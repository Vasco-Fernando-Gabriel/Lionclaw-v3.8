import { describe, it, expect, vi } from 'vitest';
import {
  createWorkflowHostApi,
  WorkflowHostFatalError,
  WORKFLOW_IMPLICIT_NODE_CAP,
  WORKFLOW_PARALLEL_ITEMS_CAP,
  type HostApiRunContext,
  type HostApiDeps,
  type HostApiCrud,
  type GateGate,
  type PendingGateResolution,
} from '../dynamic-workflows/workflow-host-api';
import type {
  DynamicWorkflowManifest,
  DynamicWorkflowNodeRun,
  DynamicWorkflowNodeRunUpsertInput,
  DynamicWorkflowNodeRunPatch,
  DynamicWorkflowEvent,
  DynamicWorkflowEventInsertInput,
  DynamicWorkflowGateDecision,
  DynamicWorkflowGateDecisionInsertInput,
  DynamicWorkflowArtifact,
  DynamicWorkflowArtifactInsertInput,
  DynamicWorkflowJournalEntry,
  DynamicWorkflowJournalAppendInput,
} from '../dynamic-workflows/types';
import type { NodeRunResult, RunNodeAgentInput } from '../dynamic-workflows/workflow-agent-adapter';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Axes = NonNullable<ReturnType<NonNullable<HostApiRunContext['resolveAgentAxes']>>>;

const AGENT_AXES: Record<string, Axes> = {
  'a-reader': {
    access: 'read-only',
    allowBash: false,
    allowedCommands: [],
    allowNetwork: false,
    allowedTools: ['Read', 'Grep'],
  },
};

function resolveAgentAxes(agentType: string): Axes | null {
  return AGENT_AXES[agentType] ?? null;
}

function makeResult(input: RunNodeAgentInput): NodeRunResult {
  return {
    ok: true,
    output: `{"node":"${input.grants.nodeId}"}`,
    runtime: 'cloud',
    family: 'claude-compatible',
    cost: {
      costUsd: 0,
      costStatus: 'known',
      tokenStatus: null,
      costUnknownReason: null,
      inputTokens: 1,
      outputTokens: 1,
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
      allowedCommands: input.grants.allowedCommands ?? [],
      effectiveTools: input.grants.allowedTools ?? [],
      effectiveMcpServers: [],
      policyHash: `hash-${input.grants.nodeId}`,
      allowBash: input.grants.allowBash ?? false,
      allowNetwork: input.grants.allowNetwork ?? false,
      timeoutMs: 1000,
      idleTimeoutMs: 1000,
      costCeilingUsd: 0,
    },
    mechanism: 'canUseTool',
    durationMs: 1,
  };
}

interface Harness {
  deps: HostApiDeps;
  state: {
    events: Array<{ type: string; nodeId?: string | null }>;
    journal: DynamicWorkflowJournalEntry[];
  };
  adapter: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const state: Harness['state'] = { events: [], journal: [] };
  const nodeRuns = new Map<string, DynamicWorkflowNodeRun>();
  let eventSeq = 0;
  let checkpointJson = '{}';

  const crud: HostApiCrud = {
    upsertNodeRun: (input: DynamicWorkflowNodeRunUpsertInput): DynamicWorkflowNodeRun => {
      const nr = {
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
      } as DynamicWorkflowNodeRun;
      nodeRuns.set(input.id, nr);
      return nr;
    },
    updateNodeRun: (id: string, patch: DynamicWorkflowNodeRunPatch): void => {
      const nr = nodeRuns.get(id);
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
      state.journal.push({
        ...input,
        outputRef: input.outputRef ?? null,
        sideEffectKey: input.sideEffectKey ?? null,
        createdAt: '2026-07-06T00:00:00.000Z',
      });
    },
    listJournalEntries: () => [...state.journal].sort((a, b) => a.callIndex - b.callIndex),
    truncateJournalFrom: () => {},
  };

  const gateGate: GateGate = {
    awaitDecision: () => new Promise<PendingGateResolution>(() => {}),
  };

  const adapter = vi.fn((input: RunNodeAgentInput) => Promise.resolve(makeResult(input)));

  const deps: HostApiDeps = {
    crud,
    gateGate,
    runNodeAgent: (input) => adapter(input),
    emit: (input) => state.events.push({ type: input.type, nodeId: input.nodeId }),
    generateId: (prefix) => `${prefix}_${eventSeq}_${state.journal.length}`,
    now: () => '2026-07-06T00:00:00.000Z',
  };

  return { deps, state, adapter };
}

function ccManifest(): DynamicWorkflowManifest {
  return {
    version: 1,
    name: 'cc-s5',
    phases: [{ id: 'Build', name: 'Build', order: 0 }],
    nodes: [],
    parallelism: { maxConcurrentAgents: 3, parallelWritersAllowed: false },
    gates: [],
    estimate: { minUsd: 0, maxUsd: 1, unknownCostNodes: [] },
  };
}

function makeCtx(over?: Partial<HostApiRunContext>): HostApiRunContext {
  const runDir = mkdtempSync(join(tmpdir(), 'dwf-s5-cde-'));
  return {
    runId: 'run-cc-s5',
    manifest: ccManifest(),
    workspaceRoot: runDir,
    runDir,
    abortSignal: new AbortController().signal,
    resolveAgentAxes,
    ...over,
  };
}

async function expectFatal(p: Promise<unknown>, code: string, contains?: string): Promise<void> {
  let caught: unknown = null;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(WorkflowHostFatalError);
  expect((caught as WorkflowHostFatalError).code).toBe(code);
  if (contains) expect((caught as WorkflowHostFatalError).message).toContain(contains);
}

