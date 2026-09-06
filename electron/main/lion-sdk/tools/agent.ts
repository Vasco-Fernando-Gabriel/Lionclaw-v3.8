
import { getAgent } from '../../db';
import { executeAgent } from '../../agent-runtime';
import { PERM_BYPASS_NO_GUARD } from '../../agent-runtime/permission-profiles';
import { getAgentCwd } from '../../paths';
import { createLogger } from '../../logger';
import { resolveSubagentRepoRoot } from '../../repo-graph/validate-root';
import { prefetchRepoGraphTurnContext } from '../../repo-graph/minimal-context';
import { getRepoGraphTurnContext } from '../../repo-graph/turn-context';
import { resolveChatInheritedEffort } from '../../agent-runtime/chat-effort-inheritance';
import type { AgentExecutionResult } from '../../agent-runtime/types';
import type { SubagentDispatchContext } from '../../agent-runtime/types';
import {
  dispatchLionSubagent,
  isSubagentProviderAuthError,
  pendingSubagentProviderAuthError,
} from '../../agent-runtime/subagent-dispatch';

const logger = createLogger('lion-sdk-agent');

export const PIPELINE_INTERNAL_SQUADS = new Set<string>([
  'harness',
  'pipeline',
  'security',
  'feature',
  'enrich',
]);

export interface AgentInput {
  agent_id: string;
  task: string;
  context?: Record<string, unknown>;
  expected_output?: string;
  repoRoot?: string;
  sessionId?: string;
}

export interface AgentToolResult {
  ok: boolean;
  status?: 'completed' | 'failed';
  executionId?: string;
  summary?: string;
  output?: string;
  model?: string;
  error?: string;
}

export interface AgentToolDependencies {
  executor?: typeof executeAgent;
  getAgent?: typeof getAgent;
  resolveRepoRoot?: typeof resolveSubagentRepoRoot;
  prefetchContext?: typeof prefetchRepoGraphTurnContext;
  getTurnContext?: typeof getRepoGraphTurnContext;
  resolveInheritedEffort?: typeof resolveChatInheritedEffort;
  dispatchContext?: SubagentDispatchContext;
  toolUseId?: string;
  transportCorrelation?: {
    kind: 'mcp-request-id' | 'local-ipc-request-id';
    value: string;
  };
}

export async function lionAgentDispatch(
  input: AgentInput,
  deps: AgentToolDependencies = {},
): Promise<AgentToolResult> {
  if (!input || typeof input.agent_id !== 'string' || input.agent_id.length === 0) {
    return { ok: false, error: 'Agent: agent_id obrigatorio.' };
  }
  if (typeof input.task !== 'string' || input.task.length === 0) {
    return { ok: false, error: 'Agent: task obrigatoria.' };
  }

  const lookup = deps.getAgent ?? getAgent;
  const agent = lookup(input.agent_id);
  if (!agent) {
    return { ok: false, error: `Agent: agent_id desconhecido: ${input.agent_id}` };
  }
  if (!agent.isActive) {
    return { ok: false, error: `Agent: agente ${input.agent_id} esta desativado.` };
  }
  const squad = (agent.squad ?? '').trim().toLowerCase();
  if (squad && PIPELINE_INTERNAL_SQUADS.has(squad)) {
    return {
      ok: false,
      error: `Agent: o agente ${input.agent_id} pertence ao squad "${squad}" (pipeline-internal) e nao e elegivel para chat.`,
    };
  }

  let cwd = getAgentCwd(false);
  let repoRootValidated = false;
  if (input.repoRoot !== undefined) {
    const resolveRoot = deps.resolveRepoRoot ?? resolveSubagentRepoRoot;
    const resolved = await resolveRoot({
      repoRoot: input.repoRoot,
      sessionId: input.sessionId,
    });
    if ('error' in resolved) {
      return { ok: false, error: `Agent: ${resolved.error}` };
    }
    cwd = resolved.cwd;
    repoRootValidated = true;
  }

  const executor = deps.executor ?? executeAgent;
  const promptParts: string[] = [];
  promptParts.push(input.task);
  if (input.expected_output) {
    promptParts.push('', `Formato esperado de saida: ${input.expected_output}`);
  }
  if (input.context && Object.keys(input.context).length > 0) {
    promptParts.push('', 'Contexto adicional (JSON):');
    try {
      promptParts.push('```json', JSON.stringify(input.context, null, 2), '```');
    } catch {
      promptParts.push(String(input.context));
    }
  }

  const agentRuntime = agent.runtime ?? 'cloud';
  const runtimeSemMcp = agentRuntime === 'local' || agentRuntime === 'external';
  const turnCtx = (deps.getTurnContext ?? getRepoGraphTurnContext)();
  let repoBaseline: string | null = null;
  if (repoRootValidated || (runtimeSemMcp && turnCtx !== null)) {
    const prefetch = deps.prefetchContext ?? prefetchRepoGraphTurnContext;
    const prefetched = await prefetch(input.task);
    repoBaseline = prefetched?.renderedMarkdown ?? null;
  }

  const basePrompt = promptParts.join('\n');
  const prompt = repoBaseline ? `${repoBaseline}\n\n${basePrompt}` : basePrompt;

  const resolveEffort = deps.resolveInheritedEffort ?? resolveChatInheritedEffort;
  const inheritedEffort = resolveEffort();

  try {
    if (deps.dispatchContext) {
      const dispatched = await dispatchLionSubagent(
        {
          agentId: input.agent_id,
          prompt,
          ...(deps.toolUseId ? { toolUseId: deps.toolUseId } : {}),
          ...(deps.transportCorrelation ? { transportCorrelation: deps.transportCorrelation } : {}),
        },
        deps.dispatchContext,
      );
      if (!dispatched.ok) {
        return {
          ok: false,
          status: 'failed',
          executionId: dispatched.executionId,
          error: `Agent dispatch falhou: ${dispatched.error}`,
        };
      }
      return {
        ok: true,
        status: 'completed',
        executionId: dispatched.executionId,
        summary: `agent=${input.agent_id} status=completed execution=${dispatched.executionId}`,
        output: dispatched.output,
        model: dispatched.model,
      };
    }
    const result: AgentExecutionResult = await executor({
      agentId: input.agent_id,
      prompt,
      cwd,
      abortController: new AbortController(),
      permission: PERM_BYPASS_NO_GUARD,
      ...(inheritedEffort !== undefined ? { inheritedEffort } : {}),
    });

    return {
      ok: true,
      status: 'completed',
      summary: `agent=${input.agent_id} status=completed`,
      output: result.output,
      model: result.model,
    };
  } catch (e) {
    const controlledError = pendingSubagentProviderAuthError(deps.dispatchContext) ?? e;
    if (isSubagentProviderAuthError(controlledError)) throw controlledError;
    logger.error({ err: controlledError, agentId: input.agent_id }, 'Agent dispatch falhou');
    return {
      ok: false,
      status: 'failed',
      error: `Agent dispatch falhou: ${(controlledError as Error).message}`,
    };
  }
}
