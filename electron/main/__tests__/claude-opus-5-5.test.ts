import { describe, it, expect } from 'vitest';

import { CLAUDE_MODELS, CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';
import { formatModelLabel, shortenModel } from '../../../src/utils/model-display';
import { MODEL_CATALOG } from '../../../src/lib/provider-presets';
import { MODEL_PRICING, calculateCost, hasKnownPricing } from '../pricing';
import { getContextWindow } from '../agent-runtime/model-context-windows';
import { buildClaudeQueryOptions } from '../agent-runtime/cloud-executor';
import { PERM_BYPASS_NO_GUARD } from '../agent-runtime/permission-profiles';
import type { AgentExecutionRequest, AgentPermissionProfile } from '../agent-runtime/types';
import type { AgentQueryConfig } from '../agent-config-resolver';

const OPUS_5_5 = 'claude-opus-5-5';

function makeReq(
  permission: AgentPermissionProfile = PERM_BYPASS_NO_GUARD,
  overrides: Partial<AgentExecutionRequest> = {},
): AgentExecutionRequest {
  return {
    agentId: 'test-cloud-agent',
    prompt: 'Do the thing',
    cwd: '/tmp/project',
    abortController: new AbortController(),
    permission,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
  return {
    model: OPUS_5_5,
    systemPrompt: 'You are a helpful coding agent.',
    allowedTools: ['Read', 'Edit'],
    mcpServers: [],
    maxTurns: undefined,
    effort: undefined,
    thinking: undefined,
    thinkingBudget: undefined,
    runtime: 'cloud',
    ...overrides,
  } as unknown as AgentQueryConfig;
}

function buildOpts(
  config: AgentQueryConfig,
  reqOverrides: Partial<AgentExecutionRequest> = {},
): Record<string, unknown> {
  return buildClaudeQueryOptions(
    makeReq(PERM_BYPASS_NO_GUARD, reqOverrides),
    config,
    '/path/to/cli.js',
    new AbortController(),
  );
}

describe('Opus 5.5 — catalogo', () => {
  it('esta em CLAUDE_MODELS com displayName "Claude Opus 5.5"', () => {
    const entry = CLAUDE_MODELS.find((m) => m.id === OPUS_5_5);
    expect(entry).toBeDefined();
    expect(entry?.displayName).toBe('Claude Opus 5.5');
  });

  it('e o CLAUDE_DEFAULT_MODEL (orquestrador/agente principal)', () => {
    expect(CLAUDE_DEFAULT_MODEL).toBe(OPUS_5_5);
  });

  it('vem logo depois do Fable 5.1, antes do Opus 5', () => {
    const ids = CLAUDE_MODELS.map((m) => m.id);
    expect(ids.indexOf(OPUS_5_5)).toBe(ids.indexOf('claude-fable-5-1') + 1);
    expect(ids.indexOf('claude-opus-5')).toBe(ids.indexOf(OPUS_5_5) + 1);
  });

  it('Opus 5 continua no catalogo (nao foi aposentado)', () => {
    expect(CLAUDE_MODELS.some((m) => m.id === 'claude-opus-5')).toBe(true);
  });

  it('esta no catalogo OpenRouter com pricingKey or:', () => {
    const entry = MODEL_CATALOG.openrouter.find((m) => m.id === 'anthropic/claude-opus-5-5');
    expect(entry?.pricingKey).toBe('or:anthropic/claude-opus-5-5');
    expect(MODEL_PRICING['or:anthropic/claude-opus-5-5']).toBeDefined();
  });
});

describe('Opus 5.5 — pricing', () => {
  it('cobra $4 input / $20 output / $0.20 cache read / $5 cache write por MTok', () => {
    expect(MODEL_PRICING[OPUS_5_5]).toEqual({ input: 4.0, output: 20.0, cacheRead: 0.2, cacheCreation: 5.0 });
  });

  it('calculateCost de 1M in + 1M out = $24', () => {
    expect(calculateCost(OPUS_5_5, 1_000_000, 1_000_000, 0, 0)).toBeCloseTo(24, 4);
  });

  it('hasKnownPricing reconhece o slug', () => {
    expect(hasKnownPricing(OPUS_5_5)).toBe(true);
  });

  it('regressao: preco do Opus 5 inalterado', () => {
    expect(MODEL_PRICING['claude-opus-5']).toEqual({ input: 5.0, output: 25.0, cacheRead: 0.5, cacheCreation: 6.25 });
  });
});

describe('Opus 5.5 — janela de contexto e display', () => {
  it('resolve 1M', () => {
    expect(getContextWindow(OPUS_5_5, 'anthropic')).toBe(1_000_000);
  });

  it('formatModelLabel -> "Opus 5.5"; shortenModel -> "opus"', () => {
    expect(formatModelLabel(OPUS_5_5)).toBe('Opus 5.5');
    expect(shortenModel(OPUS_5_5)).toBe('opus');
    expect(formatModelLabel('anthropic/claude-opus-5-5')).toBe('Opus 5.5');
  });
});

describe('Opus 5.5 — thinking nao pode ser desligado (evita 400 da API)', () => {
  it('thinking DISABLED + effort high -> OMITE a chave thinking', () => {
    const opts = buildOpts(makeConfig({ thinking: 'disabled', effort: 'high' }));
    expect(opts).not.toHaveProperty('thinking');
  });

  it('thinking DISABLED + effort low -> OMITE a chave thinking', () => {
    const opts = buildOpts(makeConfig({ thinking: 'disabled', effort: 'low' }));
    expect(opts).not.toHaveProperty('thinking');
  });

  it('thinking ENABLED + thinkingBudget -> { type: enabled } SEM budgetTokens', () => {
    const opts = buildOpts(makeConfig({ thinking: 'enabled', thinkingBudget: 8000 }));
    expect(opts.thinking).toEqual({ type: 'enabled' });
  });

  it('regressao: Opus 5 com disabled + effort high continua enviando { type: disabled }', () => {
    const opts = buildOpts(makeConfig({ model: 'claude-opus-5', thinking: 'disabled', effort: 'high' }));
    expect(opts.thinking).toEqual({ type: 'disabled' });
  });
});
