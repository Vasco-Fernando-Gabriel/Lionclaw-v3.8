import { useEffect, useRef, useState } from 'react';
import { Loader2, Pause, StopCircle } from 'lucide-react';
import { useHarnessStore } from '@/stores/harness-store';
import type { HarnessSprint } from '@/types';
import { AgentStreamPanel } from './AgentStreamPanel';
import { RoundHistory } from './RoundHistory';

interface ExecutionViewProps {
  projectId: string;
}

interface AgentStreamData {
  projectId: string;
  sprintId: string;
  round: number;
  agent: 'coder' | 'evaluator' | 'planner';
  event: { type: string; content?: string; tool?: string };
}

function useElapsedTimer(running: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (running) {
      startRef.current = Date.now() - elapsed * 1000;
      intervalRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }, 1000);
    } else {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  return elapsed;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function ExecutionView({ projectId }: ExecutionViewProps) {
  const { coderStream, evaluatorStream, isCoderActive, isEvaluatorActive, appendStream, clearStreams } =
    useHarnessStore();

  const [currentSprint, setCurrentSprint] = useState<HarnessSprint | null>(null);
  const [loadingSprints, setLoadingSprints] = useState(true);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const currentSprintIdRef = useRef<string | null>(null);

  const isRunning = isCoderActive || isEvaluatorActive;
  const elapsed = useElapsedTimer(isRunning);

  useEffect(() => {
    let cancelled = false;

    async function loadSprints() {
      setLoadingSprints(true);
      const sprints = await window.lionclaw.harness.getSprints(projectId);
      if (cancelled) return;

      const running = sprints.find((s) => s.status === 'running');
      const target = running ?? null;
      setCurrentSprint(target);
      setLoadingSprints(false);

      if (target && target.id !== currentSprintIdRef.current) {
        currentSprintIdRef.current = target.id;
        clearStreams();
      }
    }

    loadSprints();

    const unsubSprint = window.lionclaw.harness.onSprintUpdate((data) => {
      const d = data as Record<string, unknown>;
      if (d.projectId === projectId) {
        loadSprints();
      }
    });

    return () => {
      cancelled = true;
      unsubSprint();
    };
  }, [projectId, clearStreams]);

  useEffect(() => {
    if (currentSprint && coderStream.length === 0 && evaluatorStream.length === 0) {
      window.lionclaw.harness.getStreamLog(projectId, currentSprint.id).then((logs) => {
        if (logs.coder.length > 0) {
          for (const entry of logs.coder) {
            appendStream('coder', entry);
          }
        }
        if (logs.evaluator.length > 0) {
          for (const entry of logs.evaluator) {
            appendStream('evaluator', entry);
          }
        }
      }).catch(() => {});
    }
  }, [currentSprint, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const unsub = window.lionclaw.harness.onAgentStream((raw) => {
      const data = raw as unknown as AgentStreamData;
      if (data.projectId !== projectId) return;

      if (data.agent === 'coder' || data.agent === 'evaluator') {
        appendStream(data.agent, {
          type: data.event.type,
          content: data.event.content,
          tool: data.event.tool,
        });
      }
    });

    return unsub;
  }, [projectId, appendStream]);

  async function handleAction(fn: () => Promise<void | { error: string }>, label: string) {
    setActionPending(label);
    setActionError(null);
    try {
      const result = await fn();
      if (result && typeof result === 'object' && 'error' in result) {
        setActionError(result.error);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Erro ao executar: ${label}`);
    } finally {
      setActionPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Top bar: sprint info + actions */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="flex-1 min-w-0">
          {loadingSprints ? (
            <div className="flex items-center gap-2 text-zinc-500">
              <Loader2 size={13} className="animate-spin" />
              <span className="text-xs">Carregando...</span>
            </div>
          ) : currentSprint != null ? (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-zinc-400 font-medium truncate">{currentSprint.name}</span>
              <span className="text-[10px] text-zinc-600">
                rodada {currentSprint.roundsUsed}/{currentSprint.maxRounds}
              </span>
              {isRunning && (
                <span className="font-mono text-xs text-amber-400">{formatElapsed(elapsed)}</span>
              )}
            </div>
          ) : (
            <span className="text-xs text-zinc-600 italic">Nenhum sprint em execucao</span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => handleAction(() => window.lionclaw.harness.pause(projectId), 'Pausar')}
            disabled={actionPending !== null || !isRunning}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {actionPending === 'Pausar' ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Pause size={12} />
            )}
            Pausar
          </button>

          <button
            onClick={() => handleAction(() => window.lionclaw.harness.abort(projectId), 'Abortar')}
            disabled={actionPending !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-red-900 text-red-400 hover:bg-red-900/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {actionPending === 'Abortar' ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <StopCircle size={12} />
            )}
            Abortar
          </button>
        </div>
      </div>

      {actionError != null && (
        <p className="text-xs text-red-400 bg-red-900/10 border border-red-900/30 rounded px-3 py-2 shrink-0">
          {actionError}
        </p>
      )}

      {/* Split panels */}
      <div className="grid grid-cols-2 gap-2 flex-1 min-h-0">
        <AgentStreamPanel
          label="Coder"
          stream={coderStream}
          isActive={isCoderActive}
        />
        <AgentStreamPanel
          label="Avaliador"
          stream={evaluatorStream}
          isActive={isEvaluatorActive}
        />
      </div>

      {/* Round history */}
      <div className="shrink-0 border border-zinc-800 rounded-lg bg-zinc-900/60 px-3 py-2">
        <p className="text-[10px] text-zinc-500 uppercase tracking-wide font-semibold mb-1">
          Historico de rodadas
        </p>
        <RoundHistory projectId={projectId} />
      </div>
    </div>
  );
}
