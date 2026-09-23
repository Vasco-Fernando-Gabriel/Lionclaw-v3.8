import { describe, it, expect, vi, beforeEach } from 'vitest';

const saveCalls: Array<Record<string, unknown>> = [];
let persistedRows: Array<Record<string, unknown>> = [];

vi.mock('../db', () => ({
  getPipelinePhaseMetricsRows: () => persistedRows,
  savePipelinePhaseMetrics: (data: Record<string, unknown>) => {
    saveCalls.push(data);
    return 1;
  },
}));

vi.mock('../pipeline-shared/ipc-emitter', () => ({
  emitIPC: vi.fn(),
}));

import {
  accumulateMetrics,
  flushAccumulatedMetrics,
  collectMetrics,
  mergeUsageMetadata,
  type MetricsPhaseState,
  type MetricsSpawnResult,
} from '../pipeline-engine/metrics';
import type { SprintMetrics } from '../harness-engine';

function makeResult(overrides?: { metadata?: MetricsSpawnResult['metadata']; costUsd?: number }): MetricsSpawnResult {
  return {
    metrics: {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: 1,
      apiRequests: 1,
      costUsd: overrides?.costUsd ?? 0.1,
      durationMs: 1_000,
    },
    model: 'claude-opus-4-8',
    runtime: 'cloud',
    provider: 'anthropic',
    ...(overrides?.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  };
}

function makeState(): MetricsPhaseState {
  return { projectId: 'proj-1', phaseMetricAccum: new Map() };
}

beforeEach(() => {
  saveCalls.length = 0;
  persistedRows = [];
});

describe('accumulateMetrics: BUG 3 F1 — uniao de sessionIds entre rounds', () => {
  it('acumula a UNIAO dedupada, nunca last-write-wins', () => {
    const state = makeState();
    accumulateMetrics(state, 5, makeResult({ metadata: { sessionIds: ['s-1'] } }));
    accumulateMetrics(state, 5, makeResult({ metadata: { sessionIds: ['s-2', 's-1'] } }));
    accumulateMetrics(state, 5, makeResult({}));

    const accum = state.phaseMetricAccum.get(5);
    expect(accum?.sessionIds).toEqual(['s-1', 's-2']);
  });

  it('soma modelUsage por modelo entre rounds e carrega costSource/pricingSnapshot do mais recente', () => {
    const state = makeState();
    const mu = (cost: number) => ({
      'claude-opus-4-8': {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 0,
        costUSD: cost,
      },
    });
    accumulateMetrics(
      state,
      5,
      makeResult({
        metadata: { modelUsage: mu(1.0), costSource: 'calculated' },
      }),
    );
    accumulateMetrics(
      state,
      5,
      makeResult({
        metadata: { modelUsage: mu(0.5), costSource: 'sdk_total_cost_usd' },
      }),
    );

    const accum = state.phaseMetricAccum.get(5);
    expect(accum?.modelUsage?.['claude-opus-4-8']).toEqual({
      inputTokens: 200,
      outputTokens: 20,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 0,
      costUSD: 1.5,
    });
    expect(accum?.costSource).toBe('sdk_total_cost_usd');
  });

  it('soma breakdown estendido e metadata Grok entre rounds', () => {
    const state = makeState();
    const usage = (reasoningTokens: number, modelCalls: number, costUsdTicks: number) => ({
      'grok-4.5': {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: costUsdTicks / 1_000_000_000,
        reasoningTokens,
        modelCalls,
        costUsdTicks,
      },
    });
    accumulateMetrics(
      state,
      5,
      makeResult({
        metadata: {
          modelUsage: usage(3, 1, 100),
          grok: { reasoningTokens: 3, modelCalls: 1, costUsdTicks: 100, requestId: 'r-1' },
        },
      }),
    );
    accumulateMetrics(
      state,
      5,
      makeResult({
        metadata: {
          modelUsage: usage(4, 2, 250),
          grok: { reasoningTokens: 4, modelCalls: 2, costUsdTicks: 250, requestId: 'r-2' },
        },
      }),
    );

    expect(state.phaseMetricAccum.get(5)?.modelUsage?.['grok-4.5']).toMatchObject({
      reasoningTokens: 7,
      modelCalls: 3,
      costUsdTicks: 350,
    });
    expect(state.phaseMetricAccum.get(5)?.grok).toMatchObject({
      reasoningTokens: 7,
      modelCalls: 3,
      costUsdTicks: 350,
      requestId: 'r-2',
    });
  });
});

describe('flushAccumulatedMetrics: metadata chega ao save', () => {
  it('persiste sessionIds/costSource/pricingSnapshot/modelUsage no metadata', () => {
    const state = makeState();
    const pricingSnapshot = {
      pricingVersion: '2026-07-10',
      model: 'glm-4.7',
      entry: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheCreation: 0.6 },
    };
    accumulateMetrics(
      state,
      7,
      makeResult({
        metadata: { sessionIds: ['s-a', 's-b'], costSource: 'calculated', pricingSnapshot },
      }),
    );

    flushAccumulatedMetrics('proj-1', 7, 'agent-x', state, 'completed');

    expect(saveCalls).toHaveLength(1);
    const meta = saveCalls[0].metadata as Record<string, unknown>;
    expect(meta.sessionIds).toEqual(['s-a', 's-b']);
    expect(meta.costSource).toBe('calculated');
    expect(meta.pricingSnapshot).toEqual(pricingSnapshot);
    expect(state.phaseMetricAccum.has(7)).toBe(false);
  });

  it('persiste metadata Grok agregada', () => {
    const state = makeState();
    accumulateMetrics(
      state,
      7,
      makeResult({
        metadata: {
          grok: { reasoningTokens: 5, modelCalls: 1, costUsdTicks: 900 },
        },
      }),
    );

    flushAccumulatedMetrics('proj-1', 7, 'agent-x', state, 'completed');

    expect((saveCalls[0].metadata as Record<string, unknown>).grok).toEqual({
      reasoningTokens: 5,
      modelCalls: 1,
      costUsdTicks: 900,
    });
  });

  it('soma a metrica automatica persistida antes de concluir a revisao conversacional', () => {
    persistedRows = [
      {
        phaseNumber: 91,
        sprintIndex: -1,
        inputTokens: 300,
        outputTokens: 30,
        cacheReadTokens: 200,
        cacheCreationTokens: 50,
        costUsd: 0.3,
        durationMs: 3_000,
        toolUses: 3,
        apiRequests: 3,
        metadata: { sessionIds: ['auto-session'] },
      },
    ];
    const state = makeState();
    accumulateMetrics(state, 91, makeResult({ metadata: { sessionIds: ['review-session'] } }));

    flushAccumulatedMetrics('proj-1', 91, 'spec-validator', state, 'completed', undefined, true);

    expect(saveCalls[0]).toMatchObject({
      inputTokens: 400,
      outputTokens: 40,
      cacheReadTokens: 200,
      cacheCreationTokens: 50,
      costUsd: 0.4,
      durationMs: 4_000,
      toolUses: 4,
      apiRequests: 4,
      metadata: { sessionIds: ['review-session', 'auto-session'] },
    });
  });
});

