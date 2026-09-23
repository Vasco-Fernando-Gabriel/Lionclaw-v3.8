import { getAgentCwd } from '../paths';
import { getEnabledTools } from '../db';
import { buildSystemPrompt, loadGeneratedAgentContext } from '../prompt-builder';
import { estimateTokensRough } from '../agent-runtime/context-measure';
import { createLogger } from '../logger';
import { getKimiAcpDriver } from '../kimi-acp/acp-driver';
import { startKimiMcpBridge, type KimiMcpBridge } from '../kimi-acp/mcp-http-bridge';
import { buildKimiSessionTools } from '../agent-runtime/kimi-session-config';
import { appendAgentDetailsSteering } from './agent-details-steering';
import { isKimiAvailable, resolveKimiBinary, KimiUnavailableError } from '../agent-runtime/kimi-availability';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { CliAgenticResponse, CliRunHandle, CliStreamCallbacks } from '../agent-runtime/cli-agentic/contract';
import type { ChatFeatureToggles } from '../../../src/types';
import { resolveKimiEffectiveThinking, type KimiEffort } from '../../../src/constants/kimi-models';
import type { AgentPermissionProfile } from '../agent-runtime/types';
import {
  createSubagentDispatchContext,
  pendingSubagentProviderAuthError,
  resolveSubagentHostAllowedTools,
} from '../agent-runtime/subagent-dispatch';
import { resolveChatInheritedEffort } from '../agent-runtime/chat-effort-inheritance';
import { acquireKimiSlot } from '../agent-runtime/kimi-concurrency';
import { randomUUID } from 'node:crypto';

const logger = createLogger('kimi-sdk-session');

const KIMI_SUBSCRIPTION_MODEL = 'kimi-code/kimi-for-coding';

export interface CreateChatKimiSessionOptions {
  swarmReadOnly?: boolean;
  sessionId: string;
  model: string;
  effort?: KimiEffort;
  permission?: AgentPermissionProfile;
  abortSignal?: AbortSignal;
  agentId?: string;
  isOnboarding?: boolean;
  capabilities?: ChatFeatureToggles;
  lane?: 'desktop' | 'telegram' | 'cron';
  turnBinding?: { sessionId: string; turnId: string };
}

export interface KimiSessionContextMeta {
  systemPromptTokens: number;
  toolSchemasTokens: number;
}

export interface ChatKimiSession {
  send(prompt: string, callbacks: CliStreamCallbacks, abortSignal: AbortSignal): Promise<CliAgenticResponse>;
  close(): Promise<void>;
  contextMeta: KimiSessionContextMeta;
}

