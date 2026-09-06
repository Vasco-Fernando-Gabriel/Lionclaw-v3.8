import { useState } from 'react';
import {
  FolderOpen,
  FolderGit2,
  Trash2,
  Hammer,
  RefreshCw,
  BellOff,
  Loader2,
} from 'lucide-react';
import { useRepoGraphStore } from '@/stores/repo-graph-store';


interface RepoSelectorControlProps {
  sessionId: string;
}

export function RepoSelectorControl({ sessionId }: RepoSelectorControlProps) {
  const sessionState = useRepoGraphStore((s) => s.sessionState);
  const pending = useRepoGraphStore((s) => s.pending);
  const addRepository = useRepoGraphStore((s) => s.addRepository);
  const attachSession = useRepoGraphStore((s) => s.attachSession);
  const detachSession = useRepoGraphStore((s) => s.detachSession);
  const build = useRepoGraphStore((s) => s.build);
  const update = useRepoGraphStore((s) => s.update);
  const setPromptSuppressed = useRepoGraphStore((s) => s.setPromptSuppressed);
  const setGlobalPromptSuppressed = useRepoGraphStore((s) => s.setGlobalPromptSuppressed);

  const [error, setError] = useState<string | null>(null);

  const repo = sessionState?.repository ?? null;

  const handlePickFolder = async () => {
    setError(null);
    const dir = await window.lionclaw.dialog.openDirectory();
    if (!dir) return;
    const added = await addRepository(dir);
    if ('error' in added) {
      setError(added.error);
      return;
    }
    const attached = await attachSession(sessionId, added.id);
    if ('error' in attached) setError(attached.error);
  };

  const handleDetach = async () => {
    setError(null);
    const result = await detachSession(sessionId);
    if ('error' in result) setError(result.error);
  };

  const handleBuild = async () => {
    if (!repo) return;
    setError(null);
    const result = await build(repo.id, sessionId);
    if ('error' in result) setError(result.error);
  };

  const handleUpdate = async () => {
    if (!repo) return;
    setError(null);
    const result = await update(repo.id, sessionId);
    if ('error' in result) setError(result.error);
  };

  const handleSuppressSession = async () => {
    setError(null);
    const result = await setPromptSuppressed(
      sessionId,
      !(sessionState?.attach?.graphPromptSuppressed ?? false),
    );
    if ('error' in result) setError(result.error);
  };

  const handleSuppressGlobal = async () => {
    if (!repo) return;
    setError(null);
    const result = await setGlobalPromptSuppressed(repo.id, !repo.graphPromptSuppressedGlobal);
    if ('error' in result) setError(result.error);
  };

  const building = repo?.status === 'building' || Boolean(sessionState?.activeRun);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        {repo ? (
          <span
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-zinc-800/80 text-xs text-zinc-300"
            title={repo.canonicalRootPath}
          >
            <FolderGit2 size={13} className="text-blue-400" />
            {repo.name}
          </span>
        ) : (
          <button
            onClick={handlePickFolder}
            disabled={pending}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-zinc-700 text-xs text-zinc-400 hover:bg-zinc-800 transition-colors disabled:opacity-50"
          >
            <FolderOpen size={13} />
            Vincular repositorio
          </button>
        )}

        {repo && (
          <>
            {/* 'error' tambem oferece 'Criar graph': build() roda `init --index`
                quando nao ha graph (sync/'Atualizar' falharia com "not
                initialized"). Sem isto um erro de ambiente no add vira beco sem
                saida — so 'Atualizar', que nunca inicializa o graph. */}
            {(repo.status === 'absent' || repo.status === 'error') && (
              <button
                onClick={handleBuild}
                disabled={pending || building}
                title="Criar o code graph deste repositorio"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-blue-600/20 text-blue-300 text-xs hover:bg-blue-600/30 transition-colors disabled:opacity-50"
              >
                {building ? <Loader2 size={12} className="animate-spin" /> : <Hammer size={12} />}
                Criar graph
              </button>
            )}
            {(repo.status === 'ready' || repo.status === 'stale') && (
              <button
                onClick={handleUpdate}
                disabled={pending || building}
                title="Atualizar o graph (sync incremental)"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-700 text-xs text-zinc-400 hover:bg-zinc-800 transition-colors disabled:opacity-50"
              >
                {building ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RefreshCw size={12} />
                )}
                Atualizar
              </button>
            )}
            <button
              onClick={handleSuppressSession}
              disabled={pending}
              title={
                sessionState?.attach?.graphPromptSuppressed
                  ? 'Voltar a mostrar o aviso de graph nesta conversa'
                  : 'Suprimir o aviso de graph nesta conversa'
              }
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-800 text-xs transition-colors disabled:opacity-50 ${
                sessionState?.attach?.graphPromptSuppressed
                  ? 'text-amber-400/80 hover:bg-zinc-800'
                  : 'text-zinc-500 hover:bg-zinc-800'
              }`}
            >
              <BellOff size={12} />
              Aviso (sessao)
            </button>
            <button
              onClick={handleSuppressGlobal}
              disabled={pending}
              title={
                repo.graphPromptSuppressedGlobal
                  ? 'Voltar a perguntar sobre graph neste repo'
                  : 'Nao perguntar sobre graph neste repo'
              }
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-800 text-xs transition-colors disabled:opacity-50 ${
                repo.graphPromptSuppressedGlobal
                  ? 'text-amber-400/80 hover:bg-zinc-800'
                  : 'text-zinc-500 hover:bg-zinc-800'
              }`}
            >
              <BellOff size={12} />
              Aviso (repo)
            </button>
            <button
              onClick={handleDetach}
              disabled={pending}
              title="Remover o repositorio desta conversa"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-800 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400 transition-colors disabled:opacity-50"
            >
              <Trash2 size={12} />
              Remover
            </button>
          </>
        )}
      </div>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
