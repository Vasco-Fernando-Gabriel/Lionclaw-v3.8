import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle, RotateCw } from 'lucide-react';
import type { BootInstallStatus, BootInstallStreamEvent } from '@/types/open-design';

interface IndicatorProps {
  collapsed?: boolean;
}

export function BootInstallIndicator({ collapsed = false }: IndicatorProps) {
  const [status, setStatus] = useState<BootInstallStatus | null>(null);
  const [showReadyFade, setShowReadyFade] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const [hideAfterReady, setHideAfterReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let everInstalled = false;

    void (async () => {
      try {
        const result = await window.lionclaw.openDesign.bootInstallStatus();
        if (cancelled) return;
        setStatus(result);
        if (result.kind === 'ready') {
          setHideAfterReady(true);
        } else if (result.kind === 'installing') {
          everInstalled = true;
        }
      } catch {}
    })();

    const off = window.lionclaw.openDesign.onBootInstallStream((event: BootInstallStreamEvent) => {
      if (cancelled) return;
      if (event.kind === 'start') {
        everInstalled = true;
        setStatus({ kind: 'installing', runner: event.runner, startedAt: new Date().toISOString() });
        setHideAfterReady(false);
      } else if (event.kind === 'exit') {
        if (event.code === 0) {
          setStatus({ kind: 'ready', finishedAt: new Date().toISOString() });
          if (everInstalled) {
            setShowReadyFade(true);
            setTimeout(() => {
              setShowReadyFade(false);
              setHideAfterReady(true);
            }, 2000);
          } else {
            setHideAfterReady(true);
          }
        } else {
          setStatus({
            kind: 'failed',
            error: `pnpm install exited with code ${event.code}`,
            failedAt: new Date().toISOString(),
          });
        }
      } else if (event.kind === 'error') {
        setStatus({ kind: 'failed', error: event.message, failedAt: new Date().toISOString() });
      }
    });

    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const next = await window.lionclaw.openDesign.bootInstallRetry();
      setStatus(next);
      if (next.kind === 'installing' || next.kind === 'idle') {
        setHideAfterReady(false);
      }
    } finally {
      setRetrying(false);
    }
  };

  if (!status) return null;
  if (status.kind === 'idle') return null;
  if (status.kind === 'ready' && hideAfterReady && !showReadyFade) return null;

  if (collapsed) {
    return (
      <div
        className="px-2 py-2 border-t border-zinc-800 flex justify-center"
        title={status.kind === 'installing' ? 'Preparando motor de design' : undefined}
      >
        {status.kind === 'installing' && <Loader2 size={14} className="animate-spin text-amber-500" />}
        {status.kind === 'ready' && showReadyFade && (
          <CheckCircle2 size={14} className="text-green-400 transition-opacity duration-500" />
        )}
        {status.kind === 'failed' && (
          <button
            onClick={() => void handleRetry()}
            disabled={retrying}
            title={`Falha no install: ${status.error}`}
            className="text-red-400 hover:text-red-300 disabled:opacity-50"
          >
            <AlertCircle size={14} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="px-3 py-2 border-t border-zinc-800">
      {status.kind === 'installing' && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-zinc-800/50">
          <Loader2 size={13} className="animate-spin text-amber-500 shrink-0" />
          <span className="text-[11px] text-zinc-400 truncate">Preparando motor de design</span>
        </div>
      )}

      {status.kind === 'ready' && showReadyFade && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-zinc-800/50 transition-opacity duration-500">
          <CheckCircle2 size={13} className="text-green-400 shrink-0" />
          <span className="text-[11px] text-zinc-400">Motor de design pronto</span>
        </div>
      )}

      {status.kind === 'failed' && (
        <div
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-red-500/10 border border-red-500/30"
          title={status.error}
        >
          <AlertCircle size={13} className="text-red-400 shrink-0" />
          <span className="text-[11px] text-red-300 truncate flex-1" title={status.error}>
            Falha no motor
          </span>
          <button
            onClick={() => void handleRetry()}
            disabled={retrying}
            className="p-1 rounded hover:bg-red-500/20 text-red-300 disabled:opacity-50"
            title="Tentar novamente"
          >
            <RotateCw size={11} className={retrying ? 'animate-spin' : ''} />
          </button>
        </div>
      )}
    </div>
  );
}
