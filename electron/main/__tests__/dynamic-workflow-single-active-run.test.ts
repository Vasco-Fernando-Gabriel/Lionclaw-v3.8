import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  WorkflowRunner,
  assertNoOtherActiveRun,
  IN_PROGRESS_RUN_STATUSES,
  _resetRunLocksForTesting,
  type WorkflowRunnerCrud,
  type WorkflowRunnerDeps,
} from '../dynamic-workflows/workflow-runner';
import type { DynamicWorkflowRun, DynamicWorkflowRunStatus } from '../dynamic-workflows/types';

function makeRun(over: Partial<DynamicWorkflowRun> & { id: string }): DynamicWorkflowRun {
  return {
    definitionId: 'def-' + over.id,
    chatSessionId: null,
    status: 'created',
    currentPhaseId: null,
    currentNodeId: null,
    workspaceMode: null,
    baseBranch: null,
    baseCommitSha: null,
    baseWorktreeHash: null,
    worktreePath: null,
    worktreeBranch: null,
    deliveredAt: null,
    finalizedAt: null,
    closerSessionId: null,
    closerStatus: null,
    inputJson: '{}',
    outputJson: null,
    checkpointJson: '{}',
    error: null,
    totalCostUsd: 0,
    totalDurationMs: 0,
    createdBy: 'manual',
    startedAt: null,
    updatedAt: '2026-06-12T00:00:00.000Z',
    completedAt: null,
    ...over,
  };
}

function makeGuardDeps(runs: DynamicWorkflowRun[]): {
  deps: WorkflowRunnerDeps;
  runsById: Map<string, DynamicWorkflowRun>;
} {
  const runsById = new Map(runs.map((r) => [r.id, r]));
  const crud = {
    getRun: (id: string) => runsById.get(id) ?? null,
    getDefinition: () => null, // forca o "proximo passo" quando o guard passa
    listRunsByStatus: (status: DynamicWorkflowRunStatus) => [...runsById.values()].filter((r) => r.status === status),
    setRunStatus: (id: string, status: DynamicWorkflowRunStatus) => {
      const r = runsById.get(id);
      if (r) runsById.set(id, { ...r, status });
    },
    updateRun: (id: string, patch: Partial<DynamicWorkflowRun>) => {
      const r = runsById.get(id);
      if (r) runsById.set(id, { ...r, ...patch } as DynamicWorkflowRun);
    },
    upsertNodeRun: vi.fn(),
    updateNodeRun: vi.fn(),
    listNodeRuns: () => [],
    insertEvent: vi.fn(() => ({}) as never),
    recentEvents: () => [],
    insertGateDecision: vi.fn(() => ({}) as never),
    registerArtifact: vi.fn(() => ({}) as never),
    insertMessage: vi.fn(() => ({}) as never),
    listMessages: () => [],
    costAggregate: () => ({}) as never,
  } as unknown as WorkflowRunnerCrud;

  const deps: WorkflowRunnerDeps = {
    crud,
    sandboxFactory: {
      spawn: () => {
        throw new Error('sandbox NAO deveria subir no caminho do guard');
      },
    } as never,
    git: (async () => {
      throw new Error('git NAO deveria rodar no caminho do guard');
    }) as never,
    emitIPC: () => {},
    now: () => '2026-06-12T00:00:00.000Z',
    runNodeAgent: (async () => {
      throw new Error('adapter NAO deveria rodar');
    }) as never,
  };
  return { deps, runsById };
}

const IN_PROGRESS: DynamicWorkflowRunStatus[] = ['running', 'blocked', 'paused', 'interrupted'];
const NON_BLOCKING: DynamicWorkflowRunStatus[] = [
  'created', // idle
  'completed',
  'delivered',
  'aborted',
  'failed',
];

