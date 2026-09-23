import { describe, it, expect } from 'vitest';

import { CLAUDE_MODELS, CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';
import { formatModelLabel, shortenModel } from '../../../src/utils/model-display';
import { MODEL_PRICING, calculateCost, hasKnownPricing } from '../pricing';
import { getContextWindow } from '../agent-runtime/model-context-windows';
import { buildClaudeQueryOptions } from '../agent-runtime/cloud-executor';
import { PERM_BYPASS_NO_GUARD } from '../agent-runtime/permission-profiles';
import type { AgentExecutionRequest, AgentPermissionProfile } from '../agent-runtime/types';
import type { AgentQueryConfig } from '../agent-config-resolver';

const OPUS_5 = 'claude-opus-5';

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
    model: OPUS_5,
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

describe('Opus 5 — catalogo', () => {
  it('esta em CLAUDE_MODELS com displayName "Claude Opus 5"', () => {
    const opus5 = CLAUDE_MODELS.find((m) => m.id === OPUS_5);
    expect(opus5).toBeDefined();
    expect(opus5?.displayName).toBe('Claude Opus 5');
  });

  it('deixou de ser o CLAUDE_DEFAULT_MODEL (o default e o Opus 5.5; migration V157 promove quem estava nele)', () => {
    expect(CLAUDE_DEFAULT_MODEL).toBe('claude-opus-5-5');
    expect(CLAUDE_DEFAULT_MODEL).not.toBe(OPUS_5);
  });

  it('vem logo depois do Opus 5.5, antes do Opus 4.8', () => {
    const ids = CLAUDE_MODELS.map((m) => m.id);
    expect(ids.indexOf(OPUS_5)).toBeGreaterThan(ids.indexOf('claude-fable-5-1'));
    expect(ids.indexOf(OPUS_5)).toBeLessThan(ids.indexOf('claude-opus-4-8'));
  });
});

describe('Opus 5 — pricing', () => {
  it('tem entrada EXPLICITA em MODEL_PRICING (nao depende do fallback keyword)', () => {
    expect(MODEL_PRICING[OPUS_5]).toBeDefined();
  });

  it('cobra $5 input / $25 output por MTok', () => {
    expect(MODEL_PRICING[OPUS_5].input).toBe(5.0);
    expect(MODEL_PRICING[OPUS_5].output).toBe(25.0);
    expect(MODEL_PRICING[OPUS_5].cacheRead).toBe(0.5);
    expect(MODEL_PRICING[OPUS_5].cacheCreation).toBe(6.25);
  });

  it('calculateCost de 1M in + 1M out = $30', () => {
    expect(calculateCost(OPUS_5, 1_000_000, 1_000_000)).toBe(30);
  });

  it('hasKnownPricing reconhece o slug', () => {
    expect(hasKnownPricing(OPUS_5)).toBe(true);
  });

  it('regressao: precos do Opus 4.8 e Fable 5 inalterados', () => {
    expect(calculateCost('claude-opus-4-8', 1_000_000, 1_000_000)).toBe(30);
    expect(calculateCost('claude-fable-5', 1_000_000, 1_000_000)).toBe(60);
  });
});

describe('Opus 5 — janela de contexto', () => {
  it('resolve 1M (sem a entrada explicita cairia em 200k pelo fallback keyword)', () => {
    expect(getContextWindow(OPUS_5)).toBe(1_000_000);
  });
});

describe('Opus 5 — display', () => {
  it('formatModelLabel -> "Opus 5"', () => {
    expect(formatModelLabel(OPUS_5)).toBe('Opus 5');
  });

  it('shortenModel -> "opus" (nunca o id cru)', () => {
    expect(shortenModel(OPUS_5)).toBe('opus');
  });

  it('formatModelLabel do slug via OpenRouter -> "Opus 5"', () => {
    expect(formatModelLabel(`anthropic/${OPUS_5}`)).toBe('Opus 5');
  });
});

describe('Opus 5 — guard de thinking (evita 400 da API)', () => {
  it('thinking ENABLED + thinkingBudget -> envia { type: enabled } SEM budgetTokens', () => {
    const opts = buildOpts(makeConfig({ thinking: 'enabled', thinkingBudget: 16000 } as Partial<AgentQueryConfig>));
    expect(opts.thinking).toEqual({ type: 'enabled' });
  });

  it('thinking ENABLED sem budget -> { type: enabled } (inalterado)', () => {
    const opts = buildOpts(makeConfig({ thinking: 'enabled' } as Partial<AgentQueryConfig>));
    expect(opts.thinking).toEqual({ type: 'enabled' });
  });

  it('thinking DISABLED + effort max -> OMITE a chave thinking (adaptive default)', () => {
    const opts = buildOpts(makeConfig({ thinking: 'disabled', effort: 'max' } as Partial<AgentQueryConfig>));
    expect('thinking' in opts).toBe(false);
    expect(opts.effort).toBe('max');
  });

  it('thinking DISABLED + effort high -> { type: disabled } (permitido ate high)', () => {
    const opts = buildOpts(makeConfig({ thinking: 'disabled', effort: 'high' } as Partial<AgentQueryConfig>));
    expect(opts.thinking).toEqual({ type: 'disabled' });
  });

  it('thinking DISABLED + effort low -> { type: disabled }', () => {
    const opts = buildOpts(makeConfig({ thinking: 'disabled', effort: 'low' } as Partial<AgentQueryConfig>));
    expect(opts.thinking).toEqual({ type: 'disabled' });
  });

  it('effort HERDADO do chat como max tambem suprime o disabled', () => {
    const opts = buildOpts(makeConfig({ thinking: 'disabled', effort: 'low' } as Partial<AgentQueryConfig>), {
      inheritedEffort: { claude: 'max', codex: 'max' },
    } as Partial<AgentExecutionRequest>);
    expect('thinking' in opts).toBe(false);
    expect(opts.effort).toBe('max');
  });

  it('sem thinking configurado segue sem a chave', () => {
    const opts = buildOpts(makeConfig({ thinking: undefined } as Partial<AgentQueryConfig>));
    expect('thinking' in opts).toBe(false);
  });

  it('regressao: Opus 4.8 continua enviando budgetTokens (guard e SO do opus-5)', () => {
    const opts = buildOpts(
      makeConfig({
        model: 'claude-opus-4-8',
        thinking: 'enabled',
        thinkingBudget: 16000,
      } as Partial<AgentQueryConfig>),
    );
    expect(opts.thinking).toEqual({ type: 'enabled', budgetTokens: 16000 });
  });

  it('regressao: Opus 4.8 com disabled + max continua enviando { type: disabled }', () => {
    const opts = buildOpts(
      makeConfig({
        model: 'claude-opus-4-8',
        thinking: 'disabled',
        effort: 'max',
      } as Partial<AgentQueryConfig>),
    );
    expect(opts.thinking).toEqual({ type: 'disabled' });
  });
});
