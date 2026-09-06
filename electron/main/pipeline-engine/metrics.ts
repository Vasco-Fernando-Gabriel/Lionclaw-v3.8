
import { emitIPC } from '../pipeline-shared/ipc-emitter';
import { getPipelinePhaseMetricsRows, savePipelinePhaseMetrics } from '../db';
import { getPhaseName, PHASE_NAMES } from './registry';
import type { AgentConfig } from '../../../src/types';

export interface MetricsSpawnResult {
  metrics: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    toolUses: number;
    apiRequests: number;
    costUsd: number;
    durationMs: number;
    costStatus?: 'known' | 'unknown' | 'estimated-partial';
    tokenStatus?: 'reported' | 'not_reported';
    costUnknownReason?: 'unknown-pricing' | 'no-usage-reported';
  };
  model: string;
  runtime: AgentConfig['runtime'];
  provider: string;
  metadata?: {
    costEstimationKind?: 'subscription-equivalent-payg';
    sessionIds?: string[];
    costSource?:
      | 'sdk_total_cost_usd'
      | 'sdk_model_usage'
      | 'calculated'
      | 'provider-reported-equivalent';
    pricingSnapshot?: {
      pricingVersion: string;
      model: string;
      entry: {
        input: number;
        output: number;
        cacheRead: number;
        cacheCreation: number;
        longContext?: { thresholdTokens: number; inputMultiplier: number; outputMultiplier: number };
      } | null;
    };
    modelUsage?: Record<string, {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      costUSD: number;
      reasoningTokens?: number;
      modelCalls?: number;
      costUsdTicks?: number;
    }>;
    grok?: {
      reasoningTokens?: number;
      modelCalls?: number;
      apiDurationMs?: number;
      numTurns?: number;
      costUsdTicks?: number;
      requestId?: string;
    };
  };
}

export type AccumulatedMetrics = MetricsSpawnResult['metrics'] & {
  model: string;
  runtime: AgentConfig['runtime'];
  provider?: string;
  costEstimationKind?: 'subscription-equivalent-payg';
  unknownRoundCount: number;
  sessionIds?: string[];
  costSource?: NonNullable<MetricsSpawnResult['metadata']>['costSource'];
  pricingSnapshot?: NonNullable<MetricsSpawnResult['metadata']>['pricingSnapshot'];
  modelUsage?: NonNullable<MetricsSpawnResult['metadata']>['modelUsage'];
  grok?: NonNullable<MetricsSpawnResult['metadata']>['grok'];
};

export interface MetricsPhaseState {
  projectId: string;
  phaseMetricAccum: Map<number, AccumulatedMetrics>;
}

export function createEmptyMetrics(): MetricsSpawnResult['metrics'] {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolUses: 0,
    apiRequests: 0,
    costUsd: 0,
    durationMs: 0,
  };
}

export function mergeMetrics(
  accum: MetricsSpawnResult['metrics'],
  result: MetricsSpawnResult['metrics'],
): void {
  accum.inputTokens += result.inputTokens;
  accum.outputTokens += result.outputTokens;
  accum.cacheReadTokens += result.cacheReadTokens;
  accum.cacheCreationTokens += result.cacheCreationTokens;
  accum.toolUses += result.toolUses;
  accum.apiRequests += result.apiRequests;
  accum.costUsd += result.costUsd;
  accum.durationMs += result.durationMs;
  if (result.costStatus === 'unknown') {
    accum.costStatus = 'unknown';
    if (result.costUnknownReason !== undefined) {
      accum.costUnknownReason = result.costUnknownReason;
    }
  } else if (result.costStatus === 'estimated-partial' && accum.costStatus !== 'unknown') {
    accum.costStatus = 'estimated-partial';
  }
  if (result.tokenStatus === 'not_reported') {
    accum.tokenStatus = 'not_reported';
  }
}

