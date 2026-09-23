import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ChatMessage, ChatSession } from '../../../src/types';

const h = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getSessionMessagesMock: vi.fn((): unknown[] => []),
  getSettingMock: vi.fn((_key: string): string | undefined => undefined),
  setSessionCompactionStateMock: vi.fn(),
  setSessionActiveContextTokensMock: vi.fn(),
  updateSessionStatusMock: vi.fn(),
  createSessionMock: vi.fn(),
  listActiveTelegramSessionsMock: vi.fn((): Array<{ id: string }> => []),
  prepareImpl: vi.fn((_sql: string): Record<string, unknown> => ({
    get: () => undefined,
    all: () => [],
    run: () => undefined,
  })),
  runCompactionMock: vi.fn(),
  enqueueTelegramLaneTaskMock: vi.fn((fn: () => Promise<unknown>) => fn()),
  resetTelegramSessionStateMock: vi.fn(),
}));

vi.mock('node-telegram-bot-api', () => ({ default: class {} }));
vi.mock('electron', () => ({ BrowserWindow: class {} }));

vi.mock('../db', () => ({
  getDb: vi.fn(() => ({ prepare: (sql: string) => h.prepareImpl(sql) })),
  createSession: h.createSessionMock,
  getSession: h.getSessionMock,
  updateSessionStatus: h.updateSessionStatusMock,
  getSetting: h.getSettingMock,
  listActiveTelegramSessions: h.listActiveTelegramSessionsMock,
  getSessionMessages: h.getSessionMessagesMock,
  setSessionCompactionState: h.setSessionCompactionStateMock,
  setSessionActiveContextTokens: h.setSessionActiveContextTokensMock,
}));

vi.mock('../orchestrator', () => ({
  executeTelegramLaneQuery: vi.fn(),
  enqueueTelegramLaneTask: h.enqueueTelegramLaneTaskMock,
  resetTelegramSessionState: h.resetTelegramSessionStateMock,
}));

vi.mock('../memory-pipeline', () => ({
  runCompaction: h.runCompactionMock,
  isCompactionStepError: (err: unknown) =>
    typeof err === 'object' && err !== null && (err as { name?: string }).name === 'CompactionStepError',
}));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(async () => null) }));
vi.mock('../channels-db', () => ({ updateChannelStatus: vi.fn() }));
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));
vi.mock('../scheduler', () => ({
  getAllScheduledTasks: vi.fn(() => []),
  getPendingReviewCount: vi.fn(() => 0),
}));
vi.mock('../voice-engine', () => ({ transcribeAudio: vi.fn() }));

import {
  compactTelegramSessionInPlace,
  buildTelegramCompactionSeed,
  TELEGRAM_DREAMING_BUSY_MESSAGE,
  __telegramInternal,
} from '../telegram-bridge';
import { resetDreamingMutexForTests, tryAcquireDreamingMutex } from '../dreaming-mutex';
import { estimateTokens } from '../token-estimator';

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's1',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    status: 'active',
    type: 'telegram',
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

beforeEach(() => {
  vi.clearAllMocks();
  h.getSettingMock.mockReturnValue(undefined);
  h.getSessionMessagesMock.mockReturnValue([]);
  h.listActiveTelegramSessionsMock.mockReturnValue([]);
  h.enqueueTelegramLaneTaskMock.mockImplementation((fn: () => Promise<unknown>) => fn());
  h.prepareImpl.mockImplementation((_sql: string) => ({
    get: () => undefined,
    all: () => [],
    run: () => undefined,
  }));
  h.runCompactionMock.mockResolvedValue(OK_SUMMARY);
  __telegramInternal.setBotForTests(null);
  __telegramInternal.setActiveSessionIdForTests(null);
  __telegramInternal.resetCompactionBackoffForTests();
  resetDreamingMutexForTests();
});

function memoryFailedError(): Error {
  const err = new Error('Gate de memoria / MEMORY.md / USER.md falhou: disco cheio');
  err.name = 'CompactionStepError';
  (err as Error & { code: string }).code = 'COMPACT-MEMORY-FAILED';
  return err;
}

