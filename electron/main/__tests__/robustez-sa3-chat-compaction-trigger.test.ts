import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ChatMessage, ChatSession, StreamChunk } from '../../../src/types';

const h = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getSessionMessagesMock: vi.fn((): unknown[] => []),
  getSettingMock: vi.fn((_key: string): string | undefined => undefined),
  setSessionCompactionStateMock: vi.fn(),
  setSessionActiveContextTokensMock: vi.fn(),
  createSessionMock: vi.fn(),
  updateSessionStatusMock: vi.fn(),
  deleteRunsMock: vi.fn(),
  transactionMock: vi.fn(
    (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  ),
  summarizeLightweightMock: vi.fn(),
  getContextWindowMock: vi.fn((_model: string, _provider?: string): number | undefined => undefined),
  laneOrchestrator: null as { runtime: string; provider: string; model: string } | null,
}));

vi.mock('../db', () => ({
  threadIdOf: (s: { id: string; sdkSessionId?: string | null }) => s.sdkSessionId ?? s.id,
  getSessionOrchestrator: () => h.laneOrchestrator,
  getDb: vi.fn(() => ({
    prepare: (_sql: string) => ({
      get: () => undefined,
      all: () => [],
      run: (...args: unknown[]) => h.deleteRunsMock(...args),
    }),
    transaction: h.transactionMock,
  })),
  getSession: h.getSessionMock,
  getSessionMessages: h.getSessionMessagesMock,
  getSetting: h.getSettingMock,
  setSessionCompactionState: h.setSessionCompactionStateMock,
  setSessionActiveContextTokens: h.setSessionActiveContextTokensMock,
  createSession: h.createSessionMock,
  updateSessionStatus: h.updateSessionStatusMock,
}));

