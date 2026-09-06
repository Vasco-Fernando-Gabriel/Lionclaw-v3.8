import { useEffect, useMemo } from 'react';
import { Loader2, Pause } from 'lucide-react';
import { useAppStore } from '@/stores/app-store';
import { useChatStore } from '@/stores/chat-store';
import { useDynamicWorkflowStore } from '@/stores/dynamic-workflow-store';
import { useStreamTimer } from '@/components/chat/useStreamTimer';
import type { DynamicWorkflowRun, DynamicWorkflowRunStatus } from '@/types';


const ACTIVE_RUN_STATUSES: ReadonlySet<DynamicWorkflowRunStatus> = new Set<DynamicWorkflowRunStatus>([
  'running',
  'paused',
  'blocked',
  'interrupted',
  'delivered',
]);

const AWAITING_RUN_STATUSES: ReadonlySet<DynamicWorkflowRunStatus> = new Set<DynamicWorkflowRunStatus>([
  'blocked',
  'delivered',
]);

export function parseRunStartedAt(startedAt: string | null | undefined): number | null {
  if (!startedAt) return null;
  const ms = Date.parse(startedAt);
  return Number.isNaN(ms) ? null : ms;
}

export function selectChatBoundActiveRuns(
  runs: DynamicWorkflowRun[],
  sessionId: string | null,
): DynamicWorkflowRun[] {
  if (!sessionId) return [];
  const active = runs.filter(
    (r) => r.chatSessionId === sessionId && ACTIVE_RUN_STATUSES.has(r.status),
  );
  active.sort(
    (a, b) => (parseRunStartedAt(b.startedAt) ?? 0) - (parseRunStartedAt(a.startedAt) ?? 0),
  );
  return active;
}

export function workflowIndicatorLabel(run: DynamicWorkflowRun): string {
  const base = run.currentPhaseId ?? run.id;
  if (run.currentPhaseId && run.currentNodeId) {
    return `${base}/${run.currentNodeId}`;
  }
  return base;
}

export function BackgroundWorkflowIndicator() {
  const runs = useDynamicWorkflowStore((s) => s.runs);
  const loadRuns = useDynamicWorkflowStore((s) => s.loadRuns);
  const openRun = useDynamicWorkflowStore((s) => s.openRun);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const setPage = useAppStore((s) => s.setPage);

  useEffect(() => {
    if (runs.length === 0) void loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeRuns = useMemo(
    () => selectChatBoundActiveRuns(runs, currentSessionId),
    [runs, currentSessionId],
  );
  const top: DynamicWorkflowRun | null = activeRuns[0] ?? null;

  const startedAtMs = top ? parseRunStartedAt(top.startedAt) : null;
  const elapsed = useStreamTimer(top !== null && startedAtMs !== null, startedAtMs);

  if (!top) return null;

  const awaiting = AWAITING_RUN_STATUSES.has(top.status);
  const label = workflowIndicatorLabel(top);
  const extraCount = activeRuns.length - 1;

  return (
    <button
      type="button"
      data-testid="background-workflow-indicator"
      onClick={() => {
        void openRun(top.id);
        setPage('dynamic-workflow');
      }}
      title={
        awaiting
          ? `O workflow aguarda voce. Clique para abrir o run.`
          : `Workflow em andamento nesta conversa. Clique para abrir o run.`
      }
      className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400 hover:bg-amber-500/20 transition-colors min-w-0"
    >
      {awaiting ? (
        <Pause size={10} className="shrink-0" aria-hidden="true" />
      ) : (
        <Loader2 size={10} className="animate-spin shrink-0" aria-hidden="true" />
      )}
      <span className="truncate max-w-[200px]">
        {label}
        {awaiting ? ' - aguardando voce' : ''}
      </span>
      {elapsed ? <span className="font-mono tabular-nums shrink-0">{elapsed}</span> : null}
      {extraCount > 0 ? (
        <span
          className="shrink-0 rounded-full bg-amber-500/20 px-1 leading-none"
          title={`Mais ${extraCount} workflow(s) ativo(s) nesta conversa`}
        >
          +{extraCount}
        </span>
      ) : null}
    </button>
  );
}
