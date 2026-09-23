import { FolderGit2, Hammer, Clock, X, EyeOff } from 'lucide-react';
import type { LocalRepositoryRecord } from '@/types/repo-graph';

interface RepoGraphConsentDialogProps {
  repository: LocalRepositoryRecord;
  fileCount?: number;
  onCreate: () => void;
  onNotNow: () => void;
  onNeverAsk: () => void;
}

export function estimateBuildTime(fileCount?: number): string {
  if (fileCount === undefined) return '~1-2 minutos';
  if (fileCount <= 200) return '~1 minuto';
  if (fileCount <= 3000) return '~1-2 minutos';
  return '~2-3 minutos';
}

export function RepoGraphConsentDialog({
  repository,
  fileCount,
  onCreate,
  onNotNow,
  onNeverAsk,
}: RepoGraphConsentDialogProps) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="w-full max-w-md mx-4 rounded-xl border border-zinc-700 bg-zinc-900 p-5">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-zinc-800 flex items-center justify-center">
            <FolderGit2 size={20} className="text-blue-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Criar graph do repositorio?</h3>
            <p className="text-xs text-zinc-500">
              Indexa o codigo para o assistente consultar a estrutura antes de buscas brutas.
            </p>
          </div>
        </div>

        {/* Resumo: pasta + provider + estimativa (12.3) */}
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg px-3 py-2.5 mb-4 space-y-1.5">
          <p className="text-xs text-zinc-400 font-mono break-all">{repository.canonicalRootPath}</p>
          <p className="text-xs text-zinc-500 flex items-center gap-1.5">
            <Hammer size={12} />
            Provider: {repository.provider} (100% local, sem API externa)
          </p>
          <p className="text-xs text-zinc-500 flex items-center gap-1.5">
            <Clock size={12} />
            Tempo estimado: {estimateBuildTime(fileCount)}
            {fileCount !== undefined ? ` (${fileCount} arquivos)` : ''}
          </p>
          <p className="text-[10px] text-zinc-600">
            O indice fica em .codegraph/ dentro do repositorio (adicione ao .gitignore se preferir).
          </p>
        </div>

        {/* Acoes */}
        <div className="flex flex-col gap-2">
          <button
            onClick={onCreate}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
          >
            <Hammer size={16} />
            Criar agora
          </button>
          <div className="flex gap-2">
            <button
              onClick={onNotNow}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-sm transition-colors"
            >
              <X size={14} />
              Agora nao
            </button>
            <button
              onClick={onNeverAsk}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-zinc-800 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-400 text-xs transition-colors"
            >
              <EyeOff size={14} />
              Nao perguntar de novo neste repo
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