export function mergeUsageMetadata(
  accum: Pick<AccumulatedMetrics, 'sessionIds' | 'costSource' | 'pricingSnapshot' | 'modelUsage' | 'grok'>,
  meta: MetricsSpawnResult['metadata'] | undefined,
): void {
  if (!meta) return;
  if (meta.sessionIds !== undefined && meta.sessionIds.length > 0) {
    accum.sessionIds = Array.from(new Set([...(accum.sessionIds ?? []), ...meta.sessionIds]));
  }
  if (meta.costSource !== undefined) {
    accum.costSource = meta.costSource;
  }
  if (meta.pricingSnapshot !== undefined) {
    accum.pricingSnapshot = meta.pricingSnapshot;
  }
  if (meta.modelUsage !== undefined) {
    const merged = { ...(accum.modelUsage ?? {}) };
    for (const [model, usage] of Object.entries(meta.modelUsage)) {
      const prev = merged[model];
      merged[model] = prev
        ? {
            inputTokens: prev.inputTokens + usage.inputTokens,
            outputTokens: prev.outputTokens + usage.outputTokens,
            cacheReadInputTokens: prev.cacheReadInputTokens + usage.cacheReadInputTokens,
            cacheCreationInputTokens: prev.cacheCreationInputTokens + usage.cacheCreationInputTokens,
            costUSD: prev.costUSD + usage.costUSD,
            ...(prev.reasoningTokens !== undefined || usage.reasoningTokens !== undefined
              ? { reasoningTokens: (prev.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0) }
              : {}),
            ...(prev.modelCalls !== undefined || usage.modelCalls !== undefined
              ? { modelCalls: (prev.modelCalls ?? 0) + (usage.modelCalls ?? 0) }
              : {}),
            ...(prev.costUsdTicks !== undefined || usage.costUsdTicks !== undefined
              ? { costUsdTicks: (prev.costUsdTicks ?? 0) + (usage.costUsdTicks ?? 0) }
              : {}),
          }
        : { ...usage };
    }
    accum.modelUsage = merged;
  }
  if (meta.grok !== undefined) {
    const prev = accum.grok;
    accum.grok = {
      ...(prev ?? {}),
      ...(meta.grok.reasoningTokens !== undefined || prev?.reasoningTokens !== undefined
        ? { reasoningTokens: (prev?.reasoningTokens ?? 0) + (meta.grok.reasoningTokens ?? 0) }
        : {}),
      ...(meta.grok.modelCalls !== undefined || prev?.modelCalls !== undefined
        ? { modelCalls: (prev?.modelCalls ?? 0) + (meta.grok.modelCalls ?? 0) }
        : {}),
      ...(meta.grok.apiDurationMs !== undefined || prev?.apiDurationMs !== undefined
        ? { apiDurationMs: (prev?.apiDurationMs ?? 0) + (meta.grok.apiDurationMs ?? 0) }
        : {}),
      ...(meta.grok.numTurns !== undefined || prev?.numTurns !== undefined
        ? { numTurns: (prev?.numTurns ?? 0) + (meta.grok.numTurns ?? 0) }
        : {}),
      ...(meta.grok.costUsdTicks !== undefined || prev?.costUsdTicks !== undefined
        ? { costUsdTicks: (prev?.costUsdTicks ?? 0) + (meta.grok.costUsdTicks ?? 0) }
        : {}),
      ...(meta.grok.requestId !== undefined ? { requestId: meta.grok.requestId } : {}),
    };
  }
}

