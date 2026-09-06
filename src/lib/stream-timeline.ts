import type {
  PersistedTimelineToolCall,
  StreamTimelineBlock,
  StreamTimelineToolBlock,
} from '../types';

function nextSequence(blocks: readonly StreamTimelineBlock[]): number {
  return blocks.reduce((max, block) => Math.max(max, block.sequence), -1) + 1;
}

function nextId(blocks: readonly StreamTimelineBlock[], kind: 'text' | 'tool'): string {
  return `${kind}-${nextSequence(blocks)}`;
}

export function appendTimelineText(
  blocks: readonly StreamTimelineBlock[],
  content: string,
): StreamTimelineBlock[] {
  if (!content) return [...blocks];
  const last = blocks.at(-1);
  if (last?.kind === 'text' && last.status === 'streaming') {
    return [
      ...blocks.slice(0, -1),
      { ...last, content: last.content + content },
    ];
  }
  return [
    ...blocks,
    {
      id: nextId(blocks, 'text'),
      sequence: nextSequence(blocks),
      kind: 'text',
      content,
      status: 'streaming',
    },
  ];
}

export function appendTimelineTool(
  blocks: readonly StreamTimelineBlock[],
  input: { tool: string; input?: unknown; toolCallId?: string },
): StreamTimelineBlock[] {
  const closed = blocks.map((block) =>
    block.kind === 'text' && block.status === 'streaming'
      ? { ...block, status: 'done' as const }
      : block,
  );
  if (input.toolCallId) {
    const existingIndex = closed.findIndex(
      (block) => block.kind === 'tool' && block.toolCallId === input.toolCallId,
    );
    if (existingIndex >= 0) {
      const existing = closed[existingIndex] as StreamTimelineToolBlock;
      const next = [...closed];
      next[existingIndex] = {
        ...existing,
        tool: input.tool || existing.tool,
        input: input.input ?? existing.input,
      };
      return next;
    }
  }
  const sequence = nextSequence(closed);
  return [
    ...closed,
    {
      id: input.toolCallId ? `tool-${input.toolCallId}` : `tool-${sequence}`,
      sequence,
      kind: 'tool',
      toolCallId: input.toolCallId,
      tool: input.tool || 'Tool',
      input: input.input ?? null,
      status: 'running',
    },
  ];
}

export function applyTimelineToolResult(
  blocks: readonly StreamTimelineBlock[],
  result: {
    tool?: string;
    toolCallId?: string;
    result?: string;
    isError?: boolean;
  },
): StreamTimelineBlock[] {
  let index = result.toolCallId
    ? blocks.findIndex(
        (block) => block.kind === 'tool' && block.toolCallId === result.toolCallId,
      )
    : -1;

  if (index < 0 && !result.toolCallId && result.tool) {
    const candidates = blocks
      .map((block, candidate) => ({ block, candidate }))
      .filter(
        ({ block }) =>
          block.kind === 'tool' && block.status === 'running' && block.tool === result.tool,
      );
    if (candidates.length === 1) index = candidates[0].candidate;
  }

  if (index >= 0) {
    const tool = blocks[index] as StreamTimelineToolBlock;
    const next = [...blocks];
    next[index] = {
      ...tool,
      result: result.result,
      isError: result.isError === true,
      correlation: 'matched',
      status: result.isError ? 'error' : 'done',
    };
    return next;
  }

  const sequence = nextSequence(blocks);
  return [
    ...blocks,
    {
      id: result.toolCallId ? `tool-unmatched-${result.toolCallId}` : `tool-unmatched-${sequence}`,
      sequence,
      kind: 'tool',
      toolCallId: result.toolCallId,
      tool: result.tool || 'Tool',
      input: null,
      result: result.result,
      isError: result.isError === true,
      correlation: 'unmatched',
      status: result.isError ? 'error' : 'done',
    },
  ];
}

export function finishTimeline(
  blocks: readonly StreamTimelineBlock[],
  options: { toolWithoutResult?: 'done' | 'incomplete' | 'stopped' } = {},
): StreamTimelineBlock[] {
  const toolWithoutResult = options.toolWithoutResult ?? 'done';
  return blocks.map((block) => {
    if (block.kind === 'text' && block.status === 'streaming') {
      return { ...block, status: 'done' };
    }
    if (block.kind === 'tool' && block.status === 'running') {
      return { ...block, status: toolWithoutResult };
    }
    return block;
  });
}

export function failTimeline(blocks: readonly StreamTimelineBlock[]): StreamTimelineBlock[] {
  return blocks.map((block) => {
    if (block.kind === 'text' && block.status === 'streaming') {
      return { ...block, status: 'done' };
    }
    if (block.kind === 'tool' && block.status === 'running') {
      return { ...block, status: 'error', isError: true };
    }
    return block;
  });
}

export function replaceTimelineText(
  blocks: readonly StreamTimelineBlock[],
  content: string,
): StreamTimelineBlock[] {
  const previousContent = blocks
    .filter((block): block is Extract<StreamTimelineBlock, { kind: 'text' }> => block.kind === 'text')
    .map((block) => block.content)
    .join('');
  const tools = remapPersistedTimelineOffsets(
    previousContent,
    content,
    timelineToolsForPersistence(blocks),
  );
  return timelineFromPersisted(content, tools, `replace-${blocks[0]?.id ?? 'empty'}`);
}

