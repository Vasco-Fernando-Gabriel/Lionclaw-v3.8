import { Network, Loader2, AlertTriangle, CircleAlert } from 'lucide-react';
import type { RepoGraphBadgeState } from '@/types/repo-graph';


interface RepoGraphBadgeProps {
  state: RepoGraphBadgeState;
  buildPercent?: number;
  onClick?: () => void;
}

interface BadgeVisual {
  tooltip: string;
  className: string;
  clickable: boolean;
}

const VISUALS: Record<RepoGraphBadgeState, BadgeVisual> = {
  'no-repo': {
    tooltip: 'Nenhum repositorio ativo nesta conversa',
    className: 'text-zinc-700',
    clickable: false,
  },
  'graph-absent': {
    tooltip: 'Graph ausente. Clique para criar',
    className: 'text-zinc-600 hover:text-zinc-400 cursor-pointer',
    clickable: true,
  },
  building: {
    tooltip: 'Indexando repositorio',
    className: 'text-blue-400/80',
    clickable: false,
  },
  ready: {
    tooltip: 'CodeGraph pronto',
    className: 'text-zinc-500',
    clickable: false,
  },
  'used-in-turn': {
    tooltip: 'CodeGraph usado neste turno',
    className: 'text-emerald-400',
    clickable: false,
  },
  stale: {
    tooltip: 'Graph desatualizado. Clique para atualizar',
    className: 'text-amber-400 hover:text-amber-300 cursor-pointer',
    clickable: true,
  },
  error: {
    tooltip: 'Erro no CodeGraph',
    className: 'text-red-400/70',
    clickable: false,
  },
  'runtime-limited': {
    tooltip: 'Runtime usando contexto precomputado',
    className: 'text-zinc-400',
    clickable: false,
  },
};

export function RepoGraphBadge({ state, buildPercent, onClick }: RepoGraphBadgeProps) {
  const visual = VISUALS[state];
  const tooltip =
    state === 'building' && buildPercent !== undefined
      ? `${visual.tooltip} (${Math.round(buildPercent)}%)`
      : visual.tooltip;

  return (
    <button
      type="button"
      title={tooltip}
      aria-label={tooltip}
      data-state={state}
      onClick={visual.clickable && onClick ? onClick : undefined}
      className={`relative inline-flex items-center gap-1 px-1.5 py-1 rounded-md transition-colors ${visual.className}`}
    >
      {state === 'building' ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <Network size={14} />
      )}
      {state === 'runtime-limited' && (
        <AlertTriangle size={9} className="absolute -top-0.5 -right-0.5 text-amber-400" />
      )}
      {state === 'error' && (
        <CircleAlert size={9} className="absolute -top-0.5 -right-0.5 text-red-400" />
      )}
      {state === 'building' && buildPercent !== undefined && (
        <span className="text-[10px] tabular-nums">{Math.round(buildPercent)}%</span>
      )}
    </button>
  );
}
