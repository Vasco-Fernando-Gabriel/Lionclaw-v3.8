import { swarmAggregationSdkOptions } from '../swarm/aggregation-policy';
import { persistSwarmResponse } from '../swarm/chat-persistence';

import { BrowserWindow } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../logger';
import { smokeAudit } from '../smoke-audit';
import {
  getAllAgents,
  getAgent,
  insertMessage,
  insertAuditEntry,
  clearSessionPendingSeed,
  getSetting,
  updateSessionTokens,
  setSessionActiveContextTokens,
  setSessionAgenticContextTokens,
  resetSessionAgenticContext,
  getSession,
  getEnabledTools,
  getSessionMessages,
  getSessionMessagesAfterFence,
  insertTaskExecution,
  startTaskExecution,
  finalizeTaskExecutionOnce,
  finalizeRunningTaskExecutionTree,
  getTurnIndexForUserMessage,
  getLatestUserTurnIndex,
} from '../db';
import { persistUserChatMessage } from '../user-attachments-meta';
import { recordActivity, isWriteTool, deriveToolDetail } from '../activity-log';
import { setActiveAgentId } from '../knowledge-state';
import { completeOnboardingFromUserProfileMessage, extractAndProcessOnboardingData } from '../onboarding';
import { calculateCost, hasKnownPricing } from '../pricing';
import { translateProviderError } from '../agent-runtime/llm-error';
import {
  normalizeUsage,
  canonicalPromptTokens,
  reconcileActiveContext,
  estimateRequestTokens,
  estimateStrongFloor,
  estimateAgenticContentTokens,
  resolveHistoryFence,
  computeCompositionSignature,
  getOrComputeCompositionStatic,
  estimateTokensRough,
  CLI_PRESET_TOKENS,
  CLI_BUILTIN_SCHEMAS_TOKENS,
  CONTEXT_CALIBRATION_SDK_VERSION,
} from '../agent-runtime/context-measure';
import { serializeMcpSchemasForContext } from '../agent-runtime/tool-schemas';
import { getContextWindow } from '../agent-runtime/model-context-windows';
import { buildChatContextUsage } from '../chat-context-usage';
import { maybeCompactChatSession } from '../chat-compaction-trigger';
import { getSecret } from '../secrets-vault';
import { createPermissionGuard, GUARD_GATED_TOOLS } from '../permission-guard';
import { getMCPConfigForAgent, getMcpToolRegistryEntries } from '../mcp-manager';
import { MCP_GATEWAY_SERVER_ID } from '../mcp-display';
import { resolveAgentQueryConfig } from '../agent-config-resolver';
import { getCachedSDKMcpServers, getDisabledSDKMcps } from '../mcp-discovery';
import { captureToolUse, captureToolResult, resetArtifactDetector } from '../artifact-detector';
import { buildSystemPrompt } from '../prompt-builder';
import { appendRepoGraphSection } from '../prompt-builder-repo-graph';
import { getAgentCwd, getLionClawHome } from '../paths';
import { resolveMcpServerRuntime } from '../mcp-path-resolver';
import { getCodexAgentsServer } from '../codex-agents-mcp';
import {
  createSubagentDispatchContext,
  isSubagentProviderAuthError,
  MAX_SUBAGENT_DEPTH,
  pendingSubagentProviderAuthError,
  reserveSubagentInvocation,
  resolveSubagentHostAllowedTools,
  resolveSubagentConfigWithinCeiling,
  subagentAuthFailure,
} from '../agent-runtime/subagent-dispatch';
import type { SubagentDispatchContext } from '../agent-runtime/types';
import { resolveChatInheritedEffort } from '../agent-runtime/chat-effort-inheritance';
import { PERM_DEFAULT_WITH_GUARD } from '../agent-runtime/permission-profiles';
import { SDK_DISALLOWED_TOOLS, toSdkToolNames } from '../agent-runtime/sdk-tool-names';
import { ensureNodeInPath, getClaudeSdkProcessOptions } from '../pipeline-shared/sdk-bootstrap';
import type { AgentDefinition, McpSdkServerConfigWithInstance, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { ensureInitialSessionTitle, generateSessionTitle } from '../title-generator';
import type { StreamChunk, AuditEntry, AgentConfig, ArtifactData, LiveActivityEvent } from '../../../src/types';

type AgentDefinitionCompat = Omit<AgentDefinition, 'prompt'> & {
  prompt?: string;
};
import type { QueryOptions } from '../orchestrator';
import type { OrchestratorSelection } from '../orchestrator-selection';
import type { SdkLane } from '../sdk-lane';
import { resolveLaneForOptions, lanesOrAllDesktop } from '../desktop-lanes';
import { SessionRequiredError } from '../lanes';
import {
  getActiveChatTurnBinding,
  getChatCapabilityTurn,
  computeEffectiveCapabilitiesForTurn,
} from '../chat-capability-context';
import { makeScopedSdkSessionId } from '../sdk-session-id';
import { getClaudeCompatPreset } from './provider-presets';
import { recordCompletedMainChatTurn } from '../dreaming-turn-engine';

const logger = createLogger('claude-compat-sdk');
const COMPAT_DEFAULT_MAX_TURNS = 30;
const TOOL_INPUT_LOG_LIMIT = 1000;
const ZAI_SERVER_TOOL_REPEAT_LIMIT = 3;
const ZAI_LOOP_PRONE_SERVER_TOOLS = new Set(['webReader']);

const COMPAT_CONTEXT_WINDOW_ENV_KEYS: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'DISABLE_AUTO_COMPACT',
  'DISABLE_COMPACT',
]);

export function buildCompatEnv(
  selection: OrchestratorSelection,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const preset = getClaudeCompatPreset(selection.provider);
  const baseUrl = selection.baseUrl ?? preset.baseUrl;
  const authToken = selection.apiKey;
  if (!authToken) {
    throw new Error(
      `buildCompatEnv: missing auth token for compat provider "${selection.provider}". ` +
        'The resolver must populate selection.apiKey for runtime=claude-compat-sdk.',
    );
  }

  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (key === 'API_TIMEOUT_MS') continue;
    if (key.startsWith('ANTHROPIC_')) continue;
    if (COMPAT_CONTEXT_WINDOW_ENV_KEYS.has(key)) continue;
    sanitized[key] = value;
  }

  const contextWindow = getContextWindow(selection.model, selection.provider);
  return {
    ...sanitized,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
    API_TIMEOUT_MS: '3000000',
    ...(contextWindow !== undefined ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow) } : {}),
    ...(selection.provider === 'minimax'
      ? {
          ANTHROPIC_MODEL: selection.model,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ANTHROPIC_DEFAULT_SONNET_MODEL: selection.model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: selection.model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: selection.model,
        }
      : {}),
  };
}

interface CompatRunMetrics {
  sdkMessages: number;
  toolUses: number;
  mcpToolUses: number;
  serverToolUses: number;
  toolResults: number;
  compactions: number;
  lastToolName: string | null;
  serverToolUseCounts: Record<string, number>;
}

function getInputKeys(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return [];
  }
  return Object.keys(input as Record<string, unknown>);
}

function serializeToolInput(input: unknown): string {
  if (input === undefined) return '';
  try {
    return JSON.stringify(input).substring(0, TOOL_INPUT_LOG_LIMIT);
  } catch {
    return String(input).substring(0, TOOL_INPUT_LOG_LIMIT);
  }
}

function normalizeSdkMcpToggleName(name: string): string {
  if (!name.startsWith('claude.ai ')) return name;
  return name.replace(/^claude\.ai\s+/, 'claude_ai_').replace(/\s+/g, '_');
}

function getCompatDisabledSdkMcps(provider: OrchestratorSelection['provider']): string[] {
  const disabled = new Set(getDisabledSDKMcps());

  if (provider === 'zai' || provider === 'minimax') {
    for (const server of getCachedSDKMcpServers()) {
      if (!server.name.startsWith('claude.ai ')) continue;
      disabled.add(server.name);
      disabled.add(normalizeSdkMcpToggleName(server.name));
    }
  }

  return [...disabled];
}

function bumpServerToolUse(metrics: CompatRunMetrics, toolName: string): number {
  const count = (metrics.serverToolUseCounts[toolName] ?? 0) + 1;
  metrics.serverToolUseCounts[toolName] = count;
  return count;
}

