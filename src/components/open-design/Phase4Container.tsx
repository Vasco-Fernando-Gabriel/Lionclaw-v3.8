import { useEffect, useState, useCallback } from 'react';
import { Loader2, AlertTriangle, RefreshCw, Play } from 'lucide-react';
import type {
  BootInstallStatus,
  BootstrapResult,
  OpenDesignBootstrapProgressEvent,
  OpenDesignSessionConfig,
} from '@/types/open-design';
import { usePipelineStore } from '@/stores/pipeline-store';
import { SessionConfigView } from './SessionConfigView';
import { BootstrappingView } from './BootstrappingView';
import { StudioView } from './StudioView';
import { resolvePhase4StartAction } from './phase4-start-gate';

interface Phase4ContainerProps {
  projectId: string;
}

type BootstrapState = 'idle' | 'running' | 'done' | 'error';

export function Phase4Container({ projectId }: Phase4ContainerProps) {
  const openProject = usePipelineStore((s) => s.openProject);
  const currentPhase = usePipelineStore((s) => s.projectStates.get(projectId)?.currentPhase ?? null);
  const [bootInstallStatus, setBootInstallStatus] = useState<BootInstallStatus | null>(null);
  const [sessionConfig, setSessionConfig] = useState<OpenDesignSessionConfig | null>(null);
  const [bootstrapState, setBootstrapState] = useState<BootstrapState>('idle');
  const [bootstrapResult, setBootstrapResult] = useState<BootstrapResult | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapEvents, setBootstrapEvents] = useState<OpenDesignBootstrapProgressEvent[]>([]);
  const [phaseReady, setPhaseReady] = useState(false);
  const [driveEngaged, setDriveEngaged] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [startStatusLoaded, setStartStatusLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPhaseReady(false);
    void openProject(projectId).finally(() => {
      if (!cancelled) setPhaseReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [openProject, projectId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await window.lionclaw.openDesign.bootInstallStatus();
        if (!cancelled) setBootInstallStatus(status);
      } catch {}
    })();
    const unsubscribe = window.lionclaw.openDesign.onBootInstallStream(() => {
      void (async () => {
        try {
          const s = await window.lionclaw.openDesign.bootInstallStatus();
          if (!cancelled) setBootInstallStatus(s);
        } catch {}
      })();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await window.lionclaw.openDesign.getSessionConfig(projectId);
        if (!cancelled) setSessionConfig(cfg);
      } catch {
        if (!cancelled) setSessionConfig(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const refreshStartStatus = useCallback(async () => {
    try {
      const status = await window.lionclaw.openDesign.getStartStatus(projectId);
      setDriveEngaged(status.driveEngaged);
      setStartPending(status.startPending);
    } catch {
      setDriveEngaged(false);
      setStartPending(false);
    } finally {
      setStartStatusLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    setStartStatusLoaded(false);
    void refreshStartStatus();
  }, [refreshStartStatus]);

  useEffect(() => {
    const unsubscribe = window.lionclaw.openDesign.onBootstrapProgress((event) => {
      if (event.projectId !== projectId) return;
      setBootstrapEvents((current) => [...current.slice(-80), event]);
      void refreshStartStatus();
    });
    return unsubscribe;
  }, [projectId, refreshStartStatus]);

  const triggerEnsureSession = useCallback(async () => {
    setBootstrapState('running');
    setBootstrapError(null);
    setBootstrapResult(null);
    setBootstrapEvents([]);
    try {
      const result = await window.lionclaw.openDesign.ensureSession(projectId);
      if ('error' in result) {
        setBootstrapError(result.error);
        setBootstrapState('error');
        return;
      }
      setBootstrapResult(result);
      setBootstrapState('done');
    } catch (err) {
      setBootstrapError(err instanceof Error ? err.message : String(err));
      setBootstrapState('error');
    }
  }, [projectId]);

  const startAction =
    phaseReady && currentPhase === 5
      ? resolvePhase4StartAction({
          driveEngaged,
          startPending,
          startStatusLoaded,
          bootInstallReady: bootInstallStatus?.kind === 'ready',
          sessionConfigPresent: sessionConfig !== null,
          bootstrapIdle: bootstrapState === 'idle',
        })
      : 'wait';

  useEffect(() => {
    if (startAction === 'auto-ensure') {
      void triggerEnsureSession();
    }
  }, [startAction, triggerEnsureSession]);

  const handleSessionSaved = useCallback((cfg: OpenDesignSessionConfig) => {
    setSessionConfig(cfg);
    setBootstrapResult(null);
    setBootstrapError(null);
    setBootstrapState('idle');
  }, []);

  const handleRetryInstall = useCallback(async () => {
    try {
      const s = await window.lionclaw.openDesign.bootInstallRetry();
      setBootInstallStatus(s);
    } catch (err) {
      try {
        const s = await window.lionclaw.openDesign.bootInstallStatus();
        setBootInstallStatus(s);
      } catch {}
    }
  }, []);

  if (!phaseReady || bootInstallStatus === null) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 text-zinc-500">
        <Loader2 size={20} className="animate-spin" />
        <span className="text-xs mt-2">Verificando motor de design...</span>
      </div>
    );
  }

  if (currentPhase !== 5) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 px-6">
        <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900/60 p-5 text-center">
          <AlertTriangle size={24} className="mx-auto text-amber-400" />
          <h2 className="mt-3 text-sm font-medium text-zinc-100">LionDesign fora da fase atual</h2>
          <p className="mt-2 text-xs leading-5 text-zinc-400">
            Este projeto nao esta mais na fase 5. Volte ao pipeline para aprovar ou revisar a fase atual.
          </p>
        </div>
      </div>
    );
  }

  if (bootInstallStatus.kind === 'installing' || bootInstallStatus.kind === 'idle') {
    return (
      <div className="flex flex-col items-center justify-center flex-1 px-6">
        <div className="w-full max-w-md flex flex-col items-center gap-3 text-zinc-300">
          <Loader2 size={28} className="animate-spin text-amber-400" />
          <h2 className="text-sm font-medium">Preparando LionDesign (primeira execucao)</h2>
          <p className="text-[11px] text-zinc-500 text-center">
            O motor de design esta sendo instalado em background. Voce pode acompanhar o progresso na sidebar; esta tela
            continua quando estiver pronto.
          </p>
        </div>
      </div>
    );
  }

  if (bootInstallStatus.kind === 'failed') {
    return (
      <div className="flex flex-col items-center justify-center flex-1 px-6">
        <div className="w-full max-w-md flex flex-col items-center gap-3 text-zinc-300">
          <AlertTriangle size={28} className="text-red-400" />
          <h2 className="text-sm font-medium">Falha ao preparar motor de design</h2>
          <pre className="text-[10px] text-zinc-400 bg-zinc-900 border border-zinc-800 rounded-lg p-3 w-full whitespace-pre-wrap font-mono">
            {bootInstallStatus.error}
          </pre>
          <button
            onClick={() => void handleRetryInstall()}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-zinc-200 bg-zinc-800 border border-zinc-700 hover:border-zinc-600 rounded-lg transition-colors"
          >
            <RefreshCw size={12} />
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }

  if (sessionConfig === null) {
    return <SessionConfigView projectId={projectId} onSaved={handleSessionSaved} />;
  }

  if (startAction === 'show-cta') {
    return (
      <div className="flex flex-col items-center justify-center flex-1 px-6">
        <div className="w-full max-w-md flex flex-col items-center gap-4 text-zinc-300">
          <h2 className="text-sm font-medium">Sessao de design pronta para iniciar</h2>
          <p className="text-[11px] text-zinc-500 text-center leading-5">
            O orquestrador esta dirigindo este pipeline. Inicie a sessao de design quando quiser; o orquestrador tambem
            pode dar o GO e a tela avanca sozinha.
          </p>
          <button
            onClick={() => void triggerEnsureSession()}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-zinc-100 bg-amber-600/80 border border-amber-500 hover:bg-amber-600 rounded-lg transition-colors"
          >
            <Play size={12} />
            Iniciar sessao de design
          </button>
        </div>
      </div>
    );
  }

  if (bootstrapState === 'running' || bootstrapState === 'idle') {
    return <BootstrappingView error={null} events={bootstrapEvents} />;
  }

  if (bootstrapState === 'error' || bootstrapResult === null) {
    return (
      <div className="flex flex-col flex-1">
        <BootstrappingView error={bootstrapError ?? 'erro desconhecido'} events={bootstrapEvents} />
        <div className="shrink-0 flex justify-center border-t border-zinc-800 bg-zinc-950 px-4 py-3">
          <button
            onClick={() => void triggerEnsureSession()}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-zinc-200 bg-zinc-800 border border-zinc-700 hover:border-zinc-600 rounded-lg transition-colors"
          >
            <RefreshCw size={12} />
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }

  return <StudioView bootstrap={bootstrapResult} projectId={projectId} />;
}
