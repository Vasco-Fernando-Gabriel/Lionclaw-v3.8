
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DynamicWorkflowEvent } from '../dynamic-workflows/types';
import type { DynamicWorkflowRun } from '../../../src/types/dynamic-workflow';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const createSessionMock = vi.fn(() => undefined);
const getActiveChatSessionMock = vi.fn(() => null);
vi.mock('../db', () => ({
  getDynamicWorkflowRun: vi.fn(() => null),
  getDynamicWorkflowDefinition: vi.fn(() => null),
  listDynamicWorkflowRunsByStatus: vi.fn(() => []),
  listDynamicWorkflowRuns: vi.fn(() => []),
  listDynamicWorkflowEvents: vi.fn(() => []),
  insertDynamicWorkflowEvent: vi.fn((input: { runId: string; type: string; payloadJson?: string }) => ({
    id: 0,
    runId: input.runId,
    nodeId: null,
    phaseId: null,
    seq: 0,
    type: input.type,
    payloadJson: input.payloadJson ?? '{}',
    createdAt: '2026-01-01T00:00:00.000Z',
  })),
  updateDynamicWorkflowRun: vi.fn(() => undefined),
  createSession: (...args: unknown[]) => createSessionMock(...(args as [])),
  getActiveChatSession: (...args: unknown[]) => getActiveChatSessionMock(...(args as [])),
}));

const submitMessageMock = vi.fn();
vi.mock('../orchestrator', () => ({
  submitMessage: (...args: unknown[]) => submitMessageMock(...(args as [])),
}));

import {
  parseOrchestratorGateBlock,
  parseWakeSignal,
  buildIgnitionPrompt,
  resolveDriveSession,
  parsePendingGateId,
  resolveGateModeFromManifest,
  scanBlockedRunsForIgnition,
  initWorkflowIgnitionBridge,
  isHarnessProjectId,
  decideWorkflowDriveTurn,
  findUnacknowledgedWake,
  _resetIgnitionForTesting,
  _pendingWakeForTesting,
  _wakeCountersForTesting,
  WAKE_BOUNDARY_DEBOUNCE_MS,
  type WorkflowIgnitionDeps,
} from '../dynamic-workflows/workflow-ignition';
import type { DynamicWorkflowDefinition } from '../../../src/types/dynamic-workflow';
import type { DynamicWorkflowEventInsertInput } from '../dynamic-workflows/types';

let seqCounter = 0;

