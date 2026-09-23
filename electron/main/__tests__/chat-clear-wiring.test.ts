import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import type { ChatSession } from '../../../src/types';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const h = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  messages: new Map<string, string[]>(),
  executionState: new Map<string, 'streaming' | 'queued' | 'idle'>(),
  runCompactionMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  stopDesktopSessionQueryMock: vi.fn<(id: string) => void>(),
  closeCachedMock: vi.fn(),
  closeAllMock: vi.fn(),
  replaceLaneSessionMock:
    vi.fn<(input: { sessionId: string; finalStatus: string }) => { newSessionId: string | null }>(),
  onLaneClearFinishedMock: vi.fn<(sessionId: string) => void>(),
  stopDriveMock: vi.fn<(projectId: string, reason: string) => void>(),
}));

vi.mock('../db', () => ({
  getSession: (id: string) => h.sessions.get(id),
  countSessionMessages: (id: string) => (h.messages.get(id) ?? []).length,
  isOpenDesktopConversation: (s: { status: string; type: string; id: string }) =>
    s.status === 'active' && (s.type === 'chat' || s.type === 'manual') && !s.id.startsWith('dw-drive-'),
  setDreamingStartedAt: vi.fn(),
  replaceLaneSession: (input: { sessionId: string; finalStatus: string }) => h.replaceLaneSessionMock(input),
  getSessionsWithDreamingStarted: () => [],
  getSetting: () => undefined,
}));
vi.mock('../memory-pipeline', () => ({
  runCompaction: (...args: unknown[]) => h.runCompactionMock(...args),
  resolveCompactionSelection: async () => ({ kind: 'claude', model: 'claude-sonnet-4-6' }),
}));
vi.mock('../memory-pipeline/oneshot-subscription', () => ({ humanizeModelLabel: (s: string) => s }));
vi.mock('../orchestrator-selection', () => ({
  readDefaultOrchestratorColumns: () => ({ runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-sonnet-4-6' }),
}));
vi.mock('../orchestrator', () => ({
  getDesktopSessionExecutionState: (id: string) => h.executionState.get(id) ?? 'idle',
  stopDesktopSessionQuery: (id: string) => h.stopDesktopSessionQueryMock(id),
}));
vi.mock('../chat-compaction-inplace', () => ({ isChatSessionCompacting: () => false }));
vi.mock('../session-drive', () => ({ listActiveDriveProjectIdsForSession: () => [] }));
vi.mock('../pipeline-drive-coordinator', () => ({
  getPipelineDriveCoordinator: () => ({
    stopDrive: h.stopDriveMock,
    onLaneClearFinished: h.onLaneClearFinishedMock,
  }),
}));
vi.mock('../codex-sdk', () => ({
  closeCachedChatCodexSession: (id: string, reason: string) => h.closeCachedMock(id, reason),
  closeAllCachedChatCodexSessions: (...args: unknown[]) => h.closeAllMock(...args),
}));

import { clearLaneSession } from '../chat-clear';
import { clearingSessions, markSessionClearing } from '../clearing-sessions';
import { resetDreamingMutexForTests } from '../dreaming-mutex';
import {
  clearInFlightDesktopTurn,
  getInFlightDesktopSessions,
  markDesktopSessionInFlight,
  setInFlightDesktopTurn,
} from '../in-flight-desktop-session';
import { resetExternalStopWaitersForTests } from '../turn-settle';

function seedLane(id: string, badge: number, messages: string[]): void {
  const session: ChatSession = {
    id,
    title: `Conversa ${id}`,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    status: 'active',
    type: 'chat',
    laneBadge: badge,
    createdAt: '2026-09-08 10:00:00',
    updatedAt: '2026-09-08 10:00:00',
    rollingSummary: 'resumo',
  };
  h.sessions.set(id, session as unknown as Record<string, unknown>);
  h.messages.set(id, [...messages]);
}

const fsSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  h.sessions.clear();
  h.messages.clear();
  h.executionState.clear();
  h.runCompactionMock.mockReset().mockResolvedValue({ executiveSummary: 'resumo', warnings: [] });
  h.stopDesktopSessionQueryMock.mockReset();
  h.closeCachedMock.mockReset();
  h.closeAllMock.mockReset();
  h.replaceLaneSessionMock.mockReset().mockImplementation((input) => {
    const s = h.sessions.get(input.sessionId)!;
    const badge = s['laneBadge'] as number | null;
    h.sessions.set(input.sessionId, { ...s, status: input.finalStatus, laneBadge: null });
    if (badge === null) return { newSessionId: null };
    seedLane(`${input.sessionId}-new`, badge, []);
    return { newSessionId: `${input.sessionId}-new` };
  });
  h.onLaneClearFinishedMock.mockReset();
  h.stopDriveMock.mockReset();
  clearingSessions.clear();
  resetDreamingMutexForTests();
  resetExternalStopWaitersForTests();
  clearInFlightDesktopTurn('lane-a');
  clearInFlightDesktopTurn('lane-b');
  markDesktopSessionInFlight('lane-a', false);
  fsSpies.push(
    vi.spyOn(fs, 'unlinkSync'),
    vi.spyOn(fs, 'rmSync'),
    vi.spyOn(fs.promises, 'unlink'),
    vi.spyOn(fs.promises, 'rm'),
  );
});