vi.mock('../memory-pipeline', () => ({
  summarizeLightweight: h.summarizeLightweightMock,
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
  compactChatSessionInPlace,
  buildChatCompactionSeed,
  DEFAULT_CHAT_COMPACTION_TARGET_TOKENS,
} from '../chat-compaction-inplace';
import {
  maybeCompactChatSession,
  getChatCompactionThreshold,
  resolveChatCompactionTriggerPercent,
  __resetChatCompactionGuardsForTests,
} from '../chat-compaction-trigger';
import { EmptyProviderResponseError } from '../agent-runtime/llm-error';
import { estimateTokens } from '../token-estimator';

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

function makeMsg(id: number, role: 'user' | 'assistant' | 'system', content: string): ChatMessage {
  return {
    id,
    sessionId: 's1',
    role,
    content,
    createdAt: `2026-07-01 10:0${Math.min(id, 9)}:00`,
  };
}

const OK_SUMMARY = { executiveSummary: 'resumo rolante novo' };

function installKnownModel(windowTokens = 200_000): void {
  h.laneOrchestrator = { runtime: 'claude-sdk', provider: 'anthropic', model: 'modelo-conhecido' };
  h.getSettingMock.mockImplementation((key: string) => {
    if (key === 'orchestrator_model') return 'modelo-conhecido';
    if (key === 'orchestrator_provider') return 'anthropic';
    return undefined;
  });
  h.getContextWindowMock.mockImplementation((model: string) =>
    model === 'modelo-conhecido' ? windowTokens : undefined,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetChatCompactionGuardsForTests();
  h.laneOrchestrator = null;
  h.getSettingMock.mockReturnValue(undefined);
  h.getSessionMessagesMock.mockReturnValue([]);
  h.getContextWindowMock.mockReturnValue(undefined);
  h.transactionMock.mockImplementation(
    (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  );
  h.summarizeLightweightMock.mockResolvedValue(OK_SUMMARY);
});

describe('AC-A5 [INV] — gatilho pos-turno aditivo (SA-3)', () => {
  it('AC-A5: janela desconhecida (getContextWindow undefined) -> gatilho e no-op, sem crash', async () => {
    h.getSettingMock.mockImplementation((key: string) =>
      key === 'orchestrator_model' ? 'modelo-desconhecido' : undefined,
    );
    h.getContextWindowMock.mockReturnValue(undefined);
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 999_999_999 }));

    await maybeCompactChatSession('s1');

    expect(getChatCompactionThreshold()).toBeUndefined();
    expect(h.summarizeLightweightMock).not.toHaveBeenCalled();
    expect(h.setSessionCompactionStateMock).not.toHaveBeenCalled();
    expect(h.setSessionActiveContextTokensMock).not.toHaveBeenCalled();
  });

  it('AC-A5: sem orchestrator_model configurado -> gatilho desabilitado', async () => {
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 999_999_999 }));
    await maybeCompactChatSession('s1');
    expect(h.summarizeLightweightMock).not.toHaveBeenCalled();
  });

  it('AC-A5: percentual D1 — default 80, clamp 50-95, setting customizado vence', () => {
    expect(resolveChatCompactionTriggerPercent()).toBe(80);

    h.getSettingMock.mockImplementation((key: string) =>
      key === 'orchestrator_compaction_threshold_percent' ? '90' : undefined,
    );
    expect(resolveChatCompactionTriggerPercent()).toBe(90);

    h.getSettingMock.mockImplementation((key: string) =>
      key === 'orchestrator_compaction_threshold_percent' ? '10' : undefined,
    );
    expect(resolveChatCompactionTriggerPercent()).toBe(50);

    h.getSettingMock.mockImplementation((key: string) =>
      key === 'orchestrator_compaction_threshold_percent' ? '99' : undefined,
    );
    expect(resolveChatCompactionTriggerPercent()).toBe(95);
  });

  it('AC-A5: threshold = janela * pct/100 (D1); provider e repassado ao resolver', () => {
    installKnownModel(200_000);
    expect(getChatCompactionThreshold()).toBe(160_000);
    expect(h.getContextWindowMock).toHaveBeenCalledWith('modelo-conhecido', 'anthropic');
  });

  it('AC-A5 [INV]: o hook no orchestrator e UNICO, pos-done, no caminho de SUCESSO (nunca no catch/retry)', () => {
    const src = fs.readFileSync(fileURLToPath(new URL('../orchestrator.ts', import.meta.url)), 'utf8');
    const callMatches = src.match(/await maybeCompactChatSession\(/g) ?? [];
    expect(callMatches).toHaveLength(1);

    const callIdx = src.indexOf('await maybeCompactChatSession(');
    const doneIdx = src.indexOf("sendSessionStream({ type: 'done', content: sessionId })");
    expect(doneIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(doneIdx);
    const catchIdx = src.indexOf("'Orchestrator query failed'");
    expect(catchIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeLessThan(catchIdx);
  });
});

describe('AC-A6 — threshold + exclusao mutua (SA-3/V3)', () => {
  it('AC-A6: abaixo do threshold NAO dispara; acima dispara exatamente 1x', async () => {
    installKnownModel(200_000);
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola')]);

    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 159_999 }));
    await maybeCompactChatSession('s1');
    expect(h.summarizeLightweightMock).not.toHaveBeenCalled();

    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 160_000 }));
    await maybeCompactChatSession('s1');
    expect(h.summarizeLightweightMock).toHaveBeenCalledTimes(1);
  });

  it('6.1: sessao em Clear (clearingSessions) NAO dispara a Compactacao mesmo acima do threshold', async () => {
    const { clearingSessions, markSessionClearing } = await import('../clearing-sessions');
    installKnownModel(200_000);
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola')]);
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 160_000 }));
    markSessionClearing('s1', 'running', 1);
    try {
      await maybeCompactChatSession('s1');
      expect(h.summarizeLightweightMock).not.toHaveBeenCalled();
    } finally {
      clearingSessions.clear();
    }
  });

  it('toggle chat_auto_compaction_enabled=false: acima do threshold NAO dispara (no-op total)', async () => {
    h.getSettingMock.mockImplementation((key: string) => {
      if (key === 'chat_auto_compaction_enabled') return 'false';
      if (key === 'orchestrator_model') return 'modelo-conhecido';
      if (key === 'orchestrator_provider') return 'anthropic';
      return undefined;
    });
    h.getContextWindowMock.mockImplementation((model: string) => (model === 'modelo-conhecido' ? 200_000 : undefined));
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 199_000 }));
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola')]);

    await maybeCompactChatSession('s1');
    expect(h.summarizeLightweightMock).not.toHaveBeenCalled();
  });

  it('toggle com valor "true" (ou ausente): comportamento ligado byte-identico', async () => {
    installKnownModel(200_000);
    h.getSettingMock.mockImplementation((key: string) => {
      if (key === 'chat_auto_compaction_enabled') return 'true';
      if (key === 'orchestrator_model') return 'modelo-conhecido';
      if (key === 'orchestrator_provider') return 'anthropic';
      return undefined;
    });
    h.getContextWindowMock.mockImplementation((model: string) => (model === 'modelo-conhecido' ? 200_000 : undefined));
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 199_000 }));
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola')]);

    await maybeCompactChatSession('s1');
    expect(h.summarizeLightweightMock).toHaveBeenCalledTimes(1);
  });

  it('AC-A6: sem active_context_tokens_est escrito ainda -> NAO dispara (sem fallback pro acumulado)', async () => {
    installKnownModel(200_000);
    h.getSessionMock.mockReturnValue(makeSession({ inputTokens: 999_999, outputTokens: 999_999 }));
    await maybeCompactChatSession('s1');
    expect(h.summarizeLightweightMock).not.toHaveBeenCalled();
  });

  it('AC-A6: exclusao mutua REAL — o gatilho so resolve DEPOIS do re-seed (o proximo dequeue le sdk_session_id/pending_seed novos)', async () => {
    installKnownModel(200_000);
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 170_000 }));
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola')]);

    let resolveSummarize!: (v: typeof OK_SUMMARY) => void;
    h.summarizeLightweightMock.mockImplementation(
      () =>
        new Promise<typeof OK_SUMMARY>((res) => {
          resolveSummarize = res;
        }),
    );

    const events: string[] = [];
    const trigger = maybeCompactChatSession('s1').then(() => events.push('trigger:resolved'));

    await new Promise((r) => setTimeout(r, 0));
    expect(h.summarizeLightweightMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    expect(h.setSessionCompactionStateMock).not.toHaveBeenCalled();

    events.push('summarize:done');
    resolveSummarize(OK_SUMMARY);
    await trigger;

    expect(events).toEqual(['summarize:done', 'trigger:resolved']);
    expect(h.setSessionCompactionStateMock).toHaveBeenCalledTimes(1);
  });

  it('AC-A6: guarda de reentrancia — segundo gatilho durante compactacao em voo e no-op', async () => {
    installKnownModel(200_000);
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 170_000 }));
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola')]);

    let resolveSummarize!: (v: typeof OK_SUMMARY) => void;
    h.summarizeLightweightMock.mockImplementation(
      () =>
        new Promise<typeof OK_SUMMARY>((res) => {
          resolveSummarize = res;
        }),
    );

    const first = maybeCompactChatSession('s1');
    await new Promise((r) => setTimeout(r, 0));
    const second = maybeCompactChatSession('s1');
    await new Promise((r) => setTimeout(r, 0));

    expect(h.summarizeLightweightMock).toHaveBeenCalledTimes(1);

    resolveSummarize(OK_SUMMARY);
    await Promise.all([first, second]);
    expect(h.setSessionCompactionStateMock).toHaveBeenCalledTimes(1);
  });

  it('0.3: sessao telegram/scheduled/archived NUNCA entra no gatilho do chat', async () => {
    installKnownModel(200_000);

    h.getSessionMock.mockReturnValue(makeSession({ type: 'telegram', activeContextTokensEst: 999_999 }));
    await maybeCompactChatSession('s1');
    h.getSessionMock.mockReturnValue(makeSession({ type: 'scheduled', activeContextTokensEst: 999_999 }));
    await maybeCompactChatSession('s1');
    h.getSessionMock.mockReturnValue(makeSession({ status: 'archived', activeContextTokensEst: 999_999 }));
    await maybeCompactChatSession('s1');

    expect(h.summarizeLightweightMock).not.toHaveBeenCalled();
  });
});

