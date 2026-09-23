import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  WorkflowRunner,
  _resetRunLocksForTesting,
  type WorkflowRunnerDeps,
  type WorkflowRunnerCrud,
} from '../dynamic-workflows/workflow-runner';
import { digestCoordinatorValue, COORDINATOR_VALUE_DIGEST_MAX_CHARS } from '../dynamic-workflows/workflow-runner';
import type { SandboxProcessFactory, SandboxProcessHandle } from '../dynamic-workflows/workflow-sandbox';
import type { SandboxParentMessage, SandboxChildMessage } from '../dynamic-workflows/sandbox-protocol';
import type {
  DynamicWorkflowRun,
  DynamicWorkflowDefinition,
  DynamicWorkflowManifest,
  DynamicWorkflowNodeRun,
  DynamicWorkflowGateDecisionInsertInput,
  DynamicWorkflowMessageInsertInput,
} from '../dynamic-workflows/types';

type DynamicWorkflowAuthoringModel = 'manifest' | 'claude-code';
import type { GitRunResult } from '../dynamic-workflows/workflow-git';
import type { CloserTurnResult } from '../dynamic-workflows/workflow-closer';
import type { NodeRunResult, RunNodeAgentInput } from '../dynamic-workflows/workflow-agent-adapter';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface CoordinatorCtx {
  phase: (name: string) => Promise<unknown>;
  agent: (arg: unknown) => Promise<unknown>;
  parallel: (arg: unknown) => Promise<unknown>;
  gate: (arg: unknown) => Promise<unknown>;
}
type Coordinator = (ctx: CoordinatorCtx) => Promise<unknown>;

function makeFakeSandboxFactory(coordinator: Coordinator): SandboxProcessFactory {
  return {
    spawn(): SandboxProcessHandle {
      let onMsg: ((raw: unknown) => void) | null = null;
      let onExit: ((code: number | null, signal: string | null) => void) | null = null;
      let killed = false;
      let nextCallId = 1;
      const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

      const sendToParent = (msg: SandboxChildMessage): void => {
        if (onMsg) onMsg(msg);
      };
      const callPrimitive = (primitive: string, arg: unknown): Promise<unknown> =>
        new Promise<unknown>((resolve, reject) => {
          const callId = nextCallId++;
          pending.set(callId, { resolve, reject });
          sendToParent({ t: 'call', callId, primitive: primitive as never, arg });
        });

      const ctx: CoordinatorCtx = {
        phase: (name) => callPrimitive('phase', name),
        agent: (arg) => callPrimitive('agent', arg),
        parallel: async (arg) => {
          const a = arg as { thunks?: Array<() => Promise<unknown>> };
          const out: unknown[] = [];
          for (const t of a.thunks ?? []) {
            try {
              out.push(await t());
            } catch {
              out.push(null);
            }
          }
          return out;
        },
        gate: (arg) => callPrimitive('gate', arg),
      };

      const handle: SandboxProcessHandle = {
        send: (message: SandboxParentMessage): void => {
          if (killed) return;
          if (message.t === 'run') {
            void (async () => {
              try {
                const value = await coordinator(ctx);
                sendToParent({ t: 'result', value: value ?? null });
              } catch (err) {
                sendToParent({ t: 'fatal', message: err instanceof Error ? err.message : String(err) });
              }
            })();
            return;
          }
          if (message.t === 'primitive-result') {
            const p = pending.get(message.callId);
            if (p) {
              pending.delete(message.callId);
              p.resolve(message.value);
            }
            return;
          }
          if (message.t === 'primitive-error') {
            const p = pending.get(message.callId);
            if (p) {
              pending.delete(message.callId);
              p.reject(new Error(message.message));
            }
            return;
          }
        },
        onMessage: (cb) => {
          onMsg = cb;
          queueMicrotask(() => sendToParent({ t: 'hello', protocol: 1 }));
        },
        onExit: (cb) => {
          onExit = cb;
        },
        kill: () => {
          if (killed) return;
          killed = true;
          if (onExit) onExit(0, null);
        },
      };
      return handle;
    },
  };
}