describe('compactTelegramSessionInPlace (SPEC 5.4)', () => {
  it('compacta IN-PLACE: mesma sessao, sem createSession, sem status compacted (AC-13)', async () => {
    h.getSessionMock.mockReturnValue(makeSession());
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola, tudo bem?')]);

    const outcome = await compactTelegramSessionInPlace('s1', { force: true });

    expect(outcome.ok).toBe(true);
    expect(outcome.noop).toBeUndefined();
    expect(h.createSessionMock).not.toHaveBeenCalled();
    expect(h.updateSessionStatusMock).not.toHaveBeenCalled();
    expect(h.setSessionCompactionStateMock).toHaveBeenCalledTimes(1);
    const [sid, state] = h.setSessionCompactionStateMock.mock.calls[0];
    expect(sid).toBe('s1');
    expect(state.compactedUpToMessageId).toBe(2);
    expect(state.rollingSummary).toBe('resumo rolante novo');
    expect(state.pendingSeed).toContain('[Resumo da conversa ate aqui]: resumo rolante novo');
    expect(state.pendingSeed).toContain('[user] oi');
    expect(state.pendingSeed).toContain('[assistant] ola, tudo bem?');
    expect(typeof state.sdkSessionId).toBe('string');
    expect(state.sdkSessionId).not.toBe('s1');
    expect(h.resetTelegramSessionStateMock).toHaveBeenCalledTimes(1);
  });

  it('recalibra o contador ATIVO para o tamanho do seed; historicos intocados (AC-21)', async () => {
    h.getSessionMock.mockReturnValue(makeSession());
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola')]);

    await compactTelegramSessionInPlace('s1', { force: true });

    expect(h.setSessionActiveContextTokensMock).toHaveBeenCalledTimes(1);
    const [sid, tokens] = h.setSessionActiveContextTokensMock.mock.calls[0];
    expect(sid).toBe('s1');
    const seed = h.setSessionCompactionStateMock.mock.calls[0][1].pendingSeed as string;
    expect(tokens).toBe(estimateTokens(seed));
  });

  it('delta pela fronteira: runCompaction recebe sinceMessageId + priorSummary + skipDailySummary (AC-15/AC-72)', async () => {
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

    await compactTelegramSessionInPlace('s1', { force: true });

    expect(h.runCompactionMock).toHaveBeenCalledTimes(1);
    const [, , sessionId, opts] = h.runCompactionMock.mock.calls[0];
    expect(sessionId).toBe('s1');
    expect(opts).toMatchObject({
      sinceMessageId: 2,
      priorSummary: 'resumo anterior',
      skipDailySummary: true,
    });
    expect(h.setSessionCompactionStateMock.mock.calls[0][1].compactedUpToMessageId).toBe(4);
  });

  it('sessao nunca compactada (fronteira NULL): runCompaction SEM sinceMessageId', async () => {
    h.getSessionMock.mockReturnValue(makeSession());
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola')]);

    await compactTelegramSessionInPlace('s1', { force: true });

    const [, , , opts] = h.runCompactionMock.mock.calls[0];
    expect(opts.sinceMessageId).toBeUndefined();
    expect(opts.priorSummary).toBeUndefined();
    expect(opts.skipDailySummary).toBe(true);
  });

  it('falha do summarizer ABORTA antes do re-seed: estado intacto (AC-18)', async () => {
    h.getSessionMock.mockReturnValue(makeSession());
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi')]);
    h.runCompactionMock.mockRejectedValue(new Error('summarizer retornou resposta vazia'));

    const outcome = await compactTelegramSessionInPlace('s1', { force: true });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/resposta vazia/);
    expect(h.setSessionCompactionStateMock).not.toHaveBeenCalled();
    expect(h.setSessionActiveContextTokensMock).not.toHaveBeenCalled();
    expect(h.resetTelegramSessionStateMock).not.toHaveBeenCalled();
    expect(h.updateSessionStatusMock).not.toHaveBeenCalled();
  });

  it('logout durante o summarizer descarta o resultado antes de qualquer commit', async () => {
    h.getSessionMock.mockReturnValue(makeSession());
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi')]);
    let releaseCompaction: () => void = () => {
      throw new Error('summarizer ainda nao iniciou');
    };
    h.runCompactionMock.mockImplementationOnce(
      () =>
        new Promise<typeof OK_SUMMARY>((resolve) => {
          releaseCompaction = () => resolve(OK_SUMMARY);
        }),
    );
    let active = true;

    const outcome = compactTelegramSessionInPlace('s1', {
      force: true,
      currentBot: null,
      isActive: () => active,
    });
    await vi.waitFor(() => expect(h.runCompactionMock).toHaveBeenCalledTimes(1));
    active = false;
    releaseCompaction();

    await expect(outcome).resolves.toMatchObject({ ok: false, noop: true });
    expect(h.setSessionCompactionStateMock).not.toHaveBeenCalled();
    expect(h.setSessionActiveContextTokensMock).not.toHaveBeenCalled();
    expect(h.resetTelegramSessionStateMock).not.toHaveBeenCalled();
  });

  it('D6/AC-6: mutex do dreaming ocupado = noop dreaming_busy, sem bloquear e sem runCompaction', async () => {
    h.getSessionMock.mockReturnValue(makeSession());
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi')]);
    const release = tryAcquireDreamingMutex();
    expect(release).not.toBeNull();

    const outcome = await compactTelegramSessionInPlace('s1', { force: true });

    expect(outcome).toEqual({ ok: true, noop: true, reason: 'dreaming_busy' });
    expect(h.runCompactionMock).not.toHaveBeenCalled();
    expect(h.setSessionCompactionStateMock).not.toHaveBeenCalled();
    release!();

    const after = await compactTelegramSessionInPlace('s1', { force: true });
    expect(after.ok).toBe(true);
    expect(after.noop).toBeUndefined();
    const [, , , opts] = h.runCompactionMock.mock.calls[0];
    expect(opts.dreamingMutex).toBe('held');
  });

  it('6.7: COMPACT-MEMORY-FAILED arma backoff, boundary intacto, e o automatico nao re-tenta no proximo turno', async () => {
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 10_000_000 }));
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi')]);
    h.runCompactionMock.mockRejectedValue(memoryFailedError());

    const outcome = await compactTelegramSessionInPlace('s1', { force: true, notify: false });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/disco cheio/);
    expect(h.setSessionCompactionStateMock).not.toHaveBeenCalled();
    expect(__telegramInternal.getCompactionBackoffUntilForTests('s1')).toBeGreaterThan(Date.now());

    h.runCompactionMock.mockClear();
    await __telegramInternal.maybeCompactTelegramSession('s1', null, () => true);
    expect(h.enqueueTelegramLaneTaskMock).not.toHaveBeenCalled();
    expect(h.runCompactionMock).not.toHaveBeenCalled();
  });

  it('delta vazio = noop (nada a compactar, nada reescrito)', async () => {
    h.getSessionMock.mockReturnValue(makeSession({ compactedUpToMessageId: 2 }));
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'a'), makeMsg(2, 'assistant', 'b')]);

    const outcome = await compactTelegramSessionInPlace('s1', { force: true });

    expect(outcome).toEqual({ ok: true, noop: true });
    expect(h.runCompactionMock).not.toHaveBeenCalled();
    expect(h.setSessionCompactionStateMock).not.toHaveBeenCalled();
  });

  it('guardas: sessao inexistente / nao-telegram / nao-active recusam', async () => {
    h.getSessionMock.mockReturnValue(undefined);
    expect((await compactTelegramSessionInPlace('sx', { force: true })).ok).toBe(false);

    h.getSessionMock.mockReturnValue(makeSession({ type: 'chat' }));
    expect((await compactTelegramSessionInPlace('s1', { force: true })).ok).toBe(false);

    h.getSessionMock.mockReturnValue(makeSession({ status: 'archived' }));
    expect((await compactTelegramSessionInPlace('s1', { force: true })).ok).toBe(false);

    expect(h.runCompactionMock).not.toHaveBeenCalled();
  });
});

