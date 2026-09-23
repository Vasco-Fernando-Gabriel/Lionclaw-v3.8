import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ActivityItem } from '@/types';
import { ActivityCard } from './ActivityCard';

interface Props {
  activities: ActivityItem[];
  period: { from: string; to: string };
  onPeriodChange: (period: { from: string; to: string }) => void;
  onViewSession: (sessionId: string, runId: number, reviewStatus?: string | null) => void;
}

interface CalendarDay {
  date: string;
  dayNumber: number;
  isCurrentMonth: boolean;
}

function generateCalendarGrid(fromDate: string): CalendarDay[] {
  const d = new Date(fromDate + 'T00:00:00');
  const year = d.getFullYear();
  const month = d.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startOffset = firstDay.getDay();
  const days: CalendarDay[] = [];

  for (let i = startOffset - 1; i >= 0; i--) {
    const prev = new Date(year, month, -i);
    days.push({
      date: prev.toISOString().slice(0, 10),
      dayNumber: prev.getDate(),
      isCurrentMonth: false,
    });
  }

  for (let day = 1; day <= lastDay.getDate(); day++) {
    const dt = new Date(year, month, day);
    days.push({
      date: dt.toISOString().slice(0, 10),
      dayNumber: day,
      isCurrentMonth: true,
    });
  }

  const remaining = 7 - (days.length % 7);
  if (remaining < 7) {
    for (let i = 1; i <= remaining; i++) {
      const next = new Date(year, month + 1, i);
      days.push({
        date: next.toISOString().slice(0, 10),
        dayNumber: next.getDate(),
        isCurrentMonth: false,
      });
    }
  }

  return days;
}

function formatMonthYear(fromDate: string): string {
  const d = new Date(fromDate + 'T00:00:00');
  const months = [
    'Janeiro',
    'Fevereiro',
    'Marco',
    'Abril',
    'Maio',
    'Junho',
    'Julho',
    'Agosto',
    'Setembro',
    'Outubro',
    'Novembro',
    'Dezembro',
  ];
  return `${months[d.getMonth()]} ${d.getFullYear()}`;
}

export function CalendarView({ activities, period, onPeriodChange, onViewSession }: Props) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const todayStr = new Date().toISOString().slice(0, 10);

  const byDay = useMemo(() => {
    const map = new Map<string, ActivityItem[]>();
    for (const a of activities) {
      const day = a.scheduledFor.slice(0, 10);
      if (!map.has(day)) map.set(day, []);
      map.get(day)!.push(a);
    }
    return map;
  }, [activities]);

  const calendarDays = useMemo(() => generateCalendarGrid(period.from), [period.from]);

  const navigateMonth = (delta: number) => {
    const d = new Date(period.from + 'T00:00:00');
    d.setMonth(d.getMonth() + delta);
    const from = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
    const to = new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString().slice(0, 10);
    onPeriodChange({ from, to });
  };

  const formatDayHeader = (dateStr: string): string => {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  };

  return (
    <div className="flex gap-4 h-full">
      <div className="flex-1 flex flex-col">
        {/* Month navigation */}
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => navigateMonth(-1)}
            className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <ChevronLeft size={18} />
          </button>
          <h3 className="text-sm font-semibold text-zinc-200">{formatMonthYear(period.from)}</h3>
          <button
            onClick={() => navigateMonth(1)}
            className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <ChevronRight size={18} />
          </button>
        </div>

        {/* Weekday headers */}
        <div className="grid grid-cols-7 gap-px mb-1">
          {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'].map((d) => (
            <div key={d} className="text-center text-[10px] text-zinc-500 py-1">
              {d}
            </div>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7 gap-px flex-1">
          {calendarDays.map((day) => {
            const items = byDay.get(day.date) || [];
            const isToday = day.date === todayStr;
            const isSelected = selectedDay === day.date;
            const successCount = items.filter((i) => i.status === 'success').length;
            const errorCount = items.filter((i) => i.status === 'error').length;
            const scheduledCount = items.filter((i) => i.status === 'scheduled').length;
            const runningCount = items.filter((i) => i.status === 'running').length;

            return (
              <button
                key={day.date}
                onClick={() => setSelectedDay(day.date === selectedDay ? null : day.date)}
                className={`
                  min-h-[80px] p-1.5 rounded-lg border transition-colors text-left
                  ${isToday ? 'border-amber-500/30 bg-amber-500/5' : 'border-zinc-800 bg-zinc-900/30'}
                  ${isSelected ? 'ring-1 ring-amber-500' : ''}
                  ${!day.isCurrentMonth ? 'opacity-30' : ''}
                  hover:bg-zinc-800/50
                `}
              >
                <span className={`text-xs ${isToday ? 'text-amber-400 font-semibold' : 'text-zinc-400'}`}>
                  {day.dayNumber}
                </span>

                {items.length > 0 && (
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {successCount > 0 && (
                      <span className="px-1 py-0.5 text-[9px] bg-green-500/20 text-green-400 rounded">
                        {successCount} ok
                      </span>
                    )}
                    {errorCount > 0 && (
                      <span className="px-1 py-0.5 text-[9px] bg-red-500/20 text-red-400 rounded">
                        {errorCount} erro
                      </span>
                    )}
                    {runningCount > 0 && (
                      <span className="px-1 py-0.5 text-[9px] bg-amber-500/20 text-amber-400 rounded">
                        {runningCount} exec
                      </span>
                    )}
                    {scheduledCount > 0 && (
                      <span className="px-1 py-0.5 text-[9px] bg-blue-500/20 text-blue-400 rounded">
                        {scheduledCount} agend
                      </span>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Day detail panel */}
      {selectedDay && (
        <div className="w-80 border-l border-zinc-800 pl-4 overflow-y-auto shrink-0">
          <h3 className="text-sm font-medium text-zinc-200 mb-3 capitalize">{formatDayHeader(selectedDay)}</h3>
          <div className="space-y-2">
            {(byDay.get(selectedDay) || []).length === 0 ? (
              <p className="text-xs text-zinc-600 py-4 text-center">Nenhuma atividade neste dia</p>
            ) : (
              (byDay.get(selectedDay) || []).map((item) => (
                <ActivityCard key={`${item.taskId}-${item.runId}`} item={item} onViewSession={onViewSession} compact />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
