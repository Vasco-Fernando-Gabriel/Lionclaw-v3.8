
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkflowHostApi,
  type HostApiCrud,
  type HostApiDeps,
  type HostApiRunContext,
  type GateGate,
  type NodeFailureHookOutcome,
  type PendingGateResolution,
} from '../dynamic-workflows/workflow-host-api';
import {
  WorkflowRunner,
  _resetRunLocksForTesting,
  _resetWorkflowRunnerForTesting,
  type WorkflowRunnerCrud,
  type WorkflowRunnerDeps,
  type WorkflowTimerHandle,
} from '../dynamic-workflows/workflow-runner';
import type {
  NodeRunResult,
  RunNodeAgentInput,
} from '../dynamic-workflows/workflow-agent-adapter';
import type {
  DynamicWorkflowRun,
  DynamicWorkflowDefinition,
  DynamicWorkflowManifest,
  DynamicWorkflowNodeRun,
  DynamicWorkflowNodeRunUpsertInput,
  DynamicWorkflowNodeRunPatch,
  DynamicWorkflowEvent,
  DynamicWorkflowEventInsertInput,
  DynamicWorkflowGateDecisionInsertInput,
  DynamicWorkflowMessageInsertInput,
} from '../dynamic-workflows/types';

const FIXED_NOW = '2026-06-12T12:00:00.000Z';


interface FakeTimer {
  delayMs: number;
  cb: () => void;
  cancelled: boolean;
}

class FakeScheduler {
  private timers: FakeTimer[] = [];
  schedule = (delayMs: number, cb: () => void): WorkflowTimerHandle => {
    const t: FakeTimer = { delayMs, cb, cancelled: false };
    this.timers.push(t);
    return { cancel: () => { t.cancelled = true; } };
  };
  flush(): void {
    const active = this.timers.filter((t) => !t.cancelled);
    this.timers = [];
    for (const t of active) t.cb();
  }
  activeCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
  lastDelayMs(): number | null {
    const active = this.timers.filter((t) => !t.cancelled);
    return active.length ? active[active.length - 1].delayMs : null;
  }
}

interface ActiveRunStateLike {
  runId: string;
}

interface NodeFailedHookInput {
  nodeId: string;
  attempt: number;
  failureClass: string | null;
  runtime: string;
  error: unknown;
  errorMessage?: string | null;
  recoverable: boolean;
}

function callHandleNodeFailed(
  runner: WorkflowRunner,
  state: ActiveRunStateLike,
  input: NodeFailedHookInput,
): Promise<NodeFailureHookOutcome | undefined> {
  return (runner as unknown as {
    handleNodeFailed: (s: ActiveRunStateLike, i: NodeFailedHookInput) => Promise<NodeFailureHookOutcome | undefined>;
  }).handleNodeFailed(state, input);
}


interface SharedState {
  runs: Map<string, DynamicWorkflowRun>;
  definitions: Map<string, DynamicWorkflowDefinition>;
  nodeRuns: DynamicWorkflowNodeRun[];
  events: Array<{ type: string; runId: string; nodeId: string | null; payload: unknown }>;
  gateDecisions: DynamicWorkflowGateDecisionInsertInput[];
  messages: DynamicWorkflowMessageInsertInput[];
  checkpointByRun: Map<string, string>;
}

function makeManifest(): DynamicWorkflowManifest {
  return {
    version: 1,
    name: 'res-wiring',
    phases: [{ id: 'Implementar', name: 'Implementar', order: 0 }],
    nodes: [
      {
        id: 'coder',
        type: 'agent',
        phaseId: 'Implementar',
        agentId: 'a-coder',
        access: 'read-only',
        canResume: true,
        produces: ['impl'],
        consumes: [],
      },
    ],
    parallelism: { maxConcurrentAgents: 1, parallelWritersAllowed: false },
    gates: [],
    estimate: { minUsd: 0, maxUsd: 1, unknownCostNodes: [] },
  };
}

