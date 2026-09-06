import { useState, useEffect } from 'react';
import { BarChart2 } from 'lucide-react';
import { useActiveProjectState } from '@/hooks/useActiveProjectState';
import type { PipelinePhaseMetrics } from '@/types';
import {
  formatCostWithMeta,
  formatPipelineTotalCost,
  formatTokensWithMeta,
} from './PipelineMetricsReport';


function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toFixed(2)}`;
}

function formatTimer(totalSeconds: number): string {
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


interface LiveMetrics {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  model: string | null;
}

function resolveLiveMetrics(
  currentPhase: number | null,
  isStreaming: boolean,
  currentToolCallsLen: number,
  storedPhaseMetrics: PipelinePhaseMetrics[] | undefined,
): LiveMetrics | null {
  if (currentPhase === null) return null;

  const phaseMetric = storedPhaseMetrics?.find((m) => m.phaseNumber === currentPhase);

  if (!phaseMetric && !isStreaming) return null;

  const base: LiveMetrics = {
    inputTokens: phaseMetric?.inputTokens ?? 0,
    outputTokens: phaseMetric?.outputTokens ?? 0,
    costUsd: phaseMetric?.costUsd ?? 0,
    durationMs: phaseMetric?.durationMs ?? 0,
    toolUses: phaseMetric?.toolUses ?? 0,
    model: phaseMetric?.model ?? null,
  };

  if (isStreaming) {
    base.toolUses = Math.max(base.toolUses, currentToolCallsLen);
  }

  return base;
}


interface PipelineMetricsFooterProps {
  onExpandMetrics?: () => void;
}

export function PipelineMetricsFooter({ onExpandMetrics }: PipelineMetricsFooterProps) {
  const currentPhase = useActiveProjectState(s => s.currentPhase) ?? null;
  const isStreaming = useActiveProjectState(s => s.isStreaming) ?? false;
  const metrics = useActiveProjectState(s => s.metrics) ?? null;
  const currentToolCalls = useActiveProjectState(s => s.currentToolCalls) ?? [];
  const livePhaseMetrics = useActiveProjectState(s => s.phaseMetrics) ?? null;
  const streamTurnStartedAt = useActiveProjectState(s => s.streamTurnStartedAt) ?? null;

  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!isStreaming) return undefined;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isStreaming]);

  const elapsedSeconds =
    isStreaming && streamTurnStartedAt !== null
      ? Math.max(0, Math.floor((nowMs - streamTurnStartedAt) / 1000))
      : 0;


  const storedPhaseMetrics = metrics?.phases;

  const mergedStoredMetrics: PipelinePhaseMetrics[] | undefined = (() => {
    if (livePhaseMetrics !== null && currentPhase !== null) {
      const synthetic: PipelinePhaseMetrics = {
        id: -1,
        projectId: '',
        phaseNumber: currentPhase,
        phaseName: '',
        agentId: null,
        status: 'running',
        inputTokens: livePhaseMetrics.inputTokens,
        outputTokens: livePhaseMetrics.outputTokens,
        cacheReadTokens: livePhaseMetrics.cacheReadTokens,
        cacheCreationTokens: livePhaseMetrics.cacheCreationTokens,
        costUsd: livePhaseMetrics.costUsd,
        durationMs: 0,
        toolUses: 0,
        apiRequests: 0,
        model: null,
        runtime: null,
        startedAt: null,
        completedAt: null,
        metadata: {},
        createdAt: '',
      };
      const without = (storedPhaseMetrics ?? []).filter((m) => m.phaseNumber !== currentPhase);
      return [synthetic, ...without];
    }
    return storedPhaseMetrics;
  })();

  const liveMetrics = resolveLiveMetrics(
    currentPhase,
    isStreaming,
    currentToolCalls.length,
    mergedStoredMetrics,
  );

  if (liveMetrics === null && currentPhase === null) {
    return (
      <div className="flex items-center justify-center border-t border-zinc-800 px-4 py-1.5 bg-zinc-950/60 shrink-0">
        <span className="text-[10px] text-zinc-700 font-mono">aguardando inicio...</span>
      </div>
    );
  }

  const currentPhaseMeta = currentPhase !== null
    ? mergedStoredMetrics?.find((m) => m.phaseNumber === currentPhase)?.metadata
    : undefined;

  const inputStr = liveMetrics ? formatTokens(liveMetrics.inputTokens) : '-';
  const outputStr = liveMetrics ? formatTokens(liveMetrics.outputTokens) : '-';
  const costStr = liveMetrics
    ? (isStreaming ? formatCost(liveMetrics.costUsd) : formatCostWithMeta(liveMetrics.costUsd, currentPhaseMeta))
    : '-';
  const tokensStr = liveMetrics
    ? (isStreaming
        ? `${formatTokens(liveMetrics.inputTokens)} / ${formatTokens(liveMetrics.outputTokens)}`
        : formatTokensWithMeta(liveMetrics.inputTokens, liveMetrics.outputTokens, currentPhaseMeta))
    : '-';
  const modelStr = liveMetrics?.model ?? '-';
  const toolStr = liveMetrics ? String(liveMetrics.toolUses) : '-';
  const timerStr = isStreaming ? formatTimer(elapsedSeconds) : '-';
  const totalCostStr = metrics !== null
    ? formatPipelineTotalCost(
        metrics.totals.costUsd,
        metrics.subscriptionEquivalentCost,
        metrics.totals,
      )
    : null;

  const dimmed = !liveMetrics || (
    liveMetrics.inputTokens === 0 &&
    liveMetrics.outputTokens === 0 &&
    liveMetrics.costUsd === 0
  );

  const unknownCostCount = metrics?.totals.unknownCostCount ?? 0;

  return (
    <div className="flex items-center gap-2 border-t border-zinc-800 px-4 py-1.5 bg-zinc-950/60 shrink-0">
      {/* Streaming pulse */}
      {isStreaming && (
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500" />
        </span>
      )}

      {/* Live timer (only shown while streaming) */}
      {isStreaming && (
        <>
          <MetricPill label="tempo" value={timerStr} />
          <Dot />
        </>
      )}

      <MetricPill label="in" value={inputStr} dimmed={dimmed} />
      <Dot />
      <MetricPill label="out" value={outputStr} dimmed={dimmed} />
      {tokensStr === 'tokens nao reportados' && (
        <>
          <Dot />
          <span className="text-[10px] font-mono text-zinc-500">{tokensStr}</span>
        </>
      )}
      <Dot />
      <MetricPill label="custo" value={costStr} dimmed={dimmed} highlight={!dimmed && costStr !== 'Custo nao estimado'} />
      <Dot />
      <MetricPill label="tools" value={toolStr} dimmed={dimmed} />

      {/* Model name */}
      {modelStr !== '-' && (
        <>
          <Dot />
          <MetricPill label="modelo" value={modelStr} dimmed={false} />
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Total cost */}
      {totalCostStr !== null && (
        <>
          <span className="text-zinc-700 text-[10px] font-mono">total:</span>
          <span className="text-white font-bold text-[10px] font-mono">{totalCostStr}</span>
          {unknownCostCount > 0 && (
            <span className="text-zinc-500 text-[10px] font-mono">
              ({unknownCostCount} com custo nao estimado)
            </span>
          )}
        </>
      )}

      {/* Expand metrics report button */}
      {onExpandMetrics !== undefined && (
        <button
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
