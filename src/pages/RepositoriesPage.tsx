import { useState, useEffect, useCallback } from 'react';
import {
  FolderGit2,
  FolderOpen,
  Hammer,
  RefreshCw,
  Trash2,
  Loader2,
  AlertTriangle,
  CircleAlert,
  CheckCircle2,
  CircleDashed,
  TrendingDown,
  Info,
} from 'lucide-react';
import { useRepoGraphStore } from '@/stores/repo-graph-store';
import type {
  LocalRepositoryRecord,
  RepoGraphStatusEvent,
  RepoGraphSavingsMetrics,
  LocalRepositoryStatus,
} from '@/types/repo-graph';


const STATUS_VISUALS: Record<
  LocalRepositoryStatus,
  { label: string; className: string; icon: React.ReactNode }
> = {
  absent: {
    label: 'Sem graph',
    className: 'bg-zinc-800 text-zinc-400',
    icon: <CircleDashed size={12} />,
  },
  building: {
    label: 'Indexando',
    className: 'bg-blue-500/15 text-blue-300',
    icon: <Loader2 size={12} className="animate-spin" />,
  },
  ready: {
    label: 'Pronto',
    className: 'bg-emerald-500/15 text-emerald-300',
    icon: <CheckCircle2 size={12} />,
  },
  stale: {
    label: 'Desatualizado',
    className: 'bg-amber-500/15 text-amber-300',
    icon: <AlertTriangle size={12} />,
  },
  error: {
    label: 'Erro',
    className: 'bg-red-500/15 text-red-300',
    icon: <CircleAlert size={12} />,
  },
};

