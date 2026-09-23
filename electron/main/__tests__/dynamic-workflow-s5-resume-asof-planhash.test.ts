import { describe, it, expect, vi } from 'vitest';
import {
  createWorkflowHostApi,
  type HostApiRunContext,
  type HostApiDeps,
  type HostApiCrud,
  type GateGate,
  type PendingGateResolution,
} from '../dynamic-workflows/workflow-host-api';
import type {
  DynamicWorkflowManifest,
  DynamicWorkflowManifestNode,
  DynamicWorkflowNodeRun,
  DynamicWorkflowNodeRunUpsertInput,
  DynamicWorkflowNodeRunPatch,
  DynamicWorkflowEvent,
  DynamicWorkflowEventInsertInput,
  DynamicWorkflowGateDecision,
  DynamicWorkflowGateDecisionInsertInput,
  DynamicWorkflowArtifact,
  DynamicWorkflowArtifactInsertInput,
  DynamicWorkflowNodeCreateInput,
  DynamicWorkflowSprintPlan,
  DynamicWorkflowJournalEntry,
  DynamicWorkflowJournalAppendInput,
} from '../dynamic-workflows/types';
import type { NodeRunResult, RunNodeAgentInput } from '../dynamic-workflows/workflow-agent-adapter';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Harness {
  deps: HostApiDeps;
  state: {
    nodeRuns: Map<string, DynamicWorkflowNodeRun>;
    events: Array<{ type: string; nodeId?: string | null; payload?: unknown }>;
    journal: DynamicWorkflowJournalEntry[];
    truncateCalls: Array<{ fromIndex: number }>;
    materializeCrudCalls: number;
  };
}

function makeOkResult(input: RunNodeAgentInput, output: string): NodeRunResult {
  return {
    ok: true,
    output,
    runtime: 'cloud',
    family: 'claude-compatible',
    cost: {
      costUsd: 0,
      costStatus: 'known',
      tokenStatus: null,
      costUnknownReason: null,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      apiRequests: 0,
      toolUses: 0,
    },
    policy: {
      runId: input.runId,
      nodeId: input.grants.nodeId,
      agentId: input.agentId,
      workspaceRoot: input.workspace.workspaceRoot,
      cwd: input.workspace.cwd,
      access: input.grants.access ?? 'read-only',
      allowedTools: input.grants.allowedTools ?? [],
      deniedTools: [],
      allowedMcpServers: [],
      allowedMcpTools: [],
      allowedCommands: [],
      effectiveTools: input.grants.allowedTools ?? [],
      effectiveMcpServers: [],
      policyHash: `hash-${input.grants.nodeId}`,
      allowBash: false,
      allowNetwork: false,
      timeoutMs: 1000,
      idleTimeoutMs: 1000,
      costCeilingUsd: 0,
    },
    mechanism: 'canUseTool',
    durationMs: 1,
  };
}

