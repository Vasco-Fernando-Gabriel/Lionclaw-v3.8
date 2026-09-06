
import {
  getDynamicWorkflowRun,
  getDynamicWorkflowDefinition,
  listDynamicWorkflowRunsByStatus,
  setDynamicWorkflowRunStatus,
  updateDynamicWorkflowRun,
  upsertDynamicWorkflowNodeRun,
  updateDynamicWorkflowNodeRun,
  listDynamicWorkflowNodeRuns,
  insertDynamicWorkflowEvent,
  listDynamicWorkflowRecentEvents,
  insertDynamicWorkflowGateDecision,
  insertDynamicWorkflowArtifact,
  insertDynamicWorkflowMessage,
  listDynamicWorkflowMessages,
  getDynamicWorkflowRunCostAggregate,
  createDynamicWorkflowNode,
  getDynamicWorkflowNodeByKey,
  updateDynamicWorkflowNodeSprintMeta,
  updateDynamicWorkflowDefinition,
  upsertDynamicWorkflowSprint,
  updateDynamicWorkflowSprint,
  listDynamicWorkflowSprints,
  materializeDynamicWorkflowSprintPlan,
  getDynamicWorkflowPriorMaterialization,
  appendDynamicWorkflowJournalEntry,
  listDynamicWorkflowJournalEntries,
  truncateDynamicWorkflowJournalFrom,
  createDynamicWorkflowDefinition,
  repointDynamicWorkflowRunDefinition,
  getAllAgents,
  getAgent,
  getSetting,
  claimAdjustmentsForNode,
  getConsumedAdjustmentsForNode,
} from '../db';
import { emitIPC } from '../pipeline-shared/ipc-emitter';
import { createLogger } from '../logger';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { WorkflowRunnerCrud, WorkflowRunnerDeps } from './workflow-runner';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  materializeBuilderPackage,
  SCHEMAS_SUBDIR,
  type BuilderPackage,
} from './workflow-package';
import { runDirFor } from './workflow-create';
import { runLogPath } from './workflow-artifacts';
import { listDynamicWorkflowEvents } from '../db';
import { appendFileSync, mkdirSync } from 'node:fs';
import type {
  DynamicWorkflowDefinition,
  DynamicWorkflowDefinitionCreateInput,
} from './types';
import { randomBytes } from 'node:crypto';
import type {
  ComposedToolInput,
  ToolDecision,
  ClaudeCompatBackend,
  ClaudeCompatRunInput,
  KimiBackend,
  GrokBackend,
  CursorBackend,
  WorkflowAdapterDeps,
} from './workflow-agent-adapter';
import {
  runClaudeCompatNode,
  type ClaudeCompatExecDeps,
  type ClaudeCompatExecutorRuntime,
} from './workflow-claude-compat-executor';
import { hasKnownPricing as defaultHasKnownPricing } from '../pricing';
import type { CloserAgentTurnRunner } from './workflow-closer';
import type { NarrateFn, WorkflowNarratorDeps } from './workflow-narrator';

const logger = createLogger('dynamic-workflow-runner-deps');