function makeEvent(
  patch: Partial<DynamicWorkflowEvent> & Pick<DynamicWorkflowEvent, 'type'>,
): DynamicWorkflowEvent {
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

function gateBlocked(
  mode: string,
  gateId = 'gate-plan-review',
  runId = 'run-1',
): DynamicWorkflowEvent {
  return makeEvent({
    type: 'gate-blocked',
    runId,
    payloadJson: JSON.stringify({ gateId, mode }),
  });
}

function makeRun(patch?: Partial<DynamicWorkflowRun>): DynamicWorkflowRun {
  return {
    id: 'run-1',
    definitionId: 'def-1',
    chatSessionId: 'sess-1',
    status: 'blocked',
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
    totalCostUsd: 0,
    totalDurationMs: 0,
    createdBy: 'human',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:10.000Z',
    completedAt: null,
    ...patch,
  };
}

function makeFakeBus() {
  const listeners = new Set<(e: DynamicWorkflowEvent) => void>();
  let unsubscribeCalls = 0;
  return {
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
  };
}

function makeDefinition(
  patch: { id?: string; gates?: Array<{ id: string; mode: string }> } = {},
): DynamicWorkflowDefinition {
  const gates = patch.gates ?? [
    { id: 'gate-plan-review', mode: 'orchestrator' },
    { id: 'gate-delivery', mode: 'orchestrator' },
  ];
  const manifest = {
    version: 1,
    name: 'def',
    phases: [],
    nodes: [],
    parallelism: { maxConcurrentAgents: 1, parallelWritersAllowed: false },
    gates,
    estimate: { minUsd: 0, maxUsd: 0, unknownCostNodes: [] },
  };
  return {
    id: patch.id ?? 'def-1',
    name: 'def',
    definitionVersion: 1,
    authoringModel: 'claude-code',
    parentDefinitionId: null,
    supersedesDefinitionId: null,
    sourceType: 'spec',
    projectPath: '/tmp/proj',
    specPath: null,
    specSha256: null,
    workflowJsPath: '/tmp/wf.js',
    manifestPath: '/tmp/manifest.json',
    manifestJson: JSON.stringify(manifest),
    manifestHash: 'hash',
    contextBundlePath: null,
    builderModel: null,
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as DynamicWorkflowDefinition;
}

interface Captured {
  submit: ReturnType<typeof vi.fn>;
  createDedicatedSession: ReturnType<typeof vi.fn>;
  linkSession: ReturnType<typeof vi.fn>;
  getRun: ReturnType<typeof vi.fn>;
  mintCapability: ReturnType<typeof vi.fn>;
  getDefinition: ReturnType<typeof vi.fn>;
  listBlockedRuns: ReturnType<typeof vi.fn>;
  listRuns: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  registerReadOnlyTurn: ReturnType<typeof vi.fn>;
  events: DynamicWorkflowEvent[];
  seed: (...events: DynamicWorkflowEvent[]) => void;
  eventsOfType: (type: string) => DynamicWorkflowEvent[];
}

function makeDeps(
  run: DynamicWorkflowRun | null,
  boot?: {
    definition?: DynamicWorkflowDefinition | null;
    blocked?: DynamicWorkflowRun[];
    runs?: DynamicWorkflowRun[];
  },
): {
  deps: Partial<WorkflowIgnitionDeps>;
  cap: Captured;
} {
  let createdSeq = 0;
  const events: DynamicWorkflowEvent[] = [];
  const nextSeq = (runId: string): number =>
    events.filter((e) => e.runId === runId).reduce((m, e) => (e.seq > m ? e.seq : m), 0) + 1;
  const cap: Captured = {
    submit: vi.fn(),
    createDedicatedSession: vi.fn((runId: string) => {
      createdSeq += 1;
      return `dedicated-${runId}-${createdSeq}`;
    }),
    linkSession: vi.fn(),
    getRun: vi.fn(() => run),
    mintCapability: vi.fn(),
    getDefinition: vi.fn(() => boot?.definition ?? null),
    listBlockedRuns: vi.fn(() => boot?.blocked ?? []),
    listRuns: vi.fn(() => boot?.runs ?? []),
    pause: vi.fn(async () => undefined),
    registerReadOnlyTurn: vi.fn(),
    events,
    seed: (...evs) => {
      for (const e of evs) events.push({ ...e, seq: nextSeq(e.runId), id: events.length + 1 });
    },
    eventsOfType: (type) => events.filter((e) => e.type === type),
  };
  const deps: Partial<WorkflowIgnitionDeps> = {
    getRun: cap.getRun as WorkflowIgnitionDeps['getRun'],
    createDedicatedSession: cap.createDedicatedSession as WorkflowIgnitionDeps['createDedicatedSession'],
    linkSession: cap.linkSession as WorkflowIgnitionDeps['linkSession'],
    submit: cap.submit as unknown as WorkflowIgnitionDeps['submit'],
    mintCapability: cap.mintCapability as WorkflowIgnitionDeps['mintCapability'],
    getDefinition: cap.getDefinition as WorkflowIgnitionDeps['getDefinition'],
    listBlockedRuns: cap.listBlockedRuns as WorkflowIgnitionDeps['listBlockedRuns'],
    listRuns: cap.listRuns as WorkflowIgnitionDeps['listRuns'],
    pause: cap.pause as WorkflowIgnitionDeps['pause'],
    registerReadOnlyTurn: cap.registerReadOnlyTurn as WorkflowIgnitionDeps['registerReadOnlyTurn'],
    listEventsSince: (runId, afterSeq) =>
      events.filter((e) => e.runId === runId && e.seq > afterSeq).sort((a, b) => a.seq - b.seq),
    insertEvent: (input: DynamicWorkflowEventInsertInput) => {
      const ev: DynamicWorkflowEvent = {
        id: events.length + 1,
        runId: input.runId,
        nodeId: input.nodeId ?? null,
        phaseId: input.phaseId ?? null,
        seq: nextSeq(input.runId),
        type: input.type,
        payloadJson: input.payloadJson ?? '{}',
        createdAt: '2026-01-01T00:00:05.000Z',
      };
      events.push(ev);
      return ev;
    },
    getWindow: () => null,
  };
  return { deps, cap };
}

function makePersistingBus(deps: Partial<WorkflowIgnitionDeps>) {
  const bus = makeFakeBus();
  return {
    subscribe: bus.subscribe.bind(bus),
    publish: bus.publish.bind(bus),
    emit(e: DynamicWorkflowEvent): void {
      const persisted = deps.insertEvent!({
        runId: e.runId,
        nodeId: e.nodeId,
        phaseId: e.phaseId,
        type: e.type,
        payloadJson: e.payloadJson,
      });
      bus.publish(persisted);
    },
  };
}

function payloadOf(e: DynamicWorkflowEvent): Record<string, unknown> {
  return JSON.parse(e.payloadJson) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  seqCounter = 0;
  _resetIgnitionForTesting();
});


describe('parseOrchestratorGateBlock (filtro)', () => {
  it('aceita gate-blocked mode:orchestrator e devolve {runId, gateId}', () => {
    const out = parseOrchestratorGateBlock(gateBlocked('orchestrator', 'gate-plan-review'));
    expect(out).toEqual({ runId: 'run-1', gateId: 'gate-plan-review' });
  });

  it('rejeita mode:human sintetico (guarda: so orchestrator acorda o driver)', () => {
    expect(parseOrchestratorGateBlock(gateBlocked('human', 'gate-plan-review'))).toBeNull();
  });

  it('rejeita outro tipo de evento', () => {
    expect(parseOrchestratorGateBlock(makeEvent({ type: 'node-started' }))).toBeNull();
  });

  it('rejeita payload corrompido (JSON invalido) sem lancar', () => {
    expect(
      parseOrchestratorGateBlock(makeEvent({ type: 'gate-blocked', payloadJson: '{ nao-json' })),
    ).toBeNull();
  });

  it('rejeita gate-blocked sem gateId mesmo com mode:orchestrator', () => {
    expect(
      parseOrchestratorGateBlock(
        makeEvent({ type: 'gate-blocked', payloadJson: JSON.stringify({ mode: 'orchestrator' }) }),
      ),
    ).toBeNull();
  });
});


describe('buildIgnitionPrompt', () => {
  it('contem o runId LITERAL e instrui dynamic_workflow_inspect ANTES de agir', () => {
    const prompt = buildIgnitionPrompt('20260628_120000-abc123', 'gate-plan-review');
    expect(prompt).toContain('20260628_120000-abc123');
    expect(prompt).toContain('dynamic_workflow_inspect("20260628_120000-abc123")');
    expect(prompt).toContain('gate-plan-review');
    const inspectIdx = prompt.indexOf('dynamic_workflow_inspect');
    const approveIdx = prompt.toLowerCase().indexOf('aprov');
    expect(inspectIdx).toBeGreaterThanOrEqual(0);
    expect(inspectIdx).toBeLessThan(approveIdx);
  });
});


describe('resolveDriveSession', () => {
  it('usa run.chatSessionId quando presente (run chat-bound) sem criar sessao', () => {
    const { deps, cap } = makeDeps(makeRun({ chatSessionId: 'sess-existente' }));
    const sid = resolveDriveSession(deps as WorkflowIgnitionDeps, 'run-1');
    expect(sid).toBe('sess-existente');
    expect(cap.createDedicatedSession).not.toHaveBeenCalled();
    expect(cap.linkSession).not.toHaveBeenCalled();
  });

  it('run de menu (chatSessionId null): cria sessao dedicada e PERSISTE o vinculo', () => {
    const { deps, cap } = makeDeps(makeRun({ chatSessionId: null }));
    const sid = resolveDriveSession(deps as WorkflowIgnitionDeps, 'run-1');
    expect(sid).toBe('dedicated-run-1-1');
    expect(cap.createDedicatedSession).toHaveBeenCalledWith('run-1');
    expect(cap.linkSession).toHaveBeenCalledWith('run-1', 'dedicated-run-1-1');
  });

  it('run ausente -> null (chamador aborta; nunca cai em sessao ativa)', () => {
    const { deps } = makeDeps(null);
    expect(resolveDriveSession(deps as WorkflowIgnitionDeps, 'run-x')).toBeNull();
  });
});


describe('initWorkflowIgnitionBridge', () => {
  it('gate-blocked mode:orchestrator (run chat-bound) acorda submitMessage com a assinatura de drive', () => {
    const bus = makeFakeBus();
    const { deps, cap } = makeDeps(makeRun({ chatSessionId: 'sess-1' }));
    initWorkflowIgnitionBridge(() => null, { ...deps, bus });

    bus.publish(gateBlocked('orchestrator', 'gate-plan-review'));

    expect(cap.submit).toHaveBeenCalledTimes(1);
    const [prompt, options] = cap.submit.mock.calls[0]!;
    expect(prompt).toContain('run-1');
    expect(options).toMatchObject({
      sessionId: 'sess-1',
      origin: 'system-event',
      driveProjectId: 'run-1',
    });
    expect(typeof options.driveTurnId).toBe('string');
    expect(options.driveTurnId.length).toBeGreaterThan(0);
    expect(options.drivePhase).toBeUndefined();
  });

  it('E2.3: minta a capability para o {runId, gateId} EXATO, com expiresAt futuro, antes do submit', () => {
    const bus = makeFakeBus();
    const { deps, cap } = makeDeps(makeRun({ chatSessionId: 'sess-1' }));
    initWorkflowIgnitionBridge(() => null, { ...deps, bus });

    const before = Date.now();
    bus.publish(gateBlocked('orchestrator', 'gate-plan-review'));

    expect(cap.mintCapability).toHaveBeenCalledTimes(2);
    const minted = cap.mintCapability.mock.calls[0]![0];
    expect(minted.scope).toBe('gate');
    const wake = cap.mintCapability.mock.calls[1]![0];
    expect(wake).toMatchObject({ runId: 'run-1', scope: 'wake', maxUses: 3, driveTurnId: minted.driveTurnId });
    expect(wake.actions).toEqual(expect.arrayContaining(['intervene:rerun-node', 'abort', 'approve']));
    expect(minted.runId).toBe('run-1');
    expect(minted.gateId).toBe('gate-plan-review');
    expect(typeof minted.driveTurnId).toBe('string');
    expect(minted.expiresAt).toBeGreaterThan(before);

    const mintOrder = cap.mintCapability.mock.invocationCallOrder[0]!;
    const submitOrder = cap.submit.mock.invocationCallOrder[0]!;
    expect(mintOrder).toBeLessThan(submitOrder);
  });

  it('E2.3: mode:human sintetico NAO minta capability (guarda do filtro)', () => {
    const bus = makeFakeBus();
    const { deps, cap } = makeDeps(makeRun());
    initWorkflowIgnitionBridge(() => null, { ...deps, bus });

    bus.publish(gateBlocked('human', 'gate-plan-review'));

    expect(cap.mintCapability).not.toHaveBeenCalled();
  });

  it('mode:human sintetico NAO acorda o orquestrador (guarda do filtro)', () => {
    const bus = makeFakeBus();
    const { deps, cap } = makeDeps(makeRun());
    initWorkflowIgnitionBridge(() => null, { ...deps, bus });

    bus.publish(gateBlocked('human', 'gate-plan-review'));

    expect(cap.submit).not.toHaveBeenCalled();
  });

  it('T6: run de menu (chatSessionId null) cria/vincula sessao dedicada e a usa no submit; NAO usa getActiveChatSession', () => {
    const bus = makeFakeBus();
    const { deps, cap } = makeDeps(makeRun({ chatSessionId: null }));
    initWorkflowIgnitionBridge(() => null, { ...deps, bus });

    bus.publish(gateBlocked('orchestrator', 'gate-plan-review'));

    expect(cap.createDedicatedSession).toHaveBeenCalledWith('run-1');
    expect(cap.linkSession).toHaveBeenCalledWith('run-1', 'dedicated-run-1-1');

    expect(cap.submit).toHaveBeenCalledTimes(1);
    const [, options] = cap.submit.mock.calls[0]!;
    expect(options.sessionId).toBe('dedicated-run-1-1');
    expect(options.driveProjectId).toBe('run-1');

    expect(getActiveChatSessionMock).not.toHaveBeenCalled();
  });

  it('run ausente: NAO acorda o orquestrador (sem fallback para sessao ativa)', () => {
    const bus = makeFakeBus();
    const { deps, cap } = makeDeps(null);
    initWorkflowIgnitionBridge(() => null, { ...deps, bus });

    bus.publish(gateBlocked('orchestrator', 'gate-plan-review'));

    expect(cap.submit).not.toHaveBeenCalled();
    expect(getActiveChatSessionMock).not.toHaveBeenCalled();
  });

  it('driveTurnId e UNICO por turno (gates sucessivos nao reusam o id)', () => {
    const bus = makeFakeBus();
    const { deps, cap } = makeDeps(makeRun());
    let completeListener: ((c: { projectId: string; driveTurnId?: string }) => void) | null = null;
    initWorkflowIgnitionBridge(() => null, {
      ...deps,
      bus,
      onDriveTurnComplete: (l) => {
        completeListener = l as typeof completeListener;
        return () => undefined;
      },
    });

    bus.publish(gateBlocked('orchestrator', 'gate-plan-review'));
    const id1 = cap.submit.mock.calls[0]![1].driveTurnId;
    completeListener!({ projectId: 'run-1', driveTurnId: id1 });

    bus.publish(gateBlocked('orchestrator', 'gate-delivery'));

    expect(cap.submit).toHaveBeenCalledTimes(2);
    const id2 = cap.submit.mock.calls[1]![1].driveTurnId;
    expect(id1).not.toBe(id2);
  });

  it('E4: gate one-in-flight - 2o gate do MESMO run SEM complete e coalescido (1 submit)', () => {
    const bus = makeFakeBus();
    const { deps, cap } = makeDeps(makeRun());
    initWorkflowIgnitionBridge(() => null, { ...deps, bus }, { skipBootScan: true });

    bus.publish(gateBlocked('orchestrator', 'gate-plan-review'));
    bus.publish(gateBlocked('orchestrator', 'gate-delivery'));

    expect(cap.submit).toHaveBeenCalledTimes(1);
  });

  it('idempotente: reinit solta a assinatura anterior (sem duplo submit)', () => {
    const bus = makeFakeBus();
    const { deps, cap } = makeDeps(makeRun());
    initWorkflowIgnitionBridge(() => null, { ...deps, bus });
    initWorkflowIgnitionBridge(() => null, { ...deps, bus });

    expect(bus.unsubscribeCalls).toBe(1);
    expect(bus.listenerCount()).toBe(1);

    bus.publish(gateBlocked('orchestrator', 'gate-plan-review'));
    expect(cap.submit).toHaveBeenCalledTimes(1);
  });

  it('listener isolado: getRun que joga nao derruba o bus', () => {
    const bus = makeFakeBus();
    const { deps } = makeDeps(makeRun());
    (deps.getRun as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('boom');
    });
    initWorkflowIgnitionBridge(() => null, { ...deps, bus });

    expect(() => bus.publish(gateBlocked('orchestrator'))).not.toThrow();
  });
});


