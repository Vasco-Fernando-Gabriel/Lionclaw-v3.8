import { useRef, useEffect, useState } from 'react';
import { Loader2, ChevronDown, ChevronRight, FolderOpen } from 'lucide-react';
import type { RepoManifest } from '@/types/pipeline';
import { ROLE_METADATA } from '@/types/pipeline';

const ROLE_ORDER = [
  'route',
  'auth',
  'query',
  'middleware',
  'config',
  'migration',
  'async',
  'crypto',
  'template',
  'error-handling',
] as const;

function formatSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

interface RepoProfilerViewProps {
  manifest: RepoManifest | null;
  isStreaming: boolean;
  streamContent: string;
  projectId: string;
}

function PhaseRunningBadge() {
  return (
    <div className="flex items-center gap-2">
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
      </span>
      <span className="text-[11px] text-amber-300 font-medium">Repo Profiler</span>
      <Loader2 size={11} className="text-amber-400 animate-spin" />
    </div>
  );
}

interface RoleTooltipProps {
  role: string;
}

function RoleTooltip({ role }: RoleTooltipProps) {
  const meta = ROLE_METADATA[role as keyof typeof ROLE_METADATA];
  if (!meta) return null;

  return (
    <div className="absolute left-0 top-full mt-1 z-50 w-64 rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-xl pointer-events-none">
      <p className="text-[11px] font-semibold text-amber-300 mb-1">{meta.label}</p>
      <p className="text-[11px] text-zinc-300 mb-2">{meta.description}</p>
      <p className="text-[10px] text-zinc-500 mb-1">Threshold: {meta.threshold}+ correspondencias</p>
      <div className="flex flex-wrap gap-1">
        {meta.samplePatterns.map((p) => (
          <span key={p} className="text-[10px] font-mono bg-zinc-800 text-zinc-400 rounded px-1 py-0.5">
            {p}
          </span>
        ))}
      </div>
    </div>
  );
}

interface RoleRowProps {
  role: string;
  files: string[];
  maxCount: number;
  projectId: string;
}