describe('E3/T3: guard single-active-run em runner.start (FONTE DE VERDADE)', () => {
  beforeEach(() => {
    _resetRunLocksForTesting();
  });

  it('IN_PROGRESS_RUN_STATUSES e o conjunto fechado exato {running,blocked,paused,interrupted}', () => {
    expect([...IN_PROGRESS_RUN_STATUSES].sort()).toEqual(['blocked', 'interrupted', 'paused', 'running'].sort());
  });

  for (const statusA of IN_PROGRESS) {
    it(`run A em "${statusA}" BLOQUEIA o start de um run B distinto (antes do sandbox)`, async () => {
      const runA = makeRun({ id: 'run-A', status: statusA });
      const runB = makeRun({ id: 'run-B', status: 'created' });
      const { deps } = makeGuardDeps([runA, runB]);
      const runner = new WorkflowRunner(deps);

      const res = await runner.start('run-B');

      expect('error' in res).toBe(true);
      const err = (res as { error: string }).error;
      expect(err).toContain('single-active-run');
      expect(err).toContain('run-A');
      expect(err).not.toContain('definition');
    });
  }

  for (const statusA of NON_BLOCKING) {
    it(`run A em "${statusA}" NAO bloqueia: o start de B AVANCA o guard (para no proximo passo)`, async () => {
      const runA = makeRun({ id: 'run-A', status: statusA });
      const runB = makeRun({ id: 'run-B', status: 'created' });
      const { deps } = makeGuardDeps([runA, runB]);
      const runner = new WorkflowRunner(deps);

      const res = await runner.start('run-B');

      expect('error' in res).toBe(true);
      const err = (res as { error: string }).error;
      expect(err).not.toContain('single-active-run');
      expect(err).toContain('definition');
    });
  }

  it('o proprio run (selfRunId) nao se bloqueia: retomar um run blocked AVANCA o guard', async () => {
    const runB = makeRun({ id: 'run-B', status: 'blocked' });
    const { deps } = makeGuardDeps([runB]);
    const runner = new WorkflowRunner(deps);

    const res = await runner.start('run-B');

    expect('error' in res).toBe(true);
    const err = (res as { error: string }).error;
    expect(err).not.toContain('single-active-run');
    expect(err).toContain('definition');
  });

  it('run A "running" e B "running" -> start de B e no-op idempotente (gate proprio ANTES do cross-run)', async () => {
    const runA = makeRun({ id: 'run-A', status: 'running' });
    const runB = makeRun({ id: 'run-B', status: 'running' });
    const { deps } = makeGuardDeps([runA, runB]);
    const runner = new WorkflowRunner(deps);

    const res = await runner.start('run-B');
    expect(res).toEqual({ ok: true });
  });
});

describe('E3: helper puro assertNoOtherActiveRun (runner export)', () => {
  const list =
    (runs: DynamicWorkflowRun[]) =>
    (status: DynamicWorkflowRunStatus): DynamicWorkflowRun[] =>
      runs.filter((r) => r.status === status);

  it('devolve mensagem quando ha OUTRO run em-progresso', () => {
    const runs = [makeRun({ id: 'other', status: 'paused' })];
    const msg = assertNoOtherActiveRun('self', list(runs));
    expect(msg).toContain('single-active-run');
    expect(msg).toContain('other');
  });

  it('devolve null quando o unico run em-progresso e o proprio (self)', () => {
    const runs = [makeRun({ id: 'self', status: 'running' })];
    expect(assertNoOtherActiveRun('self', list(runs))).toBeNull();
  });

  it('devolve null quando os outros runs sao terminais/idle', () => {
    const runs = [
      makeRun({ id: 'a', status: 'completed' }),
      makeRun({ id: 'b', status: 'delivered' }),
      makeRun({ id: 'c', status: 'aborted' }),
      makeRun({ id: 'd', status: 'failed' }),
      makeRun({ id: 'e', status: 'created' }),
    ];
    expect(assertNoOtherActiveRun('self', list(runs))).toBeNull();
  });
});

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const listByStatusMock = vi.fn<(status: DynamicWorkflowRunStatus) => DynamicWorkflowRun[]>(() => []);
const getRunMock = vi.fn<(id: string) => DynamicWorkflowRun | null>((id) => makeRun({ id, status: 'created' }));
vi.mock('../db', () => ({
  getActiveChatSession: () => ({ id: 'chat-1' }),
  getDynamicWorkflowRun: (id: string) => getRunMock(id),
  listDynamicWorkflowRuns: vi.fn(() => []),
  listDynamicWorkflowRunsByStatus: (status: DynamicWorkflowRunStatus) => listByStatusMock(status),
  getDynamicWorkflowDefinition: vi.fn(() => null),
  createDynamicWorkflowDefinition: vi.fn(),
  createDynamicWorkflowRun: vi.fn(),
  createDynamicWorkflowNode: vi.fn(() => ({})),
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(() => undefined),
  insertAuditEntry: vi.fn(),
}));

