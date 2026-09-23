import { createSwarmProcessOwner } from './swarm-process';
import { swarmSdkHooks } from './swarm-sdk-hooks';

import fs from 'fs';
import { createLogger } from '../logger';
import { processAgentStream } from '../stream-processor';
import { calculateCost, getPricingSnapshot } from '../pricing';
import { getSetting } from '../db';
import { getSecret } from '../secrets-vault';
import { getClaudeCompatPreset } from '../claude-compat-sdk/provider-presets';
import { getClaudeSdkProcessOptions, ensureNodeInPath } from '../pipeline-shared/sdk-bootstrap';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { RuntimeExecutor, AgentExecutionRequest, AgentExecutionResult } from './types';
import { SDK_DISALLOWED_TOOLS, toSdkToolNames } from './sdk-tool-names';
import { getContextWindow } from './model-context-windows';
import { isStrippedSubprocessEnvKey } from './subprocess-env';

const logger = createLogger('minimax-tp-executor');

type EnvMap = Record<string, string>;

const CONTEXT_WINDOW_ENV_KEYS: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'DISABLE_AUTO_COMPACT',
  'DISABLE_COMPACT',
]);

function appendMinimaxTpRuntimeContext(systemPrompt: string, model: string): string {
  const runtimeBlock = [
    '',
    '',
    '## Runtime Atual',
    '',
    '- Runtime: minimax-tp',
    '- Provider: MiniMax TokenPlan (Anthropic-compatible endpoint via subscription)',
    `- Modelo selecionado: ${model}`,
    '- Use esta informacao quando o usuario perguntar qual modelo ou runtime esta executando este agente.',
  ].join('\n');
  return `${systemPrompt || ''}${runtimeBlock}`;
}

export function buildMinimaxTpEnv(
  apiKey: string,
  model: string,
  baseUrl: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): EnvMap {
  const env: EnvMap = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (key === 'API_TIMEOUT_MS') continue;
    if (key.startsWith('ANTHROPIC_')) continue;
    if (CONTEXT_WINDOW_ENV_KEYS.has(key)) continue;
    if (isStrippedSubprocessEnvKey(key)) continue;
    env[key] = value;
  }

  const contextWindow = getContextWindow(model, 'minimax');

  return {
    ...env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    API_TIMEOUT_MS: '3000000',
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ...(contextWindow !== undefined ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow) } : {}),
  };
}

export async function resolveMinimaxTpApiKey(): Promise<string> {
  const vaultRef = getSetting('orchestrator_minimax_api_key_ref');
  if (!vaultRef || vaultRef.trim().length === 0) {
    throw new Error(
      'MiniMax TokenPlan nao esta conectado. Configure MiniMax em Settings > Provedores externos antes de usar subagents MiniMax TokenPlan.',
    );
  }

  const apiKey = await getSecret(vaultRef);
  if (!apiKey) {
    throw new Error(`Chave MiniMax foi removida do Vault (ref=${vaultRef}). Reconecte MiniMax em Provedores externos.`);
  }

  return apiKey;
}

export function buildMinimaxTpQueryOptions(
  req: AgentExecutionRequest,
  config: AgentQueryConfig,
  cliPath: string,
  childAbort: AbortController,
  apiKey: string,
): Record<string, unknown> {
  const preset = getClaudeCompatPreset('minimax');
  const mcpServersObj =
    config.mcpServers.length > 0 ? Object.fromEntries(config.mcpServers.flatMap((s) => Object.entries(s))) : undefined;

  return {
    env: buildMinimaxTpEnv(apiKey, config.model, preset.baseUrl),
    pathToClaudeCodeExecutable: cliPath,
    cwd: req.cwd,
    model: config.model,
    systemPrompt: appendMinimaxTpRuntimeContext(config.systemPrompt, config.model),
    allowedTools: req.executionAgent ? [] : toSdkToolNames(config.allowedTools),
    disallowedTools: [...SDK_DISALLOWED_TOOLS],
    ...(req.executionAgent
      ? { tools: toSdkToolNames(config.allowedTools), settingSources: [], hooks: swarmSdkHooks(req) }
      : {}),
    permissionMode: req.permission.mode,
    allowDangerouslySkipPermissions: req.permission.dangerouslySkipPermissions,
    ...(req.permission.canUseTool ? { canUseTool: req.permission.canUseTool } : {}),
    includePartialMessages: true,
    abortController: childAbort,
    ...(req.continueSession ? { continue: true as const } : {}),
    ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
    ...(config.effort !== undefined ? { effort: config.effort } : {}),
    ...(config.thinking === 'enabled'
      ? {
          thinking: {
            type: 'enabled' as const,
            ...(config.thinkingBudget !== undefined ? { budgetTokens: config.thinkingBudget } : {}),
          },
        }
      : config.thinking === 'disabled'
        ? { thinking: { type: 'disabled' as const } }
        : {}),
    ...(mcpServersObj ? { mcpServers: mcpServersObj } : {}),
    stderr: (text: string) => {
      logger.info({ agentId: req.agentId, stderr: text.substring(0, 500) }, 'MiniMax TP Agent stderr');
    },
  };
}

