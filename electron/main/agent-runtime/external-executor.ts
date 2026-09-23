import { createLogger } from '../logger';
import {
  resolveExternalAuth,
  ollamaChatWithRetry,
  mapReasoningParams,
  isContextLengthError,
  resolveExternalPricing,
} from './external-http';
import { calculateCost } from '../pricing';
import { getAgent } from '../db';
import { warnMcpToolsDroppedOnce, warnOncePerAgent } from './mcp-warning';
import { googleGenAiExecutor } from './google-genai-executor';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { RuntimeExecutor, AgentExecutionRequest, AgentExecutionResult } from './types';
import { builtinToolsToOllamaSchemas } from './tool-schemas';
import { emptyResponseExecutionError } from './llm-error';

const logger = createLogger('external-executor');

async function run(req: AgentExecutionRequest, config: AgentQueryConfig): Promise<AgentExecutionResult> {
  const agentRecord = req.executionAgent ?? getAgent(req.agentId);
  if (!agentRecord?.externalConfig) {
    throw new Error(`Agent ${req.agentId} has runtime=external but no externalConfig`);
  }

  const extCfg = agentRecord.externalConfig;

  const protocol = extCfg.protocol ?? 'openai-compatible';

  if (protocol === 'google-genai') {
    return googleGenAiExecutor.run(req, config);
  }

  warnMcpToolsDroppedOnce({
    agentId: req.agentId,
    runtime: 'external',
    provider: extCfg.provider,
    allowedTools: config.allowedTools,
  });

  if (!extCfg.baseUrl || extCfg.baseUrl.trim().length === 0) {
    throw new Error(
      `Agent ${req.agentId} (provider ${extCfg.provider}) sem baseUrl. ` +
        `Custom OpenAI-compatible exige baseUrl; presets devem preencher a partir de PROVIDER_PRESETS.`,
    );
  }

  const authHeaders = await resolveExternalAuth(extCfg);
  const reasoningParams = mapReasoningParams(
    config.effort,
    config.thinking,
    config.thinkingBudget,
    extCfg.provider,
    extCfg.model,
  );
  const ollamaTools = builtinToolsToOllamaSchemas(config.allowedTools);
  const startedAt = Date.now();

  logger.info(
    { agentId: req.agentId, provider: extCfg.provider, model: extCfg.model },
    'external-executor: running agent',
  );

  let extResult: Awaited<ReturnType<typeof ollamaChatWithRetry>>;
  try {
    extResult = await ollamaChatWithRetry(extCfg.baseUrl, extCfg.model, config.systemPrompt, req.prompt, ollamaTools, {
      cwd: req.cwd,
      signal: req.abortController.signal,
      onActivity: req.onActivity,
      toolDispatch: req.swarmToolDispatch,
      disableTaskRetry: Boolean(req.executionAgent),
      externallyManagedTimeout: Boolean(req.swarmLifecycle),
      onText: req.onText,
      onTextDelta: req.onText,
      onToolUse: (record) => {
        req.onToolUse?.(record.tool);
        let parsedInput: unknown = record.input;
        if (typeof record.input === 'string') {
          try {
            parsedInput = JSON.parse(record.input);
          } catch {
            parsedInput = null;
          }
        }
        req.onToolUseComplete?.(record.tool, parsedInput);
      },
      provider: extCfg.provider,
      authHeaders,
      maxTokens: extCfg.maxTokens,
      streaming: true,
      extraBodyParams: reasoningParams,
      maxRounds: agentRecord.maxToolRounds ?? 50,
      priorMessages: req.priorMessages,
    });
  } catch (err) {
    const errMsg = (err as Error).message || '';
    if (isContextLengthError(errMsg)) {
      throw new Error(`Contexto excedido para modelo ${extCfg.model}. Considere usar um modelo com janela maior.`);
    }
    throw err;
  }

  const durationMs = Date.now() - startedAt;

  const pricing = resolveExternalPricing(extCfg);
  const reportedCostUsd = extResult.reportedCostUsd;

  let costUsd: number;
  let costStatus: 'known' | 'unknown' | undefined;
  let tokenStatus: 'reported' | 'not_reported' | undefined;
  let costUnknownReason: 'unknown-pricing' | 'no-usage-reported' | undefined;

  const usageReported: boolean = extResult.usageReported ?? false;

  if (!usageReported) {
    tokenStatus = 'not_reported';
    costStatus = 'unknown';
    costUnknownReason = 'no-usage-reported';
    costUsd = 0;
    warnOncePerAgent(req.agentId, 'no-usage-reported', {
      agentId: req.agentId,
      provider: extCfg.provider,
      model: extCfg.model,
      reason: 'no-usage-reported',
    });
  } else if (pricing.status === 'unknown') {
    tokenStatus = 'reported';
    costStatus = 'unknown';
    costUnknownReason = 'unknown-pricing';
    costUsd = 0;
  } else {
    tokenStatus = 'reported';
    costStatus = 'known';
    costUnknownReason = undefined;
    if (reportedCostUsd !== undefined && reportedCostUsd > 0) {
      costUsd = reportedCostUsd;
    } else {
      costUsd = calculateCost(
        pricing.pricingKey,
        extResult.promptTokens,
        extResult.tokensUsed,
        extResult.cacheHitTokens ?? 0,
        0,
      );
    }
  }

  const resultError = emptyResponseExecutionError({
    content: extResult.content,
    toolUses: extResult.toolCalls.length,
    aborted: req.abortController.signal.aborted,
    provider: extCfg.provider ?? 'unknown',
    model: extCfg.model,
  });

  return {
    output: extResult.content,
    metrics: {
      inputTokens: extResult.promptTokens,
      outputTokens: extResult.tokensUsed,
      cacheReadTokens: extResult.cacheHitTokens ?? 0,
      cacheCreationTokens: 0,
      toolUses: extResult.toolCalls.length,
      apiRequests: extResult.apiRequests,
      costUsd,
      durationMs,
      costStatus,
      tokenStatus,
      costUnknownReason,
    },
    model: extCfg.model,
    runtime: 'external',
    provider: extCfg.provider ?? 'unknown',
    toolCalls: extResult.toolCalls,
    ...(resultError !== undefined ? { error: resultError } : {}),
  };
}

export const externalExecutor: RuntimeExecutor = { run };
