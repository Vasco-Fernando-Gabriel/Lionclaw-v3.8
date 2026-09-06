
import { describe, it, expect } from 'vitest';
import { calculateCost, hasKnownPricing } from '../pricing';

describe('pricing - Kimi native runtime entries (SPEC-011 §6.4)', () => {
  it('calculateCost(kimi-for-coding, ...) is strictly positive', () => {
    expect(calculateCost('kimi-for-coding', 1_000_000, 1_000_000)).toBeGreaterThan(0);
  });

  it('calculateCost(kimi-k2.7-code, ...) is strictly positive', () => {
    expect(calculateCost('kimi-k2.7-code', 1_000_000, 1_000_000)).toBeGreaterThan(0);
  });

  it('hasKnownPricing(kimi-for-coding) is true', () => {
    expect(hasKnownPricing('kimi-for-coding')).toBe(true);
  });

  it('hasKnownPricing(kimi-k2.7-code) is true', () => {
    expect(hasKnownPricing('kimi-k2.7-code')).toBe(true);
  });

  it('usa os valores oficiais exatos do Kimi K2.7 Code', () => {
    expect(calculateCost('kimi-k2.7-code', 1_000_000, 1_000_000, 0, 0)).toBe(4.95);
    expect(calculateCost('kimi-k2.7-code', 1_000_000, 0, 1_000_000, 0)).toBe(0.19);
    expect(calculateCost('kimi-for-coding', 1_000_000, 0, 1_000_000, 0)).toBe(0.19);
  });

  it('lookup is case-insensitive (lowercase normalization)', () => {
    expect(hasKnownPricing('Kimi-For-Coding')).toBe(true);
    expect(calculateCost('Kimi-For-Coding', 1_000_000, 1_000_000)).toBeGreaterThan(0);
    expect(hasKnownPricing('KIMI-K2.7-CODE')).toBe(true);
    expect(calculateCost('KIMI-K2.7-CODE', 1_000_000, 1_000_000)).toBeGreaterThan(0);
  });
});
