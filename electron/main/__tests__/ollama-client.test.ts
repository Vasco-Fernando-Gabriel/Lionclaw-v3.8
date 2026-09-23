import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../local-tool-executor', () => ({
  executeLocalTool: vi.fn().mockResolvedValue({ result: 'tool-output', isError: false }),
  executeToolDispatch: vi.fn().mockResolvedValue({ result: 'dispatch-output', isError: false }),
}));

vi.mock('../mcp-tool-bridge', () => ({
  setupMCPsForSession: vi.fn().mockResolvedValue({ client: { connections: [] }, tools: [] }),
  teardownMCPsForSession: vi.fn().mockResolvedValue(undefined),
}));

function makeNonStreamingResponse(options: {
  content?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_cache_hit_tokens?: number;
    cache_hit_tokens?: number;
  };
  status?: number;
}): Response {
  const body = {
    model: 'test-model',
    choices: [
      {
        message: {
          content: options.content ?? null,
          tool_calls: options.tool_calls,
        },
      },
    ],
    usage: options.usage ?? { prompt_tokens: 100, completion_tokens: 50 },
  };

  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeOllamaResponse(options: {
  content?: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  eval_count?: number;
  prompt_eval_count?: number;
}): Response {
  const body = {
    model: 'test-model',
    message: {
      role: 'assistant',
      content: options.content ?? '',
      tool_calls: options.tool_calls,
    },
    eval_count: options.eval_count ?? 50,
    prompt_eval_count: options.prompt_eval_count ?? 100,
    done: true,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeStreamingResponse(sseChunks: string[]): Response {
  const fullBody = sseChunks.join('');
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(fullBody));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function sseChunk(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

import { ollamaChatWithTools } from '../ollama-client';
import type { OllamaToolSchema } from '../ollama-client';

const SIMPLE_TOOL: OllamaToolSchema = {
  type: 'function',
  function: {
    name: 'Read',
    description: 'Read a file',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
  },
};

describe('ollama-client: authHeaders', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        makeNonStreamingResponse({ content: 'Final answer', usage: { prompt_tokens: 100, completion_tokens: 50 } }),
      );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('inclui Authorization header quando authHeaders e passado', async () => {
    await ollamaChatWithTools(
      'https://openrouter.ai/api/v1',
      'deepseek/deepseek-v4-pro',
      'You are a coder.',
      'Write hello world',
      [],
      {
        provider: 'openai-compatible',
        authHeaders: { Authorization: 'Bearer sk-or-v1-test', 'X-Custom': 'header' },
      },
    );

    expect(fetchSpy).toHaveBeenCalled();
    const [, initArg] = fetchSpy.mock.calls[0];
    const headers = initArg?.headers as Record<string, string> | undefined;
    expect(headers?.['Authorization']).toBe('Bearer sk-or-v1-test');
    expect(headers?.['X-Custom']).toBe('header');
  });

  it('nao inclui Authorization quando authHeaders nao e passado', async () => {
    await ollamaChatWithTools('http://localhost:11434', 'llama3.1', 'You are a coder.', 'Write hello world', [], {
      provider: 'ollama',
    });

    expect(fetchSpy).toHaveBeenCalled();
    const [, initArg] = fetchSpy.mock.calls[0];
    const headers = initArg?.headers as Record<string, string> | undefined;
    expect(headers?.['Authorization']).toBeUndefined();
  });
});

describe('ollama-client: maxTokens', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let capturedBody: Record<string, unknown> = {};

  beforeEach(() => {
    capturedBody = {};
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
      capturedBody = body;
      return makeNonStreamingResponse({ content: 'Done' });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('injeta max_tokens para provider nao-Ollama', async () => {
    await ollamaChatWithTools('https://openrouter.ai/api/v1', 'deepseek/deepseek-v4-pro', '', 'Hello', [], {
      provider: 'openai-compatible',
      maxTokens: 4096,
    });

    expect(capturedBody.max_tokens).toBe(4096);
    expect((capturedBody.options as Record<string, unknown> | undefined)?.num_predict).toBeUndefined();
  });

  it('injeta num_predict para provider Ollama', async () => {
    await ollamaChatWithTools('http://localhost:11434', 'llama3.1', '', 'Hello', [], {
      provider: 'ollama',
      maxTokens: 2048,
    });

    const opts = capturedBody.options as Record<string, unknown> | undefined;
    expect(opts?.num_predict).toBe(2048);
    expect(capturedBody.max_tokens).toBeUndefined();
  });

  it('nao injeta max_tokens quando maxTokens nao e passado', async () => {
    await ollamaChatWithTools('https://openrouter.ai/api/v1', 'gpt-5.5', '', 'Hello', [], {
      provider: 'openai-compatible',
    });

    expect(capturedBody.max_tokens).toBeUndefined();
  });
});

describe('ollama-client: JSON.parse malformado em tool_call arguments', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('retorna {} para arguments malformados sem lancar erro', async () => {
    const toolCallsCapturados: Array<{ tool: string; input: Record<string, unknown> }> = [];

    let callCount = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return makeNonStreamingResponse({
          tool_calls: [
            {
              id: 'call_1',
              function: {
                name: 'Read',
                arguments: '{file_path: /tmp/file.txt}',
              },
            },
          ],
        });
      }
      return makeNonStreamingResponse({ content: 'Done after malformed args' });
    });

    const result = await ollamaChatWithTools(
      'https://openrouter.ai/api/v1',
      'test-model',
      '',
      'Read a file',
      [SIMPLE_TOOL],
      {
        provider: 'openai-compatible',
        onToolUse: (record) => {
          toolCallsCapturados.push({ tool: record.tool, input: record.input });
        },
      },
    );

    expect(toolCallsCapturados.length).toBeGreaterThan(0);
    expect(toolCallsCapturados[0].input).toEqual({});
    expect(result.content).toBe('Done after malformed args');
  });
});

