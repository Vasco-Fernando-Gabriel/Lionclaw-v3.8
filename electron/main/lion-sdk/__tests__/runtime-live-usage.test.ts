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

import { runLionLoop, type LionToolDispatcher } from '../runtime';
import type { LionAdapter, LionStreamEvent, LionStreamRequest } from '../adapters/types';
import { createLionStreamTranslator } from '../stream-translator';
import type { StreamChunk } from '../../../../src/types';

function makeMultiTurnAdapter(turns: LionStreamEvent[][]): LionAdapter {
  let turnIdx = 0;
  return {
    name: 'ollama',
    async *streamCompletion(_req: LionStreamRequest): AsyncIterable<LionStreamEvent> {
      const evs = turns[turnIdx] ?? [];
      turnIdx++;
      for (const ev of evs) yield ev;
    },
  };
}

function captureChunks(): { chunks: StreamChunk[]; emit: (c: StreamChunk) => void } {
  const chunks: StreamChunk[] = [];
  return { chunks, emit: (c) => chunks.push(c) };
}

describe('Lion-SDK runtime - S5.4 progressive usage forwarding', () => {
  it('calls emitUsage once per adapter usage event with cumulative totals', async () => {
    const adapter = makeMultiTurnAdapter([
      [
        {
          type: 'tool_call_delta',
          toolCalls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'Bash', arguments: JSON.stringify({ command: 'echo hi' }) },
            },
          ],
        },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
        { type: 'done' },
      ],
      [
        { type: 'text', delta: 'done' },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 8 } },
        { type: 'done' },
      ],
    ]);

    const { chunks, emit } = captureChunks();
    const translator = createLionStreamTranslator({ sessionId: 'sess-test', emit });
    const dispatcher: LionToolDispatcher = async () => ({ content: 'output' });

    const result = await runLionLoop({
      adapter,
      model: 'llama3.1',
      initialMessages: [{ role: 'user', content: 'run' }],
      tools: [],
      dispatcher,
      translator,
    });

    expect(result.ok).toBe(true);

    const usageChunks = chunks.filter((c) => c.type === 'usage') as Array<{
      type: 'usage';
      usage: { inputTokens: number; outputTokens: number };
    }>;

    expect(usageChunks).toHaveLength(2);

    expect(usageChunks[0]!.usage.inputTokens).toBe(10);
    expect(usageChunks[0]!.usage.outputTokens).toBe(20);

    expect(usageChunks[1]!.usage.inputTokens).toBe(15);
    expect(usageChunks[1]!.usage.outputTokens).toBe(28);
  });

  it('total in RunLionLoopResult.usage equals sum of adapter usage events', async () => {
    const adapter = makeMultiTurnAdapter([
      [
        {
          type: 'tool_call_delta',
          toolCalls: [
            {
              id: 'c2',
              type: 'function',
              function: { name: 'Read', arguments: JSON.stringify({ file_path: '/a' }) },
            },
          ],
        },
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } },
        { type: 'done' },
      ],
      [
        { type: 'text', delta: 'finished' },
        { type: 'usage', usage: { inputTokens: 30, outputTokens: 20 } },
        { type: 'done' },
      ],
    ]);

    const { emit } = captureChunks();
    const translator = createLionStreamTranslator({ sessionId: 's2', emit });
    const dispatcher: LionToolDispatcher = async () => ({ content: 'ok' });

    const result = await runLionLoop({
      adapter,
      model: 'qwen',
      initialMessages: [{ role: 'user', content: 'x' }],
      tools: [],
      dispatcher,
      translator,
    });

    expect(result.ok).toBe(true);
    expect(result.usage.inputTokens).toBe(130);
    expect(result.usage.outputTokens).toBe(70);
  });

  it('no double-counting: emitUsage not called again after last turn', async () => {
    const adapter = makeMultiTurnAdapter([
      [
        { type: 'text', delta: 'hello' },
        { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } },
        { type: 'done' },
      ],
    ]);

    const { chunks, emit } = captureChunks();
    const translator = createLionStreamTranslator({ sessionId: 's3', emit });
    const dispatcher: LionToolDispatcher = async () => ({ content: '' });

    await runLionLoop({
      adapter,
      model: 'm',
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      dispatcher,
      translator,
    });

    const usageChunks = chunks.filter((c) => c.type === 'usage');
    expect(usageChunks).toHaveLength(1);

    const u = usageChunks[0] as { usage: { inputTokens: number; outputTokens: number } };
    expect(u.usage.inputTokens).toBe(7);
    expect(u.usage.outputTokens).toBe(3);
  });

  it('emits prompt context estimate and provider occupancy when context window is configured', async () => {
    const adapter = makeMultiTurnAdapter([
      [
        { type: 'text', delta: 'hello' },
        { type: 'usage', usage: { inputTokens: 120, outputTokens: 8 } },
        { type: 'done' },
      ],
    ]);

    const { chunks, emit } = captureChunks();
    const translator = createLionStreamTranslator({ sessionId: 'ctx', emit });
    const dispatcher: LionToolDispatcher = async () => ({ content: '' });

    await runLionLoop({
      adapter,
      model: 'm',
      initialMessages: [{ role: 'user', content: 'hi there' }],
      tools: [],
      dispatcher,
      translator,
      contextWindowTokens: 1000,
      compactionThresholdPercent: 72,
    });

    const contextChunks = chunks.filter((c) => c.type === 'context_usage');
    expect(contextChunks).toHaveLength(2);
    expect(contextChunks[0]!.contextUsage).toMatchObject({
      contextWindowTokens: 1000,
      compactionThresholdPercent: 72,
      source: 'estimate',
    });
    expect(contextChunks[0]!.contextUsage!.contextTokens).toBeGreaterThan(0);
    expect(contextChunks[1]!.contextUsage).toEqual({
      contextTokens: 128,
      contextWindowTokens: 1000,
      compactionThresholdPercent: 72,
      source: 'provider',
    });
  });

  it('handles adapter that emits no usage event gracefully (usage stays zero)', async () => {
    const adapter = makeMultiTurnAdapter([[{ type: 'text', delta: 'hi' }, { type: 'done' }]]);

    const { chunks, emit } = captureChunks();
    const translator = createLionStreamTranslator({ sessionId: 's4', emit });
    const dispatcher: LionToolDispatcher = async () => ({ content: '' });

    const result = await runLionLoop({
      adapter,
      model: 'm',
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      dispatcher,
      translator,
    });

    expect(result.ok).toBe(true);
    const usageChunks = chunks.filter((c) => c.type === 'usage');
    expect(usageChunks).toHaveLength(0);
    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
  });

  it('N-turn interaction emits N cumulative usage events with growing values', async () => {
    const perTurnEvents = (input: number, output: number, hasToolCall: boolean): LionStreamEvent[] => {
      const evs: LionStreamEvent[] = [];
      if (hasToolCall) {
        evs.push({
          type: 'tool_call_delta',
          toolCalls: [
            {
              id: `c-${input}`,
              type: 'function',
              function: { name: 'Bash', arguments: JSON.stringify({ command: 'x' }) },
            },
          ],
        });
      } else {
        evs.push({ type: 'text', delta: 'final' });
      }
      evs.push({ type: 'usage', usage: { inputTokens: input, outputTokens: output } });
      evs.push({ type: 'done' });
      return evs;
    };

    const adapter = makeMultiTurnAdapter([
      perTurnEvents(10, 5, true),
      perTurnEvents(8, 4, true),
      perTurnEvents(6, 3, true),
      perTurnEvents(4, 2, false), // final text, no tool call
    ]);

    const { chunks, emit } = captureChunks();
    const translator = createLionStreamTranslator({ sessionId: 's5', emit });
    const dispatcher: LionToolDispatcher = async () => ({ content: 'done' });

    const result = await runLionLoop({
      adapter,
      model: 'm',
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [],
      dispatcher,
      translator,
    });

    expect(result.ok).toBe(true);

    const usageChunks = chunks.filter((c) => c.type === 'usage') as Array<{
      usage: { inputTokens: number; outputTokens: number };
    }>;

    expect(usageChunks).toHaveLength(4);

    for (let i = 1; i < usageChunks.length; i++) {
      expect(usageChunks[i]!.usage.inputTokens).toBeGreaterThan(usageChunks[i - 1]!.usage.inputTokens);
      expect(usageChunks[i]!.usage.outputTokens).toBeGreaterThan(usageChunks[i - 1]!.usage.outputTokens);
    }

    expect(usageChunks[3]!.usage.inputTokens).toBe(28);
    expect(usageChunks[3]!.usage.outputTokens).toBe(14);

    expect(result.usage.inputTokens).toBe(28);
    expect(result.usage.outputTokens).toBe(14);
  });
});
