
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DynamicWorkflowEvent, DynamicWorkflowRun } from '../dynamic-workflows/types';
import type { LiveActivityEvent, StreamChunk } from '../../../src/types';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../db', () => ({
  getDynamicWorkflowRun: vi.fn(() => null),
  getLatestUserTurnIndex: vi.fn(() => 0),
}));

vi.mock('../activity-log', () => ({
  recordActivity: vi.fn(),
}));

import {
  mapWorkflowEventToActivities,
  initWorkflowActivityBridge,
  type WorkflowActivityDeps,
} from '../dynamic-workflows/workflow-activity';


function makeRun(patch?: Partial<DynamicWorkflowRun>): DynamicWorkflowRun {
  return {
    id: 'run-1',
    definitionId: 'def-1',
    chatSessionId: 'sess-1',
    status: 'running',
    currentPhaseId: 'implement',
    currentNodeId: 'coder',
    workspaceMode: 'run-worktree',
    baseBranch: 'main',
    baseCommitSha: 'abc',
    baseWorktreeHash: null,
    worktreePath: '/tmp/wt',
    worktreeBranch: 'dynworkflow/run-1',
    deliveredAt: null,
    finalizedAt: null,
    closerSessionId: null,
    closerStatus: null,
    inputJson: '{"autonomy":"auto"}',
    outputJson: null,
    checkpointJson: '{}',
    error: null,
    totalCostUsd: 0.0123,
    totalDurationMs: 12000,
    createdBy: 'human',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:10.000Z',
    completedAt: null,
    ...patch,
  };
}

let seqCounter = 0;
function makeEvent(patch: Partial<DynamicWorkflowEvent> & Pick<DynamicWorkflowEvent, 'type'>): DynamicWorkflowEvent {
  seqCounter += 1;
  return {
    id: seqCounter,
    runId: 'run-1',
    nodeId: null,
    phaseId: null,
    seq: seqCounter,
    payloadJson: '{}',
    createdAt: '2026-01-01T00:00:05.000Z',
    ...patch,
  };
}

type InjectedBus = WorkflowActivityDeps['bus'];

interface FakeBus {
  subscribe: (listener: (e: DynamicWorkflowEvent) => void) => () => void;
  publish: (e: DynamicWorkflowEvent) => void;
  unsubscribeCalls: number;
  listenerCount: () => number;
  asDep: InjectedBus;
}

function makeFakeBus(): FakeBus {
  const listeners = new Set<(e: DynamicWorkflowEvent) => void>();
  let unsubscribeCalls = 0;
  const fake = {
    subscribe(listener: (e: DynamicWorkflowEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        unsubscribeCalls += 1;
        listeners.delete(listener);
      };
    },
    publish(e: DynamicWorkflowEvent): void {
      for (const l of [...listeners]) l(e);
    },
    get unsubscribeCalls(): number {
      return unsubscribeCalls;
    },
    listenerCount: (): number => listeners.size,
    asDep: null as unknown as InjectedBus,
  };
  fake.asDep = fake as unknown as InjectedBus;
  return fake;
}

beforeEach(() => {
  vi.clearAllMocks();
  seqCounter = 0;
});


