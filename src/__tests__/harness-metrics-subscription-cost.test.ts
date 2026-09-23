import { describe, expect, it } from 'vitest';
import { formatHarnessCost } from '../components/harness/MetricsView';
import { formatHarnessRoundCost } from '../components/harness/RoundHistory';

describe('harness subscription-equivalent cost label', () => {
  it('usa til quando todo o valor e apenas equivalente PAYG', () => {
    expect(formatHarnessCost(4, 4)).toBe('~$4.00');
  });

  it('preserva o total direto e explicita a parcela equivalente quando misto', () => {
    expect(formatHarnessCost(10, 6.25)).toBe('$10.00 (incl. ~$6.25)');
  });

  it('mantem custo normal quando nao ha parcela de assinatura', () => {
    expect(formatHarnessCost(3, 0)).toBe('$3.00');
  });
});

describe('harness round cost quality', () => {
  it('nao converte round unknown em $0', () => {
    const value = formatHarnessRoundCost({
      coderCostUsd: 0,
      evaluatorCostUsd: 0,
      costStatus: 'unknown',
      subscriptionEquivalentCost: 0,
    });
    expect(value).toBe('Nao estimado');
    expect(value).not.toContain('$0');
  });

  it('mantem round conhecido de assinatura com til', () => {
    expect(
      formatHarnessRoundCost({
        coderCostUsd: 0.25,
        evaluatorCostUsd: 0,
        costStatus: 'known',
        subscriptionEquivalentCost: 0.25,
      }),
    ).toBe('~$0.250');
  });
});
