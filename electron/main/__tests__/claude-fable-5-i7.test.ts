
import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { CLAUDE_MODELS, CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';
import { formatModelLabel } from '../../../src/utils/model-display';
import { MODEL_PRICING, calculateCost, hasKnownPricing } from '../pricing';
import { buildClaudeQueryOptions } from '../agent-runtime/cloud-executor';
import { PERM_BYPASS_NO_GUARD } from '../agent-runtime/permission-profiles';
import type { AgentExecutionRequest, AgentPermissionProfile } from '../agent-runtime/types';
import type { AgentQueryConfig } from '../agent-config-resolver';


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
    model: 'claude-fable-5',
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

function buildOpts(config: AgentQueryConfig): Record<string, unknown> {
  return buildClaudeQueryOptions(makeReq(), config, '/path/to/cli.js', new AbortController());
}


describe('I7 — catalogo CLAUDE_MODELS', () => {
  it('contem claude-fable-5-1 com displayName "Claude Fable 5.1" (campo displayName, nao label — W2)', () => {
    const fable = CLAUDE_MODELS.find((m) => m.id === 'claude-fable-5-1');
    expect(fable).toBeDefined();
    expect(fable?.displayName).toBe('Claude Fable 5.1');
    expect('label' in (fable as object)).toBe(false);
  });

  it('claude-fable-5-1 esta no TOPO da lista (mais recente primeiro)', () => {
    expect(CLAUDE_MODELS[0].id).toBe('claude-fable-5-1');
  });

  it('claude-fable-5 SAIU do catalogo (substituido pelo 5.1; migration V148 promove quem estava nele)', () => {
    expect(CLAUDE_MODELS.some((m) => m.id === 'claude-fable-5')).toBe(false);
  });

  it('CLAUDE_DEFAULT_MODEL e o Opus atual (bump deliberado 2026-07-24; I7 segue aditivo)', () => {
    expect(CLAUDE_DEFAULT_MODEL).toBe('claude-opus-5');
  });

  it('regressao: modelos existentes continuam no catalogo', () => {
    const ids = CLAUDE_MODELS.map((m) => m.id);
    expect(ids).toContain('claude-opus-4-8');
    expect(ids).toContain('claude-opus-4-7');
    expect(ids).toContain('claude-sonnet-4-6');
    expect(ids).toContain('claude-haiku-4-5-20251001');
  });
});


describe('I7 — formatModelLabel reconhece fable', () => {
  it('claude-fable-5-1 -> "Fable 5.1" (nunca o id cru)', () => {
    expect(formatModelLabel('claude-fable-5-1')).toBe('Fable 5.1');
  });

  it('claude-fable-5 (legado) -> "Fable 5"', () => {
    expect(formatModelLabel('claude-fable-5')).toBe('Fable 5');
  });

  it('regressao: labels dos modelos existentes inalterados', () => {
    expect(formatModelLabel('claude-opus-4-8')).toBe('Opus 4.8');
    expect(formatModelLabel('claude-opus-4-7')).toBe('Opus 4.7');
    expect(formatModelLabel('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(formatModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(formatModelLabel('anthropic/claude-opus-4-8')).toBe('Opus 4.8');
    expect(formatModelLabel('gpt-5.5')).toBe('GPT 5.5');
  });
});


describe('I7 — pricing explicito do claude-fable-5', () => {
  it('MODEL_PRICING tem a entrada explicita 10/50/1/12.50 (V1)', () => {
    expect(MODEL_PRICING['claude-fable-5']).toEqual({
      input: 10.0,
      output: 50.0,
      cacheRead: 1.0,
      cacheCreation: 12.5,
    });
  });

  it('calculateCost com tokens conhecidos (sem cache): 1M in + 1M out = $60', () => {
    expect(calculateCost('claude-fable-5', 1_000_000, 1_000_000)).toBe(60);
  });

  it('calculateCost com cache: 1M puro + 1M cacheRead + 1M cacheCreation + 1M out = $73.50', () => {
    expect(
      calculateCost('claude-fable-5', 3_000_000, 1_000_000, 1_000_000, 1_000_000),
    ).toBe(73.5);
  });

  it('custo nunca e $0 silencioso: hasKnownPricing true e custo > 0 (I7-AC2)', () => {
    expect(hasKnownPricing('claude-fable-5')).toBe(true);
    expect(calculateCost('claude-fable-5', 1000, 1000)).toBeGreaterThan(0);
  });

  it('NAO cai no fallback por keyword (sonnet): preco difere do sonnet', () => {
    const fableCost = calculateCost('claude-fable-5', 1_000_000, 1_000_000);
    const sonnetCost = calculateCost('claude-sonnet-4-6', 1_000_000, 1_000_000);
    expect(fableCost).not.toBe(sonnetCost);
    expect(fableCost).toBe(60);
  });

  it('regressao: custo dos modelos existentes inalterado', () => {
    expect(calculateCost('claude-opus-4-8', 1_000_000, 1_000_000)).toBe(30);
    expect(calculateCost('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBe(18);
    expect(calculateCost('claude-haiku-4-5-20251001', 1_000_000, 1_000_000)).toBe(6);
  });
});


describe('I7 — guard de thinking para claude-fable-* no cloud-executor', () => {
  it('thinking ENABLED + claude-fable-5 -> request SEM a chave thinking', () => {
    const opts = buildOpts(
      makeConfig({ model: 'claude-fable-5', thinking: 'enabled', thinkingBudget: 8000 } as Partial<AgentQueryConfig>),
    );
    expect('thinking' in opts).toBe(false);
  });

  it('thinking DISABLED + claude-fable-5 -> request SEM a chave thinking', () => {
    const opts = buildOpts(
      makeConfig({ model: 'claude-fable-5', thinking: 'disabled' } as Partial<AgentQueryConfig>),
    );
    expect('thinking' in opts).toBe(false);
  });

  it('guard cobre a FAMILIA claude-fable-* (ids futuros com sufixo)', () => {
    const opts = buildOpts(
      makeConfig({ model: 'claude-fable-5-20260601', thinking: 'enabled' } as Partial<AgentQueryConfig>),
    );
    expect('thinking' in opts).toBe(false);
  });

  it('fable: effort continua passando normalmente (so thinking e suprimido)', () => {
    const opts = buildOpts(
      makeConfig({ model: 'claude-fable-5', thinking: 'enabled', effort: 'high' } as Partial<AgentQueryConfig>),
    );
    expect(opts.effort).toBe('high');
    expect('thinking' in opts).toBe(false);
    expect(opts.model).toBe('claude-fable-5');
  });

  it('regressao: modelo nao-fable com thinking enabled continua enviando thinking + budget', () => {
    const opts = buildOpts(
      makeConfig({ model: 'claude-opus-4-7', thinking: 'enabled', thinkingBudget: 16000 } as Partial<AgentQueryConfig>),
    );
    expect(opts.thinking).toEqual({ type: 'enabled', budgetTokens: 16000 });
  });

  it('regressao: modelo nao-fable com thinking disabled continua enviando { type: disabled }', () => {
    const opts = buildOpts(
      makeConfig({ model: 'claude-sonnet-4-6', thinking: 'disabled' } as Partial<AgentQueryConfig>),
    );
    expect(opts.thinking).toEqual({ type: 'disabled' });
  });

  it('regressao: modelo nao-fable sem thinking configurado segue sem a chave', () => {
    const opts = buildOpts(
      makeConfig({ model: 'claude-opus-4-8', thinking: undefined } as Partial<AgentQueryConfig>),
    );
    expect('thinking' in opts).toBe(false);
  });
});
