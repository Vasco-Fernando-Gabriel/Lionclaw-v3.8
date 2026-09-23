import { z } from 'zod';
import { randomUUID } from 'crypto';
import { finalizeTaskExecutionOnce, finalizeTaskExecutionRootIfIdle, getAgent, startTaskExecution } from './db';
import { executeAgent } from './agent-runtime/execute';
import { PERM_BYPASS_NO_GUARD } from './agent-runtime/permission-profiles';
import {
  isSubagentProviderAuthError,
  pendingSubagentProviderAuthError,
  propagateSubagentProviderAuthError,
  reserveSubagentInvocation,
  type SubagentDispatchResult,
} from './agent-runtime/subagent-dispatch';
import type { SubagentDispatchContext } from './agent-runtime/types';
import { createCodexDriver } from './codex-runtime/factory';
import { createLogger } from './logger';
import { prefetchRepoGraphTurnContext } from './repo-graph/minimal-context';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

const logger = createLogger('codex-agents-mcp');

export async function getCodexAgentsServer(
  dispatchContext: SubagentDispatchContext,
): Promise<McpSdkServerConfigWithInstance> {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');

  return createSdkMcpServer({
    name: 'codex-agents',
    version: '1.0.0',
    tools: [
      tool(
        'run_codex_agent',
        'Executa um agente Codex (OpenAI via OAuth) com tool use nativo. Use para delegar tarefas a agentes com runtime=codex. Suporta multi-turn dentro da mesma chamada via threadId interno.',
        {
          agentId: z.string().describe('ID do agente codex (ex: "coder-codex")'),
          prompt: z.string().describe('A tarefa ou pergunta para o agente'),
          context: z
            .string()
            .optional()
            .describe('Contexto adicional: dados de arquivos lidos, resultados de buscas, etc.'),
        },
        async ({ agentId, prompt, context }, extra) => {
          try {
            const agent = getAgent(agentId);
            if (!agent) {
              return {
                content: [{ type: 'text' as const, text: `Erro: agente "${agentId}" nao encontrado` }],
                isError: true,
              };
            }
            if (agent.runtime !== 'codex') {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Erro: agente "${agentId}" agora usa runtime=${agent.runtime}. Use a rota canônica lionclaw-agents.call_agent; ela resolve o runtime atual automaticamente.`,
                  },
                ],
                isError: true,
              };
            }
            if (!agent.codexConfig) {
              return {
                content: [
                  { type: 'text' as const, text: `Erro: agente "${agentId}" tem runtime=codex mas sem codexConfig` },
                ],
                isError: true,
              };
            }

            const prefetched =
              dispatchContext.lane === 'desktop' && dispatchContext.sessionId
                ? await prefetchRepoGraphTurnContext(prompt, { sessionId: dispatchContext.sessionId })
                : null;
            const hostContext =
              [prefetched?.renderedMarkdown, context].filter((value): value is string => Boolean(value)).join('\n\n') ||
              undefined;
            const transportCorrelation = mcpRequestCorrelation(extra);
            const result = await executeDedicatedCodexAgent(
              {
                agentId,
                prompt,
                ...(hostContext ? { context: hostContext } : {}),
                ...(transportCorrelation ? { transportCorrelation } : {}),
              },
              dispatchContext,
            );
            if (!result.ok) {
              const metadata = buildMetadata(result);
              return {
                content: [
                  { type: 'text' as const, text: `Erro: ${result.error ?? 'falha desconhecida'}` },
                  { type: 'text' as const, text: `\n---\n[codex-agent-metadata]: ${JSON.stringify(metadata)}` },
                ],
                isError: true,
              };
            }

            const metadata = buildMetadata(result);
            return {
              content: [
                { type: 'text' as const, text: result.output ?? '' },
                { type: 'text' as const, text: `\n---\n[codex-agent-metadata]: ${JSON.stringify(metadata)}` },
              ],
            };
          } catch (err) {
            if (isSubagentProviderAuthError(err)) throw err;
            const msg = err instanceof Error ? err.message : String(err);
            logger.error({ agentId, error: msg }, 'run_codex_agent failed');
            return {
              content: [{ type: 'text' as const, text: `Erro ao executar agente codex "${agentId}": ${msg}` }],
              isError: true,
            };
          }
        },
      ),
      tool(
        'codex_agents_health',
        'Verifica status do binario codex e auth OAuth. Retorna installed, version, authenticated, implementation.',
        {},
        async () => {
          const availability = await createCodexDriver().isAvailable();
          const status = {
            installed: availability.installed,
            version: availability.version ?? null,
            authenticated: availability.authenticated,
            appServerSupported: availability.appServerSupported,
            error: availability.error,
            implementation: availability.implementation,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(status) }] };
        },
      ),
    ],
  });
}

async function executeDedicatedCodexAgent(
  input: {
    agentId: string;
    prompt: string;
    context?: string;
    transportCorrelation?: { kind: 'mcp-request-id'; value: string };
  },
  host: SubagentDispatchContext,
): Promise<SubagentDispatchResult> {
  const executionId = randomUUID();
  const reservationError = reserveSubagentInvocation(host, input.agentId);
  if (reservationError) return { ok: false, executionId, error: reservationError };

  const agent = getAgent(input.agentId);
  if (!agent || agent.runtime !== 'codex') {
    return { ok: false, executionId, error: `Agente Codex indisponivel: ${input.agentId}` };
  }

  const startedAt = Date.now();
  const childAbortController = new AbortController();
  const abortChild = (): void => childAbortController.abort(host.parentAbortSignal.reason);
  const childContext: SubagentDispatchContext = {
    ...host,
    parentAbortSignal: childAbortController.signal,
    parentExecutionId: executionId,
    depth: host.depth + 1,
    remainingBudget: host.budgetState.remaining,
    budgetState: host.budgetState,
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
    toolUseId: null,
    agentId: agent.id,
    agentName: agent.name,
    model: agent.model,
    description: input.prompt.slice(0, 500),
    runtime: 'codex',
    provider: 'openai-codex',
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
      permission: PERM_BYPASS_NO_GUARD,
      ...(host.workspace.projectId ? { projectId: host.workspace.projectId } : {}),
      ...(host.inheritedEffort ? { inheritedEffort: host.inheritedEffort } : {}),
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
      return toDispatchResult(executionId, result, false, result.error.userMessage);
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
    return toDispatchResult(executionId, result, true);
  } catch (error) {
    const controlError = pendingSubagentProviderAuthError(childContext) ?? error;
    const message = controlError instanceof Error ? controlError.message : String(controlError);
    finalizeTaskExecutionOnce(executionId, {
      status: childAbortController.signal.aborted ? 'cancelled' : 'failed',
      summary: message.slice(0, 1000),
      model: agent.model,
      runtime: 'codex',
      provider: 'openai-codex',
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
    if (propagateSubagentProviderAuthError(controlError, host)) throw controlError;
    logger.error({ error: controlError, agentId: input.agentId, executionId }, 'Dedicated Codex agent failed');
    return { ok: false, executionId, error: message };
  } finally {
    host.parentAbortSignal.removeEventListener('abort', abortChild);
    finalizeTaskExecutionRootIfIdle(host.rootExecutionId);
  }
}

function mcpRequestCorrelation(extra: unknown): { kind: 'mcp-request-id'; value: string } | undefined {
  if (!extra || typeof extra !== 'object' || !('requestId' in extra)) return undefined;
  const requestId = (extra as { requestId?: unknown }).requestId;
  if (typeof requestId !== 'string' && typeof requestId !== 'number') return undefined;
  return { kind: 'mcp-request-id', value: String(requestId) };
}

function toDispatchResult(
  executionId: string,
  result: Awaited<ReturnType<typeof executeAgent>>,
  ok: boolean,
  error?: string,
): SubagentDispatchResult {
  return {
    ok,
    executionId,
    ...(ok ? { output: result.output } : { error }),
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

function buildMetadata(result: SubagentDispatchResult): Record<string, unknown> {
  return {
    executionId: result.executionId,
    status: result.ok ? 'completed' : 'failed',
  };
}
