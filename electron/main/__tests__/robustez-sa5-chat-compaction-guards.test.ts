
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChatSession, StreamChunk } from '../../../src/types';

const h = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getSettingMock: vi.fn((_key: string): string | undefined => undefined),
  compactMock: vi.fn(),
  getContextWindowMock: vi.fn((_model: string, _provider?: string): number | undefined => undefined),
}));

vi.mock('../db', () => ({
  getSession: h.getSessionMock,
  getSetting: h.getSettingMock,
}));

vi.mock('../chat-compaction-inplace', () => ({
  compactChatSessionInPlace: h.compactMock,
}));

vi.mock('../agent-runtime/model-context-windows', () => ({
  getContextWindow: h.getContextWindowMock,
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

import {
  maybeCompactChatSession,
  CHAT_COMPACTION_MIN_SAVINGS_PERCENT,
  CHAT_COMPACTION_THRASHING_LIMIT,
  CHAT_COMPACTION_FAILURE_COOLDOWN_MS,
  __resetChatCompactionGuardsForTests,
} from '../chat-compaction-trigger';
import { buildExecutionError } from '../agent-runtime/llm-error';


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

function installKnownModel(windowTokens = 200_000): void {
  h.getSettingMock.mockImplementation((key: string) => {
    if (key === 'orchestrator_model') return 'modelo-conhecido';
    if (key === 'orchestrator_provider') return 'anthropic';
    return undefined;
  });
  h.getContextWindowMock.mockImplementation((model: string) =>
    model === 'modelo-conhecido' ? windowTokens : undefined);
}

function installHotSession(): void {
  installKnownModel(200_000);
  h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 200_000 }));
}

function okOutcomeWithSavings(savingsPercent: number) {
  const before = 200_000;
  return { ok: true, seedTokens: Math.round(before * (1 - savingsPercent / 100)) };
}

const failedOutcome = {
  ok: false,
  error: 'summarizer vazio',
  typedError: buildExecutionError('COMPACT-EMPTY', 'summarizer vazio'),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  __resetChatCompactionGuardsForTests();
  h.getSettingMock.mockReturnValue(undefined);
  h.getContextWindowMock.mockReturnValue(undefined);
  h.compactMock.mockResolvedValue({ ok: true, seedTokens: 40_000 });
});

afterEach(() => {
  vi.useRealTimers();
});


