import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  WorkflowRunner,
  isWorkflowRunLocked,
  _resetRunLocksForTesting,
  type WorkflowRunnerDeps,
  type WorkflowRunnerCrud,
} from '../dynamic-workflows/workflow-runner';
import type { SandboxProcessFactory, SandboxProcessHandle } from '../dynamic-workflows/workflow-sandbox';
import type { SandboxParentMessage, SandboxChildMessage } from '../dynamic-workflows/sandbox-protocol';
import type {
  DynamicWorkflowRun,
  DynamicWorkflowDefinition,
  DynamicWorkflowManifest,
  DynamicWorkflowNodeRun,
  DynamicWorkflowGateDecisionInsertInput,
  DynamicWorkflowMessageInsertInput,
  DynamicWorkflowJournalEntry,
} from '../dynamic-workflows/types';
import type { GitRunResult } from '../dynamic-workflows/workflow-git';
import type { NodeRunResult, RunNodeAgentInput } from '../dynamic-workflows/workflow-agent-adapter';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface CoordinatorCtx {
  phase: (name: string) => Promise<unknown>;
  agent: (arg: unknown) => Promise<unknown>;
  gate: (arg: unknown) => Promise<unknown>;
  log: (arg: unknown) => Promise<unknown>;
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
        gate: (arg) => callPrimitive('gate', arg),
        log: (arg) => callPrimitive('log', arg),
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
    events: Array<{ type: string; runId: string; payload?: unknown }>;
    gateDecisions: DynamicWorkflowGateDecisionInsertInput[];
    messages: DynamicWorkflowMessageInsertInput[];
    journal: DynamicWorkflowJournalEntry[];
  };
}

const NOW = '2026-06-14T12:00:00.000Z';

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
    updatedAt: NOW,
    completedAt: null,
    ...over,
  };
}

function makeManifest(over?: Partial<DynamicWorkflowManifest>): DynamicWorkflowManifest {
  return {
    version: 1,
    name: 'transitions-wf',
    phases: [
      { id: 'Plan', name: 'Plan', order: 0 },
      { id: 'Implementar', name: 'Implementar', order: 1 },
      { id: 'Gate', name: 'Gate', order: 2 },
    ],
    nodes: [
      {
        id: 'planner-r0',
        type: 'agent',
        phaseId: 'Plan',
        agentId: 'a-plan',
        access: 'read-only',
        canResume: true,
        produces: ['plan0'],
        consumes: [],
      },
      {
        id: 'planner-r1',
        type: 'agent',
        phaseId: 'Plan',
        agentId: 'a-plan',
        access: 'read-only',
        canResume: true,
        produces: ['plan1'],
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
        consumes: ['plan0'],
      },
      { id: 'plan-gate', type: 'gate', phaseId: 'Gate', canResume: false, produces: [], consumes: [] },
    ],
    parallelism: { maxConcurrentAgents: 1, parallelWritersAllowed: false },
    gates: [{ id: 'plan-gate', mode: 'human', kind: 'plan-review', blocks: [] }],
    estimate: { minUsd: 0, maxUsd: 1, unknownCostNodes: [] },
    ...over,
  };
}

function writeWorkflowJs(dir: string): string {
  const src = [
    "export const meta = { name: 'transitions-wf', description: 'transitions test wf', phases: ['Plan', 'Implementar', 'Gate'] };",
    'return { ok: true };',
  ].join('\n');
  const path = join(dir, 'workflow.js');
  writeFileSync(path, src, 'utf8');
  return path;
}

function makeFakeAdapter(input: RunNodeAgentInput): Promise<NodeRunResult> {
  return Promise.resolve({
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
  });
}

function ok(stdout: string): GitRunResult {
  return { code: 0, stdout, stderr: '' };
}

function defaultFakeGit(): (args: string[], cwd: string) => Promise<GitRunResult> {
  return async (args) => {
    const cmd = args.join(' ');
    if (cmd.includes('rev-parse --is-inside-work-tree')) return ok('true');
    if (cmd.includes('rev-parse --verify --quiet HEAD')) return ok('basesha');
    if (cmd === 'rev-parse HEAD') return ok('basesha');
    if (cmd.includes('rev-parse --abbrev-ref HEAD')) return ok('main');
    if (cmd.includes('^{tree}')) return ok('treehash');
    if (cmd.includes('diff --cached --name-only')) return ok('src/x.ts');
    if (cmd.startsWith('rev-list --count')) return ok('1');
    if (cmd.includes('diff --cached --quiet')) return { code: 1, stdout: '', stderr: '' };
    if (cmd.includes('diff --name-only')) return ok('src/x.ts');
    if (cmd.includes('diff-tree')) return ok('src/x.ts');
    return ok('');
  };
}