function makeHarness(adapter: (input: RunNodeAgentInput) => Promise<NodeRunResult>): Harness {
  const state: Harness['state'] = {
    nodeRuns: new Map(),
    events: [],
    journal: [],
    truncateCalls: [],
    materializeCrudCalls: 0,
  };
  let eventSeq = 0;
  let checkpointJson = '{}';

  const crud: HostApiCrud = {
    upsertNodeRun: (input: DynamicWorkflowNodeRunUpsertInput): DynamicWorkflowNodeRun => {
      const nr: DynamicWorkflowNodeRun = {
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
      state.nodeRuns.set(input.id, nr);
      return nr;
    },
    updateNodeRun: (id: string, patch: DynamicWorkflowNodeRunPatch): void => {
      const nr = state.nodeRuns.get(id);
      if (nr) Object.assign(nr, patch);
    },
    insertEvent: (input: DynamicWorkflowEventInsertInput): DynamicWorkflowEvent => {
      eventSeq += 1;
      return {
        id: eventSeq,
        runId: input.runId,
        nodeId: input.nodeId ?? null,
        phaseId: input.phaseId ?? null,
        seq: eventSeq,
        type: input.type,
        payloadJson: input.payloadJson ?? '{}',
        createdAt: '2026-07-06T00:00:00.000Z',
      };
    },
    insertGateDecision: (input: DynamicWorkflowGateDecisionInsertInput): DynamicWorkflowGateDecision => ({
      id: input.id,
      runId: input.runId,
      gateId: input.gateId,
      nodeId: input.nodeId ?? null,
      mode: input.mode,
      decision: input.decision,
      decidedBy: input.decidedBy,
      reason: input.reason ?? null,
      payloadJson: input.payloadJson ?? '{}',
      createdAt: '2026-07-06T00:00:00.000Z',
    }),
    registerArtifact: (input: DynamicWorkflowArtifactInsertInput): DynamicWorkflowArtifact => ({
      id: input.id,
      runId: input.runId,
      nodeId: input.nodeId ?? null,
      kind: input.kind,
      path: input.path,
      sha256: input.sha256,
      metadataJson: input.metadataJson ?? '{}',
      createdAt: '2026-07-06T00:00:00.000Z',
    }),
    getRunCheckpoint: () => checkpointJson,
    persistRunCheckpoint: (_runId, json) => {
      checkpointJson = json;
    },
    addRunCost: () => {},
    patchRun: () => {},
    appendJournalEntry: (input: DynamicWorkflowJournalAppendInput) => {
      const idx = state.journal.findIndex((e) => e.callIndex === input.callIndex);
      const entry: DynamicWorkflowJournalEntry = {
        ...input,
        outputRef: input.outputRef ?? null,
        sideEffectKey: input.sideEffectKey ?? null,
        createdAt: '2026-07-06T00:00:00.000Z',
      };
      if (idx >= 0) state.journal[idx] = entry;
      else state.journal.push(entry);
    },
    listJournalEntries: () => [...state.journal].sort((a, b) => a.callIndex - b.callIndex),
    truncateJournalFrom: (_runId, fromIndex) => {
      state.truncateCalls.push({ fromIndex });
      state.journal = state.journal.filter((e) => e.callIndex < fromIndex);
    },
    materializeSprintPlan: () => {
      state.materializeCrudCalls += 1;
    },
  };

  const gateGate: GateGate = {
    awaitDecision: () => new Promise<PendingGateResolution>(() => {}),
  };

  const deps: HostApiDeps = {
    crud,
    gateGate,
    runNodeAgent: (input) => adapter(input),
    emit: (input) => state.events.push({ type: input.type, nodeId: input.nodeId, payload: input.payload }),
    generateId: (prefix) => `${prefix}_${state.nodeRuns.size}`,
    now: () => '2026-07-06T00:00:00.000Z',
  };

  return { deps, state };
}

const DEV_NODE: DynamicWorkflowManifestNode = {
  id: 's0-coder-r0',
  type: 'agent',
  phaseId: 'Desenvolvimento',
  agentId: 'a-coder',
  access: 'read-only',
  canResume: true,
  produces: ['s0-impl'],
  consumes: [],
  sprintId: 's0',
  roundIndex: 0,
};

function baseManifest(): DynamicWorkflowManifest {
  return {
    version: 1,
    name: 's5-asof-wf',
    phases: [
      { id: 'Plan', name: 'Plan', order: 0 },
      { id: 'Desenvolvimento', name: 'Desenvolvimento', order: 1 },
    ],
    nodes: [
      {
        id: 'planner',
        type: 'agent',
        phaseId: 'Plan',
        agentId: 'a-scout',
        access: 'read-only',
        canResume: true,
        produces: ['plan'],
        consumes: [],
      },
    ],
    parallelism: { maxConcurrentAgents: 3, parallelWritersAllowed: false },
    gates: [],
    estimate: { minUsd: 0, maxUsd: 1, unknownCostNodes: [] },
  };
}

function manifestWithDevNode(): DynamicWorkflowManifest {
  const m = baseManifest();
  m.nodes.push({ ...DEV_NODE });
  return m;
}

function fakeBuildSprintNodes(): HostApiRunContext['buildSprintNodes'] {
  return () => {
    const createInput: DynamicWorkflowNodeCreateInput = {
      id: 'row-s0-coder-r0',
      definitionId: 'def-1',
      nodeId: 's0-coder-r0',
      phaseId: 'Desenvolvimento',
      type: 'agent',
      agentId: 'a-coder',
      access: 'read-only',
      produces: ['s0-impl'],
      consumes: [],
    };
    return {
      manifestNodes: [{ ...DEV_NODE }],
      createInputs: [createInput],
      sprintNodeIds: [{ sprintId: 's0', nodeIds: ['s0-coder-r0'] }],
    };
  };
}

function rawPlan(): { sprints: unknown[] } {
  return {
    sprints: [
      {
        id: 's0',
        index: 0,
        name: 'Sprint 0',
        description: 'entregar X',
        stack: ['ts'],
        coderAgentId: 'a-coder',
        validatorAgentIds: ['a-val'],
        features: [{ id: 'f0', name: 'feat 0', acceptanceCriteria: ['tsc verde'] }],
      },
    ],
  };
}

function makeCtx(runDir: string, over?: Partial<HostApiRunContext>): HostApiRunContext {
  return {
    runId: 'run-s5',
    manifest: baseManifest(),
    workspaceRoot: runDir,
    runDir,
    abortSignal: new AbortController().signal,
    definitionId: 'def-1',
    catalogAgentIds: ['a-coder', 'a-val', 'a-scout'],
    buildSprintNodes: fakeBuildSprintNodes(),
    ...over,
  };
}

async function runFullSequence(api: ReturnType<typeof createWorkflowHostApi>): Promise<DynamicWorkflowSprintPlan> {
  await api.agent({ id: 'planner', agentId: 'a-scout', prompt: 'planeje as sprints' });
  const v = (await api.validateSprintPlan(rawPlan())) as { ok: boolean; plan: DynamicWorkflowSprintPlan };
  expect(v.ok).toBe(true);
  await api.materializeSprintPlan(v.plan);
  await api.agent({ id: 's0-coder-r0', agentId: 'a-coder', prompt: 'implemente a sprint 0' });
  return v.plan;
}

describe('S5 resume as-of planHash: fix do "resume volta pro planner"', () => {
  it('grava o journal AS-OF no primeiro run: NULL antes do validate, hash depois', async () => {
    const adapter = vi.fn((input: RunNodeAgentInput) =>
      Promise.resolve(makeOkResult(input, `{"node":"${input.grants.nodeId}"}`)),
    );
    const h = makeHarness(adapter);
    const runDir = mkdtempSync(join(tmpdir(), 'dwf-s5-asof-'));
    const api = createWorkflowHostApi(makeCtx(runDir), h.deps);

    const plan = await runFullSequence(api);

    const journal = [...h.state.journal].sort((a, b) => a.callIndex - b.callIndex);
    expect(journal.map((e) => e.primitive)).toEqual(['agent', 'materializeSprintPlan', 'agent']);
    expect(journal[0]!.planHash).toBeNull();
    expect(journal[1]!.planHash).toBe(plan.planHash);
    expect(journal[2]!.planHash).toBe(plan.planHash);
    rmSync(runDir, { recursive: true, force: true });
  });

  it('PROVA 1: interrompido DEPOIS do materialize -> resume NAO re-roda planner nem coder (prefixo 100% cache)', async () => {
    const adapter = vi.fn((input: RunNodeAgentInput) =>
      Promise.resolve(makeOkResult(input, `{"node":"${input.grants.nodeId}"}`)),
    );
    const h = makeHarness(adapter);
    const runDir = mkdtempSync(join(tmpdir(), 'dwf-s5-resume-'));

    const api1 = createWorkflowHostApi(makeCtx(runDir), h.deps);
    const plan = await runFullSequence(api1);
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(h.state.materializeCrudCalls).toBe(1);

    const api2 = createWorkflowHostApi(
      makeCtx(runDir, {
        manifest: manifestWithDevNode(),
        priorMaterialized: {
          planVersion: plan.planVersion,
          planHash: plan.planHash,
          sprintNodeIds: [{ sprintId: 's0', nodeIds: ['s0-coder-r0'] }],
        },
      }),
      h.deps,
    );
    await runFullSequence(api2);

    expect(adapter).toHaveBeenCalledTimes(2);
    expect(h.state.materializeCrudCalls).toBe(1);
    expect(h.state.truncateCalls).toEqual([]);
    const cacheHits = h.state.events.filter((e) => e.type === 'node-cache-hit').map((e) => e.nodeId);
    expect(cacheHits).toEqual(['planner', 's0-coder-r0']);
    rmSync(runDir, { recursive: true, force: true });
  });

  it('PROVA 2: interrompido ANTES do materialize -> resume reusa o planner e segue sem re-rodar o feito', async () => {
    const adapter = vi.fn((input: RunNodeAgentInput) =>
      Promise.resolve(makeOkResult(input, `{"node":"${input.grants.nodeId}"}`)),
    );
    const h = makeHarness(adapter);
    const runDir = mkdtempSync(join(tmpdir(), 'dwf-s5-premat-'));

    const api1 = createWorkflowHostApi(makeCtx(runDir), h.deps);
    await api1.agent({ id: 'planner', agentId: 'a-scout', prompt: 'planeje as sprints' });
    const v1 = (await api1.validateSprintPlan(rawPlan())) as { plan: DynamicWorkflowSprintPlan };
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(h.state.journal).toHaveLength(1);
    expect(h.state.journal[0]!.planHash).toBeNull();

    const api2 = createWorkflowHostApi(makeCtx(runDir), h.deps);
    const plan2 = await runFullSequence(api2);

    expect(adapter).toHaveBeenCalledTimes(2);
    expect(adapter.mock.calls.map((c) => c[0].grants.nodeId)).toEqual(['planner', 's0-coder-r0']);
    expect(h.state.truncateCalls).toEqual([]);
    expect(h.state.materializeCrudCalls).toBe(1);
    expect(plan2.planVersion).toBe(v1.plan.planVersion);
    expect(plan2.planHash).toBe(v1.plan.planHash);
    rmSync(runDir, { recursive: true, force: true });
  });

  it('PROVA 3: journal LEGADO (planHash nao-nulo em todas as posicoes) segue dando match pos-materialize', async () => {
    const adapter = vi.fn((input: RunNodeAgentInput) =>
      Promise.resolve(makeOkResult(input, `{"node":"${input.grants.nodeId}"}`)),
    );
    const h = makeHarness(adapter);
    const runDir = mkdtempSync(join(tmpdir(), 'dwf-s5-legacy-'));

    const api1 = createWorkflowHostApi(makeCtx(runDir), h.deps);
    const plan = await runFullSequence(api1);

    const plannerIdx = h.state.journal.findIndex((e) => e.nodeId === 'planner');
    h.state.journal[plannerIdx] = { ...h.state.journal[plannerIdx]!, planHash: plan.planHash };

    const api2 = createWorkflowHostApi(
      makeCtx(runDir, {
        manifest: manifestWithDevNode(),
        priorMaterialized: {
          planVersion: plan.planVersion,
          planHash: plan.planHash,
          sprintNodeIds: [{ sprintId: 's0', nodeIds: ['s0-coder-r0'] }],
        },
      }),
      h.deps,
    );
    await runFullSequence(api2);

    expect(adapter).toHaveBeenCalledTimes(2);
    expect(h.state.materializeCrudCalls).toBe(1);
    expect(h.state.truncateCalls).toEqual([]);
    const cacheHits = h.state.events.filter((e) => e.type === 'node-cache-hit').map((e) => e.nodeId);
    expect(cacheHits).toEqual(['planner', 's0-coder-r0']);
    rmSync(runDir, { recursive: true, force: true });
  });

  it('idempotencia preservada: re-validate no resume NAO incrementa a versao nem re-insere nodes', async () => {
    const adapter = vi.fn((input: RunNodeAgentInput) =>
      Promise.resolve(makeOkResult(input, `{"node":"${input.grants.nodeId}"}`)),
    );
    const h = makeHarness(adapter);
    const runDir = mkdtempSync(join(tmpdir(), 'dwf-s5-idem-'));

    const api1 = createWorkflowHostApi(makeCtx(runDir), h.deps);
    const plan = await runFullSequence(api1);

    const api2 = createWorkflowHostApi(
      makeCtx(runDir, {
        manifest: manifestWithDevNode(),
        priorMaterialized: {
          planVersion: plan.planVersion,
          planHash: plan.planHash,
          sprintNodeIds: [{ sprintId: 's0', nodeIds: ['s0-coder-r0'] }],
        },
      }),
      h.deps,
    );
    await api2.agent({ id: 'planner', agentId: 'a-scout', prompt: 'planeje as sprints' });
    const v2 = (await api2.validateSprintPlan(rawPlan())) as { plan: DynamicWorkflowSprintPlan };
    expect(v2.plan.planVersion).toBe(plan.planVersion);
    expect(v2.plan.planHash).toBe(plan.planHash);
    const out = (await api2.materializeSprintPlan(v2.plan)) as {
      sprints: Array<{ sprintId: string; nodeIds: string[] }>;
      planVersion: number;
    };
    expect(out.sprints).toEqual([{ sprintId: 's0', nodeIds: ['s0-coder-r0'] }]);
    expect(out.planVersion).toBe(plan.planVersion);
    expect(h.state.materializeCrudCalls).toBe(1);
    rmSync(runDir, { recursive: true, force: true });
  });

  it('REGRA MAXIMA: journal PERDIDO + plano novo divergente NAO crasha o materialize (guard anti-colisao bump-eia a versao)', async () => {
    const adapter = vi.fn((input: RunNodeAgentInput) =>
      Promise.resolve(makeOkResult(input, `{"node":"${input.grants.nodeId}"}`)),
    );
    const h = makeHarness(adapter);
    const runDir = mkdtempSync(join(tmpdir(), 'dwf-s5-collide-'));

    const api = createWorkflowHostApi(
      makeCtx(runDir, {
        manifest: manifestWithDevNode(),
        priorMaterialized: {
          planVersion: 1,
          planHash: 'hash-antigo-que-nao-bate',
          sprintNodeIds: [{ sprintId: 's0', nodeIds: ['s0-coder-r0'] }],
        },
      }),
      h.deps,
    );
    const v = (await api.validateSprintPlan(rawPlan())) as { ok: boolean; plan: DynamicWorkflowSprintPlan };
    expect(v.ok).toBe(true);
    expect(v.plan.planVersion).toBe(2);
    await expect(api.materializeSprintPlan(v.plan)).resolves.toMatchObject({ planVersion: 2 });
    expect(h.state.materializeCrudCalls).toBe(1);
    rmSync(runDir, { recursive: true, force: true });
  });
});