function makeRun(over?: Partial<DynamicWorkflowRun>): DynamicWorkflowRun {
  return {
    id: 'run-1',
    definitionId: 'def-1',
    chatSessionId: null,
    status: 'running',
    currentPhaseId: 'Implementar',
    currentNodeId: 'coder',
    workspaceMode: 'fresh-project',
    baseBranch: 'main',
    baseCommitSha: 'base-sha',
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
    startedAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    completedAt: null,
    ...over,
  };
}

function makeDefinition(): DynamicWorkflowDefinition {
  return {
    id: 'def-1',
    name: 'res-wiring',
    definitionVersion: 1,
    authoringModel: 'manifest',
    parentDefinitionId: null,
    supersedesDefinitionId: null,
    sourceType: 'builder',
    projectPath: '/tmp/proj',
    specPath: null,
    specSha256: null,
    workflowJsPath: '/tmp/proj/.lionclaw/workflows/run-1/workflow.js',
    manifestPath: '/tmp/proj/.lionclaw/workflows/run-1/workflow.manifest.json',
    manifestJson: JSON.stringify(makeManifest()),
    manifestHash: 'mh',
    contextBundlePath: null,
    builderModel: null,
    status: 'validated',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

function nodeRunFromUpsert(input: DynamicWorkflowNodeRunUpsertInput): DynamicWorkflowNodeRun {
  return {
    id: input.id,
    runId: input.runId,
    nodeId: input.nodeId,
    phaseId: input.phaseId,
    type: input.type,
    agentId: input.agentId ?? null,
    status: input.status,
    attempt: input.attempt,
    inputHash: input.inputHash ?? null,
    policyHash: input.policyHash ?? null,
    policySnapshotJson: input.policySnapshotJson ?? '{}',
    inputJson: input.inputJson ?? '{}',
    outputHash: null,
    outputJson: null,
    error: null,
    failureClass: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    costStatus: null,
    tokenStatus: null,
    costUnknownReason: null,
    metricsMetadataJson: '{}',
    model: null,
    runtime: null,
    provider: null,
    toolUses: 0,
    apiRequests: 0,
    durationMs: 0,
    startedAt: input.startedAt ?? null,
    completedAt: null,
  };
}

function makeSharedCrud(state: SharedState): {
  hostCrud: HostApiCrud;
  runnerCrud: WorkflowRunnerCrud;
} {
  let eventSeq = 0;
  const recordEvent = (input: DynamicWorkflowEventInsertInput): DynamicWorkflowEvent => {
    eventSeq += 1;
    let payload: unknown = {};
    try {
      payload = input.payloadJson ? JSON.parse(input.payloadJson) : {};
    } catch {
      payload = input.payloadJson;
    }
    state.events.push({ type: input.type, runId: input.runId, nodeId: input.nodeId ?? null, payload });
    return {
      id: eventSeq,
      runId: input.runId,
      nodeId: input.nodeId ?? null,
      phaseId: input.phaseId ?? null,
      seq: eventSeq,
      type: input.type,
      payloadJson: input.payloadJson ?? '{}',
      createdAt: FIXED_NOW,
    };
  };

  const upsertNodeRun = (input: DynamicWorkflowNodeRunUpsertInput): DynamicWorkflowNodeRun => {
    const nr = nodeRunFromUpsert(input);
    state.nodeRuns.push(nr);
    return nr;
  };
  const updateNodeRun = (id: string, patch: DynamicWorkflowNodeRunPatch): void => {
    const nr = state.nodeRuns.find((n) => n.id === id);
    if (nr) Object.assign(nr, patch);
  };

  const getRun = (id: string) => state.runs.get(id) ?? null;
  const updateRun = (id: string, patch: Partial<DynamicWorkflowRun>): void => {
    const r = state.runs.get(id);
    if (r) state.runs.set(id, { ...r, ...patch } as DynamicWorkflowRun);
  };

  const hostCrud: HostApiCrud = {
    upsertNodeRun,
    updateNodeRun,
    insertEvent: recordEvent,
    insertGateDecision: (input) => {
      state.gateDecisions.push(input);
      return {
        id: input.id,
        runId: input.runId,
        gateId: input.gateId,
        nodeId: input.nodeId ?? null,
        mode: input.mode,
        decision: input.decision,
        decidedBy: input.decidedBy,
        reason: input.reason ?? null,
        payloadJson: input.payloadJson ?? '{}',
        createdAt: FIXED_NOW,
      };
    },
    registerArtifact: (input) => ({
      id: input.id,
      runId: input.runId,
      nodeId: input.nodeId ?? null,
      kind: input.kind,
      path: input.path,
      sha256: input.sha256,
      metadataJson: input.metadataJson ?? '{}',
      createdAt: FIXED_NOW,
    }),
    getRunCheckpoint: (runId) => state.checkpointByRun.get(runId) ?? getRun(runId)?.checkpointJson ?? null,
    persistRunCheckpoint: (runId, checkpointJson) => {
      state.checkpointByRun.set(runId, checkpointJson);
      updateRun(runId, { checkpointJson });
    },
    addRunCost: (runId, addUsd, addDurationMs) => {
      const r = getRun(runId);
      if (!r) return;
      updateRun(runId, {
        totalCostUsd: r.totalCostUsd + addUsd,
        totalDurationMs: r.totalDurationMs + addDurationMs,
      });
    },
    patchRun: (runId, patch) => {
      const runPatch: Partial<DynamicWorkflowRun> = {};
      if (patch.status !== undefined) runPatch.status = patch.status;
      if (patch.currentPhaseId !== undefined) runPatch.currentPhaseId = patch.currentPhaseId;
      if (patch.currentNodeId !== undefined) runPatch.currentNodeId = patch.currentNodeId;
      if (patch.error !== undefined) runPatch.error = patch.error;
      if (patch.pendingDecisionJson !== undefined) {
        const r = getRun(runId);
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(r?.inputJson || '{}');
        } catch {
          input = {};
        }
        const pd = JSON.parse(patch.pendingDecisionJson) as { pendingDecision?: unknown };
        if (pd.pendingDecision) input.pendingDecision = pd.pendingDecision;
        else delete input.pendingDecision;
        runPatch.inputJson = JSON.stringify(input);
      }
      updateRun(runId, runPatch);
    },
  };

  const runnerCrud: WorkflowRunnerCrud = {
    getRun,
    getDefinition: (id) => state.definitions.get(id) ?? null,
    listRunsByStatus: (status) => [...state.runs.values()].filter((r) => r.status === status),
    setRunStatus: (id, status) => updateRun(id, { status }),
    updateRun,
    upsertNodeRun,
    updateNodeRun,
    listNodeRuns: (runId) => state.nodeRuns.filter((n) => n.runId === runId),
    insertEvent: recordEvent,
    recentEvents: () => [],
    insertGateDecision: hostCrud.insertGateDecision,
    registerArtifact: hostCrud.registerArtifact,
    insertMessage: (input: DynamicWorkflowMessageInsertInput) => {
      state.messages.push(input);
      return {
        id: state.messages.length,
        runId: input.runId,
        nodeId: input.nodeId ?? null,
        role: input.role,
        source: input.source,
        kind: input.kind,
        content: input.content,
        toolCallsJson: input.toolCallsJson ?? null,
        agentId: input.agentId ?? null,
        createdAt: FIXED_NOW,
      };
    },
    listMessages: () => [],
    costAggregate: (runId) => ({
      runId,
      totalCostUsd: getRun(runId)?.totalCostUsd ?? 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalDurationMs: 0,
      nodeRunCount: 0,
      unknownCostNodeRuns: 0,
    }),
  };

  return { hostCrud, runnerCrud };
}

function makeProviderLimitFailure(input: RunNodeAgentInput): NodeRunResult {
  return {
    ok: false,
    output: '',
    runtime: 'cloud',
    family: 'claude-compatible',
    failureClass: 'provider-limit',
    errorMessage: 'rate limit exceeded',
    policy: {
      runId: input.runId,
      nodeId: input.grants.nodeId,
      agentId: input.agentId,
      workspaceRoot: input.workspace.workspaceRoot,
      cwd: input.workspace.cwd,
      access: input.grants.access ?? 'read-only',
      allowedTools: [],
      deniedTools: [],
      allowedMcpServers: [],
      allowedMcpTools: [],
      allowedCommands: [],
      effectiveTools: [],
      effectiveMcpServers: [],
      policyHash: `hash-${input.grants.nodeId}`,
      allowBash: false,
      allowNetwork: false,
      timeoutMs: 1000,
      idleTimeoutMs: 1000,
      costCeilingUsd: 0,
    },
    mechanism: 'canUseTool',
    durationMs: 5,
  };
}

function makeRunDir(): string {
  return mkdtempSync(join(tmpdir(), 'dwf-res-wiring-'));
}

beforeEach(() => {
  _resetRunLocksForTesting();
  _resetWorkflowRunnerForTesting();
});


describe('DEFECT-4: host agent() falha -> onNodeFailed -> handleProviderFailure (AC-22)', () => {
  it('o caminho de falha do agent() DISPARA o hook onNodeFailed (era codigo morto)', async () => {
    const state: SharedState = {
      runs: new Map([['run-1', makeRun()]]),
      definitions: new Map([['def-1', makeDefinition()]]),
      nodeRuns: [],
      events: [],
      gateDecisions: [],
      messages: [],
      checkpointByRun: new Map(),
    };
    const { hostCrud } = makeSharedCrud(state);
    const runDir = makeRunDir();

    const hookCalls: Array<{ nodeId: string; recoverable: boolean; runtime: string }> = [];
    const gateGate: GateGate = {
      awaitDecision: () => new Promise<PendingGateResolution>(() => {}),
    };
    const ctx: HostApiRunContext = {
      runId: 'run-1',
      manifest: makeManifest(),
      workspaceRoot: runDir,
      runDir,
      abortSignal: new AbortController().signal,
      onNodeFailed: (input) => {
        hookCalls.push({ nodeId: input.nodeId, recoverable: input.recoverable, runtime: input.runtime });
      },
    };
    const deps: HostApiDeps = {
      crud: hostCrud,
      gateGate,
      runNodeAgent: (input) => Promise.resolve(makeProviderLimitFailure(input)),
      emit: () => {},
      now: () => FIXED_NOW,
      generateId: (p) => `${p}_x`,
    };
    const api = createWorkflowHostApi(ctx, deps);

    const out = await api.agent({ id: 'coder', agentId: 'a-coder', access: 'read-only', prompt: 'x' });
    expect(out).toBeNull();
    expect(hookCalls.length).toBe(1);
    expect(hookCalls[0]).toMatchObject({ nodeId: 'coder', recoverable: true, runtime: 'cloud' });

    rmSync(runDir, { recursive: true, force: true });
  });

  it('L1.1: agent() provider-limit x3 via hook -> 2 retries IN-PROCESS (backoff aguardado) e gate failure:coder; skip devolve null (nunca failed)', async () => {
    const state: SharedState = {
      runs: new Map([['run-1', makeRun()]]),
      definitions: new Map([['def-1', makeDefinition()]]),
      nodeRuns: [],
      events: [],
      gateDecisions: [],
      messages: [],
      checkpointByRun: new Map(),
    };
    const { hostCrud, runnerCrud } = makeSharedCrud(state);
    const scheduler = new FakeScheduler();
    const runnerDeps: WorkflowRunnerDeps = {
      crud: runnerCrud,
      emitIPC: () => {},
      now: () => FIXED_NOW,
      scheduleTimer: scheduler.schedule,
    };
    const runner = new WorkflowRunner(runnerDeps);
    const runDir = makeRunDir();

    const gateCalls: string[] = [];
    const gateGate: GateGate = {
      awaitDecision: (gateId) => {
        gateCalls.push(gateId);
        return Promise.resolve<PendingGateResolution>({
          decision: 'approve',
          approvedBy: 'orchestrator',
          payload: { action: 'skip' },
        });
      },
    };
    const callState = { runId: 'run-1' } as unknown as ActiveRunStateLike;
    const ctx: HostApiRunContext = {
      runId: 'run-1',
      manifest: makeManifest(),
      workspaceRoot: runDir,
      runDir,
      abortSignal: new AbortController().signal,
      onNodeFailed: (input) => callHandleNodeFailed(runner, callState, input),
    };
    const sleeps: number[] = [];
    const deps: HostApiDeps = {
      crud: hostCrud,
      gateGate,
      runNodeAgent: (input) => Promise.resolve(makeProviderLimitFailure(input)),
      emit: (e) => runnerCrud.insertEvent({ runId: e.runId, type: e.type, nodeId: e.nodeId ?? null, payloadJson: JSON.stringify(e.payload ?? {}) }),
      now: () => FIXED_NOW,
      generateId: (p) => `${p}_${state.nodeRuns.length}`,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    };

    const api = createWorkflowHostApi(ctx, deps);
    const out = await api.agent({ id: 'coder', agentId: 'a-coder', access: 'read-only', prompt: 'x' });
    expect(out).toBeNull();

    expect(sleeps).toHaveLength(2);
    expect(sleeps.every((ms) => ms > 0)).toBe(true);
    expect(scheduler.activeCount()).toBe(0);
    const retries = state.events.filter((e) => e.type === 'node-retry-scheduled');
    expect(retries).toHaveLength(2);
    expect(retries.every((e) => (e.payload as { inProcess?: boolean }).inProcess === true)).toBe(true);
    const attempts = state.nodeRuns.filter((nr) => nr.nodeId === 'coder').map((nr) => [nr.attempt, nr.status]);
    expect(attempts).toEqual([[1, 'failed'], [2, 'failed'], [3, 'failed']]);

    const blocked = state.events.filter((e) => e.type === 'run-blocked-provider');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.payload).toMatchObject({ failureClass: 'provider-limit', retriesExhausted: true, attemptsMade: 3, gateId: 'failure:coder' });
    const gate = state.events.find((e) => e.type === 'gate-blocked');
    expect(gate?.payload).toMatchObject({ gateId: 'failure:coder', mode: 'orchestrator', failure: true, failureClass: 'provider-limit', actions: ['retry', 'switch-agent', 'skip', 'abort'] });
    expect(gateCalls).toEqual(['failure:coder']);
    const approved = state.events.find((e) => e.type === 'gate-approved');
    expect(approved?.payload).toMatchObject({ gateId: 'failure:coder', action: 'skip' });
    const run = state.runs.get('run-1');
    expect(run?.status).toBe('running');
    expect(JSON.parse(run?.inputJson || '{}').pendingDecision).toBeUndefined();
    expect(state.events.some((e) => e.type === 'run-failed')).toBe(false);

    rmSync(runDir, { recursive: true, force: true });
  });

  it('DEFECT-4: a GLUE handleNodeFailed deriva attemptsMade DURAVEL e escala (RED no codigo antigo)', async () => {
    const state: SharedState = {
      runs: new Map([['run-1', makeRun()]]),
      definitions: new Map([['def-1', makeDefinition()]]),
      nodeRuns: [],
      events: [],
      gateDecisions: [],
      messages: [],
      checkpointByRun: new Map(),
    };
    const { runnerCrud } = makeSharedCrud(state);
    const scheduler = new FakeScheduler();
    const runner = new WorkflowRunner({
      crud: runnerCrud,
      emitIPC: () => {},
      now: () => FIXED_NOW,
      scheduleTimer: scheduler.schedule,
    });
    const callState = { runId: 'run-1' } as unknown as ActiveRunStateLike;

    const statuses: string[] = [];
    const outcomes: string[] = [];
    for (let cycle = 1; cycle <= 3; cycle++) {
      runnerCrud.upsertNodeRun({
        id: `nr-${cycle}`,
        runId: 'run-1',
        nodeId: 'coder',
        phaseId: 'Implementar',
        type: 'agent',
        agentId: 'a-coder',
        status: 'failed',
        attempt: 1, // attemptByNode do host zera por ciclo (resume) -> attempt=1 sempre
        startedAt: FIXED_NOW,
      });
      const decided = await callHandleNodeFailed(runner, callState, {
        nodeId: 'coder',
        attempt: 1,
        failureClass: 'provider-limit',
        runtime: 'cloud',
        error: 'rate limit exceeded',
        errorMessage: 'rate limit exceeded',
        recoverable: true,
      });
      outcomes.push(decided?.outcome ?? '?');
      statuses.push(state.runs.get('run-1')?.status ?? '?');
    }

    expect(outcomes).toEqual(['retry-scheduled', 'retry-scheduled', 'blocked-provider']);
    expect(statuses[0]).toBe('running');
    expect(statuses[1]).toBe('running');
    expect(state.runs.get('run-1')?.status).toBe('blocked');
    expect(scheduler.activeCount()).toBe(0);
    const retryCount = state.events.filter((e) => e.type === 'node-retry-scheduled').length;
    expect(retryCount).toBe(2);
    expect(state.events.some((e) => e.type === 'run-blocked-provider')).toBe(true);
    const pd = JSON.parse(state.runs.get('run-1')?.inputJson || '{}').pendingDecision as
      | { type?: string; retriesExhausted?: boolean; gateId?: string }
      | undefined;
    expect(pd?.type).toBe('provider');
    expect(pd?.retriesExhausted).toBe(true);
    expect(pd?.gateId).toBe('failure:coder');
  });
});