describe('ollama-client: usage fields (cost, cache)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('extrai reported_cost_usd de usage.cost (OpenRouter)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeNonStreamingResponse({
        content: 'Done',
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          cost: 0.00125, // OpenRouter custo real
        },
      }),
    );

    const result = await ollamaChatWithTools(
      'https://openrouter.ai/api/v1',
      'deepseek/deepseek-v4-pro',
      '',
      'Hello',
      [],
      { provider: 'openai-compatible' },
    );

    expect(result.reportedCostUsd).toBeCloseTo(0.00125, 6);
  });

  it('extrai cache_hit_tokens de usage.prompt_cache_hit_tokens (DeepSeek)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeNonStreamingResponse({
        content: 'Done',
        usage: {
          prompt_tokens: 2000,
          completion_tokens: 300,
          prompt_cache_hit_tokens: 800,
        },
      }),
    );

    const result = await ollamaChatWithTools(
      'https://openrouter.ai/api/v1',
      'deepseek/deepseek-v4-pro',
      '',
      'Hello',
      [],
      { provider: 'openai-compatible' },
    );

    expect(result.cacheHitTokens).toBe(800);
  });

  it('extrai cache_hit_tokens de usage.cache_hit_tokens (MiniMax)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeNonStreamingResponse({
        content: 'Done',
        usage: {
          prompt_tokens: 3000,
          completion_tokens: 200,
          cache_hit_tokens: 600,
        },
      }),
    );

    const result = await ollamaChatWithTools('https://openrouter.ai/api/v1', 'minimax/minimax-m2.7', '', 'Hello', [], {
      provider: 'openai-compatible',
    });

    expect(result.cacheHitTokens).toBe(600);
  });

  it('reportedCostUsd e undefined quando usage.cost nao presente', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeNonStreamingResponse({
        content: 'Done',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    );

    const result = await ollamaChatWithTools('http://localhost:11434', 'llama3.1', '', 'Hello', [], {
      provider: 'ollama',
    });

    expect(result.reportedCostUsd).toBeUndefined();
  });
});