interface Harness {
  deps: WorkflowRunnerDeps;
  crud: WorkflowRunnerCrud;
  state: {
    runs: Map<string, DynamicWorkflowRun>;
    definitions: Map<string, DynamicWorkflowDefinition>;
    nodeRuns: Map<string, DynamicWorkflowNodeRun>;
    events: Array<{ type: string; runId: string; payload?: unknown; nodeId?: string | null }>;
    gateDecisions: DynamicWorkflowGateDecisionInsertInput[];
    messages: DynamicWorkflowMessageInsertInput[];
  };
}

function makeRun(over?: Partial<DynamicWorkflowRun>): DynamicWorkflowRun {
  return {
    id: 'run-1',
    definitionId: 'def-1',
    chatSessionId: null,
    status: 'created',
    currentPhaseId: null,
    currentNodeId: null,
    workspaceMode: null,
    baseBranch: null,
    baseCommitSha: null,
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
    startedAt: null,
    updatedAt: '2026-06-26T00:00:00.000Z',
    completedAt: null,
    ...over,
  };
}

function ccManifest(): DynamicWorkflowManifest {
  return {
    version: 1,
    name: 'cc-wf',
    phases: [{ id: 'Implementar', name: 'Implementar', order: 0 }],
    nodes: [
      {
        id: 'coder',
        type: 'agent',
        phaseId: 'Implementar',
        agentId: 'a-coder',
        access: 'workspace-write',
        writeSet: ['src/**'],
        canResume: true,
        produces: ['impl'],
        consumes: [],
      },
    ],
    parallelism: { maxConcurrentAgents: 3, parallelWritersAllowed: false },
    gates: [],
    estimate: { minUsd: 0, maxUsd: 1, unknownCostNodes: [] },
  };
}

function ccReadOnlyManifest(): DynamicWorkflowManifest {
  return {
    version: 1,
    name: 'cc-wf-ro',
    phases: [{ id: 'Scout', name: 'Scout', order: 0 }],
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
    ],
    parallelism: { maxConcurrentAgents: 3, parallelWritersAllowed: false },
    gates: [],
    estimate: { minUsd: 0, maxUsd: 1, unknownCostNodes: [] },
  };
}

function writeWorkflowJs(dir: string): string {
  const src = [
    "export const meta = { name: 'cc-wf', description: 'cc-wf de teste do gate de entrega' };",
    "await phase('Implementar');",
    'return { ok: true };',
  ].join('\n');
  const path = join(dir, 'workflow.js');
  writeFileSync(path, src, 'utf8');
  return path;
}

function makeFakeAdapter(): (input: RunNodeAgentInput, deps?: unknown) => Promise<NodeRunResult> {
  return (input) => {
    const result: NodeRunResult = {
      ok: true,
      output: '{"verdict":"ok","findings":[]}',
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
      durationMs: 1,
    };
    return Promise.resolve(result);
  };
}

