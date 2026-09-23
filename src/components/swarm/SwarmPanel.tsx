import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chat-store';
import {
  Network,
  Bot,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Ban,
  Clock3,
  ChevronRight,
  FileText,
  Square,
} from 'lucide-react';
import type { SwarmItemStatus, SwarmRunStatus, SwarmRun } from '@/types/swarm';
const STATUS_LABEL: Record<SwarmRunStatus | SwarmItemStatus, string> = {
  queued: 'Na fila',
  pending: 'Na fila',
  running: 'Executando',
  aborting: 'Abortando',
  stopping: 'Parando',
  retrying: 'Tentando novamente',
  done: 'Concluído',
  ok: 'Concluído',
  partial: 'Parcial',
  failed: 'Falhou',
  aborted: 'Abortado',
  cancelled: 'Cancelado',
};
function SwarmStatus({ status }: { status: SwarmRunStatus | SwarmItemStatus }) {
  const active = ['running', 'retrying', 'stopping', 'aborting'].includes(status);
  const success = status === 'done' || status === 'ok';
  const failed = status === 'failed' || status === 'partial';
  const Icon = active
    ? Loader2
    : success
      ? CheckCircle2
      : failed
        ? AlertTriangle
        : status === 'pending' || status === 'queued'
          ? Clock3
          : Ban;
  return (
    <span
      className={`ml-auto inline-flex shrink-0 items-center gap-1 text-[10px] font-medium ${
        active ? 'text-amber-400' : success ? 'text-emerald-400' : failed ? 'text-red-400' : 'text-zinc-500'
      }`}
    >
      <span>{STATUS_LABEL[status]}</span>
      <Icon aria-hidden="true" className={`h-3 w-3 ${active ? 'animate-spin' : ''}`} />
    </span>
  );
}
export function SwarmPanel() {
  const sessionId = useChatStore((s) => s.currentSessionId);
  const [run, setRun] = useState<SwarmRun | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const revisions = useRef(new Map<string, number>());
  useEffect(() => {
    let live = true;
    setRun(null);
    setError('');
    revisions.current.clear();
    if (!sessionId) return;
    let lastRunId: string | null = null;
    const refresh = async (runId: string) => {
      lastRunId = runId;
      try {
        const result = await window.lionclaw.swarm.getRunState(sessionId, runId);
        if (!live || lastRunId !== runId) return;
        if ('error' in result) {
          setError(result.error);
          return;
        }
        if (result.revision < (revisions.current.get(runId) ?? -1)) return;
        revisions.current.set(runId, result.revision);
        setRun(result);
      } catch (e) {
        if (live) setError(String(e));
      }
    };
    const dispose = window.lionclaw.swarm.onStream((event) => {
      if (event.chatSessionId === sessionId && event.revision > (revisions.current.get(event.runId) ?? -1))
        void refresh(event.runId);
    });
    window.lionclaw.swarm
      .listRuns(sessionId, undefined, 1)
      .then((result) => {
        if (!live) return;
        if ('error' in result) setError(result.error);
        else if (result.runs[0] && !lastRunId) void refresh(result.runs[0].runId);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    const deliveryTimer = setInterval(() => {
      if (lastRunId) void refresh(lastRunId);
    }, 5000);
    return () => {
      live = false;
      dispose();
      clearInterval(deliveryTimer);
    };
  }, [sessionId]);
  if (!run && !error) return null;
  const active = run && ['queued', 'running', 'aborting'].includes(run.status);
  const completed = run?.items.filter((item) => ['ok', 'failed', 'cancelled'].includes(item.status)).length ?? 0;
  return (
    <section aria-label="Swarm" className="max-h-[45vh] overflow-y-auto px-2 py-2 text-xs">
      <div
        className={`rounded border px-2 py-1.5 ${active ? 'border-amber-500/30 bg-amber-500/5' : 'border-zinc-700/60 bg-zinc-900/60'}`}
      >
        <div className="flex items-center gap-1.5">
          <Network
            aria-hidden="true"
            className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-amber-400' : 'text-zinc-500'}`}
          />
          <h3 className="text-xs font-medium text-zinc-200">Swarm</h3>
          {run && <SwarmStatus status={run.status} />}
        </div>
        {error && (
          <p role="alert" className="mt-1 break-words text-[10px] text-red-400">
            {error}
          </p>
        )}
        {run && (
          <>
            <p className="mt-0.5 line-clamp-2 pl-5 text-[10px] text-zinc-400" title={run.objective}>
              {run.objective}
            </p>
            <p className="mt-1 pl-5 font-mono text-[10px] text-zinc-500">
              {run.runId.slice(-13)} · {completed} de {run.items.length} itens
            </p>
            {run.items.length > 0 && (
              <div
                role="progressbar"
                aria-label="Itens finalizados"
                aria-valuenow={completed}
                aria-valuemin={0}
                aria-valuemax={run.items.length}
                className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-800"
              >
                <div
                  className="h-full rounded-full bg-amber-400 transition-all"
                  style={{ width: `${(completed / run.items.length) * 100}%` }}
                />
              </div>
            )}
            <div className="mt-1.5 space-y-1 border-l border-zinc-800 pl-2">
              {run.items.map((item) => {
                const lastAttempt = item.attempts[item.attempts.length - 1];
                const terminal = ['ok', 'failed', 'cancelled'].includes(item.status);
                const end = terminal ? (lastAttempt?.endedAt ?? run.finishedAt) : null;
                const elapsed = item.attempts[0]
                  ? Math.max(
                      0,
                      Math.floor(((end ? Date.parse(end) : now) - Date.parse(item.attempts[0].startedAt)) / 1000),
                    )
                  : null;
                return (
                  <details
                    key={item.slug}
                    className="group rounded border border-zinc-800/70 bg-zinc-900/30 px-2 py-1.5"
                  >
                    <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                      <span className="flex items-center gap-1.5">
                        <Bot
                          aria-hidden="true"
                          className={`h-3.5 w-3.5 shrink-0 ${item.status === 'running' ? 'text-amber-400' : 'text-zinc-500'}`}
                        />
                        <span className="min-w-0 truncate text-[11px] text-zinc-300" title={item.slug}>
                          {item.slug}
                        </span>
                        <SwarmStatus status={item.status} />
                        <ChevronRight
                          aria-hidden="true"
                          className="h-3 w-3 shrink-0 text-zinc-600 transition-transform group-open:rotate-90"
                        />
                      </span>
                      <span className="mt-1 block pl-5 font-mono text-[10px] text-zinc-500">
                        {item.attempts.length} tent.{elapsed !== null && ` · ${elapsed}s`}
                      </span>
                    </summary>
                    <div className="mt-1.5 space-y-1 break-words border-t border-zinc-800/70 pt-1.5 text-[10px] text-zinc-500">
                      <p>
                        {item.runtime} / {item.model}
                      </p>
                      {item.summary && <p className="text-zinc-400">{item.summary}</p>}
                      {item.error && <p className="text-red-400">{item.error.message}</p>}
                      {item.attempts.map((attempt) => (
                        <p key={attempt.id}>
                          #{attempt.n} {attempt.outcome ?? 'executando'} ·{' '}
                          {attempt.metrics.costUsd === null || attempt.metrics.costStatus === 'unknown'
                            ? 'custo desconhecido'
                            : `$${attempt.metrics.costUsd.toFixed(4)}${attempt.metrics.costStatus === 'estimated-partial' ? ' (parcial/estimado)' : ''}`}
                        </p>
                      ))}
                      {item.findingsFile && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-zinc-700 px-1.5 py-1 text-zinc-300 transition-colors hover:bg-zinc-800"
                          onClick={async () => {
                            if (!sessionId) return;
                            try {
                              const result = await window.lionclaw.swarm.openFindings(sessionId, run.runId, item.slug);
                              if ('error' in result) setError(result.error);
                            } catch (e) {
                              setError(String(e));
                            }
                          }}
                        >
                          <FileText aria-hidden="true" className="h-3 w-3" />
                          Abrir relatório
                        </button>
                      )}
                    </div>
                  </details>
                );
              })}
            </div>
            {run.delivery && run.delivery.status !== 'delivered' && (
              <p className="mt-1.5 break-words text-[10px] text-amber-400">
                Entrega: {run.delivery.status}
                {run.delivery.error ? ` · ${run.delivery.error}` : ''}
              </p>
            )}
            {active && (
              <button
                type="button"
                className="mt-2 inline-flex items-center gap-1 rounded border border-zinc-700 px-1.5 py-1 text-[10px] text-zinc-400 transition-colors hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400"
                onClick={async () => {
                  if (!sessionId) return;
                  try {
                    const result = await window.lionclaw.swarm.abort(sessionId, run.runId);
                    if ('error' in result) setError(result.error);
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                <Square aria-hidden="true" className="h-2.5 w-2.5" />
                Abortar Swarm
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
