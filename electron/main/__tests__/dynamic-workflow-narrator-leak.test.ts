import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../db', () => ({
  getDynamicWorkflowRun: vi.fn(() => null),
  getDynamicWorkflowDefinition: vi.fn(() => null),
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
  materializeDynamicWorkflowSprintPlan: vi.fn(),
  getDynamicWorkflowPriorMaterialization: vi.fn(),
  appendDynamicWorkflowJournalEntry: vi.fn(),
  listDynamicWorkflowJournalEntries: vi.fn(() => []),
  truncateDynamicWorkflowJournalFrom: vi.fn(),
  createDynamicWorkflowNode: vi.fn(),
  getDynamicWorkflowNodeByKey: vi.fn(() => null),
  updateDynamicWorkflowNodeSprintMeta: vi.fn(),
  updateDynamicWorkflowDefinition: vi.fn(),
  upsertDynamicWorkflowSprint: vi.fn(),
  updateDynamicWorkflowSprint: vi.fn(),
  listDynamicWorkflowSprints: vi.fn(() => []),
  createDynamicWorkflowDefinition: vi.fn(),
  repointDynamicWorkflowRunDefinition: vi.fn(),
  claimAdjustmentsForNode: vi.fn(() => []),
  getSetting: vi.fn(() => undefined),
  getConsumedAdjustmentsForNode: vi.fn(() => []),
  getAllAgents: vi.fn(() => []),
}));

vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: vi.fn() }));

const executeNarratorMock = vi.fn(async () => ({ output: 'O coder comecou a implementar.' }));
vi.mock('../dynamic-workflows/workflow-narrator-executor', () => ({
  executeNarrator: executeNarratorMock,
}));

import { realNarrateFn } from '../dynamic-workflows/workflow-runner-deps';

function trackAbortListeners(signal: AbortSignal): { count: () => number } {
  let live = 0;
  const realAdd = signal.addEventListener.bind(signal);
  const realRemove = signal.removeEventListener.bind(signal);
  const added = new Set<unknown>();
  vi.spyOn(signal, 'addEventListener').mockImplementation((type, listener, opts) => {
    if (type === 'abort' && listener && !added.has(listener)) {
      added.add(listener);
      live += 1;
    }
    return realAdd(type, listener, opts as never);
  });
  vi.spyOn(signal, 'removeEventListener').mockImplementation((type, listener, opts) => {
    if (type === 'abort' && listener && added.has(listener)) {
      added.delete(listener);
      live -= 1;
    }
    return realRemove(type, listener, opts as never);
  });
  return { count: () => live };
}

describe('realNarrateFn - SM-30 (sem leak de abort listener no signal longevo)', () => {
  let warnings: string[];
  const captureWarning = (w: Error | string): void => {
    warnings.push(typeof w === 'string' ? w : w.message);
  };

  beforeEach(() => {
    warnings = [];
    executeNarratorMock.mockReset();
    executeNarratorMock.mockResolvedValue({ output: 'O coder comecou a implementar.' });
    process.on('warning', captureWarning);
  });

  afterEach(() => {
    process.off('warning', captureWarning);
    vi.restoreAllMocks();
  });

  it('25 narracoes sobre o MESMO signal nao acumulam listeners de abort', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const tracker = trackAbortListeners(signal);

    for (let i = 0; i < 25; i += 1) {
      const result = await realNarrateFn({
        runId: 'run-1',
        prompt: `marco ${i}`,
        abortSignal: signal,
      });
      expect(result.text).toBe('O coder comecou a implementar.');
      expect(tracker.count()).toBe(0);
    }

    expect(tracker.count()).toBe(0);
    expect(executeNarratorMock).toHaveBeenCalledTimes(25);
  });

  it('nenhum MaxListenersExceededWarning e emitido apos muitas narracoes', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    for (let i = 0; i < 15; i += 1) {
      await realNarrateFn({ runId: 'run-1', prompt: `marco ${i}`, abortSignal: signal });
    }
    await new Promise((r) => setImmediate(r));
    const leakWarn = warnings.find((w) => w.includes('MaxListenersExceeded'));
    expect(leakWarn).toBeUndefined();
  });

  it('signal ja abortado: ainda narra e nao deixa residuo', async () => {
    const controller = new AbortController();
    controller.abort();
    const tracker = trackAbortListeners(controller.signal);
    const result = await realNarrateFn({
      runId: 'run-1',
      prompt: 'marco pos-abort',
      abortSignal: controller.signal,
    });
    expect(result.text).toBe('O coder comecou a implementar.');
    expect(tracker.count()).toBe(0);
  });

  it('mesmo se uma narracao FALHA, a ponte e removida (finally)', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const tracker = trackAbortListeners(signal);
    executeNarratorMock.mockRejectedValueOnce(new Error('modelo caiu'));
    await expect(realNarrateFn({ runId: 'run-1', prompt: 'marco que falha', abortSignal: signal })).rejects.toThrow(
      'modelo caiu',
    );
    expect(tracker.count()).toBe(0);
    const ok = await realNarrateFn({ runId: 'run-1', prompt: 'marco ok', abortSignal: signal });
    expect(ok.text).toBe('O coder comecou a implementar.');
    expect(tracker.count()).toBe(0);
  });
});
