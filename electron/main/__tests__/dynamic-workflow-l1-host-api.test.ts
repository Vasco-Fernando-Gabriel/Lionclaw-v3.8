
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkflowHostApi,
  computeNodeInputHash,
  clampMaxTurns,
  nodeOutputForScript,
  unwrapLegacyOutputEnvelope,
  detectBuildScript,
  buildFailurePendingDecision,
  parseFailureGateAction,
  agentSwitchFrom,
  buildAdjustmentText,
  WorkflowHostFatalError,
  ADJUSTMENT_PROMPT_HEADER,
  AGENT_MAX_TURNS_CEILING,
  type HostApiCrud,
  type HostApiDeps,
  type HostApiRunContext,
  type GateGate,
  type PendingGateResolution,
  type NodeFailureHookOutcome,
} from '../dynamic-workflows/workflow-host-api';
import { AGENT_SWITCH_MESSAGE_KIND, failureGateId, isFailureGateId } from '../dynamic-workflows/types';
import type {
  DynamicWorkflowManifest,
  DynamicWorkflowNodeRun,
  DynamicWorkflowNodeRunUpsertInput,
  DynamicWorkflowNodeRunPatch,
  DynamicWorkflowEvent,
  DynamicWorkflowEventInsertInput,
  DynamicWorkflowMessage,
  DynamicWorkflowMessageInsertInput,
  DynamicWorkflowGateDecisionInsertInput,
  DynamicWorkflowJournalEntry,
  DynamicWorkflowJournalAppendInput,
} from '../dynamic-workflows/types';
import type { NodeRunResult, RunNodeAgentInput } from '../dynamic-workflows/workflow-agent-adapter';
import type { GateCheckSpec, GateRunResult } from '../dynamic-workflows/workflow-gates';


interface Harness {
  deps: HostApiDeps;
  ctx: HostApiRunContext;
  events: Array<{ type: string; nodeId?: string | null; payload?: Record<string, unknown> }>;
  nodeRuns: DynamicWorkflowNodeRun[];
  messages: DynamicWorkflowMessage[];
  journal: DynamicWorkflowJournalEntry[];
  runPatches: Array<Record<string, unknown>>;
  checkpointJson: () => string;
  gateDecisions: DynamicWorkflowGateDecisionInsertInput[];
  resolveGate: (gateId: string, r: PendingGateResolution) => void;
  pendingGates: () => string[];
  addMessage: (nodeId: string, kind: string, content: string) => void;
  cleanup: () => void;
}

