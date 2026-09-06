// SPEC-001 §10: Claude-compat SDK execution path (Z.ai today, future
// Anthropic-API-emulating hosts).
//
// This is structurally a COPY of `executeClaudeSdkQuery` in
// `electron/main/orchestrator.ts`. The duplication is INTENTIONAL per SPEC
// §10.5 ("copy is intentional to keep Rule #1 enforceable"). Sharing a helper
// between the two paths would force touching orchestrator.ts, which violates
// the Rule #1 / SPEC §15 guardrail that demands the Claude SDK body remain
// verbatim. The two functions live in parallel.
//
// The ONLY material differences vs the Claude SDK path:
//   1. `env` merges the current process env plus ANTHROPIC_BASE_URL,
//      ANTHROPIC_AUTH_TOKEN, and API_TIMEOUT_MS to redirect the SDK to the
//      compat host without dropping PATH.
//   2. The API key comes from the Vault entry pointed at by
//      `preset.apiKeyVaultRef` (not `getApiKey()`).
//   3. MCP server config is filtered with `surface: 'claude-compat-sdk'`.
//   4. `model` is whatever the caller selected (e.g. `glm-4.7`) and is sent to
//      the compat host as-is.
//   5. Session state lives in a module-private "lane" object scoped to the
//      compat path, since the router dispatches here only on the chat lane and
//      `desktopLane` from orchestrator.ts is not exported.
//
// Stream handling, audit, cost calculation, subagent token bookkeeping, and
// session resume/continue logic mirror `executeClaudeSdkQuery` line by line.

import { BrowserWindow } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../logger';
// TEMPORARIO - smoke-audit do build fonte-unica; REMOVER apos validacao.
import { smokeAudit } from '../smoke-audit';
import {
  getAllAgents,
  getAgent,
  insertMessage,
  insertAuditEntry,
  createSession,
  clearSessionPendingSeed,
  getSetting,
  updateSessionTokens,
  setSessionActiveContextTokens,
  setSessionAgenticContextTokens,
  resetSessionAgenticContext,
  getActiveChatSession,
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
import {
  completeOnboardingFromUserProfileMessage,
  extractAndProcessOnboardingData,
} from '../onboarding';
import { calculateCost, hasKnownPricing } from '../pricing';
// SB-6: tradutor central de erro de provider (modulo FOLHA do agent-runtime).
import { translateProviderError } from '../agent-runtime/llm-error';
import {
  normalizeUsage,
  canonicalPromptTokens,
  reconcileActiveContext,
  estimateRequestTokens,
  // SPEC contexto-vivo-runtimes (PISO forte, regime de thread persistente):
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
import {
  captureToolUse,
  captureToolResult,
  resetArtifactDetector,
} from '../artifact-detector';
import { buildSystemPrompt } from '../prompt-builder';
// (A2) secao condicional do repo ativo do turno ('' sem repo, AC-1; setada
// pelo hook F6 do orchestrator antes do despacho).
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
import {
  ensureNodeInPath,
  getClaudeSdkProcessOptions,
} from '../pipeline-shared/sdk-bootstrap';
import type {
  AgentDefinition,
  McpSdkServerConfigWithInstance,
  McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import {
  ensureInitialSessionTitle,
  generateSessionTitle,
} from '../title-generator';
import type {
  StreamChunk,
  AuditEntry,
  AgentConfig,
  ArtifactData,
  LiveActivityEvent,
} from '../../../src/types';

type AgentDefinitionCompat = Omit<AgentDefinition, 'prompt'> & {
  prompt?: string;
};
import type { QueryOptions } from '../orchestrator';
import type { OrchestratorSelection } from '../orchestrator-selection';
import { type SdkLane, desktopLane } from '../sdk-lane';
// (S5b, SPEC chat-context-reduction A.6) leitura do turn-context DENTRO do
// executor compat (espelho do wiring claude-sdk em orchestrator.ts) para as
// capabilities EFETIVAS do turno.
import {
  getActiveChatTurnByLane,
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

/**
 * Engine knobs for context window / auto-compact that are dropped from the
 * inherited env before re-injecting the LionClaw-computed window (D9).
 * Deliberately duplicated in zai-executor / minimax-tokenplan-executor
 * (SPEC §10.5: three independent env builders).
 */
const COMPAT_CONTEXT_WINDOW_ENV_KEYS: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'DISABLE_AUTO_COMPACT',
  'DISABLE_COMPACT',
]);

/**
 * SPEC-008 §5.4b / §10 (F4): builds the SANITIZED child env for a Claude-compat
 * (Z.ai / MiniMax) `query()` subprocess from a resolved OrchestratorSelection.
 *
 * Shared by the compat chat session (this module) and the memory pipeline's
 * one-shot subscription invoker (`memory-pipeline/oneshot-subscription.ts`).
 *
 * SANITIZATION is the critical part (precedent: `buildZaiEnv` in
 * `agent-runtime/zai-executor.ts:52-57`): we copy `baseEnv` but DROP every
 * inherited `ANTHROPIC_*` key and `API_TIMEOUT_MS` BEFORE re-injecting the
 * subscription's own values. Without this, a stray `ANTHROPIC_API_KEY` in
 * `process.env` would leak into the subprocess and could OVERRIDE the
 * `ANTHROPIC_AUTH_TOKEN` of the subscription — silently dropping back to the
 * Anthropic API key, exactly what SPEC-008 avoids.
 *
 * The model slug is passed verbatim. MiniMax additionally needs
 * `ANTHROPIC_MODEL` + `ANTHROPIC_DEFAULT_*_MODEL` (its router keys off them);
 * Z.ai does not. `selection.baseUrl`/`selection.apiKey` are pre-populated by
 * the resolver for `runtime === 'claude-compat-sdk'`.
 */
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

  // Step 1 — sanitize: copy everything EXCEPT inherited Anthropic auth/config
  // and the engine's context-window/compact knobs (SPEC agent-sdk-0.3 D9: the
  // LionClaw window is authoritative; a host override must not silently beat
  // what the UI shows, and "unknown window => env ABSENT" must hold even when
  // the host has the variable).
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (key === 'API_TIMEOUT_MS') continue;
    if (key.startsWith('ANTHROPIC_')) continue;
    if (COMPAT_CONTEXT_WINDOW_ENV_KEYS.has(key)) continue;
    sanitized[key] = value;
  }

  // Step 2 — re-inject the subscription's compat env. The context window goes
  // in as CLAUDE_CODE_MAX_CONTEXT_TOKENS only when LionClaw knows it (F8: the
  // engine honours it for names that do NOT start with `claude-`).
  const contextWindow = getContextWindow(selection.model, selection.provider);
  return {
    ...sanitized,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
    API_TIMEOUT_MS: '3000000',
    ...(contextWindow !== undefined
      ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow) }
      : {}),
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

