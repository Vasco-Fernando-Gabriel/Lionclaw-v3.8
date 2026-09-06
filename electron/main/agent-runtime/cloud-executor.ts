
import fs from 'fs';
import { createLogger } from '../logger';
import { processAgentStream } from '../stream-processor';
import { calculateCost, getPricingSnapshot } from '../pricing';
import {
  getClaudeSdkProcessOptions,
  ensureNodeInPath,
  ensureAuthForSDK,
} from '../pipeline-shared/sdk-bootstrap';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { RuntimeExecutor, AgentExecutionRequest, AgentExecutionResult } from './types';
import { SDK_DISALLOWED_TOOLS, toSdkToolNames } from './sdk-tool-names';
import { sanitizeSubprocessEnv } from './subprocess-env';

const logger = createLogger('cloud-executor');

type ClaudeModelUsage = Record<string, {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}>;

interface CloudCostInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd?: number;
  modelUsage?: ClaudeModelUsage;
}

export interface CloudCostResult {
  costUsd: number;
  costSource: 'sdk_total_cost_usd' | 'sdk_model_usage' | 'calculated';
  sdkReportedCostUsd?: number;
  reconciliationRelativeDelta?: number;
}

export function reconcileCloudCost(input: CloudCostInput): CloudCostResult {
  const sdkModelUsageCost = input.modelUsage
    ? Object.values(input.modelUsage).reduce((sum, usage) => sum + usage.costUSD, 0)
    : undefined;
  const sdkReportedCostUsd = input.totalCostUsd && input.totalCostUsd > 0
    ? input.totalCostUsd
    : sdkModelUsageCost && sdkModelUsageCost > 0
      ? sdkModelUsageCost
      : undefined;
  const sdkSource = input.totalCostUsd && input.totalCostUsd > 0
    ? 'sdk_total_cost_usd' as const
    : 'sdk_model_usage' as const;

  const streamCost = calculateCost(
    input.model,
    input.inputTokens,
    input.outputTokens,
    input.cacheReadTokens,
    input.cacheCreationTokens,
  );
  const modelUsageCost = input.modelUsage
    ? Object.entries(input.modelUsage).reduce((sum, [model, usage]) => sum + calculateCost(
      model,
      usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
      usage.outputTokens,
      usage.cacheReadInputTokens,
      usage.cacheCreationInputTokens,
    ), 0)
    : 0;
  const canonicalCost = Math.max(streamCost, modelUsageCost);

  if (sdkReportedCostUsd !== undefined && canonicalCost > 0) {
    const relativeDelta = Math.abs(sdkReportedCostUsd - canonicalCost) / canonicalCost;
    if (relativeDelta > 0.10) {
      return {
        costUsd: Math.round(canonicalCost * 1_000_000) / 1_000_000,
        costSource: 'calculated',
        sdkReportedCostUsd,
        reconciliationRelativeDelta: relativeDelta,
      };
    }
    return { costUsd: sdkReportedCostUsd, costSource: sdkSource };
  }

  if (sdkReportedCostUsd !== undefined) {
    return { costUsd: sdkReportedCostUsd, costSource: sdkSource };
  }
  return { costUsd: canonicalCost, costSource: 'calculated' };
}

export function buildClaudeQueryOptions(
  req: AgentExecutionRequest,
  config: AgentQueryConfig,
  cliPath: string,
  childAbort: AbortController,
): Record<string, unknown> {
  const mcpServersObj = config.mcpServers.length > 0
    ? Object.fromEntries(config.mcpServers.flatMap((s) => Object.entries(s)))
    : undefined;

  const modelLower = config.model.toLowerCase();
  const suppressThinking = modelLower.startsWith('claude-fable-');

  const isOpus5 = modelLower.startsWith('claude-opus-5');
  const resolvedEffort = req.inheritedEffort !== undefined
    ? req.inheritedEffort.claude
    : config.effort;

  return {
    pathToClaudeCodeExecutable: cliPath,
    cwd: req.cwd,
    model: config.model,
    systemPrompt: config.systemPrompt || '',
    allowedTools: toSdkToolNames(config.allowedTools),
    disallowedTools: [...SDK_DISALLOWED_TOOLS],
    permissionMode: req.permission.mode,
    allowDangerouslySkipPermissions: req.permission.dangerouslySkipPermissions,
    ...(req.permission.canUseTool ? { canUseTool: req.permission.canUseTool } : {}),
    includePartialMessages: true,
    abortController: childAbort,
    env: sanitizeSubprocessEnv(),
    ...(req.continueSession ? { continue: true as const } : {}),
    ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
    ...(req.inheritedEffort !== undefined
      ? { effort: req.inheritedEffort.claude }
      : config.effort !== undefined
        ? { effort: config.effort }
        : {}),
    ...(suppressThinking
      ? {}
      : config.thinking === 'enabled'
        ? {
            thinking: {
              type: 'enabled' as const,
              ...(config.thinkingBudget !== undefined && !isOpus5
                ? { budgetTokens: config.thinkingBudget }
                : {}),
            },
          }
        : config.thinking === 'disabled'
          ? isOpus5 && resolvedEffort === 'max'
            ? {}
            : { thinking: { type: 'disabled' as const } }
          : {}),
    ...(mcpServersObj ? { mcpServers: mcpServersObj } : {}),
    stderr: (text: string) => {
      logger.info({ agentId: req.agentId, stderr: text.substring(0, 500) }, 'Agent stderr');
    },
  };
}