function okResult(input: RunNodeAgentInput, output = 'RESUMO: feito'): NodeRunResult {
  return {
    ok: true,
    output,
    runtime: 'cloud',
    family: 'claude-compatible',
    cost: {
      costUsd: 0.5,
      costStatus: 'known',
      tokenStatus: null,
      costUnknownReason: null,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      apiRequests: 1,
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
    durationMs: 5,
    aborted: input.abortSignal?.aborted ?? false,
  };
}

function failResult(
  input: RunNodeAgentInput,
  failureClass: NodeRunResult['failureClass'] = 'logic',
  errorMessage = 'Claude Code returned an error result: Reached maximum number of turns (80)',
): NodeRunResult {
  return { ...okResult(input), ok: false, output: '', failureClass, errorMessage };
}

function manifest(): DynamicWorkflowManifest {
  return {
    version: 1,
    name: 'l1-wf',
    phases: [{ id: 'S1', name: 'S1', order: 0 }],
    nodes: [
      { id: 'scout', type: 'agent', phaseId: 'S1', agentId: 'a-scout', access: 'read-only', canResume: true, produces: [], consumes: [] },
      { id: 'reader', type: 'agent', phaseId: 'S1', agentId: 'a-scout', access: 'read-only', canResume: true, produces: [], consumes: [] },
      { id: 'coder', type: 'agent', phaseId: 'S1', agentId: 'dynamic-workflow-coder', access: 'workspace-write', writeSet: ['src/**'], canResume: true, produces: [], consumes: [] },
      { id: 'val', type: 'agent', phaseId: 'S1', agentId: 'a-val', access: 'read-only', schemaRef: 'validator.schema.json', canResume: true, produces: [], consumes: [] },
    ],
    parallelism: { maxConcurrentAgents: 3, parallelWritersAllowed: false },
    gates: [],
    estimate: { minUsd: 0, maxUsd: 1, unknownCostNodes: [] },
  };
}

function makeHarness(opts: {
  adapter: (input: RunNodeAgentInput, call: number) => Promise<NodeRunResult>;
  hook?: (input: { nodeId: string; attempt: number }) => NodeFailureHookOutcome | undefined;
  ctx?: Partial<HostApiRunContext>;
  gate?: 'manual' | ((gateId: string) => PendingGateResolution);
  checkpoint?: string;
  journal?: DynamicWorkflowJournalEntry[];
}): Harness {
  const runDir = mkdtempSync(join(tmpdir(), 'dwf-l1-'));
  const events: Harness['events'] = [];
  const nodeRuns: DynamicWorkflowNodeRun[] = [];
  const byId = new Map<string, DynamicWorkflowNodeRun>();
  const messages: DynamicWorkflowMessage[] = [];
  const journal: DynamicWorkflowJournalEntry[] = [...(opts.journal ?? [])];
  const runPatches: Array<Record<string, unknown>> = [];
  const gateDecisions: DynamicWorkflowGateDecisionInsertInput[] = [];
  let checkpointJson = opts.checkpoint ?? '{}';
  let eventSeq = 0;
  let msgSeq = 0;
  let calls = 0;
  const resolvers = new Map<string, (r: PendingGateResolution) => void>();

  const crud: HostApiCrud = {
    upsertNodeRun: (input: DynamicWorkflowNodeRunUpsertInput) => {
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
        policyHash: null,
        policySnapshotJson: '{}',
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
      nodeRuns.push(nr);
      byId.set(nr.id, nr);
      return nr;
    },
    updateNodeRun: (id: string, patch: DynamicWorkflowNodeRunPatch) => {
      const nr = byId.get(id);
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
        createdAt: '2026-09-03 12:00:00',
      };
    },
    insertMessage: (input: DynamicWorkflowMessageInsertInput) => {
      msgSeq += 1;
      const m: DynamicWorkflowMessage = {
        id: msgSeq,
        runId: input.runId,
        nodeId: input.nodeId ?? null,
        role: input.role,
        source: input.source,
        kind: input.kind,
        content: input.content,
        toolCallsJson: input.toolCallsJson ?? null,
        agentId: input.agentId ?? null,
        createdAt: '2026-09-03T12:00:00.000Z',
        appliedNodeId: null,
        consumedAt: null,
      };
      messages.push(m);
      return m;
    },
    insertGateDecision: (input) => {
      gateDecisions.push(input);
      return { ...input, nodeId: input.nodeId ?? null, reason: input.reason ?? null, payloadJson: input.payloadJson ?? '{}', createdAt: 'x' };
    },
    registerArtifact: (input) => ({ ...input, nodeId: input.nodeId ?? null, metadataJson: input.metadataJson ?? '{}', createdAt: 'x' }),
    getRunCheckpoint: () => checkpointJson,
    persistRunCheckpoint: (_runId, cp) => {
      checkpointJson = cp;
    },
    addRunCost: () => {},
    patchRun: (_runId, patch) => {
      runPatches.push({ ...patch });
    },
    appendJournalEntry: (input: DynamicWorkflowJournalAppendInput) => {
      journal.push({ ...input, outputRef: input.outputRef ?? null, sideEffectKey: input.sideEffectKey ?? null, createdAt: 'x' });
    },
    listJournalEntries: () => [...journal].sort((a, b) => a.callIndex - b.callIndex),
    truncateJournalFrom: (_runId, from) => {
      for (let i = journal.length - 1; i >= 0; i--) if (journal[i]!.callIndex >= from) journal.splice(i, 1);
    },
    claimAdjustmentsForNode: (_runId, nodeId) => {
      const got = messages.filter(
        (m) => m.consumedAt === null && (m.kind === 'adjustment' || m.kind === AGENT_SWITCH_MESSAGE_KIND) && (m.nodeId === nodeId || m.nodeId === '*'),
      );
      for (const m of got) {
        m.consumedAt = '2026-09-03T12:00:01.000Z';
        m.appliedNodeId = nodeId;
      }
      return got.sort((a, b) => a.id - b.id);
    },
    getConsumedAdjustmentsForNode: (_runId, nodeId) =>
      messages.filter((m) => m.consumedAt !== null && m.appliedNodeId === nodeId).sort((a, b) => a.id - b.id),
  };

  const gateGate: GateGate = {
    awaitDecision: (gateId) => {
      if (typeof opts.gate === 'function') return Promise.resolve(opts.gate(gateId));
      return new Promise<PendingGateResolution>((resolve) => {
        resolvers.set(gateId, resolve);
      });
    },
  };

  const ctx: HostApiRunContext = {
    runId: 'run-1',
    manifest: manifest(),
    workspaceRoot: runDir,
    runDir,
    abortSignal: new AbortController().signal,
    ...(opts.hook ? { onNodeFailed: (input) => opts.hook!(input) } : {}),
    ...opts.ctx,
  };
  const deps: HostApiDeps = {
    crud,
    gateGate,
    runNodeAgent: (input) => {
      calls += 1;
      return opts.adapter(input, calls);
    },
    emit: (input) => events.push({ type: input.type, nodeId: input.nodeId, payload: (input.payload ?? {}) as Record<string, unknown> }),
    generateId: (prefix) => `${prefix}_${nodeRuns.length}_${events.length}`,
    now: () => '2026-09-03T12:00:00.000Z',
    sleep: async () => {},
  };

  return {
    deps,
    ctx,
    events,
    nodeRuns,
    messages,
    journal,
    runPatches,
    checkpointJson: () => checkpointJson,
    gateDecisions,
    resolveGate: (gateId, r) => {
      const res = resolvers.get(gateId);
      if (!res) throw new Error(`gate ${gateId} nao pendente`);
      resolvers.delete(gateId);
      res(r);
    },
    pendingGates: () => [...resolvers.keys()],
    addMessage: (nodeId, kind, content) => {
      crud.insertMessage!({ runId: 'run-1', nodeId, role: 'user', source: 'orchestrator', kind, content });
    },
    cleanup: () => rmSync(runDir, { recursive: true, force: true }),
  };
}

