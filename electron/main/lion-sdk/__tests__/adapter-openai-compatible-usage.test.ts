
import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createOpenAiCompatibleAdapter } from '../adapters/openai-compatible';
import type { LionStreamEvent } from '../adapters/types';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function sseLine(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n`;
}

function makeSseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function collect(adapter: ReturnType<typeof createOpenAiCompatibleAdapter>): Promise<LionStreamEvent[]> {
  const out: LionStreamEvent[] = [];
  for await (const ev of adapter.streamCompletion({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
  })) {
    out.push(ev);
  }
  return out;
}

const baseOpts = { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test' };

describe('OpenAI-compatible adapter - S5.3 usage emission', () => {
  it('emits usage event mid-stream when final SSE chunk contains usage', async () => {
    globalThis.fetch = vi.fn(async () =>
      makeSseResponse([
        sseLine({ choices: [{ index: 0, delta: { content: 'Ola' }, finish_reason: 'stop' }] }),
        sseLine({ choices: [{}], usage: { prompt_tokens: 18, completion_tokens: 6 } }),
        'data: [DONE]\n',
      ]),
    ) as unknown as typeof globalThis.fetch;

    const adapter = createOpenAiCompatibleAdapter(baseOpts);
    const events = await collect(adapter);

    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);

    const u = usageEvents[0] as { type: 'usage'; usage: { inputTokens: number; outputTokens: number } };
    expect(u.usage.inputTokens).toBe(18);
    expect(u.usage.outputTokens).toBe(6);
  });

  it('request body contains stream_options.include_usage=true', async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return makeSseResponse(['data: [DONE]\n']);
    }) as unknown as typeof globalThis.fetch;

    const adapter = createOpenAiCompatibleAdapter(baseOpts);
    await collect(adapter);

    const capturedBody = capturedBodies[0];
    expect(capturedBody).toBeDefined();
    if (!capturedBody) throw new Error('request body was not captured');
    expect(capturedBody.stream_options).toEqual({ include_usage: true });
  });

  it('usage event appears before done event', async () => {
    globalThis.fetch = vi.fn(async () =>
      makeSseResponse([
        sseLine({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }),
        sseLine({ choices: [{}], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
        'data: [DONE]\n',
      ]),
    ) as unknown as typeof globalThis.fetch;

    const adapter = createOpenAiCompatibleAdapter(baseOpts);
    const events = await collect(adapter);

    const usageIdx = events.findIndex((e) => e.type === 'usage');
    const doneIdx = events.findIndex((e) => e.type === 'done');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(usageIdx);
  });

  it('handles provider that sends no usage (graceful - no usage event emitted)', async () => {
    globalThis.fetch = vi.fn(async () =>
      makeSseResponse([
        sseLine({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }),
        'data: [DONE]\n',
      ]),
    ) as unknown as typeof globalThis.fetch;

    const adapter = createOpenAiCompatibleAdapter(baseOpts);
    const events = await collect(adapter);

    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(0);
  });

  it('emits exactly one usage event even if multiple SSE chunks have usage fields', async () => {
    globalThis.fetch = vi.fn(async () =>
      makeSseResponse([
        sseLine({ choices: [{ index: 0, delta: { content: 'a' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
        sseLine({ choices: [{ index: 0, delta: { content: 'b' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
        'data: [DONE]\n',
      ]),
    ) as unknown as typeof globalThis.fetch;

    const adapter = createOpenAiCompatibleAdapter(baseOpts);
    const events = await collect(adapter);

    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents.length).toBeGreaterThanOrEqual(1);
    const last = usageEvents[usageEvents.length - 1] as { usage: { outputTokens: number } };
    expect(last.usage.outputTokens).toBe(2);
  });
});