function makeHarness(opts: {
  coordinator: Coordinator;
  projectPath: string;
  run?: Partial<DynamicWorkflowRun>;
  manifest?: DynamicWorkflowManifest;
  adapter?: (input: RunNodeAgentInput) => Promise<NodeRunResult>;
}): Harness {
  const workflowJsPath = writeWorkflowJs(opts.projectPath);
  const definition: DynamicWorkflowDefinition = {
    id: 'def-1',
    name: 'transitions-wf',
    definitionVersion: 1,
    authoringModel: 'manifest',
    parentDefinitionId: null,
    supersedesDefinitionId: null,
    sourceType: 'builder',
    projectPath: opts.projectPath,
    specPath: null,
    specSha256: null,
    workflowJsPath,
    manifestPath: join(opts.projectPath, 'workflow.manifest.json'),
    manifestJson: JSON.stringify(opts.manifest ?? makeManifest()),
    manifestHash: 'mh',
    contextBundlePath: null,
    builderModel: null,
    status: 'validated',
    createdAt: NOW,
    updatedAt: NOW,
  };
  const state: Harness['state'] = {
    runs: new Map([['run-1', makeRun(opts.run)]]),
    definitions: new Map([['def-1', definition]]),
    nodeRuns: new Map(),
    events: [],
    gateDecisions: [],
    messages: [],
    journal: [],
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
      state.events.push({ type: input.type, runId: input.runId, payload: input.payloadJson });
      return {
        id,
        runId: input.runId,
        nodeId: input.nodeId ?? null,
        phaseId: input.phaseId ?? null,
        seq: id,
        type: input.type,
        payloadJson: input.payloadJson ?? '{}',
        createdAt: NOW,
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
        createdAt: NOW,
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
      createdAt: NOW,
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
        createdAt: NOW,
      };
    },
    listMessages: () => [],
    appendJournalEntry: (input) => {
      const idx = state.journal.findIndex((e) => e.callIndex === input.callIndex);
      const entry: DynamicWorkflowJournalEntry = {
        ...input,
        outputRef: input.outputRef ?? null,
        sideEffectKey: input.sideEffectKey ?? null,
        createdAt: NOW,
      };
      if (idx >= 0) state.journal[idx] = entry;
      else state.journal.push(entry);
    },
    listJournalEntries: () => [...state.journal].sort((a, b) => a.callIndex - b.callIndex),
    truncateJournalFrom: (_runId, fromIndex) => {
      state.journal = state.journal.filter((e) => e.callIndex < fromIndex);
    },
    costAggregate: (runId) => ({
      runId,
      totalCostUsd: state.runs.get(runId)?.totalCostUsd ?? 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalDurationMs: 0,
      nodeRunCount: 0,
      unknownCostNodeRuns: 0,
    }),
  };
  const deps: WorkflowRunnerDeps = {
    crud,
    sandboxFactory: makeFakeSandboxFactory(opts.coordinator),
    git: defaultFakeGit(),
    emitIPC: () => {},
    now: () => NOW,
    runNodeAgent: (opts.adapter ?? makeFakeAdapter) as WorkflowRunnerDeps['runNodeAgent'],
  };
  return { deps, crud, state };
}

async function waitFor(
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

let tmpRoot: string;

beforeEach(() => {
  _resetRunLocksForTesting();
  tmpRoot = mkdtempSync(join(tmpdir(), 'dwf-trans-'));
  mkdirSync(join(tmpRoot, 'src'), { recursive: true });
});

function cleanup(): void {
  rmSync(tmpRoot, { recursive: true, force: true });
}

describe('PAUSE -> RESUME re-executa do checkpoint (SM-9/SM-22)', () => {
  it('pause para limpo (libera lock) e resume RE-ADQUIRE o lock e re-executa', async () => {
    let releaseAgent: () => void = () => {};
    let agentCalls = 0;
    const adapter = (input: RunNodeAgentInput): Promise<NodeRunResult> => {
      agentCalls += 1;
      if (agentCalls === 1) {
        return new Promise<NodeRunResult>((resolve) => {
          releaseAgent = () => {
            const base = makeFakeAdapter(input) as unknown as NodeRunResult & { ok: boolean };
            resolve({ ...base, ok: false, output: '' });
          };
        });
      }
      return makeFakeAdapter(input);
    };
    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Implementar');
      await ctx.agent({
        id: 'coder',
        agentId: 'a-coder',
        access: 'workspace-write',
        writeSet: ['src/**'],
        prompt: 'impl',
      });
      await ctx.log({ message: 'pos-coder' });
      return { ok: true };
    };
    const h = makeHarness({ coordinator, projectPath: tmpRoot, adapter });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    await vi.waitFor(() =>
      expect([...h.state.nodeRuns.values()].some((n) => n.nodeId === 'coder' && n.status === 'running')).toBe(true),
    );
    expect(isWorkflowRunLocked('run-1')).toBe(true);

    expect(await runner.pause('run-1')).toEqual({ ok: true });
    releaseAgent();
    const paused = await waitFor(h.crud, 'run-1', 'paused');
    expect(paused).toBe('paused');
    await vi.waitFor(() => expect(isWorkflowRunLocked('run-1')).toBe(false));
    expect(h.crud.getRun('run-1')).toBeTruthy();

    const resumeRes = await runner.resume('run-1');
    expect(resumeRes).toEqual({ ok: true });
    const after = await waitFor(h.crud, 'run-1', ['delivered', 'blocked', 'running']);
    expect(['delivered', 'blocked', 'running']).toContain(after);
    expect(h.crud.getRun('run-1')?.status).not.toBe('paused');
    expect(h.state.events.some((e) => e.type === 'resume-requested')).toBe(true);
    cleanup();
  });
});