describe('mapWorkflowEventToActivities (S16, mapeador puro)', () => {
  it('run-started: um unico bloco raiz workflow com phase start e projectId = runId', () => {
    const run = makeRun();
    const out = mapWorkflowEventToActivities(makeEvent({ type: 'run-started' }), run);
    expect(out).toHaveLength(1);
    const root = out[0]!;
    expect(root.id).toBe('workflow:run-1');
    expect(root.kind).toBe('workflow');
    expect(root.phase).toBe('start');
    expect(root.projectId).toBe('run-1');
    expect(root.startedAt).toBe(run.startedAt);
    expect(root.costUsd).toBe(run.totalCostUsd);
  });

  it('node-started: refresca o raiz E cria um filho subagente com parentId do raiz', () => {
    const run = makeRun();
    const ev = makeEvent({
      type: 'node-started',
      nodeId: 'coder',
      payloadJson: JSON.stringify({ nodeId: 'coder', attempt: 1, agentId: 'dynamic-workflow-coder' }),
    });
    const out = mapWorkflowEventToActivities(ev, run);
    expect(out).toHaveLength(2);

    const root = out[0]!;
    expect(root.id).toBe('workflow:run-1');
    expect(root.kind).toBe('workflow');

    const child = out[1]!;
    expect(child.id).toBe('workflow:run-1:node:coder#1');
    expect(child.parentId).toBe('workflow:run-1');
    expect(child.kind).toBe('subagent');
    expect(child.phase).toBe('start');
    expect(child.label).toBe('coder');
    expect(child.status).toBe('running');
    expect(child.agentId).toBe('dynamic-workflow-coder');
  });

  it('node-started attempt > 1: filho ganha descricao de tentativa e id por attempt', () => {
    const run = makeRun();
    const ev = makeEvent({
      type: 'node-started',
      payloadJson: JSON.stringify({ nodeId: 'fix', attempt: 2 }),
    });
    const out = mapWorkflowEventToActivities(ev, run);
    const child = out[1]!;
    expect(child.id).toBe('workflow:run-1:node:fix#2');
    expect(child.description).toContain('2');
  });

  it('node-completed: fecha o filho com status done e custo do payload', () => {
    const run = makeRun();
    const ev = makeEvent({
      type: 'node-completed',
      payloadJson: JSON.stringify({ nodeId: 'coder', attempt: 1, costUsd: 0.42 }),
    });
    const out = mapWorkflowEventToActivities(ev, run);
    expect(out).toHaveLength(1);
    const child = out[0]!;
    expect(child.id).toBe('workflow:run-1:node:coder#1');
    expect(child.parentId).toBe('workflow:run-1');
    expect(child.phase).toBe('end');
    expect(child.status).toBe('done');
    expect(child.costUsd).toBe(0.42);
  });

  it('gate-blocked: cria filho cujo label comeca por "gate:" (gatilho do CTA)', () => {
    const run = makeRun();
    const ev = makeEvent({
      type: 'gate-blocked',
      payloadJson: JSON.stringify({ gateId: 'final', mode: 'orchestrator' }),
    });
    const out = mapWorkflowEventToActivities(ev, run);
    expect(out).toHaveLength(2); // raiz + filho de gate
    const gate = out[1]!;
    expect(gate.id).toBe('workflow:run-1:gate:final');
    expect(gate.parentId).toBe('workflow:run-1');
    expect(gate.kind).toBe('subagent');
    expect(gate.label.startsWith('gate:')).toBe(true);
    expect(gate.label).toContain('gate');
    expect(gate.description).toContain('orchestrator');
  });

  it('intervention: filho terminal com id unico por seq (nao sobrescreve)', () => {
    const run = makeRun();
    const a = mapWorkflowEventToActivities(
      makeEvent({ type: 'intervention', seq: 7, payloadJson: JSON.stringify({ type: 'reply', source: 'humano' }) }),
      run,
    );
    const b = mapWorkflowEventToActivities(
      makeEvent({ type: 'intervention', seq: 8, payloadJson: JSON.stringify({ type: 'pause', source: 'humano' }) }),
      run,
    );
    expect(a[0]!.id).toBe('workflow:run-1:intervention:7');
    expect(b[0]!.id).toBe('workflow:run-1:intervention:8');
    expect(a[0]!.id).not.toBe(b[0]!.id);
    expect(a[0]!.parentId).toBe('workflow:run-1');
    expect(a[0]!.label).toContain('reply');
  });

  it('merge-squashed (evento nao mapeado): cai no default e SO refresca o raiz', () => {
    const run = makeRun();
    const out = mapWorkflowEventToActivities(
      makeEvent({ type: 'merge-squashed', payloadJson: JSON.stringify({ from: 'x', to: 'main' }) }),
      run,
    );
    expect(out).toHaveLength(1);
    const root = out[0]!;
    expect(root.id).toBe('workflow:run-1');
    expect(root.kind).toBe('workflow');
    expect(root.parentId).toBeUndefined();
  });

  it('checkpoint/log (internos): tambem caem no default, so o raiz', () => {
    const run = makeRun();
    for (const type of ['checkpoint-saved', 'log', 'artifact-written']) {
      const out = mapWorkflowEventToActivities(makeEvent({ type }), run);
      expect(out).toHaveLength(1);
      expect(out[0]!.kind).toBe('workflow');
    }
  });

  it('run-finished: raiz vira phase end com status done', () => {
    const run = makeRun({ status: 'completed' });
    const out = mapWorkflowEventToActivities(makeEvent({ type: 'run-finished' }), run);
    expect(out).toHaveLength(1);
    expect(out[0]!.phase).toBe('end');
    expect(out[0]!.status).toBe('done');
  });

  it('payload invalido nao derruba o mapeador (parse defensivo)', () => {
    const run = makeRun();
    const out = mapWorkflowEventToActivities(
      makeEvent({ type: 'node-started', payloadJson: '{ nao-e-json' }),
      run,
    );
    expect(out).toHaveLength(2);
    expect(out[1]!.id).toBe('workflow:run-1:node:node#1');
  });
});