describe('gatilho min(600k, 75% janela) (SPEC 5.2 / AC-13)', () => {
  it('modelo de janela 200k (haiku): threshold = 200k * 0.75 = 150k (vence o absoluto 600k)', () => {
    h.getSettingMock.mockImplementation((key: string) =>
      key === 'orchestrator_model' ? 'claude-haiku-4-5-20251001' : undefined,
    );
    expect(__telegramInternal.getTelegramCompactionThreshold()).toBe(150_000);
  });

  it('modelo de janela 1M (opus/sonnet atuais): absoluto 600k vence (75% de 1M = 750k)', () => {
    h.getSettingMock.mockImplementation((key: string) =>
      key === 'orchestrator_model' ? 'claude-opus-4-8' : undefined,
    );
    expect(__telegramInternal.getTelegramCompactionThreshold()).toBe(600_000);
    h.getSettingMock.mockImplementation((key: string) =>
      key === 'orchestrator_model' ? 'claude-sonnet-4-6' : undefined,
    );
    expect(__telegramInternal.getTelegramCompactionThreshold()).toBe(600_000);
  });

  it('modelo desconhecido: cai SO no threshold absoluto (600k default)', () => {
    h.getSettingMock.mockImplementation((key: string) => (key === 'orchestrator_model' ? 'super-model-x' : undefined));
    expect(__telegramInternal.getTelegramCompactionThreshold()).toBe(600_000);
  });

  it('settings customizados vencem os defaults', () => {
    h.getSettingMock.mockImplementation((key: string) => {
      if (key === 'telegram_compaction_token_threshold') return '100000';
      if (key === 'orchestrator_model') return 'super-model-x';
      return undefined;
    });
    expect(__telegramInternal.getTelegramCompactionThreshold()).toBe(100_000);
  });

  it('tokens ativos: usa active_context_tokens_est; fallback input+output quando NULL', () => {
    expect(
      __telegramInternal.getActiveContextTokens(
        makeSession({ activeContextTokensEst: 42, inputTokens: 999_999, outputTokens: 999_999 }),
      ),
    ).toBe(42);
    expect(__telegramInternal.getActiveContextTokens(makeSession({ inputTokens: 300, outputTokens: 200 }))).toBe(500);
  });

  it('abaixo do threshold: force=false vira noop; force=true roda mesmo assim (AC-19)', async () => {
    h.getSettingMock.mockImplementation((key: string) =>
      key === 'orchestrator_model' ? 'claude-sonnet-4-6' : undefined,
    );
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 1_000 }));
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi')]);

    const below = await compactTelegramSessionInPlace('s1', { force: false });
    expect(below).toEqual({ ok: true, noop: true });
    expect(h.runCompactionMock).not.toHaveBeenCalled();

    const forced = await compactTelegramSessionInPlace('s1', { force: true });
    expect(forced.ok).toBe(true);
    expect(h.runCompactionMock).toHaveBeenCalledTimes(1);
  });

  it('acima do threshold: force=false compacta', async () => {
    h.getSettingMock.mockImplementation((key: string) =>
      key === 'orchestrator_model' ? 'claude-sonnet-4-6' : undefined,
    );
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 650_000 }));
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi')]);

    const outcome = await compactTelegramSessionInPlace('s1', { force: false });
    expect(outcome.ok).toBe(true);
    expect(h.runCompactionMock).toHaveBeenCalledTimes(1);
  });

  it('maybeCompactTelegramSession enfileira na telegramQueueChain so acima do threshold (SPEC 5.3)', async () => {
    h.getSettingMock.mockImplementation((key: string) =>
      key === 'orchestrator_model' ? 'claude-sonnet-4-6' : undefined,
    );

    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 1_000 }));
    await __telegramInternal.maybeCompactTelegramSession('s1');
    expect(h.enqueueTelegramLaneTaskMock).not.toHaveBeenCalled();

    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 650_000 }));
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi')]);
    await __telegramInternal.maybeCompactTelegramSession('s1');
    expect(h.enqueueTelegramLaneTaskMock).toHaveBeenCalledTimes(1);
    expect(h.runCompactionMock).toHaveBeenCalledTimes(1);
  });

  it('maybeCompactTelegramSession ignora sessao nao-telegram/nao-active', async () => {
    h.getSessionMock.mockReturnValue(makeSession({ type: 'chat', activeContextTokensEst: 999_999 }));
    await __telegramInternal.maybeCompactTelegramSession('s1');
    expect(h.enqueueTelegramLaneTaskMock).not.toHaveBeenCalled();
  });
});

