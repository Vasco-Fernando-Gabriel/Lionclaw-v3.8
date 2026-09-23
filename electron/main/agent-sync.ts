import { getAllAgents, getAgent, getSetting, listHarnessProjects, updateAgent, type AgentUpdatePatch } from './db';
import { resolveOrchestratorSelection, type OrchestratorSelection } from './orchestrator-selection';
import { getSeedAgentById } from './seed-agents';
import { isProjectLocked } from './pipeline-shared/lock';
import { CODEX_EFFORT_ORDER } from '../../src/constants/codex-models';
import { getKimiModel } from '../../src/constants/kimi-models';
import { clampCodexEffortForModelDiscovered } from './codex-runtime/model-capabilities';
import type { SessionOrchestrator } from './lanes';
import { createLogger } from './logger';
import type { HarnessEngine } from './harness-engine';
import type {
  AgentConfig,
  AgentSyncBlockedResponse,
  AgentSyncPatchSnapshot,
  AgentSyncResult,
  AgentSyncSuccessResponse,
  HarnessProject,
  HarnessProjectStatus,
  OrchestratorSelectionSnapshot,
  SyncAgentsToOrchestratorRequest,
  SyncAgentsToOrchestratorResponse,
  CodexChatReasoningEffort,
} from '../../src/types';

const logger = createLogger('agent-sync');

export class InvalidOrchestratorMappingError extends Error {
  public readonly runtime: string;
  public readonly provider: string;

  constructor(runtime: string, provider: string) {
    super(`Unsupported orchestrator runtime/provider combination: ${runtime}/${provider}`);
    this.name = 'InvalidOrchestratorMappingError';
    this.runtime = runtime;
    this.provider = provider;
  }
}

export const LOCAL_ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'WebSearch',
  'WebFetch',
] as const;

const BLOCKING_STATUSES: ReadonlyArray<HarnessProjectStatus> = ['planning', 'reviewing', 'running', 'paused'];

interface SyncAgentsToOrchestratorDeps {
  getHarnessEngine: () => HarnessEngine | null;
}

function toOrchestratorSnapshot(sel: OrchestratorSelection): OrchestratorSelectionSnapshot {
  const snapshot: OrchestratorSelectionSnapshot = {
    runtime: sel.runtime,
    provider: sel.provider,
    model: sel.model,
  };
  if (sel.effort !== undefined) {
    snapshot.effort = sel.effort;
  }
  if (sel.baseUrl !== undefined) {
    snapshot.baseUrl = sel.baseUrl;
  }
  return snapshot;
}

function toSnapshot(source: AgentUpdatePatch | AgentConfig): AgentSyncPatchSnapshot {
  const snapshot: AgentSyncPatchSnapshot = {
    runtime: (source.runtime ?? 'cloud') as AgentConfig['runtime'],
    model: source.model ?? '',
  };
  if (source.effort !== undefined) {
    snapshot.effort = source.effort;
  }
  if (source.localConfig !== undefined && source.localConfig !== null) {
    snapshot.localConfig = source.localConfig;
  }
  if (source.externalConfig !== undefined && source.externalConfig !== null) {
    snapshot.externalConfig = source.externalConfig;
  }
  if (source.codexConfig !== undefined && source.codexConfig !== null) {
    snapshot.codexConfig = source.codexConfig;
  }
  if (source.localMode !== undefined) {
    snapshot.localMode = source.localMode;
  }
  if (source.allowedTools !== undefined) {
    snapshot.allowedTools = source.allowedTools;
  }
  if (source.mcpServers !== undefined) {
    snapshot.mcpServers = source.mcpServers;
  }
  if (source.skills !== undefined) {
    snapshot.skills = source.skills;
  }
  return snapshot;
}

function selectionClaudeEffort(raw: string | undefined): AgentConfig['effort'] {
  return raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'max' ? raw : 'high';
}

function selectionCodexEffort(
  raw: string | undefined,
  model: string,
): NonNullable<NonNullable<AgentConfig['codexConfig']>['reasoningEffort']> {
  if ((CODEX_EFFORT_ORDER as readonly string[]).includes(raw ?? '')) {
    return clampCodexEffortForModelDiscovered(raw as CodexChatReasoningEffort, model);
  }
  return 'high';
}

