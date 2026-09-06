
import { describe, it, expect, beforeEach, vi } from 'vitest';

const realKimiBackendState = vi.hoisted(() => ({
  config: {
    model: 'kimi-code/kimi-for-coding',
    systemPrompt: 'sp',
    allowedTools: [],
    mcpServers: [],
    maxTurns: undefined,
    effort: 'low' as const,
    thinking: 'adaptive' as const,
    thinkingBudget: undefined,
    runtime: 'kimi' as const,
  },
  run: vi.fn(),
}));

vi.mock('../db', () => ({
  getDynamicWorkflowRun: vi.fn(() => null),
  getDynamicWorkflowDefinition: vi.fn(() => null),
  listDynamicWorkflowRunsByStatus: vi.fn(() => []),
  setDynamicWorkflowRunStatus: vi.fn(),
  updateDynamicWorkflowRun: vi.fn(),
  upsertDynamicWorkflowNodeRun: vi.fn(),
  updateDynamicWorkflowNodeRun: vi.fn(),
  listDynamicWorkflowNodeRuns: vi.fn(() => []),
  insertDynamicWorkflowEvent: vi.fn(() => ({})),
  listDynamicWorkflowRecentEvents: vi.fn(() => []),
  insertDynamicWorkflowGateDecision: vi.fn(() => ({})),
  insertDynamicWorkflowArtifact: vi.fn(() => ({})),
  insertDynamicWorkflowMessage: vi.fn(() => ({})),
  listDynamicWorkflowMessages: vi.fn(() => []),
  getDynamicWorkflowRunCostAggregate: vi.fn(() => ({})),
  repointDynamicWorkflowRunDefinition: vi.fn(),
  getSetting: (...args: unknown[]) => getSettingD11Mock(...(args as [string])),
  claimAdjustmentsForNode: vi.fn(() => []),
  getConsumedAdjustmentsForNode: vi.fn(() => []),
}));

const getSettingD11Mock = vi.hoisted(() => vi.fn((_key: string): string | undefined => undefined));

vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: vi.fn() }));
vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: vi.fn(async () => realKimiBackendState.config),
}));
vi.mock('../agent-runtime/kimi-executor', () => ({
  kimiExecutor: { run: realKimiBackendState.run },
}));

import {
  WorkflowRunner,
  getWorkflowRunner,
  _resetWorkflowRunnerForTesting,
  _resetRunLocksForTesting,
  type WorkflowRunnerDeps,
  type WorkflowRunnerCrud,
} from '../dynamic-workflows/workflow-runner';
import {
  createDefaultRunnerDeps,
  makeRealClaudeCompatBackend,
  realKimiBackend,
  parseWallTimeoutSetting,
  resolveWallTimeoutMsFromSetting,
  DYNAMIC_WORKFLOW_WALL_TIMEOUT_SETTING_KEY,
} from '../dynamic-workflows/workflow-runner-deps';
import {
  getDynamicWorkflowRun as getRunDbMock,
  getDynamicWorkflowDefinition as getDefinitionDbMock,
} from '../db';
import { runDirFor as runDirForD14 } from '../dynamic-workflows/workflow-create';
import { readFileSync as readFileSyncD14, existsSync as existsSyncD14 } from 'node:fs';
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
} from '../dynamic-workflows/types';
import type { GitRunResult } from '../dynamic-workflows/workflow-git';
import type {
  CloserTurnResult,
  CloserAgentTurnRunner,
} from '../dynamic-workflows/workflow-closer';
import type { NodeRunResult, RunNodeAgentInput } from '../dynamic-workflows/workflow-agent-adapter';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


