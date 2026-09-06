
import crypto from 'crypto';
import type { BrowserWindow } from 'electron';
import { createLogger } from '../logger';
import { smokeAudit } from '../smoke-audit';
import {
  createSession,
  clearSessionPendingSeed,
  getActiveChatSession,
  getAllAgents,
  getSession,
  getSessionMessages,
  insertMessage,
  getTurnIndexForUserMessage,
  getLatestUserTurnIndex,
  getSetting,
  updateSessionTokens,
  setSessionActiveContextTokens,
} from '../db';
import { persistUserChatMessage } from '../user-attachments-meta';
import { calculateCost } from '../pricing';
import {
  estimateRequestTokens,
  reconcileActiveContext,
} from '../agent-runtime/context-measure';
import { ensureInitialSessionTitle } from '../title-generator';
import { listSkills } from '../skills';
import { getMCPConfigForAgent, getMCPToolsFromRegistry } from '../mcp-manager';
import { setupMCPsForSession, teardownMCPsForSession } from '../mcp-tool-bridge';
import type { McpServerSpec, McpSessionClient } from '../mcp-tool-bridge';
import type { QueryOptions } from '../orchestrator';
import type { OrchestratorSelection } from '../orchestrator-selection';
import { type SdkLane, desktopLane } from '../sdk-lane';
import type { StreamChunk } from '../../../src/types';
import { resolveLionContextWindowTokens } from '../chat-context-usage';

import {
  LION_SDK_SYSTEM_PROMPT_V1,
  buildLionMcpCatalogPrompt,
  buildLionSkillCatalogPrompt,
  buildLionSubagentCatalogPrompt,
  buildLionToolCatalogPrompt,
  parsePrefixedMcpName,
} from './prompt';
import { buildLionRuntimeContextPrompt } from './runtime-context';
import type { LionMcpToolEntry } from './prompt';
import { buildMcpToolIndex, buildDirectHelperCatalog } from '../mcp-tool-index';
import { LION_TOOL_SCHEMAS, MCP_SCHEMA_TOOL_SCHEMA } from './tool-registry';
import { createLionStreamTranslator, mcpToolLabel } from './stream-translator';
import { MAX_TOOL_TURNS, runLionLoop, type LionToolDispatcher } from './runtime';
import type { LionChatMessage } from './adapters/types';
import type { LionAdapter } from './adapters/types';
import { createOllamaAdapter } from './adapters/ollama';
import { createLmStudioAdapter } from './adapters/lmstudio';
import { createOpenAiCompatibleAdapter } from './adapters/openai-compatible';
import { createGoogleGenAiAdapter } from './adapters/google-genai';
import { compactIfNeeded } from './compaction';
import { isChatAutoCompactionEnabled } from '../chat-compaction-trigger';
import { buildSystemPrompt, buildPipelineControlSection, buildPipelineControlStub, getSubagentsPromptMode } from '../prompt-builder';
import {
  getActiveChatTurnByLane,
  getChatCapabilityTurn,
  computeEffectiveCapabilitiesForTurn,
} from '../chat-capability-context';
import { getRepoGraphPromptSection } from '../prompt-builder-repo-graph';
import {
  completeOnboardingFromConversationMessages,
  completeOnboardingFromUserProfileMessage,
  extractAndProcessOnboardingData,
  resolveOnboardingCompletedFromState,
} from '../onboarding';

import {
  createSessionFsState,
  lionEdit,
  lionGlob,
  lionGrep,
  lionRead,
  lionWrite,
} from './tools/filesystem';
import { lionBash } from './tools/bash';
import { lionSkillLoad } from './tools/skill';
import { lionAgentDispatch, PIPELINE_INTERNAL_SQUADS } from './tools/agent';
import { lionMcpCall, lionMcpCallViaWrapper } from './tools/mcp';
import { lionAskUserQuestion } from './tools/ask-user';
import { lionMemorySearch } from './tools/memory';
import { LionTodoStore, lionTodoWrite } from './tools/todo';
import { maybeGenerateLionSessionTitle } from './title';
import { recordCompletedMainChatTurn } from '../dreaming-turn-engine';
import { getAgentCwd } from '../paths';
import { getRepoGraphTurnContext } from '../repo-graph/turn-context';
import {
  createSubagentDispatchContext,
  isSubagentProviderAuthError,
  pendingSubagentProviderAuthError,
  subagentAuthFailure,
} from '../agent-runtime/subagent-dispatch';
import { PERM_DEFAULT_NO_BYPASS } from '../agent-runtime/permission-profiles';
import { resolveChatInheritedEffort } from '../agent-runtime/chat-effort-inheritance';

