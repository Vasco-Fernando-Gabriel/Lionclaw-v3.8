import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createOpenAiCompatibleAdapter } from '../lion-sdk/adapters/openai-compatible';
import { createOllamaAdapter } from '../lion-sdk/adapters/ollama';
import { parseOpenAiSse } from '../lion-sdk/adapters/openai-sse';
import { runLionLoop } from '../lion-sdk/runtime';
import type { LionAdapter, LionStreamEvent } from '../lion-sdk/adapters/types';
import type { LionStreamTranslator } from '../lion-sdk/stream-translator';

function bodyStreamFrom(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function fakeResponse(status: number, bodyText: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: bodyStreamFrom(bodyText),
    text: async () => bodyText,
  } as unknown as Response;
}

async function collectEvents(iter: AsyncIterable<LionStreamEvent>): Promise<LionStreamEvent[]> {
  const events: LionStreamEvent[] = [];
  for await (const ev of iter) events.push(ev);
  return events;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('AC-B15: openai-compatible HTTP status -> categoria distinta', () => {
  const cases: Array<[number, string, string]> = [
    [402, '{"error":{"message":"insufficient balance"}}', 'LLM-QUOTA'],
    [401, '{"error":{"message":"invalid api key"}}', 'LLM-AUTH-401'],
    [429, '{"error":{"message":"rate limit exceeded"}}', 'LLM-RATE-429'],
    [404, '{"error":{"message":"model not found"}}', 'LLM-MODEL-404'],
    [500, 'internal server error', 'LLM-OVERLOADED-529'],
  ];

  for (const [status, body, code] of cases) {
    it(`AC-B15: HTTP ${status} emite [${code}] (nao "HTTP ${status}" cru)`, async () => {
      globalThis.fetch = vi.fn(async () => fakeResponse(status, body)) as typeof fetch;
      const adapter = createOpenAiCompatibleAdapter({
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
      });
      const events = await collectEvents(
        adapter.streamCompletion({ model: 'test-model', messages: [{ role: 'user', content: 'oi' }] }),
      );
      expect(events).toHaveLength(1);
      const ev = events[0];
      expect(ev.type).toBe('error');
      const msg = (ev as { error: string }).error;
      expect(msg).toContain(`[${code}]`);
      expect(msg).not.toMatch(new RegExp(`^OpenAI-compat HTTP ${status}`));
    });
  }
});

describe('AC-B15: ollama HTTP status -> categoria distinta', () => {
  it('AC-B15: Ollama 404 emite [LLM-MODEL-404]', async () => {
    globalThis.fetch = vi.fn(async () => fakeResponse(404, '{"error":"model \'x\' not found"}')) as typeof fetch;
    const adapter = createOllamaAdapter({ baseUrl: 'http://localhost:11434' });
    const events = await collectEvents(
      adapter.streamCompletion({ model: 'x', messages: [{ role: 'user', content: 'oi' }] }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    const msg = (events[0] as { error: string }).error;
    expect(msg).toContain('[LLM-MODEL-404]');
    expect(msg).not.toMatch(/^Ollama HTTP 404/);
  });

  it('AC-B15: Ollama 500 emite [LLM-OVERLOADED-529]', async () => {
    globalThis.fetch = vi.fn(async () => fakeResponse(500, 'boom')) as typeof fetch;
    const adapter = createOllamaAdapter({ baseUrl: 'http://localhost:11434' });
    const events = await collectEvents(
      adapter.streamCompletion({ model: 'x', messages: [{ role: 'user', content: 'oi' }] }),
    );
    expect((events[0] as { error: string }).error).toContain('[LLM-OVERLOADED-529]');
  });

  it('AC-B15: fetch ECONNREFUSED do Ollama emite [LLM-LOCAL-DOWN]', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    }) as typeof fetch;
    const adapter = createOllamaAdapter({ baseUrl: 'http://localhost:11434' });
    const events = await collectEvents(
      adapter.streamCompletion({ model: 'x', messages: [{ role: 'user', content: 'oi' }] }),
    );
    expect(events[0].type).toBe('error');
    expect((events[0] as { error: string }).error).toContain('[LLM-LOCAL-DOWN]');
  });
});