describe('ABORT preserva e o run segue RECUPERAVEL (SM-9, REGRA MAXIMA)', () => {
  it('abort marca aborted preservando branch; resume re-executa do checkpoint', async () => {
    const h = makeHarness({
      coordinator: async (ctx) => {
        await ctx.agent({
          id: 'coder',
          agentId: 'a-coder',
          access: 'workspace-write',
          writeSet: ['src/**'],
          prompt: 'x',
        });
        return { ok: true };
      },
      projectPath: tmpRoot,
      run: {
        status: 'paused',
        workspaceMode: 'run-worktree',
        worktreeBranch: 'dynworkflow/run-1',
        baseCommitSha: 'basesha',
        worktreePath: join(tmpRoot, 'wt'),
      },
    });
    const runner = new WorkflowRunner(h.deps);

    expect(await runner.abort('run-1')).toEqual({ ok: true });
    expect(h.crud.getRun('run-1')?.status).toBe('aborted');
    expect(h.crud.getRun('run-1')?.worktreeBranch).toBe('dynworkflow/run-1');
    expect(h.crud.getRun('run-1')).toBeTruthy();

    const resumeRes = await runner.resume('run-1');
    expect(resumeRes).toEqual({ ok: true });
    const status = await waitFor(h.crud, 'run-1', ['delivered', 'running', 'blocked']);
    expect(['delivered', 'running', 'blocked']).toContain(status);
    expect(h.state.events.some((e) => e.type === 'run-recovered-from-terminal')).toBe(true);
    cleanup();
  });

  it('abort de run ATIVO marca attempt cancelled (10.2) e nao perde dados', async () => {
    let release: () => void = () => {};
    const adapter = (input: RunNodeAgentInput): Promise<NodeRunResult> =>
      new Promise<NodeRunResult>((resolve) => {
        release = () => {
          const base = makeFakeAdapter(input) as unknown as NodeRunResult & { ok: boolean };
          resolve({ ...base, ok: false, output: '' });
        };
      });
    const h = makeHarness({
      coordinator: async (ctx) => {
        await ctx.agent({
          id: 'coder',
          agentId: 'a-coder',
          access: 'workspace-write',
          writeSet: ['src/**'],
          prompt: 'x',
        });
        await ctx.log({ message: 'pos-coder' });
        return { ok: true };
      },
      projectPath: tmpRoot,
      adapter,
    });
    const runner = new WorkflowRunner(h.deps);
    await runner.start('run-1');
    await vi.waitFor(() =>
      expect([...h.state.nodeRuns.values()].some((n) => n.nodeId === 'coder' && n.status === 'running')).toBe(true),
    );
    expect(await runner.abort('run-1')).toEqual({ ok: true });
    const coder = [...h.state.nodeRuns.values()].find((n) => n.nodeId === 'coder');
    expect(coder?.status).toBe('cancelled');
    release();
    await waitFor(h.crud, 'run-1', 'aborted');
    expect(h.crud.getRun('run-1')?.status).toBe('aborted');
    await vi.waitFor(() => expect(isWorkflowRunLocked('run-1')).toBe(false));
    expect(h.crud.getRun('run-1')).toBeTruthy();
    cleanup();
  });
});

describe('FAILED e recuperavel (SM-9)', () => {
  it('resume de um run failed re-executa (transiciona via interrupted, limpa o erro)', async () => {
    const h = makeHarness({
      coordinator: async (ctx) => {
        await ctx.agent({
          id: 'coder',
          agentId: 'a-coder',
          access: 'workspace-write',
          writeSet: ['src/**'],
          prompt: 'x',
        });
        return { ok: true };
      },
      projectPath: tmpRoot,
      run: {
        status: 'failed',
        error: 'crash anterior',
        workspaceMode: 'run-worktree',
        baseCommitSha: 'basesha',
        worktreePath: join(tmpRoot, 'wt'),
        worktreeBranch: 'dynworkflow/run-1',
      },
    });
    const runner = new WorkflowRunner(h.deps);
    const res = await runner.resume('run-1');
    expect(res).toEqual({ ok: true });
    const status = await waitFor(h.crud, 'run-1', ['delivered', 'running', 'blocked']);
    expect(['delivered', 'running', 'blocked']).toContain(status);
    expect(h.crud.getRun('run-1')?.error).not.toBe('crash anterior');
    cleanup();
  });
});

describe('REJECT-com-replan no gate de PLANO spawna planner-r{n+1} (SM-20)', () => {
  it('reject no plan-review NAO mata o run: o .js recebe action:replan e roda outro planner', async () => {
    const plannerCalls: string[] = [];
    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Plan');
      await ctx.agent({ id: 'planner-r0', agentId: 'a-plan', access: 'read-only', prompt: 'plan' });
      plannerCalls.push('planner-r0');
      const review = (await ctx.gate({ id: 'plan-gate', mode: 'human', kind: 'plan-review', checks: [] })) as {
        decisionPayload?: { action?: string };
      };
      if (review?.decisionPayload?.action === 'replan') {
        await ctx.agent({ id: 'planner-r1', agentId: 'a-plan', access: 'read-only', prompt: 'replan com findings' });
        plannerCalls.push('planner-r1');
      }
      return { ok: true, rounds: plannerCalls.length };
    };
    const h = makeHarness({ coordinator, projectPath: tmpRoot });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    const blocked = await waitFor(h.crud, 'run-1', 'blocked');
    expect(blocked).toBe('blocked');
    expect(plannerCalls).toEqual(['planner-r0']);

    const rejectRes = await runner.approveGate('run-1', 'plan-gate', { decision: 'reject' }, 'human');
    expect(rejectRes).toEqual({ ok: true });

    await vi.waitFor(() => expect(plannerCalls).toContain('planner-r1'));
    expect(plannerCalls).toEqual(['planner-r0', 'planner-r1']);
    expect(h.crud.getRun('run-1')?.status).not.toBe('failed');
    expect(h.state.events.some((e) => e.type === 'gate-replan-requested')).toBe(true);
    cleanup();
  });

  it('approve as-is no plan-review (sem replan) NAO re-planeja (segue para a entrega)', async () => {
    const plannerCalls: string[] = [];
    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Plan');
      await ctx.agent({ id: 'planner-r0', agentId: 'a-plan', access: 'read-only', prompt: 'plan' });
      plannerCalls.push('planner-r0');
      const review = (await ctx.gate({ id: 'plan-gate', mode: 'human', kind: 'plan-review', checks: [] })) as {
        decisionPayload?: { action?: string };
      };
      if (review?.decisionPayload?.action === 'replan') {
        await ctx.agent({ id: 'planner-r1', agentId: 'a-plan', access: 'read-only', prompt: 'r1' });
        plannerCalls.push('planner-r1');
      }
      return { ok: true };
    };
    const h = makeHarness({ coordinator, projectPath: tmpRoot });
    const runner = new WorkflowRunner(h.deps);
    await runner.start('run-1');
    await waitFor(h.crud, 'run-1', 'blocked');
    await runner.approveGate('run-1', 'plan-gate', { decision: 'approve' }, 'human');
    await waitFor(h.crud, 'run-1', ['delivered', 'running', 'completed']);
    expect(plannerCalls).toEqual(['planner-r0']);
    expect(h.state.events.some((e) => e.type === 'gate-replan-requested')).toBe(false);
    cleanup();
  });
});

