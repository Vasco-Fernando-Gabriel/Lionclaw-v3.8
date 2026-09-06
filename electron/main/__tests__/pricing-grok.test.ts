import { describe, expect, it } from 'vitest';
import { calculateCost, getPricingSnapshot, hasKnownPricing } from '../pricing';

describe('pricing - Grok 4.5', () => {
  it('uses the published short-context prices', () => {
    expect(calculateCost('grok-4.5', 1_000_000, 1_000_000, 0, 0)).toBe(8);
    expect(calculateCost('grok-4.5', 1_000_000, 0, 1_000_000, 0)).toBe(0.5);
    expect(hasKnownPricing('grok-4.5')).toBe(true);
  });

  it('applies the long-context tier only above 200k per request', () => {
    expect(calculateCost('grok-4.5', 200_000, 100_000, 0, 0, 0, { perRequestInput: true }))
      .toBe(1);
    expect(calculateCost('grok-4.5', 200_001, 100_000, 0, 0, 0, { perRequestInput: true }))
      .toBeCloseTo(2.000004, 6);
  });

  it('publishes the 500k context pricing snapshot', () => {
    const snapshot = getPricingSnapshot('grok-4.5');
    expect(snapshot.entry).toMatchObject({
      input: 2,
      output: 6,
      cacheRead: 0.5,
      cacheCreation: 0,
      cacheCreationBilling: 'not-separately-reported',
      longContext: { thresholdTokens: 200_000, inputMultiplier: 2, outputMultiplier: 2 },
    });
  });
});
