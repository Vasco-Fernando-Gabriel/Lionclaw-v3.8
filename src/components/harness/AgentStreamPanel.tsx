import { useEffect, useMemo, useRef } from 'react';
import { StreamTimeline } from '@/components/common/StreamTimeline';
import { timelineFromOrderedStream } from '@/lib/stream-timeline';

interface StreamEntry {
  type: string;
  content?: string;
  tool?: string;
  toolCallId?: string;
}

const STREAM_TAIL_CHARS = 40_000;

interface AgentStreamPanelProps {
  label: string;
  stream: StreamEntry[];
  isActive: boolean;
  tokens?: { input: number; output: number };
  cost?: number;
  duration?: number;
}

function formatCost(usd: number): string {
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toFixed(3)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, '0')}s`;
}

export function AgentStreamPanel({ label, stream, isActive, tokens, cost, duration }: AgentStreamPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);
  const scrollRafRef = useRef<number | null>(null);
  const timeline = useMemo(() => timelineFromOrderedStream(stream, label), [stream, label]);

  useEffect(() => {
    if (!followTailRef.current || scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    });
  }, [timeline]);

  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    },
    [],
  );

  const hasContent = timeline.length > 0;

  return (
    <div className="flex flex-col bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
        {isActive ? (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
        ) : (
          <span className="h-2 w-2 rounded-full bg-zinc-700 shrink-0" />
        )}
        <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wide">{label}</span>
        {isActive && <span className="ml-auto text-[10px] text-blue-400 font-mono">ativo</span>}
      </div>

      {/* Stream content */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3 space-y-1 min-h-0"
        onScroll={() => {
          const element = scrollRef.current;
          if (!element) return;
          followTailRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
        }}
      >
        {!hasContent && (
          <p className="text-xs text-zinc-600 italic">{isActive ? 'Aguardando saida...' : '(aguardando)'}</p>
        )}

        <StreamTimeline
          blocks={timeline}
          className="space-y-1"
          renderText={(block) => (
            <span
              className={`font-mono text-xs whitespace-pre-wrap break-words ${
                block.status === 'streaming' ? 'text-zinc-100' : 'text-zinc-200'
              }`}
            >
              {block.status === 'streaming' && block.content.length > STREAM_TAIL_CHARS
                ? `… ${Math.round((block.content.length - STREAM_TAIL_CHARS) / 1024)} KB anteriores ocultos durante o streaming …\n${block.content.slice(-STREAM_TAIL_CHARS)}`
                : block.content}
            </span>
          )}
        />

        <div ref={bottomRef} />
      </div>

      {/* Metrics footer */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-t border-zinc-800 bg-zinc-900/40 shrink-0">
        {tokens != null && (
          <span className="text-[10px] text-zinc-500 font-mono">
            in: {tokens.input.toLocaleString()} / out: {tokens.output.toLocaleString()}
          </span>
        )}
        {cost != null && cost > 0 && <span className="text-[10px] text-zinc-500 font-mono">{formatCost(cost)}</span>}
        {duration != null && duration > 0 && (
          <span className="text-[10px] text-zinc-500 font-mono">{formatDuration(duration)}</span>
        )}
        {!tokens && !cost && !duration && <span className="text-[10px] text-zinc-700 font-mono">sem metricas</span>}
      </div>
    </div>
  );
}