function getCompatDisabledSdkMcps(
  provider: OrchestratorSelection['provider'],
): string[] {
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

function bumpServerToolUse(
  metrics: CompatRunMetrics,
  toolName: string,
): number {
  const count = (metrics.serverToolUseCounts[toolName] ?? 0) + 1;
  metrics.serverToolUseCounts[toolName] = count;
  return count;
}

// SPEC orquestrador-fonte-unica 3.1/3.2: a compatLane paralela de modulo saiu. O
// abort e a thread do SDK do compat vivem NA LANE recebida (desktop/telegram/
// cron), a mesma instancia compartilhada em sdk-lane.ts. Elimina o clobber de
// thread e a disputa de abort entre lanes no mesmo provider.

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

function sendStream(
  getWindow: () => BrowserWindow | null,
  silent: boolean | undefined,
  chunk: StreamChunk,
): void {
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

function sendLogEntry(
  getWindow: () => BrowserWindow | null,
  entry: Omit<AuditEntry, 'id' | 'createdAt'>,
): void {
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

/**
 * SPEC contexto-vivo 3.1: est. do CLAUDE.md EFETIVO dos settingSources
 * ['project','user'] que o SDK injeta no system (invisivel ao PISO antigo).
 * project = `<getAgentCwd()>/CLAUDE.md` (persona gerada em ~/.lionclaw);
 * user = `~/.claude/CLAUDE.md`. Arquivo ausente/ilegivel conta 0 (nunca
 * lanca). Chamado SO dentro do compute do cache por assinatura (§5) — as
 * leituras de disco nao rodam a cada turno.
 */
function estimateClaudeSettingsFilesTokens(): number {
  let total = 0;
  const files = [
    path.join(getAgentCwd(false), 'CLAUDE.md'),
    path.join(os.homedir(), '.claude', 'CLAUDE.md'),
  ];
  for (const file of files) {
    try {
      total += estimateTokensRough(fs.readFileSync(file, 'utf-8'));
    } catch {
      // Arquivo ausente => bucket 0 (o SDK tambem nao o injetaria).
    }
  }
  return total;
}

// Exported for testing (SPEC-004 §5.6.4). The export is purely for the
// `__tests__/claude-compat-minimax-env.test.ts` suite that validates the
// MiniMax subagent model override; production callers stay within this file.
export async function buildAgentDefinitions(
  provider: OrchestratorSelection['provider'],
  dispatchContext?: SubagentDispatchContext,
): Promise<Record<string, AgentDefinitionCompat>> {
  // Only CLOUD agents become SDK subagents.
  const agents = getAllAgents().filter(
    (a: AgentConfig) => a.isActive && a.runtime === 'cloud',
  );
  const definitions: Record<string, AgentDefinitionCompat> = {};

  for (const agent of agents) {
    const resolved = dispatchContext
      ? await resolveSubagentConfigWithinCeiling(agent.id, dispatchContext)
      : { config: await resolveAgentQueryConfig(agent.id) };
    if (!resolved.config) continue;
    const config = resolved.config;

    definitions[agent.id] = {
      description: agent.description,
      // D8 (SPEC agent-sdk-0.3, espelho do orchestrator.buildAgentDefinitions):
      // TodoWrite -> Task tools so na fronteira; vazia continua undefined.
      tools: dispatchContext
        ? toSdkToolNames(config.allowedTools)
        : config.allowedTools.length > 0 ? toSdkToolNames(config.allowedTools) : undefined,
      prompt: config.systemPrompt || undefined,
      // MiniMax so expoe MiniMax-*; forcar undefined faz o SDK usar o model
      // top-level (MiniMax-M2.7) tambem para os subagents. Z.ai mantem
      // comportamento atual (passa model claude-* que o endpoint substitui
      // internamente). Ver SPEC-004 §5.6.4.
      model:
        provider === 'minimax'
          ? undefined
          : agent.model !== 'default'
            ? agent.model
            : undefined,
      maxTurns: config.maxTurns || undefined,
      mcpServers: config.mcpServers.length > 0 ? config.mcpServers : [],
    };
  }

  return definitions;
}

/**
 * SPEC-001 §10.4: Claude-compat SDK chat execution.
 *
 * Resolves the compat preset, reads the API key from the Vault, and runs the
 * Anthropic Agent SDK with `env` redirected to the compat host. Everything
 * else (system prompt, tools, MCPs, subagents, permissions, hooks, session
 * resume/continue, audit, cost) mirrors `executeClaudeSdkQuery`.
 */
export async function executeClaudeCompatSdkQuery(
  message: string,
  options: QueryOptions,
  getWindow: () => BrowserWindow | null,
  lane: SdkLane = desktopLane,
  selection: OrchestratorSelection,
): Promise<void> {
  // ---- Resolve preset + API key ----
  const preset = getClaudeCompatPreset(selection.provider);
  const apiKey = selection.apiKey ?? (await getSecret(preset.apiKeyVaultRef));
  if (!apiKey) {
    const missingKeyChunk: StreamChunk = {
      type: 'error',
      error: `API key do provedor "${preset.displayName}" nao configurada. Va em Settings > External Providers.`,
    };
    // SPEC robustez-chat SB-10 (AC-B26): notifica a rede de seguranca do
    // executeQuery (erro ja surfacado — o completion nao emite fallback).
    options.onStreamChunk?.(missingKeyChunk);
    sendStream(getWindow, options.silent, missingKeyChunk);
    return;
  }

  // ---- Session management ----
  let sessionId = options.sessionId;
  let shouldContinueSession = false;

  if (!sessionId) {
    // SPEC orquestrador-fonte-unica 3.3: getActiveChatSession() SO na desktop lane
    // (a sessao ativa casa chat/manual/telegram e vazaria a sessao do desktop para
    // outra lane). Fora do desktop, options.sessionId e obrigatorio (espelho do
    // guard do claude-sdk).
    if (lane !== desktopLane) {
      const error = `Lane '${lane.name}' exige options.sessionId explicito (guard de sessao, SPEC 3.3)`;
      logger.error({ lane: lane.name }, error);
      throw new Error(error);
    }
    const activeSession = getActiveChatSession();
    if (activeSession) {
      sessionId = activeSession.id;
      shouldContinueSession = true;
    } else {
      sessionId = crypto.randomUUID();
      createSession(sessionId, '');
      shouldContinueSession = false;
    }
  } else {
    const existingMessages = getSessionMessages(sessionId);
    shouldContinueSession = existingMessages.length > 0;
    if (options._forceNewSession) {
      shouldContinueSession = false;
      logger.info(
        { sessionId },
        'Forced fresh SDK session (retry after resume failure)',
      );
    } else if (!shouldContinueSession) {
      logger.info(
        { sessionId },
        'Session has no messages, starting fresh SDK session (post-compaction)',
      );
    }
  }

  // SPEC orquestrador-fonte-unica 3.4: pending_seed universal (espelho do
  // claude-sdk em orchestrator.ts). Um pending_seed nao-nulo (setado pela
  // compactacao in-place) forca thread SDK NOVA — sobrepoe o gate de
  // getSessionMessages().length acima (as mensagens do DB nao sao apagadas). O
  // seed entra como preambulo do prompt (abaixo) e e consumido no sucesso do
  // turno; falha preserva o seed. sessionRow tambem alimenta o corte de historia.
  const sessionRow = getSession(sessionId);
  const pendingSeed = sessionRow?.pendingSeed ?? null;
  // Chip ao vivo (in:) durante o turno: GLM/MiniMax nao mandam usage no stream,
  // entao o acumulado fica 0 e a estimativa so-da-mensagem mostrava "in: ~8"
  // irreal. O contexto vivo persistido do turno ANTERIOR e a melhor aproximacao
  // do input real da request corrente (input == contexto); a reconciliacao com
  // o resultUsage no fim do turno segue corrigindo pro valor exato.
  const prevLiveContextEst = sessionRow?.activeContextTokensEst ?? 0;
  if (pendingSeed) {
    shouldContinueSession = false;
    logger.info(
      { sessionId },
      'pending_seed presente: thread SDK nova com seed de compactacao (SPEC 3.4)',
    );
  }

  // SPEC contexto-vivo 3.6: reset/rebase do acumulador AGENTICO persistente —
  // regra por CONDICAO: `shouldContinueSession === false OU pendingSeed
  // presente` (cobre new chat, rota leve, retry pos-resume-failure,
  // `_forceNewSession`, sessao sem mensagens, compactacao in-place do
  // Telegram/desktop e /clear — os dois ultimos chegam aqui como pendingSeed /
  // sessao sem mensagens no turno seguinte, sem tocar a lane do Telegram).
  // Thread recriada SEM compactacao grava `thread_reset_message_id` = ultima
  // mensagem PRE-turno (a thread nova nao tem o historico anterior; sem o
  // fence o PISO contaria historico fantasma). Com pendingSeed, o fence e o
  // `compacted_up_to_message_id` que a compactacao ja gravou. Apos o reset, o
  // agentico do PROPRIO turno e acumulado normalmente (a thread nova e
  // resumida no proximo send).
  const threadRecreated = !shouldContinueSession || pendingSeed !== null;
  const preTurnLastMessageId = threadRecreated && !pendingSeed
    ? getSessionMessages(sessionId).reduce((mx, m) => Math.max(mx, m.id), 0) || null
    : null;
  let agenticBaseTokens = 0;
  if (threadRecreated) {
    resetSessionAgenticContext(
      sessionId,
      pendingSeed ? {} : { threadResetMessageId: preTurnLastMessageId },
    );
  } else {
    agenticBaseTokens = sessionRow?.agenticContextTokensEst ?? 0;
  }
  // Fence EFETIVO do turno (o valor recem-gravado ainda nao esta no sessionRow
  // lido acima). compact_boundary mid-turno pode avancar isto (ver o loop).
  let effectiveThreadResetId: number | null =
    threadRecreated && !pendingSeed
      ? preTurnLastMessageId
      : (sessionRow?.threadResetMessageId ?? null);

  // SPEC orquestrador-fonte-unica 3.2: o escopo do thread id do SDK inclui a
  // lane.name, entao desktop e telegram no MESMO provider nao clobbam a thread um
  // do outro (id derivado distinto por lane).
  const sdkSessionId = makeScopedSdkSessionId(
    `claude-compat-sdk:${selection.provider}:${lane.name}`,
    sessionId,
  );

  options.onStreamChunk?.({ type: 'session', content: sessionId });
  sendStream(getWindow, options.silent, {
    type: 'session',
    content: sessionId,
  });

  // SPEC robustez-chat SB-10 (AC-B26): todo chunk do turno notifica o hook do
  // executeQuery (rede de seguranca do completion, cobre os 5 runtimes).
  // Rastreio puro, aditivo; o envio segue byte-identico.
  const sendSessionStream = (chunk: StreamChunk) => {
    options.onStreamChunk?.({ ...chunk, sessionId });
    sendStream(getWindow, options.silent, { ...chunk, sessionId });
  };

  // SPEC K2 v2 (secao 5.2): turnIndex DERIVADO DO DB (paridade com orchestrator.ts).
  let currentTurnIndex = 0;

  // SPEC K2: emit aditivo de atividade ao vivo. v2 (secao 5.1): o corpo DELEGA ao
  // sink recordActivity (stream + persistencia); sites inalterados.
  const emitActivity = (a: LiveActivityEvent) =>
    recordActivity(sessionId, currentTurnIndex, a, sendSessionStream);

  // K1/R3 (pipe-control): turno semeado pelo drive do orquestrador NAO vira bolha de
  // user; so a resposta do assistant streama. Reutiliza o ultimo turno (NAO incrementa).
  const skipUserPersistence =
    options.origin === 'system-event' || options.skipUserMessagePersistence === true;

  if (skipUserPersistence) {
    currentTurnIndex = getLatestUserTurnIndex(sessionId);
  } else if (!options._forceNewSession) {
    const visibleUserMessage = options.displayMessage ?? message;
    // fix(vision-ux): metadata leve dos anexos junto da user message (miniatura
    // sobrevive a rehidratacao). Sem attachmentsMeta = insertMessage identico.
    const userMessageId = persistUserChatMessage(sessionId, visibleUserMessage, options.attachmentsMeta);
    currentTurnIndex = getTurnIndexForUserMessage(sessionId, userMessageId);
    ensureInitialSessionTitle(sessionId, visibleUserMessage);
  } else {
    // Retry / _forceNewSession: reutiliza o ultimo turno (NAO incrementa).
    currentTurnIndex = getLatestUserTurnIndex(sessionId);
  }

  // SPEC orquestrador-fonte-unica 2.3/2.4: cadeia = SO `selection.model`. O
  // override por agente foi oficializado dentro do resolver (Rule #3 nova,
  // source:'agent'): quando o agente tem modelo, o resolver ja o colocou em
  // selection.model. `selection.model` e obrigatorio (o resolver garante ou
  // lanca). O `agent?.model ||` (override escondido) foi removido junto com a
  // leitura de getAllAgents (que so servia a ele neste ponto).
  const model = selection.model;

  if (options.agentId) {
    setActiveAgentId(options.agentId);
  }

  const isOnboarding = getSetting('onboarding_completed') !== 'true';
  // (S5b, SPEC chat-context-reduction A.6) Capabilities EFETIVAS do turno de
  // chat, lidas do turn-context registrado pelo hook S3a — mesmo local do
  // wiring claude-sdk (orchestrator.ts). SO na lane desktop (A.9);
  // telegram/cron ou turno sem turn-context -> undefined = default S5a
  // byte-identico (prompt legado + composicao sem filtro).
  const chatCaps =
    lane.name === 'desktop'
      ? (() => {
          const t = getActiveChatTurnByLane('desktop');
          const ctx = t ? getChatCapabilityTurn(t) : undefined;
          return ctx ? computeEffectiveCapabilitiesForTurn(ctx) : undefined;
        })()
      : undefined;
  const baseSystemPrompt = buildSystemPrompt(options.agentId, {
    mode: 'full',
    isOnboarding,
    model,
    capabilities: chatCaps,
  });
  const compatRuntimeSection = buildCompatRuntimeSection(
    selection.provider,
    preset.displayName,
    model,
  );
  const fullSystemPrompt = isOnboarding
    ? baseSystemPrompt
    : appendRepoGraphSection(`${baseSystemPrompt}\n\n---\n\n${compatRuntimeSection}`);

  const permissionGuard = createPermissionGuard(getWindow, { isOnboarding });
  // SPEC orquestrador-fonte-unica 3.1: abort na LANE (nao mais na compatLane global).
  lane.currentAbortController = new AbortController();

  // Process image attachments (same as Claude SDK path)
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
      const imageRefs = imagePaths
        .map((p, i) => `[Imagem ${i + 1}: ${p}]`)
        .join('\n');
      finalMessage = `${imageRefs}\n\n${message || 'O usuario enviou estas imagens. Use a ferramenta Read para visualizar cada uma e responda sobre elas.'}`;
    }
  }

  // SPEC orquestrador-fonte-unica 3.4: injeta o pending_seed como PREAMBULO do
  // texto enviado ao SDK, ANTES da mensagem do usuario (mesmo padrao do
  // orchestrator.ts). O seed entra exatamente uma vez: clearSessionPendingSeed
  // roda no sucesso do turno; falha preserva para a proxima tentativa.
  if (pendingSeed) {
    finalMessage = `${pendingSeed}\n\n${finalMessage}`;
  }

  if (isOnboarding) {
    logger.info(
      { promptLength: fullSystemPrompt.length, hasTools: false },
      'Onboarding: text-only prompt, no tools',
    );
  }

  // Resolve MCP server config with the compat surface filter (excludes
  // helpers tagged `visible_to='codex-lion-only'`).
  let mcpServers: Record<string, McpServerConfig> | undefined =
    await getMCPConfigForAgent(options.agentId, {
      surface: 'claude-compat-sdk',
      capabilities: chatCaps,
    });

  // Auto-inject local-agents MCP when any local/external agent is active.
  const allAgents = getAllAgents();
  const hasLocalAgent = allAgents.some(
    (a: AgentConfig) => a.isActive && a.runtime === 'local',
  );
  const hasExternalAgent = allAgents.some(
    (a: AgentConfig) => a.isActive && a.runtime === 'external',
  );

  if (hasLocalAgent || hasExternalAgent) {
    const resolvedRuntime = resolveMcpServerRuntime(
      'local-agents',
      'dist/index.js',
      { cwd: process.cwd() },
    );
    const resolvedPath = resolvedRuntime.entryPath ?? resolvedRuntime.candidates[0];
    if (!resolvedRuntime.command) {
      throw new Error('Runtime Node do MCP local-agents não foi resolvido');
    }

    const lionclawHome = getLionClawHome();

    const envVars: Record<string, string> = { LIONCLAW_HOME: lionclawHome };
    if (hasExternalAgent) {
      const externalAgents = allAgents.filter(
        (a: AgentConfig) =>
          a.isActive && a.runtime === 'external' && a.externalConfig,
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

  // Auto-inject codex-agents in-process MCP when any codex agent is active.
  const hasCodexAgent = allAgents.some(
    (a: AgentConfig) => a.isActive && a.runtime === 'codex',
  );
  const subagentCwd = getAgentCwd(isOnboarding);
  const subagentAbortController = lane.currentAbortController;
  if (!subagentAbortController) throw new Error('Turno sem AbortController para subagentes.');
  const subagentDispatchContext = createSubagentDispatchContext({
    ownerKind: 'chat',
    ownerId: sessionId,
    sessionId,
    lane: lane.name === 'telegram' || lane.name === 'cron' ? lane.name : 'desktop',
    surface: 'claude-compat-sdk',
    cwd: subagentCwd,
    readRoots: [subagentCwd],
    writeRoots: isOnboarding ? [] : [subagentCwd],
    allowedTools: await resolveSubagentHostAllowedTools(
      getEnabledTools(),
      Object.keys(mcpServers ?? {}),
    ),
    allowedMcpServerIds: Object.keys(mcpServers ?? {}),
    permission: PERM_DEFAULT_WITH_GUARD(permissionGuard),
    parentAbortSignal: subagentAbortController.signal,
    abortOwner: (reason) => subagentAbortController.abort(reason),
    inheritedEffort: resolveChatInheritedEffort(),
  });
  if (hasCodexAgent) {
    const codexServerConfig: McpSdkServerConfigWithInstance =
      await getCodexAgentsServer(subagentDispatchContext);
    if (mcpServers) {
      if (!mcpServers['codex-agents']) {
        mcpServers['codex-agents'] = codexServerConfig;
      }
    } else {
      mcpServers = { 'codex-agents': codexServerConfig };
    }
  }

  // pipeline-control (I6, cleanup "um MCP so"): a porta in-process foi removida.
  // As tools pipeline_* chegam ao orquestrador compat via o subprocess MCP
  // `lionclaw-pipeline-control` (visibleTo 'all', seam unico para todos os
  // runtimes); o gate de WRITE/caller vive em local-ipc/jsonrpc-methods.ts.

  const agentDefinitions = isOnboarding
    ? {}
    : await buildAgentDefinitions(selection.provider, subagentDispatchContext);
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

  // TEMPORARIO - smoke-audit: par turn_start/turn_done do turno claude-compat-sdk.
  let turnOk = false;
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
    // SPEC K2: bookkeeping da arvore de atividade (tools + aninhamento sob o subagente ativo).
    let currentParentToolUseId: string | null = null;
    let currentToolActivityId: string | null = null;
    let toolActivitySeq = 0;
    // SPEC K2 v2 (secao 5.3): mapa tool_use_id -> toolName, preenchido no
    // assistant-block (onde nome+input existem) e usado no resultado da tool p/
    // derivar `changed`.
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
    // Usage autoritativo do `result` final do SDK. Providers compat (GLM/
    // MiniMax) nao populam usage no message_start do stream — o acumulado de
    // input fica 0 e o chip/custo saem subestimados. O result traz os totais
    // do endpoint; reconciliamos por max no fim do turno (nunca perde o que o
    // stream ja acumulou).
    let resultUsage: Record<string, number> | null = null;
    // CTX-FINAL: usage cru da ULTIMA request do agente PRINCIPAL (parityda com o
    // path claude-sdk do orchestrator: lastMainContextInput/lastMainOutput).
    // Quando o provider compat POPULA usage no message_start (nem todos o fazem),
    // esta e a fonte EXATA do contexto vivo (a ultima request = o array inteiro
    // que o modelo viu). Quando NAO popula, cai no `resultUsage` (paridade com o
    // billing) e, por fim, no PISO estimado (Hermes reconcile).
    let lastMainUsageRaw: Record<string, number> | null = null;
    let lastMainOutput = 0;
    // Nº de requests do agente PRINCIPAL neste turno. 1 = turno simples (sem
    // tools) -> o `resultUsage` NAO e odometro (e a request unica = contexto
    // real exato). >1 = agentico -> `resultUsage` vira soma cumulativa e nao
    // pode virar contexto (cai no PISO). CTX-COMPAT-FIX.
    let mainRequestCount = 0;
    // SPEC contexto-vivo 3.5: contador do turno de tool_use ARGS + tool
    // RESULTS da thread PRINCIPAL (parent_tool_use_id == null) — o conteudo
    // agentico vive na thread do SDK, nunca no DB, e sem ele o PISO despenca
    // (~12k com real ~50-100k+). Textos do assistant NAO entram (persistidos
    // no DB -> bucket historico; conta-los aqui = dupla contagem permanente).
    // Imagens em tool results ja entram FLAT via estimateAgenticContentTokens.
    // Subagentes (parent != null) ficam FORA — so o result final da Task conta
    // (chega como tool_result principal).
    let agenticTurnTokens = 0;
    // SPEC contexto-vivo 3.6: fence avancado por compact_boundary mid-turno
    // (persistido no sucesso, na MESMA escrita do acumulador).
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
      shouldContinueSession && lane.sdkActiveSessionId === sdkSessionId;

    // JANELA DO MODELO NO ENGINE (SPEC agent-sdk-0.3 D9, evidencia F7/F8).
    // O sufixo `[1m]` que existia aqui foi REMOVIDO: o engine reconhece
    // `[1m]` por regex /\[1m\]/i em QUALQUER nome, tira o sufixo do body e
    // injeta a beta `context-1m-2025-08-07` no header; Z.ai e MiniMax rejeitam
    // a beta com 400 `invalid_request_error` (provado pelo Build em 2.1.220 com
    // chave real). NAO tentar variantes do sufixo. O contrato novo e a env
    // `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, que o engine honra na janela de modelo
    // DESCONHECIDO desde que o nome NAO comece com `claude-` (glm-5.2,
    // MiniMax-M3 valem; subagentes compat com `model: claude-*` seguem com a
    // janela do alias Anthropic). A env e montada por `buildCompatEnv` a partir
    // de `getContextWindow(model, provider)`; janela desconhecida => ausente.
    // `options.model` recebe o slug limpo.

    // KEY DIFFERENCE vs executeClaudeSdkQuery: `env` injection redirects the
    // SDK subprocess to the compat host. The env field is documented in
    // node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts (SPEC §10.5).
    const q = query({
      prompt: finalMessage,
      options: {
        // SPEC-008 §5.4b (F4): env now built by the shared SANITIZED helper
        // `buildCompatEnv` (strips inherited ANTHROPIC_*/API_TIMEOUT_MS before
        // re-injecting). SPEC orquestrador-fonte-unica 2.4: `model` e sempre
        // `selection.model` (o override por agente ja foi resolvido no resolver,
        // source:'agent'); passamos por `model` para deixar explicito que a env
        // usa o mesmo slug do turno.
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
              // GUARD_GATED_TOOLS ficam FORA de allowedTools para roteamento ao
              // guard (ver orchestrator.ts e permission-guard.ts).
              // D7/D8 (SPEC agent-sdk-0.3, espelho do orchestrator.ts): mesma
              // expressao de hoje com TodoWrite -> Task tools; bloqueio do que
              // o engine 2.1.257 expoe alem do 2.1.74 so por disallowedTools.
              allowedTools: toSdkToolNames(getEnabledTools().filter((t) => !GUARD_GATED_TOOLS.includes(t))),
              disallowedTools: [...SDK_DISALLOWED_TOOLS],
              // permissionMode 'default' (nao bypass): o bypass total agora
              // vive dentro do permission-guard (setting permission:bypass),
              // mesmo guard usado por claude-sdk e lion-sdk. Ver orchestrator.ts.
              permissionMode: 'default' as const,
              settingSources: ['project', 'user'],
              canUseTool: (tool: string, input: Record<string, unknown>) =>
                permissionGuard(tool, input),
              // Ver espelho em orchestrator.ts: payload legado omite prompt
              // vazio; o cast fica restrito a fronteira do SDK.
              agents: agentDefinitions as Record<string, AgentDefinition>,
              hooks: {
                SubagentStart: [
                  {
                    hooks: [
                      async (input: Record<string, unknown>) => {
                        const agentId = typeof input['agent_type'] === 'string'
                          ? input['agent_type']
                          : String(input['agent_id'] ?? '');
                        const reservationContext = typeof input['agent_id'] === 'string'
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
            logger.warn(
              { provider: selection.provider, model, sessionId, stderr: chunk },
              'Claude-compat SDK stderr',
            );
          }
        },
        ...(!isOnboarding && mcpServers ? { mcpServers } : {}),
      },
    });

    if (!isOnboarding) {
      const disabledSdkMcps = getCompatDisabledSdkMcps(selection.provider);
      const hasBuiltinExcalidraw =
        mcpServers && Object.keys(mcpServers).includes('excalidraw');
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
            const rawToolName =
              (contentBlock.name as string | undefined) || 'unknown';
            currentToolName =
              contentBlock.type === 'server_tool_use'
                ? `server:${rawToolName}`
                : rawToolName;
            metrics.lastToolName = currentToolName;
            inTool = true;
            sendSessionStream({
              type: 'tool_call',
              tool: currentToolName,
              input:
                contentBlock.input &&
                typeof contentBlock.input === 'object' &&
                !Array.isArray(contentBlock.input)
                  ? (contentBlock.input as Record<string, unknown>)
                  : {},
            });

            // SPEC K2: tool START. parentId = subagente ativo (best-effort, AC-2): se o
            // parent_tool_use_id casar com o id do subagente, aninha; senao vira no de topo.
            // O proprio Task compartilha tool_use_id com o no de subagente (ja emitido em
            // task_started), entao pular para nao colidir/duplicar.
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
            // SPEC K2: tool END best-effort (fim de GERACAO, nao de execucao real - AC-2).
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
          const parentToolUseId = (sdkMessage as Record<string, unknown>)
            .parent_tool_use_id as string | null | undefined;
          // SPEC K2: rastreia o subagente ativo p/ aninhar as tools que vierem nesta message.
          currentParentToolUseId = parentToolUseId ?? null;

          // CTX-COMPAT-FIX: conta requests do agente PRINCIPAL (independe de o
          // provider popular usage — GLM/MiniMax nao populam). 1 = turno simples.
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

            // CTX-FINAL: so o agente PRINCIPAL forma o contexto vivo desta sessao
            // (subagente roda em thread separada). A ultima request principal
            // vence (SET absoluto no sucesso). Mirror de orchestrator.ts:1463.
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
          const parentToolUseId = (sdkMessage as Record<string, unknown>)
            .parent_tool_use_id as string | null | undefined;
          const usage = event.usage as Record<string, number> | undefined;
          if (usage) {
            turnOutputTokens = usage.output_tokens || 0;

            // CTX-FINAL: output da ultima request do agente principal (mirror
            // orchestrator.ts:1512).
            if (!parentToolUseId) {
              lastMainOutput = turnOutputTokens;
            }

            if (parentToolUseId) {
              const existing = subagentTokens.get(parentToolUseId);
              if (existing) {
                existing.outputTokens += turnOutputTokens;
              }
            }

            // CTX-FINAL (live counter honesto): providers compat (GLM/MiniMax)
            // so reportam INPUT no `result` final — mid-turn o input real e 0 e
            // o chip mostrava "in: 0" enganoso enquanto o out crescia. Enquanto
            // nao chega input real, mostra a estimativa chars/4 do prompt marcada
            // como `estimated` (o TokenCounter prefixa com ~). A reconciliacao
            // final (billing) sobrescreve com o valor real, sem estimated.
            const liveInput = totalInputTokens + sidechainInputTokens + turnInputTokens;
            const inputIsEstimated = liveInput === 0;
            sendSessionStream({
              type: 'usage',
              usage: {
                inputTokens: inputIsEstimated
                  ? Math.max(
                      prevLiveContextEst,
                      estimateRequestTokens({ messageTexts: [finalMessage] }),
                    )
                  : liveInput,
                outputTokens: totalOutputTokens + sidechainOutputTokens + turnOutputTokens,
                cacheReadTokens: totalCacheReadTokens + sidechainCacheReadTokens + turnCacheReadTokens,
                cacheCreationTokens:
                  totalCacheCreationTokens + sidechainCacheCreationTokens + turnCacheCreationTokens,
                ...(inputIsEstimated ? { estimated: true } : {}),
              },
            });
          }
        }
      } else if (sdkMessage.type === 'assistant') {
        const blockTypes = sdkMessage.message.content.map((b) => b.type);
        logger.info({ blockTypes }, 'Assistant message block types');

        // SPEC contexto-vivo 3.5: so a thread PRINCIPAL alimenta o acumulador
        // agentico (subagente roda em thread propria; parent_tool_use_id != null).
        const assistantParentToolUseId =
          ((sdkMessage as unknown as Record<string, unknown>)
            .parent_tool_use_id as string | null | undefined) ?? null;

        for (const block of sdkMessage.message.content) {
          const blockAny = block as unknown as Record<string, unknown>;

          if (block.type === 'tool_use' || blockAny.type === 'mcp_tool_use') {
            const toolName = (blockAny.name as string) || '';
            const toolInput = (blockAny.input as Record<string, unknown>) || {};
            const toolId = (blockAny.id as string) || crypto.randomUUID();
            // SPEC contexto-vivo 3.5: tool_use ARGS da thread principal.
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

            // SPEC K2 v2 (secao 5.3): detalhe de tool. O input COMPLETO so existe
            // neste assistant-block; enriquece o item ja criado no start (mesmo id)
            // via phase:'update'. O 'Task' nao tem no de tool proprio.
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
            const rawToolName =
              (blockAny.name as string | undefined) || 'unknown';
            const toolInput = blockAny.input;
            const toolId = (blockAny.id as string) || crypto.randomUUID();
            const toolName = `server:${rawToolName}`;
            // SPEC contexto-vivo 3.5: server_tool_use tambem e um bloco
            // tool_use na janela da thread principal — ARGS contam.
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

          if (
            blockAny.type === 'mcp_tool_result' ||
            blockAny.type === 'tool_result'
          ) {
            metrics.toolResults += 1;
            // SPEC contexto-vivo 3.5: tool RESULT da thread principal — conteudo
            // CRU (blocos de imagem contam FLAT, nunca char/4 do base64).
            if (!assistantParentToolUseId) {
              agenticTurnTokens += estimateAgenticContentTokens(blockAny.content);
            }
            const resultContent =
              typeof blockAny.content === 'string'
                ? blockAny.content
                : Array.isArray(blockAny.content)
                  ? (blockAny.content as Array<{ text?: string }>)
                      .map((b) => b.text || '')
                      .join('')
                  : '';
            // SPEC K2 v2 (secao 5.3): resultado da tool -> marca changed/status no
            // item ja existente (phase:'update').
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
        const userContent = Array.isArray(sdkMessage.message.content)
          ? sdkMessage.message.content
          : [];
        // SPEC contexto-vivo 3.5: results de subagente ficam FORA (parent != null).
        const userParentToolUseId =
          ((sdkMessage as unknown as Record<string, unknown>)
            .parent_tool_use_id as string | null | undefined) ?? null;
        for (const contentBlock of userContent) {
          const block = contentBlock as unknown as Record<string, unknown>;
          if (
            block.type === 'mcp_tool_result' ||
            block.type === 'tool_result'
          ) {
            metrics.toolResults += 1;
            // SPEC contexto-vivo 3.5: tool RESULT da thread principal (imagem FLAT).
            if (!userParentToolUseId) {
              agenticTurnTokens += estimateAgenticContentTokens(block.content);
            }
            const resultContent =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? (block.content as Array<{ text?: string }>)
                      .map((b) => b.text || '')
                      .join('')
                  : '';
            // SPEC K2 v2 (secao 5.3): resultado da tool (message user) -> marca
            // changed/status no item ja existente (phase:'update').
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

            const artifact = captureToolResult(
              block.tool_use_id as string,
              resultContent,
              block.is_error as boolean,
            );
            if (artifact) {
              collectedArtifacts.push(artifact);
              sendSessionStream({ type: 'artifact', artifact });
            }
          }
        }
      } else if (sdkMessage.type === 'result') {
        const rUsage = (sdkMessage as unknown as { usage?: Record<string, number> }).usage;
        if (rUsage) resultUsage = rUsage;
        if (assistantContent.includes('ARQUIVO_AUDIO:')) {
          const audioMatches = assistantContent.matchAll(
            /ARQUIVO_AUDIO:\s*(.+?)(?:\n|$)/g,
          );
          for (const match of audioMatches) {
            const audioPath = match[1].trim();
            const artifact = captureToolResult(
              'text-detect',
              `ARQUIVO_AUDIO: ${audioPath}`,
              false,
            );
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

          // D17 (SPEC agent-sdk-0.3, espelho do orchestrator.ts): ferramentas
          // REAIS expostas pelo engine neste turno (VA-4).
          if (subtype === 'init') {
            logger.debug(
              { sessionId, provider: selection.provider, tools: msgAny.tools },
              'sdk init tools',
            );
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
            // SPEC contexto-vivo 3.6: compact_boundary do PROPRIO SDK => a
            // thread server-side foi rebasada no resumo. Zera o acumulador
            // agentico (base + turno; re-seed 0 — o evento nao carrega o texto
            // do resumo, so pre_tokens) e AVANCA o fence do historico para a
            // ultima mensagem persistida ate aqui (o que veio antes agora so
            // existe como resumo na thread; sem o fence o PISO re-inflaria e
            // ciclaria o threshold). O fence e persistido no SUCESSO do turno,
            // na MESMA escrita do acumulador (setSessionAgenticContextTokens).
            agenticBaseTokens = 0;
            agenticTurnTokens = 0;
            const boundaryLastMsgId =
              getSessionMessages(sessionId).reduce(
                (mx, m) => Math.max(mx, m.id),
                0,
              ) || null;
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

            // SPEC K2 (a): subagente START (identico ao orchestrator.ts).
            // v2 S2(d): acrescenta description (a TAREFA, ja no taskMap).
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
            const notifUsage = msgAny.usage as
              | Record<string, number>
              | undefined;

            const taskMeta = taskMap.get(toolUseId);

            const tokenEntry =
              subagentTokens.get(toolUseId) ||
              (taskId ? subagentTokens.get(taskId) : undefined) ||
              (taskMeta?.taskId
                ? subagentTokens.get(taskMeta.taskId)
                : undefined);

            const effectiveTokens = tokenEntry;

            const resolvedAgentId =
              taskMeta?.agentId ?? effectiveTokens?.agentId ?? null;
            let resolvedAgentName =
              effectiveTokens?.agentName ?? taskMeta?.description ?? '';
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
            const cacheCreationTokens =
              effectiveTokens?.cacheCreationTokens ?? 0;
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

            // SPEC K2 (b): subagente END ANTES do try/catch (AC-11) — identico ao orchestrator.ts.
            // v2 S2(d): acrescenta toolUses (de notifUsage.tool_uses) + description preservada.
            emitActivity({
              id: toolUseId,
              kind: 'subagent',
              phase: 'end',
              label: resolvedAgentName,
              status: taskStatus === 'completed' ? 'done' : 'error',
              agentId: resolvedAgentId,
              model: resolvedModel,
              tokens: { input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheCreation: cacheCreationTokens },
              costUsd,
              durationMs,
              summary,
              toolUses: toolUsesCount,
              description: taskMeta?.description || undefined,
              endedAt: new Date().toISOString(),
            });

            if (taskMeta?.executionId) {
              // Em providers compat, message_delta pode trazer output mesmo quando
              // message_start omite todo o input. Output isolado nao torna o usage
              // completo: toda request tem input, logo sem ele o custo e inseparavel
              // do agregado final e deve permanecer desconhecido.
              const hasReportedUsage = Boolean(effectiveTokens && inputTokens > 0 && apiRequests > 0);
              try {
                finalizeTaskExecutionOnce(taskMeta.executionId, {
                  status: taskStatus === 'completed'
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
                  costStatus: !hasReportedUsage
                    ? 'unknown'
                    : hasKnownPricing(resolvedModel) ? 'known' : 'unknown',
                  tokenStatus: hasReportedUsage ? 'reported' : 'not_reported',
                  costUnknownReason: !hasReportedUsage
                    ? 'no-usage-reported'
                    : hasKnownPricing(resolvedModel) ? null : 'unknown-pricing',
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
              logger.error(
                { err, toolUseId },
                'Failed to insert task execution',
              );
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
    // TEMPORARIO - smoke-audit: marca sucesso do turno (reportado no finally).
    turnOk = true;

    // SPEC orquestrador-fonte-unica 3.4: consumo ATOMICO do pending_seed no
    // sucesso do turno (mesmo ponto da escrita da lane, espelho do orchestrator).
    // O preambulo entrou exatamente uma vez nesta thread; uma falha do turno teria
    // pulado este ponto e preservado o pending_seed.
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

    // Reconcilia com o usage do result final (ver doc do resultUsage): max por
    // campo — corrige o in:0 dos compat sem mexer no caminho claude (onde o
    // acumulado do stream ja bate com o result).
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
          ...(runtime === 'minimax-tp'
            ? { costEstimationKind: 'subscription-equivalent-payg' as const }
            : {}),
        });
      } else {
        updateSessionTokens(sessionId, totalInputTokens, totalOutputTokens, totalCost, {
          costStatus: 'unknown',
          tokenStatus: 'not_reported',
          costUnknownReason: 'no-usage-reported',
          runtime,
          ...(runtime === 'minimax-tp'
            ? { costEstimationKind: 'subscription-equivalent-payg' as const }
            : {}),
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

    // CTX-FINAL/CTX-PRECISION (paridade Hermes): contexto VIVO = usage REAL da
    // ULTIMA request, NAO o agregado do turno. Fonte por SHAPE Anthropic (input
    // uncached + cache_read + cache_creation, sem dupla contagem), reconciliada
    // com o PISO estimado (Hermes conversation_loop:3766-3792). Duas fontes:
    //   1. usage cru da ULTIMA request PRINCIPAL (`lastMainUsageRaw`, do
    //      message_start) — o mais exato (a ultima request = o array inteiro que
    //      o modelo viu). GLM/MiniMax NAO populam usage no message_start
    //      (:747-751), entao aqui fica null e caimos no PISO;
    //   2. PISO estimado do PAYLOAD REAL char/4 (Hermes estimate_request_tokens_
    //      rough): system prompt + historico da sessao (server-side, invisivel a
    //      um estimate so-do-turno) + resposta + schemas das tools + imagens.
    // CTX-COMPAT-FIX: `resultUsage` E o ODOMETRO em turno AGENTICO (soma
    // cumulativa de TODAS as requests; ~14 tool calls inflavam ~6x, ~686K com
    // contexto real ~110K). MAS em turno SIMPLES (mainRequestCount <= 1, sem
    // tools) ele e a request UNICA = o contexto EXATO — como GLM/MiniMax nao
    // populam usage no stream, o resultUsage e a unica fonte REAL do turno
    // simples. Entao usamos resultUsage SO quando mainRequestCount <= 1; no
    // agentico segue o PISO forte abaixo.
    // `resultUsage` continua no billing acima (updateSessionTokens) sempre.
    // So no sucesso do turno (este ponto so e alcancado apos turnOk = true).
    //
    // SPEC contexto-vivo §3 (PISO FORTE): a estimativa antiga media so
    // fullSystemPrompt + historico + stub de schemas — despencava pra ~12k com
    // contexto real ~50-100k+ (turno agentico caia SEMPRE nela). O PISO forte
    // mede TODOS os buckets da janela:
    //   piso = system_total (fullSystemPrompt + CLI_PRESET_TOKENS + CLAUDE.md
    //          efetivo dos settingSources; indice MCP JA vive DENTRO do
    //          fullSystemPrompt no compat — nao soma de novo, §3.1)
    //        + schemas_total (CLI_BUILTIN_SCHEMAS_TOKENS + schemas MCP REAIS do
    //          mcp_tool_registry, mode-aware pela composicao do turno, §3.2)
    //        + agent_defs (COMPUTADO: nome+descricao dos subagents, §3.3)
    //        + historico APOS o fence (§3.4)
    //        + agentico (acumulador persistente: args+results da thread
    //          principal, base da sessao + turno corrente, §3.5)
    //        + imagens_flat (SO attachments; imagem em tool result ja entrou
    //          FLAT no bucket agentico, §3.5).
    // Buckets estaticos (I/O) cacheados por assinatura de composicao (§5).
    const compatImageCount =
      options.attachments?.filter((a) => a.type === 'image').length ?? 0;
    // Historico apos o fence (§3.4): max(compacted_up_to, thread_reset). O
    // fence de reset foi resolvido no inicio do turno (effectiveThreadResetId)
    // e pode ter avancado por compact_boundary mid-turno.
    const historyFence = resolveHistoryFence(
      sessionRow?.compactedUpToMessageId ?? null,
      effectiveThreadResetId,
    );
    const fencedMessages = getSessionMessagesAfterFence(sessionId, historyFence);
    const compatMessageTexts: string[] = [];
    // Seed/rolling_summary contam como historico (§3.4). pendingSeed entrou
    // como preambulo NESTE turno; rollingSummary cobre a lane que o persiste.
    // Nunca os dois (mesma origem — dupla contagem).
    if (pendingSeed) {
      compatMessageTexts.push(pendingSeed);
    } else if (sessionRow?.rollingSummary) {
      compatMessageTexts.push(sessionRow.rollingSummary);
    }
    for (const m of fencedMessages) compatMessageTexts.push(m.content);
    // Turno cujo texto do user NAO foi persistido nesta execucao (drive de
    // system-event ou retry _forceNewSession): o prompt enviado nao esta nas
    // fencedMessages — conta o finalMessage direto (sem dupla contagem: no
    // turno normal a user message persistida ja esta apos o fence).
    if (skipUserPersistence || options._forceNewSession) {
      compatMessageTexts.push(finalMessage);
    }
    compatMessageTexts.push(assistantContent);
    // Buckets ESTATICOS cacheados por assinatura de composicao (§5). Onboarding
    // fica fora: settingSources [], allowedTools [], sem MCP, agents {} — o
    // PISO do onboarding e so prompt + mensagens.
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
            const rows = getMcpToolRegistryEntries().filter((r) =>
              idSet.has(r.mcpId),
            );
            const mcpJson = serializeMcpSchemasForContext(rows, {
              includeGatewayMeta: indexMode,
            });
            return {
              settingsFilesTokens: estimateClaudeSettingsFilesTokens(),
              mcpSchemasTokens: mcpJson ? estimateTokensRough(mcpJson) : 0,
              // §3.3: APENAS nome+descricao (o prompt do subagente ocupa a
              // thread DO SUBAGENTE, nunca a janela principal).
              agentDefsTokens: compositionAgentIds.reduce(
                (sum, agentId) =>
                  sum +
                  estimateTokensRough(
                    `${agentId} ${String(agentDefinitions[agentId]?.description ?? '')}`,
                  ),
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
    // CTX-COMPAT-FIX: GLM/MiniMax POPULAM usage no message_start MAS com input/
    // cache ZERADOS (so o `result` final traz os totais). Entao `lastMainUsageRaw`
    // e um objeto truthy com prompt_tokens=0 -> checar o VALOR, nao a existencia.
    // Fonte do contexto, em ordem:
    //   1. lastMainUsageRaw SE prompt_tokens>0 (compat que popula de verdade);
    //   2. resultUsage em turno simples (mainRequestCount<=1): request unica =
    //      contexto exato (input + cache_read), NAO odometro.
    const lastMainCanonical = lastMainUsageRaw
      ? normalizeUsage(lastMainUsageRaw, 'anthropic')
      : null;
    const lastMainPrompt = lastMainCanonical ? canonicalPromptTokens(lastMainCanonical) : 0;
    const canonical =
      lastMainPrompt > 0
        ? lastMainCanonical
        : singleRequestTurn && resultUsage
          ? normalizeUsage(resultUsage, 'anthropic')
          : null;
    const realPromptTokens = canonical ? canonicalPromptTokens(canonical) : 0;
    const realOutputTokens =
      lastMainPrompt > 0 ? lastMainOutput : canonical ? canonical.outputTokens : 0;
    const liveContextTokens = reconcileActiveContext(
      realPromptTokens,
      realOutputTokens,
      compatContextEstimate,
    );
    setSessionActiveContextTokens(sessionId, liveContextTokens);
    // SPEC contexto-vivo 3.5/§5: persiste o acumulador AGENTICO da sessao
    // (regime de thread persistente — o proximo turno RESUME esta thread e
    // parte de base + turno). NO MAXIMO 1 UPDATE/turno; quando houve
    // compact_boundary mid-turno o fence avanca NA MESMA escrita.
    setSessionAgenticContextTokens(
      sessionId,
      agenticBaseTokens + agenticTurnTokens,
      boundaryFenceMessageId !== null ? boundaryFenceMessageId : undefined,
    );
    // SPEC robustez-chat SA-2 (AC-A3/AC-A4): barrinha model-aware no runtime
    // compat. contextTokens = o MESMO contexto vivo do contador ativo acima;
    // `source: 'provider'` quando veio de usage real, `'estimate'` no fallback.
    // Janela do resolver SA-1 (D4); desconhecida -> sem chunk (D5), sem crash.
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
      const recordOnboardingAudit = ({ toolName, input, output }: { toolName: string; input: string; output: string }) => {
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
      const cleaned = extractAndProcessOnboardingData(assistantContent, {
        sendStream: sendSessionStream,
        onAudit: recordOnboardingAudit,
      });
      if (cleaned !== null) assistantContent = cleaned;
      if (cleaned === null && isOnboarding) {
        completeOnboardingFromUserProfileMessage(finalMessage, {
          sendStream: sendSessionStream,
          onAudit: recordOnboardingAudit,
        });
      }

      const messageMetadata =
        collectedArtifacts.length > 0
          ? JSON.stringify({ artifacts: collectedArtifacts })
          : undefined;
      insertMessage(
        sessionId,
        'assistant',
        assistantContent,
        options.agentId,
        messageMetadata,
      );
      recordCompletedMainChatTurn(sessionId, getWindow);
    }

    if (sessionId) {
      const session = getSession(sessionId);
      if (
        session &&
        session.type !== 'scheduled' &&
        session.type !== 'telegram'
      ) {
        const msgs = getSessionMessages(session.id);
        const assistantCount = msgs.filter(
          (msg) => msg.role === 'assistant',
        ).length;
        const shouldGenerateTitle = !session.title || assistantCount === 1;

        if (shouldGenerateTitle && msgs.length >= 2) {
          generateSessionTitle(session.id).catch((err) => {
            logger.error({ err, sessionId }, 'Title generation failed');
          });
        }
      }
    }

    // SPEC robustez-chat SA-3 (AC-A5 [INV], decisao V3): gatilho pos-turno da
    // compactacao automatica leve — hook ADITIVO no fim do SUCESSO do turno
    // (depois do `done`; o catch/retry abaixo nunca passa por aqui), SINCRONO
    // (awaited) ANTES de retornar ao processQueue: a fila do desktop aguarda
    // executeQuery serialmente (que awaita este executor), entao o proximo
    // dequeue so roda apos a compactacao, ja lendo sdk_session_id/pending_seed
    // novos (AC-A6, exclusao mutua sem lock). Threshold model-aware (D1/D4):
    // passa o modelo/provider REAIS da selection do turno. Janela desconhecida
    // / sessao nao-chat / abaixo do threshold = no-op. NUNCA lanca
    // (best-effort — falha nao bloqueia o proximo turno).
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
      if (lane !== desktopLane) throw controlledError;
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
    // SPEC robustez-chat SB-6 (P11): fallback NUNCA e um 'Erro desconhecido'
    // seco — sem mensagem crua, usa a traducao classificada da tabela B.2
    // (com o marcador [code] para o tradutor do renderer). Com mensagem crua,
    // ela e preservada intacta (heuristicas a jusante continuam funcionando).
    const translatedError = translateProviderError(error, {
      runtime: 'claude-compat',
      provider: selection.provider,
      model,
    });
    const errorMsg =
      serializedError.message ||
      `[${translatedError.code}] ${translatedError.userMessage}`;
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

    if (
      shouldContinueSession &&
      lane.sdkActiveSessionId !== sdkSessionId &&
      !options._forceNewSession
    ) {
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
      // SPEC orquestrador-fonte-unica 3: o retry roda NA MESMA lane.
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
      // SB-6: codigo classificado ADITIVO (o tradutor do renderer prioriza
      // `code`; a mensagem crua segue intacta em `error`).
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
    // TEMPORARIO - smoke-audit: fim do turno claude-compat-sdk (ok=sucesso/falha).
    smokeAudit('turn_done', { lane: lane.name, runtime: 'claude-compat-sdk', sessionId, ok: turnOk });
    lane.currentAbortController = null;
  }
}

/**
 * Reset SDK session state for the Claude-compat chat lane. Mirrors
 * `resetSdkSessionState` in orchestrator.ts for the compat path so callers
 * that clear session files can drop the resume id here too.
 *
 * SPEC orquestrador-fonte-unica 3.1: recebe a lane (default desktop, compativel
 * com as chamadas existentes).
 */
export function resetClaudeCompatSdkSessionState(lane: SdkLane = desktopLane): void {
  lane.sdkActiveSessionId = null;
  stopClaudeCompatQuery(lane);
}

/**
 * Abort the in-flight Claude-compat query on the given lane, if any. Mirrors
 * `stopLaneQuery` in orchestrator.ts for the compat path.
 */
export function stopClaudeCompatQuery(lane: SdkLane = desktopLane): void {
  if (lane.currentAbortController) {
    lane.currentAbortController.abort();
    lane.currentAbortController = null;
  }
}

export function isClaudeCompatQueryActive(lane: SdkLane = desktopLane): boolean {
  return lane.currentAbortController !== null;
}
