import { Workflow, Bot, Loader2, CheckCircle2, AlertTriangle, Ban, Lock, Hand } from 'lucide-react';
import { useAppStore } from '@/stores/app-store';
import { useDynamicWorkflowStore, type DynamicWorkflowUIStatus } from '@/stores/dynamic-workflow-store';
import type { LiveActivity, LiveActivityStatus, DynamicWorkflowRun } from '@/types';

export interface WorkflowActivityNode extends LiveActivity {
  children: WorkflowActivityNode[];
}

const STATUS_TEXT: Record<LiveActivityStatus, string> = {
  running: 'Executando',
  done: 'Concluido',
  error: 'Erro',
  stopped: 'Parado',
};

const STATUS_TEXT_CLASS: Record<LiveActivityStatus, string> = {
  running: 'text-amber-400',
  done: 'text-emerald-400',
  error: 'text-red-400',
  stopped: 'text-zinc-500',
};

function StatusIcon({ status }: { status: LiveActivityStatus }) {
  if (status === 'running') return <Loader2 className="w-3 h-3 shrink-0 text-amber-400 animate-spin" />;
  if (status === 'done') return <CheckCircle2 className="w-3 h-3 shrink-0 text-emerald-400" />;
  if (status === 'error') return <AlertTriangle className="w-3 h-3 shrink-0 text-red-400" />;
  return <Ban className="w-3 h-3 shrink-0 text-zinc-500" />;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${(tokens / 1_000).toFixed(1)}K`;
  if (tokens >= 1_000) return tokens.toLocaleString();
  return String(tokens);
}

function formatCost(costUsd?: number): string | null {
  if (typeof costUsd !== 'number') return null;
  if (costUsd === 0) return '$0';
  if (costUsd < 0.001) return '<$0.001';
  if (costUsd < 0.01) return `~$${costUsd.toFixed(4)}`;
  return `~$${costUsd.toFixed(3)}`;
}

function formatDuration(ms?: number): string | null {
  if (typeof ms !== 'number' || ms <= 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem}s`;
}

function formatLiveClock(node: LiveActivity, now: number): string | null {
  if (node.status === 'running') {
    if (!node.startedAt) return null;
    const started = Date.parse(node.startedAt);
    if (Number.isNaN(started)) return null;
    return formatDuration(Math.max(0, now - started));
  }
  if (typeof node.durationMs === 'number' && node.durationMs > 0) {
    return formatDuration(node.durationMs);
  }
  if (node.startedAt && node.endedAt) {
    const a = Date.parse(node.startedAt);
    const b = Date.parse(node.endedAt);
    if (!Number.isNaN(a) && !Number.isNaN(b) && b > a) return formatDuration(b - a);
  }
  return null;
}

function uiToActivityStatus(ui: DynamicWorkflowUIStatus): LiveActivityStatus {
  if (ui === 'completed') return 'done';
  if (ui === 'failed') return 'error';
  if (ui === 'aborted' || ui === 'interrupted' || ui === 'paused' || ui === 'pausing') {
    return 'stopped';
  }
  return 'running';
}

function formatRunClock(run: DynamicWorkflowRun, isRunning: boolean, now: number): string | null {
  if (isRunning && run.startedAt) {
    const started = Date.parse(run.startedAt);
    if (!Number.isNaN(started)) return formatDuration(Math.max(0, now - started));
  }
  if (typeof run.totalDurationMs === 'number' && run.totalDurationMs > 0) {
    return formatDuration(run.totalDurationMs);
  }
  return null;
}

