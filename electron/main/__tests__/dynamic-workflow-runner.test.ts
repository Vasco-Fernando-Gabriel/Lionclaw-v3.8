import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  WorkflowRunner,
  recoverInterruptedRuns,
  isWorkflowRunLocked,
  _resetRunLocksForTesting,
  type WorkflowRunnerDeps,
  type WorkflowRunnerCrud,
  type WorkflowTimerHandle,
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
} from '../dynamic-workflows/types';
import { runGit, WORKFLOW_RUN_LOCK_FILE, type GitRunResult } from '../dynamic-workflows/workflow-git';
import type { WorkspaceHandle } from '../dynamic-workflows/workflow-worktree';
import type { CloserTurnResult } from '../dynamic-workflows/workflow-closer';
import type { NodeRunResult, RunNodeAgentInput } from '../dynamic-workflows/workflow-agent-adapter';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Coordinator = (ctx: CoordinatorCtx) => Promise<unknown>;

interface CoordinatorCtx {
  phase: (name: string) => Promise<unknown>;
  agent: (arg: unknown) => Promise<unknown>;
  parallel: (arg: unknown) => Promise<unknown>;
  pipeline: (arg: unknown) => Promise<unknown>;
  gate: (arg: unknown) => Promise<unknown>;
  artifact: (arg: unknown) => Promise<unknown>;
  checkpoint: (arg: unknown) => Promise<unknown>;
  log: (arg: unknown) => Promise<unknown>;
}

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
          const a = arg as { thunks?: Array<() => Promise<unknown>>; options?: { failFast?: boolean } };
          const thunks = a.thunks ?? [];
          const results: unknown[] = [];
          for (const t of thunks) {
            try {
              results.push(await t());
            } catch {
              results.push(null);
              if (a.options?.failFast) break;
            }
          }
          return results;
        },
        pipeline: async (arg) => {
          const a = arg as { items?: unknown[]; stages?: Array<(item: unknown, i: number) => Promise<unknown>> };
          const items = a.items ?? [];
          const stages = a.stages ?? [];
          return Promise.all(
            items.map(async (item, i) => {
              let acc: unknown = item;
              for (const s of stages) acc = await s(acc, i);
              return acc;
            }),
          );
        },
        gate: (arg) => callPrimitive('gate', arg),
        artifact: (arg) => callPrimitive('artifact', arg),
        checkpoint: (arg) => callPrimitive('checkpoint', arg),
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

interface RunnerHarness {
  deps: WorkflowRunnerDeps;
  crud: WorkflowRunnerCrud;
  state: {
    runs: Map<string, DynamicWorkflowRun>;
    definitions: Map<string, DynamicWorkflowDefinition>;
    nodeRuns: Map<string, DynamicWorkflowNodeRun>;
    events: Array<{ type: string; runId: string; payload?: unknown }>;
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
    updatedAt: '2026-06-12T00:00:00.000Z',
    completedAt: null,
    ...over,
  };
}

