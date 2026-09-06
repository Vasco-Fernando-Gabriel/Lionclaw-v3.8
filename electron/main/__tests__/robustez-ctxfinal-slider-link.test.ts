import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ChatSession } from '../../../src/types';

const h = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getSessionMessagesMock: vi.fn((): unknown[] => []),
  getSettingMock: vi.fn((_key: string): string | undefined => undefined),
  setSessionCompactionStateMock: vi.fn(),
  setSessionActiveContextTokensMock: vi.fn(),
  transactionMock: vi.fn((fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a)),
  summarizeLightweightMock: vi.fn(),
  getContextWindowMock: vi.fn((_m: string, _p?: string): number | undefined => undefined),
}));

vi.mock('../db', () => ({
  getDb: vi.fn(() => ({
    prepare: () => ({ get: () => undefined, all: () => [], run: () => undefined }),
    transaction: h.transactionMock,
  })),
  getSession: h.getSessionMock,
  getSessionMessages: h.getSessionMessagesMock,
  getSetting: h.getSettingMock,
  setSessionCompactionState: h.setSessionCompactionStateMock,
  setSessionActiveContextTokens: h.setSessionActiveContextTokensMock,
  createSession: vi.fn(),
  updateSessionStatus: vi.fn(),
}));

vi.mock('../memory-pipeline', () => ({ summarizeLightweight: h.summarizeLightweightMock }));
vi.mock('../agent-runtime/model-context-windows', () => ({ getContextWindow: h.getContextWindowMock }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
}));

import {
  maybeCompactChatSession,
  getChatCompactionThreshold,
  resolveChatCompactionTriggerPercent,
  __resetChatCompactionGuardsForTests,
} from '../chat-compaction-trigger';
import { resolveCompactionThresholdPercent } from '../chat-context-usage';

const GLM52_WINDOW = 1_000_000;
const TURN_MODEL = { model: 'glm-5.2', provider: 'zai' };

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's1',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    status: 'active',
    type: 'chat',
    createdAt: '2026-07-01 10:00:00',
    updatedAt: '2026-07-01 10:00:00',
    ...overrides,
  };
}

function installSlider(percent: number | undefined): void {
  h.getSettingMock.mockImplementation((key: string) => {
    if (key === 'orchestrator_compaction_threshold_percent') {
      return percent === undefined ? undefined : String(percent);
    }
    if (key === 'orchestrator_model') return 'glm-5.2';
    if (key === 'orchestrator_provider') return 'zai';
    return undefined;
  });
  h.getContextWindowMock.mockImplementation((model: string) =>
    model === 'glm-5.2' ? GLM52_WINDOW : undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetChatCompactionGuardsForTests();
  h.getSessionMessagesMock.mockReturnValue([
    { id: 1, sessionId: 's1', role: 'user', content: 'oi', createdAt: '2026-07-01 10:01:00' },
    { id: 2, sessionId: 's1', role: 'assistant', content: 'ola', createdAt: '2026-07-01 10:02:00' },
  ]);
  h.summarizeLightweightMock.mockResolvedValue({ executiveSummary: 'resumo novo' });
});


describe('slider — barrinha e gatilho leem a MESMA fonte (% identico)', () => {
  for (const pct of [50, 55, 70, 80, 95]) {
    it(`setting=${pct}% -> barrinha === gatilho === ${pct}`, () => {
      installSlider(pct);
      expect(resolveCompactionThresholdPercent()).toBe(pct);
      expect(resolveChatCompactionTriggerPercent()).toBe(pct);
    });
  }

  it('setting ausente -> ambos caem no MESMO default (80)', () => {
    installSlider(undefined);
    expect(resolveCompactionThresholdPercent()).toBe(80);
    expect(resolveChatCompactionTriggerPercent()).toBe(80);
  });

  it('clamp 50-95 identico nos dois (valor fora dos limites)', () => {
    installSlider(200);
    expect(resolveCompactionThresholdPercent()).toBe(95);
    expect(resolveChatCompactionTriggerPercent()).toBe(95);
    installSlider(10);
    expect(resolveCompactionThresholdPercent()).toBe(50);
    expect(resolveChatCompactionTriggerPercent()).toBe(50);
  });
});


describe('slider — o threshold em tokens = window * pct/100', () => {
  it('55% de 1M = 550k; 80% de 1M = 800k', () => {
    installSlider(55);
    expect(getChatCompactionThreshold(TURN_MODEL)).toBe(550_000);
    installSlider(80);
    expect(getChatCompactionThreshold(TURN_MODEL)).toBe(800_000);
  });
});


describe('slider — dispara quando o contexto real passa o threshold', () => {
  const REAL_CONTEXT = 600_000; // contexto vivo REAL (GLM), nao a estimativa furada

  it('slider 55% (550k): contexto real 600k >= 550k -> DISPARA a compactacao', async () => {
    installSlider(55);
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: REAL_CONTEXT }));

    await maybeCompactChatSession('s1', undefined, TURN_MODEL);

    expect(h.summarizeLightweightMock).toHaveBeenCalledTimes(1);
    expect(h.setSessionCompactionStateMock).toHaveBeenCalledTimes(1);
  });

  it('slider 80% (800k): o MESMO contexto real 600k < 800k -> NAO dispara', async () => {
    installSlider(80);
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: REAL_CONTEXT }));

    await maybeCompactChatSession('s1', undefined, TURN_MODEL);

    expect(h.summarizeLightweightMock).not.toHaveBeenCalled();
    expect(h.setSessionCompactionStateMock).not.toHaveBeenCalled();
  });

  it('subindo o contexto acima de 800k, o slider 80% volta a disparar', async () => {
    installSlider(80);
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 850_000 }));

    await maybeCompactChatSession('s1', undefined, TURN_MODEL);

    expect(h.summarizeLightweightMock).toHaveBeenCalledTimes(1);
  });

  it('regressao do bug: contexto FURADO (26 tokens, como lia o compat antes) nunca dispara', async () => {
    installSlider(55);
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 26 }));

    await maybeCompactChatSession('s1', undefined, TURN_MODEL);

    expect(h.summarizeLightweightMock).not.toHaveBeenCalled();
  });
});