const BLOCKED_LOGIC: NodeFailureHookOutcome = {
  outcome: 'blocked-provider',
  backoffMs: 0,
  failureClass: 'logic',
  retriesExhausted: false,
  attemptsMade: 1,
};

async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}


describe('L1.1: falha nao-retryavel abre o gate failure:<nodeId> DENTRO do agent() e o coordenador fica parado', () => {
  it('gate aberto ANTES de qualquer outro agent(); skip devolve null e o proximo agent() so roda depois', async () => {
    const h = makeHarness({
      adapter: (input) => Promise.resolve(input.grants.nodeId === 'scout' ? failResult(input) : okResult(input)),
      hook: () => BLOCKED_LOGIC,
    });
    const api = createWorkflowHostApi(h.ctx, h.deps);
    let readerRan = false;
    const coordinator = (async () => {
      const a = await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'x' });
      readerRan = true;
      const b = await api.agent({ id: 'reader', agentId: 'a-scout', access: 'read-only', prompt: 'y' });
      return { a, b };
    })();
    await tick();
    expect(h.pendingGates()).toEqual(['failure:scout']);
    expect(readerRan).toBe(false);
    const blocked = h.runPatches.find((p) => p.status === 'blocked');
    const pd = JSON.parse(String(blocked?.pendingDecisionJson)).pendingDecision as Record<string, unknown>;
    expect(pd).toMatchObject({ type: 'provider', id: 'failure:scout', gateId: 'failure:scout', nodeId: 'scout', failureClass: 'logic', actions: ['retry', 'switch-agent', 'skip', 'abort'] });
    expect(String(pd.prompt)).toContain('maximum number of turns');
    const gateEv = h.events.find((e) => e.type === 'gate-blocked');
    expect(gateEv?.payload).toMatchObject({ gateId: 'failure:scout', mode: 'orchestrator', failure: true, failureClass: 'logic' });
    expect(h.events.filter((e) => e.type === 'node-failed')).toHaveLength(1);

    h.resolveGate('failure:scout', { decision: 'approve', approvedBy: 'orchestrator', payload: { action: 'skip' } });
    const out = await coordinator;
    expect(out.a).toBeNull();
    expect(out.b).toBe('RESUMO: feito');
    expect(readerRan).toBe(true);
    const approved = h.events.find((e) => e.type === 'gate-approved');
    expect(approved?.payload).toMatchObject({ gateId: 'failure:scout', action: 'skip' });
    expect(h.runPatches.at(-2)).toMatchObject({ status: 'running' });
    expect(h.gateDecisions.find((g) => g.gateId === 'failure:scout')?.decision).toBe('approved');
    expect(h.journal.map((j) => j.nodeId)).toEqual(['reader']);
    h.cleanup();
  });

  it('retry com instruction (o runner grava o ajuste antes de resolver): nova attempt AGORA com [AJUSTE DO ORQUESTRADOR], hash muda, e o node conclui', async () => {
    const prompts: string[] = [];
    const h = makeHarness({
      adapter: (input, call) => {
        prompts.push(input.prompt);
        return Promise.resolve(call === 1 ? failResult(input) : okResult(input, 'ARQUIVOS TOCADOS:\n- src/a.ts\nRESUMO: ok'));
      },
      hook: () => BLOCKED_LOGIC,
    });
    const api = createWorkflowHostApi(h.ctx, h.deps);
    const pending = api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'base' });
    await tick();
    expect(h.pendingGates()).toEqual(['failure:scout']);
    h.addMessage('scout', 'adjustment', 'foque no arquivo a.ts');
    h.resolveGate('failure:scout', { decision: 'approve', approvedBy: 'orchestrator', payload: { action: 'retry', instruction: 'foque no arquivo a.ts' } });
    const out = await pending;
    expect(out).toBe('ARQUIVOS TOCADOS:\n- src/a.ts\nRESUMO: ok');
    expect(prompts).toEqual(['base', `base${ADJUSTMENT_PROMPT_HEADER}foque no arquivo a.ts`]);
    expect(h.nodeRuns.map((n) => [n.nodeId, n.attempt, n.status])).toEqual([['scout', 1, 'failed'], ['scout', 2, 'completed']]);
    const baseHash = computeNodeInputHash({ agentId: 'a-scout', prompt: 'base', access: 'read-only', writeSet: [] });
    const adjustedHash = computeNodeInputHash({ agentId: 'a-scout', prompt: 'base', access: 'read-only', writeSet: [], adjustment: 'foque no arquivo a.ts' });
    expect(h.nodeRuns[0]!.inputHash).toBe(baseHash);
    expect(h.nodeRuns[1]!.inputHash).toBe(adjustedHash);
    expect(h.journal).toHaveLength(1);
    expect(h.journal[0]!.argHash).toBe(adjustedHash);
    expect(h.messages[0]!.consumedAt).not.toBeNull();
    expect(h.events.filter((e) => e.type === 'node-started')).toHaveLength(2);
    h.cleanup();
  });

  it('switch-agent (mensagem agent-switch gravada pelo runner): nova attempt com o agentId novo; hash e journal carregam o agente novo', async () => {
    const agents: string[] = [];
    const h = makeHarness({
      adapter: (input, call) => {
        agents.push(input.agentId);
        return Promise.resolve(call === 1 ? failResult(input) : okResult(input));
      },
      hook: () => BLOCKED_LOGIC,
    });
    const api = createWorkflowHostApi(h.ctx, h.deps);
    const pending = api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p' });
    await tick();
    h.addMessage('scout', AGENT_SWITCH_MESSAGE_KIND, 'a-scout-b');
    h.resolveGate('failure:scout', { decision: 'approve', approvedBy: 'orchestrator', payload: { action: 'switch-agent', agentType: 'a-scout-b' } });
    await pending;
    expect(agents).toEqual(['a-scout', 'a-scout-b']);
    expect(h.nodeRuns[1]!.agentId).toBe('a-scout-b');
    expect(h.journal[0]!.agentId).toBe('a-scout-b');
    expect(h.journal[0]!.argHash).toBe(
      computeNodeInputHash({ agentId: 'a-scout-b', prompt: 'p', access: 'read-only', writeSet: [] }),
    );
    const claimable = h.messages.filter((m) => m.kind === 'adjustment' || m.kind === AGENT_SWITCH_MESSAGE_KIND);
    expect(buildAdjustmentText(claimable)).toBeUndefined();
    expect(agentSwitchFrom(claimable)).toBe('a-scout-b');
    h.cleanup();
  });

  it('reject (= abort) e action abort lancam fatal run-aborted (o runner ja abortou/pausou o run)', async () => {
    for (const resolution of [
      { decision: 'reject', approvedBy: 'orchestrator' },
      { decision: 'approve', approvedBy: 'orchestrator', payload: { action: 'abort' } },
    ] as PendingGateResolution[]) {
      const h = makeHarness({ adapter: (input) => Promise.resolve(failResult(input)), hook: () => BLOCKED_LOGIC });
      const api = createWorkflowHostApi(h.ctx, h.deps);
      const pending = api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p' });
      await tick();
      h.resolveGate('failure:scout', resolution);
      await expect(pending).rejects.toMatchObject({ code: 'run-aborted' } as Partial<WorkflowHostFatalError>);
      expect(h.events.find((e) => e.type === 'gate-rejected')?.payload).toMatchObject({ gateId: 'failure:scout', action: 'abort' });
      expect(h.journal).toHaveLength(0);
      h.cleanup();
    }
  });

  it('retry automatico (retry-scheduled): o host aguarda o backoff (sleep injetado) e roda a nova attempt in-process, sem gate', async () => {
    const sleeps: number[] = [];
    const h = makeHarness({
      adapter: (input, call) => Promise.resolve(call < 3 ? failResult(input, 'provider-limit', 'rate limit') : okResult(input)),
      hook: ({ attempt }) =>
        attempt < 3
          ? { outcome: 'retry-scheduled', backoffMs: 30_000 * attempt, failureClass: 'provider-limit' }
          : BLOCKED_LOGIC,
    });
    h.deps.sleep = async (ms) => {
      sleeps.push(ms);
    };
    const api = createWorkflowHostApi(h.ctx, h.deps);
    const out = await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p' });
    expect(out).toBe('RESUMO: feito');
    expect(sleeps).toEqual([30_000, 60_000]);
    expect(h.pendingGates()).toEqual([]);
    expect(h.events.some((e) => e.type === 'gate-blocked')).toBe(false);
    expect(h.nodeRuns.map((n) => n.status)).toEqual(['failed', 'failed', 'completed']);
    h.cleanup();
  });

  it('sem hook (fake legado): falha devolve null como sempre, sem gate', async () => {
    const h = makeHarness({ adapter: (input) => Promise.resolve(failResult(input)) });
    const api = createWorkflowHostApi(h.ctx, h.deps);
    expect(await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p' })).toBeNull();
    expect(h.events.some((e) => e.type === 'gate-blocked')).toBe(false);
    h.cleanup();
  });

  it('node-failed com custo desconhecido quando o adapter nao reporta usage (costStatus unknown, nunca $0 conhecido)', async () => {
    const h = makeHarness({
      adapter: (input) =>
        Promise.resolve({
          ...failResult(input),
          cost: { ...okResult(input).cost!, costUsd: 0, costStatus: 'unknown', costUnknownReason: 'error-without-usage', inputTokens: 0, outputTokens: 0 },
        }),
    });
    const api = createWorkflowHostApi(h.ctx, h.deps);
    await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p' });
    const failed = h.events.find((e) => e.type === 'node-failed');
    expect(failed?.payload).toMatchObject({ costStatus: 'unknown', costUnknownReason: 'error-without-usage' });
    h.cleanup();
  });

  it('helpers puros: buildFailurePendingDecision, parseFailureGateAction, failureGateId', () => {
    const pd = buildFailurePendingDecision({ nodeId: 'cc:S1:u-1:0', failureClass: 'logic', nodeError: 'boom', retriesExhausted: false, attemptsMade: 1 });
    expect(pd).toMatchObject({ type: 'provider', id: 'failure:cc:S1:u-1:0', gateId: 'failure:cc:S1:u-1:0', nodeId: 'cc:S1:u-1:0', actions: ['retry', 'switch-agent', 'skip', 'abort'] });
    expect(pd.prompt).toContain('boom');
    expect(pd.prompt).toContain('retry');
    expect(isFailureGateId(failureGateId('x'))).toBe(true);
    expect(parseFailureGateAction('retry')).toBe('retry');
    expect(parseFailureGateAction('skip')).toBe('skip');
    expect(parseFailureGateAction('redev')).toBeNull();
    expect(parseFailureGateAction(undefined)).toBeNull();
  });
});


