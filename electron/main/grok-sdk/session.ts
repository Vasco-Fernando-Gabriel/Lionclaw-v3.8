import type { BrowserWindow } from 'electron';
import { getEnabledTools, getSetting } from '../db';
import { buildSystemPrompt, loadGeneratedAgentContext } from '../prompt-builder';
import { estimateTokensRough } from '../agent-runtime/context-measure';
import { createLogger } from '../logger';
import { getGrokAcpDriver } from '../grok-acp/acp-driver';
import { startGrokMcpBridge, type GrokMcpBridge } from '../grok-acp/mcp-http-bridge';
import {
  buildGrokNativeToolPolicy,
  buildGrokSessionTools,
} from '../agent-runtime/grok-session-config';
import {
  createSubagentDispatchContext,
  pendingSubagentProviderAuthError,
  resolveSubagentHostAllowedTools,
} from '../agent-runtime/subagent-dispatch';
import { resolveChatInheritedEffort } from '../agent-runtime/chat-effort-inheritance';
import { acquireGrokSlot, configureGrokConcurrency } from '../agent-runtime/grok-concurrency';
import {
  buildGrokChildEnv,
  isGrokAvailable,
  prepareGrokWorkspace,
  resolveGrokBinary,
  resolveGrokHome,
  GrokUnavailableError,
} from '../agent-runtime/grok-availability';
import { createPermissionGuard } from '../permission-guard';
import { PERM_DEFAULT_WITH_GUARD } from '../agent-runtime/permission-profiles';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { CliRunHandle, CliStreamCallbacks } from '../agent-runtime/cli-agentic/contract';
import type { GrokAcpResponse } from '../grok-acp/acp-translator';
import type { ChatFeatureToggles } from '../../../src/types';
import type { GrokReasoningEffort } from '../../../src/constants/grok-models';
import {
  acquireGrokSandboxSpawnLock,
  assertGrokWorkspaceUnchanged,
  attestGrokSession,
  ensureGrokSandboxProfile,
  grokInputTouchesProtectedSource,
  snapshotGrokSandboxAttestation,
  waitForGrokSandboxApplied,
  type GrokWorkspaceGrant,
} from './workspace';

const logger = createLogger('grok-sdk-session');

export interface CreateChatGrokSessionOptions {
  sessionId: string;
  model: string;
  effort: GrokReasoningEffort;
  getWindow: () => BrowserWindow | null;
  abortSignal: AbortSignal;
  lane: 'desktop' | 'telegram' | 'cron';
  agentId?: string;
  isOnboarding?: boolean;
  capabilities?: ChatFeatureToggles;
  workspaceGrant: GrokWorkspaceGrant;
}

export interface GrokSessionContextMeta {
  systemPromptTokens: number;
  toolSchemasTokens: number;
}

export interface ChatGrokSession {
  send(prompt: string, callbacks: CliStreamCallbacks, abortSignal: AbortSignal): Promise<GrokAcpResponse>;
  close(): Promise<void>;
  contextMeta: GrokSessionContextMeta;
}

