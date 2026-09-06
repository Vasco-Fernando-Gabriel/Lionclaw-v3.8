import { describe, it, expect } from 'vitest';
import {
  translateEvent,
  createAccumulator,
  finalizeResponse,
  type AppServerEvent,
} from '../official-event-translator';
import {
  normalizeUsage,
  canonicalPromptTokens,
  reconcileActiveContext,
  estimateRequestTokens,
} from '../../agent-runtime/context-measure';

const THREAD = '019f2b0d-bf8e-75c2-bfbb-3d571c46bd74';
const TURN = '019f2b0d-c000-0000-0000-000000000001';

const AGENTIC_EVENTS: AppServerEvent[] = [
  { method: 'thread/started', params: { thread: { id: THREAD, sessionId: THREAD } } },
  { method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } } },
  { method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: TURN, itemId: 'm1', delta: 'pronto' } },
  {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: THREAD,
      turnId: TURN,
      tokenUsage: {
        total: { totalTokens: 2185096, inputTokens: 2178844, cachedInputTokens: 1200000, outputTokens: 6252, reasoningOutputTokens: 3000 },
        last: { totalTokens: 152300, inputTokens: 150000, cachedInputTokens: 90000, outputTokens: 2300, reasoningOutputTokens: 800 },
        modelContextWindow: 1050000,
      },
    },
  },
  { method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, status: 'completed', error: null } } },
];

describe('CTX-FINAL codex — captura tokenUsage.last (nao o odometro .total)', () => {
  it('acc.usage segue do .total (billing intacto) e acc.lastUsage vem do .last', () => {
    const acc = createAccumulator(THREAD);
    for (const e of AGENTIC_EVENTS) translateEvent(e, acc, {});

    expect(acc.usage.inputTokens).toBe(2178844);
    expect(acc.usage.totalTokens).toBe(2185096);

    expect(acc.lastUsage).toBeDefined();
    expect(acc.lastUsage!.inputTokens).toBe(150000);
    expect(acc.lastUsage!.cachedInputTokens).toBe(90000);
    expect(acc.lastUsage!.outputTokens).toBe(2300);
    expect(acc.modelContextWindow).toBe(1050000);
  });

  it('finalizeResponse propaga lastUsage + modelContextWindow (aditivo)', () => {
    const acc = createAccumulator(THREAD);
    for (const e of AGENTIC_EVENTS) translateEvent(e, acc, {});
    const res = finalizeResponse(acc, 'completed');
    expect(res.status).toBe('completed');
    expect(res.lastUsage?.inputTokens).toBe(150000);
    expect(res.modelContextWindow).toBe(1050000);
    expect(res.usage.inputTokens).toBe(2178844);
  });

  it('a medicao final bate o contexto VIVO (~150K), nunca o odometro (~2.18M) nem 2223', () => {
    const acc = createAccumulator(THREAD);
    for (const e of AGENTIC_EVENTS) translateEvent(e, acc, {});
    const res = finalizeResponse(acc, 'completed');

    const estimate = estimateRequestTokens({ messageTexts: ['New user message: oi', 'pronto'] });
    const lastCanonical = normalizeUsage(res.lastUsage, 'codex');
    const realPrompt = canonicalPromptTokens(lastCanonical); // 150000 (60k uncached + 90k cache)
    const active = reconcileActiveContext(realPrompt, lastCanonical.outputTokens, estimate);

    expect(realPrompt).toBe(150000);
    expect(active).toBe(150000 + 2300);
    expect(active).not.toBe(2185096);
    expect(active).toBeGreaterThan(100000);
    expect(active).toBeLessThan(200000);
  });

  it('sem `.last` (bridge legacy / shape flat) -> lastUsage ausente, cai no PISO estimado', () => {
    const FLAT: AppServerEvent[] = [
      { method: 'thread/started', params: { thread: { id: THREAD } } },
      {
        method: 'thread/tokenUsage/updated',
        params: { usage: { inputTokens: 1200, cachedInputTokens: 300, outputTokens: 450, totalTokens: 1650 } },
      },
      { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    ];
    const acc = createAccumulator(THREAD);
    for (const e of FLAT) translateEvent(e, acc, {});
    const res = finalizeResponse(acc, 'completed');
    expect(res.lastUsage).toBeUndefined();

    const estimate = estimateRequestTokens({ messageTexts: ['oi', 'ola'] });
    const lastCanonical = res.lastUsage ? normalizeUsage(res.lastUsage, 'codex') : null;
    const realPrompt = lastCanonical ? canonicalPromptTokens(lastCanonical) : 0;
    const active = reconcileActiveContext(realPrompt, 0, estimate);
    expect(active).toBe(estimate); // fallback ao piso
  });
});