function makeHarness(opts: {
  coordinator: Coordinator;
  projectPath: string;
  authoringModel?: DynamicWorkflowAuthoringModel;
  manifest?: DynamicWorkflowManifest;
  git?: (args: string[], cwd: string) => Promise<GitRunResult>;
  closerTurn?: (input: { runId: string }) => Promise<CloserTurnResult>;
  run?: Partial<DynamicWorkflowRun>;
}): Harness {
  const workflowJsPath = writeWorkflowJs(opts.projectPath);
  const definition: DynamicWorkflowDefinition = {
    id: 'def-1',
    name: 'cc-wf',
    definitionVersion: 1,
    authoringModel: 'claude-code',
    parentDefinitionId: null,
    supersedesDefinitionId: null,
    sourceType: 'claude-code',
    projectPath: opts.projectPath,
    specPath: null,
    specSha256: null,
    workflowJsPath,
    manifestPath: join(opts.projectPath, 'workflow.manifest.json'),
    manifestJson: JSON.stringify(opts.manifest ?? ccManifest()),
    manifestHash: 'mh',
    contextBundlePath: null,
    builderModel: null,
    status: 'validated',
    createdAt: '2026-06-26T00:00:00.000Z',
    updatedAt: '2026-06-26T00:00:00.000Z',
  };

  const state: Harness['state'] = {
    runs: new Map([['run-1', makeRun(opts.run)]]),
    definitions: new Map([['def-1', definition]]),
    nodeRuns: new Map(),
    events: [],
    gateDecisions: [],
    messages: [],
  };
  let msgId = 0;

  const crud: WorkflowRunnerCrud = {
    getRun: (id) => state.runs.get(id) ?? null,
    getDefinition: (id) => state.definitions.get(id) ?? null,
    listRunsByStatus: (status) => [...state.runs.values()].filter((r) => r.status === status),
    setRunStatus: (id, status) => {
      const r = state.runs.get(id);
      if (r) state.runs.set(id, { ...r, status });
    },
    updateRun: (id, patch) => {
      const r = state.runs.get(id);
      if (r) state.runs.set(id, { ...r, ...patch } as DynamicWorkflowRun);
    },
    upsertNodeRun: (input) => {
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
      state.nodeRuns.set(`${input.runId}:${input.nodeId}:${input.attempt}`, nr);
      return nr;
    },
    updateNodeRun: (id, patch) => {
      const nr = state.nodeRuns.get(id);
      if (nr) Object.assign(nr, patch);
    },
    listNodeRuns: (runId) => [...new Set([...state.nodeRuns.values()])].filter((n) => n.runId === runId),
    insertEvent: (input) => {
      const id = state.events.length + 1;
      state.events.push({
        type: input.type,
        runId: input.runId,
        payload: input.payloadJson,
        nodeId: input.nodeId ?? null,
      });
      return {
        id,
        runId: input.runId,
        nodeId: input.nodeId ?? null,
        phaseId: input.phaseId ?? null,
        seq: id,
        type: input.type,
        payloadJson: input.payloadJson ?? '{}',
        createdAt: '2026-06-26T00:00:00.000Z',
      };
    },
    recentEvents: () => [],
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
        createdAt: '2026-06-26T00:00:00.000Z',
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
      createdAt: '2026-06-26T00:00:00.000Z',
    }),
    insertMessage: (input) => {
      msgId += 1;
      state.messages.push(input);
      return {
        id: msgId,
        runId: input.runId,
        nodeId: input.nodeId ?? null,
        role: input.role,
        source: input.source,
        kind: input.kind,
        content: input.content,
        toolCallsJson: input.toolCallsJson ?? null,
        agentId: input.agentId ?? null,
        createdAt: '2026-06-26T00:00:00.000Z',
      };
    },
    listMessages: (runId) =>
      state.messages
        .filter((m) => m.runId === runId)
        .map((m, i) => ({
          id: i + 1,
          runId: m.runId,
          nodeId: m.nodeId ?? null,
          role: m.role,
          source: m.source,
          kind: m.kind,
          content: m.content,
          toolCallsJson: m.toolCallsJson ?? null,
          agentId: m.agentId ?? null,
          createdAt: '2026-06-26T00:00:00.000Z',
        })),
    costAggregate: (runId) => {
      const r = state.runs.get(runId);
      return {
        runId,
        totalCostUsd: r?.totalCostUsd ?? 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalDurationMs: 0,
        nodeRunCount: 0,
        unknownCostNodeRuns: 0,
      };
    },
  };

  const deps: WorkflowRunnerDeps = {
    crud,
    sandboxFactory: makeFakeSandboxFactory(opts.coordinator),
    git: opts.git ?? defaultFakeGit(),
    emitIPC: () => {},
    now: () => '2026-06-26T00:00:00.000Z',
    runNodeAgent: makeFakeAdapter() as WorkflowRunnerDeps['runNodeAgent'],
    closerDeps: opts.closerTurn
      ? {
          runAgentTurn: async (input) => opts.closerTurn!({ runId: input.runId }),
          resolveCloserRuntime: () => 'cloud',
        }
      : undefined,
  };

  return { deps, crud, state };
}

function defaultFakeGit(): (args: string[], cwd: string) => Promise<GitRunResult> {
  return async (args) => {
    const cmd = args.join(' ');
    if (cmd.includes('rev-parse --is-inside-work-tree')) return ok('true');
    if (cmd.includes('rev-parse --verify --quiet HEAD')) return ok('basesha');
    if (cmd === 'rev-parse HEAD') return ok('basesha');
    if (cmd.includes('rev-parse --abbrev-ref HEAD')) return ok('main');
    if (cmd.includes('^{tree}')) return ok('treehash');
    if (cmd.startsWith('worktree')) return ok('');
    if (cmd.startsWith('add')) return ok('');
    if (cmd.includes('diff --cached --name-only')) return ok('src/x.ts');
    if (cmd.startsWith('rev-list --count')) return ok('1');
    if (cmd.includes('diff --cached --quiet')) return { code: 1, stdout: '', stderr: '' };
    if (cmd.startsWith('commit')) return ok('');
    if (cmd.includes('rev-parse HEAD') || cmd === 'rev-parse HEAD') return ok('nodesha');
    if (cmd.includes('diff --name-only')) return ok('src/x.ts');
    if (cmd.includes('diff-tree')) return ok('src/x.ts');
    if (cmd.includes('rev-parse --verify --quiet refs/heads/')) return ok('basesha');
    if (cmd.startsWith('branch')) return ok('');
    if (cmd.startsWith('checkout')) return ok('');
    if (cmd.startsWith('merge')) return ok('');
    if (cmd.startsWith('reset')) return ok('');
    return ok('');
  };
}

