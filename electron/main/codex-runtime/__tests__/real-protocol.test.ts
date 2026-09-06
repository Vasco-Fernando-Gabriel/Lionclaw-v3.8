import { describe, it, expect } from 'vitest';
import {
  translateEvent,
  createAccumulator,
  finalizeResponse,
  type AppServerEvent,
} from '../official-event-translator';

const THREAD = '019ed034-a691-7690-957c-9339561c61a0';
const TURN = '019ed034-a75d-7fa2-bdc3-249a41e38c9e';

const REAL_EVENTS: AppServerEvent[] = [
  { method: 'thread/started', params: { thread: { id: THREAD, sessionId: THREAD } } },
  { method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } } },
  { method: 'item/started', params: { item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Reply with exactly one word: pong' }] }, threadId: THREAD, turnId: TURN } },
  { method: 'item/completed', params: { item: { type: 'userMessage', id: 'u1' }, threadId: THREAD, turnId: TURN } },
  { method: 'item/started', params: { item: { type: 'reasoning', id: 'rs1', summary: [], content: [] }, threadId: THREAD, turnId: TURN } },
  { method: 'item/completed', params: { item: { type: 'reasoning', id: 'rs1' }, threadId: THREAD, turnId: TURN } },
  { method: 'item/started', params: { item: { type: 'agentMessage', id: 'msg1', text: '', phase: 'final_answer' }, threadId: THREAD, turnId: TURN } },
  { method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: TURN, itemId: 'msg1', delta: 'pong' } },
  { method: 'item/completed', params: { item: { type: 'agentMessage', id: 'msg1', text: 'pong', phase: 'final_answer' }, threadId: THREAD, turnId: TURN } },
  { method: 'thread/tokenUsage/updated', params: { threadId: THREAD, turnId: TURN, tokenUsage: { total: { totalTokens: 13168, inputTokens: 13145, cachedInputTokens: 4992, outputTokens: 23, reasoningOutputTokens: 16 }, last: { totalTokens: 13168, inputTokens: 13145, cachedInputTokens: 4992, outputTokens: 23, reasoningOutputTokens: 16 } } } },
  { method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, status: 'completed', error: null } } },
];

describe('official-event-translator: real app-server protocol', () => {
  it('accumulates content + usage from a verbatim live turn', () => {
    const acc = createAccumulator(THREAD);
    const texts: string[] = [];
    for (const e of REAL_EVENTS) {
      translateEvent(e, acc, { callbacks: { onText: (t) => texts.push(t) } });
    }
    expect(acc.content).toBe('pong');
    expect(texts.join('')).toBe('pong');
    expect(acc.usage.inputTokens).toBe(13145);
    expect(acc.usage.cachedInputTokens).toBe(4992);
    expect(acc.usage.outputTokens).toBe(23);
    expect(acc.usage.reasoningOutputTokens).toBe(16);
    expect(acc.content).not.toContain('Reply with exactly');
  });

  it('resolves a completed CodexResponse', () => {
    const acc = createAccumulator(THREAD);
    for (const e of REAL_EVENTS) translateEvent(e, acc, {});
    const res = finalizeResponse(acc, 'completed');
    expect(res.status).toBe('completed');
    expect(res.content).toBe('pong');
    expect(res.threadId).toBe(THREAD);
    expect(res.usage.outputTokens).toBe(23);
  });
});
