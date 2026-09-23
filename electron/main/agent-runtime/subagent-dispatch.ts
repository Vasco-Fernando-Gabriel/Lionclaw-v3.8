import { randomUUID } from 'crypto';
import {
  finalizeTaskExecutionOnce,
  finalizeTaskExecutionRootIfIdle,
  getAgent,
  insertAuditEntry,
  startTaskExecution,
} from '../db';
import { resolveAgentQueryConfig } from '../agent-config-resolver';
import { CodexAuthError } from '../codex-runtime/errors';
import { createLogger } from '../logger';
import { executeAgent } from './execute';
import { GrokAuthError } from './grok-availability';
import { KimiAuthError } from './kimi-availability';
import type { AgentExecutionResult, AgentPermissionProfile, SubagentDispatchContext } from './types';
import type { AgentQueryConfig } from '../agent-config-resolver';

const logger = createLogger('subagent-dispatch');

export const MAX_SUBAGENT_DEPTH = 4;
export const DEFAULT_SUBAGENT_BUDGET = 16;
export const SUBAGENT_AUTH_REQUIRED_CODE = 'SUBAGENT_AUTH_REQUIRED';
export type SubagentAuthProvider = 'codex' | 'grok' | 'kimi';

export interface LionSubagentInput {
  agentId: string;
  prompt: string;
  context?: string;
  toolUseId?: string;
  transportCorrelation?: {
    kind: 'mcp-request-id' | 'local-ipc-request-id';
    value: string;
  };
}

export interface SubagentDispatchResult {
  ok: boolean;
  executionId: string;
  output?: string;
  error?: string;
  model?: string;
  runtime?: AgentExecutionResult['runtime'];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    apiRequests: number;
    toolUses: number;
    durationMs: number;
  };
  costUsd?: number;
}

export function createSubagentDispatchContext(input: {
  ownerKind: SubagentDispatchContext['ownerKind'];
  ownerId: string;
  sessionId?: string;
  lane: SubagentDispatchContext['lane'];
  surface: string;
  cwd: string;
  projectId?: string;
  readRoots?: string[];
  writeRoots?: string[];
  permission: SubagentDispatchContext['permission'];
  parentAbortSignal: AbortSignal;
  inheritedEffort?: SubagentDispatchContext['inheritedEffort'];
  budget?: number;
  allowedTools?: readonly string[];
  allowedMcpServerIds?: readonly string[];
  abortOwner?: (reason: Error) => void;
}): SubagentDispatchContext {
  if (input.ownerKind === 'chat' && !input.sessionId) {
    throw new Error('Subagent dispatch de chat exige sessionId do host.');
  }
  const rootExecutionId = randomUUID();
  const budgetState = { remaining: input.budget ?? DEFAULT_SUBAGENT_BUDGET };
  const capabilityCeiling = Object.freeze({
    allowedTools: Object.freeze([...(input.allowedTools ?? [])]),
    allowedMcpServerIds: Object.freeze([...(input.allowedMcpServerIds ?? [])]),
  });
  return {
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    lane: input.lane,
    surface: input.surface,
    workspace: {
      cwd: input.cwd,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      readRoots: input.readRoots ?? [input.cwd],
      writeRoots: input.writeRoots ?? [],
    },
    permission: input.permission,
    parentAbortSignal: input.parentAbortSignal,
    rootExecutionId,
    parentExecutionId: rootExecutionId,
    depth: 0,
    remainingBudget: budgetState.remaining,
    budgetState,
    controlState: {},
    ...(input.abortOwner ? { abortOwner: input.abortOwner } : {}),
    capabilityCeiling,
    ...(input.inheritedEffort ? { inheritedEffort: input.inheritedEffort } : {}),
  };
}

export function pendingSubagentProviderAuthError(
  context: SubagentDispatchContext | undefined,
  parentAbortSignal?: AbortSignal,
): Error | undefined {
  const contextError = context?.controlState?.providerAuthError;
  if (contextError) return contextError;
  return isSubagentProviderAuthError(parentAbortSignal?.reason) ? parentAbortSignal.reason : undefined;
}

