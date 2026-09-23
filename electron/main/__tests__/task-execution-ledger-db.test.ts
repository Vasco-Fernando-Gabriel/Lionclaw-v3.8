import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));

vi.mock('../paths', () => ({ getLionClawHome: () => state.root }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, shell: {} }));

import {
  advanceClaimedHarnessProviderAuthCheckpoint,
  createSession,
  claimHarnessProviderAuthCheckpoint,
  completeHarnessProviderAuthCheckpoint,
  finalizeTaskExecutionOnce,
  finalizeRunningTaskExecutionTree,
  finalizeTaskExecutionRootIfIdle,
  getDb,
  getHarnessProjectMetrics,
  getHarnessProviderAuthCheckpoint,
  getHarnessRounds,
  getPipelineMetrics,
  getSession,
  getTaskExecutionRollup,
  initDatabase,
  persistClaimedHarnessEvaluatorCompletion,
  persistHarnessProviderAuthCheckpoint,
  reconcileInterruptedTaskExecutions,
  savePipelinePhaseMetrics,
  startTaskExecution,
  updateSessionTokens,
} from '../db';
import { mergeTaskExecutionMetrics } from '../ipc/enrich';

beforeAll(() => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-ledger-db-'));
  initDatabase();
  createSession('session-1', 'Ledger test');
});

afterAll(() => {
  try {
    getDb().close();
  } catch {}
  fs.rmSync(state.root, { recursive: true, force: true });
});

const root = {
  executionId: 'root-1',
  rootExecutionId: 'root-1',
  parentExecutionId: null,
  executionKind: 'root' as const,
  ownerKind: 'chat' as const,
  ownerId: 'session-1',
  sessionId: 'session-1',
  toolUseId: null,
  agentId: null,
  agentName: 'root',
  model: '',
  description: 'chat turn',
  runtime: null,
  provider: null,
  metadata: { surface: 'test', lane: 'desktop' },
};

const child = {
  executionId: 'child-1',
  rootExecutionId: 'root-1',
  parentExecutionId: 'root-1',
  executionKind: 'subagent' as const,
  ownerKind: 'chat' as const,
  ownerId: 'session-1',
  sessionId: 'session-1',
  toolUseId: 'tool-1',
  agentId: 'coder',
  agentName: 'Coder',
  model: 'gpt-5.6-codex',
  description: 'implementa',
  runtime: 'codex',
  provider: 'openai',
  metadata: { depth: 1 },
};

const finalPayload = {
  status: 'completed' as const,
  summary: 'feito',
  model: 'gpt-5.6-codex',
  runtime: 'codex',
  provider: 'openai',
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 10,
  cacheCreationTokens: 0,
  costUsd: 0.01,
  apiRequests: 1,
  toolUses: 2,
  durationMs: 500,
  costStatus: 'known' as const,
  tokenStatus: 'reported' as const,
  costUnknownReason: null,
  metadata: { requestId: 'request-1', source: 'provider-reported' },
};