const createWorkflowMock = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({
  ok: true,
  runId: 'run-new',
  definitionId: 'def-new',
}));
vi.mock('../dynamic-workflows/workflow-create', () => ({
  createWorkflow: (input: unknown) => createWorkflowMock(input),
}));

const runnerStartMock = vi.fn(async () => ({ ok: true }));
vi.mock('../dynamic-workflows/workflow-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dynamic-workflows/workflow-runner')>();
  return {
    ...actual,
    getWorkflowRunner: () => ({ start: runnerStartMock }),
  };
});
vi.mock('../dynamic-workflows/workflow-runner-deps', () => ({
  createDefaultRunnerDeps: () => ({}),
}));

import { dynamicWorkflowStartCore, dynamicWorkflowAuthorCore } from '../dynamic-workflows/workflow-control-core';

describe('E3/T3: fail-fast de UX nas portas de control-core (start/author)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listByStatusMock.mockReturnValue([]);
    getRunMock.mockImplementation((id) => makeRun({ id, status: 'created' }));
  });

  it('dynamicWorkflowStartCore: recusa quando ja ha outro run em-progresso (sem subir o sandbox)', async () => {
    listByStatusMock.mockImplementation((status) =>
      status === 'running' ? [makeRun({ id: 'run-other', status: 'running' })] : [],
    );

    const res = await dynamicWorkflowStartCore('run-target');

    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('single-active-run');
    expect(runnerStartMock).not.toHaveBeenCalled();
  });

  it('dynamicWorkflowStartCore: NAO recusa quando o unico run em-progresso e o proprio target', async () => {
    getRunMock.mockImplementation((id) => makeRun({ id, status: 'created' }));
    listByStatusMock.mockImplementation((status) =>
      status === 'blocked' ? [makeRun({ id: 'run-target', status: 'blocked' })] : [],
    );

    const res = await dynamicWorkflowStartCore('run-target');

    expect(res.ok).toBe(true);
    expect(runnerStartMock).toHaveBeenCalledTimes(1);
  });

  it('dynamicWorkflowAuthorCore (start=true): recusa ANTES de criar (createWorkflow nao chamado)', async () => {
    listByStatusMock.mockImplementation((status) =>
      status === 'paused' ? [makeRun({ id: 'run-busy', status: 'paused' })] : [],
    );

    const res = await dynamicWorkflowAuthorCore({
      projectPath: '/tmp/proj',
      workflowJsSource: 'export default async function run(ctx){ return {ok:true}; }',
      start: true,
    });

    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('single-active-run');
    expect(createWorkflowMock).not.toHaveBeenCalled();
  });

  it('dynamicWorkflowAuthorCore (start=false): NAO aplica o fail-fast (autorar sem iniciar nao ocupa slot)', async () => {
    listByStatusMock.mockImplementation((status) =>
      status === 'running' ? [makeRun({ id: 'run-busy', status: 'running' })] : [],
    );

    const res = await dynamicWorkflowAuthorCore({
      projectPath: '/tmp/proj',
      workflowJsSource: 'export default async function run(ctx){ return {ok:true}; }',
      start: false,
    });

    expect(res.ok).toBe(true);
    expect(createWorkflowMock).toHaveBeenCalledTimes(1);
    expect(runnerStartMock).not.toHaveBeenCalled();
  });

  it('nenhuma porta recusa quando nao ha outro run ativo (todos terminais/idle)', async () => {
    listByStatusMock.mockReturnValue([]);

    const start = await dynamicWorkflowStartCore('run-target');
    expect(start.ok).toBe(true);
    expect(runnerStartMock).toHaveBeenCalled();
  });
});
