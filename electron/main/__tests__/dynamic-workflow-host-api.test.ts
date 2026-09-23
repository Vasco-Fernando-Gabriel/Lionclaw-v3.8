import { describe, it, expect, vi } from 'vitest';
import {
  createWorkflowHostApi,
  createAgentSemaphore,
  WorkflowHostFatalError,
  isFinalGate,
  parseNodeOutput,
  clampAccess,
  clampList,
  clampFlag,
  clampCeiling,
  effectiveMaxConcurrentAgents,
  CODEX_NODE_CONCURRENCY_CEILING,
  defaultGreenCheckSpecs,
  greenCheckFindingOf,
  GREEN_CHECK_PSEUDO_GATE_ID,
  computeNodeInputHash,
  ADJUSTMENT_PROMPT_HEADER,
  type HostApiRunContext,
  type HostApiDeps,
  type HostApiCrud,
  type GateGate,
  type GreenCheckResult,
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
  DynamicWorkflowMessage,
  DynamicWorkflowMessageInsertInput,
  DynamicWorkflowGateDecision,
  DynamicWorkflowGateDecisionInsertInput,
  DynamicWorkflowArtifact,
  DynamicWorkflowArtifactInsertInput,
  DynamicWorkflowNodeCreateInput,
  DynamicWorkflowSprintPlan,
  MaterializeDynamicWorkflowSprintPlanInput,
  DynamicWorkflowJournalEntry,
  DynamicWorkflowJournalAppendInput,
} from '../dynamic-workflows/types';
import type { NodeRunResult, RunNodeAgentInput } from '../dynamic-workflows/workflow-agent-adapter';
import { resolveGateChecks, type GateCheckResolutionContext } from '../dynamic-workflows/workflow-gate-resolver';
import { runGateChecks as realRunGateChecks, type GateCheckSpec } from '../dynamic-workflows/workflow-gates';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface HostHarness {
  deps: HostApiDeps;
  state: {
    nodeRuns: Map<string, DynamicWorkflowNodeRun>;
    events: Array<{ type: string; nodeId?: string | null; payload?: unknown }>;
    messages: DynamicWorkflowMessage[];
    gateDecisions: DynamicWorkflowGateDecisionInsertInput[];
    artifacts: DynamicWorkflowArtifactInsertInput[];
    checkpointJson: string;
    spentUsd: number;
    runPatches: Array<Record<string, unknown>>;
    journal: DynamicWorkflowJournalEntry[];
  };
  resolveGate: (gateId: string, resolution: PendingGateResolution) => void;
}

function makeHostHarness(over?: {
  adapter?: (input: RunNodeAgentInput) => Promise<NodeRunResult>;
  onWriterCommit?: HostApiRunContext['onWriterNodeCompleted'];
  initialCheckpointJson?: string;
  initialJournal?: DynamicWorkflowJournalEntry[];
}): { harness: HostHarness } {
  const state: HostHarness['state'] = {
    nodeRuns: new Map(),
    events: [],
    messages: [],
    gateDecisions: [],
    artifacts: [],
    checkpointJson: over?.initialCheckpointJson ?? '{}',
    spentUsd: 0,
    runPatches: [],
    journal: over?.initialJournal ? [...over.initialJournal] : [],
  };
  let eventSeq = 0;
  let messageSeq = 0;

  const gateResolvers = new Map<string, (r: PendingGateResolution) => void>();

  const crud: HostApiCrud = {
    upsertNodeRun: (input: DynamicWorkflowNodeRunUpsertInput): DynamicWorkflowNodeRun => {
      const key = `${input.runId}:${input.nodeId}:${input.attempt}`;
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
      state.nodeRuns.set(key, nr);
      state.nodeRuns.set(input.id, nr);
      return nr;
    },
    updateNodeRun: (id: string, patch: DynamicWorkflowNodeRunPatch): void => {
      const nr = state.nodeRuns.get(id);
      if (!nr) return;
      Object.assign(nr, patch);
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
        createdAt: `2026-06-12T00:00:0${eventSeq % 10}.000Z`,
      };
    },
    insertMessage: (input: DynamicWorkflowMessageInsertInput): DynamicWorkflowMessage => {
      messageSeq += 1;
      const message: DynamicWorkflowMessage = {
        id: messageSeq,
        runId: input.runId,
        nodeId: input.nodeId ?? null,
        role: input.role,
        source: input.source,
        kind: input.kind,
        content: input.content,
        toolCallsJson: input.toolCallsJson ?? null,
        agentId: input.agentId ?? null,
        createdAt: '2026-06-12T00:00:00.000Z',
      };
      state.messages.push(message);
      return message;
    },
    insertGateDecision: (input: DynamicWorkflowGateDecisionInsertInput): DynamicWorkflowGateDecision => {
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
        createdAt: '2026-06-12T00:00:00.000Z',
      };
    },
    registerArtifact: (input: DynamicWorkflowArtifactInsertInput): DynamicWorkflowArtifact => {
      state.artifacts.push(input);
      return {
        id: input.id,
        runId: input.runId,
        nodeId: input.nodeId ?? null,
        kind: input.kind,
        path: input.path,
        sha256: input.sha256,
        metadataJson: input.metadataJson ?? '{}',
        createdAt: '2026-06-12T00:00:00.000Z',
      };
    },
    getRunCheckpoint: () => state.checkpointJson,
    persistRunCheckpoint: (_runId, checkpointJson) => {
      state.checkpointJson = checkpointJson;
    },
    addRunCost: (_runId, addUsd) => {
      state.spentUsd += addUsd;
    },
    patchRun: (_runId, patch) => {
      state.runPatches.push({ ...patch });
    },
    appendJournalEntry: (input: DynamicWorkflowJournalAppendInput) => {
      const idx = state.journal.findIndex((e) => e.callIndex === input.callIndex);
      const entry: DynamicWorkflowJournalEntry = {
        ...input,
        outputRef: input.outputRef ?? null,
        sideEffectKey: input.sideEffectKey ?? null,
        createdAt: '2026-06-12T00:00:00.000Z',
      };
      if (idx >= 0) state.journal[idx] = entry;
      else state.journal.push(entry);
    },
    listJournalEntries: () => [...state.journal].sort((a, b) => a.callIndex - b.callIndex),
    truncateJournalFrom: (_runId, fromIndex) => {
      state.journal = state.journal.filter((e) => e.callIndex < fromIndex);
    },
  };

  const gateGate: GateGate = {
    awaitDecision: (gateId) =>
      new Promise<PendingGateResolution>((resolve) => {
        gateResolvers.set(gateId, resolve);
      }),
  };

  const deps: HostApiDeps = {
    crud,
    gateGate,
    runNodeAgent: over?.adapter ? (input) => over.adapter!(input) : (input) => Promise.resolve(makeOkResult(input)),
    emit: (input) => state.events.push({ type: input.type, nodeId: input.nodeId, payload: input.payload }),
    generateId: (prefix) => `${prefix}_${state.nodeRuns.size}_${Math.random().toString(36).slice(2, 6)}`,
    now: () => '2026-06-12T00:00:00.000Z',
  };

  return {
    harness: {
      deps,
      state,
      resolveGate: (gateId, resolution) => {
        const r = gateResolvers.get(gateId);
        if (r) {
          gateResolvers.delete(gateId);
          r(resolution);
        }
      },
    },
  };
}

function makeOkResult(input: RunNodeAgentInput, output = '{"verdict":"ok","findings":[]}'): NodeRunResult {
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
      deniedTools: ['Bash', 'Write', 'Edit'],
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
    durationMs: 5,
  };
}

function minimalManifest(): DynamicWorkflowManifest {
  return {
    version: 1,
    name: 'test-wf',
    phases: [
      { id: 'Scout', name: 'Scout', order: 0 },
      { id: 'Implementar', name: 'Implementar', order: 1 },
      { id: 'Validar', name: 'Validar', order: 2 },
      { id: 'Gate', name: 'Gate', order: 3 },
    ],
    nodes: [
      {
        id: 'scout',
        type: 'agent',
        phaseId: 'Scout',
        agentId: 'a-scout',
        access: 'read-only',
        canResume: true,
        produces: ['scout'],
        consumes: [],
      },
      {
        id: 'coder',
        type: 'agent',
        phaseId: 'Implementar',
        agentId: 'a-coder',
        access: 'workspace-write',
        writeSet: ['src/**'],
        canResume: true,
        produces: ['impl'],
        consumes: ['scout'],
      },
      {
        id: 'v0',
        type: 'agent',
        phaseId: 'Validar',
        agentId: 'a-val',
        access: 'read-only',
        canResume: true,
        produces: ['v0'],
        consumes: ['impl'],
      },
      {
        id: 'v1',
        type: 'agent',
        phaseId: 'Validar',
        agentId: 'a-val',
        access: 'read-only',
        canResume: true,
        produces: ['v1'],
        consumes: ['impl'],
      },
      { id: 'gate-global', type: 'gate', phaseId: 'Gate', canResume: false, produces: [], consumes: [] },
    ],
    parallelism: { maxConcurrentAgents: 3, parallelWritersAllowed: false },
    gates: [{ id: 'gate-global', mode: 'human', blocks: ['delivery'] }],
    estimate: { minUsd: 0, maxUsd: 1, unknownCostNodes: [] },
  };
}

function makeCtx(over?: Partial<HostApiRunContext>): HostApiRunContext {
  const runDir = mkdtempSync(join(tmpdir(), 'dwf-hostapi-'));
  return {
    runId: 'run-1',
    manifest: minimalManifest(),
    workspaceRoot: runDir,
    runDir,
    abortSignal: new AbortController().signal,
    ...over,
  };
}

function eventsAsPersisted(harness: HostHarness): DynamicWorkflowEvent[] {
  return harness.state.events.map((e, i) => ({
    id: i + 1,
    runId: 'run-1',
    nodeId: e.nodeId ?? null,
    phaseId: null,
    seq: i + 1,
    type: e.type,
    payloadJson: JSON.stringify(e.payload ?? {}),
    createdAt: '2026-06-12T00:00:00.000Z',
  }));
}

const P1_VALIDATOR_OUTPUT = JSON.stringify({
  verdict: 'fail',
  findings: [{ severity: 'P1', where: 'src/a.ts:10', problem: 'faltou guard', fix: 'adicionar' }],
});