describe('AC-B16: 200 com corpo de erro no SSE/NDJSON', () => {
  it('AC-B16: parseOpenAiSse yields kind:error para data:{"error":{...}}', async () => {
    const sse = 'data: {"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}\n\n';
    const events: Array<{ kind: string }> = [];
    for await (const ev of parseOpenAiSse(bodyStreamFrom(sse))) {
      events.push(ev);
    }
    expect(events.some((e) => e.kind === 'error')).toBe(true);
  });

  it('AC-B16: parseOpenAiSse NAO classifica chunk normal como erro', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"oi"}}]}\n\ndata: [DONE]\n\n';
    const kinds: string[] = [];
    for await (const ev of parseOpenAiSse(bodyStreamFrom(sse))) {
      kinds.push(ev.kind);
    }
    expect(kinds).not.toContain('error');
    expect(kinds).toContain('chunk');
  });

  it('AC-B16: adapter openai-compatible emite erro CLASSIFICADO para 200+quota (nao turno vazio)', async () => {
    const sse = 'data: {"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}\n\n';
    globalThis.fetch = vi.fn(async () => fakeResponse(200, sse)) as typeof fetch;
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
    });
    const events = await collectEvents(
      adapter.streamCompletion({ model: 'test-model', messages: [{ role: 'user', content: 'oi' }] }),
    );
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0] as { error: string }).error).toContain('[LLM-QUOTA]');
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('AC-B16 (paridade): linha NDJSON {"error":"..."} do Ollama vira erro classificado', async () => {
    const ndjson = '{"error":"model requires more system memory"}\n';
    globalThis.fetch = vi.fn(async () => fakeResponse(200, ndjson)) as typeof fetch;
    const adapter = createOllamaAdapter({ baseUrl: 'http://localhost:11434' });
    const events = await collectEvents(
      adapter.streamCompletion({ model: 'x', messages: [{ role: 'user', content: 'oi' }] }),
    );
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0] as { error: string }).error).toContain('model requires more system memory');
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });
});

describe('SB-6: runLionLoop emite LLM-EMPTY para turno 200 vazio', () => {
  function adapterFromEvents(events: LionStreamEvent[]): LionAdapter {
    return {
      name: 'openai-compatible',
      // eslint-disable-next-line @typescript-eslint/require-await
      streamCompletion: async function* () {
        for (const ev of events) yield ev;
      },
    };
  }

  it('SB-6: stream 200 sem texto/tool_call/reasoning emite chunk LLM-EMPTY e conclui normal', async () => {
    const errors: string[] = [];
    let dones = 0;
    const translator: LionStreamTranslator = {
      emitText: vi.fn(),
      emitToolCall: vi.fn(),
      emitToolResult: vi.fn(),
      emitError: (err: unknown) => {
        errors.push(err instanceof Error ? err.message : String(err));
      },
      emitUsage: vi.fn(),
      emitContextUsage: vi.fn(),
      emitDone: () => {
        dones += 1;
      },
    };
    const result = await runLionLoop({
      adapter: adapterFromEvents([{ type: 'done' }]),
      model: 'test-model',
      initialMessages: [{ role: 'user', content: 'oi' }],
      tools: [],
      dispatcher: vi.fn(),
      translator,
    });
    expect(errors.some((m) => m.includes('[LLM-EMPTY]'))).toBe(true);
    expect(dones).toBe(1);
    expect(result.ok).toBe(true);
  });

  it('SB-6 (empty-ok): turno com texto NAO emite LLM-EMPTY', async () => {
    const errors: string[] = [];
    const translator: LionStreamTranslator = {
      emitText: vi.fn(),
      emitToolCall: vi.fn(),
      emitToolResult: vi.fn(),
      emitError: (err: unknown) => {
        errors.push(err instanceof Error ? err.message : String(err));
      },
      emitUsage: vi.fn(),
      emitContextUsage: vi.fn(),
      emitDone: vi.fn(),
    };
    const result = await runLionLoop({
      adapter: adapterFromEvents([{ type: 'text', delta: 'resposta' }, { type: 'done' }]),
      model: 'test-model',
      initialMessages: [{ role: 'user', content: 'oi' }],
      tools: [],
      dispatcher: vi.fn(),
      translator,
    });
    expect(errors).toHaveLength(0);
    expect(result.finalText).toBe('resposta');
  });

  it('SB-6 (empty-ok): turno so-reasoning NAO emite LLM-EMPTY', async () => {
    const errors: string[] = [];
    const translator: LionStreamTranslator = {
      emitText: vi.fn(),
      emitToolCall: vi.fn(),
      emitToolResult: vi.fn(),
      emitError: (err: unknown) => {
        errors.push(err instanceof Error ? err.message : String(err));
      },
      emitUsage: vi.fn(),
      emitContextUsage: vi.fn(),
      emitDone: vi.fn(),
    };
    await runLionLoop({
      adapter: adapterFromEvents([{ type: 'reasoning', delta: 'pensando...' }, { type: 'done' }]),
      model: 'test-model',
      initialMessages: [{ role: 'user', content: 'oi' }],
      tools: [],
      dispatcher: vi.fn(),
      translator,
    });
    expect(errors).toHaveLength(0);
  });
});
