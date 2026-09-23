import { describe, expect, it } from 'vitest';
import { resolveTokenCounterCostDisplay, shouldShowCompactionBadge } from '../TokenCounter';

function resolveCostDisplay(
  costUsd: number | null | undefined,
  costEstimationKind?: 'subscription-equivalent-payg',
): string | null {
  return resolveTokenCounterCostDisplay(costUsd, undefined, costEstimationKind);
}

describe('TokenCounter costUsd display logic', () => {
  it('costUsd === null -> omite custo (null)', () => {
    expect(resolveCostDisplay(null)).toMatchSnapshot();
  });

  it('costUsd === undefined -> omite custo (null)', () => {
    expect(resolveCostDisplay(undefined)).toMatchSnapshot();
  });

  it('costUsd === 0 -> "Local · $0"', () => {
    expect(resolveCostDisplay(0)).toMatchSnapshot();
  });

  it('subscription-equivalent-payg zero -> "~$0.000"', () => {
    expect(resolveCostDisplay(0, 'subscription-equivalent-payg')).toBe('~$0.000');
  });

  it('subscription-equivalent-payg positivo sempre comeca com "~$"', () => {
    expect(resolveCostDisplay(0.0005, 'subscription-equivalent-payg')).toBe('~$<0.001');
    expect(resolveCostDisplay(0.0523, 'subscription-equivalent-payg')).toBe('~$0.052');
  });

  it('costUsd muito pequeno (< 0.001) -> "<$0.001"', () => {
    expect(resolveCostDisplay(0.0005)).toMatchSnapshot();
  });

  it('costUsd pequeno (0.001 <= x < 0.01) -> "~$0.XXXX"', () => {
    expect(resolveCostDisplay(0.0045)).toMatchSnapshot();
  });

  it('costUsd normal (>= 0.01) -> "~$X.XXX"', () => {
    expect(resolveCostDisplay(0.0523)).toMatchSnapshot();
  });

  it('costUsd grande -> "~$X.XXX"', () => {
    expect(resolveCostDisplay(1.25)).toMatchSnapshot();
  });

  it('estimated-partial usa um unico marcador em custos positivos', () => {
    expect(resolveTokenCounterCostDisplay(0.0045, 'estimated-partial')).toBe('~$0.0045');
    expect(resolveTokenCounterCostDisplay(0.0523, 'estimated-partial')).toBe('~$0.052');
  });

  it('estimated-partial muito pequeno preserva o limite sem til extra', () => {
    expect(resolveTokenCounterCostDisplay(0.0005, 'estimated-partial')).toBe('<$0.001');
  });

  it('estimateCost removido: prop costUsd controla display (sem fallback hardcoded)', () => {
    expect(resolveCostDisplay(undefined)).toBeNull();
  });
});

describe('shouldShowCompactionBadge (SPEC-008 §13.5 — discrimina origem)', () => {
  it("('lionclaw', 'GLM-4.6') -> true (badge da compactacao propria do LionClaw)", () => {
    expect(shouldShowCompactionBadge('lionclaw', 'GLM-4.6')).toBe(true);
  });

  it("('sdk', 'GLM-4.6') -> false (compactacao nativa do SDK nunca tem badge)", () => {
    expect(shouldShowCompactionBadge('sdk', 'GLM-4.6')).toBe(false);
  });

  it("('lionclaw', '') -> false (sem label ainda)", () => {
    expect(shouldShowCompactionBadge('lionclaw', '')).toBe(false);
  });

  it("(null, 'GLM-4.6') -> false (sem origem)", () => {
    expect(shouldShowCompactionBadge(null, 'GLM-4.6')).toBe(false);
  });

  it('(undefined, undefined) -> false (estado default)', () => {
    expect(shouldShowCompactionBadge(undefined, undefined)).toBe(false);
  });
});

describe('TokenCounter props contract', () => {
  it('props basicas do componente sao verificadas por shape', () => {
    const propsShape = {
      inputTokens: 'number',
      outputTokens: 'number',
      cacheReadTokens: 'number | undefined',
      cacheCreationTokens: 'number | undefined',
      isStreaming: 'boolean',
      isCompacting: 'boolean | undefined',
      contextTokens: 'number | undefined',
      contextWindowTokens: 'number | undefined',
      compactionThresholdPercent: 'number | undefined',
      contextSource: "'estimate' | 'provider' | undefined",
      costUsd: 'number | null | undefined', // nova prop S6.6
    };
    expect(propsShape).toMatchSnapshot();
  });
});
