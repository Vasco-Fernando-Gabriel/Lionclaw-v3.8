import { useEffect, useRef, useState } from 'react';
import { Lock, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import type { BootstrapResult } from '@/types/open-design';
import { usePipelineStore } from '@/stores/pipeline-store';
import { useOpenDesignStore } from '@/stores/open-design-store';


interface StudioViewProps {
  bootstrap: BootstrapResult;
  projectId: string;
}

function readBounds(el: HTMLElement): { x: number; y: number; width: number; height: number } {
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

export function StudioView({ bootstrap, projectId }: StudioViewProps) {
  const [locking, setLocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const placeholderRef = useRef<HTMLDivElement | null>(null);

  const lockRejection = usePipelineStore(
    (s) => s.projectStates.get(projectId)?.openDesignLockRejection ?? null,
  );
  const currentPhase = usePipelineStore(
    (s) => s.projectStates.get(projectId)?.currentPhase ?? null,
  );

  useEffect(() => {
    if (lockRejection) setLocking(false);
  }, [lockRejection]);
  useEffect(() => {
    if (currentPhase !== null && currentPhase !== 5) setLocking(false);
  }, [currentPhase]);

  useEffect(() => {
    const el = placeholderRef.current;
    if (!el) return;

    const initialBounds = readBounds(el);
    let cancelled = false;
    void window.lionclaw.openDesign
      .showView(bootstrap.webUrl, initialBounds)
      .then((result) => {
        if (cancelled) return;
        if (result && typeof result === 'object' && 'error' in result && result.error) {
          setError(`Falha ao montar LionDesign: ${String(result.error)}`);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    let frame = 0;
    const syncBounds = (): void => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const next = readBounds(el);
        void window.lionclaw.openDesign.setViewBounds(next);
      });
    };

    const ro = new ResizeObserver(syncBounds);
    ro.observe(el);
    window.addEventListener('resize', syncBounds);
    window.addEventListener('scroll', syncBounds, true);

    return () => {
      cancelled = true;
      if (frame) window.cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', syncBounds);
      window.removeEventListener('scroll', syncBounds, true);
      void window.lionclaw.openDesign.hideView();
    };
  }, [bootstrap.webUrl]);

  const handleLockAndContinue = async (): Promise<void> => {
    if (locking) return;
    setLocking(true);
    setError(null);
    useOpenDesignStore.getState().closeStudio();
    usePipelineStore.getState()._setProjectState(projectId, { openDesignLockRejection: null });
    try {
      const result = await window.lionclaw.pipeline.approve(projectId, {
        action: 'lock-and-continue',
      });
      if (result && typeof result === 'object' && 'error' in result && result.error) {
        setError(typeof result.error === 'string' ? result.error : String(result.error));
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLocking(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 bg-zinc-950">
      {/* Header LionClaw (renderizado pelo LionClaw, NAO pelo OD). */}
      <div className="h-10 shrink-0 flex items-center gap-3 px-4 border-b border-zinc-800 bg-zinc-950/90">
        <div className="text-xs text-zinc-400 truncate">
          Sessao LionDesign <span className="font-mono text-zinc-600">/ {bootstrap.openDesignProjectId}</span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          disabled={locking}
          onClick={() => void handleLockAndContinue()}
          title="Travar design, validar e avancar para a fase 7 (PRD Completo)"
          aria-label="Travar Design e Continuar"
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-zinc-100 border border-amber-700 rounded-md bg-amber-600 hover:bg-amber-500 transition-colors disabled:opacity-50 disabled:cursor-wait"
        >
          {locking ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />}
          {locking ? 'Travando...' : 'Travar Design e Continuar'}
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-4 py-2 bg-red-950/60 border-b border-red-800/50">
          <AlertTriangle size={13} className="text-red-400 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-[11px] font-semibold text-red-300 mb-0.5">Erro.</p>
            <p className="text-[11px] text-red-200 break-words">{error}</p>
          </div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-[11px] text-red-300 hover:text-red-100 underline"
          >
            Fechar
          </button>
        </div>
      )}

      {lockRejection && (
        <div className="flex items-start gap-2 px-4 py-3 bg-amber-950/60 border-b border-amber-800/50">
          <AlertTriangle size={14} className="text-amber-300 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-amber-200 mb-1">
              Design Lock recusado ({lockRejection.problemCount} pendencia{lockRejection.problemCount === 1 ? '' : 's'}).
            </p>
            <ul className="text-[11px] text-amber-100 space-y-1.5 mb-2">
              {lockRejection.problems.map((p, i) => (
                <li key={i} className="leading-snug">
                  <span className="font-mono text-amber-300">Regra {p.rule}:</span> {p.hint}
                </li>
              ))}
            </ul>
            <p className="text-[10px] text-amber-300/70">
              O LionClaw pode direcionar o agente do LionDesign para corrigir o
              contract e tentar travar novamente. Relatorio completo:{' '}
              <span className="font-mono break-all">{lockRejection.lockReportPath}</span>
            </p>
            <button
              type="button"
              disabled={locking}
              onClick={() => void handleLockAndContinue()}
              className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-amber-50 border border-amber-600/70 rounded-md bg-amber-600/30 hover:bg-amber-600/45 transition-colors disabled:opacity-50 disabled:cursor-wait"
            >
              {locking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {locking ? 'Corrigindo...' : 'Corrigir automaticamente'}
            </button>
          </div>
          <button
            type="button"
            onClick={() =>
              usePipelineStore.getState()._setProjectState(projectId, { openDesignLockRejection: null })
            }
            className="text-[11px] text-amber-200 hover:text-amber-50 underline shrink-0"
          >
            Fechar
          </button>
        </div>
      )}

      {/*
        Placeholder DOM real. O WebContentsView do main eh posicionado por
        cima desta div via `setViewBounds`. A div em si fica vazia — o conteudo
        visual vem do processo separado.
      */}
      <div
        ref={placeholderRef}
        className="flex-1 w-full bg-zinc-900"
        aria-label="LionDesign Studio"
      />
    </div>
  );
}
