import { useEffect, useRef, useState } from 'react';
import { Zap } from 'lucide-react';

interface TokenCounterProps {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  isStreaming: boolean;
  isCompacting?: boolean;
  compactionModelLabel?: string;
  compactionSource?: 'lionclaw' | 'sdk' | null;
  isDreaming?: boolean;
  contextTokens?: number;
  contextWindowTokens?: number;
  compactionThresholdPercent?: number;
  contextSource?: 'estimate' | 'provider';
  costUsd?: number | null;
  estimated?: boolean;
  costStatus?: 'known' | 'unknown' | 'estimated-partial';
  costUnknownReason?: string;
  costEstimationKind?: 'subscription-equivalent-payg';
}

function useAnimatedCounter(target: number, duration = 200): number {
  const [display, setDisplay] = useState(0);
  const startRef = useRef(0);
  const startTimeRef = useRef(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    startRef.current = display;
    startTimeRef.current = performance.now();

    const animate = (now: number) => {
      const elapsed = now - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = Math.round(startRef.current + (target - startRef.current) * eased);
      setDisplay(value);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return display;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${(tokens / 1_000).toFixed(1)}K`;
  if (tokens >= 1_000) return tokens.toLocaleString();
  return String(tokens);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function contextTone(percent: number, threshold: number): {
  text: string;
  fill: string;
  border: string;
} {
  if (percent >= threshold) {
    return {
      text: 'text-red-300',
      fill: 'bg-red-500',
      border: 'border-red-500/40',
    };
  }
  if (percent >= Math.max(55, threshold - 15)) {
    return {
      text: 'text-amber-300',
      fill: 'bg-amber-500',
      border: 'border-amber-500/40',
    };
  }
  return {
    text: 'text-amber-300',
    fill: 'bg-amber-500',
    border: 'border-amber-500/40',
  };
}

function formatCostDisplay(costUsd: number): string {
  if (costUsd < 0.001) return '<$0.001';
  if (costUsd < 0.01) return `~$${costUsd.toFixed(4)}`;
  return `~$${costUsd.toFixed(3)}`;
}

function formatSubscriptionEquivalentCost(costUsd: number): string {
  if (costUsd === 0) return '~$0.000';
  if (costUsd < 0.001) return '~$<0.001';
  return formatCostDisplay(costUsd);
}

export function resolveTokenCounterCostDisplay(
  costUsd: number | null | undefined,
  costStatus?: 'known' | 'unknown' | 'estimated-partial',
  costEstimationKind?: 'subscription-equivalent-payg',
): string | null {
  if (costStatus === 'unknown') return 'Custo nao estimado';
  if (costStatus === 'estimated-partial' && typeof costUsd === 'number' && costUsd >= 0) {
    return formatCostDisplay(costUsd);
  }
  if (
    typeof costUsd === 'number'
    && costUsd >= 0
    && costEstimationKind === 'subscription-equivalent-payg'
  ) {
    return formatSubscriptionEquivalentCost(costUsd);
  }
  if (costUsd === 0) return 'Local · $0';
  if (typeof costUsd === 'number' && costUsd > 0) return formatCostDisplay(costUsd);
  return null;
}

export function shouldShowCompactionBadge(
  compactionSource: 'lionclaw' | 'sdk' | null | undefined,
  compactionModelLabel: string | undefined,
): boolean {
  return compactionSource === 'lionclaw' && Boolean(compactionModelLabel);
}

export function TokenCounter({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
  isStreaming,
  isCompacting,
  compactionModelLabel,
  compactionSource,
  isDreaming,
  contextTokens,
  contextWindowTokens,
  compactionThresholdPercent,
  contextSource,
  costUsd,
  estimated,
  costStatus,
  costUnknownReason,
  costEstimationKind,
}: TokenCounterProps) {
  const animatedInput = useAnimatedCounter(inputTokens);
  const animatedOutput = useAnimatedCounter(outputTokens);
  const animatedCacheRead = useAnimatedCounter(cacheReadTokens || 0);
  const animatedCacheCreation = useAnimatedCounter(cacheCreationTokens || 0);
  const animatedContext = useAnimatedCounter(contextTokens || 0);

  const showTokenCounts = (inputTokens > 0 || outputTokens > 0) && !estimated;
  const showEstimatedLabel = Boolean(estimated && (inputTokens > 0 || outputTokens > 0));
  const showContextBar = Boolean(contextWindowTokens && contextWindowTokens > 0 && contextTokens !== undefined);
  const showCompactionOnly = Boolean(isCompacting && !showTokenCounts && !showContextBar);
  const showCompactionBadge = shouldShowCompactionBadge(compactionSource, compactionModelLabel);

  if (!showTokenCounts && !showEstimatedLabel && !showContextBar && !showCompactionOnly && !isDreaming) return null;

  const hasCacheInfo = (cacheReadTokens || 0) > 0 || (cacheCreationTokens || 0) > 0;

  const costDisplay = resolveTokenCounterCostDisplay(costUsd, costStatus, costEstimationKind);

  const threshold = Math.min(95, Math.max(50, compactionThresholdPercent ?? 70));
  const contextPercent = showContextBar
    ? clampPercent((animatedContext / (contextWindowTokens || 1)) * 100)
    : 0;
  const tone = contextTone(contextPercent, threshold);
  const markerLeft = clampPercent(threshold);

  return (
    <div
      className={`min-w-[280px] max-w-full px-3 py-2 rounded-lg bg-zinc-900/80 border ${
        showContextBar ? tone.border : 'border-zinc-800/50'
      }`}
    >
      <div className="flex items-center gap-3">
        <Zap size={12} className={`text-amber-500 ${isStreaming || isCompacting ? 'animate-pulse' : ''}`} />
        {showTokenCounts && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-zinc-500">
            <span>
              <span className="text-zinc-600">in:</span>{' '}
              <span className="text-zinc-400">
                {estimated ? '~' : ''}
                {formatTokenCount(animatedInput)}
              </span>
              {hasCacheInfo && (
                <span className="text-zinc-600">
                  {' '}
                  (cache: {formatTokenCount(animatedCacheRead + animatedCacheCreation)})
                </span>
              )}
            </span>
            <span className="text-zinc-700">|</span>
            <span>
              <span className="text-zinc-600">out:</span>{' '}
              <span className="text-zinc-400">
                {estimated ? '~' : ''}
                {formatTokenCount(animatedOutput)}
              </span>
            </span>
            {costDisplay !== null && (
              <>
                <span className="text-zinc-700">|</span>
                <span
                  className="text-zinc-500"
                  title={costEstimationKind === 'subscription-equivalent-payg'
                    ? 'Equivalente da API; nao e cobranca da assinatura.'
                    : costUnknownReason}
                >
                  {costDisplay}
                </span>
              </>
            )}
          </div>
        )}
        {showEstimatedLabel && (
          <span className="text-[11px] font-mono text-zinc-500" title="O provider nao reportou usage real neste turno.">
            tokens estimados{costStatus === 'unknown' ? ' · custo nao estimado' : ''}
          </span>
        )}
        {showCompactionBadge && (
          <span className="bg-amber-500/15 text-amber-400 rounded-full px-2 py-0.5 text-xs flex items-center gap-1.5 font-mono">
            {`⟦ ${compactionModelLabel} ⟧`}
          </span>
        )}
        {showCompactionOnly && (
          <div className="text-[11px] font-mono text-amber-300 animate-pulse">
            compactando
          </div>
        )}
        {isDreaming && (
          <span className="bg-amber-500/15 text-amber-400 rounded-full px-2 py-0.5 text-xs flex items-center gap-1.5">
            Dreaming
            <span className="w-3 h-1 rounded-sm bg-amber-400 animate-pulse" />
          </span>
        )}
      </div>
      {showContextBar && (
        <div className="mt-2 space-y-1">
          <div className="flex items-center justify-between gap-3 text-[10px] font-mono">
            <span className="text-zinc-600">
              ctx:{' '}
              <span className={tone.text}>{formatTokenCount(animatedContext)}</span>
              <span className="text-zinc-700"> / </span>
              <span className="text-zinc-500">{formatTokenCount(contextWindowTokens || 0)}</span>
              {contextSource === 'estimate' && <span className="text-zinc-700"> est</span>}
            </span>
            <span className={isCompacting ? 'text-amber-300 animate-pulse' : 'text-zinc-600'}>
              {isCompacting ? 'compactando' : `${contextPercent.toFixed(0)}%`}
            </span>
          </div>
          <div className="relative h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${tone.fill} ${isCompacting ? 'animate-pulse' : ''}`}
              style={{ width: `${contextPercent}%` }}
            />
            <div
              className="absolute top-0 h-full w-px bg-zinc-200/70"
              style={{ left: `${markerLeft}%` }}
            />
          </div>
        </div>
      )}
      {showCompactionOnly && (
        <div className="mt-2 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
          <div className="h-full w-full rounded-full bg-amber-500 animate-pulse" />
        </div>
      )}
    </div>
  );
}
