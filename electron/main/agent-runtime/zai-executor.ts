
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

const logger = createLogger('zai-executor');

type EnvMap = Record<string, string>;

const CONTEXT_WINDOW_ENV_KEYS: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'DISABLE_AUTO_COMPACT',
  'DISABLE_COMPACT',
]);

function appendZaiRuntimeContext(systemPrompt: string, model: string): string {
  const runtimeBlock = [
    '',
    '',
    '## Runtime Atual',
    '',
    '- Runtime: zai',
    '- Provider: Z.ai Anthropic-compatible Claude Code endpoint',
    `- Modelo selecionado: ${model}`,
    '- Use esta informacao quando o usuario perguntar qual modelo ou runtime esta executando este agente.',
  ].join('\n');
  return `${systemPrompt || ''}${runtimeBlock}`;
}

export function buildZaiEnv(
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

  const contextWindow = getContextWindow(model, 'zai');

  return {
    ...env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    API_TIMEOUT_MS: '3000000',
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ...(contextWindow !== undefined
      ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow) }
      : {}),
  };
}

async function resolveZaiApiKey(): Promise<string> {
  const vaultRef = getSetting('orchestrator_zai_api_key_ref');
  if (!vaultRef) {
    throw new Error(
      'Z.ai nao esta conectado. Configure Z.ai em Settings > Provedores externos antes de usar subagents GLM.',
    );
  }

  const apiKey = await getSecret(vaultRef);
  if (!apiKey) {
    throw new Error(
      `Chave Z.ai nao encontrada no Vault (ref=${vaultRef}). Reconecte Z.ai em Provedores externos.`,
    );
  }

  return apiKey;
}

export function buildZaiQueryOptions(
  req: AgentExecutionRequest,
  config: AgentQueryConfig,
  cliPath: string,
  childAbort: AbortController,
  apiKey: string,
): Record<string, unknown> {
  const preset = getClaudeCompatPreset('zai');
  const mcpServersObj = config.mcpServers.length > 0
    ? Object.fromEntries(config.mcpServers.flatMap((s) => Object.entries(s)))
    : undefined;

  return {
    env: buildZaiEnv(apiKey, config.model, preset.baseUrl),
    pathToClaudeCodeExecutable: cliPath,
    cwd: req.cwd,
    model: config.model,
    systemPrompt: appendZaiRuntimeContext(config.systemPrompt, config.model),
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
      logger.info({ agentId: req.agentId, stderr: text.substring(0, 500) }, 'Z.ai Agent stderr');
    },
  };
}

async function run(
  req: AgentExecutionRequest,
  config: AgentQueryConfig,
): Promise<AgentExecutionResult> {
  ensureNodeInPath();

  const apiKey = await resolveZaiApiKey();
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
    'zai-executor: running agent',
  );

  const q = (query as (opts: Record<string, unknown>) => unknown)({
    prompt: req.prompt,
    options: {
      ...buildZaiQueryOptions(req, config, cliPath, childAbort, apiKey),
      ...processOptions,
    },
  }) as AsyncIterable<Record<string, unknown>>;

  let output: string;
  let streamMetrics: Awaited<ReturnType<typeof processAgentStream>>['metrics'];
  let accumulatedText: string;
  let textBlocks: string[];
  let resultError: Awaited<ReturnType<typeof processAgentStream>>['resultError'];
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
    runtime: 'zai',
    provider: 'zai',
    accumulatedText,
    textBlocks,
    metadata: {
      costSource: 'calculated',
      pricingSnapshot: getPricingSnapshot(config.model),
      ...(sessionIds !== undefined && sessionIds.length > 0 ? { sessionIds } : {}),
    },
    ...(resultError !== undefined ? { error: resultError } : {}),
  };
}

export const zaiExecutor: RuntimeExecutor = { run };