describe('AC-A7 — compactChatSessionInPlace (SA-4)', () => {
  it('AC-A7: mesma sessao continua (thread SDK nova + seed), messages intacta, contador reseta pro tamanho do seed', async () => {
    h.getSessionMock.mockReturnValue(makeSession());
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola, tudo bem?')]);

    const outcome = await compactChatSessionInPlace('s1');

    expect(outcome.ok).toBe(true);
    expect(outcome.noop).toBeUndefined();
    expect(h.createSessionMock).not.toHaveBeenCalled();
    expect(h.updateSessionStatusMock).not.toHaveBeenCalled();
    expect(h.deleteRunsMock).not.toHaveBeenCalled();
    expect(h.setSessionCompactionStateMock).toHaveBeenCalledTimes(1);
    const [sid, state] = h.setSessionCompactionStateMock.mock.calls[0];
    expect(sid).toBe('s1');
    expect(state.compactedUpToMessageId).toBe(2);
    expect(state.rollingSummary).toBe('resumo rolante novo');
    expect(state.pendingSeed).toContain('[Resumo da conversa ate aqui]: resumo rolante novo');
    expect(state.pendingSeed).toContain('[user] oi');
    expect(typeof state.sdkSessionId).toBe('string');
    expect(state.sdkSessionId).not.toBe('s1');
    expect(h.setSessionActiveContextTokensMock).toHaveBeenCalledTimes(1);
    const [, tokens] = h.setSessionActiveContextTokensMock.mock.calls[0];
    expect(tokens).toBe(estimateTokens(state.pendingSeed as string));
    expect(h.transactionMock).toHaveBeenCalledTimes(1);
  });

  it('delta pela fronteira: summarizeLightweight recebe sinceMessageId + priorSummary; fronteira avanca pra ultima', async () => {
    h.getSessionMock.mockReturnValue(
      makeSession({
        compactedUpToMessageId: 2,
        rollingSummary: 'resumo anterior',
      }),
    );
    h.getSessionMessagesMock.mockReturnValue([
      makeMsg(1, 'user', 'antigo'),
      makeMsg(2, 'assistant', 'antigo tambem'),
      makeMsg(3, 'user', 'novo'),
      makeMsg(4, 'assistant', 'novissimo'),
    ]);

    await compactChatSessionInPlace('s1');

    expect(h.summarizeLightweightMock).toHaveBeenCalledWith('s1', {
      sinceMessageId: 2,
      priorSummary: 'resumo anterior',
    });
    expect(h.setSessionCompactionStateMock.mock.calls[0][1].compactedUpToMessageId).toBe(4);
  });

  it('guardas: sessao inexistente / telegram / scheduled / nao-active recusam', async () => {
    h.getSessionMock.mockReturnValue(undefined);
    expect((await compactChatSessionInPlace('sx')).ok).toBe(false);

    h.getSessionMock.mockReturnValue(makeSession({ type: 'telegram' }));
    expect((await compactChatSessionInPlace('s1')).ok).toBe(false);

    h.getSessionMock.mockReturnValue(makeSession({ type: 'scheduled' }));
    expect((await compactChatSessionInPlace('s1')).ok).toBe(false);

    h.getSessionMock.mockReturnValue(makeSession({ status: 'archived' }));
    expect((await compactChatSessionInPlace('s1')).ok).toBe(false);

    expect(h.summarizeLightweightMock).not.toHaveBeenCalled();
  });

  it('sessao type manual (desktop) tambem compacta', async () => {
    h.getSessionMock.mockReturnValue(makeSession({ type: 'manual' }));
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola')]);
    expect((await compactChatSessionInPlace('s1')).ok).toBe(true);
  });
});

