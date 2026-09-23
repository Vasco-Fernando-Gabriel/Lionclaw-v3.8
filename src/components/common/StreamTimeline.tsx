import { memo, type ReactNode, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Loader2, OctagonX, Wrench } from 'lucide-react';
import type { StreamTimelineBlock, StreamTimelineToolBlock } from '@/types';

const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|api[-_]?key/i;

function sanitized(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[resumo]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitized(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      out[key] = SECRET_KEY.test(key) ? '[redigido]' : sanitized(child, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value
      .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[redigido]')
      .replace(/((?:api[-_]?key|token|secret|password|passwd)\s*[:=]\s*)[^\s,;&]+/gi, '$1[redigido]')
      .replace(/\/Users\/[^/\s]+/g, '~/')
      .replace(/\/home\/[^/\s]+/g, '~/')
      .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, '~')
      .slice(0, 4_000);
  }
  return value;
}

function displayValue(value: unknown, short = false): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (typeof value === 'string') text = String(sanitized(value));
  else {
    try {
      text = JSON.stringify(sanitized(value), null, short ? 0 : 2);
    } catch {
      text = String(value);
    }
  }
  const limit = short ? 120 : 4_000;
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

const TimelineToolRow = memo(function TimelineToolRow({ block }: { block: StreamTimelineToolBlock }) {
  const [expanded, setExpanded] = useState(false);
  const status = block.status;
  const statusLabel =
    status === 'running'
      ? 'executando'
      : status === 'done'
        ? 'concluído'
        : status === 'error'
          ? 'falhou'
          : status === 'incomplete'
            ? 'incompleto'
            : 'interrompido';
  const icon =
    status === 'running' ? (
      <Loader2 size={12} className="animate-spin text-amber-400" />
    ) : status === 'done' ? (
      <CheckCircle2 size={12} className="text-emerald-500" />
    ) : status === 'error' ? (
      <OctagonX size={12} className="text-red-500" />
    ) : (
      <AlertCircle size={12} className="text-zinc-500" />
    );
  const shortInput = displayValue(block.input, true);

  return (
    <div className="py-0.5" data-timeline-kind="tool" data-tool-status={status}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        {expanded ? (
          <ChevronDown size={10} className="shrink-0 text-zinc-600" />
        ) : (
          <ChevronRight size={10} className="shrink-0 text-zinc-600" />
        )}
        {icon}
        <Wrench size={10} className="shrink-0 text-amber-500" />
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-400">{block.tool}</span>
        {!expanded && shortInput && (
          <span className="max-w-[360px] truncate font-mono text-[10px] text-zinc-600">{shortInput}</span>
        )}
        <span className={`ml-auto shrink-0 text-[10px] ${status === 'error' ? 'text-red-400' : 'text-zinc-600'}`}>
          {statusLabel}
          {block.durationMs != null && block.durationMs > 0 ? ` · ${block.durationMs}ms` : ''}
        </span>
      </button>
      {expanded && (
        <div className="ml-4 mt-1 space-y-2 rounded border border-zinc-800 bg-zinc-950/80 p-2">
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-600">Input</p>
            <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-zinc-300">
              {displayValue(block.input) || '(vazio)'}
            </pre>
          </div>
          {block.result !== undefined && (
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-600">Resultado</p>
              <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-zinc-400">
                {displayValue(block.result) || '(vazio)'}
              </pre>
            </div>
          )}
          {block.correlation === 'unmatched' && (
            <p className="text-[10px] text-amber-500">Resultado sem correlação segura com a chamada original.</p>
          )}
        </div>
      )}
    </div>
  );
});

type TimelineTextBlock = Extract<StreamTimelineBlock, { kind: 'text' }>;

const TimelineTextRow = memo(
  function TimelineTextRow({
    block,
    renderText,
  }: {
    block: TimelineTextBlock;
    renderText?: (block: TimelineTextBlock) => ReactNode;
  }) {
    return (
      <div data-timeline-kind="text">
        {renderText ? (
          renderText(block)
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-zinc-200">
            {block.content}
          </pre>
        )}
      </div>
    );
  },
  (previous, next) =>
    previous.block.id === next.block.id &&
    previous.block.sequence === next.block.sequence &&
    previous.block.content === next.block.content &&
    previous.block.status === next.block.status &&
    previous.renderText === next.renderText,
);

interface StreamTimelineProps {
  blocks: readonly StreamTimelineBlock[];
  renderText?: (block: Extract<StreamTimelineBlock, { kind: 'text' }>) => ReactNode;
  className?: string;
  toolGroupLimit?: number;
}

interface RenderEntry {
  key: string;
  kind: 'block' | 'group';
  block?: StreamTimelineBlock;
  tools?: StreamTimelineToolBlock[];
}

function makeRenderEntries(blocks: readonly StreamTimelineBlock[], limit: number): RenderEntry[] {
  const entries: RenderEntry[] = [];
  let cursor = 0;
  while (cursor < blocks.length) {
    if (blocks[cursor].kind !== 'tool') {
      const block = blocks[cursor];
      entries.push({ key: block.id, kind: 'block', block });
      cursor += 1;
      continue;
    }
    const run: StreamTimelineToolBlock[] = [];
    while (cursor < blocks.length && blocks[cursor].kind === 'tool') {
      run.push(blocks[cursor] as StreamTimelineToolBlock);
      cursor += 1;
    }
    if (run.length <= limit) {
      entries.push(...run.map((block) => ({ key: block.id, kind: 'block' as const, block })));
      continue;
    }
    const latestIds = new Set(run.slice(-3).map((tool) => tool.id));
    const grouped = run.filter((tool) => tool.status === 'done' && !latestIds.has(tool.id));
    const groupedIds = new Set(grouped.map((tool) => tool.id));
    let inserted = false;
    for (const tool of run) {
      if (groupedIds.has(tool.id)) {
        if (!inserted) {
          entries.push({ key: `group-${grouped[0].id}`, kind: 'group', tools: grouped });
          inserted = true;
        }
      } else {
        entries.push({ key: tool.id, kind: 'block', block: tool });
      }
    }
  }
  return entries;
}

function ToolGroup({ tools }: { tools: StreamTimelineToolBlock[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-1.5 text-left text-[10px] text-zinc-500 hover:text-zinc-300"
      >
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <CheckCircle2 size={11} className="text-emerald-600" />
        {tools.length} ferramentas anteriores concluídas
        <span className="ml-auto">{expanded ? 'recolher' : 'expandir'}</span>
      </button>
      {expanded && (
        <div className="ml-3 border-l border-zinc-800 pl-2">
          {tools.map((tool) => (
            <TimelineToolRow key={tool.id} block={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

export function StreamTimeline({ blocks, renderText, className = '', toolGroupLimit = 8 }: StreamTimelineProps) {
  const entries = useMemo(() => makeRenderEntries(blocks, toolGroupLimit), [blocks, toolGroupLimit]);
  return (
    <div className={className} data-testid="stream-timeline">
      {entries.map((entry) => {
        if (entry.kind === 'group') return <ToolGroup key={entry.key} tools={entry.tools ?? []} />;
        const block = entry.block;
        if (!block) return null;
        if (block.kind === 'tool') return <TimelineToolRow key={block.id} block={block} />;
        return <TimelineTextRow key={block.id} block={block} renderText={renderText} />;
      })}
    </div>
  );
}