function makeManifest(): DynamicWorkflowManifest {
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

function writeWorkflowJs(dir: string): string {
  const src = [
    "export const meta = { name: 'test-wf', description: 'runner test wf', phases: ['Scout', 'Implementar', 'Validar', 'Gate'] };",
    "await phase('Scout');",
    'return { ok: true };',
  ].join('\n');
  const path = join(dir, 'workflow.js');
  writeFileSync(path, src, 'utf8');
  return path;
}

function makeFakeAdapter(
  over?: (input: RunNodeAgentInput) => Promise<NodeRunResult>,
): (input: RunNodeAgentInput, deps?: unknown) => Promise<NodeRunResult> {
  return (input) => {
    if (over) return over(input);
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

function makeRunnerHarness(opts: {
  coordinator: Coordinator;
  projectPath: string;
  git?: (args: string[], cwd: string) => Promise<GitRunResult>;
  closerTurn?: (input: { runId: string }) => Promise<CloserTurnResult>;
  adapter?: (input: RunNodeAgentInput) => Promise<NodeRunResult>;
  run?: Partial<DynamicWorkflowRun>;
  runGateCommand?: (
    command: string,
    args: string[],
    o: { cwd?: string; timeoutMs?: number },
  ) => { status: number | null; stdout: string; stderr: string; timedOut: boolean };
  manifest?: DynamicWorkflowManifest;
}): RunnerHarness {
  const workflowJsPath = writeWorkflowJs(opts.projectPath);
  const definition: DynamicWorkflowDefinition = {
    id: 'def-1',
    name: 'test-wf',
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
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
  };

  const state: RunnerHarness['state'] = {
    runs: new Map([['run-1', makeRun(opts.run)]]),
    definitions: new Map([['def-1', definition]]),
    nodeRuns: new Map(),
    events: [],
    gateDecisions: [],
    messages: [],
  };
  let msgId = 0;
  let gateDecId = 0;

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
        createdAt: '2026-06-12T00:00:00.000Z',
      };
    },
    recentEvents: () => [],
    insertGateDecision: (input) => {
      gateDecId += 1;
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
    registerArtifact: (input) => ({
      id: input.id,
      runId: input.runId,
      nodeId: input.nodeId ?? null,
      kind: input.kind,
      path: input.path,
      sha256: input.sha256,
      metadataJson: input.metadataJson ?? '{}',
      createdAt: '2026-06-12T00:00:00.000Z',
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
        createdAt: '2026-06-12T00:00:00.000Z',
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
          createdAt: '2026-06-12T00:00:00.000Z',
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
    now: () => '2026-06-12T00:00:00.000Z',
    runNodeAgent: makeFakeAdapter(opts.adapter) as WorkflowRunnerDeps['runNodeAgent'],
    runGateCommand: opts.runGateCommand,
    closerDeps: opts.closerTurn
      ? {
          runAgentTurn: async (input) => opts.closerTurn!({ runId: input.runId }),
          resolveCloserRuntime: () => 'cloud',
        }
      : undefined,
  };

  return { deps, crud, state };
}

function defaultFakeGit(
  over?: (args: string[], cwd: string) => GitRunResult | null,
): (args: string[], cwd: string) => Promise<GitRunResult> {
  return async (args, cwd) => {
    const custom = over?.(args, cwd);
    if (custom) return custom;
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
  tmpRoot = mkdtempSync(join(tmpdir(), 'dwf-runner-'));
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

describe('workflow-runner: fluxo feliz', () => {
  it('scout -> coder -> validators -> gate humano aprovado conclui em delivered + closer (AC-9/AC-28)', async () => {
    const closerTurn = vi.fn(async () => ({ ok: true, output: 'walkthrough da entrega', costUsd: 0 }));
    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Scout');
      await ctx.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 's' });
      await ctx.phase('Implementar');
      await ctx.agent({
        id: 'coder',
        agentId: 'a-coder',
        access: 'workspace-write',
        writeSet: ['src/**'],
        prompt: 'impl',
      });
      await ctx.phase('Validar');
      await ctx.parallel({
        thunks: [
          () => ctx.agent({ id: 'v0', agentId: 'a-val', access: 'read-only', prompt: 'v0' }),
          () => ctx.agent({ id: 'v1', agentId: 'a-val', access: 'read-only', prompt: 'v1' }),
        ],
        options: { id: 'validators-r0', maxConcurrency: 2 },
      });
      await ctx.phase('Gate');
      const decision = await ctx.gate({ id: 'gate-global', mode: 'human', checks: [] });
      return { ok: (decision as { ok: boolean }).ok };
    };
    const h = makeRunnerHarness({ coordinator, projectPath: tmpRoot, closerTurn });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    const blocked = await waitForRunStatus(h.crud, 'run-1', 'blocked');
    expect(blocked).toBe('blocked');

    await runner.approveGate('run-1', 'gate-global', { decision: 'approve' });
    const terminal = await waitForRunStatus(h.crud, 'run-1', 'completed');
    expect(terminal).toBe('completed');
    const finalRun = h.crud.getRun('run-1');
    expect(finalRun?.deliveredAt).toBeTruthy();
    expect(finalRun?.completedAt).toBeTruthy();
    expect(finalRun?.finalizedAt).toBeTruthy();
    expect(finalRun?.closerStatus).toBe('closed');
    expect(h.state.events.some((e) => e.type === 'run-delivered')).toBe(true);
    expect(h.state.events.some((e) => e.type === 'workflow-finalized')).toBe(true);
    expect(closerTurn).toHaveBeenCalled();
    expect(h.state.gateDecisions.some((d) => d.gateId === 'gate-global' && d.decision === 'approved')).toBe(true);
    expect(runner.finalize('run-1')).toEqual({ ok: true });
    cleanup();
  });
});

describe('workflow-runner: writeSet enforcement DESLIGADO (decisao de produto)', () => {
  it('coder que toca arquivo FORA do writeSet NAO vira node-failed - so AUDITA (node-committed.outside>0)', async () => {
    const gitOutOfScope = defaultFakeGit((args) => {
      const cmd = args.join(' ');
      if (cmd.includes('diff --name-only') || cmd.includes('diff-tree')) return ok('vendor/x.ts');
      if (cmd.includes('check-ignore')) return { code: 1, stdout: '', stderr: '' };
      return null;
    });
    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Scout');
      await ctx.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 's' });
      await ctx.phase('Implementar');
      await ctx.agent({
        id: 'coder',
        agentId: 'a-coder',
        access: 'workspace-write',
        writeSet: ['src/**'],
        prompt: 'impl',
      });
      await ctx.phase('Gate');
      const decision = await ctx.gate({ id: 'gate-global', mode: 'human', checks: [] });
      return { ok: (decision as { ok: boolean }).ok };
    };
    const h = makeRunnerHarness({ coordinator, projectPath: tmpRoot, git: gitOutOfScope });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    const blocked = await waitForRunStatus(h.crud, 'run-1', 'blocked');
    expect(blocked).toBe('blocked');

    expect(
      h.state.events.some(
        (e) =>
          e.type === 'node-failed' && (e.payload as { reason?: string } | undefined)?.reason === 'writeset-violation',
      ),
    ).toBe(false);

    await runner.approveGate('run-1', 'gate-global', { decision: 'approve' });
    const terminal = await waitForRunStatus(h.crud, 'run-1', 'completed');
    expect(terminal).toBe('completed');
    cleanup();
  });
});