export function buildRunnerCrud(): WorkflowRunnerCrud {
  return {
    getRun: getDynamicWorkflowRun,
    getDefinition: getDynamicWorkflowDefinition,
    listRunsByStatus: listDynamicWorkflowRunsByStatus,
    setRunStatus: setDynamicWorkflowRunStatus,
    updateRun: updateDynamicWorkflowRun,
    upsertNodeRun: upsertDynamicWorkflowNodeRun,
    updateNodeRun: updateDynamicWorkflowNodeRun,
    listNodeRuns: listDynamicWorkflowNodeRuns,
    insertEvent: insertDynamicWorkflowEvent,
    recentEvents: listDynamicWorkflowRecentEvents,
    listEventsSince: (runId, afterSeq) =>
      listDynamicWorkflowEvents(runId, { afterSeq, limit: 100_000 }),
    insertGateDecision: insertDynamicWorkflowGateDecision,
    registerArtifact: insertDynamicWorkflowArtifact,
    insertMessage: insertDynamicWorkflowMessage,
    listMessages: listDynamicWorkflowMessages,
    costAggregate: getDynamicWorkflowRunCostAggregate,
    materializeSprintPlan: materializeDynamicWorkflowSprintPlan,
    getPriorMaterialization: getDynamicWorkflowPriorMaterialization,
    appendJournalEntry: appendDynamicWorkflowJournalEntry,
    listJournalEntries: listDynamicWorkflowJournalEntries,
    truncateJournalFrom: truncateDynamicWorkflowJournalFrom,
    claimAdjustmentsForNode,
    getConsumedAdjustmentsForNode,
    createNodes: (definitionId, nodes) => {
      for (const node of nodes) {
        if (getDynamicWorkflowNodeByKey(definitionId, node.nodeId)) continue;
        createDynamicWorkflowNode({ ...node, definitionId });
      }
    },
    updateDefinition: updateDynamicWorkflowDefinition,
    persistSprints: (sprints) => {
      for (const sprint of sprints) upsertDynamicWorkflowSprint(sprint);
    },
    setNodeSprintMeta: updateDynamicWorkflowNodeSprintMeta,
    updateSprintMerge: updateDynamicWorkflowSprint,
    listSprints: listDynamicWorkflowSprints,
  };
}


export function closerGuardToSdkCanUseTool(
  guard: (input: ComposedToolInput) => Promise<ToolDecision>,
): CanUseTool {
  return async (toolName, input) => {
    const decision = await guard({ toolName, input });
    return decision.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: decision.message };
  };
}

export const CLOSER_AUTO_APPROVED_TOOLS: string[] = ['Read', 'Glob', 'Grep'];

export interface RealClaudeCompatBackendDeps {
  resolveConfig?: (agentId: string) => Promise<AgentQueryConfig>;
  runNode?: typeof runClaudeCompatNode;
  execDeps?: ClaudeCompatExecDeps;
  executeAgentFn?: (
    req: import('../agent-runtime/types').AgentExecutionRequest,
  ) => Promise<import('../agent-runtime/types').AgentExecutionResult>;
  hasKnownPricing?: (model: string) => boolean;
}

