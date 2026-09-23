import { describe, it, expect, vi, beforeEach } from 'vitest';

const { generateContentStreamMock, insertAuditEntryMock, googleGenAIConstructorMock } = vi.hoisted(() => ({
  generateContentStreamMock: vi.fn(),
  insertAuditEntryMock: vi.fn(),
  googleGenAIConstructorMock: vi.fn(),
}));

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = { generateContentStream: generateContentStreamMock };

    constructor(options: unknown) {
      googleGenAIConstructorMock(options);
    }
  }
  return {
    GoogleGenAI,
    FunctionCallingConfigMode: { AUTO: 'AUTO' },
    Type: {
      STRING: 'STRING',
      NUMBER: 'NUMBER',
      INTEGER: 'INTEGER',
      BOOLEAN: 'BOOLEAN',
      ARRAY: 'ARRAY',
      OBJECT: 'OBJECT',
    },
  };
});

vi.mock('../../../db', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orig: any = await importOriginal();
  return {
    ...orig,
    insertAuditEntry: insertAuditEntryMock,
  };
});

import { createGoogleGenAiAdapter } from '../google-genai';
import { createLionStreamTranslator } from '../../stream-translator';
import type { LionStreamEvent, LionChatMessage } from '../types';
import type { StreamChunk } from '../../../../../src/types';

async function* asyncGenFrom<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