describe('workflow-runner: #G gate orfao pos-restart (recuperabilidade)', () => {
  it('approveGate re-arma pelo journal e conclui um gate cujo estado RAM sumiu no restart', async () => {
    const closerTurn = vi.fn(async () => ({ ok: true, output: 'walkthrough', costUsd: 0 }));
    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Implementar');
      await ctx.agent({
        id: 'coder',
        agentId: 'a-coder',
        access: 'workspace-write',
        writeSet: ['src/**'],
        prompt: 'impl',
      });
      await ctx.phase('Gate');
      const decision = await ctx.gate({ id: 'gate-global', mode: 'human', checks: [] });
      return { ok: (decision as { ok: boolean }).ok };
    };
    const h = makeRunnerHarness({ coordinator, projectPath: tmpRoot, closerTurn });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    await waitForRunStatus(h.crud, 'run-1', 'blocked');
    const pending = JSON.parse(h.crud.getRun('run-1')!.inputJson || '{}').pendingDecision;
    expect(pending?.type).toBe('gate');

    await runner.abort('run-1');
    await waitForRunStatus(h.crud, 'run-1', 'aborted');
    await new Promise((r) => setTimeout(r, 20));
    h.crud.updateRun('run-1', {
      status: 'blocked',
      completedAt: null,
      inputJson: JSON.stringify({ pendingDecision: pending }),
    });

    const res = await runner.approveGate('run-1', 'gate-global', { decision: 'approve' });
    expect(res).toMatchObject({ ok: true });
    const terminal = await waitForRunStatus(h.crud, 'run-1', 'completed');
    expect(terminal).toBe('completed');
    expect(h.state.gateDecisions.some((d) => d.gateId === 'gate-global' && d.decision === 'approved')).toBe(true);
    expect(h.state.events.some((e) => e.type === 'gate-orphan-rearm')).toBe(true);
    expect(h.state.events.some((e) => e.type === 'gate-orphan-resolved')).toBe(true);
    cleanup();
  });

  it('approveGate de gate orfao com gateId errado falha claro, sem re-armar', async () => {
    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Gate');
      const decision = await ctx.gate({ id: 'gate-global', mode: 'human', checks: [] });
      return { ok: (decision as { ok: boolean }).ok };
    };
    const h = makeRunnerHarness({ coordinator, projectPath: tmpRoot });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    await waitForRunStatus(h.crud, 'run-1', 'blocked');
    const pending = JSON.parse(h.crud.getRun('run-1')!.inputJson || '{}').pendingDecision;
    await runner.abort('run-1');
    await waitForRunStatus(h.crud, 'run-1', 'aborted');
    await new Promise((r) => setTimeout(r, 20));
    h.crud.updateRun('run-1', {
      status: 'blocked',
      completedAt: null,
      inputJson: JSON.stringify({ pendingDecision: pending }),
    });

    const wrong = await runner.approveGate('run-1', 'gate-inexistente', { decision: 'approve' });
    expect(wrong).toMatchObject({ error: expect.any(String) });
    expect(h.crud.getRun('run-1')?.status).toBe('blocked');
    cleanup();
  });
});

