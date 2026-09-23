import { describe, it, expect } from 'vitest';
import { normalizeCost, type PricingHelpers, type RawCostReport } from '../dynamic-workflows/workflow-cost';

const fakePricing: PricingHelpers = {
  hasKnownPricing: (model) => {
    const m = model.toLowerCase();
    return m.includes('opus') || m.includes('sonnet') || m.includes('claude');
  },
  calculateCost: (model, input, output) => {
    const m = model.toLowerCase();
    if (m.includes('opus') || m.includes('sonnet') || m.includes('claude')) {
      return (input / 1_000_000) * 1 + (output / 1_000_000) * 2;
    }
    return 0;
  },
};

describe('workflow-cost: normalizeCost (secao 9 / AC-7)', () => {
  it('runtime local: known + $0 POR DEFINICAO, regra de unknown NAO se aplica', () => {
    const report: RawCostReport = {
      runtime: 'local',
      model: 'llama3-modelo-qualquer',
      inputTokens: 5000,
      outputTokens: 1000,
    };
    const out = normalizeCost(report, fakePricing);
    expect(out.costUsd).toBe(0);
    expect(out.costStatus).toBe('known');
    expect(out.costUnknownReason).toBeNull();
  });

  it('runtime local preserva o trio que o executor mandou', () => {
    const out = normalizeCost(
      {
        runtime: 'local',
        model: 'llama3',
        inputTokens: 10,
        costStatus: 'known',
        tokenStatus: 'exact',
      },
      fakePricing,
    );
    expect(out.tokenStatus).toBe('exact');
  });

  it('SM-16: carrega apiRequests/toolUses do executor (API e local)', () => {
    const api = normalizeCost(
      {
        runtime: 'cloud',
        model: 'claude-opus-4',
        inputTokens: 1000,
        outputTokens: 500,
        apiRequests: 3,
        toolUses: 7,
      },
      fakePricing,
    );
    expect(api.apiRequests).toBe(3);
    expect(api.toolUses).toBe(7);

    const local = normalizeCost({ runtime: 'local', model: 'llama3', apiRequests: 2, toolUses: 4 }, fakePricing);
    expect(local.apiRequests).toBe(2);
    expect(local.toolUses).toBe(4);
  });

  it('SM-16: apiRequests/toolUses omitidos normalizam para 0 (aditivo)', () => {
    const out = normalizeCost(
      { runtime: 'cloud', model: 'claude-opus-4', inputTokens: 1, outputTokens: 1 },
      fakePricing,
    );
    expect(out.apiRequests).toBe(0);
    expect(out.toolUses).toBe(0);
  });

  it('API runtime + pricing DESCONHECIDO + tokens>0 + executor omitiu -> unknown/unknown-pricing', () => {
    const report: RawCostReport = {
      runtime: 'zai',
      model: 'glm-4.6',
      inputTokens: 3000,
      outputTokens: 500,
    };
    const out = normalizeCost(report, fakePricing);
    expect(out.costUsd).toBe(0);
    expect(out.costStatus).toBe('unknown');
    expect(out.costUnknownReason).toBe('unknown-pricing');
  });

  it('API runtime + pricing CONHECIDO -> known com custo calculado', () => {
    const out = normalizeCost(
      { runtime: 'cloud', model: 'claude-opus-4', inputTokens: 1_000_000, outputTokens: 1_000_000 },
      fakePricing,
    );
    expect(out.costStatus).toBe('known');
    expect(out.costUsd).toBe(3);
    expect(out.costUnknownReason).toBeNull();
  });

  it('API runtime sem tokens (tokens=0) NAO vira unknown (sem uso reportado)', () => {
    const out = normalizeCost(
      { runtime: 'external', model: 'desconhecido-x', inputTokens: 0, outputTokens: 0 },
      fakePricing,
    );
    expect(out.costStatus).toBe('known');
    expect(out.costUnknownReason).toBeNull();
  });

  it('preserva o trio que o executor JA setou (normalizacao so preenche o omitido)', () => {
    const out = normalizeCost(
      {
        runtime: 'codex',
        model: 'gpt-x',
        inputTokens: 1000,
        costStatus: 'unknown',
        costUnknownReason: 'provider-not-reporting',
        tokenStatus: 'estimated',
      },
      fakePricing,
    );
    expect(out.costStatus).toBe('unknown');
    expect(out.costUnknownReason).toBe('provider-not-reporting');
    expect(out.tokenStatus).toBe('estimated');
  });

  it('usa o costUsd do executor quando presente (nao recalcula)', () => {
    const out = normalizeCost(
      {
        runtime: 'cloud',
        model: 'claude-sonnet',
        inputTokens: 1_000_000,
        outputTokens: 0,
        costUsd: 99.5,
      },
      fakePricing,
    );
    expect(out.costUsd).toBe(99.5);
  });
});
