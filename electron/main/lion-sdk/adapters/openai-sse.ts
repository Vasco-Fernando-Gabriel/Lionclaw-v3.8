import { extractOpenAiEmbeddedError, type OpenAiEmbeddedError } from './openai-compat-errors';

export interface OpenAiSseDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: 'function' | string;
    function?: { name?: string; arguments?: string };
  }>;
  role?: string;
}

export interface OpenAiSseChunk {
  id?: string;
  choices?: Array<{
    index?: number;
    delta?: OpenAiSseDelta;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface ParsedSseEvent {
  kind: 'chunk' | 'done' | 'usage' | 'error';
  chunk?: OpenAiSseChunk;
  error?: OpenAiEmbeddedError;
}

export async function* parseOpenAiSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<ParsedSseEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventData = '';

  function* flushEvent(): Generator<ParsedSseEvent, boolean, void> {
    const data = eventData.trim();
    eventData = '';
    if (!data) return false;
    if (data === '[DONE]') {
      yield { kind: 'done' };
      return true;
    }
    try {
      const parsed = JSON.parse(data) as OpenAiSseChunk;
      const embedded = extractOpenAiEmbeddedError(parsed);
      if (embedded && !Array.isArray(parsed.choices)) {
        yield { kind: 'error', error: embedded };
        return false;
      }
      if (parsed.usage) yield { kind: 'usage', chunk: parsed };
      yield { kind: 'chunk', chunk: parsed };
    } catch {}
    return false;
  }

  function isCompleteJsonPayload(value: string): boolean {
    const data = value.trim();
    if (!data) return false;
    if (data === '[DONE]') return true;
    try {
      JSON.parse(data);
      return true;
    } catch {
      return false;
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const rawLine = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
        if (rawLine.length === 0) {
          const flushed = [...flushEvent()];
          for (const ev of flushed) yield ev;
          if (flushed.some((ev) => ev.kind === 'done')) return;
          continue;
        }
        if (rawLine.startsWith(':')) continue;
        if (rawLine.startsWith('data:')) {
          if (eventData.length > 0 && isCompleteJsonPayload(eventData)) {
            const flushed = [...flushEvent()];
            for (const ev of flushed) yield ev;
            if (flushed.some((ev) => ev.kind === 'done')) return;
          }
          eventData += rawLine.slice(5).trim();
        } else if (eventData.length > 0) {
          eventData += rawLine.trim();
        }
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      eventData += tail.slice(5).trim();
    } else if (tail && eventData.length > 0) {
      eventData += tail;
    }
    const flushed = [...flushEvent()];
    for (const ev of flushed) yield ev;
    if (flushed.some((ev) => ev.kind === 'done')) {
      return;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}
