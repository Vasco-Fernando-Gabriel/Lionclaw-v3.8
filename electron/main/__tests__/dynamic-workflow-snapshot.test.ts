import { describe, it, expect } from 'vitest';
import { buildSnapshot, derivePendingDecision, type SnapshotDeps } from '../dynamic-workflows/workflow-snapshot';
import type {
  DynamicWorkflowRun,
  DynamicWorkflowEvent,
  DynamicWorkflowRunCostAggregate,
  DynamicWorkflowPendingDecisionType,
} from '../dynamic-workflows/types';

function makeRun(over?: Partial<DynamicWorkflowRun>): DynamicWorkflowRun {
  return {
    id: 'run-1',
    definitionId: 'def-1',
    chatSessionId: null,
    status: 'running',
    currentPhaseId: 'Validar',
    currentNodeId: 'v0',
    workspaceMode: 'run-worktree',
    baseBranch: 'main',
    baseCommitSha: 'base',
    baseWorktreeHash: 'tree',
    worktreePath: '/p/wt',
    worktreeBranch: 'dynworkflow/run-1',
    deliveredAt: null,
    finalizedAt: null,
    closerSessionId: null,
    closerStatus: null,
    inputJson: '{}',
    outputJson: null,
    checkpointJson: '{}',
    error: null,
    totalCostUsd: 1.25,
    totalDurationMs: 5000,
    createdBy: 'manual',
    startedAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
    completedAt: null,
    ...over,
  };
}

function makeEvent(seq: number, type: string, payload?: unknown): DynamicWorkflowEvent {
  return {
    id: seq,
    runId: 'run-1',
    nodeId: null,
    phaseId: null,
    seq,
    type,
    payloadJson: JSON.stringify(payload ?? {}),
    createdAt: `2026-06-12T00:00:0${seq % 10}.000Z`,
  };
}

function makeCost(over?: Partial<DynamicWorkflowRunCostAggregate>): DynamicWorkflowRunCostAggregate {
  return {
    runId: 'run-1',
    totalCostUsd: 1.25,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalDurationMs: 5000,
    nodeRunCount: 3,
    unknownCostNodeRuns: 0,
    ...over,
  };
}

function makeDeps(run: DynamicWorkflowRun, events: DynamicWorkflowEvent[] = [], cost = makeCost()): SnapshotDeps {
  return {
    getRun: (id) => (id === run.id ? run : null),
    recentEvents: () => events,
    costAggregate: () => cost,
  };
}

function runWithPending(
  type: DynamicWorkflowPendingDecisionType,
  status: 'blocked' | 'failed' = 'blocked',
): DynamicWorkflowRun {
  return makeRun({
    status,
    inputJson: JSON.stringify({
      pendingDecision: { type, id: `${type}-id`, prompt: `decisao ${type}` },
    }),
  });
}

describe('SPEC orquestrador-driver D12: since + lastOutcomes', () => {
  it('deriva since (janela desde o ultimo wake executed) e lastOutcomes (<= 12, mais recentes primeiro)', () => {
    const run = makeRun();
    const all: DynamicWorkflowEvent[] = [
      makeEvent(1, 'node-completed', { agentId: 'old', access: 'read-only', costUsd: 9 }),
      makeEvent(2, 'wake-planned', { driveTurnId: 't1', reason: 'boundary' }),
      makeEvent(3, 'wake-completed', { driveTurnId: 't1', outcome: 'executed' }),
      ...Array.from({ length: 14 }, (_, i) =>
        makeEvent(4 + i, 'node-completed', { agentId: `a${i}`, access: 'read-only', costUsd: 0.5, durationMs: 1000 }),
      ),
      makeEvent(18, 'node-failed', { failureClass: 'logic', error: 'boom' }),
    ];
    for (let i = 0; i < 14; i++) all[3 + i]!.nodeId = `n${i}`;
    all[17]!.nodeId = 'f1';
    const deps: SnapshotDeps = {
      ...makeDeps(run, all.slice(-12)),
      listEventsSince: (_runId, afterSeq) => all.filter((e) => e.seq > afterSeq),
    };
    const snap = buildSnapshot('run-1', '/r', deps);
    expect(snap!.since).toEqual({
      nodes: 15,
      green: 14,
      attention: 0,
      pending: 0,
      failed: 1,
      costUsd: 7,
      durationMs: 14_000,
    });
    expect(snap!.lastOutcomes).toHaveLength(12);
    expect(snap!.lastOutcomes![0]).toMatchObject({
      type: 'node-failed',
      verdict: 'attention',
      failureClass: 'logic',
      errorExcerpt: 'boom',
      nodeId: 'f1',
    });
    expect(snap!.lastOutcomes![1]!.nodeId).toBe('n13');
    expect(snap!.lastOutcomes!.some((o) => o.agentId === 'old')).toBe(false);
    expect(snap!.recentEvents).toHaveLength(12);
  });

  it('sem listEventsSince (fakes legados) omite since/lastOutcomes', () => {
    const snap = buildSnapshot('run-1', '/r', makeDeps(makeRun(), [makeEvent(1, 'run-started')]));
    expect(snap!.since).toBeUndefined();
    expect(snap!.lastOutcomes).toBeUndefined();
  });
});

