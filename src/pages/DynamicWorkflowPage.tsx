import { useEffect, useState } from 'react';
import { Loader2, AlertCircle, AlertTriangle, Workflow, Trash2 } from 'lucide-react';
import { useDynamicWorkflowStore } from '@/stores/dynamic-workflow-store';
import { DynamicWorkflowRunCard } from '@/components/dynamic-workflow/DynamicWorkflowRunCard';
import { DynamicWorkflowRunView } from '@/components/dynamic-workflow/DynamicWorkflowRunView';

export function DynamicWorkflowPage() {
  const runs = useDynamicWorkflowStore((s) => s.runs);
  const isLoading = useDynamicWorkflowStore((s) => s.isLoading);
  const error = useDynamicWorkflowStore((s) => s.error);
  const selectedRunId = useDynamicWorkflowStore((s) => s.selectedRunId);
  const loadRuns = useDynamicWorkflowStore((s) => s.loadRuns);
  const openRun = useDynamicWorkflowStore((s) => s.openRun);
  const pause = useDynamicWorkflowStore((s) => s.pause);
  const resume = useDynamicWorkflowStore((s) => s.resume);
  const abort = useDynamicWorkflowStore((s) => s.abort);
  const reopenRun = useDynamicWorkflowStore((s) => s.reopenRun);
  const deleteWorkflow = useDynamicWorkflowStore((s) => s.deleteWorkflow);
  const init = useDynamicWorkflowStore((s) => s.init);
  const streamingRunIds = useDynamicWorkflowStore((s) => s.streamingRunIds);
  const awaitingUserRunIds = useDynamicWorkflowStore((s) => s.awaitingUserRunIds);

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    const cleanup = init();
    return cleanup;
  }, [init]);

  const getUIStatus = useDynamicWorkflowStore((s) => s.getUIStatus);
  void streamingRunIds;
  void awaitingUserRunIds;

  if (selectedRunId) {
    return <DynamicWorkflowRunView runId={selectedRunId} />;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-6">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-zinc-100">Workflows Dinamicos</h1>
            <p className="mt-0.5 text-xs text-zinc-500">
              Workflows sandboxados criados e dirigidos pelo orquestrador no chat.
            </p>
          </div>
        </div>

        {/* Aviso: funcionalidade experimental */}
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
          <p className="text-xs text-amber-200/90">
            Funcionalidade em <span className="font-semibold">Beta experimental</span>. Use com
            cuidado: cada workflow coordena varios subagents e pode consumir muitos tokens.
          </p>
        </div>

        {/* Erro */}
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-red-400" />
            <p className="text-xs text-red-300">{error}</p>
          </div>
        )}

        {/* Lista */}
        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 size={24} className="animate-spin text-zinc-500" />
          </div>
        ) : runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center text-zinc-500">
            <Workflow size={28} className="mb-2 text-zinc-600" />
            <p className="text-sm text-zinc-400">
              Nenhum workflow ainda. Peca ao orquestrador no chat para criar um.
            </p>
          </div>
        ) : (
          <div className="grid max-w-3xl grid-cols-1 gap-3">
            {runs.map((run) => (
              <DynamicWorkflowRunCard
                key={run.id}
                run={run}
                uiStatus={getUIStatus(run.id)}
                onOpen={(id) => void openRun(id)}
                onPause={(id) => void pause(id)}
                onResume={(id) => void resume(id)}
                onAbort={(id) => void abort(id)}
                onReopen={(id) => void reopenRun(id)}
                onArtifacts={(id) => void openRun(id)}
                onDelete={(id) => setDeleteTarget(id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* P0-RECOVERY (REGRA MAXIMA): confirmacao da UNICA acao destrutiva. Deletar
          apaga o run e TUDO dele (plano/sprints/codigo/chat) de forma irreversivel -
          diferente de Abortar, que so PARA e PRESERVA. Por isso pede confirmacao
          explicita aqui, e nao ha nenhum outro caminho que apague dados. */}
      {deleteTarget && (
        <DeleteWorkflowConfirm
          runId={deleteTarget}
          deleting={deleting}
          onCancel={() => {
            if (deleting) return;
            setDeleteTarget(null);
          }}
          onConfirm={async () => {
            if (deleting) return;
            setDeleting(true);
            const result = await deleteWorkflow(deleteTarget);
            setDeleting(false);
            if (!('error' in result)) setDeleteTarget(null);
          }}
        />
      )}
    </div>
  );
}


function DeleteWorkflowConfirm({
  runId,
  deleting,
  onCancel,
  onConfirm,
}: {
  runId: string;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
      data-testid="dwf-delete-confirm"
    >
      <div
        className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-red-500/10 p-2">
            <Trash2 size={18} className="text-red-400" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">Deletar workflow</h2>
            <p className="mt-1 text-xs text-zinc-400">
              Isto apaga o run{' '}
              <span className="font-mono text-zinc-300">{runId.slice(0, 8)}</span> e
              TODO o conteudo dele (plano, sprints, codigo gerado, chat e historico).
              A acao e irreversivel e nao pode ser desfeita.
            </p>
            <p className="mt-2 text-xs text-zinc-500">
              Para apenas parar a execucao sem perder nada, use Abortar.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            data-testid="dwf-delete-confirm-button"
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-40"
          >
            {deleting && <Loader2 size={12} className="animate-spin" />}
            {deleting ? 'Deletando...' : 'Deletar workflow'}
          </button>
        </div>
      </div>
    </div>
  );
}