function ok(stdout: string): GitRunResult {
  return { code: 0, stdout, stderr: '' };
}

let tmpRoot: string;
beforeEach(() => {
  _resetRunLocksForTesting();
  tmpRoot = mkdtempSync(join(tmpdir(), 'dwf-cc-delivery-'));
  mkdirSync(join(tmpRoot, 'src'), { recursive: true });
});
function cleanup(): void {
  rmSync(tmpRoot, { recursive: true, force: true });
}

async function waitForRunStatus(
  crud: WorkflowRunnerCrud,
  runId: string,
  target: string | string[],
  timeoutMs = 2000,
): Promise<string> {
  const targets = Array.isArray(target) ? target : [target];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = crud.getRun(runId)?.status;
    if (status && targets.includes(status)) return status;
    await new Promise((r) => setTimeout(r, 5));
  }
  return crud.getRun(runId)?.status ?? 'unknown';
}

const writingCoordinator: Coordinator = async (ctx) => {
  await ctx.phase('Implementar');
  await ctx.agent({ id: 'coder', agentId: 'a-coder', access: 'workspace-write', writeSet: ['src/**'], prompt: 'impl' });
  return { ok: true };
};

const readOnlyCoordinator: Coordinator = async (ctx) => {
  await ctx.phase('Scout');
  await ctx.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 's' });
  return { ok: true };
};

function wireListEventsSince(h: Harness): void {
  h.crud.listEventsSince = (runId, afterSeq) =>
    h.state.events
      .map((e, i) => ({
        id: i + 1,
        runId: e.runId,
        nodeId: e.nodeId ?? null,
        phaseId: null,
        seq: i + 1,
        type: e.type,
        payloadJson: typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload ?? {}),
        createdAt: '2026-06-26T00:00:00.000Z',
      }))
      .filter((e) => e.runId === runId && e.seq > afterSeq);
}