export function accumulateMetrics(
  state: MetricsPhaseState,
  phaseNumber: number,
  result: MetricsSpawnResult,
): void {
  let accum = state.phaseMetricAccum.get(phaseNumber);
  if (!accum) {
    accum = {
      ...createEmptyMetrics(),
      model: result.model,
      runtime: result.runtime,
      unknownRoundCount: 0,
    };
    state.phaseMetricAccum.set(phaseNumber, accum);
  }
  mergeMetrics(accum, result.metrics);
  accum.model = result.model;
  accum.runtime = result.runtime;
  if (result.provider !== undefined && result.provider.length > 0) {
    accum.provider = result.provider;
  }
  if (result.metadata?.costEstimationKind !== undefined) {
    accum.costEstimationKind = result.metadata.costEstimationKind;
  }
  mergeUsageMetadata(accum, result.metadata);
  if (result.metrics.costStatus === 'unknown') {
    accum.unknownRoundCount += 1;
  }

  emitIPC('pipeline:metrics', {
    projectId: state.projectId,
    phaseNumber,
    metrics: { ...accum },
    model: result.model,
    runtime: result.runtime,
  });
}

export function flushAccumulatedMetrics(
  projectId: string,
  phaseNumber: number,
  agentId: string,
  state: MetricsPhaseState,
  status: 'completed' | 'failed',
  projectCtx?: { pipelineType?: string },
  includePersisted = false,
): void {
  const accum = state.phaseMetricAccum.get(phaseNumber);
  if (!accum) return;

  if (includePersisted) {
    const persisted = getPipelinePhaseMetricsRows(projectId).find(
      (row) => row.phaseNumber === phaseNumber && row.sprintIndex === -1,
    );
    if (persisted) {
      const persistedMetadata = persisted.metadata as Record<string, unknown>;
      mergeMetrics(accum, {
        inputTokens: persisted.inputTokens,
        outputTokens: persisted.outputTokens,
        cacheReadTokens: persisted.cacheReadTokens,
        cacheCreationTokens: persisted.cacheCreationTokens,
        costUsd: persisted.costUsd,
        durationMs: persisted.durationMs,
        toolUses: persisted.toolUses,
        apiRequests: persisted.apiRequests,
        ...(persistedMetadata['costStatus'] === 'known'
          || persistedMetadata['costStatus'] === 'unknown'
          || persistedMetadata['costStatus'] === 'estimated-partial'
          ? { costStatus: persistedMetadata['costStatus'] }
          : {}),
        ...(persistedMetadata['tokenStatus'] === 'reported'
          || persistedMetadata['tokenStatus'] === 'not_reported'
          ? { tokenStatus: persistedMetadata['tokenStatus'] }
          : {}),
        ...(persistedMetadata['costUnknownReason'] === 'unknown-pricing'
          || persistedMetadata['costUnknownReason'] === 'no-usage-reported'
          ? { costUnknownReason: persistedMetadata['costUnknownReason'] }
          : {}),
      });
      mergeUsageMetadata(accum, persisted.metadata as MetricsSpawnResult['metadata'] | undefined);
      if (typeof persistedMetadata['provider'] === 'string') {
        accum.provider = persistedMetadata['provider'];
      }
      if (persistedMetadata['costEstimationKind'] === 'subscription-equivalent-payg') {
        accum.costEstimationKind = persistedMetadata['costEstimationKind'];
      }
      accum.unknownRoundCount += persisted.unknownCostCount;
    }
  }

  const phaseName = (projectCtx ? getPhaseName(phaseNumber, projectCtx) : PHASE_NAMES[phaseNumber]) ?? `Phase ${phaseNumber}`;

  const metadataFields: Record<string, unknown> = {};
  if (accum.provider !== undefined) {
    metadataFields.provider = accum.provider;
  }
  if (accum.tokenStatus !== undefined) {
    metadataFields.tokenStatus = accum.tokenStatus;
  }
  if (accum.costStatus !== undefined) {
    metadataFields.costStatus = accum.costStatus;
  }
  if (accum.costUnknownReason !== undefined) {
    metadataFields.costUnknownReason = accum.costUnknownReason;
  }
  if (accum.costEstimationKind !== undefined) {
    metadataFields.costEstimationKind = accum.costEstimationKind;
  }
  if (accum.sessionIds !== undefined && accum.sessionIds.length > 0) {
    metadataFields.sessionIds = accum.sessionIds;
  }
  if (accum.costSource !== undefined) {
    metadataFields.costSource = accum.costSource;
  }
  if (accum.pricingSnapshot !== undefined) {
    metadataFields.pricingSnapshot = accum.pricingSnapshot;
  }
  if (accum.modelUsage !== undefined) {
    metadataFields.modelUsage = accum.modelUsage;
  }
  if (accum.grok !== undefined) {
    metadataFields.grok = accum.grok;
  }

  savePipelinePhaseMetrics({
    projectId,
    phaseNumber,
    phaseName,
    agentId,
    status,
    inputTokens: accum.inputTokens,
    outputTokens: accum.outputTokens,
    cacheReadTokens: accum.cacheReadTokens,
    cacheCreationTokens: accum.cacheCreationTokens,
    costUsd: accum.costUsd,
    durationMs: accum.durationMs,
    toolUses: accum.toolUses,
    apiRequests: accum.apiRequests,
    model: accum.model,
    runtime: accum.runtime,
    completedAt: new Date().toISOString(),
    metadata: Object.keys(metadataFields).length > 0 ? metadataFields : undefined,
    unknownCostCount: accum.unknownRoundCount > 0 ? accum.unknownRoundCount : 0,
  });

  state.phaseMetricAccum.delete(phaseNumber);
}

