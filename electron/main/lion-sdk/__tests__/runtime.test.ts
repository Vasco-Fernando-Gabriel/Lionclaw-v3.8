import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  insertAuditEntry: vi.fn(),
  upsertActivityLog: vi.fn(),
}));
vi.mock('../../artifact-detector', () => ({
  captureToolUse: vi.fn(() => null),
  captureToolResult: vi.fn(() => null),
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { MAX_CONSECUTIVE_TOOL_ERRORS, MAX_TOOL_TURNS, runLionLoop, type LionToolDispatcher } from '../runtime';
import type { LionAdapter, LionStreamEvent, LionStreamRequest } from '../adapters/types';
import { createLionStreamTranslator } from '../stream-translator';
import type { StreamChunk } from '../../../../src/types';

function makeAdapter(eventsFor: (n: number) => LionStreamEvent[]): { adapter: LionAdapter; turn: () => number } {
  let turn = 0;
  return {
    turn: () => turn,
    adapter: {
      name: 'ollama',
      async *streamCompletion(_req: LionStreamRequest): AsyncIterable<LionStreamEvent> {
        const evs = eventsFor(turn);
        turn++;
        for (const ev of evs) yield ev;
      },
    },
  };
}

function captureChunks(): { chunks: StreamChunk[]; emit: (c: StreamChunk) => void } {
  const chunks: StreamChunk[] = [];
  return { chunks, emit: (c) => chunks.push(c) };
}

describe('Lion-SDK runtime loop', () => {
  it('emits usage + done when no tool calls are made', async () => {
    const { adapter } = makeAdapter(() => [
      { type: 'text', delta: 'oi' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      { type: 'done' },
    ]);
    const { chunks, emit } = captureChunks();
    const translator = createLionStreamTranslator({ sessionId: 's', emit });
    const dispatcher: LionToolDispatcher = async () => ({ content: '' });

    const r = await runLionLoop({
      adapter,
      model: 'm',
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      dispatcher,
      translator,
    });
    expect(r.ok).toBe(true);
    expect(chunks.find((c) => c.type === 'done')).toBeDefined();
    expect(chunks.find((c) => c.type === 'usage')).toBeDefined();
    expect(r.finalText).toBe('oi');
  });

  it('stops at MAX_TOOL_TURNS', async () => {
    const { adapter } = makeAdapter(() => [
      {
        type: 'tool_call_delta',
        toolCalls: [
          {
            id: 'c',
            type: 'function',
            function: { name: 'Read', arguments: JSON.stringify({ file_path: '/a' }) },
          },
        ],
      },
      { type: 'done' },
    ]);
    const { emit } = captureChunks();
    const translator = createLionStreamTranslator({ sessionId: 's', emit });
    const dispatcher: LionToolDispatcher = async () => ({ content: 'ok' });
    const r = await runLionLoop({
      adapter,
      model: 'm',
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      dispatcher,
      translator,
      maxToolTurns: 3,
    });
    expect(r.ok).toBe(false);
    expect(r.errorReason).toBe('max-turns');
    expect(MAX_TOOL_TURNS).toBeGreaterThanOrEqual(30);
  });

  it('stops at MAX_CONSECUTIVE_TOOL_ERRORS', async () => {
    const { adapter } = makeAdapter(() => [
      {
        type: 'tool_call_delta',
        toolCalls: [
          {
            id: 'c',
            type: 'function',
            function: { name: 'Read', arguments: JSON.stringify({ file_path: '/a' }) },
          },
        ],
      },
      { type: 'done' },
    ]);
    const { emit } = captureChunks();
    const translator = createLionStreamTranslator({ sessionId: 's', emit });
    const dispatcher: LionToolDispatcher = async () => ({ content: 'erro', isError: true });
    const r = await runLionLoop({
      adapter,
      model: 'm',
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      dispatcher,
      translator,
      maxConsecutiveToolErrors: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.errorReason).toBe('max-tool-errors');
    expect(MAX_CONSECUTIVE_TOOL_ERRORS).toBeGreaterThanOrEqual(3);
  });

  it('respects abortSignal before invoking the adapter', async () => {
    const { adapter } = makeAdapter(() => [{ type: 'done' }]);
    const ac = new AbortController();
    ac.abort();
    const { emit } = captureChunks();
    const translator = createLionStreamTranslator({ sessionId: 's', emit });
    const r = await runLionLoop({
      adapter,
      model: 'm',
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      dispatcher: async () => ({ content: '' }),
      translator,
      abortSignal: ac.signal,
    });
    expect(r.ok).toBe(false);
    expect(r.errorReason).toBe('abort');
  });

  it('reports adapter errors and stops', async () => {
    const { adapter } = makeAdapter(() => [{ type: 'error', error: 'boom' }]);
    const { chunks, emit } = captureChunks();
    const translator = createLionStreamTranslator({ sessionId: 's', emit });
    const r = await runLionLoop({
      adapter,
      model: 'm',
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      dispatcher: async () => ({ content: '' }),
      translator,
    });
    expect(r.ok).toBe(false);
    expect(r.errorReason).toBe('adapter-error');
    expect(chunks.find((c) => c.type === 'error')).toBeDefined();
  });

  it('labels mcp_call tool chunks with server and tool name', async () => {
    const { adapter } = makeAdapter((turn) =>
      turn === 0
        ? [
            {
              type: 'tool_call_delta',
              toolCalls: [
                {
                  id: 'mcp-1',
                  type: 'function',
                  function: {
                    name: 'mcp_call',
                    arguments: JSON.stringify({
                      server_id: 'excalidraw',
                      tool: 'create_view',
                      args: { elements: [] },
                    }),
                  },
                },
              ],
            },
            { type: 'done' },
          ]
        : [{ type: 'text', delta: 'feito' }, { type: 'done' }],
    );
    const { chunks, emit } = captureChunks();
    const translator = createLionStreamTranslator({ sessionId: 's', emit });
    const dispatcher: LionToolDispatcher = async () => ({ content: 'ok' });

    const r = await runLionLoop({
      adapter,
      model: 'm',
      initialMessages: [{ role: 'user', content: 'draw' }],
      tools: [],
      dispatcher,
      translator,
      maxToolTurns: 3,
    });

    expect(r.ok).toBe(true);
    const toolCall = chunks.find((c) => c.type === 'tool_call');
    const toolResult = chunks.find((c) => c.type === 'tool_result');
    expect(toolCall?.tool).toBe('mcp:excalidraw.create_view');
    expect(toolResult?.tool).toBe('mcp:excalidraw.create_view');
  });

  it('can defer fenced fallback tool text and drop it from tool-call transcript turns', async () => {
    const { adapter } = makeAdapter((turn) =>
      turn === 0
        ? [
            {
              type: 'text',
              delta:
                '```LION_TOOL_USE\n{"calls":[{"id":"call_memory_onboarding_3","name":"mcp_call","input":{"server_id":"memory-search","tool":"memory_search","args":{"query":"onboarding"}}}]}\n```\nAinda nenhum resultado.',
            },
            { type: 'done' },
          ]
        : [{ type: 'text', delta: 'Achei a memoria.' }, { type: 'done' }],
    );
    const { chunks, emit } = captureChunks();
    const translator = createLionStreamTranslator({ sessionId: 's', emit });
    const dispatcher: LionToolDispatcher = async () => ({ content: '{"results":[{"content":"onboarding"}]}' });

    const r = await runLionLoop({
      adapter,
      model: 'kimi-k2.6',
      initialMessages: [{ role: 'user', content: 'busca onboarding' }],
      tools: [],
      dispatcher,
      translator,
      maxToolTurns: 3,
      deferTextUntilToolParse: true,
      dropTextWhenToolCalls: true,
    });

    expect(r.ok).toBe(true);
    expect(
      chunks
        .filter((c) => c.type === 'text')
        .map((c) => c.content)
        .join(''),
    ).toBe('Achei a memoria.');
    expect(chunks.find((c) => c.type === 'tool_call')?.tool).toBe('mcp:memory-search.memory_search');
    const assistantWithTool = r.transcript.find((msg) => msg.role === 'assistant' && msg.tool_calls);
    expect(assistantWithTool?.content).toBe('');
    expect(JSON.stringify(chunks)).not.toContain('LION_TOOL_USE');
    expect(JSON.stringify(chunks)).not.toContain('Ainda nenhum resultado');
  });

  it('stores normalized tool call ids in transcript so providers can correlate results', async () => {
    const { adapter } = makeAdapter((turn) =>
      turn === 0
        ? [
            {
              type: 'tool_call_delta',
              toolCalls: [
                {
                  type: 'function',
                  function: { name: 'Read', arguments: JSON.stringify({ file_path: '/tmp/a.txt' }) },
                },
              ],
            },
            { type: 'done' },
          ]
        : [{ type: 'text', delta: 'li o arquivo' }, { type: 'done' }],
    );
    const { emit } = captureChunks();
    const translator = createLionStreamTranslator({ sessionId: 's', emit });
    const dispatcher: LionToolDispatcher = async () => ({ content: 'conteudo' });

    const r = await runLionLoop({
      adapter,
      model: 'm',
      initialMessages: [{ role: 'user', content: 'read' }],
      tools: [],
      dispatcher,
      translator,
      maxToolTurns: 3,
    });

    expect(r.ok).toBe(true);
    const assistantWithTool = r.transcript.find((msg) => msg.role === 'assistant' && msg.tool_calls);
    const toolResult = r.transcript.find((msg) => msg.role === 'tool');
    const callId = assistantWithTool?.tool_calls?.[0]?.id;
    expect(callId).toMatch(/^lion_call_/);
    expect(toolResult?.tool_call_id).toBe(callId);
  });

  it('preserves native tool call payloads in transcript for strict OpenAI-compatible providers', async () => {
    const rawArguments = '{ "server_id": "memory-search", "tool": "memory_search", "args": { "query": "projeto" } }';
    const { adapter } = makeAdapter((turn) =>
      turn === 0
        ? [
            { type: 'reasoning', delta: 'preciso consultar a memoria' },
            {
              type: 'tool_call_delta',
              toolCalls: [
                {
                  index: 0,
                  id: 'mcp_call:0',
                  type: 'function',
                  function: {
                    name: 'mcp_call',
                    arguments: rawArguments,
                  },
                },
              ],
            },
            { type: 'done' },
          ]
        : [{ type: 'text', delta: 'achei memoria' }, { type: 'done' }],
    );
    const { emit } = captureChunks();
    const translator = createLionStreamTranslator({ sessionId: 's', emit });
    const dispatcher: LionToolDispatcher = async () => ({ content: '{"results":[]}' });

    const r = await runLionLoop({
      adapter,
      model: 'm',
      initialMessages: [{ role: 'user', content: 'search memory' }],
      tools: [],
      dispatcher,
      translator,
      maxToolTurns: 3,
    });

    expect(r.ok).toBe(true);
    const assistantWithTool = r.transcript.find((msg) => msg.role === 'assistant' && msg.tool_calls);
    expect(assistantWithTool?.tool_calls?.[0]).toEqual({
      index: 0,
      id: 'mcp_call:0',
      type: 'function',
      function: {
        name: 'mcp_call',
        arguments: rawArguments,
      },
    });
    expect(assistantWithTool?.reasoning_content).toBe('preciso consultar a memoria');
    const toolResult = r.transcript.find((msg) => msg.role === 'tool');
    expect(toolResult?.tool_call_id).toBe('mcp_call:0');
  });

  it('preserves provider metadata on native tool calls for adapter replay', async () => {
    const { adapter } = makeAdapter((turn) =>
      turn === 0
        ? [
            {
              type: 'tool_call_delta',
              toolCalls: [
                {
                  index: 0,
                  id: 'gemini_call_1_0',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: JSON.stringify({ command: 'echo ok' }),
                  },
                  providerMetadata: {
                    googleGenAi: { thoughtSignature: 'sig-123' },
                  },
                },
              ],
            },
            { type: 'done' },
          ]
        : [{ type: 'text', delta: 'ok' }, { type: 'done' }],
    );
    const { emit } = captureChunks();
    const translator = createLionStreamTranslator({ sessionId: 's', emit });
    const dispatcher: LionToolDispatcher = async () => ({ content: 'exit=0\nok' });

    const r = await runLionLoop({
      adapter,
      model: 'm',
      initialMessages: [{ role: 'user', content: 'run echo' }],
      tools: [],
      dispatcher,
      translator,
      maxToolTurns: 3,
    });

    expect(r.ok).toBe(true);
    const assistantWithTool = r.transcript.find((msg) => msg.role === 'assistant' && msg.tool_calls);
    expect(assistantWithTool?.tool_calls?.[0]?.providerMetadata).toEqual({
      googleGenAi: { thoughtSignature: 'sig-123' },
    });
  });
});