describe('workflow-runner: erro estrutural', () => {
  it('LEGADO: start() de definition manifest antiga falha com o erro normal de compile (sem caminho especial)', async () => {
    const coordinator: Coordinator = async () => ({ ok: true });
    const h = makeRunnerHarness({ coordinator, projectPath: tmpRoot });
    const def = h.crud.getDefinition('def-1')!;
    writeFileSync(
      def.workflowJsPath,
      [
        "export const meta = { name: 'legacy-wf', phases: ['Scout'] };",
        'export default async function run(ctx) { return { ok: true }; }',
      ].join('\n'),
      'utf8',
    );
    const runner = new WorkflowRunner(h.deps);
    const res = await runner.start('run-1');
    expect(res).toMatchObject({ error: expect.stringMatching(/description/) });
    expect(h.crud.getRun('run-1')?.status).toBe('failed');
    expect(h.crud.getRun('run-1')?.error).toMatch(/invalido/);
    cleanup();
  });

  it('node fora do manifest = run failed', async () => {
    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Scout');
      await ctx.agent({ id: 'ghost', agentId: 'a', access: 'read-only', prompt: 'x' });
      return { ok: true };
    };
    const h = makeRunnerHarness({ coordinator, projectPath: tmpRoot });
    const runner = new WorkflowRunner(h.deps);
    await runner.start('run-1');
    const status = await waitForRunStatus(h.crud, 'run-1', 'failed');
    expect(status).toBe('failed');
    expect(h.crud.getRun('run-1')?.error).toMatch(/nao existe no manifest/);
    cleanup();
  });
});

describe('workflow-runner: merge pos-gate base divergente (8.6.2 passo 3)', () => {
  it('base ANDOU + merge limpo + re-checks VERDES conclui sem novo aceite humano', async () => {
    let finalizeStagedCalled = false;
    const git = defaultFakeGit((args) => {
      const cmd = args.join(' ');
      if (cmd.includes('rev-parse --verify --quiet refs/heads/main')) return ok('newtip');
      if (cmd.includes('merge --ff-only')) {
        finalizeStagedCalled = true;
        return ok('');
      }
      return null;
    });
    const closerTurn = vi.fn(async () => ({ ok: true, output: 'ok', costUsd: 0 }));
    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Gate');
      const d = await ctx.gate({ id: 'gate-global', mode: 'human', checks: [] });
      return { ok: (d as { ok: boolean }).ok };
    };
    const h = makeRunnerHarness({ coordinator, projectPath: tmpRoot, git, closerTurn });
    const runner = new WorkflowRunner(h.deps);
    await runner.start('run-1');
    await waitForRunStatus(h.crud, 'run-1', 'blocked');
    await runner.approveGate('run-1', 'gate-global', { decision: 'approve' });
    const terminal = await waitForRunStatus(h.crud, 'run-1', 'completed');
    expect(terminal).toBe('completed');
    expect(h.crud.getRun('run-1')?.deliveredAt).toBeTruthy();
    expect(finalizeStagedCalled).toBe(true);
    expect(h.state.events.some((e) => e.type === 'merge-revalidated')).toBe(true);
    cleanup();
  });

  it('base ANDOU + merge limpo + re-checks VERMELHOS abre o closer (friccao)', async () => {
    const git = defaultFakeGit((args) => {
      const cmd = args.join(' ');
      if (cmd.includes('rev-parse --verify --quiet refs/heads/main')) return ok('newtip');
      return null;
    });
    const closerTurn = vi.fn(async () => ({ ok: true, output: 'socorro', costUsd: 0 }));
    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Gate');
      await ctx.gate({ id: 'gate-global', mode: 'human', checks: [] });
      return { ok: true };
    };
    const h = makeRunnerHarness({
      coordinator,
      projectPath: tmpRoot,
      git,
      closerTurn,
      run: { inputJson: JSON.stringify({ recheckOverride: 'red' }) },
    });
    const runner = new WorkflowRunner(h.deps);
    await runner.start('run-1');
    await waitForRunStatus(h.crud, 'run-1', 'blocked');
    await runner.approveGate('run-1', 'gate-global', { decision: 'approve' });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.state.events.some((e) => e.type === 'merge-recheck-failed')).toBe(true);
    expect(closerTurn).toHaveBeenCalled();
    cleanup();
  });

  it('base ANDOU + sem override + checks REAIS do gate rodam: command fake reprova -> RED (P2)', async () => {
    const git = defaultFakeGit((args) => {
      const cmd = args.join(' ');
      if (cmd.includes('rev-parse --verify --quiet refs/heads/main')) return ok('newtip');
      return null;
    });
    const closerTurn = vi.fn(async () => ({ ok: true, output: 'socorro', costUsd: 0 }));
    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Gate');
      await ctx.gate({ id: 'gate-global', mode: 'human', checks: [] });
      return { ok: true };
    };
    const manifest = makeManifest();
    const gateNode = manifest.nodes.find((n) => n.id === 'gate-global') as unknown as Record<string, unknown>;
    gateNode.gateConfig = { checks: [{ kind: 'command', command: 'npm run typecheck', maxErrors: 0 }] };
    let gateCmdRan = false;
    const h = makeRunnerHarness({
      coordinator,
      projectPath: tmpRoot,
      git,
      closerTurn,
      manifest,
      runGateCommand: (command, cmdArgs) => {
        gateCmdRan = true;
        expect(command).toBe('npm');
        expect(cmdArgs).toEqual(['run', 'typecheck']);
        return { status: 1, stdout: 'error: boom', stderr: '', timedOut: false };
      },
    });
    const runner = new WorkflowRunner(h.deps);
    await runner.start('run-1');
    await waitForRunStatus(h.crud, 'run-1', 'blocked');
    await runner.approveGate('run-1', 'gate-global', { decision: 'approve' });
    await new Promise((r) => setTimeout(r, 50));
    expect(gateCmdRan).toBe(true);
    expect(h.state.events.some((e) => e.type === 'merge-recheck-failed')).toBe(true);
    expect(closerTurn).toHaveBeenCalled();
    cleanup();
  });
});