describe('initWorkflowActivityBridge gating chat-bound (S16, AC-13)', () => {
  type RecordCall = { sessionId: string; turnIndex: number; ev: LiveActivityEvent };

  function setup(run: DynamicWorkflowRun | null) {
    const bus = makeFakeBus();
    const records: RecordCall[] = [];
    const overrides: Partial<WorkflowActivityDeps> = {
      getRun: vi.fn(() => run),
      getTurnIndex: vi.fn(() => 3),
      record: vi.fn((sessionId: string, turnIndex: number, ev: LiveActivityEvent, _send: (c: StreamChunk) => void) => {
        records.push({ sessionId, turnIndex, ev });
      }),
      getWindow: () => null,
      bus: bus.asDep,
    };
    const cleanup = initWorkflowActivityBridge(() => null, overrides);
    return { bus, records, overrides, cleanup };
  }

  it('run SEM chatSessionId: nenhum record gravado (vive so na pagina)', () => {
    const { bus, records, overrides, cleanup } = setup(makeRun({ chatSessionId: null }));
    bus.publish(makeEvent({ type: 'run-started' }));
    expect((overrides.getRun as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('run-1');
    expect((overrides.getTurnIndex as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
    cleanup();
  });

  it('run inexistente (getRun null): nenhum record', () => {
    const { bus, records, cleanup } = setup(null);
    bus.publish(makeEvent({ type: 'run-started' }));
    expect(records).toHaveLength(0);
    cleanup();
  });

  it('run chat-bound: 1 record por LiveActivityEvent, com sessionId e turnIndex resolvidos', () => {
    const { bus, records, cleanup } = setup(makeRun({ chatSessionId: 'sess-1' }));
    bus.publish(makeEvent({ type: 'node-started', payloadJson: JSON.stringify({ nodeId: 'coder', attempt: 1 }) }));
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.sessionId).toBe('sess-1');
      expect(r.turnIndex).toBe(3);
    }
    expect(records[0]!.ev.projectId).toBe('run-1');
    expect(records[0]!.ev.kind).toBe('workflow');
    expect(records[1]!.ev.parentId).toBe('workflow:run-1');
    cleanup();
  });

  it('record que lanca nao derruba o bridge (isolado em try/catch)', () => {
    const bus = makeFakeBus();
    const overrides: Partial<WorkflowActivityDeps> = {
      getRun: () => makeRun({ chatSessionId: 'sess-1' }),
      getTurnIndex: () => 1,
      record: () => {
        throw new Error('db indisponivel');
      },
      getWindow: () => null,
      bus: bus.asDep,
    };
    const cleanup = initWorkflowActivityBridge(() => null, overrides);
    expect(() => bus.publish(makeEvent({ type: 'run-started' }))).not.toThrow();
    cleanup();
  });
});


describe('initWorkflowActivityBridge idempotencia (S16)', () => {
  it('a segunda chamada desassina a primeira antes de reassinar', () => {
    const bus = makeFakeBus();
    const base: Partial<WorkflowActivityDeps> = {
      getRun: () => makeRun({ chatSessionId: 'sess-1' }),
      getTurnIndex: () => 1,
      record: vi.fn(),
      getWindow: () => null,
      bus: bus.asDep,
    };

    initWorkflowActivityBridge(() => null, base);
    expect(bus.listenerCount()).toBe(1);
    expect(bus.unsubscribeCalls).toBe(0);

    const cleanup2 = initWorkflowActivityBridge(() => null, base);
    expect(bus.unsubscribeCalls).toBe(1);
    expect(bus.listenerCount()).toBe(1);

    cleanup2();
    expect(bus.listenerCount()).toBe(0);
  });

  it('um evento apos reinit dispara o record uma unica vez (sem assinatura dupla)', () => {
    const bus = makeFakeBus();
    const record = vi.fn();
    const base: Partial<WorkflowActivityDeps> = {
      getRun: () => makeRun({ chatSessionId: 'sess-1' }),
      getTurnIndex: () => 1,
      record,
      getWindow: () => null,
      bus: bus.asDep,
    };
    initWorkflowActivityBridge(() => null, base);
    const cleanup = initWorkflowActivityBridge(() => null, base);

    record.mockClear();
    bus.publish(makeEvent({ type: 'run-finished' }));
    expect(record).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
