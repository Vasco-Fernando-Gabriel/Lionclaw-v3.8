import { describe, expect, it } from 'vitest';

import { totalTokensFromInclusiveInput } from '../PipelineMetricsReport';

describe('totalTokensFromInclusiveInput', () => {
  it('nao soma cache novamente porque inputTokens ja inclui cache', () => {
    expect(totalTokensFromInclusiveInput(28_568_112, 462_816)).toBe(29_030_928);
  });
});