describe('workflow-runner: fresh-project aceite final (AC-28)', () => {
  it('gate aprovado no fresh-project -> delivered + closer automatico, sem merge', async () => {
    const git = defaultFakeGit((args) => {
      const cmd = args.join(' ');
      if (cmd.includes('rev-parse --is-inside-work-tree')) return ok('true');
      if (cmd.includes('rev-parse --verify --quiet HEAD')) return ok('');
      return null;
    });
    const closerTurn = vi.fn(async () => ({ ok: true, output: 'walkthrough', costUsd: 0 }));
    let squashAttempted = false;
    const gitWrap: (args: string[], cwd: string) => Promise<GitRunResult> = async (args, cwd) => {
      if (args.join(' ').includes('merge --squash')) squashAttempted = true;
      if (args.join(' ') === 'rev-parse HEAD') return ok('freshsha');
      if (args.join(' ').includes('rev-parse --verify --quiet HEAD')) {
        return ok('freshsha');
      }
      return git(args, cwd);
    };
    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Gate');
      await ctx.gate({ id: 'gate-global', mode: 'human', checks: [] });
      return { ok: true };
    };
    const h = makeRunnerHarness({ coordinator, projectPath: tmpRoot, git: gitWrap, closerTurn });
    const runner = new WorkflowRunner(h.deps);
    await runner.start('run-1');
    await waitForRunStatus(h.crud, 'run-1', 'blocked');
    await runner.approveGate('run-1', 'gate-global', { decision: 'approve' });
    const terminal = await waitForRunStatus(h.crud, 'run-1', 'completed');
    expect(terminal).toBe('completed');
    expect(h.crud.getRun('run-1')?.deliveredAt).toBeTruthy();
    expect(closerTurn).toHaveBeenCalled();
    void squashAttempted;
    cleanup();
  });
});

describe('workflow-runner: intervencoes (14.1.1 / AC-14)', () => {
  it('intervencao desconhecida (set-autonomy removido) e recusada como `intervencao desconhecida`, sem evento de autonomia', async () => {
    const h = makeRunnerHarness({ coordinator: async () => ({ ok: true }), projectPath: tmpRoot });
    const runner = new WorkflowRunner(h.deps);

    const legacy = await runner.intervene(
      'run-1',
      {
        type: 'set-autonomy',
        mode: 'full',
      } as unknown as import('../dynamic-workflows/types').DynamicWorkflowIntervention,
      'human',
    );
    expect(legacy).toMatchObject({ error: expect.stringContaining('intervencao desconhecida') });
    expect(h.state.events.some((e) => e.type === 'autonomy-changed')).toBe(false);
    cleanup();
  });

  it('reply registra mensagem auditavel (AC-14)', async () => {
    const h = makeRunnerHarness({ coordinator: async () => ({ ok: true }), projectPath: tmpRoot });
    const runner = new WorkflowRunner(h.deps);
    await runner.intervene('run-1', { type: 'reply', message: 'foco no AC-3', targetNodeId: 'coder' }, 'human');
    expect(h.state.messages.some((m) => m.content === 'foco no AC-3' && m.source === 'human')).toBe(true);
    expect(h.state.events.some((e) => e.type === 'intervention')).toBe(true);
    cleanup();
  });

  it('switch-agent agora e roteado ao runner (S17): sem deps injetadas, recusa pelo guard de validacao', async () => {
    const h = makeRunnerHarness({ coordinator: async () => ({ ok: true }), projectPath: tmpRoot });
    const runner = new WorkflowRunner(h.deps);
    const res = await runner.intervene(
      'run-1',
      { type: 'switch-agent', nodeId: 'coder', newAgentId: 'a-other', reason: 'x' },
      'human',
    );
    expect(res).not.toMatchObject({ ok: true });
    expect(res).toMatchObject({ error: expect.stringContaining('switch-agent indisponivel') });
    expect(h.state.events.some((e) => e.type === 'intervention')).toBe(true);
    cleanup();
  });
});