export async function createChatKimiSession(opts: CreateChatKimiSessionOptions): Promise<ChatKimiSession> {
  const availability = await isKimiAvailable(opts.model);
  if (availability.authMode === 'none') {
    throw new KimiUnavailableError(
      'Kimi nao esta autenticado. Rode `/login` na CLI do Kimi (assinatura) antes de selecionar Kimi como orquestrador.',
    );
  }
  if (
    availability.managedProviderVerified === false ||
    availability.modelAvailable === false ||
    availability.usable === false
  ) {
    throw new KimiUnavailableError(`Modelo ${opts.model} nao esta disponivel pelo provider managed/OAuth do Kimi CLI.`);
  }

  const binary = await resolveKimiBinary();
  const isOnboarding = opts.isOnboarding ?? false;
  const workDir = getAgentCwd(isOnboarding);
  const effectiveThinking = resolveKimiEffectiveThinking(opts.model, opts.effort, true, 'inherited');
  const thinking = effectiveThinking.mode !== 'none';

  const lionPrompt = buildSystemPrompt(opts.agentId, {
    isOnboarding,
    model: opts.model,
    chatSurface: 'kimi-sdk',
    capabilities: opts.capabilities,
  });
  const agentContext = isOnboarding ? '' : loadGeneratedAgentContext();
  const chatSystemPrompt = agentContext ? `${agentContext}\n\n${lionPrompt}` : lionPrompt;

  const toolAbortController = new AbortController();
  const permission = opts.permission;
  if (!permission) throw new Error('Sessao Kimi de chat exige permission profile efetivo.');
  const lane = opts.lane ?? 'desktop';
  const { getMCPConfigForAgent } = await import('../mcp-manager');
  const parentMcpConfig =
    lane === 'desktop'
      ? await getMCPConfigForAgent(opts.agentId, {
          surface: 'kimi-sdk',
          capabilities: opts.capabilities,
        })
      : undefined;
  const parentMcpServerIds = Object.keys(parentMcpConfig ?? {});
  const dispatchContext = createSubagentDispatchContext({
    ownerKind: 'chat',
    ownerId: opts.sessionId,
    sessionId: opts.sessionId,
    lane,
    surface: 'kimi-sdk',
    cwd: workDir,
    readRoots: [workDir],
    writeRoots: [],
    allowedTools: await resolveSubagentHostAllowedTools(
      lane === 'desktop' ? getEnabledTools() : [],
      parentMcpServerIds,
    ),
    allowedMcpServerIds: parentMcpServerIds,
    permission,
    parentAbortSignal: toolAbortController.signal,
    inheritedEffort: resolveChatInheritedEffort('kimi-sdk', opts.effort),
  });
  const chatConfig: AgentQueryConfig = {
    model: opts.model,
    systemPrompt: chatSystemPrompt,
    allowedTools: [],
    mcpServers: [],
    maxTurns: undefined,
    effort: effectiveThinking.mode === 'tiered' ? effectiveThinking.effective : 'max',
    thinking: thinking ? 'enabled' : 'disabled',
    thinkingBudget: undefined,
    runtime: 'kimi',
  };
  const sessionTools = await buildKimiSessionTools({
    profile: 'chat',
    config: chatConfig,
    cwd: workDir,
    abortController: toolAbortController,
    lane,
    sessionId: opts.sessionId,
    dispatchContext,
    capabilities: opts.capabilities,
    ...(opts.turnBinding ? { turnBinding: { ...opts.turnBinding, ...(lane ? { lane } : {}) } } : {}),
  });

  const reconciledPrompt = appendAgentDetailsSteering(
    sessionTools.systemPrompt,
    new Set(sessionTools.externalTools.map((t) => t.name)),
  );

  const contextMeta: KimiSessionContextMeta = {
    systemPromptTokens: estimateTokensRough(reconciledPrompt),
    toolSchemasTokens:
      sessionTools.externalTools.length > 0
        ? estimateTokensRough(
            JSON.stringify(
              sessionTools.externalTools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
            ),
          )
        : 0,
  };

  let releaseSlot: () => void;
  try {
    releaseSlot = await acquireKimiSlot({
      role: 'parent',
      toolBearing: sessionTools.externalTools.some((tool) => tool.name === 'lion_run_subagent'),
      ...(opts.abortSignal ? { signal: opts.abortSignal } : {}),
      parentExecutionId: dispatchContext.parentExecutionId,
      rootExecutionId: dispatchContext.rootExecutionId,
      executionDepth: dispatchContext.depth,
    });
  } catch (error) {
    toolAbortController.abort();
    throw error;
  }

  let bridge: KimiMcpBridge | null = null;

  let handle: CliRunHandle;
  try {
    if (!opts.swarmReadOnly && sessionTools.externalTools.length > 0) {
      bridge = await startKimiMcpBridge({
        tools: sessionTools.externalTools,
        serverName: 'LionClaw Bridge',
      });
    }
    handle = await getKimiAcpDriver().createRun({
      workDir,
      model: opts.model,
      effort: effectiveThinking.envEffort,
      thinking,
      systemPrompt: '',
      ...(binary ? { executable: binary } : {}),
      ...(opts.permission ? { permission: opts.permission } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      profile: 'chat',
      surface: 'chat',
      ownerKind: 'chat',
      runId: `kimi-chat-${randomUUID()}`,
      ownerId: opts.sessionId,
      mcpServers: bridge ? [bridge.mcpServerEntry] : [],
    });
  } catch (error) {
    toolAbortController.abort();
    if (bridge) await bridge.stop().catch(() => undefined);
    releaseSlot();
    throw error;
  }

  const abortToolsFromParent = (): void => {
    toolAbortController.abort(opts.abortSignal?.reason);
  };
  let detachParentAbort = (): void => undefined;
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) {
      abortToolsFromParent();
    } else {
      opts.abortSignal.addEventListener('abort', abortToolsFromParent, { once: true });
      detachParentAbort = () => opts.abortSignal?.removeEventListener('abort', abortToolsFromParent);
    }
  }

  let firstSend = true;

  return {
    contextMeta,
    async send(prompt: string, callbacks: CliStreamCallbacks, abortSignal: AbortSignal): Promise<CliAgenticResponse> {
      const leadingPrompt =
        firstSend && reconciledPrompt.trim().length > 0
          ? `## Instrucoes do agente\n\n${reconciledPrompt}\n\n## Tarefa\n\n${prompt}`
          : prompt;
      firstSend = false;

      try {
        const response = await handle.send(
          leadingPrompt,
          {
            onText: callbacks.onText,
            onThinking: callbacks.onThinking,
            onToolUse: callbacks.onToolUse,
            onToolUseComplete: callbacks.onToolUseComplete,
            onToolUseIO: callbacks.onToolUseIO,
            onActivity: callbacks.onActivity,
          },
          abortSignal,
        );
        const authError = pendingSubagentProviderAuthError(dispatchContext);
        if (authError) throw authError;
        return response;
      } catch (error) {
        throw pendingSubagentProviderAuthError(dispatchContext) ?? error;
      }
    },
    async close(): Promise<void> {
      detachParentAbort();
      detachParentAbort = (): void => undefined;
      try {
        toolAbortController.abort();
      } catch {}
      try {
        await handle.close();
      } catch (err) {
        logger.warn({ err, sessionId: opts.sessionId }, 'kimi chat handle.close() failed');
      }
      if (bridge) {
        try {
          await bridge.stop();
        } catch (err) {
          logger.warn({ err, sessionId: opts.sessionId }, 'kimi chat bridge.stop() failed');
        }
      }
      releaseSlot();
    },
  };
}

export { KIMI_SUBSCRIPTION_MODEL };