describe('buildTelegramCompactionSeed (SPEC 5.4 passo 6 / AC-14)', () => {
  it('tudo cabe: header + turnos verbatim em ordem cronologica', () => {
    const seed = buildTelegramCompactionSeed(
      'resumo X',
      [
        makeMsg(1, 'user', 'primeira pergunta'),
        makeMsg(2, 'assistant', 'primeira resposta'),
        makeMsg(3, 'user', 'segunda pergunta'),
        makeMsg(4, 'assistant', 'segunda resposta'),
      ],
      50_000,
    );

    expect(seed.startsWith('[Resumo da conversa ate aqui]: resumo X')).toBe(true);
    const firstTurnIdx = seed.indexOf('[user] primeira pergunta');
    const secondTurnIdx = seed.indexOf('[user] segunda pergunta');
    expect(firstTurnIdx).toBeGreaterThan(-1);
    expect(secondTurnIdx).toBeGreaterThan(firstTurnIdx);
    expect(seed).toContain('[assistant] primeira resposta');
    expect(seed).toContain('[assistant] segunda resposta');
    expect(seed).not.toContain('[turno truncado]');
  });

  it('teto DURO: seed <= target; mais recente entra, mais antigo cai', () => {
    const target = 1_000;
    const messages: ChatMessage[] = [];
    for (let t = 0; t < 10; t++) {
      messages.push(makeMsg(t * 2 + 1, 'user', `pergunta-${t} ` + 'x'.repeat(600)));
      messages.push(makeMsg(t * 2 + 2, 'assistant', `resposta-${t} ` + 'y'.repeat(600)));
    }

    const seed = buildTelegramCompactionSeed('resumo curto', messages, target);

    expect(estimateTokens(seed)).toBeLessThanOrEqual(target);
    expect(seed).toContain('pergunta-9');
    expect(seed).not.toContain('pergunta-0');
  });

  it('turno unico gigante: minimo 1 turno, truncado no INICIO com [turno truncado]', () => {
    const target = 500;
    const giant = 'INICIO-DESCARTAVEL ' + 'm'.repeat(50_000) + ' FINAL-IMPORTANTE';
    const seed = buildTelegramCompactionSeed('resumo', [makeMsg(1, 'user', giant)], target);

    expect(estimateTokens(seed)).toBeLessThanOrEqual(target);
    expect(seed).toContain('[turno truncado]');
    expect(seed).toContain('FINAL-IMPORTANTE');
    expect(seed).not.toContain('INICIO-DESCARTAVEL');
  });

  it('o bloco de resumo e descontado primeiro (o resumo sempre cabe)', () => {
    const rolling = 'R'.repeat(1_200);
    const seed = buildTelegramCompactionSeed(rolling, [makeMsg(1, 'user', 'u'.repeat(4_000))], 400);
    expect(seed).toContain(rolling);
    expect(estimateTokens(seed)).toBeLessThanOrEqual(400);
  });
});