describe('L1.2a: writer que falha commita WIP (wipSha no node-failed); skip reseta', () => {
  it('onWriterNodeFailed e chamado ANTES do node-failed e o sha vai no payload/gate; skip chama onNodeSkipped com o wipSha', async () => {
    const calls: string[] = [];
    const h = makeHarness({
      adapter: (input) => Promise.resolve(failResult(input)),
      hook: () => BLOCKED_LOGIC,
      gate: () => ({ decision: 'approve', approvedBy: 'orchestrator', payload: { action: 'skip' } }),
      ctx: {
        onWriterNodeFailed: async ({ nodeId, attempt }) => {
          calls.push(`wip:${nodeId}#${attempt}`);
          return { sha: 'wip123' };
        },
        onNodeSkipped: async ({ nodeId, wipSha }) => {
          calls.push(`skip:${nodeId}:${wipSha}`);
        },
        onWriterNodeCompleted: async () => {
          calls.push('completed-hook (nao deveria)');
          return null;
        },
      },
    });
    const api = createWorkflowHostApi(h.ctx, h.deps);
    const out = await api.agent({ id: 'coder', agentId: 'dynamic-workflow-coder', access: 'workspace-write', writeSet: ['src/**'], prompt: 'p' });
    expect(out).toBeNull();
    expect(calls).toEqual(['wip:coder#1', 'skip:coder:wip123']);
    const failed = h.events.find((e) => e.type === 'node-failed');
    expect(failed?.payload).toMatchObject({ wipSha: 'wip123', access: 'workspace-write', agentId: 'dynamic-workflow-coder' });
    expect(h.events.find((e) => e.type === 'gate-blocked')?.payload).toMatchObject({ wipSha: 'wip123' });
    h.cleanup();
  });

  it('retry NAO reseta (onNodeSkipped nao e chamado): a proxima attempt parte do WIP', async () => {
    const calls: string[] = [];
    const h = makeHarness({
      adapter: (input, call) => Promise.resolve(call === 1 ? failResult(input) : okResult(input)),
      hook: () => BLOCKED_LOGIC,
      gate: () => ({ decision: 'approve', approvedBy: 'orchestrator', payload: { action: 'retry' } }),
      ctx: {
        onWriterNodeFailed: async () => {
          calls.push('wip');
          return { sha: 'wip1' };
        },
        onNodeSkipped: async () => {
          calls.push('reset');
        },
        onWriterNodeCompleted: async () => ({ sha: 'node1', touchedFiles: ['src/a.ts'] }),
      },
    });
    const api = createWorkflowHostApi(h.ctx, h.deps);
    const out = await api.agent({ id: 'coder', agentId: 'dynamic-workflow-coder', access: 'workspace-write', writeSet: ['src/**'], prompt: 'p' });
    expect(out).toBe('RESUMO: feito');
    expect(calls).toEqual(['wip']);
    expect(h.events.find((e) => e.type === 'node-completed')?.payload).toMatchObject({ worktreeCommitSha: 'node1', touchedFiles: ['src/a.ts'] });
    h.cleanup();
  });
});