function RoleRow({ role, files, maxCount, projectId }: RoleRowProps) {
  const count = files.length;
  const pct = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;
  const [expanded, setExpanded] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);

  const meta = ROLE_METADATA[role as keyof typeof ROLE_METADATA];
  const label = meta?.label ?? role;

  async function handleOpenFile(relativePath: string) {
    const result = await window.lionclaw.pipeline.openProjectFile(projectId, relativePath);
    if ('error' in result) {
      console.error('Erro ao abrir arquivo:', result.error);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-3">
        {/* Expand toggle */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 shrink-0 w-24 group/label"
          aria-expanded={expanded}
        >
          <span className="text-zinc-600 group-hover/label:text-zinc-400 transition-colors">
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
          {/* Label with tooltip */}
          <div
            className="relative"
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
          >
            <span className="text-[11px] text-zinc-400 font-mono truncate group-hover/label:text-zinc-200 transition-colors">
              {label}
            </span>
            {showTooltip && <RoleTooltip role={role} />}
          </div>
        </button>

        {/* Bar track */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden hover:opacity-80 transition-opacity"
          tabIndex={-1}
        >
          <div className="h-2 bg-amber-500 rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
        </button>

        {/* Count */}
        <span className="text-[11px] text-zinc-300 font-mono w-6 text-right shrink-0">{count}</span>
      </div>

      {/* Expanded file list */}
      {expanded && (
        <div className="mt-1.5 ml-7 space-y-0.5">
          {files.map((filePath) => (
            <div
              key={filePath}
              className="flex items-center justify-between gap-2 py-0.5 px-2 rounded hover:bg-zinc-800/60 group/file"
            >
              <span className="text-[10px] font-mono text-zinc-400 truncate">{filePath}</span>
              <button
                onClick={() => handleOpenFile(filePath)}
                className="shrink-0 flex items-center gap-1 text-[10px] text-zinc-600 hover:text-amber-300 transition-colors opacity-0 group-hover/file:opacity-100"
                title="Abrir no Finder"
              >
                <FolderOpen size={10} />
                <span>Abrir</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RepoProfilerView({ manifest, isStreaming, streamContent, projectId }: RepoProfilerViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isStreaming) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [streamContent, isStreaming]);

  const roleEntries = (() => {
    if (!manifest) return [];
    const all = Object.entries(manifest.filesByRole)
      .map(([role, files]) => ({ role, files: files as string[] }))
      .filter((e) => e.files.length > 0);

    const known = ROLE_ORDER.flatMap((r) => {
      const found = all.find((e) => e.role === r);
      return found ? [found] : [];
    });
    const unknown = all
      .filter((e) => !(ROLE_ORDER as readonly string[]).includes(e.role))
      .sort((a, b) => b.files.length - a.files.length);

    return [...known, ...unknown];
  })();

  const maxCount = roleEntries.length > 0 ? Math.max(...roleEntries.map((e) => e.files.length)) : 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Stream da fase</span>
        {isStreaming ? (
          <PhaseRunningBadge />
        ) : (
          <span className="text-[11px] text-zinc-600 font-medium">Repo Profiler</span>
        )}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
        {/* Streaming state: raw progress text */}
        {isStreaming && (
          <>
            {streamContent ? (
              <pre className="font-mono text-xs text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">
                {streamContent}
                <span className="repo-profiler-cursor" />
              </pre>
            ) : (
              <p className="text-xs text-zinc-600 italic mt-4 text-center">Aguardando saida do agente...</p>
            )}
            <div ref={bottomRef} />
          </>
        )}

        {/* Completed state: manifest summary */}
        {!isStreaming && manifest && (
          <div className="space-y-5">
            {/* Detection header */}
            <div>
              <p className="text-sm font-semibold text-zinc-100">
                Detectado:{' '}
                <span className="text-amber-300">
                  {manifest.language}
                  {manifest.framework && manifest.framework !== 'unknown' && manifest.framework !== manifest.language
                    ? ` + ${manifest.framework}`
                    : ''}
                </span>
              </p>
              <p className="text-xs text-zinc-500 mt-1">
                {manifest.totalFiles} arquivos encontrados <span className="text-zinc-400">|</span>{' '}
                {manifest.classifiedFiles} classificados
              </p>
            </div>

            {/* Role bars section */}
            {roleEntries.length > 0 && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">
                  Classificacao por role
                </p>
                <div className="space-y-2">
                  {roleEntries.map(({ role, files }) => (
                    <RoleRow key={role} role={role} files={files} maxCount={maxCount} projectId={projectId} />
                  ))}
                </div>
              </div>
            )}

            {/* Skipped large files */}
            {manifest.skippedLargeFiles && manifest.skippedLargeFiles.length > 0 && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-3">
                  {manifest.skippedLargeFiles.length} arquivos {'>'} 5MB ignorados
                </p>
                <ul className="space-y-1">
                  {manifest.skippedLargeFiles.map((f) => (
                    <li key={f.path} className="flex items-center justify-between text-[11px] font-mono text-zinc-300">
                      <span className="truncate">{f.path}</span>
                      <span className="text-zinc-500 ml-2 shrink-0">{formatSize(f.sizeBytes)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Previous scan */}
            <div className="flex items-start gap-2 text-xs text-zinc-500">
              <span className="shrink-0">Scan anterior:</span>
              {manifest.previousScan ? (
                <span className="text-zinc-300 font-mono break-all">
                  {manifest.previousScan.split('/').pop() ?? manifest.previousScan}
                </span>
              ) : (
                <span className="italic">Nenhum scan anterior encontrado</span>
              )}
            </div>
          </div>
        )}

        {/* Idle: nothing yet */}
        {!isStreaming && !manifest && (
          <p className="text-xs text-zinc-600 italic mt-4 text-center">Nenhum conteudo ainda.</p>
        )}
      </div>

      <style>{`
        .repo-profiler-cursor {
          display: inline-block;
          width: 6px;
          height: 0.9em;
          background: rgba(251, 191, 36, 0.8);
          margin-left: 2px;
          vertical-align: text-bottom;
          border-radius: 1px;
          animation: repo-profiler-blink 1s step-end infinite;
        }
        @keyframes repo-profiler-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
