import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';


let streamCb: ((chunk: unknown) => void) | null = null;
let onEventCleanup: ReturnType<typeof vi.fn>;
let listRunsResult: unknown[] = [];
let nextStartResult: unknown = { ok: true };
let nextCloserResult: unknown = { ok: true };

beforeAll(() => {
  onEventCleanup = vi.fn();
  (global as unknown as Record<string, unknown>).window = {
    lionclaw: {
      dynamicWorkflow: {
        listRuns: vi.fn(async () => listRunsResult),
        getRun: vi.fn(async () => null),
        getNodes: vi.fn(async () => []),
        getEvents: vi.fn(async () => []),
        start: vi.fn(async () => nextStartResult),
        pause: vi.fn(async () => ({ ok: true })),
        resume: vi.fn(async () => ({ ok: true })),
        abort: vi.fn(async () => ({ ok: true })),
        intervene: vi.fn(async () => ({ ok: true })),
        sendCloserMessage: vi.fn(async () => nextCloserResult),
        resolveWithCloser: vi.fn(async () => nextCloserResult),
        getArtifacts: vi.fn(async () => []),
        getMessages: vi.fn(async () => []),
        deleteRun: vi.fn(async () => ({ ok: true })),
        approveGate: vi.fn(async () => ({ ok: true })),
        getSnapshot: vi.fn(async () => ({ error: 'no-snapshot' })),
        onEvent: vi.fn((cb: (chunk: unknown) => void) => {
          streamCb = cb;
          return onEventCleanup;
        }),
      },
    },
  };
});

import {
  useDynamicWorkflowStore,
  deriveWorkflowUIStatus,
  deriveNodeRunsFromEvents,
  appendNarrationLine,
  extractStallMessage,
  _cancelRunnerReloadTimers,
  NARRATION_FEED_LIMIT,
  fetchAllStructuralEvents,
  deriveTouchedFilesFromEvents,
  STRUCTURAL_EVENTS_PAGE_SIZE,
} from '@/stores/dynamic-workflow-store';
import { COCKPIT_STRUCTURAL_EVENT_TYPES } from '@/types/dynamic-workflow';
import type { DynamicWorkflowEventsQuery } from '@/types';
import type {
  DynamicWorkflowRun,
  DynamicWorkflowRunStatus,
  DynamicWorkflowEvent,
} from '@/types';

function makeRun(
  id: string,
  status: DynamicWorkflowRunStatus,
  overrides: Partial<DynamicWorkflowRun> = {},
): DynamicWorkflowRun {
  return {
    id,
    status,
    definitionId: `def-${id}`,
    chatSessionId: null,
    totalCostUsd: 0,
    ...overrides,
  } as unknown as DynamicWorkflowRun;
}

beforeEach(() => {
  streamCb = null;
  listRunsResult = [];
  nextStartResult = { ok: true };
  nextCloserResult = { ok: true };
  onEventCleanup.mockClear();
  _cancelRunnerReloadTimers();
  useDynamicWorkflowStore.setState({
    runs: [],
    isLoading: false,
    error: null,
    selectedRunId: null,
    selectedRun: null,
    nodes: [],
    events: [],
    closerThread: [],
    maestroThread: [],
    pendingQuestion: null,
    scheduledResumeAt: {},
    stalledByRun: {},
    narrationByRun: {},
    closerBusyRunIds: new Set<string>(),
    streamingRunIds: new Set<string>(),
    awaitingUserRunIds: new Set<string>(),
  });
});

describe('deriveWorkflowUIStatus (funcao pura, 10.2/13.3.4)', () => {
  it('sem flags, retorna o status do DB', () => {
    expect(deriveWorkflowUIStatus('created')).toBe('created');
    expect(deriveWorkflowUIStatus('running')).toBe('running');
    expect(deriveWorkflowUIStatus('paused')).toBe('paused');
  });

  it('awaiting-user vence streaming e status', () => {
    expect(
      deriveWorkflowUIStatus('running', { isStreaming: true, awaitingUser: true }),
    ).toBe('awaiting-user');
    expect(deriveWorkflowUIStatus('blocked', { awaitingUser: true })).toBe('awaiting-user');
  });

  it('streaming vence o status quando nao ha awaiting', () => {
    expect(deriveWorkflowUIStatus('running', { isStreaming: true })).toBe('streaming');
    expect(deriveWorkflowUIStatus('created', { isStreaming: true })).toBe('streaming');
  });

  it('estado terminal ignora flags transientes (nao streama nem espera)', () => {
    expect(
      deriveWorkflowUIStatus('completed', { isStreaming: true, awaitingUser: true }),
    ).toBe('completed');
    expect(deriveWorkflowUIStatus('aborted', { isStreaming: true })).toBe('aborted');
    expect(deriveWorkflowUIStatus('failed', { awaitingUser: true })).toBe('failed');
  });
});