function WorkflowChildRow({ node, now }: { node: WorkflowActivityNode; now: number }) {
  const tin = node.tokens?.input ?? 0;
  const tout = node.tokens?.output ?? 0;
  const hasTokens = tin > 0 || tout > 0;
  const cost = formatCost(node.costUsd);
  const clock = formatLiveClock(node, now);

  return (
    <div className="rounded border border-zinc-800/70 bg-zinc-900/30 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <Bot className={`w-3.5 h-3.5 shrink-0 ${node.status === 'running' ? 'text-amber-400' : 'text-zinc-500'}`} />
        <span className={`truncate text-xs ${node.status === 'running' ? 'text-zinc-200' : 'text-zinc-300'}`}>
          {node.label}
        </span>
        <span className={`ml-auto shrink-0 text-[10px] font-medium ${STATUS_TEXT_CLASS[node.status]}`}>
          {STATUS_TEXT[node.status]}
        </span>
        <StatusIcon status={node.status} />
      </div>
      {node.description && (
        <div className="mt-0.5 truncate pl-5 text-[10px] text-zinc-500" title={node.description}>
          {node.description}
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 font-mono text-[10px] text-zinc-600">
        {clock && <span className={node.status === 'running' ? 'text-amber-400/80' : ''}>{clock}</span>}
        {hasTokens && (
          <span>
            {formatTokenCount(tin)}
            <span className="text-zinc-700">in</span> {formatTokenCount(tout)}
            <span className="text-zinc-700">out</span>
          </span>
        )}
        {cost !== null && <span>{cost}</span>}
      </div>
      {node.summary && (
        <div className="mt-0.5 line-clamp-2 pl-5 text-[10px] leading-snug text-zinc-500" title={node.summary}>
          {node.summary}
        </div>
      )}
      {node.children.length > 0 && (
        <div className="mt-1 space-y-1 border-l border-zinc-800 pl-2">
          {node.children.map((child) => (
            <WorkflowChildRow key={child.id} node={child} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkflowRunRow({ node, now }: { node: WorkflowActivityNode; now: number }) {
  const setPage = useAppStore((s) => s.setPage);
  const openRun = useDynamicWorkflowStore((s) => s.openRun);

  const runId = node.projectId ?? null;
  const clickable = Boolean(runId);

  const liveUiStatus = useDynamicWorkflowStore((s) => (runId ? s.getUIStatus(runId) : null));
  const liveRun = useDynamicWorkflowStore((s) =>
    runId ? (s.selectedRun?.id === runId ? s.selectedRun : (s.runs.find((r) => r.id === runId) ?? null)) : null,
  );
  const status: LiveActivityStatus = liveRun && liveUiStatus ? uiToActivityStatus(liveUiStatus) : node.status;
  const clock = liveRun ? formatRunClock(liveRun, status === 'running', now) : formatLiveClock(node, now);
  const cost = liveRun ? formatCost(liveRun.totalCostUsd) : formatCost(node.costUsd);
  const description =
    liveRun && liveRun.currentPhaseId
      ? `Fase ${liveRun.currentPhaseId}${liveRun.currentNodeId ? ` - node ${liveRun.currentNodeId}` : ''}`
      : node.description;

  const navigate = (): void => {
    if (!runId) return;
    void openRun(runId);
    setPage('dynamic-workflow');
  };

  const gateChild = node.children.find(
    (c) =>
      c.status !== 'done' &&
      ((c.description ?? '').toLowerCase().includes('gate') || (c.label ?? '').toLowerCase().includes('gate')),
  );

  return (
    <div
      className={`rounded border px-2 py-1.5 ${
        status === 'running' ? 'border-amber-500/30 bg-amber-500/5' : 'border-zinc-700/60 bg-zinc-900/60'
      }`}
      data-testid="workflow-run-row"
    >
      {/* Header: clicavel para abrir a pagina do run (13.3.3). */}
      <div
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? navigate : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') navigate();
              }
            : undefined
        }
        title={clickable ? 'Abrir workflow' : undefined}
        className={`flex items-center gap-1.5 ${clickable ? 'cursor-pointer' : ''}`}
      >
        <Workflow className={`w-3.5 h-3.5 shrink-0 ${status === 'running' ? 'text-amber-400' : 'text-zinc-500'}`} />
        <span className={`truncate text-xs font-medium ${status === 'running' ? 'text-zinc-200' : 'text-zinc-300'}`}>
          {node.label}
        </span>
        <span className={`ml-auto shrink-0 text-[10px] font-medium ${STATUS_TEXT_CLASS[status]}`}>
          {STATUS_TEXT[status]}
        </span>
        <StatusIcon status={status} />
      </div>

      {/* Fase atual / node atual: do run VIVO (ou do node de atividade no fallback). */}
      {description && (
        <div className="mt-0.5 truncate pl-5 text-[10px] text-zinc-500" title={description}>
          {description}
        </div>
      )}

      {/* Metricas do header: tempo + custo acumulado (13.3.3). */}
      {(clock || cost !== null) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 pl-5 font-mono text-[10px] text-zinc-600">
          {clock && <span className={status === 'running' ? 'text-amber-400/80' : ''}>{clock}</span>}
          {cost !== null && <span>{cost}</span>}
        </div>
      )}

      {/* Gate pendente: CTA destacado que abre a pagina do run (aprovar/rejeitar
          no modal de la). O CTA so aparece quando ha gate pendente. */}
      {gateChild && (
        <button
          type="button"
          data-testid="workflow-gate-cta"
          onClick={(e) => {
            e.stopPropagation();
            navigate();
          }}
          className="mt-1.5 ml-5 inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400 transition-colors hover:bg-amber-500/20"
          title="Gate aguardando decisao. Abrir o run para aprovar ou rejeitar."
        >
          <Lock className="h-2.5 w-2.5" />
          Gate pendente
        </button>
      )}

      {/* Filhos: node-agentes, grupos paralelos (validadores) e intervencoes,
          todos como itens estilo subagente do Activity Log v2 (13.3.3). */}
      {node.children.length > 0 && (
        <div className="mt-1.5 space-y-1 border-l border-zinc-800 pl-2">
          {node.children.map((child) => (
            <WorkflowChildRow key={child.id} node={child} now={now} />
          ))}
        </div>
      )}

      {/* Intervencoes auditaveis sem filho dedicado caem no summary do bloco. */}
      {node.summary && (
        <div className="mt-1 flex items-start gap-1 pl-5 text-[10px] leading-snug text-zinc-500">
          <Hand className="mt-0.5 h-2.5 w-2.5 shrink-0 text-zinc-600" />
          <span className="line-clamp-2" title={node.summary}>
            {node.summary}
          </span>
        </div>
      )}
    </div>
  );
}