describe('AC-A9 — falha do summarizer (best-effort + surfacing Pilar B)', () => {
  it('AC-A9: falha ABORTA sem re-seed (contexto intacto) e o outcome carrega COMPACT-EMPTY tipado', async () => {
    h.getSessionMock.mockReturnValue(makeSession());
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi')]);
    h.summarizeLightweightMock.mockRejectedValue(
      new EmptyProviderResponseError('anthropic', 'claude-sonnet-4-6', 'claude-sdk'),
    );

    const outcome = await compactChatSessionInPlace('s1');

    expect(outcome.ok).toBe(false);
    expect(outcome.typedError?.code).toBe('COMPACT-EMPTY');
    expect(outcome.typedError?.userMessage).toMatch(/resposta vazia/i);
    expect(h.setSessionCompactionStateMock).not.toHaveBeenCalled();
    expect(h.setSessionActiveContextTokensMock).not.toHaveBeenCalled();
  });

  it('AC-A9: erro NAO-tipado do summarizer tambem vira COMPACT-EMPTY (raw preservado)', async () => {
    h.getSessionMock.mockReturnValue(makeSession());
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi')]);
    h.summarizeLightweightMock.mockRejectedValue(new Error('boom qualquer'));

    const outcome = await compactChatSessionInPlace('s1');

    expect(outcome.ok).toBe(false);
    expect(outcome.typedError?.code).toBe('COMPACT-EMPTY');
    expect(outcome.typedError?.raw).toContain('boom qualquer');
  });

  it('AC-A9: o gatilho surfaca a falha como chunk {type:error, code:COMPACT-EMPTY} e NAO lanca (chat nao quebra)', async () => {
    installKnownModel(200_000);
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 170_000 }));
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi')]);
    h.summarizeLightweightMock.mockRejectedValue(
      new EmptyProviderResponseError('anthropic', 'claude-sonnet-4-6', 'claude-sdk'),
    );

    const chunks: StreamChunk[] = [];
    await expect(maybeCompactChatSession('s1', (c) => chunks.push(c))).resolves.toBeUndefined();

    expect(chunks.filter((c) => c.type === 'compacting').map((c) => c.isCompacting)).toEqual([true, false]);
    const errorChunks = chunks.filter((c) => c.type !== 'compacting');
    expect(errorChunks).toHaveLength(1);
    expect(errorChunks[0]).toMatchObject({ type: 'error', code: 'COMPACT-EMPTY' });
    expect(errorChunks[0].error).toMatch(/resposta vazia/i);
  });

  it('AC-A9: sucesso NAO emite chunk de erro', async () => {
    installKnownModel(200_000);
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 170_000 }));
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola')]);

    const chunks: StreamChunk[] = [];
    await maybeCompactChatSession('s1', (c) => chunks.push(c), {
      model: 'modelo-conhecido',
      provider: 'anthropic',
    });

    expect(chunks.map((c) => c.type)).toEqual(['compacting', 'compacting', 'context_usage']);
    expect(h.setSessionCompactionStateMock).toHaveBeenCalledTimes(1);
  });

  it('context_usage pos-Compactacao le a lane (colunas da sessao), nunca o setting global', async () => {
    installKnownModel(200_000);
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 170_000 }));
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola')]);

    const chunks: StreamChunk[] = [];
    await maybeCompactChatSession('s1', (c) => chunks.push(c));

    expect(chunks.map((c) => c.type)).toEqual(['compacting', 'compacting', 'context_usage']);
    expect(chunks[2]?.contextUsage?.contextWindowTokens).toBe(200_000);
    expect(h.setSessionCompactionStateMock).toHaveBeenCalledTimes(1);
  });
});