afterEach(() => {
  for (const spy of fsSpies.splice(0)) spy.mockRestore();
});

function expectNoFileDeleted(): void {
  for (const spy of fsSpies) expect(spy).not.toHaveBeenCalled();
}

describe('AC-1: clear(B) durante turno em A (wiring real de chat-clear.ts)', () => {
  it('A termina normalmente, B vira compacted no mesmo badge, nada apagado, closeAll nunca chamado', async () => {
    seedLane('lane-a', 1, ['u1', 'a1', 'u2']);
    seedLane('lane-b', 2, ['u1', 'a1']);
    let finishA: () => void = () => {};
    const turnA = new Promise<void>((resolve) => {
      finishA = resolve;
    });
    setInFlightDesktopTurn('lane-a', turnA);
    markDesktopSessionInFlight('lane-a', true);
    h.executionState.set('lane-a', 'streaming');

    const result = await clearLaneSession('lane-b');

    expect(result).toMatchObject({ ok: true, sessionId: 'lane-b', newSessionId: 'lane-b-new' });
    expect(h.runCompactionMock).toHaveBeenCalledTimes(1);
    expect(h.runCompactionMock.mock.calls[0]?.[2]).toBe('lane-b');
    expect(h.sessions.get('lane-b')?.['status']).toBe('compacted');
    expect(h.sessions.get('lane-b-new')?.['laneBadge']).toBe(2);
    expect(h.stopDesktopSessionQueryMock).not.toHaveBeenCalled();
    expect(h.closeAllMock).not.toHaveBeenCalled();
    expect(h.closeCachedMock).toHaveBeenCalledTimes(1);
    expect(h.closeCachedMock).toHaveBeenCalledWith('lane-b', 'lane-clear');
    expectNoFileDeleted();

    expect(getInFlightDesktopSessions()).toEqual(['lane-a']);
    expect(h.sessions.get('lane-a')?.['status']).toBe('active');
    expect(h.sessions.get('lane-a')?.['laneBadge']).toBe(1);
    finishA();
    await expect(turnA).resolves.toBeUndefined();
  });

  it('o caminho de chat nunca referencia clearSDKSessionFiles/resetSdkSessionState/closeAllCachedChatCodexSessions', () => {
    const forbidden = ['clearSDKSessionFiles', 'resetSdkSessionState', 'closeAllCachedChatCodexSessions'];
    for (const file of ['../chat-clear.ts', '../chat-clear-core.ts']) {
      const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
      for (const symbol of forbidden) expect(source).not.toContain(symbol);
    }
  });
});