describe('isHarnessProjectId (E4 / risco 5 - disjuncao de namespace)', () => {
  it('TRUE para projectId de harness (inteiro autoincrement, so digitos)', () => {
    expect(isHarnessProjectId('1')).toBe(true);
    expect(isHarnessProjectId('42')).toBe(true);
    expect(isHarnessProjectId('1000000')).toBe(true);
  });

  it('FALSE para runId de workflow (YYYYMMDD_HHmmss-hex6) e ids nao-numericos', () => {
    expect(isHarnessProjectId('20260628_120000-abc123')).toBe(false);
    expect(isHarnessProjectId('run-1')).toBe(false); // ids de teste
    expect(isHarnessProjectId('dw-drive-run-1-xyz')).toBe(false);
    expect(isHarnessProjectId('')).toBe(false);
  });
});

describe('decideWorkflowDriveTurn (E4 - gate one-in-flight por runId)', () => {
  beforeEach(() => _resetIgnitionForTesting());

  it('fire quando NAO ha turno em voo para o run', () => {
    expect(decideWorkflowDriveTurn('20260628_120000-abc123', Date.now())).toBe('fire');
  });

  it('coalesce depois que a ponte poe um turno em voo; fire de novo apos o complete', () => {
    const bus = makeFakeBus();
    const { deps } = makeDeps(makeRun({ id: 'wf-run', chatSessionId: 'sess-x' }), undefined);
    let completeListener: ((c: { projectId: string; driveTurnId?: string; outcome?: string }) => void) | null = null;
    initWorkflowIgnitionBridge(
      () => null,
      {
        ...deps,
        bus,
        getRun: vi.fn(() => makeRun({ id: 'wf-run', chatSessionId: 'sess-x' })) as WorkflowIgnitionDeps['getRun'],
        onDriveTurnComplete: (l) => {
          completeListener = l as typeof completeListener;
          return () => undefined;
        },
      },
      { skipBootScan: true },
    );

    expect(decideWorkflowDriveTurn('wf-run', Date.now())).toBe('fire');
    bus.publish(gateBlocked('orchestrator', 'gate-plan-review', 'wf-run'));
    expect(decideWorkflowDriveTurn('wf-run', Date.now())).toBe('coalesce');
    completeListener!({ projectId: 'wf-run', driveTurnId: 'wf-run:1', outcome: 'executed' });
    expect(decideWorkflowDriveTurn('wf-run', Date.now())).toBe('fire');
  });
});

describe('T7: completion-filter (complete de pipeline NAO afeta o gate de workflow)', () => {
  beforeEach(() => _resetIgnitionForTesting());

  function makeBridgeForRun(runId: string): {
    bus: ReturnType<typeof makeFakeBus>;
    cap: ReturnType<typeof makeDeps>['cap'];
    fireComplete: (projectId: string, driveTurnId?: string) => void;
  } {
    const bus = makeFakeBus();
    const { deps, cap } = makeDeps(makeRun({ id: runId, chatSessionId: 'sess-x' }));
    let completeListener: ((c: { projectId: string; driveTurnId?: string; outcome?: string }) => void) | null = null;
    initWorkflowIgnitionBridge(
      () => null,
      {
        ...deps,
        bus,
        getRun: vi.fn(() => makeRun({ id: runId, chatSessionId: 'sess-x' })) as WorkflowIgnitionDeps['getRun'],
        onDriveTurnComplete: (l) => {
          completeListener = l as typeof completeListener;
          return () => undefined;
        },
      },
      { skipBootScan: true },
    );
    return {
      bus,
      cap,
      fireComplete: (projectId, driveTurnId) =>
        completeListener!({ projectId, driveTurnId, outcome: 'executed' }),
    };
  }

  it('complete de um projectId de PIPELINE (numerico) nao libera o gate one-in-flight do workflow', () => {
    const runId = '20260628_120000-abc123';
    const { bus, cap, fireComplete } = makeBridgeForRun(runId);

    bus.publish(gateBlocked('orchestrator', 'gate-plan-review', runId));
    expect(cap.submit).toHaveBeenCalledTimes(1);
    expect(decideWorkflowDriveTurn(runId, Date.now())).toBe('coalesce');

    fireComplete('42', '42:7');
    expect(decideWorkflowDriveTurn(runId, Date.now())).toBe('coalesce');

    bus.publish(gateBlocked('orchestrator', 'gate-delivery', runId));
    expect(cap.submit).toHaveBeenCalledTimes(1); // nada novo: o pipeline-complete nao liberou

    fireComplete(runId, `${runId}:1`);
    expect(cap.submit).toHaveBeenCalledTimes(2);
    expect(cap.submit.mock.calls[1]![1].driveTurnId).toBe(`${runId}:2`);
    expect(decideWorkflowDriveTurn(runId, Date.now())).toBe('coalesce');
    fireComplete(runId, `${runId}:2`);
    expect(decideWorkflowDriveTurn(runId, Date.now())).toBe('fire');
  });

  it('complete de OUTRO runId de workflow tambem nao libera (filtro por runId, nao so por numerico)', () => {
    const runId = '20260628_120000-abc123';
    const { bus, fireComplete } = makeBridgeForRun(runId);

    bus.publish(gateBlocked('orchestrator', 'gate-plan-review', runId));
    expect(decideWorkflowDriveTurn(runId, Date.now())).toBe('coalesce');

    fireComplete('20260628_999999-deadbe', '20260628_999999-deadbe:1');
    expect(decideWorkflowDriveTurn(runId, Date.now())).toBe('coalesce');
  });

  it('complete com driveTurnId DEFASADO (id nao bate) nao libera o gate', () => {
    const runId = '20260628_120000-abc123';
    const { bus, fireComplete } = makeBridgeForRun(runId);

    bus.publish(gateBlocked('orchestrator', 'gate-plan-review', runId));
    expect(decideWorkflowDriveTurn(runId, Date.now())).toBe('coalesce');

    fireComplete(runId, `${runId}:99`);
    expect(decideWorkflowDriveTurn(runId, Date.now())).toBe('coalesce');
  });
});


describe('parsePendingGateId (E2.4)', () => {
  it('le {type:gate, id} do inputJson e devolve o gateId', () => {
    const run = makeRun({
      inputJson: JSON.stringify({
        pendingDecision: { type: 'gate', id: 'gate-plan-review' },
      }),
    });
    expect(parsePendingGateId(run)).toBe('gate-plan-review');
  });

  it('devolve null quando a pendingDecision NAO e de gate (ex.: provider)', () => {
    const run = makeRun({
      inputJson: JSON.stringify({ pendingDecision: { type: 'provider' } }),
    });
    expect(parsePendingGateId(run)).toBeNull();
  });

  it('devolve null sem pendingDecision', () => {
    expect(parsePendingGateId(makeRun({ inputJson: '{}' }))).toBeNull();
  });

  it('inputJson corrompido nao lanca (devolve null)', () => {
    expect(parsePendingGateId(makeRun({ inputJson: '{ nao-json' }))).toBeNull();
  });

  it('gateId vazio -> null', () => {
    const run = makeRun({
      inputJson: JSON.stringify({ pendingDecision: { type: 'gate', id: '' } }),
    });
    expect(parsePendingGateId(run)).toBeNull();
  });
});

