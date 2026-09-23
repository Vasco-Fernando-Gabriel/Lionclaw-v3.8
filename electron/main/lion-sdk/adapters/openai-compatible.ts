import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { createLogger } from '../../logger';
import { normalizeBaseUrl } from './base-url';
import {
  normalizeOpenAiCompatEmbeddedError,
  normalizeOpenAiCompatHttpError,
  normalizeOpenAiCompatTransportError,
} from './openai-compat-errors';
import { parseOpenAiSse } from './openai-sse';
import type { AdapterConfig, LionAdapter, LionChatMessage, LionStreamEvent, LionStreamRequest } from './types';
import type { NativeToolCall } from '../tool-parser';

const logger = createLogger('lion-adapter-openai-compat');

interface StreamResponse {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

interface OpenAIToolSchema {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

type OpenAiChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        index?: number;
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; content: string; tool_call_id: string; name?: string };

function toOpenAITools(req: LionStreamRequest): OpenAIToolSchema[] | undefined {
  if (!req.tools || req.tools.length === 0) return undefined;
  return req.tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema,
    },
  }));
}

function stringifyToolArguments(args: string | Record<string, unknown> | undefined): string {
  if (typeof args === 'string') return args;
  if (args && typeof args === 'object') return JSON.stringify(args);
  return '{}';
}

function toOpenAIMessages(
  messages: LionChatMessage[],
  opts: {
    includeToolMessageName?: boolean;
    includeToolCallIndex?: boolean;
    includeReasoningContent?: boolean;
    requireToolReasoningContent?: boolean;
  } = {},
): OpenAiChatMessage[] {
  const toolCallNamesById = new Map<string, string>();
  const out: OpenAiChatMessage[] = [];

  for (const m of messages) {
    if (m.role === 'assistant') {
      const toolCalls = (() => {
        if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) return undefined;
        const mapped = m.tool_calls
          .filter((tc) => tc.id && tc.function?.name)
          .map((tc) => {
            const id = tc.id as string;
            const name = tc.function!.name as string;
            toolCallNamesById.set(id, name);
            return {
              ...(opts.includeToolCallIndex && typeof tc.index === 'number' ? { index: tc.index } : {}),
              id,
              type: 'function' as const,
              function: {
                name,
                arguments: stringifyToolArguments(tc.function!.arguments),
              },
            };
          });
        return mapped.length > 0 ? mapped : undefined;
      })();

      const hasText = m.content.trim().length > 0;
      if (!hasText && !toolCalls) {
        continue;
      }
      const reasoningContent =
        opts.includeReasoningContent && typeof m.reasoning_content === 'string'
          ? m.reasoning_content
          : opts.requireToolReasoningContent && toolCalls
            ? ''
            : undefined;

      out.push({
        role: 'assistant',
        content: hasText ? m.content : null,
        ...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : {}),
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (m.role === 'tool') {
      const toolCallId = m.tool_call_id ?? '';
      if (!toolCallId) {
        continue;
      }
      const name = toolCallNamesById.get(toolCallId);
      out.push({
        role: 'tool',
        content: m.content.trim().length > 0 ? m.content : '{}',
        tool_call_id: toolCallId,
        ...(opts.includeToolMessageName && name ? { name } : {}),
      });
      continue;
    }

    out.push({ role: m.role, content: m.content });
  }

  return out;
}

export interface OpenAiCompatibleAdapterOptions extends AdapterConfig {
  endpointPath?: string;
  requireApiKey?: boolean;
  localStreamNoBodyTimeout?: boolean;
}

function abortError(): Error {
  const err = new Error('AbortError');
  err.name = 'AbortError';
  return err;
}

async function readWebStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

function nodeResponseToStreamResponse(res: IncomingMessage): StreamResponse {
  const body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
  const status = res.statusCode ?? 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    text: () => readWebStreamText(body),
  };
}

function postJsonStreamWithoutBodyTimeout(
  url: string,
  init: {
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
): Promise<StreamResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const requestImpl = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    let response: IncomingMessage | null = null;
    let settled = false;

    const cleanup = () => {
      init.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      const err = abortError();
      request.destroy(err);
      response?.destroy(err);
    };

    if (init.signal?.aborted) {
      reject(abortError());
      return;
    }

    const request = requestImpl(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          ...init.headers,
          'Content-Length': Buffer.byteLength(init.body),
        },
      },
      (res) => {
        response = res;
        settled = true;
        res.once('close', cleanup);
        resolve(nodeResponseToStreamResponse(res));
      },
    );

    init.signal?.addEventListener('abort', onAbort, { once: true });

    request.once('error', (err) => {
      if (!settled) {
        cleanup();
        reject(err);
      }
    });

    request.end(init.body);
  });
}

function isKimiThinkingModel(model: string): boolean {
  return /kimi-k2(?:[.-]?(?:5|6)|-thinking)|k2-thinking/i.test(model);
}

