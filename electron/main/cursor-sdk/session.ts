
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import { getEnabledTools, getSessionActiveRepository, getLocalRepository } from '../db';
import { createLogger } from '../logger';
import { buildSystemPrompt, loadGeneratedAgentContext } from '../prompt-builder';
import { appendRepoGraphSection } from '../prompt-builder-repo-graph';
import { estimateTokensRough } from '../agent-runtime/context-measure';
import { getSecret } from '../secrets-vault';
import { getCursorModel } from '../../../src/constants/cursor-models';
import { TypedProviderError } from '../agent-runtime/llm-error';
import { createPermissionGuard } from '../permission-guard';
import { PERM_DEFAULT_WITH_GUARD } from '../agent-runtime/permission-profiles';
import {
  createSubagentDispatchContext,
  pendingSubagentProviderAuthError,
  resolveSubagentHostAllowedTools,
} from '../agent-runtime/subagent-dispatch';
import { resolveChatInheritedEffort } from '../agent-runtime/chat-effort-inheritance';
import { buildCursorSessionTools } from '../agent-runtime/cursor-session-config';
import {
  CURSOR_GUARDED_NATIVE_ALLOWLIST,
  buildCursorGuardedToolset,
} from '../agent-runtime/cursor-sidecar/guarded-tools';
import { isCursorCatalogModel } from '../agent-runtime/cursor-sidecar/model-catalog';
import { composeCursorToolDispatchers } from '../agent-runtime/cursor-sidecar/tool-dispatch';
import {
  runCursorSidecarExecution,
  type CursorSidecarExecutionResult,
  type CursorSidecarStreamEvent,
} from '../agent-runtime/cursor-sidecar/sidecar-manager';
import {
  cursorSessionStoreDir,
  loadCursorSession,
  saveCursorSession,
} from '../agent-runtime/cursor-sidecar/session-registry';
import { getLionClawHome } from '../paths';
import {
  cursorChatInputTouchesRules,
  cursorChatInputTouchesWorkspacesRoot,
  cursorChatWorkspacesRoot,
  materializeCursorChatRules,
  resolveCursorChatWorkspace,
  type CursorChatLane,
  type CursorChatWorkspace,
} from './workspace';
import type { ChatFeatureToggles } from '../../../src/types';

const logger = createLogger('cursor-sdk-session');

const CURSOR_VAULT_KEY = 'CURSOR_API_KEY';

export interface CreateChatCursorSessionOptions {
  sessionId: string;
  model: string;
  getWindow: () => BrowserWindow | null;
  abortController: AbortController;
  lane: CursorChatLane;
  agentId?: string;
  isOnboarding?: boolean;
  capabilities?: ChatFeatureToggles;
}

export interface CursorSessionContextMeta {
  systemPromptTokens: number;
  toolSchemasTokens: number;
}

export interface ChatCursorSession {
  resuming: boolean;
  contextMeta: CursorSessionContextMeta;
  workspace: CursorChatWorkspace;
  send(
    prompt: string,
    onEvent: (event: CursorSidecarStreamEvent) => void,
  ): Promise<CursorSidecarExecutionResult>;
  close(): void;
}

export function buildCursorChatSessionKey(lane: CursorChatLane, sessionId: string): string {
  return `chat::${lane}::${sessionId}`;
}

