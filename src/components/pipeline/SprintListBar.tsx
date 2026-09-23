import { useState } from 'react';
import { Check, X, RotateCcw, Loader2 } from 'lucide-react';
import type { SprintStatus } from '@/stores/pipeline-store';

type SprintDisplayStatus = 'pending' | 'running' | 'passed' | 'failed';

function resolveSprintDisplayStatus(sprint: SprintStatus, currentSprintIndex: number | null): SprintDisplayStatus {
  const v = sprint.verdict?.toLowerCase() ?? '';
  if (v === 'pass' || v === 'passed' || v === 'accepted' || v === 'completed') return 'passed';
  if (v === 'fail' || v === 'failed' || v === 'rejected') return 'failed';
  if (sprint.index === currentSprintIndex) return 'running';
  return 'pending';
}

function SprintStatusIcon({ status }: { status: SprintDisplayStatus }) {
  if (status === 'passed') {
    return <Check size={10} strokeWidth={3} className="text-green-400" />;
  }
  if (status === 'running') {
    return <Loader2 size={10} className="text-amber-400 animate-spin" />;
  }
  if (status === 'failed') {
    return <X size={10} strokeWidth={3} className="text-red-400" />;
  }
  return <span className="inline-block w-2 h-2 rounded-full" style={{ border: '1.5px dashed #52525b' }} />;
}

function sprintBadgeClass(status: SprintDisplayStatus, isActive: boolean): string {
  const base =
    'flex flex-col items-center justify-center gap-0.5 px-2 py-1 rounded border transition-all duration-150 cursor-pointer shrink-0 select-none';

  if (isActive) {
    return `${base} ring-1 ring-amber-400 border-amber-500/60 bg-amber-500/10`;
  }

  switch (status) {
    case 'passed':
      return `${base} border-green-700/50 bg-green-600/10 hover:bg-green-600/20`;
    case 'running':
      return `${base} border-amber-500/50 bg-amber-500/10`;
    case 'failed':
      return `${base} border-red-500/50 bg-red-500/10 hover:bg-red-500/15`;
    default:
      return `${base} border-zinc-700 bg-zinc-900 hover:bg-zinc-800`;
  }
}

function sprintLabelColor(status: SprintDisplayStatus, isActive: boolean): string {
  if (isActive) return 'text-amber-300';
  switch (status) {
    case 'passed':
      return 'text-green-400';
    case 'running':
      return 'text-amber-300';
    case 'failed':
      return 'text-red-400';
    default:
      return 'text-zinc-600';
  }
}

export interface SprintListBarProps {
  sprints: SprintStatus[];
  currentSprintIndex: number | null;
  onSelectSprint: (sprintIndex: number) => void;
  onRequestReset: (sprintIndex: number) => void;
}

export function SprintListBar({ sprints, currentSprintIndex, onSelectSprint, onRequestReset }: SprintListBarProps) {
  const [hoveredSprint, setHoveredSprint] = useState<number | null>(null);

  if (sprints.length === 0) return null;

  return (
    <div className="border-b border-zinc-800 bg-zinc-950/60 px-4 shrink-0 h-11 flex items-center">
      <div className="flex items-center gap-1.5 overflow-x-auto py-1">
        {sprints.map((sprint) => {
          const isActive = sprint.index === currentSprintIndex;
          const status = resolveSprintDisplayStatus(sprint, currentSprintIndex);
          const isHovered = hoveredSprint === sprint.index;
          const badgeClass = sprintBadgeClass(status, isActive);
          const labelColor = sprintLabelColor(status, isActive);

          return (
            <div
              key={sprint.index}
              className="relative"
              onMouseEnter={() => setHoveredSprint(sprint.index)}
              onMouseLeave={() => setHoveredSprint(null)}
            >
              <button
                className={badgeClass}
                onClick={() => onSelectSprint(sprint.index)}
                title={`Sprint ${sprint.index + 1}: ${sprint.name} — ${sprint.verdict ?? 'pendente'}`}
                style={{ minWidth: 36 }}
              >
                <span className={`text-[10px] font-bold leading-none ${labelColor}`}>S{sprint.index + 1}</span>
                <div className="flex items-center justify-center h-3">
                  <SprintStatusIcon status={status} />
                </div>
              </button>

              {/* Reset icon on hover */}
              {isHovered && (
                <button
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center rounded-full bg-zinc-800 border border-zinc-600 hover:bg-zinc-700 hover:border-zinc-500 transition-colors z-10"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestReset(sprint.index);
                  }}
                  title={`Resetar Sprint ${sprint.index + 1}`}
                >
                  <RotateCcw size={9} className="text-zinc-400" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
