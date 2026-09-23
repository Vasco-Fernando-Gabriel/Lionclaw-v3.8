import { calculateCost, hasKnownPricing } from '../pricing';

export type DynamicWorkflowNodeRuntime =
  'cloud' | 'local' | 'external' | 'codex' | 'kimi' | 'grok' | 'zai' | 'minimax-tp' | 'cursor';

const API_RUNTIMES: ReadonlySet<DynamicWorkflowNodeRuntime> = new Set([
  'cloud',
  'zai',
  'minimax-tp',
  'codex',
  'kimi',
  'grok',
  'cursor',
  'external',
]);

export interface PricingHelpers {
  calculateCost: typeof calculateCost;
  hasKnownPricing: typeof hasKnownPricing;
}

const DEFAULT_PRICING: PricingHelpers = { calculateCost, hasKnownPricing };

export {
  COST_STATUS_REASON_ORDER,
  mergeCostStatusReasons,
  encodeCostStatusReasonsIntoMetricsMetadata,
  decodeCostStatusReasonsFromMetricsMetadata,
} from '../../../src/lib/cost-status-reasons';
export type { CostStatusReason } from '../../../src/lib/cost-status-reasons';
import { mergeCostStatusReasons } from '../../../src/lib/cost-status-reasons';
import type { CostStatusReason } from '../../../src/lib/cost-status-reasons';

export interface RawCostReport {
  runtime: DynamicWorkflowNodeRuntime;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  costStatus?: string;
  tokenStatus?: string;
  costUnknownReason?: string;
  costStatusReasons?: readonly string[];
  apiRequests?: number;
  toolUses?: number;
}

export interface NormalizedCost {
  costUsd: number;
  costStatus: string;
  tokenStatus: string | null;
  costUnknownReason: string | null;
  costStatusReasons?: CostStatusReason[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  apiRequests: number;
  toolUses: number;
}

function totalTokens(r: RawCostReport): number {
  return (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheCreationTokens ?? 0);
}

export function normalizeCost(report: RawCostReport, pricing: PricingHelpers = DEFAULT_PRICING): NormalizedCost {
  const inputTokens = report.inputTokens ?? 0;
  const outputTokens = report.outputTokens ?? 0;
  const cacheReadTokens = report.cacheReadTokens ?? 0;
  const cacheCreationTokens = report.cacheCreationTokens ?? 0;
  const apiRequests = report.apiRequests ?? 0;
  const toolUses = report.toolUses ?? 0;

  if (report.runtime === 'local') {
    return {
      costUsd: 0,
      costStatus: report.costStatus ?? 'known',
      tokenStatus: report.tokenStatus ?? null,
      costUnknownReason: report.costUnknownReason ?? null,
      costStatusReasons: mergeCostStatusReasons(report.costStatusReasons),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      apiRequests,
      toolUses,
    };
  }

  const costUsd =
    report.costUsd !== undefined
      ? report.costUsd
      : pricing.calculateCost(report.model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens);

  let costStatus = report.costStatus;
  let costUnknownReason = report.costUnknownReason ?? null;
  const tokenStatus = report.tokenStatus ?? null;

  if (
    costStatus === undefined &&
    API_RUNTIMES.has(report.runtime) &&
    totalTokens(report) > 0 &&
    !pricing.hasKnownPricing(report.model)
  ) {
    costStatus = 'unknown';
    costUnknownReason = costUnknownReason ?? 'unknown-pricing';
  }

  return {
    costUsd,
    costStatus: costStatus ?? 'known',
    tokenStatus,
    costUnknownReason,
    costStatusReasons: mergeCostStatusReasons(report.costStatusReasons),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    apiRequests,
    toolUses,
  };
}