function installAdjustmentStore(
  h: Harness,
): Array<{ id: number; nodeId: string | null; content: string; applied: string | null; consumed: boolean }> {
  const rows: Array<{ id: number; nodeId: string | null; content: string; applied: string | null; consumed: boolean }> =
    [];
  const origInsert = h.crud.insertMessage;
  h.crud.insertMessage = (input) => {
    const m = origInsert(input);
    if (input.kind === 'adjustment') {
      rows.push({ id: m.id, nodeId: input.nodeId ?? null, content: input.content, applied: null, consumed: false });
    }
    return m;
  };
  const toMsg = (r: (typeof rows)[number]) => ({
    id: r.id,
    runId: 'run-1',
    nodeId: r.nodeId,
    role: 'user',
    source: 'orchestrator' as const,
    kind: 'adjustment',
    content: r.content,
    toolCallsJson: null,
    agentId: null,
    createdAt: NOW,
    appliedNodeId: r.applied,
    consumedAt: r.consumed ? NOW : null,
  });
  h.crud.claimAdjustmentsForNode = (_runId, nodeId) => {
    const pick = (t: string) => rows.filter((r) => !r.consumed && r.nodeId === t);
    const got = [...pick(nodeId), ...pick('*')];
    for (const r of got) {
      r.consumed = true;
      r.applied = nodeId;
    }
    return got.sort((a, b) => a.id - b.id).map(toMsg);
  };
  h.crud.getConsumedAdjustmentsForNode = (_runId, nodeId) =>
    rows
      .filter((r) => r.consumed && r.applied === nodeId)
      .sort((a, b) => a.id - b.id)
      .map(toMsg);
  return rows;
}

function seededJournalEntry(nodeId: string, callIndex: number): DynamicWorkflowJournalEntry {
  return {
    runId: 'run-1',
    callIndex,
    callPath: `${nodeId}:agent`,
    primitive: 'agent',
    nodeId,
    argHash: `hash-${nodeId}`,
    schemaRef: null,
    policyHash: `policy-${nodeId}`,
    agentId: 'a-plan',
    model: null,
    runtime: null,
    planHash: null,
    workflowRevision: null,
    outputRef: null,
    sideEffectKey: null,
    createdAt: NOW,
  };
}

