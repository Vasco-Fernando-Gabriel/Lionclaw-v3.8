
import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWorkflow,
  type CreateWorkflowDeps,
} from '../dynamic-workflows/workflow-create';

import {
  createWorkflowHostApi,
  type HostApiRunContext,
  type HostApiDeps,
  type HostApiCrud,
  type GateGate,
  type PendingGateResolution,
} from '../dynamic-workflows/workflow-host-api';

import type {
  DynamicWorkflowAgentSummary,
  DynamicWorkflowDefinition,
  DynamicWorkflowDefinitionCreateInput,
  DynamicWorkflowManifest,
  DynamicWorkflowNodeCreateInput,
  DynamicWorkflowNodeRun,
  DynamicWorkflowNodeRunUpsertInput,
  DynamicWorkflowNodeRunPatch,
  DynamicWorkflowRun,
  DynamicWorkflowRunCreateInput,
  DynamicWorkflowEvent,
  DynamicWorkflowEventInsertInput,
  DynamicWorkflowGateDecision,
  DynamicWorkflowGateDecisionInsertInput,
  DynamicWorkflowArtifact,
  DynamicWorkflowArtifactInsertInput,
  DynamicWorkflowJournalEntry,
  DynamicWorkflowJournalAppendInput,
} from '../dynamic-workflows/types';
import type {
  NodeRunResult,
  RunNodeAgentInput,
} from '../dynamic-workflows/workflow-agent-adapter';


const CLAUDE_CODE_WORKFLOW_JS = `export const meta = {
  name: 'cc-e2e',
  description: 'Workflow claude-code end-to-end de teste',
};

await phase('plan');
const map = await agent({
  agentType: 'cc-reader',
  label: 'map',
  prompt: 'mapeie o repo',
  schema: { type: 'object', required: ['summary'] },
});
const reviews = await parallel([
  () => agent({ agentType: 'cc-reader', label: 'rev-a', prompt: 'revise A' }),
  () => agent({ agentType: 'cc-reader', label: 'rev-b', prompt: 'revise B' }),
], { id: 'reviews-r0', maxConcurrency: 2 });
return { map, reviews };
`;


interface Captured {
  definitions: DynamicWorkflowDefinitionCreateInput[];
  runs: DynamicWorkflowRunCreateInput[];
  nodes: DynamicWorkflowNodeCreateInput[];
}

const CREATE_CATALOG: DynamicWorkflowAgentSummary[] = [
  { id: 'cc-reader', name: 'CC Reader', runtime: 'cloud' },
  { id: 'cc-codex', name: 'CC Codex', runtime: 'codex' },
];

function makeCreateDeps(captured: Captured): CreateWorkflowDeps {
  let seq = 0;
  return {
    loadAgentCatalog: () => CREATE_CATALOG,
    createDefinition: (input): DynamicWorkflowDefinition => {
      captured.definitions.push(input);
      return stubDefinition(input);
    },
    createRun: (input): DynamicWorkflowRun => {
      captured.runs.push(input);
      return stubRun(input);
    },
    generateRunId: () => `run_${(seq += 1)}`,
    generateId: (prefix: string) => `${prefix}_${(seq += 1)}`,
    now: () => '2026-06-26T00:00:00.000Z',
  };
}

function stubDefinition(
  input: DynamicWorkflowDefinitionCreateInput,
): DynamicWorkflowDefinition {
  return {
    id: input.id,
    name: input.name,
    definitionVersion: input.definitionVersion ?? 1,
    authoringModel: 'claude-code',
    parentDefinitionId: input.parentDefinitionId ?? null,
    supersedesDefinitionId: input.supersedesDefinitionId ?? null,
    sourceType: input.sourceType,
    projectPath: input.projectPath,
    specPath: input.specPath ?? null,
    specSha256: input.specSha256 ?? null,
    workflowJsPath: input.workflowJsPath,
    manifestPath: input.manifestPath,
    manifestJson: input.manifestJson,
    manifestHash: input.manifestHash,
    contextBundlePath: input.contextBundlePath ?? null,
    builderModel: input.builderModel ?? null,
    status: input.status,
    createdAt: '2026-06-26T00:00:00.000Z',
    updatedAt: '2026-06-26T00:00:00.000Z',
  };
}