interface CoordinatorCtx {
  phase: (name: string) => Promise<unknown>;
  agent: (arg: unknown) => Promise<unknown>;
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


interface FakeState {
  runs: Map<string, DynamicWorkflowRun>;
  definitions: Map<string, DynamicWorkflowDefinition>;
  nodeRuns: Map<string, DynamicWorkflowNodeRun>;
  events: Array<{ type: string; runId: string }>;
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
    phases: [{ id: 'Gate', name: 'Gate', order: 0 }],
    nodes: [{ id: 'gate-global', type: 'gate', phaseId: 'Gate', canResume: false, produces: [], consumes: [] }],
    parallelism: { maxConcurrentAgents: 1, parallelWritersAllowed: false },
    gates: [{ id: 'gate-global', mode: 'human', blocks: ['delivery'] }],
    estimate: { minUsd: 0, maxUsd: 0, unknownCostNodes: [] },
  };
}

function writeWorkflowJs(dir: string): string {
  const src = [
    "export const meta = { name: 'test-wf', description: 'runner-deps test wf', phases: ['Gate'] };",
    "await phase('Gate');",
    'return { ok: true };',
  ].join('\n');
  const path = join(dir, 'workflow.js');
  writeFileSync(path, src, 'utf8');
  return path;
}

function makeFakeCrud(projectPath: string): { crud: WorkflowRunnerCrud; state: FakeState } {
  const workflowJsPath = writeWorkflowJs(projectPath);
  const definition: DynamicWorkflowDefinition = {
    id: 'def-1',
    name: 'test-wf',
    definitionVersion: 1,
    authoringModel: 'manifest',
    parentDefinitionId: null,
    supersedesDefinitionId: null,
    sourceType: 'builder',
    projectPath,
    specPath: null,
    specSha256: null,
    workflowJsPath,
    manifestPath: join(projectPath, 'workflow.manifest.json'),
    manifestJson: JSON.stringify(makeManifest()),
    manifestHash: 'mh',
    contextBundlePath: null,
    builderModel: null,
    status: 'validated',
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
  };
  const state: FakeState = {
    runs: new Map([['run-1', makeRun()]]),
    definitions: new Map([['def-1', definition]]),
    nodeRuns: new Map(),
    events: [],
  };
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
      state.nodeRuns.set(input.id, nr);
      return nr;
    },
    updateNodeRun: (id, patch) => {
      const nr = state.nodeRuns.get(id);
      if (nr) Object.assign(nr, patch);
    },
    listNodeRuns: (runId) => [...state.nodeRuns.values()].filter((n) => n.runId === runId),
    insertEvent: (input) => {
      const id = state.events.length + 1;
      state.events.push({ type: input.type, runId: input.runId });
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
    insertGateDecision: (input) => ({
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
    }),
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
    insertMessage: (input) => ({
      id: 1,
      runId: input.runId,
      nodeId: input.nodeId ?? null,
      role: input.role,
      source: input.source,
      kind: input.kind,
      content: input.content,
      toolCallsJson: input.toolCallsJson ?? null,
      agentId: input.agentId ?? null,
      createdAt: '2026-06-12T00:00:00.000Z',
    }),
    listMessages: () => [],
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
  return { crud, state };
}

function fakeGit(): (args: string[], cwd: string) => Promise<GitRunResult> {
  return async (args) => {
    const cmd = args.join(' ');
    if (cmd.includes('rev-parse --is-inside-work-tree')) return ok('true');
    if (cmd.includes('rev-parse --verify --quiet HEAD')) return ok('basesha');
    if (cmd === 'rev-parse HEAD') return ok('basesha');
    if (cmd.includes('rev-parse --abbrev-ref HEAD')) return ok('main');
    if (cmd.includes('^{tree}')) return ok('treehash');
    if (cmd.includes('rev-parse --verify --quiet refs/heads/')) return ok('basesha');
    return ok('');
  };
}
function ok(stdout: string): GitRunResult {
  return { code: 0, stdout, stderr: '' };
}

function fakeAdapter(): (input: RunNodeAgentInput) => Promise<NodeRunResult> {
  return (input) =>
    Promise.resolve({
      ok: true,
      output: '{}',
      runtime: 'cloud',
      family: 'claude-compatible',
      cost: {
        costUsd: 0,
        costStatus: 'known',
        tokenStatus: null,
        costUnknownReason: null,
        inputTokens: 0,
        outputTokens: 0,
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
        policyHash: 'h',
        allowBash: false,
        allowNetwork: false,
        timeoutMs: 1000,
        idleTimeoutMs: 1000,
        costCeilingUsd: 0,
      },
      mechanism: 'canUseTool',
      durationMs: 1,
    } as NodeRunResult);
}