export function collectMetrics(
  projectId: string,
  phaseNumber: number,
  agentId: string,
  result: MetricsSpawnResult,
  status: 'completed' | 'failed',
  projectCtx?: { pipelineType?: string },
): void {
  const phaseNameStr = (projectCtx ? getPhaseName(phaseNumber, projectCtx) : PHASE_NAMES[phaseNumber]) ?? `Phase ${phaseNumber}`;

  const metadataFields: Record<string, unknown> = {
    provider: result.provider,
  };
  if (result.metrics.tokenStatus !== undefined) {
    metadataFields.tokenStatus = result.metrics.tokenStatus;
  }
  if (result.metrics.costStatus !== undefined) {
    metadataFields.costStatus = result.metrics.costStatus;
  }
  if (result.metrics.costUnknownReason !== undefined) {
    metadataFields.costUnknownReason = result.metrics.costUnknownReason;
  }
  if (result.metadata?.costEstimationKind !== undefined) {
    metadataFields.costEstimationKind = result.metadata.costEstimationKind;
  }
  if (result.metadata?.sessionIds !== undefined && result.metadata.sessionIds.length > 0) {
    metadataFields.sessionIds = result.metadata.sessionIds;
  }
  if (result.metadata?.costSource !== undefined) {
    metadataFields.costSource = result.metadata.costSource;
  }
  if (result.metadata?.pricingSnapshot !== undefined) {
    metadataFields.pricingSnapshot = result.metadata.pricingSnapshot;
  }
  if (result.metadata?.modelUsage !== undefined) {
    metadataFields.modelUsage = result.metadata.modelUsage;
  }
  if (result.metadata?.grok !== undefined) {
    metadataFields.grok = result.metadata.grok;
  }

  savePipelinePhaseMetrics({
    projectId,
    phaseNumber,
    phaseName: phaseNameStr,
    agentId,
    status,
    inputTokens: result.metrics.inputTokens,
    outputTokens: result.metrics.outputTokens,
    cacheReadTokens: result.metrics.cacheReadTokens,
    cacheCreationTokens: result.metrics.cacheCreationTokens,
    costUsd: result.metrics.costUsd,
    durationMs: result.metrics.durationMs,
    toolUses: result.metrics.toolUses,
    apiRequests: result.metrics.apiRequests,
    model: result.model,
    runtime: result.runtime,
    completedAt: new Date().toISOString(),
    metadata: metadataFields,
    unknownCostCount: result.metrics.costStatus === 'unknown' ? 1 : 0,
  });

  emitIPC('pipeline:metrics', {
    projectId,
    phaseNumber,
    metrics: result.metrics,
    model: result.model,
    runtime: result.runtime,
  });
}
