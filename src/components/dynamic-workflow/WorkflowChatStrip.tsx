import { useMemo } from 'react';
import { Workflow, Loader2, Pause, FolderGit2 } from 'lucide-react';
import { useAppStore } from '@/stores/app-store';
import { useChatStore } from '@/stores/chat-store';
import { useDynamicWorkflowStore } from '@/stores/dynamic-workflow-store';
import { selectChatBoundActiveRuns, workflowIndicatorLabel } from './BackgroundWorkflowIndicator';
import type { DynamicWorkflowRun } from '@/types';

function StatusBadge({ run }: { run: DynamicWorkflowRun }) {
  const awaiting = run.status === 'blocked' || run.status === 'delivered';
  const text =
    run.status === 'blocked'
      ? 'aguardando gate'
      : run.status === 'delivered'
        ? 'fechamento'
        : run.status === 'paused'
          ? 'pausado'
          : run.status === 'interrupted'
            ? 'interrompido'
            : 'executando';
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-medium ${
        awaiting ? 'text-amber-400' : 'text-amber-300'
      }`}
    >
      {awaiting ? (
        <Pause size={10} className="shrink-0" aria-hidden="true" />
      ) : (
        <Loader2 size={10} className="animate-spin shrink-0" aria-hidden="true" />
      )}
      {text}
    </span>
  );
}

function formatStripCost(costUsd: number): string {
  if (costUsd === 0) return '$0';
  if (costUsd < 0.001) return '<$0.001';
  if (costUsd < 0.01) return `~$${costUsd.toFixed(4)}`;
  return `~$${costUsd.toFixed(3)}`;
}

export function WorkflowChatStrip({ repoLabel }: { repoLabel?: string | null }) {
  const runs = useDynamicWorkflowStore((s) => s.runs);
  const openRun = useDynamicWorkflowStore((s) => s.openRun);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const setPage = useAppStore((s) => s.setPage);

  const top = useMemo<DynamicWorkflowRun | null>(
    () => selectChatBoundActiveRuns(runs, currentSessionId)[0] ?? null,
    [runs, currentSessionId],
  );

  if (!top) return null;

  const name = workflowIndicatorLabel(top);
  const phase = top.currentPhaseId ?? '-';
  const node = top.currentNodeId ?? '-';

  return (
    <button
      type="button"
      data-testid="workflow-chat-strip"
      onClick={() => {
        void openRun(top.id);
        setPage('dynamic-workflow');
      }}
      title="Workflow ativo nesta conversa. Clique para abrir o run."
      className="flex w-full items-center gap-2 border-b border-zinc-800 bg-zinc-950/80 px-3 py-1.5 text-left transition-colors hover:bg-zinc-900/80"
    >
      <Workflow size={14} className="shrink-0 text-amber-400" aria-hidden="true" />
      {repoLabel ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400 min-w-0">
          <FolderGit2 size={11} className="shrink-0 text-zinc-500" aria-hidden="true" />
          <span className="truncate max-w-[140px]">{repoLabel}</span>
        </span>
      ) : null}
      <span className="truncate text-[11px] font-medium text-zinc-200 max-w-[180px]">{name}</span>
      <span className="hidden items-center gap-1.5 font-mono text-[10px] text-zinc-500 sm:inline-flex">
        <span>
          fase <span className="text-zinc-300">{phase}</span>
        </span>
        <span className="text-zinc-700">·</span>
        <span>
          node <span className="text-zinc-300">{node}</span>
        </span>
      </span>
      <span className="ml-auto inline-flex items-center gap-2 shrink-0">
        <span className="font-mono text-[10px] text-zinc-400">{formatStripCost(top.totalCostUsd)}</span>
        <StatusBadge run={top} />
      </span>
    </button>
  );
}