interface FakeBot {
  sendMessage: ReturnType<typeof vi.fn>;
  sendChatAction: ReturnType<typeof vi.fn>;
}

function installFakeBot(): FakeBot {
  const fake: FakeBot = {
    sendMessage: vi.fn(async () => undefined),
    sendChatAction: vi.fn(async () => undefined),
  };
  __telegramInternal.setBotForTests(fake);
  return fake;
}

const FAKE_CONFIG = {
  allowedUserId: 42,
  allowedUserName: 'Dono',
  sessionMode: 'continuous' as const,
  notifyOnSchedulerTasks: true,
  notifyOnDriveHandoff: false,
};

function installDbForCommands(): void {
  h.prepareImpl.mockImplementation((sql: string) => {
    if (sql.includes('FROM channels')) {
      return { get: () => ({ config: JSON.stringify(FAKE_CONFIG) }), all: () => [], run: () => undefined };
    }
    if (sql.includes('COUNT(*)')) {
      return { get: () => ({ c: 1 }), all: () => [], run: () => undefined };
    }
    return { get: () => undefined, all: () => [], run: () => undefined };
  });
}

function sentTexts(bot: FakeBot): string[] {
  return bot.sendMessage.mock.calls.map((c) => String(c[1]));
}

describe('comandos do bot (SPEC 6)', () => {
  beforeEach(() => {
    installDbForCommands();
    __telegramInternal.setActiveSessionIdForTests('s1');
  });

  it('/compact roda SEMPRE (mesmo abaixo do threshold), sessao continua ativa, usuario avisado (AC-19/20)', async () => {
    const bot = installFakeBot();
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 10 }));
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola')]);

    await __telegramInternal.handleBotCommand('/compact', 42, FAKE_CONFIG);

    expect(h.enqueueTelegramLaneTaskMock).toHaveBeenCalledTimes(1);
    expect(h.runCompactionMock).toHaveBeenCalledTimes(1);
    expect(h.setSessionCompactionStateMock).toHaveBeenCalledTimes(1);
    expect(h.updateSessionStatusMock).not.toHaveBeenCalled();
    expect(sentTexts(bot).some((t) => t.includes('Compactei nossa conversa'))).toBe(true);
  });

  it('/compact com Clear do desktop em andamento responde dreaming_busy sem prender a cadeia', async () => {
    const bot = installFakeBot();
    h.getSessionMock.mockReturnValue(makeSession());
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola')]);
    const release = tryAcquireDreamingMutex();

    await __telegramInternal.handleBotCommand('/compact', 42, FAKE_CONFIG);

    expect(h.runCompactionMock).not.toHaveBeenCalled();
    expect(sentTexts(bot)).toContain(TELEGRAM_DREAMING_BUSY_MESSAGE);
    release!();
  });

  it('/compact sem nada novo: responde noop e nao mexe em nada', async () => {
    const bot = installFakeBot();
    h.getSessionMock.mockReturnValue(makeSession({ compactedUpToMessageId: 2 }));
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'a'), makeMsg(2, 'assistant', 'b')]);

    await __telegramInternal.handleBotCommand('/compact', 42, FAKE_CONFIG);

    expect(h.runCompactionMock).not.toHaveBeenCalled();
    expect(sentTexts(bot).some((t) => t.includes('Nada novo para compactar'))).toBe(true);
  });

  it('/clear salva na memoria, ARQUIVA e zera RAM + lane (AC-19)', async () => {
    const bot = installFakeBot();
    h.getSessionMock.mockReturnValue(makeSession());
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi'), makeMsg(2, 'assistant', 'ola')]);

    await __telegramInternal.handleBotCommand('/clear', 42, FAKE_CONFIG);

    expect(h.runCompactionMock).toHaveBeenCalledTimes(1);
    expect(h.updateSessionStatusMock).toHaveBeenCalledWith('s1', 'archived');
    expect(h.resetTelegramSessionStateMock).toHaveBeenCalled();
    expect(__telegramInternal.getActiveSessionIdForTests()).toBeNull();
    expect(sentTexts(bot).some((t) => t.includes('Conversa salva na memoria e encerrada'))).toBe(true);
    expect(sentTexts(bot).some((t) => t.includes('Compactei nossa conversa'))).toBe(false);
  });

  it('/clear com compactacao falhando NAO arquiva (nada se perde) (AC-19)', async () => {
    const bot = installFakeBot();
    h.getSessionMock.mockReturnValue(makeSession());
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi')]);
    h.runCompactionMock.mockRejectedValue(new Error('summarizer retornou resposta vazia'));

    await __telegramInternal.handleBotCommand('/clear', 42, FAKE_CONFIG);

    expect(h.updateSessionStatusMock).not.toHaveBeenCalled();
    expect(__telegramInternal.getActiveSessionIdForTests()).toBe('s1');
    expect(sentTexts(bot).some((t) => t.includes('nao encerrei'))).toBe(true);
  });

  it('/reset e alias de /clear (mesmo fluxo; zerar-so-a-RAM deixou de existir)', async () => {
    const bot = installFakeBot();
    h.getSessionMock.mockReturnValue(makeSession());
    h.getSessionMessagesMock.mockReturnValue([makeMsg(1, 'user', 'oi')]);

    await __telegramInternal.handleBotCommand('/reset', 42, FAKE_CONFIG);

    expect(h.runCompactionMock).toHaveBeenCalledTimes(1);
    expect(h.updateSessionStatusMock).toHaveBeenCalledWith('s1', 'archived');
    expect(sentTexts(bot).some((t) => t.includes('Conversa salva na memoria e encerrada'))).toBe(true);
  });

  it('/status mostra contexto: tokens ativos / threshold (pct) e o target (AC-20)', async () => {
    const bot = installFakeBot();
    h.getSettingMock.mockImplementation((key: string) =>
      key === 'orchestrator_model' ? 'claude-sonnet-4-6' : undefined,
    );
    h.getSessionMock.mockReturnValue(makeSession({ activeContextTokensEst: 75_000 }));

    await __telegramInternal.handleBotCommand('/status', 42, FAKE_CONFIG);

    const status = sentTexts(bot).find((t) => t.includes('Status do LionClaw'));
    expect(status).toBeDefined();
    expect(status).toContain('Contexto: 75000 / 600000 (13%)');
    expect(status).toContain('alvo pos-compactacao: 50000');
  });

  it('/help lista /compact, /clear, /reset, /status e /tasks', async () => {
    const bot = installFakeBot();

    await __telegramInternal.handleBotCommand('/help', 42, FAKE_CONFIG);

    const help = sentTexts(bot)[0];
    expect(help).toContain('/compact');
    expect(help).toContain('/clear');
    expect(help).toContain('/reset');
    expect(help).toContain('/status');
    expect(help).toContain('/tasks');
  });
});