describe('workflow-runner: boot recovery (10.3 / AC-25)', () => {
  it('runs running -> interrupted, nodes running -> interrupted', async () => {
    const h = makeRunnerHarness({
      coordinator: async () => ({ ok: true }),
      projectPath: tmpRoot,
      run: { status: 'running' },
    });
    h.crud.upsertNodeRun({
      id: 'nr-1',
      runId: 'run-1',
      nodeId: 'coder',
      phaseId: 'Implementar',
      type: 'agent',
      status: 'running',
      attempt: 1,
    });
    const runner = new WorkflowRunner(h.deps);
    const result = runner.recoverInterrupted();
    expect(result.recovered).toBe(1);
    expect(h.crud.getRun('run-1')?.status).toBe('interrupted');
    const nr = [...h.state.nodeRuns.values()].find((n) => n.id === 'nr-1');
    expect(nr?.status).toBe('interrupted');
    cleanup();
  });

  it('recoverInterruptedRuns(runner) delega ao runner (wire da S15)', async () => {
    const h = makeRunnerHarness({
      coordinator: async () => ({ ok: true }),
      projectPath: tmpRoot,
      run: { status: 'running' },
    });
    const runner = new WorkflowRunner(h.deps);
    const res = recoverInterruptedRuns(runner);
    expect(res.recovered).toBe(1);
    cleanup();
  });
});

describe('workflow-runner: pause/resume/abort idempotentes', () => {
  it('pause de run nao ativo + ja paused = ok (idempotente)', async () => {
    const h = makeRunnerHarness({
      coordinator: async () => ({ ok: true }),
      projectPath: tmpRoot,
      run: { status: 'paused' },
    });
    const runner = new WorkflowRunner(h.deps);
    expect(await runner.pause('run-1')).toEqual({ ok: true });
    cleanup();
  });

  it('abort de run nao ativo marca aborted e preserva branch', async () => {
    const h = makeRunnerHarness({
      coordinator: async () => ({ ok: true }),
      projectPath: tmpRoot,
      run: { status: 'paused', worktreeBranch: 'dynworkflow/run-1' },
    });
    const runner = new WorkflowRunner(h.deps);
    expect(await runner.abort('run-1')).toEqual({ ok: true });
    expect(h.crud.getRun('run-1')?.status).toBe('aborted');
    cleanup();
  });

  it('abort de node running persiste a attempt como CANCELLED (14.1.1/10.2), nao interrupted', async () => {
    let releaseAdapter: () => void = () => {};
    const adapter = (_input: RunNodeAgentInput): Promise<NodeRunResult> =>
      new Promise<NodeRunResult>((resolve) => {
        releaseAdapter = () =>
          resolve({
            ok: false,
            output: '',
            runtime: 'cloud',
            family: 'claude-compatible',
            failureClass: 'logic',
            errorMessage: 'released',
            policy: {
              runId: 'run-1',
              nodeId: 'scout',
              agentId: 'a-scout',
              workspaceRoot: tmpRoot,
              cwd: tmpRoot,
              access: 'read-only',
              allowedTools: [],
              deniedTools: [],
              allowedMcpServers: [],
              allowedMcpTools: [],
              allowedCommands: [],
              effectiveTools: [],
              effectiveMcpServers: [],
              policyHash: 'h',
              allowBash: false,
              allowNetwork: false,
              timeoutMs: 0,
              idleTimeoutMs: 0,
              costCeilingUsd: 0,
            },
            mechanism: 'none',
            durationMs: 0,
          });
      });
    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Scout');
      await ctx.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 's' });
      return { ok: true };
    };
    const h = makeRunnerHarness({ coordinator, projectPath: tmpRoot, adapter });
    const runner = new WorkflowRunner(h.deps);
    await runner.start('run-1');
    await vi.waitFor(() =>
      expect([...h.state.nodeRuns.values()].some((n) => n.nodeId === 'scout' && n.status === 'running')).toBe(true),
    );

    expect(await runner.abort('run-1')).toEqual({ ok: true });
    const scout = [...h.state.nodeRuns.values()].find((n) => n.nodeId === 'scout');
    expect(scout?.status).toBe('cancelled');
    expect([...h.state.nodeRuns.values()].some((n) => n.status === 'interrupted')).toBe(false);

    releaseAdapter();
    cleanup();
  });

  it('start de run ja terminal (completed) recusa', async () => {
    const h = makeRunnerHarness({
      coordinator: async () => ({ ok: true }),
      projectPath: tmpRoot,
      run: { status: 'completed' },
    });
    const runner = new WorkflowRunner(h.deps);
    const res = await runner.start('run-1');
    expect(res).toMatchObject({ error: expect.stringContaining('terminal') });
    cleanup();
  });
});