describe('rerun-node (D9): quiescencia real, truncate no node, ajuste consumido (D8) e resume', () => {
  it('run BLOCKED por gate com child VIVO: quiesce (pause + aguarda), trunca no node, re-executa com [AJUSTE DO ORQUESTRADOR] e re-alcanca o gate', async () => {
    const plannerPrompts: string[] = [];
    const adapter = (input: RunNodeAgentInput): Promise<NodeRunResult> => {
      if (input.grants.nodeId === 'planner-r0') plannerPrompts.push(input.prompt);
      return makeFakeAdapter(input);
    };
    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Plan');
      await ctx.agent({ id: 'planner-r0', agentId: 'a-plan', access: 'read-only', prompt: 'plan' });
      await ctx.gate({ id: 'plan-gate', mode: 'human', kind: 'plan-review', checks: [] });
      return { ok: true };
    };
    const h = makeHarness({ coordinator, projectPath: tmpRoot, adapter });
    installAdjustmentStore(h);
    let inputJsonAtRerun: string | undefined;
    const originalInsertEvent = h.crud.insertEvent;
    h.crud.insertEvent = (input) => {
      if (input.type === 'rerun-requested') inputJsonAtRerun = h.crud.getRun('run-1')?.inputJson;
      return originalInsertEvent(input);
    };
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    expect(await waitFor(h.crud, 'run-1', 'blocked')).toBe('blocked');
    expect(isWorkflowRunLocked('run-1')).toBe(true);
    expect(JSON.parse(h.crud.getRun('run-1')!.inputJson).pendingDecision).toMatchObject({
      type: 'gate',
      id: 'plan-gate',
    });
    expect(h.state.journal.some((e) => e.nodeId === 'planner-r0')).toBe(true);
    expect(plannerPrompts).toEqual(['plan']);

    const res = await runner.intervene(
      'run-1',
      { type: 'rerun-node', nodeId: 'planner-r0', instruction: 'refaca o plano com 2 sprints' },
      'orchestrator',
    );
    expect(res).toEqual({ ok: true });

    const types = h.state.events.map((e) => e.type);
    expect(types).toContain('pause-requested');
    expect(types.indexOf('run-paused')).toBeGreaterThan(types.indexOf('pause-requested'));
    expect(types.indexOf('rerun-requested')).toBeGreaterThan(types.indexOf('run-paused'));
    const rerun = h.state.events.find((e) => e.type === 'rerun-requested')!;
    expect(JSON.parse(rerun.payload as string)).toMatchObject({
      nodeId: 'planner-r0',
      clearedDecision: { type: 'gate', id: 'plan-gate' },
    });
    expect(inputJsonAtRerun).toBeDefined();
    expect(JSON.parse(inputJsonAtRerun!).pendingDecision).toBeUndefined();

    expect(await waitFor(h.crud, 'run-1', 'blocked')).toBe('blocked');
    await vi.waitFor(() => expect(plannerPrompts).toHaveLength(2));
    expect(plannerPrompts[1]).toBe('plan\n\n[AJUSTE DO ORQUESTRADOR]\nrefaca o plano com 2 sprints');
    const entry = h.state.journal.find((e) => e.nodeId === 'planner-r0')!;
    expect(entry.argHash).not.toBe('hash-planner-r0');
    expect(h.state.messages.some((m) => m.kind === 'adjustment' && m.nodeId === 'planner-r0')).toBe(true);
    await runner.abort('run-1');
    cleanup();
  });

  it('run PAUSED (ja parado): trunca direto e retoma; node re-executa com o ajuste', async () => {
    const plannerPrompts: string[] = [];
    let holdCoder: () => void = () => {};
    let coderCalls = 0;
    const adapter = (input: RunNodeAgentInput): Promise<NodeRunResult> => {
      if (input.grants.nodeId === 'planner-r0') plannerPrompts.push(input.prompt);
      if (input.grants.nodeId === 'coder') {
        coderCalls += 1;
        if (coderCalls === 1) {
          return new Promise<NodeRunResult>((resolve) => {
            holdCoder = () =>
              resolve({
                ...(makeFakeAdapter(input) as unknown as NodeRunResult),
                ok: false,
                output: '',
              } as NodeRunResult);
          });
        }
      }
      return makeFakeAdapter(input);
    };
    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Plan');
      await ctx.agent({ id: 'planner-r0', agentId: 'a-plan', access: 'read-only', prompt: 'plan' });
      await ctx.phase('Implementar');
      await ctx.agent({
        id: 'coder',
        agentId: 'a-coder',
        access: 'workspace-write',
        writeSet: ['src/**'],
        prompt: 'impl',
      });
      await ctx.log({ message: 'pos-coder' });
      return { ok: true };
    };
    const h = makeHarness({ coordinator, projectPath: tmpRoot, adapter });
    installAdjustmentStore(h);
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    await vi.waitFor(() => expect(coderCalls).toBe(1));
    expect(await runner.pause('run-1')).toEqual({ ok: true });
    holdCoder();
    expect(await waitFor(h.crud, 'run-1', 'paused')).toBe('paused');
    await vi.waitFor(() => expect(isWorkflowRunLocked('run-1')).toBe(false));
    expect(h.state.journal.some((e) => e.nodeId === 'planner-r0')).toBe(true);

    const res = await runner.intervene(
      'run-1',
      { type: 'rerun-node', nodeId: 'planner-r0', instruction: 'plano menor' },
      'orchestrator',
    );
    expect(res).toEqual({ ok: true });
    const pauses = h.state.events.filter((e) => e.type === 'pause-requested');
    expect(pauses).toHaveLength(1);
    expect(h.state.events.some((e) => e.type === 'rerun-requested')).toBe(true);
    await waitFor(h.crud, 'run-1', ['delivered', 'blocked', 'completed']);
    await vi.waitFor(() => expect(plannerPrompts).toHaveLength(2));
    expect(plannerPrompts[1]).toContain('[AJUSTE DO ORQUESTRADOR]\nplano menor');
    cleanup();
  });

  it('run FAILED (terminal): rerun-node recupera via interrupted (isento do guard terminal) e re-executa', async () => {
    const plannerPrompts: string[] = [];
    const adapter = (input: RunNodeAgentInput): Promise<NodeRunResult> => {
      if (input.grants.nodeId === 'planner-r0') plannerPrompts.push(input.prompt);
      return makeFakeAdapter(input);
    };
    const coordinator: Coordinator = async (ctx) => {
      await ctx.agent({ id: 'planner-r0', agentId: 'a-plan', access: 'read-only', prompt: 'plan' });
      return { ok: true };
    };
    const h = makeHarness({
      coordinator,
      projectPath: tmpRoot,
      adapter,
      run: {
        status: 'failed',
        error: 'crash',
        workspaceMode: 'run-worktree',
        worktreeBranch: 'dynworkflow/run-1',
        baseCommitSha: 'basesha',
        worktreePath: join(tmpRoot, 'wt'),
      },
    });
    installAdjustmentStore(h);
    h.state.journal.push(seededJournalEntry('planner-r0', 1));
    const runner = new WorkflowRunner(h.deps);

    const res = await runner.intervene(
      'run-1',
      { type: 'rerun-node', nodeId: 'planner-r0', instruction: 'de novo' },
      'orchestrator',
    );
    expect(res).toEqual({ ok: true });
    expect(h.state.events.some((e) => e.type === 'rerun-requested')).toBe(true);
    expect(h.state.events.some((e) => e.type === 'run-recovered-from-terminal')).toBe(true);
    await waitFor(h.crud, 'run-1', ['delivered', 'blocked', 'completed', 'running']);
    await vi.waitFor(() => expect(plannerPrompts).toHaveLength(1));
    expect(plannerPrompts[0]).toBe('plan\n\n[AJUSTE DO ORQUESTRADOR]\nde novo');
    cleanup();
  });

  it('run BLOCKED por PROVIDER pos-restart (sem child): limpa pendingDecision de forma auditavel, vai a interrupted e retoma', async () => {
    const coordinator: Coordinator = async (ctx) => {
      await ctx.agent({ id: 'planner-r0', agentId: 'a-plan', access: 'read-only', prompt: 'plan' });
      return { ok: true };
    };
    const pending = {
      type: 'provider',
      id: 'provider:planner-r0',
      prompt: 'limite',
      nodeId: 'planner-r0',
      failureClass: 'provider-limit',
      retriesExhausted: true,
      nodeError: 'boom',
    };
    const h = makeHarness({
      coordinator,
      projectPath: tmpRoot,
      run: { status: 'blocked', inputJson: JSON.stringify({ pendingDecision: pending }) },
    });
    installAdjustmentStore(h);
    h.state.journal.push(seededJournalEntry('planner-r0', 1));
    const runner = new WorkflowRunner(h.deps);

    const res = await runner.intervene(
      'run-1',
      { type: 'rerun-node', nodeId: 'planner-r0', instruction: 'tente outro modelo' },
      'orchestrator',
    );
    expect(res).toEqual({ ok: true });
    const rerun = h.state.events.find((e) => e.type === 'rerun-requested')!;
    expect(JSON.parse(rerun.payload as string)).toMatchObject({
      nodeId: 'planner-r0',
      clearedDecision: { type: 'provider', nodeError: 'boom' },
    });
    expect(h.state.events.some((e) => e.type === 'pause-requested')).toBe(false);
    const status = await waitFor(h.crud, 'run-1', ['delivered', 'blocked', 'completed', 'running']);
    expect(['delivered', 'blocked', 'completed', 'running']).toContain(status);
    expect(JSON.parse(h.crud.getRun('run-1')!.inputJson).pendingDecision).toBeUndefined();
    expect(h.state.events.some((e) => e.type === 'resume-requested')).toBe(true);
    cleanup();
  });

  it('child que NAO quiesce no prazo: erro "nao quiesceu" e NADA truncado (journal intacto, sem rerun-requested)', async () => {
    let coderStarted = false;
    const adapter = (input: RunNodeAgentInput): Promise<NodeRunResult> => {
      if (input.grants.nodeId === 'coder') {
        coderStarted = true;
        return new Promise<NodeRunResult>(() => {});
      }
      return makeFakeAdapter(input);
    };
    const coordinator: Coordinator = async (ctx) => {
      await ctx.agent({ id: 'planner-r0', agentId: 'a-plan', access: 'read-only', prompt: 'plan' });
      await ctx.agent({
        id: 'coder',
        agentId: 'a-coder',
        access: 'workspace-write',
        writeSet: ['src/**'],
        prompt: 'impl',
      });
      return { ok: true };
    };
    const h = makeHarness({ coordinator, projectPath: tmpRoot, adapter });
    installAdjustmentStore(h);
    const runner = new WorkflowRunner({ ...h.deps, quiesceTimeoutMs: 150 });

    await runner.start('run-1');
    await vi.waitFor(() => expect(coderStarted).toBe(true));
    const journalBefore = h.state.journal.map((e) => e.callIndex);
    expect(journalBefore.length).toBeGreaterThan(0);

    const res = await runner.intervene(
      'run-1',
      { type: 'rerun-node', nodeId: 'planner-r0', instruction: 'x' },
      'orchestrator',
    );
    expect('error' in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/nao quiesceu/);
    expect(h.state.journal.map((e) => e.callIndex)).toEqual(journalBefore);
    expect(h.state.events.some((e) => e.type === 'rerun-requested')).toBe(false);
    expect(h.state.messages.some((m) => m.kind === 'adjustment')).toBe(false);
    cleanup();
  });

  it('node fora do journal: erro claro, nada truncado, sem ajuste gravado', async () => {
    const h = makeHarness({
      coordinator: async () => ({ ok: true }),
      projectPath: tmpRoot,
      run: { status: 'paused' },
    });
    installAdjustmentStore(h);
    h.state.journal.push(seededJournalEntry('planner-r0', 1));
    const runner = new WorkflowRunner(h.deps);
    const res = await runner.intervene(
      'run-1',
      { type: 'rerun-node', nodeId: 'nao-existe', instruction: 'x' },
      'orchestrator',
    );
    expect('error' in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/nao esta no journal/);
    expect(h.state.journal).toHaveLength(1);
    expect(h.state.messages.some((m) => m.kind === 'adjustment')).toBe(false);
    cleanup();
  });

  it('intervene resume com acceptBoundary repassa ao runner (evento resume-requested {acceptBoundary:true})', async () => {
    const h = makeHarness({
      coordinator: async () => ({ ok: true }),
      projectPath: tmpRoot,
      run: { status: 'paused' },
    });
    const runner = new WorkflowRunner(h.deps);
    const res = await runner.intervene('run-1', { type: 'resume', acceptBoundary: true }, 'orchestrator');
    expect(res).toEqual({ ok: true });
    const ev = h.state.events.find((e) => e.type === 'resume-requested')!;
    expect(JSON.parse(ev.payload as string)).toEqual({ acceptBoundary: true });
    await waitFor(h.crud, 'run-1', ['delivered', 'completed', 'blocked', 'running']);
    cleanup();
  });
});