describe('resolveGateModeFromManifest (E2.4)', () => {
  it('resolve o mode pelo manifesto DAQUELE run (le o valor vigente, seja qual for)', () => {
    const def = makeDefinition({
      gates: [
        { id: 'gate-plan-review', mode: 'orchestrator' },
        { id: 'gate-legacy-human', mode: 'human' },
      ],
    });
    expect(resolveGateModeFromManifest(def, 'gate-plan-review')).toBe('orchestrator');
    expect(resolveGateModeFromManifest(def, 'gate-legacy-human')).toBe('human');
  });

  it('T8: resolve do manifesto VIGENTE quando edit_coordinator o reescreveu (nao do template)', () => {
    const rewritten = makeDefinition({
      gates: [{ id: 'gate-x', mode: 'orchestrator' }],
    });
    expect(resolveGateModeFromManifest(rewritten, 'gate-x')).toBe('orchestrator');

    const downgraded = makeDefinition({ gates: [{ id: 'gate-x', mode: 'human' }] });
    expect(resolveGateModeFromManifest(downgraded, 'gate-x')).toBe('human');
  });

  it('definition ausente -> undefined', () => {
    expect(resolveGateModeFromManifest(null, 'gate-x')).toBeUndefined();
  });

  it('gate fora do manifesto -> undefined', () => {
    expect(resolveGateModeFromManifest(makeDefinition(), 'gate-inexistente')).toBeUndefined();
  });

  it("gate SINTETICO 'cc-delivery' resolve 'orchestrator' mesmo FORA do manifesto (fix da ignicao)", () => {
    expect(resolveGateModeFromManifest(makeDefinition({ gates: [] }), 'cc-delivery')).toBe(
      'orchestrator',
    );
    expect(resolveGateModeFromManifest(null, 'cc-delivery')).toBe('orchestrator');
  });

  it('manifestJson ilegivel nao lanca (undefined)', () => {
    const def = makeDefinition();
    (def as { manifestJson: string }).manifestJson = '{ nao-json';
    expect(resolveGateModeFromManifest(def, 'gate-x')).toBeUndefined();
  });
});

describe('scanBlockedRunsForIgnition (E2.4 / T8)', () => {
  it('T8: run blocked num gate mode:orchestrator e RE-DISPARADO (submit + capability)', () => {
    const run = makeRun({
      chatSessionId: 'sess-1',
      status: 'blocked',
      inputJson: JSON.stringify({
        pendingDecision: { type: 'gate', id: 'gate-plan-review' },
      }),
    });
    const { deps, cap } = makeDeps(run, {
      definition: makeDefinition(),
      blocked: [run],
    });

    const count = scanBlockedRunsForIgnition(deps as WorkflowIgnitionDeps);

    expect(count).toBe(1);
    expect(cap.submit).toHaveBeenCalledTimes(1);
    const [prompt, options] = cap.submit.mock.calls[0]!;
    expect(prompt).toContain('run-1');
    expect(options).toMatchObject({
      sessionId: 'sess-1',
      origin: 'system-event',
      driveProjectId: 'run-1',
    });
    expect(options.drivePhase).toBeUndefined();
    expect(cap.mintCapability).toHaveBeenCalledTimes(2);
    expect(cap.mintCapability.mock.calls[0]![0]).toMatchObject({
      runId: 'run-1',
      gateId: 'gate-plan-review',
    });
  });

  it("boot-scan REACORDA run bloqueado no gate SINTETICO 'cc-delivery' (gates:[] no manifesto derivado)", () => {
    const run = makeRun({
      chatSessionId: 'sess-1',
      status: 'blocked',
      inputJson: JSON.stringify({ pendingDecision: { type: 'gate', id: 'cc-delivery' } }),
    });
    const derived = makeDefinition({ gates: [] });
    const { deps, cap } = makeDeps(run, { definition: derived, blocked: [run] });

    const count = scanBlockedRunsForIgnition(deps as WorkflowIgnitionDeps);

    expect(count).toBe(1);
    expect(cap.submit).toHaveBeenCalledTimes(1);
    const [prompt] = cap.submit.mock.calls[0]!;
    expect(prompt).toContain('cc-delivery');
    expect(cap.mintCapability.mock.calls[0]![0]).toMatchObject({
      runId: 'run-1',
      gateId: 'cc-delivery',
    });
  });

  it('T8: mode derivado do manifesto DAQUELE run mesmo quando edit_coordinator alterou (resolve do vigente)', () => {
    const run = makeRun({
      chatSessionId: 'sess-1',
      status: 'blocked',
      inputJson: JSON.stringify({ pendingDecision: { type: 'gate', id: 'gate-x' } }),
    });
    const rewritten = makeDefinition({ gates: [{ id: 'gate-x', mode: 'orchestrator' }] });
    const { deps, cap } = makeDeps(run, { definition: rewritten, blocked: [run] });

    const count = scanBlockedRunsForIgnition(deps as WorkflowIgnitionDeps);

    expect(count).toBe(1);
    expect(cap.getDefinition).toHaveBeenCalledWith('def-1');
    expect(cap.submit).toHaveBeenCalledTimes(1);
    expect(cap.mintCapability.mock.calls[0]![0].gateId).toBe('gate-x');
  });

  it('T8 (guarda): run blocked num gate mode:human sintetico NAO e re-disparado', () => {
    const run = makeRun({
      status: 'blocked',
      inputJson: JSON.stringify({
        pendingDecision: { type: 'gate', id: 'gate-legacy-human' },
      }),
    });
    const humanDef = makeDefinition({ gates: [{ id: 'gate-legacy-human', mode: 'human' }] });
    const { deps, cap } = makeDeps(run, { definition: humanDef, blocked: [run] });

    expect(scanBlockedRunsForIgnition(deps as WorkflowIgnitionDeps)).toBe(0);
    expect(cap.submit).not.toHaveBeenCalled();
    expect(cap.mintCapability).not.toHaveBeenCalled();
  });

  it('run blocked SEM gate pendente (provider-limit) e pulado', () => {
    const run = makeRun({
      status: 'blocked',
      inputJson: JSON.stringify({ pendingDecision: { type: 'provider' } }),
    });
    const { deps, cap } = makeDeps(run, { definition: makeDefinition(), blocked: [run] });

    expect(scanBlockedRunsForIgnition(deps as WorkflowIgnitionDeps)).toBe(0);
    expect(cap.submit).not.toHaveBeenCalled();
    expect(cap.getDefinition).not.toHaveBeenCalled();
  });

  it('mistura: so os runs de gate orchestrator sao re-disparados', () => {
    const orchRun = makeRun({
      id: 'run-orch',
      chatSessionId: 'sess-o',
      status: 'blocked',
      inputJson: JSON.stringify({
        pendingDecision: { type: 'gate', id: 'gate-plan-review' },
      }),
    });
    const humanRun = makeRun({
      id: 'run-human',
      chatSessionId: 'sess-h',
      status: 'blocked',
      inputJson: JSON.stringify({
        pendingDecision: { type: 'gate', id: 'gate-legacy-human' },
      }),
    });
    const providerRun = makeRun({
      id: 'run-prov',
      status: 'blocked',
      inputJson: JSON.stringify({ pendingDecision: { type: 'provider' } }),
    });
    const mixedDef = makeDefinition({
      gates: [
        { id: 'gate-plan-review', mode: 'orchestrator' },
        { id: 'gate-legacy-human', mode: 'human' },
      ],
    });
    const { deps, cap } = makeDeps(null, {
      definition: mixedDef,
      blocked: [orchRun, humanRun, providerRun],
    });
    (cap.getRun as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'run-orch' ? orchRun : id === 'run-human' ? humanRun : providerRun,
    );

    const count = scanBlockedRunsForIgnition(deps as WorkflowIgnitionDeps);

    expect(count).toBe(1);
    expect(cap.submit).toHaveBeenCalledTimes(1);
    expect(cap.submit.mock.calls[0]![1].driveProjectId).toBe('run-orch');
  });

  it('isolamento: um run cujo submit joga nao aborta os demais (catch por run)', () => {
    const bad = makeRun({
      id: 'run-bad',
      chatSessionId: 'sess-b',
      status: 'blocked',
      inputJson: JSON.stringify({
        pendingDecision: { type: 'gate', id: 'gate-plan-review' },
      }),
    });
    const good = makeRun({
      id: 'run-good',
      chatSessionId: 'sess-g',
      status: 'blocked',
      inputJson: JSON.stringify({
        pendingDecision: { type: 'gate', id: 'gate-plan-review' },
      }),
    });
    const { deps, cap } = makeDeps(null, {
      definition: makeDefinition(),
      blocked: [bad, good],
    });
    (cap.getRun as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'run-good' ? good : bad,
    );
    (cap.submit as ReturnType<typeof vi.fn>).mockImplementation(
      (_p: string, opts: { driveProjectId: string }) => {
        if (opts.driveProjectId === 'run-bad') throw new Error('boom');
      },
    );

    const count = scanBlockedRunsForIgnition(deps as WorkflowIgnitionDeps);

    expect(count).toBe(1);
    expect(cap.submit).toHaveBeenCalledTimes(2); // tentou os dois; o bad jogou
    expect(cap.submit.mock.calls.map((c) => c[1].driveProjectId)).toEqual([
      'run-bad',
      'run-good',
    ]);
  });

  it('listBlockedRuns que joga nao derruba o boot (varredura pulada, retorna 0)', () => {
    const { deps, cap } = makeDeps(makeRun());
    (cap.listBlockedRuns as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('db down');
    });
    expect(() => scanBlockedRunsForIgnition(deps as WorkflowIgnitionDeps)).not.toThrow();
    expect(scanBlockedRunsForIgnition(deps as WorkflowIgnitionDeps)).toBe(0);
    expect(cap.submit).not.toHaveBeenCalled();
  });
});