describe('loadRuns', () => {
  it('popula a lista a partir do IPC', async () => {
    listRunsResult = [makeRun('run-a', 'running'), makeRun('run-b', 'paused')];
    await useDynamicWorkflowStore.getState().loadRuns();
    const { runs, isLoading } = useDynamicWorkflowStore.getState();
    expect(runs).toHaveLength(2);
    expect(runs[0]?.id).toBe('run-a');
    expect(isLoading).toBe(false);
  });
});

describe('getUIStatus (seletor com Sets transientes)', () => {
  it('reflete streaming e awaiting do run sem mutar o status persistido', () => {
    useDynamicWorkflowStore.setState({
      runs: [makeRun('run-a', 'running'), makeRun('run-b', 'running')],
      streamingRunIds: new Set(['run-a']),
      awaitingUserRunIds: new Set(['run-b']),
    });
    const store = useDynamicWorkflowStore.getState();
    expect(store.getUIStatus('run-a')).toBe('streaming');
    expect(store.getUIStatus('run-b')).toBe('awaiting-user');
    expect(useDynamicWorkflowStore.getState().runs.every((r) => r.status === 'running')).toBe(true);
  });

  it('run desconhecido cai no default created', () => {
    expect(useDynamicWorkflowStore.getState().getUIStatus('nope')).toBe('created');
  });
});

describe('_handleStreamChunk', () => {
  it('chunk de node text marca streaming; done limpa', () => {
    const store = useDynamicWorkflowStore.getState();
    store._handleStreamChunk({ kind: 'node', runId: 'run-a', type: 'text', content: 'oi' });
    expect(useDynamicWorkflowStore.getState().streamingRunIds.has('run-a')).toBe(true);
    store._handleStreamChunk({ kind: 'node', runId: 'run-a', type: 'done' });
    expect(useDynamicWorkflowStore.getState().streamingRunIds.has('run-a')).toBe(false);
  });

  it('evento do runner com sufixo pending marca awaiting-user; resolved limpa', () => {
    const store = useDynamicWorkflowStore.getState();
    store._handleStreamChunk({
      kind: 'runner',
      runId: 'run-a',
      type: 'event',
      eventType: 'gate-pending',
    });
    expect(useDynamicWorkflowStore.getState().awaitingUserRunIds.has('run-a')).toBe(true);
    store._handleStreamChunk({
      kind: 'runner',
      runId: 'run-a',
      type: 'event',
      eventType: 'gate-resolved',
    });
    expect(useDynamicWorkflowStore.getState().awaitingUserRunIds.has('run-a')).toBe(false);
  });

  it('chunk sem runId e ignorado', () => {
    const store = useDynamicWorkflowStore.getState();
    store._handleStreamChunk({ kind: 'node', runId: '', type: 'text' });
    expect(useDynamicWorkflowStore.getState().streamingRunIds.size).toBe(0);
  });
});

describe('init (listener + cleanup)', () => {
  it('registra onEvent e devolve a cleanup que remove o listener', () => {
    const cleanup = useDynamicWorkflowStore.getState().init();
    expect(typeof cleanup).toBe('function');
    expect(streamCb).toBeTypeOf('function');
    streamCb?.({ kind: 'node', runId: 'run-z', type: 'tool_call', toolName: 'Read' });
    expect(useDynamicWorkflowStore.getState().streamingRunIds.has('run-z')).toBe(true);
    cleanup();
    expect(onEventCleanup).toHaveBeenCalledTimes(1);
  });

  it('idempotente: 2 callers (App + ChatPage) = 1 listener; so o ultimo cleanup remove', () => {
    onEventCleanup.mockClear();
    const cApp = useDynamicWorkflowStore.getState().init();
    const cChat = useDynamicWorkflowStore.getState().init();
    cChat();
    expect(onEventCleanup).not.toHaveBeenCalled();
    cApp();
    expect(onEventCleanup).toHaveBeenCalledTimes(1);
  });
});