describe('DEFECT-4: resume() roda detectPolicyInvalidation (10.1)', () => {
  it('policy_hash mudou -> resume NAO re-executa, bloqueia exigindo aceite humano', async () => {
    const completed: DynamicWorkflowNodeRun = {
      ...nodeRunFromUpsert({
        id: 'nr-coder-1',
        runId: 'run-1',
        nodeId: 'coder',
        phaseId: 'Implementar',
        type: 'agent',
        agentId: 'a-coder',
        status: 'completed',
        attempt: 1,
        policyHash: 'ph-old',
      }),
      status: 'completed',
      policyHash: 'ph-old',
    };
    const state: SharedState = {
      runs: new Map([['run-1', makeRun({ status: 'interrupted' })]]),
      definitions: new Map([['def-1', makeDefinition()]]),
      nodeRuns: [completed],
      events: [],
      gateDecisions: [],
      messages: [],
      checkpointByRun: new Map(),
    };
    const { runnerCrud } = makeSharedCrud(state);
    const scheduler = new FakeScheduler();
    const runner = new WorkflowRunner({
      crud: runnerCrud,
      emitIPC: () => {},
      now: () => FIXED_NOW,
      scheduleTimer: scheduler.schedule,
      resolvePolicyHashForNode: () => 'ph-new',
    });

    const res = await runner.resume('run-1');
    expect('error' in res).toBe(true);
    expect(state.runs.get('run-1')?.status).toBe('blocked');
    const pd = JSON.parse(state.runs.get('run-1')?.inputJson || '{}').pendingDecision as { policyChanged?: boolean } | undefined;
    expect(pd?.policyChanged).toBe(true);
    expect(state.events.some((e) => e.type === 'cache-invalidated:policy-changed' && e.nodeId === 'coder')).toBe(true);
  });

  it('aceite humano (acceptPolicyChange) destrava o bloqueio de policy-changed', async () => {
    const state: SharedState = {
      runs: new Map([
        [
          'run-1',
          makeRun({
            status: 'blocked',
            inputJson: JSON.stringify({
              pendingDecision: { type: 'provider', id: 'policy-changed', policyChanged: true, invalidatedNodeIds: ['coder'] },
            }),
          }),
        ],
      ]),
      definitions: new Map([['def-1', makeDefinition()]]),
      nodeRuns: [],
      events: [],
      gateDecisions: [],
      messages: [],
      checkpointByRun: new Map(),
    };
    const { runnerCrud } = makeSharedCrud(state);
    const scheduler = new FakeScheduler();
    const runner = new WorkflowRunner({
      crud: runnerCrud,
      emitIPC: () => {},
      now: () => FIXED_NOW,
      scheduleTimer: scheduler.schedule,
      resolvePolicyHashForNode: () => 'ph-new',
    });

    await runner.resume('run-1', { acceptPolicyChange: true });
    const run = state.runs.get('run-1');
    const pd = JSON.parse(run?.inputJson || '{}').pendingDecision;
    expect(pd).toBeUndefined();
    expect(state.events.some((e) => e.type === 'policy-change-accepted')).toBe(true);
  });
});


