
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WorkflowRunner,
  isWorkflowRunLocked,
  _resetRunLocksForTesting,
  type WorkflowRunnerDeps,
  type WorkflowRunnerCrud,
} from '../dynamic-workflows/workflow-runner';
import type {
  SandboxProcessFactory,
  SandboxProcessHandle,
} from '../dynamic-workflows/workflow-sandbox';
import type {
  SandboxParentMessage,
  SandboxChildMessage,
} from '../dynamic-workflows/sandbox-protocol';
import type {
  DynamicWorkflowRun,
  DynamicWorkflowDefinition,
  DynamicWorkflowManifest,
  DynamicWorkflowNodeRun,
  DynamicWorkflowGateDecisionInsertInput,
  DynamicWorkflowMessageInsertInput,
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
                sendToParent({
                  t: 'fatal',
                  message: err instanceof Error ? err.message : String(err),
                });
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
  };
}

const NOW = '2026-06-15T12:00:00.000Z';

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

function makeManifest(): DynamicWorkflowManifest {
  return {
    version: 1,
    name: 'sm34-wf',
    phases: [{ id: 'Fase', name: 'Fase', order: 0 }],
    nodes: [
      {
        id: 'coder',
        type: 'agent',
        phaseId: 'Fase',
        agentId: 'a-coder',
        access: 'workspace-write',
        writeSet: ['src/**'],
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

function writeWorkflowJs(dir: string): string {
  const src = [
    "export const meta = { name: 'sm34-wf', description: 'sm34 pause test wf', phases: ['Fase'] };",
    "await phase('Fase');",
    "await agent({ id: 'coder', agentId: 'a-coder', access: 'workspace-write', prompt: 'code' });",
    'return { ok: true };',
  ].join('\n');
  const path = join(dir, 'workflow.js');
  writeFileSync(path, src, 'utf8');
  return path;
}

function defaultFakeGit(): (args: string[], cwd: string) => Promise<GitRunResult> {
  return async (args) => {
    const cmd = args.join(' ');
    if (cmd.includes('rev-parse --is-inside-work-tree')) return { code: 0, stdout: 'true', stderr: '' };
    if (cmd.includes('rev-parse --verify --quiet HEAD')) return { code: 0, stdout: 'basesha', stderr: '' };
    if (cmd === 'rev-parse HEAD') return { code: 0, stdout: 'basesha', stderr: '' };
    if (cmd.includes('rev-parse --abbrev-ref HEAD')) return { code: 0, stdout: 'main', stderr: '' };
    if (cmd.includes('^{tree}')) return { code: 0, stdout: 'treehash', stderr: '' };
    if (cmd.includes('diff --cached --name-only')) return { code: 0, stdout: 'src/x.ts', stderr: '' };
    if (cmd.startsWith('rev-list --count')) return { code: 0, stdout: '1', stderr: '' };
    if (cmd.includes('diff --cached --quiet')) return { code: 1, stdout: '', stderr: '' };
    if (cmd.includes('diff --name-only')) return { code: 0, stdout: 'src/x.ts', stderr: '' };
    if (cmd.includes('diff-tree')) return { code: 0, stdout: 'src/x.ts', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
}

function makeHarness(opts: {
  coordinator: Coordinator;
  projectPath: string;
  adapter?: (input: RunNodeAgentInput) => Promise<NodeRunResult>;
  run?: Partial<DynamicWorkflowRun>;
}): Harness {
  const workflowJsPath = writeWorkflowJs(opts.projectPath);
  const definition: DynamicWorkflowDefinition = {
    id: 'def-1',
    name: 'sm34-wf',
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
    manifestJson: JSON.stringify(makeManifest()),
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
    listNodeRuns: (runId) =>
      [...new Set([...state.nodeRuns.values()])].filter((n) => n.runId === runId),
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
          createdAt: NOW,
        })),
    costAggregate: (runId) => ({
      runId,
      totalCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalDurationMs: 0,
      nodeRunCount: 0,
      unknownCostNodeRuns: 0,
    }),
  };
  const effectiveAdapter = opts.adapter;
  const deps: WorkflowRunnerDeps = {
    crud,
    sandboxFactory: makeFakeSandboxFactory(opts.coordinator),
    git: defaultFakeGit(),
    emitIPC: () => {},
    now: () => NOW,
    runNodeAgent: effectiveAdapter
      ? (effectiveAdapter as WorkflowRunnerDeps['runNodeAgent'])
      : undefined,
  };
  return { deps, crud, state };
}


let tmpRoot: string;

beforeEach(() => {
  _resetRunLocksForTesting();
  tmpRoot = mkdtempSync(join(tmpdir(), 'dwf-sm34-'));
  mkdirSync(join(tmpRoot, 'src'), { recursive: true });
});

afterEach(() => {
  _resetRunLocksForTesting();
  rmSync(tmpRoot, { recursive: true, force: true });
});


describe('SM-34: pause sinaliza o AbortController do no corrente', () => {
  it('pause() sinaliza o abort do AbortController antes do no encerrar', async () => {
    let signalAbortedAtDispatch = false;
    let releaseAdapter: (r: NodeRunResult) => void = () => {};
    const adapter = (input: RunNodeAgentInput): Promise<NodeRunResult> => {
      const signal = input.abortSignal;
      return new Promise<NodeRunResult>((resolve) => {
        if (signal) {
          if (signal.aborted) {
            signalAbortedAtDispatch = true;
          } else {
            signal.addEventListener('abort', () => {
              signalAbortedAtDispatch = true;
            }, { once: true });
          }
        }
        releaseAdapter = resolve;
      });
    };

    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Fase');
      await ctx.agent({ id: 'coder', agentId: 'a-coder', access: 'workspace-write', prompt: 'code' });
      return { ok: true };
    };

    const h = makeHarness({ coordinator, projectPath: tmpRoot, adapter });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    await vi.waitFor(() =>
      expect(
        [...h.state.nodeRuns.values()].some(
          (n) => n.nodeId === 'coder' && n.status === 'running',
        ),
      ).toBe(true),
    );

    const pauseResult = await runner.pause('run-1');
    expect(pauseResult).toEqual({ ok: true });

    expect(signalAbortedAtDispatch).toBe(true);

    releaseAdapter({
      ok: false,
      output: '',
      runtime: 'cloud',
      family: 'claude-compatible',
      failureClass: 'logic',
      errorMessage: 'abortado pelo pause',
      policy: {
        runId: 'run-1',
        nodeId: 'coder',
        agentId: 'a-coder',
        workspaceRoot: tmpRoot,
        cwd: tmpRoot,
        access: 'workspace-write',
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

  it('run transiciona para paused (nao aborted) e emite run-paused', async () => {
    let releaseAdapter: (r: NodeRunResult) => void = () => {};
    const adapter = (_input: RunNodeAgentInput): Promise<NodeRunResult> =>
      new Promise<NodeRunResult>((resolve) => {
        releaseAdapter = resolve;
      });

    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Fase');
      await ctx.agent({ id: 'coder', agentId: 'a-coder', access: 'workspace-write', prompt: 'code' });
      return { ok: true };
    };

    const h = makeHarness({ coordinator, projectPath: tmpRoot, adapter });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    await vi.waitFor(() =>
      expect(
        [...h.state.nodeRuns.values()].some(
          (n) => n.nodeId === 'coder' && n.status === 'running',
        ),
      ).toBe(true),
    );

    await runner.pause('run-1');

    releaseAdapter({
      ok: false,
      output: '',
      runtime: 'cloud',
      family: 'claude-compatible',
      failureClass: 'logic',
      errorMessage: 'no interrompido pelo pause',
      policy: {
        runId: 'run-1',
        nodeId: 'coder',
        agentId: 'a-coder',
        workspaceRoot: tmpRoot,
        cwd: tmpRoot,
        access: 'workspace-write',
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

    await vi.waitFor(() =>
      expect(h.crud.getRun('run-1')?.status).toBe('paused'),
    );

    expect(h.state.events.some((e) => e.type === 'run-paused')).toBe(true);
    expect(h.state.events.some((e) => e.type === 'run-aborted')).toBe(false);
  });

  it('a attempt do no corrente vira interrupted (nao cancelled) na pausa (14.1.1)', async () => {
    let releaseAdapter: (r: NodeRunResult) => void = () => {};
    const adapter = (_input: RunNodeAgentInput): Promise<NodeRunResult> =>
      new Promise<NodeRunResult>((resolve) => {
        releaseAdapter = resolve;
      });

    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Fase');
      await ctx.agent({ id: 'coder', agentId: 'a-coder', access: 'workspace-write', prompt: 'code' });
      return { ok: true };
    };

    const h = makeHarness({ coordinator, projectPath: tmpRoot, adapter });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    await vi.waitFor(() =>
      expect(
        [...h.state.nodeRuns.values()].some(
          (n) => n.nodeId === 'coder' && n.status === 'running',
        ),
      ).toBe(true),
    );

    await runner.pause('run-1');

    releaseAdapter({
      ok: false,
      output: '',
      runtime: 'cloud',
      family: 'claude-compatible',
      failureClass: 'logic',
      errorMessage: 'interrompido',
      policy: {
        runId: 'run-1',
        nodeId: 'coder',
        agentId: 'a-coder',
        workspaceRoot: tmpRoot,
        cwd: tmpRoot,
        access: 'workspace-write',
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

    await vi.waitFor(() =>
      expect(h.crud.getRun('run-1')?.status).toBe('paused'),
    );

    const coder = [...h.state.nodeRuns.values()].find((n) => n.nodeId === 'coder');
    expect(['failed', 'interrupted']).toContain(coder?.status);
    expect([...h.state.nodeRuns.values()].some((n) => n.status === 'cancelled')).toBe(false);
  });

  it('lock e liberado apos a pausa (resume pode re-adquirir)', async () => {
    let releaseAdapter: (r: NodeRunResult) => void = () => {};
    const adapter = (_input: RunNodeAgentInput): Promise<NodeRunResult> =>
      new Promise<NodeRunResult>((resolve) => {
        releaseAdapter = resolve;
      });

    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Fase');
      await ctx.agent({ id: 'coder', agentId: 'a-coder', access: 'workspace-write', prompt: 'code' });
      return { ok: true };
    };

    const h = makeHarness({ coordinator, projectPath: tmpRoot, adapter });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    await vi.waitFor(() =>
      expect(
        [...h.state.nodeRuns.values()].some(
          (n) => n.nodeId === 'coder' && n.status === 'running',
        ),
      ).toBe(true),
    );

    expect(isWorkflowRunLocked('run-1')).toBe(true);

    await runner.pause('run-1');

    releaseAdapter({
      ok: false,
      output: '',
      runtime: 'cloud',
      family: 'claude-compatible',
      failureClass: 'logic',
      errorMessage: 'interrompido',
      policy: {
        runId: 'run-1',
        nodeId: 'coder',
        agentId: 'a-coder',
        workspaceRoot: tmpRoot,
        cwd: tmpRoot,
        access: 'workspace-write',
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

    await vi.waitFor(() =>
      expect(h.crud.getRun('run-1')?.status).toBe('paused'),
    );
    expect(isWorkflowRunLocked('run-1')).toBe(false);
  });

  it('pause de run ja paused e idempotente (ok sem erro)', async () => {
    const h = makeHarness({
      coordinator: async () => ({ ok: true }),
      projectPath: tmpRoot,
      run: { status: 'paused' },
    });
    const runner = new WorkflowRunner(h.deps);
    const result = await runner.pause('run-1');
    expect(result).toEqual({ ok: true });
  });

  it('pause nao perde o checkpoint existente (REGRA MAXIMA)', async () => {
    const checkpoint = JSON.stringify({ nodes: { 'prev-node': { worktreeCommitSha: 'abc123', savedAt: NOW } } });
    let releaseAdapter: (r: NodeRunResult) => void = () => {};
    const adapter = (_input: RunNodeAgentInput): Promise<NodeRunResult> =>
      new Promise<NodeRunResult>((resolve) => {
        releaseAdapter = resolve;
      });

    const coordinator: Coordinator = async (ctx) => {
      await ctx.phase('Fase');
      await ctx.agent({ id: 'coder', agentId: 'a-coder', access: 'workspace-write', prompt: 'code' });
      return { ok: true };
    };

    const h = makeHarness({
      coordinator,
      projectPath: tmpRoot,
      adapter,
      run: { checkpointJson: checkpoint },
    });
    const runner = new WorkflowRunner(h.deps);

    await runner.start('run-1');
    await vi.waitFor(() =>
      expect(
        [...h.state.nodeRuns.values()].some(
          (n) => n.nodeId === 'coder' && n.status === 'running',
        ),
      ).toBe(true),
    );

    await runner.pause('run-1');
    releaseAdapter({
      ok: false,
      output: '',
      runtime: 'cloud',
      family: 'claude-compatible',
      failureClass: 'logic',
      errorMessage: 'interrompido',
      policy: {
        runId: 'run-1',
        nodeId: 'coder',
        agentId: 'a-coder',
        workspaceRoot: tmpRoot,
        cwd: tmpRoot,
        access: 'workspace-write',
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

    await vi.waitFor(() =>
      expect(h.crud.getRun('run-1')?.status).toBe('paused'),
    );

    const run = h.crud.getRun('run-1');
    const ckpt = JSON.parse(run?.checkpointJson ?? '{}') as { nodes?: Record<string, unknown> };
    expect(ckpt.nodes?.['prev-node']).toBeDefined();
  });
});