function controlStateFor(context: SubagentDispatchContext): NonNullable<SubagentDispatchContext['controlState']> {
  return (context.controlState ??= {});
}

export function isSubagentProviderAuthError(error: unknown): error is CodexAuthError | GrokAuthError | KimiAuthError {
  return error instanceof CodexAuthError || error instanceof GrokAuthError || error instanceof KimiAuthError;
}

export function propagateSubagentProviderAuthError(
  error: unknown,
  host: SubagentDispatchContext,
): error is CodexAuthError | GrokAuthError | KimiAuthError {
  if (!isSubagentProviderAuthError(error)) return false;
  controlStateFor(host).providerAuthError ??= error;
  host.abortOwner?.(error);
  return true;
}

export function subagentAuthProvider(error: CodexAuthError | GrokAuthError | KimiAuthError): SubagentAuthProvider {
  if (error instanceof CodexAuthError) return 'codex';
  if (error instanceof GrokAuthError) return 'grok';
  return 'kimi';
}

export function subagentAuthFailure(error: CodexAuthError | GrokAuthError | KimiAuthError): {
  code: typeof SUBAGENT_AUTH_REQUIRED_CODE;
  authProvider: SubagentAuthProvider;
  error: string;
} {
  return {
    code: SUBAGENT_AUTH_REQUIRED_CODE,
    authProvider: subagentAuthProvider(error),
    error: error.message,
  };
}

function recordPolicyRefusal(
  host: SubagentDispatchContext,
  agentId: string,
  code: 'max-depth' | 'budget-exhausted',
  reason: string,
): void {
  insertAuditEntry({
    ...(host.sessionId ? { sessionId: host.sessionId } : {}),
    ...(agentId ? { subagent: agentId } : {}),
    source: host.ownerKind,
    eventType: 'tool_blocked',
    toolName: 'system:subagent-dispatch',
    input: JSON.stringify({
      code,
      ownerKind: host.ownerKind,
      ownerId: host.ownerId,
      rootExecutionId: host.rootExecutionId,
      depth: host.depth,
      remainingBudget: host.budgetState.remaining,
      surface: host.surface,
    }),
    output: reason,
    approved: false,
  });
}

function providerForRuntime(runtime: AgentExecutionResult['runtime']): string {
  switch (runtime) {
    case 'cloud':
      return 'anthropic';
    case 'codex':
      return 'openai-codex';
    case 'zai':
      return 'zai';
    case 'minimax-tp':
      return 'minimax';
    case 'kimi':
      return 'kimi';
    case 'grok':
      return 'grok';
    case 'cursor':
      return 'cursor';
    case 'local':
      return 'local';
    case 'external':
      return 'external';
  }
}

function providerForAgent(agent: NonNullable<ReturnType<typeof getAgent>>): string {
  if (agent.runtime === 'local') return agent.localConfig?.provider || 'ollama';
  if (agent.runtime === 'external') return agent.externalConfig?.provider || 'unknown';
  return providerForRuntime(agent.runtime);
}

function validateHostContext(host: SubagentDispatchContext, agentId: string): string | null {
  if (!host.ownerId || !host.rootExecutionId || !host.parentExecutionId) {
    return 'Subagent dispatch sem owner/ancestry definidos pelo host.';
  }
  if (host.ownerKind === 'chat' && !host.sessionId) {
    return 'Subagent dispatch de chat sem sessionId do host.';
  }
  if (!host.workspace.cwd) {
    return 'Subagent dispatch sem workspace autorizado.';
  }
  if (host.depth >= MAX_SUBAGENT_DEPTH) {
    const reason = `Profundidade maxima de subagentes excedida (${MAX_SUBAGENT_DEPTH}).`;
    recordPolicyRefusal(host, agentId, 'max-depth', reason);
    return reason;
  }
  host.budgetState.remaining = Math.min(host.budgetState.remaining, host.remainingBudget);
  host.remainingBudget = host.budgetState.remaining;
  if (host.budgetState.remaining <= 0) {
    const reason = 'Budget de invocacoes de subagentes esgotado.';
    recordPolicyRefusal(host, agentId, 'budget-exhausted', reason);
    return reason;
  }
  if (host.parentAbortSignal.aborted) return 'Execucao pai cancelada.';
  return null;
}