describe('workflow-snapshot: shape geral (13.3.2)', () => {
  it('deriva runId/repoPath/status/fase/node/custo + recentEvents', () => {
    const run = makeRun();
    const events = [makeEvent(1, 'run-started'), makeEvent(2, 'node-completed', { nodeId: 'scout' })];
    const snap = buildSnapshot('run-1', '/repo/proj', makeDeps(run, events));
    expect(snap).toBeTruthy();
    expect(snap!.runId).toBe('run-1');
    expect(snap!.repoPath).toBe('/repo/proj');
    expect(snap!.status).toBe('running');
    expect(snap!.currentPhaseId).toBe('Validar');
    expect(snap!.currentNodeId).toBe('v0');
    expect(snap!.cost.actualUsd).toBe(1.25);
    expect(snap!.recentEvents).toHaveLength(2);
    expect(snap!.recentEvents[1].summary).toContain('node-completed');
    expect(snap!.pendingDecision).toBeUndefined();
  });

  it('run inexistente -> null', () => {
    const snap = buildSnapshot('ausente', '/r', makeDeps(makeRun()));
    expect(snap).toBeNull();
  });

  it('lastCheckpointAt derivado do checkpoint_json (savedAt mais recente)', () => {
    const run = makeRun({
      checkpointJson: JSON.stringify({
        nodes: {
          scout: { nodeId: 'scout', savedAt: '2026-06-12T00:00:01.000Z' },
          coder: { nodeId: 'coder', savedAt: '2026-06-12T00:00:09.000Z' },
        },
      }),
    });
    const snap = buildSnapshot('run-1', '/r', makeDeps(run));
    expect(snap!.lastCheckpointAt).toBe('2026-06-12T00:00:09.000Z');
  });

  it('estimatedRemainingUsd e incluido quando o estimador devolve numero', () => {
    const run = makeRun();
    const deps: SnapshotDeps = {
      ...makeDeps(run),
      estimateRemainingUsd: () => 3.5,
    };
    const snap = buildSnapshot('run-1', '/r', deps);
    expect(snap!.cost.estimatedRemainingUsd).toBe(3.5);
  });
});

describe('workflow-snapshot: pendingDecision para os 4 tipos (13.3.2)', () => {
  const types: DynamicWorkflowPendingDecisionType[] = ['gate', 'question', 'error', 'provider'];

  for (const type of types) {
    it(`tipo '${type}' e derivado do input_json quando o run esta blocked`, () => {
      const run = runWithPending(type);
      const snap = buildSnapshot('run-1', '/r', makeDeps(run));
      expect(snap!.pendingDecision).toBeTruthy();
      expect(snap!.pendingDecision!.type).toBe(type);
      expect(snap!.pendingDecision!.id).toBe(`${type}-id`);
      expect(snap!.pendingDecision!.prompt).toBe(`decisao ${type}`);
    });
  }

  it("tipo 'provider' (rev0.6) nao some silenciosamente", () => {
    const run = runWithPending('provider');
    const pd = derivePendingDecision(run);
    expect(pd?.type).toBe('provider');
  });

  it('failed sem pendingDecision explicito vira tipo error com o motivo do run', () => {
    const run = makeRun({ status: 'failed', error: 'crash do node coder', inputJson: '{}' });
    const pd = derivePendingDecision(run);
    expect(pd?.type).toBe('error');
    expect(pd?.prompt).toBe('crash do node coder');
  });

  it('blocked sem pendingDecision registrado nunca esconde o bloqueio (error generico)', () => {
    const run = makeRun({ status: 'blocked', inputJson: '{}' });
    const pd = derivePendingDecision(run);
    expect(pd?.type).toBe('error');
    expect(pd?.prompt).toMatch(/bloqueado/);
  });

  it('run nao-bloqueado nao tem pendingDecision', () => {
    expect(derivePendingDecision(makeRun({ status: 'running' }))).toBeUndefined();
    expect(derivePendingDecision(makeRun({ status: 'delivered' }))).toBeUndefined();
    expect(derivePendingDecision(makeRun({ status: 'paused' }))).toBeUndefined();
  });

  it('input_json invalido nao quebra a derivacao (degrada para error em blocked)', () => {
    const run = makeRun({ status: 'blocked', inputJson: '{ nao e json' });
    const pd = derivePendingDecision(run);
    expect(pd?.type).toBe('error');
  });

  it('tipo de pendingDecision invalido no input_json e ignorado (cai para error)', () => {
    const run = makeRun({
      status: 'blocked',
      inputJson: JSON.stringify({ pendingDecision: { type: 'inventado', id: 'x', prompt: 'y' } }),
    });
    const pd = derivePendingDecision(run);
    expect(pd?.type).toBe('error');
  });
});

describe('workflow-snapshot: agregacao de custo', () => {
  it('actualUsd vem do agregado da CRUD', () => {
    const run = makeRun();
    const snap = buildSnapshot('run-1', '/r', makeDeps(run, [], makeCost({ totalCostUsd: 9.99 })));
    expect(snap!.cost.actualUsd).toBe(9.99);
  });
});
