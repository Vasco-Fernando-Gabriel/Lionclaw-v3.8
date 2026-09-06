import { AlertTriangle, X } from 'lucide-react';

interface DeleteAgentDialogProps {
  agentName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteAgentDialog({ agentName, onConfirm, onCancel }: DeleteAgentDialogProps) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="w-full max-w-sm mx-4 rounded-xl border border-red-500/30 bg-zinc-900 p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-red-500/10 flex items-center justify-center">
            <AlertTriangle size={20} className="text-red-400" />
          </div>
          <h3 className="text-sm font-semibold text-zinc-100">Excluir Subagente</h3>
        </div>

        <p className="text-sm text-zinc-300 mb-1">
          Tem certeza que deseja excluir o subagente <strong>&quot;{agentName}&quot;</strong>?
        </p>
        <p className="text-xs text-zinc-500 mb-5">Esta acao nao pode ser desfeita.</p>

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-sm transition-colors"
          >
            <X size={16} />
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium transition-colors"
          >
            Excluir
          </button>
        </div>
      </div>
    </div>
  );
}