export function remapPersistedTimelineOffsets(
  previousContent: string,
  nextContent: string,
  toolCalls: readonly PersistedTimelineToolCall[],
): PersistedTimelineToolCall[] {
  if (previousContent === nextContent) return toolCalls.map((tool) => ({ ...tool }));
  let prefix = 0;
  const prefixLimit = Math.min(previousContent.length, nextContent.length);
  while (prefix < prefixLimit && previousContent[prefix] === nextContent[prefix]) prefix += 1;

  let suffix = 0;
  const suffixLimit = Math.min(
    previousContent.length - prefix,
    nextContent.length - prefix,
  );
  while (
    suffix < suffixLimit &&
    previousContent[previousContent.length - 1 - suffix] ===
      nextContent[nextContent.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const previousChangedEnd = previousContent.length - suffix;
  const delta = nextContent.length - previousContent.length;
  return toolCalls.map((tool) => {
    if (!Number.isInteger(tool.textOffset) || (tool.textOffset ?? -1) < 0) return { ...tool };
    const offset = tool.textOffset ?? 0;
    const remapped = offset <= prefix
      ? offset
      : offset >= previousChangedEnd
        ? offset + delta
        : prefix;
    return { ...tool, textOffset: Math.max(0, Math.min(nextContent.length, remapped)) };
  });
}

export function timelineFromPersisted(
  content: string,
  toolCalls: readonly PersistedTimelineToolCall[] | undefined,
  idPrefix: string,
): StreamTimelineBlock[] {
  if (!toolCalls?.length) {
    return content
      ? [{ id: `${idPrefix}-text-0`, sequence: 0, kind: 'text', content, status: 'done' }]
      : [];
  }

  const hasOffsets = toolCalls.every(
    (tool) => Number.isInteger(tool.textOffset) && (tool.textOffset ?? -1) >= 0,
  );
  const sorted = toolCalls
    .map((tool, index) => ({ tool, index }))
    .sort((a, b) =>
      hasOffsets
        ? (a.tool.textOffset ?? 0) - (b.tool.textOffset ?? 0) ||
          (a.tool.sequence ?? a.index) - (b.tool.sequence ?? b.index)
        : (a.tool.sequence ?? a.index) - (b.tool.sequence ?? b.index),
    );

  const blocks: StreamTimelineBlock[] = [];
  let cursor = 0;
  let sequence = 0;
  const pushText = (text: string): void => {
    if (!text) return;
    blocks.push({
      id: `${idPrefix}-text-${sequence}`,
      sequence: sequence++,
      kind: 'text',
      content: text,
      status: 'done',
    });
  };

  for (const { tool, index } of sorted) {
    if (hasOffsets) {
      const offset = Math.max(cursor, Math.min(content.length, tool.textOffset ?? cursor));
      pushText(content.slice(cursor, offset));
      cursor = offset;
    }
    blocks.push({
      id: `${idPrefix}-tool-${tool.toolCallId ?? index}`,
      sequence: sequence++,
      kind: 'tool',
      toolCallId: tool.toolCallId,
      tool: tool.tool,
      input: tool.input,
      result: tool.result ?? tool.output,
      isError: tool.isError,
      correlation: 'matched',
      status: tool.status ?? (tool.isError ? 'error' : 'done'),
      durationMs: tool.durationMs,
      textOffset: tool.textOffset,
    });
  }
  pushText(hasOffsets ? content.slice(cursor) : content);
  return blocks;
}

export function timelineToolsForPersistence(
  blocks: readonly StreamTimelineBlock[],
): PersistedTimelineToolCall[] {
  let textOffset = 0;
  const tools: PersistedTimelineToolCall[] = [];
  for (const block of blocks) {
    if (block.kind === 'text') {
      textOffset += block.content.length;
      continue;
    }
    tools.push({
      tool: block.tool,
      input: block.input,
      result: block.result,
      isError: block.isError,
      status: block.status,
      durationMs: block.durationMs,
      sequence: block.sequence,
      textOffset,
      toolCallId: block.toolCallId,
    });
  }
  return tools;
}

export function timelineFromOrderedStream(
  entries: ReadonlyArray<{
    type: string;
    content?: string;
    tool?: string;
    toolCallId?: string;
    isError?: boolean;
  }>,
  idPrefix: string,
): StreamTimelineBlock[] {
  let blocks: StreamTimelineBlock[] = [];
  for (const entry of entries) {
    if (entry.type === 'text' || entry.type === 'thinking') {
      blocks = appendTimelineText(blocks, entry.content ?? '');
    } else if (entry.type === 'tool_call' || entry.type === 'tool_use') {
      blocks = appendTimelineTool(blocks, {
        tool: entry.tool ?? 'Tool',
        input: entry.content ?? null,
        toolCallId: entry.toolCallId,
      });
    } else if (entry.type === 'tool_result') {
      blocks = applyTimelineToolResult(blocks, {
        tool: entry.tool,
        toolCallId: entry.toolCallId,
        result: entry.content,
        isError: entry.isError,
      });
    } else if (entry.type === 'done') {
      blocks = finishTimeline(blocks, { toolWithoutResult: 'done' });
    } else if (entry.type === 'error') {
      blocks = failTimeline(blocks);
    }
  }
  return blocks.map((block) => ({ ...block, id: `${idPrefix}-${block.id}` }));
}