describe('orquestrador-driver S1: coordinator-finished + gate de fronteira do fim do coordenador', () => {
  it('coordinator-finished e emitido no ramo completed ANTES do gate-blocked cc-delivery', async () => {
    const h = makeHarness({ coordinator: writingCoordinator, projectPath: tmpRoot, run: { inputJson: '{}' } });
    const runner = new WorkflowRunner(h.deps);
    await runner.start('run-1');
    await waitForRunStatus(h.crud, 'run-1', 'blocked');
    const types = h.state.events.map((e) => e.type);
    const finishedIdx = types.indexOf('coordinator-finished');
    const gateIdx = types.indexOf('gate-blocked');
    expect(finishedIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(finishedIdx);
    const pending = JSON.parse(h.crud.getRun('run-1')!.inputJson || '{}').pendingDecision;
    expect(pending?.id).toBe('cc-delivery');
    cleanup();
  });

  it('janela SEM VEREDITO (writer sem green-check) abre boundary:coordinator-finished ANTES do cc-delivery; approve segue para a entrega', async () => {
    const closerTurn = vi.fn(async () => ({ ok: true, output: 'walkthrough', costUsd: 0 }));
    const h = makeHarness({
      coordinator: writingCoordinator,
      projectPath: tmpRoot,
      closerTurn,
      run: { inputJson: '{}' },
    });
    wireListEventsSince(h);
    const runner = new WorkflowRunner(h.deps);
    await runner.start('run-1');
    await waitForRunStatus(h.crud, 'run-1', 'blocked');

    const pending1 = JSON.parse(h.crud.getRun('run-1')!.inputJson || '{}').pendingDecision;
    expect(pending1?.type).toBe('gate');
    expect(pending1?.id).toBe('boundary:coordinator-finished');
    const gb = h.state.events.filter((e) => e.type === 'gate-blocked');
    expect(gb).toHaveLength(1);
    const gbPayload = JSON.parse(String(gb[0]!.payload));
    expect(gbPayload).toMatchObject({
      gateId: 'boundary:coordinator-finished',
      mode: 'orchestrator',
      semaphore: 'SEM VEREDITO',
    });
    expect(h.state.events.some((e) => e.type === 'coordinator-finished')).toBe(true);
    expect(h.state.events.some((e) => e.type === 'merge-squashed')).toBe(false);

    await runner.approveGate('run-1', 'boundary:coordinator-finished', { decision: 'approve' }, 'orchestrator');
    await vi.waitFor(() => {
      const pd = JSON.parse(h.crud.getRun('run-1')!.inputJson || '{}').pendingDecision;
      expect(pd?.id).toBe('cc-delivery');
    });
    expect(
      h.state.gateDecisions.some((d) => d.gateId === 'boundary:coordinator-finished' && d.decision === 'approved'),
    ).toBe(true);
    const approved = h.state.events
      .filter((e) => e.type === 'gate-approved')
      .map((e) => JSON.parse(String(e.payload)).gateId);
    expect(approved).toContain('boundary:coordinator-finished');

    await runner.approveGate('run-1', 'cc-delivery', { decision: 'approve' });
    expect(await waitForRunStatus(h.crud, 'run-1', 'completed')).toBe('completed');
    expect(h.state.events.some((e) => e.type === 'merge-squashed')).toBe(true);
    cleanup();
  });

  it('reject do boundary:coordinator-finished = PAUSA (recuperavel), sem merge', async () => {
    const h = makeHarness({ coordinator: writingCoordinator, projectPath: tmpRoot, run: { inputJson: '{}' } });
    wireListEventsSince(h);
    const runner = new WorkflowRunner(h.deps);
    await runner.start('run-1');
    await waitForRunStatus(h.crud, 'run-1', 'blocked');
    await runner.approveGate(
      'run-1',
      'boundary:coordinator-finished',
      { decision: 'reject', reason: 'rode o green-check' },
      'orchestrator',
    );
    expect(await waitForRunStatus(h.crud, 'run-1', 'paused')).toBe('paused');
    expect(h.state.events.some((e) => e.type === 'gate-rejected')).toBe(true);
    expect(h.state.events.some((e) => e.type === 'run-paused')).toBe(true);
    expect(h.state.events.some((e) => e.type === 'merge-squashed')).toBe(false);
    expect(JSON.parse(h.crud.getRun('run-1')!.inputJson || '{}').pendingDecision).toBeUndefined();
    cleanup();
  });

  it('reject de boundary:<fase> MID-RUN = run paused E input_json SEM pendingDecision (nada de gate fantasma)', async () => {
    const midRunCoordinator: Coordinator = async (ctx) => {
      await ctx.phase('Implementar');
      await ctx.agent({
        id: 'coder',
        agentId: 'a-coder',
        access: 'workspace-write',
        writeSet: ['src/**'],
        prompt: 'impl',
      });
      await ctx.phase('Validar');
      await ctx.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 's' });
      return { ok: true };
    };
    const h = makeHarness({ coordinator: midRunCoordinator, projectPath: tmpRoot, run: { inputJson: '{}' } });
    wireListEventsSince(h);
    const runner = new WorkflowRunner(h.deps);
    await runner.start('run-1');
    expect(await waitForRunStatus(h.crud, 'run-1', 'blocked')).toBe('blocked');
    const pending = JSON.parse(h.crud.getRun('run-1')!.inputJson || '{}').pendingDecision;
    expect(pending).toMatchObject({ type: 'gate', id: 'boundary:Validar' });

    await runner.approveGate(
      'run-1',
      'boundary:Validar',
      { decision: 'reject', reason: 'rode o green-check' },
      'orchestrator',
    );
    expect(await waitForRunStatus(h.crud, 'run-1', 'paused')).toBe('paused');
    expect(h.state.events.some((e) => e.type === 'gate-rejected')).toBe(true);
    expect(h.state.events.some((e) => e.type === 'run-paused')).toBe(true);
    expect(h.state.events.some((e) => e.type === 'merge-squashed')).toBe(false);
    expect(JSON.parse(h.crud.getRun('run-1')!.inputJson || '{}').pendingDecision).toBeUndefined();
    cleanup();
  });

  it('5a: reject + resume NAO segue para o cc-delivery: a janela congelada reabre boundary:coordinator-finished (novo juizo); resume({ acceptBoundary: true }) e o que libera', async () => {
    const h = makeHarness({ coordinator: writingCoordinator, projectPath: tmpRoot, run: { inputJson: '{}' } });
    wireListEventsSince(h);
    const runner = new WorkflowRunner(h.deps);
    await runner.start('run-1');
    await waitForRunStatus(h.crud, 'run-1', 'blocked');
    await runner.approveGate(
      'run-1',
      'boundary:coordinator-finished',
      { decision: 'reject', reason: 'rode o green-check' },
      'orchestrator',
    );
    expect(await waitForRunStatus(h.crud, 'run-1', 'paused')).toBe('paused');
    h.crud.insertEvent({
      runId: 'run-1',
      type: 'wake-completed',
      payloadJson: JSON.stringify({ driveTurnId: 'run-1:1', outcome: 'executed' }),
    });

    const r1 = await runner.resume('run-1');
    expect('error' in r1).toBe(false);
    expect(await waitForRunStatus(h.crud, 'run-1', 'blocked')).toBe('blocked');
    const pending2 = JSON.parse(h.crud.getRun('run-1')!.inputJson || '{}').pendingDecision;
    expect(pending2?.id).toBe('boundary:coordinator-finished');
    expect(h.state.events.filter((e) => e.type === 'gate-blocked')).toHaveLength(2);
    expect(h.state.events.some((e) => e.type === 'merge-squashed')).toBe(false);

    await runner.approveGate('run-1', 'boundary:coordinator-finished', { decision: 'reject' }, 'orchestrator');
    expect(await waitForRunStatus(h.crud, 'run-1', 'paused')).toBe('paused');
    const r2 = await runner.resume('run-1', { acceptBoundary: true });
    expect('error' in r2).toBe(false);
    const resumeEv = h.state.events.filter((e) => e.type === 'resume-requested');
    expect(resumeEv).toHaveLength(2);
    expect(JSON.parse(String(resumeEv[0]!.payload))).toEqual({});
    expect(JSON.parse(String(resumeEv[1]!.payload))).toEqual({ acceptBoundary: true });
    await waitForRunStatus(h.crud, 'run-1', 'blocked');
    cleanup();
  });

  it('P3: coordinator-finished persiste `value` como DIGEST (<= 2k chars) e nao o valor inteiro', async () => {
    const h = makeHarness({ coordinator: writingCoordinator, projectPath: tmpRoot, run: { inputJson: '{}' } });
    const runner = new WorkflowRunner(h.deps);
    await runner.start('run-1');
    await waitForRunStatus(h.crud, 'run-1', 'blocked');
    const finished = h.state.events.find((e) => e.type === 'coordinator-finished')!;
    expect(JSON.parse(String(finished.payload))).toEqual({
      value: '{"ok":true}',
      valueTruncated: false,
      valueChars: 11,
    });

    const big = digestCoordinatorValue({ texto: 'x'.repeat(5_000) });
    expect(big.value!.length).toBe(COORDINATOR_VALUE_DIGEST_MAX_CHARS);
    expect(big.value!.endsWith('...')).toBe(true);
    expect(big.valueTruncated).toBe(true);
    expect(big.valueChars).toBeGreaterThan(5_000);
    expect(digestCoordinatorValue(undefined)).toEqual({ value: null, valueTruncated: false, valueChars: 0 });
    expect(digestCoordinatorValue('ok').value).toBe('ok');
    cleanup();
  });
});