async function drain(iter: AsyncIterable<LionStreamEvent>): Promise<LionStreamEvent[]> {
  const out: LionStreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

beforeEach(() => {
  generateContentStreamMock.mockReset();
  insertAuditEntryMock.mockReset();
  googleGenAIConstructorMock.mockReset();
});

describe('createGoogleGenAiAdapter', () => {
  describe('S4.5 — basic streaming', () => {
    it('emits text deltas from chunk.text and done at end', async () => {
      generateContentStreamMock.mockResolvedValue(asyncGenFrom([{ text: 'Hello' }, { text: ' world' }, { text: '!' }]));
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      const events = await drain(adapter.streamCompletion({ model: 'gemini-3-flash-preview', messages: [] }));
      expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)).toEqual([
        'Hello',
        ' world',
        '!',
      ]);
      expect(events.at(-1)).toEqual({ type: 'done' });
    });

    it('errors when apiKey is empty', async () => {
      const adapter = createGoogleGenAiAdapter({ apiKey: '' });
      const events = await drain(adapter.streamCompletion({ model: 'gemini-3-flash-preview', messages: [] }));
      expect(events).toEqual([{ type: 'error', error: expect.stringMatching(/requer apiKey/) }]);
    });
  });

  describe('S4.5 — usage normalization', () => {
    it('sums promptTokenCount + toolUsePromptTokenCount for input', async () => {
      generateContentStreamMock.mockResolvedValue(
        asyncGenFrom([
          {
            text: '',
            usageMetadata: {
              promptTokenCount: 100,
              toolUsePromptTokenCount: 50,
              candidatesTokenCount: 200,
              thoughtsTokenCount: 75,
            },
          },
        ]),
      );
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      const events = await drain(adapter.streamCompletion({ model: 'gemini-3-flash-preview', messages: [] }));
      const usage = events.find((e) => e.type === 'usage') as
        { type: 'usage'; usage: { inputTokens: number; outputTokens: number } } | undefined;
      expect(usage).toBeDefined();
      expect(usage!.usage.inputTokens).toBe(150);
      expect(usage!.usage.outputTokens).toBe(275);
    });

    it('does NOT include cachedContentTokenCount in inputTokens', async () => {
      generateContentStreamMock.mockResolvedValue(
        asyncGenFrom([
          {
            text: '',
            usageMetadata: {
              promptTokenCount: 100,
              cachedContentTokenCount: 30,
              candidatesTokenCount: 200,
            },
          },
        ]),
      );
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      const events = await drain(adapter.streamCompletion({ model: 'gemini-3-flash-preview', messages: [] }));
      const usage = events.find((e) => e.type === 'usage') as
        { type: 'usage'; usage: { inputTokens: number; outputTokens: number } } | undefined;
      expect(usage!.usage.inputTokens).toBe(100);
    });

    it('does NOT include totalTokenCount (avoid double-count)', async () => {
      generateContentStreamMock.mockResolvedValue(
        asyncGenFrom([
          {
            text: '',
            usageMetadata: {
              promptTokenCount: 50,
              candidatesTokenCount: 50,
              totalTokenCount: 999, // suspicious -- must be ignored
            },
          },
        ]),
      );
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      const events = await drain(adapter.streamCompletion({ model: 'gemini-3-flash-preview', messages: [] }));
      const usage = events.find((e) => e.type === 'usage') as
        { type: 'usage'; usage: { inputTokens: number; outputTokens: number } } | undefined;
      expect(usage!.usage.inputTokens).toBe(50);
      expect(usage!.usage.outputTokens).toBe(50);
    });
  });

  describe('S4.5 — safety + finishReason handling', () => {
    it('promptFeedback.blockReason -> error event, stops consuming', async () => {
      generateContentStreamMock.mockResolvedValue(
        asyncGenFrom([{ promptFeedback: { blockReason: 'SAFETY' } }, { text: 'should-not-reach' }]),
      );
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      const events = await drain(adapter.streamCompletion({ model: 'gemini-3-flash-preview', messages: [] }));
      const err = events.find((e) => e.type === 'error');
      expect(err).toBeDefined();
      expect(events.find((e) => e.type === 'text')).toBeUndefined();
    });

    it('finishReason MALFORMED_FUNCTION_CALL -> error event', async () => {
      generateContentStreamMock.mockResolvedValue(
        asyncGenFrom([{ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', content: { parts: [] } }] }]),
      );
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      const events = await drain(adapter.streamCompletion({ model: 'gemini-3-flash-preview', messages: [] }));
      const err = events.find((e) => e.type === 'error') as { error: string } | undefined;
      expect(err).toBeDefined();
      expect(err!.error).toMatch(/invalid tool call/);
    });

    it('finishReason MAX_TOKENS is NOT an error', async () => {
      generateContentStreamMock.mockResolvedValue(
        asyncGenFrom([
          { text: 'partial response' },
          { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] },
        ]),
      );
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      const events = await drain(adapter.streamCompletion({ model: 'gemini-3-flash-preview', messages: [] }));
      expect(events.find((e) => e.type === 'error')).toBeUndefined();
      expect(events.at(-1)).toEqual({ type: 'done' });
    });
  });

  describe('S4.5 — empty candidate defense (S2.9b)', () => {
    it('emits error when stream ends with no text, no functionCall, no finishReason', async () => {
      generateContentStreamMock.mockResolvedValue(asyncGenFrom([]));
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      const events = await drain(adapter.streamCompletion({ model: 'gemini-3-flash-preview', messages: [] }));
      const err = events.find((e) => e.type === 'error') as { error: string } | undefined;
      expect(err).toBeDefined();
      expect(err!.error).toMatch(/empty response/);
    });
  });

  describe('S4.5 — tool call emission', () => {
    it('emits tool_call_delta when chunk contains a functionCall part', async () => {
      generateContentStreamMock.mockResolvedValue(
        asyncGenFrom([
          {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: { name: 'Read', args: { file_path: '/tmp/foo' } },
                      thoughtSignature: 'sig-abc',
                    },
                  ],
                },
              },
            ],
          },
        ]),
      );
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      const events = await drain(adapter.streamCompletion({ model: 'gemini-3-flash-preview', messages: [] }));
      const tc = events.find((e) => e.type === 'tool_call_delta') as
        | {
            type: 'tool_call_delta';
            toolCalls: Array<{
              id: string;
              function: { name: string; arguments: string };
              providerMetadata?: { googleGenAi?: { thoughtSignature?: string } };
            }>;
          }
        | undefined;
      expect(tc).toBeDefined();
      expect(tc!.toolCalls[0].function.name).toBe('Read');
      expect(JSON.parse(tc!.toolCalls[0].function.arguments)).toEqual({ file_path: '/tmp/foo' });
      expect(tc!.toolCalls[0].providerMetadata).toEqual({
        googleGenAi: { thoughtSignature: 'sig-abc' },
      });
      expect(tc!.toolCalls[0].id).toMatch(/^gemini_call_\d+_\d+$/);
    });

    it('prefers SDK-provided FunctionCall.id when present', async () => {
      generateContentStreamMock.mockResolvedValue(
        asyncGenFrom([
          {
            candidates: [
              {
                content: {
                  parts: [{ functionCall: { id: 'sdk-id-xyz', name: 'Glob', args: { pattern: '*.ts' } } }],
                },
              },
            ],
          },
        ]),
      );
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      const events = await drain(adapter.streamCompletion({ model: 'gemini-3-flash-preview', messages: [] }));
      const tc = events.find((e) => e.type === 'tool_call_delta') as { toolCalls: Array<{ id: string }> } | undefined;
      expect(tc!.toolCalls[0].id).toBe('sdk-id-xyz');
    });
  });

  describe('S4.5 — abort behavior', () => {
    it('emits abort error when signal already aborted during stream', async () => {
      const controller = new AbortController();
      generateContentStreamMock.mockImplementation(async () => {
        controller.abort();
        return asyncGenFrom([{ text: 'should-not-stream' }]);
      });
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      const events = await drain(
        adapter.streamCompletion({
          model: 'gemini-3-flash-preview',
          messages: [],
          abortSignal: controller.signal,
        }),
      );
      expect(events.find((e) => e.type === 'text')).toBeUndefined();
      const err = events.find((e) => e.type === 'error');
      expect(err).toBeDefined();
    });
  });

  describe('S4.7c — region mismatch surfaces clear error', () => {
    it('SDK throw with location hint maps to "Try global" message', async () => {
      generateContentStreamMock.mockImplementation(async () => {
        throw {
          status: 400,
          code: 'INVALID_ARGUMENT',
          message: 'Model gemini-3-flash-preview is not available in location us-east1',
        };
      });
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      const events = await drain(adapter.streamCompletion({ model: 'gemini-3-flash-preview', messages: [] }));
      const err = events.find((e) => e.type === 'error') as { error: string } | undefined;
      expect(err).toBeDefined();
      expect(err!.error).toMatch(/location/i);
      expect(err!.error).toMatch(/global/i);
    });
  });

  describe('S4.5 — request shape sanity', () => {
    it('initializes express API-key client without project or location', async () => {
      generateContentStreamMock.mockResolvedValue(asyncGenFrom([{ text: 'ok' }]));
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      await drain(adapter.streamCompletion({ model: 'gemini-3-flash-preview', messages: [] }));

      expect(googleGenAIConstructorMock).toHaveBeenCalledWith({
        vertexai: true,
        apiKey: 'k',
      });
      const opts = googleGenAIConstructorMock.mock.calls[0][0] as Record<string, unknown>;
      expect(opts).not.toHaveProperty('location');
      expect(opts).not.toHaveProperty('project');
    });

    it('passes systemInstruction merged from system messages', async () => {
      generateContentStreamMock.mockResolvedValue(asyncGenFrom([{ text: 'ok' }]));
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      const messages: LionChatMessage[] = [
        { role: 'system', content: 'part1' },
        { role: 'system', content: 'part2' },
        { role: 'user', content: 'hi' },
      ];
      await drain(adapter.streamCompletion({ model: 'gemini-3-flash-preview', messages }));
      const call = generateContentStreamMock.mock.calls[0][0];
      expect(call.config.systemInstruction).toBe('part1\n\npart2');
      expect(call.contents[0]).toEqual({ role: 'user', parts: [{ text: 'hi' }] });
    });

    it('omits config.tools when req.tools is undefined', async () => {
      generateContentStreamMock.mockResolvedValue(asyncGenFrom([{ text: 'ok' }]));
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      await drain(adapter.streamCompletion({ model: 'gemini-3-flash-preview', messages: [] }));
      const call = generateContentStreamMock.mock.calls[0][0];
      expect(call.config.tools).toBeUndefined();
      expect(call.config.toolConfig).toBeUndefined();
    });

    it('maps tool message to functionResponse part on user role', async () => {
      generateContentStreamMock.mockResolvedValue(asyncGenFrom([{ text: 'ok' }]));
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      const messages: LionChatMessage[] = [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'tc-1',
              type: 'function',
              function: { name: 'Read', arguments: '{"file_path":"/x"}' },
            },
          ],
        },
        {
          role: 'tool',
          content: 'file contents here',
          tool_call_id: 'tc-1',
          name: 'Read',
        },
      ];
      await drain(adapter.streamCompletion({ model: 'gemini-3-flash-preview', messages }));
      const call = generateContentStreamMock.mock.calls[0][0];
      const lastContent = call.contents[call.contents.length - 1];
      expect(lastContent.role).toBe('user');
      expect(lastContent.parts[0].functionResponse).toEqual({
        id: 'tc-1',
        name: 'Read',
        response: { output: 'file contents here' },
      });
    });

    it('groups consecutive tool messages into one Gemini functionResponse content', async () => {
      generateContentStreamMock.mockResolvedValue(asyncGenFrom([{ text: 'ok' }]));
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      const messages: LionChatMessage[] = [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'tc-1',
              type: 'function',
              function: { name: 'Bash', arguments: '{"command":"pwd"}' },
            },
            {
              id: 'tc-2',
              type: 'function',
              function: {
                name: 'mcp_call',
                arguments: '{"server_id":"excalidraw","tool":"create_view","args":{"elements":[]}}',
              },
            },
          ],
        },
        {
          role: 'tool',
          content: 'exit=0\n/path',
          tool_call_id: 'tc-1',
          name: 'Bash',
        },
        {
          role: 'tool',
          content: '{"viewId":"v1"}',
          tool_call_id: 'tc-2',
          name: 'mcp:excalidraw.create_view',
        },
        { role: 'user', content: 'continue' },
      ];

      await drain(adapter.streamCompletion({ model: 'gemini-3.1-pro-preview', messages }));
      const call = generateContentStreamMock.mock.calls[0][0];
      expect(call.contents[1]).toEqual({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'tc-1',
              name: 'Bash',
              response: { output: 'exit=0\n/path' },
            },
          },
          {
            functionResponse: {
              id: 'tc-2',
              name: 'mcp_call',
              response: { output: '{"viewId":"v1"}' },
            },
          },
        ],
      });
      expect(call.contents[2]).toEqual({ role: 'user', parts: [{ text: 'continue' }] });
    });

    it('replays Gemini thoughtSignature and original function name across tool turns', async () => {
      generateContentStreamMock.mockResolvedValue(asyncGenFrom([{ text: 'ok' }]));
      const adapter = createGoogleGenAiAdapter({ apiKey: 'k' });
      const messages: LionChatMessage[] = [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'tc-mcp',
              type: 'function',
              function: {
                name: 'mcp_call',
                arguments: '{"server_id":"memory-search","tool":"memory_search","args":{"query":"x"}}',
              },
              providerMetadata: {
                googleGenAi: { thoughtSignature: 'sig-mcp' },
              },
            },
          ],
        },
        {
          role: 'tool',
          content: '{"results":[]}',
          tool_call_id: 'tc-mcp',
          name: 'mcp:memory-search.memory_search',
        },
      ];
      await drain(adapter.streamCompletion({ model: 'gemini-3.1-pro-preview', messages }));
      const call = generateContentStreamMock.mock.calls[0][0];
      expect(call.contents[0].parts[0]).toEqual({
        functionCall: {
          id: 'tc-mcp',
          name: 'mcp_call',
          args: { server_id: 'memory-search', tool: 'memory_search', args: { query: 'x' } },
        },
        thoughtSignature: 'sig-mcp',
      });
      expect(call.contents[1].parts[0].functionResponse).toEqual({
        id: 'tc-mcp',
        name: 'mcp_call',
        response: { output: '{"results":[]}' },
      });
    });
  });
});

describe('S4.7b — audit reach via stream-translator (provider-agnostic)', () => {
  it('emitToolCall through createLionStreamTranslator triggers insertAuditEntry', () => {
    const emitted: StreamChunk[] = [];
    const translator = createLionStreamTranslator({
      sessionId: 'session-x',
      emit: (chunk) => emitted.push(chunk),
      subagent: undefined,
    });

    translator.emitToolCall('tc-vertex-1', 'Read', { file_path: '/tmp/x' });

    expect(insertAuditEntryMock).toHaveBeenCalledTimes(1);
    const call = insertAuditEntryMock.mock.calls[0][0];
    expect(call.sessionId).toBe('session-x');
    expect(call.eventType).toBe('tool_call');
    expect(call.toolName).toBe('Read');
    expect(typeof call.input).toBe('string');

    expect(emitted.find((e) => e.type === 'tool_call')).toBeDefined();
  });
});