describe('S5 (C) caps anti-runaway (claude-code only)', () => {
  it('constantes exportadas com os valores da SPEC (1000 nodes / 4096 itens)', () => {
    expect(WORKFLOW_IMPLICIT_NODE_CAP).toBe(1000);
    expect(WORKFLOW_PARALLEL_ITEMS_CAP).toBe(4096);
  });

  it('estourar o teto de nodes implicitos por run -> fatal implicit-node-cap-exceeded claro', async () => {
    const h = makeHarness();
    const ctx = makeCtx({ maxImplicitNodesPerRun: 2 });
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');
    await api.agent({ agentType: 'a-reader', label: 'n1', prompt: 'p1' } as never);
    await api.agent({ agentType: 'a-reader', label: 'n2', prompt: 'p2' } as never);
    await expectFatal(
      api.agent({ agentType: 'a-reader', label: 'n3', prompt: 'p3' } as never),
      'implicit-node-cap-exceeded',
      'anti-runaway',
    );
    expect(h.adapter).toHaveBeenCalledTimes(2);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('parallel() acima do teto de itens -> fatal parallel-items-cap-exceeded (nao trunca silencioso)', async () => {
    const h = makeHarness();
    const ctx = makeCtx({ maxParallelItemsPerCall: 3 });
    const api = createWorkflowHostApi(ctx, h.deps);
    const thunks = [1, 2, 3, 4].map((n) => () => Promise.resolve(n));
    await expectFatal(
      api.parallel({ thunks, options: {} } as never),
      'parallel-items-cap-exceeded',
      'teto anti-runaway de 3',
    );
    const ok = (await api.parallel({ thunks: thunks.slice(0, 3), options: {} } as never)) as unknown[];
    expect(ok).toEqual([1, 2, 3]);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('pipeline() acima do teto de itens -> fatal parallel-items-cap-exceeded', async () => {
    const h = makeHarness();
    const ctx = makeCtx({ maxParallelItemsPerCall: 3 });
    const api = createWorkflowHostApi(ctx, h.deps);
    await expectFatal(
      api.pipeline({ items: [1, 2, 3, 4], stages: [(x: unknown) => x] } as never),
      'parallel-items-cap-exceeded',
    );
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('S5 (D) agent(prompt, { phase }) por chamada (claude-code)', () => {
  it('fase inexistente e registrada on-the-fly e o node nasce nela, SEM mudar a fase corrente', async () => {
    const h = makeHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');

    await api.agent({ agentType: 'a-reader', label: 'aud', prompt: 'p1', phase: 'Auditoria' } as never);
    await api.agent({ agentType: 'a-reader', label: 'scan', prompt: 'p2' } as never);

    const ids = ctx.manifest.nodes.map((n) => n.id);
    expect(ids).toEqual(['cc:Auditoria:aud:0', 'cc:Build:scan:0']);
    expect(ctx.manifest.nodes[0]!.phaseId).toBe('Auditoria');
    expect(ctx.manifest.nodes[1]!.phaseId).toBe('Build');
    expect(ctx.manifest.phases.map((p) => p.id)).toEqual(['Build', 'Auditoria']);
    expect(ctx.manifest.phases[1]!.order).toBe(1);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('fase EXISTENTE em opts.phase e reusada sem duplicar em manifest.phases', async () => {
    const h = makeHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');
    await api.agent({ agentType: 'a-reader', label: 'x', prompt: 'p', phase: 'Build' } as never);
    expect(ctx.manifest.phases.map((p) => p.id)).toEqual(['Build']);
    expect(ctx.manifest.nodes[0]!.id).toBe('cc:Build:x:0');
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('scripts SEM opts.phase: id e chave de journal (argHash/policyHash) byte-identicos ao legado', async () => {
    async function runOnce(): Promise<{ ids: string[]; keys: Array<[string, string | null]> }> {
      const h = makeHarness();
      const ctx = makeCtx();
      const api = createWorkflowHostApi(ctx, h.deps);
      await api.phase('Build');
      await api.agent({ agentType: 'a-reader', label: 'scan', prompt: 'p1' } as never);
      await api.agent({ agentType: 'a-reader', prompt: 'p2' } as never);
      const ids = ctx.manifest.nodes.map((n) => n.id);
      const keys = h.state.journal.map((e) => [e.argHash, e.policyHash] as [string, string | null]);
      rmSync(ctx.runDir, { recursive: true, force: true });
      return { ids, keys };
    }
    const a = await runOnce();
    const b = await runOnce();
    expect(a.ids).toEqual(['cc:Build:scan:0', 'cc:Build:a-reader:0']);
    expect(a.ids).toEqual(b.ids);
    expect(a.keys).toEqual(b.keys);
  });
});

describe('S5 (E) agent({ isolation }) rejeitado no claude-code', () => {
  it('isolation em qualquer valor -> fatal isolation-unsupported ANTES do dispatch', async () => {
    const h = makeHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');
    await expectFatal(
      api.agent({ agentType: 'a-reader', prompt: 'p', isolation: 'worktree' } as never),
      'isolation-unsupported',
      'worktree dedicada',
    );
    expect(h.adapter).not.toHaveBeenCalled();
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('sem isolation segue normal (nada muda no caminho feliz)', async () => {
    const h = makeHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');
    const out = await api.agent({ agentType: 'a-reader', label: 'ok', prompt: 'p' } as never);
    expect(JSON.parse(String(out))).toEqual({ node: 'cc:Build:ok:0' });
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});
