
import type { AgentConfig } from '../../../src/types';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  RuntimeExecutor,
} from '../agent-runtime/types';
import { PERM_DEFAULT_NO_BYPASS } from '../agent-runtime/permission-profiles';
import { createWatchdog, WATCHDOG_TIMEOUT_MS } from '../agent-runtime/watchdog';
import { cloudExecutor } from '../agent-runtime/cloud-executor';
import { zaiExecutor } from '../agent-runtime/zai-executor';
import { minimaxTokenplanExecutor } from '../agent-runtime/minimax-tokenplan-executor';
import { codexExecutor } from '../agent-runtime/codex-executor';
import { localExecutor } from '../agent-runtime/local-executor';
import { externalExecutor } from '../agent-runtime/external-executor';
import { kimiExecutor } from '../agent-runtime/kimi-executor';
import { grokExecutor } from '../agent-runtime/grok-executor';
import { getAgent as realGetAgent } from '../db';
import { DYNAMIC_WORKFLOW_MAESTRO_ID } from '../seed-agents/dynamic-workflow-builder';
import { createLogger } from '../logger';

const logger = createLogger('dynamic-workflow-narrator-executor');

export interface NarratorExecutorDeps {
  getAgent?: (id: string) => AgentConfig | undefined;
  runtimeExecutors?: Partial<Record<AgentConfig['runtime'], RuntimeExecutor>>;
}

export interface ExecuteNarratorInput {
  prompt: string;
  cwd: string;
  abortController?: AbortController;
  onText?: (chunk: string) => void;
  onThinking?: (chunk: string) => void;
  onToolUse?: (tool: string) => void;
  onToolUseComplete?: (tool: string, input: unknown) => void;
  onStalled?: (info: { lastChunkAt: number; secondsSinceLastChunk: number }) => void;
  narratorAgentId?: string;
}

const REAL_RUNTIME_EXECUTORS: Record<AgentConfig['runtime'], RuntimeExecutor> = {
  cloud: cloudExecutor,
  zai: zaiExecutor,
  'minimax-tp': minimaxTokenplanExecutor,
  codex: codexExecutor,
  local: localExecutor,
  external: externalExecutor,
  kimi: kimiExecutor,
  grok: grokExecutor,
  cursor: {
    run: async () => {
      throw new Error('Runtime cursor ainda sem executor (SPEC cursor-runtime F1 item 2 pendente).');
    },
  },
};

export function buildNarratorQueryConfig(agent: AgentConfig): AgentQueryConfig {
  return {
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    allowedTools: [...agent.allowedTools],
    mcpServers: [],
    maxTurns: agent.maxTurns ?? undefined,
    effort: agent.effort,
    thinking: agent.thinking,
    thinkingBudget: agent.thinkingBudget ?? undefined,
    runtime: agent.runtime,
  };
}

export async function executeNarrator(
  input: ExecuteNarratorInput,
  deps: NarratorExecutorDeps = {},
): Promise<AgentExecutionResult> {
  const getAgent = deps.getAgent ?? realGetAgent;
  const runtimeExecutors = deps.runtimeExecutors ?? REAL_RUNTIME_EXECUTORS;

  const agentId = input.narratorAgentId ?? DYNAMIC_WORKFLOW_MAESTRO_ID;

  const agent = getAgent(agentId);
  if (!agent) {
    throw new Error(`Narrador seed nao encontrado: ${agentId}`);
  }

  if (agent.model.trim().length === 0) {
    throw new Error(
      `Narrador seed "${agentId}" sem model resolvido (estado corrompido). ` +
        'Defina o modelo do agente em SubAgents; nenhum modelo default e assumido ' +
        '(SPEC orquestrador-fonte-unica 4.5 / AC-19).',
    );
  }

  const config = buildNarratorQueryConfig(agent);

  const executor = runtimeExecutors[config.runtime];
  if (!executor) {
    throw new Error(
      `Runtime do narrador sem executor: ${String(config.runtime)} (agent ${agentId})`,
    );
  }

  const abortController = input.abortController ?? new AbortController();

  const watchdog = createWatchdog(WATCHDOG_TIMEOUT_MS, (info) => {
    logger.warn(
      { agentId, runtime: config.runtime, ...info },
      'Narrador stalled: sem progresso por 3min',
    );
    input.onStalled?.(info);
  });

  const req: AgentExecutionRequest = {
    agentId,
    prompt: input.prompt,
    cwd: input.cwd,
    abortController,
    permission: PERM_DEFAULT_NO_BYPASS,
    onText: watchdog.wrapOnText(input.onText),
    onThinking: watchdog.wrapOnThinking(input.onThinking),
    onToolUse: watchdog.wrapOnToolUse(input.onToolUse),
    onToolUseComplete: watchdog.wrapOnToolUseComplete(input.onToolUseComplete),
  };

  try {
    return await executor.run(req, config);
  } finally {
    watchdog.stop();
  }
}