function installClaimStore(h: Harness): Array<{
  id: number;
  nodeId: string | null;
  kind: string;
  content: string;
  applied: string | null;
  consumed: boolean;
}> {
  const rows: Array<{
    id: number;
    nodeId: string | null;
    kind: string;
    content: string;
    applied: string | null;
    consumed: boolean;
  }> = [];
  const origInsert = h.crud.insertMessage;
  h.crud.insertMessage = (input) => {
    const m = origInsert(input);
    if (input.kind === 'adjustment' || input.kind === 'agent-switch') {
      rows.push({
        id: m.id,
        nodeId: input.nodeId ?? null,
        kind: input.kind,
        content: input.content,
        applied: null,
        consumed: false,
      });
    }
    return m;
  };
  const toMsg = (r: (typeof rows)[number]) => ({
    id: r.id,
    runId: 'run-1',
    nodeId: r.nodeId,
    role: 'user',
    source: 'orchestrator' as const,
    kind: r.kind,
    content: r.content,
    toolCallsJson: null,
    agentId: null,
    createdAt: NOW,
    appliedNodeId: r.applied,
    consumedAt: r.consumed ? NOW : null,
  });
  h.crud.claimAdjustmentsForNode = (_runId, nodeId) => {
    const got = rows.filter((r) => !r.consumed && (r.nodeId === nodeId || r.nodeId === '*'));
    for (const r of got) {
      r.consumed = true;
      r.applied = nodeId;
    }
    return got.sort((a, b) => a.id - b.id).map(toMsg);
  };
  h.crud.getConsumedAdjustmentsForNode = (_runId, nodeId) =>
    rows
      .filter((r) => r.consumed && r.applied === nodeId)
      .sort((a, b) => a.id - b.id)
      .map(toMsg);
  return rows;
}