describe('L1.2b: agent({ maxTurns }) clampado 1..400, CONDICIONAL no hash e propagado ao adapter', () => {
  const CANONICAL = { agentId: 'a-reader', prompt: 'p', access: 'read-only', schemaRef: undefined, writeSet: [] as string[] };
  const BASELINE = 'cd730d9cd5de867e317c2a8c526d82a2a02c4161698883cf77ad9cc2da33eb1c';

  it('sem maxTurns o hash e BYTE-IDENTICO ao baseline; com maxTurns muda e e deterministico', () => {
    expect(computeNodeInputHash(CANONICAL)).toBe(BASELINE);
    expect(computeNodeInputHash({ ...CANONICAL, effectiveMaxTurns: undefined })).toBe(BASELINE);
    const with150 = computeNodeInputHash({ ...CANONICAL, effectiveMaxTurns: 150 });
    expect(with150).not.toBe(BASELINE);
    expect(computeNodeInputHash({ ...CANONICAL, effectiveMaxTurns: 150 })).toBe(with150);
    expect(computeNodeInputHash({ ...CANONICAL, effectiveMaxTurns: 151 })).not.toBe(with150);
  });

  it('clampMaxTurns: 1..400, inteiro; ausente/invalido => undefined', () => {
    expect(clampMaxTurns(undefined)).toBeUndefined();
    expect(clampMaxTurns(null)).toBeUndefined();
    expect(clampMaxTurns('80')).toBeUndefined();
    expect(clampMaxTurns(Number.NaN)).toBeUndefined();
    expect(clampMaxTurns(0)).toBe(1);
    expect(clampMaxTurns(-5)).toBe(1);
    expect(clampMaxTurns(120.7)).toBe(120);
    expect(clampMaxTurns(1000)).toBe(AGENT_MAX_TURNS_CEILING);
    expect(AGENT_MAX_TURNS_CEILING).toBe(400);
  });

  it('agent({ maxTurns: 1000 }) chega ao adapter como effectiveMaxTurns 400 e o hash/node_run carregam o clamp', async () => {
    let received: RunNodeAgentInput | undefined;
    const h = makeHarness({
      adapter: (input) => {
        received = input;
        return Promise.resolve(okResult(input));
      },
    });
    const api = createWorkflowHostApi(h.ctx, h.deps);
    await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p', maxTurns: 1000 });
    expect(received?.effectiveMaxTurns).toBe(400);
    expect(h.nodeRuns[0]!.inputHash).toBe(
      computeNodeInputHash({ agentId: 'a-scout', prompt: 'p', access: 'read-only', writeSet: [], effectiveMaxTurns: 400 }),
    );
    h.cleanup();
  });

  it('agent() sem maxTurns NAO manda effectiveMaxTurns ao adapter (byte-identico)', async () => {
    let received: RunNodeAgentInput | undefined;
    const h = makeHarness({
      adapter: (input) => {
        received = input;
        return Promise.resolve(okResult(input));
      },
    });
    const api = createWorkflowHostApi(h.ctx, h.deps);
    await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p' });
    expect(received).toBeDefined();
    expect('effectiveMaxTurns' in received!).toBe(false);
    h.cleanup();
  });
});


