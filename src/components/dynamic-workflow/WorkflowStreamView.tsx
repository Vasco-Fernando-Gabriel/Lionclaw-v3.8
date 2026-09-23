import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react';
import type { DynamicWorkflowNodeStatus, StreamTimelineBlock } from '@/types';
import { StreamTimeline } from '@/components/common/StreamTimeline';

export interface WorkflowNodeStreamToolCall {
  toolName: string;
  detail?: string;
}

export interface WorkflowNodeStreamState {
  nodeId: string;
  label: string;
  status: DynamicWorkflowNodeStatus;
  text: string;
  toolCalls: WorkflowNodeStreamToolCall[];
  timeline: StreamTimelineBlock[];
  isStreaming: boolean;
}

function NodeStatusBadge({ status, isStreaming }: { status: DynamicWorkflowNodeStatus; isStreaming: boolean }) {
  if (isStreaming || status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-amber-400">
        <Loader2 size={11} className="animate-spin" />
        rodando
      </span>
    );
  }
  if (status === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-green-400">
        <CheckCircle2 size={11} />
        ok
      </span>
    );
  }
  if (status === 'failed' || status === 'blocked' || status === 'cancelled') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-red-400">
        <XCircle size={11} />
        {status === 'blocked' ? 'bloqueado' : 'falhou'}
      </span>
    );
  }
  if (status === 'interrupted') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-amber-300">
        <Clock size={11} />
        interrompido
      </span>
    );
  }
  return <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500">pendente</span>;
}

function StreamBody({ node }: { node: WorkflowNodeStreamState }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);
  const scrollRafRef = useRef<number | null>(null);
  const [debouncedTimeline, setDebouncedTimeline] = useState(node.timeline);

  useEffect(() => {
    const last = node.timeline.at(-1);
    if (last?.kind === 'tool') {
      setDebouncedTimeline(node.timeline);
      return;
    }
    const t = setTimeout(() => setDebouncedTimeline(node.timeline), 80);
    return () => clearTimeout(t);
  }, [node.timeline]);

  useEffect(() => {
    if (!followTailRef.current || scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    });
  }, [debouncedTimeline]);

  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    },
    [],
  );

  const hasContent = debouncedTimeline.length > 0;

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto px-3 py-2 min-h-0"
      onScroll={() => {
        const element = scrollRef.current;
        if (!element) return;
        followTailRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
      }}
    >
      <StreamTimeline
        blocks={debouncedTimeline}
        className="space-y-1"
        renderText={(block) => (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-300">
            {block.content}
          </pre>
        )}
      />
      {!hasContent && (
        <p className="text-[11px] text-zinc-600 italic">
          {node.isStreaming ? 'aguardando output...' : 'sem output capturado'}
        </p>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function NodeStreamCard({ node }: { node: WorkflowNodeStreamState }) {
  return (
    <div className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/40 min-h-0 h-full overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-1.5 shrink-0">
        {/* SM-15: nome do agente na fonte de escrita (sans), nao mono. */}
        <span className="truncate text-[11px] text-zinc-300">{node.label}</span>
        <NodeStatusBadge status={node.status} isStreaming={node.isStreaming} />
      </div>
      <StreamBody node={node} />
    </div>
  );
}

export interface WorkflowStreamViewProps {
  nodes: WorkflowNodeStreamState[];
  parallelGroupNodeIds?: string[];
  pendingNodeIds?: string[];
}

function PendingNodePlaceholder({ nodeId }: { nodeId: string | null }) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-2 text-[11px] text-zinc-500"
      data-testid="stream-pending-placeholder"
    >
      <Loader2 size={18} className="animate-spin text-amber-400" />
      <span>
        {nodeId ? (
          <>
            aguardando o agente <span className="font-mono text-zinc-300">{nodeId}</span>...
          </>
        ) : (
          'aguardando o agente...'
        )}
      </span>
      <span className="text-[10px] text-zinc-600">O output aparece aqui assim que o node comecar a emitir.</span>
    </div>
  );
}

export function selectStreamLayout(
  nodes: WorkflowNodeStreamState[],
  parallelGroupNodeIds: string[],
): { mode: 'parallel'; nodes: WorkflowNodeStreamState[] } | { mode: 'single'; node: WorkflowNodeStreamState | null } {
  const groupSet = new Set(parallelGroupNodeIds);
  const groupNodes = nodes.filter((n) => groupSet.has(n.nodeId));
  if (groupNodes.length >= 2) {
    return { mode: 'parallel', nodes: groupNodes };
  }
  const streaming = nodes.filter((n) => n.isStreaming);
  const active = streaming.length > 0 ? streaming[streaming.length - 1] : (nodes[nodes.length - 1] ?? null);
  return { mode: 'single', node: active };
}

export function WorkflowStreamView({ nodes, parallelGroupNodeIds = [], pendingNodeIds = [] }: WorkflowStreamViewProps) {
  const layout = useMemo(() => selectStreamLayout(nodes, parallelGroupNodeIds), [nodes, parallelGroupNodeIds]);

  if (layout.mode === 'single' && layout.node === null) {
    if (pendingNodeIds.length > 0) {
      return <PendingNodePlaceholder nodeId={pendingNodeIds[0] ?? null} />;
    }
    return (
      <div className="flex flex-1 items-center justify-center text-[11px] text-zinc-600">
        Sem stream ativo. O output dos nodes aparece aqui durante a execucao.
      </div>
    );
  }

  if (layout.mode === 'parallel') {
    const cols = Math.min(layout.nodes.length, 3);
    return (
      <div className="flex flex-1 flex-col min-h-0 p-2">
        <div className="mb-1.5 flex items-center gap-1.5 px-1 shrink-0">
          <span className="text-[9px] uppercase tracking-wider text-zinc-600 font-medium">Grupo paralelo</span>
          <span className="text-[10px] text-zinc-500">{layout.nodes.length} agentes</span>
        </div>
        <div className="grid flex-1 gap-2 min-h-0" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {layout.nodes.map((node) => (
            <NodeStreamCard key={node.nodeId} node={node} />
          ))}
        </div>
      </div>
    );
  }

  const node = layout.node;
  if (node === null) return null;
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-1.5 shrink-0">
        {/* SM-15: nome do agente na fonte de escrita (sans), nao mono. */}
        <span className="truncate text-[11px] text-zinc-300">{node.label}</span>
        <NodeStatusBadge status={node.status} isStreaming={node.isStreaming} />
      </div>
      <StreamBody node={node} />
    </div>
  );
}