export function makeRealCloserAgentTurn(
  deps?: RealClaudeCompatBackendDeps,
): CloserAgentTurnRunner {
  return async (input) => {
    const sdkGuard = closerGuardToSdkCanUseTool(input.canUseTool);
    try {
      const resolveConfig =
        deps?.resolveConfig ??
        (async (agentId: string) => {
          const { resolveAgentQueryConfig } = await import('../agent-config-resolver');
          return resolveAgentQueryConfig(agentId);
        });
      const runNode = deps?.runNode ?? runClaudeCompatNode;
      const config = await resolveConfig(input.agentId);

      if (config.runtime === 'codex' || config.runtime === 'kimi') {
        const executeAgentFn =
          deps?.executeAgentFn ??
          (async (req) => {
            const { executeAgent } = await import('../agent-runtime/execute');
            return executeAgent(req);
          });
        const { PERM_BYPASS_NO_GUARD } = await import('../agent-runtime/permission-profiles');
        const result = await executeAgentFn({
          agentId: input.agentId,
          prompt: input.prompt,
          cwd: input.cwd,
          abortController: new AbortController(),
          permission: PERM_BYPASS_NO_GUARD,
        });
        return {
          ok: true,
          output: result.output,
          costUsd: result.metrics.costUsd,
          inputTokens: result.metrics.inputTokens,
          outputTokens: result.metrics.outputTokens,
          cacheReadTokens: result.metrics.cacheReadTokens,
          cacheCreationTokens: result.metrics.cacheCreationTokens,
          model: result.model,
        };
      }

      const runtime: ClaudeCompatExecutorRuntime =
        config.runtime === 'zai' || config.runtime === 'minimax-tp'
          ? config.runtime
          : 'cloud';
      const result = await runNode(
        {
          runtime,
          config,
          prompt: input.prompt,
          cwd: input.cwd,
          allowedTools: CLOSER_AUTO_APPROVED_TOOLS,
          mcpServers: [],
          canUseTool: sdkGuard,
          abortSignal: new AbortController().signal,
        },
        deps?.execDeps,
      );
      return {
        ok: true,
        output: result.output,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheCreationTokens: result.cacheCreationTokens,
        model: result.model,
      };
    } catch (err) {
      return {
        ok: false,
        output: '',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

export const realCloserAgentTurn: CloserAgentTurnRunner = makeRealCloserAgentTurn();


export function makeRealClaudeCompatBackend(
  deps?: RealClaudeCompatBackendDeps,
): ClaudeCompatBackend {
  return async (input: ClaudeCompatRunInput) => {
    const sdkGuard = composedGuardToSdkCanUseTool(input.canUseTool);
    const resolveConfig =
      deps?.resolveConfig ??
      (async (agentId: string) => {
        const { resolveAgentQueryConfig } = await import('../agent-config-resolver');
        return resolveAgentQueryConfig(agentId);
      });
    const runNode = deps?.runNode ?? runClaudeCompatNode;
    const hasKnownPricing = deps?.hasKnownPricing ?? defaultHasKnownPricing;
    const resolvedConfig = await resolveConfig(input.agentId);
    const isOverride =
      typeof input.model === 'string' &&
      input.model.length > 0 &&
      input.model !== resolvedConfig.model;
    const isEffortOverride =
      input.effort !== undefined && input.effort !== resolvedConfig.effort;
    const isMaxTurnsOverride =
      input.maxTurns !== undefined && input.maxTurns !== resolvedConfig.maxTurns;
    const config: AgentQueryConfig =
      isOverride || isEffortOverride || isMaxTurnsOverride
        ? {
            ...resolvedConfig,
            ...(isOverride ? { model: input.model } : {}),
            ...(isEffortOverride ? { effort: input.effort } : {}),
            ...(isMaxTurnsOverride ? { maxTurns: input.maxTurns } : {}),
          }
        : resolvedConfig;
    const result = await runNode(
      {
        runtime: input.runtime as ClaudeCompatExecutorRuntime,
        config,
        prompt: input.prompt,
        cwd: input.cwd,
        allowedTools: input.allowedTools,
        mcpServers: input.mcpServers,
        canUseTool: sdkGuard,
        abortSignal: input.abortSignal,
        onStreamChunk: input.onStreamChunk,
      },
      deps?.execDeps,
    );
    const overrideUnknownPricing = isOverride && !hasKnownPricing(result.model);
    return {
      output: result.output,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheCreationTokens: result.cacheCreationTokens,
      costUsd: result.costUsd,
      costStatus: overrideUnknownPricing ? 'unknown' : 'known',
      ...(overrideUnknownPricing ? { costUnknownReason: 'unknown-pricing' } : {}),
      apiRequests: result.apiRequests,
      toolUses: result.toolUses,
    };
  };
}

export function composedGuardToSdkCanUseTool(
  guard: (input: ComposedToolInput) => ToolDecision,
): CanUseTool {
  return async (toolName, input) => {
    const decision = guard({ toolName, input });
    return decision.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: decision.message };
  };
}

export const realClaudeCompatBackend: ClaudeCompatBackend = makeRealClaudeCompatBackend();

function makeRealCliBackend(runtime: 'kimi'): KimiBackend;
function makeRealCliBackend(runtime: 'grok'): GrokBackend;
function makeRealCliBackend(runtime: 'kimi' | 'grok'): KimiBackend | GrokBackend {
  return async (input: ClaudeCompatRunInput) => {
    const [{ resolveAgentQueryConfig }, profiles, executorModule] = await Promise.all([
      import('../agent-config-resolver'),
      import('../agent-runtime/permission-profiles'),
      runtime === 'grok'
        ? import('../agent-runtime/grok-executor')
        : import('../agent-runtime/kimi-executor'),
    ]);
    const resolved = await resolveAgentQueryConfig(input.agentId);
    const config: AgentQueryConfig = {
      ...resolved,
      runtime,
      model: input.model,
      ...(input.effort ? { effort: input.effort } : {}),
      allowedTools: [...input.allowedTools],
      mcpServers: input.mcpServers,
      systemPrompt: input.systemPrompt,
    };
    const abortController = new AbortController();
    const onAbort = (): void => abortController.abort();
    if (input.abortSignal.aborted) abortController.abort();
    else input.abortSignal.addEventListener('abort', onAbort, { once: true });
    const permission = profiles.PERM_DEFAULT_WITH_GUARD(
      composedGuardToSdkCanUseTool(input.canUseTool),
    );
    try {
      const executor = runtime === 'grok'
        ? (executorModule as typeof import('../agent-runtime/grok-executor')).grokExecutor
        : (executorModule as typeof import('../agent-runtime/kimi-executor')).kimiExecutor;
      const result = await executor.run({
        agentId: input.agentId,
        prompt: input.prompt,
        cwd: input.cwd,
        abortController,
        permission,
        ...(input.effort !== undefined ? { effortOverride: input.effort } : {}),
        onText: (content) => input.onStreamChunk?.({ type: 'text', content }),
        onToolUse: (toolName) => input.onStreamChunk?.({ type: 'tool_call_start', toolName }),
        onToolUseComplete: (toolName) => input.onStreamChunk?.({ type: 'tool_call', toolName }),
      }, config);
      return {
        output: result.output,
        model: result.model,
        inputTokens: result.metrics.inputTokens,
        outputTokens: result.metrics.outputTokens,
        cacheReadTokens: result.metrics.cacheReadTokens,
        cacheCreationTokens: result.metrics.cacheCreationTokens,
        costUsd: result.metrics.costUsd,
        costStatus: result.metrics.costStatus,
        tokenStatus: result.metrics.tokenStatus,
        costUnknownReason: result.metrics.costUnknownReason,
        costStatusReasons: result.metrics.costStatusReasons,
        apiRequests: result.metrics.apiRequests,
        toolUses: result.metrics.toolUses,
      };
    } finally {
      input.abortSignal.removeEventListener('abort', onAbort);
    }
  };
}

export const realKimiBackend: KimiBackend = makeRealCliBackend('kimi');
export const realGrokBackend: GrokBackend = makeRealCliBackend('grok');

export function makeRealCursorBackend(): CursorBackend {
  return async (input: ClaudeCompatRunInput) => {
    if (input.effort !== undefined) {
      throw new Error(
        'cursor backend: transporte de effort nao implementado no executor cursor '
          + '(nenhum modelo do catalogo 1.0.30 anuncia tiers; o adapter deveria ter '
          + 'falhado fechado antes). Fail-closed em vez de descarte silencioso.',
      );
    }
    const [{ resolveAgentQueryConfig }, profiles, executorModule] = await Promise.all([
      import('../agent-config-resolver'),
      import('../agent-runtime/permission-profiles'),
      import('../agent-runtime/cursor-executor'),
    ]);
    const resolved = await resolveAgentQueryConfig(input.agentId);
    const config: AgentQueryConfig = {
      ...resolved,
      runtime: 'cursor',
      model: input.model,
      allowedTools: [...input.allowedTools],
      mcpServers: input.mcpServers,
      systemPrompt: input.systemPrompt,
    };
    const abortController = new AbortController();
    const onAbort = (): void => abortController.abort();
    if (input.abortSignal.aborted) abortController.abort();
    else input.abortSignal.addEventListener('abort', onAbort, { once: true });
    const permission = profiles.PERM_DEFAULT_WITH_GUARD(
      composedGuardToSdkCanUseTool(input.canUseTool),
    );
    try {
      const result = await executorModule.cursorExecutor.run({
        agentId: input.agentId,
        prompt: input.prompt,
        cwd: input.cwd,
        abortController,
        permission,
        onText: (content) => input.onStreamChunk?.({ type: 'text', content }),
        onToolUse: (toolName) => input.onStreamChunk?.({ type: 'tool_call_start', toolName }),
        onToolUseComplete: (toolName) => input.onStreamChunk?.({ type: 'tool_call', toolName }),
      }, config);
      return {
        output: result.output,
        model: result.model,
        inputTokens: result.metrics.inputTokens,
        outputTokens: result.metrics.outputTokens,
        cacheReadTokens: result.metrics.cacheReadTokens,
        cacheCreationTokens: result.metrics.cacheCreationTokens,
        costUsd: result.metrics.costUsd,
        costStatus: result.metrics.costStatus,
        tokenStatus: result.metrics.tokenStatus,
        costUnknownReason: result.metrics.costUnknownReason,
        costStatusReasons: result.metrics.costStatusReasons,
        apiRequests: result.metrics.apiRequests,
        toolUses: result.metrics.toolUses,
      };
    } finally {
      input.abortSignal.removeEventListener('abort', onAbort);
    }
  };
}

export const realCursorBackend: CursorBackend = makeRealCursorBackend();

export function buildRealAdapterDeps(): WorkflowAdapterDeps {
  return {
    claudeCompat: realClaudeCompatBackend,
    kimiBackend: realKimiBackend,
    grokBackend: realGrokBackend,
    cursorBackend: realCursorBackend,
  };
}


export function materializeEditedPackageReal(input: {
  projectPath: string;
  revisionId: string;
  workflowJsSource: string;
  manifestJson: string;
  currentWorkflowJsPath?: string;
}): {
  workflowJsPath: string;
  manifestPath: string;
  manifestJson: string;
  manifestHash: string;
  schemaPaths: string[];
} {
  const revisionRunDir = runDirFor(input.projectPath, input.revisionId);
  let manifestObj: unknown;
  try {
    manifestObj = JSON.parse(input.manifestJson);
  } catch (e) {
    throw new Error(`manifest editado invalido (JSON): ${e instanceof Error ? e.message : String(e)}`);
  }
  let schemas: Record<string, unknown> | undefined;
  if (input.currentWorkflowJsPath) {
    const currentSchemasDir = join(dirname(input.currentWorkflowJsPath), SCHEMAS_SUBDIR);
    if (existsSync(currentSchemasDir)) {
      const collected: Record<string, unknown> = {};
      for (const fileName of readdirSync(currentSchemasDir)) {
        if (!fileName.endsWith('.json')) continue;
        try {
          collected[fileName] = JSON.parse(
            readFileSync(join(currentSchemasDir, fileName), 'utf8'),
          );
        } catch (e) {
          throw new Error(
            `schema ilegivel na revisao corrente (${fileName}): ${e instanceof Error ? e.message : String(e)}. Conserte ou remova o arquivo em ${currentSchemasDir} antes de editar o workflow.`,
          );
        }
      }
      if (Object.keys(collected).length > 0) schemas = collected;
    }
  }
  const pkg: BuilderPackage = {
    workflowJs: input.workflowJsSource,
    manifest: manifestObj,
    ...(schemas ? { schemas } : {}),
  };
  const out = materializeBuilderPackage(revisionRunDir, pkg, 'edit', 0);
  return {
    workflowJsPath: out.workflowJsPath,
    manifestPath: out.manifestPath,
    manifestJson: out.manifestJson,
    manifestHash: out.manifestHash,
    schemaPaths: out.schemaPaths,
  };
}

export function createEditedDefinitionReal(input: {
  prevDefinition: DynamicWorkflowDefinition;
  revisionId: string;
  workflowJsPath: string;
  manifestPath: string;
  manifestJson: string;
  manifestHash: string;
}): { newDefinitionId: string } {
  const prev = input.prevDefinition;
  const newDefinitionId = `dwfd_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const newDefInput: DynamicWorkflowDefinitionCreateInput = {
    id: newDefinitionId,
    name: prev.name,
    definitionVersion: prev.definitionVersion + 1,
    parentDefinitionId: prev.id,
    supersedesDefinitionId: null,
    sourceType: prev.sourceType,
    projectPath: prev.projectPath,
    specPath: prev.specPath,
    specSha256: prev.specSha256,
    workflowJsPath: input.workflowJsPath,
    manifestPath: input.manifestPath,
    manifestJson: input.manifestJson,
    manifestHash: input.manifestHash,
    contextBundlePath: prev.contextBundlePath,
    builderModel: prev.builderModel,
    status: 'validated',
  };
  createDynamicWorkflowDefinition(newDefInput);
  updateDynamicWorkflowDefinition(prev.id, { supersedesDefinitionId: newDefinitionId });
  return { newDefinitionId };
}


export const realNarrateFn: NarrateFn = async ({ runId, prompt, abortSignal }) => {
  const { executeNarrator } = await import('./workflow-narrator-executor');
  const abortController = new AbortController();
  const bridgeAbort = (): void => abortController.abort();
  if (abortSignal.aborted) abortController.abort();
  else abortSignal.addEventListener('abort', bridgeAbort);
  const cwd = resolveRunCwd(runId) ?? process.cwd();
  try {
    const result = await executeNarrator({
      prompt,
      cwd,
      abortController,
    });
    logger.debug({ runId, len: result.output.length }, 'voz do Maestro (narracao) gerada');
    return { text: result.output };
  } finally {
    abortSignal.removeEventListener('abort', bridgeAbort);
  }
};

function resolveRunCwd(runId: string): string | undefined {
  try {
    const run = getDynamicWorkflowRun(runId);
    if (!run) return undefined;
    if (run.worktreePath) return run.worktreePath;
    const definition = getDynamicWorkflowDefinition(run.definitionId);
    if (!definition?.projectPath) return undefined;
    return runDirFor(definition.projectPath, runId);
  } catch {
    return undefined;
  }
}

export interface DefaultNarratorDepsOverrides {
  narrate?: NarrateFn;
  emit?: (channel: string, payload: unknown) => void;
  now?: () => number;
  insertMessage?: WorkflowNarratorDeps['insertMessage'] | null;
}

export function createDefaultNarratorDeps(
  overrides?: DefaultNarratorDepsOverrides,
): WorkflowNarratorDeps {
  const deps: WorkflowNarratorDeps = {
    narrate: overrides?.narrate ?? realNarrateFn,
    emit: overrides?.emit ?? emitIPC,
  };
  if (overrides?.now) deps.now = overrides.now;
  if (overrides && 'insertMessage' in overrides) {
    if (typeof overrides.insertMessage === 'function') {
      deps.insertMessage = overrides.insertMessage;
    }
  } else {
    deps.insertMessage = insertDynamicWorkflowMessage;
  }
  return deps;
}


function defaultAppendJsonl(runId: string, line: string): void {
  try {
    const run = getDynamicWorkflowRun(runId);
    if (!run) return;
    const definition = getDynamicWorkflowDefinition(run.definitionId);
    if (!definition?.projectPath) return;
    const filePath = runLogPath(runDirFor(definition.projectPath, runId), 'events.jsonl');
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${line}\n`, 'utf8');
  } catch (err) {
    logger.warn({ err, runId }, 'events.jsonl: append falhou (ignorado, best-effort)');
  }
}

export interface DefaultRunnerDepsOverrides {
  crud?: WorkflowRunnerCrud;
  emitIPC?: (channel: string, payload: unknown) => void;
  getWallTimeoutMs?: () => number | undefined;
  appendJsonl?: (runId: string, line: string) => void;
  closerRunAgentTurn?: CloserAgentTurnRunner;
  adapterDeps?: WorkflowAdapterDeps;
  narratorDeps?: WorkflowNarratorDeps;
  loadActiveAgentIds?: () => string[];
  resolveAgentAxes?: WorkflowRunnerDeps['resolveAgentAxes'];
  materializeEditedPackage?: WorkflowRunnerDeps['materializeEditedPackage'];
  createEditedDefinition?: WorkflowRunnerDeps['createEditedDefinition'];
  repointRunDefinition?: WorkflowRunnerDeps['repointRunDefinition'];
}

export const DYNAMIC_WORKFLOW_WALL_TIMEOUT_SETTING_KEY = 'dynamic_workflow_wall_timeout_minutes';

export const DYNAMIC_WORKFLOW_WALL_TIMEOUT_MAX_MINUTES = 35_000;

export function parseWallTimeoutSetting(
  raw: string | undefined | null,
): { ms: number | undefined; reason?: string } {
  if (raw === undefined || raw === null) return { ms: undefined };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ms: undefined };
  if (!/^-?\d+$/.test(trimmed)) {
    return { ms: undefined, reason: `valor "${raw}" nao e inteiro` };
  }
  const minutes = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(minutes) || minutes < 1) {
    return { ms: undefined, reason: `valor "${raw}" deve ser >= 1 minuto` };
  }
  if (minutes > DYNAMIC_WORKFLOW_WALL_TIMEOUT_MAX_MINUTES) {
    return {
      ms: undefined,
      reason: `valor "${raw}" acima do teto de ${DYNAMIC_WORKFLOW_WALL_TIMEOUT_MAX_MINUTES} minutos (limite do setTimeout)`,
    };
  }
  return { ms: minutes * 60_000 };
}