describe('deriveNodeRunsFromEvents (status do tipo do evento)', () => {
  function ev(
    seq: number,
    type: string,
    nodeId: string | null,
    payload: object,
  ): DynamicWorkflowEvent {
    return {
      id: seq,
      runId: 'r',
      nodeId,
      phaseId: null,
      seq,
      type,
      payloadJson: JSON.stringify(payload),
      createdAt: 'now',
    } as DynamicWorkflowEvent;
  }

  it('deriva running/completed do TIPO do evento mesmo sem status no payload', () => {
    const runs = deriveNodeRunsFromEvents('r', [
      ev(1, 'run-started', null, {}), // sem node -> ignorado
      ev(2, 'phase-changed', null, { phase: 'Implementar' }), // ignorado
      ev(3, 'node-started', 'scout', { attempt: 1 }), // running
      ev(4, 'node-completed', 'scout', { attempt: 1 }), // -> completed (sobrescreve)
      ev(5, 'node-started', 'coder', { attempt: 1 }), // running
      ev(6, 'checkpoint-saved', 'checkpoint-scout', {}), // completed
    ]);
    const byId = Object.fromEntries(runs.map((r) => [r.nodeId, r.status]));
    expect(byId['scout']).toBe('completed');
    expect(byId['coder']).toBe('running');
    expect(byId['checkpoint-scout']).toBe('completed');
    expect(runs.length).toBe(3);
  });

  it('node-failed vira failed', () => {
    const runs = deriveNodeRunsFromEvents('r', [
      ev(1, 'node-started', 'coder', { attempt: 1 }),
      ev(2, 'node-failed', 'coder', { attempt: 1, error: 'x' }),
    ]);
    expect(runs.find((r) => r.nodeId === 'coder')?.status).toBe('failed');
  });

  it('D20: node-completed preserva agentId/startedAt/label do node-started (merge), ultimo vence nos definidos', () => {
    const runs = deriveNodeRunsFromEvents('r', [
      ev(1, 'node-started', 'cc:S1:u-s1-ac1:0', {
        attempt: 0,
        agentId: 'dynamic-workflow-coder',
        label: 'u-s1-ac1',
        startedAt: '2026-09-02T04:40:00.000Z',
        access: 'workspace-write',
      }),
      ev(2, 'node-completed', 'cc:S1:u-s1-ac1:0', {
        attempt: 0,
        costUsd: 0.5,
        durationMs: 120000,
        inputTokens: 100,
        outputTokens: 10,
        runtime: 'cloud',
        worktreeCommitSha: 'abc123',
      }),
    ]);
    expect(runs).toHaveLength(1);
    const nr = runs[0];
    expect(nr.status).toBe('completed');
    expect(nr.agentId).toBe('dynamic-workflow-coder');
    expect(nr.label).toBe('u-s1-ac1');
    expect(nr.startedAt).toBe('2026-09-02T04:40:00.000Z');
    expect(nr.costUsd).toBeCloseTo(0.5, 5);
    expect(nr.durationMs).toBe(120000);
    expect(nr.runtime).toBe('cloud');
    expect(nr.worktreeCommitSha).toBe('abc123');
  });

  it('D20: campos definidos no evento posterior sobrescrevem (agentId trocado por switch-agent)', () => {
    const runs = deriveNodeRunsFromEvents('r', [
      ev(1, 'node-started', 'coder', { attempt: 0, agentId: 'a1', label: 'x' }),
      ev(2, 'node-completed', 'coder', { attempt: 0, agentId: 'a2' }),
    ]);
    expect(runs[0].agentId).toBe('a2');
    expect(runs[0].label).toBe('x');
  });

  it('node-cache-hit conta como concluido (D1: mesma regra do node-completed)', () => {
    const runs = deriveNodeRunsFromEvents('r', [
      ev(1, 'node-cache-hit', 'scout', { attempt: 0, agentId: 'dynamic-workflow-scout' }),
    ]);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].agentId).toBe('dynamic-workflow-scout');
    expect(runs[0].costStatus).toBe('unknown');
  });

  const REAL_CACHE_HIT_PAYLOAD = {
    inputHash: 'h1',
    callIndex: 3,
    replay: 'journal',
    agentId: 'dynamic-workflow-coder',
    access: 'workspace-write',
    label: 'u-s1-ac1',
    outputDigest: 'ok',
  };

  it('P1: node-cache-hit sobre node ja concluido PRESERVA metricas (custo/duracao/tokens/runtime/attempt)', () => {
    const runs = deriveNodeRunsFromEvents('r', [
      ev(1, 'node-started', 'cc:S1:u-s1-ac1:0', {
        attempt: 1,
        agentId: 'dynamic-workflow-coder',
        label: 'u-s1-ac1',
        startedAt: '2026-09-02T04:40:00.000Z',
      }),
      ev(2, 'node-completed', 'cc:S1:u-s1-ac1:0', {
        attempt: 1,
        costUsd: 0.5,
        durationMs: 120000,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 30,
        cacheCreationTokens: 40,
        toolUses: 7,
        apiRequests: 3,
        costStatus: 'known',
        tokenStatus: 'known',
        runtime: 'cloud',
        model: 'claude-sonnet',
        completedAt: '2026-09-02T04:42:00.000Z',
      }),
      ev(3, 'node-cache-hit', 'cc:S1:u-s1-ac1:0', REAL_CACHE_HIT_PAYLOAD),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'completed',
      attempt: 1,
      costUsd: 0.5,
      durationMs: 120000,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      toolUses: 7,
      apiRequests: 3,
      costStatus: 'known',
      tokenStatus: 'known',
      runtime: 'cloud',
      model: 'claude-sonnet',
      completedAt: '2026-09-02T04:42:00.000Z',
      startedAt: '2026-09-02T04:40:00.000Z',
      agentId: 'dynamic-workflow-coder',
      label: 'u-s1-ac1',
    });
    expect(runs[0].inputHash).toBeNull();
  });

  it('P1: cache-hit sem historico do node vira entrada com custo desconhecido e attempt 1', () => {
    const runs = deriveNodeRunsFromEvents('r', [
      ev(1, 'node-cache-hit', 'cc:S1:u-s1-ac1:0', REAL_CACHE_HIT_PAYLOAD),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ attempt: 1, status: 'completed', costStatus: 'unknown', costUsd: 0, label: 'u-s1-ac1' });
  });

  it('P3: attempt ausente no payload usa o ultimo attempt conhecido do node (nao cria #1 fantasma)', () => {
    const runs = deriveNodeRunsFromEvents('r', [
      ev(1, 'node-started', 'coder', { attempt: 2, startedAt: '2026-09-02T04:40:00.000Z' }),
      ev(2, 'node-completed', 'coder', { attempt: 2, costUsd: 0.3 }),
      ev(3, 'node-cache-hit', 'coder', { replay: 'journal' }),
      ev(4, 'checkpoint-saved', 'coder', {}),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].attempt).toBe(2);
    expect(runs[0].costUsd).toBeCloseTo(0.3, 5);
  });

  it('D20: campo com valor 0 DEFINIDO no evento posterior sobrescreve; ausente preserva', () => {
    const runs = deriveNodeRunsFromEvents('r', [
      ev(1, 'node-started', 'coder', { attempt: 0, toolUses: 5, costUsd: 0.2 }),
      ev(2, 'node-completed', 'coder', { attempt: 0, toolUses: 0 }),
    ]);
    expect(runs[0].toolUses).toBe(0);
    expect(runs[0].costUsd).toBeCloseTo(0.2, 5);
  });
});


