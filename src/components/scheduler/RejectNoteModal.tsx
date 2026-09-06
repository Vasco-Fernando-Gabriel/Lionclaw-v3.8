import { useState, useRef, useEffect } from 'react';
import { X } from 'lucide-react';

interface Props {
  onConfirm: (note?: string) => void;
  onCancel: () => void;
}

export function RejectNoteModal({ onConfirm, onCancel }: Props) {
  const [note, setNote] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onConfirm(note.trim() || undefined);
    }
    if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-100">Rejeitar execucao</h3>
          <button onClick={onCancel} className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300">
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <label className="block text-xs text-zinc-400">Nota (opcional)</label>
          <textarea
            ref={inputRef}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Motivo da rejeicao..."
            rows={3}
            className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-red-500 resize-none"
          />
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-800">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={() => onConfirm(note.trim() || undefined)}
            className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded-lg font-medium transition-colors"
          >
            Rejeitar
          </button>
        </div>
      </div>
    </div>
  );
}
