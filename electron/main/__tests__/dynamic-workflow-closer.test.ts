
import { describe, it, expect } from 'vitest';
import {
  openCloserSession,
  sendCloserMessage,
  finalizeWorkflow,
  resolveCloserCwd,
  buildCloserTurnPrompt,
  buildCloserCanUseTool,
  CloserError,
  DYNAMIC_WORKFLOW_CLOSER_AGENT_ID,
  type CloserEngineDeps,
  type CloserAgentTurnRunner,
  type CloserSpawnContext,
} from '../dynamic-workflows/workflow-closer';
import type {
  CloserGitAuditEvent,
  CloserGitConfirmRequest,
} from '../dynamic-workflows/closer-permission-guard';
import type {
  DynamicWorkflowRun,
  DynamicWorkflowMessage,
  DynamicWorkflowMessageInsertInput,
  DynamicWorkflowRunPatch,
  DynamicWorkflowEvent,
  DynamicWorkflowRunCostAggregate,
} from '../dynamic-workflows/types';

const REPO_ROOT = '/proj/repo';
const WORKTREE = '/proj/repo/.lionclaw/workflows/run-1/worktree';

function makeRun(over?: Partial<DynamicWorkflowRun>): DynamicWorkflowRun {
  return {
    id: 'run-1',
    definitionId: 'def-1',
    chatSessionId: null,
    status: 'delivered',
    currentPhaseId: null,
    currentNodeId: null,
    workspaceMode: 'run-worktree',
    baseBranch: 'main',
    baseCommitSha: 'base-sha',
    baseWorktreeHash: 'tree-hash',
    worktreePath: WORKTREE,
    worktreeBranch: 'dynworkflow/run-1',
    deliveredAt: '2026-06-12T00:00:00.000Z',
    finalizedAt: null,
    closerSessionId: null,
    closerStatus: null,
    inputJson: '{}',
    outputJson: null,
    checkpointJson: '{}',
    error: null,
    totalCostUsd: 1.5,
    totalDurationMs: 1000,
    createdBy: 'manual',
    startedAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
    completedAt: null,
    ...over,
  };
}

function makeDeps(
  initial: DynamicWorkflowRun,
  over?: {
    runAgentTurn?: CloserAgentTurnRunner;
    resolveCloserRuntime?: (agentId: string) => string;
    cost?: DynamicWorkflowRunCostAggregate;
    recentEvents?: DynamicWorkflowEvent[];
  },
): {
  deps: CloserEngineDeps;
  state: {
    run: DynamicWorkflowRun;
    messages: DynamicWorkflowMessage[];
    events: Array<{ runId: string; type: string; payload?: unknown }>;
    lockReleased: string[];
    patches: DynamicWorkflowRunPatch[];
  };
} {
  const state = {
    run: initial,
    messages: [] as DynamicWorkflowMessage[],
    events: [] as Array<{ runId: string; type: string; payload?: unknown }>,
    lockReleased: [] as string[],
    patches: [] as DynamicWorkflowRunPatch[],
  };
  let msgId = 0;

  const deps: CloserEngineDeps = {
    getRun: (id) => (id === state.run.id ? state.run : null),
    updateRun: (id, patch) => {
      if (id !== state.run.id) return;
      state.patches.push(patch);
      state.run = { ...state.run, ...patch } as DynamicWorkflowRun;
    },
    insertMessage: (input: DynamicWorkflowMessageInsertInput) => {
      msgId += 1;
      const m: DynamicWorkflowMessage = {
        id: msgId,
        runId: input.runId,
        nodeId: input.nodeId ?? null,
        role: input.role,
        source: input.source,
        kind: input.kind,
        content: input.content,
        toolCallsJson: input.toolCallsJson ?? null,
        agentId: input.agentId ?? null,
        createdAt: `2026-06-12T00:00:0${msgId}.000Z`,
      };
      state.messages.push(m);
      return m;
    },
    listMessages: () => [...state.messages],
    recentEvents: () => over?.recentEvents ?? [],
    costAggregate: (): DynamicWorkflowRunCostAggregate =>
      over?.cost ?? {
        runId: state.run.id,
        totalCostUsd: state.run.totalCostUsd,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalDurationMs: 0,
        nodeRunCount: 0,
        unknownCostNodeRuns: 0,
      },
    resolveCloserRuntime: over?.resolveCloserRuntime,
    runAgentTurn:
      over?.runAgentTurn ??
      (async () => ({ ok: true, output: 'walkthrough da entrega', costUsd: 0.25 })),
    emitEvent: (e) => state.events.push(e),
    releaseRunLock: (id) => state.lockReleased.push(id),
    newSessionId: () => 'sess-fixed',
    now: () => '2026-06-12T12:00:00.000Z',
  };
  return { deps, state };
}

