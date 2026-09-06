
import { createLogger } from '../logger';
import { ollamaChatWithTools } from '../ollama-client';
import { getSecret } from '../vault-registry';
import { MODEL_CATALOG } from '../../../src/lib/provider-presets';
import type { ReasoningCapability } from '../../../src/lib/provider-presets';
import type { OllamaChatResult } from '../ollama-client';
import type { ExternalConfig, AgentConfig } from '../../../src/types';

const logger = createLogger('external-http');

export async function resolveExternalAuth(
  config: ExternalConfig,
): Promise<Record<string, string>> {
  const apiKey = await getSecret(config.apiKeyRef);
  if (!apiKey) {
    throw new Error(
      `API key nao encontrada no Vault para provider "${config.apiKeyRef}". ` +
      `Configure em Configuracoes > Vault.`,
    );
  }
  return {
    ...(config.extraHeaders ?? {}),
    'Authorization': `Bearer ${apiKey}`,
  };
}

export async function ollamaChatWithRetry(
  ...args: Parameters<typeof ollamaChatWithTools>
): Promise<OllamaChatResult> {
  const MAX_RETRIES = 5;
  const DEFAULT_429_WAIT_MS = 30_000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await ollamaChatWithTools(...args);
    } catch (err) {
      const errMsg = (err as Error).message || '';
      const is429 = errMsg.includes('HTTP 429');
      const is5xx = /HTTP 5\d\d/.test(errMsg);

      if ((!is429 && !is5xx) || attempt === MAX_RETRIES) {
        throw err;
      }

      let waitMs: number;
      if (is429) {
        const retryAfterMatch = errMsg.match(/Retry-After:\s*(\d+)/i);
        waitMs = retryAfterMatch
          ? parseInt(retryAfterMatch[1], 10) * 1000
          : DEFAULT_429_WAIT_MS;
      } else {
        waitMs = Math.min(2000 * Math.pow(2, attempt), 30_000);
      }

      logger.warn(
        {
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          waitMs,
          statusType: is429 ? '429' : '5xx',
          model: args[1],
          errPreview: errMsg.substring(0, 200),
        },
        'External request failed, retrying',
      );

      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  throw new Error('Retry exhausted');
}

export function computePricingKey(extCfg: ExternalConfig): string {
  if (extCfg.provider === 'openrouter') return `or:${extCfg.model}`;
  return extCfg.model;
}

export function mapReasoningParams(
  effort: AgentConfig['effort'] | undefined,
  thinking: AgentConfig['thinking'] | undefined,
  _thinkingBudget: number | undefined,
  provider: ExternalConfig['provider'],
  model: string,
): Partial<Record<string, unknown>> {
  const reasoningEffort = effort === 'max' ? 'high' : (effort ?? 'medium');

  if (provider === 'openai' && (model.startsWith('gpt-5.5') || model.startsWith('o'))) {
    if (thinking === 'disabled') return {};
    return { reasoning_effort: reasoningEffort };
  }

  if (provider === 'openrouter') {
    if (model.startsWith('openai/gpt-5')) {
      return thinking === 'disabled' ? {} : { reasoning_effort: reasoningEffort };
    }
    if (model.startsWith('qwen/qwen3.6') && thinking !== 'disabled') {
      return { thinking: { type: 'enabled' } };
    }
  }

  if (
    provider === 'kimi' ||
    provider === 'deepseek' ||
    provider === 'qwen' ||
    provider === 'minimax-payg'
  ) {
    const cataloged = MODEL_CATALOG[provider]?.find((m) => m.id === model);
    if (cataloged?.reasoning) {
      return materializeReasoning(cataloged.reasoning, reasoningEffort, thinking);
    }
  }

  return {}; // outros providers/modelos: ignora
}

export function materializeReasoning(
  cap: ReasoningCapability,
  effort: 'low' | 'medium' | 'high',
  thinking: AgentConfig['thinking'] | undefined,
): Partial<Record<string, unknown>> {
  if (thinking === 'disabled') return {};
  switch (cap.kind) {
    case 'none':
      return {};
    case 'openai-effort':
      return { reasoning_effort: effort };
    case 'anthropic-thinking-flag':
      return { thinking: { type: 'enabled' } };
    case 'qwen-thinking-flag':
      return { thinking: { type: 'enabled' } };
    case 'reasoning-content-builtin':
      return {};
  }
}

export function resolveExternalPricing(
  extCfg: ExternalConfig,
): { pricingKey: string; status: 'known' } | { pricingKey: null; status: 'unknown' } {
  const { provider, model } = extCfg;

  if (provider === 'openrouter' || provider === 'openai' || provider === 'openai-compatible') {
    return { pricingKey: computePricingKey(extCfg), status: 'known' };
  }

  const catalog = MODEL_CATALOG[provider];
  const entry = catalog?.find((m) => m.id === model);
  if (!entry || entry.pricingKey === null) {
    return { pricingKey: null, status: 'unknown' };
  }
  return { pricingKey: entry.pricingKey, status: 'known' };
}

export function isContextLengthError(errorMessage: string): boolean {
  return /context.*(length|limit|exceed|too long)/i.test(errorMessage)
    || /maximum.*tokens/i.test(errorMessage)
    || /token.*limit.*exceeded/i.test(errorMessage)
    || errorMessage.includes('context_length_exceeded');
}
