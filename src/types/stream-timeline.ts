export type StreamTimelineToolStatus = 'running' | 'done' | 'error' | 'incomplete' | 'stopped';

export interface StreamTimelineTextBlock {
  id: string;
  sequence: number;
  kind: 'text';
  content: string;
  status: 'streaming' | 'done';
}

export interface StreamTimelineToolBlock {
  id: string;
  sequence: number;
  kind: 'tool';
  toolCallId?: string;
  tool: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  correlation?: 'matched' | 'unmatched';
  status: StreamTimelineToolStatus;
  durationMs?: number;
  textOffset?: number;
}

export type StreamTimelineBlock = StreamTimelineTextBlock | StreamTimelineToolBlock;

export interface PersistedTimelineToolCall {
  tool: string;
  input: unknown;
  output?: string;
  result?: string;
  isError?: boolean;
  status?: StreamTimelineToolStatus;
  durationMs?: number;
  sequence?: number;
  textOffset?: number;
  toolCallId?: string;
}