async function run(req: AgentExecutionRequest, config: AgentQueryConfig): Promise<AgentExecutionResult> {
  ensureNodeInPath();

  const apiKey = await resolveMinimaxTpApiKey();
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const processOptions = getClaudeSdkProcessOptions();
  const cliPath = processOptions.pathToClaudeCodeExecutable;

  if (!fs.existsSync(cliPath)) {
    throw new Error(`Claude Code engine not found at ${cliPath}. Run npm install.`);
  }

  const startedAt = Date.now();
  const childAbort = new AbortController();
  const onParentAbort = (): void => {
    if (!childAbort.signal.aborted) childAbort.abort();
  };
  if (req.abortController.signal.aborted) {
    childAbort.abort();
  } else {
    req.abortController.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const cleanupParentListener = (): void => {
    req.abortController.signal.removeEventListener('abort', onParentAbort);
  };

  logger.info({ agentId: req.agentId, model: config.model }, 'minimax-tp-executor: running agent');

  const swarmOwner = req.executionAgent ? createSwarmProcessOwner(req.swarmOwnerDirectory) : null;
  const q = (query as (opts: Record<string, unknown>) => unknown)({
    prompt: req.prompt,
    options: {
      ...buildMinimaxTpQueryOptions(req, config, cliPath, childAbort, apiKey),
      ...processOptions,
      ...(swarmOwner ? { spawnClaudeCodeProcess: swarmOwner.spawnProcess } : {}),
    },
  }) as AsyncIterable<Record<string, unknown>>;

  let output: string;
  let streamMetrics: Awaited<ReturnType<typeof processAgentStream>>['metrics'];
  let accumulatedText: string;
  let textBlocks: string[];
  let resultError: Awaited<ReturnType<typeof processAgentStream>>['resultError'];
  let sessionIds: Awaited<ReturnType<typeof processAgentStream>>['sessionIds'];

  try {
    const result = await processAgentStream(withRuntimeActivity(q, req.onActivity), {
      shouldAbort: () => childAbort.signal.aborted,
      onText: req.onText,
      onThinking: req.onThinking,
      onToolUse: req.onToolUse,
      onToolUseComplete: req.onToolUseComplete,
    });
    output = result.output;
    streamMetrics = result.metrics;
    accumulatedText = result.accumulatedText;
    textBlocks = result.textBlocks;
    sessionIds = result.sessionIds;
    resultError = result.resultError;
  } finally {
    cleanupParentListener();
    await swarmOwner?.closeConfirmed();
  }

  const durationMs = Date.now() - startedAt;

  const usageReported = streamMetrics.inputTokens > 0 || streamMetrics.outputTokens > 0;

  if (!usageReported && (output.length > 0 || accumulatedText.length > 0)) {
    logger.warn(
      { agentId: req.agentId, model: config.model },
      'minimax-tp: SDK returned text but zero tokens — marking usage as unreported',
    );
    return {
      output,
      metrics: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        toolUses: streamMetrics.toolUses,
        apiRequests: streamMetrics.apiRequests,
        costUsd: 0,
        durationMs,
        costStatus: 'unknown',
        tokenStatus: 'not_reported',
        costUnknownReason: 'no-usage-reported',
      },
      model: config.model,
      runtime: 'minimax-tp',
      provider: 'minimax',
      accumulatedText,
      textBlocks,
      metadata: {
        costEstimationKind: 'subscription-equivalent-payg',
        costSource: 'calculated',
        pricingSnapshot: getPricingSnapshot(config.model),
        ...(sessionIds !== undefined && sessionIds.length > 0 ? { sessionIds } : {}),
      },
    };
  }

  const costUsd = calculateCost(
    config.model,
    streamMetrics.inputTokens,
    streamMetrics.outputTokens,
    streamMetrics.cacheReadTokens,
    streamMetrics.cacheCreationTokens,
  );

  return {
    output,
    metrics: {
      inputTokens: streamMetrics.inputTokens,
      outputTokens: streamMetrics.outputTokens,
      cacheReadTokens: streamMetrics.cacheReadTokens,
      cacheCreationTokens: streamMetrics.cacheCreationTokens,
      toolUses: streamMetrics.toolUses,
      apiRequests: streamMetrics.apiRequests,
      costUsd,
      durationMs,
    },
    model: config.model,
    runtime: 'minimax-tp',
    provider: 'minimax',
    accumulatedText,
    textBlocks,
    metadata: {
      costEstimationKind: 'subscription-equivalent-payg',
      costSource: 'calculated',
      pricingSnapshot: getPricingSnapshot(config.model),
      ...(sessionIds !== undefined && sessionIds.length > 0 ? { sessionIds } : {}),
    },
    ...(resultError !== undefined ? { error: resultError } : {}),
  };
}

export const minimaxTokenplanExecutor: RuntimeExecutor = { run };

async function* withRuntimeActivity<T>(source: AsyncIterable<T>, onActivity?: () => void): AsyncIterable<T> {
  for await (const event of source) {
    onActivity?.();
    yield event;
  }
}