describe('cc-delivery (1/2) a invariante "merge nunca sem OK"', () => {
  it('claude-code + escrita fica BLOCKED no gate de entrega (orchestrator); merge SO acontece apos a aprovacao do orquestrador', async () => {
    const closerTurn = vi.fn(async () => ({ ok: true, output: 'walkthrough', costUsd: 0 }));
    const h = makeHarness({
      coordinator: writingCoordinator,
      projectPath: tmpRoot,
      authoringModel: 'claude-code',
      closerTurn,
      run: { inputJson: '{}' },
    });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');

    const blocked = await waitForRunStatus(h.crud, 'run-1', 'blocked');
    expect(blocked).toBe('blocked');

    expect(h.state.events.some((e) => e.type === 'merge-squashed')).toBe(false);
    expect(h.state.events.some((e) => e.type === 'run-delivered')).toBe(false);
    expect(closerTurn).not.toHaveBeenCalled();
    expect(h.crud.getRun('run-1')?.deliveredAt).toBeFalsy();

    const pending = JSON.parse(h.crud.getRun('run-1')!.inputJson || '{}').pendingDecision;
    expect(pending?.type).toBe('gate');
    expect(pending?.id).toBe('cc-delivery');
    const gb = h.state.events.find((e) => e.type === 'gate-blocked');
    expect(gb).toBeTruthy();
    const blockedMode =
      (gb?.payload as { mode?: string } | undefined)?.mode ?? JSON.parse(String(gb?.payload ?? '{}')).mode;
    expect(blockedMode).toBe('orchestrator');

    await runner.approveGate('run-1', 'cc-delivery', { decision: 'approve' });
    const terminal = await waitForRunStatus(h.crud, 'run-1', 'completed');
    expect(terminal).toBe('completed');

    expect(h.state.events.some((e) => e.type === 'merge-squashed')).toBe(true);
    expect(h.state.events.some((e) => e.type === 'run-delivered')).toBe(true);
    expect(closerTurn).toHaveBeenCalled();
    const finalRun = h.crud.getRun('run-1');
    expect(finalRun?.deliveredAt).toBeTruthy();
    expect(finalRun?.completedAt).toBeTruthy();

    expect(
      h.state.gateDecisions.some(
        (d) => d.gateId === 'cc-delivery' && d.mode === 'orchestrator' && d.decision === 'approved',
      ),
    ).toBe(true);
    cleanup();
  });
});

