import { BarChart2 } from 'lucide-react';
import {
  decodeCostStatusReasonsFromMetricsMetadata,
  COST_STATUS_REASON_LABELS,
  type CostStatusReason,
} from '@/lib/cost-status-reasons';
import type { DynamicWorkflowNodeRun } from '@/types';
import { useStreamTimer } from '@/components/chat/useStreamTimer';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toFixed(2)}`;
}

function formatTimer(totalMs: number): string {
  const totalSeconds = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

interface MetricPillProps {
  label: string;
  value: string;
  dimmed?: boolean;
  highlight?: boolean;
}

function MetricPill({ label, value, dimmed = false, highlight = false }: MetricPillProps) {
  const valueClass = highlight
    ? 'text-[10px] font-mono font-bold text-white'
    : `text-[10px] font-mono font-medium ${dimmed ? 'text-zinc-600' : 'text-zinc-400'}`;
  return (
    <div className="flex items-center gap-1">
      <span className="text-zinc-600 text-[10px] font-mono">{label}:</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}

function Dot() {
  return <span className="text-zinc-700 text-[10px] select-none">·</span>;
}

export interface WorkflowRunMetricsTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  unknownCostCount: number;
  estimatedPartialCount: number;
  estimatedPartialReasons: Set<CostStatusReason>;
  model: string | null;
}

export function aggregateRunMetrics(nodeRuns: DynamicWorkflowNodeRun[]): WorkflowRunMetricsTotals {
  const totals: WorkflowRunMetricsTotals = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: 0,
    toolUses: 0,
    unknownCostCount: 0,
    estimatedPartialCount: 0,
    estimatedPartialReasons: new Set<CostStatusReason>(),
    model: null,
  };
  for (const nr of nodeRuns) {
    totals.inputTokens += nr.inputTokens;
    totals.outputTokens += nr.outputTokens;
    totals.costUsd += nr.costUsd;
    totals.durationMs += nr.durationMs;
    totals.toolUses += nr.toolUses;
    if (nr.costStatus === 'estimated-partial') {
      totals.estimatedPartialCount += 1;
      for (const reason of decodeCostStatusReasonsFromMetricsMetadata(nr.metricsMetadataJson)) {
        totals.estimatedPartialReasons.add(reason);
      }
    } else if (nr.costStatus !== null && nr.costStatus !== 'known') {
      totals.unknownCostCount += 1;
    }
    if (nr.model) totals.model = nr.model;
  }
  return totals;
}

export interface WorkflowMetricsFooterProps {
  nodeRuns: DynamicWorkflowNodeRun[];
  totalCostUsd: number;
  isStreaming?: boolean;
  runStartedAtMs?: number | null;
  onExpandMetrics?: () => void;
}

export function WorkflowMetricsFooter({
  nodeRuns,
  totalCostUsd,
  isStreaming = false,
  runStartedAtMs = null,
  onExpandMetrics,
}: WorkflowMetricsFooterProps) {
  const totals = aggregateRunMetrics(nodeRuns);
  const liveElapsed = useStreamTimer(isStreaming && runStartedAtMs != null, runStartedAtMs);

  if (nodeRuns.length === 0 && !isStreaming) {
    return (
      <div className="flex items-center justify-center border-t border-zinc-800 px-4 py-1.5 bg-zinc-950/60 shrink-0">
        <span className="text-[10px] text-zinc-700 font-mono">aguardando inicio...</span>
      </div>
    );
  }

  const dimmed = totals.inputTokens === 0 && totals.outputTokens === 0 && totals.costUsd === 0;
  const inputStr = formatTokens(totals.inputTokens);
  const outputStr = formatTokens(totals.outputTokens);
  const costStr = (totals.estimatedPartialCount > 0 ? '~' : '') + formatCost(totals.costUsd);
  const toolStr = String(totals.toolUses);
  const timerStr = isStreaming && runStartedAtMs != null ? liveElapsed : formatTimer(totals.durationMs);
  const modelStr = totals.model ?? '-';
  const totalStr = (totals.estimatedPartialCount > 0 ? '~' : '') + formatCost(totalCostUsd);

  return (
    <div className="flex items-center gap-2 border-t border-zinc-800 px-4 py-1.5 bg-zinc-950/60 shrink-0">
      {isStreaming && (
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500" />
        </span>
      )}

      <MetricPill label="tempo" value={timerStr} dimmed={dimmed} />
      <Dot />
      <MetricPill label="in" value={inputStr} dimmed={dimmed} />
      <Dot />
      <MetricPill label="out" value={outputStr} dimmed={dimmed} />
      <Dot />
      <MetricPill label="custo" value={costStr} dimmed={dimmed} highlight={!dimmed} />
      <Dot />
      <MetricPill label="tools" value={toolStr} dimmed={dimmed} />

      {modelStr !== '-' && (
        <>
          <Dot />
          <MetricPill label="modelo" value={modelStr} />
        </>
      )}

      <div className="flex-1" />

      <span className="text-zinc-700 text-[10px] font-mono">total:</span>
      <span className="text-white font-bold text-[10px] font-mono">{totalStr}</span>
      {totals.estimatedPartialCount > 0 && totals.unknownCostCount === 0 && (
        <span className="text-[10px] text-zinc-600 font-mono ml-1">
          (custo aproximado
          {totals.estimatedPartialReasons.size > 0
            ? `: ${[...totals.estimatedPartialReasons].map((r) => COST_STATUS_REASON_LABELS[r]).join(', ')}`
            : ''}
          )
        </span>
      )}
      {totals.unknownCostCount > 0 && (
        <span className="text-zinc-500 text-[10px] font-mono">({totals.unknownCostCount} com custo nao estimado)</span>
      )}

      {onExpandMetrics !== undefined && (
        <button
          type="button"
          onClick={onExpandMetrics}
          className="ml-2 flex items-center justify-center w-5 h-5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors shrink-0"
          title="Ver relatorio completo de metricas"
        >
          <BarChart2 size={12} />
        </button>
      )}
    </div>
  );
}
