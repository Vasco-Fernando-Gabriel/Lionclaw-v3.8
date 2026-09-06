
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  class InvalidOrchestratorSelectionError extends Error {
    code: 'orchestrator_unconfigured' | 'orchestrator_provider_unavailable';
    missingField?: 'runtime' | 'provider' | 'model';
    constructor(
      message: string,
      code: 'orchestrator_unconfigured' | 'orchestrator_provider_unavailable' = 'orchestrator_unconfigured',
      missingField?: 'runtime' | 'provider' | 'model',
    ) {
      super(message);
      this.name = 'InvalidOrchestratorSelectionError';
      this.code = code;
      this.missingField = missingField;
    }
  }
  return {
    InvalidOrchestratorSelectionError,
    executeTelegramLaneQueryMock: vi.fn(async () => undefined),
    enqueueTelegramLaneTaskMock: vi.fn((fn: () => Promise<unknown>) => fn()),
    resetTelegramSessionStateMock: vi.fn(),
    prepareImpl: vi.fn((_sql: string): Record<string, unknown> => ({
      get: () => undefined,
      all: () => [],
      run: () => undefined,
    })),
  };
});

const InvalidOrchestratorSelectionError = h.InvalidOrchestratorSelectionError;

vi.mock('node-telegram-bot-api', () => ({ default: class {} }));
vi.mock('electron', () => ({ BrowserWindow: class {} }));

vi.mock('../db', () => ({
  getDb: vi.fn(() => ({ prepare: (sql: string) => h.prepareImpl(sql) })),
  createSession: vi.fn(),
  getSession: vi.fn(() => undefined),
  updateSessionStatus: vi.fn(),
  getSetting: vi.fn(() => undefined),
  listActiveTelegramSessions: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  setSessionCompactionState: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
}));

vi.mock('../orchestrator', () => ({
  executeTelegramLaneQuery: h.executeTelegramLaneQueryMock,
  enqueueTelegramLaneTask: h.enqueueTelegramLaneTaskMock,
  resetTelegramSessionState: h.resetTelegramSessionStateMock,
}));

vi.mock('../orchestrator-selection', () => ({
  InvalidOrchestratorSelectionError: h.InvalidOrchestratorSelectionError,
}));

vi.mock('../memory-pipeline', () => ({ runCompaction: vi.fn() }));
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
vi.mock('../knowledge-engine', () => ({ parseFile: vi.fn() }));

import { __telegramInternal } from '../telegram-bridge';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('bridge do Telegram: erro tipado do resolver -> mensagem especifica (SPEC 2.2)', () => {
  it('orchestrator_unconfigured -> mensagem fixa "abra Configuracoes no app"', async () => {
    h.executeTelegramLaneQueryMock.mockRejectedValueOnce(
      new InvalidOrchestratorSelectionError(
        'Orquestrador nao configurado: runtime ausente nos settings.',
        'orchestrator_unconfigured',
        'runtime',
      ),
    );

    const response = await __telegramInternal.executeTelegramQueryForTests(
      'oi',
      'tg-session',
      42,
      'Breno',
    );

    expect(response).toBe('Orquestrador nao configurado: abra Configuracoes no app.');
    expect(response).not.toMatch(/Erro ao processar/i);
  });

  it('orchestrator_provider_unavailable (gate S2->S3) -> mensagem do proprio erro', async () => {
    h.executeTelegramLaneQueryMock.mockRejectedValueOnce(
      new InvalidOrchestratorSelectionError(
        'runtime codex-sdk ainda nao habilitado para esta lane (telegram).',
        'orchestrator_provider_unavailable',
      ),
    );

    const response = await __telegramInternal.executeTelegramQueryForTests(
      'oi',
      'tg-session',
      42,
      'Breno',
    );

    expect(response).toMatch(/codex-sdk ainda nao habilitado/i);
    expect(response).not.toMatch(/Erro ao processar/i);
  });

  it('erro NAO-tipado do turno e re-lancado (nao vira mensagem especifica)', async () => {
    h.executeTelegramLaneQueryMock.mockRejectedValueOnce(new Error('boom generico do SDK'));

    await expect(
      __telegramInternal.executeTelegramQueryForTests('oi', 'tg-session', 42, 'Breno'),
    ).rejects.toThrow('boom generico do SDK');
  });
});