const DELIVERY_CTX: CloserSpawnContext = {
  reason: 'delivery',
  motive: 'Entrega concluida. Walkthrough: rode npm run dev. Smoke sugerido: abrir a pagina.',
  deliveryReport: 'Feature X implementada em 3 nodes.',
  nodeDiffs: [{ nodeId: 'coder', attempt: 1, files: ['src/a.ts', 'src/b.ts'] }],
};

describe('workflow-closer: openCloserSession (8.8 / AC-28)', () => {
  it('grava closer_session_id + closer_status active e persiste a mensagem do closer', async () => {
    const { deps, state } = makeDeps(makeRun());
    const res = await openCloserSession('run-1', DELIVERY_CTX, deps, { repoRoot: REPO_ROOT });

    expect(res.sessionId).toBe('sess-fixed');
    const activated = state.patches.find(
      (p) => p.closerStatus === 'active' && p.closerSessionId === 'sess-fixed',
    );
    expect(activated).toBeDefined();
    expect(state.run.closerStatus).toBe('active');
    expect(state.run.closerSessionId).toBe('sess-fixed');

    const closerMsg = state.messages.find((m) => m.source === 'closer');
    expect(closerMsg).toBeDefined();
    expect(closerMsg?.nodeId).toBeNull();
    expect(closerMsg?.role).toBe('assistant');
    expect(closerMsg?.content).toBe('walkthrough da entrega');
    expect(closerMsg?.agentId).toBe(DYNAMIC_WORKFLOW_CLOSER_AGENT_ID);

    expect(state.events.some((e) => e.type === 'closer-opened')).toBe(true);
  });

  it('injeta o contexto (motivo + delivery report + diffs) no prompt do agente', async () => {
    let capturedPrompt = '';
    let capturedCwd = '';
    const turn: CloserAgentTurnRunner = async (input) => {
      capturedPrompt = input.prompt;
      capturedCwd = input.cwd;
      return { ok: true, output: 'ok', costUsd: 0 };
    };
    const { deps } = makeDeps(makeRun(), { runAgentTurn: turn });
    await openCloserSession('run-1', DELIVERY_CTX, deps, { repoRoot: REPO_ROOT });

    expect(capturedPrompt).toContain('Walkthrough');
    expect(capturedPrompt).toContain('Feature X implementada');
    expect(capturedPrompt).toContain('coder');
    expect(capturedPrompt).toContain('src/a.ts');
    expect(capturedCwd).toBe(REPO_ROOT);
  });

  it('soma o custo do turno ao total do run (8.8)', async () => {
    const { deps, state } = makeDeps(makeRun({ totalCostUsd: 2.0 }), {
      runAgentTurn: async () => ({ ok: true, output: 'x', costUsd: 0.5 }),
    });
    const res = await openCloserSession('run-1', DELIVERY_CTX, deps, { repoRoot: REPO_ROOT });
    expect(res.addedCostUsd).toBe(0.5);
    expect(state.run.totalCostUsd).toBeCloseTo(2.5, 5);
  });

  it('passa o canUseTool PROPRIO do closer ao turno (git-first)', async () => {
    let guardSeen = false;
    const turn: CloserAgentTurnRunner = async (input) => {
      const d = await input.canUseTool({ toolName: 'Bash', input: { command: 'git status' } });
      guardSeen = d.behavior === 'allow';
      const push = await input.canUseTool({ toolName: 'Bash', input: { command: 'git push' } });
      expect(push.behavior).toBe('deny');
      return { ok: true, output: 'ok', costUsd: 0 };
    };
    const { deps } = makeDeps(makeRun(), { runAgentTurn: turn });
    await openCloserSession('run-1', DELIVERY_CTX, deps, { repoRoot: REPO_ROOT });
    expect(guardSeen).toBe(true);
  });

  it('run inexistente lanca CloserError run-not-found', async () => {
    const { deps } = makeDeps(makeRun());
    await expect(
      openCloserSession('outro', DELIVERY_CTX, deps, { repoRoot: REPO_ROOT }),
    ).rejects.toMatchObject({ code: 'run-not-found' });
  });

  it('closer em runtime sandbox-capable (codex) e PERMITIDO (8.8 - sandbox = contenção)', async () => {
    const { deps } = makeDeps(makeRun(), { resolveCloserRuntime: () => 'codex' });
    await expect(
      openCloserSession('run-1', DELIVERY_CTX, deps, { repoRoot: REPO_ROOT }),
    ).resolves.toMatchObject({ sessionId: expect.any(String) });
  });

  it('closer em runtime sem canUseTool NEM sandbox (local) e bloqueado (8.8)', async () => {
    const { deps } = makeDeps(makeRun(), { resolveCloserRuntime: () => 'local' });
    await expect(
      openCloserSession('run-1', DELIVERY_CTX, deps, { repoRoot: REPO_ROOT }),
    ).rejects.toMatchObject({ code: 'closer-not-guard-capable' });
  });
});