describe('initWorkflowIgnitionBridge: boot re-ignition wiring (E2.4 / T8)', () => {
  it('roda a varredura no init e re-dispara o run blocked orchestrator', () => {
    const bus = makeFakeBus();
    const run = makeRun({
      chatSessionId: 'sess-1',
      status: 'blocked',
      inputJson: JSON.stringify({
        pendingDecision: { type: 'gate', id: 'gate-plan-review' },
      }),
    });
    const { deps, cap } = makeDeps(run, { definition: makeDefinition(), blocked: [run] });

    initWorkflowIgnitionBridge(() => null, { ...deps, bus });

    expect(cap.listBlockedRuns).toHaveBeenCalledTimes(1);
    expect(cap.submit).toHaveBeenCalledTimes(1);
    expect(cap.submit.mock.calls[0]![1].driveProjectId).toBe('run-1');
  });

  it('skipBootScan: NAO roda a varredura (so o caminho de evento fica ativo)', () => {
    const bus = makeFakeBus();
    const run = makeRun({
      status: 'blocked',
      inputJson: JSON.stringify({
        pendingDecision: { type: 'gate', id: 'gate-plan-review' },
      }),
    });
    const { deps, cap } = makeDeps(run, { definition: makeDefinition(), blocked: [run] });

    initWorkflowIgnitionBridge(() => null, { ...deps, bus }, { skipBootScan: true });

    expect(cap.listBlockedRuns).not.toHaveBeenCalled();
    expect(cap.submit).not.toHaveBeenCalled();
  });
});


function runningRun(patch?: Partial<DynamicWorkflowRun>): DynamicWorkflowRun {
  return makeRun({ status: 'running', chatSessionId: 'sess-1', inputJson: '{}', ...patch });
}

function bridgeFor(
  run: DynamicWorkflowRun | null,
  boot?: Parameters<typeof makeDeps>[1],
): {
  deps: Partial<WorkflowIgnitionDeps>;
  cap: Captured;
  bus: ReturnType<typeof makePersistingBus>;
  complete: (driveTurnId: string, outcome?: 'executed' | 'discarded' | 'failed-before-execution') => void;
} {
  const { deps, cap } = makeDeps(run, boot);
  const bus = makePersistingBus(deps);
  let completeListener: ((c: { projectId: string; driveTurnId?: string; outcome?: string }) => void) | null = null;
  initWorkflowIgnitionBridge(
    () => null,
    {
      ...deps,
      bus,
      onDriveTurnComplete: (l) => {
        completeListener = l as typeof completeListener;
        return () => undefined;
      },
    },
    { skipBootScan: true },
  );
  return {
    deps,
    cap,
    bus,
    complete: (driveTurnId, outcome) => completeListener!({ projectId: run?.id ?? 'run-1', driveTurnId, outcome }),
  };
}

describe('parseWakeSignal (D1/D3)', () => {
  it('classifica por tipo: terminais acordam, precursores/verdes nao', () => {
    expect(parseWakeSignal(makeEvent({ type: 'run-blocked-provider', nodeId: 'c1', payloadJson: JSON.stringify({ failureClass: 'logic' }) }))).toEqual({ reason: 'needs-decision', nodeId: 'c1' });
    expect(parseWakeSignal(makeEvent({ type: 'node-stalled', nodeId: 'c1' }))).toBeNull();
    expect(parseWakeSignal(makeEvent({ type: 'run-blocked-provider', nodeId: 'c1', payloadJson: JSON.stringify({ failureClass: 'logic', gateId: 'failure:c1' }) }))).toBeNull();
    expect(parseWakeSignal(gateBlocked('orchestrator', 'failure:c1'))).toEqual({ reason: 'blocked', gateId: 'failure:c1' });
    expect(parseWakeSignal(makeEvent({ type: 'run-failed' }))!.reason).toBe('needs-decision');
    expect(parseWakeSignal(gateBlocked('orchestrator', 'boundary:S2'))).toEqual({ reason: 'blocked', gateId: 'boundary:S2' });
    expect(parseWakeSignal(gateBlocked('human'))).toBeNull();
    expect(parseWakeSignal(makeEvent({ type: 'wake-runaway' }))).toEqual({ reason: 'needs-human' });
    expect(parseWakeSignal(makeEvent({ type: 'phase-changed' }))).toEqual({ reason: 'boundary' });
    expect(parseWakeSignal(makeEvent({ type: 'coordinator-finished' }))).toEqual({ reason: 'boundary' });
    for (const t of ['node-failed', 'sandbox-killed', 'node-completed', 'node-retry-scheduled', 'green-check', 'run-delivered', 'run-finished', 'node-started']) {
      expect(parseWakeSignal(makeEvent({ type: t }))).toBeNull();
    }
  });

  it("alias parseOrchestratorGateBlock intacto e resolveGateModeFromManifest reconhece 'boundary:*' como orchestrator", () => {
    expect(parseOrchestratorGateBlock(gateBlocked('orchestrator', 'boundary:S2'))).toEqual({ runId: 'run-1', gateId: 'boundary:S2' });
    expect(resolveGateModeFromManifest(null, 'boundary:S2')).toBe('orchestrator');
    expect(resolveGateModeFromManifest(makeDefinition({ gates: [] }), 'boundary:coordinator-finished')).toBe('orchestrator');
  });
});

