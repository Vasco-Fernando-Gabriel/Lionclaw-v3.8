
import { describe, it, expect } from 'vitest';
import {
  createWorkflowHostApi,
  isUserQuestionTool,
  type HostApiRunContext,
  type HostApiCrud,
  type HostApiDeps,
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
  DynamicWorkflowStreamChunk,
} from '../dynamic-workflows/types';
import type { NodeRunResult, RunNodeAgentInput } from '../dynamic-workflows/workflow-agent-adapter';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const USER_QUESTION_TOOL = 'mcp__lionclaw-user-question__ask_user_question';

interface CapturedEvent {
  type: string;
  nodeId?: string | null;
  payload?: unknown;
}

interface Harness {
  deps: HostApiDeps;
  events: CapturedEvent[];
  streamChunks: DynamicWorkflowStreamChunk[];
}

function makeHarness(adapter: (input: RunNodeAgentInput) => Promise<NodeRunResult>): Harness {
  const nodeRuns = new Map<string, DynamicWorkflowNodeRun>();
  const events: CapturedEvent[] = [];
  const streamChunks: DynamicWorkflowStreamChunk[] = [];
  let eventSeq = 0;

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
        createdAt: '2026-06-13T00:00:00.000Z',
      };
    },
    insertGateDecision: (() => {
      throw new Error('nao usado');
    }) as HostApiCrud['insertGateDecision'],
    registerArtifact: (() => {
      throw new Error('nao usado');
    }) as HostApiCrud['registerArtifact'],
    getRunCheckpoint: () => '{}',
    persistRunCheckpoint: () => undefined,
    addRunCost: () => undefined,
    patchRun: () => undefined,
  };

  const gateGate: GateGate = {
    awaitDecision: () => new Promise<PendingGateResolution>(() => undefined),
  };

  const deps: HostApiDeps = {
    crud,
    gateGate,
    runNodeAgent: (input) => adapter(input),
    emit: (input) =>
      events.push({ type: input.type, nodeId: input.nodeId, payload: input.payload }),
    emitStreamChunk: (chunk) => streamChunks.push(chunk),
    generateId: (prefix) => `${prefix}_${nodeRuns.size}`,
    now: () => '2026-06-13T00:00:00.000Z',
  };

  return { deps, events, streamChunks };
}

function manifest(): DynamicWorkflowManifest {
  return {
    version: 1,
    name: 'wf',
    phases: [{ id: 'Ask', name: 'Ask', order: 0 }],
    nodes: [
      {
        id: 'asker',
        type: 'agent',
        phaseId: 'Ask',
        agentId: 'a-asker',
        access: 'read-only',
        allowedMcpServers: ['lionclaw-user-question'],
        canResume: true,
        produces: ['a'],
        consumes: [],
      },
      {
        id: 'silent',
        type: 'agent',
        phaseId: 'Ask',
        agentId: 'a-silent',
        access: 'read-only',
        canResume: true,
        produces: ['s'],
        consumes: [],
      },
    ],
    parallelism: { maxConcurrentAgents: 1, parallelWritersAllowed: false },
    gates: [],
    estimate: { minUsd: 0, maxUsd: 0, unknownCostNodes: [] },
  };
}

function okResult(input: RunNodeAgentInput): NodeRunResult {
  return {
    ok: true,
    output: '{"ok":true}',
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
      access: 'read-only',
      allowedTools: [],
      deniedTools: [],
      allowedMcpServers: input.grants.allowedMcpServers ?? [],
      allowedMcpTools: [],
      allowedCommands: [],
      effectiveTools: [],
      effectiveMcpServers: input.grants.allowedMcpServers ?? [],
      policyHash: 'h',
      allowBash: false,
      allowNetwork: false,
      timeoutMs: 1000,
      idleTimeoutMs: 1000,
      costCeilingUsd: 0,
    },
    mechanism: 'canUseTool',
    durationMs: 1,
  };
}

function makeCtx(): HostApiRunContext {
  const runDir = mkdtempSync(join(tmpdir(), 'dwf-qp-'));
  return {
    runId: 'run-1',
    manifest: manifest(),
    workspaceRoot: runDir,
    runDir,
    abortSignal: new AbortController().signal,
  };
}

describe('isUserQuestionTool', () => {
  it('casa o tool do server lionclaw-user-question', () => {
    expect(isUserQuestionTool(USER_QUESTION_TOOL)).toBe(true);
    expect(isUserQuestionTool('mcp__lionclaw-user-question__ask_user_question')).toBe(true);
    expect(isUserQuestionTool('Read')).toBe(false);
    expect(isUserQuestionTool('mcp__google-calendar__list')).toBe(false);
    expect(isUserQuestionTool(undefined)).toBe(false);
  });
});

describe('question-pending / question-resolved (Parte B)', () => {
  it('node com grant: start -> question-pending, fim -> question-resolved', async () => {
    const h = makeHarness(async (input) => {
      input.onStreamChunk?.({ type: 'tool_call_start', toolName: USER_QUESTION_TOOL });
      input.onStreamChunk?.({ type: 'tool_call', toolName: USER_QUESTION_TOOL, content: 'q' });
      return okResult(input);
    });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);

    await api.agent({
      id: 'asker',
      agentId: 'a-asker',
      access: 'read-only',
      prompt: 'Devo seguir com a abordagem A ou B?',
    });

    const pending = h.events.find((e) => e.type === 'question-pending');
    const resolved = h.events.find((e) => e.type === 'question-resolved');
    expect(pending).toBeTruthy();
    expect(pending!.nodeId).toBe('asker');
    expect((pending!.payload as { prompt?: string }).prompt).toContain('abordagem A ou B');
    expect(resolved).toBeTruthy();
    expect(resolved!.nodeId).toBe('asker');
    expect(h.events.indexOf(pending!)).toBeLessThan(h.events.indexOf(resolved!));

    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('tool_call_start NAO vira chunk de stream do node (so text/tool_call)', async () => {
    const h = makeHarness(async (input) => {
      input.onStreamChunk?.({ type: 'tool_call_start', toolName: USER_QUESTION_TOOL });
      input.onStreamChunk?.({ type: 'text', content: 'pensando' });
      input.onStreamChunk?.({ type: 'tool_call', toolName: USER_QUESTION_TOOL, content: 'q' });
      return okResult(input);
    });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.agent({ id: 'asker', agentId: 'a-asker', access: 'read-only', prompt: 'p' });

    expect(h.streamChunks.every((c) => c.type !== ('tool_call_start' as unknown))).toBe(true);
    expect(h.streamChunks.some((c) => c.type === 'text')).toBe(true);
    expect(h.streamChunks.some((c) => c.type === 'tool_call')).toBe(true);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });

  it('node SEM grant nao emite question-* mesmo chamando alguma tool', async () => {
    const h = makeHarness(async (input) => {
      input.onStreamChunk?.({ type: 'tool_call_start', toolName: 'Read' });
      input.onStreamChunk?.({ type: 'tool_call', toolName: 'Read', content: 'foo' });
      return okResult(input);
    });
    const ctx = makeCtx();
    const api = createWorkflowHostApi(ctx, h.deps);
    await api.agent({ id: 'silent', agentId: 'a-silent', access: 'read-only', prompt: 'p' });

    expect(h.events.some((e) => e.type === 'question-pending')).toBe(false);
    expect(h.events.some((e) => e.type === 'question-resolved')).toBe(false);
    rmSync(ctx.runDir, { recursive: true, force: true });
  });
});
