import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

vi.mock('../db', () => ({ getSetting: vi.fn(() => null) }));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(async () => null) }));

import {
  windowLabel,
  codexWindow,
  glmWindow,
  minimaxUsedPercent,
  parseKimiUsages,
  withStaleFallback,
  resetUsageLimitsCache,
} from '../provider-usage-limits';
import type { ProviderUsageLimits } from '../../../src/types';

beforeEach(() => {
  resetUsageLimitsCache();
});

describe('windowLabel', () => {
  it('10080 min = Semanal; 300 min = 5 horas; 60 = 1 hora; 90 = 90 min; null = fallback', () => {
    expect(windowLabel(10_080, 'x')).toBe('Semanal');
    expect(windowLabel(300, 'x')).toBe('5 horas');
    expect(windowLabel(60, 'x')).toBe('1 hora');
    expect(windowLabel(90, 'x')).toBe('90 min');
    expect(windowLabel(null, 'fallback')).toBe('fallback');
  });
});

describe('codexWindow', () => {
  it('converte janela com used_percent e clampa 0..100', () => {
    const w = codexWindow('primary', '5 horas', {
      used_percent: 120,
      window_minutes: 10_080,
      resets_at: 1_754_600_000,
    });
    expect(w).toMatchObject({ id: 'primary', label: 'Semanal', usedPercent: 100 });
    expect(w?.resetsAt).toMatch(/^\d{4}-/);
  });

  it('descarta janela sem used_percent numerico', () => {
    expect(codexWindow('primary', '5 horas', { used_percent: 'muito' })).toBeNull();
    expect(codexWindow('primary', '5 horas', undefined)).toBeNull();
  });
});

describe('glmWindow', () => {
  it('reconhece 5h (unit=3/number=5) e semanal (unit=6/number=1) de TOKENS_LIMIT', () => {
    expect(glmWindow({ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42 })).toMatchObject({
      id: 'five_hour',
      label: '5 horas',
      usedPercent: 42,
    });
    expect(glmWindow({ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 7 })).toMatchObject({
      id: 'seven_day',
      label: 'Semanal',
      usedPercent: 7,
    });
  });

  it('descarta tipos/unidades desconhecidos', () => {
    expect(glmWindow({ type: 'REQUESTS_LIMIT', unit: 3, number: 5, percentage: 1 })).toBeNull();
    expect(glmWindow({ type: 'TOKENS_LIMIT', unit: 9, number: 9, percentage: 1 })).toBeNull();
  });
});

describe('minimaxUsedPercent', () => {
  it('pior caso entre modelos PROVISIONADOS (total > 0), invertendo restante -> usado', () => {
    const entries = [
      { current_weekly_total_count: 100, current_weekly_remaining_percent: 80 }, // 20 usado
      { current_weekly_total_count: 100, current_weekly_remaining_percent: 30 }, // 70 usado
      { current_weekly_total_count: 0, current_weekly_remaining_percent: 1 }, // nao provisionado
    ];
    expect(minimaxUsedPercent(entries, 'current_weekly_remaining_percent', 'current_weekly_total_count')).toBe(70);
  });

  it('sem provisionados, pior caso entre todos; sem valores, null', () => {
    const entries = [{ current_weekly_total_count: 0, current_weekly_remaining_percent: 55 }];
    expect(minimaxUsedPercent(entries, 'current_weekly_remaining_percent', 'current_weekly_total_count')).toBe(45);
    expect(minimaxUsedPercent([], 'current_weekly_remaining_percent', 'current_weekly_total_count')).toBeNull();
  });
});

describe('parseKimiUsages', () => {
  it('quota semanal (valores STRING) + janelas por duracao + plano LEVEL_X', () => {
    const { windows, planType } = parseKimiUsages({
      usage: { limit: '1000', used: '200', resetTime: '2026-08-15T00:00:00Z' },
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '50', used: '10', resetTime: '2026-08-08T22:00:00Z' },
        },
      ],
      user: { membership: { level: 'LEVEL_MODERATO' } },
    });
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ id: 'subscription', label: 'Semanal', usedPercent: 20 });
    expect(windows[1]).toMatchObject({ label: '5 horas', usedPercent: 20 });
    expect(planType).toBe('moderato');
  });

  it('payload vazio -> zero janelas e plano null', () => {
    const { windows, planType } = parseKimiUsages({});
    expect(windows).toHaveLength(0);
    expect(planType).toBeNull();
  });
});

describe('withStaleFallback', () => {
  const ok: ProviderUsageLimits = {
    provider: 'glm',
    status: 'ok',
    windows: [{ id: 'seven_day', label: 'Semanal', usedPercent: 10, resetsAt: null }],
  };
  const down: ProviderUsageLimits = {
    provider: 'glm',
    status: 'unavailable',
    reason: '429',
    windows: [],
  };

  it('unavailable transitorio serve o ultimo snapshot OK recente', () => {
    const t0 = 1_000_000;
    expect(withStaleFallback(ok, t0)).toBe(ok);
    expect(withStaleFallback(down, t0 + 60_000)).toBe(ok);
  });

  it('stale velho demais (>30min) volta a reportar unavailable', () => {
    const t0 = 1_000_000;
    withStaleFallback(ok, t0);
    expect(withStaleFallback(down, t0 + 31 * 60_000)).toBe(down);
  });
});
