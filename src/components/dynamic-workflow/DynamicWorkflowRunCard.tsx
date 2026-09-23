import { useState } from 'react';
import {
  PlayCircle,
  Pause,
  Square,
  FolderOpen,
  Loader2,
  Hand,
  Trash2,
  RotateCcw,
  Circle,
  CircleCheck,
  CircleX,
  MessageSquare,
  Menu,
} from 'lucide-react';
import type { DynamicWorkflowRun } from '@/types';
import type { DynamicWorkflowUIStatus } from '@/stores/dynamic-workflow-store';
import { AbortRunConfirm } from './AbortRunConfirm';

interface StatusToken {
  label: string;
  className: string;
  spinning?: boolean;
}

function statusToken(status: DynamicWorkflowUIStatus): StatusToken {
  switch (status) {
    case 'streaming':
    case 'running':
      return { label: 'rodando', className: 'text-amber-400 border-amber-500/40 bg-amber-500/10', spinning: true };
    case 'awaiting-user':
      return { label: 'aguardando voce', className: 'text-amber-300 border-amber-500/40 bg-amber-500/10' };
    case 'blocked':
      return { label: 'bloqueado', className: 'text-amber-300 border-amber-500/40 bg-amber-500/10' };
    case 'completed':
      return { label: 'concluido', className: 'text-green-400 border-green-500/40 bg-green-500/10' };
    case 'delivered':
      return { label: 'entregue', className: 'text-green-400 border-green-500/40 bg-green-500/10' };
    case 'pausing':
      return { label: 'pausando', className: 'text-amber-300 border-amber-500/40 bg-amber-500/10', spinning: true };
    case 'paused':
      return { label: 'pausado', className: 'text-zinc-300 border-zinc-700 bg-zinc-800/60' };
    case 'interrupted':
      return { label: 'interrompido', className: 'text-amber-300 border-amber-500/40 bg-amber-500/10' };
    case 'failed':
      return { label: 'falhou', className: 'text-red-400 border-red-500/40 bg-red-500/10' };
    case 'aborted':
      return { label: 'abortado', className: 'text-red-400 border-red-500/40 bg-red-500/10' };
    case 'created':
    default:
      return { label: 'criado', className: 'text-zinc-400 border-zinc-700 bg-zinc-800/60' };
  }
}