describe('workflow-closer: resolveCloserCwd (8.8)', () => {
  it('friccao de merge no modo worktree -> worktree viva', () => {
    const run = makeRun({ status: 'blocked' });
    expect(resolveCloserCwd({ run, reason: 'merge-conflict', repoRoot: REPO_ROOT })).toBe(WORKTREE);
    expect(resolveCloserCwd({ run, reason: 'gate-failed', repoRoot: REPO_ROOT })).toBe(WORKTREE);
  });

  it('delivered no modo worktree -> repo principal (worktree ja morreu)', () => {
    const run = makeRun();
    expect(resolveCloserCwd({ run, reason: 'delivery', repoRoot: REPO_ROOT })).toBe(REPO_ROOT);
    expect(resolveCloserCwd({ run, reason: 'user-request', repoRoot: REPO_ROOT })).toBe(REPO_ROOT);
  });

  it('fresh-project sempre usa o repo do projeto', () => {
    const run = makeRun({ workspaceMode: 'fresh-project', worktreePath: null });
    expect(resolveCloserCwd({ run, reason: 'merge-conflict', repoRoot: REPO_ROOT })).toBe(REPO_ROOT);
    expect(resolveCloserCwd({ run, reason: 'delivery', repoRoot: REPO_ROOT })).toBe(REPO_ROOT);
  });
});

describe('workflow-closer: sendCloserMessage (multi-turno)', () => {
  it('persiste a mensagem humana e a resposta do closer', async () => {
    const { deps, state } = makeDeps(makeRun({ closerStatus: 'active', closerSessionId: 'sess-fixed' }), {
      runAgentTurn: async () => ({ ok: true, output: 'corrigido', costUsd: 0.1 }),
    });
    const res = await sendCloserMessage('run-1', 'tem um bug no botao', DELIVERY_CTX, deps, {
      repoRoot: REPO_ROOT,
    });
    expect(res.message.source).toBe('closer');
    const human = state.messages.find((m) => m.source === 'human');
    expect(human?.content).toBe('tem um bug no botao');
    expect(human?.role).toBe('user');
    expect(state.messages.map((m) => m.source)).toEqual(['human', 'closer']);
  });

  it('recusa quando a sessao nao esta ativa', async () => {
    const { deps } = makeDeps(makeRun({ closerStatus: 'idle' }));
    await expect(
      sendCloserMessage('run-1', 'oi', DELIVERY_CTX, deps, { repoRoot: REPO_ROOT }),
    ).rejects.toMatchObject({ code: 'session-not-active' });
  });

  it('turno com falha do agente vira mensagem de indisponibilidade (nao derruba)', async () => {
    const { deps, state } = makeDeps(makeRun({ closerStatus: 'active' }), {
      runAgentTurn: async () => ({ ok: false, output: '', errorMessage: 'provider-limit' }),
    });
    const res = await sendCloserMessage('run-1', 'segue', DELIVERY_CTX, deps, { repoRoot: REPO_ROOT });
    expect(res.message.source).toBe('closer');
    expect(res.message.content).toContain('closer indisponivel');
    expect(res.message.content).toContain('provider-limit');
    expect(state.run.totalCostUsd).toBe(1.5); // sem custo somado em falha sem custo.
  });
});

describe('workflow-closer: finalizeWorkflow (8.8 / 10.2)', () => {
  it('delivered -> completed + closer_status closed + finalized_at, libera lock, sem cleanup', () => {
    const { deps, state } = makeDeps(makeRun({ status: 'delivered', closerStatus: 'active' }));
    finalizeWorkflow('run-1', deps);

    expect(state.run.status).toBe('completed');
    expect(state.run.closerStatus).toBe('closed');
    expect(state.run.finalizedAt).toBe('2026-06-12T12:00:00.000Z');
    expect(state.run.completedAt).toBe('2026-06-12T12:00:00.000Z');
    expect(state.lockReleased).toEqual(['run-1']);
    expect(state.events.some((e) => e.type === 'workflow-finalized')).toBe(true);
  });

  it('recusa finalize quando o run NAO esta em delivered', () => {
    for (const status of ['running', 'paused', 'completed', 'blocked'] as const) {
      const { deps } = makeDeps(makeRun({ status }));
      expect(() => finalizeWorkflow('run-1', deps)).toThrow(CloserError);
      try {
        finalizeWorkflow('run-1', deps);
      } catch (e) {
        expect((e as CloserError).code).toBe('finalize-not-delivered');
      }
    }
  });

  it('run inexistente lanca run-not-found', () => {
    const { deps } = makeDeps(makeRun());
    expect(() => finalizeWorkflow('zzz', deps)).toThrow(/nao encontrado/);
  });
});

