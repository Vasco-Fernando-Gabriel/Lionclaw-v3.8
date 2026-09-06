
import { buildExecutionError, type AgentExecutionError } from './agent-runtime/llm-error';

const CONTENT_CHUNK_TYPES: ReadonlySet<string> = new Set([
  'text',
  'tool_call',
  'tool_result',
  'artifact',
  'replace_content',
  'assistant_pushed',
]);

export interface ChatTurnStreamFlags {
  sawErrorChunk: boolean;
  sawDoneChunk: boolean;
  sawContentChunk: boolean;
  delegatedToRetry: boolean;
}

export function createChatTurnStreamFlags(): ChatTurnStreamFlags {
  return {
    sawErrorChunk: false,
    sawDoneChunk: false,
    sawContentChunk: false,
    delegatedToRetry: false,
  };
}

export function markChatTurnDelegated(flags: ChatTurnStreamFlags): void {
  flags.delegatedToRetry = true;
}

export function trackChatTurnChunk(flags: ChatTurnStreamFlags, chunkType: string): void {
  if (chunkType === 'error') flags.sawErrorChunk = true;
  else if (chunkType === 'done') flags.sawDoneChunk = true;
  else if (CONTENT_CHUNK_TYPES.has(chunkType)) flags.sawContentChunk = true;
}

export function shouldEmitChatTurnFallbackError(
  flags: ChatTurnStreamFlags,
  opts: { isDesktopLane: boolean; silent: boolean },
): boolean {
  if (!opts.isDesktopLane) return false;
  if (opts.silent) return false;
  if (flags.delegatedToRetry) return false;
  return !flags.sawErrorChunk && !flags.sawContentChunk && !flags.sawDoneChunk;
}

export function chatTurnFallbackError(raw?: string): AgentExecutionError {
  return buildExecutionError('LLM-EMPTY', raw);
}
