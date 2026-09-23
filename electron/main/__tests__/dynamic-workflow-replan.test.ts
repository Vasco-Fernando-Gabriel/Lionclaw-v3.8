import { describe, it, expect } from 'vitest';
import {
  buildReplanLinkage,
  makeRealCloserAgentTurn,
  closerGuardToSdkCanUseTool,
  closerReasonFromState,
  type RealClaudeCompatBackendDeps,
} from '../ipc/dynamic-workflow';
import { buildCloserCanUseTool, resolveCloserCwd } from '../dynamic-workflows/workflow-closer';
import type {
  ClaudeCompatExecInput,
  ClaudeCompatExecResult,
} from '../dynamic-workflows/workflow-claude-compat-executor';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type {
  DynamicWorkflowDefinition,
  DynamicWorkflowDefinitionCreateInput,
  DynamicWorkflowDefinitionPatch,
  DynamicWorkflowRun,
  DynamicWorkflowEvent,
} from '../dynamic-workflows/types';

function makeDefinition(patch: Partial<DynamicWorkflowDefinition> = {}): DynamicWorkflowDefinition {
  return {
    id: 'dwfd_prev',
    name: 'demo-workflow',
    definitionVersion: 1,
    authoringModel: 'manifest',
    parentDefinitionId: null,
    supersedesDefinitionId: null,
    sourceType: 'builder',
    projectPath: '/tmp/projeto',
    specPath: '/tmp/projeto/spec.md',
    specSha256: 'abc123',
    workflowJsPath: '/tmp/projeto/.lionclaw/workflows/run-1/workflow.js',
    manifestPath: '/tmp/projeto/.lionclaw/workflows/run-1/workflow.manifest.json',
    manifestJson: '{"version":1,"name":"demo","phases":[],"nodes":[]}',
    manifestHash: 'deadbeef',
    contextBundlePath: '/tmp/projeto/.lionclaw/workflows/run-1/context-bundle.json',
    builderModel: 'claude-opus',
    status: 'validated',
    createdAt: '2026-06-12T10:00:00.000Z',
    updatedAt: '2026-06-12T10:00:00.000Z',
    ...patch,
  };
}

describe('buildReplanLinkage (cadeia parent/supersedes - 22.7)', () => {
  it('a nova definition aponta parent_definition_id = id da anterior', () => {
    const prev = makeDefinition();
    const { newDefInput } = buildReplanLinkage(prev, 'dwfd_new');
    expect(newDefInput.parentDefinitionId).toBe('dwfd_prev');
  });

  it('a anterior recebe supersedes_definition_id = id da nova', () => {
    const prev = makeDefinition();
    const { prevDefPatch } = buildReplanLinkage(prev, 'dwfd_new');
    expect(prevDefPatch.supersedesDefinitionId).toBe('dwfd_new');
  });

  it('bumpa a definition_version (anterior +1)', () => {
    const prev = makeDefinition({ definitionVersion: 3 });
    const { newDefInput } = buildReplanLinkage(prev, 'dwfd_new');
    expect(newDefInput.definitionVersion).toBe(4);
  });

  it('a nova herda o pacote (workflow.js/manifest/schemas) e o projeto da anterior', () => {
    const prev = makeDefinition();
    const { newDefInput } = buildReplanLinkage(prev, 'dwfd_new');
    expect(newDefInput.id).toBe('dwfd_new');
    expect(newDefInput.name).toBe(prev.name);
    expect(newDefInput.projectPath).toBe(prev.projectPath);
    expect(newDefInput.workflowJsPath).toBe(prev.workflowJsPath);
    expect(newDefInput.manifestJson).toBe(prev.manifestJson);
    expect(newDefInput.manifestHash).toBe(prev.manifestHash);
    expect(newDefInput.supersedesDefinitionId).toBeNull();
  });
});