describe('AC-A9b — delta vazio e no-op (V11)', () => {
  it('AC-A9b: nada alem da fronteira -> no-op (boundary/seed/contador intactos; nenhuma escrita)', async () => {
    h.getSessionMock.mockReturnValue(makeSession({ compactedUpToMessageId: 2 }));
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'a'), makeMsg(2, 'assistant', 'b')]);

    const outcome = await compactChatSessionInPlace('s1');

    expect(outcome).toEqual({ ok: true, noop: true });
    expect(h.summarizeLightweightMock).not.toHaveBeenCalled();
    expect(h.setSessionCompactionStateMock).not.toHaveBeenCalled();
    expect(h.setSessionActiveContextTokensMock).not.toHaveBeenCalled();
  });

  it('AC-A9b: summarizeLightweight devolve undefined (corrida benigna) -> no-op igualmente', async () => {
    h.getSessionMock.mockReturnValue(makeSession());
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi')]);
    h.summarizeLightweightMock.mockResolvedValue(undefined);

    const outcome = await compactChatSessionInPlace('s1');

    expect(outcome).toEqual({ ok: true, noop: true });
    expect(h.setSessionCompactionStateMock).not.toHaveBeenCalled();
    expect(h.setSessionActiveContextTokensMock).not.toHaveBeenCalled();
  });

  it('AC-A9b: gatilho acima do threshold com delta vazio nao emite erro nem escreve', async () => {
    installKnownModel(200_000);
    h.getSessionMock.mockReturnValue(
      makeSession({
        activeContextTokensEst: 170_000,
        compactedUpToMessageId: 2,
      }),
    );
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'a'), makeMsg(2, 'assistant', 'b')]);

    const chunks: StreamChunk[] = [];
    await maybeCompactChatSession('s1', (c) => chunks.push(c));

    expect(chunks.map((c) => c.type)).toEqual(['compacting', 'compacting']);
    expect(h.setSessionCompactionStateMock).not.toHaveBeenCalled();
  });
});