const logger = createLogger('lion-sdk');

export function stopLionSdkQuery(lane: SdkLane = desktopLane): void {
  if (lane.currentAbortController) {
    lane.currentAbortController.abort();
    lane.currentAbortController = null;
  }
}

export function isLionSdkQueryActive(lane: SdkLane = desktopLane): boolean {
  return lane.currentAbortController !== null;
}

export function resetLionSdkSessionState(lane: SdkLane = desktopLane): void {
  stopLionSdkQuery(lane);
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
  }
}

function resolveSessionId(
  options: QueryOptions,
  lane: SdkLane,
): { sessionId: string; created: boolean } {
  if (options.sessionId) return { sessionId: options.sessionId, created: false };
  if (lane !== desktopLane) {
    throw new Error(
      `Lane '${lane.name}' exige options.sessionId explicito (guard de sessao, SPEC 3.3)`,
    );
  }
  const active = getActiveChatSession();
  if (active) return { sessionId: active.id, created: false };
  const sessionId = crypto.randomUUID();
  createSession(sessionId, '');
  return { sessionId, created: true };
}

function resolveAdapter(selection: OrchestratorSelection): LionAdapter {
  switch (selection.provider) {
    case 'ollama':
      return createOllamaAdapter({
        baseUrl: selection.baseUrl ?? '',
      });
    case 'lmstudio':
      return createLmStudioAdapter({
        baseUrl: selection.baseUrl ?? '',
      });
    case 'openai-compatible':
      return createOpenAiCompatibleAdapter({
        baseUrl: selection.baseUrl ?? '',
        apiKey: selection.apiKey,
      });
    case 'vertex-ai':
      return createGoogleGenAiAdapter({
        apiKey: selection.apiKey ?? '',
      });
    default:
      throw new Error(`Lion-SDK: provider nao suportado "${selection.provider}".`);
  }
}

function isKimiSelection(selection: OrchestratorSelection): boolean {
  if (selection.provider !== 'openai-compatible') return false;
  return /kimi|moonshot/i.test(`${selection.model} ${selection.baseUrl ?? ''}`);
}

function listChatEligibleAgents() {
  return getAllAgents().filter((a) => {
    if (!a.isActive) return false;
    const squad = (a.squad ?? '').trim().toLowerCase();
    return !squad || !PIPELINE_INTERNAL_SQUADS.has(squad);
  });
}