function formatDate(iso: string | null): string {
  if (!iso) return 'nunca';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function parseStats(statsJson: string | null): { files?: number; nodes?: number; edges?: number } {
  if (!statsJson) return {};
  try {
    return JSON.parse(statsJson) as { files?: number; nodes?: number; edges?: number };
  } catch {
    return {};
  }
}

function formatCount(value: number | undefined): string | null {
  if (value === undefined) return null;
  return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
}

function formatAvgTokens(value: number | null): string {
  if (value === null) return '-';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : value.toFixed(1);
}


function SavingsMetricsCard({ metrics }: { metrics: RepoGraphSavingsMetrics | null }) {
  if (!metrics) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-500">
        Carregando metricas...
      </div>
    );
  }

  const groups: Array<{
    title: string;
    turns: number;
    avgToolCalls: number | null;
    avgTokens: number | null;
  }> = [
    {
      title: 'Com repo (graph usado)',
      turns: metrics.withRepo.turns,
      avgToolCalls: metrics.withRepo.avgToolCalls,
      avgTokens: metrics.withRepo.avgTokens,
    },
    {
      title: 'Sem repo',
      turns: metrics.withoutRepo.turns,
      avgToolCalls: metrics.withoutRepo.avgToolCalls,
      avgTokens: metrics.withoutRepo.avgTokens,
    },
  ];

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-center gap-2 mb-3">
        <TrendingDown size={15} className="text-emerald-400" />
        <h2 className="text-sm font-semibold text-zinc-200">Economia com CodeGraph</h2>
        <span
          className="text-zinc-600"
          title={
            'Formula fixada (D-5): media de tool calls nao-repo-graph e de tokens por turno, ' +
            'em sessoes COM repo onde o graph foi usado vs sessoes SEM repo, ' +
            `janela minima de ${metrics.minTurnsWindow} turnos por grupo.`
          }
        >
          <Info size={13} />
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        {groups.map((group) => (
          <div key={group.title} className="rounded-md bg-zinc-950/60 border border-zinc-800/60 p-3">
            <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1.5">
              {group.title}
            </p>
            <div className="flex items-baseline gap-4">
              <div>
                <p className="text-lg font-semibold text-zinc-200 tabular-nums">
                  {group.avgToolCalls ?? '-'}
                </p>
                <p className="text-[10px] text-zinc-500">tool calls/turno</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-zinc-200 tabular-nums">
                  {formatAvgTokens(group.avgTokens)}
                </p>
                <p className="text-[10px] text-zinc-500">tokens/turno</p>
              </div>
              <div className="ml-auto">
                <p className="text-xs text-zinc-500 tabular-nums">{group.turns} turnos</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {metrics.windowMet ? (
        <div className="flex items-center gap-4 text-sm">
          <span className="text-zinc-400">
            Tool calls:{' '}
            <strong
              className={
                (metrics.toolCallsSavingsPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
              }
            >
              {metrics.toolCallsSavingsPct === null
                ? 'sem base'
                : `${metrics.toolCallsSavingsPct > 0 ? '-' : '+'}${Math.abs(metrics.toolCallsSavingsPct)}%`}
            </strong>
          </span>
          <span className="text-zinc-400">
            Tokens:{' '}
            <strong
              className={
                (metrics.tokensSavingsPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
              }
            >
              {metrics.tokensSavingsPct === null
                ? 'sem base'
                : `${metrics.tokensSavingsPct > 0 ? '-' : '+'}${Math.abs(metrics.tokensSavingsPct)}%`}
            </strong>
          </span>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">
          Janela insuficiente: a economia aparece quando os dois grupos atingem{' '}
          {metrics.minTurnsWindow}+ turnos ({metrics.withRepo.turns} com repo,{' '}
          {metrics.withoutRepo.turns} sem repo ate agora).
        </p>
      )}
    </div>
  );
}


interface RepositoryRowProps {
  repo: LocalRepositoryRecord;
  pending: boolean;
  progress: string | null;
  onBuild: (repo: LocalRepositoryRecord) => void;
  onUpdate: (repo: LocalRepositoryRecord) => void;
  onRemove: (repo: LocalRepositoryRecord) => void;
}

function RepositoryRow({ repo, pending, progress, onBuild, onUpdate, onRemove }: RepositoryRowProps) {
  const visual = STATUS_VISUALS[repo.status];
  const stats = parseStats(repo.statsJson);
  const building = repo.status === 'building';
  const statParts = [
    formatCount(stats.files) && `${formatCount(stats.files)} arquivos`,
    formatCount(stats.nodes) && `${formatCount(stats.nodes)} nodes`,
    formatCount(stats.edges) && `${formatCount(stats.edges)} edges`,
  ].filter(Boolean);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-start gap-3">
        <FolderGit2 size={18} className="text-blue-400 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-zinc-200">{repo.name}</span>
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${visual.className}`}
            >
              {visual.icon}
              {visual.label}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 font-mono">
              {repo.provider}
            </span>
          </div>
          <p className="text-xs text-zinc-500 font-mono truncate mt-1" title={repo.canonicalRootPath}>
            {repo.canonicalRootPath}
          </p>
          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-zinc-500">
            <span>Ultimo index: {formatDate(repo.lastIndexedAt)}</span>
            {repo.indexedCommit && (
              <span className="font-mono" title={repo.indexedCommit}>
                {repo.indexedCommit.slice(0, 7)}
              </span>
            )}
            {statParts.length > 0 && <span>{statParts.join(' / ')}</span>}
          </div>
          {building && progress && (
            <pre className="mt-2 max-h-20 overflow-y-auto rounded bg-zinc-950/80 border border-zinc-800/60 px-2 py-1.5 text-[10px] text-zinc-400 whitespace-pre-wrap font-mono">
              {progress}
            </pre>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => onBuild(repo)}
            disabled={pending || building}
            title={
              repo.status === 'absent'
                ? 'Criar o code graph deste repositorio'
                : 'Reindexar do zero (index --force)'
            }
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-blue-600/20 text-blue-300 text-xs hover:bg-blue-600/30 transition-colors disabled:opacity-50"
          >
            {building ? <Loader2 size={12} className="animate-spin" /> : <Hammer size={12} />}
            {repo.status === 'absent' ? 'Criar graph' : 'Reindexar'}
          </button>
          {repo.status !== 'absent' && (
            <button
              onClick={() => onUpdate(repo)}
              disabled={pending || building}
              title="Atualizar o graph (codegraph sync incremental)"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-700 text-xs text-zinc-400 hover:bg-zinc-800 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={12} />
              Atualizar
            </button>
          )}
          <button
            onClick={() => onRemove(repo)}
            disabled={pending || building}
            title="Remover o repositorio do LionClaw (o .codegraph/ local nao e apagado)"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-800 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400 transition-colors disabled:opacity-50"
          >
            <Trash2 size={12} />
            Remover
          </button>
        </div>
      </div>
    </div>
  );
}


export default function RepositoriesPage() {
  const repositories = useRepoGraphStore((s) => s.repositories);
  const pending = useRepoGraphStore((s) => s.pending);
  const loadRepositories = useRepoGraphStore((s) => s.loadRepositories);
  const addRepository = useRepoGraphStore((s) => s.addRepository);
  const removeRepository = useRepoGraphStore((s) => s.removeRepository);
  const build = useRepoGraphStore((s) => s.build);
  const update = useRepoGraphStore((s) => s.update);

  const [metrics, setMetrics] = useState<RepoGraphSavingsMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progressByRepo, setProgressByRepo] = useState<Record<string, string>>({});

  const loadMetrics = useCallback(async () => {
    try {
      const result = await window.lionclaw.repoGraph.metrics();
      if ('error' in result) {
        console.warn('[repositories-page] metrics error', result.error);
        return;
      }
      setMetrics(result);
    } catch (err) {
      console.warn('[repositories-page] metrics failed', err);
    }
  }, []);

  useEffect(() => {
    void loadRepositories();
    void loadMetrics();
  }, [loadRepositories, loadMetrics]);

  useEffect(() => {
    const unsub = window.lionclaw.repoGraph.onStatus((event: RepoGraphStatusEvent) => {
      if (event.buildProgress) {
        setProgressByRepo((prev) => ({
          ...prev,
          [event.repositoryId]: ((prev[event.repositoryId] ?? '') + event.buildProgress).slice(-2000),
        }));
      }
      if (event.runStatus && event.runStatus !== 'running') {
        setProgressByRepo((prev) => {
          const next = { ...prev };
          delete next[event.repositoryId];
          return next;
        });
        void loadRepositories();
      } else if (!event.buildProgress) {
        void loadRepositories();
      }
    });
    return unsub;
  }, [loadRepositories]);

  const handleAdd = async () => {
    setError(null);
    const dir = await window.lionclaw.dialog.openDirectory();
    if (!dir) return;
    const result = await addRepository(dir);
    if ('error' in result) setError(result.error);
  };

  const handleBuild = useCallback(
    async (repo: LocalRepositoryRecord) => {
      setError(null);
      const result = await build(repo.id, null);
      if ('error' in result) setError(result.error);
    },
    [build],
  );

  const handleUpdate = useCallback(
    async (repo: LocalRepositoryRecord) => {
      setError(null);
      const result = await update(repo.id, null);
      if ('error' in result) setError(result.error);
    },
    [update],
  );

  const handleRemove = useCallback(
    async (repo: LocalRepositoryRecord) => {
      if (
        !window.confirm(
          `Remover "${repo.name}" do LionClaw? Conversas vinculadas perdem o repo ativo. O indice .codegraph/ na pasta nao e apagado.`,
        )
      ) {
        return;
      }
      setError(null);
      const result = await removeRepository(repo.id);
      if ('error' in result) setError(result.error);
    },
    [removeRepository],
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="h-12 flex items-center px-4 border-b border-zinc-800 app-drag-region shrink-0">
        <FolderGit2 size={16} className="text-blue-400 mr-2" />
        <h1 className="text-sm font-semibold text-zinc-200">Repositorios</h1>
        <div className="flex-1" />
        <button
          onClick={handleAdd}
          disabled={pending}
          className="no-drag inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium transition-colors disabled:opacity-50"
        >
          <FolderOpen size={13} />
          Adicionar repositorio
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <p className="text-xs text-zinc-500 max-w-2xl">
          Repositorios locais com code graph (provider 100% local). O graph e consultado pelo
          orquestrador antes de buscas brutas nas conversas com repo ativo. Criar e atualizar o
          graph exige acao sua — agentes nunca tem acesso de escrita.
        </p>

        {error && (
          <div className="rounded-md border border-red-900/60 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <SavingsMetricsCard metrics={metrics} />

        {repositories.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center">
            <FolderGit2 size={24} className="mx-auto text-zinc-700 mb-2" />
            <p className="text-sm text-zinc-500">Nenhum repositorio registrado.</p>
            <p className="text-xs text-zinc-600 mt-1">
              Adicione uma pasta aqui ou vincule um repositorio direto na conversa.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {repositories.map((repo) => (
              <RepositoryRow
                key={repo.id}
                repo={repo}
                pending={pending}
                progress={progressByRepo[repo.id] ?? null}
                onBuild={handleBuild}
                onUpdate={handleUpdate}
                onRemove={handleRemove}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
