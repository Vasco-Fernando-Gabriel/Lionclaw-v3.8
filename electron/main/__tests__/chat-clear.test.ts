import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ChatSession, CompactionActivePayload } from '../../../src/types';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createLaneClearer, buildTranscriptName, readClearForceSettleMs, type ClearLaneDeps } from '../chat-clear-core';
import { clearingSessions, getClearingPhase, isSessionClearing, markSessionClearing } from '../clearing-sessions';
import { acquireDreamingMutex, resetDreamingMutexForTests, tryAcquireDreamingMutex } from '../dreaming-mutex';
import type { RunCompactionResult } from '../memory-pipeline';

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'lane-a',
    title: 'Conversa A',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    status: 'active',
    type: 'chat',
    laneBadge: 1,
    createdAt: '2026-09-08 10:00:00',
    updatedAt: '2026-09-08 10:00:00',
    rollingSummary: 'resumo rolante',
    ...overrides,
  };
}

interface Harness {
  deps: ClearLaneDeps;
  sessions: Map<string, ChatSession>;
  events: CompactionActivePayload[];
  sessionsUpdated: string[][];
  order: string[];
}

function makeHarness(overrides: Partial<ClearLaneDeps> = {}): Harness {
  const sessions = new Map<string, ChatSession>([['lane-a', makeSession()]]);
  const events: CompactionActivePayload[] = [];
  const sessionsUpdated: string[][] = [];
  const order: string[] = [];
  const okResult: RunCompactionResult = { executiveSummary: 'resumo', warnings: [] };
  const deps: ClearLaneDeps = {
    getSession: (id) => sessions.get(id),
    countSessionMessages: () => 4,
    isOpenDesktopConversation: (s) =>
      s.status === 'active' && (s.type === 'chat' || s.type === 'manual') && !s.id.startsWith('dw-drive-'),
    setDreamingStartedAt: vi.fn((id, startedAt) => {
      order.push(`dreaming_started_at:${startedAt ? 'set' : 'null'}`);
      const s = sessions.get(id);
      if (s) sessions.set(id, { ...s, dreamingStartedAt: startedAt ?? undefined });
    }),
    replaceLaneSession: vi.fn((input) => {
      order.push('replaceLaneSession');
      expect(isSessionClearing(input.sessionId)).toBe(true);
      const s = sessions.get(input.sessionId)!;
      const badge = s.laneBadge ?? null;
      sessions.set(input.sessionId, { ...s, status: input.finalStatus, laneBadge: null, dreamingStartedAt: undefined });
      if (badge === null) return { newSessionId: null };
      sessions.set(
        'lane-new',
        makeSession({ id: 'lane-new', title: '', laneBadge: badge, orchestrator: input.orchestrator }),
      );
      return { newSessionId: 'lane-new' };
    }),
    getSessionsWithDreamingStarted: () =>
      [...sessions.values()].filter((s) => s.dreamingStartedAt && s.status === 'active'),
    getExecutionState: vi.fn(() => 'idle' as const),
    isCompacting: vi.fn(() => false),
    listActiveDriveProjectIds: vi.fn(() => [] as string[]),
    stopDrive: vi.fn(),
    onLaneClearFinished: vi.fn(),
    stopSessionQuery: vi.fn(),
    awaitTurnSettled: vi.fn(async () => ({ settled: true as const })),
    readSettleTimeoutMs: () => 30_000,
    acquireDreamingMutex,
    runCompaction: vi.fn(async () => {
      order.push('runCompaction');
      return okResult;
    }),
    resolveModelLabel: async () => 'Claude Sonnet 4.6',
    readDefaultOrchestrator: () => ({ runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-sonnet-4-6' }),
    closeCodexSession: vi.fn((id) => order.push(`closeCodex:${id}`)),
    emitCompactionActive: (payload) => {
      events.push(payload);
    },
    emitSessionsUpdated: (ids) => {
      sessionsUpdated.push(ids);
    },
    now: () => new Date('2026-09-08T15:00:00.000Z'),
    ...overrides,
  };
  return { deps, sessions, events, sessionsUpdated, order };
}

beforeEach(() => {
  clearingSessions.clear();
  resetDreamingMutexForTests();
});

describe('6.1/AC-2: recusas tipadas', () => {
  it('sessionId ausente, inexistente ou nao aberta', async () => {
    const h = makeHarness();
    const { clearLaneSession } = createLaneClearer(h.deps);
    expect(await clearLaneSession('')).toMatchObject({ ok: false, code: 'session_required' });
    expect(await clearLaneSession('nope')).toMatchObject({ ok: false, code: 'session_not_found' });
    h.sessions.set('arch', makeSession({ id: 'arch', status: 'compacted' }));
    expect(await clearLaneSession('arch')).toMatchObject({ ok: false, code: 'session_not_active' });
    expect(h.deps.runCompaction).not.toHaveBeenCalled();
  });

  it('session_busy: turno em voo, item na fila ou Compactacao em andamento', async () => {
    const h = makeHarness();
    const { clearLaneSession } = createLaneClearer(h.deps);
    (h.deps.getExecutionState as ReturnType<typeof vi.fn>).mockReturnValueOnce('streaming');
    expect(await clearLaneSession('lane-a')).toMatchObject({ ok: false, code: 'session_busy' });
    (h.deps.getExecutionState as ReturnType<typeof vi.fn>).mockReturnValueOnce('queued');
    expect(await clearLaneSession('lane-a')).toMatchObject({ ok: false, code: 'session_busy' });
    (h.deps.isCompacting as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    expect(await clearLaneSession('lane-a')).toMatchObject({ ok: false, code: 'session_busy' });
    expect(isSessionClearing('lane-a')).toBe(false);
    expect(h.deps.runCompaction).not.toHaveBeenCalled();
  });

  it('drive_active sem force; empty_session com 0 mensagens', async () => {
    const h = makeHarness();
    const { clearLaneSession } = createLaneClearer(h.deps);
    (h.deps.listActiveDriveProjectIds as ReturnType<typeof vi.fn>).mockReturnValueOnce(['proj-1']);
    expect(await clearLaneSession('lane-a')).toMatchObject({ ok: false, code: 'drive_active' });
    const empty = makeHarness({ countSessionMessages: () => 0 });
    expect(await createLaneClearer(empty.deps).clearLaneSession('lane-a')).toMatchObject({
      ok: false,
      code: 'empty_session',
    });
    expect(empty.events).toEqual([]);
  });

  it('session_clearing quando ja esta em Clear', async () => {
    const h = makeHarness();
    const { clearLaneSession } = createLaneClearer(h.deps);
    markSessionClearing('lane-a', 'running', 1);
    expect(await clearLaneSession('lane-a')).toMatchObject({ ok: false, code: 'session_clearing' });
  });
});

describe('V6/AC-2: force', () => {
  it('bloqueia entradas, pausa o drive, aborta so a sessao, aguarda assentar e so entao roda o dreaming', async () => {
    const h = makeHarness();
    (h.deps.getExecutionState as ReturnType<typeof vi.fn>).mockReturnValue('streaming');
    (h.deps.listActiveDriveProjectIds as ReturnType<typeof vi.fn>).mockReturnValue(['proj-1']);
    let clearingDuringSettle: boolean | null = null;
    (h.deps.awaitTurnSettled as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      clearingDuringSettle = isSessionClearing('lane-a');
      h.order.push('awaitTurnSettled');
      return { settled: true };
    });
    const { clearLaneSession } = createLaneClearer(h.deps);

    const result = await clearLaneSession('lane-a', { force: true });

    expect(result).toMatchObject({ ok: true, newSessionId: 'lane-new', pausedDriveProjectIds: ['proj-1'] });
    expect(clearingDuringSettle).toBe(true);
    expect(h.deps.stopDrive).toHaveBeenCalledWith('proj-1', 'lane-clear-force');
    expect(h.deps.stopSessionQuery).toHaveBeenCalledWith('lane-a');
    expect(h.deps.awaitTurnSettled).toHaveBeenCalledWith('lane-a', 30_000);
    expect(h.order.indexOf('awaitTurnSettled')).toBeLessThan(h.order.indexOf('runCompaction'));
  });

  it('turno que nao assenta = turn_did_not_settle, nada arquivado, sessao sai de clearingSessions', async () => {
    const h = makeHarness();
    (h.deps.getExecutionState as ReturnType<typeof vi.fn>).mockReturnValue('streaming');
    (h.deps.awaitTurnSettled as ReturnType<typeof vi.fn>).mockResolvedValue({ settled: false, reason: 'timeout' });
    const { clearLaneSession } = createLaneClearer(h.deps);

    const result = await clearLaneSession('lane-a', { force: true });

    expect(result).toMatchObject({ ok: false, code: 'turn_did_not_settle' });
    expect(h.deps.runCompaction).not.toHaveBeenCalled();
    expect(h.deps.replaceLaneSession).not.toHaveBeenCalled();
    expect(h.sessions.get('lane-a')?.status).toBe('active');
    expect(isSessionClearing('lane-a')).toBe(false);
  });
});

describe('6.3/6.4/6.6: dreaming sobre a conversa inteira e transicao atomica', () => {
  it('runCompaction com priorSummary, skipDailySummary, transcriptName e mutex held; badge nunca fica livre', async () => {
    const h = makeHarness();
    const { clearLaneSession } = createLaneClearer(h.deps);

    const result = await clearLaneSession('lane-a');

    expect(result).toEqual({
      ok: true,
      sessionId: 'lane-a',
      newSessionId: 'lane-new',
      warnings: [],
      pausedDriveProjectIds: [],
    });
    const [periodStart, , sessionId, opts] = (h.deps.runCompaction as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(periodStart).toEqual(new Date('2026-09-08 10:00:00'));
    expect(sessionId).toBe('lane-a');
    expect(opts).toMatchObject({
      priorSummary: 'resumo rolante',
      skipDailySummary: true,
      transcriptName: '2026-09-08-lane-a',
      dreamingMutex: 'held',
    });
    expect(opts.sinceMessageId).toBeUndefined();
    expect(h.deps.replaceLaneSession).toHaveBeenCalledTimes(1);
    expect(h.deps.replaceLaneSession).toHaveBeenCalledWith({
      sessionId: 'lane-a',
      finalStatus: 'compacted',
      orchestrator: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-sonnet-4-6' },
      purgeActivityLog: true,
    });
    expect(h.sessions.get('lane-a')).toMatchObject({ status: 'compacted', laneBadge: null });
    expect(h.sessions.get('lane-new')).toMatchObject({ laneBadge: 1, status: 'active' });
    expect(h.order).toEqual(['dreaming_started_at:set', 'runCompaction', 'replaceLaneSession', 'closeCodex:lane-a']);
    expect(h.sessionsUpdated).toEqual([['lane-a', 'lane-new']]);
    expect(isSessionClearing('lane-a')).toBe(false);
  });

  it('conversa aberta sem lane arquiva sem criar conversa nova', async () => {
    const h = makeHarness();
    h.sessions.set('lane-a', makeSession({ laneBadge: null }));
    const { clearLaneSession } = createLaneClearer(h.deps);
    const result = await clearLaneSession('lane-a');
    expect(result).toMatchObject({ ok: true, newSessionId: null });
    expect(h.sessions.has('lane-new')).toBe(false);
  });

  it('warnings do dreaming chegam no resultado', async () => {
    const h = makeHarness({
      runCompaction: vi.fn(async () => ({
        executiveSummary: 'r',
        warnings: [{ step: 'embeddings' as const, detail: '2 de 3 chunks nao gravados' }],
      })),
    });
    const result = await createLaneClearer(h.deps).clearLaneSession('lane-a');
    expect(result).toMatchObject({ ok: true, warnings: [{ step: 'embeddings' }] });
  });
});

describe('6.7/D3: falhas dos passos 1 e 2 deixam a conversa intacta', () => {
  it.each(['COMPACT-SUMMARY-FAILED', 'COMPACT-MEMORY-FAILED'] as const)('%s', async (code) => {
    const err = Object.assign(new Error(`falha ${code}`), { name: 'CompactionStepError', code, cause: new Error('x') });
    const h = makeHarness({
      runCompaction: vi.fn(async () => {
        throw err;
      }),
    });
    const { clearLaneSession } = createLaneClearer(h.deps);

    const result = await clearLaneSession('lane-a');

    expect(result).toMatchObject({ ok: false, code, error: expect.stringContaining(code) });
    expect(h.deps.replaceLaneSession).not.toHaveBeenCalled();
    expect(h.sessions.get('lane-a')).toMatchObject({ status: 'active', laneBadge: 1 });
    expect(h.sessions.get('lane-a')?.dreamingStartedAt).toBeUndefined();
    expect(isSessionClearing('lane-a')).toBe(false);
    expect(h.events.at(-1)).toEqual({ isActive: false, sessionId: 'lane-a', source: 'lionclaw' });
  });
});

describe('6.9/AC-9: compaction:active por lane com phase e cancelamento do queued', () => {
  it('emite queued -> running -> inativo com sessionId, modelLabel e title', async () => {
    const h = makeHarness();
    await createLaneClearer(h.deps).clearLaneSession('lane-a');
    expect(h.events).toEqual([
      {
        isActive: true,
        sessionId: 'lane-a',
        phase: 'queued',
        modelLabel: 'Claude Sonnet 4.6',
        title: 'Conversa A',
        source: 'lionclaw',
      },
      {
        isActive: true,
        sessionId: 'lane-a',
        phase: 'running',
        modelLabel: 'Claude Sonnet 4.6',
        title: 'Conversa A',
        source: 'lionclaw',
      },
      { isActive: false, sessionId: 'lane-a', source: 'lionclaw' },
    ]);
  });

  it('AC-6 FIFO: o segundo Clear fica queued ate o primeiro terminar; cancelar o queued limpa clearingSessions', async () => {
    const h = makeHarness();
    h.sessions.set('lane-b', makeSession({ id: 'lane-b', title: 'Conversa B', laneBadge: 2 }));
    let finishFirst: () => void = () => {};
    (h.deps.runCompaction as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise<RunCompactionResult>((resolve) => {
          finishFirst = () => resolve({ executiveSummary: 'r', warnings: [] });
        }),
    );
    const clearer = createLaneClearer(h.deps);

    const first = clearer.clearLaneSession('lane-a');
    await vi.waitFor(() => expect(getClearingPhase('lane-a')).toBe('running'));
    const second = clearer.clearLaneSession('lane-b');
    await vi.waitFor(() => expect(getClearingPhase('lane-b')).toBe('queued'));
    expect(h.deps.runCompaction).toHaveBeenCalledTimes(1);
    expect(tryAcquireDreamingMutex()).toBeNull();

    expect(clearer.cancelQueuedClear('lane-b')).toEqual({ ok: true, sessionId: 'lane-b' });
    await expect(second).resolves.toMatchObject({ ok: false, code: 'clear_cancelled' });
    expect(isSessionClearing('lane-b')).toBe(false);
    expect(h.events.filter((e) => e.sessionId === 'lane-b')).toEqual([
      {
        isActive: true,
        sessionId: 'lane-b',
        phase: 'queued',
        modelLabel: 'Claude Sonnet 4.6',
        title: 'Conversa B',
        source: 'lionclaw',
      },
      { isActive: false, sessionId: 'lane-b', source: 'lionclaw' },
    ]);

    finishFirst();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(h.deps.runCompaction).toHaveBeenCalledTimes(1);
    expect(clearer.cancelQueuedClear('lane-a')).toMatchObject({ ok: false, code: 'clear_not_queued' });
  });

  it('AC-6 FIFO: sem cancelamento, o segundo dreaming so comeca depois do primeiro', async () => {
    const h = makeHarness();
    h.sessions.set('lane-b', makeSession({ id: 'lane-b', laneBadge: 2 }));
    let finishFirst: () => void = () => {};
    (h.deps.runCompaction as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise<RunCompactionResult>((resolve) => {
          finishFirst = () => resolve({ executiveSummary: 'r', warnings: [] });
        }),
    );
    const clearer = createLaneClearer(h.deps);
    const first = clearer.clearLaneSession('lane-a');
    await vi.waitFor(() => expect(getClearingPhase('lane-a')).toBe('running'));
    const second = clearer.clearLaneSession('lane-b');
    await vi.waitFor(() => expect(getClearingPhase('lane-b')).toBe('queued'));
    expect(h.deps.runCompaction).toHaveBeenCalledTimes(1);
    finishFirst();
    await first;
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(h.deps.runCompaction).toHaveBeenCalledTimes(2);
    const names = (h.deps.runCompaction as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[3].transcriptName);
    expect(names).toEqual(['2026-09-08-lane-a', '2026-09-08-lane-b']);
  });
});

describe('6.10/AC-12/V13: Clear interrompido reconstruido no boot', () => {
  it('sessao active com dreaming_started_at entra como interrupted; chat:clear e a unica transicao', async () => {
    const h = makeHarness();
    h.sessions.set('lane-a', makeSession({ dreamingStartedAt: '2026-09-08T14:00:00.000Z' }));
    h.sessions.set('lane-b', makeSession({ id: 'lane-b', laneBadge: 2 }));
    const clearer = createLaneClearer(h.deps);

    expect(clearer.rebuildClearingSessionsOnBoot()).toEqual(['lane-a']);
    expect(getClearingPhase('lane-a')).toBe('interrupted');
    expect(isSessionClearing('lane-b')).toBe(false);

    (h.deps.getExecutionState as ReturnType<typeof vi.fn>).mockReturnValue('streaming');
    const result = await clearer.clearLaneSession('lane-a');

    expect(result).toMatchObject({ ok: true, newSessionId: 'lane-new' });
    expect(h.deps.runCompaction).toHaveBeenCalledTimes(1);
    expect(h.events[0]).toMatchObject({ sessionId: 'lane-a', phase: 'queued' });
    expect(h.sessions.get('lane-a')).toMatchObject({ status: 'compacted' });
    expect(isSessionClearing('lane-a')).toBe(false);
  });

  it('boot ignora sessoes que nao sao conversa desktop aberta', () => {
    const h = makeHarness();
    h.sessions.set('lane-a', makeSession({ dreamingStartedAt: '2026-09-08T14:00:00.000Z', status: 'compacted' }));
    h.sessions.set(
      'dw-drive-1',
      makeSession({ id: 'dw-drive-1', laneBadge: null, dreamingStartedAt: '2026-09-08T14:00:00.000Z' }),
    );
    expect(createLaneClearer(h.deps).rebuildClearingSessionsOnBoot()).toEqual([]);
  });
});

describe('helpers puros', () => {
  it('buildTranscriptName = <date>-<sessionId> no fuso local', () => {
    expect(buildTranscriptName('abc', new Date(2026, 8, 8, 15, 0, 0))).toBe('2026-09-08-abc');
  });

  it('readClearForceSettleMs: default 30 s; setting positivo vence; invalido cai no default', () => {
    expect(readClearForceSettleMs(() => undefined)).toBe(30_000);
    expect(readClearForceSettleMs(() => '5000')).toBe(5_000);
    expect(readClearForceSettleMs(() => 'abc')).toBe(30_000);
    expect(readClearForceSettleMs(() => '-1')).toBe(30_000);
  });
});
