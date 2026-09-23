import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowRunnerDeps } from '../dynamic-workflows/workflow-runner';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: vi.fn() }));

vi.mock('../db', () => ({
  getActiveChatSession: vi.fn(() => null),
  getDynamicWorkflowRun: vi.fn(() => null),
  listDynamicWorkflowRuns: vi.fn(() => []),
  getDynamicWorkflowDefinition: vi.fn(() => null),
  createDynamicWorkflowDefinition: vi.fn(),
  createDynamicWorkflowRun: vi.fn(),
  getAllAgents: vi.fn(() => []),
  listDynamicWorkflowRunsByStatus: vi.fn(() => []),
  setDynamicWorkflowRunStatus: vi.fn(),
  updateDynamicWorkflowRun: vi.fn(),
  upsertDynamicWorkflowNodeRun: vi.fn(),
  updateDynamicWorkflowNodeRun: vi.fn(),
  listDynamicWorkflowNodeRuns: vi.fn(() => []),
  insertDynamicWorkflowEvent: vi.fn(() => ({})),
  listDynamicWorkflowRecentEvents: vi.fn(() => []),
  insertDynamicWorkflowGateDecision: vi.fn(() => ({})),
  insertDynamicWorkflowArtifact: vi.fn(() => ({})),
  insertDynamicWorkflowMessage: vi.fn(() => ({})),
  listDynamicWorkflowMessages: vi.fn(() => []),
  getDynamicWorkflowRunCostAggregate: vi.fn(() => ({})),
  createDynamicWorkflowNode: vi.fn(() => ({})),
  getDynamicWorkflowNodeByKey: vi.fn(() => null),
  updateDynamicWorkflowNodeSprintMeta: vi.fn(),
  updateDynamicWorkflowDefinition: vi.fn(),
  upsertDynamicWorkflowSprint: vi.fn(() => ({})),
  updateDynamicWorkflowSprint: vi.fn(),
  listDynamicWorkflowSprints: vi.fn(() => []),
  materializeDynamicWorkflowSprintPlan: vi.fn(),
  getDynamicWorkflowPriorMaterialization: vi.fn(() => null),
  appendDynamicWorkflowJournalEntry: vi.fn(),
  listDynamicWorkflowJournalEntries: vi.fn(() => []),
  truncateDynamicWorkflowJournalFrom: vi.fn(),
  repointDynamicWorkflowRunDefinition: vi.fn(),
  claimAdjustmentsForNode: vi.fn(() => []),
  getSetting: vi.fn(() => undefined),
  getConsumedAdjustmentsForNode: vi.fn(() => []),
}));

vi.mock('../dynamic-workflows/workflow-create', () => ({
  createWorkflow: vi.fn(async () => ({ ok: true, runId: 'run-1', definitionId: 'def-1' })),
}));

let capturedDeps: WorkflowRunnerDeps | undefined;
const fakeRunner = {
  start: vi.fn(async () => ({ ok: true })),
  abort: vi.fn(async () => ({ ok: true })),
  intervene: vi.fn(async () => ({ ok: true })),
  approveGate: vi.fn(async () => ({ ok: true })),
  getSnapshot: vi.fn(() => null),
  recoverInterrupted: vi.fn(() => ({ recovered: 0 })),
};
vi.mock('../dynamic-workflows/workflow-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dynamic-workflows/workflow-runner')>();
  return {
    ...actual,
    getWorkflowRunner: (deps?: WorkflowRunnerDeps) => {
      if (deps) capturedDeps = deps;
      return fakeRunner as unknown as ReturnType<typeof actual.getWorkflowRunner>;
    },
    recoverInterruptedRuns: vi.fn(() => ({ recovered: 0 })),
  };
});

import { ensureWorkflowRunner } from '../dynamic-workflows/workflow-control-core';

beforeEach(() => {
  vi.clearAllMocks();
  capturedDeps = undefined;
});

describe('DEFECT-3: ensureWorkflowRunner constroi o singleton COM closer (fabrica unica)', () => {
  it('passa deps com closerDeps.runAgentTurn a getWorkflowRunner (RED se revertido para deps reduzidas)', async () => {
    await ensureWorkflowRunner();
    expect(capturedDeps).toBeDefined();
    expect(capturedDeps?.closerDeps).toBeDefined();
    expect(typeof capturedDeps?.closerDeps?.runAgentTurn).toBe('function');
    expect(capturedDeps?.crud).toBeDefined();
    expect(typeof capturedDeps?.crud.getRun).toBe('function');
  });
});
