import { useState, useMemo } from 'react';
import { Check, X, Minus, RotateCcw, PenTool, Lock } from 'lucide-react';
import type { PhaseDefinition, PipelinePhaseMetrics } from '@/types';
import { usePipelineStore } from '@/stores/pipeline-store';
import { TechGroup } from './TechGroup';

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

function PhaseStatusIcon({ status }: { status: PhaseDisplayStatus }) {
  if (status === 'completed') {
    return <Check size={10} strokeWidth={3} className="text-green-400" />;
  }
  if (status === 'running') {
    return (
      <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-orange-400 border-t-transparent animate-spin" />
    );
  }
  if (status === 'failed') {
    return <X size={10} strokeWidth={3} className="text-red-400" />;
  }
  if (status === 'skipped') {
    return <Minus size={10} strokeWidth={2} className="text-zinc-500" />;
  }
  return <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ border: '1.5px dashed #52525b' }} />;
}

const STATUS_NUM_COLOR: Record<PhaseDisplayStatus, string> = {
  pending: 'text-zinc-600',
  running: 'text-orange-300',
  completed: 'text-green-400',
  failed: 'text-red-400',
  skipped: 'text-zinc-500',
};

function PhaseConnector({ completed }: { completed: boolean }) {
  return (
    <div className={`h-0.5 flex-1 mx-0.5 rounded transition-colors ${completed ? 'bg-green-600' : 'bg-zinc-800'}`} />
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}c`;
  return `$${usd.toFixed(3)}`;
}

interface PhaseTooltipProps {
  phase: PhaseDefinition;
  metrics: PipelinePhaseMetrics | undefined;
  status: PhaseDisplayStatus;
}

function PhaseTooltip({ phase, metrics, status }: PhaseTooltipProps) {
  return (
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-300 whitespace-nowrap shadow-xl">
        <p className="font-semibold text-zinc-100 mb-1">{phase.name}</p>
        <p className="text-zinc-500 mb-1.5">
          Fase {phase.number} — {phase.stageName}
        </p>
        {metrics ? (
          <div className="space-y-0.5 text-[11px]">
            <div className="flex gap-3">
              <span className="text-zinc-500">Custo:</span>
              <span className="text-zinc-300">{formatCost(metrics.costUsd)}</span>
            </div>
            <div className="flex gap-3">
              <span className="text-zinc-500">Duracao:</span>
              <span className="text-zinc-300">{formatMs(metrics.durationMs)}</span>
            </div>
            <div className="flex gap-3">
              <span className="text-zinc-500">Tokens in:</span>
              <span className="text-zinc-300">{metrics.inputTokens.toLocaleString()}</span>
            </div>
            <div className="flex gap-3">
              <span className="text-zinc-500">Tokens out:</span>
              <span className="text-zinc-300">{metrics.outputTokens.toLocaleString()}</span>
            </div>
          </div>
        ) : (
          <p className="text-zinc-600 text-[11px]">
            {status === 'pending' ? 'Ainda nao executado' : 'Sem metricas disponíveis'}
          </p>
        )}
        {status === 'completed' && <p className="text-zinc-600 text-[10px] mt-1.5">Clique para ver historico</p>}
      </div>
      {/* arrow */}
      <div className="flex justify-center">
        <div className="w-2 h-2 bg-zinc-900 border-r border-b border-zinc-700 rotate-45 -mt-1" />
      </div>
    </div>
  );
}

interface PipelineProgressBarProps {
  phases: PhaseDefinition[];
  currentPhase: number | null;
  phaseStatus: string;
  phaseMetrics?: PipelinePhaseMetrics[];
  onPhaseClick?: (phaseNumber: number) => void;
  onRequestReset?: (phase: number) => void;
  sidecarRunning?: boolean;
}

export function PipelineProgressBar({
  phases,
  currentPhase,
  phaseStatus,
  phaseMetrics = [],
  onPhaseClick,
  onRequestReset,
  sidecarRunning = false,
}: PipelineProgressBarProps) {
  const [hoveredPhase, setHoveredPhase] = useState<number | null>(null);

  const { viewingPhase, activeProjectId, setViewingPhase, loadPhaseHistory } = usePipelineStore();

  const metricsMap = new Map<number, PipelinePhaseMetrics>(phaseMetrics.map((m) => [m.phaseNumber, m]));

  const stages = useMemo(() => {
    const stageMap = new Map<number, { stageName: string; phases: PhaseDefinition[] }>();
    for (const phase of phases) {
      if (!stageMap.has(phase.stage)) {
        stageMap.set(phase.stage, { stageName: phase.stageName, phases: [] });
      }
      stageMap.get(phase.stage)!.phases.push(phase);
    }
    return Array.from(stageMap.entries()).map(([stageNum, data]) => ({
      stageNum,
      stageName: data.stageName,
      phases: data.phases,
    }));
  }, [phases]);

  const groupedPhases = useMemo(() => {
    const map = new Map<string, { label: string; phases: PhaseDefinition[] }>();
    for (const p of phases) {
      if (!p.groupId) continue;
      const label = p.groupLabel ?? p.groupId.toUpperCase();
      const entry = map.get(p.groupId) ?? { label, phases: [] };
      entry.phases.push(p);
      map.set(p.groupId, entry);
    }
    return map;
  }, [phases]);

  const groupCompleted = useMemo(() => {
    const result: Record<string, boolean> = {};
    for (const [groupId, data] of groupedPhases) {
      result[groupId] = data.phases.every((p) => {
        const s = resolvePhaseDisplayStatus(p.number, currentPhase, phaseStatus, metricsMap);
        return s === 'completed' || s === 'skipped';
      });
    }
    return result;
  }, [groupedPhases, currentPhase, phaseStatus, metricsMap]);

  const handlePhaseBadgeClick = (phaseNumber: number, isCompleted: boolean, isCurrentPhase: boolean) => {
    if (onPhaseClick) onPhaseClick(phaseNumber);

    if (isCurrentPhase) {
      setViewingPhase(null);
    } else if (isCompleted && activeProjectId) {
      setViewingPhase(phaseNumber);
      void loadPhaseHistory(activeProjectId, phaseNumber);
    }
  };

  const handleGroupPhaseSelect = (phaseNumber: number) => {
    if (onPhaseClick) onPhaseClick(phaseNumber);
    if (activeProjectId) {
      setViewingPhase(phaseNumber);
      void loadPhaseHistory(activeProjectId, phaseNumber);
    }
  };

  type BarItem =
    | { kind: 'phase'; phase: PhaseDefinition }
    | { kind: 'group'; groupId: string; label: string; phases: PhaseDefinition[] };

  const barItems = useMemo((): BarItem[] => {
    if (groupedPhases.size === 0) {
      return phases.map((phase) => ({ kind: 'phase' as const, phase }));
    }
    const inserted = new Set<string>();
    const items: BarItem[] = [];
    for (const phase of phases) {
      if (phase.groupId) {
        if (!inserted.has(phase.groupId)) {
          const data = groupedPhases.get(phase.groupId)!;
          items.push({ kind: 'group', groupId: phase.groupId, label: data.label, phases: data.phases });
          inserted.add(phase.groupId);
        }
        continue;
      }
      items.push({ kind: 'phase', phase });
    }
    return items;
  }, [phases, groupedPhases]);

  return (
    <div className="border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 shrink-0">
      {/* Stage labels */}
      <div className="flex items-end mb-1 gap-1">
        {stages.map((stage, si) => (
          <div
            key={stage.stageNum}
            className="flex flex-col items-center"
            style={{
              flex: stage.phases.length,
              marginLeft: si > 0 ? '2px' : '0',
            }}
          >
            <span className="text-[9px] text-zinc-600 uppercase tracking-wider font-medium mb-1">
              {stage.stageName}
            </span>
          </div>
        ))}
      </div>

      {/* Phase indicators with connectors */}
      <div className="flex items-center">
        {barItems.map((item, idx) => {
          const isLast = idx === barItems.length - 1;

          if (item.kind === 'group') {
            const nextItemForGroup = barItems[idx + 1];
            let nextCompletedForGroup = false;
            if (nextItemForGroup) {
              if (nextItemForGroup.kind === 'phase') {
                nextCompletedForGroup =
                  resolvePhaseDisplayStatus(nextItemForGroup.phase.number, currentPhase, phaseStatus, metricsMap) ===
                  'completed';
              } else {
                nextCompletedForGroup = groupCompleted[nextItemForGroup.groupId] ?? false;
              }
            }

            return (
              <div key={`group-${item.groupId}`} className="flex items-center">
                <TechGroup
                  phases={item.phases}
                  currentPhase={currentPhase}
                  phaseStatus={phaseStatus}
                  metricsMap={metricsMap}
                  onSelectPhase={handleGroupPhaseSelect}
                  groupLabel={item.label}
                />
                {!isLast && (
                  <PhaseConnector completed={(groupCompleted[item.groupId] ?? false) && nextCompletedForGroup} />
                )}
              </div>
            );
          }

          const { phase } = item;
          const displayStatus = resolvePhaseDisplayStatus(phase.number, currentPhase, phaseStatus, metricsMap);
          const metrics = metricsMap.get(phase.number);
          const isHovered = hoveredPhase === phase.number;
          const isCompleted = displayStatus === 'completed';
          const isCurrentPhase = phase.number === currentPhase;
          const isViewingThis = viewingPhase === phase.number;
          const clickable = isCompleted || isCurrentPhase;

          const nextItem = barItems[idx + 1];
          let nextCompleted = false;
          if (nextItem) {
            if (nextItem.kind === 'phase') {
              nextCompleted =
                resolvePhaseDisplayStatus(nextItem.phase.number, currentPhase, phaseStatus, metricsMap) === 'completed';
            } else {
              nextCompleted = groupCompleted[nextItem.groupId] ?? false;
            }
          }

          return (
            <div key={phase.number} className="flex items-center flex-1 min-w-0">
              {/* Phase indicator: two-line layout */}
              <div
                className="relative flex flex-col items-center shrink-0"
                onMouseEnter={() => setHoveredPhase(phase.number)}
                onMouseLeave={() => setHoveredPhase(null)}
              >
                {/* Top line: number + abbreviation */}
                <div
                  className={`
                    flex flex-col items-center gap-0
                    transition-all duration-200
                    ${clickable ? 'cursor-pointer hover:opacity-75' : 'cursor-default'}
                    ${isViewingThis ? 'ring-1 ring-amber-400/60 rounded px-0.5' : ''}
                  `}
                  onClick={() => handlePhaseBadgeClick(phase.number, isCompleted, isCurrentPhase)}
                  role={clickable ? 'button' : undefined}
                  style={{ minWidth: 28 }}
                >
                  <span
                    className={`text-[11px] font-bold leading-none ${STATUS_NUM_COLOR[displayStatus]}`}
                    style={{ fontSize: 11 }}
                  >
                    {phase.number}
                  </span>
                  <span
                    className={`text-[10px] font-medium leading-none mt-0.5 ${STATUS_NUM_COLOR[displayStatus]}`}
                    style={{ fontSize: 10 }}
                  >
                    {phase.abbreviation}
                  </span>
                  {/* Bottom line: status icon or special phase icon */}
                  <div className="mt-1 flex items-center justify-center h-3">
                    {phase.agentId === 'open-design-studio' ? (
                      <PenTool
                        size={10}
                        className={
                          sidecarRunning && isCurrentPhase ? 'text-amber-400' : STATUS_NUM_COLOR[displayStatus]
                        }
                      />
                    ) : phase.agentId === 'design-lock' ? (
                      <Lock size={10} className={STATUS_NUM_COLOR[displayStatus]} />
                    ) : (
                      <PhaseStatusIcon status={displayStatus} />
                    )}
                  </div>
                  {/* History viewing underline indicator */}
                  {isViewingThis && <div className="w-full h-0.5 mt-0.5 rounded bg-amber-400" />}
                </div>

                {/* Tooltip */}
                {isHovered && <PhaseTooltip phase={phase} metrics={metrics} status={displayStatus} />}

                {/* Reset button: only for resetable phases that are completed or running */}
                {phase.resetable && (isCompleted || isCurrentPhase) && onRequestReset && isHovered && (
                  <button
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center rounded-full bg-zinc-800 border border-zinc-600 hover:bg-red-700 hover:border-red-500 transition-colors z-10"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequestReset(phase.number);
                    }}
                    title={`Resetar Fase ${phase.number}: ${phase.name}`}
                  >
                    <RotateCcw size={9} className="text-zinc-400" />
                  </button>
                )}
              </div>

              {/* Connector to next item */}
              {!isLast && <PhaseConnector completed={isCompleted && nextCompleted} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