export function mapOrchestratorToAgentPatch(sel: OrchestratorSelection): AgentUpdatePatch {
  const key = `${sel.runtime}|${sel.provider}`;

  switch (key) {
    case 'claude-sdk|anthropic':
      return {
        runtime: 'cloud',
        model: sel.model,
        effort: selectionClaudeEffort(sel.effort),
        localConfig: null,
        externalConfig: null,
        codexConfig: null,
      };

    case 'codex-sdk|codex':
      return {
        runtime: 'codex',
        model: sel.model,
        localConfig: null,
        externalConfig: null,
        codexConfig: {
          model: sel.model,
          sandbox: 'workspace-write',
          reasoningEffort: selectionCodexEffort(sel.effort, sel.model),
        },
      };

    case 'lion-sdk|ollama':
      return {
        runtime: 'local',
        model: sel.model,
        localConfig: {
          provider: 'ollama',
          baseUrl: getSetting('orchestrator_ollama_base_url') || '',
          model: sel.model,
        },
        localMode: 'smart',
        externalConfig: null,
        codexConfig: null,
      };

    case 'lion-sdk|lmstudio':
      return {
        runtime: 'local',
        model: sel.model,
        localConfig: {
          provider: 'lmstudio',
          baseUrl: getSetting('orchestrator_lmstudio_base_url') || '',
          model: sel.model,
        },
        localMode: 'smart',
        externalConfig: null,
        codexConfig: null,
      };

    case 'lion-sdk|openai-compatible':
      return {
        runtime: 'external',
        model: sel.model,
        externalConfig: {
          provider: 'openai-compatible',
          protocol: 'openai-compatible',
          model: sel.model,
          baseUrl: getSetting('orchestrator_openai_compat_base_url') || '',
          apiKeyRef: getSetting('orchestrator_openai_compat_api_key_ref') || '',
        },
        localConfig: null,
        codexConfig: null,
      };

    case 'lion-sdk|vertex-ai':
      return {
        runtime: 'external',
        model: sel.model,
        externalConfig: {
          provider: 'gemini-agent-platform',
          protocol: 'google-genai',
          model: sel.model,
          apiKeyRef: getSetting('orchestrator_vertex_api_key_ref') || '',
        },
        localConfig: null,
        codexConfig: null,
      };

    case 'claude-compat-sdk|zai':
      return {
        runtime: 'zai',
        model: sel.model,
        localConfig: null,
        externalConfig: null,
        codexConfig: null,
      };

    case 'claude-compat-sdk|minimax':
      return {
        runtime: 'minimax-tp',
        model: sel.model,
        localConfig: null,
        externalConfig: null,
        codexConfig: null,
      };

    case 'kimi-sdk|kimi': {
      const model = getKimiModel(sel.model);
      const saved = sel.effort;
      const effort = model?.efforts.includes(saved as 'low' | 'high' | 'max')
        ? (saved as 'low' | 'high' | 'max')
        : (model?.defaultEffort ?? 'max');
      return {
        runtime: 'kimi',
        model: sel.model,
        effort,
        localConfig: null,
        externalConfig: null,
        codexConfig: null,
      };
    }

    case 'grok-sdk|grok': {
      const saved = sel.effort;
      const effort: AgentConfig['effort'] = saved === 'low' || saved === 'medium' || saved === 'high' ? saved : 'high';
      return {
        runtime: 'grok',
        model: sel.model,
        effort,
        localConfig: null,
        externalConfig: null,
        codexConfig: null,
      };
    }

    case 'cursor-sdk|cursor':
      return {
        runtime: 'cursor',
        model: sel.model,
        localConfig: null,
        externalConfig: null,
        codexConfig: null,
      };

    default:
      throw new InvalidOrchestratorMappingError(sel.runtime, sel.provider);
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

interface DiffInput {
  patch: AgentUpdatePatch;
  agent: AgentConfig;
  touchedExtras: ReadonlyArray<'allowedTools' | 'mcpServers' | 'skills'>;
}

function diffAgentVsPatch({ patch, agent, touchedExtras }: DiffInput): boolean {
  if (patch.runtime !== undefined && patch.runtime !== agent.runtime) {
    return true;
  }
  if (patch.model !== undefined && patch.model !== agent.model) {
    return true;
  }
  if (patch.effort !== undefined && patch.effort !== agent.effort) {
    return true;
  }
  if (patch.localMode !== undefined && patch.localMode !== agent.localMode) {
    return true;
  }
  if (patch.localConfig !== undefined) {
    const patchValue = patch.localConfig === null ? undefined : patch.localConfig;
    if (stableStringify(patchValue) !== stableStringify(agent.localConfig)) {
      return true;
    }
  }
  if (patch.externalConfig !== undefined) {
    const patchValue = patch.externalConfig === null ? undefined : patch.externalConfig;
    if (stableStringify(patchValue) !== stableStringify(agent.externalConfig)) {
      return true;
    }
  }
  if (patch.codexConfig !== undefined) {
    const patchValue = patch.codexConfig === null ? undefined : patch.codexConfig;
    if (stableStringify(patchValue) !== stableStringify(agent.codexConfig)) {
      return true;
    }
  }
  for (const field of touchedExtras) {
    if (stableStringify(patch[field]) !== stableStringify(agent[field])) {
      return true;
    }
  }
  return false;
}

async function resolveSyncSelection(explicit: SessionOrchestrator | undefined): Promise<OrchestratorSelection> {
  if (explicit) {
    return resolveOrchestratorSelection({ surface: 'default', selection: explicit });
  }
  logger.warn(
    'agents:sync-to-orchestrator sem `selection`: alias deprecated, usando o Orquestrador padrao (surface default)',
  );
  return resolveOrchestratorSelection({ surface: 'default' });
}

export async function syncAgentsToOrchestrator(
  req: SyncAgentsToOrchestratorRequest,
  deps: SyncAgentsToOrchestratorDeps,
): Promise<SyncAgentsToOrchestratorResponse> {
  logger.info(
    {
      mode: req.mode ?? 'unspecified',
      dryRun: req.dryRun === true,
      targetsRequested: req.agentIds?.length ?? 'all',
    },
    'syncAgentsToOrchestrator: starting',
  );

  const allProjects: HarnessProject[] = listHarnessProjects();
  const projectsBlocking = allProjects.filter((p) => BLOCKING_STATUSES.includes(p.status));
  const lockedProjects = allProjects.filter((p) => isProjectLocked(p.id));

  const engine = deps.getHarnessEngine();
  const enrichActive = engine?.hasActiveEnrichSession() ?? false;

  if (projectsBlocking.length > 0 || lockedProjects.length > 0 || enrichActive) {
    const blockingById = new Map<string, { id: string; name: string; status: HarnessProjectStatus }>();
    for (const p of projectsBlocking) {
      blockingById.set(p.id, { id: p.id, name: p.name, status: p.status });
    }
    for (const p of lockedProjects) {
      if (!blockingById.has(p.id)) {
        blockingById.set(p.id, { id: p.id, name: p.name, status: p.status });
      }
    }

    let reason: AgentSyncBlockedResponse['reason'];
    if (projectsBlocking.length > 0) {
      reason = 'pipeline-running';
    } else if (lockedProjects.length > 0) {
      reason = 'project-locked';
    } else {
      reason = 'enrich-active';
    }

    const blocked: AgentSyncBlockedResponse = {
      blocked: true,
      reason,
      active: {
        projects: Array.from(blockingById.values()),
        enrich: enrichActive,
      },
    };

    logger.warn(
      {
        reason,
        projectsBlockingCount: projectsBlocking.length,
        lockedProjectsCount: lockedProjects.length,
        enrichActive,
      },
      'syncAgentsToOrchestrator: blocked',
    );
    return blocked;
  }

  const selection = await resolveSyncSelection(req.selection);

  const basePatch = mapOrchestratorToAgentPatch(selection);

  let targets: AgentConfig[];
  if (req.agentIds === undefined) {
    targets = getAllAgents();
  } else if (req.agentIds.length === 0) {
    logger.info({ mode: req.mode }, 'sync called with empty agentIds array — zero targets, returning empty result');
    targets = [];
  } else {
    targets = req.agentIds.map((id) => getAgent(id)).filter((a): a is AgentConfig => a !== undefined);
  }

  const results: AgentSyncResult[] = [];

  for (const agent of targets) {
    const patch: AgentUpdatePatch = { ...basePatch };
    const touchedExtras: Array<'allowedTools' | 'mcpServers' | 'skills'> = [];
    let restoredFromSeed: Array<'allowedTools' | 'mcpServers' | 'skills'> | undefined;
    let warning: string | undefined;

    const fromToolStrippingRuntime = agent.runtime === 'codex' || agent.runtime === 'local';
    const targetConsumesTools = basePatch.runtime !== 'codex' && basePatch.runtime !== 'local';
    const hasEmptyToolField =
      agent.allowedTools.length === 0 || agent.mcpServers.length === 0 || agent.skills.length === 0;

    if (fromToolStrippingRuntime && targetConsumesTools && hasEmptyToolField) {
      const seed = getSeedAgentById(agent.id);
      if (seed) {
        const restored: Array<'allowedTools' | 'mcpServers' | 'skills'> = [];
        if (agent.allowedTools.length === 0 && seed.allowedTools.length > 0) {
          patch.allowedTools = seed.allowedTools;
          touchedExtras.push('allowedTools');
          restored.push('allowedTools');
        }
        if (agent.mcpServers.length === 0 && seed.mcpServers.length > 0) {
          patch.mcpServers = seed.mcpServers;
          touchedExtras.push('mcpServers');
          restored.push('mcpServers');
        }
        if (agent.skills.length === 0 && seed.skills.length > 0) {
          patch.skills = seed.skills;
          touchedExtras.push('skills');
          restored.push('skills');
        }
        if (restored.length > 0) {
          restoredFromSeed = restored;
        }
      } else {
        warning = 'Agente custom sem allowedTools/mcpServers/skills. Ajuste manualmente.';
      }
    }

    if (basePatch.runtime === 'local' && agent.runtime !== 'local' && agent.allowedTools.length === 0) {
      patch.allowedTools = [...LOCAL_ALLOWED_TOOLS];
      if (!touchedExtras.includes('allowedTools')) {
        touchedExtras.push('allowedTools');
      }
    }

    if (
      (basePatch.runtime === 'local' || basePatch.runtime === 'external') &&
      agent.allowedTools.some((t) => t.startsWith('mcp__claude_ai_'))
    ) {
      const mcpWarning = `Tools MCP cloud-only (mcp__claude_ai_*) detectadas em runtime ${basePatch.runtime} — podem nao funcionar`;
      warning = warning ? `${warning}; ${mcpWarning}` : mcpWarning;
    }

    const changed = diffAgentVsPatch({ patch, agent, touchedExtras });

    let error: string | undefined;
    if (req.dryRun !== true && changed) {
      try {
        updateAgent(agent.id, patch);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        logger.error({ agentId: agent.id, err: error }, 'syncAgentsToOrchestrator: updateAgent failed for agent');
      }
    }

    const result: AgentSyncResult = {
      agentId: agent.id,
      before: toSnapshot(agent),
      after: toSnapshot(patch),
      changed,
    };
    if (restoredFromSeed) result.restoredFromSeed = restoredFromSeed;
    if (warning) result.warning = warning;
    if (error) result.error = error;
    results.push(result);
  }

  const summary = {
    updated: results.filter((r) => r.changed && !r.error).length,
    skipped: results.filter((r) => !r.changed).length,
    failed: results.filter((r) => r.error !== undefined).length,
  };

  const response: AgentSyncSuccessResponse = {
    blocked: false,
    orchestrator: toOrchestratorSnapshot(selection),
    results,
    summary,
  };

  logger.info(
    {
      mode: req.mode ?? 'unspecified',
      dryRun: req.dryRun === true,
      orchestrator: {
        runtime: selection.runtime,
        provider: selection.provider,
        model: selection.model,
        effort: selection.effort ?? null,
      },
      summary,
      targets: targets.length,
    },
    'syncAgentsToOrchestrator: done',
  );

  return response;
}