export async function createChatCursorSession(
  opts: CreateChatCursorSessionOptions,
): Promise<ChatCursorSession> {
  if (!getCursorModel(opts.model) && !isCursorCatalogModel(opts.model)) {
    throw new TypedProviderError('LLM-MODEL-404', {
      message: `Modelo "${opts.model}" nao pertence ao catalogo do runtime Cursor.`,
      raw: `model=${opts.model} runtime=cursor-sdk`,
    });
  }
  const apiKey = await getSecret(CURSOR_VAULT_KEY);
  if (!apiKey) {
    throw new TypedProviderError('LLM-AUTH-401', {
      message:
        'Cursor API key ausente do Vault (CURSOR_API_KEY). '
        + 'Gere uma User API key em cursor.com/dashboard e cadastre em Settings > Providers.',
      raw: `vaultKey=${CURSOR_VAULT_KEY}`,
    });
  }

  const isOnboarding = opts.isOnboarding ?? false;
  const workspace = resolveCursorChatWorkspace(opts.lane, opts.sessionId);
  const lionHome = getLionClawHome();

  const repoRoot = opts.lane === 'desktop'
    ? (() => {
        const attachment = getSessionActiveRepository(opts.sessionId);
        return attachment
          ? getLocalRepository(attachment.repositoryId)?.canonicalRootPath
          : undefined;
      })()
    : undefined;

  const lionPrompt = buildSystemPrompt(opts.agentId, {
    isOnboarding,
    model: opts.model,
    chatSurface: 'cursor-sdk',
    capabilities: opts.capabilities,
  });
  const generated = isOnboarding ? '' : loadGeneratedAgentContext();
  const runtimeBlock = [
    '## Runtime atual',
    '',
    `Cursor (@cursor/sdk) via assinatura; modelo ${opts.model}.`,
    'O custo em dolar exibido e equivalente-API estimado; a cobranca real e o plano Cursor.',
    'Operacoes de arquivo usam as tools lion_* host-controladas do LionClaw. '
      + 'Esta surface NAO tem shell: execucao de comandos e delegada a subagents, '
      + 'pipelines ou workflows.',
  ].join('\n');
  const workspaceBlock = repoRoot
    ? [
        '## Workspace conectado',
        '',
        `O usuario conectou o repositorio local desta conversa: ${repoRoot}`,
        'Perguntas sobre "este repositorio/workspace/projeto" referem-se a ESSE caminho, '
          + 'nao ao ~/.lionclaw (que e a memoria do LionClaw).',
        'Para ler/buscar arquivos dele use as tools lion_* com CAMINHOS ABSOLUTOS '
          + '(o cwd da sessao nao e o repositorio).',
      ].join('\n')
    : '';
  const baseSystemPrompt = appendRepoGraphSection(
    [generated, lionPrompt, runtimeBlock, workspaceBlock].filter(Boolean).join('\n\n'),
  );

  const permission = PERM_DEFAULT_WITH_GUARD(
    createPermissionGuard(opts.getWindow, { isOnboarding }),
  );
  const baseGuard = permission.canUseTool;
  permission.canUseTool = async (toolName, input, context) => {
    if (cursorChatInputTouchesRules(workspace, input)) {
      return {
        behavior: 'deny',
        message: 'Fonte de instrucao do LionClaw (rules da sessao Cursor) e protegida.',
      };
    }
    if (cursorChatInputTouchesWorkspacesRoot(input)) {
      return {
        behavior: 'deny',
        message:
          'Workspaces de sessao Cursor (runtime/cursor-chat-workspaces) sao fonte de '
          + 'instrucao protegida de TODAS as sessoes; nenhuma escrita/leitura via tools ali.',
      };
    }
    return baseGuard
      ? baseGuard(toolName, input, context)
      : { behavior: 'deny', message: 'Tool sem guard efetivo.' };
  };

  const { getMCPConfigForAgent } = await import('../mcp-manager');
  const parentMcpConfig = opts.lane === 'desktop'
    ? await getMCPConfigForAgent(opts.agentId, {
        surface: 'cursor-sdk',
        capabilities: opts.capabilities,
      })
    : undefined;
  const parentMcpServerIds = Object.keys(parentMcpConfig ?? {});
  const enabledTools = opts.lane === 'desktop' ? getEnabledTools() : [];
  const inheritedEffort = resolveChatInheritedEffort();
  const dispatchContext = createSubagentDispatchContext({
    ownerKind: 'chat',
    ownerId: opts.sessionId,
    sessionId: opts.sessionId,
    lane: opts.lane,
    surface: 'cursor-sdk',
    cwd: workspace.workspaceDir,
    readRoots: repoRoot ? [lionHome, repoRoot] : [lionHome],
    writeRoots: repoRoot ? [lionHome, repoRoot] : [lionHome],
    allowedTools: await resolveSubagentHostAllowedTools(enabledTools, parentMcpServerIds),
    allowedMcpServerIds: parentMcpServerIds,
    permission,
    parentAbortSignal: opts.abortController.signal,
    ...(inheritedEffort ? { inheritedEffort } : {}),
  });

  const bridge = await buildCursorSessionTools({
    profile: opts.lane === 'desktop' ? 'chat' : 'remote-chat',
    systemPrompt: baseSystemPrompt,
    scope: { sessionId: opts.sessionId, turnId: randomUUID() },
    ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    dispatchContext,
    allowUserQuestion: opts.lane === 'desktop',
    getWindow: opts.getWindow,
    abortSignal: opts.abortController.signal,
  });

  const guardedToolset = buildCursorGuardedToolset({
    cwd: lionHome,
    canUseTool: permission.canUseTool,
    includeShell: false,
    deniedRoots: [cursorChatWorkspacesRoot()],
    ...(repoRoot ? { extraRoots: [repoRoot] } : {}),
  });

  const declarations = [...guardedToolset.declarations, ...bridge.declarations];
  const dispatchTool = composeCursorToolDispatchers({
    ...guardedToolset.handlers,
    ...bridge.handlers,
  });

  const rulesContent = bridge.systemPrompt;
  materializeCursorChatRules(workspace, rulesContent);

  const sessionKey = buildCursorChatSessionKey(opts.lane, opts.sessionId);
  const storeDir = cursorSessionStoreDir(sessionKey);
  const prior = loadCursorSession(sessionKey);
  const resumeAgentId = prior?.cursorAgentId;

  const contextMeta: CursorSessionContextMeta = {
    systemPromptTokens: estimateTokensRough(rulesContent),
    toolSchemasTokens: declarations.length > 0
      ? estimateTokensRough(JSON.stringify(declarations))
      : 0,
  };

  return {
    resuming: resumeAgentId !== undefined,
    contextMeta,
    workspace,
    async send(prompt, onEvent) {
      const executionId = `cursor-chat-${randomUUID()}`;
      try {
        const result = await runCursorSidecarExecution({
          config: {
            executionId,
            model: opts.model,
            apiKey,
            cwd: workspace.workspaceDir,
            storeDir,
            prompt,
            settingSources: ['project'],
            guarded: true,
            allowedTools: [...CURSOR_GUARDED_NATIVE_ALLOWLIST],
            customTools: declarations,
            ...(resumeAgentId !== undefined ? { resumeAgentId } : {}),
          },
          abortController: opts.abortController,
          dispatchTool,
          onEvent,
        });
        const authError = pendingSubagentProviderAuthError(dispatchContext);
        if (authError) throw authError;
        if (result.agentId !== undefined && result.agentId.length > 0) {
          saveCursorSession(sessionKey, {
            cursorAgentId: result.agentId,
            model: opts.model,
            updatedAt: new Date().toISOString(),
          });
        }
        return result;
      } catch (error) {
        throw pendingSubagentProviderAuthError(dispatchContext) ?? error;
      }
    },
    close() {
      logger.debug({ sessionId: opts.sessionId, lane: opts.lane }, 'cursor chat session closed');
    },
  };
}