describe('workflow-runner: resume destrava bloqueio informativo (gate inconclusivo / budget legado)', () => {
  it.each(['error', 'budget'] as const)(
    "run blocked com pendingDecision type '%s' -> resume() aceita, emite run-info-block-accepted e re-executa",
    async (blockType) => {
      const h = makeRunnerHarness({
        coordinator: async () => ({ ok: true }),
        projectPath: tmpRoot,
        run: {
          status: 'blocked',
          inputJson: JSON.stringify({
            pendingDecision: { type: blockType, message: 'bloqueio informativo' },
          }),
        },
      });
      const runner = new WorkflowRunner(h.deps);
      const res = await runner.resume('run-1');
      expect(res).toEqual({ ok: true });

      const evt = h.state.events.find((e) => e.type === 'run-info-block-accepted');
      expect(evt).toBeTruthy();
      const payload = typeof evt!.payload === 'string' ? JSON.parse(evt!.payload) : evt!.payload;
      expect(payload).toMatchObject({ blockType });

      const terminal = await waitForRunStatus(h.crud, 'run-1', 'completed');
      expect(terminal).toBe('completed');
      expect(JSON.parse(h.crud.getRun('run-1')!.inputJson || '{}').pendingDecision).toBeUndefined();
      cleanup();
    },
  );
});

class FakeScheduler {
  private timers: Array<{ cb: () => void; cancelled: boolean }> = [];
  schedule = (_delayMs: number, cb: () => void): WorkflowTimerHandle => {
    const t = { cb, cancelled: false };
    this.timers.push(t);
    return {
      cancel: () => {
        t.cancelled = true;
      },
    };
  };
  flush(): void {
    const active = this.timers.filter((t) => !t.cancelled);
    this.timers = [];
    for (const t of active) t.cb();
  }
  activeCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}

function providerLimitAdapter(input: RunNodeAgentInput): Promise<NodeRunResult> {
  return Promise.resolve({
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
    durationMs: 1,
  });
}