function stubRun(input: DynamicWorkflowRunCreateInput): DynamicWorkflowRun {
  return {
    id: input.id,
    definitionId: input.definitionId,
    chatSessionId: input.chatSessionId ?? null,
    status: input.status ?? 'created',
    currentPhaseId: null,
    currentNodeId: null,
    workspaceMode: input.workspaceMode ?? null,
    baseBranch: input.baseBranch ?? null,
    baseCommitSha: input.baseCommitSha ?? null,
    baseWorktreeHash: input.baseWorktreeHash ?? null,
    worktreePath: input.worktreePath ?? null,
    worktreeBranch: input.worktreeBranch ?? null,
    deliveredAt: null,
    finalizedAt: null,
    closerSessionId: null,
    closerStatus: null,
    inputJson: input.inputJson ?? '{}',
    outputJson: null,
    checkpointJson: '{}',
    error: null,
    totalCostUsd: 0,
    totalDurationMs: 0,
    createdBy: input.createdBy,
    startedAt: null,
    updatedAt: '2026-06-26T00:00:00.000Z',
    completedAt: null,
  };
}


type Axes = NonNullable<ReturnType<NonNullable<HostApiRunContext['resolveAgentAxes']>>>;

const RUN_AXES: Record<string, Axes> = {
  'cc-reader': {
    access: 'read-only',
    allowBash: false,
    allowedCommands: [],
    allowNetwork: false,
    allowedTools: ['Read', 'Grep'],
  },
  'cc-codex': {
    access: 'read-only',
    allowBash: false,
    allowedCommands: [],
    allowNetwork: false,
    allowedTools: ['Read'],
  },
};

function resolveRunAxes(agentType: string): Axes | null {
  return RUN_AXES[agentType] ?? null;
}

function runtimeFor(agentId: string): { runtime: NodeRunResult['runtime']; family: NodeRunResult['family'] } {
  if (agentId === 'cc-codex') return { runtime: 'codex', family: 'codex' };
  return { runtime: 'cloud', family: 'claude-compatible' };
}

interface RunHarness {
  deps: HostApiDeps;
  state: {
    nodeRuns: Map<string, DynamicWorkflowNodeRun>;
    events: Array<{ type: string; nodeId?: string | null; payload?: unknown }>;
    runCheckpointJson: string;
    journal: DynamicWorkflowJournalEntry[];
    adapterCalls: Array<{ nodeId: string; agentId: string }>;
  };
}

