import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react';
import { usePipelineStore } from '@/stores/pipeline-store';
import type { PipelineResetPreview } from '@/types';

type ResetTarget = { phase: number; phaseName: string } | { sprintIndex: number; sprintTitle: string };

export interface ResetConfirmDialogProps {
  open: boolean;
  target: ResetTarget | null;
  projectId: string;
  onClose: () => void;
  onConfirmed: () => void;
}

function isPhaseTarget(t: ResetTarget): t is { phase: number; phaseName: string } {
  return 'phase' in t;
}

function buildTitle(target: ResetTarget): string {
  if (isPhaseTarget(target)) {
    return `Resetar Fase ${target.phase}: ${target.phaseName}`;
  }
  return `Resetar Sprint ${target.sprintIndex + 1}: ${target.sprintTitle}`;
}

export function ResetConfirmDialog({ open, target, projectId, onClose, onConfirmed }: ResetConfirmDialogProps) {
  const { getResetPreview, resetPhase, resetSprint } = usePipelineStore();
  const pipelineType = usePipelineStore((s) => s.projects.find((p) => p.id === projectId)?.pipelineType);

  const isOpenDesignReset =
    target !== null && isPhaseTarget(target) && pipelineType === 'development-v2' && target.phase === 5;

  const [preview, setPreview] = useState<PipelineResetPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || target === null) return;

    setPreview(null);
    setResetError(null);
    setLoadingPreview(true);

    const ipcTarget = isPhaseTarget(target) ? { phase: target.phase } : { sprintIndex: target.sprintIndex };

    void getResetPreview(projectId, ipcTarget).then((result) => {
      setLoadingPreview(false);
      if (result && typeof result === 'object' && !('error' in result)) {
        setPreview(result as PipelineResetPreview);
      }
    });
  }, [open, target, projectId, getResetPreview]);

  const handleConfirm = async () => {
    if (target === null) return;
    setResetting(true);
    setResetError(null);

    let result: { ok: boolean; error?: string };
    if (isPhaseTarget(target)) {
      result = await resetPhase(projectId, target.phase);
    } else {
      result = await resetSprint(projectId, target.sprintIndex);
    }

    setResetting(false);

    if (!result.ok) {
      setResetError(result.error ?? 'Erro desconhecido ao resetar.');
      return;
    }

    onConfirmed();
    onClose();
  };

  if (!open || target === null) return null;

  const title = buildTitle(target);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/75 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-md mx-4 flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-3 border-b border-zinc-800">
          <RotateCcw size={16} className="text-red-400 shrink-0" />
          <h2 className="text-sm font-semibold text-zinc-100 leading-tight">{title}</h2>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex flex-col gap-4">
          {loadingPreview ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-zinc-500">
              <Loader2 size={14} className="animate-spin" />
              Carregando preview...
            </div>
          ) : (
            <>
              {/* Files to delete */}
              <div>
                <p className="text-xs font-medium text-zinc-400 mb-1.5">Arquivos que serao apagados:</p>
                {preview && preview.filesToDelete.length > 0 ? (
                  <ul className="flex flex-col gap-0.5 max-h-36 overflow-y-auto">
                    {preview.filesToDelete.map((f) => (
                      <li
                        key={f}
                        className="text-[11px] font-mono text-zinc-300 bg-zinc-800 rounded px-2 py-0.5 truncate"
                        title={f}
                      >
                        {f}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11px] text-zinc-500 italic">Nenhum arquivo sera apagado.</p>
                )}
              </div>

              {/* Records count */}
              {preview && (preview.messagesToDelete > 0 || preview.metricsToDelete > 0) && (
                <p className="text-xs text-zinc-400">
                  <span className="font-semibold text-zinc-300">{preview.messagesToDelete}</span> mensagens e{' '}
                  <span className="font-semibold text-zinc-300">{preview.metricsToDelete}</span> metricas serao
                  apagadas.
                </p>
              )}

              {/* Sprints affected */}
              {preview && preview.sprintsAffected.length > 0 && (
                <p className="text-xs text-zinc-400">
                  <span className="font-semibold text-zinc-300">{preview.sprintsAffected.length}</span> sprint
                  {preview.sprintsAffected.length !== 1 ? 's' : ''} sera
                  {preview.sprintsAffected.length !== 1 ? 'o' : ''} afetada
                  {preview.sprintsAffected.length !== 1 ? 's' : ''}:{' '}
                  <span className="text-zinc-300">{preview.sprintsAffected.map((i) => `S${i + 1}`).join(', ')}</span>
                </p>
              )}

              {/* Open Design: aviso especifico de full-wipe do design */}
              {isOpenDesignReset && (
                <div className="flex items-start gap-2.5 bg-red-500/15 border border-red-500/40 rounded-lg px-3 py-2.5">
                  <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-200 leading-relaxed">
                    <b>O design do LionDesign sera APAGADO permanentemente</b> (projeto do sidecar + snapshot do lock)
                    deste projeto. Ao reabrir o Studio, um novo design sera recriado do zero a partir do briefing da
                    fase anterior. Os outros projetos e a conexao do LionDesign nao sao afetados.
                  </p>
                </div>
              )}

              {/* Warning box */}
              <div className="flex items-start gap-2.5 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5">
                <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-xs text-red-300 leading-relaxed">Esta acao e permanente e nao pode ser desfeita.</p>
              </div>

              {/* Error feedback */}
              {resetError && <p className="text-xs text-red-400">{resetError}</p>}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 pb-5">
          <button
            onClick={onClose}
            disabled={resetting}
            className="px-4 py-1.5 text-xs font-medium rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Cancelar
          </button>
          <button
            onClick={() => {
              void handleConfirm();
            }}
            disabled={resetting || loadingPreview}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {resetting && <Loader2 size={11} className="animate-spin" />}
            {resetting ? 'Resetando...' : 'Resetar definitivamente'}
          </button>
        </div>
      </div>
    </div>
  );
}
