import { Clock, Loader2, CheckCircle2, XCircle, Eye } from 'lucide-react';
import type { ActivityItem } from '@/types';

interface Props {
  item: ActivityItem;
  onViewSession: (sessionId: string, runId: number, reviewStatus?: string | null) => void;
  compact?: boolean;
}

const statusConfig = {
  scheduled: { label: 'Agendado', Icon: Clock },
  running:   { label: 'Executando', Icon: Loader2 },
  success:   { label: 'Concluido', Icon: CheckCircle2 },
  error:     { label: 'Erro', Icon: XCircle },
} as const;

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function ActivityCard({ item, onViewSession, compact }: Props) {
  const cfg = statusConfig[item.status];

  return (
    <div
      className={`
        bg-zinc-800/50 border border-zinc-700/50 rounded-lg
        hover:border-zinc-600 transition-colors group
        ${compact ? 'p-2' : 'p-3'}
      `}
    >
      <div className="flex items-center gap-2 mb-1">
        <cfg.Icon
          size={12}
          className={`shrink-0 ${
            item.status === 'scheduled' ? 'text-blue-400' :
            item.status === 'running'   ? 'text-amber-400 animate-spin' :
            item.status === 'success'   ? 'text-green-400' :
                                          'text-red-400'
          }`}
        />
        {/* SPEC robustez-chat SB-10 (P14): texto truncado ganha o completo em title */}
        <span title={item.taskName} className="text-xs font-medium text-zinc-200 truncate flex-1">
          {item.taskName}
        </span>
      </div>

      <div className="flex items-center gap-2 text-[10px] text-zinc-500">
        <span>{formatTime(item.scheduledFor)}</span>
        {item.subagent && (
          <>
            <span>-</span>
            <span className="text-amber-500/70">{item.subagent}</span>
          </>
        )}
      </div>

      {item.tags.length > 0 && (
        <div className="flex gap-1 mt-1.5 flex-wrap">
          {item.tags.map(tag => (
            <span key={tag} className="px-1.5 py-0.5 text-[9px] bg-zinc-700 text-zinc-400 rounded">
              {tag}
            </span>
          ))}
        </div>
      )}

      {item.reviewStatus === 'pending_review' && (
        <span className="mt-1.5 inline-block px-1.5 py-0.5 text-[9px] bg-amber-500/20 text-amber-400 rounded font-medium">
          pendente review
        </span>
      )}

      {item.error && (
        <p title={item.error} className="mt-1.5 text-[10px] text-red-400 truncate">{item.error}</p>
      )}

      {item.sessionId && (
        <button
          onClick={() => onViewSession(item.sessionId!, item.runId, item.reviewStatus)}
          className="mt-2 text-[10px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Eye size={10} /> Ver sessao
        </button>
      )}
    </div>
  );
}