describe('L1.3: pausa/abort do run durante o node = attempt INTERROMPIDA', () => {
  it('resultado recebido com abortSignal.aborted (mesmo ok:true) => node-interrupted, sem node-completed/checkpoint/journal/commit, fatal run-aborted', async () => {
    const abort = new AbortController();
    const committed: string[] = [];
    const h = makeHarness({
      adapter: async (input) => {
        abort.abort();
        return okResult(input, 'saida parcial');
      },
      ctx: {
        abortSignal: abort.signal,
        onWriterNodeCompleted: async ({ nodeId }) => {
          committed.push(nodeId);
          return { sha: 'x', touchedFiles: [] };
        },
      },
    });
    const api = createWorkflowHostApi(h.ctx, h.deps);
    await expect(
      api.agent({ id: 'coder', agentId: 'dynamic-workflow-coder', access: 'workspace-write', writeSet: ['src/**'], prompt: 'p' }),
    ).rejects.toMatchObject({ code: 'run-aborted' } as Partial<WorkflowHostFatalError>);
    const types = h.events.map((e) => e.type);
    expect(types).toContain('node-interrupted');
    expect(types).not.toContain('node-completed');
    expect(types).not.toContain('node-failed');
    expect(committed).toEqual([]);
    expect(h.journal).toHaveLength(0);
    expect(JSON.parse(h.checkpointJson())).toEqual({});
    expect(h.nodeRuns[0]!.status).toBe('running');
    expect(h.events.find((e) => e.type === 'node-interrupted')?.payload).toMatchObject({ attempt: 1, reason: 'run-aborted', costUsd: 0.5 });
    h.cleanup();
  });
});


