import { useState, useEffect } from 'react';
import type { AgentConfig, ActivityFilters as FiltersType } from '@/types';

interface Props {
  filters: FiltersType;
  onChange: (f: FiltersType) => void;
  availableTags: string[];
}

function getTodayRange(): { from: string; to: string } {
  const d = new Date();
  const from = d.toISOString().slice(0, 10);
  const next = new Date(d);
  next.setDate(next.getDate() + 1);
  const to = next.toISOString().slice(0, 10);
  return { from, to };
}

function getWeekRange(): { from: string; to: string } {
  const d = new Date();
  const day = d.getDay();
  const start = new Date(d);
  start.setDate(start.getDate() - day);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function getMonthRange(): { from: string; to: string } {
  const d = new Date();
  const from = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
  const to = new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString().slice(0, 10);
  return { from, to };
}

export function ActivityFiltersBar({ filters, onChange, availableTags }: Props) {
  const [agents, setAgents] = useState<AgentConfig[]>([]);

  useEffect(() => {
    window.lionclaw.agents.list().then(setAgents).catch(() => {});
  }, []);

  const today = getTodayRange();
  const week = getWeekRange();
  const month = getMonthRange();

  const isToday = filters.from === today.from && filters.to === today.to;
  const isWeek = filters.from === week.from && filters.to === week.to;
  const isMonth = filters.from === month.from && filters.to === month.to;

  const chipClass = (active: boolean) =>
    `px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
      active
        ? 'bg-amber-600 text-white'
        : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-700'
    }`;

  return (
    <div className="px-6 py-2 flex items-center gap-3 border-b border-zinc-800 flex-wrap">
      <div className="flex gap-1">
        <button className={chipClass(isToday)} onClick={() => onChange({ ...filters, ...today })}>
          Hoje
        </button>
        <button className={chipClass(isWeek)} onClick={() => onChange({ ...filters, ...week })}>
          Semana
        </button>
        <button className={chipClass(isMonth)} onClick={() => onChange({ ...filters, ...month })}>
          Mes
        </button>
      </div>

      <div className="w-px h-5 bg-zinc-700" />

      <input
        type="date"
        value={filters.from}
        onChange={(e) => onChange({ ...filters, from: e.target.value })}
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none focus:border-amber-600"
      />
      <span className="text-zinc-600 text-xs">ate</span>
      <input
        type="date"
        value={filters.to}
        onChange={(e) => onChange({ ...filters, to: e.target.value })}
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none focus:border-amber-600"
      />

      <div className="w-px h-5 bg-zinc-700" />

      <select
        value={filters.subagent || ''}
        onChange={(e) => onChange({ ...filters, subagent: e.target.value || undefined })}
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none focus:border-amber-600"
      >
        <option value="">Todos agentes</option>
        {agents.map(a => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>

      <select
        value={filters.status || ''}
        onChange={(e) =>
          onChange({ ...filters, status: (e.target.value || undefined) as FiltersType['status'] })
        }
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none focus:border-amber-600"
      >
        <option value="">Todos status</option>
        <option value="scheduled">Agendado</option>
        <option value="running">Executando</option>
        <option value="success">Sucesso</option>
        <option value="error">Erro</option>
      </select>

      {availableTags.length > 0 && (
        <>
          <div className="w-px h-5 bg-zinc-700" />
          <div className="flex gap-1 flex-wrap">
            {availableTags.map(tag => {
              const isSelected = filters.tags?.includes(tag);
              return (
                <button
                  key={tag}
                  onClick={() => {
                    const current = filters.tags || [];
                    const next = isSelected
                      ? current.filter(t => t !== tag)
                      : [...current, tag];
                    onChange({ ...filters, tags: next.length > 0 ? next : undefined });
                  }}
                  className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                    isSelected
                      ? 'bg-amber-600/30 text-amber-400 border border-amber-500/30'
                      : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-300'
                  }`}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