describe('fluxo do handler com CRUD fake (insert da nova + update da anterior)', () => {
  it('cria a nova definition E atualiza a anterior, fechando a cadeia', () => {
    const prev = makeDefinition();
    const createdInputs: DynamicWorkflowDefinitionCreateInput[] = [];
    const updates: Array<{ id: string; patch: DynamicWorkflowDefinitionPatch }> = [];

    const fakeCreate = (input: DynamicWorkflowDefinitionCreateInput): void => {
      createdInputs.push(input);
    };
    const fakeUpdate = (id: string, patch: DynamicWorkflowDefinitionPatch): void => {
      updates.push({ id, patch });
    };

    const newDefinitionId = 'dwfd_new';
    const { newDefInput, prevDefPatch } = buildReplanLinkage(prev, newDefinitionId);
    fakeCreate(newDefInput);
    fakeUpdate(prev.id, prevDefPatch);

    expect(createdInputs).toHaveLength(1);
    expect(createdInputs[0].id).toBe(newDefinitionId);
    expect(createdInputs[0].parentDefinitionId).toBe(prev.id);

    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(prev.id);
    expect(updates[0].patch.supersedesDefinitionId).toBe(newDefinitionId);
  });
});

function captureRunNode(
  capture: (input: ClaudeCompatExecInput) => void,
  output = 'walkthrough',
): RealClaudeCompatBackendDeps['runNode'] {
  return (async (input: ClaudeCompatExecInput): Promise<ClaudeCompatExecResult> => {
    capture(input);
    return {
      output,
      model: input.config.model,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.01,
      apiRequests: 1,
      toolUses: 0,
    };
  }) as RealClaudeCompatBackendDeps['runNode'];
}

function closerDeps(capture: (input: ClaudeCompatExecInput) => void, output?: string): RealClaudeCompatBackendDeps {
  return {
    resolveConfig: async () => ({
      model: 'claude-opus',
      systemPrompt: 'closer',
      allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
      mcpServers: [],
      maxTurns: undefined,
      effort: 'high',
      thinking: 'adaptive',
      thinkingBudget: undefined,
      runtime: 'cloud',
    }),
    runNode: captureRunNode(capture, output),
  };
}

