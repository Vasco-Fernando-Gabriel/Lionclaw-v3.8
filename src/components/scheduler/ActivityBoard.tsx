import { useState, useEffect, useCallback } from 'react';
import { LayoutGrid, Calendar } from 'lucide-react';
import type { ActivityItem, ActivityStats, ActivityFilters } from '@/types';
import { ActivityFiltersBar } from './ActivityFilters';
import { KanbanView } from './KanbanView';
import { CalendarView } from './CalendarView';

interface Props {
  onViewSession: (sessionId: string, runId: number, reviewStatus?: string | null) => void;
}

function getTodayRange(): { from: string; to: string } {
  const d = new Date();
  const from = d.toISOString().slice(0, 10);
  const next = new Date(d);
  next.setDate(next.getDate() + 1);
  return { from, to: next.toISOString().slice(0, 10) };
}

export function ActivityBoard({ onViewSession }: Props) {
  const [viewMode, setViewMode] = useState<'kanban' | 'calendar'>('kanban');
  const [filters, setFilters] = useState<ActivityFilters>(() => getTodayRange());
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [stats, setStats] = useState<ActivityStats>({ scheduled: 0, running: 0, success: 0, error: 0 });
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadActivities = useCallback(async () => {
    setIsLoading(true);
    try {
      const [items, activityStats, tags] = await Promise.all([
        window.lionclaw.scheduler.getActivities(filters),
        window.lionclaw.scheduler.getActivityStats(filters.from, filters.to),
        window.lionclaw.scheduler.getAllTags(),
      ]);
      setActivities(items);
      setStats(activityStats);
      setAvailableTags(tags);
    } catch (err) {
      console.error('Failed to load activities:', err);
    }
    setIsLoading(false);
  }, [filters]);

  useEffect(() => {
    loadActivities();
  }, [loadActivities]);

  useEffect(() => {
    const interval = setInterval(loadActivities, 30_000);
    return () => clearInterval(interval);
  }, [loadActivities]);

  const handleFiltersChange = (f: ActivityFilters) => {
    setFilters(f);
  };

  const handleCalendarPeriodChange = (period: { from: string; to: string }) => {
    setFilters(prev => ({ ...prev, from: period.from, to: period.to }));
  };

  const total = stats.scheduled + stats.running + stats.success + stats.error;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header with stats */}
      <div className="px-6 py-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold text-zinc-100">Agenda</h2>
          {total > 0 && (
            <div className="flex items-center gap-2 text-[11px]">
              {stats.scheduled > 0 && (
                <span className="px-2 py-0.5 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-full">
                  {stats.scheduled} agendado{stats.scheduled !== 1 ? 's' : ''}
                </span>
              )}
              {stats.running > 0 && (
                <span className="px-2 py-0.5 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-full">
                  {stats.running} executando
                </span>
              )}
              {stats.success > 0 && (
                <span className="px-2 py-0.5 bg-green-500/10 text-green-400 border border-green-500/20 rounded-full">
                  {stats.success} ok
                </span>
              )}
              {stats.error > 0 && (
                <span className="px-2 py-0.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded-full">
                  {stats.error} erro{stats.error !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          )}
        </div>

        {/* View toggle */}
        <div className="flex gap-1 bg-zinc-800 rounded-lg p-1">
          <button
            onClick={() => setViewMode('kanban')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              viewMode === 'kanban' ? 'bg-amber-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <LayoutGrid size={14} />
            Kanban
          </button>
          <button
            onClick={() => setViewMode('calendar')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              viewMode === 'calendar' ? 'bg-amber-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Calendar size={14} />
            Calendario
          </button>
        </div>
      </div>

      {/* Filters */}
      <ActivityFiltersBar
        filters={filters}
        onChange={handleFiltersChange}
        availableTags={availableTags}
      />

      {/* View content */}
      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : viewMode === 'kanban' ? (
          <KanbanView activities={activities} onViewSession={onViewSession} />
        ) : (
          <CalendarView
            activities={activities}
            period={{ from: filters.from, to: filters.to }}
            onPeriodChange={handleCalendarPeriodChange}
            onViewSession={onViewSession}
          />
        )}
      </div>
    </div>
  );
}