async function run(
  req: AgentExecutionRequest,
  config: AgentQueryConfig,
): Promise<AgentExecutionResult> {
  ensureNodeInPath();
  await ensureAuthForSDK();

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

  const q = (query as (opts: Record<string, unknown>) => unknown)({
    prompt: req.prompt,
    options: {
      ...buildClaudeQueryOptions(req, config, cliPath, childAbort),
      ...processOptions,
    },
  }) as AsyncIterable<Record<string, unknown>>;

  let output: string;
  let streamMetrics: Awaited<ReturnType<typeof processAgentStream>>['metrics'];
  let accumulatedText: string;
  let textBlocks: string[];
  let totalCostUsd: Awaited<ReturnType<typeof processAgentStream>>['totalCostUsd'];
  let modelUsage: Awaited<ReturnType<typeof processAgentStream>>['modelUsage'];
  let sessionIds: Awaited<ReturnType<typeof processAgentStream>>['sessionIds'];
  let resultError: Awaited<ReturnType<typeof processAgentStream>>['resultError'];

  try {
    const result = await processAgentStream(q, {
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
    totalCostUsd = result.totalCostUsd;
    modelUsage = result.modelUsage;
    sessionIds = result.sessionIds;
    resultError = result.resultError;
  } finally {
    cleanupParentListener();
  }

  const durationMs = Date.now() - startedAt;

  const reconciledCost = reconcileCloudCost({
    model: config.model,
    inputTokens: streamMetrics.inputTokens,
    outputTokens: streamMetrics.outputTokens,
    cacheReadTokens: streamMetrics.cacheReadTokens,
    cacheCreationTokens: streamMetrics.cacheCreationTokens,
    totalCostUsd,
    modelUsage,
  });
  if (reconciledCost.reconciliationRelativeDelta !== undefined) {
    logger.warn({
      agentId: req.agentId,
      model: config.model,
      sdkReportedCostUsd: reconciledCost.sdkReportedCostUsd,
      reconciledCostUsd: reconciledCost.costUsd,
      relativeDelta: reconciledCost.reconciliationRelativeDelta,
    }, 'Claude SDK cost diverged from canonical pricing; using local calculation');
  }

  return {
    output,
    metrics: {
      inputTokens: streamMetrics.inputTokens,
      outputTokens: streamMetrics.outputTokens,
      cacheReadTokens: streamMetrics.cacheReadTokens,
      cacheCreationTokens: streamMetrics.cacheCreationTokens,
      toolUses: streamMetrics.toolUses,
      apiRequests: streamMetrics.apiRequests,
      costUsd: reconciledCost.costUsd,
      durationMs,
    },
    model: config.model,
    runtime: 'cloud',
    provider: 'anthropic',
    accumulatedText,
    textBlocks,
    metadata: {
      costSource: reconciledCost.costSource,
      ...(reconciledCost.costSource === 'calculated'
        ? { pricingSnapshot: getPricingSnapshot(config.model) }
        : {}),
      ...(reconciledCost.sdkReportedCostUsd !== undefined
        ? { sdkReportedCostUsd: reconciledCost.sdkReportedCostUsd }
        : {}),
      ...(reconciledCost.reconciliationRelativeDelta !== undefined
        ? { costReconciliationRelativeDelta: reconciledCost.reconciliationRelativeDelta }
        : {}),
      ...(sessionIds !== undefined && sessionIds.length > 0 ? { sessionIds } : {}),
      ...(modelUsage !== undefined ? { modelUsage } : {}),
    },
    ...(resultError !== undefined ? { error: resultError } : {}),
  };
}

export const cloudExecutor: RuntimeExecutor = { run };
