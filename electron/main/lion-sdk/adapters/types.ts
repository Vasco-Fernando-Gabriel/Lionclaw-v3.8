
import type { LionToolSchema } from '../tool-registry';
import type { AnthropicContentBlock, NativeToolCall } from '../tool-parser';

export type LionRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LionChatMessage {
  role: LionRole;
  content: string;
  reasoning_content?: string;
  tool_calls?: NativeToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LionStreamRequest {
  model: string;
  messages: LionChatMessage[];
  tools?: LionToolSchema[];
  abortSignal?: AbortSignal;
  extra?: Record<string, unknown>;
}

export type LionStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call_delta'; toolCalls: NativeToolCall[] }
  | { type: 'content_block'; blocks: AnthropicContentBlock[] }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; error: string };

export interface LionAdapter {
  name: 'ollama' | 'lmstudio' | 'openai-compatible' | 'vertex-ai';
  streamCompletion(req: LionStreamRequest): AsyncIterable<LionStreamEvent>;
}

export interface AdapterConfig {
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
}