describe('cc-delivery (3) read-only nao bloqueia', () => {
  it('claude-code SEM escrita completa direto (delivered->completed), SEM gate', async () => {
    const closerTurn = vi.fn(async () => ({ ok: true, output: 'walkthrough', costUsd: 0 }));
    const h = makeHarness({
      coordinator: readOnlyCoordinator,
      projectPath: tmpRoot,
      authoringModel: 'claude-code',
      manifest: ccReadOnlyManifest(),
      closerTurn,
    });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    const terminal = await waitForRunStatus(h.crud, 'run-1', 'completed');
    expect(terminal).toBe('completed');

    expect(h.state.events.some((e) => e.type === 'gate-blocked')).toBe(false);
    expect(h.state.gateDecisions.some((d) => d.gateId === 'cc-delivery')).toBe(false);
    cleanup();
  });
});

describe('cc-delivery (4) gate de entrega bloqueia em mode orchestrator (sandbox nao auto-mergeia)', () => {
  it('o sandbox NAO auto-mergeia: o gate pausa em mode orchestrator esperando o OK do orquestrador', async () => {
    const closerTurn = vi.fn(async () => ({ ok: true, output: 'walkthrough', costUsd: 0 }));
    const h = makeHarness({
      coordinator: writingCoordinator,
      projectPath: tmpRoot,
      authoringModel: 'claude-code',
      closerTurn,
      run: { inputJson: '{}' },
    });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    const blocked = await waitForRunStatus(h.crud, 'run-1', 'blocked');
    expect(blocked).toBe('blocked');

    const gb = h.state.events.find((e) => e.type === 'gate-blocked');
    const mode = (gb?.payload as { mode?: string } | undefined)?.mode ?? JSON.parse(String(gb?.payload ?? '{}')).mode;
    expect(mode).toBe('orchestrator');

    expect(h.state.events.some((e) => e.type === 'merge-squashed')).toBe(false);
    expect(h.state.events.some((e) => e.type === 'run-delivered')).toBe(false);
    expect(closerTurn).not.toHaveBeenCalled();
    expect(h.crud.getRun('run-1')?.deliveredAt).toBeFalsy();

    await runner.approveGate('run-1', 'cc-delivery', { decision: 'approve' });
    const terminal = await waitForRunStatus(h.crud, 'run-1', 'completed');
    expect(terminal).toBe('completed');
    expect(
      h.state.gateDecisions.some(
        (d) => d.gateId === 'cc-delivery' && d.mode === 'orchestrator' && d.decision === 'approved',
      ),
    ).toBe(true);
    cleanup();
  });
});