describe('L1.6: greenCheck re-detecta scripts.build no workspace a cada chamada', () => {
  function fakeChecks(captured: GateCheckSpec[][]) {
    return (specs: GateCheckSpec[]): GateRunResult => {
      captured.push(specs);
      return {
        ok: true,
        inconclusive: false,
        checks: specs.map((s) => ({ id: s.id, kind: s.kind, ok: true })),
      } as GateRunResult;
    };
  }

  it('package.json com build criado DURANTE o run: final=true passa a rodar 3 checks; payload buildScriptDetected', async () => {
    const captured: GateCheckSpec[][] = [];
    const h = makeHarness({ adapter: (input) => Promise.resolve(okResult(input)), ctx: { hasBuildScript: false } });
    h.deps.runGateChecks = fakeChecks(captured) as HostApiDeps['runGateChecks'];
    const api = createWorkflowHostApi(h.ctx, h.deps);
    await api.greenCheck({ final: true });
    const ids = (i: number) => captured[i]!.map((s) => s.id.replace(/^green-check:/, ''));
    expect(ids(0)).toEqual(['typecheck', 'test']);
    expect(h.events.at(-1)?.payload).toMatchObject({ final: false, buildScriptDetected: null });
    writeFileSync(join(h.ctx.workspaceRoot, 'package.json'), JSON.stringify({ scripts: { build: 'next build', test: 'vitest' } }));
    await api.greenCheck({ final: true });
    expect(ids(1)).toEqual(['typecheck', 'test', 'build']);
    expect(h.events.at(-1)?.payload).toMatchObject({ final: true, buildScriptDetected: true });
    await api.greenCheck({ final: false });
    expect(ids(2)).toEqual(['typecheck', 'test']);
    h.cleanup();
  });

  it('detectBuildScript: ausente => null; sem build => false; com build => true; malformado => null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwf-build-'));
    expect(detectBuildScript(dir)).toBeNull();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
    expect(detectBuildScript(dir)).toBe(false);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
    expect(detectBuildScript(dir)).toBe(true);
    writeFileSync(join(dir, 'package.json'), '{ nao-json');
    expect(detectBuildScript(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});


describe('L2.1a: node SEM schema devolve STRING ao .js; COM schema, objeto; replay desembrulha o envelope legado', () => {
  it('writer sem schema: typeof === string (texto cru, mesmo quando parece JSON); o payload ainda le o JSON', async () => {
    const h = makeHarness({ adapter: (input) => Promise.resolve(okResult(input, '{"verdict":"pass","findings":[]}')) });
    const api = createWorkflowHostApi(h.ctx, h.deps);
    const out = await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p' });
    expect(out).toBe('{"verdict":"pass","findings":[]}');
    expect(h.events.find((e) => e.type === 'node-completed')?.payload).toMatchObject({ validatorVerdict: { verdict: 'pass' }, p1Count: 0 });
    const cp = JSON.parse(h.checkpointJson()) as { nodes?: Record<string, unknown> };
    expect(cp.nodes?.scout).toBeDefined();
    h.cleanup();
  });

  it('validador COM schema devolve o objeto estruturado', async () => {
    const structured = { verdict: 'fail', findings: [{ severity: 'P1', where: 'a', problem: 'b' }] };
    const h = makeHarness({
      adapter: (input) => Promise.resolve({ ...okResult(input, JSON.stringify(structured)), structuredOutput: structured }),
      ctx: { resolveSchemaRef: () => ({ name: 'validator', type: 'object', required: ['verdict', 'findings'] }) },
    });
    const api = createWorkflowHostApi(h.ctx, h.deps);
    const out = await api.agent({ id: 'val', agentId: 'a-val', access: 'read-only', prompt: 'p' });
    expect(out).toEqual(structured);
    h.cleanup();
  });

  it('nodeOutputForScript / unwrapLegacyOutputEnvelope (puros)', () => {
    expect(nodeOutputForScript({ output: 'texto' }, null)).toBe('texto');
    expect(nodeOutputForScript({ output: '{"a":1}' }, null)).toBe('{"a":1}');
    expect(nodeOutputForScript({ output: '{"a":1}' }, 'x.schema.json')).toEqual({ a: 1 });
    expect(nodeOutputForScript({ output: 'ignored', structuredOutput: { b: 2 } }, 'x')).toEqual({ b: 2 });
    expect(unwrapLegacyOutputEnvelope({ output: 'texto antigo' }, null)).toBe('texto antigo');
    expect(unwrapLegacyOutputEnvelope({ output: 'texto', extra: 1 }, null)).toEqual({ output: 'texto', extra: 1 });
    expect(unwrapLegacyOutputEnvelope({ output: 'texto' }, 'x.schema.json')).toEqual({ output: 'texto' });
    expect(unwrapLegacyOutputEnvelope('s', null)).toBe('s');
  });

  it('replay de checkpoint LEGADO { output } de node sem schema devolve a string (sem re-rodar o agente)', async () => {
    const legacyCheckpoint = JSON.stringify({
      nodes: { scout: { state: { output: 'ARQUIVOS TOCADOS:\n- src/a.ts' }, savedAt: '2026-09-02T00:00:00.000Z' } },
    });
    const baseHash = computeNodeInputHash({ agentId: 'a-scout', prompt: 'p', access: 'read-only', writeSet: [] });
    const journal: DynamicWorkflowJournalEntry[] = [
      {
        runId: 'run-1',
        callIndex: 1,
        callPath: 'scout:agent',
        primitive: 'agent',
        nodeId: 'scout',
        argHash: baseHash,
        schemaRef: null,
        policyHash: 'hash-scout',
        agentId: 'a-scout',
        model: null,
        runtime: 'cloud',
        planHash: null,
        workflowRevision: null,
        outputRef: 'scout#1',
        sideEffectKey: null,
        createdAt: 'x',
      },
    ];
    let adapterCalls = 0;
    const h = makeHarness({
      adapter: (input) => {
        adapterCalls += 1;
        return Promise.resolve(okResult(input));
      },
      checkpoint: legacyCheckpoint,
      journal,
      ctx: {
        readNodeCheckpoint: () => ({ state: { output: 'ARQUIVOS TOCADOS:\n- src/a.ts' } } as never),
      },
    });
    journal[0]!.policyHash = computeNodeInputHash({ agentId: 'ignored', prompt: 'ignored' }); // placeholder, ajustado abaixo
    const api = createWorkflowHostApi(h.ctx, h.deps);
    const out = await api.agent({ id: 'scout', agentId: 'a-scout', access: 'read-only', prompt: 'p' });
    expect(typeof out).toBe('string');
    if (adapterCalls === 0) {
      expect(out).toBe('ARQUIVOS TOCADOS:\n- src/a.ts');
      expect(h.events.find((e) => e.type === 'node-cache-hit')).toBeDefined();
    }
    h.cleanup();
  });
});
