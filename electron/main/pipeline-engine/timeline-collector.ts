import type { PersistedTimelineToolCall } from '../../../src/types/stream-timeline';

interface PipelineTimelineState {
  textOffset: number;
  textContent: string;
  nextSequence: number;
  tools: PersistedTimelineToolCall[];
}

interface PipelineTimelineEvent {
  projectId: string;
  phase: number;
  type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'thinking' | 'error';
  content?: string;
  tool?: string;
  toolCallId?: string;
  isError?: boolean;
}

const turns = new Map<string, PipelineTimelineState>();

function key(projectId: string, phase: number): string {
  return `${projectId}:${phase}`;
}

function stateFor(projectId: string, phase: number): PipelineTimelineState {
  const id = key(projectId, phase);
  const current = turns.get(id);
  if (current) return current;
  const created: PipelineTimelineState = {
    textOffset: 0,
    textContent: '',
    nextSequence: 0,
    tools: [],
  };
  turns.set(id, created);
  return created;
}

export function recordPipelineTimelineEvent(event: PipelineTimelineEvent): void {
  const id = key(event.projectId, event.phase);
  if (event.type === 'done' || event.type === 'error') {
    turns.delete(id);
    return;
  }
  if (event.type === 'thinking') return;

  const state = stateFor(event.projectId, event.phase);
  if (event.type === 'text') {
    const content = event.content ?? '';
    state.textContent += content;
    state.textOffset += content.length;
    return;
  }
  if (event.type === 'tool_call') {
    state.tools.push({
      tool: event.tool || 'Tool',
      input: null,
      sequence: state.nextSequence++,
      textOffset: state.textOffset,
      toolCallId: event.toolCallId,
      status: 'running',
    });
    return;
  }

  let match = event.toolCallId ? state.tools.find((tool) => tool.toolCallId === event.toolCallId) : undefined;
  if (!match && !event.toolCallId && event.tool) {
    const candidates = state.tools.filter((tool) => tool.tool === event.tool && tool.status === 'running');
    if (candidates.length === 1) match = candidates[0];
  }
  if (match) {
    match.result = event.content;
    match.isError = event.isError === true;
    match.status = event.isError ? 'error' : 'done';
  }
}

export function consumePipelineTimeline(
  projectId: string,
  phase: number,
  runtimeTools: readonly PersistedTimelineToolCall[] | undefined,
  persistedContent?: string,
): PersistedTimelineToolCall[] | undefined {
  const id = key(projectId, phase);
  const state = turns.get(id);
  turns.delete(id);

  if (!state) return runtimeTools?.length ? runtimeTools.map((tool) => ({ ...tool })) : undefined;

  const remaining = [...(runtimeTools ?? [])];
  const merged: PersistedTimelineToolCall[] = state.tools.map((started) => {
    let index = started.toolCallId ? remaining.findIndex((tool) => tool.toolCallId === started.toolCallId) : -1;
    if (index < 0) index = remaining.findIndex((tool) => tool.tool === started.tool);
    const final = index >= 0 ? remaining.splice(index, 1)[0] : undefined;
    return {
      ...started,
      ...final,
      sequence: started.sequence,
      textOffset: started.textOffset,
      toolCallId: started.toolCallId ?? final?.toolCallId,
      status: final?.status ?? (final?.isError ? 'error' : 'done'),
    } satisfies PersistedTimelineToolCall;
  });

  for (const final of remaining) {
    merged.push({
      ...final,
      sequence: final.sequence ?? state.nextSequence++,
      textOffset: final.textOffset ?? state.textOffset,
      status: final.status ?? (final.isError ? 'error' : 'done'),
    });
  }
  if (persistedContent !== undefined && persistedContent !== state.textContent) {
    remapOffsets(state.textContent, persistedContent, merged);
  }
  return merged.length > 0 ? merged : undefined;
}

function remapOffsets(previousContent: string, nextContent: string, tools: PersistedTimelineToolCall[]): void {
  let prefix = 0;
  const prefixLimit = Math.min(previousContent.length, nextContent.length);
  while (prefix < prefixLimit && previousContent[prefix] === nextContent[prefix]) prefix += 1;
  let suffix = 0;
  const suffixLimit = Math.min(previousContent.length - prefix, nextContent.length - prefix);
  while (
    suffix < suffixLimit &&
    previousContent[previousContent.length - 1 - suffix] === nextContent[nextContent.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const previousChangedEnd = previousContent.length - suffix;
  const delta = nextContent.length - previousContent.length;
  for (const tool of tools) {
    if (!Number.isInteger(tool.textOffset) || (tool.textOffset ?? -1) < 0) continue;
    const offset = tool.textOffset ?? 0;
    const remapped = offset <= prefix ? offset : offset >= previousChangedEnd ? offset + delta : prefix;
    tool.textOffset = Math.max(0, Math.min(nextContent.length, remapped));
  }
}

export function resetPipelineTimeline(projectId: string, phase: number): void {
  turns.delete(key(projectId, phase));
}
