import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { HarnessSprint, HarnessProject, HarnessProviderAuthCheckpoint } from '@/types';
import { SprintCard } from './SprintCard';
import { RegenerateModal } from './RegenerateModal';
import { AgentStreamPanel } from './AgentStreamPanel';
import { useHarnessStore } from '@/stores/harness-store';
import { translateLlmError } from '@/utils/translate-llm-error';

interface SprintListProps {
  projectId: string;
  projectStatus: HarnessProject['status'];
  providerAuthCheckpoint?: HarnessProviderAuthCheckpoint;
}

type HarnessActionResult =
  | void
  | { error: string }
  | { ok: true }
  | { ok: false; message: string };

export function SprintList({
  projectId,
  projectStatus,
  providerAuthCheckpoint,
}: SprintListProps) {
  const [sprints, setSprints] = useState<HarnessSprint[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { plannerStream, isPlannerActive, appendStream, clearPlannerStream } = useHarnessStore();
  const canResumeAfterAuth = providerAuthCheckpoint?.ownerKind === 'harness'
    && (projectStatus === 'paused'
      || (projectStatus === 'running' && providerAuthCheckpoint.claimState === 'claimed'));
  const providerLabel = providerAuthCheckpoint?.provider === 'grok'
    ? 'Grok Build'
    : providerAuthCheckpoint?.provider === 'kimi'
      ? 'Kimi'
      : 'Codex';

  useEffect(() => {
    let cancelled = false;

    window.lionclaw.harness.getSprints(projectId).then((data) => {
      if (!cancelled) {
        setSprints(data);
        setLoading(false);
      }
    });

    const unsubSprint = window.lionclaw.harness.onSprintUpdate((data) => {
      const updated = data as Record<string, unknown>;
      if (updated.projectId === projectId) {
        window.lionclaw.harness.getSprints(projectId).then((fresh) => {
          if (!cancelled) setSprints(fresh);
        });
      }
    });

    const unsubPlanning = window.lionclaw.harness.onPlanningDone((data) => {
      const updated = data as Record<string, unknown>;
      if (updated.projectId === projectId) {
        window.lionclaw.harness.getSprints(projectId).then((fresh) => {
          if (!cancelled) {
            setSprints(fresh);
            setLoading(false);
          }
        });
      }
    });

    return () => {
      cancelled = true;
      unsubSprint();
      unsubPlanning();
    };
  }, [projectId]);

  useEffect(() => {
    if (projectStatus !== 'planning') return;

    clearPlannerStream();

    const unsub = window.lionclaw.harness.onAgentStream((raw) => {
      const data = raw as Record<string, unknown>;
      if (data.projectId !== projectId) return;
      if (data.agent !== 'planner') return;

      const event = data.event as Record<string, unknown> | undefined;
      if (event) {
        appendStream('planner', {
          type: event.type as string,
          content: event.content as string | undefined,
          tool: event.tool as string | undefined,
        });
      }
    });

    return () => {
      unsub();
    };
  }, [projectId, projectStatus, appendStream, clearPlannerStream]);

  async function handleAction(action: () => Promise<HarnessActionResult>, label: string) {
    setActionPending(label);
    setActionError(null);
    try {
      const result = await action();
      if (result && typeof result === 'object' && 'error' in result) {
        setActionError(translateLlmError({ error: result.error }).body);
      } else if (result && typeof result === 'object' && 'ok' in result && !result.ok) {
        setActionError(result.message);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Erro ao executar: ${label}`);
    } finally {
      setActionPending(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-zinc-500 py-4">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm">Carregando sprints...</span>
      </div>
    );
  }

  if (sprints.length === 0 && projectStatus === 'planning') {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-zinc-400 text-sm">
          <Loader2 size={14} className="animate-spin" />
          <span>Planner trabalhando...</span>
        </div>
        <div className="h-[calc(100vh-260px)]">
          <AgentStreamPanel
            label="Planner"
            stream={plannerStream}
            isActive={isPlannerActive}
          />
        </div>
      </div>
    );
  }

  if (sprints.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-zinc-500">Nenhum sprint encontrado.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Action buttons */}
      {(projectStatus === 'reviewing' ||
        projectStatus === 'ready' ||
        projectStatus === 'paused' ||
        canResumeAfterAuth) && (
        <div className="flex items-center gap-2">
          {projectStatus === 'reviewing' && (
            <>
              <button
                onClick={() => setShowRegenerate(true)}
                disabled={actionPending !== null}
                className="px-4 py-1.5 text-sm rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Regenerar
              </button>
              <button
                onClick={() =>
                  handleAction(() => window.lionclaw.harness.approveSprints(projectId), 'Aprovar')
                }
                disabled={actionPending !== null}
                className="px-4 py-1.5 text-sm rounded-lg bg-green-600 hover:bg-green-500 text-white font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {actionPending === 'Aprovar' ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" />
                    Iniciando execucao...
                  </span>
                ) : (
                  'Aprovar e Executar'
                )}
              </button>
            </>
          )}

          {projectStatus === 'ready' && (
            <button
              onClick={() =>
                handleAction(() => window.lionclaw.harness.run(projectId), 'Executar')
              }
              disabled={actionPending !== null}
              className="px-4 py-1.5 text-sm rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {actionPending === 'Executar' ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" />
                  Iniciando...
                </span>
              ) : (
                'Executar'
              )}
            </button>
          )}

          {canResumeAfterAuth && providerAuthCheckpoint ? (
            <>
              <button
                onClick={() =>
                  handleAction(
                    () => window.lionclaw.harness.resumeAfterAuth(
                      projectId,
                      providerAuthCheckpoint.provider,
                    ),
                    'Retomar autenticacao',
                  )
                }
                disabled={actionPending !== null}
                className="px-4 py-1.5 text-sm rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {actionPending === 'Retomar autenticacao' ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" />
                    Retomando...
                  </span>
                ) : (
                  `Retomar com ${providerLabel}`
                )}
              </button>
              <button
                onClick={() =>
                  handleAction(() => window.lionclaw.harness.abort(projectId), 'Abortar')
                }
                disabled={actionPending !== null}
                className="px-4 py-1.5 text-sm rounded-lg border border-red-900 text-red-400 hover:bg-red-900/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {actionPending === 'Abortar' ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" />
                    Abortando...
                  </span>
                ) : (
                  'Abortar'
                )}
              </button>
            </>
          ) : projectStatus === 'paused' && (
            <>
              <button
                onClick={() =>
                  handleAction(() => window.lionclaw.harness.resume(projectId), 'Retomar')
                }
                disabled={actionPending !== null}
                className="px-4 py-1.5 text-sm rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {actionPending === 'Retomar' ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" />
                    Retomando...
                  </span>
                ) : (
                  'Retomar'
                )}
              </button>
              <button
                onClick={() =>
                  handleAction(() => window.lionclaw.harness.abort(projectId), 'Abortar')
                }
                disabled={actionPending !== null}
                className="px-4 py-1.5 text-sm rounded-lg border border-red-900 text-red-400 hover:bg-red-900/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {actionPending === 'Abortar' ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" />
                    Abortando...
                  </span>
                ) : (
                  'Abortar'
                )}
              </button>
            </>
          )}
        </div>
      )}

      {actionError && (
        <p className="text-xs text-red-400 bg-red-900/10 border border-red-900/30 rounded px-3 py-2">
          {actionError}
        </p>
      )}

      {/* Sprint cards */}
      <div className="space-y-2">
        {sprints.map((sprint) => (
          <SprintCard key={sprint.id} sprint={sprint} projectId={projectId} />
        ))}
      </div>

      {showRegenerate && (
        <RegenerateModal projectId={projectId} onClose={() => setShowRegenerate(false)} />
      )}
    </div>
  );
}
