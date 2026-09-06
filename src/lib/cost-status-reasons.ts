
export const COST_STATUS_REASON_ORDER = [
  'cache-write-not-reported',
  'long-context-unpriced',
  'child-usage-unknown',
] as const;
export type CostStatusReason = (typeof COST_STATUS_REASON_ORDER)[number];

export const COST_STATUS_REASON_LABELS: Record<CostStatusReason, string> = {
  'cache-write-not-reported': 'cache write nao reportado',
  'long-context-unpriced': 'long context nao tarifado',
  'child-usage-unknown': 'usage de subagentes desconhecido',
};

export function mergeCostStatusReasons(
  ...lists: Array<readonly string[] | undefined>
): CostStatusReason[] {
  const seen = new Set<string>();
  for (const list of lists) for (const r of list ?? []) seen.add(r);
  return COST_STATUS_REASON_ORDER.filter((r) => seen.has(r));
}

export function encodeCostStatusReasonsIntoMetricsMetadata(
  metricsMetadataJson: string | undefined,
  reasons: readonly string[],
): string {
  let base: Record<string, unknown> = {};
  if (metricsMetadataJson) {
    try {
      const parsed = JSON.parse(metricsMetadataJson) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
    }
  }
  base['costStatusReasons'] = mergeCostStatusReasons(reasons);
  return JSON.stringify(base);
}

export function decodeCostStatusReasonsFromMetricsMetadata(
  metricsMetadataJson: string | null | undefined,
): CostStatusReason[] {
  if (!metricsMetadataJson) return [];
  try {
    const parsed = JSON.parse(metricsMetadataJson) as { costStatusReasons?: unknown };
    if (Array.isArray(parsed?.costStatusReasons)) {
      return mergeCostStatusReasons(parsed.costStatusReasons as string[]);
    }
  } catch {
  }
  return [];
}