function buildCompatRuntimeSection(
  provider: OrchestratorSelection['provider'],
  providerName: string,
  model: string,
): string {
  return [
    '# Runtime ativo do orquestrador',
    '',
    '- Runtime: claude-compat-sdk',
    `- Provider: ${providerName} (${provider})`,
    `- Modelo selecionado: ${model}`,
    '',
    'Esta secao tem prioridade sobre qualquer linha generica de Runtime/Modelo em CLAUDE.md.',
    'O Claude Code / Claude Agent SDK e usado aqui apenas como transporte de orquestracao.',
    `O modelo efetivo deste turno e ${model} via ${providerName}.`,
    ...(provider === 'zai'
      ? [
          '',
          'Regras especificas para Z.ai/GLM:',
          '- Nao use ferramentas server-side embutidas do Z.ai como webReader.',
          '- Para pesquisa web, use as ferramentas normais do Claude Code quando disponiveis.',
          '- Para artefatos visuais, use os MCPs locais do LionClaw, como Excalidraw, e finalize no chat.',
          '- Nao use MCPs remotos claude.ai_* neste runtime; eles sao reservados ao Claude SDK principal.',
        ]
      : []),
    ...(provider === 'minimax'
      ? [
          '',
          'Regras especificas para MiniMax (Token Plan):',
          '- Voce esta consumindo cota de assinatura (reset 5h). Seja conciso em respostas longas.',
          '- Nao use ferramentas server-side embutidas do MiniMax se houver; use ferramentas Claude Code.',
          '- Para artefatos visuais, use MCPs locais do LionClaw (Excalidraw, etc).',
        ]
      : []),
  ].join('\n');
}

function sendStream(getWindow: () => BrowserWindow | null, silent: boolean | undefined, chunk: StreamChunk): void {
  if (silent) return;
  try {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('chat:stream', chunk);
    }
  } catch {
    // Render frame disposed (e.g. GPU crash, window reload)
  }
}

function sendLogEntry(getWindow: () => BrowserWindow | null, entry: Omit<AuditEntry, 'id' | 'createdAt'>): void {
  try {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      const liveEntry: AuditEntry = {
        id: -1,
        createdAt: new Date().toISOString(),
        ...entry,
      };
      win.webContents.send('logs:entry', liveEntry);
    }
  } catch {
    // Render frame disposed (e.g. GPU crash, window reload)
  }
}

function serializeError(error: unknown): {
  name?: string;
  message: string;
  stack?: string;
  code?: unknown;
  errno?: unknown;
  syscall?: unknown;
} {
  if (error instanceof Error) {
    const err = error as Error & {
      code?: unknown;
      errno?: unknown;
      syscall?: unknown;
    };
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: err.code,
      errno: err.errno,
      syscall: err.syscall,
    };
  }

  if (typeof error === 'object' && error !== null) {
    try {
      return { message: JSON.stringify(error) };
    } catch {
      return { message: String(error) };
    }
  }

  return { message: String(error) };
}

function estimateClaudeSettingsFilesTokens(): number {
  let total = 0;
  const files = [path.join(getAgentCwd(false), 'CLAUDE.md'), path.join(os.homedir(), '.claude', 'CLAUDE.md')];
  for (const file of files) {
    try {
      total += estimateTokensRough(fs.readFileSync(file, 'utf-8'));
    } catch {
      // Arquivo ausente => bucket 0 (o SDK tambem nao o injetaria).
    }
  }
  return total;
}

export async function buildAgentDefinitions(
  provider: OrchestratorSelection['provider'],
  dispatchContext?: SubagentDispatchContext,
): Promise<Record<string, AgentDefinitionCompat>> {
  const agents = getAllAgents().filter((a: AgentConfig) => a.isActive && a.runtime === 'cloud');
  const definitions: Record<string, AgentDefinitionCompat> = {};

  for (const agent of agents) {
    const resolved = dispatchContext
      ? await resolveSubagentConfigWithinCeiling(agent.id, dispatchContext)
      : { config: await resolveAgentQueryConfig(agent.id) };
    if (!resolved.config) continue;
    const config = resolved.config;

    definitions[agent.id] = {
      description: agent.description,
      tools: dispatchContext
        ? toSdkToolNames(config.allowedTools)
        : config.allowedTools.length > 0
          ? toSdkToolNames(config.allowedTools)
          : undefined,
      prompt: config.systemPrompt || undefined,
      model: provider === 'minimax' ? undefined : agent.model !== 'default' ? agent.model : undefined,
      maxTurns: config.maxTurns || undefined,
      mcpServers: config.mcpServers.length > 0 ? config.mcpServers : [],
    };
  }

  return definitions;
}

