
import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  WorkflowRunner,
  recoverInterruptedRuns,
  stallDelayFor,
  resolveSandboxChildEntry,
  _resetRunLocksForTesting,
  _resetWorkflowRunnerForTesting,
  type WorkflowRunnerCrud,
  type WorkflowRunnerDeps,
  type WorkflowTimerHandle,
  type SwitchAgentValidation,
} from '../dynamic-workflows/workflow-runner';
import { normalizeLineEndings, compileWorkflowJs } from '../dynamic-workflows/workflow-js-compiler';
import { classifyFailureByRuntime } from '../dynamic-workflows/workflow-failure';
import {
  computeCanonicalFailureClass,
  partitionSprintsForParallel,
  sprintWriteSetsDisjoint,
  globsCanOverlap,
  WORKFLOW_PARALLEL_SPRINT_CAP,
  type ParallelGroupSprint,
} from '../dynamic-workflows/workflow-host-api';
import {
  sanitizeBranchSegment,
  sprintBranchName,
  shortRunId,
  isGitLockError,
  runGitWithBackoff,
  type GitRunner,
  type GitRunResult,
} from '../dynamic-workflows/workflow-git';
import {
  defaultSprintWorktreePath,
  chooseSprintWorktreePath,
  tempSprintWorktreePath,
} from '../dynamic-workflows/workflow-worktree';
import {
  mergeSprintsOrdered,
  type SprintMergeTarget,
  type OrderedMergeDeps,
} from '../dynamic-workflows/workflow-closer';
import { mapWorkflowEventToActivities } from '../dynamic-workflows/workflow-activity';
import { __V93_INTERNAL } from '../db-migrations/v93-dynamic-workflow-sprint-worktree';
import type { DynamicWorkflowSprintPatch } from '../dynamic-workflows/types';
import {
  DYNAMIC_WORKFLOW_SPRINT_MERGE_STATUSES,
  type DynamicWorkflowSprintMergeStatus,
} from '../../../src/types/dynamic-workflow';
import {
  journalKeyMatches,
  lookupJournalReplay,
} from '../dynamic-workflows/workflow-checkpoints';
import type {
  DynamicWorkflowRun,
  DynamicWorkflowDefinition,
  DynamicWorkflowManifest,
  DynamicWorkflowNodeRun,
  DynamicWorkflowNodeRunUpsertInput,
  DynamicWorkflowGateDecisionInsertInput,
  DynamicWorkflowMessageInsertInput,
  DynamicWorkflowDefinitionCreateInput,
  DynamicWorkflowJournalCallKey,
  DynamicWorkflowJournalEntry,
} from '../dynamic-workflows/types';


interface FakeTimer {
  id: number;
  delayMs: number;
  cb: () => void;
  cancelled: boolean;
}

class FakeScheduler {
  private timers: FakeTimer[] = [];
  private nextId = 1;

