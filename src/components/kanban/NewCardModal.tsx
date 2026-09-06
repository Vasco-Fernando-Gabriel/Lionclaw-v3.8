import { useState } from 'react';
import { X } from 'lucide-react';
import { useKanbanStore } from '@/stores/kanban-store';

interface NewCardModalProps {
  boardPrefix: string;
  onClose: () => void;
}

export function NewCardModal({ boardPrefix, onClose }: NewCardModalProps) {
  const createCard = useKanbanStore((s) => s.createCard);
  const [title, setTitle] = useState('');
  const [type, setType] = useState('');
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (title.trim() === '' || saving) return;
    setSaving(true);
    try {
      const ok = await createCard({
        board: boardPrefix,
        title: title.trim(),
        ...(type ? { type } : {}),
      });
      if (ok) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-md flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-6 pt-5 pb-2">
          <h2 className="text-base font-semibold text-zinc-100 flex-1">Novo card</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="Fechar"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-6 pb-5 space-y-4">
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-1.5">
              Título
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
              }}
              placeholder="verbo + objeto + resultado"
              autoFocus
              className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-500"
            />
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-1.5">
              Tipo (opcional)
            </label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-500"
            >
              <option value="">(sem tipo)</option>
              <option>Bug</option>
              <option>Feature</option>
              <option>Débito técnico</option>
              <option>Chore</option>
            </select>
          </div>
          <p className="text-xs text-zinc-500 leading-relaxed">
            Só o título é obrigatório. O card nasce no Backlog e o agente completa os
            detalhes na conversa: critério de aceite, reprodução, severidade. Sem travas.
          </p>
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg text-xs font-semibold border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={() => void handleCreate()}
              disabled={title.trim() === '' || saving}
              className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Criar no Backlog
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