function makeRunResult(input: RunNodeAgentInput): NodeRunResult {
  const { runtime, family } = runtimeFor(input.agentId);
  const structured =
    input.outputSchema !== undefined
      ? { summary: `done:${input.grants.nodeId}` }
      : undefined;
  const base: NodeRunResult = {
    ok: true,
    output: JSON.stringify({ node: input.grants.nodeId }),
    runtime,
    family,
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
  return structured !== undefined ? { ...base, structuredOutput: structured } : base;
}

function makeRunHarness(over?: {
  adapter?: (input: RunNodeAgentInput) => Promise<NodeRunResult>;
  initialJournal?: DynamicWorkflowJournalEntry[];
}): RunHarness {
  const state: RunHarness['state'] = {
    nodeRuns: new Map(),
    events: [],
    runCheckpointJson: '{}',
    journal: over?.initialJournal ? [...over.initialJournal] : [],
    adapterCalls: [],
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

  const adapter =
    over?.adapter ??
    ((input: RunNodeAgentInput) => Promise.resolve(makeRunResult(input)));

  const deps: HostApiDeps = {
    crud,
    gateGate,
    runNodeAgent: (input) => {
      state.adapterCalls.push({ nodeId: input.grants.nodeId, agentId: input.agentId });
      return adapter(input);
    },
    emit: (input) => state.events.push({ type: input.type, nodeId: input.nodeId, payload: input.payload }),
    generateId: (prefix) => `${prefix}_${state.nodeRuns.size}`,
    now: () => '2026-06-26T00:00:00.000Z',
  };

  return { deps, state };
}

function ccRunManifest(): DynamicWorkflowManifest {
  return {
    version: 1,
    name: 'cc-e2e',
    phases: [{ id: 'plan', name: 'plan', order: 0 }],
    nodes: [],
    parallelism: { maxConcurrentAgents: 8, parallelWritersAllowed: false },
    gates: [],
    estimate: { minUsd: 0, maxUsd: 30, unknownCostNodes: [] },
  };
}

function makeRunCtx(over?: Partial<HostApiRunContext>): HostApiRunContext {
  const runDir = mkdtempSync(join(tmpdir(), 'dwf-cc-e2e-'));
  return {
    runId: 'run-cc-e2e',
    manifest: ccRunManifest(),
    workspaceRoot: runDir,
    runDir,
    abortSignal: new AbortController().signal,
    resolveAgentAxes: resolveRunAxes,
    ...over,
  };
}

async function runClaudeCodeBody(
  ctx: HostApiRunContext,
  deps: HostApiDeps,
  opts?: { withCodexNode?: boolean },
): Promise<{ map: unknown; reviews: unknown[]; codex?: unknown }> {
  const api = createWorkflowHostApi(ctx, deps);
  await api.phase('plan');
  const map = await api.agent({
    agentType: 'cc-reader',
    label: 'map',
    prompt: 'mapeie o repo',
    schema: { type: 'object', required: ['summary'] },
  } as never);
  const reviews = (await api.parallel(
    {
      thunks: [
        () => api.agent({ agentType: 'cc-reader', label: 'rev-a', prompt: 'revise A' } as never),
        () => api.agent({ agentType: 'cc-reader', label: 'rev-b', prompt: 'revise B' } as never),
      ],
      options: { id: 'reviews-r0', maxConcurrency: 2 },
    } as never,
  )) as unknown[];
  let codex: unknown;
  if (opts?.withCodexNode) {
    codex = await api.agent({
      agentType: 'cc-codex',
      label: 'codex-check',
      prompt: 'verifique via codex',
    } as never);
  }
  return { map, reviews, codex };
}

function completedNodeRun(h: RunHarness, nodeId: string): DynamicWorkflowNodeRun | undefined {
  return [...h.state.nodeRuns.values()].find((n) => n.nodeId === nodeId && n.status === 'completed');
}


describe('claude-code e2e (1) CRIAR de um .js inline (sem SPEC, sem manifesto)', () => {
  it('cria definition claude-code + manifesto derivado (nodes:[]), run created', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dwf-cc-create-'));
    const captured: Captured = { definitions: [], runs: [], nodes: [] };

    const result = await createWorkflow(
      {
        projectPath: projectDir,
        origin: 'manual',
        workflowSource: CLAUDE_CODE_WORKFLOW_JS,
      },
      makeCreateDeps(captured),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(existsSync(join(result.runDir, 'workflow.js'))).toBe(true);
    expect(existsSync(join(result.runDir, 'workflow.manifest.json'))).toBe(true);

    expect(captured.definitions).toHaveLength(1);
    const def = captured.definitions[0]!;
    expect(def.sourceType).toBe('claude-code');
    expect(def.specPath).toBeNull();
    expect(def.specSha256).toBeNull();
    expect(def.status).toBe('validated');

    const manifest = JSON.parse(def.manifestJson) as DynamicWorkflowManifest;
    expect(manifest.name).toBe('cc-e2e');
    expect(manifest.description).toBe('Workflow claude-code end-to-end de teste');
    expect(manifest.nodes).toEqual([]);
    expect(manifest.gates).toEqual([]);
    expect(manifest.phases).toEqual([]);

    expect(captured.runs).toHaveLength(1);
    expect(captured.runs[0]!.status).toBe('created');
    expect(captured.nodes).toHaveLength(0);

    rmSync(projectDir, { recursive: true, force: true });
  });
});


describe('claude-code e2e (2) RODAR: nodes implicitos, ordem, eixos, completa', () => {
  it('executa phase->agent->parallel->return com ids estaveis e eixos do agentType', async () => {
    const h = makeRunHarness();
    const ctx = makeRunCtx();

    const out = await runClaudeCodeBody(ctx, h.deps);

    const ids = ctx.manifest.nodes.map((n) => n.id);
    expect(ids).toEqual([
      'cc:plan:map:0',
      'cc:plan:rev-a:0',
      'cc:plan:rev-b:0',
    ]);
    expect(new Set(ids).size).toBe(3);

    const order = h.state.adapterCalls.map((c) => c.nodeId);
    expect(order).toHaveLength(3);
    expect(order[0]).toBe('cc:plan:map:0');
    expect(order.slice(1).sort()).toEqual(['cc:plan:rev-a:0', 'cc:plan:rev-b:0']);

    for (const id of ids) {
      const node = ctx.manifest.nodes.find((n) => n.id === id)!;
      expect(node.access).toBe('read-only');
      expect(node.allowBash).toBe(false);
      expect(node.allowNetwork).toBe(false);
      expect(node.agentId).toBe('cc-reader');
    }

    expect(ctx.manifest.phases.some((p) => p.id === 'plan')).toBe(true);

    expect(completedNodeRun(h, 'cc:plan:map:0')).toBeTruthy();
    expect(completedNodeRun(h, 'cc:plan:rev-a:0')).toBeTruthy();
    expect(completedNodeRun(h, 'cc:plan:rev-b:0')).toBeTruthy();

    expect(out.map).toEqual({ summary: 'done:cc:plan:map:0' });
    expect(Array.isArray(out.reviews)).toBe(true);
    expect(out.reviews).toHaveLength(2);
    expect(JSON.parse(String(out.reviews[0]))).toEqual({ node: 'cc:plan:rev-a:0' });
    expect(JSON.parse(String(out.reviews[1]))).toEqual({ node: 'cc:plan:rev-b:0' });

    expect(h.state.adapterCalls).toHaveLength(3);

    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});


describe('claude-code e2e (3) RESUME: prefixo reusado pelo journal, nada re-roda', () => {
  it('PASS 2 no mesmo runDir/journal NAO re-chama o adapter (reuso por journal)', async () => {
    const adapter = vi.fn((input: RunNodeAgentInput) => Promise.resolve(makeRunResult(input)));
    const h = makeRunHarness({ adapter });
    const runDir = mkdtempSync(join(tmpdir(), 'dwf-cc-e2e-resume-'));

    const ctx1 = makeRunCtx({ runDir });
    const out1 = await runClaudeCodeBody(ctx1, h.deps);
    expect(adapter).toHaveBeenCalledTimes(3);
    expect(out1.map).toEqual({ summary: 'done:cc:plan:map:0' });

    const journal1 = [...h.state.journal].sort((a, b) => a.callIndex - b.callIndex);
    const nodeJournal1 = journal1.filter((e) => e.nodeId).map((e) => e.nodeId);
    expect(nodeJournal1).toEqual(['cc:plan:map:0', 'cc:plan:rev-a:0', 'cc:plan:rev-b:0']);
    const hashes1 = journal1.filter((e) => e.nodeId).map((e) => e.policyHash);

    const ctx2 = makeRunCtx({ runDir });
    const out2 = await runClaudeCodeBody(ctx2, h.deps);

    expect(adapter).toHaveBeenCalledTimes(3);
    expect(out2.map).toEqual({ summary: 'done:cc:plan:map:0' });
    expect(JSON.parse(String(out2.reviews[0]))).toEqual({ node: 'cc:plan:rev-a:0' });
    expect(JSON.parse(String(out2.reviews[1]))).toEqual({ node: 'cc:plan:rev-b:0' });

    const cacheHits = h.state.events.filter((e) => e.type === 'node-cache-hit').map((e) => e.nodeId);
    expect(cacheHits.sort()).toEqual(['cc:plan:map:0', 'cc:plan:rev-a:0', 'cc:plan:rev-b:0']);

    const journal2 = [...h.state.journal].sort((a, b) => a.callIndex - b.callIndex);
    const hashes2 = journal2.filter((e) => e.nodeId).map((e) => e.policyHash);
    expect(hashes2).toEqual(hashes1);

    rmSync(runDir, { recursive: true, force: true });
  });
});


describe('claude-code e2e (4) runtime diferente (codex) nao quebra o fluxo', () => {
  it('node cc-codex roda no MESMO run; node_run persiste runtime=codex; run completa', async () => {
    const h = makeRunHarness();
    const ctx = makeRunCtx();

    const out = await runClaudeCodeBody(ctx, h.deps, { withCodexNode: true });

    const ids = ctx.manifest.nodes.map((n) => n.id);
    expect(ids).toEqual([
      'cc:plan:map:0',
      'cc:plan:rev-a:0',
      'cc:plan:rev-b:0',
      'cc:plan:codex-check:0',
    ]);

    const mapRun = completedNodeRun(h, 'cc:plan:map:0');
    const codexRun = completedNodeRun(h, 'cc:plan:codex-check:0');
    expect(mapRun?.runtime).toBe('cloud');
    expect(codexRun?.runtime).toBe('codex');
    expect(codexRun?.agentId).toBe('cc-codex');

    expect(JSON.parse(String(out.codex))).toEqual({ node: 'cc:plan:codex-check:0' });
    expect(h.state.adapterCalls).toHaveLength(4);
    expect([...h.state.nodeRuns.values()].every((n) => n.status === 'completed')).toBe(true);

    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});
