
import { describe, it, expect, vi } from 'vitest';
import {
  createWorkflowHostApi,
  computeNodeInputHash,
  WorkflowHostFatalError,
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
import { computeNodeGrantsHash } from '../dynamic-workflows/workflow-policy';
import { saveNodeCheckpoint } from '../dynamic-workflows/workflow-checkpoints';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


type Axes = NonNullable<ReturnType<NonNullable<HostApiRunContext['resolveAgentAxes']>>>;

const AGENT_AXES: Record<string, Axes> = {
  'a-writer': {
    access: 'workspace-write',
    allowBash: true,
    allowedCommands: ['npm test', 'npm run build'],
    allowNetwork: true,
    allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
  },
  'a-reader': {
    access: 'read-only',
    allowBash: false,
    allowedCommands: [],
    allowNetwork: false,
    allowedTools: ['Read', 'Grep'],
  },
  'dynamic-workflow-builder': {
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


interface Harness {
  deps: HostApiDeps;
  state: {
    nodeRuns: Map<string, DynamicWorkflowNodeRun>;
    events: Array<{ type: string; nodeId?: string | null; payload?: unknown }>;
    runCheckpointJson: string;
    journal: DynamicWorkflowJournalEntry[];
  };
}

function makeResult(input: RunNodeAgentInput, output: string): NodeRunResult {
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

function makeHarness(over?: {
  adapter?: (input: RunNodeAgentInput) => Promise<NodeRunResult>;
  initialJournal?: DynamicWorkflowJournalEntry[];
}): Harness {
  const state: Harness['state'] = {
    nodeRuns: new Map(),
    events: [],
    runCheckpointJson: '{}',
    journal: over?.initialJournal ? [...over.initialJournal] : [],
  };
  let eventSeq = 0;

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
        createdAt: '2026-06-26T00:00:00.000Z',
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
      createdAt: '2026-06-26T00:00:00.000Z',
    }),
    registerArtifact: (input: DynamicWorkflowArtifactInsertInput): DynamicWorkflowArtifact => ({
      id: input.id,
      runId: input.runId,
      nodeId: input.nodeId ?? null,
      kind: input.kind,
      path: input.path,
      sha256: input.sha256,
      metadataJson: input.metadataJson ?? '{}',
      createdAt: '2026-06-26T00:00:00.000Z',
    }),
    getRunCheckpoint: () => state.runCheckpointJson,
    persistRunCheckpoint: (_runId, checkpointJson) => {
      state.runCheckpointJson = checkpointJson;
    },
    addRunCost: () => {},
    patchRun: () => {},
    appendJournalEntry: (input: DynamicWorkflowJournalAppendInput) => {
      const idx = state.journal.findIndex((e) => e.callIndex === input.callIndex);
      const entry: DynamicWorkflowJournalEntry = {
        ...input,
        outputRef: input.outputRef ?? null,
        sideEffectKey: input.sideEffectKey ?? null,
        createdAt: '2026-06-26T00:00:00.000Z',
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
    awaitDecision: () => new Promise<PendingGateResolution>(() => {}),
  };

  const deps: HostApiDeps = {
    crud,
    gateGate,
    runNodeAgent: over?.adapter
      ? (input) => over.adapter!(input)
      : (input) => Promise.resolve(makeResult(input, `{"node":"${input.grants.nodeId}"}`)),
    emit: (input) => state.events.push({ type: input.type, nodeId: input.nodeId, payload: input.payload }),
    generateId: (prefix) => `${prefix}_${state.nodeRuns.size}`,
    now: () => '2026-06-26T00:00:00.000Z',
  };

  return { deps, state };
}

function ccManifest(): DynamicWorkflowManifest {
  return {
    version: 1,
    name: 'cc-wf',
    phases: [{ id: 'Build', name: 'Build', order: 0 }],
    nodes: [],
    parallelism: { maxConcurrentAgents: 3, parallelWritersAllowed: false },
    gates: [],
    estimate: { minUsd: 0, maxUsd: 1, unknownCostNodes: [] },
  };
}

function makeCtx(over?: Partial<HostApiRunContext>): HostApiRunContext {
  const runDir = mkdtempSync(join(tmpdir(), 'dwf-implicit-'));
  return {
    runId: 'run-cc',
    manifest: ccManifest(),
    workspaceRoot: runDir,
    runDir,
    abortSignal: new AbortController().signal,
    resolveAgentAxes,
    ...over,
  };
}

function policyHashOf(h: Harness, nodeId: string): string | null {
  const run = [...h.state.nodeRuns.values()].find((n) => n.nodeId === nodeId && n.status === 'completed');
  return run?.policyHash ?? null;
}


describe('F1d implicit node: id estavel/deterministico', () => {
  it('dois agent({label:"a"}) + um agent({agentType:"Y"}) geram ids ESTAVEIS e DISTINTOS', async () => {
    const h = makeHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');

    await api.agent({ agentType: 'a-reader', label: 'a', prompt: 'p1' } as never);
    await api.agent({ agentType: 'a-reader', label: 'a', prompt: 'p2' } as never);
    await api.agent({ agentType: 'a-writer', prompt: 'p3' } as never);

    const ids = ctx.manifest.nodes.map((n) => n.id);
    expect(ids).toEqual([
      'cc:Build:a:0',
      'cc:Build:a:1',
      'cc:Build:a-writer:0',
    ]);
    expect(new Set(ids).size).toBe(3);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('DETERMINISTICO: rodar a MESMA sequencia 2x produz os MESMOS ids e MESMOS policyHash', async () => {
    async function runOnce(): Promise<{ ids: string[]; hashes: Array<string | null> }> {
      const h = makeHarness();
      const ctx = makeCtx();
      const api = createWorkflowHostApi(ctx, h.deps);
      await api.phase('Build');
      await api.agent({ agentType: 'a-reader', label: 'a', prompt: 'p1' } as never);
      await api.agent({ agentType: 'a-writer', label: 'b', prompt: 'p2' } as never);
      await api.agent({ agentType: 'a-reader', prompt: 'p3' } as never);
      const ids = ctx.manifest.nodes.map((n) => n.id);
      const hashes = ids.map((id) => policyHashOf(h, id));
      rmSync(ctx.runDir, { recursive: true, force: true });
      return { ids, hashes };
    }

    const a = await runOnce();
    const b = await runOnce();
    expect(a.ids).toEqual(b.ids);
    expect(a.ids).toEqual(['cc:Build:a:0', 'cc:Build:b:0', 'cc:Build:a-reader:0']);
    expect(a.hashes).toEqual(b.hashes);
    expect(a.hashes.every((x) => typeof x === 'string' && x.length > 0)).toBe(true);
  });
});


describe('F1d implicit node: eixos vem do agentType', () => {
  it('agentType workspace-write+bash -> grants workspace-write+bash+rede+commands', async () => {
    const seen: RunNodeAgentInput[] = [];
    const adapter = vi.fn((input: RunNodeAgentInput) => {
      seen.push(input);
      return Promise.resolve(makeResult(input, `{"ok":1}`));
    });
    const h = makeHarness({ adapter });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');
    await api.agent({ agentType: 'a-writer', prompt: 'escreva' } as never);

    const node = ctx.manifest.nodes.find((n) => n.id === 'cc:Build:a-writer:0')!;
    expect(node.access).toBe('workspace-write');
    expect(node.allowBash).toBe(true);
    expect(node.allowNetwork).toBe(true);
    expect(node.allowedCommands).toEqual(['npm test', 'npm run build']);
    expect(node.allowedTools).toEqual(['Read', 'Write', 'Edit', 'Bash']);
    expect(node.agentId).toBe('a-writer');

    const grants = seen[0].grants;
    expect(grants.access).toBe('workspace-write');
    expect(grants.allowBash).toBe(true);
    expect(grants.allowNetwork).toBe(true);
    expect(grants.allowedCommands).toEqual(['npm test', 'npm run build']);
    expect(grants.allowedTools).toEqual(['Read', 'Write', 'Edit', 'Bash']);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('agentType read-only -> grants read-only sem bash/rede', async () => {
    const seen: RunNodeAgentInput[] = [];
    const adapter = vi.fn((input: RunNodeAgentInput) => {
      seen.push(input);
      return Promise.resolve(makeResult(input, `{"ok":1}`));
    });
    const h = makeHarness({ adapter });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');
    await api.agent({ agentType: 'a-reader', prompt: 'leia' } as never);

    const node = ctx.manifest.nodes.find((n) => n.id === 'cc:Build:a-reader:0')!;
    expect(node.access).toBe('read-only');
    expect(node.allowBash).toBe(false);
    expect(node.allowNetwork).toBe(false);
    expect(node.allowedCommands).toEqual([]);

    const grants = seen[0].grants;
    expect(grants.access).toBe('read-only');
    expect(grants.allowBash).toBe(false);
    expect(grants.allowNetwork).toBe(false);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});


describe('F1d implicit node: resume reusa pelo journal (determinismo)', () => {
  it('resume claude-code com nodes implicitos: PASS 2 NAO re-roda (prefixo intacto)', async () => {
    const adapter = vi.fn((input: RunNodeAgentInput) =>
      Promise.resolve(makeResult(input, `{"out":"${input.grants.nodeId}"}`)),
    );
    const h = makeHarness({ adapter });
    const runDir = mkdtempSync(join(tmpdir(), 'dwf-implicit-resume-'));

    const ctx1 = makeCtx({ runDir });
    const api1 = createWorkflowHostApi(ctx1, h.deps);
    await api1.phase('Build');
    const out1a = await api1.agent({ agentType: 'a-reader', label: 'scan', prompt: 'mapeie' } as never);
    const out1b = await api1.agent({ agentType: 'a-writer', label: 'code', prompt: 'implemente' } as never);
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(out1a))).toEqual({ out: 'cc:Build:scan:0' });
    expect(JSON.parse(String(out1b))).toEqual({ out: 'cc:Build:code:0' });
    const journal1 = [...h.state.journal].sort((a, b) => a.callIndex - b.callIndex);
    expect(journal1.map((e) => e.nodeId)).toEqual(['cc:Build:scan:0', 'cc:Build:code:0']);
    const hashes1 = journal1.map((e) => e.policyHash);

    const ctx2 = makeCtx({ runDir });
    const api2 = createWorkflowHostApi(ctx2, h.deps);
    await api2.phase('Build');
    const out2a = await api2.agent({ agentType: 'a-reader', label: 'scan', prompt: 'mapeie' } as never);
    const out2b = await api2.agent({ agentType: 'a-writer', label: 'code', prompt: 'implemente' } as never);

    expect(adapter).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(out2a))).toEqual({ out: 'cc:Build:scan:0' });
    expect(JSON.parse(String(out2b))).toEqual({ out: 'cc:Build:code:0' });
    const cacheHits = h.state.events.filter((e) => e.type === 'node-cache-hit').map((e) => e.nodeId);
    expect(cacheHits).toEqual(['cc:Build:scan:0', 'cc:Build:code:0']);
    const journal2 = [...h.state.journal].sort((a, b) => a.callIndex - b.callIndex);
    expect(journal2.map((e) => e.policyHash)).toEqual(hashes1);
    expect(journal2.map((e) => e.nodeId)).toEqual(['cc:Build:scan:0', 'cc:Build:code:0']);

    rmSync(runDir, { recursive: true, force: true });
  });
});


describe('F1d implicit node: guards (agent-missing)', () => {
  it('agentType inexistente no catalogo -> fatal agent-missing', async () => {
    const h = makeHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');
    let caught: unknown;
    try {
      await api.agent({ agentType: 'a-fantasma', prompt: 'x' } as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowHostFatalError);
    expect((caught as WorkflowHostFatalError).code).toBe('agent-missing');
    expect(ctx.manifest.nodes).toHaveLength(0);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('claude-code: agent() COM id explicito ainda exige node no manifest (semantica preservada)', async () => {
    const h = makeHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');
    let caught: unknown;
    try {
      await api.agent({ id: 'inexistente', agentType: 'a-reader', prompt: 'x' } as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowHostFatalError);
    expect((caught as WorkflowHostFatalError).code).toBe('node-not-in-manifest');
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});


describe('denylist de runtime: dynamic-workflow-builder nunca e invocavel', () => {
  it('agent({ agentType: dynamic-workflow-builder }) -> fatal agent-denylisted com o motivo', async () => {
    const h = makeHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');
    let caught: unknown;
    try {
      await api.agent({ agentType: 'dynamic-workflow-builder', prompt: 'gere um pacote' } as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowHostFatalError);
    expect((caught as WorkflowHostFatalError).code).toBe('agent-denylisted');
    expect((caught as WorkflowHostFatalError).message).toMatch(/denylist/);
    expect((caught as WorkflowHostFatalError).message).toMatch(/dynamic-workflow-builder/);
    expect(h.state.journal).toHaveLength(0);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('RESUME de definition ANTIGA com node pre-declarado do builder falha com a denylist MESMO com cache-hit possivel (nada replayado)', async () => {
    const manifest = ccManifest();
    manifest.nodes.push({
      id: 'builder-node',
      type: 'agent',
      phaseId: 'Build',
      agentId: 'dynamic-workflow-builder',
      access: 'read-only',
      allowedTools: ['Read'],
      canResume: true,
      produces: [],
      consumes: [],
    });
    const seeded: DynamicWorkflowJournalEntry = {
      runId: 'run-cc',
      callIndex: 1,
      callPath: 'builder-node:agent',
      primitive: 'agent',
      nodeId: 'builder-node',
      argHash: computeNodeInputHash({
        agentId: 'dynamic-workflow-builder',
        prompt: 'x',
        access: 'read-only',
        writeSet: [],
      }),
      schemaRef: null,
      policyHash: computeNodeGrantsHash({
        nodeId: 'builder-node',
        agentId: 'dynamic-workflow-builder',
        access: 'read-only',
        allowedTools: ['Read'],
        allowedMcpServers: [],
        allowedMcpTools: [],
        allowedCommands: [],
        allowBash: false,
        allowNetwork: false,
        timeoutMs: undefined,
        costCeilingUsd: undefined,
      }),
      agentId: 'dynamic-workflow-builder',
      model: null,
      runtime: null,
      planHash: null,
      workflowRevision: null,
      outputRef: 'builder-node#1',
      sideEffectKey: null,
      createdAt: '2026-06-26T00:00:00.000Z',
    };
    const adapter = vi.fn((input: RunNodeAgentInput) =>
      Promise.resolve(makeResult(input, '{"never":1}')),
    );
    const h = makeHarness({ adapter, initialJournal: [seeded] });
    const ctx = makeCtx({ manifest });
    saveNodeCheckpoint(
      {
        getRunCheckpoint: () => h.state.runCheckpointJson,
        persistRunCheckpoint: (_runId, json) => {
          h.state.runCheckpointJson = json;
        },
      },
      {
        runId: 'run-cc',
        runDir: ctx.runDir,
        nodeId: 'builder-node',
        attempt: 1,
        state: { cached: 'output-do-builder' },
      },
    );
    const api = createWorkflowHostApi(ctx, h.deps);
    let caught: unknown;
    try {
      await api.agent({ id: 'builder-node', agentId: 'dynamic-workflow-builder', prompt: 'x' } as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowHostFatalError);
    expect((caught as WorkflowHostFatalError).code).toBe('agent-denylisted');
    expect(h.state.events.some((e) => e.type === 'node-cache-hit')).toBe(false);
    expect(adapter).not.toHaveBeenCalled();
    expect(h.state.journal).toEqual([seeded]);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});


function makeSchemaResult(
  input: RunNodeAgentInput,
  structured: unknown,
): NodeRunResult {
  const base = makeResult(input, JSON.stringify(structured));
  return input.outputSchema !== undefined
    ? { ...base, structuredOutput: structured }
    : base;
}

const INLINE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['summary', 'items'],
  properties: {
    summary: { type: 'string' },
    items: { type: 'array' },
  },
} as const;

describe('F1f schema no call-site: node implicito read-only com schema inline', () => {
  it('schema inline -> schemaRef canonico cc-schema:<hash> + structured output validado', async () => {
    const seen: RunNodeAgentInput[] = [];
    const adapter = vi.fn((input: RunNodeAgentInput) => {
      seen.push(input);
      return Promise.resolve(makeSchemaResult(input, { summary: 'ok', items: [1, 2] }));
    });
    const h = makeHarness({ adapter });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');

    const out = await api.agent({
      agentType: 'a-reader',
      prompt: 'mapeie',
      schema: INLINE_SCHEMA,
    } as never);

    const node = ctx.manifest.nodes.find((n) => n.id === 'cc:Build:a-reader:0')!;
    expect(node.schemaRef).toMatch(/^cc-schema:[0-9a-f]{64}$/);

    expect(seen).toHaveLength(1);
    expect(seen[0].outputSchema).toEqual({ type: 'object', required: ['summary', 'items'] });

    expect(out).toEqual({ summary: 'ok', items: [1, 2] });
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('DETERMINISMO: o MESMO schema inline -> MESMO hash/ref nas duas passadas (resume estavel)', async () => {
    async function refForSchema(schema: unknown): Promise<string> {
      const adapter = vi.fn((input: RunNodeAgentInput) =>
        Promise.resolve(makeSchemaResult(input, { summary: 'ok', items: [] })),
      );
      const h = makeHarness({ adapter });
      const ctx = makeCtx();
      const api = createWorkflowHostApi(ctx, h.deps);
      await api.phase('Build');
      await api.agent({ agentType: 'a-reader', prompt: 'p', schema } as never);
      const ref = ctx.manifest.nodes.find((n) => n.id === 'cc:Build:a-reader:0')!.schemaRef!;
      rmSync(ctx.runDir, { recursive: true, force: true });
      return ref;
    }

    const r1 = await refForSchema(INLINE_SCHEMA);
    const r2 = await refForSchema(INLINE_SCHEMA);
    expect(r1).toBe(r2);

    const reordered = {
      properties: { items: { type: 'array' }, summary: { type: 'string' } },
      required: ['summary', 'items'],
      type: 'object',
      $schema: 'http://json-schema.org/draft-07/schema#',
    };
    expect(await refForSchema(reordered)).toBe(r1);

    const other = { type: 'object', required: ['verdict'] };
    expect(await refForSchema(other)).not.toBe(r1);
  });

  it('DETERMINISMO no inputHash: schema inline entra na chave do journal (run==resume)', async () => {
    async function journalKeyForSchema(schema: unknown): Promise<{ argHash: string; schemaRef: string | null }> {
      const adapter = vi.fn((input: RunNodeAgentInput) =>
        Promise.resolve(makeSchemaResult(input, { summary: 'ok', items: [] })),
      );
      const h = makeHarness({ adapter });
      const ctx = makeCtx();
      const api = createWorkflowHostApi(ctx, h.deps);
      await api.phase('Build');
      await api.agent({ agentType: 'a-reader', prompt: 'p', schema } as never);
      const entry = h.state.journal.find((e) => e.nodeId === 'cc:Build:a-reader:0')!;
      rmSync(ctx.runDir, { recursive: true, force: true });
      return { argHash: entry.argHash, schemaRef: entry.schemaRef };
    }

    const a = await journalKeyForSchema(INLINE_SCHEMA);
    const b = await journalKeyForSchema(INLINE_SCHEMA);
    expect(a.schemaRef).toMatch(/^cc-schema:[0-9a-f]{64}$/);
    expect(a.schemaRef).toBe(b.schemaRef);
    expect(a.argHash).toBe(b.argHash);
    const c = await journalKeyForSchema({ type: 'object', required: ['x'] });
    expect(c.argHash).not.toBe(a.argHash);
  });
});

describe('F1f schema no call-site: schema como STRING (ref nomeado)', () => {
  it('schema string -> usa o ref nomeado e resolve pelo caminho de disco (ctx.resolveSchemaRef)', async () => {
    const NAMED: { type: 'object'; required: string[] } = {
      type: 'object',
      required: ['verdict'],
    };
    const seen: RunNodeAgentInput[] = [];
    const adapter = vi.fn((input: RunNodeAgentInput) => {
      seen.push(input);
      return Promise.resolve(makeSchemaResult(input, { verdict: 'pass' }));
    });
    const h = makeHarness({ adapter });
    const ctx = makeCtx({
      resolveSchemaRef: (ref) => (ref === 'plan-findings.json' ? NAMED : null),
    });
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');

    const out = await api.agent({
      agentType: 'a-reader',
      prompt: 'valide',
      schema: 'plan-findings.json',
    } as never);

    const node = ctx.manifest.nodes.find((n) => n.id === 'cc:Build:a-reader:0')!;
    expect(node.schemaRef).toBe('plan-findings.json');
    expect(seen[0].outputSchema).toEqual(NAMED);
    expect(out).toEqual({ verdict: 'pass' });
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('F1f schema no call-site: WRITER com schema -> FATAL writer-schema-forbidden', () => {
  it('writer (workspace-write) inline schema -> fatal writer-schema-forbidden', async () => {
    const h = makeHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');

    let caught: unknown;
    try {
      await api.agent({ agentType: 'a-writer', prompt: 'escreva', schema: INLINE_SCHEMA } as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowHostFatalError);
    expect((caught as WorkflowHostFatalError).code).toBe('writer-schema-forbidden');
    expect(ctx.manifest.nodes).toHaveLength(0);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('writer (workspace-write) STRING schema -> tambem fatal writer-schema-forbidden', async () => {
    const h = makeHarness();
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');

    let caught: unknown;
    try {
      await api.agent({ agentType: 'a-writer', prompt: 'escreva', schema: 'x.json' } as never);
    } catch (err) {
      caught = err;
    }
    expect((caught as WorkflowHostFatalError).code).toBe('writer-schema-forbidden');
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('writer SEM schema continua livre (sem trava, byte-identico ao caminho do coder)', async () => {
    const seen: RunNodeAgentInput[] = [];
    const adapter = vi.fn((input: RunNodeAgentInput) => {
      seen.push(input);
      return Promise.resolve(makeResult(input, '{"ok":1}'));
    });
    const h = makeHarness({ adapter });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');
    await api.agent({ agentType: 'a-writer', prompt: 'escreva' } as never);

    const node = ctx.manifest.nodes.find((n) => n.id === 'cc:Build:a-writer:0')!;
    expect(node.schemaRef).toBeUndefined();
    expect(seen[0].outputSchema).toBeUndefined();
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('F1f schema no call-site: node PRE-DECLARADO ignora arg.schema', () => {
  it('node pre-declarado com arg.schema -> schema IGNORADO (so manifestNode.schemaRef vale)', async () => {
    const seen: RunNodeAgentInput[] = [];
    const adapter = vi.fn((input: RunNodeAgentInput) => {
      seen.push(input);
      return Promise.resolve(makeResult(input, '{"ok":1}'));
    });
    const h = makeHarness({ adapter });
    const manifest: DynamicWorkflowManifest = {
      version: 1,
      name: 'manifest-wf',
      phases: [{ id: 'Build', name: 'Build', order: 0 }],
      nodes: [
        {
          id: 'n1',
          type: 'agent',
          phaseId: 'Build',
          agentId: 'a-reader',
          access: 'read-only',
          allowedTools: ['Read'],
          allowedCommands: [],
          allowBash: false,
          allowNetwork: false,
          canResume: true,
          produces: [],
          consumes: [],
        },
      ],
      parallelism: { maxConcurrentAgents: 3, parallelWritersAllowed: false },
      gates: [],
      estimate: { minUsd: 0, maxUsd: 1, unknownCostNodes: [] },
    };
    const ctx = makeCtx({ manifest });
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.agent({ id: 'n1', agentId: 'a-reader', prompt: 'x', schema: INLINE_SCHEMA } as never);

    expect(ctx.manifest.nodes.find((n) => n.id === 'n1')!.schemaRef).toBeUndefined();
    expect(seen[0].outputSchema).toBeUndefined();
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});


describe('F3 model override: effectiveModel chega ao adapter (claude-code)', () => {
  it('agent({ model }) -> o adapter recebe input.effectiveModel = override', async () => {
    const seen: RunNodeAgentInput[] = [];
    const adapter = vi.fn((input: RunNodeAgentInput) => {
      seen.push(input);
      return Promise.resolve(makeResult(input, '{"ok":1}'));
    });
    const h = makeHarness({ adapter });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');
    await api.agent({
      agentType: 'a-reader',
      prompt: 'mapeie',
      model: 'claude-sonnet-4-6',
    } as never);

    expect(seen).toHaveLength(1);
    expect(seen[0].effectiveModel).toBe('claude-sonnet-4-6');
    expect(seen[0].agentId).toBe('a-reader');
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('SEM override -> o adapter NAO recebe effectiveModel (undefined)', async () => {
    const seen: RunNodeAgentInput[] = [];
    const adapter = vi.fn((input: RunNodeAgentInput) => {
      seen.push(input);
      return Promise.resolve(makeResult(input, '{"ok":1}'));
    });
    const h = makeHarness({ adapter });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');
    await api.agent({ agentType: 'a-reader', prompt: 'mapeie' } as never);

    expect(seen[0].effectiveModel).toBeUndefined();
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('F3 model override: HASH CONDICIONAL (resume legado intacto)', () => {
  async function argHashFor(arg: Record<string, unknown>): Promise<string> {
    const adapter = vi.fn((input: RunNodeAgentInput) =>
      Promise.resolve(makeResult(input, '{"ok":1}')),
    );
    const h = makeHarness({ adapter });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');
    await api.agent({ agentType: 'a-reader', prompt: 'p', ...arg } as never);
    const entry = h.state.journal.find((e) => e.nodeId === 'cc:Build:a-reader:0')!;
    rmSync(ctx.runDir, { recursive: true, force: true });
    return entry.argHash;
  }

  it('CRITICO: SEM override -> argHash IDENTICO ao computeNodeInputHash legado (sem effectiveModel)', async () => {
    const journaled = await argHashFor({});
    const legacy = computeNodeInputHash({
      agentId: 'a-reader',
      prompt: 'p',
      access: 'read-only',
      schemaRef: undefined,
      writeSet: [],
    });
    expect(journaled).toBe(legacy);
  });

  it('CRITICO: COM override -> argHash MUDA (re-roda no resume)', async () => {
    const noOverride = await argHashFor({});
    const withOverride = await argHashFor({ model: 'claude-sonnet-4-6' });
    expect(withOverride).not.toBe(noOverride);
    const withOverride2 = await argHashFor({ model: 'claude-sonnet-4-6' });
    expect(withOverride2).toBe(withOverride);
    const otherOverride = await argHashFor({ model: 'claude-opus-4-8' });
    expect(otherOverride).not.toBe(withOverride);
  });

  it('computeNodeInputHash: effectiveModel ausente == undefined (mesma saida, prova a condicionalidade)', () => {
    const base = {
      agentId: 'a',
      prompt: 'x',
      access: 'read-only',
      schemaRef: undefined,
      writeSet: ['src/**'],
    };
    expect(computeNodeInputHash(base)).toBe(
      computeNodeInputHash({ ...base, effectiveModel: undefined }),
    );
    expect(computeNodeInputHash({ ...base, effectiveModel: 'm1' })).not.toBe(
      computeNodeInputHash(base),
    );
  });
});



describe('S4 effort override: effectiveEffort chega ao adapter (claude-code)', () => {
  it('agent({ effort }) -> o adapter recebe input.effectiveEffort = override', async () => {
    const seen: RunNodeAgentInput[] = [];
    const adapter = vi.fn((input: RunNodeAgentInput) => {
      seen.push(input);
      return Promise.resolve(makeResult(input, '{"ok":1}'));
    });
    const h = makeHarness({ adapter });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');
    await api.agent({ agentType: 'a-reader', prompt: 'valide', effort: 'xhigh' } as never);

    expect(seen).toHaveLength(1);
    expect(seen[0].effectiveEffort).toBe('xhigh');
    expect(seen[0].agentId).toBe('a-reader');
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('SEM override -> o adapter NAO recebe effectiveEffort (undefined)', async () => {
    const seen: RunNodeAgentInput[] = [];
    const adapter = vi.fn((input: RunNodeAgentInput) => {
      seen.push(input);
      return Promise.resolve(makeResult(input, '{"ok":1}'));
    });
    const h = makeHarness({ adapter });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');
    await api.agent({ agentType: 'a-reader', prompt: 'valide' } as never);

    expect(seen[0].effectiveEffort).toBeUndefined();
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('effort INVALIDO -> fatal effort-invalid ANTES de qualquer dispatch (adapter nunca chamado)', async () => {
    const adapter = vi.fn((input: RunNodeAgentInput) =>
      Promise.resolve(makeResult(input, '{"ok":1}')),
    );
    const h = makeHarness({ adapter });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');

    await expect(
      api.agent({ agentType: 'a-reader', prompt: 'p', effort: 'turbo' } as never),
    ).rejects.toMatchObject({ code: 'effort-invalid' });
    await expect(
      api.agent({ agentType: 'a-reader', prompt: 'p', effort: 'mega' } as never),
    ).rejects.toBeInstanceOf(WorkflowHostFatalError);
    expect(adapter).not.toHaveBeenCalled();
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});

describe('S4 effort override: HASH CONDICIONAL (resume legado intacto)', () => {
  async function argHashFor(arg: Record<string, unknown>): Promise<string> {
    const adapter = vi.fn((input: RunNodeAgentInput) =>
      Promise.resolve(makeResult(input, '{"ok":1}')),
    );
    const h = makeHarness({ adapter });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.phase('Build');
    await api.agent({ agentType: 'a-reader', prompt: 'p', ...arg } as never);
    const entry = h.state.journal.find((e) => e.nodeId === 'cc:Build:a-reader:0')!;
    rmSync(ctx.runDir, { recursive: true, force: true });
    return entry.argHash;
  }

  it('CRITICO: SEM effort -> argHash IDENTICO ao computeNodeInputHash legado (resume intacto)', async () => {
    const journaled = await argHashFor({});
    const legacy = computeNodeInputHash({
      agentId: 'a-reader',
      prompt: 'p',
      access: 'read-only',
      schemaRef: undefined,
      writeSet: [],
    });
    expect(journaled).toBe(legacy);
  });

  it('CRITICO: COM effort -> argHash MUDA (re-roda no resume) e e deterministico', async () => {
    const noOverride = await argHashFor({});
    const withEffort = await argHashFor({ effort: 'xhigh' });
    expect(withEffort).not.toBe(noOverride);
    const withEffort2 = await argHashFor({ effort: 'xhigh' });
    expect(withEffort2).toBe(withEffort);
    const otherEffort = await argHashFor({ effort: 'low' });
    expect(otherEffort).not.toBe(withEffort);
    const modelAndEffort = await argHashFor({ model: 'claude-sonnet-4-6', effort: 'xhigh' });
    expect(modelAndEffort).not.toBe(withEffort);
  });

  it('computeNodeInputHash: effectiveEffort ausente == undefined (prova a condicionalidade)', () => {
    const base = {
      agentId: 'a',
      prompt: 'x',
      access: 'read-only',
      schemaRef: undefined,
      writeSet: ['src/**'],
    };
    expect(computeNodeInputHash(base)).toBe(
      computeNodeInputHash({ ...base, effectiveEffort: undefined }),
    );
    expect(computeNodeInputHash({ ...base, effectiveEffort: 'xhigh' })).not.toBe(
      computeNodeInputHash(base),
    );
  });
});



describe('D8: computeNodeInputHash com `adjustment` CONDICIONAL (hash literal do baseline)', () => {
  const base = {
    agentId: 'a-reader',
    prompt: 'p',
    access: 'read-only',
    schemaRef: undefined,
    writeSet: [] as string[],
  };
  const BASELINE = 'cd730d9cd5de867e317c2a8c526d82a2a02c4161698883cf77ad9cc2da33eb1c';

  it('CRITICO: SEM ajuste = hash LITERAL do baseline (byte-identico ao legado)', () => {
    expect(computeNodeInputHash(base)).toBe(BASELINE);
    expect(computeNodeInputHash({ ...base, adjustment: undefined })).toBe(BASELINE);
    expect(computeNodeInputHash({ ...base, adjustment: '' })).toBe(BASELINE);
  });

  it('COM ajuste: hash diferente do baseline, DETERMINISTICO e literal', () => {
    const withAdj = computeNodeInputHash({ ...base, adjustment: 'foque em X' });
    expect(withAdj).not.toBe(BASELINE);
    expect(withAdj).toBe('0eee42fcbd90f5bd73dade4b4a276387f05a9de20ab14d04e94e5f4384ece566');
    expect(computeNodeInputHash({ ...base, adjustment: 'foque em X' })).toBe(withAdj);
    expect(computeNodeInputHash({ ...base, adjustment: 'foque em Y' })).not.toBe(withAdj);
  });
});