describe('collectMetrics (single-shot): metadata chega ao save', () => {
  it('persiste sessionIds/costSource e nao inventa campos ausentes', () => {
    collectMetrics(
      'proj-1',
      3,
      'agent-y',
      makeResult({
        metadata: { sessionIds: ['s-z'], costSource: 'sdk_total_cost_usd' },
      }),
      'completed',
    );

    expect(saveCalls).toHaveLength(1);
    const meta = saveCalls[0].metadata as Record<string, unknown>;
    expect(meta.sessionIds).toEqual(['s-z']);
    expect(meta.costSource).toBe('sdk_total_cost_usd');
    expect(meta).not.toHaveProperty('pricingSnapshot');
    expect(meta).not.toHaveProperty('modelUsage');
  });

  it('result sem metadata novo mantem o shape antigo do metadata (so provider)', () => {
    collectMetrics('proj-1', 3, 'agent-y', makeResult({}), 'completed');

    const meta = saveCalls[0].metadata as Record<string, unknown>;
    expect(meta.provider).toBe('anthropic');
    expect(meta).not.toHaveProperty('sessionIds');
    expect(meta).not.toHaveProperty('costSource');
  });
});

describe('mergeUsageMetadata: agregado de SPRINT (fases 13/14) usa a mesma espinha', () => {
  function makeSprintAgg(): SprintMetrics {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
      durationMs: 0,
      toolUses: 0,
      apiRequests: 0,
      model: null,
      runtime: null,
    };
  }

  it('uniao dedupada de sessionIds entre rounds do sprint; round sem metadata nao apaga', () => {
    const agg = makeSprintAgg();
    mergeUsageMetadata(agg, { sessionIds: ['s-1'] });
    mergeUsageMetadata(agg, { sessionIds: ['s-2', 's-1'] });
    mergeUsageMetadata(agg, undefined);

    expect(agg.sessionIds).toEqual(['s-1', 's-2']);
  });

  it('soma modelUsage por modelo e carrega costSource/pricingSnapshot do round mais recente', () => {
    const agg = makeSprintAgg();
    const mu = (cost: number) => ({
      'claude-opus-4-8': {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 0,
        costUSD: cost,
      },
    });
    const pricingSnapshot = {
      pricingVersion: '2026-07-10',
      model: 'glm-4.7',
      entry: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheCreation: 0.6 },
    };
    mergeUsageMetadata(agg, { modelUsage: mu(1.0), costSource: 'calculated' });
    mergeUsageMetadata(agg, { modelUsage: mu(0.5), costSource: 'sdk_total_cost_usd', pricingSnapshot });

    expect(agg.modelUsage?.['claude-opus-4-8']).toEqual({
      inputTokens: 200,
      outputTokens: 20,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 0,
      costUSD: 1.5,
    });
    expect(agg.costSource).toBe('sdk_total_cost_usd');
    expect(agg.pricingSnapshot).toEqual(pricingSnapshot);
  });

  it('sessionIds vazio nao cria a chave (o save das fases 13/14 so espalha quando ha ids)', () => {
    const agg = makeSprintAgg();
    mergeUsageMetadata(agg, { sessionIds: [] });

    expect(agg.sessionIds).toBeUndefined();
  });
});