describe('ollama-client: apiRequests por round', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('apiRequests = 1 quando responde diretamente sem tool calls', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeNonStreamingResponse({ content: 'Done in one round' }));

    const result = await ollamaChatWithTools('http://localhost:11434', 'llama3.1', '', 'Hello', [], {
      provider: 'ollama',
    });

    expect(result.apiRequests).toBe(1);
  });

  it('apiRequests = 2 quando ha um round de tool call seguido de resposta final', async () => {
    let callCount = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return makeNonStreamingResponse({
          tool_calls: [{ id: 'call_1', function: { name: 'Read', arguments: '{"file_path":"/tmp/a"}' } }],
        });
      }
      return makeNonStreamingResponse({ content: 'Done after tool' });
    });

    const result = await ollamaChatWithTools('https://api.openai.com/v1', 'gpt-5.5', '', 'Read /tmp/a', [SIMPLE_TOOL], {
      provider: 'openai-compatible',
    });

    expect(result.apiRequests).toBe(2);
  });

  it('apiRequests = 3 para 2 rounds de tool call + resposta final', async () => {
    let callCount = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        return makeNonStreamingResponse({
          tool_calls: [{ id: `call_${callCount}`, function: { name: 'Read', arguments: '{"file_path":"/tmp/a"}' } }],
        });
      }
      return makeNonStreamingResponse({ content: 'Done' });
    });

    const result = await ollamaChatWithTools('https://api.openai.com/v1', 'gpt-5.5', '', 'Read files', [SIMPLE_TOOL], {
      provider: 'openai-compatible',
      maxRounds: 10,
    });

    expect(result.apiRequests).toBe(3);
  });
});

describe('ollama-client: tool_call delta accumulation (streaming)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('acumula tool_call com nome e arguments fragmentados em multiplos chunks', async () => {
    const sseRound1 = [
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_abc123',
                  type: 'function',
                  function: { name: 'Read', arguments: '' },
                },
              ],
            },
          },
        ],
      }),
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"file_' },
                },
              ],
            },
          },
        ],
      }),
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'path": "/tmp/test.ts"}' },
                },
              ],
            },
          },
        ],
      }),
      sseChunk({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      }),
      sseChunk({
        usage: { prompt_tokens: 200, completion_tokens: 50 },
      }),
      'data: [DONE]\n\n',
    ];

    const sseRound2 = [
      sseChunk({
        choices: [
          {
            delta: { content: 'File read done' },
            finish_reason: null,
          },
        ],
      }),
      sseChunk({
        choices: [{ delta: {}, finish_reason: 'stop' }],
      }),
      sseChunk({
        usage: { prompt_tokens: 250, completion_tokens: 30 },
      }),
      'data: [DONE]\n\n',
    ];

    let callCount = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return makeStreamingResponse(sseRound1);
      }
      return makeStreamingResponse(sseRound2);
    });

    const toolCallsCapturados: Array<{ tool: string; input: Record<string, unknown> }> = [];

    const result = await ollamaChatWithTools(
      'https://openrouter.ai/api/v1',
      'deepseek/deepseek-v4-pro',
      '',
      'Read file',
      [SIMPLE_TOOL],
      {
        provider: 'openai-compatible',
        streaming: true,
        onToolUse: (record) => toolCallsCapturados.push({ tool: record.tool, input: record.input }),
      },
    );

    expect(toolCallsCapturados.length).toBeGreaterThan(0);
    expect(toolCallsCapturados[0].tool).toBe('Read');
    expect(toolCallsCapturados[0].input).toEqual({ file_path: '/tmp/test.ts' });
    expect(result.content).toBe('File read done');
  });

  it('stream_options.include_usage esta no body quando streaming = true', async () => {
    let capturedBody: Record<string, unknown> = {};

    const sseSimple = [
      sseChunk({ choices: [{ delta: { content: 'Done' }, finish_reason: null }] }),
      sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      sseChunk({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      'data: [DONE]\n\n',
    ];

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
      return makeStreamingResponse(sseSimple);
    });

    await ollamaChatWithTools('https://openrouter.ai/api/v1', 'deepseek/deepseek-v4-pro', '', 'Hello', [], {
      provider: 'openai-compatible',
      streaming: true,
    });

    expect(capturedBody.stream).toBe(true);
    expect(capturedBody.stream_options).toBeDefined();
    expect((capturedBody.stream_options as Record<string, unknown>).include_usage).toBe(true);
  });

  it('preserva reasoning_content em assistant tool-call history para Kimi/Moonshot', async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const sseRound1 = [
      sseChunk({
        choices: [{ delta: { reasoning_content: 'Preciso ler o arquivo antes.' } }],
      }),
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_kimi_1',
                  type: 'function',
                  function: { name: 'Read', arguments: '{"file_path":"/tmp/a.ts"}' },
                },
              ],
            },
          },
        ],
      }),
      sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      sseChunk({ usage: { prompt_tokens: 20, completion_tokens: 8 } }),
      'data: [DONE]\n\n',
    ];
    const sseRound2 = [
      sseChunk({ choices: [{ delta: { content: 'Done' }, finish_reason: null }] }),
      sseChunk({ usage: { prompt_tokens: 30, completion_tokens: 5 } }),
      'data: [DONE]\n\n',
    ];

    let callCount = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBodies.push(JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>);
      callCount++;
      return makeStreamingResponse(callCount === 1 ? sseRound1 : sseRound2);
    });

    await ollamaChatWithTools('https://api.moonshot.ai/v1', 'kimi-k2.6', '', 'Read file', [SIMPLE_TOOL], {
      provider: 'kimi',
      streaming: true,
    });

    const secondMessages = capturedBodies[1].messages as Array<Record<string, unknown>>;
    const assistantToolMessage = secondMessages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    expect(assistantToolMessage?.reasoning_content).toBe('Preciso ler o arquivo antes.');
  });
});

