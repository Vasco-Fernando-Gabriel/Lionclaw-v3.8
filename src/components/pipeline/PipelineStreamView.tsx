import { useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle, RefreshCw, XCircle } from 'lucide-react';
import { usePipelineStore } from '@/stores/pipeline-store';
import { useActiveProjectState } from '@/hooks/useActiveProjectState';
import { StreamTimeline } from '@/components/common/StreamTimeline';

const STREAM_TAIL_CHARS = 40_000;

interface AutoTransitionBannerProps {
  nextPhaseName: string;
}

function AutoTransitionBanner({ nextPhaseName }: AutoTransitionBannerProps) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const duration = 2000;
    const tick = setInterval(() => {
      const elapsed = Date.now() - start;
      const pct = Math.min(100, (elapsed / duration) * 100);
      setProgress(pct);
      if (pct >= 100) clearInterval(tick);
    }, 30);
    return () => clearInterval(tick);
  }, []);

  return (
    <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-900 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <CheckCircle2 size={13} className="text-green-400 shrink-0" />
        <span className="text-xs text-zinc-300">
          Concluido. Avancando para <span className="text-amber-300 font-medium">{nextPhaseName}</span>...
        </span>
      </div>
      {/* Progress bar */}
      <div className="h-1 bg-zinc-800 rounded overflow-hidden">
        <div className="h-1 bg-amber-500 rounded transition-all duration-75" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

interface ErrorBannerProps {
  errorMessage: string;
  retryCount: number;
  maxRetries: number;
  onRetry: () => void;
  onAbort: () => void;
}

function ErrorBanner({ errorMessage, retryCount, maxRetries, onRetry, onAbort }: ErrorBannerProps) {
  const retryExhausted = retryCount >= maxRetries;

  return (
    <div
      className="mt-3 rounded-lg border p-3 space-y-2"
      style={{
        background: 'rgba(239, 68, 68, 0.08)',
        borderColor: '#ef4444',
      }}
    >
      <div className="flex items-start gap-2">
        <AlertCircle size={13} className="text-red-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-red-400">
            {retryExhausted ? 'Pipeline pausado - limite de tentativas atingido' : 'Erro na fase'}
          </p>
          <p className="text-[11px] text-red-300/80 mt-0.5 break-words">{errorMessage}</p>
          {retryCount > 0 && (
            <p className="text-[10px] text-zinc-500 mt-1">
              Tentativa {retryCount}/{maxRetries}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {retryExhausted ? (
          <>
            <button
              onClick={onRetry}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-lg transition-colors"
            >
              <RefreshCw size={11} />
              Retry manual
            </button>
            <button
              onClick={onAbort}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 rounded-lg transition-colors"
            >
              <XCircle size={11} />
              Abortar
            </button>
          </>
        ) : (
          <button
            onClick={onRetry}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors"
          >
            <RefreshCw size={11} />
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

function PhaseRunningBadge({ phaseName }: { phaseName: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
      </span>
      <span className="text-[11px] text-amber-300 font-medium">{phaseName}</span>
      <Loader2 size={11} className="text-amber-400 animate-spin" />
    </div>
  );
}

interface PipelineStreamViewProps {
  phaseName: string;
  nextPhaseName?: string;
}

const MAX_RETRIES = 3;

export function PipelineStreamView({ phaseName, nextPhaseName }: PipelineStreamViewProps) {
  const streamTimeline = useActiveProjectState((s) => s.streamTimeline) ?? [];
  const isStreaming = useActiveProjectState((s) => s.isStreaming) ?? false;
  const error = useActiveProjectState((s) => s.error) ?? null;
  const retryPhase = usePipelineStore((s) => s.retryPhase);
  const abortPipeline = usePipelineStore((s) => s.abortPipeline);

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);
  const scrollRafRef = useRef<number | null>(null);

  const [retryCount, setRetryCount] = useState(0);
  const [showTransition, setShowTransition] = useState(false);

  useEffect(() => {
    setRetryCount(0);
  }, [phaseName]);

  useEffect(() => {
    if (!followTailRef.current || scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    });
  }, [streamTimeline]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  const prevIsStreaming = useRef(isStreaming);
  useEffect(() => {
    const wasStreaming = prevIsStreaming.current;
    prevIsStreaming.current = isStreaming;

    if (wasStreaming && !isStreaming && streamTimeline.length > 0 && !error) {
      setShowTransition(true);
      const timer = setTimeout(() => setShowTransition(false), 2500);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, streamTimeline.length, error]);

  useEffect(() => {
    if (error) setShowTransition(false);
  }, [error]);

  const handleRetry = () => {
    setRetryCount((c) => c + 1);
    void retryPhase();
  };

  const handleAbort = () => {
    void abortPipeline();
  };

  const hasContent = streamTimeline.length > 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Stream da fase</span>
        {isStreaming ? (
          <PhaseRunningBadge phaseName={phaseName} />
        ) : (
          <span className="text-[11px] text-zinc-600 font-medium">{phaseName}</span>
        )}
      </div>

      {/* Stream content area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3 min-h-0"
        onScroll={() => {
          const element = scrollRef.current;
          if (!element) return;
          followTailRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
        }}
      >
        {!hasContent && !error && (
          <p className="text-xs text-zinc-600 italic mt-4 text-center">
            {isStreaming ? 'Aguardando saida do agente...' : 'Nenhum conteudo ainda.'}
          </p>
        )}

        <StreamTimeline
          blocks={streamTimeline}
          className="space-y-2"
          renderText={(block) => (
            <pre className="font-mono text-xs text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">
              {block.status === 'streaming' && block.content.length > STREAM_TAIL_CHARS
                ? `… ${Math.round((block.content.length - STREAM_TAIL_CHARS) / 1024)} KB anteriores ocultos durante o streaming …\n${block.content.slice(-STREAM_TAIL_CHARS)}`
                : block.content}
              {block.status === 'streaming' && <span className="pipeline-stream-cursor" />}
            </pre>
          )}
        />

        {/* Auto-transition banner */}
        {showTransition && nextPhaseName && <AutoTransitionBanner nextPhaseName={nextPhaseName} />}

        {/* Error banner with retry */}
        {error && (
          <ErrorBanner
            errorMessage={error}
            retryCount={retryCount}
            maxRetries={MAX_RETRIES}
            onRetry={handleRetry}
            onAbort={handleAbort}
          />
        )}

        <div ref={bottomRef} />
      </div>

      <style>{`
        .pipeline-stream-cursor {
          display: inline-block;
          width: 6px;
          height: 0.9em;
          background: rgba(167, 139, 250, 0.8);
          margin-left: 2px;
          vertical-align: text-bottom;
          border-radius: 1px;
          animation: pipeline-stream-blink 1s step-end infinite;
        }
        @keyframes pipeline-stream-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