describe('fetchAllStructuralEvents (D23, paginacao por beforeSeq)', () => {
  function mkEvents(from: number, to: number): DynamicWorkflowEvent[] {
    const out: DynamicWorkflowEvent[] = [];
    for (let seq = from; seq <= to; seq += 1) {
      out.push({ id: seq, runId: 'r', nodeId: null, phaseId: null, seq, type: 'node-started', payloadJson: '{}', createdAt: 'now' });
    }
    return out;
  }

  function backend(total: number) {
    const calls: Array<DynamicWorkflowEventsQuery | undefined> = [];
    const getEvents = vi.fn(async (_runId: string, opts?: DynamicWorkflowEventsQuery) => {
      calls.push(opts);
      if (!opts) return mkEvents(Math.max(1, total - 999), total);
      const limit = opts.limit ?? 1000;
      const before = opts.beforeSeq ?? total + 1;
      const hi = Math.min(total, before - 1);
      const lo = Math.max(1, hi - limit + 1);
      if (hi < 1) return [];
      return mkEvents(lo, hi);
    });
    return { getEvents, calls };
  }

  it('pagina enquanto vier cheio e devolve TODOS em ordem ASC', async () => {
    const { getEvents, calls } = backend(2500);
    const all = await fetchAllStructuralEvents(getEvents, 'r', 2500);
    expect(all).toHaveLength(2500);
    expect(all[0].seq).toBe(1);
    expect(all[2499].seq).toBe(2500);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ beforeSeq: 2501, limit: STRUCTURAL_EVENTS_PAGE_SIZE });
    expect(calls[1]).toMatchObject({ beforeSeq: 1501 });
    expect(calls[2]).toMatchObject({ beforeSeq: 501 });
    for (const c of calls) expect(c?.types).toEqual([...COCKPIT_STRUCTURAL_EVENT_TYPES]);
  });

  it('pagina exatamente cheia no fim: uma chamada extra vazia encerra', async () => {
    const { getEvents, calls } = backend(1000);
    const all = await fetchAllStructuralEvents(getEvents, 'r', 1000);
    expect(all).toHaveLength(1000);
    expect(calls).toHaveLength(2);
  });

  it('backend que ignora beforeSeq (mock legado) nao entra em loop', async () => {
    const same = mkEvents(1, 1000);
    const getEvents = vi.fn(async () => same);
    const all = await fetchAllStructuralEvents(getEvents, 'r', 1000);
    expect(all).toHaveLength(1000);
    expect(getEvents).toHaveBeenCalledTimes(2);
  });

  it('openRun: fio sem opts (ultimos 1000) + estruturais por types/beforeSeq -> events e structuralEvents', async () => {
    const { getEvents, calls } = backend(1200);
    const w = (global as unknown as { window: { lionclaw: { dynamicWorkflow: Record<string, unknown> } } }).window;
    const prev = w.lionclaw.dynamicWorkflow.getEvents;
    w.lionclaw.dynamicWorkflow.getEvents = getEvents;
    try {
      await useDynamicWorkflowStore.getState().openRun('run-x');
      const st = useDynamicWorkflowStore.getState();
      expect(calls[0]).toBeUndefined();
      expect(st.events).toHaveLength(1000);
      expect(st.events[0].seq).toBe(201);
      expect(st.structuralEvents).toHaveLength(1200);
      expect(st.structuralEvents[0].seq).toBe(1);
      expect(st.nodeRuns).toEqual([]);
    } finally {
      w.lionclaw.dynamicWorkflow.getEvents = prev;
      useDynamicWorkflowStore.getState().closeRun();
    }
  });
});

