import type { ActivityItem } from '@/types';
import { ActivityCard } from './ActivityCard';

interface Props {
  activities: ActivityItem[];
  onViewSession: (sessionId: string, runId: number, reviewStatus?: string | null) => void;
}

interface ColumnProps {
  title: string;
  count: number;
  colorDot: string;
  items: ActivityItem[];
  onViewSession: Props['onViewSession'];
}

function KanbanColumn({ title, count, colorDot, items, onViewSession }: ColumnProps) {
  return (
    <div className="flex flex-col bg-zinc-900/50 rounded-xl border border-zinc-800 min-h-0">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2 shrink-0">
        <div className={`w-2 h-2 rounded-full ${colorDot}`} />
        <span className="text-sm font-medium text-zinc-300">{title}</span>
        <span className="text-xs text-zinc-500 ml-auto">{count}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {items.map(item => (
          <ActivityCard
            key={`${item.taskId}-${item.runId}-${item.scheduledFor}`}
            item={item}
            onViewSession={onViewSession}
          />
        ))}
        {items.length === 0 && (
          <p className="text-xs text-zinc-600 text-center py-8">Nenhuma atividade</p>
        )}
      </div>
    </div>
  );
}

export function KanbanView({ activities, onViewSession }: Props) {
  const scheduled = activities.filter(a => a.status === 'scheduled');
  const running = activities.filter(a => a.status === 'running');
  const done = activities.filter(a => a.status === 'success' || a.status === 'error');

  return (
    <div className="grid grid-cols-3 gap-4 h-full">
      <KanbanColumn
        title="Agendado"
        count={scheduled.length}
        colorDot="bg-blue-400"
        items={scheduled}
        onViewSession={onViewSession}
      />
      <KanbanColumn
        title="Executando"
        count={running.length}
        colorDot="bg-amber-400"
        items={running}
        onViewSession={onViewSession}
      />
      <KanbanColumn
        title="Concluido"
        count={done.length}
        colorDot="bg-green-400"
        items={done}
        onViewSession={onViewSession}
      />
    </div>
  );
}
