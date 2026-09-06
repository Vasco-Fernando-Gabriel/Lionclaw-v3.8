
import { describe, it, expect } from 'vitest';
import { formatCostWithMeta } from '../components/pipeline/PipelineMetricsReport';

describe('formatCostWithMeta - SPEC-006 Sprint 3 costEstimationKind', () => {
  it('sem flag: retorna formato padrao $X.YYYY', () => {
    expect(formatCostWithMeta(0.05, {})).toBe('$0.050');
  });

  it('sem flag com undefined metadata: retorna formato padrao', () => {
    expect(formatCostWithMeta(0.05, undefined)).toBe('$0.050');
  });

  it('com costEstimationKind=subscription-equivalent-payg: retorna ~$X.YYYY (est. PAYG)', () => {
    const result = formatCostWithMeta(0.05, { costEstimationKind: 'subscription-equivalent-payg' });
    expect(result).toBe('~$0.050 (est. PAYG)');
  });

  it('costStatus unknown sobrescreve costEstimationKind', () => {
    const result = formatCostWithMeta(0.05, {
      costStatus: 'unknown',
      costEstimationKind: 'subscription-equivalent-payg',
    });
    expect(result).toBe('Custo nao estimado');
  });

  it('zero com flag: retorna ~$0.00 (est. PAYG)', () => {
    const result = formatCostWithMeta(0, { costEstimationKind: 'subscription-equivalent-payg' });
    expect(result).toBe('~$0.00 (est. PAYG)');
  });

  it('valor pequeno <0.001 com flag: retorna ~<$0.001 (est. PAYG)', () => {
    const result = formatCostWithMeta(0.0005, { costEstimationKind: 'subscription-equivalent-payg' });
    expect(result).toBe('~<$0.001 (est. PAYG)');
  });

  it('costEstimationKind de outro tipo nao afeta formatacao', () => {
    const result = formatCostWithMeta(0.05, { costEstimationKind: 'other-type' });
    expect(result).toBe('$0.050');
  });
});