describe('realCloserAgentTurn liga o guard git-first ao executor (R0/P1, AC-26)', () => {
  it('o canUseTool passado ao executor e o guard git-first; allowedTools SEM Bash/Write/Edit', async () => {
    const closerGuard = buildCloserCanUseTool({
      runId: 'run-1',
      workspaceCwd: '/repo/worktree/run-1',
      confirmGitWrite: () => true,
    });

    let captured: ClaudeCompatExecInput | undefined;
    const turn = makeRealCloserAgentTurn(closerDeps((i) => (captured = i)));
    const result = await turn({
      runId: 'run-1',
      agentId: 'dynamic-workflow-closer',
      prompt: 'feche a entrega',
      cwd: '/repo/worktree/run-1',
      canUseTool: closerGuard,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe('walkthrough');
    expect(result.costUsd).toBe(0.01);

    expect(captured).toBeDefined();
    const inp = captured as ClaudeCompatExecInput;
    expect(inp.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    expect(inp.allowedTools).not.toContain('Bash');
    expect(inp.allowedTools).not.toContain('Write');
    const capturedCanUseTool: CanUseTool = inp.canUseTool;
    const opts = { signal: new AbortController().signal, toolUseID: 't1', requestId: 'req-1' };

    const commit = await capturedCanUseTool('Bash', { command: 'git commit -m "wip"' }, opts);
    expect(commit?.behavior).toBe('allow');

    const push = await capturedCanUseTool('Bash', { command: 'git push origin main' }, opts);
    expect(push?.behavior).toBe('deny');

    const merge = await capturedCanUseTool('Bash', { command: 'git merge feature' }, opts);
    expect(merge?.behavior).toBe('allow');
  });

  it('runtime codex roteia pelo executeAgent (sandbox), NAO pelo runNode claude-compat', async () => {
    let executeAgentReq: { agentId: string } | undefined;
    let runNodeCalled = false;
    const deps: RealClaudeCompatBackendDeps = {
      resolveConfig: async () => ({
        model: 'gpt-5.5',
        systemPrompt: 'closer',
        allowedTools: ['Read', 'Glob', 'Grep'],
        mcpServers: [],
        maxTurns: undefined,
        effort: 'high',
        thinking: 'adaptive',
        thinkingBudget: undefined,
        runtime: 'codex',
      }),
      runNode: (async () => {
        runNodeCalled = true;
        return {
          output: '',
          model: 'x',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          apiRequests: 0,
          toolUses: 0,
        };
      }) as RealClaudeCompatBackendDeps['runNode'],
      executeAgentFn: (async (req: { agentId: string }) => {
        executeAgentReq = req;
        return {
          output: 'walkthrough codex',
          model: 'gpt-5.5',
          runtime: 'codex',
          provider: 'openai',
          metrics: {
            inputTokens: 20,
            outputTokens: 8,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            toolUses: 1,
            apiRequests: 1,
            costUsd: 0.02,
            durationMs: 100,
          },
        };
      }) as RealClaudeCompatBackendDeps['executeAgentFn'],
    };

    const turn = makeRealCloserAgentTurn(deps);
    const result = await turn({
      runId: 'run-1',
      agentId: 'dynamic-workflow-closer',
      prompt: 'feche a entrega',
      cwd: '/repo',
      canUseTool: buildCloserCanUseTool({
        runId: 'run-1',
        workspaceCwd: '/repo',
        confirmGitWrite: () => true,
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe('walkthrough codex');
    expect(result.costUsd).toBe(0.02);
    expect(result.inputTokens).toBe(20);
    expect(result.model).toBe('gpt-5.5');
    expect(runNodeCalled).toBe(false);
    expect(executeAgentReq?.agentId).toBe('dynamic-workflow-closer');
  });

  it('com confirmacao NEGADA, git de escrita local e bloqueado (fail-closed)', async () => {
    const closerGuard = buildCloserCanUseTool({
      runId: 'run-1',
      workspaceCwd: '/repo/worktree/run-1',
      confirmGitWrite: () => false, // usuario nao confirmou.
    });
    let captured: ClaudeCompatExecInput | undefined;
    const turn = makeRealCloserAgentTurn(closerDeps((i) => (captured = i), ''));
    await turn({
      runId: 'run-1',
      agentId: 'dynamic-workflow-closer',
      prompt: 'p',
      cwd: '/repo/worktree/run-1',
      canUseTool: closerGuard,
    });
    const capturedCanUseTool = (captured as ClaudeCompatExecInput).canUseTool;
    const opts = { signal: new AbortController().signal, toolUseID: 't1', requestId: 'req-1' };
    const commit = await capturedCanUseTool('Bash', { command: 'git commit -m x' }, opts);
    expect(commit?.behavior).toBe('deny');
    const status = await capturedCanUseTool('Bash', { command: 'git status' }, opts);
    expect(status?.behavior).toBe('allow');
  });

  it('falha do executor vira turno ok:false com a mensagem (closer indisponivel)', async () => {
    const turn = makeRealCloserAgentTurn({
      resolveConfig: async () => ({
        model: 'm',
        systemPrompt: 'c',
        allowedTools: [],
        mcpServers: [],
        maxTurns: undefined,
        effort: 'high',
        thinking: 'adaptive',
        thinkingBudget: undefined,
        runtime: 'cloud',
      }),
      runNode: (async () => {
        throw new Error('provider limit');
      }) as RealClaudeCompatBackendDeps['runNode'],
    });
    const result = await turn({
      runId: 'run-1',
      agentId: 'dynamic-workflow-closer',
      prompt: 'p',
      cwd: '/repo',
      canUseTool: async () => ({ behavior: 'allow' }),
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain('provider limit');
  });
});

describe('closerGuardToSdkCanUseTool (bridge ComposedToolInput -> SDK CanUseTool)', () => {
  it('repassa allow/deny sem mexer na decisao do guard', async () => {
    const sdk = closerGuardToSdkCanUseTool(async ({ toolName }) =>
      toolName === 'Write' ? { behavior: 'allow' } : { behavior: 'deny', message: 'nope' },
    );
    const opts = { signal: new AbortController().signal, toolUseID: 't', requestId: 'req-1' };
    const allow = await sdk('Write', { file_path: '/x' }, opts);
    expect(allow?.behavior).toBe('allow');
    const deny = await sdk('Bash', { command: 'rm -rf /' }, opts);
    expect(deny?.behavior).toBe('deny');
    if (deny?.behavior === 'deny') expect(deny.message).toBe('nope');
  });
});

function makeRun(patch: Partial<DynamicWorkflowRun> = {}): DynamicWorkflowRun {
  return {
    id: 'run-1',
    definitionId: 'dwfd_prev',
    chatSessionId: null,
    status: 'blocked',
    currentPhaseId: null,
    currentNodeId: null,
    workspaceMode: 'run-worktree',
    baseBranch: 'main',
    baseCommitSha: 'base000',
    baseWorktreeHash: null,
    worktreePath: '/repo/worktree/run-1',
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
    startedAt: null,
    updatedAt: '2026-06-12T10:00:00.000Z',
    completedAt: null,
    ...patch,
  };
}

function mergeEvent(type: string): DynamicWorkflowEvent {
  return {
    id: 1,
    runId: 'run-1',
    nodeId: null,
    phaseId: null,
    seq: 1,
    type,
    payloadJson: '{}',
    createdAt: '2026-06-12T10:00:00.000Z',
  };
}

describe('closerReasonFromState (motivo derivado do estado real - R0/P2, 8.8)', () => {
  it('friccao de merge (worktree viva + evento merge-conflict) -> merge-conflict; cwd = worktree', () => {
    const run = makeRun({ status: 'blocked' });
    const reason = closerReasonFromState(run, [mergeEvent('merge-conflict')]);
    expect(reason).toBe('merge-conflict');
    const cwd = resolveCloserCwd({ run, reason, repoRoot: '/repo' });
    expect(cwd).toBe('/repo/worktree/run-1');
  });

  it('merge-recheck-failed (base andou + re-checks vermelhos) tambem -> merge-conflict', () => {
    const run = makeRun({ status: 'failed' });
    const reason = closerReasonFromState(run, [mergeEvent('merge-recheck-failed')]);
    expect(reason).toBe('merge-conflict');
  });

  it('delivered -> delivery (cwd = repo principal, worktree morreu no pos-merge)', () => {
    const run = makeRun({ status: 'delivered' });
    const reason = closerReasonFromState(run, []);
    expect(reason).toBe('delivery');
    const cwd = resolveCloserCwd({ run, reason, repoRoot: '/repo' });
    expect(cwd).toBe('/repo');
  });

  it('blocked SEM sinal de conflito -> user-request (socorro generico, cwd = repo)', () => {
    const run = makeRun({ status: 'blocked' });
    const reason = closerReasonFromState(run, [mergeEvent('run-blocked-snapshot')]);
    expect(reason).toBe('user-request');
    const cwd = resolveCloserCwd({ run, reason, repoRoot: '/repo' });
    expect(cwd).toBe('/repo');
  });

  it('fresh-project com conflito improvavel: sem worktree viva nao vira merge-conflict', () => {
    const run = makeRun({ workspaceMode: 'fresh-project', worktreePath: null, status: 'failed' });
    const reason = closerReasonFromState(run, [mergeEvent('merge-conflict')]);
    expect(reason).toBe('user-request');
  });
});
