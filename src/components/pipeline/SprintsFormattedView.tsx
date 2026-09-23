import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { HarnessSprint } from '@/types';

interface SprintsFormattedViewProps {
  sprints: HarnessSprint[];
}

interface SprintCardProps {
  sprint: HarnessSprint;
  sprintNumber: number;
}

function SprintCard({ sprint, sprintNumber }: SprintCardProps) {
  const [expanded, setExpanded] = useState(false);

  const agentLabel = sprint.coderAgentId ?? null;

  return (
    <div className="border border-zinc-800 rounded-xl bg-zinc-900/60 overflow-hidden transition-all duration-200">
      {/* Header - always visible, click to toggle */}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/40 transition-colors"
      >
        {/* Sprint label */}
        <div className="flex-1 min-w-0 flex items-center gap-2.5">
          <span className="text-sm font-semibold text-zinc-100 shrink-0">
            S{sprintNumber} - {sprint.name}
          </span>

          {/* Agent chip */}
          {agentLabel && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 shrink-0">
              {agentLabel}
            </span>
          )}
        </div>

        {/* Chevron icon */}
        <div className="shrink-0 text-zinc-500">{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</div>
      </button>

      {/* Expandable body */}
      {expanded && (
        <div className="px-4 pb-4 pt-1 border-t border-zinc-800/60 space-y-3">
          {/* Agent name row (if available) */}
          {agentLabel && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-zinc-500 uppercase font-medium">Agente</span>
              <span className="text-xs text-zinc-300">{agentLabel}</span>
            </div>
          )}

          {/* Rounds info */}
          <div className="flex items-center gap-4 text-xs text-zinc-500">
            <span>
              Rodadas usadas: <span className="text-zinc-300">{sprint.roundsUsed}</span>
            </span>
            <span>
              Limite: <span className="text-zinc-300">{sprint.maxRounds}</span>
            </span>
          </div>

          {/* Sprint index for reference */}
          <div className="text-[11px] text-zinc-600">ID: {sprint.id}</div>
        </div>
      )}
    </div>
  );
}

export function SprintsFormattedView({ sprints }: SprintsFormattedViewProps) {
  if (sprints.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-sm text-zinc-500">Ainda nao ha artefato para esta fase.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 max-w-3xl mx-auto">
      <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
        Plano de sprints ({sprints.length} {sprints.length === 1 ? 'sprint' : 'sprints'})
      </h2>
      {sprints.map((sprint, index) => (
        <SprintCard key={sprint.id} sprint={sprint} sprintNumber={index + 1} />
      ))}
    </div>
  );
}