export async function executeLionSdkQuery(
  message: string,
  options: QueryOptions,
  getWindow: () => BrowserWindow | null,
  lane: SdkLane = desktopLane,
  selection: OrchestratorSelection,
): Promise<void> {
  const { sessionId } = resolveSessionId(options, lane);
  const emit = (chunk: StreamChunk) => {
    options.onStreamChunk?.({ ...chunk, sessionId });
    sendStream(getWindow, options.silent, { ...chunk, sessionId });
  };

  emit({ type: 'session', content: sessionId });

  const sessionRow = getSession(sessionId);
  const compactedUpToMessageId = sessionRow?.compactedUpToMessageId;
  const pendingSeed = sessionRow?.pendingSeed ?? null;

  let isOnboarding = getSetting('onboarding_completed') !== 'true';
  if (isOnboarding && resolveOnboardingCompletedFromState()) {
    emit({ type: 'onboarding_completed' });
    isOnboarding = false;
  }

  const displayContent = options.displayMessage ?? message;
  const skipUserPersistence =
    options.origin === 'system-event' || options.skipUserMessagePersistence === true;
  let currentTurnIndex = 0;
  if (skipUserPersistence) {
    try {
      currentTurnIndex = getLatestUserTurnIndex(sessionId);
    } catch {
      currentTurnIndex = 0;
    }
  } else {
    try {
      const userMessageId = persistUserChatMessage(sessionId, displayContent, options.attachmentsMeta);
      currentTurnIndex = getTurnIndexForUserMessage(sessionId, userMessageId);
      ensureInitialSessionTitle(sessionId, displayContent);
    } catch (e) {
      logger.warn({ err: e, sessionId }, 'failed to persist user message');
      try {
        currentTurnIndex = getLatestUserTurnIndex(sessionId);
      } catch {
        currentTurnIndex = 0;
      }
    }
  }

  let adapter: LionAdapter;
  try {
    adapter = resolveAdapter(selection);
  } catch (e) {
    emit({ type: 'error', error: (e as Error).message });
    return;
  }

  const abortController = new AbortController();
  lane.currentAbortController = abortController;

  const mcpPromptMode: 'index' | 'full' =
    getSetting('mcp_prompt_mode') === 'full' ? 'full' : 'index';

  const useLazyMcpSetup =
    !isOnboarding && (mcpPromptMode === 'index' || selection.provider === 'vertex-ai');

  const chatLane = lane.name === 'desktop' || lane.name === 'telegram' || lane.name === 'cron'
    ? lane.name
    : undefined;
  const activeChatTurn = chatLane ? getActiveChatTurnByLane(chatLane) : undefined;
  const chatTurnContext = activeChatTurn ? getChatCapabilityTurn(activeChatTurn) : undefined;
  const chatCaps = lane.name === 'desktop' && chatTurnContext
    ? computeEffectiveCapabilitiesForTurn(chatTurnContext)
    : undefined;

  let mcpConfig: Record<string, McpServerSpec> | undefined;
  let mcpClient: McpSessionClient = { connections: [] };
  let mcpCatalog: LionMcpToolEntry[] = [];
  try {
    if (isOnboarding) {
      logger.info('Onboarding: text-only prompt, no tools');
    } else {
      mcpConfig = await getMCPConfigForAgent(options.agentId, { surface: 'lion-sdk', capabilities: chatCaps });
      if (mcpConfig && Object.keys(mcpConfig).length > 0) {
        if (useLazyMcpSetup) {
          const activeServerIds = Object.keys(mcpConfig);
          const registeredTools = getMCPToolsFromRegistry(activeServerIds);
          const entries: LionMcpToolEntry[] = [];
          for (const name of registeredTools) {
            const parsed = parsePrefixedMcpName(name);
            if (!parsed) continue;
            entries.push({
              serverId: parsed.serverId,
              toolName: parsed.toolName,
            });
          }
          mcpCatalog = entries;
        } else {
          const setup = await setupMCPsForSession(mcpConfig);
          mcpClient = setup.client;
          const rawEntries: LionMcpToolEntry[] = [];
          for (const t of setup.tools) {
            const parsed = parsePrefixedMcpName(t.function.name);
            if (!parsed) continue;
            const required = (t.function.parameters?.required ?? []) as string[];
            const props = (t.function.parameters?.properties ?? {}) as Record<string, { type?: string; description?: string }>;
            rawEntries.push({
              serverId: parsed.serverId,
              toolName: parsed.toolName,
              description: t.function.description,
              args: Object.entries(props).map(([name, prop]) => ({
                name,
                type: prop?.type,
                description: prop?.description,
                required: required.includes(name),
              })),
              requiredArgs: required.map((name) => ({
                name,
                type: props[name]?.type,
                description: props[name]?.description,
              })),
            });
          }
          mcpCatalog = rawEntries;
        }
      }
    }
  } catch (e) {
    logger.warn({ err: e }, 'Lion-SDK: setup/catalogo MCP falhou');
  }

  async function ensureMcpConnection(serverId: string): Promise<boolean> {
    if (!mcpConfig || !mcpConfig[serverId]) return false;
    if (mcpClient.connections.some((c) => c.serverId === serverId)) return true;
    const setup = await setupMCPsForSession({ [serverId]: mcpConfig[serverId] });
    mcpClient.connections.push(...setup.client.connections);
    return mcpClient.connections.some((c) => c.serverId === serverId);
  }

  const orchestratorToolSchemas =
    mcpPromptMode === 'index'
      ? [...LION_TOOL_SCHEMAS, MCP_SCHEMA_TOOL_SCHEMA]
      : [...LION_TOOL_SCHEMAS];
  const toolSchemas = isOnboarding ? [] : orchestratorToolSchemas;

  const p5ExplicitServerIds =
    options.agentId && mcpConfig ? Object.keys(mcpConfig) : [];
  const useMcpIndexCatalog =
    mcpPromptMode === 'index' &&
    !isOnboarding &&
    mcpConfig !== undefined &&
    Object.keys(mcpConfig).length > 0 &&
    p5ExplicitServerIds.length === 0;
  const systemPrompt = isOnboarding
    ? buildSystemPrompt(undefined, { mode: 'full', isOnboarding: true })
    : (() => {
        const skills = listSkills().map((s) => ({
          name: s.name,
          description: s.description,
          category: s.category,
        }));
        const agents = listChatEligibleAgents();
        const systemPromptParts = [
          LION_SDK_SYSTEM_PROMPT_V1,
          buildLionRuntimeContextPrompt(),
          buildLionToolCatalogPrompt(
            orchestratorToolSchemas.map((t) => ({ name: t.name, description: t.description })),
          ),
          chatCaps?.pipelineControl === false
            ? buildPipelineControlStub()
            : buildPipelineControlSection(),
          getRepoGraphPromptSection(),
          useMcpIndexCatalog
            ? [
                '## Available MCP Tools',
                '',
                [
                  buildMcpToolIndex({
                    invokeToolName: 'mcp_call',
                    schemaToolName: 'mcp_schema',
                    excludeServerIds: p5ExplicitServerIds,
                  }),
                  buildDirectHelperCatalog({
                    serverIds: mcpConfig ? Object.keys(mcpConfig) : [],
                    invokeToolName: 'mcp_call',
                  }),
                ]
                  .filter((part) => part.trim() !== '')
                  .join('\n\n'),
              ].join('\n')
            : buildLionMcpCatalogPrompt(mcpCatalog),
          buildLionSkillCatalogPrompt(skills),
          buildLionSubagentCatalogPrompt(agents, getSubagentsPromptMode()),
        ];
        return systemPromptParts.filter((part) => part.trim() !== '').join('\n\n---\n\n');
      })();

  const compactionRuntimeRaw = getSetting('orchestrator_compaction_runtime') || '';
  const compactionProviderRaw = getSetting('orchestrator_compaction_provider') || '';
  const compactionModelRaw = getSetting('orchestrator_compaction_model') || '';
  const maxContextTokensRaw = parseInt(
    getSetting('orchestrator_context_window_tokens') || '',
    10,
  );
  const compactionThresholdPercentRaw = parseInt(
    getSetting('orchestrator_compaction_threshold_percent') || '70',
    10,
  );
  const maxContextTokens =
    Number.isFinite(maxContextTokensRaw) && maxContextTokensRaw > 0
      ? maxContextTokensRaw
      : undefined;
  const contextWindowTokens = resolveLionContextWindowTokens(
    selection.model,
    selection.provider,
    maxContextTokens,
  );
  const compactionThresholdPercent = Number.isFinite(compactionThresholdPercentRaw)
    ? Math.min(95, Math.max(50, compactionThresholdPercentRaw))
    : undefined;
  const thresholdRatio = compactionThresholdPercent
    ? compactionThresholdPercent / 100
    : undefined;

  let compactionAdapter: LionAdapter | undefined;
  let compactionModel: string | undefined;
  let compactionAdapterFailed = false;

  if (compactionProviderRaw && compactionModelRaw) {
    try {
      let compBaseUrl: string | undefined;
      let compApiKey: string | undefined;
      if (compactionProviderRaw === 'ollama') {
        compBaseUrl = getSetting('orchestrator_ollama_base_url') ?? 'http://localhost:11434';
      } else if (compactionProviderRaw === 'lmstudio') {
        compBaseUrl = getSetting('orchestrator_lmstudio_base_url') ?? 'http://localhost:1234';
      } else if (compactionProviderRaw === 'openai-compatible') {
        compBaseUrl = getSetting('orchestrator_openai_compat_base_url') ?? undefined;
        const apiKeyRef = getSetting('orchestrator_openai_compat_api_key_ref');
        if (apiKeyRef) {
          const { getSecret } = await import('../secrets-vault');
          compApiKey = (await getSecret(apiKeyRef)) ?? undefined;
        }
      } else if (compactionProviderRaw === 'vertex-ai') {
        const apiKeyRef = getSetting('orchestrator_vertex_api_key_ref');
        if (apiKeyRef) {
          const { getSecret } = await import('../secrets-vault');
          compApiKey = (await getSecret(apiKeyRef)) ?? undefined;
        }
      }

      const compSelection: OrchestratorSelection = {
        runtime: (compactionRuntimeRaw || 'lion-sdk') as OrchestratorSelection['runtime'],
        provider: compactionProviderRaw as OrchestratorSelection['provider'],
        model: compactionModelRaw,
        source: 'settings',
        baseUrl: compBaseUrl,
        apiKey: compApiKey,
      };
      compactionAdapter = resolveAdapter(compSelection);
      compactionModel = compactionModelRaw;
    } catch (e) {
      compactionAdapterFailed = true;
      logger.warn(
        { err: e },
        'Lion-SDK: falha ao resolver adapter de compactacao; PULANDO compactacao deste turno (contexto intacto, retry no proximo)',
      );
    }
  }

  const seededUserMsg = pendingSeed ? `${pendingSeed}\n\n${message}` : message;

  let compactedHistory: LionChatMessage[] = [];
  if (compactionAdapterFailed || !isChatAutoCompactionEnabled()) {
    const raw = getSessionMessages(sessionId);
    const cut =
      compactedUpToMessageId !== undefined
        ? raw.filter((m) => m.id > compactedUpToMessageId)
        : raw;
    compactedHistory = cut
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(0, -1)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    compactedHistory.push({ role: 'user', content: seededUserMsg });
  } else {
    try {
      const compactResult = await compactIfNeeded({
        sessionId,
        newUserMsg: seededUserMsg,
        systemPrompt,
        primaryAdapter: adapter,
        primaryModel: selection.model,
        primaryProvider: selection.provider,
        maxContextTokens,
        thresholdRatio,
        compactionAdapter,
        compactionModel,
        compactedUpToMessageId,
        emitChunk: (chunk) => emit(chunk),
      });
      compactedHistory = compactResult.messages;
    } catch (e) {
      logger.error({ err: e, sessionId }, 'Lion-SDK: compactIfNeeded falhou');
      emit({ type: 'error', error: `Compactacao de contexto falhou: ${(e as Error).message}` });
      return;
    }
  }

  const initialMessages: LionChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...compactedHistory,
  ];

  const fsState = createSessionFsState();
  const todoStore = new LionTodoStore();
  const repoContext = getRepoGraphTurnContext();
  const subagentCwd = repoContext?.canonicalRootPath ?? getAgentCwd(isOnboarding);
  const remoteSubagentLane = lane.name === 'telegram' || lane.name === 'cron';
  const completeHostGrants = !remoteSubagentLane
    && chatTurnContext?.cwd
    && chatTurnContext.permissionProfile?.canUseTool
    && Array.isArray(chatTurnContext.allowedTools)
    && Array.isArray(chatTurnContext.allowedServerIds)
    && Array.isArray(chatTurnContext.readRoots)
    && Array.isArray(chatTurnContext.writeRoots)
      ? chatTurnContext
      : undefined;
  const subagentContext = createSubagentDispatchContext({
    ownerKind: 'chat',
    ownerId: sessionId,
    sessionId,
    lane: lane.name === 'telegram' || lane.name === 'cron' ? lane.name : 'desktop',
    surface: 'lion-sdk',
    cwd: completeHostGrants?.cwd ?? chatTurnContext?.cwd ?? subagentCwd,
    readRoots: completeHostGrants?.readRoots ?? [],
    writeRoots: completeHostGrants?.writeRoots ?? [],
    allowedTools: completeHostGrants?.allowedTools ?? [],
    allowedMcpServerIds: completeHostGrants?.allowedServerIds ?? [],
    permission: completeHostGrants?.permissionProfile ?? PERM_DEFAULT_NO_BYPASS,
    parentAbortSignal: abortController.signal,
    inheritedEffort: resolveChatInheritedEffort(),
  });

  const translator = createLionStreamTranslator({
    sessionId,
    turnIndex: currentTurnIndex,
    emit,
    subagent: options.agentId,
  });
  let shouldGenerateTitle = false;

  const dispatcher: LionToolDispatcher = async (call) => {
    if (isOnboarding) {
      return {
        content: 'Onboarding mode is text-only; tools are disabled.',
        isError: true,
      };
    }

    const raw = call.input as unknown;
    switch (call.name) {
      case 'Read': {
        const r = await lionRead(fsState, raw as Parameters<typeof lionRead>[1]);
        return r.isError ? { content: r.message, isError: true } : { content: r.value };
      }
      case 'Write': {
        const r = await lionWrite(fsState, raw as Parameters<typeof lionWrite>[1]);
        return r.isError ? { content: r.message, isError: true } : { content: r.value };
      }
      case 'Edit': {
        const r = await lionEdit(fsState, raw as Parameters<typeof lionEdit>[1]);
        return r.isError ? { content: r.message, isError: true } : { content: r.value };
      }
      case 'Glob': {
        const r = await lionGlob(raw as Parameters<typeof lionGlob>[0]);
        return r.isError ? { content: r.message, isError: true } : { content: r.value.join('\n') };
      }
      case 'Grep': {
        const r = await lionGrep(raw as Parameters<typeof lionGrep>[0]);
        return r.isError ? { content: r.message, isError: true } : { content: r.value };
      }
      case 'Bash': {
        const r = await lionBash(raw as Parameters<typeof lionBash>[0], { getWindow });
        const text = `exit=${r.exitCode} duration=${r.durationMs}ms\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
        return { content: text, isError: r.exitCode !== 0 || !!r.blocked };
      }
      case 'TodoWrite': {
        const r = lionTodoWrite(todoStore, raw as Parameters<typeof lionTodoWrite>[1]);
        if (!r.ok) return { content: r.error ?? 'TodoWrite falhou', isError: true };
        return { content: JSON.stringify({ todos: r.todos }) };
      }
      case 'AskUserQuestion': {
        const r = await lionAskUserQuestion(
          raw as Parameters<typeof lionAskUserQuestion>[0],
          { getWindow },
        );
        if (!r.ok) return { content: r.error ?? 'AskUserQuestion falhou', isError: true };
        return { content: JSON.stringify({ answers: r.answers, annotations: r.annotations }) };
      }
      case 'memory_search': {
        const r = await lionMemorySearch(raw as Parameters<typeof lionMemorySearch>[0]);
        if (!r.ok) return { content: r.error ?? 'memory_search falhou', isError: true };
        return { content: JSON.stringify({ results: r.results }) };
      }
      case 'mcp_call': {
        const input = raw as Parameters<typeof lionMcpCall>[1];
        const serverId = typeof input.server_id === 'string' ? input.server_id : '';
        if (!serverId) {
          return { content: 'mcp_call: server_id obrigatorio.', isError: true };
        }
        if (mcpPromptMode === 'index') {
          return await lionMcpCallViaWrapper(input, {
            sessionId,
            turnId: String(currentTurnIndex),
            allowedServerIds: mcpConfig ? Object.keys(mcpConfig) : [],
          });
        }
        const connected = await ensureMcpConnection(serverId);
        if (!connected) {
          return {
            content: `mcp_call: nenhum MCP ativo com server_id=${serverId}`,
            isError: true,
          };
        }
        const r = await lionMcpCall(mcpClient, input);
        const label = r.prefixedName
          ? mcpToolLabel(input.server_id ?? '', input.tool ?? '')
          : 'mcp_call';
        if (!r.ok) return { content: r.error ?? 'mcp_call falhou', isError: true, displayName: label };
        return { content: r.content ?? '', displayName: label };
      }
      case 'mcp_schema': {
        if (mcpPromptMode !== 'index') {
          return { content: `Unknown tool: ${call.name}`, isError: true };
        }
        const input = raw as { server?: unknown; tool?: unknown };
        const server = typeof input.server === 'string' ? input.server : '';
        const tool = typeof input.tool === 'string' ? input.tool : '';
        if (!server || !tool) {
          return { content: 'mcp_schema: server e tool obrigatorios.', isError: true };
        }
        const { getMcpToolSchema } = await import('../mcp-invoke');
        const r = getMcpToolSchema(server, tool);
        return { content: r.content, isError: r.isError };
      }
      case 'Agent':
      case 'Task': {
        const r = await lionAgentDispatch(
          raw as Parameters<typeof lionAgentDispatch>[0],
          { dispatchContext: subagentContext },
        );
        if (!r.ok) return { content: r.error ?? 'Agent falhou', isError: true, displayName: 'Agent' };
        return {
          content: JSON.stringify({
            status: r.status,
            executionId: r.executionId,
            summary: r.summary,
            output: r.output,
          }),
          displayName: 'Agent',
        };
      }
      case 'Skill': {
        const r = await lionSkillLoad(raw as Parameters<typeof lionSkillLoad>[0]);
        if (!r.ok) {
          return {
            content: `${r.error ?? 'Skill falhou'} (path=${r.attemptedPath ?? 'unknown'})`,
            isError: true,
            displayName: 'Skill',
          };
        }
        return { content: r.body ?? '', displayName: 'Skill' };
      }
      default:
        return { content: `Unknown tool: ${call.name}`, isError: true };
    }
  };

  let assistantText = '';
  let turnOk = false;
  smokeAudit('turn_start', { lane: lane.name, runtime: 'lion-sdk', sessionId });
  try {
    const result = await runLionLoop({
      adapter,
      model: selection.model,
      initialMessages,
      tools: toolSchemas,
      dispatcher,
      translator,
      abortSignal: abortController.signal,
      maxToolTurns: MAX_TOOL_TURNS,
      contextWindowTokens,
      compactionThresholdPercent,
      deferTextUntilToolParse: isKimiSelection(selection),
      dropTextWhenToolCalls: isKimiSelection(selection),
    });
    const childAuthError = pendingSubagentProviderAuthError(subagentContext);
    if (childAuthError) throw childAuthError;
    assistantText = result.finalText;
    turnOk = result.ok;
    if (assistantText.trim().length > 0) {
      const cleaned = extractAndProcessOnboardingData(assistantText, {
        sendStream: emit,
      });
      if (cleaned !== null) assistantText = cleaned;
      if (cleaned === null && isOnboarding) {
        const completedFromCurrentMessage = completeOnboardingFromUserProfileMessage(message, {
          sendStream: emit,
        });
        if (!completedFromCurrentMessage) {
          const onboardingMsgs = getSessionMessages(sessionId);
          const cutMsgs =
            compactedUpToMessageId !== undefined
              ? onboardingMsgs.filter((m) => m.id > compactedUpToMessageId)
              : onboardingMsgs;
          completeOnboardingFromConversationMessages(cutMsgs, message, {
            sendStream: emit,
          });
        }
      }

      try {
        insertMessage(sessionId, 'assistant', assistantText);
        recordCompletedMainChatTurn(sessionId, getWindow);
        if (pendingSeed) {
          clearSessionPendingSeed(sessionId);
          logger.info({ sessionId }, 'Lion-SDK: pending_seed consumido no sucesso do turno');
        }
        try {
          const u = result.usage;
          if (u.inputTokens > 0 || u.outputTokens > 0) {
            const costUsd = calculateCost(selection.model, u.inputTokens, u.outputTokens);
            updateSessionTokens(sessionId, u.inputTokens, u.outputTokens, costUsd, {
              costStatus: 'known',
              tokenStatus: 'reported',
              runtime: selection.provider === 'ollama' || selection.provider === 'lmstudio'
                ? 'local'
                : 'external',
            });
          }
          const lionContextEstimate = estimateRequestTokens({
            messageTexts: [
              ...initialMessages.map((m) => m.content),
              assistantText,
            ],
            toolSchemasJson: toolSchemas.length ? JSON.stringify(toolSchemas) : undefined,
          });
          setSessionActiveContextTokens(
            sessionId,
            reconcileActiveContext(
              result.lastContextTokens ?? 0,
              0,
              lionContextEstimate,
            ),
          );
        } catch (e) {
          logger.warn({ err: e, sessionId }, 'Lion-SDK: token persistence failed');
        }
        shouldGenerateTitle = result.ok && !isOnboarding;
      } catch (e) {
        logger.warn({ err: e, sessionId }, 'failed to persist assistant message');
      }
    } else {
      logger.debug({ sessionId, ok: result.ok, errorReason: result.errorReason }, 'skipped empty Lion-SDK assistant message');
    }
  } catch (e) {
    logger.error({ err: e, sessionId }, 'Lion-SDK runtime falhou');
    if (isSubagentProviderAuthError(e)) {
      emit({ type: 'error', sessionId, ...subagentAuthFailure(e) });
      if (lane !== desktopLane) throw e;
    } else {
      emit({ type: 'error', error: (e as Error).message });
    }
  } finally {
    smokeAudit('turn_done', { lane: lane.name, runtime: 'lion-sdk', sessionId, ok: turnOk });
    if (mcpClient && mcpClient.connections.length > 0) {
      try {
        await teardownMCPsForSession(mcpClient);
      } catch (e) {
        logger.debug({ err: e }, 'teardownMCPsForSession threw');
      }
    }
    if (lane.currentAbortController === abortController) {
      lane.currentAbortController = null;
    }
  }

  if (shouldGenerateTitle) {
    maybeGenerateLionSessionTitle({
      sessionId,
      adapter,
      model: selection.model,
      getWindow,
    }).catch((err) => {
      logger.warn({ err, sessionId }, 'Lion-SDK title generation failed');
    });
  }
}