function failThenOkAdapter(failures: number, seen: Array<{ agentId: string; prompt: string }> = []) {
  let calls = 0;
  return async (input: RunNodeAgentInput): Promise<NodeRunResult> => {
    const base = await makeFakeAdapter(input);
    seen.push({ agentId: input.agentId, prompt: input.prompt });
    calls += 1;
    if (calls <= failures) {
      return {
        ...base,
        ok: false,
        output: '',
        failureClass: 'logic',
        errorMessage: 'Reached maximum number of turns (80)',
      };
    }
    return base;
  };
}

function pendingOf(h: Harness): Record<string, unknown> | undefined {
  return JSON.parse(h.crud.getRun('run-1')!.inputJson || '{}').pendingDecision as Record<string, unknown> | undefined;
}

describe('L1.1 (runner): gate failure:<nodeId> com o child vivo', () => {
  it('falha logic => run BLOCKED no gate failure:planner-r0 (pendingDecision provider + gateId), child vivo, lock preso; rerun-node no node falho = retry com instrucao (sem truncate)', async () => {
    const seen: Array<{ agentId: string; prompt: string }> = [];
    const coordinator: Coordinator = async (ctx) => {
      const out = await ctx.agent({ id: 'planner-r0', agentId: 'a-plan', access: 'read-only', prompt: 'plan' });
      return { got: out };
    };
    const h = makeHarness({
      coordinator,
      projectPath: tmpRoot,
      run: { status: 'created' },
      adapter: failThenOkAdapter(1, seen),
    });
    installClaimStore(h);
    const runner = new WorkflowRunner({ ...h.deps, sleep: async () => {} });
    await runner.start('run-1');
    expect(await waitFor(h.crud, 'run-1', 'blocked')).toBe('blocked');
    expect(pendingOf(h)).toMatchObject({
      type: 'provider',
      id: 'failure:planner-r0',
      gateId: 'failure:planner-r0',
      failureClass: 'logic',
    });
    expect(isWorkflowRunLocked('run-1')).toBe(true);
    expect(
      h.state.events.some((e) => e.type === 'gate-blocked' && String(e.payload).includes('failure:planner-r0')),
    ).toBe(true);

    const res = await runner.intervene(
      'run-1',
      { type: 'rerun-node', nodeId: 'planner-r0', instruction: 'tente de novo' },
      'orchestrator',
    );
    expect(res).toEqual({ ok: true });
    expect(h.state.events.some((e) => e.type === 'rerun-requested')).toBe(false);
    expect(await waitFor(h.crud, 'run-1', ['delivered', 'completed'])).toMatch(/delivered|completed/);
    expect(seen.map((s) => s.prompt)).toEqual(['plan', `plan${'\n\n[AJUSTE DO ORQUESTRADOR]\n'}tente de novo`]);
    expect(pendingOf(h)).toBeUndefined();
    const approved = h.state.events.find((e) => e.type === 'gate-approved');
    expect(JSON.parse(approved!.payload as string)).toMatchObject({ gateId: 'failure:planner-r0', action: 'retry' });
    const attempts = h.crud
      .listNodeRuns('run-1')
      .filter((n) => n.nodeId === 'planner-r0')
      .map((n) => [n.attempt, n.status]);
    expect(attempts).toEqual([
      [1, 'failed'],
      [2, 'completed'],
    ]);
    expect(h.state.events.some((e) => e.type === 'run-failed')).toBe(false);
    cleanup();
  });

  it('approve switch-agent grava agent-switch e a nova attempt roda com o agentId novo; agentType da denylist e recusado', async () => {
    const seen: Array<{ agentId: string; prompt: string }> = [];
    const coordinator: Coordinator = async (ctx) => {
      await ctx.agent({ id: 'planner-r0', agentId: 'a-plan', access: 'read-only', prompt: 'plan' });
      return { ok: true };
    };
    const h = makeHarness({
      coordinator,
      projectPath: tmpRoot,
      run: { status: 'created' },
      adapter: failThenOkAdapter(1, seen),
    });
    const rows = installClaimStore(h);
    const runner = new WorkflowRunner({ ...h.deps, sleep: async () => {} });
    await runner.start('run-1');
    expect(await waitFor(h.crud, 'run-1', 'blocked')).toBe('blocked');

    const denied = await runner.approveGate(
      'run-1',
      'failure:planner-r0',
      { decision: 'approve', payload: { action: 'switch-agent', agentType: 'dynamic-workflow-closer' } },
      'orchestrator',
    );
    expect(denied).toMatchObject({ error: expect.stringContaining('denylist') });
    const invalid = await runner.approveGate(
      'run-1',
      'failure:planner-r0',
      { decision: 'approve', payload: { action: 'redev' } },
      'orchestrator',
    );
    expect(invalid).toMatchObject({ error: expect.stringContaining('payload.action invalida') });
    expect(h.crud.getRun('run-1')?.status).toBe('blocked');

    const res = await runner.approveGate(
      'run-1',
      'failure:planner-r0',
      { decision: 'approve', payload: { action: 'switch-agent', agentType: 'a-plan-b' } },
      'orchestrator',
    );
    expect(res).toEqual({ ok: true });
    expect(await waitFor(h.crud, 'run-1', ['delivered', 'completed'])).toMatch(/delivered|completed/);
    expect(seen.map((s) => s.agentId)).toEqual(['a-plan', 'a-plan-b']);
    expect(rows.map((r) => [r.kind, r.content, r.consumed])).toEqual([['agent-switch', 'a-plan-b', true]]);
    const attempts = h.crud
      .listNodeRuns('run-1')
      .filter((n) => n.nodeId === 'planner-r0')
      .map((n) => [n.attempt, n.agentId, n.status]);
    expect(attempts).toEqual([
      [1, 'a-plan', 'failed'],
      [2, 'a-plan-b', 'completed'],
    ]);
    cleanup();
  });

  it('reject (= abort) no gate de falha aborta o run (recuperavel), sem falsa entrega', async () => {
    const coordinator: Coordinator = async (ctx) => {
      await ctx.agent({ id: 'planner-r0', agentId: 'a-plan', access: 'read-only', prompt: 'plan' });
      return { ok: true };
    };
    const h = makeHarness({
      coordinator,
      projectPath: tmpRoot,
      run: { status: 'created' },
      adapter: failThenOkAdapter(5),
    });
    installClaimStore(h);
    const runner = new WorkflowRunner({ ...h.deps, sleep: async () => {} });
    await runner.start('run-1');
    expect(await waitFor(h.crud, 'run-1', 'blocked')).toBe('blocked');
    const res = await runner.approveGate('run-1', 'failure:planner-r0', { decision: 'reject' }, 'orchestrator');
    expect(res).toEqual({ ok: true });
    expect(await waitFor(h.crud, 'run-1', 'aborted')).toBe('aborted');
    expect(h.state.events.some((e) => e.type === 'run-delivered')).toBe(false);
    cleanup();
  });

  it('gate de falha ORFAO (restart): approve retry re-arma pelo inbox e o replay re-executa o node; approve abort aborta direto', async () => {
    const seen: Array<{ agentId: string; prompt: string }> = [];
    const coordinator: Coordinator = async (ctx) => {
      await ctx.agent({ id: 'planner-r0', agentId: 'a-plan', access: 'read-only', prompt: 'plan' });
      return { ok: true };
    };
    const pending = {
      type: 'provider',
      id: 'failure:planner-r0',
      gateId: 'failure:planner-r0',
      prompt: 'x',
      nodeId: 'planner-r0',
      failureClass: 'logic',
      retriesExhausted: false,
      attemptsMade: 1,
      nodeError: 'boom',
      actions: ['retry', 'switch-agent', 'skip', 'abort'],
    };
    const h = makeHarness({
      coordinator,
      projectPath: tmpRoot,
      run: { status: 'blocked', inputJson: JSON.stringify({ pendingDecision: pending }) },
      adapter: failThenOkAdapter(0, seen),
    });
    installClaimStore(h);
    const runner = new WorkflowRunner({ ...h.deps, sleep: async () => {} });
    const res = await runner.approveGate(
      'run-1',
      'failure:planner-r0',
      { decision: 'approve', payload: { action: 'retry', instruction: 'de novo' } },
      'orchestrator',
    );
    expect(res).toEqual({ ok: true });
    expect(h.state.events.some((e) => e.type === 'gate-orphan-rearm')).toBe(true);
    expect(await waitFor(h.crud, 'run-1', ['delivered', 'completed'])).toMatch(/delivered|completed/);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.prompt).toContain('[AJUSTE DO ORQUESTRADOR]');
    expect(pendingOf(h)).toBeUndefined();
    cleanup();

    _resetRunLocksForTesting();
    tmpRoot = mkdtempSync(join(tmpdir(), 'dwf-trans-'));
    mkdirSync(join(tmpRoot, 'src'), { recursive: true });
    const h2 = makeHarness({
      coordinator,
      projectPath: tmpRoot,
      run: { status: 'blocked', inputJson: JSON.stringify({ pendingDecision: pending }) },
      adapter: failThenOkAdapter(0),
    });
    const runner2 = new WorkflowRunner(h2.deps);
    const res2 = await runner2.approveGate(
      'run-1',
      'failure:planner-r0',
      { decision: 'approve', payload: { action: 'abort' } },
      'orchestrator',
    );
    expect(res2).toEqual({ ok: true });
    expect(h2.crud.getRun('run-1')?.status).toBe('aborted');
    expect(pendingOf(h2)).toBeUndefined();
    cleanup();
  });

  it('watchdog de stall aborta SO o node (falha timeout + retry in-process), sem pausar o run', async () => {
    let calls = 0;
    const adapter = async (input: RunNodeAgentInput): Promise<NodeRunResult> => {
      calls += 1;
      const base = await makeFakeAdapter(input);
      if (calls === 1) {
        await new Promise<void>((resolve) =>
          input.abortSignal!.addEventListener('abort', () => resolve(), { once: true }),
        );
        return {
          ...base,
          ok: false,
          output: '',
          failureClass: 'cancelled',
          errorMessage: 'The operation was aborted',
          aborted: true,
        };
      }
      return base;
    };
    const coordinator: Coordinator = async (ctx) => {
      const out = await ctx.agent({ id: 'planner-r0', agentId: 'a-plan', access: 'read-only', prompt: 'plan' });
      return { got: out };
    };
    const h = makeHarness({ coordinator, projectPath: tmpRoot, run: { status: 'created' }, adapter });
    installClaimStore(h);
    const timers: Array<() => void> = [];
    const runner = new WorkflowRunner({
      ...h.deps,
      sleep: async () => {},
      scheduleTimer: (_ms, cb) => {
        timers.push(cb);
        return { cancel: () => undefined };
      },
    });
    await runner.start('run-1');
    await new Promise((r) => setTimeout(r, 20));
    expect(timers.length).toBeGreaterThan(0);
    for (const cb of timers.splice(0)) cb();
    expect(await waitFor(h.crud, 'run-1', ['delivered', 'completed'])).toMatch(/delivered|completed/);
    expect(h.state.events.some((e) => e.type === 'node-stalled')).toBe(true);
    expect(h.state.events.some((e) => e.type === 'pause-requested')).toBe(false);
    const failed = h.state.events.find((e) => e.type === 'node-failed');
    expect(JSON.parse(failed!.payload as string)).toMatchObject({ failureClass: 'timeout', stalled: true });
    expect(calls).toBe(2);
    expect(h.state.events.some((e) => e.type === 'run-paused')).toBe(false);
    cleanup();
  });
});