describe('AC-2: force aguarda o executor assentar e o dreaming ve a ultima mensagem persistida no abort', () => {
  it('a mensagem gravada no finally do executor abortado chega ao runCompaction', async () => {
    seedLane('lane-a', 1, ['u1', 'a1']);
    let finishTurn: () => void = () => {};
    const turnA = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    setInFlightDesktopTurn('lane-a', turnA);
    markDesktopSessionInFlight('lane-a', true);
    h.executionState.set('lane-a', 'streaming');
    const order: string[] = [];

    h.stopDesktopSessionQueryMock.mockImplementation((id) => {
      order.push(`stop:${id}`);
      setTimeout(() => {
        h.messages.get('lane-a')!.push('assistant:parcial-persistida-no-abort');
        order.push('persist-final');
        h.executionState.set('lane-a', 'idle');
        markDesktopSessionInFlight('lane-a', false);
        finishTurn();
      }, 10);
    });
    let seenByDreaming: string[] = [];
    h.runCompactionMock.mockImplementation(async (...args: unknown[]) => {
      order.push('runCompaction');
      seenByDreaming = [...(h.messages.get(args[2] as string) ?? [])];
      return { executiveSummary: 'resumo', warnings: [] };
    });

    const result = await clearLaneSession('lane-a', { force: true });

    expect(result).toMatchObject({ ok: true, sessionId: 'lane-a', newSessionId: 'lane-a-new' });
    expect(order).toEqual(['stop:lane-a', 'persist-final', 'runCompaction']);
    expect(seenByDreaming).toContain('assistant:parcial-persistida-no-abort');
    expectNoFileDeleted();
  });
});

describe('AC (SPEC 7.3/7.4): o fim do Clear notifica o coordinator pelo wiring real de chat-clear.ts', () => {
  it('Clear concluido chama onLaneClearFinished com a conversa NOVA (lane resultante do re-bind)', async () => {
    seedLane('lane-a', 1, ['u1', 'a1']);

    const result = await clearLaneSession('lane-a');

    expect(result).toMatchObject({ ok: true, newSessionId: 'lane-a-new' });
    expect(h.onLaneClearFinishedMock).toHaveBeenCalledTimes(1);
    expect(h.onLaneClearFinishedMock).toHaveBeenCalledWith('lane-a-new');
  });

  it('Clear sem conversa nova (sem badge) notifica a propria sessao', async () => {
    seedLane('lane-a', 1, ['u1', 'a1']);
    h.replaceLaneSessionMock.mockImplementationOnce((input) => {
      const s = h.sessions.get(input.sessionId)!;
      h.sessions.set(input.sessionId, { ...s, status: input.finalStatus, laneBadge: null });
      return { newSessionId: null };
    });

    await clearLaneSession('lane-a');

    expect(h.onLaneClearFinishedMock).toHaveBeenCalledWith('lane-a');
  });

  it('Refazer Clear (state interrupted) tambem notifica o coordinator ao concluir', async () => {
    seedLane('lane-a', 1, ['u1', 'a1']);
    markSessionClearing('lane-a', 'interrupted', 1);

    const result = await clearLaneSession('lane-a');

    expect(result).toMatchObject({ ok: true, newSessionId: 'lane-a-new' });
    expect(h.stopDriveMock).not.toHaveBeenCalled();
    expect(h.onLaneClearFinishedMock).toHaveBeenCalledTimes(1);
    expect(h.onLaneClearFinishedMock).toHaveBeenCalledWith('lane-a-new');
  });

  it('Clear que FALHA nao dispara a notificacao de sucesso', async () => {
    seedLane('lane-a', 1, ['u1', 'a1']);
    h.runCompactionMock.mockRejectedValueOnce(new Error('COMPACT falhou'));

    const result = await clearLaneSession('lane-a');

    expect(result).toMatchObject({ ok: false, code: 'clear_failed' });
    expect(h.onLaneClearFinishedMock).not.toHaveBeenCalled();
    expect(h.replaceLaneSessionMock).not.toHaveBeenCalled();
  });
});
