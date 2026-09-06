import { describe, expect, it } from 'vitest';

import { reconcileCloudCost } from '../agent-runtime/cloud-executor';

describe('reconcileCloudCost', () => {
  it('rejeita custo do SDK quando Opus 4.8 foi precificado como Opus legado', () => {
    const result = reconcileCloudCost({
      model: 'claude-opus-4-8',
      inputTokens: 30_754_040,
      outputTokens: 477_010,
      cacheReadTokens: 27_982_910,
      cacheCreationTokens: 2_748_181,
      totalCostUsd: 123.920573,
    });

    expect(result.costUsd).toBe(43.207581);
    expect(result.costSource).toBe('calculated');
    expect(result.sdkReportedCostUsd).toBe(123.920573);
    expect(result.reconciliationRelativeDelta).toBeGreaterThan(1.8);
  });

  it('preserva custo do SDK quando bate com a tabela canonica', () => {
    const result = reconcileCloudCost({
      model: 'claude-fable-5',
      inputTokens: 28_592_936,
      outputTokens: 620_024,
      cacheReadTokens: 25_303_792,
      cacheCreationTokens: 2_642_132,
      totalCostUsd: 88.199832,
    });

    expect(result.costUsd).toBe(88.199832);
    expect(result.costSource).toBe('sdk_total_cost_usd');
    expect(result.reconciliationRelativeDelta).toBeUndefined();
  });
});
