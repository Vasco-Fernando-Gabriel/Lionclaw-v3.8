import { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, X, Wrench } from 'lucide-react';
import type { CodexWindowsHealthWarning, CodexWindowsPrepSkipped, CodexPatchFailureWarning } from '@/types';

interface BannerState {
  type: 'health' | 'prep-skipped' | 'patch-failure';
  payload: CodexWindowsHealthWarning | CodexWindowsPrepSkipped | CodexPatchFailureWarning;
  dismissed: boolean;
}

export function CodexWindowsHealthBanner({
  onOpenHealthCheck,
}: {
  onOpenHealthCheck?: (payload: CodexWindowsHealthWarning) => void;
}) {
  const [state, setState] = useState<BannerState | null>(null);

  useEffect(() => {
    const unsubHealth = window.lionclaw.codex.onWindowsHealthWarning((payload) => {
      setState({ type: 'health', payload, dismissed: false });
    });
    const unsubPrepSkipped = window.lionclaw.codex.onWindowsPrepSkipped((payload) => {
      setState({ type: 'prep-skipped', payload, dismissed: false });
    });
    const unsubPatchFailure = window.lionclaw.codex.onPatchFailureWarning((payload) => {
      setState({ type: 'patch-failure', payload, dismissed: false });
    });
    return () => {
      unsubHealth();
      unsubPrepSkipped();
      unsubPatchFailure();
    };
  }, []);

  const handleDismiss = useCallback(() => {
    setState((prev) => (prev ? { ...prev, dismissed: true } : prev));
  }, []);

  if (!state || state.dismissed) return null;

  if (state.type === 'health') {
    const payload = state.payload as CodexWindowsHealthWarning;
    return (
      <div className="bg-amber-900/30 border-l-4 border-amber-500 px-4 py-3 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-amber-200 mb-1">Codex Windows Health Check</div>
          <ul className="text-sm text-amber-100/80 space-y-1">
            {payload.issues.map((issue) => (
              <li key={issue.type}>
                <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-amber-950/50 mr-2">
                  {issue.severity.toUpperCase()}
                </span>
                {issue.message}
                <div className="text-xs text-amber-200/60 ml-1 mt-0.5">{issue.hint}</div>
              </li>
            ))}
          </ul>
          {onOpenHealthCheck && (
            <button
              type="button"
              onClick={() => onOpenHealthCheck(payload)}
              className="mt-2 inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-amber-700 hover:bg-amber-600 text-white transition-colors"
            >
              <Wrench className="w-3 h-3" />
              Preparar projeto
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-amber-300/60 hover:text-amber-200 flex-shrink-0"
          aria-label="Dispensar"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  if (state.type === 'prep-skipped') {
    const payload = state.payload as CodexWindowsPrepSkipped;
    return (
      <div className="bg-orange-900/30 border-l-4 border-orange-500 px-4 py-3 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-orange-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-orange-200 mb-1">Codex auto-prep pulado</div>
          <div className="text-sm text-orange-100/80">
            Razao: <span className="font-mono">{payload.reason}</span>
          </div>
          <div className="text-xs text-orange-200/60 mt-1">
            {payload.reason === 'dirty-tree'
              ? 'Working tree tem mudancas nao commitadas. Commite ou stash antes pro auto-prep funcionar.'
              : payload.reason === 'has-submodules'
                ? 'Repo tem submodules — auto-prep nao roda por seguranca.'
                : 'Veja o log pra detalhes.'}
          </div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-orange-300/60 hover:text-orange-200 flex-shrink-0"
          aria-label="Dispensar"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  if (state.type === 'patch-failure') {
    const payload = state.payload as CodexPatchFailureWarning;
    return (
      <div className="bg-red-900/30 border-l-4 border-red-500 px-4 py-3 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-red-200 mb-1">Codex apply_patch falhou {payload.count}x</div>
          <div className="text-sm text-red-100/80">
            Provavel mojibake (encoding) ou CRLF mismatch. Veja Health Check pra preparar projeto.
          </div>
          <div className="text-xs text-red-200/60 mt-1 font-mono">agent: {payload.agentId}</div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-red-300/60 hover:text-red-200 flex-shrink-0"
          aria-label="Dispensar"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return null;
}
