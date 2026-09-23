import { useState, useEffect } from 'react';
import { Check, X, Minus } from 'lucide-react';
import type { PhaseDefinition, PipelinePhaseMetrics } from '@/types';

type PhaseDisplayStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

function resolvePhaseDisplayStatus(
  phaseNum: number,
  currentPhase: number | null,
  phaseStatus: string,
  metricsMap: Map<number, PipelinePhaseMetrics>,
): PhaseDisplayStatus {
  const metrics = metricsMap.get(phaseNum);

  if (metrics) {
    if (metrics.status === 'completed') return 'completed';
    if (metrics.status === 'failed') return 'failed';
    if (metrics.status === 'skipped') return 'skipped';
  }

  if (currentPhase === null) return 'pending';

  if (phaseNum < currentPhase) return 'completed';
  if (phaseNum === currentPhase) {
    if (phaseStatus === 'failed') return 'failed';
    if (phaseStatus === 'skipped') return 'skipped';
    if (metrics?.status === 'running') return 'running';
    return 'running';
  }
  return 'pending';
}

function MiniStatusIcon({ status }: { status: PhaseDisplayStatus }) {
  if (status === 'completed') {
    return <Check size={8} strokeWidth={3} className="text-green-400" />;
  }
  if (status === 'running') {
    return (
      <span className="inline-block w-2 h-2 rounded-full border-2 border-amber-400 border-t-transparent animate-spin" />
    );
  }
  if (status === 'failed') {
    return <X size={8} strokeWidth={3} className="text-red-400" />;
  }
  if (status === 'skipped') {
    return <Minus size={8} strokeWidth={2} className="text-zinc-500" />;
  }
  return <span className="inline-block w-2 h-2 rounded-full" style={{ border: '1.5px dashed #52525b' }} />;
}

const MINI_STATUS_TEXT: Record<PhaseDisplayStatus, string> = {
  pending: 'text-zinc-600',
  running: 'text-amber-300',
  completed: 'text-green-400',
  failed: 'text-red-400',
  skipped: 'text-zinc-500',
};

const GROUP_STATUS_BORDER: Record<PhaseDisplayStatus, string> = {
  pending: 'border-zinc-700 bg-zinc-900',
  running: 'border-amber-500/60 bg-amber-500/10',
  completed: 'border-green-700/60 bg-green-600/10 hover:bg-green-600/20',
  failed: 'border-red-500/60 bg-red-500/10',
  skipped: 'border-zinc-700 bg-zinc-900',
};

function resolveGroupStatus(
  techPhases: PhaseDefinition[],
  currentPhase: number | null,
  phaseStatus: string,
  metricsMap: Map<number, PipelinePhaseMetrics>,
): PhaseDisplayStatus {
  const statuses = techPhases.map((p) => resolvePhaseDisplayStatus(p.number, currentPhase, phaseStatus, metricsMap));

  if (statuses.some((s) => s === 'running')) return 'running';
  if (statuses.some((s) => s === 'failed')) return 'failed';
  if (statuses.every((s) => s === 'completed' || s === 'skipped')) return 'completed';
  return 'pending';
}

export interface TechGroupProps {
  phases: PhaseDefinition[];
  currentPhase: number | null;
  phaseStatus: string;
  metricsMap: Map<number, PipelinePhaseMetrics>;
  onSelectPhase: (phase: number) => void;
  groupLabel?: string;
  tooltip?: string;
}

export function TechGroup({
  phases,
  currentPhase,
  phaseStatus,
  metricsMap,
  onSelectPhase,
  groupLabel = 'TECH',
  tooltip,
}: TechGroupProps) {
  const memberNumbers = new Set<number>(phases.map((p) => p.number));
  const isCurrentInGroup = currentPhase !== null && memberNumbers.has(currentPhase);
  const [expanded, setExpanded] = useState(isCurrentInGroup);

  useEffect(() => {
    if (isCurrentInGroup) {
      setExpanded(true);
    }
  }, [isCurrentInGroup]);

  const groupStatus = resolveGroupStatus(phases, currentPhase, phaseStatus, metricsMap);
  const borderClass = GROUP_STATUS_BORDER[groupStatus];

  const groupTextColor =
    groupStatus === 'completed'
      ? 'text-green-400'
      : groupStatus === 'running'
        ? 'text-amber-300'
        : groupStatus === 'failed'
          ? 'text-red-400'
          : 'text-zinc-500';

  const resolvedTooltip =
    tooltip ??
    `${groupLabel} (${phases.map((p) => p.abbreviation).join(' / ')}) — clique para ${expanded ? 'recolher' : 'expandir'}`;

  return (
    <div className="flex flex-col items-center shrink-0">
      {/* Main group badge */}
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className={`
          flex flex-col items-center gap-0.5 px-2 py-0.5 rounded
          border transition-all duration-200 cursor-pointer
          ${borderClass}
        `}
        title={resolvedTooltip}
      >
        <span className={`text-[10px] font-bold leading-none ${groupTextColor}`}>{groupLabel}</span>
        <div className="flex items-center justify-center h-3">
          <div className="flex items-center gap-0.5">
            {groupStatus === 'running' && (
              <span className="inline-block w-2 h-2 rounded-full border-2 border-amber-400 border-t-transparent animate-spin" />
            )}
            {groupStatus === 'completed' && <Check size={8} strokeWidth={3} className="text-green-400" />}
            {groupStatus === 'failed' && <X size={8} strokeWidth={3} className="text-red-400" />}
            {groupStatus === 'pending' && (
              <span className="inline-block w-2 h-2 rounded-full" style={{ border: '1.5px dashed #52525b' }} />
            )}
            {groupStatus === 'skipped' && <Minus size={8} strokeWidth={2} className="text-zinc-500" />}
          </div>
        </div>
      </button>

      {/* Expanded mini-badges */}
      <div
        className={`
          overflow-hidden transition-all duration-200
          ${expanded ? 'max-h-20 opacity-100 mt-1' : 'max-h-0 opacity-0 mt-0'}
        `}
      >
        <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 shadow-xl">
          {phases.map((phase, idx) => {
            const status = resolvePhaseDisplayStatus(phase.number, currentPhase, phaseStatus, metricsMap);
            const isCompleted = status === 'completed';
            const isCurrentActive = phase.number === currentPhase;
            const clickable = isCompleted || isCurrentActive;
            const textColor = MINI_STATUS_TEXT[status];

            return (
              <div key={phase.number} className="flex items-center">
                <div
                  className={`
                    flex flex-col items-center gap-0.5 px-1 py-0.5 rounded
                    transition-colors duration-150
                    ${clickable ? 'cursor-pointer hover:bg-zinc-800' : 'cursor-default'}
                  `}
                  onClick={() => {
                    if (clickable) onSelectPhase(phase.number);
                  }}
                  role={clickable ? 'button' : undefined}
                  title={`${phase.name} (Fase ${phase.number})`}
                >
                  <span className={`text-[9px] font-bold leading-none ${textColor}`}>{phase.abbreviation}</span>
                  <div className="flex items-center justify-center h-2.5">
                    <MiniStatusIcon status={status} />
                  </div>
                </div>

                {idx < phases.length - 1 && <div className="w-2.5 h-0.5 mx-0.5 bg-zinc-700 shrink-0" />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