export async function createChatGrokSession(
  opts: CreateChatGrokSessionOptions,
): Promise<ChatGrokSession> {
  const availability = await isGrokAvailable();
  if (!availability.usable) {
    throw new GrokUnavailableError(
      availability.reason ?? 'Grok Build nao esta autenticado e isolado no home do LionClaw.',
    );
  }
  const binary = await resolveGrokBinary();
  if (!binary) throw new GrokUnavailableError('Grok Build CLI nao encontrado.');
  const isOnboarding = opts.isOnboarding ?? false;
  const workDir = opts.workspaceGrant.sessionCwd;
  const lionPrompt = buildSystemPrompt(opts.agentId, {
    isOnboarding,
    model: opts.model,
    chatSurface: 'grok-sdk',
    capabilities: opts.capabilities,
  });
  const generated = isOnboarding ? '' : loadGeneratedAgentContext();
  const runtimeBlock = [
    '## Runtime atual',
    '',
    `Grok Build via assinatura no CLI oficial; modelo ${opts.model}; effort ${opts.effort}.`,
    'Os subagentes nativos do Grok estao desativados. Delegue somente pelas tools do LionClaw.',
  ].join('\n');
  const systemPrompt = [generated, lionPrompt, runtimeBlock].filter(Boolean).join('\n\n');
  const toolAbortController = new AbortController();
  const hasWorkspace = opts.workspaceGrant.source === 'desktop-repository';
  const config: AgentQueryConfig = {
    model: opts.model,
    systemPrompt,
    allowedTools: hasWorkspace ? getEnabledTools() : [],
    mcpServers: [],
    maxTurns: undefined,
    effort: opts.effort,
    thinking: 'enabled',
    thinkingBudget: undefined,
    runtime: 'grok',
  };
  const permission = PERM_DEFAULT_WITH_GUARD(
    createPermissionGuard(opts.getWindow, { isOnboarding }),
  );
  const baseGuard = permission.canUseTool;
  permission.canUseTool = async (toolName, input, context) => {
    assertGrokWorkspaceUnchanged(opts.workspaceGrant);
    if (
      (toolName === 'Write' || toolName === 'Edit' || toolName === 'Bash')
      && grokInputTouchesProtectedSource(opts.workspaceGrant, input)
    ) {
      return { behavior: 'deny', message: 'Fonte de instrucao/configuracao Grok protegida pelo snapshot do turno.' };
    }
    return baseGuard
      ? baseGuard(toolName, input, context)
      : { behavior: 'deny', message: 'Tool sem guard efetivo.' };
  };
  const { getMCPConfigForAgent } = await import('../mcp-manager');
  const parentMcpConfig = opts.lane === 'desktop'
    ? await getMCPConfigForAgent(opts.agentId, {
        surface: 'grok-sdk',
        capabilities: opts.capabilities,
      })
    : undefined;
  const parentMcpServerIds = Object.keys(parentMcpConfig ?? {});
  const dispatchContext = createSubagentDispatchContext({
    ownerKind: 'chat',
    ownerId: opts.sessionId,
    sessionId: opts.sessionId,
    lane: opts.lane,
    surface: 'grok-sdk',
    cwd: workDir,
    readRoots: opts.workspaceGrant.readRoots,
    writeRoots: opts.workspaceGrant.writeRoots,
    allowedTools: await resolveSubagentHostAllowedTools(
      config.allowedTools,
      parentMcpServerIds,
    ),
    allowedMcpServerIds: parentMcpServerIds,
    permission,
    parentAbortSignal: opts.abortSignal,
    inheritedEffort: resolveChatInheritedEffort(),
  });
  const toolProfile = opts.lane === 'desktop' ? 'chat' : 'remote-chat';
  const sessionTools = await buildGrokSessionTools({
    profile: toolProfile,
    config,
    cwd: workDir,
    abortController: toolAbortController,
    capabilities: opts.capabilities,
    dispatchContext,
    allowUserQuestion: opts.lane === 'desktop',
    getWindow: opts.getWindow,
  });
  const externalTools = sessionTools.externalTools.map((tool) => ({
    ...tool,
    async handler(input: Record<string, unknown>, callContext?: { toolUseId: string }) {
      assertGrokWorkspaceUnchanged(opts.workspaceGrant);
      if (grokInputTouchesProtectedSource(opts.workspaceGrant, input)) {
        throw new Error('Tool LionClaw tentou alterar fonte/configuracao protegida do Grok.');
      }
      const result = await tool.handler(input, callContext);
      assertGrokWorkspaceUnchanged(opts.workspaceGrant);
      return result;
    },
  }));
  const nativePolicy = buildGrokNativeToolPolicy(
    toolProfile,
    opts.lane === 'desktop' ? config.allowedTools : [],
  );
  const env = buildGrokChildEnv();
  const grokHome = resolveGrokHome();
  await prepareGrokWorkspace(opts.workspaceGrant, binary, env);
  const configuredConcurrency = Number.parseInt(getSetting('grok_max_concurrency') || '3', 10);
  configureGrokConcurrency(
    Number.isInteger(configuredConcurrency) && configuredConcurrency >= 1 && configuredConcurrency <= 16
      ? configuredConcurrency
      : 3,
  );
  const releaseSlot = await acquireGrokSlot({
    role: 'parent',
    toolBearing: externalTools.length > 0 || nativePolicy.effectiveTools.length > 0,
    signal: opts.abortSignal,
    rootExecutionId: dispatchContext.rootExecutionId,
    executionDepth: dispatchContext.depth,
  });
  let bridge: GrokMcpBridge | null = null;
  try {
    if (externalTools.length > 0) {
      bridge = await startGrokMcpBridge({
        tools: externalTools,
        serverName: 'lionclaw',
      });
    }
  } catch (error) {
    releaseSlot();
    throw error;
  }

  const reconciledPrompt = sessionTools.systemPrompt;
  const driver = getGrokAcpDriver();
  let handle: CliRunHandle;
  try {
    const releaseSandboxSpawn = await acquireGrokSandboxSpawnLock();
    try {
      const sandbox = ensureGrokSandboxProfile(opts.workspaceGrant, grokHome);
      const sandboxAttestation = snapshotGrokSandboxAttestation(
        grokHome,
        sandbox,
        opts.workspaceGrant.processCwd,
        opts.workspaceGrant.projectSources.map((source) => source.path),
      );
      const spawned = await driver.createRun({
        workDir,
        processCwd: opts.workspaceGrant.processCwd,
        model: opts.model,
        effort: opts.effort,
        thinking: true,
        systemPrompt: '',
        executable: binary,
        env,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
        profile: toolProfile,
        surface: 'chat',
        ownerKind: 'chat',
        runId: opts.sessionId,
        sandbox,
        permission,
        nativeToolArgs: nativePolicy.argv,
        mcpServers: bridge ? [bridge.mcpServerEntry] : [],
        attestSession: (sessionId) => attestGrokSession(opts.workspaceGrant, grokHome, sessionId),
        assertWorkspaceUnchanged: () => assertGrokWorkspaceUnchanged(opts.workspaceGrant),
      });
      try {
        await waitForGrokSandboxApplied(sandboxAttestation);
      } catch (error) {
        await spawned.close().catch(() => undefined);
        throw error;
      }
      handle = spawned;
    } finally {
      releaseSandboxSpawn();
    }
  } catch (error) {
    if (bridge) await bridge.stop().catch(() => undefined);
    releaseSlot();
    throw error;
  }
  let firstSend = true;
  const contextMeta: GrokSessionContextMeta = {
    systemPromptTokens: estimateTokensRough(reconciledPrompt),
    toolSchemasTokens: externalTools.length > 0
      ? estimateTokensRough(JSON.stringify(externalTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }))))
      : 0,
  };

  return {
    contextMeta,
    async send(prompt, callbacks, abortSignal) {
      const fullPrompt = firstSend && reconciledPrompt.trim()
        ? `## Instrucoes do agente\n\n${reconciledPrompt}\n\n## Tarefa\n\n${prompt}`
        : prompt;
      firstSend = false;
      try {
        const response = await handle.send(fullPrompt, callbacks, abortSignal) as GrokAcpResponse;
        const authError = pendingSubagentProviderAuthError(dispatchContext);
        if (authError) throw authError;
        return response;
      } catch (error) {
        throw pendingSubagentProviderAuthError(dispatchContext) ?? error;
      }
    },
    async close() {
      toolAbortController.abort();
      try {
        await handle.close();
      } catch (err) {
        logger.warn({ err, sessionId: opts.sessionId }, 'grok chat handle.close failed');
      }
      if (bridge) {
        try {
          await bridge.stop();
        } catch (err) {
          logger.warn({ err, sessionId: opts.sessionId }, 'grok chat bridge.stop failed');
        }
      }
      releaseSlot();
    },
  };
}