describe('cc-delivery (5) resume idempotente apos approve', () => {
  it('run completed NAO re-bloqueia nem re-mergeia ao re-disparar', async () => {
    const closerTurn = vi.fn(async () => ({ ok: true, output: 'walkthrough', costUsd: 0 }));
    const h = makeHarness({
      coordinator: writingCoordinator,
      projectPath: tmpRoot,
      authoringModel: 'claude-code',
      closerTurn,
    });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    await waitForRunStatus(h.crud, 'run-1', 'blocked');
    await runner.approveGate('run-1', 'cc-delivery', { decision: 'approve' });
    await waitForRunStatus(h.crud, 'run-1', 'completed');

    const mergesBefore = h.state.events.filter((e) => e.type === 'merge-squashed').length;
    const decisionsBefore = h.state.gateDecisions.length;

    const resumed = await runner.resume('run-1');
    expect('error' in resumed).toBe(true);
    const started = await runner.start('run-1');
    expect('error' in started).toBe(true);

    expect(h.state.events.filter((e) => e.type === 'merge-squashed').length).toBe(mergesBefore);
    expect(h.state.gateDecisions.length).toBe(decisionsBefore);
    expect(h.crud.getRun('run-1')?.status).toBe('completed');
    cleanup();
  });

  it('#G gate orfao (restart durante o gate sintetico) re-arma pelo journal e conclui SEM re-bloquear', async () => {
    const closerTurn = vi.fn(async () => ({ ok: true, output: 'walkthrough', costUsd: 0 }));
    const h = makeHarness({
      coordinator: writingCoordinator,
      projectPath: tmpRoot,
      authoringModel: 'claude-code',
      closerTurn,
    });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    await waitForRunStatus(h.crud, 'run-1', 'blocked');
    const pending = JSON.parse(h.crud.getRun('run-1')!.inputJson || '{}').pendingDecision;
    expect(pending?.id).toBe('cc-delivery');

    await runner.abort('run-1');
    await waitForRunStatus(h.crud, 'run-1', 'aborted');
    await new Promise((r) => setTimeout(r, 20));
    h.crud.updateRun('run-1', {
      status: 'blocked',
      completedAt: null,
      inputJson: JSON.stringify({ pendingDecision: pending }),
    });

    const res = await runner.approveGate('run-1', 'cc-delivery', { decision: 'approve' });
    expect('error' in res).toBe(false);
    const terminal = await waitForRunStatus(h.crud, 'run-1', 'completed');
    expect(terminal).toBe('completed');
    expect(h.state.events.some((e) => e.type === 'gate-orphan-rearm')).toBe(true);
    expect(h.state.events.some((e) => e.type === 'gate-orphan-resolved')).toBe(true);
    expect(h.state.events.filter((e) => e.type === 'merge-squashed').length).toBe(1);
    cleanup();
  });
});

describe('cc-delivery (7) o .js nao decide o mode do gate', () => {
  it('o return do .js carrega mode:auto/skip; o host IGNORA e injeta o gate em mode orchestrator', async () => {
    const closerTurn = vi.fn(async () => ({ ok: true, output: 'walkthrough', costUsd: 0 }));
    const sneaky: Coordinator = async (ctx) => {
      await ctx.phase('Implementar');
      await ctx.agent({
        id: 'coder',
        agentId: 'a-coder',
        access: 'workspace-write',
        writeSet: ['src/**'],
        prompt: 'impl',
      });
      return { ok: true, gateMode: 'auto', skipGate: true, mode: 'auto' };
    };
    const h = makeHarness({
      coordinator: sneaky,
      projectPath: tmpRoot,
      authoringModel: 'claude-code',
      closerTurn,
      run: { inputJson: '{}' },
    });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    const blocked = await waitForRunStatus(h.crud, 'run-1', 'blocked');
    expect(blocked).toBe('blocked');
    const gb = h.state.events.find((e) => e.type === 'gate-blocked');
    const mode = (gb?.payload as { mode?: string } | undefined)?.mode ?? JSON.parse(String(gb?.payload ?? '{}')).mode;
    expect(mode).toBe('orchestrator');
    expect(mode).not.toBe('auto');

    expect(h.state.events.some((e) => e.type === 'run-delivered')).toBe(false);
    cleanup();
  });
});
