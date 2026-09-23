import { describe, it, expect } from 'vitest';
import type { SprintMetrics } from '../harness-engine';

function buildCoderPhaseMetadata(
  sprintIndex: number,
  sprintName: string,
  coderMetrics: SprintMetrics,
): Record<string, unknown> {
  return {
    sprintIndex,
    sprintName,
    ...(coderMetrics.provider !== undefined && { provider: coderMetrics.provider }),
    ...(coderMetrics.costEstimationKind !== undefined && { costEstimationKind: coderMetrics.costEstimationKind }),
  };
}

function buildEvaluatorPhaseMetadata(
  sprintIndex: number,
  sprintName: string,
  evaluatorMetrics: SprintMetrics,
): Record<string, unknown> {
  return {
    sprintIndex,
    sprintName,
    ...(evaluatorMetrics.provider !== undefined && { provider: evaluatorMetrics.provider }),
    ...(evaluatorMetrics.costEstimationKind !== undefined && {
      costEstimationKind: evaluatorMetrics.costEstimationKind,
    }),
  };
}

describe('pipeline-engine fases agregadas - SPEC-006 Sprint 3 metadata', () => {
  const baseMetrics: SprintMetrics = {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 75,
    cacheCreationTokens: 25,
    cacheTokens: 100,
    costUsd: 0.05,
    durationMs: 5000,
    toolUses: 3,
    apiRequests: 1,
    model: 'MiniMax-M2.7',
    runtime: 'minimax-tp',
  };

  it('Coder: metadata contem provider quando coderMetrics.provider definido', () => {
    const coderMetrics: SprintMetrics = {
      ...baseMetrics,
      provider: 'minimax',
      costEstimationKind: 'subscription-equivalent-payg',
    };

    const metadata = buildCoderPhaseMetadata(0, 'Sprint 1', coderMetrics);

    expect(metadata.provider).toBe('minimax');
    expect(metadata.costEstimationKind).toBe('subscription-equivalent-payg');
    expect(metadata.sprintIndex).toBe(0);
    expect(metadata.sprintName).toBe('Sprint 1');
  });

  it('Evaluator: metadata contem provider quando evaluatorMetrics.provider definido', () => {
    const evaluatorMetrics: SprintMetrics = {
      ...baseMetrics,
      provider: 'minimax',
      costEstimationKind: 'subscription-equivalent-payg',
    };

    const metadata = buildEvaluatorPhaseMetadata(0, 'Sprint 1', evaluatorMetrics);

    expect(metadata.provider).toBe('minimax');
    expect(metadata.costEstimationKind).toBe('subscription-equivalent-payg');
  });

  it('Coder: metadata NAO contem provider quando coderMetrics.provider undefined (runtime cloud)', () => {
    const cloudMetrics: SprintMetrics = {
      ...baseMetrics,
      runtime: 'cloud',
    };

    const metadata = buildCoderPhaseMetadata(0, 'Sprint 1', cloudMetrics);

    expect(metadata.provider).toBeUndefined();
    expect(metadata.costEstimationKind).toBeUndefined();
    expect(metadata.sprintIndex).toBe(0);
    expect(metadata.sprintName).toBe('Sprint 1');
  });

  it('Evaluator: metadata NAO contem costEstimationKind quando undefined', () => {
    const cloudMetrics: SprintMetrics = {
      ...baseMetrics,
      runtime: 'cloud',
    };

    const metadata = buildEvaluatorPhaseMetadata(1, 'Sprint 2', cloudMetrics);

    expect(metadata.costEstimationKind).toBeUndefined();
    expect(metadata.sprintIndex).toBe(1);
  });

  it('snapshot completo do payload Coder com minimax-tp', () => {
    const coderMetrics: SprintMetrics = {
      ...baseMetrics,
      provider: 'minimax',
      costEstimationKind: 'subscription-equivalent-payg',
    };

    const metadata = buildCoderPhaseMetadata(2, 'Sprint 3: UI Components', coderMetrics);

    expect(metadata).toEqual({
      sprintIndex: 2,
      sprintName: 'Sprint 3: UI Components',
      provider: 'minimax',
      costEstimationKind: 'subscription-equivalent-payg',
    });
  });

  it('snapshot completo do payload Evaluator com minimax-tp', () => {
    const evaluatorMetrics: SprintMetrics = {
      ...baseMetrics,
      provider: 'minimax',
      costEstimationKind: 'subscription-equivalent-payg',
    };

    const metadata = buildEvaluatorPhaseMetadata(2, 'Sprint 3: UI Components', evaluatorMetrics);

    expect(metadata).toEqual({
      sprintIndex: 2,
      sprintName: 'Sprint 3: UI Components',
      provider: 'minimax',
      costEstimationKind: 'subscription-equivalent-payg',
    });
  });
});