function eligibilityError(agent: NonNullable<ReturnType<typeof getAgent>>): string | null {
  if (agent.squad === 'swarm') return 'Membros Swarm executam somente pelo runner swarm_start.';
  if (!agent.isActive) return `Agente desativado: ${agent.id}`;
  return null;
}

export function createSubagentConfinedPermission(host: SubagentDispatchContext): AgentPermissionProfile {
  return { ...host.permission };
}

function mcpServerIdForTool(tool: string): string | null {
  if (!tool.startsWith('mcp__')) return null;
  const rest = tool.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  return separator > 0 ? rest.slice(0, separator) : null;
}

export function mergeSubagentHostAllowedTools(
  allowedTools: readonly string[],
  materializedMcpTools: readonly string[],
): string[] {
  return [...new Set([...allowedTools, ...materializedMcpTools.filter((tool) => mcpServerIdForTool(tool) !== null)])];
}

export async function resolveSubagentHostAllowedTools(
  allowedTools: readonly string[],
  allowedMcpServerIds: readonly string[],
): Promise<string[]> {
  if (allowedMcpServerIds.length === 0) return [...new Set(allowedTools)];
  try {
    const { getMCPToolsFromRegistry } = await import('../mcp-manager');
    return mergeSubagentHostAllowedTools(allowedTools, getMCPToolsFromRegistry([...new Set(allowedMcpServerIds)]));
  } catch (error) {
    logger.warn({ error }, 'Falha ao cunhar grants MCP exatos do host; mantendo somente tools ja autorizadas');
    return [...new Set(allowedTools)];
  }
}

export function withResolvedRootSubagentGrants(
  context: SubagentDispatchContext | undefined,
  config: AgentQueryConfig,
): SubagentDispatchContext | undefined {
  if (!context || context.depth !== 0) return context;
  const allowedTools = [...(config.allowedTools ?? [])];
  const allowedMcpServerIds = [
    ...new Set([
      ...(config.mcpServers ?? []).flatMap((server) => Object.keys(server)),
      ...allowedTools.map(mcpServerIdForTool).filter((id): id is string => id !== null),
    ]),
  ];
  return {
    ...context,
    capabilityCeiling: Object.freeze({
      ...context.capabilityCeiling,
      allowedTools: Object.freeze(allowedTools),
      allowedMcpServerIds: Object.freeze(allowedMcpServerIds),
    }),
  };
}

export function applySubagentCapabilityCeiling(
  config: AgentQueryConfig,
  _host: SubagentDispatchContext,
): { config?: AgentQueryConfig; error?: string } {
  return { config };
}

export async function resolveSubagentConfigWithinCeiling(
  agentId: string,
  host: SubagentDispatchContext,
): Promise<{ config?: AgentQueryConfig; error?: string }> {
  const agent = getAgent(agentId);
  if (!agent) return { error: `Agente desconhecido: ${agentId}` };
  if (agent.squad === 'swarm') return { error: 'Membros Swarm executam somente pelo runner swarm_start.' };
  const denied = eligibilityError(agent);
  if (denied) return { error: denied };
  const config = await resolveAgentQueryConfig(agentId);
  return applySubagentCapabilityCeiling(config, host);
}

export function reserveSubagentInvocation(host: SubagentDispatchContext, agentId: string): string | null {
  controlStateFor(host);
  const contextError = validateHostContext(host, agentId);
  if (contextError) return contextError;
  const agent = getAgent(agentId);
  if (!agent) return `Agente desconhecido: ${agentId}`;
  if (agent.squad === 'swarm') return 'Membros Swarm executam somente pelo runner swarm_start.';
  const denied = eligibilityError(agent);
  if (denied) return denied;
  host.budgetState.remaining -= 1;
  host.remainingBudget = host.budgetState.remaining;
  return null;
}