const gateCoordinator: Coordinator = async (ctx) => {
  await ctx.phase('Gate');
  const decision = await ctx.gate({ id: 'gate-global', mode: 'human', checks: [] });
  return { ok: (decision as { ok: boolean }).ok };
};

async function waitForStatus(
  crud: WorkflowRunnerCrud,
  runId: string,
  target: string,
  timeoutMs = 2000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = crud.getRun(runId)?.status;
    if (status === target) return status;
    await new Promise((r) => setTimeout(r, 5));
  }
  return crud.getRun(runId)?.status ?? 'unknown';
}


let tmpRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  _resetWorkflowRunnerForTesting();
  _resetRunLocksForTesting();
  tmpRoot = mkdtempSync(join(tmpdir(), 'dwf-deps-'));
  mkdirSync(join(tmpRoot, 'src'), { recursive: true });
});

function cleanup(): void {
  rmSync(tmpRoot, { recursive: true, force: true });
}

function withFakes(
  base: WorkflowRunnerDeps,
  coordinator: Coordinator,
): WorkflowRunnerDeps {
  return {
    ...base,
    sandboxFactory: makeFakeSandboxFactory(coordinator),
    git: fakeGit(),
    now: () => '2026-06-12T00:00:00.000Z',
    runNodeAgent: fakeAdapter() as WorkflowRunnerDeps['runNodeAgent'],
    loadActiveAgentIds: () => [],
  };
}


