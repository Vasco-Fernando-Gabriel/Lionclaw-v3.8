import { createLogger } from '../../logger';
import { normalizeBaseUrl } from './base-url';
import {
  extractOpenAiEmbeddedError,
  normalizeOpenAiCompatEmbeddedError,
  normalizeOpenAiCompatHttpError,
  normalizeOpenAiCompatTransportError,
} from './openai-compat-errors';
import type { AdapterConfig, LionAdapter, LionStreamEvent, LionStreamRequest } from './types';
import type { NativeToolCall } from '../tool-parser';

const logger = createLogger('lion-adapter-ollama');

interface OllamaToolFunctionSchema {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChatLine {
  model?: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      function?: { name?: string; arguments?: Record<string, unknown> | string };
    }>;
  };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

function toOllamaTools(req: LionStreamRequest): OllamaToolFunctionSchema[] | undefined {
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

export function createOllamaAdapter(config: AdapterConfig): LionAdapter {
  const base = normalizeBaseUrl(config.baseUrl);
  if (!base) {
    throw new Error('Ollama adapter requires baseUrl');
  }

  return {
    name: 'ollama',
    async *streamCompletion(req: LionStreamRequest): AsyncIterable<LionStreamEvent> {
      const url = `${base}/api/chat`;
      const body = {
        model: req.model,
        messages: req.messages,
        stream: true,
        tools: toOllamaTools(req),
        options: req.extra,
      };
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.extraHeaders ?? {}),
          },
          body: JSON.stringify(body),
          signal: req.abortSignal,
        });
      } catch (e) {
        const norm = normalizeOpenAiCompatTransportError(e, { provider: 'ollama' });
        yield { type: 'error', error: `Ollama fetch falhou: ${norm.userMessage}` };
        return;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const norm = normalizeOpenAiCompatHttpError({
          status: response.status,
          bodyText: text.slice(0, 400),
          ctx: { provider: 'ollama' },
        });
        yield { type: 'error', error: norm.userMessage };
        return;
      }
      if (!response.body) {
        yield { type: 'error', error: 'Ollama: resposta sem body' };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let finishReason: string | undefined;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let nlIdx = buffer.indexOf('\n');
          while (nlIdx !== -1) {
            const rawLine = buffer.slice(0, nlIdx).trim();
            buffer = buffer.slice(nlIdx + 1);
            nlIdx = buffer.indexOf('\n');
            if (rawLine.length === 0) continue;

            let line: OllamaChatLine;
            try {
              line = JSON.parse(rawLine) as OllamaChatLine;
            } catch {
              continue;
            }

            const embedded = extractOpenAiEmbeddedError(line);
            if (embedded && !line.message && !line.done) {
              const norm = normalizeOpenAiCompatEmbeddedError(embedded, {
                provider: 'ollama',
                model: req.model,
              });
              yield { type: 'error', error: norm.userMessage };
              return;
            }

            const msg = line.message;
            if (msg) {
              if (typeof msg.content === 'string' && msg.content.length > 0) {
                yield { type: 'text', delta: msg.content };
              }
              if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                const toolCalls: NativeToolCall[] = msg.tool_calls.map((tc) => {
                  let argsString: string | Record<string, unknown> = {};
                  const fn = tc.function;
                  if (fn?.arguments && typeof fn.arguments === 'object') {
                    argsString = fn.arguments as Record<string, unknown>;
                  } else if (typeof fn?.arguments === 'string') {
                    argsString = fn.arguments;
                  }
                  return {
                    type: 'function',
                    function: {
                      name: fn?.name,
                      arguments: argsString,
                    },
                  };
                });
                yield { type: 'tool_call_delta', toolCalls };
              }
            }

            if (line.done) {
              inputTokens = line.prompt_eval_count ?? inputTokens;
              outputTokens = line.eval_count ?? outputTokens;
              finishReason = 'stop';
              yield {
                type: 'usage',
                usage: { inputTokens, outputTokens },
              };
            }
          }
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          yield { type: 'error', error: 'Ollama: stream abortado' };
          return;
        }
        logger.warn({ err: e }, 'Ollama stream falhou');
        const norm = normalizeOpenAiCompatTransportError(e, { provider: 'ollama' });
        yield { type: 'error', error: `Ollama stream falhou: ${norm.userMessage}` };
        return;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* noop */
        }
      }

      yield { type: 'done', finishReason };
    },
  };
}