describe('AC-A10 — anti-thrashing (2 compactacoes ineficazes consecutivas param o gatilho)', () => {
  it('AC-A10: 2 compactacoes seguidas salvando <10% -> gatilho PARA e avisa 1x (COMPACT-SKIPPED)', async () => {
    installHotSession();
    const chunks: StreamChunk[] = [];
    const emit = (c: StreamChunk) => chunks.push(c);
    const nonIndicator = () =>
      chunks.filter((c) => c.type !== 'compacting' && c.type !== 'context_usage');

    h.compactMock.mockResolvedValueOnce(okOutcomeWithSavings(5));
    await maybeCompactChatSession('s1', emit);
    expect(h.compactMock).toHaveBeenCalledTimes(1);
    expect(nonIndicator()).toHaveLength(0);

    h.compactMock.mockResolvedValueOnce(okOutcomeWithSavings(5));
    await maybeCompactChatSession('s1', emit);
    expect(h.compactMock).toHaveBeenCalledTimes(2);
    expect(nonIndicator()).toHaveLength(1);
    expect(nonIndicator()[0].type).toBe('error');
    expect(nonIndicator()[0].code).toBe('COMPACT-SKIPPED');

    const chunksBeforeStopped = chunks.length;
    await maybeCompactChatSession('s1', emit);
    await maybeCompactChatSession('s1', emit);
    expect(h.compactMock).toHaveBeenCalledTimes(2);
    expect(chunks).toHaveLength(chunksBeforeStopped);
    expect(nonIndicator()).toHaveLength(1);
  });

  it('AC-A10: compactacao EFICAZ (>=10%) reseta o contador — ineficazes intercaladas nao param', async () => {
    installHotSession();
    const chunks: StreamChunk[] = [];
    const emit = (c: StreamChunk) => chunks.push(c);

    h.compactMock.mockResolvedValueOnce(okOutcomeWithSavings(5)); // ineficaz (1)
    await maybeCompactChatSession('s1', emit);
    h.compactMock.mockResolvedValueOnce(okOutcomeWithSavings(75)); // eficaz -> reset
    await maybeCompactChatSession('s1', emit);
    h.compactMock.mockResolvedValueOnce(okOutcomeWithSavings(5)); // ineficaz (1 de novo)
    await maybeCompactChatSession('s1', emit);

    h.compactMock.mockResolvedValueOnce(okOutcomeWithSavings(75));
    await maybeCompactChatSession('s1', emit);
    expect(h.compactMock).toHaveBeenCalledTimes(4);
    expect(
      chunks.filter((c) => c.type !== 'compacting' && c.type !== 'context_usage'),
    ).toHaveLength(0);
  });

  it('AC-A10: no-op (delta vazio) NAO conta como ineficaz nem como falha', async () => {
    installHotSession();
    h.compactMock.mockResolvedValue({ ok: true, noop: true });
    await maybeCompactChatSession('s1');
    await maybeCompactChatSession('s1');
    await maybeCompactChatSession('s1');
    expect(h.compactMock).toHaveBeenCalledTimes(3);
  });

  it('AC-A10: o estado e por SESSAO — parar s1 nao afeta s2', async () => {
    installKnownModel(200_000);
    h.getSessionMock.mockImplementation((id: string) =>
      makeSession({ id, activeContextTokensEst: 200_000 }));

    h.compactMock.mockResolvedValue(okOutcomeWithSavings(5));
    await maybeCompactChatSession('s1');
    await maybeCompactChatSession('s1'); // s1 parada (2 ineficazes)
    await maybeCompactChatSession('s1');
    expect(h.compactMock).toHaveBeenCalledTimes(2);

    await maybeCompactChatSession('s2'); // s2 segue viva
    expect(h.compactMock).toHaveBeenCalledTimes(3);
  });

  it('AC-A10: constantes da spec — limite 2 consecutivas, economia minima 10%', () => {
    expect(CHAT_COMPACTION_THRASHING_LIMIT).toBe(2);
    expect(CHAT_COMPACTION_MIN_SAVINGS_PERCENT).toBe(10);
  });
});


describe('AC-A11 — cooldown pos-falha do sumarizador', () => {
  it('AC-A11: falha do sumarizador arma cooldown — turno seguinte NAO re-tenta', async () => {
    installHotSession();
    const chunks: StreamChunk[] = [];
    const emit = (c: StreamChunk) => chunks.push(c);

    h.compactMock.mockResolvedValueOnce(failedOutcome);
    await maybeCompactChatSession('s1', emit);
    expect(h.compactMock).toHaveBeenCalledTimes(1);
    expect(chunks.some(c => c.type === 'error' && c.code === 'COMPACT-EMPTY')).toBe(true);

    await maybeCompactChatSession('s1', emit);
    vi.advanceTimersByTime(CHAT_COMPACTION_FAILURE_COOLDOWN_MS - 1_000);
    await maybeCompactChatSession('s1', emit);
    expect(h.compactMock).toHaveBeenCalledTimes(1);
  });

  it('AC-A11: cooldown expirado -> gatilho volta a tentar (retentativa apos a janela)', async () => {
    installHotSession();

    h.compactMock.mockResolvedValueOnce(failedOutcome);
    await maybeCompactChatSession('s1');
    expect(h.compactMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CHAT_COMPACTION_FAILURE_COOLDOWN_MS + 1);
    h.compactMock.mockResolvedValueOnce(okOutcomeWithSavings(75));
    await maybeCompactChatSession('s1');
    expect(h.compactMock).toHaveBeenCalledTimes(2);

    h.compactMock.mockResolvedValueOnce(okOutcomeWithSavings(75));
    await maybeCompactChatSession('s1');
    expect(h.compactMock).toHaveBeenCalledTimes(3);
  });

  it('AC-A11: valor do cooldown dentro da faixa da spec (30-60s)', () => {
    expect(CHAT_COMPACTION_FAILURE_COOLDOWN_MS).toBeGreaterThanOrEqual(30_000);
    expect(CHAT_COMPACTION_FAILURE_COOLDOWN_MS).toBeLessThanOrEqual(60_000);
  });
});
