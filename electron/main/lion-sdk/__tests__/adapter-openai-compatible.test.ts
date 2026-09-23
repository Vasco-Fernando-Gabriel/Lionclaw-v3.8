import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createOpenAiCompatibleAdapter } from '../adapters/openai-compatible';
import type { LionChatMessage, LionStreamEvent } from '../adapters/types';

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
    model: 'gpt-x',
    messages: [{ role: 'user', content: 'hi' }],
  })) {
    out.push(ev);
  }
  return out;
}

describe('OpenAI-compatible adapter', () => {
  it('parses streaming SSE text deltas and usage', async () => {
    globalThis.fetch = vi.fn(async () =>
      makeSseResponse([
        sseLine({ choices: [{ index: 0, delta: { content: 'hello ' } }] }),
        sseLine({ choices: [{ index: 0, delta: { content: 'world' }, finish_reason: 'stop' }] }),
        sseLine({ choices: [{}], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
        'data: [DONE]\n',
      ]),
    ) as unknown as typeof globalThis.fetch;
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
    });
    const events = await collect(adapter);
    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    expect(text).toBe('hello world');
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toBeDefined();
    expect((usage as { usage: { inputTokens: number; outputTokens: number } }).usage).toEqual({
      inputTokens: 3,
      outputTokens: 4,
    });
    expect(events[events.length - 1]?.type).toBe('done');
  });

  it('accumulates streaming tool_calls across deltas', async () => {
    globalThis.fetch = vi.fn(async () =>
      makeSseResponse([
        sseLine({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"file_p' } }],
              },
            },
          ],
        }),
        sseLine({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: 'ath":"/abs"}' } }] },
            },
          ],
        }),
        'data: [DONE]\n',
      ]),
    ) as unknown as typeof globalThis.fetch;
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://api.example.com/v1', // /v1 should be stripped
      apiKey: 'sk-test',
    });
    const events = await collect(adapter);
    const tc = events.find((e) => e.type === 'tool_call_delta');
    expect(tc).toBeDefined();
    const calls = (tc as { toolCalls: Array<{ function?: { name?: string; arguments?: string } }> }).toolCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.function?.name).toBe('Read');
    expect(calls[0]?.function?.arguments).toBe('{"file_path":"/abs"}');
  });

  it('parses Kimi-style multi-line SSE payloads', async () => {
    globalThis.fetch = vi.fn(async () =>
      makeSseResponse(['data: {"choices":[{"index":0,"delta":{"content":"he', 'llo"}}]}\n', 'data: [DONE]\n']),
    ) as unknown as typeof globalThis.fetch;
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://api.moonshot.ai',
      apiKey: 'sk-test',
    });

    const events = await collect(adapter);

    expect(events.find((e) => e.type === 'text')).toEqual({ type: 'text', delta: 'hello' });
    expect(events[events.length - 1]?.type).toBe('done');
  });

  it('parses Kimi reasoning_content without rendering it as text', async () => {
    globalThis.fetch = vi.fn(async () =>
      makeSseResponse([
        sseLine({ choices: [{ index: 0, delta: { reasoning_content: 'vou pensar' } }] }),
        sseLine({ choices: [{ index: 0, delta: { content: 'resposta' } }] }),
        'data: [DONE]\n',
      ]),
    ) as unknown as typeof globalThis.fetch;
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://api.moonshot.ai',
      apiKey: 'sk-test',
    });

    const events = await collect(adapter);

    expect(events.find((e) => e.type === 'reasoning')).toEqual({ type: 'reasoning', delta: 'vou pensar' });
    expect(events.find((e) => e.type === 'text')).toEqual({ type: 'text', delta: 'resposta' });
  });

  it('sends tool_choice auto when tools are present', async () => {
    let requestBody: { tool_choice?: string } = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return makeSseResponse(['data: [DONE]\n']);
    }) as unknown as typeof globalThis.fetch;
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://api.moonshot.ai',
      apiKey: 'sk-test',
    });

    for await (const _ of adapter.streamCompletion({
      model: 'kimi-k2.6',
      messages: [{ role: 'user', content: 'use tool' }],
      tools: [
        {
          name: 'memory_search',
          description: 'Search memory',
          input_schema: {
            type: 'object',
            required: ['query'],
            properties: { query: { type: 'string' } },
          },
        },
      ],
    })) {
    }

    expect(requestBody.tool_choice).toBe('auto');
  });

  it('drops empty assistant messages without tool calls before sending to OpenAI-compatible providers', async () => {
    let requestBody: {
      messages?: Array<Record<string, unknown>>;
    } = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return makeSseResponse(['data: [DONE]\n']);
    }) as unknown as typeof globalThis.fetch;
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://api.moonshot.ai',
      apiKey: 'sk-test',
    });

    for await (const _ of adapter.streamCompletion({
      model: 'kimi-k2.6',
      messages: [
        { role: 'user', content: 'antes' },
        { role: 'assistant', content: '' },
        { role: 'assistant', content: '   ' },
        { role: 'user', content: 'depois' },
      ],
    })) {
    }

    expect(requestBody.messages).toEqual([
      { role: 'user', content: 'antes' },
      { role: 'user', content: 'depois' },
    ]);
  });

  it('requires apiKey for openai-compatible', async () => {
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'https://api.example.com' });
    const events = await collect(adapter);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { error: string }).error).toMatch(/apiKey/);
  });

  it('formats assistant tool_calls and tool results for OpenAI-compatible providers', async () => {
    let requestBody: {
      messages?: Array<Record<string, unknown>>;
    } = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return makeSseResponse(['data: [DONE]\n']);
    }) as unknown as typeof globalThis.fetch;
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://api.moonshot.ai',
      apiKey: 'sk-test',
    });
    const messages: LionChatMessage[] = [
      { role: 'user', content: 'busca memoria' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'preciso chamar memory_search',
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: {
              name: 'mcp_call',
              arguments: { server_id: 'memory-search', tool: 'memory_search', args: { query: 'projeto' } },
            },
          },
        ],
      },
      {
        role: 'tool',
        content: '{"results":[]}',
        tool_call_id: 'call_1',
        name: 'mcp:memory-search.memory_search',
      },
    ];

    for await (const _ of adapter.streamCompletion({ model: 'gpt-x', messages })) {
    }

    expect(requestBody.messages?.[1]).toEqual({
      role: 'assistant',
      content: null,
      reasoning_content: 'preciso chamar memory_search',
      tool_calls: [
        {
          index: 0,
          id: 'call_1',
          type: 'function',
          function: {
            name: 'mcp_call',
            arguments: JSON.stringify({
              server_id: 'memory-search',
              tool: 'memory_search',
              args: { query: 'projeto' },
            }),
          },
        },
      ],
    });
    expect(requestBody.messages?.[2]).toEqual({
      role: 'tool',
      content: '{"results":[]}',
      tool_call_id: 'call_1',
      name: 'mcp_call',
    });
  });

  it('keeps Kimi tool result messages non-empty', async () => {
    let requestBody: {
      messages?: Array<Record<string, unknown>>;
    } = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return makeSseResponse(['data: [DONE]\n']);
    }) as unknown as typeof globalThis.fetch;
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://api.moonshot.ai',
      apiKey: 'sk-test',
    });

    for await (const _ of adapter.streamCompletion({
      model: 'kimi-k2.6',
      messages: [
        { role: 'user', content: 'call tool' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'mcp_call', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', content: '', tool_call_id: 'call_1', name: 'mcp_call' },
      ],
    })) {
    }

    expect(requestBody.messages?.[1]).toMatchObject({
      role: 'assistant',
      reasoning_content: '',
    });
    expect(requestBody.messages?.[2]).toEqual({
      role: 'tool',
      content: '{}',
      tool_call_id: 'call_1',
      name: 'mcp_call',
    });
  });

  it('normalizes Kimi temperature to the only value accepted by Moonshot', async () => {
    let requestBody: {
      temperature?: number;
    } = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return makeSseResponse(['data: [DONE]\n']);
    }) as unknown as typeof globalThis.fetch;
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://api.moonshot.ai',
      apiKey: 'sk-test',
    });

    for await (const _ of adapter.streamCompletion({
      model: 'kimi-k2.6',
      messages: [{ role: 'user', content: 'titulo' }],
      extra: { temperature: 0.2, max_tokens: 60 },
    })) {
    }

    expect(requestBody.temperature).toBe(1);
  });
});
