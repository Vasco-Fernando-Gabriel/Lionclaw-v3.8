import { Square } from 'lucide-react';

interface AbortRunConfirmProps {
  runId: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function AbortRunConfirm({ runId, onCancel, onConfirm }: AbortRunConfirmProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
      data-testid="dwf-abort-confirm"
    >
      <div
        className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-amber-500/10 p-2">
            <Square size={18} className="text-amber-400" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">Abortar execucao?</h2>
            <p className="mt-1 text-xs text-zinc-400">
              Abortar PARA a execucao do run <span className="font-mono text-zinc-300">{runId.slice(0, 8)}</span>, mas{' '}
              <span className="text-zinc-200 font-medium">PRESERVA tudo</span> (plano, sprints, codigo) e o run continua{' '}
              <span className="text-amber-300 font-medium">RECUPERAVEL</span> (da pra Reabrir/Retomar a qualquer
              momento).
            </p>
            <p className="mt-2 text-xs text-zinc-500">
              Para apagar de vez o run e todo o conteudo, use <span className="text-zinc-400">Deletar workflow</span>.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            data-testid="dwf-abort-confirm-button"
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/20"
          >
            Abortar (preserva tudo)
          </button>
        </div>
      </div>
    </div>
  );
}