describe('workflow-host-api: orquestrador-driver S1 (D2 payloads aditivos + D1b gate de fronteira)', () => {
  it('D2: node-completed de validador carrega agentId/access/outputDigest/validatorVerdict/p*Count/findings; node-started carrega label', async () => {
    const { harness } = makeHostHarness({
      adapter: async (input) => makeOkResult(input, P1_VALIDATOR_OUTPUT),
    });
    const ctx = makeCtx();
    ctx.manifest.nodes.find((n) => n.id === 'v0')!.label = 'validar-spec';
    const api = createWorkflowHostApi(ctx, harness.deps);
    await api.agent({ id: 'v0', agentId: 'a-val', access: 'read-only', prompt: 'valide' });

    const started = harness.state.events.find((e) => e.type === 'node-started' && e.nodeId === 'v0')!.payload as Record<
      string,
      unknown
    >;
    expect(started.label).toBe('validar-spec');

    const completed = harness.state.events.find((e) => e.type === 'node-completed' && e.nodeId === 'v0')!
      .payload as Record<string, unknown>;
    expect(completed).toMatchObject({
      agentId: 'a-val',
      access: 'read-only',
      label: 'validar-spec',
      outputDigest: 'verdict=fail findings=1 P1=1 P2=0 P3=0',
      validatorVerdict: { verdict: 'fail', findingsTotal: 1, blockers: 1 },
      p1Count: 1,
      p2Count: 0,
      p3Count: 0,
      findings: [{ severity: 'P1', where: 'src/a.ts:10', problem: 'faltou guard' }],
    });
    expect(completed.durationMs).toBeDefined();
    expect(completed.costUsd).toBeDefined();
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('D2: contrato novo do hook writer ({ sha, touchedFiles }) -> touchedFiles/Total/Truncated + worktreeCommitSha no node-completed', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`);
    const { harness } = makeHostHarness();
    const ctx = makeCtx({
      onWriterNodeCompleted: async () => ({ sha: 'deadbeef', touchedFiles: many }),
    });
    const api = createWorkflowHostApi(ctx, harness.deps);
    await api.agent({
      id: 'coder',
      agentId: 'a-coder',
      access: 'workspace-write',
      writeSet: ['src/**'],
      prompt: 'implemente',
    });

    const completed = harness.state.events.find((e) => e.type === 'node-completed' && e.nodeId === 'coder')!
      .payload as Record<string, unknown>;
    expect(completed.access).toBe('workspace-write');
    expect(completed.worktreeCommitSha).toBe('deadbeef');
    expect(completed.touchedFiles).toHaveLength(50);
    expect(completed.touchedFilesTotal).toBe(60);
    expect(completed.touchedFilesTruncated).toBe(true);
    const { harness: h2 } = makeHostHarness();
    const ctx2 = makeCtx({ onWriterNodeCompleted: async () => null });
    const api2 = createWorkflowHostApi(ctx2, h2.deps);
    await api2.agent({
      id: 'coder',
      agentId: 'a-coder',
      access: 'workspace-write',
      writeSet: ['src/**'],
      prompt: 'implemente',
    });
    const c2 = h2.state.events.find((e) => e.type === 'node-completed' && e.nodeId === 'coder')!.payload as Record<
      string,
      unknown
    >;
    expect(c2).toMatchObject({
      worktreeCommitSha: null,
      touchedFiles: [],
      touchedFilesTotal: 0,
      touchedFilesTruncated: false,
    });
    rmSync(ctx.runDir, { recursive: true, force: true });
    rmSync(ctx2.runDir, { recursive: true, force: true });
  });

  it('D1b: fronteira NAO-verde (P1 aberto) abre gate boundary:<phase> ANTES do proximo agent(); approve continua; replay nao re-bloqueia', async () => {
    const { harness } = makeHostHarness({
      adapter: async (input) => makeOkResult(input, P1_VALIDATOR_OUTPUT),
    });
    harness.deps.crud.listEventsSince = (_runId, afterSeq) =>
      eventsAsPersisted(harness).filter((e) => e.seq > afterSeq);
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);

    await api.phase('Validar');
    expect(harness.state.events.some((e) => e.type === 'gate-blocked')).toBe(false);

    await api.agent({ id: 'v0', agentId: 'a-val', access: 'read-only', prompt: 'valide' });

    let settled = false;
    const pending = api.phase('Gate').then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    const gb = harness.state.events.find((e) => e.type === 'gate-blocked');
    expect(gb).toBeTruthy();
    expect(gb!.payload).toMatchObject({
      gateId: 'boundary:Gate',
      mode: 'orchestrator',
      boundary: 'Gate',
      semaphore: 'ATENCAO',
      openP1: 1,
    });
    const blockedPatch = harness.state.runPatches.find((p) => p.status === 'blocked');
    expect(blockedPatch).toBeTruthy();
    expect(JSON.parse(String(blockedPatch!.pendingDecisionJson)).pendingDecision).toMatchObject({
      type: 'gate',
      id: 'boundary:Gate',
    });
    expect(
      harness.state.events.some(
        (e) => e.type === 'phase-changed' && (e.payload as { phase?: string }).phase === 'Gate',
      ),
    ).toBe(false);

    harness.resolveGate('boundary:Gate', { decision: 'approve', approvedBy: 'orchestrator' });
    await pending;
    expect(settled).toBe(true);
    const types = harness.state.events.map((e) => e.type);
    const approvedIdx = types.indexOf('gate-approved');
    const phaseIdx = types.findIndex(
      (t, i) => t === 'phase-changed' && (harness.state.events[i]!.payload as { phase?: string }).phase === 'Gate',
    );
    expect(approvedIdx).toBeGreaterThan(-1);
    expect(phaseIdx).toBeGreaterThan(approvedIdx);
    expect(
      harness.state.gateDecisions.some(
        (d) => d.gateId === 'boundary:Gate' && d.mode === 'orchestrator' && d.decision === 'approved',
      ),
    ).toBe(true);
    expect(harness.state.runPatches.some((p) => p.status === 'running')).toBe(true);

    await api.phase('Scout');
    expect(harness.state.events.filter((e) => e.type === 'gate-blocked')).toHaveLength(1);

    const api2 = createWorkflowHostApi(makeCtx({ runDir: ctx.runDir, workspaceRoot: ctx.workspaceRoot }), harness.deps);
    await api2.phase('Validar');
    const out = await api2.agent({ id: 'v0', agentId: 'a-val', access: 'read-only', prompt: 'valide' });
    expect(typeof out).toBe('string');
    expect(JSON.parse(String(out))).toEqual(JSON.parse(P1_VALIDATOR_OUTPUT));
    const hit = harness.state.events.find((e) => e.type === 'node-cache-hit' && e.nodeId === 'v0');
    expect(hit).toBeTruthy();
    expect(hit!.payload).toMatchObject({ p1Count: 1, agentId: 'a-val', access: 'read-only' });
    await api2.phase('Gate');
    expect(harness.state.events.filter((e) => e.type === 'gate-blocked')).toHaveLength(1);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('D1b: writer sem green-check => SEM VEREDITO bloqueia; reject lanca fatal run-aborted (o runner pausa)', async () => {
    const { harness } = makeHostHarness();
    harness.deps.crud.listEventsSince = (_runId, afterSeq) =>
      eventsAsPersisted(harness).filter((e) => e.seq > afterSeq);
    const ctx = makeCtx({ onWriterNodeCompleted: async () => ({ sha: 'abc', touchedFiles: ['src/x.ts'] }) });
    const api = createWorkflowHostApi(ctx, harness.deps);
    await api.phase('Implementar');
    await api.agent({
      id: 'coder',
      agentId: 'a-coder',
      access: 'workspace-write',
      writeSet: ['src/**'],
      prompt: 'impl',
    });
    const pending = api.phase('Validar');
    await new Promise((r) => setTimeout(r, 0));
    const gb = harness.state.events.find((e) => e.type === 'gate-blocked');
    expect(gb!.payload).toMatchObject({ gateId: 'boundary:Validar', semaphore: 'SEM VEREDITO' });
    harness.resolveGate('boundary:Validar', {
      decision: 'reject',
      approvedBy: 'orchestrator',
      reason: 'rode o verificador',
    });
    await expect(pending).rejects.toMatchObject({ code: 'run-aborted' });
    expect(harness.state.events.some((e) => e.type === 'gate-rejected')).toBe(true);
    expect(harness.state.gateDecisions.some((d) => d.gateId === 'boundary:Validar' && d.decision === 'rejected')).toBe(
      true,
    );
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('5a: reject de boundary:* CONGELA a janela - wake-completed executed do turno que rejeitou NAO reseta; o replay re-alcanca a fronteira e REABRE o gate (novo juizo)', async () => {
    const { harness } = makeHostHarness();
    harness.deps.crud.listEventsSince = (_runId, afterSeq) =>
      eventsAsPersisted(harness).filter((e) => e.seq > afterSeq);
    const ctx = makeCtx({ onWriterNodeCompleted: async () => ({ sha: 'abc', touchedFiles: ['src/x.ts'] }) });
    const api = createWorkflowHostApi(ctx, harness.deps);
    await api.phase('Implementar');
    await api.agent({
      id: 'coder',
      agentId: 'a-coder',
      access: 'workspace-write',
      writeSet: ['src/**'],
      prompt: 'impl',
    });
    const pending = api.phase('Validar');
    await new Promise((r) => setTimeout(r, 0));
    harness.resolveGate('boundary:Validar', {
      decision: 'reject',
      approvedBy: 'orchestrator',
      reason: 'rode o verificador',
    });
    await expect(pending).rejects.toMatchObject({ code: 'run-aborted' });

    harness.state.events.push({
      type: 'wake-completed',
      nodeId: undefined,
      payload: { driveTurnId: 'run-1:1', outcome: 'executed' },
    });
    harness.state.events.push({ type: 'resume-requested', nodeId: undefined, payload: {} });

    const api2 = createWorkflowHostApi(makeCtx({ runDir: ctx.runDir, workspaceRoot: ctx.workspaceRoot }), harness.deps);
    await api2.phase('Implementar');
    await api2.agent({
      id: 'coder',
      agentId: 'a-coder',
      access: 'workspace-write',
      writeSet: ['src/**'],
      prompt: 'impl',
    });
    let settled = false;
    const pending2 = api2.phase('Validar').then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    const gates = harness.state.events.filter((e) => e.type === 'gate-blocked');
    expect(gates).toHaveLength(2);
    expect(gates[1]!.payload).toMatchObject({ gateId: 'boundary:Validar', semaphore: 'SEM VEREDITO' });

    harness.resolveGate('boundary:Validar', { decision: 'approve', approvedBy: 'orchestrator' });
    await pending2;
    expect(settled).toBe(true);
    await api2.phase('Fim');
    expect(harness.state.events.filter((e) => e.type === 'gate-blocked')).toHaveLength(2);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('5a: resume-requested {acceptBoundary:true} apos reject reseta a janela: o replay NAO reabre o gate', async () => {
    const { harness } = makeHostHarness();
    harness.deps.crud.listEventsSince = (_runId, afterSeq) =>
      eventsAsPersisted(harness).filter((e) => e.seq > afterSeq);
    const ctx = makeCtx({ onWriterNodeCompleted: async () => ({ sha: 'abc', touchedFiles: ['src/x.ts'] }) });
    const api = createWorkflowHostApi(ctx, harness.deps);
    await api.phase('Implementar');
    await api.agent({
      id: 'coder',
      agentId: 'a-coder',
      access: 'workspace-write',
      writeSet: ['src/**'],
      prompt: 'impl',
    });
    const pending = api.phase('Validar');
    await new Promise((r) => setTimeout(r, 0));
    harness.resolveGate('boundary:Validar', { decision: 'reject', approvedBy: 'orchestrator' });
    await expect(pending).rejects.toMatchObject({ code: 'run-aborted' });
    harness.state.events.push({
      type: 'wake-completed',
      nodeId: undefined,
      payload: { driveTurnId: 'run-1:1', outcome: 'executed' },
    });
    harness.state.events.push({ type: 'resume-requested', nodeId: undefined, payload: { acceptBoundary: true } });

    const api2 = createWorkflowHostApi(makeCtx({ runDir: ctx.runDir, workspaceRoot: ctx.workspaceRoot }), harness.deps);
    await api2.phase('Implementar');
    await api2.agent({
      id: 'coder',
      agentId: 'a-coder',
      access: 'workspace-write',
      writeSet: ['src/**'],
      prompt: 'impl',
    });
    await api2.phase('Validar');
    expect(harness.state.events.filter((e) => e.type === 'gate-blocked')).toHaveLength(1);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('5b: fronteira re-alcancada com janela vazia/verde DESCARTA inbox e pendingDecision orfaos do boundary:* (gateGate.discardStaleGate), sem gate fantasma', async () => {
    const { harness } = makeHostHarness({ adapter: async (input) => makeOkResult(input, P1_VALIDATOR_OUTPUT) });
    harness.deps.crud.listEventsSince = (_runId, afterSeq) =>
      eventsAsPersisted(harness).filter((e) => e.seq > afterSeq);
    const discarded: string[] = [];
    harness.deps.gateGate.discardStaleGate = (gateId) => {
      discarded.push(gateId);
    };
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);
    await api.phase('Validar');
    await api.agent({ id: 'v0', agentId: 'a-val', access: 'read-only', prompt: 'valide' });
    const pending = api.phase('Gate');
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.state.events.filter((e) => e.type === 'gate-blocked')).toHaveLength(1);
    expect(discarded).toEqual([]);

    harness.resolveGate('boundary:Gate', { decision: 'approve', approvedBy: 'orchestrator' });
    await pending;
    harness.state.events.push({
      type: 'wake-completed',
      nodeId: undefined,
      payload: { driveTurnId: 'run-1:1', outcome: 'executed' },
    });
    const api2 = createWorkflowHostApi(makeCtx({ runDir: ctx.runDir, workspaceRoot: ctx.workspaceRoot }), harness.deps);
    await api2.phase('Validar');
    await api2.agent({ id: 'v0', agentId: 'a-val', access: 'read-only', prompt: 'valide' });
    await api2.phase('Gate');
    expect(harness.state.events.filter((e) => e.type === 'gate-blocked')).toHaveLength(1);
    expect(discarded).toEqual(['boundary:Gate']);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('D1b: sem leitor de eventos (fakes legados) phase() so emite phase-changed (sem gate)', async () => {
    const { harness } = makeHostHarness({ adapter: async (input) => makeOkResult(input, P1_VALIDATOR_OUTPUT) });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);
    await api.phase('Validar');
    await api.agent({ id: 'v0', agentId: 'a-val', access: 'read-only', prompt: 'valide' });
    await api.phase('Gate');
    expect(harness.state.events.some((e) => e.type === 'gate-blocked')).toBe(false);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('workflow-host-api: agent()', () => {
  it('feliz: persiste node_run running -> completed com policy snapshot (AC-16)', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);

    const out = await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'mapeie' });
    expect(out).toBe('{"verdict":"ok","findings":[]}');

    const runs = [...harness.state.nodeRuns.values()].filter((n) => n.nodeId === 'scout');
    const completed = runs.find((n) => n.status === 'completed');
    expect(completed).toBeTruthy();
    expect(completed!.policyHash).toBe('hash-scout');
    expect(JSON.parse(completed!.policySnapshotJson).access).toBe('read-only');
    expect(harness.state.events.some((e) => e.type === 'node-completed' && e.nodeId === 'scout')).toBe(true);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('persiste a saida final autoritativa e remapeia o offset da tool', async () => {
    const { harness } = makeHostHarness({
      adapter: async (input) => {
        input.onStreamChunk?.({ type: 'text', content: 'resposta' });
        input.onStreamChunk?.({ type: 'tool_call_start', toolName: 'Read', content: '{}' });
        input.onStreamChunk?.({ type: 'tool_call', toolName: 'Read', content: '{"ok":true}' });
        return makeOkResult(input, 'prefixo resposta');
      },
    });
    harness.deps.emitStreamChunk = vi.fn();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);

    await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'mapeie' });

    expect(harness.state.messages).toHaveLength(1);
    expect(harness.state.messages[0].content).toBe('prefixo resposta');
    expect(JSON.parse(harness.state.messages[0].toolCallsJson ?? '[]')).toEqual([
      expect.objectContaining({
        tool: 'Read',
        textOffset: 'prefixo resposta'.length,
        status: 'done',
      }),
    ]);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('falha recuperavel -> retorna null e marca node failed (AC-8)', async () => {
    const { harness } = makeHostHarness({
      adapter: (input) =>
        Promise.resolve({
          ...makeOkResult(input),
          ok: false,
          output: '',
          failureClass: 'provider-limit',
          errorMessage: 'rate limit',
        }),
    });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);

    const out = await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'x' });
    expect(out).toBeNull();
    const failed = [...harness.state.nodeRuns.values()].find((n) => n.nodeId === 'scout' && n.status === 'failed');
    expect(failed).toBeTruthy();
    expect(failed!.failureClass).toBe('provider-limit');
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('node fora do manifest -> erro estrutural (WorkflowHostFatalError)', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);
    await expect(api.agent({ id: 'ghost-r9', agentId: 'a', access: 'read-only', prompt: 'x' })).rejects.toBeInstanceOf(
      WorkflowHostFatalError,
    );
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('write fora do writeSet falha o node via onWriterNodeCompleted (AC-5)', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx({
      onWriterNodeCompleted: async () => {
        throw new Error('tocou arquivo fora do writeSet: vendor/x.ts');
      },
    });
    const api = createWorkflowHostApi(ctx, harness.deps);
    const out = await api.agent({
      id: 'coder',
      agentId: 'a-coder',
      access: 'workspace-write',
      writeSet: ['src/**'],
      prompt: 'implemente',
    });
    expect(out).toBeNull();
    const failed = [...harness.state.nodeRuns.values()].find((n) => n.nodeId === 'coder' && n.status === 'failed');
    expect(failed).toBeTruthy();
    expect(
      harness.state.events.some(
        (e) => e.type === 'node-failed' && (e.payload as { reason?: string })?.reason === 'writeset-violation',
      ),
    ).toBe(true);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('workflow-host-api: forced structured output (SPEC-010 sec 3/5.1, S08)', () => {
  it('node COM schemaRef: resolve o schema, passa ao adapter e devolve structuredOutput', async () => {
    let received: RunNodeAgentInput | undefined;
    const structured = { sprints: [{ id: 's0', index: 0 }] };
    const { harness } = makeHostHarness({
      adapter: (input) => {
        received = input;
        return Promise.resolve({
          ...makeOkResult(input, 'texto cru ignorado'),
          structuredOutput: structured,
        });
      },
    });
    const manifestWithSchema = {
      ...minimalManifest(),
      nodes: minimalManifest().nodes.map((n) => (n.id === 'scout' ? { ...n, schemaRef: 'plan.schema.json' } : n)),
    };
    const ctx = makeCtx({
      manifest: manifestWithSchema,
      resolveSchemaRef: (ref) =>
        ref === 'plan.schema.json' ? { name: 'plan', type: 'object', required: ['sprints'] } : null,
    });
    const api = createWorkflowHostApi(ctx, harness.deps);

    const out = await api.agent({
      id: 'scout',
      agentId: 'a-scout',
      access: 'read-only',
      schema: 'plan.schema.json',
      prompt: 'planeje',
    });
    expect(out).toEqual(structured);
    expect(received?.outputSchema).toEqual({ name: 'plan', type: 'object', required: ['sprints'] });
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('node SEM schemaRef: adapter nao recebe outputSchema; parseNodeOutput do texto', async () => {
    let received: RunNodeAgentInput | undefined;
    const { harness } = makeHostHarness({
      adapter: (input) => {
        received = input;
        return Promise.resolve(makeOkResult(input, '{"verdict":"ok","findings":[]}'));
      },
    });
    const ctx = makeCtx({
      resolveSchemaRef: () => ({ name: 'x', type: 'object', required: [] }),
    });
    const api = createWorkflowHostApi(ctx, harness.deps);

    const out = await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'mapeie' });
    expect(received?.outputSchema).toBeUndefined();
    expect(out).toBe('{"verdict":"ok","findings":[]}');
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('schemaRef declarado mas SEM resolveSchemaRef no ctx: caminho legado (texto cru)', async () => {
    let received: RunNodeAgentInput | undefined;
    const { harness } = makeHostHarness({
      adapter: (input) => {
        received = input;
        return Promise.resolve(makeOkResult(input, '{"verdict":"ok","findings":[]}'));
      },
    });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);

    const out = await api.agent({
      id: 'scout',
      agentId: 'a-scout',
      access: 'read-only',
      schema: 'plan.schema.json',
      prompt: 'planeje',
    });
    expect(received?.outputSchema).toBeUndefined();
    expect(out).toBe('{"verdict":"ok","findings":[]}');
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('falha de schema do adapter -> node failed, retorna null (AC-6)', async () => {
    const { harness } = makeHostHarness({
      adapter: (input) =>
        Promise.resolve({
          ...makeOkResult(input),
          ok: false,
          output: '{"foo":1}',
          failureClass: 'schema',
          errorMessage: 'output fora do schema: chave obrigatoria ausente: "sprints"',
        }),
    });
    const ctx = makeCtx({
      resolveSchemaRef: () => ({ name: 'plan', type: 'object', required: ['sprints'] }),
    });
    const api = createWorkflowHostApi(ctx, harness.deps);

    const out = await api.agent({
      id: 'scout',
      agentId: 'a-scout',
      access: 'read-only',
      schema: 'plan.schema.json',
      prompt: 'planeje',
    });
    expect(out).toBeNull();
    const failed = [...harness.state.nodeRuns.values()].find((n) => n.nodeId === 'scout' && n.status === 'failed');
    expect(failed?.failureClass).toBe('schema');
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('workflow-host-api: parallel() e pipeline()', () => {
  it('parallel(): barrier espera todos e mantem a ordem', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);

    const results = await api.parallel({
      thunks: [async () => 'a', async () => 'b', async () => 'c'],
      options: { id: 'validators-r0', maxConcurrency: 3 },
    });
    expect(results).toEqual(['a', 'b', 'c']);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('parallel() failFast cancela os pendentes no primeiro erro', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);
    let thirdRan = false;
    const results = (await api.parallel({
      thunks: [
        async () => {
          throw new Error('boom');
        },
        async () => 'b',
        async () => {
          thirdRan = true;
          return 'c';
        },
      ],
      options: { id: 'g', maxConcurrency: 1, failFast: true },
    })) as unknown[];
    expect(results[0]).toBeNull();
    expect(thirdRan).toBe(false);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('pipeline() SEM barrier: item 0 avanca de stage ANTES de item 1 terminar a stage anterior (7.3)', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx({
      manifest: { ...minimalManifest(), parallelism: { maxConcurrentAgents: 4, parallelWritersAllowed: false } },
    });
    const api = createWorkflowHostApi(ctx, harness.deps);

    const order: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const stage1 = async (prev: unknown, _item: unknown, index: number): Promise<unknown> => {
      await sleep(index === 1 ? 60 : 5);
      order.push(`s1:item${index}`);
      return prev;
    };
    const stage2 = async (prev: unknown, _item: unknown, index: number): Promise<unknown> => {
      order.push(`s2:item${index}`);
      return prev;
    };

    await api.pipeline({ items: ['x', 'y'], stages: [stage1, stage2] });

    const s2item0 = order.indexOf('s2:item0');
    const s1item1 = order.indexOf('s1:item1');
    expect(s2item0).toBeGreaterThanOrEqual(0);
    expect(s1item1).toBeGreaterThanOrEqual(0);
    expect(s2item0).toBeLessThan(s1item1);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('pipeline() in-process passa (prevResult, originalItem, index) a cada stage, igual ao child real (fechamento S3)', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);

    const seen: Array<{ stage: number; prev: unknown; item: unknown; index: number }> = [];
    const stage1 = (prev: unknown, item: unknown, index: number): unknown => {
      seen.push({ stage: 1, prev, item, index });
      return `s1(${String(prev)})`;
    };
    const stage2 = (prev: unknown, item: unknown, index: number): unknown => {
      seen.push({ stage: 2, prev, item, index });
      return `s2(${String(prev)})`;
    };

    const results = (await api.pipeline({ items: ['a', 'b'], stages: [stage1, stage2] })) as unknown[];

    expect(seen).toContainEqual({ stage: 1, prev: 'a', item: 'a', index: 0 });
    expect(seen).toContainEqual({ stage: 2, prev: 's1(a)', item: 'a', index: 0 });
    expect(seen).toContainEqual({ stage: 1, prev: 'b', item: 'b', index: 1 });
    expect(seen).toContainEqual({ stage: 2, prev: 's1(b)', item: 'b', index: 1 });
    expect(results).toEqual(['s2(s1(a))', 's2(s1(b))']);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('createAgentSemaphore (teto global do host, SPEC 7.3 secao 9)', () => {
  it('serializa para no maximo `max` execucoes concorrentes (FIFO)', async () => {
    const sem = createAgentSemaphore(2);
    let active = 0;
    let maxActive = 0;
    const release: Array<() => void> = [];
    const gate = (i: number) =>
      sem.run(
        () =>
          new Promise<number>((resolve) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            release[i] = () => {
              active -= 1;
              resolve(i);
            };
          }),
      );

    const p0 = gate(0);
    const p1 = gate(1);
    const p2 = gate(2);
    await new Promise((r) => setTimeout(r, 10));
    expect(active).toBe(2);
    expect(maxActive).toBe(2);
    release[0]();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(maxActive).toBe(2);
    release[1]();
    release[2]();
    await Promise.all([p0, p1, p2]);
    expect(maxActive).toBe(2);
  });

  it('max <= 0 vira serializacao total (1), nunca ilimitado', async () => {
    const sem = createAgentSemaphore(0);
    let active = 0;
    let maxActive = 0;
    const run = () =>
      sem.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      });
    await Promise.all([run(), run(), run(), run()]);
    expect(maxActive).toBe(1);
  });

  it('libera o slot mesmo quando fn lanca (finally)', async () => {
    const sem = createAgentSemaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const ok = await sem.run(async () => 'ok');
    expect(ok).toBe('ok');
  });
});

describe('workflow-host-api: parallel() in-process respeita o cap (dead-path; teto real coberto pelo e2e de fork + unit do semaforo) (DEFECT-1 F1)', () => {
  function manifestWithValidators(maxConcurrentAgents: number): DynamicWorkflowManifest {
    const base = minimalManifest();
    const valNodes = ['va', 'vb', 'vc', 'vd'].map((id) => ({
      id,
      type: 'agent' as const,
      phaseId: 'Validar',
      agentId: 'a-val',
      access: 'read-only' as const,
      canResume: true,
      produces: [id],
      consumes: ['impl'],
    }));
    return {
      ...base,
      nodes: [...base.nodes, ...valNodes],
      parallelism: { maxConcurrentAgents, parallelWritersAllowed: false },
    };
  }

  it('runParallel in-process com maxConcurrentAgents=2 e SEM maxConcurrency nao passa de 2 (cap do proprio runParallel; teto real do filho no e2e de fork)', async () => {
    let active = 0;
    let maxActive = 0;
    const { harness } = makeHostHarness({
      adapter: async (input) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return makeOkResult(input);
      },
    });
    const ctx = makeCtx({ manifest: manifestWithValidators(2) });
    const api = createWorkflowHostApi(ctx, harness.deps);

    const results = await api.parallel({
      thunks: [
        () => api.agent({ id: 'va', agentId: 'a-val', access: 'read-only', prompt: 'x' }),
        () => api.agent({ id: 'vb', agentId: 'a-val', access: 'read-only', prompt: 'x' }),
        () => api.agent({ id: 'vc', agentId: 'a-val', access: 'read-only', prompt: 'x' }),
        () => api.agent({ id: 'vd', agentId: 'a-val', access: 'read-only', prompt: 'x' }),
      ],
      options: { id: 'validators-r0' },
    });
    expect((results as unknown[]).length).toBe(4);
    expect(maxActive).toBe(2);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('runParallel in-process com maxConcurrentAgents=1 serializa por completo (cap do runParallel; teto real no e2e de fork)', async () => {
    let active = 0;
    let maxActive = 0;
    const { harness } = makeHostHarness({
      adapter: async (input) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return makeOkResult(input);
      },
    });
    const ctx = makeCtx({ manifest: manifestWithValidators(1) });
    const api = createWorkflowHostApi(ctx, harness.deps);
    await api.parallel({
      thunks: [
        () => api.agent({ id: 'va', agentId: 'a-val', access: 'read-only', prompt: 'x' }),
        () => api.agent({ id: 'vb', agentId: 'a-val', access: 'read-only', prompt: 'x' }),
        () => api.agent({ id: 'vc', agentId: 'a-val', access: 'read-only', prompt: 'x' }),
      ],
      options: { id: 'g', maxConcurrency: 3 },
    });
    expect(maxActive).toBe(1);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('workflow-host-api: gate()', () => {
  it('gate auto resolve na hora com os checks deterministicos', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx({
      manifest: {
        ...minimalManifest(),
        gates: [{ id: 'gate-auto', mode: 'auto', blocks: [] }],
        nodes: [
          ...minimalManifest().nodes.filter((n) => n.type !== 'gate'),
          { id: 'gate-auto', type: 'gate', phaseId: 'Gate', canResume: false, produces: [], consumes: [] },
        ],
      },
    });
    const api = createWorkflowHostApi(ctx, harness.deps);
    const decision = (await api.gate({
      id: 'gate-auto',
      mode: 'auto',
      checks: [{ kind: 'schema', id: 'c1', value: { verdict: 'ok' }, requiredKeys: ['verdict'] }],
    })) as { ok: boolean };
    expect(decision.ok).toBe(true);
    expect(harness.state.gateDecisions.some((d) => d.gateId === 'gate-auto' && d.decision === 'approved')).toBe(true);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('gate human BLOQUEIA o run e resolve quando aprovado (AC-9)', async () => {
    const { harness } = makeHostHarness();
    let finalApproved: { gateId: string; approvedBy: string } | null = null;
    const ctx = makeCtx({
      onFinalGateApproved: async (gateId, approvedBy) => {
        finalApproved = { gateId, approvedBy };
      },
    });
    const api = createWorkflowHostApi(ctx, harness.deps);

    const gatePromise = api.gate({ id: 'gate-global', mode: 'human', checks: [] }) as Promise<{
      ok: boolean;
      approvedBy?: string;
    }>;
    await Promise.resolve();
    expect(harness.state.runPatches.some((p) => p.status === 'blocked')).toBe(true);

    harness.resolveGate('gate-global', { decision: 'approve', approvedBy: 'humano' });
    const decision = await gatePromise;
    expect(decision.ok).toBe(true);
    expect(decision.approvedBy).toBe('humano');
    expect(finalApproved).toEqual({ gateId: 'gate-global', approvedBy: 'humano' });
    expect(harness.state.gateDecisions.some((d) => d.gateId === 'gate-global' && d.decision === 'approved')).toBe(true);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('gate human rejeitado lanca erro fatal de gate', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);
    const gatePromise = api.gate({ id: 'gate-global', mode: 'human', checks: [] });
    await Promise.resolve();
    harness.resolveGate('gate-global', { decision: 'reject', approvedBy: 'humano' });
    await expect(gatePromise).rejects.toBeInstanceOf(WorkflowHostFatalError);
    expect(harness.state.gateDecisions.some((d) => d.decision === 'rejected')).toBe(true);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  function deliveryGateManifest() {
    const base = minimalManifest();
    return {
      ...base,
      gates: [{ id: 'gate-delivery', mode: 'human' as const, kind: 'delivery' as const, blocks: ['delivery'] }],
      nodes: [
        ...base.nodes.filter((n) => n.type !== 'gate'),
        { id: 'gate-delivery', type: 'gate' as const, phaseId: 'Gate', canResume: false, produces: [], consumes: [] },
      ],
    };
  }
  const RED_CHECK = { kind: 'schema', id: 'c-test', value: {}, requiredKeys: ['needsThis'] };

  it('BACKSTOP: gate de ENTREGA com checks VERMELHOS volta pro dev (redev), nao bloqueia humano', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx({ manifest: deliveryGateManifest() });
    const api = createWorkflowHostApi(ctx, harness.deps);
    const decision = (await api.gate({
      id: 'gate-delivery',
      mode: 'human',
      kind: 'delivery',
      checks: [RED_CHECK],
    })) as { ok: boolean; decisionPayload?: { action?: string }; reason?: string };
    expect(decision.decisionPayload?.action).toBe('redev');
    expect(decision.reason).toContain('reprovou nos checks');
    expect(harness.state.runPatches.some((p) => p.status === 'blocked')).toBe(false);
    expect(
      harness.state.gateDecisions.some(
        (d) => d.gateId === 'gate-delivery' && d.decision === 'rejected' && d.decidedBy === 'auto-checks',
      ),
    ).toBe(true);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('BACKSTOP: gate de ENTREGA vermelho com escalateIfRed ESCALA pro humano (apos MAX redev)', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx({ manifest: deliveryGateManifest() });
    const api = createWorkflowHostApi(ctx, harness.deps);
    const gatePromise = api.gate({
      id: 'gate-delivery',
      mode: 'human',
      kind: 'delivery',
      escalateIfRed: true,
      checks: [RED_CHECK],
    }) as Promise<{ ok: boolean }>;
    await Promise.resolve();
    expect(harness.state.runPatches.some((p) => p.status === 'blocked')).toBe(true);
    harness.resolveGate('gate-delivery', { decision: 'approve', approvedBy: 'humano' });
    await gatePromise;
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('workflow-host-api: resolucao simbolico->concreto dos checks de gate (P1)', () => {
  const fakeCmd =
    (status: number, stdout = '', stderr = '') =>
    () => ({ status, stdout, stderr, timedOut: false });

  function ctxWithResolver(rc: GateCheckResolutionContext, over?: Partial<HostApiRunContext>): HostApiRunContext {
    return makeCtx({
      manifest: {
        ...minimalManifest(),
        gates: [{ id: 'gate-auto', mode: 'auto', blocks: [] }],
        nodes: [
          ...minimalManifest().nodes.filter((n) => n.type !== 'gate'),
          { id: 'gate-auto', type: 'gate', phaseId: 'Gate', canResume: false, produces: [], consumes: [] },
        ],
      },
      resolveGateChecks: (checks) => resolveGateChecks(checks, rc),
      ...over,
    });
  }

  it('checks simbolicos do template resolvem e o gate auto APROVA com fakes verdes', async () => {
    const { harness } = makeHostHarness();
    const rc: GateCheckResolutionContext = {
      repoRoot: '/repo',
      protectedPaths: ['electron/main/agent-runtime'],
      touchedFiles: ['src/foo.ts'],
      nodeOutputs: { v0: { verdict: 'pass', findings: [] }, v1: { verdict: 'pass', findings: [] } },
      defaultSchemaRequiredKeys: ['verdict', 'findings'],
      baselineMaxErrorsByCommand: { 'npm run test': 63 },
    };
    const ctx = ctxWithResolver(rc);
    const deps = {
      ...harness.deps,
      runGateChecks: ((checks: GateCheckSpec[], mode: 'auto' | 'orchestrator' | 'human') =>
        realRunGateChecks(checks, mode, { runCommand: fakeCmd(0) })) as typeof realRunGateChecks,
    };
    const api = createWorkflowHostApi(ctx, deps);

    const decision = (await api.gate({
      id: 'gate-auto',
      mode: 'auto',
      checks: [
        { kind: 'schema', nodeIds: ['v0', 'v1'] },
        { kind: 'command', command: 'npm run typecheck', maxErrors: 123 },
        { kind: 'command', command: 'npm run test', baselineRef: 'context-bundle.baselineResults' },
        { kind: 'containment', protectedPaths: 'context-bundle.protectedPaths' },
      ],
    })) as { ok: boolean; checks: Array<{ ok: boolean; kind: string }> };

    expect(decision.ok).toBe(true);
    expect(decision.checks).toHaveLength(5);
    expect(decision.checks.every((c) => c.ok)).toBe(true);
    expect(harness.state.gateDecisions.some((d) => d.gateId === 'gate-auto' && d.decision === 'approved')).toBe(true);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('gate auto REPROVA quando o containment simbolico resolve para um protected tocado', async () => {
    const { harness } = makeHostHarness();
    const rc: GateCheckResolutionContext = {
      repoRoot: '/repo',
      protectedPaths: ['electron/main/agent-runtime'],
      touchedFiles: ['electron/main/agent-runtime/execute.ts'], // VIOLA
      nodeOutputs: {},
    };
    const ctx = ctxWithResolver(rc);
    const api = createWorkflowHostApi(ctx, harness.deps);
    await expect(
      api.gate({
        id: 'gate-auto',
        mode: 'auto',
        checks: [{ kind: 'containment', protectedPaths: 'context-bundle.protectedPaths' }],
      }),
    ).rejects.toMatchObject({ code: 'gate-rejected' });
    expect(harness.state.gateDecisions.some((d) => d.gateId === 'gate-auto' && d.decision === 'rejected')).toBe(true);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('workflow-host-api: custo ILIMITADO por desenho (refatoracao 2026-08-27) - custo nunca trava', () => {
  it('custo acumulado ENORME nao bloqueia o dispatch: agent() roda e o run nunca vira blocked', async () => {
    const { harness } = makeHostHarness();
    harness.state.spentUsd = 1_000_000;
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);
    await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'x' });
    expect(harness.state.runPatches.some((p) => p.status === 'blocked')).toBe(false);
    expect(harness.state.runPatches.some((p) => p.pendingDecisionJson !== undefined)).toBe(false);
    expect([...harness.state.nodeRuns.values()].some((n) => n.nodeId === 'scout' && n.status === 'completed')).toBe(
      true,
    );
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('a host API nao expoe primitiva budget (custo ilimitado por desenho)', () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);
    expect('budget' in api).toBe(false);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('workflow-host-api: resume por journal ordenado (SPEC-010 F2 sec 3.2 / 10.1)', () => {
  function manifestScoutSchema(ref: string): DynamicWorkflowManifest {
    const base = minimalManifest();
    return {
      ...base,
      nodes: base.nodes.map((n) => (n.id === 'scout' ? { ...n, schemaRef: ref } : n)),
    };
  }

  it('prefixo intacto reusa o OUTPUT REAL do checkpoint (nao marcador, adapter nao roda 2x)', async () => {
    const agentId = 'a-scout';
    const manifest = manifestScoutSchema('schemas/scout.json');
    const adapter = vi.fn((input: RunNodeAgentInput) =>
      Promise.resolve(makeOkResult(input, '{"verdict":"REAL-OUTPUT","findings":["a","b"]}')),
    );
    const { harness } = makeHostHarness({ adapter });
    const ctx = makeCtx({ manifest });

    const api1 = createWorkflowHostApi(ctx, harness.deps);
    const out1 = await api1.agent({
      id: 'scout',
      agentId,
      access: 'read-only',
      schema: 'schemas/scout.json',
      prompt: 'mapeie',
    });
    expect(adapter).toHaveBeenCalledTimes(1);
    expect((out1 as { verdict?: string }).verdict).toBe('REAL-OUTPUT');
    expect(harness.state.journal.length).toBe(1);
    expect(harness.state.journal[0].nodeId).toBe('scout');
    expect(harness.state.journal[0].outputRef).toBe('scout#1');

    const api2 = createWorkflowHostApi(ctx, harness.deps);
    const out2 = await api2.agent({
      id: 'scout',
      agentId,
      access: 'read-only',
      schema: 'schemas/scout.json',
      prompt: 'mapeie',
    });
    expect(adapter).toHaveBeenCalledTimes(1);
    expect((out2 as { verdict?: string }).verdict).toBe('REAL-OUTPUT');
    expect((out2 as { cached?: boolean }).cached).toBeUndefined();
    expect(harness.state.events.some((e) => e.type === 'node-cache-hit')).toBe(true);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('schemaRef CANONICO diferente no resume desvia o prefixo e re-executa (sufixo invalido)', async () => {
    const agentId = 'a-scout';
    const adapter = vi.fn((input: RunNodeAgentInput) => Promise.resolve(makeOkResult(input)));
    const { harness } = makeHostHarness({ adapter });

    const ctxOld = makeCtx({ manifest: manifestScoutSchema('schemas/old.json') });
    const api1 = createWorkflowHostApi(ctxOld, harness.deps);
    await api1.agent({ id: 'scout', agentId, access: 'read-only', schema: 'schemas/old.json', prompt: 'mapeie' });
    expect(adapter).toHaveBeenCalledTimes(1);

    const ctxNew = makeCtx({ manifest: manifestScoutSchema('schemas/new.json'), runDir: ctxOld.runDir });
    const api2 = createWorkflowHostApi(ctxNew, harness.deps);
    await api2.agent({ id: 'scout', agentId, access: 'read-only', schema: 'schemas/new.json', prompt: 'mapeie' });
    expect(adapter).toHaveBeenCalledTimes(2);
    rmSync(ctxOld.runDir, { recursive: true, force: true });
  });

  it('agentId diferente no resume desvia o prefixo e re-executa (nunca herda silencioso)', async () => {
    function manifestScoutAgent(agent: string): DynamicWorkflowManifest {
      const base = minimalManifest();
      return {
        ...base,
        nodes: base.nodes.map((n) => (n.id === 'scout' ? { ...n, agentId: agent } : n)),
      };
    }
    const adapter = vi.fn((input: RunNodeAgentInput) => Promise.resolve(makeOkResult(input)));
    const { harness } = makeHostHarness({ adapter });

    const ctxOld = makeCtx({ manifest: manifestScoutAgent('a-old') });
    const api1 = createWorkflowHostApi(ctxOld, harness.deps);
    await api1.agent({ id: 'scout', agentId: 'a-old', access: 'read-only', prompt: 'mapeie' });
    expect(adapter).toHaveBeenCalledTimes(1);

    const ctxNew = makeCtx({ manifest: manifestScoutAgent('a-new'), runDir: ctxOld.runDir });
    const api2 = createWorkflowHostApi(ctxNew, harness.deps);
    await api2.agent({ id: 'scout', agentId: 'a-new', access: 'read-only', prompt: 'mapeie' });
    expect(adapter).toHaveBeenCalledTimes(2);
    rmSync(ctxOld.runDir, { recursive: true, force: true });
  });
});

describe('workflow-host-api: helpers puros', () => {
  it('isFinalGate reconhece gate-global e o ultimo gate humano', () => {
    const m = minimalManifest();
    expect(isFinalGate(m.gates[0], m)).toBe(true);
    expect(isFinalGate({ id: 'x', mode: 'auto', blocks: [] }, m)).toBe(false);
  });

  it('parseNodeOutput parseia JSON e envelopa texto livre', () => {
    expect(parseNodeOutput('{"a":1}')).toEqual({ a: 1 });
    expect(parseNodeOutput('texto')).toEqual({ output: 'texto' });
    expect(parseNodeOutput('')).toEqual({ output: '' });
  });

  it('phase() fora de meta.phases registra on-the-fly (meta.phases e advisory)', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);
    await expect(api.phase('NaoExiste')).resolves.toBeUndefined();
    expect(ctx.manifest.phases.some((p) => p.id === 'NaoExiste')).toBe(true);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('workflow-host-api: phase() on-the-fly (F1c)', () => {
  it('phase() com nome NOVO registra on-the-fly sem erro e entra em manifest.phases', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);

    await expect(api.phase('FaseNova')).resolves.toBeUndefined();

    const registrada = ctx.manifest.phases.find((p) => p.id === 'FaseNova');
    expect(registrada).toEqual({ id: 'FaseNova', name: 'FaseNova', order: 4 });
    expect(harness.state.runPatches.some((p) => p.currentPhaseId === 'FaseNova')).toBe(true);
    expect(harness.state.events.some((e) => e.type === 'phase-changed')).toBe(true);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('fase ja declarada nao duplica; fase nova repetida e idempotente', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);

    await api.phase('Scout');
    expect(ctx.manifest.phases).toHaveLength(4);

    await api.phase('FaseExtra');
    await api.phase('FaseExtra');
    expect(ctx.manifest.phases.filter((p) => p.id === 'FaseExtra')).toHaveLength(1);
    expect(ctx.manifest.phases).toHaveLength(5);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('phase() sem nome (vazio) ainda lanca fatal (nao registra lixo)', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);
    await expect(api.phase('')).rejects.toBeInstanceOf(WorkflowHostFatalError);
    await expect(api.phase({})).rejects.toBeInstanceOf(WorkflowHostFatalError);
    expect(ctx.manifest.phases).toHaveLength(4);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('clamp helpers (manifest = teto, SPEC 8.3 / DEFECT-6 ITEM 2)', () => {
  it('clampAccess: read-only(manifest) nunca sobe para workspace-write(arg)', () => {
    expect(clampAccess('workspace-write', 'read-only')).toBe('read-only');
    expect(clampAccess('workspace-write', undefined)).toBe('read-only');
    expect(clampAccess('workspace-write', 'workspace-write')).toBe('workspace-write');
    expect(clampAccess('read-only', 'workspace-write')).toBe('read-only');
    expect(clampAccess(undefined, 'workspace-write')).toBe('read-only');
  });

  it('clampList: arg so intersecta o teto do manifest (ordem do manifest)', () => {
    expect(clampList(['Read', 'Write', 'Bash'], ['Read', 'Grep'])).toEqual(['Read']);
    expect(clampList(['Read', 'Write'], undefined)).toEqual([]);
    expect(clampList(['Read', 'Write'], [])).toEqual([]);
    expect(clampList(undefined, ['Read', 'Grep'])).toEqual(['Read', 'Grep']);
    expect(clampList(['Grep', 'Read'], ['Read', 'Grep'])).toEqual(['Read', 'Grep']);
  });

  it('clampFlag: AND com o teto - arg true contra manifest sem o flag fica false', () => {
    expect(clampFlag(true, undefined)).toBe(false);
    expect(clampFlag(true, false)).toBe(false);
    expect(clampFlag(true, true)).toBe(true);
    expect(clampFlag(false, true)).toBe(false);
    expect(clampFlag(undefined, true)).toBe(true);
    expect(clampFlag(undefined, undefined)).toBe(false);
  });

  it('clampCeiling: arg so encolhe o teto de recurso, nunca o estende', () => {
    expect(clampCeiling(10_000, 5_000)).toBe(5_000);
    expect(clampCeiling(2_000, 5_000)).toBe(2_000);
    expect(clampCeiling(0, 5_000)).toBe(5_000);
    expect(clampCeiling(-1, 5_000)).toBe(5_000);
    expect(clampCeiling(3_000, undefined)).toBe(3_000);
    expect(clampCeiling(undefined, 5_000)).toBe(5_000);
    expect(clampCeiling(undefined, undefined)).toBeUndefined();
  });
});

describe('effectiveMaxConcurrentAgents (clamp de concorrencia, Fase A A5.2)', () => {
  function ctxWithMaxConcurrent(maxConcurrentAgents: number): HostApiRunContext {
    return makeCtx({
      manifest: {
        ...minimalManifest(),
        parallelism: { maxConcurrentAgents, parallelWritersAllowed: false },
      },
    });
  }

  it('teto = 3 (CODEX_NODE_CONCURRENCY_CEILING)', () => {
    expect(CODEX_NODE_CONCURRENCY_CEILING).toBe(3);
  });

  it('manifest=8 acima do teto -> clampa para 3', () => {
    const ctx = ctxWithMaxConcurrent(8);
    expect(effectiveMaxConcurrentAgents(ctx)).toBe(3);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('manifest=2 abaixo do teto -> inalterado (2)', () => {
    const ctx = ctxWithMaxConcurrent(2);
    expect(effectiveMaxConcurrentAgents(ctx)).toBe(2);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('manifest=3 no teto -> 3', () => {
    const ctx = ctxWithMaxConcurrent(3);
    expect(effectiveMaxConcurrentAgents(ctx)).toBe(3);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('runAgentNode: arg malicioso NAO escala alem do manifest (DEFECT-6 ITEM 2)', () => {
  function readOnlyScoutManifest(): DynamicWorkflowManifest {
    const base = minimalManifest();
    return {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === 'scout'
          ? {
              ...n,
              access: 'read-only' as const,
              allowedTools: ['Read', 'Grep'],
            }
          : n,
      ),
    };
  }

  it('access workspace-write + writeSet amplo + allowBash true contra manifest read-only => policy read-only/negada', async () => {
    let seenGrants: RunNodeAgentInput['grants'] | null = null;
    const { harness } = makeHostHarness({
      adapter: (input) => {
        seenGrants = input.grants;
        return Promise.resolve(makeOkResult(input));
      },
    });
    const ctx = makeCtx({ manifest: readOnlyScoutManifest() });
    const api = createWorkflowHostApi(ctx, harness.deps);

    await api.agent({
      id: 'scout',
      agentId: 'a-scout',
      access: 'workspace-write', // tenta virar writer
      allowedTools: ['Read', 'Grep', 'Write', 'Edit', 'Bash'], // tenta adicionar tools
      allowedMcpServers: ['lionclaw-agents', 'shopify'], // tenta MCP novo
      allowedCommands: ['rm -rf /'], // tenta comandos
      allowBash: true, // tenta bash
      allowNetwork: true, // tenta rede
      writeSet: ['**', '/etc/**'], // tenta writeSet amplo
      timeoutMs: 999_999_999, // tenta estourar o teto de tempo
      prompt: 'tente escalar',
    });

    expect(seenGrants).not.toBeNull();
    const g = seenGrants!;
    expect(g.access).toBe('read-only');
    expect(g.allowedTools).toEqual(['Read', 'Grep']);
    expect(g.allowedMcpServers ?? []).toEqual([]);
    expect(g.allowBash).toBe(false);
    expect(g.allowNetwork).toBe(false);
    expect(g.allowedCommands ?? []).toEqual([]);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('writer legitimo: arg pode ESTREITAR o writeSet do manifest, nunca ampliar', async () => {
    let seenInput: RunNodeAgentInput | null = null;
    const { harness } = makeHostHarness({
      adapter: (input) => {
        seenInput = input;
        return Promise.resolve(makeOkResult(input));
      },
    });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);

    await api.agent({
      id: 'coder',
      agentId: 'a-coder',
      access: 'workspace-write',
      writeSet: ['src/**', 'vendor/**'],
      prompt: 'implemente',
    });

    expect(seenInput).not.toBeNull();
    expect(seenInput!.grants.access).toBe('workspace-write');
    expect(seenInput!.writeSet).toEqual(['src/**']);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('writeSet amplo contra manifest read-only (sem writeSet) => writeSet vazio', async () => {
    let seenInput: RunNodeAgentInput | null = null;
    const { harness } = makeHostHarness({
      adapter: (input) => {
        seenInput = input;
        return Promise.resolve(makeOkResult(input));
      },
    });
    const ctx = makeCtx({ manifest: readOnlyScoutManifest() });
    const api = createWorkflowHostApi(ctx, harness.deps);

    await api.agent({
      id: 'scout',
      agentId: 'a-scout',
      access: 'workspace-write',
      writeSet: ['**'],
      prompt: 'x',
    });

    expect(seenInput).not.toBeNull();
    expect(seenInput!.writeSet).toEqual([]);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

function rawPlanWithOneSprint(): { sprints: unknown[] } {
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

function fakeBuildSprintNodes(): HostApiRunContext['buildSprintNodes'] {
  return () => {
    const node: DynamicWorkflowManifestNode = {
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
      manifestNodes: [node],
      createInputs: [createInput],
      sprintNodeIds: [{ sprintId: 's0', nodeIds: ['s0-coder-r0'] }],
    };
  };
}

function planDrivenManifest(): DynamicWorkflowManifest {
  const m = minimalManifest();
  m.phases.push({ id: 'Desenvolvimento', name: 'Desenvolvimento', order: 4 });
  const coder = m.nodes.find((n) => n.id === 'coder');
  if (coder) coder.isolation = 'run-workspace';
  return m;
}

describe('workflow-host-api: materializeSprintPlan transacional + idempotencia (FIX-F1)', () => {
  it('F1b: usa o CRUD combinado TRANSACIONAL (1 chamada com os 4 passos), sem as callbacks soltas', async () => {
    const { harness } = makeHostHarness();
    const calls: { combined: number; loose: number } = { combined: 0, loose: 0 };
    let captured: MaterializeDynamicWorkflowSprintPlanInput | null = null;
    const crud: HostApiCrud = {
      ...harness.deps.crud,
      materializeSprintPlan: (input) => {
        calls.combined += 1;
        captured = input;
      },
      createNodes: () => {
        calls.loose += 1;
      },
      updateDefinition: () => {
        calls.loose += 1;
      },
      persistSprints: () => {
        calls.loose += 1;
      },
      setNodeSprintMeta: () => {
        calls.loose += 1;
      },
    };
    const ctx = makeCtx({
      manifest: planDrivenManifest(),
      definitionId: 'def-1',
      catalogAgentIds: ['a-coder', 'a-val', 'a-scout'],
      buildSprintNodes: fakeBuildSprintNodes(),
    });
    const api = createWorkflowHostApi(ctx, { ...harness.deps, crud });

    const validated = (await api.validateSprintPlan(rawPlanWithOneSprint())) as {
      ok: boolean;
      plan: DynamicWorkflowSprintPlan;
    };
    expect(validated.ok).toBe(true);
    const out = (await api.materializeSprintPlan(validated.plan)) as {
      sprints: Array<{ sprintId: string; nodeIds: string[] }>;
      planVersion: number;
    };

    expect(calls.combined).toBe(1);
    expect(calls.loose).toBe(0);
    expect(captured).not.toBeNull();
    expect(captured!.definitionId).toBe('def-1');
    expect(captured!.nodes).toHaveLength(1);
    expect(captured!.sprints).toHaveLength(1);
    expect(captured!.nodeSprintMeta[0]).toEqual({
      nodeId: 's0-coder-r0',
      patch: { sprintId: 's0', roundIndex: 0 },
    });
    expect(out.sprints).toEqual([{ sprintId: 's0', nodeIds: ['s0-coder-r0'] }]);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('F1a: priorMaterialized hidrata a idempotencia -> re-materializar o MESMO plano e no-op (resume)', async () => {
    const { harness } = makeHostHarness();
    let combinedCalls = 0;
    const crud: HostApiCrud = {
      ...harness.deps.crud,
      materializeSprintPlan: () => {
        combinedCalls += 1;
      },
    };

    const probeCtx = makeCtx({
      manifest: planDrivenManifest(),
      definitionId: 'def-1',
      catalogAgentIds: ['a-coder', 'a-val', 'a-scout'],
      buildSprintNodes: fakeBuildSprintNodes(),
    });
    const probeApi = createWorkflowHostApi(probeCtx, { ...harness.deps, crud });
    const probe = (await probeApi.validateSprintPlan(rawPlanWithOneSprint())) as {
      plan: DynamicWorkflowSprintPlan;
    };
    const { planVersion, planHash } = probe.plan;
    rmSync(probeCtx.runDir, { recursive: true, force: true });

    const resumeCtx = makeCtx({
      manifest: planDrivenManifest(),
      definitionId: 'def-1',
      catalogAgentIds: ['a-coder', 'a-val', 'a-scout'],
      buildSprintNodes: fakeBuildSprintNodes(),
      priorMaterialized: {
        planVersion,
        planHash,
        sprintNodeIds: [{ sprintId: 's0', nodeIds: ['s0-coder-r0'] }],
      },
    });
    const resumeApi = createWorkflowHostApi(resumeCtx, { ...harness.deps, crud });

    const revalidated = (await resumeApi.validateSprintPlan(rawPlanWithOneSprint())) as {
      plan: DynamicWorkflowSprintPlan;
    };
    expect(revalidated.plan.planVersion).toBe(planVersion);
    expect(revalidated.plan.planHash).toBe(planHash);

    const out = (await resumeApi.materializeSprintPlan(revalidated.plan)) as {
      sprints: Array<{ sprintId: string; nodeIds: string[] }>;
      planVersion: number;
      parallelGroups: Array<{ sprintIds: string[] }>;
    };
    expect(combinedCalls).toBe(0);
    expect(out.sprints).toEqual([{ sprintId: 's0', nodeIds: ['s0-coder-r0'] }]);
    expect(out.planVersion).toBe(planVersion);
    expect(out.parallelGroups).toEqual([{ sprintIds: ['s0'] }]);
    rmSync(resumeCtx.runDir, { recursive: true, force: true });
  });

  it('F1a: mesma planVersion com planHash DIFERENTE no resume -> FATAL (inconsistencia)', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx({
      manifest: planDrivenManifest(),
      definitionId: 'def-1',
      catalogAgentIds: ['a-coder', 'a-val', 'a-scout'],
      buildSprintNodes: fakeBuildSprintNodes(),
      priorMaterialized: {
        planVersion: 1,
        planHash: 'hash-original',
        sprintNodeIds: [{ sprintId: 's0', nodeIds: ['s0-coder-r0'] }],
      },
    });
    const api = createWorkflowHostApi(ctx, harness.deps);

    await expect(
      api.materializeSprintPlan({ planVersion: 1, planHash: 'hash-diferente', sprints: [] }),
    ).rejects.toBeInstanceOf(WorkflowHostFatalError);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('SM-26: plan.md + sprints.json gravados ANTES da materializacao - sobrevivem a um crash da materialize (REGRA MAXIMA)', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx({
      manifest: planDrivenManifest(),
      definitionId: 'def-1',
      catalogAgentIds: ['a-coder', 'a-val', 'a-scout'],
      buildSprintNodes: () => {
        throw new Error('boom: materializacao falhou no meio');
      },
    });
    const api = createWorkflowHostApi(ctx, harness.deps);

    const validated = (await api.validateSprintPlan(rawPlanWithOneSprint())) as {
      ok: boolean;
      plan: DynamicWorkflowSprintPlan;
    };
    expect(validated.ok).toBe(true);

    await expect(api.materializeSprintPlan(validated.plan)).rejects.toThrow();

    const planPath = join(ctx.runDir, 'plan.md');
    const sprintsPath = join(ctx.runDir, 'sprints.json');
    expect(existsSync(planPath)).toBe(true);
    expect(existsSync(sprintsPath)).toBe(true);
    const sprintsJson = JSON.parse(readFileSync(sprintsPath, 'utf8'));
    expect(sprintsJson.planVersion).toBe(validated.plan.planVersion);
    expect(sprintsJson.planHash).toBe(validated.plan.planHash);

    const kinds = harness.state.artifacts.map((a) => a.kind).sort();
    expect(kinds).toContain('plan');
    expect(kinds).toContain('sprints');
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

function rawPlanWithBadValidator(): { sprints: unknown[] } {
  return {
    sprints: [
      {
        id: 's0',
        index: 0,
        name: 'Sprint 0',
        description: 'entregar X',
        stack: ['ts'],
        coderAgentId: 'a-coder',
        validatorAgentIds: ['typescript-validator'],
        features: [{ id: 'f0', name: 'feat 0', acceptanceCriteria: ['tsc verde'] }],
      },
    ],
  };
}

describe('workflow-host-api: SM-50 sanea validatorAgentId fora do catalogo (sem crash)', () => {
  it('filtra o validador fantasma ANTES de buildSprintNodes -> lista vazia (3 defaults por eixo) e NAO crasha', async () => {
    const { harness } = makeHostHarness();
    let seenValidatorIds: string[] | null = null;
    const delegate = fakeBuildSprintNodes()!;
    const capturingBuild: HostApiRunContext['buildSprintNodes'] = (plan, config) => {
      seenValidatorIds = [...plan.sprints[0]!.validatorAgentIds];
      return delegate(plan, config);
    };
    const crud: HostApiCrud = {
      ...harness.deps.crud,
      materializeSprintPlan: () => {},
    };
    const ctx = makeCtx({
      manifest: planDrivenManifest(),
      definitionId: 'def-1',
      catalogAgentIds: ['a-coder', 'a-val', 'a-scout'],
      buildSprintNodes: capturingBuild,
    });
    const api = createWorkflowHostApi(ctx, { ...harness.deps, crud });

    const validated = (await api.validateSprintPlan(rawPlanWithBadValidator())) as {
      ok: boolean;
      plan: DynamicWorkflowSprintPlan;
      errors: Array<{ code: string }>;
    };
    expect(validated.ok).toBe(true);
    expect(validated.errors.some((e) => e.code === 'validator-not-in-catalog')).toBe(false);
    expect(validated.plan.sprints[0]!.validatorAgentIds).not.toContain('typescript-validator');

    const out = (await api.materializeSprintPlan(validated.plan)) as {
      sprints: Array<{ sprintId: string; nodeIds: string[] }>;
    };

    expect(seenValidatorIds).toEqual([]);
    expect(out.sprints).toEqual([{ sprintId: 's0', nodeIds: ['s0-coder-r0'] }]);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('preserva um validatorAgentId que ESTA no catalogo (nao filtra demais)', async () => {
    const { harness } = makeHostHarness();
    let seenValidatorIds: string[] | null = null;
    const delegate = fakeBuildSprintNodes()!;
    const capturingBuild: HostApiRunContext['buildSprintNodes'] = (plan, config) => {
      seenValidatorIds = [...plan.sprints[0]!.validatorAgentIds];
      return delegate(plan, config);
    };
    const crud: HostApiCrud = {
      ...harness.deps.crud,
      materializeSprintPlan: () => {},
    };
    const ctx = makeCtx({
      manifest: planDrivenManifest(),
      definitionId: 'def-1',
      catalogAgentIds: ['a-coder', 'a-val', 'a-scout'],
      buildSprintNodes: capturingBuild,
    });
    const api = createWorkflowHostApi(ctx, { ...harness.deps, crud });

    const validated = (await api.validateSprintPlan(rawPlanWithOneSprint())) as {
      plan: DynamicWorkflowSprintPlan;
    };
    await api.materializeSprintPlan(validated.plan);

    expect(seenValidatorIds).toEqual(['a-val']);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('workflow-host-api: validateSprintPlan auto-corrige cosmetico, bloqueia so o real (2.8.0)', () => {
  async function runValidate(
    raw: { sprints: unknown[] },
    catalog: string[] = ['a-coder', 'a-val', 'a-scout'],
  ): Promise<{ ok: boolean; plan: DynamicWorkflowSprintPlan; errors: Array<{ code: string }> }> {
    const { harness } = makeHostHarness();
    const ctx = makeCtx({
      manifest: planDrivenManifest(),
      definitionId: 'def-1',
      catalogAgentIds: catalog,
    });
    const api = createWorkflowHostApi(ctx, harness.deps);
    const validated = (await api.validateSprintPlan(raw)) as {
      ok: boolean;
      plan: DynamicWorkflowSprintPlan;
      errors: Array<{ code: string }>;
    };
    rmSync(ctx.runDir, { recursive: true, force: true });
    return validated;
  }

  const okSprint = (over: Record<string, unknown>) => ({
    index: 0,
    name: 'A',
    description: 'entregar A',
    stack: ['ts'],
    coderAgentId: 'a-coder',
    validatorAgentIds: ['a-val'],
    features: [{ id: 'f0', name: 'f0', acceptanceCriteria: ['compila'] }],
    ...over,
  });

  it('dependencia ORFA -> dropada (ok=true; a real preservada)', async () => {
    const v = await runValidate({
      sprints: [okSprint({ id: 's0', index: 0 }), okSprint({ id: 's1', index: 1, dependencies: ['s0', 'fantasma'] })],
    });
    expect(v.ok).toBe(true);
    expect(v.plan.sprints.find((s) => s.id === 's1')!.dependencies).toEqual(['s0']);
  });

  it('CICLO -> back-edge quebrada (ok=true; grafo aciclico)', async () => {
    const v = await runValidate({
      sprints: [
        okSprint({ id: 's0', index: 0, dependencies: ['s1'] }),
        okSprint({ id: 's1', index: 1, dependencies: ['s0'] }),
      ],
    });
    expect(v.ok).toBe(true);
    expect(v.plan.sprints.reduce((n, s) => n + s.dependencies.length, 0)).toBe(1);
  });

  it('coderAgentId INVALIDO -> remapeado pro catalogo (ok=true)', async () => {
    const v = await runValidate({ sprints: [okSprint({ id: 's0', coderAgentId: 'general-purpose' })] });
    expect(v.ok).toBe(true);
    expect(v.plan.sprints[0]!.coderAgentId).not.toBe('general-purpose');
    expect(['a-coder', 'a-val', 'a-scout']).toContain(v.plan.sprints[0]!.coderAgentId);
  });

  it('id DUPLICADO -> sufixado (ok=true; ids E index unicos -> sem colisao de node-id)', async () => {
    const v = await runValidate({
      sprints: [okSprint({ id: 's0', index: 0 }), okSprint({ id: 's0', index: 0 })],
    });
    expect(v.ok).toBe(true);
    const ids = v.plan.sprints.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const idxs = v.plan.sprints.map((s) => s.index);
    expect(new Set(idxs).size).toBe(idxs.length);
    expect([...idxs].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it('REORDENA por topologia: consumidor emitido ANTES do produtor roda DEPOIS', async () => {
    const v = await runValidate({
      sprints: [okSprint({ id: 'ui', index: 0, dependencies: ['db'] }), okSprint({ id: 'db', index: 1 })],
    });
    expect(v.ok).toBe(true);
    const idxById = Object.fromEntries(v.plan.sprints.map((s) => [s.id, s.index]));
    expect(idxById['db']).toBeLessThan(idxById['ui']);
    expect(v.plan.sprints.map((s) => s.index).sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it('REGRA MAXIMA: feature SEM acceptanceCriteria AINDA bloqueia (nao passa merda)', async () => {
    const v = await runValidate({
      sprints: [okSprint({ id: 's0', features: [{ id: 'f0', name: 'f0', acceptanceCriteria: [] }] })],
    });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.code === 'acceptance-criteria-missing')).toBe(true);
  });

  it('sprint SEM features AINDA bloqueia', async () => {
    const v = await runValidate({ sprints: [okSprint({ id: 's0', features: [] })] });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.code === 'features-empty')).toBe(true);
  });

  it('plano VAZIO bloqueia', async () => {
    const v = await runValidate({ sprints: [] });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.code === 'plan-empty')).toBe(true);
  });
});

describe('workflow-host-api: efeitos laterais idempotentes no replay (SPEC-010 F2 sec 3.2)', () => {
  it('materialize NAO insere nodes 2x no replay com prefixo intacto', async () => {
    const { harness } = makeHostHarness();
    let combinedCalls = 0;
    const crud: HostApiCrud = {
      ...harness.deps.crud,
      materializeSprintPlan: () => {
        combinedCalls += 1;
      },
    };

    const ctx1 = makeCtx({
      manifest: planDrivenManifest(),
      definitionId: 'def-1',
      catalogAgentIds: ['a-coder', 'a-val', 'a-scout'],
      buildSprintNodes: fakeBuildSprintNodes(),
    });
    const api1 = createWorkflowHostApi(ctx1, { ...harness.deps, crud });
    const v1 = (await api1.validateSprintPlan(rawPlanWithOneSprint())) as { plan: DynamicWorkflowSprintPlan };
    await api1.materializeSprintPlan(v1.plan);
    expect(combinedCalls).toBe(1);
    expect(harness.state.journal.some((e) => e.primitive === 'materializeSprintPlan')).toBe(true);
    rmSync(ctx1.runDir, { recursive: true, force: true });

    const ctx2 = makeCtx({
      manifest: planDrivenManifest(),
      definitionId: 'def-1',
      catalogAgentIds: ['a-coder', 'a-val', 'a-scout'],
      buildSprintNodes: fakeBuildSprintNodes(),
      priorMaterialized: {
        planVersion: v1.plan.planVersion,
        planHash: v1.plan.planHash,
        sprintNodeIds: [{ sprintId: 's0', nodeIds: ['s0-coder-r0'] }],
      },
    });
    const api2 = createWorkflowHostApi(ctx2, { ...harness.deps, crud });
    const v2 = (await api2.validateSprintPlan(rawPlanWithOneSprint())) as { plan: DynamicWorkflowSprintPlan };
    await api2.materializeSprintPlan(v2.plan);
    expect(combinedCalls).toBe(1);
    rmSync(ctx2.runDir, { recursive: true, force: true });
  });

  it('gate auto aprovado NAO re-persiste a decisao no replay (prefixo intacto)', async () => {
    const { harness } = makeHostHarness();
    const manifest = minimalManifest();
    manifest.gates = [{ id: 'gate-global', mode: 'auto', blocks: ['delivery'] }];
    const ctx = makeCtx({ manifest });

    const api1 = createWorkflowHostApi(ctx, harness.deps);
    const r1 = (await api1.gate({ id: 'gate-global', mode: 'auto', checks: [] })) as { ok: boolean };
    expect(r1.ok).toBe(true);
    expect(harness.state.gateDecisions.length).toBe(1);
    expect(harness.state.journal.some((e) => e.primitive === 'gate')).toBe(true);

    const api2 = createWorkflowHostApi(ctx, harness.deps);
    const r2 = (await api2.gate({ id: 'gate-global', mode: 'auto', checks: [] })) as { ok: boolean };
    expect(r2.ok).toBe(true);
    expect(harness.state.gateDecisions.length).toBe(1);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('artifact NAO re-registra a linha no DB no replay (prefixo intacto)', async () => {
    const { harness } = makeHostHarness();
    const ctx = makeCtx();

    const api1 = createWorkflowHostApi(ctx, harness.deps);
    await api1.artifact({ id: 'scout', path: 'out/report.md', type: 'markdown', data: '# rel' });
    expect(harness.state.artifacts.length).toBe(1);
    expect(harness.state.journal.some((e) => e.primitive === 'artifact')).toBe(true);

    const api2 = createWorkflowHostApi(ctx, harness.deps);
    await api2.artifact({ id: 'scout', path: 'out/report.md', type: 'markdown', data: '# rel' });
    expect(harness.state.artifacts.length).toBe(1);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('desvio no MEIO re-executa SO o sufixo (prefixo reusado, sufixo re-roda)', async () => {
    function manifestSeq(v0Agent: string): DynamicWorkflowManifest {
      const base = minimalManifest();
      return {
        ...base,
        nodes: base.nodes.map((n) => (n.id === 'v0' ? { ...n, agentId: v0Agent } : n)),
      };
    }
    const adapter = vi.fn((input: RunNodeAgentInput) => Promise.resolve(makeOkResult(input)));
    const { harness } = makeHostHarness({ adapter });

    const ctx1 = makeCtx({ manifest: manifestSeq('a-old') });
    const api1 = createWorkflowHostApi(ctx1, harness.deps);
    await api1.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p-scout' });
    await api1.agent({ id: 'v0', agentId: 'a-old', access: 'read-only', prompt: 'p-v0' });
    await api1.agent({ id: 'v1', agentId: 'a-val', access: 'read-only', prompt: 'p-v1' });
    expect(adapter).toHaveBeenCalledTimes(3);
    expect(harness.state.journal.length).toBe(3);

    adapter.mockClear();
    const ctx2 = makeCtx({ manifest: manifestSeq('a-new'), runDir: ctx1.runDir });
    const api2 = createWorkflowHostApi(ctx2, harness.deps);
    await api2.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p-scout' });
    await api2.agent({ id: 'v0', agentId: 'a-new', access: 'read-only', prompt: 'p-v0' });
    await api2.agent({ id: 'v1', agentId: 'a-val', access: 'read-only', prompt: 'p-v1' });
    expect(adapter).toHaveBeenCalledTimes(2);
    rmSync(ctx1.runDir, { recursive: true, force: true });
  });
});

describe('workflow-host-api: greenCheck() (F1-S3, NAO-BLOQUEANTE)', () => {
  type FakeCmdResult = {
    status: number | null;
    stdout?: string;
    stderr?: string;
    timedOut?: boolean;
    error?: string;
    signal?: string;
  };
  function fakeRunnerBy(
    byScript: Record<string, FakeCmdResult>,
    fallback: FakeCmdResult = { status: 0 },
  ): (
    cmd: string,
    args: string[],
  ) => {
    status: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    error?: string;
    signal?: string;
  } {
    return (_cmd, args) => {
      const script = args[args.length - 1] ?? '';
      const r = byScript[script] ?? fallback;
      return {
        status: r.status,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        timedOut: r.timedOut ?? false,
        error: r.error,
        signal: r.signal,
      };
    };
  }

  function greenCheckCtx(rc: GateCheckResolutionContext, over?: Partial<HostApiRunContext>): HostApiRunContext {
    return makeCtx({
      resolveGateChecks: (checks) => resolveGateChecks(checks, rc),
      ...over,
    });
  }

  function depsWithRunner(harness: HostHarness, runner: ReturnType<typeof fakeRunnerBy>): HostApiDeps {
    return {
      ...harness.deps,
      runGateChecks: ((checks: GateCheckSpec[], mode: 'auto' | 'orchestrator' | 'human') =>
        realRunGateChecks(checks, mode, { runCommand: runner })) as typeof realRunGateChecks,
    };
  }

  it('VERDE: typecheck+test dentro do baseline -> ok=true, sem findings, NAO da throw', async () => {
    const { harness } = makeHostHarness();
    const rc: GateCheckResolutionContext = {
      repoRoot: '/repo',
      baselineMaxErrorsByCommand: { 'npm run typecheck': 125, 'npm run test': 0 },
    };
    const ctx = greenCheckCtx(rc);
    const runner = fakeRunnerBy({
      typecheck: { status: 1, stdout: 'error a\nerror b\nerror c' },
      test: { status: 0, stdout: 'all green' },
    });
    const api = createWorkflowHostApi(ctx, depsWithRunner(harness, runner));

    const res = (await api.greenCheck({})) as GreenCheckResult;
    expect(res.ok).toBe(true);
    expect(res.findings).toHaveLength(0);
    expect(res.checks).toHaveLength(2);
    expect(harness.state.events.some((e) => e.type === 'green-check')).toBe(true);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('VERMELHO: typecheck acima do baseline -> finding P1, ok=false, mas NAO da throw (nao-bloqueante)', async () => {
    const { harness } = makeHostHarness();
    const rc: GateCheckResolutionContext = {
      repoRoot: '/repo',
      baselineMaxErrorsByCommand: { 'npm run typecheck': 125, 'npm run test': 0 },
    };
    const ctx = greenCheckCtx(rc);
    const runner = fakeRunnerBy({
      typecheck: { status: 1, stdout: Array.from({ length: 200 }, () => 'error x').join('\n') },
      test: { status: 0 },
    });
    const api = createWorkflowHostApi(ctx, depsWithRunner(harness, runner));

    const res = (await api.greenCheck({})) as GreenCheckResult;
    expect(res.ok).toBe(false);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({ severity: 'P1' });
    expect(res.findings[0].where).toContain('typecheck');
    expect(harness.state.gateDecisions).toHaveLength(0);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('CRASH nunca e verde (F1-S1): INCONCLUSIVO bloqueia o run (doutrina NeonChatWF), nao vira vermelho', async () => {
    const { harness } = makeHostHarness();
    const rc: GateCheckResolutionContext = {
      repoRoot: '/repo',
      baselineMaxErrorsByCommand: { 'npm run typecheck': 125, 'npm run test': 0 },
    };
    const ctx = greenCheckCtx(rc);
    const runner = fakeRunnerBy({
      typecheck: { status: null, error: 'spawn npm ENOENT' },
      test: { status: 0 },
    });
    const api = createWorkflowHostApi(ctx, depsWithRunner(harness, runner));

    await expect(api.greenCheck({})).rejects.toMatchObject({
      code: 'gate-inconclusive',
      isWorkflowHostFatal: true,
    });
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('vermelho EXECUTADO segue virando finding P1 (exit 1 nao e inconclusivo)', async () => {
    const { harness } = makeHostHarness();
    const rc: GateCheckResolutionContext = { repoRoot: '/repo' };
    const ctx = greenCheckCtx(rc);
    const runner = fakeRunnerBy({
      typecheck: { status: 1, stdout: 'src/a.ts(1,1): error TS2304' },
      test: { status: 0 },
    });
    const api = createWorkflowHostApi(ctx, depsWithRunner(harness, runner));

    const res = (await api.greenCheck({})) as GreenCheckResult;
    expect(res.ok).toBe(false);
    expect(res.inconclusive).toBe(false);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].severity).toBe('P1');
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('build SO entra quando final===true E hasBuildScript===true (Q1 da SPEC)', async () => {
    const { harness } = makeHostHarness();
    const rc: GateCheckResolutionContext = { repoRoot: '/repo' };
    const runner = fakeRunnerBy({ typecheck: { status: 0 }, test: { status: 0 }, build: { status: 0 } });

    const ctxNoFinal = greenCheckCtx(rc, { hasBuildScript: true });
    const apiNoFinal = createWorkflowHostApi(ctxNoFinal, depsWithRunner(harness, runner));
    const r1 = (await apiNoFinal.greenCheck({})) as GreenCheckResult;
    expect(r1.checks).toHaveLength(2);

    const ctxNoScript = greenCheckCtx(rc, { hasBuildScript: false });
    const apiNoScript = createWorkflowHostApi(ctxNoScript, depsWithRunner(harness, runner));
    const r2 = (await apiNoScript.greenCheck({ final: true })) as GreenCheckResult;
    expect(r2.checks).toHaveLength(2);

    const ctxFinal = greenCheckCtx(rc, { hasBuildScript: true });
    const apiFinal = createWorkflowHostApi(ctxFinal, depsWithRunner(harness, runner));
    const r3 = (await apiFinal.greenCheck({ final: true })) as GreenCheckResult;
    expect(r3.checks).toHaveLength(3);
    expect(r3.checks.some((c) => c.id === 'green-check:build')).toBe(true);

    rmSync(ctxNoFinal.runDir, { recursive: true, force: true });
    rmSync(ctxNoScript.runDir, { recursive: true, force: true });
    rmSync(ctxFinal.runDir, { recursive: true, force: true });
  });

  it('greenCheck NAO entra no journal ordenado (idempotente/read-only no resume)', async () => {
    const { harness } = makeHostHarness();
    const rc: GateCheckResolutionContext = { repoRoot: '/repo' };
    const ctx = greenCheckCtx(rc);
    const runner = fakeRunnerBy({ typecheck: { status: 0 }, test: { status: 0 } });
    const api = createWorkflowHostApi(ctx, depsWithRunner(harness, runner));

    await api.greenCheck({});
    await api.greenCheck({});
    expect(harness.state.journal).toHaveLength(0);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('aceita checks proprios do .js (override do default do host)', async () => {
    const { harness } = makeHostHarness();
    const rc: GateCheckResolutionContext = { repoRoot: '/repo' };
    const ctx = greenCheckCtx(rc);
    const runner = fakeRunnerBy({ lint: { status: 0 } }, { status: 0 });
    const api = createWorkflowHostApi(ctx, depsWithRunner(harness, runner));

    const res = (await api.greenCheck({
      checks: [{ kind: 'command', command: 'npm run lint' }],
    })) as GreenCheckResult;
    expect(res.checks).toHaveLength(1);
    expect(res.ok).toBe(true);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('FIX P1 (revisao): sprintIndex roda os comandos na worktree DEDICADA (resolveSprintCwd), nao no repoRoot', async () => {
    const { harness } = makeHostHarness();
    const rc: GateCheckResolutionContext = { repoRoot: '/repo' };
    const ctx = greenCheckCtx(rc, {
      resolveSprintCwd: (idx: number) => (idx === 2 ? '/repo/.worktrees/s2' : null),
    });
    const seen: Array<string | undefined> = [];
    const capturing = (_c: string, _a: string[], opts?: { cwd?: string }) => {
      seen.push(opts?.cwd);
      return { status: 0, stdout: '', stderr: '', timedOut: false };
    };
    const deps: HostApiDeps = {
      ...harness.deps,
      runGateChecks: ((checks: GateCheckSpec[], mode: 'auto' | 'orchestrator' | 'human') =>
        realRunGateChecks(checks, mode, { runCommand: capturing })) as typeof realRunGateChecks,
    };
    const api = createWorkflowHostApi(ctx, deps);

    await api.greenCheck({ sprintIndex: 2 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((c) => c === '/repo/.worktrees/s2')).toBe(true);

    seen.length = 0;
    await api.greenCheck({});
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((c) => c === '/repo')).toBe(true);

    seen.length = 0;
    await api.greenCheck({ sprintIndex: 9 });
    expect(seen.every((c) => c === '/repo')).toBe(true);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('workflow-host-api: greenCheck helpers puros (F1-S3)', () => {
  it('defaultGreenCheckSpecs: typecheck+test sempre; build so com wantsBuild', () => {
    const noBuild = defaultGreenCheckSpecs(false) as Array<{ id: string }>;
    expect(noBuild.map((c) => c.id)).toEqual(['green-check:typecheck', 'green-check:test']);
    const withBuild = defaultGreenCheckSpecs(true) as Array<{ id: string }>;
    expect(withBuild.map((c) => c.id)).toEqual(['green-check:typecheck', 'green-check:test', 'green-check:build']);
  });

  it('greenCheckFindingOf: check vermelho -> finding P1 com where do comando', () => {
    const f = greenCheckFindingOf({
      id: 'green-check:typecheck',
      kind: 'command',
      ok: false,
      reason: 'erros 200 acima do baseline 125',
      detail: { command: 'npm run typecheck', errorCount: 200 },
    });
    expect(f.severity).toBe('P1');
    expect(f.where).toBe('npm run typecheck');
    expect(f.problem).toContain('vermelho');
    expect(typeof f.fix).toBe('string');
  });

  it('GREEN_CHECK_PSEUDO_GATE_ID nao colide com gate real (so usado no resolver)', () => {
    expect(GREEN_CHECK_PSEUDO_GATE_ID).toBe('__green-check__');
  });
});

interface AdjustmentRow {
  id: number;
  nodeId: string;
  content: string;
  appliedNodeId: string | null;
  consumedAt: string | null;
}

function installAdjustmentStore(
  harness: HostHarness,
  rows: Array<{ nodeId: string; content: string }>,
): {
  rows: AdjustmentRow[];
  add: (nodeId: string, content: string) => void;
} {
  const store: AdjustmentRow[] = [];
  let nextId = 0;
  const add = (nodeId: string, content: string): void => {
    nextId += 1;
    store.push({ id: nextId, nodeId, content, appliedNodeId: null, consumedAt: null });
  };
  rows.forEach((r) => add(r.nodeId, r.content));
  const toMsg = (r: AdjustmentRow): DynamicWorkflowMessage => ({
    id: r.id,
    runId: 'run-1',
    nodeId: r.nodeId,
    role: 'user',
    source: 'orchestrator',
    kind: 'adjustment',
    content: r.content,
    toolCallsJson: null,
    agentId: null,
    createdAt: '2026-06-12T00:00:00.000Z',
    appliedNodeId: r.appliedNodeId,
    consumedAt: r.consumedAt,
  });
  harness.deps.crud.claimAdjustmentsForNode = (_runId, nodeId) => {
    const pick = (target: string) => store.filter((r) => r.consumedAt === null && r.nodeId === target);
    const got = [...pick(nodeId), ...pick('*')];
    for (const r of got) {
      r.appliedNodeId = nodeId;
      r.consumedAt = '2026-06-12T00:00:01.000Z';
    }
    return got.sort((a, b) => a.id - b.id).map(toMsg);
  };
  harness.deps.crud.getConsumedAdjustmentsForNode = (_runId, nodeId) =>
    store
      .filter((r) => r.consumedAt !== null && r.appliedNodeId === nodeId)
      .sort((a, b) => a.id - b.id)
      .map(toMsg);
  return { rows: store, add };
}

function journalHashOf(harness: HostHarness, nodeId: string): string {
  const entry = harness.state.journal.find((e) => e.nodeId === nodeId);
  expect(entry, `journal sem entrada para ${nodeId}`).toBeDefined();
  return entry!.argHash;
}

const SCOUT_BASE_HASH = computeNodeInputHash({
  agentId: 'a-scout',
  prompt: 'p',
  access: 'read-only',
  schemaRef: undefined,
  writeSet: [],
});

describe('workflow-host-api: D8 ajuste do orquestrador consumido no claim do node', () => {
  it('SEM ajuste: prompt intacto e argHash journalado == hash legado (byte-identico, REGRA MAXIMA)', async () => {
    const prompts: string[] = [];
    const { harness } = makeHostHarness({
      adapter: async (input) => {
        prompts.push(input.prompt);
        return makeOkResult(input);
      },
    });
    installAdjustmentStore(harness, []);
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);
    await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p' });
    expect(prompts).toEqual(['p']);
    expect(journalHashOf(harness, 'scout')).toBe(SCOUT_BASE_HASH);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('COM ajuste (nodeId exato): prompt ganha [AJUSTE DO ORQUESTRADOR], hash muda e a linha e consumida com applied_node_id', async () => {
    const prompts: string[] = [];
    const { harness } = makeHostHarness({
      adapter: async (input) => {
        prompts.push(input.prompt);
        return makeOkResult(input);
      },
    });
    const store = installAdjustmentStore(harness, [{ nodeId: 'scout', content: 'foque em X' }]);
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);
    await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p' });

    expect(prompts).toEqual([`p${ADJUSTMENT_PROMPT_HEADER}foque em X`]);
    const adjusted = journalHashOf(harness, 'scout');
    expect(adjusted).not.toBe(SCOUT_BASE_HASH);
    expect(adjusted).toBe(
      computeNodeInputHash({
        agentId: 'a-scout',
        prompt: 'p',
        access: 'read-only',
        schemaRef: undefined,
        writeSet: [],
        adjustment: 'foque em X',
      }),
    );
    expect(store.rows[0]).toMatchObject({ appliedNodeId: 'scout', consumedAt: expect.any(String) });
    const nr = [...harness.state.nodeRuns.values()].find((n) => n.nodeId === 'scout')!;
    expect(JSON.parse(nr.inputJson).prompt).toContain('[AJUSTE DO ORQUESTRADOR]');
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('REPLAY: rele o ajuste por applied_node_id ANTES do claim do journal -> MESMO hash, reuse (cache-hit) sem re-rodar o agente', async () => {
    let calls = 0;
    const { harness } = makeHostHarness({
      adapter: async (input) => {
        calls += 1;
        return makeOkResult(input);
      },
    });
    installAdjustmentStore(harness, [{ nodeId: 'scout', content: 'foque em X' }]);
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);
    await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p' });
    const firstHash = journalHashOf(harness, 'scout');
    expect(calls).toBe(1);

    const api2 = createWorkflowHostApi(makeCtx({ runDir: ctx.runDir, workspaceRoot: ctx.workspaceRoot }), harness.deps);
    await api2.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p' });
    expect(calls).toBe(1);
    const hit = harness.state.events.find((e) => e.type === 'node-cache-hit' && e.nodeId === 'scout')!.payload as {
      inputHash: string;
    };
    expect(hit.inputHash).toBe(firstHash);
    expect(journalHashOf(harness, 'scout')).toBe(firstHash);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it("'*' em parallel: EXATAMENTE UM dos dois nodes recebe o ajuste (o primeiro a reivindicar)", async () => {
    const prompts = new Map<string, string>();
    const { harness } = makeHostHarness({
      adapter: async (input) => {
        prompts.set(input.grants.nodeId, input.prompt);
        return makeOkResult(input);
      },
    });
    installAdjustmentStore(harness, [{ nodeId: '*', content: 'mais validadores' }]);
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);
    await Promise.all([
      api.agent({ id: 'v0', agentId: 'a-val', access: 'read-only', prompt: 'v' }),
      api.agent({ id: 'v1', agentId: 'a-val', access: 'read-only', prompt: 'v' }),
    ]);
    const withAdj = [...prompts.values()].filter((p) => p.includes('[AJUSTE DO ORQUESTRADOR]'));
    expect(withAdj).toHaveLength(1);
    expect(withAdj[0]).toBe(`v${ADJUSTMENT_PROMPT_HEADER}mais validadores`);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('dois ajustes sucessivos para o MESMO node: ambos consumidos e concatenados em ordem de id num unico bloco', async () => {
    const prompts: string[] = [];
    const { harness } = makeHostHarness({
      adapter: async (input) => {
        prompts.push(input.prompt);
        return makeOkResult(input);
      },
    });
    const store = installAdjustmentStore(harness, [
      { nodeId: 'scout', content: 'primeiro' },
      { nodeId: '*', content: 'segundo (curinga)' },
    ]);
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);
    await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p' });
    expect(prompts).toEqual([`p${ADJUSTMENT_PROMPT_HEADER}primeiro\n\nsegundo (curinga)`]);
    expect(store.rows.every((r) => r.appliedNodeId === 'scout' && r.consumedAt !== null)).toBe(true);
    expect(journalHashOf(harness, 'scout')).toBe(
      computeNodeInputHash({
        agentId: 'a-scout',
        prompt: 'p',
        access: 'read-only',
        schemaRef: undefined,
        writeSet: [],
        adjustment: 'primeiro\n\nsegundo (curinga)',
      }),
    );
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('node REUSADO do journal nao rouba um ajuste `*` pendente (so node fresh reivindica)', async () => {
    let calls = 0;
    const { harness } = makeHostHarness({
      adapter: async (input) => {
        calls += 1;
        return makeOkResult(input);
      },
    });
    const store = installAdjustmentStore(harness, []);
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, harness.deps);
    await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p' });
    store.add('*', 'para o proximo');
    const api2 = createWorkflowHostApi(makeCtx({ runDir: ctx.runDir, workspaceRoot: ctx.workspaceRoot }), harness.deps);
    await api2.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p' });
    expect(calls).toBe(1);
    expect(store.rows[0]!.consumedAt).toBeNull();
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});
