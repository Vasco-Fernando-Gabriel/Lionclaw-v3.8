import { useEffect, useState } from 'react';
import { Lock, Loader2, AlertTriangle } from 'lucide-react';

interface LockedSnapshotPaths {
  snapshotDir: string;
  manifestPath: string;
  contractPath: string;
  artifactHtmlPath: string;
}

interface LockedDesignViewerProps {
  projectId: string;
}

export function LockedDesignViewer({ projectId }: LockedDesignViewerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paths, setPaths] = useState<LockedSnapshotPaths | null>(null);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [lockedAt, setLockedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const result = (await window.lionclaw.openDesign.getLockedSnapshot(projectId)) as
          { ok: true; paths: LockedSnapshotPaths; lockedAt: string | null } | { error: string };

        if (cancelled) return;

        if ('error' in result) {
          setError(result.error === 'not-locked' ? 'Design ainda nao foi travado.' : result.error);
          setLoading(false);
          return;
        }

        setPaths(result.paths);
        setLockedAt(result.lockedAt);

        const htmlResult = await window.lionclaw.openDesign.readLockedHtml(projectId);
        if (cancelled) return;
        if ('error' in htmlResult) {
          setError(`Nao foi possivel ler o arquivo HTML do design travado: ${htmlResult.error}`);
          setLoading(false);
          return;
        }
        setHtmlContent(htmlResult.html);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 gap-2">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm">Carregando design travado...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-3 p-8">
        <AlertTriangle size={24} className="text-amber-500" />
        <p className="text-sm text-center text-zinc-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Read-only header */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 bg-zinc-950 border-b border-zinc-800">
        <div className="flex items-center gap-1.5 px-2 py-1 bg-amber-900/40 border border-amber-700/40 rounded text-[11px] text-amber-300 font-medium">
          <Lock size={10} />
          Read-only
        </div>
        {lockedAt && (
          <span className="text-[11px] text-zinc-500">Travado em {new Date(lockedAt).toLocaleString('pt-BR')}</span>
        )}
        {paths && <span className="text-[11px] text-zinc-600 ml-auto truncate max-w-xs">{paths.snapshotDir}</span>}
      </div>

      {/* Sandboxed iframe carregando via protocolo `lionclaw-asset://` para
          ganhar CSP propria (permite Google Fonts, CDN, etc) sem afrouxar a
          CSP geral do app. Iframe permanece sandboxed sem `allow-same-origin`
          — SPEC L1610-1614 cumprida. */}
      {htmlContent ? (
        <iframe
          className="flex-1 w-full border-0 bg-white"
          sandbox="allow-scripts"
          src={`lionclaw-asset://host/locked-design/${encodeURIComponent(projectId)}`}
          title="Design Travado (Read-only)"
        />
      ) : (
        <div className="flex items-center justify-center flex-1 text-zinc-500 text-sm">Conteudo nao disponivel</div>
      )}
    </div>
  );
}
