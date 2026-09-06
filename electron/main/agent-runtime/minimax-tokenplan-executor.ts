/**
 * minimax-tokenplan-executor.ts
 *
 * Runs an agent via MiniMax TokenPlan's Anthropic-compatible endpoint.
 *
 * This runtime is intentionally separate from cloud-executor AND from
 * zai-executor (duplicacao deliberada — SPEC-006 §8.3 + R6 ADR):
 * - no ensureAuthForSDK()
 * - no Anthropic API key fallback
 * - child env is sanitized before injecting MiniMax variables
 * - costEstimationKind: 'subscription-equivalent-payg' em todo retorno
 *
 * NOTA: este executor espelha a estrutura do zai-executor.ts mas NAO importa
 * dele. Qualquer correcao futura no zai-executor deve ser replicada aqui
 * manualmente para manter a simetria (SPEC-006 §15 — symmetry drift risk).
 *
 * SPEC-006 §11.4: comportamento defensivo de usage zero implementado em `run`.
 */

import fs from 'fs';
import { createLogger } from '../logger';
import { processAgentStream } from '../stream-processor';
import { calculateCost, getPricingSnapshot } from '../pricing';
import { getSetting } from '../db';
import { getSecret } from '../secrets-vault';
import { getClaudeCompatPreset } from '../claude-compat-sdk/provider-presets';
import {
  getClaudeSdkProcessOptions,
  ensureNodeInPath,
} from '../pipeline-shared/sdk-bootstrap';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { RuntimeExecutor, AgentExecutionRequest, AgentExecutionResult } from './types';
import { SDK_DISALLOWED_TOOLS, toSdkToolNames } from './sdk-tool-names';
import { getContextWindow } from './model-context-windows';
import { isStrippedSubprocessEnvKey } from './subprocess-env';

const logger = createLogger('minimax-tp-executor');

type EnvMap = Record<string, string>;

// Engine knobs for context window / auto-compact dropped from the inherited env
// before re-injecting the LionClaw-computed window (SPEC agent-sdk-0.3 D9).
// Deliberate copy of the compat / zai builders (three independent env
// builders, SPEC §10.5).
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
    // Follow-up L1.7: vars de dev do Electron nunca chegam ao engine.
    if (isStrippedSubprocessEnvKey(key)) continue;
    env[key] = value;
  }

  // F8: the engine honours CLAUDE_CODE_MAX_CONTEXT_TOKENS for names that do NOT
  // start with `claude-`. Unknown window => key ABSENT (never guess).
  const contextWindow = getContextWindow(model, 'minimax');

  return {
    ...env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    // Match the working orchestrator MiniMax compat path: MiniMax requires the
    // explicit top-level model env in addition to Claude Code default aliases.
    ANTHROPIC_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    API_TIMEOUT_MS: '3000000',
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ...(contextWindow !== undefined
      ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow) }
      : {}),
  };
}

async function resolveMinimaxTpApiKey(): Promise<string> {
  const vaultRef = getSetting('orchestrator_minimax_api_key_ref');
  if (!vaultRef || vaultRef.trim().length === 0) {
    throw new Error(
      'MiniMax TokenPlan nao esta conectado. Configure MiniMax em Settings > Provedores externos antes de usar subagents MiniMax TokenPlan.',
    );
  }

  const apiKey = await getSecret(vaultRef);
  if (!apiKey) {
    throw new Error(
      `Chave MiniMax foi removida do Vault (ref=${vaultRef}). Reconecte MiniMax em Provedores externos.`,
    );
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
  const mcpServersObj = config.mcpServers.length > 0
    ? Object.fromEntries(config.mcpServers.flatMap((s) => Object.entries(s)))
    : undefined;

  return {
    env: buildMinimaxTpEnv(apiKey, config.model, preset.baseUrl),
    pathToClaudeCodeExecutable: cliPath,
    cwd: req.cwd,
    model: config.model,
    systemPrompt: appendMinimaxTpRuntimeContext(config.systemPrompt, config.model),
    // D7/D8 (SPEC agent-sdk-0.3): ver cloud-executor.buildClaudeQueryOptions.
    allowedTools: toSdkToolNames(config.allowedTools),
    disallowedTools: [...SDK_DISALLOWED_TOOLS],
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

async function run(
  req: AgentExecutionRequest,
  config: AgentQueryConfig,
): Promise<AgentExecutionResult> {
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

  logger.info(
    { agentId: req.agentId, model: config.model },
    'minimax-tp-executor: running agent',
  );

  const q = (query as (opts: Record<string, unknown>) => unknown)({
    prompt: req.prompt,
    options: {
      ...buildMinimaxTpQueryOptions(req, config, cliPath, childAbort, apiKey),
      ...processOptions,
    },
  }) as AsyncIterable<Record<string, unknown>>;

  let output: string;
  let streamMetrics: Awaited<ReturnType<typeof processAgentStream>>['metrics'];
  let accumulatedText: string;
  let textBlocks: string[];
  // SPEC robustez-chat SB-2 (AC-B6b): vazio-como-sucesso detectado no ponto
  // comum (processAgentStream) e propagado ao contrato `error?` do resultado.
  let resultError: Awaited<ReturnType<typeof processAgentStream>>['resultError'];
  // BUG 3 F1/F3 (bug-atividade-toolcalls-codex.md 3.3): sessionIds do stream.
  // O total_cost_usd do result NUNCA e usado aqui — VENENOSO no compat (o CLI
  // precifica o modelo mapeado com tabela Anthropic); o custo segue em
  // calculateCost e o snapshot da tabela vai na proveniencia do metadata.
  let sessionIds: Awaited<ReturnType<typeof processAgentStream>>['sessionIds'];

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
    sessionIds = result.sessionIds;
    resultError = result.resultError;
  } finally {
    cleanupParentListener();
  }

  const durationMs = Date.now() - startedAt;

  // SPEC-006 §11.4: comportamento DEFENSIVO. Se o SDK retornou texto mas tokens
  // vieram zero, marcar tokenStatus: 'not_reported' + costStatus: 'unknown' em
  // vez de gravar $0 silencioso. Apenas aplica quando ha output real.
  // Sem output + tokens zero: legitimo (noop ou empty response), nao marca.
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
