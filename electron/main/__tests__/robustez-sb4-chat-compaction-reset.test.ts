
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => [] as string[]),
  unlinkSync: vi.fn(),
}));
vi.mock('fs', () => ({ default: fsMock }));

vi.mock('os', () => ({ default: { homedir: () => '/fake/home' } }));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../paths', () => ({ getLionClawHome: () => '/fake/home/.lionclaw' }));

const db = vi.hoisted(() => ({
  getActiveChatSession: vi.fn(),
  getSessionMessages: vi.fn(() => [{ id: 'm1', role: 'user', content: 'oi' }]),
  updateSessionStatus: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(() => ({ id: 'old-session', type: 'chat', taskId: undefined })),
  purgeActivityLog: vi.fn(),
  listActiveTelegramSessions: vi.fn(() => [{ id: 'tg-sess', sdkSessionId: 'tg-live' }]),
}));
vi.mock('../db', () => db);

const memoryPipeline = vi.hoisted(() => ({
  runCompaction: vi.fn(),
  resolveCompactionSelection: vi.fn(async () => ({ kind: 'claude', model: 'claude-sonnet-4' })),
}));
vi.mock('../memory-pipeline', () => memoryPipeline);

vi.mock('../memory-pipeline/oneshot-subscription', () => ({
  humanizeModelLabel: (s: unknown) => String(s),
}));

const resetSdkSessionState = vi.hoisted(() => vi.fn());
vi.mock('../orchestrator', () => ({ resetSdkSessionState }));

vi.mock('../telegram-bridge', () => ({ onTelegramSessionCompacted: vi.fn() }));

import { compactActiveChatSession } from '../ipc/_shared/chat-compaction';

function setupActiveSession(): void {
  db.getActiveChatSession.mockReturnValue({
    id: 'old-session',
    title: 't',
    type: 'chat',
    createdAt: new Date().toISOString(),
    inputTokens: 100,
    outputTokens: 50,
  });
}

describe('SB-4 chat-compaction reset garantido (P5/V6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupActiveSession();
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(['dead-thread.jsonl', 'tg-live.jsonl']);
  });

  it('AC-B10: switch com compactacao FALHA conclui com reset de sessao SDK (nao-vazamento cross-provider)', async () => {
    memoryPipeline.runCompaction.mockRejectedValue(new Error('quota estourada'));

    const result = await compactActiveChatSession(() => null, 'orchestrator-switch');

    expect(result.success).toBe(false);
    expect(result.reason).toBe('compaction_failed');
    expect(result.error).toContain('quota estourada');
    expect(fsMock.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('dead-thread.jsonl'),
    );
    expect(resetSdkSessionState).toHaveBeenCalled();
    expect(result.newSessionId).toBeDefined();
    expect(db.createSession).toHaveBeenCalledWith(
      result.newSessionId,
      '',
      undefined,
      { type: 'chat', taskId: undefined },
    );
    expect(db.updateSessionStatus).toHaveBeenCalledWith('old-session', 'archived');
    const unlinked = fsMock.unlinkSync.mock.calls.map((c) => String(c[0]));
    expect(unlinked.some((p) => p.endsWith('dead-thread.jsonl'))).toBe(true);
    expect(unlinked.some((p) => p.endsWith('tg-live.jsonl'))).toBe(false);
  });

  it('AC-B10: trigger manual com falha fica INALTERADO (sem reset, sem sessao nova — 0.3/D3)', async () => {
    memoryPipeline.runCompaction.mockRejectedValue(new Error('boom'));

    const result = await compactActiveChatSession(() => null, 'manual');

    expect(result).toEqual({
      success: false,
      reason: 'compaction_failed',
      error: 'boom',
    });
    expect(result.newSessionId).toBeUndefined();
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
    expect(resetSdkSessionState).not.toHaveBeenCalled();
    expect(db.createSession).not.toHaveBeenCalled();
    expect(db.updateSessionStatus).not.toHaveBeenCalled();
  });

  it('AC-B10: caminho de SUCESSO da troca segue identico (compacted + reset + sessao nova)', async () => {
    memoryPipeline.runCompaction.mockResolvedValue(undefined);

    const result = await compactActiveChatSession(() => null, 'orchestrator-switch');

    expect(result.success).toBe(true);
    expect(result.newSessionId).toBeDefined();
    expect(db.updateSessionStatus).toHaveBeenCalledWith('old-session', 'compacted');
    expect(resetSdkSessionState).toHaveBeenCalled();
    expect(fsMock.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('dead-thread.jsonl'),
    );
  });
});
