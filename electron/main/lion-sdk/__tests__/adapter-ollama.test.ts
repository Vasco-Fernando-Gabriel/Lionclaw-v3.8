
import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createOllamaAdapter } from '../adapters/ollama';
import type { LionStreamEvent } from '../adapters/types';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeNdjsonResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l + '\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

async function collect(adapter: ReturnType<typeof createOllamaAdapter>): Promise<LionStreamEvent[]> {
  const out: LionStreamEvent[] = [];
  for await (const ev of adapter.streamCompletion({
    model: 'llama3.1',
    messages: [{ role: 'user', content: 'hi' }],
  })) {
    out.push(ev);
  }
  return out;
}

describe('Ollama adapter', () => {
  it('parses NDJSON text deltas and emits usage/done', async () => {
    globalThis.fetch = vi.fn(async () =>
      makeNdjsonResponse([
        JSON.stringify({ message: { content: 'hello ' } }),
        JSON.stringify({ message: { content: 'world' } }),
        JSON.stringify({ done: true, prompt_eval_count: 5, eval_count: 7 }),
      ]),
    ) as unknown as typeof globalThis.fetch;
    const adapter = createOllamaAdapter({ baseUrl: 'http://localhost:11434' });
    const events = await collect(adapter);
    const texts = events.filter((e) => e.type === 'text');
    expect(texts.map((e) => (e as { delta: string }).delta).join('')).toBe('hello world');
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toBeDefined();
    expect((usage as { usage: { inputTokens: number; outputTokens: number } }).usage).toEqual({
      inputTokens: 5,
      outputTokens: 7,
    });
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  });

  it('parses native function tool_calls', async () => {
    globalThis.fetch = vi.fn(async () =>
      makeNdjsonResponse([
        JSON.stringify({
          message: {
            tool_calls: [{ function: { name: 'Read', arguments: { file_path: '/a' } } }],
          },
        }),
        JSON.stringify({ done: true }),
      ]),
    ) as unknown as typeof globalThis.fetch;
    const adapter = createOllamaAdapter({ baseUrl: 'http://localhost:11434/v1' });
    const events = await collect(adapter);
    const tc = events.find((e) => e.type === 'tool_call_delta');
    expect(tc).toBeDefined();
    expect((tc as { toolCalls: Array<{ function?: { name?: string } }> }).toolCalls[0]?.function?.name).toBe('Read');
  });

  it('surfaces HTTP errors as an error event', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof globalThis.fetch;
    const adapter = createOllamaAdapter({ baseUrl: 'http://localhost:11434' });
    const events = await collect(adapter);
    expect(events[0]?.type).toBe('error');
  });
});
