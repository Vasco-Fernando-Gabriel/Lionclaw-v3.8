import { useEffect, useMemo, useState } from 'react';
import { FileText, FolderOpen, GitBranch, GitCommitHorizontal, Package } from 'lucide-react';
import type { DynamicWorkflowArtifact, DynamicWorkflowRun } from '@/types';
import type {
  DynamicWorkflowCockpitOptionalAPI,
  RunBundleEntry,
  TouchedFilesFromEvents,
} from '@/types/dynamic-workflow-cockpit';
import { parseSqliteUtc, formatLocalDateTime } from '@/lib/sqlite-time';
import { shortNodeId } from './DynamicWorkflowNodeTimeline';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readOptionalApi(): DynamicWorkflowCockpitOptionalAPI {
  const api: Partial<DynamicWorkflowCockpitOptionalAPI> | undefined = window.lionclaw?.dynamicWorkflow;
  return {
    getRunBundle: typeof api?.getRunBundle === 'function' ? api.getRunBundle : undefined,
    openRunDir: typeof api?.openRunDir === 'function' ? api.openRunDir : undefined,
  };
}

export interface WorkflowOutputsTabProps {
  runId: string;
  run: DynamicWorkflowRun | null;
  touched: TouchedFilesFromEvents;
  liveTouchedFiles: string[];
  artifacts: DynamicWorkflowArtifact[];
}