export async function executeClaudeCompatSdkQuery(
  message: string,
  options: QueryOptions,
  getWindow: () => BrowserWindow | null,
  laneArg: SdkLane | undefined,
  selection: OrchestratorSelection,
): Promise<void> {
  const lane = laneArg ?? resolveLaneForOptions(options, 'claude-compat-sdk');
  const preset = getClaudeCompatPreset(selection.provider);
  const apiKey = selection.apiKey ?? (await getSecret(preset.apiKeyVaultRef));
  if (!apiKey) {
    const missingKeyChunk: StreamChunk = {
      type: 'error',
      error: `API key do provedor "${preset.displayName}" nao configurada. Va em Settings > External Providers.`,
    };
    options.onStreamChunk?.(missingKeyChunk);
    sendStream(getWindow, options.silent, missingKeyChunk);
    return;
  }

  const sessionId = options.sessionId;
  let shouldContinueSession = false;

  if (!sessionId) {
    logger.error({ lane: lane.name }, 'claude-compat-sdk sem options.sessionId (session_required)');
    throw new SessionRequiredError(lane.name, 'claude-compat-sdk');
  } else {
    const existingMessages = getSessionMessages(sessionId);
    shouldContinueSession = existingMessages.length > 0;
    if (options._forceNewSession) {
      shouldContinueSession = false;
      logger.info({ sessionId }, 'Forced fresh SDK session (retry after resume failure)');
    } else if (!shouldContinueSession) {
      logger.info({ sessionId }, 'Session has no messages, starting fresh SDK session (post-compaction)');
    }
  }

  const sessionRow = getSession(sessionId);
  const pendingSeed = sessionRow?.pendingSeed ?? null;
  const prevLiveContextEst = sessionRow?.activeContextTokensEst ?? 0;
  if (pendingSeed) {
    shouldContinueSession = false;
    logger.info({ sessionId }, 'pending_seed presente: thread SDK nova com seed de compactacao (SPEC 3.4)');
  }

  const threadRecreated = !shouldContinueSession || pendingSeed !== null;
  const preTurnLastMessageId =
    threadRecreated && !pendingSeed
      ? getSessionMessages(sessionId).reduce((mx, m) => Math.max(mx, m.id), 0) || null
      : null;
  let agenticBaseTokens = 0;
  if (threadRecreated) {
    resetSessionAgenticContext(sessionId, pendingSeed ? {} : { threadResetMessageId: preTurnLastMessageId });
  } else {
    agenticBaseTokens = sessionRow?.agenticContextTokensEst ?? 0;
  }
  let effectiveThreadResetId: number | null =
    threadRecreated && !pendingSeed ? preTurnLastMessageId : (sessionRow?.threadResetMessageId ?? null);

  const sdkSessionId = makeScopedSdkSessionId(`claude-compat-sdk:${selection.provider}:${lane.kind}`, sessionId);

  options.onStreamChunk?.({ type: 'session', content: sessionId });
  sendStream(getWindow, options.silent, {
    type: 'session',
    content: sessionId,
    sessionId,
  });

  const sendSessionStream = (chunk: StreamChunk) => {
    options.onStreamChunk?.({ ...chunk, sessionId });
    sendStream(getWindow, options.silent, { ...chunk, sessionId });
  };

  let currentTurnIndex = 0;

  const emitActivity = (a: LiveActivityEvent) => recordActivity(sessionId, currentTurnIndex, a, sendSessionStream);

  const skipUserPersistence = options.origin === 'system-event' || options.skipUserMessagePersistence === true;

  if (skipUserPersistence) {
    currentTurnIndex = getLatestUserTurnIndex(sessionId);
  } else if (!options._forceNewSession) {
    const visibleUserMessage = options.displayMessage ?? message;
    const userMessageId = persistUserChatMessage(sessionId, visibleUserMessage, options.attachmentsMeta);
    currentTurnIndex = getTurnIndexForUserMessage(sessionId, userMessageId);
    ensureInitialSessionTitle(sessionId, visibleUserMessage);
  } else {
    currentTurnIndex = getLatestUserTurnIndex(sessionId);
  }

  const model = selection.model;

  if (options.agentId) {
    setActiveAgentId(options.agentId);
  }

  const isOnboarding = getSetting('onboarding_completed') !== 'true';
  const activeTurnBinding = getActiveChatTurnBinding({ sessionId, lane: lane.kind });
  const chatCaps =
    lane.kind === 'desktop'
      ? (() => {
          const ctx = activeTurnBinding ? getChatCapabilityTurn(activeTurnBinding) : undefined;
          return ctx ? computeEffectiveCapabilitiesForTurn(ctx) : undefined;
        })()
      : undefined;
  const baseSystemPrompt = buildSystemPrompt(options.agentId, {
    mode: 'full',
    isOnboarding,
    model,
    capabilities: chatCaps,
  });
  const compatRuntimeSection = buildCompatRuntimeSection(selection.provider, preset.displayName, model);
  const fullSystemPrompt = isOnboarding
    ? baseSystemPrompt
    : appendRepoGraphSection(`${baseSystemPrompt}\n\n---\n\n${compatRuntimeSection}`, sessionId);

  const permissionGuard = createPermissionGuard(getWindow, { isOnboarding, sessionId });
  lane.currentAbortController = new AbortController();

  let finalMessage = message;
  if (options.attachments && options.attachments.length > 0) {
    const imagePaths: string[] = [];
    for (const att of options.attachments) {
      if (att.type === 'image') {
        const ext = att.mimeType.split('/')[1] || 'png';
        const tmpPath = path.join(os.tmpdir(), `lionclaw-img-${att.id}.${ext}`);
        fs.writeFileSync(tmpPath, Buffer.from(att.data, 'base64'));
        imagePaths.push(tmpPath);
      }
    }
    if (imagePaths.length > 0) {
      const imageRefs = imagePaths.map((p, i) => `[Imagem ${i + 1}: ${p}]`).join('\n');
      finalMessage = `${imageRefs}\n\n${message || 'O usuario enviou estas imagens. Use a ferramenta Read para visualizar cada uma e responda sobre elas.'}`;
    }
  }

  if (pendingSeed) {
    finalMessage = `${pendingSeed}\n\n${finalMessage}`;
  }

  if (isOnboarding) {
    logger.info({ promptLength: fullSystemPrompt.length, hasTools: false }, 'Onboarding: text-only prompt, no tools');
  }

  let mcpServers: Record<string, McpServerConfig> | undefined = await getMCPConfigForAgent(options.agentId, {
    surface: 'claude-compat-sdk',
    capabilities: chatCaps,
    lane: lane.kind,
    ...(activeTurnBinding ? { turn: activeTurnBinding } : {}),
  });

  const allAgents = getAllAgents();
  const hasLocalAgent = allAgents.some((a: AgentConfig) => a.isActive && a.runtime === 'local');
  const hasExternalAgent = allAgents.some((a: AgentConfig) => a.isActive && a.runtime === 'external');

  if (hasLocalAgent || hasExternalAgent) {
    const resolvedRuntime = resolveMcpServerRuntime('local-agents', 'dist/index.js', { cwd: process.cwd() });
    const resolvedPath = resolvedRuntime.entryPath ?? resolvedRuntime.candidates[0];
    if (!resolvedRuntime.command) {
      throw new Error('Runtime Node do MCP local-agents não foi resolvido');
    }

    const lionclawHome = getLionClawHome();

    const envVars: Record<string, string> = { LIONCLAW_HOME: lionclawHome };
    if (hasExternalAgent) {
      const externalAgents = allAgents.filter(
        (a: AgentConfig) => a.isActive && a.runtime === 'external' && a.externalConfig,
      );
      const keyRefs = new Set<string>();
      for (const ag of externalAgents) {
        const ref = ag.externalConfig?.apiKeyRef;
        if (ref) keyRefs.add(ref);
      }
      for (const ref of keyRefs) {
        const value = await getSecret(ref);
        if (value) envVars[ref] = value;
      }
    }

    if (mcpServers) {
      if (!mcpServers['local-agents']) {
        mcpServers['local-agents'] = {
          command: resolvedRuntime.command,
          args: [resolvedPath],
          env: { ...resolvedRuntime.env, ...envVars },
        };
      }
    } else {
      mcpServers = {
        'local-agents': {
          command: resolvedRuntime.command,
          args: [resolvedPath],
          env: { ...resolvedRuntime.env, ...envVars },
        },
      };
    }
  }

  const hasCodexAgent = allAgents.some((a: AgentConfig) => a.isActive && a.runtime === 'codex');
  const subagentCwd = getAgentCwd(isOnboarding);
  const subagentAbortController = lane.currentAbortController;
  if (!subagentAbortController) throw new Error('Turno sem AbortController para subagentes.');
  const subagentDispatchContext = createSubagentDispatchContext({
    ownerKind: 'chat',
    ownerId: sessionId,
    sessionId,
    lane: lane.kind,
    surface: 'claude-compat-sdk',
    cwd: subagentCwd,
    readRoots: [subagentCwd],
    writeRoots: isOnboarding ? [] : [subagentCwd],
    allowedTools: await resolveSubagentHostAllowedTools(getEnabledTools(), Object.keys(mcpServers ?? {})),
    allowedMcpServerIds: Object.keys(mcpServers ?? {}),
    permission: PERM_DEFAULT_WITH_GUARD(permissionGuard),
    parentAbortSignal: subagentAbortController.signal,
    abortOwner: (reason) => subagentAbortController.abort(reason),
    inheritedEffort: resolveChatInheritedEffort(selection.runtime, selection.effort),
  });
  if (hasCodexAgent) {
    const codexServerConfig: McpSdkServerConfigWithInstance = await getCodexAgentsServer(subagentDispatchContext);
    if (mcpServers) {
      if (!mcpServers['codex-agents']) {
        mcpServers['codex-agents'] = codexServerConfig;
      }
    } else {
      mcpServers = { 'codex-agents': codexServerConfig };
    }
  }

  const agentDefinitions = isOnboarding ? {} : await buildAgentDefinitions(selection.provider, subagentDispatchContext);
  const metrics: CompatRunMetrics = {
    sdkMessages: 0,
    toolUses: 0,
    mcpToolUses: 0,
    serverToolUses: 0,
    toolResults: 0,
    compactions: 0,
    lastToolName: null,
    serverToolUseCounts: {},
  };
  const startedAt = Date.now();

  let turnOk = false;
  let swarmResultSucceeded = false;
  const nativeTaskRootExecutionId = subagentDispatchContext.rootExecutionId;
  smokeAudit('turn_start', { lane: lane.name, runtime: 'claude-compat-sdk', sessionId });

  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    ensureNodeInPath();
    const processOptions = getClaudeSdkProcessOptions();

    resetArtifactDetector();
    logger.info(
      {
        provider: selection.provider,
        model,
        sessionId,
        sdkSessionId,
        forceNewSession: !!options._forceNewSession,
        maxTurns: COMPAT_DEFAULT_MAX_TURNS,
      },
      'Claude-compat SDK query started',
    );

    let assistantContent = '';
    let inTool = false;
    let currentToolName: string | null = null;
    let currentParentToolUseId: string | null = null;
    let currentToolActivityId: string | null = null;
    let toolActivitySeq = 0;
    const toolNameById = new Map<string, string>();
    const collectedArtifacts: ArtifactData[] = [];
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    let turnCacheReadTokens = 0;
    let turnCacheCreationTokens = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;
    let sidechainInputTokens = 0;
    let sidechainOutputTokens = 0;
    let sidechainCacheReadTokens = 0;
    let sidechainCacheCreationTokens = 0;
    let turnParentToolUseId: string | null = null;
    let sawSidechainTurn = false;
    const accumulateTurnUsage = (): void => {
      if (turnParentToolUseId) {
        sidechainInputTokens += turnInputTokens;
        sidechainOutputTokens += turnOutputTokens;
        sidechainCacheReadTokens += turnCacheReadTokens;
        sidechainCacheCreationTokens += turnCacheCreationTokens;
      } else {
        totalInputTokens += turnInputTokens;
        totalOutputTokens += turnOutputTokens;
        totalCacheReadTokens += turnCacheReadTokens;
        totalCacheCreationTokens += turnCacheCreationTokens;
      }
    };
    let resultUsage: Record<string, number> | null = null;
    let lastMainUsageRaw: Record<string, number> | null = null;
    let lastMainOutput = 0;
    let mainRequestCount = 0;
    let agenticTurnTokens = 0;
    let boundaryFenceMessageId: number | null = null;

    const subagentTokens = new Map<
      string,
      {
        agentId: string | null;
        agentName: string | null;
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        requestCount: number;
      }
    >();

    const taskMap = new Map<
      string,
      {
        taskId: string;
        description: string;
        agentId: string | null;
        executionId?: string;
      }
    >();
    let pendingAgentId: string | null = null;
    const shouldContinueSdkSession =
      lane.kind !== 'desktop' && shouldContinueSession && lane.sdkActiveSessionId === sdkSessionId;

    const q = query({
      prompt: finalMessage,
      options: {
        env: buildCompatEnv({ ...selection, model, apiKey }),
        ...processOptions,
        cwd: getAgentCwd(isOnboarding),
        model,
        maxTurns: COMPAT_DEFAULT_MAX_TURNS,
        includePartialMessages: true,
        systemPrompt: isOnboarding
          ? fullSystemPrompt
          : {
              type: 'preset',
              preset: 'claude_code' as const,
              append: fullSystemPrompt,
            },
        ...(isOnboarding
          ? {
              allowedTools: [],
              disallowedTools: [...SDK_DISALLOWED_TOOLS],
              settingSources: [],
            }
          : {
              allowedTools: toSdkToolNames(getEnabledTools().filter((t) => !GUARD_GATED_TOOLS.includes(t))),
              disallowedTools: [...SDK_DISALLOWED_TOOLS],
              permissionMode: 'default' as const,
              settingSources: ['project', 'user'],
              canUseTool: (tool: string, input: Record<string, unknown>) => permissionGuard(tool, input),
              agents: agentDefinitions as Record<string, AgentDefinition>,
              hooks: {
                SubagentStart: [
                  {
                    hooks: [
                      async (input: Record<string, unknown>) => {
                        const agentId =
                          typeof input['agent_type'] === 'string'
                            ? input['agent_type']
                            : String(input['agent_id'] ?? '');
                        const reservationContext =
                          typeof input['agent_id'] === 'string'
                            ? { ...subagentDispatchContext, depth: MAX_SUBAGENT_DEPTH }
                            : subagentDispatchContext;
                        const refusal = reserveSubagentInvocation(reservationContext, agentId);
                        if (refusal) return { continue: false, stopReason: refusal };
                        pendingAgentId = agentId;
                        return { continue: true };
                      },
                    ],
                  },
                ],
              },
            }),
        ...(shouldContinueSdkSession
          ? { continue: true }
          : shouldContinueSession
            ? { resume: sdkSessionId }
            : { sessionId: sdkSessionId }),
        abortController: lane.currentAbortController,
        stderr: (data: string) => {
          const chunk = data.trim();
          if (chunk) {
            logger.warn({ provider: selection.provider, model, sessionId, stderr: chunk }, 'Claude-compat SDK stderr');
          }
        },
        ...(!isOnboarding && mcpServers ? { mcpServers } : {}),
        ...(options.swarmDelivery ? swarmAggregationSdkOptions() : {}),
      },
    });

    if (!isOnboarding) {
      const disabledSdkMcps = getCompatDisabledSdkMcps(selection.provider);
      const hasBuiltinExcalidraw = mcpServers && Object.keys(mcpServers).includes('excalidraw');
      if (hasBuiltinExcalidraw) {
        disabledSdkMcps.push('claude_ai_Excalidraw');
      }
      const uniqueDisabledSdkMcps = [...new Set(disabledSdkMcps)];
      if (selection.provider === 'zai' && uniqueDisabledSdkMcps.length > 0) {
        logger.info(
          {
            sessionId,
            provider: selection.provider,
            disabledSdkMcps: uniqueDisabledSdkMcps,
          },
          'Claude-compat disabling SDK-managed remote MCPs',
        );
      }
      for (const name of uniqueDisabledSdkMcps) {
        try {
          await q.toggleMcpServer(name, false);
        } catch {
          // Server may not exist anymore, ignore
        }
      }
    }

    for await (const sdkMessage of q) {
      metrics.sdkMessages += 1;
      if (sdkMessage.type === 'stream_event') {
        const event = sdkMessage.event as unknown as Record<string, unknown>;

        if (event.type === 'content_block_start') {
          const contentBlock = event.content_block as Record<string, unknown>;
          if (
            contentBlock.type === 'tool_use' ||
            contentBlock.type === 'mcp_tool_use' ||
            contentBlock.type === 'server_tool_use'
          ) {
            const rawToolName = (contentBlock.name as string | undefined) || 'unknown';
            currentToolName = contentBlock.type === 'server_tool_use' ? `server:${rawToolName}` : rawToolName;
            metrics.lastToolName = currentToolName;
            inTool = true;
            sendSessionStream({
              type: 'tool_call',
              tool: currentToolName,
              input:
                contentBlock.input && typeof contentBlock.input === 'object' && !Array.isArray(contentBlock.input)
                  ? (contentBlock.input as Record<string, unknown>)
                  : {},
            });

            if (currentToolName === 'Task') {
              currentToolActivityId = null;
            } else {
              currentToolActivityId = (contentBlock.id as string) || `tool-${++toolActivitySeq}`;
              emitActivity({
                id: currentToolActivityId,
                parentId: currentParentToolUseId ?? undefined,
                kind: 'tool',
                phase: 'start',
                label: currentToolName,
                status: 'running',
                toolName: currentToolName,
                startedAt: new Date().toISOString(),
              });
            }

            if (contentBlock.type === 'server_tool_use') {
              logger.info(
                {
                  sessionId,
                  provider: selection.provider,
                  model,
                  toolUseId: contentBlock.id,
                  toolName: rawToolName,
                  inputKeys: getInputKeys(contentBlock.input),
                  sdkMessages: metrics.sdkMessages,
                },
                'Claude-compat server tool use started',
              );
            }
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown>;
          if (delta.type === 'text_delta' && !inTool) {
            const text = delta.text as string;
            assistantContent += text;
            sendSessionStream({ type: 'text', content: text });
          }
        } else if (event.type === 'content_block_stop') {
          if (inTool && currentToolName) {
            inTool = false;
            currentToolName = null;
            if (currentToolActivityId) {
              emitActivity({
                id: currentToolActivityId,
                kind: 'tool',
                phase: 'end',
                label: '',
                status: 'done',
                endedAt: new Date().toISOString(),
              });
              currentToolActivityId = null;
            }
          }
        } else if (event.type === 'message_start') {
          const parentToolUseId = (sdkMessage as Record<string, unknown>).parent_tool_use_id as
            string | null | undefined;
          currentParentToolUseId = parentToolUseId ?? null;

          if (!parentToolUseId) mainRequestCount += 1;

          accumulateTurnUsage();
          turnParentToolUseId = parentToolUseId ?? null;
          sawSidechainTurn ||= parentToolUseId !== null && parentToolUseId !== undefined;
          turnInputTokens = 0;
          turnOutputTokens = 0;
          turnCacheReadTokens = 0;
          turnCacheCreationTokens = 0;

          const msg = event.message as Record<string, unknown> | undefined;
          const usage = msg?.usage as Record<string, number> | undefined;
          if (usage) {
            const inputBase = usage.input_tokens || 0;
            const cacheRead = usage.cache_read_input_tokens || 0;
            const cacheCreation = usage.cache_creation_input_tokens || 0;
            turnInputTokens = inputBase + cacheRead + cacheCreation;
            turnCacheReadTokens = cacheRead;
            turnCacheCreationTokens = cacheCreation;

            if (!parentToolUseId) {
              lastMainUsageRaw = usage;
              lastMainOutput = 0;
            }

            if (parentToolUseId) {
              const msgModel = (msg?.model as string) || model;
              const existing = subagentTokens.get(parentToolUseId);
              if (existing) {
                existing.inputTokens += turnInputTokens;
                existing.cacheReadTokens += cacheRead;
                existing.cacheCreationTokens += cacheCreation;
                existing.requestCount += 1;
                if (msgModel && !existing.model) {
                  existing.model = msgModel;
                }
              } else {
                subagentTokens.set(parentToolUseId, {
                  agentId: null,
                  agentName: null,
                  model: msgModel,
                  inputTokens: turnInputTokens,
                  outputTokens: 0,
                  cacheReadTokens: cacheRead,
                  cacheCreationTokens: cacheCreation,
                  requestCount: 1,
                });
              }
            }

            sendSessionStream({
              type: 'usage',
              usage: {
                inputTokens: totalInputTokens + sidechainInputTokens + turnInputTokens,
                outputTokens: totalOutputTokens + sidechainOutputTokens,
                cacheReadTokens: totalCacheReadTokens + sidechainCacheReadTokens + cacheRead,
                cacheCreationTokens: totalCacheCreationTokens + sidechainCacheCreationTokens + cacheCreation,
              },
            });
          }
        } else if (event.type === 'message_delta') {
          const parentToolUseId = (sdkMessage as Record<string, unknown>).parent_tool_use_id as
            string | null | undefined;
          const usage = event.usage as Record<string, number> | undefined;
          if (usage) {
            turnOutputTokens = usage.output_tokens || 0;

            if (!parentToolUseId) {
              lastMainOutput = turnOutputTokens;
            }

            if (parentToolUseId) {
              const existing = subagentTokens.get(parentToolUseId);
              if (existing) {
                existing.outputTokens += turnOutputTokens;
              }
            }

            const liveInput = totalInputTokens + sidechainInputTokens + turnInputTokens;
            const inputIsEstimated = liveInput === 0;
            sendSessionStream({
              type: 'usage',
              usage: {
                inputTokens: inputIsEstimated
                  ? Math.max(prevLiveContextEst, estimateRequestTokens({ messageTexts: [finalMessage] }))
                  : liveInput,
                outputTokens: totalOutputTokens + sidechainOutputTokens + turnOutputTokens,
                cacheReadTokens: totalCacheReadTokens + sidechainCacheReadTokens + turnCacheReadTokens,
                cacheCreationTokens: totalCacheCreationTokens + sidechainCacheCreationTokens + turnCacheCreationTokens,
                ...(inputIsEstimated ? { estimated: true } : {}),
              },
            });
          }
        }
      } else if (sdkMessage.type === 'assistant') {
        const blockTypes = sdkMessage.message.content.map((b) => b.type);
        logger.info({ blockTypes }, 'Assistant message block types');

        const assistantParentToolUseId =
          ((sdkMessage as unknown as Record<string, unknown>).parent_tool_use_id as string | null | undefined) ?? null;

        for (const block of sdkMessage.message.content) {
          const blockAny = block as unknown as Record<string, unknown>;

          if (block.type === 'tool_use' || blockAny.type === 'mcp_tool_use') {
            const toolName = (blockAny.name as string) || '';
            const toolInput = (blockAny.input as Record<string, unknown>) || {};
            const toolId = (blockAny.id as string) || crypto.randomUUID();
            if (!assistantParentToolUseId) {
              agenticTurnTokens += estimateAgenticContentTokens(toolInput);
            }
            metrics.toolUses += 1;
            if (blockAny.type === 'mcp_tool_use') {
              metrics.mcpToolUses += 1;
            }
            metrics.lastToolName = toolName;

            const toolCallEntry: Omit<AuditEntry, 'id' | 'createdAt'> = {
              sessionId,
              subagent: options.agentId,
              eventType: 'tool_call',
              toolName,
              input: JSON.stringify(toolInput).substring(0, 1000),
            };
            insertAuditEntry(toolCallEntry);
            sendLogEntry(getWindow, toolCallEntry);

            if (toolName !== 'Task') {
              toolNameById.set(toolId, toolName);
              const detail = deriveToolDetail(toolName, toolInput);
              emitActivity({
                id: toolId,
                kind: 'tool',
                phase: 'update',
                label: toolName,
                toolName,
                file: detail.file,
                command: detail.command,
                description: detail.description,
              });
            }

            const artifact = captureToolUse(toolId, toolName, toolInput);
            if (artifact) {
              collectedArtifacts.push(artifact);
              sendSessionStream({ type: 'artifact', artifact });
            }
          }

          if (blockAny.type === 'server_tool_use') {
            const rawToolName = (blockAny.name as string | undefined) || 'unknown';
            const toolInput = blockAny.input;
            const toolId = (blockAny.id as string) || crypto.randomUUID();
            const toolName = `server:${rawToolName}`;
            if (!assistantParentToolUseId) {
              agenticTurnTokens += estimateAgenticContentTokens(toolInput);
            }
            metrics.serverToolUses += 1;
            metrics.lastToolName = toolName;
            const serverToolUseCount = bumpServerToolUse(metrics, rawToolName);

            const toolCallEntry: Omit<AuditEntry, 'id' | 'createdAt'> = {
              sessionId,
              subagent: options.agentId,
              eventType: 'tool_call',
              toolName,
              input: serializeToolInput(toolInput),
            };
            insertAuditEntry(toolCallEntry);
            sendLogEntry(getWindow, toolCallEntry);

            logger.info(
              {
                sessionId,
                provider: selection.provider,
                model,
                toolUseId: toolId,
                toolName: rawToolName,
                serverToolUseCount,
                inputKeys: getInputKeys(toolInput),
                metrics,
                elapsedMs: Date.now() - startedAt,
              },
              'Claude-compat server tool use captured',
            );

            if (
              selection.provider === 'zai' &&
              ZAI_LOOP_PRONE_SERVER_TOOLS.has(rawToolName) &&
              serverToolUseCount > ZAI_SERVER_TOOL_REPEAT_LIMIT
            ) {
              throw new Error(
                `Z.ai built-in server tool "${rawToolName}" repetiu ${serverToolUseCount} vezes sem finalizar o turno. Abortando para evitar loop; tente usar WebSearch/WebFetch ou um MCP local.`,
              );
            }
          }

          if (blockAny.type === 'mcp_tool_result' || blockAny.type === 'tool_result') {
            metrics.toolResults += 1;
            if (!assistantParentToolUseId) {
              agenticTurnTokens += estimateAgenticContentTokens(blockAny.content);
            }
            const resultContent =
              typeof blockAny.content === 'string'
                ? blockAny.content
                : Array.isArray(blockAny.content)
                  ? (blockAny.content as Array<{ text?: string }>).map((b) => b.text || '').join('')
                  : '';
            const resultToolUseId = blockAny.tool_use_id as string | undefined;
            if (resultToolUseId) {
              const isError = blockAny.is_error === true;
              const resultToolName = toolNameById.get(resultToolUseId);
              emitActivity({
                id: resultToolUseId,
                kind: 'tool',
                phase: 'update',
                label: resultToolName ?? '',
                status: isError ? 'error' : 'done',
                changed: !isError && isWriteTool(resultToolName),
                endedAt: new Date().toISOString(),
              });
            }

            const artifact = captureToolResult(
              blockAny.tool_use_id as string,
              resultContent,
              blockAny.is_error as boolean,
            );
            if (artifact) {
              collectedArtifacts.push(artifact);
              sendSessionStream({ type: 'artifact', artifact });
            }
          }
        }
        const fullText = sdkMessage.message.content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { type: string; text?: string }) => b.text || '')
          .join('');
        if (fullText && fullText.length > assistantContent.length) {
          const missing = fullText.slice(assistantContent.length);
          if (missing) {
            sendSessionStream({ type: 'text', content: missing });
          }
          assistantContent = fullText;
        }
      } else if (sdkMessage.type === 'user') {
        const userContent = Array.isArray(sdkMessage.message.content) ? sdkMessage.message.content : [];
        const userParentToolUseId =
          ((sdkMessage as unknown as Record<string, unknown>).parent_tool_use_id as string | null | undefined) ?? null;
        for (const contentBlock of userContent) {
          const block = contentBlock as unknown as Record<string, unknown>;
          if (block.type === 'mcp_tool_result' || block.type === 'tool_result') {
            metrics.toolResults += 1;
            if (!userParentToolUseId) {
              agenticTurnTokens += estimateAgenticContentTokens(block.content);
            }
            const resultContent =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? (block.content as Array<{ text?: string }>).map((b) => b.text || '').join('')
                  : '';
            const resultToolUseId = block.tool_use_id as string | undefined;
            if (resultToolUseId) {
              const isError = block.is_error === true;
              const resultToolName = toolNameById.get(resultToolUseId);
              emitActivity({
                id: resultToolUseId,
                kind: 'tool',
                phase: 'update',
                label: resultToolName ?? '',
                status: isError ? 'error' : 'done',
                changed: !isError && isWriteTool(resultToolName),
                endedAt: new Date().toISOString(),
              });
            }

            const artifact = captureToolResult(block.tool_use_id as string, resultContent, block.is_error as boolean);
            if (artifact) {
              collectedArtifacts.push(artifact);
              sendSessionStream({ type: 'artifact', artifact });
            }
          }
        }
      } else if (sdkMessage.type === 'result') {
        if (options.swarmDelivery) swarmResultSucceeded = sdkMessage.subtype === 'success' && !sdkMessage.is_error;
        const rUsage = (sdkMessage as unknown as { usage?: Record<string, number> }).usage;
        if (rUsage) resultUsage = rUsage;
        if (assistantContent.includes('ARQUIVO_AUDIO:')) {
          const audioMatches = assistantContent.matchAll(/ARQUIVO_AUDIO:\s*(.+?)(?:\n|$)/g);
          for (const match of audioMatches) {
            const audioPath = match[1].trim();
            const artifact = captureToolResult('text-detect', `ARQUIVO_AUDIO: ${audioPath}`, false);
            if (artifact) {
              collectedArtifacts.push(artifact);
              sendSessionStream({ type: 'artifact', artifact });
            }
          }
        }
        sendSessionStream({ type: 'done', content: sessionId });
      } else {
        const msgAny = sdkMessage as Record<string, unknown>;
        if (msgAny.type === 'system') {
          const subtype = msgAny.subtype as string;

          if (subtype === 'init') {
            logger.debug({ sessionId, provider: selection.provider, tools: msgAny.tools }, 'sdk init tools');
          }

          if (subtype === 'status') {
            const status = msgAny.status as string | null;
            if (status === 'compacting') {
              metrics.compactions += 1;
              sendSessionStream({ type: 'compacting', isCompacting: true });
              logger.info(
                {
                  sessionId,
                  provider: selection.provider,
                  metrics,
                  elapsedMs: Date.now() - startedAt,
                },
                'SDK compaction started',
              );
            } else if (status === null) {
              sendSessionStream({ type: 'compacting', isCompacting: false });
              logger.info(
                {
                  sessionId,
                  provider: selection.provider,
                  metrics,
                  elapsedMs: Date.now() - startedAt,
                },
                'SDK compaction finished',
              );
            }
          }

          if (subtype === 'compact_boundary') {
            const metadata = msgAny.compact_metadata as {
              trigger: string;
              pre_tokens: number;
            };
            logger.info(
              {
                sessionId,
                trigger: metadata.trigger,
                preTokens: metadata.pre_tokens,
                provider: selection.provider,
                metrics,
                elapsedMs: Date.now() - startedAt,
              },
              'SDK compact boundary',
            );
            insertAuditEntry({
              sessionId,
              eventType: 'tool_call',
              toolName: 'system:sdk_compaction',
              output: `Compactacao ${metadata.trigger}: ${metadata.pre_tokens} tokens antes`,
            });
            agenticBaseTokens = 0;
            agenticTurnTokens = 0;
            const boundaryLastMsgId = getSessionMessages(sessionId).reduce((mx, m) => Math.max(mx, m.id), 0) || null;
            boundaryFenceMessageId = boundaryLastMsgId;
            if (boundaryLastMsgId !== null) {
              effectiveThreadResetId = boundaryLastMsgId;
            }
          }

          if (subtype === 'task_started') {
            const taskId = msgAny.task_id as string;
            const toolUseId = msgAny.tool_use_id as string;
            const description = (msgAny.description as string) || '';
            const taskType = (msgAny.task_type as string) || '';

            const capturedAgentId = pendingAgentId;
            pendingAgentId = null;

            let resolvedId: string | null = null;
            let resolvedName: string | null = null;

            if (capturedAgentId) {
              const agentRecord = getAgent(capturedAgentId);
              if (agentRecord) {
                resolvedId = capturedAgentId;
                resolvedName = agentRecord.name;
              }
            }

            if (!resolvedId && taskType) {
              const agentRecord = getAgent(taskType);
              if (agentRecord) {
                resolvedId = taskType;
                resolvedName = agentRecord.name;
              }
            }

            if (!resolvedName) {
              resolvedName = description || taskId;
            }

            let executionId = taskMap.get(toolUseId)?.executionId;
            if (!executionId) {
              const candidateExecutionId = crypto.randomUUID();
              const compatRuntime = selection.provider === 'minimax' ? 'minimax-tp' : 'zai';
              try {
                startTaskExecution({
                  executionId: nativeTaskRootExecutionId,
                  rootExecutionId: nativeTaskRootExecutionId,
                  parentExecutionId: null,
                  executionKind: 'root',
                  ownerKind: 'chat',
                  ownerId: sessionId,
                  sessionId,
                  toolUseId: null,
                  agentId: null,
                  agentName: 'root',
                  model: '',
                  description: subagentDispatchContext.surface,
                  runtime: null,
                  provider: null,
                  metadata: { lane: subagentDispatchContext.lane, surface: subagentDispatchContext.surface },
                });
                startTaskExecution({
                  executionId: candidateExecutionId,
                  taskId,
                  rootExecutionId: nativeTaskRootExecutionId,
                  parentExecutionId: nativeTaskRootExecutionId,
                  executionKind: 'native-task',
                  ownerKind: 'chat',
                  ownerId: sessionId,
                  sessionId,
                  toolUseId,
                  agentId: resolvedId,
                  agentName: resolvedName,
                  model,
                  description,
                  runtime: compatRuntime,
                  provider: selection.provider,
                  metadata: { source: 'sdk-native-task', taskId },
                });
                executionId = candidateExecutionId;
              } catch (err) {
                logger.error({ err, toolUseId }, 'Failed to start native task execution ledger');
              }
            }

            taskMap.set(toolUseId, {
              taskId,
              description,
              agentId: resolvedId,
              ...(executionId ? { executionId } : {}),
            });

            const tokenEntry = subagentTokens.get(toolUseId);
            if (tokenEntry) {
              tokenEntry.agentId = resolvedId;
              tokenEntry.agentName = resolvedName;
            }

            logger.info(
              {
                taskId,
                toolUseId,
                agentId: resolvedId,
                agentName: resolvedName,
                taskType,
                description,
              },
              'Task started',
            );

            emitActivity({
              id: toolUseId,
              kind: 'subagent',
              phase: 'start',
              label: resolvedName,
              status: 'running',
              agentId: resolvedId,
              description: description || undefined,
              startedAt: new Date().toISOString(),
            });
          }

          if (subtype === 'task_notification') {
            const toolUseId = msgAny.tool_use_id as string;
            const taskId = (msgAny.task_id as string) || '';
            const taskStatus = (msgAny.status as string) || 'completed';
            const summary = (msgAny.summary as string) || '';
            const notifUsage = msgAny.usage as Record<string, number> | undefined;

            const taskMeta = taskMap.get(toolUseId);

            const tokenEntry =
              subagentTokens.get(toolUseId) ||
              (taskId ? subagentTokens.get(taskId) : undefined) ||
              (taskMeta?.taskId ? subagentTokens.get(taskMeta.taskId) : undefined);

            const effectiveTokens = tokenEntry;

            const resolvedAgentId = taskMeta?.agentId ?? effectiveTokens?.agentId ?? null;
            let resolvedAgentName = effectiveTokens?.agentName ?? taskMeta?.description ?? '';
            if (!resolvedAgentName && resolvedAgentId) {
              const agentRecord = getAgent(resolvedAgentId);
              resolvedAgentName = agentRecord?.name ?? resolvedAgentId;
            }
            if (!resolvedAgentName) {
              resolvedAgentName = summary || taskId || toolUseId;
            }

            const resolvedModel = effectiveTokens?.model || model;
            const inputTokens = effectiveTokens?.inputTokens ?? 0;
            const outputTokens = effectiveTokens?.outputTokens ?? 0;
            const cacheReadTokens = effectiveTokens?.cacheReadTokens ?? 0;
            const cacheCreationTokens = effectiveTokens?.cacheCreationTokens ?? 0;
            const apiRequests = effectiveTokens?.requestCount ?? 0;
            const toolUsesCount = notifUsage?.tool_uses ?? 0;
            const durationMs = notifUsage?.duration_ms ?? 0;

            const costUsd = calculateCost(
              resolvedModel,
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheCreationTokens,
            );

            emitActivity({
              id: toolUseId,
              kind: 'subagent',
              phase: 'end',
              label: resolvedAgentName,
              status: taskStatus === 'completed' ? 'done' : 'error',
              agentId: resolvedAgentId,
              model: resolvedModel,
              tokens: {
                input: inputTokens,
                output: outputTokens,
                cacheRead: cacheReadTokens,
                cacheCreation: cacheCreationTokens,
              },
              costUsd,
              durationMs,
              summary,
              toolUses: toolUsesCount,
              description: taskMeta?.description || undefined,
              endedAt: new Date().toISOString(),
            });

            if (taskMeta?.executionId) {
              const hasReportedUsage = Boolean(effectiveTokens && inputTokens > 0 && apiRequests > 0);
              try {
                finalizeTaskExecutionOnce(taskMeta.executionId, {
                  status:
                    taskStatus === 'completed'
                      ? 'completed'
                      : taskStatus === 'cancelled' || taskStatus === 'stopped'
                        ? 'cancelled'
                        : 'failed',
                  summary,
                  model: resolvedModel,
                  runtime: selection.provider === 'minimax' ? 'minimax-tp' : 'zai',
                  provider: selection.provider,
                  inputTokens,
                  outputTokens,
                  cacheReadTokens,
                  cacheCreationTokens,
                  costUsd,
                  apiRequests,
                  toolUses: toolUsesCount,
                  durationMs,
                  costStatus: !hasReportedUsage ? 'unknown' : hasKnownPricing(resolvedModel) ? 'known' : 'unknown',
                  tokenStatus: hasReportedUsage ? 'reported' : 'not_reported',
                  costUnknownReason: !hasReportedUsage
                    ? 'no-usage-reported'
                    : hasKnownPricing(resolvedModel)
                      ? null
                      : 'unknown-pricing',
                  metadata: { source: 'sdk-native-task', taskId: taskMeta.taskId },
                });
              } catch (err) {
                logger.error({ err, toolUseId }, 'Failed to finalize native task execution ledger');
              }
            }

            try {
              if (!taskMeta?.executionId) {
                insertTaskExecution({
                  sessionId,
                  taskId: taskMeta?.taskId ?? toolUseId,
                  toolUseId,
                  agentId: resolvedAgentId,
                  agentName: resolvedAgentName,
                  model: resolvedModel,
                  description: taskMeta?.description ?? '',
                  status: taskStatus,
                  summary,
                  inputTokens,
                  outputTokens,
                  cacheReadTokens,
                  cacheCreationTokens,
                  costUsd,
                  apiRequests,
                  toolUses: toolUsesCount,
                  durationMs,
                });
              }

              insertAuditEntry({
                sessionId,
                subagent: resolvedAgentId ?? undefined,
                eventType: 'tool_call',
                toolName: 'system:task_execution',
                output: `Tarefa concluida (${taskStatus}): ${summary || taskMeta?.description || toolUseId} | tokens: ${inputTokens}in/${outputTokens}out | custo: $${costUsd.toFixed(6)}`,
              });
            } catch (err) {
              logger.error({ err, toolUseId }, 'Failed to insert task execution');
            }

            taskMap.delete(toolUseId);
            subagentTokens.delete(toolUseId);
            if (taskId) subagentTokens.delete(taskId);
            if (taskMeta?.taskId) subagentTokens.delete(taskMeta.taskId);
          }
        }
      }
    }

    const childAuthError = pendingSubagentProviderAuthError(subagentDispatchContext);
    if (childAuthError) throw childAuthError;
    lane.sdkActiveSessionId = sdkSessionId;
    if (options.swarmDelivery && (!swarmResultSucceeded || lane.currentAbortController?.signal.aborted)) {
      throw new Error('Agregação Swarm terminou sem resultado final bem-sucedido.');
    }
    turnOk = true;

    if (pendingSeed) {
      clearSessionPendingSeed(sessionId);
      logger.info({ sessionId, sdkSessionId }, 'pending_seed consumido no sucesso do turno (SPEC 3.4)');
    }

    logger.info(
      {
        sessionId,
        sdkSessionId,
        provider: selection.provider,
        model,
        metrics,
        elapsedMs: Date.now() - startedAt,
      },
      'Claude-compat SDK query finished',
    );

    accumulateTurnUsage();

    if (resultUsage && !sawSidechainTurn) {
      const rCacheRead = resultUsage.cache_read_input_tokens || 0;
      const rCacheCreation = resultUsage.cache_creation_input_tokens || 0;
      const rInput = (resultUsage.input_tokens || 0) + rCacheRead + rCacheCreation;
      totalInputTokens = Math.max(totalInputTokens, rInput);
      totalOutputTokens = Math.max(totalOutputTokens, resultUsage.output_tokens || 0);
      totalCacheReadTokens = Math.max(totalCacheReadTokens, rCacheRead);
      totalCacheCreationTokens = Math.max(totalCacheCreationTokens, rCacheCreation);
    }

    const parentUsageReported = mainRequestCount === 0 || totalInputTokens > 0;
    if (totalInputTokens > 0 || totalOutputTokens > 0 || !parentUsageReported) {
      const totalCost = calculateCost(
        model,
        totalInputTokens,
        totalOutputTokens,
        totalCacheReadTokens,
        totalCacheCreationTokens,
      );
      const runtime = selection.provider === 'minimax' ? 'minimax-tp' : 'zai';
      if (parentUsageReported) {
        updateSessionTokens(sessionId, totalInputTokens, totalOutputTokens, totalCost, {
          costStatus: 'known',
          tokenStatus: 'reported',
          runtime,
          ...(runtime === 'minimax-tp' ? { costEstimationKind: 'subscription-equivalent-payg' as const } : {}),
        });
      } else {
        updateSessionTokens(sessionId, totalInputTokens, totalOutputTokens, totalCost, {
          costStatus: 'unknown',
          tokenStatus: 'not_reported',
          costUnknownReason: 'no-usage-reported',
          runtime,
          ...(runtime === 'minimax-tp' ? { costEstimationKind: 'subscription-equivalent-payg' as const } : {}),
        });
      }
    }
    const combinedInputTokens = totalInputTokens + sidechainInputTokens;
    const combinedOutputTokens = totalOutputTokens + sidechainOutputTokens;
    if (combinedInputTokens > 0 || combinedOutputTokens > 0) {
      sendSessionStream({
        type: 'usage',
        usage: {
          inputTokens: combinedInputTokens,
          outputTokens: combinedOutputTokens,
          cacheReadTokens: totalCacheReadTokens + sidechainCacheReadTokens,
          cacheCreationTokens: totalCacheCreationTokens + sidechainCacheCreationTokens,
        },
      });
    }

    const compatImageCount = options.attachments?.filter((a) => a.type === 'image').length ?? 0;
    const historyFence = resolveHistoryFence(sessionRow?.compactedUpToMessageId ?? null, effectiveThreadResetId);
    const fencedMessages = getSessionMessagesAfterFence(sessionId, historyFence);
    const compatMessageTexts: string[] = [];
    if (pendingSeed) {
      compatMessageTexts.push(pendingSeed);
    } else if (sessionRow?.rollingSummary) {
      compatMessageTexts.push(sessionRow.rollingSummary);
    }
    for (const m of fencedMessages) compatMessageTexts.push(m.content);
    if (skipUserPersistence || options._forceNewSession) {
      compatMessageTexts.push(finalMessage);
    }
    compatMessageTexts.push(assistantContent);
    const indexMode = !!(mcpServers && mcpServers[MCP_GATEWAY_SERVER_ID]);
    const compositionServerIds = mcpServers ? Object.keys(mcpServers) : [];
    const compositionAgentIds = Object.keys(agentDefinitions);
    const staticTokens = isOnboarding
      ? { settingsFilesTokens: 0, mcpSchemasTokens: 0, agentDefsTokens: 0 }
      : getOrComputeCompositionStatic(
          computeCompositionSignature({
            runtimeKey: `claude-compat-sdk:${selection.provider}`,
            sdkVersion: CONTEXT_CALIBRATION_SDK_VERSION,
            mcpServerIds: compositionServerIds,
            mode: indexMode ? 'index' : 'full',
            capabilityKey: JSON.stringify(chatCaps ?? null),
            systemPromptLength: fullSystemPrompt.length,
            agentIds: compositionAgentIds,
          }),
          () => {
            const idSet = new Set(compositionServerIds);
            const rows = getMcpToolRegistryEntries().filter((r) => idSet.has(r.mcpId));
            const mcpJson = serializeMcpSchemasForContext(rows, {
              includeGatewayMeta: indexMode,
            });
            return {
              settingsFilesTokens: estimateClaudeSettingsFilesTokens(),
              mcpSchemasTokens: mcpJson ? estimateTokensRough(mcpJson) : 0,
              agentDefsTokens: compositionAgentIds.reduce(
                (sum, agentId) =>
                  sum + estimateTokensRough(`${agentId} ${String(agentDefinitions[agentId]?.description ?? '')}`),
                0,
              ),
            };
          },
        );
    const compatContextEstimate = isOnboarding
      ? estimateStrongFloor({
          systemPrompt: fullSystemPrompt,
          messageTexts: compatMessageTexts,
          imageCount: compatImageCount,
        })
      : estimateStrongFloor({
          systemPrompt: fullSystemPrompt,
          presetTokens: CLI_PRESET_TOKENS,
          builtinSchemasTokens: CLI_BUILTIN_SCHEMAS_TOKENS,
          settingsFilesTokens: staticTokens.settingsFilesTokens,
          mcpSchemasTokens: staticTokens.mcpSchemasTokens,
          agentDefsTokens: staticTokens.agentDefsTokens,
          messageTexts: compatMessageTexts,
          agenticTokens: agenticBaseTokens + agenticTurnTokens,
          imageCount: compatImageCount,
        });
    const singleRequestTurn = mainRequestCount <= 1;
    const lastMainCanonical = lastMainUsageRaw ? normalizeUsage(lastMainUsageRaw, 'anthropic') : null;
    const lastMainPrompt = lastMainCanonical ? canonicalPromptTokens(lastMainCanonical) : 0;
    const canonical =
      lastMainPrompt > 0
        ? lastMainCanonical
        : singleRequestTurn && resultUsage
          ? normalizeUsage(resultUsage, 'anthropic')
          : null;
    const realPromptTokens = canonical ? canonicalPromptTokens(canonical) : 0;
    const realOutputTokens = lastMainPrompt > 0 ? lastMainOutput : canonical ? canonical.outputTokens : 0;
    const liveContextTokens = reconcileActiveContext(realPromptTokens, realOutputTokens, compatContextEstimate);
    setSessionActiveContextTokens(sessionId, liveContextTokens);
    setSessionAgenticContextTokens(
      sessionId,
      agenticBaseTokens + agenticTurnTokens,
      boundaryFenceMessageId !== null ? boundaryFenceMessageId : undefined,
    );
    const turnContextUsage = buildChatContextUsage({
      model: selection.model,
      provider: selection.provider,
      contextTokens: liveContextTokens,
      source: realPromptTokens > 0 ? 'provider' : 'estimate',
    });
    if (turnContextUsage) {
      sendSessionStream({ type: 'context_usage', contextUsage: turnContextUsage });
    }

    if (assistantContent) {
      const recordOnboardingAudit = ({
        toolName,
        input,
        output,
      }: {
        toolName: string;
        input: string;
        output: string;
      }) => {
        insertAuditEntry({
          sessionId,
          eventType: 'tool_call',
          toolName,
          input,
          output,
        });
        sendLogEntry(getWindow, {
          sessionId,
          eventType: 'tool_call',
          toolName,
          input,
          output,
        });
      };
      const cleaned = options.swarmDelivery
        ? null
        : extractAndProcessOnboardingData(assistantContent, {
            sendStream: sendSessionStream,
            onAudit: recordOnboardingAudit,
          });
      if (cleaned !== null) assistantContent = cleaned;
      if (cleaned === null && isOnboarding && !options.swarmDelivery) {
        completeOnboardingFromUserProfileMessage(finalMessage, {
          sendStream: sendSessionStream,
          onAudit: recordOnboardingAudit,
        });
      }

      const messageMetadata =
        collectedArtifacts.length > 0 ? JSON.stringify({ artifacts: collectedArtifacts }) : undefined;
      if (!persistSwarmResponse(options, sessionId, assistantContent, messageMetadata)) {
        insertMessage(sessionId, 'assistant', assistantContent, options.agentId, messageMetadata);
      }
      recordCompletedMainChatTurn(sessionId, getWindow);
    }

    if (sessionId) {
      const session = getSession(sessionId);
      if (session && session.type !== 'scheduled' && session.type !== 'telegram') {
        const msgs = getSessionMessages(session.id);
        const assistantCount = msgs.filter((msg) => msg.role === 'assistant').length;
        const shouldGenerateTitle = !session.title || assistantCount === 1;

        if (shouldGenerateTitle && msgs.length >= 2) {
          generateSessionTitle(session.id).catch((err) => {
            logger.error({ err, sessionId }, 'Title generation failed');
          });
        }
      }
    }

    await maybeCompactChatSession(sessionId, sendSessionStream, {
      model: selection.model,
      provider: selection.provider,
    });
  } catch (error) {
    const controlledError = pendingSubagentProviderAuthError(subagentDispatchContext) ?? error;
    if (isSubagentProviderAuthError(controlledError)) {
      const failure = subagentAuthFailure(controlledError);
      sendStream(getWindow, options.silent, { type: 'error', sessionId, ...failure });
      insertAuditEntry({ sessionId, eventType: 'error', output: failure.error });
      if (lane.kind !== 'desktop') throw controlledError;
      return;
    }
    if ((error as Error).name === 'AbortError') {
      sendStream(getWindow, options.silent, {
        type: 'done',
        content: sessionId,
        sessionId,
      });
      return;
    }
    const serializedError = serializeError(error);
    const translatedError = translateProviderError(error, {
      runtime: 'claude-compat',
      provider: selection.provider,
      model,
    });
    const errorMsg = serializedError.message || `[${translatedError.code}] ${translatedError.userMessage}`;
    logger.error(
      {
        err: serializedError,
        shouldContinueSession,
        sdkActiveSessionId: lane.sdkActiveSessionId,
        sdkSessionId,
        provider: selection.provider,
        model,
        metrics,
        elapsedMs: Date.now() - startedAt,
      },
      'Claude-compat orchestrator query failed',
    );

    if (shouldContinueSession && lane.sdkActiveSessionId !== sdkSessionId && !options._forceNewSession) {
      lane.sdkActiveSessionId = null;
      logger.warn(
        {
          sessionId,
          sdkSessionId,
          provider: selection.provider,
          err: serializedError,
          metrics,
          elapsedMs: Date.now() - startedAt,
        },
        'Claude-compat resume failed, retrying with fresh SDK session',
      );
      lane.currentAbortController = null;
      await executeClaudeCompatSdkQuery(
        message,
        { ...options, sessionId, _forceNewSession: true },
        getWindow,
        lane,
        selection,
      );
      return;
    }

    if (shouldContinueSession) {
      lane.sdkActiveSessionId = null;
    }

    sendStream(getWindow, options.silent, {
      type: 'error',
      error: errorMsg,
      code: translatedError.code,
      sessionId,
    });
    const errorEntry: Omit<AuditEntry, 'id' | 'createdAt'> = {
      sessionId,
      eventType: 'error',
      output: errorMsg,
    };
    insertAuditEntry(errorEntry);
    sendLogEntry(getWindow, errorEntry);
  } finally {
    try {
      finalizeRunningTaskExecutionTree(
        nativeTaskRootExecutionId,
        turnOk ? 'completed' : 'cancelled',
        turnOk
          ? 'Turno owner encerrado; Task nativa nao enviou notificacao terminal.'
          : 'Turno owner cancelado/falhou antes da notificacao terminal da Task nativa.',
      );
    } catch (err) {
      logger.error({ err, nativeTaskRootExecutionId }, 'Failed to finalize native task execution tree');
    }
    smokeAudit('turn_done', { lane: lane.name, runtime: 'claude-compat-sdk', sessionId, ok: turnOk });
    lane.currentAbortController = null;
  }
}

export function resetClaudeCompatSdkSessionState(laneArg?: SdkLane): void {
  for (const lane of lanesOrAllDesktop(laneArg)) {
    lane.sdkActiveSessionId = null;
    stopClaudeCompatQuery(lane);
  }
}

export function stopClaudeCompatQuery(laneArg?: SdkLane): void {
  for (const lane of lanesOrAllDesktop(laneArg)) {
    if (lane.currentAbortController) {
      lane.currentAbortController.abort();
      lane.currentAbortController = null;
    }
  }
}

export function isClaudeCompatQueryActive(laneArg?: SdkLane): boolean {
  return lanesOrAllDesktop(laneArg).some((lane) => lane.currentAbortController !== null);
}