describe('SPEC orquestrador-driver D14: events.jsonl ligado por default', () => {
  it('createDefaultRunnerDeps() seta appendJsonl e grava logs/events.jsonl no run dir resolvido por run', () => {
    const { crud } = makeFakeCrud(tmpRoot);
    const deps = createDefaultRunnerDeps({ crud, emitIPC: () => {} });
    expect(typeof deps.appendJsonl).toBe('function');

    vi.mocked(getRunDbMock).mockReturnValueOnce({ id: 'run-1', definitionId: 'def-1' } as never);
    vi.mocked(getDefinitionDbMock).mockReturnValueOnce({ id: 'def-1', projectPath: tmpRoot } as never);
    deps.appendJsonl!('run-1', '{"seq":1,"type":"run-started"}');
    const file = join(runDirForD14(tmpRoot, 'run-1'), 'logs', 'events.jsonl');
    expect(existsSyncD14(file)).toBe(true);
    expect(readFileSyncD14(file, 'utf8')).toBe('{"seq":1,"type":"run-started"}\n');

    vi.mocked(getRunDbMock).mockReturnValueOnce({ id: 'run-1', definitionId: 'def-1' } as never);
    vi.mocked(getDefinitionDbMock).mockReturnValueOnce({ id: 'def-1', projectPath: tmpRoot } as never);
    deps.appendJsonl!('run-1', '{"seq":2}');
    expect(readFileSyncD14(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    cleanup();
  });

  it('best-effort: run inexistente nao lanca; override de teste vence o default', () => {
    const { crud } = makeFakeCrud(tmpRoot);
    const deps = createDefaultRunnerDeps({ crud, emitIPC: () => {} });
    vi.mocked(getRunDbMock).mockReturnValueOnce(null as never);
    expect(() => deps.appendJsonl!('run-x', '{}')).not.toThrow();

    const spy = vi.fn();
    const overridden = createDefaultRunnerDeps({ crud, emitIPC: () => {}, appendJsonl: spy });
    expect(overridden.appendJsonl).toBe(spy);
    cleanup();
  });
});

describe('DEFECT-3: fabrica unica de deps do runner sempre carrega o closer', () => {
  it('createDefaultRunnerDeps() SEMPRE retorna closerDeps.runAgentTurn definido', () => {
    const { crud } = makeFakeCrud(tmpRoot);
    const deps = createDefaultRunnerDeps({ crud, emitIPC: () => {} });
    expect(deps.closerDeps).toBeDefined();
    expect(typeof deps.closerDeps?.runAgentTurn).toBe('function');
    cleanup();
  });

  it('Inc2: createDefaultRunnerDeps() liga o narrador do cockpit por default (narrate + emit)', () => {
    const { crud } = makeFakeCrud(tmpRoot);
    const deps = createDefaultRunnerDeps({ crud, emitIPC: () => {} });
    expect(deps.narratorDeps).toBeDefined();
    expect(typeof deps.narratorDeps?.narrate).toBe('function');
    expect(typeof deps.narratorDeps?.emit).toBe('function');
    cleanup();
  });

  it('GREEN: runner construido pelo caminho do BOOT (fabrica) ABRE o closer em delivered (R4-F2/AC-28)', async () => {
    const { crud, state } = makeFakeCrud(tmpRoot);
    const closerTurn: ReturnType<typeof vi.fn<CloserAgentTurnRunner>> = vi.fn<CloserAgentTurnRunner>(
      async (): Promise<CloserTurnResult> => ({ ok: true, output: 'walkthrough da entrega', costUsd: 0 }),
    );
    const bootDeps = withFakes(
      createDefaultRunnerDeps({
        crud,
        emitIPC: () => {},
        closerRunAgentTurn: closerTurn,
      }),
      gateCoordinator,
    );
    const runner = getWorkflowRunner(bootDeps);

    await runner.start('run-1');
    const blocked = await waitForStatus(crud, 'run-1', 'blocked');
    expect(blocked).toBe('blocked');

    await runner.approveGate('run-1', 'gate-global', { decision: 'approve' });
    const terminal = await waitForStatus(crud, 'run-1', 'completed');
    expect(terminal).toBe('completed');
    expect(closerTurn).toHaveBeenCalled();
    expect(state.events.some((e) => e.type === 'closer-auto-opened')).toBe(true);
    expect(crud.getRun('run-1')?.closerStatus).toBe('closed');
    expect(state.events.some((e) => e.type === 'workflow-finalized')).toBe(true);
    cleanup();
  });

  it('GREEN: o caminho do IPC reusa a MESMA fabrica - tambem nasce com closer', async () => {
    const { crud } = makeFakeCrud(tmpRoot);
    const closerTurn: ReturnType<typeof vi.fn<CloserAgentTurnRunner>> = vi.fn<CloserAgentTurnRunner>(
      async (): Promise<CloserTurnResult> => ({ ok: true, output: 'ok', costUsd: 0 }),
    );
    const ipcDeps = withFakes(
      createDefaultRunnerDeps({
        crud,
        emitIPC: () => {},
        closerRunAgentTurn: closerTurn,
      }),
      gateCoordinator,
    );
    const runner = getWorkflowRunner(ipcDeps);
    await runner.start('run-1');
    await waitForStatus(crud, 'run-1', 'blocked');
    await runner.approveGate('run-1', 'gate-global', { decision: 'approve' });
    expect(await waitForStatus(crud, 'run-1', 'completed')).toBe('completed');
    expect(closerTurn).toHaveBeenCalled();
    cleanup();
  });

  it('RED-no-codigo-antigo: deps REDUZIDAS { crud, emitIPC } (shape antigo do boot) NAO abrem o closer', async () => {
    const { crud, state } = makeFakeCrud(tmpRoot);
    const reducedDeps: WorkflowRunnerDeps = withFakes(
      { crud, emitIPC: () => {} }, // SEM closerDeps - exatamente o shape antigo.
      gateCoordinator,
    );
    const runner = new WorkflowRunner(reducedDeps);
    await runner.start('run-1');
    await waitForStatus(crud, 'run-1', 'blocked');
    await runner.approveGate('run-1', 'gate-global', { decision: 'approve' });
    const terminal = await waitForStatus(crud, 'run-1', 'completed');
    expect(terminal).toBe('completed');
    expect(state.events.some((e) => e.type === 'closer-auto-opened')).toBe(false);
    cleanup();
  });
});


describe('F3 makeRealClaudeCompatBackend: override + pricing', () => {
  const fakeConfig = {
    model: 'opus-default',
    systemPrompt: 'sp',
    allowedTools: [],
    mcpServers: [],
    maxTurns: undefined,
    effort: 'medium' as const,
    thinking: 'adaptive' as const,
    thinkingBudget: undefined,
    runtime: 'cloud' as const,
  };

  function fakeRunNode(capture: (configModel: string) => void) {
    return (async (input: { config: { model: string } }) => {
      capture(input.config.model);
      return {
        output: 'ok',
        model: input.config.model,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        apiRequests: 1,
        toolUses: 0,
      };
    }) as never;
  }

  function backendInput(model: string) {
    return {
      agentId: 'a1',
      runtime: 'cloud' as const,
      model,
      systemPrompt: 'sp',
      prompt: 'p',
      cwd: '/tmp',
      allowedTools: [],
      mcpServers: [],
      canUseTool: () => ({ behavior: 'allow' as const }),
      abortSignal: new AbortController().signal,
      timeoutMs: 1000,
    };
  }

  it('AC-F3-1: override (input.model != config.model) PATCHA config.model -> chega ao runNode', async () => {
    let configModelSeen = '';
    const backend = makeRealClaudeCompatBackend({
      resolveConfig: async () => fakeConfig,
      runNode: fakeRunNode((m) => (configModelSeen = m)),
      hasKnownPricing: () => true,
    });
    const out = await backend(backendInput('claude-sonnet-4-6'));
    expect(configModelSeen).toBe('claude-sonnet-4-6');
    expect(out.model).toBe('claude-sonnet-4-6');
    expect(out.costStatus).toBe('known');
  });

  it('SEM override (input.model == config.model): config intacta, costStatus known (byte-identico)', async () => {
    let configModelSeen = '';
    const backend = makeRealClaudeCompatBackend({
      resolveConfig: async () => fakeConfig,
      runNode: fakeRunNode((m) => (configModelSeen = m)),
      hasKnownPricing: () => false, // mesmo sem pricing, SEM override nao marca unknown.
    });
    const out = await backend(backendInput('opus-default'));
    expect(configModelSeen).toBe('opus-default');
    expect(out.costStatus).toBe('known');
    expect(out.costUnknownReason).toBeUndefined();
  });

  it('AC-F3-4: override de model SEM pricing conhecido -> costStatus unknown / unknown-pricing', async () => {
    const backend = makeRealClaudeCompatBackend({
      resolveConfig: async () => fakeConfig,
      runNode: fakeRunNode(() => undefined),
      hasKnownPricing: (m) => m !== 'glm-5.2',
    });
    const out = await backend(backendInput('glm-5.2'));
    expect(out.model).toBe('glm-5.2');
    expect(out.costStatus).toBe('unknown');
    expect(out.costUnknownReason).toBe('unknown-pricing');
  });

  it('override de model COM pricing conhecido -> costStatus known', async () => {
    const backend = makeRealClaudeCompatBackend({
      resolveConfig: async () => fakeConfig,
      runNode: fakeRunNode(() => undefined),
      hasKnownPricing: () => true,
    });
    const out = await backend(backendInput('claude-opus-4-8'));
    expect(out.costStatus).toBe('known');
  });
});


describe('S4 makeRealClaudeCompatBackend: override de effort', () => {
  const fakeConfig = {
    model: 'opus-default',
    systemPrompt: 'sp',
    allowedTools: [],
    mcpServers: [],
    maxTurns: undefined,
    effort: 'medium' as const,
    thinking: 'adaptive' as const,
    thinkingBudget: undefined,
    runtime: 'cloud' as const,
  };

  function fakeRunNodeCapturingConfig(
    capture: (config: { model: string; effort?: string; thinking?: string }) => void,
  ) {
    return (async (input: { config: { model: string; effort?: string; thinking?: string } }) => {
      capture(input.config);
      return {
        output: 'ok',
        model: input.config.model,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        apiRequests: 1,
        toolUses: 0,
      };
    }) as never;
  }

  function backendInput(over: Record<string, unknown> = {}) {
    return {
      agentId: 'a1',
      runtime: 'cloud' as const,
      model: 'opus-default',
      systemPrompt: 'sp',
      prompt: 'p',
      cwd: '/tmp',
      allowedTools: [],
      mcpServers: [],
      canUseTool: () => ({ behavior: 'allow' as const }),
      abortSignal: new AbortController().signal,
      timeoutMs: 1000,
      ...over,
    } as never;
  }

  it('override (input.effort != config.effort) PATCHA config.effort SEM re-resolver e SEM tocar a config global', async () => {
    let seen: { model: string; effort?: string; thinking?: string } | undefined;
    let resolveCalls = 0;
    const backend = makeRealClaudeCompatBackend({
      resolveConfig: async () => {
        resolveCalls += 1;
        return fakeConfig;
      },
      runNode: fakeRunNodeCapturingConfig((c) => (seen = c)),
      hasKnownPricing: () => true,
    });
    const out = await backend(backendInput({ effort: 'max' }));
    expect(seen!.effort).toBe('max');
    expect(seen!.thinking).toBe('adaptive');
    expect(seen!.model).toBe('opus-default');
    expect(fakeConfig.effort).toBe('medium');
    expect(resolveCalls).toBe(1);
    expect(out.costStatus).toBe('known');
  });

  it('SEM effort: config INTACTA (mesma referencia, byte-identico ao legado)', async () => {
    let seen: { effort?: string } | undefined;
    const backend = makeRealClaudeCompatBackend({
      resolveConfig: async () => fakeConfig,
      runNode: (async (input: { config: unknown }) => {
        seen = input.config as { effort?: string };
        expect(input.config).toBe(fakeConfig);
        return {
          output: 'ok',
          model: 'opus-default',
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          apiRequests: 1,
          toolUses: 0,
        };
      }) as never,
      hasKnownPricing: () => true,
    });
    await backend(backendInput());
    expect(seen!.effort).toBe('medium');
  });

  it('effort IGUAL ao da config: sem patch (mesma referencia)', async () => {
    const backend = makeRealClaudeCompatBackend({
      resolveConfig: async () => fakeConfig,
      runNode: (async (input: { config: unknown }) => {
        expect(input.config).toBe(fakeConfig);
        return {
          output: 'ok',
          model: 'opus-default',
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          apiRequests: 1,
          toolUses: 0,
        };
      }) as never,
      hasKnownPricing: () => true,
    });
    await backend(backendInput({ effort: 'medium' }));
  });

  it('model + effort juntos: os DOIS patches entram na mesma copia local', async () => {
    let seen: { model: string; effort?: string } | undefined;
    const backend = makeRealClaudeCompatBackend({
      resolveConfig: async () => fakeConfig,
      runNode: fakeRunNodeCapturingConfig((c) => (seen = c)),
      hasKnownPricing: () => true,
    });
    await backend(backendInput({ model: 'claude-sonnet-4-6', effort: 'low' }));
    expect(seen!.model).toBe('claude-sonnet-4-6');
    expect(seen!.effort).toBe('low');
    expect(fakeConfig.model).toBe('opus-default');
    expect(fakeConfig.effort).toBe('medium');
  });
});

describe('S4 realKimiBackend: provenance do override de effort', () => {
  it('repassa o effort do node como override explicito sem mutar a config resolvida', async () => {
    realKimiBackendState.run.mockResolvedValueOnce({
      output: 'ok',
      model: 'kimi-code/kimi-for-coding',
      runtime: 'kimi',
      provider: 'kimi',
      metrics: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        durationMs: 1,
        apiRequests: 1,
        toolUses: 0,
      },
    });

    await realKimiBackend({
      agentId: 'kimi-agent',
      runtime: 'kimi',
      model: 'kimi-code/kimi-for-coding',
      effort: 'high',
      systemPrompt: 'sp',
      prompt: 'p',
      cwd: '/tmp',
      allowedTools: [],
      mcpServers: [],
      canUseTool: () => ({ behavior: 'allow' }),
      abortSignal: new AbortController().signal,
      timeoutMs: 1000,
    });

    const [request, config] = realKimiBackendState.run.mock.calls[0] as unknown as [
      { effortOverride?: string },
      { effort?: string },
    ];
    expect(request.effortOverride).toBe('high');
    expect(config.effort).toBe('high');
    expect(realKimiBackendState.config.effort).toBe('low');
  });
});


describe('D11: getWallTimeoutMs por setting dynamic_workflow_wall_timeout_minutes', () => {
  beforeEach(() => {
    getSettingD11Mock.mockReset();
    getSettingD11Mock.mockImplementation(() => undefined);
  });

  it('parseWallTimeoutSetting (pura): ausente/vazio = desligado sem reason; inteiro 1..35000 = ms', () => {
    expect(parseWallTimeoutSetting(undefined)).toEqual({ ms: undefined });
    expect(parseWallTimeoutSetting(null)).toEqual({ ms: undefined });
    expect(parseWallTimeoutSetting('')).toEqual({ ms: undefined });
    expect(parseWallTimeoutSetting('   ')).toEqual({ ms: undefined });
    expect(parseWallTimeoutSetting('1')).toEqual({ ms: 60_000 });
    expect(parseWallTimeoutSetting('120')).toEqual({ ms: 120 * 60_000 });
    expect(parseWallTimeoutSetting(' 35000 ')).toEqual({ ms: 35_000 * 60_000 });
  });

  it('parseWallTimeoutSetting: invalida (0, -1, 99999, abc, 1.5) = desligado COM reason (warn no caller)', () => {
    for (const raw of ['0', '-1', '99999', 'abc', '1.5', '35001', 'NaN']) {
      const parsed = parseWallTimeoutSetting(raw);
      expect(parsed.ms, raw).toBeUndefined();
      expect(typeof parsed.reason, raw).toBe('string');
    }
  });

  it('createDefaultRunnerDeps().getWallTimeoutMs: ausente por default (setting nao existe) => undefined', () => {
    const deps = createDefaultRunnerDeps({ crud: {} as WorkflowRunnerCrud, adapterDeps: {} as never });
    expect(typeof deps.getWallTimeoutMs).toBe('function');
    expect(deps.getWallTimeoutMs!()).toBeUndefined();
    expect(getSettingD11Mock).toHaveBeenCalledWith(DYNAMIC_WORKFLOW_WALL_TIMEOUT_SETTING_KEY);
  });

  it('setting valida => ms; invalida => desligado (undefined)', () => {
    getSettingD11Mock.mockImplementation((key: string) =>
      key === DYNAMIC_WORKFLOW_WALL_TIMEOUT_SETTING_KEY ? '90' : undefined,
    );
    expect(resolveWallTimeoutMsFromSetting()).toBe(90 * 60_000);
    for (const raw of ['0', '-1', '99999', 'abc']) {
      getSettingD11Mock.mockImplementation((key: string) =>
        key === DYNAMIC_WORKFLOW_WALL_TIMEOUT_SETTING_KEY ? raw : undefined,
      );
      expect(resolveWallTimeoutMsFromSetting(), raw).toBeUndefined();
    }
  });

  it('override de teste vence o default da setting', () => {
    const deps = createDefaultRunnerDeps({
      crud: {} as WorkflowRunnerCrud,
      adapterDeps: {} as never,
      getWallTimeoutMs: () => 1234,
    });
    expect(deps.getWallTimeoutMs!()).toBe(1234);
    expect(getSettingD11Mock).not.toHaveBeenCalled();
  });
});