describe('wake por desfecho (D1/D3): cadeias terminais geram UM wake', () => {
  it('node-failed(logic) -> run-blocked-provider = UM wake needs-decision com classe/erro reais no digest', () => {
    const { cap, bus } = bridgeFor(runningRun());
    bus.emit(makeEvent({ type: 'node-completed', nodeId: 'scout', payloadJson: JSON.stringify({ agentId: 'scout', access: 'read-only', costUsd: 0.1 }) }));
    bus.emit(makeEvent({ type: 'node-completed', nodeId: 'planner', payloadJson: JSON.stringify({ agentId: 'planner', access: 'read-only', costUsd: 0.2 }) }));
    bus.emit(makeEvent({ type: 'node-failed', nodeId: 'coder', payloadJson: JSON.stringify({ failureClass: 'logic', error: 'agentType inexistente', attempt: 1 }) }));
    expect(cap.submit).not.toHaveBeenCalled(); // precursor NAO acorda
    bus.emit(makeEvent({ type: 'run-blocked-provider', nodeId: 'coder', payloadJson: JSON.stringify({ failureClass: 'logic', retriesExhausted: false, attemptsMade: 1, nodeError: 'agentType inexistente' }) }));

    expect(cap.submit).toHaveBeenCalledTimes(1);
    const [prompt, options] = cap.submit.mock.calls[0]!;
    expect(options.driveProjectId).toBe('run-1');
    expect(prompt).toContain('SEMAFORO: DECISAO NECESSARIA');
    expect(prompt).toContain('dynamic_workflow_inspect("run-1")');
    expect(prompt).toContain('classe=logic');
    expect(prompt).toContain('agentType inexistente');
    expect(prompt).toContain('3 node(s)');
    expect(prompt).toContain('1 falha(s)');
    expect(cap.mintCapability).toHaveBeenCalledTimes(1);
    expect(cap.mintCapability.mock.calls[0]![0]).toMatchObject({ runId: 'run-1', scope: 'wake', maxUses: 3 });
    expect(cap.mintCapability.mock.calls[0]![0].gateId).toBeUndefined();
    const planned = cap.eventsOfType('wake-planned');
    expect(planned).toHaveLength(1);
    expect(payloadOf(planned[0]!)).toMatchObject({ reason: 'needs-decision', fromSeq: 0, throughSeq: 4, driveTurnId: options.driveTurnId, readOnly: false });
  });

  it('sandbox-killed -> run-failed = UM wake (precursor no digest, run-failed acorda)', () => {
    const { cap, bus } = bridgeFor(runningRun());
    bus.emit(makeEvent({ type: 'node-completed', nodeId: 'coder', payloadJson: JSON.stringify({ access: 'workspace-write' }) }));
    bus.emit(makeEvent({ type: 'sandbox-killed', payloadJson: JSON.stringify({ reason: 'wall-timeout' }) }));
    expect(cap.submit).not.toHaveBeenCalled();
    bus.emit(makeEvent({ type: 'run-failed', payloadJson: JSON.stringify({ error: 'execucao falhou (wall-timeout)' }) }));
    expect(cap.submit).toHaveBeenCalledTimes(1);
    const [prompt] = cap.submit.mock.calls[0]!;
    expect(prompt).toContain('wall-timeout');
    expect(prompt).toContain('SEMAFORO: DECISAO NECESSARIA');
  });

  it('L1.1: node-stalled -> node-failed(timeout) -> run-blocked-provider{gateId} -> gate-blocked failure:* = UM wake blocked com classe/erro e as 4 acoes no prompt', () => {
    const { cap, bus } = bridgeFor(runningRun());
    bus.emit(makeEvent({ type: 'node-stalled', nodeId: 'coder', payloadJson: JSON.stringify({ message: 'sem progresso ha 3min' }) }));
    bus.emit(makeEvent({ type: 'node-failed', nodeId: 'coder', payloadJson: JSON.stringify({ failureClass: 'timeout', error: 'node abortado pelo watchdog de stall', attempt: 1, stalled: true }) }));
    bus.emit(makeEvent({ type: 'run-blocked-provider', nodeId: 'coder', payloadJson: JSON.stringify({ failureClass: 'timeout', retriesExhausted: true, attemptsMade: 3, nodeError: 'node abortado pelo watchdog de stall', gateId: 'failure:coder' }) }));
    expect(cap.submit).toHaveBeenCalledTimes(0);
    bus.emit(makeEvent({ type: 'gate-blocked', nodeId: 'coder', payloadJson: JSON.stringify({ gateId: 'failure:coder', mode: 'orchestrator', failure: true, failureClass: 'timeout', error: 'node abortado pelo watchdog de stall', actions: ['retry', 'switch-agent', 'skip', 'abort'] }) }));
    expect(cap.submit).toHaveBeenCalledTimes(1);
    const prompt = cap.submit.mock.calls[0]![0] as string;
    expect(prompt).toContain('failure:coder');
    expect(prompt).toContain('classe=timeout');
    expect(prompt).toContain('watchdog de stall');
    expect(prompt).toContain('"retry"');
    expect(prompt).toContain('"switch-agent"');
    expect(prompt).toContain('"skip"');
    expect(prompt).toContain('"abort"');
    expect(prompt).toContain('dynamic_workflow_approve(');
  });

  it('phase-changed com janela vazia, run-delivered e run-finished NAO acordam', () => {
    vi.useFakeTimers();
    try {
      const { cap, bus } = bridgeFor(runningRun());
      bus.emit(makeEvent({ type: 'phase-changed', phaseId: 'S1', payloadJson: JSON.stringify({ phase: 'S1' }) }));
      bus.emit(makeEvent({ type: 'run-delivered' }));
      bus.emit(makeEvent({ type: 'run-finished' }));
      vi.advanceTimersByTime(WAKE_BOUNDARY_DEBOUNCE_MS * 2);
      expect(cap.submit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fronteira VERDE (since.nodes > 0) acorda apos debounce de 3 s com SEMAFORO: VERDE + 'ok, seguindo' e SEM inspect", () => {
    vi.useFakeTimers();
    try {
      const { cap, bus } = bridgeFor(runningRun());
      bus.emit(makeEvent({ type: 'phase-changed', phaseId: 'S1', payloadJson: JSON.stringify({ phase: 'S1' }) }));
      bus.emit(makeEvent({ type: 'node-completed', nodeId: 'v1', payloadJson: JSON.stringify({ access: 'read-only', validatorVerdict: { verdict: 'pass', findingsTotal: 0, blockers: 0 }, p1Count: 0, findings: [] }) }));
      bus.emit(makeEvent({ type: 'phase-changed', phaseId: 'S2', payloadJson: JSON.stringify({ phase: 'S2' }) }));
      expect(cap.submit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(WAKE_BOUNDARY_DEBOUNCE_MS - 1);
      expect(cap.submit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(cap.submit).toHaveBeenCalledTimes(1);
      const [prompt] = cap.submit.mock.calls[0]!;
      expect(prompt).toContain('SEMAFORO: VERDE');
      expect(prompt).toContain("responda 'ok, seguindo'. Nao chame tools.");
      expect(prompt).not.toContain('dynamic_workflow_inspect');
      expect(cap.mintCapability).toHaveBeenCalledTimes(1);
      expect(cap.mintCapability.mock.calls[0]![0]).toMatchObject({ runId: 'run-1', scope: 'wake' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fronteira NAO-verde (P1 aberto) NAO acorda pela ignicao; o gate-blocked boundary:* do host acorda com ATENCAO', () => {
    vi.useFakeTimers();
    try {
      const { cap, bus } = bridgeFor(runningRun());
      bus.emit(makeEvent({ type: 'phase-changed', phaseId: 'S1' }));
      bus.emit(makeEvent({
        type: 'node-completed',
        nodeId: 'v1',
        payloadJson: JSON.stringify({ access: 'read-only', validatorVerdict: { verdict: 'fail', findingsTotal: 1, blockers: 1 }, p1Count: 1, findings: [{ severity: 'P1', where: 'a.ts:1', problem: 'x' }] }),
      }));
      bus.emit(makeEvent({ type: 'phase-changed', phaseId: 'S2' }));
      vi.advanceTimersByTime(WAKE_BOUNDARY_DEBOUNCE_MS * 2);
      expect(cap.submit).not.toHaveBeenCalled();
      bus.emit(makeEvent({
        type: 'gate-blocked',
        payloadJson: JSON.stringify({ gateId: 'boundary:S2', mode: 'orchestrator', boundary: 'S2', semaphore: 'ATENCAO', reasons: ['1 P1 aberto(s) no ledger'] }),
      }));
      expect(cap.submit).toHaveBeenCalledTimes(1);
      const [prompt] = cap.submit.mock.calls[0]!;
      expect(prompt).toContain('boundary:S2');
      expect(prompt).toContain('SEMAFORO: ATENCAO');
      expect(prompt).toContain('dynamic_workflow_inspect("run-1")');
      expect(cap.mintCapability).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', gateId: 'boundary:S2' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('needs-decision FURA o debounce de fronteira (dispara ja, com o motivo mais severo)', () => {
    vi.useFakeTimers();
    try {
      const { cap, bus } = bridgeFor(runningRun());
      bus.emit(makeEvent({ type: 'node-completed', nodeId: 'n1', payloadJson: JSON.stringify({ access: 'read-only' }) }));
      bus.emit(makeEvent({ type: 'phase-changed', phaseId: 'S2' }));
      expect(cap.submit).not.toHaveBeenCalled();
      bus.emit(makeEvent({ type: 'run-failed', payloadJson: JSON.stringify({ error: 'boom' }) }));
      expect(cap.submit).toHaveBeenCalledTimes(1);
      expect(payloadOf(cap.eventsOfType('wake-planned')[0]!).reason).toBe('needs-decision');
      vi.advanceTimersByTime(WAKE_BOUNDARY_DEBOUNCE_MS * 2);
      expect(cap.submit).toHaveBeenCalledTimes(1); // o timer foi cancelado
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('coalescencia real + lifecycle duravel (D5)', () => {
  it('2 desfechos em voo => 1 submit durante o voo (pendingWake) e 1 wake no complete executed; wake-completed reconhece o throughSeq', () => {
    const { cap, bus, complete } = bridgeFor(runningRun());
    bus.emit(gateBlocked('orchestrator', 'gate-plan-review'));
    expect(cap.submit).toHaveBeenCalledTimes(1);
    const turn1 = cap.submit.mock.calls[0]![1].driveTurnId as string;

    bus.emit(makeEvent({ type: 'run-blocked-provider', nodeId: 'coder', payloadJson: JSON.stringify({ failureClass: 'logic' }) }));
    expect(cap.submit).toHaveBeenCalledTimes(1);
    expect(_pendingWakeForTesting('run-1')).toEqual({ reason: 'needs-decision', nodeId: 'coder' });

    complete(turn1, 'executed');
    const completed = cap.eventsOfType('wake-completed');
    expect(completed).toHaveLength(1);
    expect(payloadOf(completed[0]!)).toEqual({ driveTurnId: turn1, outcome: 'executed' });

    expect(cap.submit).toHaveBeenCalledTimes(2);
    expect(_pendingWakeForTesting('run-1')).toBeNull();
    const planned = cap.eventsOfType('wake-planned');
    expect(planned).toHaveLength(2);
    const p2 = payloadOf(planned[1]!);
    expect(p2.reason).toBe('needs-decision');
    expect(p2.fromSeq).toBe(completed[0]!.seq);
    expect(cap.submit.mock.calls[1]![1].driveTurnId).not.toBe(turn1);
  });

  it("complete 'discarded' NAO reconhece (wake-completed com outcome discarded) e REARMA o wake pelo debounce de 3 s", () => {
    vi.useFakeTimers();
    try {
      const { cap, bus, complete } = bridgeFor(runningRun());
      bus.emit(gateBlocked('orchestrator', 'cc-delivery'));
      expect(cap.submit).toHaveBeenCalledTimes(1);
      const turn1 = cap.submit.mock.calls[0]![1].driveTurnId as string;
      const plannedBefore = payloadOf(cap.eventsOfType('wake-planned')[0]!);

      complete(turn1, 'discarded');
      const completed = cap.eventsOfType('wake-completed');
      expect(payloadOf(completed[0]!)).toEqual({ driveTurnId: turn1, outcome: 'discarded' });

      expect(cap.submit).toHaveBeenCalledTimes(1);
      expect(_pendingWakeForTesting('run-1')).toEqual({ reason: 'blocked', gateId: 'cc-delivery' });
      vi.advanceTimersByTime(WAKE_BOUNDARY_DEBOUNCE_MS - 1);
      expect(cap.submit).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);

      expect(cap.submit).toHaveBeenCalledTimes(2);
      const planned2 = payloadOf(cap.eventsOfType('wake-planned')[1]!);
      expect(planned2.reason).toBe('blocked');
      expect(planned2.gateId).toBe('cc-delivery');
      expect(planned2.fromSeq).toBe(plannedBefore.fromSeq);
      expect(cap.mintCapability).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("complete 'failed-before-execution' tambem rearma (pelo debounce)", () => {
    vi.useFakeTimers();
    try {
      const { cap, bus, complete } = bridgeFor(runningRun());
      bus.emit(makeEvent({ type: 'run-failed' }));
      const turn1 = cap.submit.mock.calls[0]![1].driveTurnId as string;
      complete(turn1, 'failed-before-execution');
      expect(cap.submit).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(WAKE_BOUNDARY_DEBOUNCE_MS);
      expect(cap.submit).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("complete SEM outcome (chamador legado) e fail-closed: grava 'failed-before-execution' e rearma (nao reconhece)", () => {
    vi.useFakeTimers();
    try {
      const { cap, bus, complete } = bridgeFor(runningRun());
      bus.emit(makeEvent({ type: 'run-failed' }));
      const turn1 = cap.submit.mock.calls[0]![1].driveTurnId as string;
      complete(turn1, undefined);
      expect(payloadOf(cap.eventsOfType('wake-completed')[0]!)).toEqual({ driveTurnId: turn1, outcome: 'failed-before-execution' });
      expect(decideWorkflowDriveTurn('run-1', Date.now())).toBe('fire');
      vi.advanceTimersByTime(WAKE_BOUNDARY_DEBOUNCE_MS);
      expect(cap.submit).toHaveBeenCalledTimes(2);
      expect(payloadOf(cap.eventsOfType('wake-planned')[1]!).fromSeq).toBe(payloadOf(cap.eventsOfType('wake-planned')[0]!).fromSeq);
    } finally {
      vi.useRealTimers();
    }
  });

  it('3 descartes seguidos NAO formam laco quente: no maximo 1 submit por janela de debounce e wakesSinceProgress cresce', () => {
    vi.useFakeTimers();
    try {
      const { cap, bus, complete } = bridgeFor(runningRun());
      bus.emit(gateBlocked('orchestrator', 'cc-delivery'));
      expect(cap.submit).toHaveBeenCalledTimes(1);
      expect(_wakeCountersForTesting('run-1').wakesSinceProgress).toBe(1);
      for (let i = 1; i <= 3; i++) {
        const turn = cap.submit.mock.calls[cap.submit.mock.calls.length - 1]![1].driveTurnId as string;
        complete(turn, 'discarded');
        vi.advanceTimersByTime(WAKE_BOUNDARY_DEBOUNCE_MS / 2);
        expect(cap.submit).toHaveBeenCalledTimes(i);
        vi.advanceTimersByTime(WAKE_BOUNDARY_DEBOUNCE_MS / 2);
        expect(cap.submit).toHaveBeenCalledTimes(i + 1);
        expect(_wakeCountersForTesting('run-1').wakesSinceProgress).toBe(i + 1);
      }
      expect(cap.eventsOfType('wake-planned')).toHaveLength(4);
      expect(cap.pause).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('apos runaway, turno descartado NAO rearma automaticamente (fica para boot-scan/proximo evento)', () => {
    vi.useFakeTimers();
    try {
      const { cap, bus, complete } = bridgeFor(runningRun());
      for (let i = 0; i < 7; i++) {
        bus.emit(gateBlocked('orchestrator', `gate-${i}`));
        if (i < 6) complete(cap.submit.mock.calls[i]![1].driveTurnId as string, 'executed');
      }
      expect(cap.eventsOfType('wake-runaway')).toHaveLength(1);
      expect(cap.submit).toHaveBeenCalledTimes(7);
      complete(cap.submit.mock.calls[6]![1].driveTurnId as string, 'discarded');
      vi.advanceTimersByTime(WAKE_BOUNDARY_DEBOUNCE_MS * 3);
      expect(cap.submit).toHaveBeenCalledTimes(7);
      expect(_pendingWakeForTesting('run-1')).toEqual({ reason: 'needs-human' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('complete defasado (driveTurnId antigo) nao grava wake-completed nem libera', () => {
    const { cap, bus, complete } = bridgeFor(runningRun());
    bus.emit(gateBlocked('orchestrator', 'gate-plan-review'));
    complete('run-1:99', 'executed');
    expect(cap.eventsOfType('wake-completed')).toHaveLength(0);
    expect(decideWorkflowDriveTurn('run-1', Date.now())).toBe('coalesce');
  });
});

describe('boot-scan generalizado (D5)', () => {
  it("wake-planned sem ACK 'executed' e re-disparado mesmo em run completed (fecha o ciclo)", () => {
    const run = makeRun({ id: 'run-done', status: 'completed', chatSessionId: 'sess-d' });
    const { deps, cap } = makeDeps(run, { runs: [run], blocked: [] });
    cap.seed(
      makeEvent({ runId: 'run-done', type: 'node-completed', nodeId: 'n1' }),
      makeEvent({ runId: 'run-done', type: 'coordinator-finished' }),
      makeEvent({ runId: 'run-done', type: 'wake-planned', payloadJson: JSON.stringify({ reason: 'boundary', fromSeq: 0, throughSeq: 2, driveTurnId: 'run-done:1' }) }),
      makeEvent({ runId: 'run-done', type: 'wake-completed', payloadJson: JSON.stringify({ driveTurnId: 'run-done:1', outcome: 'discarded' }) }),
    );
    expect(findUnacknowledgedWake(cap.events)).toEqual({ reason: 'boundary' });
    const count = scanBlockedRunsForIgnition(deps as WorkflowIgnitionDeps);
    expect(count).toBe(1);
    expect(cap.submit).toHaveBeenCalledTimes(1);
    expect(cap.submit.mock.calls[0]![1].driveProjectId).toBe('run-done');
  });

  it("wake-planned COM ACK 'executed' nao re-dispara; run completed sem pendencia = 0", () => {
    const run = makeRun({ id: 'run-done', status: 'completed', chatSessionId: 'sess-d' });
    const { deps, cap } = makeDeps(run, { runs: [run] });
    cap.seed(
      makeEvent({ runId: 'run-done', type: 'node-completed', nodeId: 'n1' }),
      makeEvent({ runId: 'run-done', type: 'wake-planned', payloadJson: JSON.stringify({ reason: 'boundary', fromSeq: 0, throughSeq: 1, driveTurnId: 'run-done:1' }) }),
      makeEvent({ runId: 'run-done', type: 'wake-completed', payloadJson: JSON.stringify({ driveTurnId: 'run-done:1', outcome: 'executed' }) }),
    );
    expect(scanBlockedRunsForIgnition(deps as WorkflowIgnitionDeps)).toBe(0);
    expect(cap.submit).not.toHaveBeenCalled();
  });

  it('boot com run-failed NAO reconhecido acorda (needs-decision)', () => {
    const run = makeRun({ id: 'run-f', status: 'failed', chatSessionId: 'sess-f', error: 'boom' });
    const { deps, cap } = makeDeps(run, { runs: [run] });
    cap.seed(
      makeEvent({ runId: 'run-f', type: 'node-completed', nodeId: 'n1' }),
      makeEvent({ runId: 'run-f', type: 'sandbox-killed', payloadJson: JSON.stringify({ reason: 'idle-timeout' }) }),
      makeEvent({ runId: 'run-f', type: 'run-failed', payloadJson: JSON.stringify({ error: 'boom' }) }),
    );
    expect(scanBlockedRunsForIgnition(deps as WorkflowIgnitionDeps)).toBe(1);
    expect(cap.submit).toHaveBeenCalledTimes(1);
    expect(cap.submit.mock.calls[0]![0]).toContain('SEMAFORO: DECISAO NECESSARIA');
    expect(payloadOf(cap.eventsOfType('wake-planned')[0]!).reason).toBe('needs-decision');
  });

  it('boot com fronteira VERDE nao reconhecida (phase-changed apos nodes, sem wake) acorda como boundary', () => {
    const run = makeRun({ id: 'run-b', status: 'running', chatSessionId: 'sess-b' });
    const { deps, cap } = makeDeps(run, { runs: [run] });
    cap.seed(
      makeEvent({ runId: 'run-b', type: 'node-completed', nodeId: 'n1', payloadJson: JSON.stringify({ access: 'read-only' }) }),
      makeEvent({ runId: 'run-b', type: 'phase-changed', phaseId: 'S2' }),
    );
    expect(scanBlockedRunsForIgnition(deps as WorkflowIgnitionDeps)).toBe(1);
    expect(cap.submit.mock.calls[0]![0]).toContain('SEMAFORO: VERDE');
  });

  it("boot re-disparando 'wake-planned needs-human' sem ACK e READ-ONLY: lease so inspect, sem capability, sem novo pause/wake-runaway; regime dura ate resume-requested", () => {
    const run = makeRun({ id: 'run-h', status: 'paused', chatSessionId: 'sess-h' });
    const { deps, cap, bus, complete } = bridgeFor(run, { runs: [run] });
    cap.seed(
      makeEvent({ runId: 'run-h', type: 'gate-blocked', payloadJson: JSON.stringify({ gateId: 'gate-7', mode: 'orchestrator' }) }),
      makeEvent({ runId: 'run-h', type: 'wake-runaway', payloadJson: JSON.stringify({ wakesTotal: 7, wakesSinceProgress: 7, reason: 'max-wakes-sem-progresso' }) }),
      makeEvent({ runId: 'run-h', type: 'wake-planned', payloadJson: JSON.stringify({ reason: 'needs-human', fromSeq: 0, throughSeq: 2, driveTurnId: 'run-h:1', readOnly: true }) }),
    );
    expect(findUnacknowledgedWake(cap.events)).toEqual({ reason: 'needs-human' });
    expect(scanBlockedRunsForIgnition(deps as WorkflowIgnitionDeps)).toBe(1);
    expect(cap.submit).toHaveBeenCalledTimes(1);
    const [prompt, options] = cap.submit.mock.calls[0]!;
    expect(prompt).toContain('SEMAFORO: DECISAO HUMANA');
    expect(prompt).toContain('So `dynamic_workflow_inspect` esta disponivel');
    expect(cap.registerReadOnlyTurn).toHaveBeenCalledWith(options.driveTurnId);
    expect(cap.mintCapability).not.toHaveBeenCalled();
    expect(payloadOf(cap.eventsOfType('wake-planned')[1]!)).toMatchObject({ reason: 'needs-human', readOnly: true });
    expect(cap.pause).not.toHaveBeenCalled();
    expect(cap.eventsOfType('wake-runaway')).toHaveLength(1);

    complete(options.driveTurnId as string, 'executed');
    bus.emit(makeEvent({ runId: 'run-h', type: 'gate-blocked', payloadJson: JSON.stringify({ gateId: 'gate-8', mode: 'orchestrator' }) }));
    expect(cap.submit).toHaveBeenCalledTimes(2);
    const [prompt2, options2] = cap.submit.mock.calls[1]!;
    expect(prompt2).toContain('SEMAFORO: DECISAO HUMANA');
    expect(cap.registerReadOnlyTurn).toHaveBeenCalledWith(options2.driveTurnId);
    expect(cap.mintCapability).not.toHaveBeenCalled();

    complete(options2.driveTurnId as string, 'executed');
    bus.emit(makeEvent({ runId: 'run-h', type: 'resume-requested' }));
    bus.emit(makeEvent({ runId: 'run-h', type: 'gate-blocked', payloadJson: JSON.stringify({ gateId: 'gate-9', mode: 'orchestrator' }) }));
    expect(cap.submit).toHaveBeenCalledTimes(3);
    expect(cap.submit.mock.calls[2]![0]).toContain('gate-9');
    expect(cap.submit.mock.calls[2]![0]).not.toContain('DECISAO HUMANA');
    expect(cap.mintCapability).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-h', gateId: 'gate-9' }));
  });

  it('boot com wake-runaway NAO reconhecido na janela (sem wake-planned) acorda needs-human READ-ONLY via findUnacknowledgedOutcome', () => {
    const run = makeRun({ id: 'run-r', status: 'paused', chatSessionId: 'sess-r' });
    const { deps, cap } = makeDeps(run, { runs: [run] });
    cap.seed(
      makeEvent({ runId: 'run-r', type: 'node-completed', nodeId: 'n1', payloadJson: JSON.stringify({ access: 'read-only' }) }),
      makeEvent({ runId: 'run-r', type: 'wake-runaway', payloadJson: JSON.stringify({ wakesTotal: 7, wakesSinceProgress: 7, reason: 'max-wakes-sem-progresso' }) }),
    );
    expect(findUnacknowledgedWake(cap.events)).toBeNull();
    expect(scanBlockedRunsForIgnition(deps as WorkflowIgnitionDeps)).toBe(1);
    const [prompt, options] = cap.submit.mock.calls[0]!;
    expect(prompt).toContain('SEMAFORO: DECISAO HUMANA');
    expect(cap.registerReadOnlyTurn).toHaveBeenCalledWith(options.driveTurnId);
    expect(cap.mintCapability).not.toHaveBeenCalled();
    expect(cap.pause).not.toHaveBeenCalled();
    expect(payloadOf(cap.eventsOfType('wake-planned')[0]!)).toMatchObject({ reason: 'needs-human', readOnly: true });
    expect(cap.eventsOfType('wake-runaway')).toHaveLength(1);
  });

  it('run blocked por gate NAO e contado duas vezes (caminho de gate + generalizado)', () => {
    const run = makeRun({
      id: 'run-g',
      status: 'blocked',
      chatSessionId: 'sess-g',
      inputJson: JSON.stringify({ pendingDecision: { type: 'gate', id: 'cc-delivery' } }),
    });
    const { deps, cap } = makeDeps(run, { definition: makeDefinition({ gates: [] }), blocked: [run], runs: [run] });
    cap.seed(makeEvent({ runId: 'run-g', type: 'gate-blocked', payloadJson: JSON.stringify({ gateId: 'cc-delivery', mode: 'orchestrator' }) }));
    expect(scanBlockedRunsForIgnition(deps as WorkflowIgnitionDeps)).toBe(1);
    expect(cap.submit).toHaveBeenCalledTimes(1);
  });
});

describe('anti-runaway de wakes (D6)', () => {
  it('7o wake sem progresso => pause + wake-runaway + wake needs-human SEM capability, lease so inspect, driveTurnId registrado read-only', () => {
    const { cap, bus, complete } = bridgeFor(runningRun());
    for (let i = 0; i < 6; i++) {
      bus.emit(gateBlocked('orchestrator', `gate-${i}`));
      const turn = cap.submit.mock.calls[cap.submit.mock.calls.length - 1]![1].driveTurnId as string;
      complete(turn, 'executed');
    }
    expect(cap.submit).toHaveBeenCalledTimes(6);
    expect(cap.pause).not.toHaveBeenCalled();
    expect(cap.mintCapability).toHaveBeenCalledTimes(12); // 6 wakes blocked x (gate + wake), D7

    bus.emit(gateBlocked('orchestrator', 'gate-7'));
    expect(cap.pause).toHaveBeenCalledWith('run-1');
    expect(cap.eventsOfType('wake-runaway')).toHaveLength(1);
    expect(payloadOf(cap.eventsOfType('wake-runaway')[0]!)).toMatchObject({ wakesTotal: 7, wakesSinceProgress: 7, reason: 'max-wakes-sem-progresso' });
    expect(cap.submit).toHaveBeenCalledTimes(7);
    const [prompt, options] = cap.submit.mock.calls[6]!;
    expect(prompt).toContain('SEMAFORO: DECISAO HUMANA');
    expect(prompt).toContain('So `dynamic_workflow_inspect` esta disponivel');
    expect(cap.mintCapability).toHaveBeenCalledTimes(12); // 6 wakes blocked x (gate + wake), D7
    expect(cap.registerReadOnlyTurn).toHaveBeenCalledWith(options.driveTurnId);
    expect(payloadOf(cap.eventsOfType('wake-planned')[6]!)).toMatchObject({ reason: 'needs-human', readOnly: true });
  });

  it('node-completed entre wakes conta como progresso e zera o contador (sem runaway)', () => {
    const { cap, bus, complete } = bridgeFor(runningRun());
    for (let i = 0; i < 10; i++) {
      bus.emit(makeEvent({ type: 'node-completed', nodeId: `n${i}`, payloadJson: JSON.stringify({ access: 'read-only' }) }));
      bus.emit(gateBlocked('orchestrator', `gate-${i}`));
      const turn = cap.submit.mock.calls[cap.submit.mock.calls.length - 1]![1].driveTurnId as string;
      complete(turn, 'executed');
    }
    expect(cap.submit).toHaveBeenCalledTimes(10);
    expect(cap.pause).not.toHaveBeenCalled();
    expect(cap.eventsOfType('wake-runaway')).toHaveLength(0);
  });
});