export function WorkflowOutputsTab({ runId, run, touched, liveTouchedFiles, artifacts }: WorkflowOutputsTabProps) {
  const api = useMemo(readOptionalApi, []);
  const [bundle, setBundle] = useState<RunBundleEntry[] | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [bundleLoading, setBundleLoading] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    const getRunBundle = api.getRunBundle;
    if (!getRunBundle) return;
    let cancelled = false;
    setBundleLoading(true);
    setBundleError(null);
    void getRunBundle(runId)
      .then((result) => {
        if (cancelled) return;
        if (Array.isArray(result)) setBundle(result);
        else setBundleError(result.error);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBundleError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setBundleLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, runId]);

  const filesFromEvents = touched.files.length > 0;
  const files = filesFromEvents ? touched.files : liveTouchedFiles;
  const hiddenCount = filesFromEvents ? touched.hidden : 0;

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto" data-testid="outputs-tab">
      {/* (a) Arquivos tocados */}
      <section data-testid="outputs-touched">
        <SectionTitle>
          Arquivos tocados
          <Count n={files.length} />
          {hiddenCount > 0 && <span className="font-mono text-[10px] text-zinc-500">+{hiddenCount}</span>}
          {!filesFromEvents && files.length > 0 && (
            <span className="ml-1 text-[10px] normal-case tracking-normal text-zinc-500">(stream ao vivo)</span>
          )}
        </SectionTitle>
        {files.length === 0 ? (
          <Empty>Nenhum arquivo tocado ainda.</Empty>
        ) : (
          <div className="flex flex-col gap-0.5">
            {files.map((file) => (
              <div
                key={file}
                className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] hover:bg-zinc-900"
                title={file}
              >
                <FileText size={10} className="shrink-0 text-amber-400/70" />
                <span dir="rtl" className="min-w-0 flex-1 truncate text-left font-mono text-zinc-300">
                  {file}
                </span>
              </div>
            ))}
            {(hiddenCount > 0 || touched.truncated) && (
              <p className="px-1 text-[11px] text-zinc-400">
                {hiddenCount > 0 ? `+${hiddenCount} nao listado(s)` : 'lista truncada pelo host'}
              </p>
            )}
          </div>
        )}
      </section>

      {/* (b) Branch/worktree + commits por writer */}
      <section data-testid="outputs-commits">
        <SectionTitle>
          Commits dos writers
          <Count n={touched.writers.length} />
        </SectionTitle>
        <div className="mb-1.5 flex flex-col gap-0.5 text-[11px] text-zinc-400">
          <div className="flex items-center gap-1.5">
            <GitBranch size={10} className="shrink-0 text-zinc-500" />
            <span>branch</span>
            <span className="min-w-0 truncate font-mono text-zinc-300" title={run?.worktreeBranch ?? undefined}>
              {run?.worktreeBranch ?? '-'}
            </span>
            <span className="text-zinc-500">de</span>
            <span className="font-mono text-zinc-300">{run?.baseBranch ?? '-'}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <FolderOpen size={10} className="shrink-0 text-zinc-500" />
            <span>worktree</span>
            <span className="min-w-0 truncate font-mono text-zinc-300" title={run?.worktreePath ?? undefined}>
              {run?.worktreePath ?? '-'}
            </span>
          </div>
        </div>
        {touched.writers.length === 0 ? (
          <Empty>Nenhum writer concluiu ainda.</Empty>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-800">
            {touched.writers.map((w, i) => (
              <div
                key={`${w.nodeId}#${w.attempt}`}
                className={`flex items-center gap-2 px-3 py-1.5 text-[11px] ${i > 0 ? 'border-t border-zinc-800/70' : ''}`}
                title={w.nodeId}
                data-testid={`outputs-writer-${w.nodeId}`}
              >
                <GitCommitHorizontal size={11} className="shrink-0 text-zinc-500" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-zinc-200">{w.label ?? w.agentId ?? shortNodeId(w.nodeId)}</span>
                  <span className="ml-1 font-mono text-[11px] text-zinc-500">#{w.attempt}</span>
                  {w.phaseId && <span className="ml-1.5 text-[10px] text-zinc-500">{w.phaseId}</span>}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-zinc-500">{w.touchedFiles.length} arq</span>
                <span
                  className={`shrink-0 font-mono text-[11px] ${w.worktreeCommitSha ? 'text-amber-300' : 'text-zinc-500'}`}
                  title={w.worktreeCommitSha ?? 'sem commit'}
                >
                  {w.worktreeCommitSha ? w.worktreeCommitSha.slice(0, 8) : 'sem commit'}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* (c) Pacote do run (host-controlado) */}
      <section data-testid="outputs-bundle">
        <div className="mb-1.5 flex items-center gap-2">
          <SectionTitle inline>
            Pacote do run
            {bundle && <Count n={bundle.length} />}
          </SectionTitle>
          {api.openRunDir && (
            <button
              type="button"
              onClick={() => {
                setOpenError(null);
                void api
                  .openRunDir?.(runId)
                  .then((r) => {
                    if (r && 'error' in r) setOpenError(r.error);
                  })
                  .catch((err: unknown) => setOpenError(err instanceof Error ? err.message : String(err)));
              }}
              className="ml-auto flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800"
              data-testid="outputs-open-run-dir"
            >
              <FolderOpen size={11} />
              Abrir pasta do run
            </button>
          )}
        </div>
        {openError && <p className="mb-1 text-[11px] text-red-300">{openError}</p>}
        {!api.getRunBundle ? (
          <Empty testId="outputs-bundle-unavailable">Pacote do run indisponivel nesta versao.</Empty>
        ) : bundleLoading && !bundle ? (
          <Empty>Lendo o pacote do run...</Empty>
        ) : bundleError ? (
          <p className="text-[11px] text-red-300">{bundleError}</p>
        ) : !bundle || bundle.length === 0 ? (
          <Empty>Pacote vazio.</Empty>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-800">
            {bundle.map((entry, i) => {
              const at = parseSqliteUtc(entry.mtime);
              return (
                <div
                  key={entry.relativePath}
                  className={`flex items-center gap-2 px-3 py-1.5 text-[11px] ${i > 0 ? 'border-t border-zinc-800/70' : ''}`}
                  title={entry.relativePath}
                >
                  <Package size={11} className="shrink-0 text-zinc-500" />
                  <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">{entry.relativePath}</span>
                  <span className="shrink-0 font-mono text-[11px] text-zinc-500">{formatBytes(entry.sizeBytes)}</span>
                  {at && (
                    <span className="shrink-0 font-mono text-[11px] text-zinc-500">{formatLocalDateTime(at)}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* (d) Artefatos declarados (artifact() do .js) */}
      <section data-testid="outputs-artifacts">
        <SectionTitle>
          Artefatos declarados
          <Count n={artifacts.length} />
        </SectionTitle>
        {artifacts.length === 0 ? (
          <Empty>Nenhum artefato declarado ainda.</Empty>
        ) : (
          <div className="flex flex-col gap-1.5">
            {artifacts.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2"
              >
                <FolderOpen size={13} className="text-zinc-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[11px] text-zinc-300">{a.path}</p>
                  <p className="font-mono text-[10px] text-zinc-500">
                    {a.kind} · {a.sha256.slice(0, 12)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void window.lionclaw.shell.showInFolder(a.path)}
                  className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
                  title="Mostrar na pasta"
                >
                  <FolderOpen size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SectionTitle({ children, inline = false }: { children: React.ReactNode; inline?: boolean }) {
  return (
    <p
      className={`${inline ? '' : 'mb-1.5 '}flex items-center gap-1 text-[11px] uppercase tracking-wider text-zinc-400 font-medium`}
    >
      {children}
    </p>
  );
}

function Count({ n }: { n: number }) {
  return <span className="font-mono text-[10px] text-zinc-500">{n}</span>;
}

function Empty({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <p className="text-[12px] text-zinc-400" data-testid={testId}>
      {children}
    </p>
  );
}