export function createOpenAiCompatibleAdapter(opts: OpenAiCompatibleAdapterOptions): LionAdapter {
  const base = normalizeBaseUrl(opts.baseUrl);
  if (!base) {
    throw new Error('OpenAI-compatible adapter requires baseUrl');
  }
  const endpointPath = opts.endpointPath ?? '/v1/chat/completions';
  const requireApiKey = opts.requireApiKey !== false;
  const isKimiCompatible = /moonshot|kimi/i.test(base);

  return {
    name: 'openai-compatible',
    async *streamCompletion(req: LionStreamRequest): AsyncIterable<LionStreamEvent> {
      if (requireApiKey && (!opts.apiKey || opts.apiKey.length === 0)) {
        yield { type: 'error', error: 'OpenAI-compatible adapter requer apiKey.' };
        return;
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(opts.extraHeaders ?? {}),
      };
      if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`;

      const body: Record<string, unknown> = {
        model: req.model,
        messages: toOpenAIMessages(req.messages, {
          includeToolMessageName: isKimiCompatible,
          includeToolCallIndex: isKimiCompatible,
          includeReasoningContent: isKimiCompatible,
          requireToolReasoningContent: isKimiCompatible && isKimiThinkingModel(req.model),
        }),
        stream: true,
        stream_options: { include_usage: true },
        tools: toOpenAITools(req),
        tool_choice: req.tools && req.tools.length > 0 ? 'auto' : undefined,
        ...req.extra,
      };
      if (isKimiCompatible && typeof body.temperature === 'number' && body.temperature !== 1) {
        body.temperature = 1;
      }

      let response: StreamResponse;
      try {
        const serializedBody = JSON.stringify(body);
        response = opts.localStreamNoBodyTimeout
          ? await postJsonStreamWithoutBodyTimeout(`${base}${endpointPath}`, {
              headers,
              body: serializedBody,
              signal: req.abortSignal,
            })
          : await fetch(`${base}${endpointPath}`, {
              method: 'POST',
              headers,
              body: serializedBody,
              signal: req.abortSignal,
            });
      } catch (e) {
        const norm = normalizeOpenAiCompatTransportError(e, { provider: 'openai-compatible' });
        yield { type: 'error', error: `OpenAI-compat fetch falhou: ${norm.userMessage}` };
        return;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const norm = normalizeOpenAiCompatHttpError({
          status: response.status,
          bodyText: text.slice(0, 400),
          ctx: { provider: 'openai-compatible' },
        });
        yield { type: 'error', error: norm.userMessage };
        return;
      }
      if (!response.body) {
        yield { type: 'error', error: 'OpenAI-compat: resposta sem body' };
        return;
      }

      const accToolCalls = new Map<number, { id?: string; name?: string; args: string }>();
      let inputTokens = 0;
      let outputTokens = 0;
      let finishReason: string | undefined;

      try {
        for await (const ev of parseOpenAiSse(response.body)) {
          if (ev.kind === 'done') {
            break;
          }
          if (ev.kind === 'error' && ev.error) {
            const norm = normalizeOpenAiCompatEmbeddedError(ev.error, {
              provider: 'openai-compatible',
              model: req.model,
            });
            yield { type: 'error', error: norm.userMessage };
            return;
          }
          if (!ev.chunk) continue;
          if (ev.kind === 'usage' && ev.chunk.usage) {
            inputTokens = ev.chunk.usage.prompt_tokens ?? inputTokens;
            outputTokens = ev.chunk.usage.completion_tokens ?? outputTokens;
            yield {
              type: 'usage',
              usage: { inputTokens, outputTokens },
            };
          }
          const choice = ev.chunk.choices?.[0];
          if (!choice) continue;
          if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
          const delta = choice.delta ?? {};
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            yield { type: 'reasoning', delta: delta.reasoning_content };
          }
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            yield { type: 'text', delta: delta.content };
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === 'number' ? tc.index : 0;
              const cur = accToolCalls.get(idx) ?? { args: '' };
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.name = tc.function.name;
              if (typeof tc.function?.arguments === 'string') {
                cur.args += tc.function.arguments;
              }
              accToolCalls.set(idx, cur);
            }
          }
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          yield { type: 'error', error: 'OpenAI-compat: stream abortado' };
          return;
        }
        logger.warn({ err: e }, 'OpenAI-compat stream falhou');
        const norm = normalizeOpenAiCompatTransportError(e, { provider: 'openai-compatible' });
        yield { type: 'error', error: `OpenAI-compat stream falhou: ${norm.userMessage}` };
        return;
      }

      if (accToolCalls.size > 0) {
        const toolCalls: NativeToolCall[] = [];
        const indices = [...accToolCalls.keys()].sort((a, b) => a - b);
        for (const i of indices) {
          const c = accToolCalls.get(i);
          if (!c || !c.name) continue;
          toolCalls.push({
            index: i,
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.args },
          });
        }
        if (toolCalls.length > 0) {
          yield { type: 'tool_call_delta', toolCalls };
        }
      }

      yield { type: 'done', finishReason };
    },
  };
}