describe('deriveTouchedFilesFromEvents (D25a/b)', () => {
  function ev(seq: number, type: string, nodeId: string | null, phaseId: string | null, payload: unknown): DynamicWorkflowEvent {
    return { id: seq, runId: 'r', nodeId, phaseId, seq, type, payloadJson: JSON.stringify(payload), createdAt: 'now' };
  }

  it('agrega arquivos unicos/ordenados, total, truncado e commits por writer', () => {
    const out = deriveTouchedFilesFromEvents([
      ev(1, 'node-completed', 'scout', 'Docs', { attempt: 0, agentId: 'scout' }), // read-only: sem bloco
      ev(2, 'node-completed', 'cc:S1:u1:0', 'S1', {
        attempt: 0,
        label: 'u1',
        touchedFiles: ['src/b.ts', 'src/a.ts'],
        touchedFilesTotal: 2,
        touchedFilesTruncated: false,
        worktreeCommitSha: 'sha-1',
      }),
      ev(3, 'node-completed', 'cc:S1:u2:0', 'S1', {
        attempt: 1,
        touchedFiles: ['src/a.ts', 'src/c.ts'],
        touchedFilesTotal: 60,
        touchedFilesTruncated: true,
        worktreeCommitSha: null,
      }),
      ev(4, 'node-failed', 'cc:S1:u3:0', 'S1', { touchedFiles: ['ignorado.ts'] }),
    ]);
    expect(out.files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(out.hidden).toBe(58);
    expect(out.truncated).toBe(true);
    expect(out.writers).toHaveLength(2);
    expect(out.writers[0]).toMatchObject({ nodeId: 'cc:S1:u1:0', label: 'u1', worktreeCommitSha: 'sha-1', attempt: 0 });
    expect(out.writers[1]).toMatchObject({ nodeId: 'cc:S1:u2:0', worktreeCommitSha: null, attempt: 1 });
  });

  it('sem writers => vazio', () => {
    expect(deriveTouchedFilesFromEvents([])).toEqual({ files: [], hidden: 0, truncated: false, writers: [] });
  });

  it('P2: o mesmo arquivo tocado por 3 writers NAO conta como "nao listado"', () => {
    const writer = (seq: number, id: string) =>
      ev(seq, 'node-completed', id, 'S1', {
        attempt: 0,
        touchedFiles: ['src/a.ts', 'src/b.ts'],
        touchedFilesTotal: 2,
        touchedFilesTruncated: false,
        worktreeCommitSha: `sha-${seq}`,
      });
    const out = deriveTouchedFilesFromEvents([writer(1, 'w1'), writer(2, 'w2'), writer(3, 'w3')]);
    expect(out.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(out.hidden).toBe(0);
    expect(out.truncated).toBe(false);
    expect(out.writers).toHaveLength(3);
  });

  it('P2: writer com total 60 e 50 listados => hidden 10', () => {
    const listed = Array.from({ length: 50 }, (_, i) => `src/f${i.toString().padStart(2, '0')}.ts`);
    const out = deriveTouchedFilesFromEvents([
      ev(1, 'node-completed', 'w1', 'S1', {
        attempt: 0,
        touchedFiles: listed,
        touchedFilesTotal: 60,
        touchedFilesTruncated: true,
        worktreeCommitSha: 'sha',
      }),
    ]);
    expect(out.files).toHaveLength(50);
    expect(out.hidden).toBe(10);
    expect(out.truncated).toBe(true);
  });
});

describe('start (acao de lifecycle)', () => {
  it('propaga erro do IPC para o store', async () => {
    nextStartResult = { error: 'not-implemented' };
    await useDynamicWorkflowStore.getState().start('run-a');
    expect(useDynamicWorkflowStore.getState().error).toBe('not-implemented');
  });
});


describe('appendNarrationLine (Inc7, funcao pura)', () => {
  it('acumula linhas, ignora vazias e respeita o limite (cauda = mais recente)', () => {
    let feed: string[] = [];
    feed = appendNarrationLine(feed, 'primeira');
    feed = appendNarrationLine(feed, '   '); // whitespace -> ignorada
    feed = appendNarrationLine(feed, 'segunda');
    expect(feed).toEqual(['primeira', 'segunda']);
    for (let i = 0; i < NARRATION_FEED_LIMIT + 3; i += 1) {
      feed = appendNarrationLine(feed, `linha ${i}`);
    }
    expect(feed).toHaveLength(NARRATION_FEED_LIMIT);
    expect(feed[feed.length - 1]).toBe(`linha ${NARRATION_FEED_LIMIT + 2}`);
  });

  it('feed undefined inicia vazio', () => {
    expect(appendNarrationLine(undefined, 'x')).toEqual(['x']);
  });
});

describe('_handleStreamChunk: narrador (kind narrator)', () => {
  it('acumula narracao SO para o run aberto', () => {
    useDynamicWorkflowStore.setState({ selectedRunId: 'run-a' });
    const store = useDynamicWorkflowStore.getState();
    store._handleStreamChunk({ kind: 'narrator', runId: 'run-a', type: 'text', content: 'planejando o scout' });
    store._handleStreamChunk({ kind: 'narrator', runId: 'run-a', type: 'text', content: 'rodando o coder' });
    store._handleStreamChunk({ kind: 'narrator', runId: 'run-b', type: 'text', content: 'invisivel' });
    const { narrationByRun } = useDynamicWorkflowStore.getState();
    expect(narrationByRun['run-a']).toEqual(['planejando o scout', 'rodando o coder']);
    expect(narrationByRun['run-b']).toBeUndefined();
  });
});


describe('extractStallMessage (Inc5, funcao pura)', () => {
  it('le message/reason do payload, ou cai no texto neutro', () => {
    expect(extractStallMessage({ message: 'sem progresso ha 3min' })).toBe('sem progresso ha 3min');
    expect(extractStallMessage({ reason: 'travou' })).toBe('travou');
    expect(extractStallMessage(null)).toContain('watchdog');
    expect(extractStallMessage({})).toContain('watchdog');
  });
});


describe('SM-18: _handleStreamChunk narrator acumula numa UNICA bolha', () => {
  it('deltas do mesmo turno crescem a mesma bolha do maestroThread', () => {
    useDynamicWorkflowStore.setState({ selectedRunId: 'run-a', maestroThread: [] });
    const store = useDynamicWorkflowStore.getState();
    store._handleStreamChunk({ kind: 'narrator', runId: 'run-a', type: 'text', content: 'O cod' });
    store._handleStreamChunk({ kind: 'narrator', runId: 'run-a', type: 'text', content: 'er ter' });
    store._handleStreamChunk({ kind: 'narrator', runId: 'run-a', type: 'text', content: 'minou.' });
    const { maestroThread } = useDynamicWorkflowStore.getState();
    expect(maestroThread).toHaveLength(1);
    expect(maestroThread[0].role).toBe('maestro');
    expect(maestroThread[0].content).toBe('O coder terminou.');
    expect(maestroThread[0].streaming).toBe(true);
  });
});


describe('SM-23: narracao de marco (final: true) vira UMA entrada por marco', () => {
  it('marcos consecutivos NAO concatenam: cada um vira bolha sealed propria', () => {
    useDynamicWorkflowStore.setState({ selectedRunId: 'run-a', maestroThread: [] });
    const store = useDynamicWorkflowStore.getState();
    store._handleStreamChunk({
      kind: 'narrator',
      runId: 'run-a',
      type: 'text',
      content: 'O scout mapeou o repositorio.',
      final: true,
    });
    store._handleStreamChunk({
      kind: 'narrator',
      runId: 'run-a',
      type: 'text',
      content: 'O coder comecou a implementar a sprint.',
      final: true,
    });
    const { maestroThread } = useDynamicWorkflowStore.getState();
    expect(maestroThread).toHaveLength(2);
    expect(maestroThread[0].content).toBe('O scout mapeou o repositorio.');
    expect(maestroThread[1].content).toBe('O coder comecou a implementar a sprint.');
    expect(maestroThread[0].streaming).toBe(false);
    expect(maestroThread[1].streaming).toBe(false);
  });

  it('marco (final) apos delta de streaming SELA a bolha viva e abre a sua propria', () => {
    useDynamicWorkflowStore.setState({ selectedRunId: 'run-a', maestroThread: [] });
    const store = useDynamicWorkflowStore.getState();
    store._handleStreamChunk({ kind: 'narrator', runId: 'run-a', type: 'text', content: 'Respon' });
    store._handleStreamChunk({ kind: 'narrator', runId: 'run-a', type: 'text', content: 'dendo...' });
    store._handleStreamChunk({
      kind: 'narrator',
      runId: 'run-a',
      type: 'text',
      content: 'A fase de implementacao terminou.',
      final: true,
    });
    const { maestroThread } = useDynamicWorkflowStore.getState();
    expect(maestroThread).toHaveLength(2);
    expect(maestroThread[0].content).toBe('Respondendo...');
    expect(maestroThread[0].streaming).toBe(false); // selada pelo marco
    expect(maestroThread[1].content).toBe('A fase de implementacao terminou.');
    expect(maestroThread[1].streaming).toBe(false);
  });

  it('delta de streaming apos um marco abre bolha NOVA (nao cresce a do marco)', () => {
    useDynamicWorkflowStore.setState({ selectedRunId: 'run-a', maestroThread: [] });
    const store = useDynamicWorkflowStore.getState();
    store._handleStreamChunk({
      kind: 'narrator',
      runId: 'run-a',
      type: 'text',
      content: 'Gate de plano aberto.',
      final: true,
    });
    store._handleStreamChunk({ kind: 'narrator', runId: 'run-a', type: 'text', content: 'Voce ' });
    store._handleStreamChunk({ kind: 'narrator', runId: 'run-a', type: 'text', content: 'aprova?' });
    const { maestroThread } = useDynamicWorkflowStore.getState();
    expect(maestroThread).toHaveLength(2);
    expect(maestroThread[0].content).toBe('Gate de plano aberto.');
    expect(maestroThread[1].content).toBe('Voce aprova?');
    expect(maestroThread[1].streaming).toBe(true);
  });
});

describe('deleteWorkflow (REGRA MAXIMA: unica acao destrutiva)', () => {
  it('em sucesso fecha o detalhe (se aberto) e recarrega a lista', async () => {
    (window.lionclaw.dynamicWorkflow.deleteRun as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    useDynamicWorkflowStore.setState({ selectedRunId: 'run-a', selectedRun: makeRun('run-a', 'paused') });
    const result = await useDynamicWorkflowStore.getState().deleteWorkflow('run-a');
    expect(result).toEqual({ ok: true });
    expect(useDynamicWorkflowStore.getState().selectedRunId).toBeNull();
  });

  it('propaga erro do IPC e mantem o detalhe aberto', async () => {
    (window.lionclaw.dynamicWorkflow.deleteRun as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ error: 'falhou' });
    useDynamicWorkflowStore.setState({ selectedRunId: 'run-a', selectedRun: makeRun('run-a', 'paused') });
    const result = await useDynamicWorkflowStore.getState().deleteWorkflow('run-a');
    expect(result).toEqual({ error: 'falhou' });
    expect(useDynamicWorkflowStore.getState().error).toBe('falhou');
    expect(useDynamicWorkflowStore.getState().selectedRunId).toBe('run-a');
  });
});

describe('approveGate (SM-20: banner reflete a decisao real)', () => {
  it('limpa o awaiting OTIMISTICAMENTE ao decidir', async () => {
    (window.lionclaw.dynamicWorkflow.approveGate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    useDynamicWorkflowStore.setState({
      selectedRunId: null,
      awaitingUserRunIds: new Set(['run-a']),
    });
    const err = await useDynamicWorkflowStore.getState().approveGate('run-a', 'gate-1', { decision: 'approve' });
    expect(err).toBeNull();
    expect(useDynamicWorkflowStore.getState().awaitingUserRunIds.has('run-a')).toBe(false);
  });

  it('retorna a string de erro do IPC sem limpar', async () => {
    (window.lionclaw.dynamicWorkflow.approveGate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ error: 'gate-fechado' });
    useDynamicWorkflowStore.setState({ awaitingUserRunIds: new Set(['run-a']) });
    const err = await useDynamicWorkflowStore.getState().approveGate('run-a', 'gate-1', { decision: 'reject' });
    expect(err).toBe('gate-fechado');
    expect(useDynamicWorkflowStore.getState().awaitingUserRunIds.has('run-a')).toBe(true);
  });
});

describe('_handleStreamChunk: stall (node-stalled / limpeza)', () => {
  it('node-stalled grava stalledByRun; node-started limpa', () => {
    const store = useDynamicWorkflowStore.getState();
    store._handleStreamChunk({
      kind: 'runner',
      runId: 'run-a',
      type: 'event',
      eventType: 'node-stalled',
      payload: { message: 'sem progresso ha 3min', at: '2026-06-13T00:00:00.000Z' },
    });
    expect(useDynamicWorkflowStore.getState().stalledByRun['run-a']).toEqual({
      message: 'sem progresso ha 3min',
      at: '2026-06-13T00:00:00.000Z',
    });
    store._handleStreamChunk({
      kind: 'runner',
      runId: 'run-a',
      type: 'event',
      eventType: 'node-started',
    });
    expect(useDynamicWorkflowStore.getState().stalledByRun['run-a']).toBeUndefined();
  });
});


describe('closer busy (Inc4)', () => {
  it('sendCloserMessage marca busy; o chunk do closer limpa', async () => {
    useDynamicWorkflowStore.setState({ selectedRunId: 'run-a' });
    const promise = useDynamicWorkflowStore.getState().sendCloserMessage('run-a', 'oi closer');
    expect(useDynamicWorkflowStore.getState().closerBusyRunIds.has('run-a')).toBe(true);
    await promise;
    expect(useDynamicWorkflowStore.getState().closerBusyRunIds.has('run-a')).toBe(true);
    useDynamicWorkflowStore.getState()._handleStreamChunk({
      kind: 'closer',
      runId: 'run-a',
      type: 'text',
      content: 'aqui esta a entrega',
    });
    expect(useDynamicWorkflowStore.getState().closerBusyRunIds.has('run-a')).toBe(false);
  });

  it('sendCloserMessage com erro limpa o busy', async () => {
    nextCloserResult = { error: 'closer-down' };
    await useDynamicWorkflowStore.getState().sendCloserMessage('run-a', 'oi');
    expect(useDynamicWorkflowStore.getState().closerBusyRunIds.has('run-a')).toBe(false);
    expect(useDynamicWorkflowStore.getState().error).toBe('closer-down');
  });

  it('done do run tambem encerra o busy do closer', () => {
    useDynamicWorkflowStore.setState({ closerBusyRunIds: new Set(['run-a']) });
    useDynamicWorkflowStore.getState()._handleStreamChunk({
      kind: 'closer',
      runId: 'run-a',
      type: 'done',
    });
    expect(useDynamicWorkflowStore.getState().closerBusyRunIds.has('run-a')).toBe(false);
  });
});


describe('debounce dos reloads (Inc2)', () => {
  it('coalesce uma rajada de eventos runner num unico loadRuns (trailing)', async () => {
    vi.useFakeTimers();
    try {
      const listRunsSpy = window.lionclaw.dynamicWorkflow.listRuns as ReturnType<typeof vi.fn>;
      listRunsSpy.mockClear();
      const store = useDynamicWorkflowStore.getState();
      for (let i = 0; i < 5; i += 1) {
        store._handleStreamChunk({
          kind: 'runner',
          runId: 'run-a',
          type: 'event',
          eventType: 'node-progress',
        });
      }
      expect(listRunsSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(listRunsSpy).toHaveBeenCalledTimes(1);
    } finally {
      _cancelRunnerReloadTimers();
      vi.useRealTimers();
    }
  });
});