describe('ollama-client: onTextDelta e onText callbacks (non-streaming)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('onText dispara uma vez com o conteudo final no round sem tool calls (Ollama)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeOllamaResponse({ content: 'Final response text' }));

    const onTextCalls: string[] = [];
    await ollamaChatWithTools('http://localhost:11434', 'llama3.1', '', 'Hello', [], {
      provider: 'ollama',
      onText: (text) => onTextCalls.push(text),
    });

    expect(onTextCalls).toHaveLength(1);
    expect(onTextCalls[0]).toBe('Final response text');
  });

  it('onText dispara uma vez com o conteudo final no round sem tool calls (openai-compatible)', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeNonStreamingResponse({ content: 'Final response text OAI' }));

    const onTextCalls: string[] = [];
    await ollamaChatWithTools('https://api.openai.com/v1', 'gpt-5.5', '', 'Hello', [], {
      provider: 'openai-compatible',
      onText: (text) => onTextCalls.push(text),
    });

    expect(onTextCalls).toHaveLength(1);
    expect(onTextCalls[0]).toBe('Final response text OAI');
  });

  it('onText nao dispara para rounds intermediarios com tool calls', async () => {
    let callCount = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return makeNonStreamingResponse({
          content: 'Calling tool...',
          tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{"file_path":"/f"}' } }],
        });
      }
      return makeNonStreamingResponse({ content: 'Done' });
    });

    const onTextCalls: string[] = [];
    await ollamaChatWithTools('https://api.openai.com/v1', 'gpt-5.5', '', 'Read a file', [SIMPLE_TOOL], {
      provider: 'openai-compatible',
      onText: (text) => onTextCalls.push(text),
    });

    expect(onTextCalls).toHaveLength(1);
    expect(onTextCalls[0]).toBe('Done');
  });
});