describe('DEFECT-4: stall watchdog arma no node-started (13.8)', () => {
  it('evento node-started (emitido pelo host) ARMA o watchdog; node-completed CANCELA', () => {
    const state: SharedState = {
      runs: new Map([['run-1', makeRun()]]),
      definitions: new Map([['def-1', makeDefinition()]]),
      nodeRuns: [],
      events: [],
      gateDecisions: [],
      messages: [],
      checkpointByRun: new Map(),
    };
    const { runnerCrud } = makeSharedCrud(state);
    const scheduler = new FakeScheduler();
    const runner = new WorkflowRunner({
      crud: runnerCrud,
      emitIPC: () => {},
      now: () => FIXED_NOW,
      scheduleTimer: scheduler.schedule,
    });

    const hostEmit = (e: { runId: string; type: string; nodeId?: string | null; payload?: unknown }) =>
      // @ts-expect-error acesso ao emit privado: este teste exercita o roteamento
      runner.emit(e);

    expect(scheduler.activeCount()).toBe(0);
    hostEmit({ runId: 'run-1', type: 'node-started', nodeId: 'coder', payload: {} });
    expect(scheduler.activeCount()).toBe(1);
    expect(scheduler.lastDelayMs()).toBe(3 * 60 * 1000);

    hostEmit({ runId: 'run-1', type: 'node-completed', nodeId: 'coder', payload: {} });
    expect(scheduler.activeCount()).toBe(0);
  });

  it('o watchdog dispara node-stalled apos 3min sem progresso (flush do timer)', () => {
    const state: SharedState = {
      runs: new Map([['run-1', makeRun()]]),
      definitions: new Map([['def-1', makeDefinition()]]),
      nodeRuns: [{ ...nodeRunFromUpsert({ id: 'nr-coder-1', runId: 'run-1', nodeId: 'coder', phaseId: 'Implementar', type: 'agent', agentId: 'a-coder', status: 'running', attempt: 1 }), status: 'running' }],
      events: [],
      gateDecisions: [],
      messages: [],
      checkpointByRun: new Map(),
    };
    const { runnerCrud } = makeSharedCrud(state);
    const scheduler = new FakeScheduler();
    const runner = new WorkflowRunner({
      crud: runnerCrud,
      emitIPC: () => {},
      now: () => FIXED_NOW,
      scheduleTimer: scheduler.schedule,
    });

    // @ts-expect-error roteamento node-started -> startStallWatchdog (emit privado).
    runner.emit({ runId: 'run-1', type: 'node-started', nodeId: 'coder', payload: {} });
    scheduler.flush();
    expect(state.events.some((e) => e.type === 'node-stalled' && e.nodeId === 'coder')).toBe(true);
  });
});
