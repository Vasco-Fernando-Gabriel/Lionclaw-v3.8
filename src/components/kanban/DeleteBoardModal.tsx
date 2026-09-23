import { useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import type { KanbanBoardWithCounts } from '@/types/kanban';
import { useKanbanStore } from '@/stores/kanban-store';

interface DeleteBoardModalProps {
  board: KanbanBoardWithCounts;
  onClose: () => void;
}

export function DeleteBoardModal({ board, onClose }: DeleteBoardModalProps) {
  const deleteBoard = useKanbanStore((s) => s.deleteBoard);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);

  const confirmed = typed === board.prefix;
  const totalCards = Object.values(board.columnCounts).reduce((a, b) => a + b, 0);

  const handleDelete = async () => {
    if (!confirmed || deleting) return;
    setDeleting(true);
    try {
      const ok = await deleteBoard(board.id);
      if (ok) onClose();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-red-900/60 rounded-2xl w-full max-w-md flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-6 pt-5 pb-2">
          <h2 className="text-base font-semibold text-red-300 flex-1 flex items-center gap-2">
            <AlertTriangle size={16} />
            Deletar quadro {board.prefix}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="Fechar"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-6 pb-5 space-y-4">
          <p className="text-sm text-zinc-400 leading-relaxed">
            O quadro <span className="text-zinc-200 font-medium">{board.name}</span> e seus {totalCards} cards, com
            histórico e anexos, serão apagados de verdade. Não há desfazer.
          </p>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-1.5">
              Digite o prefixo <span className="text-red-400 font-mono">{board.prefix}</span> para confirmar
            </label>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value.toUpperCase())}
              autoFocus
              className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-red-500 font-mono uppercase"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg text-xs font-semibold border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={() => void handleDelete()}
              disabled={!confirmed || deleting}
              className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-red-700 hover:bg-red-600 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Deletar quadro
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