export async function dispatchLionSubagent(
  input: LionSubagentInput,
  host: SubagentDispatchContext,
): Promise<SubagentDispatchResult> {
  controlStateFor(host);
  const executionId = randomUUID();
  if (!input.agentId?.trim() || !input.prompt?.trim()) {
    return { ok: false, executionId, error: 'agentId e prompt sao obrigatorios.' };
  }

  const reservationError = reserveSubagentInvocation(host, input.agentId);
  if (reservationError) return { ok: false, executionId, error: reservationError };
  const agent = getAgent(input.agentId)!;

  const startedAt = Date.now();
  let resolvedConfig: AgentQueryConfig;
  try {
    const resolved = await resolveSubagentConfigWithinCeiling(input.agentId, host);
    if (!resolved.config) {
      return { ok: false, executionId, error: resolved.error ?? 'Configuracao invalida do subagente.' };
    }
    resolvedConfig = resolved.config;
  } catch (error) {
    return {
      ok: false,
      executionId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const childAbortController = new AbortController();
  const abortChild = (): void => childAbortController.abort(host.parentAbortSignal.reason);
  const confinedPermission = createSubagentConfinedPermission(host);

  const childContext: SubagentDispatchContext = {
    ...host,
    permission: confinedPermission,
    parentAbortSignal: childAbortController.signal,
    parentExecutionId: executionId,
    depth: host.depth + 1,
    remainingBudget: host.budgetState.remaining,
    budgetState: host.budgetState,
    capabilityCeiling: Object.freeze({
      ...host.capabilityCeiling,
      allowedTools: Object.freeze([...resolvedConfig.allowedTools]),
      allowedMcpServerIds: Object.freeze([
        ...new Set([
          ...resolvedConfig.mcpServers.flatMap((server) => Object.keys(server)),
          ...resolvedConfig.allowedTools.map(mcpServerIdForTool).filter((id): id is string => id !== null),
        ]),
      ]),
    }),
  };
  const fullPrompt = input.context ? `${input.context}\n\n${input.prompt}` : input.prompt;
  const transportMetadata = input.transportCorrelation ? { transportCorrelation: input.transportCorrelation } : {};

  startTaskExecution({
    executionId: host.rootExecutionId,
    rootExecutionId: host.rootExecutionId,
    parentExecutionId: null,
    executionKind: 'root',
    ownerKind: host.ownerKind,
    ownerId: host.ownerId,
    sessionId: host.sessionId ?? null,
    toolUseId: null,
    agentId: null,
    agentName: 'root',
    model: '',
    description: host.surface,
    runtime: null,
    provider: null,
    metadata: { lane: host.lane, surface: host.surface },
  });
  startTaskExecution({
    executionId,
    rootExecutionId: host.rootExecutionId,
    parentExecutionId: host.parentExecutionId,
    executionKind: 'subagent',
    ownerKind: host.ownerKind,
    ownerId: host.ownerId,
    sessionId: host.sessionId ?? null,
    toolUseId: input.toolUseId ?? null,
    agentId: agent.id,
    agentName: agent.name,
    model: agent.model,
    description: input.prompt.slice(0, 500),
    runtime: agent.runtime,
    provider: providerForAgent(agent),
    metadata: {
      lane: host.lane,
      surface: host.surface,
      depth: childContext.depth,
      ...transportMetadata,
    },
  });
  host.parentAbortSignal.addEventListener('abort', abortChild, { once: true });
  if (host.parentAbortSignal.aborted) abortChild();

  try {
    const result = await executeAgent({
      agentId: input.agentId,
      prompt: fullPrompt,
      cwd: host.workspace.cwd,
      abortController: childAbortController,
      permission: confinedPermission,
      ...(host.workspace.projectId ? { projectId: host.workspace.projectId } : {}),
      ...(host.inheritedEffort ? { inheritedEffort: host.inheritedEffort } : {}),
      allowedToolsOverride: resolvedConfig.allowedTools,
      resolvedConfigOverride: resolvedConfig,
      executionContext: childContext,
    });
    const nestedAuthError = pendingSubagentProviderAuthError(childContext);
    if (nestedAuthError) throw nestedAuthError;
    if (result.error) {
      finalizeTaskExecutionOnce(executionId, {
        status: 'failed',
        summary: result.error.userMessage.slice(0, 1000),
        model: result.model,
        runtime: result.runtime,
        provider: result.provider,
        inputTokens: result.metrics.inputTokens,
        outputTokens: result.metrics.outputTokens,
        cacheReadTokens: result.metrics.cacheReadTokens,
        cacheCreationTokens: result.metrics.cacheCreationTokens,
        costUsd: result.metrics.costUsd,
        apiRequests: result.metrics.apiRequests,
        toolUses: result.metrics.toolUses,
        durationMs: result.metrics.durationMs,
        costStatus: result.metrics.costStatus ?? 'known',
        tokenStatus: result.metrics.tokenStatus ?? 'reported',
        costUnknownReason: result.metrics.costUnknownReason ?? null,
        metadata: { ...transportMetadata, ...(result.metadata ?? {}), executionError: result.error },
      });
      return {
        ok: false,
        executionId,
        error: result.error.userMessage,
        model: result.model,
        runtime: result.runtime,
        usage: {
          inputTokens: result.metrics.inputTokens,
          outputTokens: result.metrics.outputTokens,
          cacheReadTokens: result.metrics.cacheReadTokens,
          cacheCreationTokens: result.metrics.cacheCreationTokens,
          apiRequests: result.metrics.apiRequests,
          toolUses: result.metrics.toolUses,
          durationMs: result.metrics.durationMs,
        },
        costUsd: result.metrics.costUsd,
      };
    }
    finalizeTaskExecutionOnce(executionId, {
      status: 'completed',
      summary: result.output.slice(0, 1000),
      model: result.model,
      runtime: result.runtime,
      provider: result.provider,
      inputTokens: result.metrics.inputTokens,
      outputTokens: result.metrics.outputTokens,
      cacheReadTokens: result.metrics.cacheReadTokens,
      cacheCreationTokens: result.metrics.cacheCreationTokens,
      costUsd: result.metrics.costUsd,
      apiRequests: result.metrics.apiRequests,
      toolUses: result.metrics.toolUses,
      durationMs: result.metrics.durationMs,
      costStatus: result.metrics.costStatus ?? 'known',
      tokenStatus: result.metrics.tokenStatus ?? 'reported',
      costUnknownReason: result.metrics.costUnknownReason ?? null,
      metadata: { ...transportMetadata, ...(result.metadata ?? {}) },
    });
    return {
      ok: true,
      executionId,
      output: result.output,
      model: result.model,
      runtime: result.runtime,
      usage: {
        inputTokens: result.metrics.inputTokens,
        outputTokens: result.metrics.outputTokens,
        cacheReadTokens: result.metrics.cacheReadTokens,
        cacheCreationTokens: result.metrics.cacheCreationTokens,
        apiRequests: result.metrics.apiRequests,
        toolUses: result.metrics.toolUses,
        durationMs: result.metrics.durationMs,
      },
      costUsd: result.metrics.costUsd,
    };
  } catch (error) {
    const controlError = pendingSubagentProviderAuthError(childContext) ?? error;
    const message = controlError instanceof Error ? controlError.message : String(controlError);
    const status = childAbortController.signal.aborted ? 'cancelled' : 'failed';
    finalizeTaskExecutionOnce(executionId, {
      status,
      summary: message.slice(0, 1000),
      model: agent.model,
      runtime: agent.runtime,
      provider: providerForAgent(agent),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      apiRequests: 0,
      toolUses: 0,
      durationMs: Date.now() - startedAt,
      costStatus: 'unknown',
      tokenStatus: 'not_reported',
      costUnknownReason: 'no-usage-reported',
      metadata: transportMetadata,
    });
    if (propagateSubagentProviderAuthError(controlError, host)) {
      throw controlError;
    }
    logger.error({ error: controlError, agentId: input.agentId, executionId }, 'Subagent execution failed');
    return { ok: false, executionId, error: message };
  } finally {
    host.parentAbortSignal.removeEventListener('abort', abortChild);
    finalizeTaskExecutionRootIfIdle(host.rootExecutionId);
  }
}