describe('workflow-closer: buildCloserTurnPrompt', () => {
  it('inclui snapshot, custo, motivo, diffs, eventos e conversa em ordem', () => {
    const run = makeRun();
    const cost: DynamicWorkflowRunCostAggregate = {
      runId: 'run-1',
      totalCostUsd: 3.1416,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalDurationMs: 0,
      nodeRunCount: 0,
      unknownCostNodeRuns: 0,
    };
    const events: DynamicWorkflowEvent[] = [
      { id: 1, runId: 'run-1', nodeId: null, phaseId: null, seq: 41, type: 'gate-approved', payloadJson: '{}', createdAt: 'x' },
    ];
    const history: DynamicWorkflowMessage[] = [
      { id: 1, runId: 'run-1', nodeId: null, role: 'user', source: 'human', kind: 'text', content: 'primeira', toolCallsJson: null, agentId: null, createdAt: 'a' },
      { id: 2, runId: 'run-1', nodeId: null, role: 'assistant', source: 'closer', kind: 'text', content: 'resposta', toolCallsJson: null, agentId: 'dynamic-workflow-closer', createdAt: 'b' },
    ];
    const prompt = buildCloserTurnPrompt({ run, cost, recentEvents: events, context: DELIVERY_CTX, history });
    expect(prompt).toContain('run-1');
    expect(prompt).toContain('USD 3.1416');
    expect(prompt).toContain('gate-approved');
    expect(prompt).toContain('Usuario: primeira');
    expect(prompt).toContain('Closer: resposta');
    expect(prompt.indexOf('## Contexto')).toBeLessThan(prompt.indexOf('## Conversa'));
  });
});


describe('closer git wiring: confirmGitWrite + auditGit chegam ao guard (8.8/AC-26)', () => {
  const CWD = '/proj/repo/.lionclaw/workflows/run-1/worktree';
  const bash = (command: string) => ({ toolName: 'Bash' as const, input: { command } });

  it('write-local (commit) com confirmador que APROVA + audit: ALLOW + audit approved + req com cwd', async () => {
    const audits: CloserGitAuditEvent[] = [];
    const reqs: CloserGitConfirmRequest[] = [];
    const canUseTool = buildCloserCanUseTool({
      runId: 'run-1',
      workspaceCwd: CWD,
      confirmGitWrite: (req) => {
        reqs.push(req);
        return true;
      },
      auditGit: (e) => audits.push(e),
    });
    const d = await canUseTool(bash('git commit -m "fix residual"'));
    expect(d.behavior).toBe('allow');
    expect(reqs).toHaveLength(1);
    expect(reqs[0].subcommand).toBe('commit');
    expect(reqs[0].cwd).toBe(CWD);
    expect(audits).toHaveLength(1);
    expect(audits[0].decision).toBe('approved');
  });

  it('write-local com confirmador de PRODUCAO (nega, fail-closed) + audit: DENY + audit denied', async () => {
    const audits: CloserGitAuditEvent[] = [];
    const canUseTool = buildCloserCanUseTool({
      runId: 'run-1',
      workspaceCwd: CWD,
      confirmGitWrite: () => false,
      auditGit: (e) => audits.push(e),
    });
    const d = await canUseTool(bash('git merge feature'));
    expect(d.behavior).toBe('deny');
    expect(audits).toHaveLength(1);
    expect(audits[0].decision).toBe('denied');
    expect(audits[0].subcommand).toBe('merge');
  });

  it('push permanece negado ESTRUTURALMENTE mesmo com confirmador que aprovaria', async () => {
    const audits: CloserGitAuditEvent[] = [];
    const canUseTool = buildCloserCanUseTool({
      runId: 'run-1',
      workspaceCwd: CWD,
      confirmGitWrite: () => true, // mesmo aprovando tudo...
      auditGit: (e) => audits.push(e),
    });
    const d = await canUseTool(bash('git push origin main'));
    expect(d.behavior).toBe('deny'); // ...push nunca passa (allowlist do guard).
    expect(audits.some((a) => a.decision === 'denied')).toBe(true);
  });
});