describe('buildChatCompactionSeed (D2)', () => {
  it('header + turnos verbatim em ordem; teto DURO <= target; mais recente sempre presente', () => {
    const target = 1_000;
    const messages: ChatMessage[] = [];
    for (let t = 0; t < 10; t++) {
      messages.push(makeMsg(t * 2 + 1, 'user', `pergunta-${t} ` + 'x'.repeat(600)));
      messages.push(makeMsg(t * 2 + 2, 'assistant', `resposta-${t} ` + 'y'.repeat(600)));
    }

    const seed = buildChatCompactionSeed('resumo curto', messages, target);

    expect(seed.startsWith('[Resumo da conversa ate aqui]: resumo curto')).toBe(true);
    expect(estimateTokens(seed)).toBeLessThanOrEqual(target);
    expect(seed).toContain('pergunta-9');
    expect(seed).not.toContain('pergunta-0');
  });

  it('turno unico gigante: minimo 1 turno, truncado no INICIO com [turno truncado]', () => {
    const target = 500;
    const giant = 'INICIO-DESCARTAVEL ' + 'm'.repeat(50_000) + ' FINAL-IMPORTANTE';
    const seed = buildChatCompactionSeed('resumo', [makeMsg(1, 'user', giant)], target);

    expect(estimateTokens(seed)).toBeLessThanOrEqual(target);
    expect(seed).toContain('[turno truncado]');
    expect(seed).toContain('FINAL-IMPORTANTE');
    expect(seed).not.toContain('INICIO-DESCARTAVEL');
  });

  it('target D2: default flat 50k lido do setting chat_compaction_target_tokens', async () => {
    expect(DEFAULT_CHAT_COMPACTION_TARGET_TOKENS).toBe(50_000);

    h.getSettingMock.mockImplementation((key: string) => (key === 'chat_compaction_target_tokens' ? '300' : undefined));
    h.getSessionMock.mockReturnValue(makeSession());
    h.getSessionMessagesMock.mockReturnValue([
      makeMsg(1, 'user', 'u'.repeat(10_000)),
      makeMsg(2, 'assistant', 'a'.repeat(10_000)),
    ]);

    await compactChatSessionInPlace('s1');

    const seed = h.setSessionCompactionStateMock.mock.calls[0][1].pendingSeed as string;
    expect(estimateTokens(seed)).toBeLessThanOrEqual(300);
  });
});

describe('D13 — getChatCompactionThreshold(turnModel, sessionId) com teto absoluto em dw-drive-*', () => {
  it('sessao dw-drive-*: min(percentual da janela, 80.000 default); sessao normal segue o percentual', () => {
    installKnownModel(1_000_000);
    expect(getChatCompactionThreshold(undefined, 'sess-humana')).toBe(800_000);
    expect(getChatCompactionThreshold(undefined, undefined)).toBe(800_000);
    expect(getChatCompactionThreshold(undefined, 'dw-drive-run-1-ab12')).toBe(80_000);
  });

  it('setting dynamic_workflow_drive_compaction_tokens valida vence o default; invalida cai no default', () => {
    installKnownModel(1_000_000);
    const withSetting = (value: string | undefined) =>
      h.getSettingMock.mockImplementation((key: string) => {
        if (key === 'orchestrator_model') return 'modelo-conhecido';
        if (key === 'orchestrator_provider') return 'anthropic';
        if (key === 'dynamic_workflow_drive_compaction_tokens') return value;
        return undefined;
      });
    h.getContextWindowMock.mockImplementation((model: string) =>
      model === 'modelo-conhecido' ? 1_000_000 : undefined,
    );

    withSetting('50000');
    expect(getChatCompactionThreshold(undefined, 'dw-drive-x')).toBe(50_000);
    withSetting('abc');
    expect(getChatCompactionThreshold(undefined, 'dw-drive-x')).toBe(80_000);
    withSetting('0');
    expect(getChatCompactionThreshold(undefined, 'dw-drive-x')).toBe(80_000);
    withSetting('50000');
    expect(getChatCompactionThreshold(undefined, 'chat-1')).toBe(800_000);
  });

  it('janela pequena: o percentual ja abaixo do teto e preservado (min, nao substituicao)', () => {
    installKnownModel(50_000);
    expect(getChatCompactionThreshold(undefined, 'dw-drive-x')).toBe(40_000);
  });

  it('janela desconhecida continua desabilitando o gatilho tambem em dw-drive-*', () => {
    h.getSettingMock.mockImplementation((key: string) =>
      key === 'orchestrator_model' ? 'modelo-desconhecido' : undefined,
    );
    h.getContextWindowMock.mockReturnValue(undefined);
    expect(getChatCompactionThreshold(undefined, 'dw-drive-x')).toBeUndefined();
  });
});