export function resolveWallTimeoutMsFromSetting(): number | undefined {
  const raw = getSetting(DYNAMIC_WORKFLOW_WALL_TIMEOUT_SETTING_KEY);
  const parsed = parseWallTimeoutSetting(raw);
  if (parsed.reason) {
    logger.warn(
      { setting: DYNAMIC_WORKFLOW_WALL_TIMEOUT_SETTING_KEY, raw, reason: parsed.reason },
      'dynamic_workflow_wall_timeout_minutes invalida; run segue SEM teto de wall-clock',
    );
  }
  return parsed.ms;
}

export function createDefaultRunnerDeps(
  overrides?: DefaultRunnerDepsOverrides,
): WorkflowRunnerDeps {
  return {
    crud: overrides?.crud ?? buildRunnerCrud(),
    emitIPC: overrides?.emitIPC ?? emitIPC,
    getWallTimeoutMs: overrides?.getWallTimeoutMs ?? resolveWallTimeoutMsFromSetting,
    appendJsonl: overrides?.appendJsonl ?? defaultAppendJsonl,
    adapterDeps: overrides?.adapterDeps ?? buildRealAdapterDeps(),
    narratorDeps: overrides?.narratorDeps ?? createDefaultNarratorDeps(),
    loadActiveAgentIds:
      overrides?.loadActiveAgentIds ??
      (() => getAllAgents().filter((a) => a.isActive).map((a) => a.id)),
    resolveAgentAxes:
      overrides?.resolveAgentAxes ??
      ((agentType: string) => {
        const agent = getAgent(agentType);
        if (!agent) return null;
        return {
          access: agent.access ?? 'read-only',
          allowBash: agent.allowBash ?? false,
          allowedCommands: agent.allowedCommands ?? [],
          allowNetwork: agent.allowNetwork ?? false,
          allowedTools: agent.allowedTools ?? [],
        };
      }),
    materializeEditedPackage:
      overrides?.materializeEditedPackage ?? materializeEditedPackageReal,
    createEditedDefinition:
      overrides?.createEditedDefinition ?? createEditedDefinitionReal,
    repointRunDefinition:
      overrides?.repointRunDefinition ?? repointDynamicWorkflowRunDefinition,
    closerDeps: {
      runAgentTurn: overrides?.closerRunAgentTurn ?? realCloserAgentTurn,
      auditGit: (event) => {
        try {
          insertDynamicWorkflowEvent({
            runId: event.runId,
            type: `closer-git-${event.decision}`,
            payloadJson: JSON.stringify(event),
          });
        } catch (err) {
          logger.warn({ err, runId: event.runId }, 'closer auditGit (auto) falhou (ignorado)');
        }
      },
    },
  };
}
