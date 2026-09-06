
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listActiveTelegramSessionsMock: vi.fn((): Array<{ id: string; sdkSessionId?: string }> => []),
  updateSessionStatusMock: vi.fn(),
}));

vi.mock('node-telegram-bot-api', () => ({ default: class {} }));
vi.mock('electron', () => ({ BrowserWindow: class {} }));

vi.mock('../db', () => ({
  getDb: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  updateSessionStatus: h.updateSessionStatusMock,
  getSetting: vi.fn(),
  listActiveTelegramSessions: h.listActiveTelegramSessionsMock,
  getSessionMessages: vi.fn(() => []),
  setSessionCompactionState: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
}));

vi.mock('../orchestrator', () => ({
  executeTelegramLaneQuery: vi.fn(),
  enqueueTelegramLaneTask: vi.fn((fn: () => Promise<unknown>) => fn()),
  resetTelegramSessionState: vi.fn(),
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

import { setActiveTelegramSession } from '../telegram-bridge';

beforeEach(() => {
  h.listActiveTelegramSessionsMock.mockReset();
  h.listActiveTelegramSessionsMock.mockReturnValue([]);
  h.updateSessionStatusMock.mockClear();
});

describe('setActiveTelegramSession (SPEC 3.1 / AC-9)', () => {
  it('arquiva TODAS as outras sessoes telegram active (estado legado com varias)', () => {
    h.listActiveTelegramSessionsMock.mockReturnValue([
      { id: 'old-1' },
      { id: 'old-2' },
      { id: 'nova' },
    ]);

    setActiveTelegramSession('nova');

    expect(h.updateSessionStatusMock).toHaveBeenCalledTimes(2);
    expect(h.updateSessionStatusMock).toHaveBeenCalledWith('old-1', 'archived');
    expect(h.updateSessionStatusMock).toHaveBeenCalledWith('old-2', 'archived');
  });

  it('NUNCA arquiva a propria sessao nova', () => {
    h.listActiveTelegramSessionsMock.mockReturnValue([{ id: 'nova' }]);

    setActiveTelegramSession('nova');

    expect(h.updateSessionStatusMock).not.toHaveBeenCalled();
  });

  it('sem nenhuma active previa (criacao fresca): apenas ativa, nada a arquivar', () => {
    h.listActiveTelegramSessionsMock.mockReturnValue([]);

    setActiveTelegramSession('primeira');

    expect(h.updateSessionStatusMock).not.toHaveBeenCalled();
  });

  it('transicao encadeada preserva a invariante: cada nova ativa arquiva a anterior', () => {
    h.listActiveTelegramSessionsMock.mockReturnValue([{ id: 'a' }]);
    setActiveTelegramSession('b');
    expect(h.updateSessionStatusMock).toHaveBeenCalledWith('a', 'archived');

    h.updateSessionStatusMock.mockClear();
    h.listActiveTelegramSessionsMock.mockReturnValue([{ id: 'b' }]);
    setActiveTelegramSession('c');
    expect(h.updateSessionStatusMock).toHaveBeenCalledWith('b', 'archived');
    expect(h.updateSessionStatusMock).toHaveBeenCalledTimes(1);
  });
});
