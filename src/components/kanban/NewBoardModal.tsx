import { useEffect, useState } from 'react';
import { X, FolderGit2 } from 'lucide-react';
import type { LocalRepositoryRecord } from '@/types/repo-graph';
import { useKanbanStore } from '@/stores/kanban-store';
import { useAppStore } from '@/stores/app-store';

interface NewBoardModalProps {
  onClose: () => void;
}

export function NewBoardModal({ onClose }: NewBoardModalProps) {
  const createBoard = useKanbanStore((s) => s.createBoard);
  const [repos, setRepos] = useState<LocalRepositoryRecord[] | null>(null);
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [repositoryId, setRepositoryId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let mounted = true;
    void window.lionclaw.repoGraph.list().then((result) => {
      if (!mounted) return;
      if (Array.isArray(result)) setRepos(result);
      else setRepos([]);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const canCreate = name.trim() !== '' && prefix.trim() !== '' && repositoryId !== '' && !saving;

  const handleCreate = async () => {
    if (!canCreate) return;
    setSaving(true);
    setError(null);
    try {
      const result = await createBoard({
        name: name.trim(),
        prefix: prefix.trim().toUpperCase(),
        repositoryId,
      });
      if (result.ok) onClose();
      else setError(result.error ?? 'falha ao criar quadro');
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
          <h2 className="text-base font-semibold text-zinc-100 flex-1">Novo quadro</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="Fechar"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-6 pb-5 space-y-4">
          {repos !== null && repos.length === 0 ? (
            <div className="text-center py-4 space-y-3">
              <FolderGit2 size={26} className="text-zinc-600 mx-auto" />
              <p className="text-sm text-zinc-400 leading-relaxed">
                Um quadro pertence a um repositório registrado, e nenhum repositório está registrado ainda. Registre um
                na página Repositórios e volte aqui.
              </p>
              <button
                onClick={() => {
                  onClose();
                  useAppStore.getState().setPage('repositories');
                }}
                className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white transition-colors"
              >
                Abrir Repositórios
              </button>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-1.5">
                  Nome
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="LionClaw"
                  autoFocus
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-1.5">
                  Prefixo (2-4 letras, imutável)
                </label>
                <input
                  type="text"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value.toUpperCase())}
                  placeholder="LC"
                  maxLength={4}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-500 font-mono uppercase"
                />
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-1.5">
                  Repositório registrado
                </label>
                <select
                  value={repositoryId}
                  onChange={(e) => setRepositoryId(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-500"
                >
                  <option value="">Selecione...</option>
                  {(repos ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} · {r.rootPath}
                    </option>
                  ))}
                </select>
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex justify-end gap-2">
                <button
                  onClick={onClose}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-semibold border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => void handleCreate()}
                  disabled={!canCreate}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Criar quadro
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
