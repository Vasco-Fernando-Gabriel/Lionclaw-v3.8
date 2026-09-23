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

describe('Ollama adapter - S5.1 usage emission', () => {
  it('emits usage event during stream when done line arrives with token counts', async () => {
    globalThis.fetch = vi.fn(async () =>
      makeNdjsonResponse([
        JSON.stringify({ message: { content: 'hello ' } }),
        JSON.stringify({ message: { content: 'world' } }),
        JSON.stringify({ done: true, prompt_eval_count: 12, eval_count: 34 }),
      ]),
    ) as unknown as typeof globalThis.fetch;

    const adapter = createOllamaAdapter({ baseUrl: 'http://localhost:11434' });
    const events = await collect(adapter);

    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);

    const u = usageEvents[0] as { type: 'usage'; usage: { inputTokens: number; outputTokens: number } };
    expect(u.usage.inputTokens).toBe(12);
    expect(u.usage.outputTokens).toBe(34);
  });

  it('usage event appears before done event in event order', async () => {
    globalThis.fetch = vi.fn(async () =>
      makeNdjsonResponse([
        JSON.stringify({ message: { content: 'hi' } }),
        JSON.stringify({ done: true, prompt_eval_count: 5, eval_count: 7 }),
      ]),
    ) as unknown as typeof globalThis.fetch;

    const adapter = createOllamaAdapter({ baseUrl: 'http://localhost:11434' });
    const events = await collect(adapter);

    const usageIdx = events.findIndex((e) => e.type === 'usage');
    const doneIdx = events.findIndex((e) => e.type === 'done');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(usageIdx);
  });

  it('emits usage with zero counts when prompt_eval_count and eval_count are absent from done line', async () => {
    globalThis.fetch = vi.fn(async () =>
      makeNdjsonResponse([JSON.stringify({ message: { content: 'x' } }), JSON.stringify({ done: true })]),
    ) as unknown as typeof globalThis.fetch;

    const adapter = createOllamaAdapter({ baseUrl: 'http://localhost:11434' });
    const events = await collect(adapter);

    const u = events.find((e) => e.type === 'usage') as
      { type: 'usage'; usage: { inputTokens: number; outputTokens: number } } | undefined;
    expect(u).toBeDefined();
    expect(u!.usage.inputTokens).toBe(0);
    expect(u!.usage.outputTokens).toBe(0);
  });

  it('does not emit usage when stream errors before done line', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('internal error', { status: 500 }),
    ) as unknown as typeof globalThis.fetch;

    const adapter = createOllamaAdapter({ baseUrl: 'http://localhost:11434' });
    const events = await collect(adapter);

    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(0);
    expect(events[0]?.type).toBe('error');
  });
});
