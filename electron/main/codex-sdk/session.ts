import type { CodexSession } from '../codex-runtime/types';
import { resolveCodexSessionForRun } from '../agent-runtime/codex-session-factory';
import { resolveChatCodexMcpComposition, type ChatCodexMcpComposition } from '../codex-chat-spawn-extras';
import { estimateTokensRough } from '../agent-runtime/context-measure';
import { serializeMcpSchemasForContext } from '../agent-runtime/tool-schemas';
import { getAllMCPServers, getPermissionBypass, getSetting } from '../db';
import { readCodexTurnSettleMs } from '../codex-runtime/turn-barrier';
import { getAgentCwd } from '../paths';
import { buildSystemPrompt, loadGeneratedAgentContext } from '../prompt-builder';
import { appendRepoGraphSection } from '../prompt-builder-repo-graph';
import { buildCodexSdkSystemPromptV6, buildCodexMcpCatalogPrompt, type CodexMcpIndexNaming } from './prompt';
import {
  CODEX_GATEWAY_SERVER_ID,
  CODEX_GATEWAY_INVOKE_TOOL_NAME,
  CODEX_GATEWAY_SCHEMA_TOOL_NAME,
} from '../mcp-display';
import { getChatCapabilityForServer } from '../chat-capability-gate';
import { isChatTurnScopedMcpHelper, isDirectMcpHelper } from '../mcp-risk-patterns';
import type { ChatFeatureToggles, CodexChatReasoningEffort } from '../../../src/types';

export interface CreateChatCodexSessionOptions {
  swarmReadOnly?: boolean;
  sessionId: string;
  model: string;
  agentId?: string;
  isOnboarding?: boolean;
  cwdOverride?: string;
  capabilities?: ChatFeatureToggles;
  onContextMeta?: (meta: CodexChatContextMeta) => void;
  reasoningEffort?: CodexChatReasoningEffort;
  mcpComposition?: ChatCodexMcpComposition;
}

export interface CodexChatContextMeta {
  systemPromptTokens: number;
  mcpSchemasTokens: number;
}

export async function createChatCodexSession(opts: CreateChatCodexSessionOptions): Promise<CodexSession> {
  const cwd = opts.cwdOverride ?? getAgentCwd(opts.isOnboarding ?? false);
  const mcpComposition =
    opts.mcpComposition ??
    resolveChatCodexMcpComposition({
      agentId: opts.agentId,
      isOnboarding: opts.isOnboarding,
      sessionId: opts.sessionId,
    });
  const indexMode = mcpComposition.mode === 'index';
  const mcpIndexNaming: CodexMcpIndexNaming | undefined = indexMode
    ? {
        invokeToolName: CODEX_GATEWAY_INVOKE_TOOL_NAME,
        schemaToolName: CODEX_GATEWAY_SCHEMA_TOOL_NAME,
      }
    : undefined;
  const lionPrompt = buildSystemPrompt(opts.agentId, {
    isOnboarding: opts.isOnboarding ?? false,
    model: opts.model,
    chatSurface: 'codex-sdk',
    codexMcpMode: mcpComposition.mode,
    capabilities: opts.capabilities,
  });
  const mcpServers = getAllMCPServers().filter((s) => s.isActive);
  const catalogServers = (
    opts.capabilities
      ? mcpServers.filter((s) => {
          const gated = getChatCapabilityForServer(s.id);
          return gated === undefined || opts.capabilities?.[gated] !== false;
        })
      : mcpServers
  ).filter((s) => opts.capabilities !== undefined || !isChatTurnScopedMcpHelper(s.id));
  const catalogEntries = (indexMode ? catalogServers.filter((s) => isDirectMcpHelper(s.id)) : catalogServers).map(
    (s) => ({ id: s.id, description: s.description }),
  );
  if (indexMode) {
    catalogEntries.push({
      id: CODEX_GATEWAY_SERVER_ID,
      description: `LionClaw gateway meta-tools: ${CODEX_GATEWAY_INVOKE_TOOL_NAME}(server, tool, args) executes any tool from the MCP index above; ${CODEX_GATEWAY_SCHEMA_TOOL_NAME}(server, tool) returns its full contract`,
    });
  }
  const mcpCatalog = buildCodexMcpCatalogPrompt(catalogEntries);
  const agentContext = opts.isOnboarding ? '' : loadGeneratedAgentContext();
  const systemPrompt = opts.isOnboarding
    ? lionPrompt
    : appendRepoGraphSection(
        [buildCodexSdkSystemPromptV6(opts.capabilities, mcpIndexNaming), agentContext, lionPrompt, mcpCatalog]
          .filter(Boolean)
          .join('\n\n'),
        opts.sessionId,
        'codex',
      );

  if (opts.onContextMeta) {
    try {
      const { getMcpToolRegistryEntries } = await import('../mcp-manager');
      const activeIds = new Set(
        (indexMode ? mcpServers.filter((s) => isDirectMcpHelper(s.id)) : mcpServers).map((s) => s.id),
      );
      const registryRows = getMcpToolRegistryEntries().filter((r) => activeIds.has(r.mcpId));
      const mcpJson = serializeMcpSchemasForContext(registryRows, indexMode ? { includeGatewayMeta: true } : undefined);
      opts.onContextMeta({
        systemPromptTokens: estimateTokensRough(systemPrompt),
        mcpSchemasTokens: mcpJson ? estimateTokensRough(mcpJson) : 0,
      });
    } catch {}
  }

  const reasoningEffort: CodexChatReasoningEffort = opts.reasoningEffort ?? 'high';
  return resolveCodexSessionForRun({
    surface: 'chat',
    mcpProfile: opts.swarmReadOnly ? 'one-shot' : 'chat',
    disableGlobalMcp: opts.swarmReadOnly,
    reasoningEffortOverride: reasoningEffort,
    extraArgs: !opts.swarmReadOnly && mcpComposition.extraArgs.length > 0 ? mcpComposition.extraArgs : undefined,
    sessionOptions: {
      cwd,
      model: opts.model,
      systemPrompt,
      approvalPolicy: 'never',
      sandbox:
        opts.isOnboarding || opts.swarmReadOnly
          ? 'read-only'
          : getPermissionBypass()
            ? 'danger-full-access'
            : 'workspace-write',
      reasoningEffort,
      turnSettleMs: readCodexTurnSettleMs(getSetting),
      ownerKind: 'chat',
      ownerId: opts.sessionId,
    },
  });
}