function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}c`;
  return `$${usd.toFixed(3)}`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function deriveProjectName(run: DynamicWorkflowRun): string {
  const p = run.worktreePath;
  if (p) {
    const root = p.split('/.lionclaw/')[0];
    const base = root.split('/').filter(Boolean).pop();
    if (base) return base;
  }
  return `Workflow ${shortId(run.id)}`;
}

type CircleState = 'done' | 'active' | 'pending' | 'failed';
type BarTone = 'green' | 'amber' | 'red' | 'zinc';

interface RunCardProgress {
  circles: CircleState[];
  pct: number;
  tone: BarTone;
}

function deriveRunCardProgress(run: DynamicWorkflowRun, uiStatus: DynamicWorkflowUIStatus): RunCardProgress {
  const total = run.sprintsTotal ?? 0;
  const done = Math.max(0, Math.min(run.sprintsDone ?? 0, total));
  const sprintCount = total > 0 ? total : 1;
  const hasSprints = total > 0;

  const terminalSuccess = uiStatus === 'completed' || uiStatus === 'delivered';
  const failed = uiStatus === 'failed' || uiStatus === 'aborted';
  const created = uiStatus === 'created';
  const active =
    uiStatus === 'running' ||
    uiStatus === 'streaming' ||
    uiStatus === 'awaiting-user' ||
    uiStatus === 'blocked' ||
    uiStatus === 'pausing' ||
    uiStatus === 'paused' ||
    uiStatus === 'interrupted';

  const circles: CircleState[] = [];

  if (created) {
    circles.push('pending');
  } else if (terminalSuccess || hasSprints) {
    circles.push('done');
  } else if (failed) {
    circles.push('failed');
  } else {
    circles.push('active');
  }

  for (let i = 0; i < sprintCount; i += 1) {
    if (terminalSuccess) {
      circles.push('done');
    } else if (i < done) {
      circles.push('done');
    } else if (i === done && failed && hasSprints) {
      circles.push('failed');
    } else if (i === done && active && hasSprints) {
      circles.push('active');
    } else {
      circles.push('pending');
    }
  }

  circles.push(terminalSuccess ? 'done' : failed ? 'failed' : 'pending');

  const doneCount = circles.filter((c) => c === 'done').length;
  const pct = terminalSuccess ? 100 : created ? 0 : Math.max(4, Math.round((doneCount / circles.length) * 100));
  const tone: BarTone = failed ? 'red' : terminalSuccess ? 'green' : created ? 'zinc' : 'amber';

  return { circles, pct, tone };
}

const BAR_TONE: Record<BarTone, string> = {
  green: 'bg-green-500',
  amber: 'bg-amber-400',
  red: 'bg-red-500',
  zinc: 'bg-zinc-600',
};

function ProgressCircle({ state }: { state: CircleState }) {
  if (state === 'done') {
    return <CircleCheck size={13} className="shrink-0 text-green-500" />;
  }
  if (state === 'failed') {
    return <CircleX size={13} className="shrink-0 text-red-400" />;
  }
  if (state === 'active') {
    return (
      <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
    );
  }
  return <Circle size={13} className="shrink-0 text-zinc-700" />;
}

interface DynamicWorkflowRunCardProps {
  run: DynamicWorkflowRun;
  uiStatus: DynamicWorkflowUIStatus;
  onOpen: (runId: string) => void;
  onPause: (runId: string) => void;
  onResume: (runId: string) => void;
  onAbort: (runId: string) => void;
  onArtifacts: (runId: string) => void;
  onReopen: (runId: string) => void;
  onDelete: (runId: string) => void;
}

export function DynamicWorkflowRunCard({
  run,
  uiStatus,
  onOpen,
  onPause,
  onResume,
  onAbort,
  onArtifacts,
  onReopen,
  onDelete,
}: DynamicWorkflowRunCardProps) {
  const [abortConfirmOpen, setAbortConfirmOpen] = useState(false);

  const token = statusToken(uiStatus);
  const isRunning = uiStatus === 'running' || uiStatus === 'streaming';
  const isPausing = uiStatus === 'pausing';
  const isPausable = !isPausing && (isRunning || uiStatus === 'awaiting-user' || uiStatus === 'blocked');
  const isResumable = uiStatus === 'paused' || uiStatus === 'interrupted';
  const isReopenable = uiStatus === 'aborted';
  const isTerminal = uiStatus === 'completed';
  const createdByChat = run.chatSessionId !== null;

  const name = deriveProjectName(run);
  const progress = deriveRunCardProgress(run, uiStatus);
  const sprintsTotal = run.sprintsTotal ?? 0;
  const sprintsDone = Math.min(run.sprintsDone ?? 0, sprintsTotal);
  const featuresTotal = run.featuresTotal ?? 0;

  return (
    <>
      <button
        type="button"
        onClick={() => onOpen(run.id)}
        className="group w-full cursor-pointer rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-left transition-all hover:border-zinc-700 hover:bg-zinc-900/80"
      >
        {/* Top: nome + badge WF | status + acoes */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h3 className="min-w-0 truncate text-sm font-bold text-zinc-100 transition-colors group-hover:text-white">
              {name}
            </h3>
            <span
              title="Workflow dinamico"
              className="shrink-0 rounded border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-mono font-semibold tracking-wide text-amber-300"
            >
              WF
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-semibold uppercase ${token.className}`}
            >
              {token.spinning && <Loader2 size={10} className="animate-spin" />}
              {!token.spinning && uiStatus === 'awaiting-user' && <Hand size={10} />}
              {token.label}
            </span>
            {/* Acoes do run (SPEC 13.1). */}
            {isPausable && (
              <ActionIcon title="Pausar" onClick={() => onPause(run.id)} className="text-zinc-300 hover:text-amber-300">
                <Pause size={14} />
              </ActionIcon>
            )}
            {isResumable && (
              <ActionIcon
                title="Retomar"
                onClick={() => onResume(run.id)}
                className="text-green-400 hover:text-green-300"
              >
                <PlayCircle size={14} />
              </ActionIcon>
            )}
            {/* SM-37: botao Reabrir para runs abortados (REGRA MAXIMA). */}
            {isReopenable && (
              <ActionIcon
                title="Reabrir (retomar do checkpoint)"
                onClick={() => onReopen(run.id)}
                className="text-amber-400 hover:text-amber-300"
              >
                <RotateCcw size={14} />
              </ActionIcon>
            )}
            {/* Abortar: visivel enquanto o run nao for completed nem abortado.
                SM-36: abre popup de confirmacao antes de disparar (semi-destrutivo). */}
            {!isTerminal && !isReopenable && (
              <ActionIcon
                title="Abortar (preserva tudo - da pra Reabrir)"
                onClick={() => setAbortConfirmOpen(true)}
                className="text-zinc-400 hover:text-red-400"
              >
                <Square size={14} />
              </ActionIcon>
            )}
            <ActionIcon
              title="Ver artefatos"
              onClick={() => onArtifacts(run.id)}
              className="text-zinc-400 hover:text-zinc-200"
            >
              <FolderOpen size={14} />
            </ActionIcon>
            {/* P0-RECOVERY (REGRA MAXIMA): UNICA porta destrutiva. Distinta de Abortar
                (que PARA e PRESERVA) - aqui APAGA, com confirmacao na pagina. */}
            <ActionIcon
              title="Deletar workflow"
              onClick={() => onDelete(run.id)}
              className="text-zinc-500 opacity-0 hover:text-red-400 group-hover:opacity-100"
            >
              <Trash2 size={14} />
            </ActionIcon>
          </div>
        </div>

        {/* Path / worktree */}
        <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">
          {run.worktreePath ?? `def ${shortId(run.definitionId)}`}
        </p>

        {/* Bolinhas de progresso: planejamento + uma por sprint + entrega */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1">
          {progress.circles.map((state, i) => (
            <ProgressCircle key={i} state={state} />
          ))}
        </div>

        {/* Resumo: Sprints X/Y . Features N . Custo . fase */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500">
          {sprintsTotal > 0 && (
            <span>
              Sprints{' '}
              <span className="font-medium text-zinc-400">
                {sprintsDone}/{sprintsTotal}
              </span>
            </span>
          )}
          {featuresTotal > 0 && (
            <span>
              Features <span className="font-medium text-zinc-400">{featuresTotal}</span>
            </span>
          )}
          <span>
            Custo <span className="font-medium text-zinc-400">{formatCost(run.totalCostUsd)}</span>
          </span>
          {run.currentPhaseId && <span className="font-mono text-zinc-600">{run.currentPhaseId}</span>}
          <span className="ml-auto inline-flex items-center gap-1 text-zinc-600">
            {createdByChat ? <MessageSquare size={11} /> : <Menu size={11} />}
            {createdByChat ? 'chat' : 'manual'}
          </span>
        </div>

        {/* Barra de progresso */}
        <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-zinc-800">
          <div
            className={`h-full rounded-full transition-all ${BAR_TONE[progress.tone]}`}
            style={{ width: `${progress.pct}%` }}
          />
        </div>
      </button>

      {/* SM-36: popup de confirmacao de abortar (fora do <button> para nao propagar). */}
      {abortConfirmOpen && (
        <AbortRunConfirm
          runId={run.id}
          onCancel={() => setAbortConfirmOpen(false)}
          onConfirm={() => {
            setAbortConfirmOpen(false);
            onAbort(run.id);
          }}
        />
      )}
    </>
  );
}

function ActionIcon({
  title,
  onClick,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }
      }}
      className={`rounded-lg p-1.5 transition-colors hover:bg-zinc-800 ${className}`}
    >
      {children}
    </span>
  );
}
