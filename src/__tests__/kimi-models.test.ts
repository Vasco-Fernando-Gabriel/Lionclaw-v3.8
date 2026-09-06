import { describe, expect, it } from 'vitest';
import {
  filterManagedKimiModels,
  isManagedKimiSelectionUsable,
  KIMI_MODELS,
  KIMI_MODELS_BY_AUTH,
} from '@/constants/kimi-models';

describe('filterManagedKimiModels', () => {
  it('deriva o catalogo de assinatura da fonte canonica', () => {
    expect(KIMI_MODELS_BY_AUTH.subscription).toBe(KIMI_MODELS);
  });

  it('expoe somente modelos confirmados pelo provider managed', () => {
    expect(filterManagedKimiModels(['kimi-code/k3']).map((model) => model.slug))
      .toEqual(['kimi-code/k3']);
  });

  it('ignora aliases desconhecidos e bloqueia quando nenhum modelo foi confirmado', () => {
    expect(filterManagedKimiModels(['kimi-code/desconhecido'])).toEqual([]);
    expect(filterManagedKimiModels([])).toEqual([]);
  });

  it('libera a selecao somente quando o runtime e o modelo managed estao utilizaveis', () => {
    const status = { usable: true, availableModels: ['kimi-code/k3'] };
    expect(isManagedKimiSelectionUsable(status, 'kimi-code/k3')).toBe(true);
    expect(isManagedKimiSelectionUsable(status, 'kimi-code/kimi-for-coding')).toBe(false);
    expect(isManagedKimiSelectionUsable({ ...status, usable: false }, 'kimi-code/k3')).toBe(false);
    expect(isManagedKimiSelectionUsable(null, 'kimi-code/k3')).toBe(false);
  });
});
