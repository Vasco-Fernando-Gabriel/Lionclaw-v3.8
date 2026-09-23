import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { handoffToOrchestrator, type HandoffRequest, type HandoffDeps } from '../../lib/handoff-to-orchestrator';
import { useChatStore } from '../../stores/chat-store';
import { useRepoGraphStore } from '../../stores/repo-graph-store';
import { useAppStore } from '../../stores/app-store';

interface HandoffButtonProps {
  request: HandoffRequest;
  beforeHandoff?: () => Promise<{ ok: true } | { error: string }>;
  labelIdle?: string;
  'data-testid'?: string;
}

const DEFAULT_LABEL = 'Continuar no orquestrador';
const TOOLTIP = 'Garante a conversa, vincula o projeto e abre o chat com o Lion';

export function HandoffButton({ request, beforeHandoff, labelIdle, 'data-testid': dataTestId }: HandoffButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = labelIdle ?? DEFAULT_LABEL;

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (loading) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const deps: HandoffDeps = {
          ensureSession: (preferredSessionId) => window.lionclaw.chat.ensureSession(preferredSessionId),
          selectSession: (sessionId) => useChatStore.getState().selectSession(sessionId),
          addRepository: (path) => useRepoGraphStore.getState().addRepository(path),
          attachSession: (sessionId, repoId) => useRepoGraphStore.getState().attachSession(sessionId, repoId),
          build: (repoId, sessionId) => useRepoGraphStore.getState().build(repoId, sessionId),
          update: (repoId, sessionId) => useRepoGraphStore.getState().update(repoId, sessionId),
          setPendingChat: (message, agentId, handoff) =>
            useAppStore.getState().setPendingChat(message, agentId, handoff),
          setPage: (page) => useAppStore.getState().setPage(page),
          currentSessionId: () => useChatStore.getState().currentSessionId,
        };
        const result = await handoffToOrchestrator(request, beforeHandoff, deps);
        if ('error' in result) {
          setError(result.error);
          setLoading(false);
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
  };

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        title={TOOLTIP}
        className="flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/15 disabled:opacity-40"
        data-testid={dataTestId}
      >
        {loading ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
        {label}
      </button>
      {error && (
        <span className="text-[10px] text-red-300" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