  schedule = (delayMs: number, cb: () => void): WorkflowTimerHandle => {
    const t: FakeTimer = { id: this.nextId++, delayMs, cb, cancelled: false };
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

  lastDelayMs(): number | null {
    const active = this.timers.filter((t) => !t.cancelled);
    return active.length ? active[active.length - 1].delayMs : null;
  }
}


interface Harness {
  crud: WorkflowRunnerCrud;
  state: {
    runs: Map<string, DynamicWorkflowRun>;
    definitions: Map<string, DynamicWorkflowDefinition>;
    nodeRuns: DynamicWorkflowNodeRun[];
    events: Array<{ type: string; runId: string; nodeId: string | null; payload: unknown }>;
    gateDecisions: DynamicWorkflowGateDecisionInsertInput[];
    messages: DynamicWorkflowMessageInsertInput[];
  };
}

const FIXED_NOW = '2026-06-12T12:00:00.000Z';

function makeManifest(): DynamicWorkflowManifest {
  return {
    version: 1,
    name: 'res-wf',
    phases: [
      { id: 'Scout', name: 'Scout', order: 0 },
      { id: 'Implementar', name: 'Implementar', order: 1 },
    ],
    nodes: [
      { id: 'scout', type: 'agent', phaseId: 'Scout', agentId: 'a-scout', access: 'read-only', canResume: true, produces: ['scout'], consumes: [] },
      { id: 'coder', type: 'agent', phaseId: 'Implementar', agentId: 'a-coder', access: 'workspace-write', writeSet: ['src/**'], isolation: 'run-workspace', canResume: true, produces: ['impl'], consumes: ['scout'] },
    ],
    parallelism: { maxConcurrentAgents: 1, parallelWritersAllowed: false },
    gates: [],
    estimate: { minUsd: 0, maxUsd: 1, unknownCostNodes: [] },
  };
}

function makeRun(over?: Partial<DynamicWorkflowRun>): DynamicWorkflowRun {
  return {
    id: 'run-1',
    definitionId: 'def-1',
    chatSessionId: null,
    status: 'running',
    currentPhaseId: 'Implementar',
    currentNodeId: 'coder',
    workspaceMode: 'run-worktree',
    baseBranch: 'main',
    baseCommitSha: 'base-sha',
    baseWorktreeHash: null,
    worktreePath: '/tmp/wt/run-1',
    worktreeBranch: 'dynworkflow/run-1',
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
    startedAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    completedAt: null,
    ...over,
  };
}

function makeDefinition(over?: Partial<DynamicWorkflowDefinition>): DynamicWorkflowDefinition {
  return {
    id: 'def-1',
    name: 'res-wf',
    definitionVersion: 1,
    authoringModel: 'claude-code',
    parentDefinitionId: null,
    supersedesDefinitionId: null,
    sourceType: 'builder',
    projectPath: '/tmp/proj',
    specPath: null,
    specSha256: null,
    workflowJsPath: '/tmp/proj/.lionclaw/workflows/run-1/workflow.js',
    manifestPath: '/tmp/proj/.lionclaw/workflows/run-1/workflow.manifest.json',
    manifestJson: JSON.stringify(makeManifest()),
    manifestHash: 'mh',
    contextBundlePath: null,
    builderModel: null,
    status: 'validated',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...over,
  };
}

function makeNodeRun(over: Partial<DynamicWorkflowNodeRun> & { nodeId: string; attempt: number }): DynamicWorkflowNodeRun {
  return {
    id: `nr-${over.nodeId}-${over.attempt}`,
    runId: 'run-1',
    phaseId: 'Implementar',
    type: 'agent',
    agentId: 'a-coder',
    status: 'running',
    inputHash: 'ih',
    policyHash: 'ph-old',
    policySnapshotJson: '{}',
    inputJson: '{}',
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
    runtime: 'cloud',
    provider: null,
    toolUses: 0,
    apiRequests: 0,
    durationMs: 0,
    startedAt: FIXED_NOW,
    completedAt: null,
    ...over,
  };
}

function makeHarness(opts?: {
  run?: Partial<DynamicWorkflowRun>;
  definition?: Partial<DynamicWorkflowDefinition>;
  nodeRuns?: DynamicWorkflowNodeRun[];
  definitions?: DynamicWorkflowDefinition[];
}): Harness {
  const state: Harness['state'] = {
    runs: new Map([['run-1', makeRun(opts?.run)]]),
    definitions: new Map(
      (opts?.definitions ?? [makeDefinition(opts?.definition)]).map((d) => [d.id, d]),
    ),
    nodeRuns: opts?.nodeRuns ?? [],
    events: [],
    gateDecisions: [],
    messages: [],
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
    upsertNodeRun: (input: DynamicWorkflowNodeRunUpsertInput) => {
      const nr = makeNodeRun({
        nodeId: input.nodeId,
        attempt: input.attempt,
        id: input.id,
        status: input.status,
        agentId: input.agentId ?? null,
        inputHash: input.inputHash ?? null,
        policyHash: input.policyHash ?? null,
      });
      state.nodeRuns.push(nr);
      return nr;
    },
    updateNodeRun: (id, patch) => {
      const nr = state.nodeRuns.find((n) => n.id === id);
      if (nr) Object.assign(nr, patch);
    },
    listNodeRuns: (runId) => state.nodeRuns.filter((n) => n.runId === runId),
    insertEvent: (input) => {
      const id = state.events.length + 1;
      let payload: unknown = {};
      try {
        payload = input.payloadJson ? JSON.parse(input.payloadJson) : {};
      } catch {
        payload = input.payloadJson;
      }
      state.events.push({ type: input.type, runId: input.runId, nodeId: input.nodeId ?? null, payload });
      return {
        id,
        runId: input.runId,
        nodeId: input.nodeId ?? null,
        phaseId: input.phaseId ?? null,
        seq: id,
        type: input.type,
        payloadJson: input.payloadJson ?? '{}',
        createdAt: FIXED_NOW,
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
        createdAt: FIXED_NOW,
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
      createdAt: FIXED_NOW,
    }),
    insertMessage: (input) => {
      state.messages.push(input);
      return {
        id: state.messages.length,
        runId: input.runId,
        nodeId: input.nodeId ?? null,
        role: input.role,
        source: input.source,
        kind: input.kind,
        content: input.content,
        toolCallsJson: input.toolCallsJson ?? null,
        agentId: input.agentId ?? null,
        createdAt: FIXED_NOW,
      };
    },
    listMessages: () => [],
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

  return { crud, state };
}

function makeRunner(harness: Harness, scheduler: FakeScheduler, extra?: Partial<WorkflowRunnerDeps>): WorkflowRunner {
  const deps: WorkflowRunnerDeps = {
    crud: harness.crud,
    emitIPC: () => {},
    now: () => FIXED_NOW,
    scheduleTimer: scheduler.schedule,
    ...extra,
  };
  return new WorkflowRunner(deps);
}

function pendingDecisionOf(harness: Harness, runId = 'run-1'): { type?: string; failureClass?: string; policyChanged?: boolean } | null {
  const run = harness.state.runs.get(runId);
  if (!run) return null;
  try {
    const input = JSON.parse(run.inputJson || '{}') as { pendingDecision?: { type?: string; failureClass?: string; policyChanged?: boolean } };
    return input.pendingDecision ?? null;
  } catch {
    return null;
  }
}

beforeEach(() => {
  _resetRunLocksForTesting();
  _resetWorkflowRunnerForTesting();
});


describe('S17 classifyFailureByRuntime: refinamento fino por runtime (10.4)', () => {
  it('janela de uso renovavel (claude-compatible) -> provider-limit (retryavel)', () => {
    expect(
      classifyFailureByRuntime({ runtime: 'cloud', error: new Error('You have hit your usage limit reached. Try again later.') }),
    ).toBe('provider-limit');
  });

  it('overloaded transitorio -> provider-error', () => {
    expect(
      classifyFailureByRuntime({ runtime: 'zai', error: new Error('upstream is overloaded, retry') }),
    ).toBe('provider-error');
  });

  it('codex pedindo re-login (mensagem do CLI) -> provider-auth', () => {
    expect(
      classifyFailureByRuntime({ runtime: 'codex', error: new Error('session expired, run /login') }),
    ).toBe('provider-auth');
  });

  it('nao rebaixa classe ja decidida pelo classificador base (429 -> provider-limit)', () => {
    expect(
      classifyFailureByRuntime({ runtime: 'external', error: new Error('nope'), httpStatus: 429 }),
    ).toBe('provider-limit');
  });

  it('sem sinal nenhum continua logic (nao inventa provider-limit)', () => {
    expect(classifyFailureByRuntime({ runtime: 'cloud', error: new Error('undefined is not a function') })).toBe('logic');
  });
});


describe('S17 handleProviderFailure: retry/backoff/blocked (10.4/AC-22)', () => {
  it('provider-limit -> 3 retries com backoff exponencial -> blocked provider (nunca failed)', async () => {
    const harness = makeHarness({ nodeRuns: [makeNodeRun({ nodeId: 'coder', attempt: 1 })] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);
    const input = { runtime: 'cloud' as const, error: new Error('rate limit exceeded') };

    let r = await runner.handleProviderFailure('run-1', 'coder', input, 1);
    expect(r.outcome).toBe('retry-scheduled');
    expect(r.failureClass).toBe('provider-limit');
    expect(r.backoffMs).toBe(30_000);
    expect(scheduler.lastDelayMs()).toBe(30_000);
    const nr1 = harness.state.nodeRuns.find((n) => n.nodeId === 'coder' && n.attempt === 1);
    expect(nr1?.status).toBe('interrupted');
    expect(nr1?.failureClass).toBe('provider-limit');
    expect(harness.state.runs.get('run-1')?.status).not.toBe('failed');

    r = await runner.handleProviderFailure('run-1', 'coder', input, 2);
    expect(r.outcome).toBe('retry-scheduled');
    expect(r.backoffMs).toBe(120_000);

    r = await runner.handleProviderFailure('run-1', 'coder', input, 3);
    expect(r.outcome).toBe('blocked-provider');
    const run = harness.state.runs.get('run-1');
    expect(run?.status).toBe('blocked');
    expect(run?.status).not.toBe('failed');
    const pd = pendingDecisionOf(harness);
    expect(pd?.type).toBe('provider');
    expect(pd?.failureClass).toBe('provider-limit');
  });

  it('provider-auth bloqueia IMEDIATAMENTE sem retry (re-login humano, 10.4)', async () => {
    const harness = makeHarness({ nodeRuns: [makeNodeRun({ nodeId: 'coder', attempt: 1 })] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);

    const r = await runner.handleProviderFailure(
      'run-1',
      'coder',
      { runtime: 'codex', error: Object.assign(new Error('login'), { name: 'CodexAuthError' }) },
      1,
    );
    expect(r.outcome).toBe('blocked-provider');
    expect(r.failureClass).toBe('provider-auth');
    expect(scheduler.activeCount()).toBe(0);
    expect(harness.state.runs.get('run-1')?.status).toBe('blocked');
    expect(pendingDecisionOf(harness)?.failureClass).toBe('provider-auth');
  });

  it('progresso parcial preservado: node JA concluido nao e re-tocado no retry (continuation 10.1)', async () => {
    const completed = makeNodeRun({ nodeId: 'coder', attempt: 1, status: 'completed', id: 'nr-coder-1' });
    const running = makeNodeRun({ nodeId: 'coder', attempt: 2, status: 'running', id: 'nr-coder-2' });
    const harness = makeHarness({ nodeRuns: [completed, running] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);

    await runner.handleProviderFailure('run-1', 'coder', { runtime: 'cloud', error: new Error('quota') }, 1);

    expect(harness.state.nodeRuns.find((n) => n.id === 'nr-coder-1')?.status).toBe('completed');
    expect(harness.state.nodeRuns.find((n) => n.id === 'nr-coder-2')?.status).toBe('interrupted');
  });
});


describe('S17 scheduleResume: retomada agendada (R2-F4/13.8)', () => {
  it('persiste o timestamp-alvo no checkpoint_json e arma o timer', () => {
    const harness = makeHarness({ run: { status: 'blocked' } });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);

    const at = new Date(Date.parse(FIXED_NOW) + 120_000).toISOString();
    const res = runner.scheduleResume('run-1', at);
    expect('ok' in res && res.ok).toBe(true);

    const cp = JSON.parse(harness.state.runs.get('run-1')!.checkpointJson) as { scheduledResumeAt?: string };
    expect(cp.scheduledResumeAt).toBe(at);
    expect(scheduler.lastDelayMs()).toBe(120_000);
  });

  it('o timer dispara uma nova attempt (resume) automaticamente ao vencer', () => {
    const harness = makeHarness({ run: { status: 'interrupted' } });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);

    const at = new Date(Date.parse(FIXED_NOW) + 60_000).toISOString();
    runner.scheduleResume('run-1', at);
    expect(scheduler.activeCount()).toBe(1);

    scheduler.flush();
    const cp = JSON.parse(harness.state.runs.get('run-1')!.checkpointJson) as { scheduledResumeAt?: string };
    expect(cp.scheduledResumeAt).toBeUndefined();
    expect(harness.state.events.some((e) => e.type === 'scheduled-resume-fired')).toBe(true);
  });

  it('boot recovery RE-ARMA a retomada agendada que ficou pendente no crash (R2-F4)', () => {
    const at = new Date(Date.parse(FIXED_NOW) + 300_000).toISOString();
    const harness = makeHarness({
      run: { status: 'blocked', checkpointJson: JSON.stringify({ nodes: {}, scheduledResumeAt: at }) },
    });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);

    const result = runner.recoverInterrupted();
    expect(result.rearmed).toBe(1);
    expect(scheduler.lastDelayMs()).toBe(300_000);
    expect(harness.state.events.some((e) => e.type === 'resume-rearmed')).toBe(true);
  });
});


describe('S17 recoverInterrupted: boot recovery oferece Retomar (10.3/AC-25)', () => {
  it('runs running viram interrupted (aguardam Retomar); nodes running tambem', () => {
    const running = makeNodeRun({ nodeId: 'coder', attempt: 1, status: 'running' });
    const harness = makeHarness({ run: { status: 'running' }, nodeRuns: [running] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);

    const result = runner.recoverInterrupted();
    expect(result.recovered).toBe(1);
    expect(harness.state.runs.get('run-1')?.status).toBe('interrupted');
    expect(harness.state.nodeRuns[0].status).toBe('interrupted');
  });

  it('recoverInterruptedRuns(runner) delega ao runner (wire da S15)', () => {
    const harness = makeHarness({ run: { status: 'running' } });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);
    const res = recoverInterruptedRuns(runner);
    expect(res.recovered).toBe(1);
  });
});


describe('S17 detectPolicyInvalidation: cache invalidado por policy (10.1)', () => {
  it('policy_hash diferente -> emite cache-invalidated:policy-changed e marca blocked', () => {
    const completed = makeNodeRun({ nodeId: 'coder', attempt: 1, status: 'completed', policyHash: 'ph-old' });
    const harness = makeHarness({ nodeRuns: [completed] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler, {
      resolvePolicyHashForNode: () => 'ph-new',
    });

    const { invalidated } = runner.detectPolicyInvalidation('run-1');
    expect(invalidated).toContain('coder');
    expect(
      harness.state.events.some((e) => e.type === 'cache-invalidated:policy-changed' && e.nodeId === 'coder'),
    ).toBe(true);
    expect(harness.state.runs.get('run-1')?.status).toBe('blocked');
    expect(pendingDecisionOf(harness)?.policyChanged).toBe(true);
  });

  it('policy_hash igual -> nao invalida (reuso automatico permitido)', () => {
    const completed = makeNodeRun({ nodeId: 'coder', attempt: 1, status: 'completed', policyHash: 'ph-same' });
    const harness = makeHarness({ nodeRuns: [completed] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler, {
      resolvePolicyHashForNode: () => 'ph-same',
    });
    const { invalidated } = runner.detectPolicyInvalidation('run-1');
    expect(invalidated).toEqual([]);
    expect(harness.state.events.some((e) => e.type === 'cache-invalidated:policy-changed')).toBe(false);
  });
});


describe('S17 switchAgent: troca de agente com nova definition version (14.1.1/22.7)', () => {
  function switchDeps(over: Partial<SwitchAgentValidation>, captured: { newDefInput?: DynamicWorkflowDefinitionCreateInput; prevPatch?: { id: string; supersedes: string } }) {
    return {
      validateSwitchAgent: (): SwitchAgentValidation => ({
        exists: true,
        preflightOk: true,
        expandsPermission: false,
        ...over,
      }),
      persistSwitchedDefinition: (input: { prevDefinition: DynamicWorkflowDefinition }) => {
        const newDefinitionId = 'def-2';
        captured.newDefInput = {
          id: newDefinitionId,
          name: input.prevDefinition.name,
          definitionVersion: input.prevDefinition.definitionVersion + 1,
          parentDefinitionId: input.prevDefinition.id,
          supersedesDefinitionId: null,
          sourceType: input.prevDefinition.sourceType,
          projectPath: input.prevDefinition.projectPath,
          specPath: input.prevDefinition.specPath,
          specSha256: input.prevDefinition.specSha256,
          workflowJsPath: input.prevDefinition.workflowJsPath,
          manifestPath: input.prevDefinition.manifestPath,
          manifestJson: input.prevDefinition.manifestJson,
          manifestHash: input.prevDefinition.manifestHash,
          contextBundlePath: input.prevDefinition.contextBundlePath,
          builderModel: input.prevDefinition.builderModel,
          status: input.prevDefinition.status,
        };
        captured.prevPatch = { id: input.prevDefinition.id, supersedes: newDefinitionId };
        return { newDefinitionId };
      },
    };
  }

  it('aplica a troca: nova definition version COM parent_definition_id + supersedes na anterior (22.7)', async () => {
    const harness = makeHarness({ nodeRuns: [makeNodeRun({ nodeId: 'coder', attempt: 1, status: 'interrupted' })] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);
    const captured: { newDefInput?: DynamicWorkflowDefinitionCreateInput; prevPatch?: { id: string; supersedes: string } } = {};

    const res = await runner.switchAgent('run-1', 'coder', 'a-coder-2', 'limite do provedor', 'human', switchDeps({}, captured));
    expect('ok' in res && res.ok).toBe(true);

    expect(captured.newDefInput?.parentDefinitionId).toBe('def-1');
    expect(captured.newDefInput?.definitionVersion).toBe(2);
    expect(captured.prevPatch).toEqual({ id: 'def-1', supersedes: 'def-2' });
    expect(harness.state.events.some((e) => e.type === 'switch-agent-applied')).toBe(true);
    expect(harness.state.messages.some((m) => m.kind === 'switch-agent')).toBe(true);
  });

  it('node JA concluido NAO troca (14.1.1: completados preservados)', async () => {
    const harness = makeHarness({ nodeRuns: [makeNodeRun({ nodeId: 'coder', attempt: 1, status: 'completed' })] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);
    const captured: { newDefInput?: DynamicWorkflowDefinitionCreateInput } = {};

    const res = await runner.switchAgent('run-1', 'coder', 'a-coder-2', 'troca', 'human', switchDeps({}, captured));
    expect('error' in res).toBe(true);
    expect(captured.newDefInput).toBeUndefined();
  });

  it('ampliacao de permissao pelo ORQUESTRADOR -> gate humano (nao aplica, registra gate)', async () => {
    const harness = makeHarness({ nodeRuns: [makeNodeRun({ nodeId: 'coder', attempt: 1, status: 'interrupted' })] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);
    const captured: { newDefInput?: DynamicWorkflowDefinitionCreateInput } = {};

    const res = await runner.switchAgent(
      'run-1',
      'coder',
      'a-coder-2',
      'troca que amplia',
      'orchestrator',
      switchDeps({ expandsPermission: true }, captured),
    );
    expect('error' in res).toBe(true);
    expect(captured.newDefInput).toBeUndefined();
    expect(harness.state.gateDecisions.some((g) => g.gateId === 'switch-agent:coder' && g.mode === 'human')).toBe(true);
    expect(harness.state.events.some((e) => e.type === 'switch-agent-needs-gate')).toBe(true);
  });

  it('ampliacao de permissao pelo HUMANO -> gate humano (nao aplica, registra gate)', async () => {
    const harness = makeHarness({ nodeRuns: [makeNodeRun({ nodeId: 'coder', attempt: 1, status: 'interrupted' })] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);
    const captured: { newDefInput?: DynamicWorkflowDefinitionCreateInput } = {};

    const res = await runner.switchAgent(
      'run-1',
      'coder',
      'a-coder-2',
      'troca que amplia',
      'human',
      switchDeps({ expandsPermission: true }, captured),
    );
    expect('error' in res).toBe(true);
    expect(captured.newDefInput).toBeUndefined();
    expect(harness.state.gateDecisions.some((g) => g.gateId === 'switch-agent:coder' && g.mode === 'human')).toBe(true);
    expect(harness.state.events.some((e) => e.type === 'switch-agent-needs-gate')).toBe(true);
    expect(harness.state.events.some((e) => e.type === 'switch-agent-applied')).toBe(false);
  });

  it('agente novo inexistente no catalogo -> recusa (risco 10)', async () => {
    const harness = makeHarness({ nodeRuns: [makeNodeRun({ nodeId: 'coder', attempt: 1, status: 'interrupted' })] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);
    const captured: { newDefInput?: DynamicWorkflowDefinitionCreateInput } = {};
    const res = await runner.switchAgent('run-1', 'coder', 'ghost', 'troca', 'human', switchDeps({ exists: false, reason: 'agente ghost nao existe no catalogo' }, captured));
    expect('error' in res).toBe(true);
    expect(captured.newDefInput).toBeUndefined();
  });

  it('preflight 8.7 falha para o runtime novo -> recusa', async () => {
    const harness = makeHarness({ nodeRuns: [makeNodeRun({ nodeId: 'coder', attempt: 1, status: 'interrupted' })] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);
    const captured: { newDefInput?: DynamicWorkflowDefinitionCreateInput } = {};
    const res = await runner.switchAgent('run-1', 'coder', 'a-local', 'troca', 'human', switchDeps({ preflightOk: false, reason: 'runtime local nao suporta allowBash' }, captured));
    expect('error' in res).toBe(true);
    expect(captured.newDefInput).toBeUndefined();
  });
});


describe('S17 stall watchdog (13.8)', () => {
  it('sem progresso por 3min -> emite node-stalled', () => {
    const harness = makeHarness({ run: { status: 'running' }, nodeRuns: [makeNodeRun({ nodeId: 'coder', attempt: 1, status: 'running' })] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);

    runner.startStallWatchdog('run-1', 'coder');
    expect(scheduler.lastDelayMs()).toBe(3 * 60 * 1000);
    scheduler.flush();
    expect(harness.state.events.some((e) => e.type === 'node-stalled' && e.nodeId === 'coder')).toBe(true);
  });

  it('pokeStallWatchdog re-arma o watchdog (houve progresso)', () => {
    const harness = makeHarness({ run: { status: 'running' } });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);
    runner.startStallWatchdog('run-1', 'coder');
    runner.pokeStallWatchdog('run-1', 'coder');
    expect(scheduler.activeCount()).toBe(1);
    runner.cancelStallWatchdog('run-1');
    expect(scheduler.activeCount()).toBe(0);
  });


  it('stallDelayFor deriva do timeout do node (20min -> 21min) e cai no piso sem timeout', () => {
    const min = 60 * 1000;
    expect(stallDelayFor(undefined)).toBe(3 * min);
    expect(stallDelayFor(0)).toBe(3 * min);
    expect(stallDelayFor(20 * min)).toBe(21 * min);
    expect(stallDelayFor(30 * 1000)).toBe(3 * min);
  });

  it('node de 20min (template) NAO e auto-pausado aos 3min (regressao do teto fixo)', () => {
    const min = 60 * 1000;
    const harness = makeHarness({ run: { status: 'running' }, nodeRuns: [makeNodeRun({ nodeId: 'coder', attempt: 1, status: 'running' })] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);

    runner.startStallWatchdog('run-1', 'coder', 20 * min);
    expect(scheduler.lastDelayMs()).toBe(21 * min);

    scheduler.flush();
    expect(
      harness.state.events.some((e) => e.type === 'node-stalled' && e.nodeId === 'coder'),
    ).toBe(true);
  });
});


describe('F2 journal ordenado: match de chave + decisao de replay (sec 3.2)', () => {
  function key(over: Partial<DynamicWorkflowJournalCallKey> = {}): DynamicWorkflowJournalCallKey {
    return {
      callPath: 'scout:agent',
      primitive: 'agent',
      nodeId: 'scout',
      argHash: 'arg-1',
      schemaRef: null,
      policyHash: 'pol-1',
      agentId: 'a-scout',
      model: null,
      runtime: null,
      planHash: null,
      workflowRevision: 'rev-1',
      ...over,
    };
  }
  function entry(callIndex: number, over: Partial<DynamicWorkflowJournalEntry> = {}): DynamicWorkflowJournalEntry {
    return {
      runId: 'run-1',
      callIndex,
      outputRef: `n#${callIndex}`,
      sideEffectKey: null,
      createdAt: '2026-06-14T00:00:00.000Z',
      ...key(),
      ...over,
    };
  }

  it('journalKeyMatches: chave identica bate; argHash/policyHash/workflowRevision diferentes nao batem', () => {
    expect(journalKeyMatches(key(), key())).toBe(true);
    expect(journalKeyMatches(key(), key({ argHash: 'arg-2' }))).toBe(false);
    expect(journalKeyMatches(key(), key({ policyHash: 'pol-2' }))).toBe(false);
    expect(journalKeyMatches(key(), key({ workflowRevision: 'rev-2' }))).toBe(false);
    expect(journalKeyMatches(key(), key({ agentId: 'a-other' }))).toBe(false);
  });

  it('journalKeyMatches: model/runtime so comparam quando a chamada nova os conhece (pos-exec)', () => {
    const journaled = key({ runtime: 'codex', model: 'm1' });
    expect(journalKeyMatches(journaled, key({ runtime: null, model: null }))).toBe(true);
    expect(journalKeyMatches(journaled, key({ runtime: 'cloud' }))).toBe(false);
  });

  it('lookupJournalReplay: reuse no prefixo intacto, diverge no 1o desvio, fresh apos o fim', () => {
    const journal = [entry(1), entry(2, { ...key({ argHash: 'arg-2', nodeId: 'v0', callPath: 'v0:agent' }) })];
    expect(lookupJournalReplay(journal, 1, key()).kind).toBe('reuse');
    expect(lookupJournalReplay(journal, 2, key({ argHash: 'arg-MUDOU', nodeId: 'v0', callPath: 'v0:agent' })).kind).toBe('diverge');
    expect(lookupJournalReplay(journal, 3, key()).kind).toBe('fresh');
  });
});


describe('F3 classificacao consistente: uma classe propagada (1.3/3.3)', () => {
  const USAGE_LIMIT_MSG = 'You have hit your usage limit reached. Try again later.';

  it('host computa a classe CANONICA uma vez (por-runtime), nao a coarse do adapter', () => {
    expect(classifyFailureByRuntime({ runtime: 'cloud', error: new Error(USAGE_LIMIT_MSG) })).toBe('provider-limit');
    const canonical = computeCanonicalFailureClass({
      runtime: 'cloud',
      error: new Error(USAGE_LIMIT_MSG),
      errorMessage: USAGE_LIMIT_MSG,
      adapterFailureClass: 'logic',
    });
    expect(canonical).toBe('provider-limit');
  });

  it('a classe canonica e propagada IDENTICA ao node_run, run-block e banner (sem reclassificar)', async () => {
    const harness = makeHarness({ nodeRuns: [makeNodeRun({ nodeId: 'coder', attempt: 1 })] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);

    const canonical = computeCanonicalFailureClass({
      runtime: 'cloud',
      error: new Error(USAGE_LIMIT_MSG),
      errorMessage: USAGE_LIMIT_MSG,
      adapterFailureClass: 'logic',
    });
    expect(canonical).toBe('provider-limit');

    const r = await runner.handleProviderFailure(
      'run-1',
      'coder',
      { runtime: 'cloud', error: new Error(USAGE_LIMIT_MSG) },
      3,
      undefined,
      canonical,
    );
    expect(r.failureClass).toBe('provider-limit');
    expect(r.outcome).toBe('blocked-provider');

    const nr = harness.state.nodeRuns.find((n) => n.nodeId === 'coder' && n.attempt === 1);
    expect(nr?.status).toBe('interrupted');
    expect(nr?.failureClass).toBe('provider-limit');

    expect(pendingDecisionOf(harness)?.failureClass).toBe('provider-limit');

    const banner = harness.state.events.find((e) => e.type === 'run-blocked-provider');
    expect((banner?.payload as { failureClass?: string } | undefined)?.failureClass).toBe('provider-limit');

    const rows = mapWorkflowEventToActivities(
      {
        id: 1,
        runId: 'run-1',
        nodeId: 'coder',
        phaseId: 'Implementar',
        seq: 1,
        type: 'node-failed',
        payloadJson: JSON.stringify({ attempt: 1, failureClass: canonical, error: USAGE_LIMIT_MSG }),
        createdAt: FIXED_NOW,
      },
      makeRun(),
    );
    const errorRow = rows.find((row) => row.status === 'error');
    expect(errorRow?.summary).toBe('provider-limit');
  });

  it('o runner NAO remapeia: a classe canonica vence mesmo divergindo do erro cru', async () => {
    const harness = makeHarness({ nodeRuns: [makeNodeRun({ nodeId: 'coder', attempt: 1 })] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);

    const rawErrorThatWouldBeLimit = Object.assign(new Error('rate limit exceeded'), { status: 429 });
    expect(classifyFailureByRuntime({ runtime: 'cloud', error: rawErrorThatWouldBeLimit })).toBe('provider-limit');

    const r = await runner.handleProviderFailure(
      'run-1',
      'coder',
      { runtime: 'cloud', error: rawErrorThatWouldBeLimit },
      3,
      undefined,
      'timeout', // classe canonica fixada pelo host
    );
    expect(r.failureClass).toBe('timeout');
    const nr = harness.state.nodeRuns.find((n) => n.nodeId === 'coder' && n.attempt === 1);
    expect(nr?.failureClass).toBe('timeout');
    expect(pendingDecisionOf(harness)?.failureClass).toBe('timeout');
    const banner = harness.state.events.find((e) => e.type === 'run-blocked-provider');
    expect((banner?.payload as { failureClass?: string } | undefined)?.failureClass).toBe('timeout');
  });

  it('sem classe canonica (chamada direta legada) o runner ainda classifica por runtime', async () => {
    const harness = makeHarness({ nodeRuns: [makeNodeRun({ nodeId: 'coder', attempt: 1 })] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);

    const r = await runner.handleProviderFailure('run-1', 'coder', { runtime: 'cloud', error: new Error('rate limit') }, 1);
    expect(r.failureClass).toBe('provider-limit');
    expect(r.outcome).toBe('retry-scheduled');
  });

  it('cancelled NUNCA e tratado como failure class (continua status de node)', async () => {
    const harness = makeHarness({ nodeRuns: [makeNodeRun({ nodeId: 'coder', attempt: 1 })] });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);

    const r = await runner.handleProviderFailure(
      'run-1',
      'coder',
      { runtime: 'cloud', error: new Error('rate limit') },
      3,
      undefined,
      null,
    );
    expect(r.failureClass).toBe('provider-limit');
    expect(r.failureClass).not.toBe('cancelled');
  });
});


const VALID_EDIT_JS =
  "export const meta = { name: 'res-wf', description: 'edicao de teste', phases: ['Scout', 'Implementar'] };\n" +
  "await agent('faz o scout do repo', { agentType: 'dynamic-workflow-scout' });\n" +
  "await agent('implementa a feature', { agentType: 'dynamic-workflow-coder' });\n" +
  'return { ok: true };\n';

function makeEditDeps(): {
  deps: Partial<WorkflowRunnerDeps>;
  created: { calls: Array<{ prevId: string; manifestHash: string }> };
  repointed: { calls: Array<{ runId: string; definitionId: string }> };
  materialized: { calls: Array<{ revisionId: string }> };
} {
  const created = { calls: [] as Array<{ prevId: string; manifestHash: string }> };
  const repointed = { calls: [] as Array<{ runId: string; definitionId: string }> };
  const materialized = { calls: [] as Array<{ revisionId: string }> };
  const deps: Partial<WorkflowRunnerDeps> = {
    materializeEditedPackage: (input) => {
      materialized.calls.push({ revisionId: input.revisionId });
      return {
        workflowJsPath: `/tmp/proj/.lionclaw/workflows/${input.revisionId}/workflow.js`,
        manifestPath: `/tmp/proj/.lionclaw/workflows/${input.revisionId}/workflow.manifest.json`,
        manifestJson: input.manifestJson,
        manifestHash: `mh-${input.revisionId}`,
        schemaPaths: [],
      };
    },
    createEditedDefinition: (input) => {
      created.calls.push({ prevId: input.prevDefinition.id, manifestHash: input.manifestHash });
      return { newDefinitionId: `def-${input.revisionId}` };
    },
    repointRunDefinition: (runId, definitionId) => {
      repointed.calls.push({ runId, definitionId });
    },
  };
  return { deps, created, repointed, materialized };
}

describe('F4b editCoordinator: edicao-ao-vivo transacional (SPEC sec 4.3)', () => {
  it('quiescence OK (paused, sem attempt em voo) -> nova revisao auditavel + run re-apontado', async () => {
    const harness = makeHarness({ run: { status: 'paused', currentNodeId: 'coder' } });
    const scheduler = new FakeScheduler();
    const edit = makeEditDeps();
    const runner = makeRunner(harness, scheduler, edit.deps);

    const res = await runner.editCoordinator('run-1', {
      workflowJsSource: VALID_EDIT_JS,
      reason: 'troca a ordem dos validadores',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(edit.created.calls).toHaveLength(1);
    expect(edit.created.calls[0].prevId).toBe('def-1');
    expect(res.manifestHash).toBe(`mh-${res.revisionId}`);
    expect(edit.repointed.calls).toEqual([
      { runId: 'run-1', definitionId: `def-${res.revisionId}` },
    ]);
    expect(harness.state.events.some((e) => e.type === 'coordinator-edited')).toBe(true);
    expect(harness.state.messages.some((m) => m.kind === 'coordinator-edit')).toBe(true);
  });

  it('resume APOS a edicao reusa o prefixo do journal (re-roda do desvio)', async () => {
    const journal: Array<{ runId: string; callIndex: number; nodeId: string | null }> = [
      { runId: 'run-1', callIndex: 1, nodeId: 'scout' },
      { runId: 'run-1', callIndex: 2, nodeId: 'coder' },
    ];
    const truncated: Array<{ runId: string; fromIndex: number }> = [];
    const harness = makeHarness({ run: { status: 'paused', currentNodeId: 'coder' } });
    harness.crud.listJournalEntries = (runId) =>
      journal
        .filter((j) => j.runId === runId)
        .map((j) => ({
          runId: j.runId,
          callIndex: j.callIndex,
          callPath: `c${j.callIndex}`,
          primitive: 'agent',
          nodeId: j.nodeId,
          argHash: 'a',
          schemaRef: null,
          policyHash: null,
          agentId: null,
          model: null,
          runtime: null,
          planHash: null,
          workflowRevision: 'mh',
          outputRef: null,
          sideEffectKey: null,
          createdAt: FIXED_NOW,
        }));
    harness.crud.truncateJournalFrom = (runId, fromIndex) => {
      truncated.push({ runId, fromIndex });
    };
    const scheduler = new FakeScheduler();
    const edit = makeEditDeps();
    const runner = makeRunner(harness, scheduler, edit.deps);

    const res = await runner.editCoordinator('run-1', {
      workflowJsSource: VALID_EDIT_JS,
      reason: 'reescreve a fase de fix',
    });
    expect(res.ok).toBe(true);
    expect(truncated).toEqual([{ runId: 'run-1', fromIndex: 2 }]);
  });

  it('SEM quiescence (run running) -> recusa e NAO muta o run', async () => {
    const harness = makeHarness({ run: { status: 'running', currentNodeId: 'coder' } });
    const scheduler = new FakeScheduler();
    const edit = makeEditDeps();
    const runner = makeRunner(harness, scheduler, edit.deps);

    const res = await runner.editCoordinator('run-1', {
      workflowJsSource: VALID_EDIT_JS,
      reason: 'editar com run rodando',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/quiescence|execucao|pause/i);
    expect(edit.created.calls).toHaveLength(0);
    expect(edit.repointed.calls).toHaveLength(0);
  });

  it('SEM quiescence (attempt em voo) -> recusa mesmo com run paused', async () => {
    const harness = makeHarness({
      run: { status: 'paused', currentNodeId: 'coder' },
      nodeRuns: [makeNodeRun({ nodeId: 'coder', attempt: 1, status: 'running' })],
    });
    const scheduler = new FakeScheduler();
    const edit = makeEditDeps();
    const runner = makeRunner(harness, scheduler, edit.deps);

    const res = await runner.editCoordinator('run-1', {
      workflowJsSource: VALID_EDIT_JS,
      reason: 'editar com writer em voo',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/voo|quiescence|encerramento/i);
    expect(edit.repointed.calls).toHaveLength(0);
  });

  it('o manifest da revisao e re-derivado do meta, PRESERVANDO os nodes ja materializados (gates vazios)', async () => {
    const harness = makeHarness({ run: { status: 'paused', currentNodeId: 'coder' } });
    const scheduler = new FakeScheduler();
    const edit = makeEditDeps();
    const captured: Array<{ manifestJson: string }> = [];
    const runner = makeRunner(harness, scheduler, {
      ...edit.deps,
      materializeEditedPackage: (input) => {
        captured.push({ manifestJson: input.manifestJson });
        return {
          workflowJsPath: `/tmp/proj/.lionclaw/workflows/${input.revisionId}/workflow.js`,
          manifestPath: `/tmp/proj/.lionclaw/workflows/${input.revisionId}/workflow.manifest.json`,
          manifestJson: input.manifestJson,
          manifestHash: `mh-${input.revisionId}`,
          schemaPaths: [],
        };
      },
    });

    const res = await runner.editCoordinator('run-1', {
      workflowJsSource: VALID_EDIT_JS,
      reason: 'JS-only: manifest re-derivado pelo host',
    });

    expect(res.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const derived = JSON.parse(captured[0].manifestJson) as {
      nodes: Array<{ id: string }>;
      gates: unknown[];
      phases: Array<{ id: string }>;
    };
    expect(derived.nodes.map((n) => n.id)).toEqual(['scout', 'coder']);
    expect(derived.gates).toEqual([]);
    expect(derived.phases.map((p) => p.id)).toEqual(['Scout', 'Implementar']);
  });

  it('nodes de SPRINT materializados sobrevivem no manifest da definition NOVA apos o edit', async () => {
    const sprintNodes = [
      {
        id: 'coder-s1-r1',
        type: 'agent',
        phaseId: 'Implementar',
        agentId: 'a-coder',
        access: 'workspace-write',
        writeSet: ['src/**'],
        isolation: 'run-workspace',
        canResume: true,
        produces: ['impl-s1'],
        consumes: [],
        sprintId: 's1',
        roundIndex: 1,
      },
      {
        id: 'validator-tests-s1-r1',
        type: 'agent',
        phaseId: 'Implementar',
        agentId: 'a-scout',
        access: 'read-only',
        canResume: true,
        produces: ['findings-s1'],
        consumes: ['impl-s1'],
        sprintId: 's1',
        roundIndex: 1,
      },
    ];
    const manifestWithSprints = {
      ...makeManifest(),
      nodes: sprintNodes,
    } as unknown as DynamicWorkflowManifest;
    const harness = makeHarness({
      run: { status: 'paused', currentNodeId: 'coder-s1-r1' },
      definition: { manifestJson: JSON.stringify(manifestWithSprints) },
    });
    const scheduler = new FakeScheduler();
    const edit = makeEditDeps();
    const capturedDefs: string[] = [];
    const runner = makeRunner(harness, scheduler, {
      ...edit.deps,
      createEditedDefinition: (input) => {
        capturedDefs.push(input.manifestJson);
        return { newDefinitionId: `def-${input.revisionId}` };
      },
    });

    const res = await runner.editCoordinator('run-1', {
      workflowJsSource: VALID_EDIT_JS,
      reason: 'edit nao pode perder os nodes de sprint',
    });

    expect(res.ok).toBe(true);
    expect(capturedDefs).toHaveLength(1);
    const newManifest = JSON.parse(capturedDefs[0]) as {
      nodes: Array<{ id: string; sprintId?: string; roundIndex?: number }>;
      gates: unknown[];
    };
    expect(newManifest.nodes.map((n) => n.id)).toEqual(['coder-s1-r1', 'validator-tests-s1-r1']);
    expect(newManifest.nodes[0].sprintId).toBe('s1');
    expect(newManifest.nodes[0].roundIndex).toBe(1);
    expect(newManifest.gates).toEqual([]);
  });

  it('JS que nao compila (API proibida) -> recusa com o motivo REAL, run intacto', async () => {
    const harness = makeHarness({ run: { status: 'paused', currentNodeId: 'coder' } });
    const scheduler = new FakeScheduler();
    const edit = makeEditDeps();
    const runner = makeRunner(harness, scheduler, edit.deps);

    const badJs =
      "export const meta = { name: 'res-wf', phases: ['Scout', 'Implementar'] };\n" +
      "export default async function run(ctx) { const fs = require('fs'); return {}; }\n";
    const res = await runner.editCoordinator('run-1', {
      workflowJsSource: badJs,
      reason: 'usa require (proibido)',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/compila|require|forbidden/i);
    expect(edit.materialized.calls).toHaveLength(0);
    expect(edit.repointed.calls).toHaveLength(0);
  });

  it('host nao montado (sem deps F4b) -> recusa por seguranca, sem mutar', async () => {
    const harness = makeHarness({ run: { status: 'paused', currentNodeId: 'coder' } });
    const scheduler = new FakeScheduler();
    const runner = makeRunner(harness, scheduler);

    const res = await runner.editCoordinator('run-1', {
      workflowJsSource: VALID_EDIT_JS,
      reason: 'sem host de edicao',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/indisponivel|nao configurado/i);
  });
});


describe('F5a V93: colunas de worktree por sprint (sec 3.4/D-3)', () => {
  it('a migration adiciona EXATAMENTE as 5 colunas por sprint na tabela certa', () => {
    expect(__V93_INTERNAL.TABLE).toBe('dynamic_workflow_sprints');
    expect(__V93_INTERNAL.ADDED_COLUMNS).toEqual([
      'worktree_path',
      'branch',
      'base_sha',
      'head_sha',
      'merge_status',
    ]);
  });

  it('cada coluna e um ALTER TABLE ADD COLUMN isolado (try/catch idempotente como V87)', () => {
    expect(__V93_INTERNAL.ALTERS).toHaveLength(5);
    for (const alter of __V93_INTERNAL.ALTERS) {
      expect(alter).toMatch(
        /^ALTER TABLE dynamic_workflow_sprints ADD COLUMN /,
      );
    }
    expect(
      __V93_INTERNAL.ALTERS.every((a) =>
        a.includes('dynamic_workflow_sprints'),
      ),
    ).toBe(true);
  });

  it('merge_status carrega DEFAULT pending + CHECK gerado do union (disciplina 12.1)', () => {
    const mergeAlter = __V93_INTERNAL.ALTERS.find((a) =>
      a.includes('merge_status'),
    );
    expect(mergeAlter).toBeDefined();
    expect(mergeAlter).toContain("DEFAULT 'pending'");
    for (const status of DYNAMIC_WORKFLOW_SPRINT_MERGE_STATUSES) {
      expect(mergeAlter).toContain(`'${status}'`);
    }
    expect(mergeAlter).toMatch(/CHECK \(merge_status IN \(/);
  });

  it('o union de merge_status e o dominio fechado esperado (pending->merged->conflict)', () => {
    const expected: DynamicWorkflowSprintMergeStatus[] = [
      'pending',
      'merging',
      'merged',
      'conflict',
      'skipped',
    ];
    expect([...DYNAMIC_WORKFLOW_SPRINT_MERGE_STATUSES]).toEqual(expected);
    expect(DYNAMIC_WORKFLOW_SPRINT_MERGE_STATUSES).toContain('pending');
  });
});


function sprint(
  index: number,
  writeSet: string[],
  dependencies: string[] = [],
): ParallelGroupSprint {
  return { sprintId: `s${index}`, index, writeSet, dependencies };
}

describe('F5b - overlap deterministico dos write-sets (D-2)', () => {
  it('globsCanOverlap: literais distintos disjuntos; curinga/igual = overlap', () => {
    expect(globsCanOverlap('src/a/**', 'src/b/**')).toBe(false);
    expect(globsCanOverlap('frontend/**', 'backend/**')).toBe(false);
    expect(globsCanOverlap('src/a/**', 'src/a/x.ts')).toBe(true);
    expect(globsCanOverlap('*/a/**', 'src/a/**')).toBe(true);
    expect(globsCanOverlap('**', 'backend/x.ts')).toBe(true);
    expect(globsCanOverlap('lib/util.ts', 'lib/util.ts')).toBe(true);
  });

  it('sprintWriteSetsDisjoint: disjunto comprovado true; vazio/glob-tudo false', () => {
    expect(sprintWriteSetsDisjoint(['src/a/**'], ['src/b/**'])).toBe(true);
    expect(sprintWriteSetsDisjoint(['frontend/**'], ['backend/**'])).toBe(true);
    expect(sprintWriteSetsDisjoint(['src/a/**'], ['src/a/x.ts'])).toBe(false);
    expect(sprintWriteSetsDisjoint([], ['src/b/**'])).toBe(false);
    expect(sprintWriteSetsDisjoint(['src/a/**'], [])).toBe(false);
    expect(sprintWriteSetsDisjoint(['**'], ['src/b/**'])).toBe(false);
  });

  it('SEQUENCIAL-ONLY: worktree-por-sprint removida -> cada sprint vira seu proprio batch', () => {
    const sprints = [
      sprint(0, ['a/**']),
      sprint(1, ['b/**']),
      sprint(2, ['c/**']),
    ];
    const groups = partitionSprintsForParallel(sprints);
    expect(WORKFLOW_PARALLEL_SPRINT_CAP).toBe(3);
    expect(groups).toEqual([
      { sprintIds: ['s0'] },
      { sprintIds: ['s1'] },
      { sprintIds: ['s2'] },
    ]);
  });

  it('SEQUENCIAL-ONLY: o cap nao reagrupa - 4 sprints viram 4 batches de 1', () => {
    const sprints = [
      sprint(0, ['a/**']),
      sprint(1, ['b/**']),
      sprint(2, ['c/**']),
      sprint(3, ['d/**']),
    ];
    const groups = partitionSprintsForParallel(sprints);
    expect(groups).toEqual([
      { sprintIds: ['s0'] },
      { sprintIds: ['s1'] },
      { sprintIds: ['s2'] },
      { sprintIds: ['s3'] },
    ]);
  });

  it('AMBIGUIDADE (write-set vazio) -> 1 sprint por batch (sequencial)', () => {
    const sprints = [sprint(0, []), sprint(1, []), sprint(2, [])];
    const groups = partitionSprintsForParallel(sprints);
    expect(groups).toEqual([
      { sprintIds: ['s0'] },
      { sprintIds: ['s1'] },
      { sprintIds: ['s2'] },
    ]);
  });

  it('DEPENDENCIA respeitada: a ordem dos batches segue o index/dependencia', () => {
    const sprints = [
      sprint(0, ['a/**']),
      sprint(1, ['b/**'], ['s0']), // depende de s0
    ];
    const groups = partitionSprintsForParallel(sprints);
    expect(groups).toEqual([{ sprintIds: ['s0'] }, { sprintIds: ['s1'] }]);
  });

  it('DETERMINISTICO: mesma entrada -> mesma particao (idempotente no resume)', () => {
    const sprints = [
      sprint(2, ['c/**']),
      sprint(0, ['a/**']),
      sprint(1, ['b/**']),
    ];
    const a = partitionSprintsForParallel(sprints);
    const b = partitionSprintsForParallel(sprints);
    expect(a).toEqual(b);
    expect(a).toEqual([
      { sprintIds: ['s0'] },
      { sprintIds: ['s1'] },
      { sprintIds: ['s2'] },
    ]);
  });
});

describe('F5b - raiz curta + branch sanitizada + backoff de lock (6.2.3)', () => {
  it('shortRunId: deterministico, 6-8 chars hex, clampado', () => {
    const a = shortRunId('20260614_010203-abc123');
    const b = shortRunId('20260614_010203-abc123');
    expect(a).toBe(b); // deterministico
    expect(a).toMatch(/^[0-9a-f]{7}$/); // default 7
    expect(shortRunId('x', 6)).toMatch(/^[0-9a-f]{6}$/);
    expect(shortRunId('x', 99)).toMatch(/^[0-9a-f]{8}$/); // clamp em 8
    expect(shortRunId('x', 1)).toMatch(/^[0-9a-f]{6}$/); // clamp em 6
  });

  it('sanitizeBranchSegment: remove char invalido no Windows', () => {
    expect(sanitizeBranchSegment('ok_name-1.2')).toBe('ok_name-1.2');
    expect(sanitizeBranchSegment('bad:name?<>|*')).toBe('bad-name');
    expect(sanitizeBranchSegment('--lead--trail--')).toBe('lead-trail');
  });

  it('sprintBranchName: dynworkflow/<runId>-s<idx> sanitizado, sem aninhar sob o branch do run (SM-24)', () => {
    const branch = sprintBranchName('20260614_010203-abc', 2);
    expect(branch).toBe('dynworkflow/20260614_010203-abc-s2');
    const dirty = sprintBranchName('a:b?c', 0);
    expect(dirty).toBe('dynworkflow/a-b-c-s0');
    expect(dirty).not.toMatch(/[:?<>|*]/);
  });

  it('raiz CURTA sob o projeto, NAO o runDir longo; fallback temp quando estoura', () => {
    const projectShort = '/p';
    const short = defaultSprintWorktreePath(projectShort, 'run-xyz', 1);
    const normalizedShort = short.replaceAll('\\', '/');
    expect(normalizedShort).toContain('/.lionclaw/wf/');
    expect(normalizedShort).not.toContain('/workflows/');
    expect(normalizedShort.endsWith('/s1')).toBe(true);

    const deepProject = '/' + 'x'.repeat(200);
    const chosen = chooseSprintWorktreePath(deepProject, 'run-xyz', 0, 150);
    expect(chosen.fellBackToTemp).toBe(true);
    expect(chosen.path).toBe(tempSprintWorktreePath('run-xyz', 0));

    const ok = chooseSprintWorktreePath(projectShort, 'run-xyz', 0, 150);
    expect(ok.fellBackToTemp).toBe(false);
    expect(ok.path).toBe(defaultSprintWorktreePath(projectShort, 'run-xyz', 0));
  });

  it('isGitLockError detecta index.lock / ref lock; ignora outros erros', () => {
    expect(isGitLockError({ code: 1, stdout: '', stderr: 'fatal: Unable to create .git/index.lock' })).toBe(true);
    expect(isGitLockError({ code: 128, stdout: '', stderr: 'cannot lock ref refs/heads/x' })).toBe(true);
    expect(isGitLockError({ code: 0, stdout: '', stderr: '' })).toBe(false);
    expect(isGitLockError({ code: 1, stdout: '', stderr: 'fatal: not a git repository' })).toBe(false);
  });

  it('runGitWithBackoff: re-tenta SO em lock; retorna na hora em outro erro', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    let calls = 0;
    const lockyGit: GitRunner = async () => {
      calls++;
      if (calls < 3) return { code: 1, stdout: '', stderr: 'Unable to create index.lock' };
      return { code: 0, stdout: 'ok', stderr: '' };
    };
    const res = await runGitWithBackoff(['worktree', 'add'], '/repo', lockyGit, {
      maxAttempts: 4,
      baseDelayMs: 10,
      sleep,
    });
    expect(res.code).toBe(0);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]);

    sleeps.length = 0;
    let nonLockCalls = 0;
    const failGit: GitRunner = async () => {
      nonLockCalls++;
      return { code: 1, stdout: '', stderr: 'fatal: not a git repository' };
    };
    const res2 = await runGitWithBackoff(['status'], '/repo', failGit, { maxAttempts: 4, sleep });
    expect(res2.code).toBe(1);
    expect(nonLockCalls).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe('F5b - merge ORDENADO por sprint (closer, 8.6.2 / D-3)', () => {
  function makeFakeGit(opts: { conflictBranches?: Set<string>; baseAdvanced?: boolean } = {}): {
    git: GitRunner;
    cmds: string[][];
  } {
    const cmds: string[][] = [];
    const conflict = opts.conflictBranches ?? new Set<string>();
    const git: GitRunner = async (args) => {
      cmds.push(args);
      const ok = (stdout = ''): GitRunResult => ({ code: 0, stdout, stderr: '' });
      if (args[0] === 'rev-parse') return ok('basehead0000000000000000000000000000000');
      if (args[0] === 'rev-list') return ok(opts.baseAdvanced ? '2' : '1'); // ahead count
      if (args[0] === 'branch') return ok('feedfacefeedfacefeedfacefeedfacefeedface');
      if (args[0] === 'checkout') return ok();
      if (args[0] === 'worktree') return ok();
      if (args[0] === 'reset') return ok();
      if (args[0] === 'merge' && args[1] === '--squash') {
        const runBranch = args[2];
        if (conflict.has(runBranch)) return { code: 1, stdout: '', stderr: 'CONFLICT' };
        return ok();
      }
      if (args[0] === 'merge') return ok();
      if (args[0] === 'diff' && args.includes('--quiet')) return { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'diff' && args.includes('--diff-filter=U')) return ok('shared/x.ts');
      if (args[0] === 'commit') return ok();
      if (args[0] === 'config') return ok();
      return ok();
    };
    return { git, cmds };
  }

  function target(index: number, overrides: Partial<SprintMergeTarget> = {}): SprintMergeTarget {
    return {
      sprintId: `s${index}`,
      index,
      branch: `dynworkflow/run-1/s${index}`,
      baseSha: 'base0000000000000000000000000000000000000',
      worktreePath: `/p/.lionclaw/wf/abc1234/s${index}`,
      ...overrides,
    };
  }

  function makeDeps(
    git: GitRunner,
    patches: Array<{ sprintId: string; patch: DynamicWorkflowSprintPatch }>,
    cleaned: number[],
  ): OrderedMergeDeps {
    return {
      repoRoot: '/p',
      baseBranch: 'main',
      name: 'wf',
      runId: 'run-1',
      git,
      updateSprintMerge: (_runId, sprintId, patch) => patches.push({ sprintId, patch }),
      cleanupSprint: async (input) => {
        cleaned.push(input.sprintIndex);
      },
    };
  }

  it('merge ORDENADO: processa por index, marca merging->merged, atualiza mergeStatus', async () => {
    const { git } = makeFakeGit();
    const patches: Array<{ sprintId: string; patch: DynamicWorkflowSprintPatch }> = [];
    const cleaned: number[] = [];
    const report = await mergeSprintsOrdered(
      [target(2), target(0), target(1)],
      makeDeps(git, patches, cleaned),
    );
    expect(report.allMerged).toBe(true);
    expect(report.sprints.map((s) => s.sprintId)).toEqual(['s0', 's1', 's2']);
    expect(report.sprints.every((s) => s.mergeStatus === 'merged')).toBe(true);
    const s0Statuses = patches.filter((p) => p.sprintId === 's0').map((p) => p.patch.mergeStatus);
    expect(s0Statuses).toContain('merging');
    expect(s0Statuses).toContain('merged');
    expect(cleaned.sort()).toEqual([0, 1, 2]);
  });

  it('conflito numa sprint PARA a sequencia (nunca auto-resolve); marca conflict', async () => {
    const { git } = makeFakeGit({ conflictBranches: new Set(['dynworkflow/run-1/s1']) });
    const patches: Array<{ sprintId: string; patch: DynamicWorkflowSprintPatch }> = [];
    const cleaned: number[] = [];
    const report = await mergeSprintsOrdered(
      [target(0), target(1), target(2)],
      makeDeps(git, patches, cleaned),
    );
    expect(report.allMerged).toBe(false);
    expect(report.conflictedSprintId).toBe('s1');
    const byId = Object.fromEntries(report.sprints.map((s) => [s.sprintId, s.mergeStatus]));
    expect(byId['s0']).toBe('merged');
    expect(byId['s1']).toBe('conflict');
    expect(byId['s2']).toBeUndefined();
    expect(cleaned).toEqual([0]);
    const s1Last = patches.filter((p) => p.sprintId === 's1').pop();
    expect(s1Last?.patch.mergeStatus).toBe('conflict');
  });

  it('sprint sem branch/worktree (so leitor) vira skipped, nao mergeia', async () => {
    const { git } = makeFakeGit();
    const patches: Array<{ sprintId: string; patch: DynamicWorkflowSprintPatch }> = [];
    const cleaned: number[] = [];
    const report = await mergeSprintsOrdered(
      [target(0, { branch: '', worktreePath: null })],
      makeDeps(git, patches, cleaned),
    );
    expect(report.sprints[0].mergeStatus).toBe('skipped');
    expect(report.allMerged).toBe(true); // skipped conta como terminal sem conflito
    expect(cleaned).toEqual([]); // nada a limpar
    expect(patches.pop()?.patch.mergeStatus).toBe('skipped');
  });

  function makeAdvancingBaseGit(): {
    git: GitRunner;
    stagingBranches: string[];
    ffMerges: string[];
    currentBranch: { name: string };
  } {
    const baseSha = 'base0000000000000000000000000000000000000';
    let baseTip = baseSha; // tip da branch base; avanca no 1o commit-na-base
    let onBranch = 'main';
    const stagingBranches: string[] = [];
    const ffMerges: string[] = [];
    const currentBranch = { name: 'main' };
    const ok = (stdout = ''): GitRunResult => ({ code: 0, stdout, stderr: '' });
    const git: GitRunner = async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        const ref = args[3] ?? '';
        if (ref === 'refs/heads/main') return ok(baseTip);
        return ok('stagingtip00000000000000000000000000000');
      }
      if (args[0] === 'rev-parse') {
        return onBranch === 'main' ? ok(baseTip) : ok('stagingtip00000000000000000000000000000');
      }
      if (args[0] === 'rev-list') return ok('1');
      if (args[0] === 'branch') {
        if (args[1] === '-f' && typeof args[2] === 'string') stagingBranches.push(args[2]);
        return ok();
      }
      if (args[0] === 'checkout') {
        onBranch = String(args[1]);
        currentBranch.name = onBranch;
        return ok();
      }
      if (args[0] === 'merge' && args[1] === '--ff-only') {
        ffMerges.push(String(args[2]));
        baseTip = 'stagingtip00000000000000000000000000000';
        return ok();
      }
      if (args[0] === 'merge') return ok();
      if (args.includes('commit')) {
        if (onBranch === 'main') baseTip = 'advancedbase00000000000000000000000000000';
        return ok();
      }
      if (args[0] === 'diff' && args.includes('--quiet')) return { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'worktree' || args[0] === 'reset' || args[0] === 'config') return ok();
      return ok();
    };
    return { git, stagingBranches, ffMerges, currentBranch };
  }

  it('BLOCKER: sprint staged (base ja andou) e CONCLUIDA na base, nao abandonada (8.6 dinheiro nao evapora)', async () => {
    const { git, stagingBranches, ffMerges } = makeAdvancingBaseGit();
    const patches: Array<{ sprintId: string; patch: DynamicWorkflowSprintPatch }> = [];
    const cleaned: number[] = [];
    const report = await mergeSprintsOrdered(
      [target(0), target(1), target(2)],
      makeDeps(git, patches, cleaned),
    );
    expect(report.allMerged).toBe(true);
    expect(report.sprints.map((s) => s.mergeStatus)).toEqual(['merged', 'merged', 'merged']);
    expect(ffMerges.length).toBeGreaterThanOrEqual(2);
    expect(new Set(stagingBranches).size).toBe(stagingBranches.length);
    expect(stagingBranches).toEqual(
      expect.arrayContaining(['dynworkflow-staging/run-1/s1', 'dynworkflow-staging/run-1/s2']),
    );
    expect(cleaned.sort()).toEqual([0, 1, 2]);
  });

  it('BLOCKER: re-check VERMELHO numa sprint staged trata como conflito (worktree viva, sequencia para)', async () => {
    const { git, ffMerges } = makeAdvancingBaseGit();
    const patches: Array<{ sprintId: string; patch: DynamicWorkflowSprintPatch }> = [];
    const cleaned: number[] = [];
    const deps: OrderedMergeDeps = {
      ...makeDeps(git, patches, cleaned),
      runStagedRechecks: async (sprintId) => sprintId !== 's1',
    };
    const report = await mergeSprintsOrdered([target(0), target(1), target(2)], deps);
    expect(report.allMerged).toBe(false);
    expect(report.conflictedSprintId).toBe('s1');
    const byId = Object.fromEntries(report.sprints.map((s) => [s.sprintId, s.mergeStatus]));
    expect(byId['s0']).toBe('merged'); // squashou direto
    expect(byId['s1']).toBe('conflict'); // re-check vermelho
    expect(byId['s2']).toBeUndefined(); // sequencia parou
    expect(ffMerges).toEqual([]);
    expect(cleaned).toEqual([0]);
  });
});


const MANUAL_PATH_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: '`${__dirname}/...`', re: /\$\{\s*__dirname\s*\}\//},
  {
    label: '`${<ident>Path|<ident>Dir}/...`',
    re: /\$\{\s*[A-Za-z_$][A-Za-z0-9_$]*(?:Path|Dir)\s*\}\//,
  },
  { label: "__dirname + '/'", re: /__dirname\s*\+\s*['"]\// },
  {
    label: "<ident>Path|<ident>Dir + '/'",
    re: /\b[A-Za-z_$][A-Za-z0-9_$]*(?:Path|Dir)\s*\+\s*['"]\//,
  },
];

function collectDomainTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectDomainTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function isCommentOnlyLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

describe('FX cross-platform: sweep de construcao manual de path no dominio (SPEC 6.2.1)', () => {
  const domainDir = join(dirname(__dirname), 'dynamic-workflows');

  it('nenhum arquivo do dominio constroi path a mao (template ${...}/, __dirname+/, *Path+/, *Dir+/)', () => {
    const files = collectDomainTsFiles(domainDir);
    expect(files.length).toBeGreaterThan(10); // sanidade: achou o dominio
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, idx) => {
        if (isCommentOnlyLine(line)) return; // comentario nao constroi path
        if (line.includes('://')) return; // URL (protocolo://host) nao e path local
        for (const { label, re } of MANUAL_PATH_PATTERNS) {
          if (re.test(line)) {
            violations.push(`${file}:${idx + 1} [${label}] -> ${line.trim()}`);
          }
        }
      });
    }
    expect(violations, `construcao manual de path encontrada:\n${violations.join('\n')}`).toEqual(
      [],
    );
  });

  it('o sweep DETECTA os padroes proibidos (guarda contra regex morta)', () => {
    const positives = [
      'return `${projectPath}/.lionclaw/workflows/${runId}`;',
      "return `${__dirname}/${SANDBOX_CHILD_ENTRY_BASENAME}`;",
      "const e = __dirname + '/' + base;",
      "const p = worktreePath + '/' + sub;",
      'const d = `${rootDir}/sub`;',
    ];
    for (const sample of positives) {
      const hit = MANUAL_PATH_PATTERNS.some((p) => p.re.test(sample));
      expect(hit, `deveria detectar: ${sample}`).toBe(true);
    }
    const negatives = [
      "const url = `https://api.example.com/${id}/x`;",
      "join(projectPath, '.lionclaw', 'workflows', runId);",
      "resolveArtifactPath(runDir, `${CHECKPOINTS_SUBDIR}/${name}.json`);",
      'if (w.startsWith(`${p}/`)) return true;',
      "const mcp = 'lionclaw-dynamic-workflows/index';",
      "const glob = 'src/**/*.ts';",
      "const branch = `dynworkflow/${runId}/s${i}`;",
    ];
    for (const sample of negatives) {
      const hit = MANUAL_PATH_PATTERNS.some((p) => p.re.test(sample));
      expect(hit, `nao deveria detectar: ${sample}`).toBe(false);
    }
  });
});

describe('FX cross-platform: resolveSandboxChildEntry asar-aware (SPEC 6.2.1)', () => {
  it('dev/packaged comum: usa o entry ao lado do modulo (__dirname), sem template', () => {
    const dir = join('home', 'app', 'dist', 'main');
    const entry = resolveSandboxChildEntry(dir, undefined);
    expect(entry).toBe(join(dir, 'workflow-sandbox-child.js'));
    expect(entry.endsWith('workflow-sandbox-child.js')).toBe(true);
  });

  it('packaged asar-unpacked: deriva o candidato app.asar.unpacked quando o ao-lado nao existe', () => {
    const root = join(__dirname, '__fx_fixture__'); // raiz absoluta deterministica
    const insideAsar = join(root, 'Resources', 'app.asar', 'dist', 'main');
    const appPath = join(root, 'Resources', 'app.asar');
    const unpacked = join(
      root,
      'Resources',
      'app.asar.unpacked',
      'dist',
      'main',
      'workflow-sandbox-child.js',
    );
    const exists = (p: string): boolean => p === unpacked;
    const entry = resolveSandboxChildEntry(insideAsar, appPath, exists);
    expect(entry).toBe(unpacked);
  });

  it('packaged prefere unpacked mesmo quando o arquivo virtual dentro do ASAR também existe', () => {
    const root = join(__dirname, '__fx_fixture__');
    const insideAsar = join(root, 'Resources', 'app.asar', 'dist', 'main');
    const appPath = join(root, 'Resources', 'app.asar');
    const virtual = join(insideAsar, 'workflow-sandbox-child.js');
    const unpacked = join(
      root,
      'Resources',
      'app.asar.unpacked',
      'dist',
      'main',
      'workflow-sandbox-child.js',
    );
    const entry = resolveSandboxChildEntry(
      insideAsar,
      appPath,
      (candidate) => candidate === virtual || candidate === unpacked,
    );
    expect(entry).toBe(unpacked);
  });

  it('packaged: cai no candidato derivado de app.getAppPath()/dist/main quando o ao-lado nao existe', () => {
    const root = join(__dirname, '__fx_fixture__'); // raiz absoluta deterministica
    const dir = join(root, 'some', 'weird', 'wrapper');
    const appPath = join(root, 'opt', 'lionclaw', 'resources', 'app');
    const target = join(appPath, 'dist', 'main', 'workflow-sandbox-child.js');
    const exists = (p: string): boolean => p === target;
    const entry = resolveSandboxChildEntry(dir, appPath, exists);
    expect(entry).toBe(target);
  });

  it('fallback determinístico: nenhum candidato existe -> primeiro (ao lado do modulo)', () => {
    const dir = join('x', 'y');
    const entry = resolveSandboxChildEntry(dir, undefined, () => false);
    expect(entry).toBe(join(dir, 'workflow-sandbox-child.js'));
  });
});

describe('FX cross-platform: normalizeLineEndings + compile (SPEC 6.2.4)', () => {
  it('CRLF e CR solto viram LF; LF puro fica intacto; idempotente', () => {
    expect(normalizeLineEndings('a\r\nb\r\nc')).toBe('a\nb\nc');
    expect(normalizeLineEndings('a\rb\rc')).toBe('a\nb\nc');
    expect(normalizeLineEndings('a\nb\nc')).toBe('a\nb\nc');
    const once = normalizeLineEndings('x\r\ny\rz');
    expect(normalizeLineEndings(once)).toBe(once); // idempotente
  });

  it('compileWorkflowJs aceita fonte CRLF (Windows) e emite transformedSource em LF', () => {
    const lf = [
      "export const meta = { name: 'wf', description: 'crlf', phases: ['p'] };",
      "await log('oi');",
      'return { ok: true };',
      '',
    ].join('\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    const r = compileWorkflowJs(crlf);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.transformedSource.includes('\r')).toBe(false); // sem CR no vm source
      expect(r.meta.name).toBe('wf');
    }
  });
});