describe('task execution ledger helpers', () => {
  it('persiste, reivindica e conclui checkpoint por CAS sem janela de perda', () => {
    const projectId = 'project-auth-checkpoint-cas';
    getDb()
      .prepare(
        `
      INSERT INTO harness_projects (id, name, project_path, spec_path, status, config)
      VALUES (?, 'Auth checkpoint', '/tmp/auth', '/tmp/auth/SPEC.md', 'running', ?)
    `,
      )
      .run(projectId, JSON.stringify({ stack: ['typescript'], custom: 'preservar' }));
    const checkpoint = {
      checkpointId: 'checkpoint-1',
      pauseReason: 'provider-auth' as const,
      provider: 'grok' as const,
      ownerKind: 'pipeline' as const,
      phaseNumber: 14,
      agentId: 'harness-evaluator',
      roundId: 'round-1',
      resume: {
        kind: 'pipeline-run',
        provider: 'grok',
        checkpoint: {
          stage: 'evaluator',
          sprintId: 'sprint-1',
          sprintIndex: 0,
          roundNumber: 1,
          roundId: 'round-1',
          totalRounds: 1,
          aggCoder: { costUsd: 1 },
          aggEvaluator: { costUsd: 0 },
          coderMetrics: { costUsd: 1 },
        },
      },
    };

    expect(persistHarnessProviderAuthCheckpoint(projectId, checkpoint)).toBe(true);
    expect(getHarnessProviderAuthCheckpoint(projectId)).toEqual({ ...checkpoint, claimState: 'pending' });
    expect(getDb().prepare('SELECT status FROM harness_projects WHERE id = ?').get(projectId)).toEqual({
      status: 'paused',
    });
    expect(claimHarnessProviderAuthCheckpoint(projectId, 'checkpoint-errado')).toBeUndefined();
    expect(getHarnessProviderAuthCheckpoint(projectId)).toEqual({ ...checkpoint, claimState: 'pending' });
    expect(claimHarnessProviderAuthCheckpoint(projectId, checkpoint.checkpointId)).toEqual({
      ...checkpoint,
      claimState: 'claimed',
    });
    const advancedResume = {
      ...checkpoint.resume,
      checkpoint: {
        ...checkpoint.resume.checkpoint,
        stage: 'evaluator-completed',
        evaluatorMetrics: { costUsd: 0.5 },
      },
    };
    expect(advanceClaimedHarnessProviderAuthCheckpoint(projectId, 'checkpoint-errado', advancedResume)).toBeUndefined();
    expect(advanceClaimedHarnessProviderAuthCheckpoint(projectId, checkpoint.checkpointId, advancedResume)).toEqual({
      ...checkpoint,
      claimState: 'claimed',
      resume: advancedResume,
    });
    expect(getHarnessProviderAuthCheckpoint(projectId)).toEqual({
      ...checkpoint,
      claimState: 'claimed',
      resume: advancedResume,
    });
    expect(claimHarnessProviderAuthCheckpoint(projectId, checkpoint.checkpointId)).toEqual({
      ...checkpoint,
      claimState: 'claimed',
      resume: advancedResume,
    });
    expect(completeHarnessProviderAuthCheckpoint(projectId, 'checkpoint-errado')).toBe(false);
    expect(getHarnessProviderAuthCheckpoint(projectId)).toEqual({
      ...checkpoint,
      claimState: 'claimed',
      resume: advancedResume,
    });
    expect(completeHarnessProviderAuthCheckpoint(projectId, checkpoint.checkpointId)).toBe(true);
    expect(getHarnessProviderAuthCheckpoint(projectId)).toBeUndefined();
    const config = JSON.parse(
      (getDb().prepare('SELECT config FROM harness_projects WHERE id = ?').get(projectId) as { config: string }).config,
    ) as Record<string, unknown>;
    expect(config).toMatchObject({ stack: ['typescript'], custom: 'preservar' });
  });

  it('commita evaluator, mensagem e checkpoint de forma atomica e idempotente', () => {
    const projectId = 'project-evaluator-boundary';
    getDb()
      .prepare(
        `
      INSERT INTO harness_projects (id, name, project_path, spec_path, status, config)
      VALUES (?, 'Evaluator boundary', '/tmp/eval', '/tmp/eval/SPEC.md', 'running', '{}')
    `,
      )
      .run(projectId);
    getDb()
      .prepare(
        `
      INSERT INTO harness_sprints (id, project_id, sprint_index, sprint_json_id, name, status)
      VALUES ('sprint-evaluator-boundary', ?, 0, 'sprint-1', 'Sprint', 'running')
    `,
      )
      .run(projectId);
    getDb()
      .prepare(
        `
      INSERT INTO harness_rounds (id, sprint_id, round_number)
      VALUES ('round-evaluator-boundary', 'sprint-evaluator-boundary', 1)
    `,
      )
      .run();
    const checkpoint = {
      checkpointId: 'checkpoint-evaluator-boundary',
      pauseReason: 'provider-auth' as const,
      provider: 'grok' as const,
      ownerKind: 'pipeline' as const,
      phaseNumber: 14,
      agentId: 'harness-evaluator',
      roundId: 'round-evaluator-boundary',
      resume: {
        kind: 'pipeline-run',
        provider: 'grok',
        checkpoint: {
          stage: 'evaluator',
          sprintId: 'sprint-evaluator-boundary',
          sprintIndex: 0,
          roundNumber: 1,
          roundId: 'round-evaluator-boundary',
          totalRounds: 1,
          aggCoder: {},
          aggEvaluator: {},
          coderMetrics: {},
        },
      },
    };
    expect(persistHarnessProviderAuthCheckpoint(projectId, checkpoint)).toBe(true);
    expect(claimHarnessProviderAuthCheckpoint(projectId, checkpoint.checkpointId)).toBeDefined();
    const resume = {
      ...checkpoint.resume,
      checkpoint: {
        ...checkpoint.resume.checkpoint,
        stage: 'evaluator-completed',
        evaluatorMetrics: { costUsd: 0.5 },
      },
    };
    const completion = {
      projectId,
      checkpointId: checkpoint.checkpointId,
      roundId: 'round-evaluator-boundary',
      resume,
      round: {
        evaluatorInputTokens: 5,
        evaluatorOutputTokens: 6,
        evaluatorCacheTokens: 1,
        evaluatorCostUsd: 0.5,
        evaluatorDurationMs: 50,
        evaluatorToolUses: 0,
        evaluatorApiRequests: 1,
        verdict: 'pass' as const,
        feedbackSummary: 'aprovado',
        completedAt: '2026-07-18T12:00:00.000Z',
        metadata: { evaluatorCostStatus: 'known' },
      },
      pipelineMessage: {
        projectId,
        phaseNumber: 14,
        role: 'assistant' as const,
        content: 'aprovado',
        sprintIndex: 0,
        roundIndex: 1,
        agentId: 'harness-evaluator',
      },
    };

    expect(persistClaimedHarnessEvaluatorCompletion(completion)?.resume).toEqual(resume);
    expect(persistClaimedHarnessEvaluatorCompletion(completion)?.resume).toEqual(resume);
    expect(getHarnessRounds('sprint-evaluator-boundary')).toEqual([
      expect.objectContaining({ evaluatorCostUsd: 0.5, verdict: 'pass' }),
    ]);
    expect(
      getDb()
        .prepare(
          `
      SELECT COUNT(*) AS total FROM pipeline_messages
      WHERE project_id = ? AND phase_number = 14 AND round_index = 1
    `,
        )
        .get(projectId),
    ).toEqual({ total: 1 });
    expect(getHarnessProviderAuthCheckpoint(projectId)?.resume).toEqual(resume);
  });

  it('persiste raiz + filha e finaliza idempotentemente', () => {
    startTaskExecution(root);
    startTaskExecution(root);
    expect(() =>
      startTaskExecution({
        ...root,
        metadata: { surface: 'forjada' },
      }),
    ).toThrow('idempotente divergente');
    startTaskExecution(child);
    finalizeTaskExecutionOnce('child-1', finalPayload);
    expect(() => finalizeTaskExecutionOnce('child-1', finalPayload)).not.toThrow();
    expect(finalizeTaskExecutionRootIfIdle('root-1')).toBe(true);

    const rows = getDb()
      .prepare(
        `
      SELECT execution_id, root_execution_id, parent_execution_id, execution_kind,
        owner_kind, owner_id, session_id, status, provider, input_tokens,
        output_tokens, cost_status, token_status, metadata
      FROM task_executions
      WHERE root_execution_id = 'root-1'
      ORDER BY execution_kind DESC
    `,
      )
      .all();
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual(
      expect.objectContaining({
        execution_id: 'child-1',
        root_execution_id: 'root-1',
        parent_execution_id: 'root-1',
        execution_kind: 'subagent',
        owner_kind: 'chat',
        owner_id: 'session-1',
        session_id: 'session-1',
        status: 'completed',
        provider: 'openai',
        input_tokens: 100,
        output_tokens: 20,
        cost_status: 'known',
        token_status: 'reported',
        metadata: '{"requestId":"request-1","source":"provider-reported"}',
      }),
    );

    updateSessionTokens('session-1', 10, 5, 0.02);
    expect(getSession('session-1')).toEqual(
      expect.objectContaining({
        inputTokens: 110,
        outputTokens: 25,
        costUsd: 0.03,
      }),
    );

    updateSessionTokens('session-1', 0, 0, 0, {
      costStatus: 'unknown',
      tokenStatus: 'not_reported',
      costUnknownReason: 'no-usage-reported',
    });
    expect(getSession('session-1')).toEqual(
      expect.objectContaining({
        costStatus: 'unknown',
        tokenStatus: 'not_reported',
        unknownCostCount: 1,
        costUnknownReasons: ['no-usage-reported'],
      }),
    );

    startTaskExecution({
      ...child,
      executionId: 'native-task-1',
      executionKind: 'native-task',
      toolUseId: 'native-tool-1',
    });
    finalizeTaskExecutionOnce('native-task-1', {
      ...finalPayload,
      inputTokens: 50,
      outputTokens: 5,
      costUsd: 0.05,
      metadata: { source: 'native-task' },
    });
    expect(getSession('session-1')).toEqual(
      expect.objectContaining({
        inputTokens: 160,
        outputTokens: 30,
        costUsd: 0.08,
      }),
    );
    expect(
      getTaskExecutionRollup({
        ownerKind: 'chat',
        ownerId: 'session-1',
        surface: 'test',
        executionKinds: ['subagent', 'native-task'],
      }).executionIds,
    ).toEqual(['child-1', 'native-task-1']);
  });

  it('reidrata breakdown misto do parent Codex e dos filhos sem double count', () => {
    const sessionId = 'session-mixed-cost';
    const rootExecutionId = 'root-mixed-cost';
    createSession(sessionId, 'Mixed cost');
    updateSessionTokens(sessionId, 10, 5, 0.4, {
      costStatus: 'known',
      tokenStatus: 'reported',
      runtime: 'codex',
      costEstimationKind: 'subscription-equivalent-payg',
    });
    startTaskExecution({
      ...root,
      executionId: rootExecutionId,
      rootExecutionId,
      ownerId: sessionId,
      sessionId,
    });
    for (const entry of [
      {
        id: 'child-mixed-cloud',
        runtime: 'cloud',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        costUsd: 0.2,
        equivalent: false,
      },
      { id: 'child-mixed-grok', runtime: 'grok', provider: 'grok', model: 'grok-4.5', costUsd: 0.3, equivalent: true },
    ]) {
      startTaskExecution({
        ...child,
        executionId: entry.id,
        rootExecutionId,
        parentExecutionId: rootExecutionId,
        ownerId: sessionId,
        sessionId,
        toolUseId: `tool-${entry.id}`,
        runtime: entry.runtime,
        provider: entry.provider,
        model: entry.model,
      });
      finalizeTaskExecutionOnce(entry.id, {
        ...finalPayload,
        runtime: entry.runtime,
        provider: entry.provider,
        model: entry.model,
        costUsd: entry.costUsd,
        metadata: entry.equivalent ? { costEstimationKind: 'subscription-equivalent-payg' } : {},
      });
    }
    expect(finalizeTaskExecutionRootIfIdle(rootExecutionId)).toBe(true);

    expect(getSession(sessionId)).toEqual(
      expect.objectContaining({
        costUsd: 0.9,
        costByRuntime: { codex: 0.4, cloud: 0.2, grok: 0.3 },
        costStatusByRuntime: { codex: 'known', cloud: 'known', grok: 'known' },
        subscriptionEquivalentCost: 0.7,
      }),
    );
  });

  it('persiste e reidrata o parent Grok isolado como equivalente de assinatura', () => {
    const sessionId = 'session-parent-grok';
    createSession(sessionId, 'Parent Grok');
    updateSessionTokens(sessionId, 10, 5, 0.4, {
      costStatus: 'known',
      tokenStatus: 'reported',
      runtime: 'grok',
      costEstimationKind: 'subscription-equivalent-payg',
    });

    expect(getSession(sessionId)).toEqual(
      expect.objectContaining({
        costUsd: 0.4,
        costByRuntime: { grok: 0.4 },
        costStatusByRuntime: { grok: 'known' },
        subscriptionEquivalentCost: 0.4,
      }),
    );
  });

  it('mantem somente a parcela do parent Kimi como equivalente quando o filho e Cloud', () => {
    const sessionId = 'session-parent-kimi-child-cloud';
    const rootExecutionId = 'root-parent-kimi-child-cloud';
    createSession(sessionId, 'Parent Kimi child Cloud');
    updateSessionTokens(sessionId, 10, 5, 0.4, {
      costStatus: 'known',
      tokenStatus: 'reported',
      runtime: 'kimi',
      costEstimationKind: 'subscription-equivalent-payg',
    });
    startTaskExecution({
      ...root,
      executionId: rootExecutionId,
      rootExecutionId,
      ownerId: sessionId,
      sessionId,
    });
    startTaskExecution({
      ...child,
      executionId: 'child-parent-kimi-cloud',
      rootExecutionId,
      parentExecutionId: rootExecutionId,
      ownerId: sessionId,
      sessionId,
      runtime: 'cloud',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    finalizeTaskExecutionOnce('child-parent-kimi-cloud', {
      ...finalPayload,
      runtime: 'cloud',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      costUsd: 0.2,
      metadata: {},
    });
    expect(finalizeTaskExecutionRootIfIdle(rootExecutionId)).toBe(true);

    expect(getSession(sessionId)).toEqual(
      expect.objectContaining({
        costUsd: expect.closeTo(0.6, 10),
        costByRuntime: { kimi: 0.4, cloud: 0.2 },
        costStatusByRuntime: { kimi: 'known', cloud: 'known' },
        subscriptionEquivalentCost: 0.4,
      }),
    );
  });

  it('mantem somente o filho Grok como equivalente quando o parent e Cloud', () => {
    const sessionId = 'session-parent-cloud-child-grok';
    const rootExecutionId = 'root-parent-cloud-child-grok';
    createSession(sessionId, 'Parent Cloud child Grok');
    updateSessionTokens(sessionId, 10, 5, 0.4, {
      costStatus: 'known',
      tokenStatus: 'reported',
      runtime: 'cloud',
    });
    startTaskExecution({
      ...root,
      executionId: rootExecutionId,
      rootExecutionId,
      ownerId: sessionId,
      sessionId,
    });
    startTaskExecution({
      ...child,
      executionId: 'child-parent-cloud-grok',
      rootExecutionId,
      parentExecutionId: rootExecutionId,
      ownerId: sessionId,
      sessionId,
      runtime: 'grok',
      provider: 'grok',
      model: 'grok-4.5',
    });
    finalizeTaskExecutionOnce('child-parent-cloud-grok', {
      ...finalPayload,
      runtime: 'grok',
      provider: 'grok',
      model: 'grok-4.5',
      costUsd: 0.3,
      metadata: { costEstimationKind: 'subscription-equivalent-payg' },
    });
    expect(finalizeTaskExecutionRootIfIdle(rootExecutionId)).toBe(true);

    expect(getSession(sessionId)).toEqual(
      expect.objectContaining({
        costUsd: 0.7,
        costByRuntime: { cloud: 0.4, grok: 0.3 },
        costStatusByRuntime: { cloud: 'known', grok: 'known' },
        subscriptionEquivalentCost: 0.3,
      }),
    );
  });

  it('propaga custo misto dos filhos no enrich sem classificar o total inteiro como assinatura', () => {
    const ownerId = 'enrich-mixed-cost';
    const rootExecutionId = 'root-enrich-mixed-cost';
    startTaskExecution({
      ...root,
      executionId: rootExecutionId,
      rootExecutionId,
      ownerKind: 'enrich',
      ownerId,
      sessionId: null,
      metadata: { surface: 'enrich:validator' },
    });
    const entries = [
      {
        id: 'child-enrich-cloud',
        runtime: 'cloud',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        costUsd: 0.2,
        equivalent: false,
      },
      { id: 'child-enrich-grok', runtime: 'grok', provider: 'grok', model: 'grok-4.5', costUsd: 0.3, equivalent: true },
    ] as const;
    for (const entry of entries) {
      startTaskExecution({
        ...child,
        executionId: entry.id,
        rootExecutionId,
        parentExecutionId: rootExecutionId,
        ownerKind: 'enrich',
        ownerId,
        sessionId: null,
        toolUseId: `tool-${entry.id}`,
        runtime: entry.runtime,
        provider: entry.provider,
        model: entry.model,
        metadata: { surface: 'enrich:validator' },
      });
      finalizeTaskExecutionOnce(entry.id, {
        ...finalPayload,
        runtime: entry.runtime,
        provider: entry.provider,
        model: entry.model,
        costUsd: entry.costUsd,
        metadata: {
          surface: 'enrich:validator',
          ...(entry.equivalent ? { costEstimationKind: 'subscription-equivalent-payg' } : {}),
        },
      });
    }
    expect(finalizeTaskExecutionRootIfIdle(rootExecutionId)).toBe(true);
    const rollup = getTaskExecutionRollup({
      ownerKind: 'enrich',
      ownerId,
      surface: 'enrich:validator',
      executionKinds: ['subagent'],
    });
    const base = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.4,
      durationMs: 100,
      toolUses: 0,
      apiRequests: 1,
      messages: 1,
      costStatus: 'known' as const,
      tokenStatus: 'reported' as const,
      costEstimationKind: 'subscription-equivalent-payg' as const,
    };

    expect(mergeTaskExecutionMetrics(base, rollup)).toEqual(
      expect.objectContaining({
        costUsd: 0.9,
        costEstimationKind: undefined,
        costByRuntime: { cloud: 0.2, grok: 0.3 },
        subscriptionEquivalentCost: 0.7,
      }),
    );
    expect(mergeTaskExecutionMetrics({ ...base, costEstimationKind: undefined }, rollup)).toEqual(
      expect.objectContaining({
        costUsd: 0.9,
        costEstimationKind: undefined,
        subscriptionEquivalentCost: 0.3,
      }),
    );
  });

  it('recusa parent de outra owner e segunda finalizacao divergente', () => {
    expect(() =>
      startTaskExecution({
        ...child,
        executionId: 'child-foreign',
        ownerId: 'outra-session',
        sessionId: 'outra-session',
      }),
    ).toThrow('outra arvore/owner/sessao');

    expect(() =>
      finalizeTaskExecutionOnce('child-1', {
        ...finalPayload,
        outputTokens: 21,
      }),
    ).toThrow('payload divergente');
  });

  it('fecha a raiz comum quando a ultima filha termina e reconcilia crash no boot', () => {
    const idleRoot = { ...root, executionId: 'root-idle', rootExecutionId: 'root-idle' };
    const idleChild = {
      ...child,
      executionId: 'child-idle',
      rootExecutionId: 'root-idle',
      parentExecutionId: 'root-idle',
      toolUseId: 'tool-idle',
    };
    startTaskExecution(idleRoot);
    startTaskExecution(idleChild);
    expect(finalizeTaskExecutionRootIfIdle('root-idle')).toBe(false);
    finalizeTaskExecutionOnce('child-idle', finalPayload);
    expect(finalizeTaskExecutionRootIfIdle('root-idle')).toBe(true);
    expect(getDb().prepare("SELECT status FROM task_executions WHERE execution_id='root-idle'").get()).toEqual({
      status: 'completed',
    });

    const crashRoot = { ...root, executionId: 'root-crash', rootExecutionId: 'root-crash' };
    const crashChild = {
      ...child,
      executionId: 'child-crash',
      rootExecutionId: 'root-crash',
      parentExecutionId: 'root-crash',
      toolUseId: 'tool-crash',
    };
    startTaskExecution(crashRoot);
    startTaskExecution(crashChild);
    expect(reconcileInterruptedTaskExecutions()).toBe(2);
    expect(
      getDb()
        .prepare(
          `
      SELECT execution_id, status, token_status
      FROM task_executions WHERE root_execution_id='root-crash' ORDER BY execution_id
    `,
        )
        .all(),
    ).toEqual([
      { execution_id: 'child-crash', status: 'cancelled', token_status: 'not_reported' },
      { execution_id: 'root-crash', status: 'cancelled', token_status: 'reported' },
    ]);
  });

  it('preserva task_id nativo e encerra filhos/root sem notificacao terminal', () => {
    const rootExecutionId = 'root-native-pending';
    startTaskExecution({
      ...root,
      executionId: rootExecutionId,
      rootExecutionId,
    });
    startTaskExecution({
      ...child,
      executionId: 'native-pending',
      taskId: 'provider-task-42',
      rootExecutionId,
      parentExecutionId: rootExecutionId,
      executionKind: 'native-task',
    });
    finalizeRunningTaskExecutionTree(rootExecutionId, 'cancelled', 'owner terminou');
    const rows = getDb()
      .prepare(
        `
      SELECT task_id, execution_id, execution_kind, status, token_status, cost_status
      FROM task_executions WHERE root_execution_id = ? ORDER BY execution_kind
    `,
      )
      .all(rootExecutionId) as Array<Record<string, unknown>>;
    expect(rows).toContainEqual(
      expect.objectContaining({
        task_id: 'provider-task-42',
        execution_id: 'native-pending',
        execution_kind: 'native-task',
        status: 'cancelled',
        token_status: 'not_reported',
        cost_status: 'unknown',
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        execution_kind: 'root',
        status: 'cancelled',
      }),
    );
  });

  it('faz rollup canonico sem raiz, deduplica execution_id e propaga a pior qualidade', () => {
    const rollupRoot = {
      ...root,
      executionId: 'root-rollup',
      rootExecutionId: 'root-rollup',
    };
    startTaskExecution(rollupRoot);

    const children = [
      { id: 'rollup-known', costStatus: 'known' as const, tokenStatus: 'reported' as const },
      { id: 'rollup-partial', costStatus: 'estimated-partial' as const, tokenStatus: 'reported' as const },
      { id: 'rollup-unknown', costStatus: 'unknown' as const, tokenStatus: 'not_reported' as const },
    ];
    for (const [index, entry] of children.entries()) {
      const execution = {
        ...child,
        executionId: entry.id,
        rootExecutionId: 'root-rollup',
        parentExecutionId: 'root-rollup',
        toolUseId: `tool-rollup-${index}`,
      };
      startTaskExecution(execution);
      startTaskExecution(execution);
      finalizeTaskExecutionOnce(entry.id, {
        ...finalPayload,
        inputTokens: entry.tokenStatus === 'reported' ? 10 * (index + 1) : 0,
        outputTokens: entry.tokenStatus === 'reported' ? index + 1 : 0,
        costUsd: entry.costStatus === 'unknown' ? 0 : 0.01 * (index + 1),
        durationMs: 100 * (index + 1),
        costStatus: entry.costStatus,
        tokenStatus: entry.tokenStatus,
        costUnknownReason: entry.costStatus === 'unknown' ? 'no-usage-reported' : null,
        metadata: { source: entry.id },
      });
    }

    const rollup = getTaskExecutionRollup({ rootExecutionId: 'root-rollup' });
    expect(rollup.executionCount).toBe(3);
    expect(rollup.executionIds).toEqual(['rollup-known', 'rollup-partial', 'rollup-unknown']);
    expect(rollup.statusCounts).toEqual({ running: 0, completed: 3, failed: 0, cancelled: 0 });
    expect(rollup.metrics).toEqual({
      inputTokens: 30,
      outputTokens: 3,
      cacheReadTokens: 30,
      cacheCreationTokens: 0,
      costUsd: 0.03,
      apiRequests: 3,
      toolUses: 6,
      durationMs: 600,
    });
    expect(rollup.costStatus).toBe('unknown');
    expect(rollup.tokenStatus).toBe('not_reported');
    expect(rollup.costUnknownReasons).toEqual(['no-usage-reported']);
    expect(rollup.unknownCostCount).toBe(1);
    expect(rollup.notReportedTokenCount).toBe(1);

    expect(getTaskExecutionRollup({ executionId: 'rollup-partial' })).toEqual(
      expect.objectContaining({
        executionCount: 1,
        costStatus: 'estimated-partial',
        tokenStatus: 'reported',
      }),
    );
    expect(getTaskExecutionRollup({ executionId: 'root-rollup' }).executionCount).toBe(0);
  });

  it('agrega apenas modelUsage reportado e deixa custo escalar sem breakdown como unattributed', () => {
    const rootExecutionId = 'root-usage-metadata';
    startTaskExecution({ ...root, executionId: rootExecutionId, rootExecutionId });
    for (const [index, executionId] of ['usage-detailed', 'usage-fallback'].entries()) {
      startTaskExecution({
        ...child,
        executionId,
        rootExecutionId,
        parentExecutionId: rootExecutionId,
        toolUseId: `tool-${executionId}`,
      });
      finalizeTaskExecutionOnce(executionId, {
        ...finalPayload,
        model: 'kimi-code/k3',
        runtime: 'kimi',
        provider: 'kimi',
        inputTokens: index === 0 ? 100 : 50,
        outputTokens: index === 0 ? 10 : 5,
        cacheReadTokens: index === 0 ? 20 : 10,
        costUsd: index === 0 ? 0.02 : 0.01,
        apiRequests: 1,
        metadata:
          index === 0
            ? {
                costSource: 'calculated',
                pricingSnapshot: { pricingVersion: 'v1', model: 'kimi-k3' },
                modelUsage: {
                  'kimi-code/k3': {
                    inputTokens: 100,
                    outputTokens: 10,
                    cacheReadInputTokens: 20,
                    cacheCreationInputTokens: 0,
                    costUSD: 0.02,
                    modelCalls: 1,
                  },
                },
              }
            : {
                costSource: 'calculated',
                pricingSnapshot: { pricingVersion: 'v2', model: 'kimi-k3' },
              },
      });
    }

    const rollup = getTaskExecutionRollup({ rootExecutionId });
    expect(rollup.usageMetadata.modelUsage['kimi-code/k3']).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 0,
      costUSD: 0.02,
      modelCalls: 1,
    });
    expect(rollup.usageMetadata.pricingProvenance).toEqual([
      expect.objectContaining({
        executionId: 'usage-detailed',
        model: 'kimi-code/k3',
        runtime: 'kimi',
        costUsd: 0.02,
        costSource: 'calculated',
        pricingSnapshot: { pricingVersion: 'v1', model: 'kimi-k3' },
      }),
      expect.objectContaining({
        executionId: 'usage-fallback',
        model: 'kimi-code/k3',
        runtime: 'kimi',
        costUsd: 0.01,
        pricingSnapshot: { pricingVersion: 'v2', model: 'kimi-k3' },
      }),
    ]);
    expect(rollup.usageMetadata.unattributedCostUsd).toBeCloseTo(0.01, 12);
    expect(rollup.usageMetadata.overAttributedCostUsd).toBeUndefined();
    expect(rollup.usageMetadata.pricingProvenance.reduce((sum, entry) => sum + entry.costUsd, 0)).toBeCloseTo(
      rollup.metrics.costUsd,
      12,
    );
  });

  it('sinaliza breakdown conhecido maior que o custo escalar total', () => {
    const rootExecutionId = 'root-over-attributed';
    startTaskExecution({ ...root, executionId: rootExecutionId, rootExecutionId });
    startTaskExecution({
      ...child,
      executionId: 'over-attributed',
      rootExecutionId,
      parentExecutionId: rootExecutionId,
      toolUseId: 'tool-over-attributed',
      model: 'grok-4.5',
      runtime: 'grok',
      provider: 'grok',
    });
    finalizeTaskExecutionOnce('over-attributed', {
      ...finalPayload,
      model: 'grok-4.5',
      runtime: 'grok',
      provider: 'grok',
      costUsd: 0.01,
      costStatus: 'known',
      metadata: {
        modelUsage: {
          'grok-4.5': {
            inputTokens: 100,
            outputTokens: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.03,
            modelCalls: 1,
          },
        },
      },
    });

    const rollup = getTaskExecutionRollup({ rootExecutionId });
    expect(rollup.usageMetadata.unattributedCostUsd).toBe(0);
    expect(rollup.usageMetadata.overAttributedCostUsd).toBeCloseTo(0.02, 12);
  });

  it('nao deriva custo nao atribuido quando o total e unknown e o breakdown e parcial', () => {
    const rootExecutionId = 'root-partial-breakdown';
    startTaskExecution({ ...root, executionId: rootExecutionId, rootExecutionId });
    startTaskExecution({
      ...child,
      executionId: 'partial-breakdown',
      rootExecutionId,
      parentExecutionId: rootExecutionId,
      toolUseId: 'tool-partial-breakdown',
      model: 'grok-4.5',
      runtime: 'grok',
      provider: 'grok',
    });
    finalizeTaskExecutionOnce('partial-breakdown', {
      ...finalPayload,
      model: 'grok-4.5',
      runtime: 'grok',
      provider: 'grok',
      inputTokens: 200,
      outputTokens: 20,
      costUsd: 0,
      costStatus: 'unknown',
      tokenStatus: 'reported',
      costUnknownReason: 'no-usage-reported',
      metadata: {
        modelUsage: {
          'grok-4.5': {
            inputTokens: 100,
            outputTokens: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.00026,
            modelCalls: 1,
          },
        },
      },
    });

    const rollup = getTaskExecutionRollup({ rootExecutionId });
    expect(rollup.costStatus).toBe('unknown');
    expect(rollup.usageMetadata.modelUsage['grok-4.5']?.costUSD).toBe(0.00026);
    expect(rollup.usageMetadata.unattributedCostUsd).toBeUndefined();
  });

  it('leva a pior qualidade aos totais normais de pipeline e harness sem contar a raiz', () => {
    getDb()
      .prepare(
        `
      INSERT INTO harness_projects (id, name, project_path, spec_path, status, config)
      VALUES ('project-quality', 'Quality', '/tmp/quality', '/tmp/quality/SPEC.md', 'running', '{}')
    `,
      )
      .run();
    savePipelinePhaseMetrics({
      projectId: 'project-quality',
      phaseNumber: 1,
      phaseName: 'Discovery',
      status: 'completed',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.02,
      metadata: { costStatus: 'known', tokenStatus: 'reported' },
    });

    for (const ownerKind of ['pipeline', 'harness'] as const) {
      const rootId = `root-${ownerKind}-quality`;
      const childId = `child-${ownerKind}-quality`;
      startTaskExecution({
        ...root,
        executionId: rootId,
        rootExecutionId: rootId,
        ownerKind,
        ownerId: 'project-quality',
        sessionId: null,
      });
      startTaskExecution({
        ...child,
        executionId: childId,
        rootExecutionId: rootId,
        parentExecutionId: rootId,
        ownerKind,
        ownerId: 'project-quality',
        sessionId: null,
        toolUseId: `${ownerKind}-tool`,
      });
      finalizeTaskExecutionOnce(childId, {
        ...finalPayload,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        costStatus: 'unknown',
        tokenStatus: 'not_reported',
        costUnknownReason: 'no-usage-reported',
      });
    }

    const pipelineMetrics = getPipelineMetrics('project-quality');
    expect(pipelineMetrics.totals).toEqual(
      expect.objectContaining({
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.02,
        costStatus: 'unknown',
        tokenStatus: 'not_reported',
        unknownCostCount: 1,
        costUnknownReasons: ['no-usage-reported'],
      }),
    );
    expect(pipelineMetrics.costStatusByRuntime).toEqual({ codex: 'unknown', cloud: 'known' });
    expect(getHarnessProjectMetrics('project-quality')).toEqual(
      expect.objectContaining({
        costStatus: 'unknown',
        tokenStatus: 'not_reported',
        unknownCostCount: 1,
        costUnknownReasons: ['no-usage-reported'],
      }),
    );
  });

  it('preserva qualidade not_reported do planner/coder/evaluator sem depender do ledger filho', () => {
    getDb()
      .prepare(
        `
      INSERT INTO harness_projects (id, name, project_path, spec_path, status, config)
      VALUES (?, 'Harness Quality', '/tmp/hq', '/tmp/hq/SPEC.md', 'running', ?)
    `,
      )
      .run(
        'project-harness-quality',
        JSON.stringify({
          metricsQuality: {
            plannerCostStatus: 'estimated-partial',
            plannerTokenStatus: 'reported',
          },
        }),
      );
    getDb()
      .prepare(
        `
      INSERT INTO harness_sprints (id, project_id, sprint_index, sprint_json_id, name, status)
      VALUES ('sprint-harness-quality', 'project-harness-quality', 0, 'sprint-json-quality', 'Sprint', 'passed')
    `,
      )
      .run();
    getDb()
      .prepare(
        `
      INSERT INTO harness_rounds (sprint_id, round_number, metadata, unknown_cost_count)
      VALUES ('sprint-harness-quality', 1, ?, 1)
    `,
      )
      .run(
        JSON.stringify({
          coderCostStatus: 'unknown',
          coderTokenStatus: 'not_reported',
          coderCostUnknownReason: 'no-usage-reported',
          evaluatorCostStatus: 'known',
          evaluatorTokenStatus: 'reported',
        }),
      );

    expect(getHarnessProjectMetrics('project-harness-quality')).toEqual(
      expect.objectContaining({
        costStatus: 'unknown',
        tokenStatus: 'not_reported',
        unknownCostCount: 1,
        costUnknownReasons: ['no-usage-reported'],
        sprintMetrics: [
          expect.objectContaining({
            costStatus: 'unknown',
            tokenStatus: 'not_reported',
          }),
        ],
      }),
    );
    expect(getHarnessRounds('sprint-harness-quality')).toEqual([
      expect.objectContaining({
        costStatus: 'unknown',
        subscriptionEquivalentCost: 0,
      }),
    ]);
  });

  it('separa exatamente custo direto e equivalente de assinatura no harness misto', () => {
    const projectId = 'project-harness-subscription-cost';
    getDb()
      .prepare(
        `
      INSERT INTO harness_projects (
        id, name, project_path, spec_path, status, config, planner_cost_usd
      ) VALUES (?, 'Harness Subscription', '/tmp/hs', '/tmp/hs/SPEC.md', 'running', ?, 1)
    `,
      )
      .run(
        projectId,
        JSON.stringify({
          metricsQuality: { plannerSubscriptionEquivalentCostUsd: 0.25 },
        }),
      );
    getDb()
      .prepare(
        `
      INSERT INTO harness_sprints (id, project_id, sprint_index, sprint_json_id, name, status)
      VALUES ('sprint-harness-subscription', ?, 0, 'sprint-json-subscription', 'Sprint', 'passed')
    `,
      )
      .run(projectId);
    getDb()
      .prepare(
        `
      INSERT INTO harness_rounds (
        sprint_id, round_number, coder_cost_usd, evaluator_cost_usd, metadata
      ) VALUES ('sprint-harness-subscription', 1, 2, 3, ?)
    `,
      )
      .run(
        JSON.stringify({
          coderCostEstimationKind: 'subscription-equivalent-payg',
          coderCostStatus: 'known',
          evaluatorCostStatus: 'known',
        }),
      );

    expect(getHarnessRounds('sprint-harness-subscription')).toEqual([
      expect.objectContaining({
        costStatus: 'known',
        subscriptionEquivalentCost: 2,
      }),
    ]);

    const rootId = 'root-harness-subscription';
    const childId = 'child-harness-subscription';
    startTaskExecution({
      ...root,
      executionId: rootId,
      rootExecutionId: rootId,
      ownerKind: 'harness',
      ownerId: projectId,
      sessionId: null,
    });
    startTaskExecution({
      ...child,
      executionId: childId,
      rootExecutionId: rootId,
      parentExecutionId: rootId,
      ownerKind: 'harness',
      ownerId: projectId,
      sessionId: null,
      runtime: 'grok',
      provider: 'xai-subscription',
      model: 'grok-4.5',
      metadata: { costEstimationKind: 'subscription-equivalent-payg' },
    });
    finalizeTaskExecutionOnce(childId, {
      ...finalPayload,
      model: 'grok-4.5',
      runtime: 'grok',
      provider: 'xai-subscription',
      costUsd: 4,
      metadata: { costEstimationKind: 'subscription-equivalent-payg' },
    });

    expect(getHarnessProjectMetrics(projectId)).toEqual(
      expect.objectContaining({
        totalCost: 10,
        subscriptionEquivalentCost: 6.25,
        plannerSubscriptionEquivalentCost: 0.25,
        coderSubscriptionEquivalentCost: 2,
        evaluatorSubscriptionEquivalentCost: 0,
        subagentSubscriptionEquivalentCost: 4,
        sprintMetrics: [
          expect.objectContaining({
            totalCost: 5,
            subscriptionEquivalentCost: 2,
            coderSubscriptionEquivalentCost: 2,
            evaluatorSubscriptionEquivalentCost: 0,
          }),
        ],
      }),
    );
  });
});