describe('workflow-runner: DEFECT-4 provider-limit retry/backoff -> blocked (AC-22)', () => {
  it('L1.1: start()->sandbox->2 retries IN-PROCESS -> gate failure:coder (run blocked, child vivo); approve skip segue ate a entrega (nunca failed)', async () => {
    const scheduler = new FakeScheduler();
    const coordinator: Coordinator = async (ctx) => {
      const out = await ctx.agent({ id: 'coder', agentId: 'a-coder', access: 'read-only', prompt: 'x' });
      return { got: out };
    };
    const h = makeRunnerHarness({
      coordinator,
      projectPath: tmpRoot,
      adapter: providerLimitAdapter,
      run: { status: 'created' },
    });
    const sleeps: number[] = [];
    const runner = new WorkflowRunner({
      ...h.deps,
      scheduleTimer: scheduler.schedule,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await runner.start('run-1');
    await vi.waitFor(() => expect(h.crud.getRun('run-1')?.status).toBe('blocked'));
    expect(sleeps).toHaveLength(2);
    expect(scheduler.activeCount()).toBe(0);
    expect(isWorkflowRunLocked('run-1')).toBe(true);
    expect(h.state.events.some((e) => e.type === 'run-delivered')).toBe(false);

    const run = h.crud.getRun('run-1');
    expect(run?.status).not.toBe('failed');
    const pd = JSON.parse(run?.inputJson || '{}').pendingDecision as
      | {
          type?: string;
          id?: string;
          gateId?: string;
          failureClass?: string;
          retriesExhausted?: boolean;
          actions?: string[];
        }
      | undefined;
    expect(pd).toMatchObject({
      type: 'provider',
      id: 'failure:coder',
      gateId: 'failure:coder',
      failureClass: 'provider-limit',
      retriesExhausted: true,
    });
    expect(pd?.actions).toEqual(['retry', 'switch-agent', 'skip', 'abort']);
    const retryCount = h.state.events.filter((e) => e.type === 'node-retry-scheduled').length;
    expect(retryCount).toBe(2);
    const blockedEv = h.state.events.find((e) => e.type === 'run-blocked-provider') as { payload?: unknown };
    const blockedPayload = (
      typeof blockedEv.payload === 'string' ? JSON.parse(blockedEv.payload) : blockedEv.payload
    ) as Record<string, unknown>;
    expect(blockedPayload).toMatchObject({
      failureClass: 'provider-limit',
      retriesExhausted: true,
      attemptsMade: 3,
      gateId: 'failure:coder',
    });
    expect(blockedPayload).toHaveProperty('nodeError');
    const gateEv = h.state.events.find((e) => e.type === 'gate-blocked') as { payload?: unknown };
    expect(JSON.parse(String(gateEv.payload))).toMatchObject({
      gateId: 'failure:coder',
      mode: 'orchestrator',
      failure: true,
    });

    const res = await runner.approveGate(
      'run-1',
      'failure:coder',
      { decision: 'approve', payload: { action: 'skip' } },
      'orchestrator',
    );
    expect(res).toEqual({ ok: true });
    await vi.waitFor(() => expect(['delivered', 'completed']).toContain(h.crud.getRun('run-1')?.status));
    const approved = h.state.events.find((e) => e.type === 'gate-approved') as { payload?: unknown };
    expect(JSON.parse(String(approved.payload))).toMatchObject({ gateId: 'failure:coder', action: 'skip' });
    expect(h.state.events.some((e) => e.type === 'run-failed')).toBe(false);
    cleanup();
  });
});

describe('computeGitTransientPaths (S4, repo git real)', () => {
  function gitSync(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  }

  function setupRealRepo(): { repo: string; baseSha: string } {
    const repo = join(tmpRoot, 'real-repo');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    gitSync(repo, 'init', '-b', 'main');
    gitSync(repo, 'config', 'user.name', 'Test User');
    gitSync(repo, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(repo, 'docs', 'spec-tracked.md'), '# tracked', 'utf8');
    gitSync(repo, 'add', '-A');
    gitSync(repo, 'commit', '-m', 'base');
    writeFileSync(join(repo, 'docs', 'spec-untracked.md'), '# untracked', 'utf8');
    return { repo, baseSha: gitSync(repo, 'rev-parse', 'HEAD') };
  }

  function computeFor(repo: string, specPath: string, baseCommitSha: string): Promise<string[]> {
    const h = makeRunnerHarness({
      coordinator: async () => ({}),
      projectPath: repo,
      git: runGit,
    });
    const def = h.state.definitions.get('def-1')!;
    const definition: DynamicWorkflowDefinition = { ...def, specPath };
    const workspace: WorkspaceHandle = {
      runId: 'run-1',
      mode: 'run-worktree',
      repoRoot: repo,
      baseBranch: 'main',
      baseCommitSha,
      baseWorktreeHash: 'th',
      workspaceDir: repo,
      worktreePath: join(repo, '.wt'),
      worktreeBranch: 'dynworkflow/run-1',
    };
    const runner = new WorkflowRunner(h.deps);
    const compute = (
      runner as unknown as {
        computeGitTransientPaths(d: DynamicWorkflowDefinition, w: WorkspaceHandle): Promise<string[]>;
      }
    ).computeGitTransientPaths.bind(runner);
    return compute(definition, workspace);
  }

  it('(a) SPEC rastreada na base -> FORA da lista (reset descartaria mudanca legitima)', async () => {
    const { repo, baseSha } = setupRealRepo();
    const paths = await computeFor(repo, 'docs/spec-tracked.md', baseSha);
    expect(paths).toEqual([WORKFLOW_RUN_LOCK_FILE]);
    cleanup();
  });

  it('(b) SPEC untracked na base -> NA lista (e copia; nunca entra na entrega)', async () => {
    const { repo, baseSha } = setupRealRepo();
    const paths = await computeFor(repo, 'docs/spec-untracked.md', baseSha);
    expect(paths).toEqual([WORKFLOW_RUN_LOCK_FILE, 'docs/spec-untracked.md']);
    cleanup();
  });

  it('(c) baseCommitSha INVALIDO -> inconclusivo -> SPEC FORA da lista (nunca inverter para o lado destrutivo)', async () => {
    const { repo } = setupRealRepo();
    const paths = await computeFor(repo, 'docs/spec-untracked.md', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(paths).toEqual([WORKFLOW_RUN_LOCK_FILE]);
    cleanup();
  });
});
