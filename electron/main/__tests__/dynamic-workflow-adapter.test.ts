
import { describe, it, expect } from 'vitest';
import {
  runNodeAgent,
  createComposedCanUseTool,
  partitionSdkTools,
  isCommandAllowed,
  filterMcpServersByPolicy,
  dispatchFamilyOf,
  runtimeSupportsEffortOverride,
  ADAPTER_RUNTIME_CASES,
  type AdapterRuntime,
  type ClaudeCompatBackend,
  type CreateCodexSessionFn,
  type WorkflowAdapterDeps,
  type NodeRunResult,
} from '../dynamic-workflows/workflow-agent-adapter';
import { deriveNodeExecutionPolicy } from '../dynamic-workflows/workflow-policy';
import { WorkflowPathGuard } from '../dynamic-workflows/workflow-path-guard';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { AgentConfig } from '../../../src/types';

const ROOT = process.cwd();

function fakeResolved(over: Partial<AgentQueryConfig>): AgentQueryConfig {
  return {
    model: 'opus-test',
    systemPrompt: 'voce e um agente',
    allowedTools: ['Read', 'Grep'],
    mcpServers: [],
    maxTurns: undefined,
    effort: 'medium',
    thinking: 'adaptive',
    thinkingBudget: undefined,
    runtime: 'cloud',
    ...over,
  };
}

function fakeClaudeBackend(
  capture?: (args: Parameters<ClaudeCompatBackend>[0]) => void,
): ClaudeCompatBackend {
  return async (input) => {
    capture?.(input);
    return {
      output: 'resposta do agente',
      model: input.model,
      inputTokens: 1000,
      outputTokens: 200,
    };
  };
}

describe('workflow-agent-adapter: drift vs AgentConfig[runtime] (risco 19)', () => {
  it('ADAPTER_RUNTIME_CASES cobre EXATAMENTE os runtimes de node de AgentConfig', () => {
    const canonical: AgentConfig['runtime'][] = [
      'cloud',
      'local',
      'external',
      'codex',
      'kimi',
      'grok',
      'zai',
      'minimax-tp',
      'cursor',
    ];
    const adapterKeys = Object.keys(ADAPTER_RUNTIME_CASES).sort();
    expect(adapterKeys).toEqual([...canonical].sort());
  });

  it('toda chave do adapter e um AgentConfig[runtime] valido (assignabilidade)', () => {
    for (const key of Object.keys(ADAPTER_RUNTIME_CASES)) {
      const r: AgentConfig['runtime'] = key as AdapterRuntime;
      expect(typeof r).toBe('string');
    }
  });

  it('dispatchFamilyOf mapeia familias e devolve null p/ runtime desconhecido', () => {
    expect(dispatchFamilyOf('cloud')).toBe('claude-compatible');
    expect(dispatchFamilyOf('zai')).toBe('claude-compatible');
    expect(dispatchFamilyOf('codex')).toBe('codex');
    expect(dispatchFamilyOf('cursor')).toBe('cursor');
    expect(dispatchFamilyOf('local')).toBe('local-family');
    expect(dispatchFamilyOf('external')).toBe('local-family');
    expect(dispatchFamilyOf('lion-sdk')).toBeNull();
    expect(dispatchFamilyOf('google-genai')).toBeNull(); // nao e AgentConfig[runtime]
  });
});

describe('workflow-agent-adapter: canUseTool composto (AC-4 cloud, 8.3)', () => {
  function policyFor(access: 'read-only' | 'workspace-write', allowBash = false) {
    return deriveNodeExecutionPolicy(
      { allowedTools: ['Read', 'Write', 'Edit', 'Bash'], mcpServers: [], runtime: 'cloud' },
      {
        nodeId: 'n1',
        agentId: 'a1',
        access,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
        allowBash,
        allowedCommands: allowBash ? ['npm test', 'tsc'] : [],
      },
      { runId: 'r1', workspaceRoot: ROOT, cwd: ROOT },
      'canUseTool',
    );
  }

  it('read-only: NEGA Write/Edit/Bash incondicionalmente (independente do prompt)', () => {
    const policy = policyFor('read-only');
    const guard = new WorkflowPathGuard({ workspaceRoot: ROOT });
    const canUse = createComposedCanUseTool(policy, guard);
    expect(canUse({ toolName: 'Write', input: { file_path: `${ROOT}/a` } }).behavior).toBe('deny');
    expect(canUse({ toolName: 'Edit', input: { file_path: `${ROOT}/a` } }).behavior).toBe('deny');
    expect(canUse({ toolName: 'Bash', input: { command: 'ls' } }).behavior).toBe('deny');
    expect(canUse({ toolName: 'Read', input: { file_path: `${ROOT}/a` } }).behavior).toBe('allow');
  });

  it('rota lateral (Task/Agent/dynamic_workflow_*) e DENY estrutural sempre (AC-20)', () => {
    const policy = policyFor('workspace-write');
    const guard = new WorkflowPathGuard({ workspaceRoot: ROOT });
    const canUse = createComposedCanUseTool(policy, guard);
    expect(canUse({ toolName: 'Task', input: {} }).behavior).toBe('deny');
    expect(canUse({ toolName: 'Agent', input: {} }).behavior).toBe('deny');
    expect(canUse({ toolName: 'dynamic_workflow_create', input: {} }).behavior).toBe('deny');
    expect(canUse({ toolName: 'pipeline_drive', input: {} }).behavior).toBe('deny');
  });

  it('writer: Write dentro da raiz e permitido; fora da raiz e negado (path guard)', () => {
    const policy = policyFor('workspace-write');
    const guard = new WorkflowPathGuard({ workspaceRoot: ROOT });
    const canUse = createComposedCanUseTool(policy, guard);
    expect(canUse({ toolName: 'Write', input: { file_path: `${ROOT}/ok.txt` } }).behavior).toBe('allow');
    expect(canUse({ toolName: 'Write', input: { file_path: '/etc/passwd' } }).behavior).toBe('deny');
  });

  it('writer: Bash negado sem allowBash; permitido so para comando da allowlist', () => {
    const noBash = policyFor('workspace-write', false);
    const guard = new WorkflowPathGuard({ workspaceRoot: ROOT });
    expect(
      createComposedCanUseTool(noBash, guard)({ toolName: 'Bash', input: { command: 'npm test' } })
        .behavior,
    ).toBe('deny');

    const withBash = policyFor('workspace-write', true);
    const canUse = createComposedCanUseTool(withBash, guard);
    expect(canUse({ toolName: 'Bash', input: { command: 'npm test' } }).behavior).toBe('allow');
    expect(canUse({ toolName: 'Bash', input: { command: 'rm -rf /' } }).behavior).toBe('deny');
  });

  it('MCP tool-level (8.3): subset explicito NEGA tool fora dele e PERMITE dentro', () => {
    const policy = deriveNodeExecutionPolicy(
      {
        allowedTools: [],
        mcpServers: [{ 'repo-graph': { command: 'x' } }],
        runtime: 'cloud',
      },
      {
        nodeId: 'n1',
        access: 'read-only',
        allowedMcpServers: ['repo-graph'],
        allowedMcpTools: ['mcp__repo-graph__read_file'],
      },
      { runId: 'r1', workspaceRoot: ROOT, cwd: ROOT },
      'canUseTool',
    );
    expect(policy.allowedMcpTools).toEqual(['mcp__repo-graph__read_file']);
    const guard = new WorkflowPathGuard({ workspaceRoot: ROOT });
    const canUse = createComposedCanUseTool(policy, guard);
    expect(canUse({ toolName: 'mcp__repo-graph__read_file', input: {} }).behavior).toBe('allow');
    expect(canUse({ toolName: 'mcp__repo-graph__delete_file', input: {} }).behavior).toBe('deny');
  });

  it('MCP tool-level (8.3): allowedMcpTools VAZIO permite todas as tools do servidor', () => {
    const policy = deriveNodeExecutionPolicy(
      {
        allowedTools: [],
        mcpServers: [{ 'repo-graph': { command: 'x' } }],
        runtime: 'cloud',
      },
      { nodeId: 'n1', access: 'read-only', allowedMcpServers: ['repo-graph'] },
      { runId: 'r1', workspaceRoot: ROOT, cwd: ROOT },
      'canUseTool',
    );
    expect(policy.allowedMcpTools).toEqual([]);
    const guard = new WorkflowPathGuard({ workspaceRoot: ROOT });
    const canUse = createComposedCanUseTool(policy, guard);
    expect(canUse({ toolName: 'mcp__repo-graph__read_file', input: {} }).behavior).toBe('allow');
    expect(canUse({ toolName: 'mcp__repo-graph__delete_file', input: {} }).behavior).toBe('allow');
  });
});

describe('workflow-agent-adapter: helpers de policy/tools', () => {
  it('partitionSdkTools separa guard-gated (fora) das seguras (auto-aprovadas)', () => {
    const policy = deriveNodeExecutionPolicy(
      { allowedTools: ['Read', 'Grep', 'Write', 'Bash'], mcpServers: [], runtime: 'cloud' },
      {
        nodeId: 'n1',
        access: 'workspace-write',
        allowedTools: ['Read', 'Grep', 'Write', 'Bash'],
        allowBash: true,
        allowedCommands: ['npm test'],
      },
      { runId: 'r1', workspaceRoot: ROOT, cwd: ROOT },
      'canUseTool',
    );
    const { autoApproved, guardRouted } = partitionSdkTools(policy);
    expect(autoApproved).toEqual(expect.arrayContaining(['Read', 'Grep']));
    expect(autoApproved).not.toContain('Write');
    expect(autoApproved).not.toContain('Bash');
    expect(guardRouted).toEqual(expect.arrayContaining(['Write', 'Bash']));
  });

  it('isCommandAllowed: match por prefixo de token, nao substring', () => {
    expect(isCommandAllowed('npm test', ['npm test'])).toBe(true);
    expect(isCommandAllowed('npm test -- --watch', ['npm test'])).toBe(true);
    expect(isCommandAllowed('npm', ['npm test'])).toBe(false);
    expect(isCommandAllowed('format c:', ['rm'])).toBe(false);
    expect(isCommandAllowed('anything', [])).toBe(false);
  });

  it('filterMcpServersByPolicy mantem so os servidores efetivos', () => {
    const policy = deriveNodeExecutionPolicy(
      {
        allowedTools: [],
        mcpServers: [{ 'repo-graph': { command: 'x' } }, { 'knowledge-base': { command: 'y' } }],
        runtime: 'cloud',
      },
      { nodeId: 'n1', access: 'read-only', allowedMcpServers: ['repo-graph'] },
      { runId: 'r1', workspaceRoot: ROOT, cwd: ROOT },
      'canUseTool',
    );
    const filtered = filterMcpServersByPolicy(
      [{ 'repo-graph': { command: 'x' } }, { 'knowledge-base': { command: 'y' } }],
      policy,
    );
    expect(filtered).toHaveLength(1);
    expect(Object.keys(filtered[0])[0]).toBe('repo-graph');
  });
});

describe('workflow-agent-adapter: runNodeAgent (AC-3/AC-6/AC-7)', () => {
  const baseInput = {
    runId: 'run-1',
    agentId: 'a1',
    grants: { nodeId: 'n1', agentId: 'a1', access: 'read-only' as const, allowedTools: ['Read'] },
    workspace: { runId: 'run-1', workspaceRoot: ROOT, cwd: ROOT },
    prompt: 'faca o trabalho',
  };

  it('AC-3: agentId vazio falha sem resolver agente (label nunca resolve)', async () => {
    let resolverCalled = false;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => {
        resolverCalled = true;
        return fakeResolved({});
      },
    };
    const res = await runNodeAgent({ ...baseInput, agentId: '   ' }, deps);
    expect(res.ok).toBe(false);
    expect(res.failureClass).toBe('logic');
    expect(res.errorMessage).toContain('agentId obrigatorio');
    expect(resolverCalled).toBe(false);
  });

  it('AC-7: cloud roda pelo backend e persiste metrics normalizadas via callback', async () => {
    const sink: NodeRunResult[] = [];
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cloud', allowedTools: ['Read'] }),
      claudeCompat: fakeClaudeBackend(),
      onNodeRunResult: (r) => sink.push(r),
    };
    const res = await runNodeAgent(baseInput, deps);
    expect(res.ok).toBe(true);
    expect(res.runtime).toBe('cloud');
    expect(res.family).toBe('claude-compatible');
    expect(res.cost?.costStatus).toBe('known');
    expect(res.cost?.inputTokens).toBe(1000);
    expect(res.cost?.outputTokens).toBe(200);
    expect(res.mechanism).toBe('canUseTool');
    expect(sink).toHaveLength(1);
    expect(sink[0].output).toBe('resposta do agente');
  });

  it('AC-4 cloud: o backend recebe allowedTools SEM guard-gated + canUseTool composto', async () => {
    let captured: Parameters<ClaudeCompatBackend>[0] | undefined;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () =>
        fakeResolved({ runtime: 'cloud', allowedTools: ['Read', 'Write', 'Bash'] }),
      claudeCompat: fakeClaudeBackend((a) => (captured = a)),
    };
    await runNodeAgent(baseInput, deps);
    expect(captured).toBeDefined();
    expect(captured!.allowedTools).not.toContain('Write');
    expect(captured!.allowedTools).not.toContain('Bash');
    const decision = captured!.canUseTool({ toolName: 'Write', input: { file_path: `${ROOT}/x` } });
    expect(decision.behavior).toBe('deny');
  });

  it('AC-4 codex: sandbox derivado do access (read-only -> read-only)', async () => {
    let codexOpts: Parameters<CreateCodexSessionFn>[0] | undefined;
    const fakeCreate: CreateCodexSessionFn = async (opts) => {
      codexOpts = opts;
      return {
        threadId: 't',
        send: async () => ({
          threadId: 't',
          content: 'feito',
          filesChanged: [],
          commandsRun: [],
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 5,
            reasoningOutputTokens: 0,
            totalTokens: 15,
          },
          status: 'completed' as const,
          applyPatchFailures: 0,
          applyPatchFailureSamples: [],
        }),
        reply: async () => {
          throw new Error('nao usado');
        },
        close: () => undefined,
      };
    };
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'codex', allowedTools: [] }),
      createCodexSession: fakeCreate,
    };
    const res = await runNodeAgent(baseInput, deps);
    expect(res.ok).toBe(true);
    expect(res.runtime).toBe('codex');
    expect(codexOpts?.sandbox).toBe('read-only');
    expect(codexOpts?.ownerKind).toBe('pipeline');
    expect(codexOpts?.projectId).toBe('run-1');
    expect(codexOpts?.ownerId).toBe('dynamic-workflow:run-1:n1');
    expect(codexOpts?.approvalPolicy).toBe('never');
  });

  it('AC-4 codex writer: sandbox workspace-write quando access workspace-write', async () => {
    let codexOpts: Parameters<CreateCodexSessionFn>[0] | undefined;
    const fakeCreate: CreateCodexSessionFn = async (opts) => {
      codexOpts = opts;
      return {
        threadId: 't',
        send: async () => ({
          threadId: 't',
          content: 'ok',
          filesChanged: [],
          commandsRun: [],
          usage: {
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0,
          },
          status: 'completed' as const,
          applyPatchFailures: 0,
          applyPatchFailureSamples: [],
        }),
        reply: async () => {
          throw new Error('x');
        },
        close: () => undefined,
      };
    };
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'codex' }),
      createCodexSession: fakeCreate,
    };
    await runNodeAgent(
      {
        ...baseInput,
        grants: { nodeId: 'n1', access: 'workspace-write', allowedTools: [] },
      },
      deps,
    );
    expect(codexOpts?.sandbox).toBe('workspace-write');
  });

  it('falha do backend e capturada e classificada (nao derruba o adapter)', async () => {
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cloud', allowedTools: ['Read'] }),
      claudeCompat: async () => {
        throw new Error('Rate limit exceeded');
      },
    };
    const res = await runNodeAgent(baseInput, deps);
    expect(res.ok).toBe(false);
    expect(res.failureClass).toBe('provider-limit');
    expect(res.errorMessage).toContain('Rate limit');
  });

  it('codex + allowBash agora PASSA o preflight e executa (o sandbox contem o shell)', async () => {
    let created = false;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'codex' }),
      createCodexSession: async () => {
        created = true;
        return {
          threadId: 't',
          send: async () => ({
            threadId: 't',
            content: 'feito',
            filesChanged: [],
            commandsRun: [],
            usage: {
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              reasoningOutputTokens: 0,
              totalTokens: 15,
            },
            status: 'completed' as const,
            applyPatchFailures: 0,
            applyPatchFailureSamples: [],
          }),
          reply: async () => {
            throw new Error('x');
          },
          close: () => undefined,
        };
      },
    };
    const res = await runNodeAgent(
      {
        ...baseInput,
        grants: {
          nodeId: 'n1',
          access: 'workspace-write',
          allowedTools: ['Bash'],
          allowBash: true,
        },
      },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(created).toBe(true);
  });

  it('preflight bloqueia allowBash em runtime SEM allowlist E SEM sandbox (local) ANTES de executar', async () => {
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'local' }),
    };
    const res = await runNodeAgent(
      {
        ...baseInput,
        grants: {
          nodeId: 'n1',
          access: 'workspace-write',
          allowedTools: ['Bash'],
          allowBash: true,
        },
      },
      deps,
    );
    expect(res.ok).toBe(false); // local nao tem allowlist nem sandbox -> sem contencao
    expect(res.errorMessage).toContain('Bash');
  });
});


describe('workflow-agent-adapter: F3 override de modelo por dispatch path', () => {
  const baseInput = {
    runId: 'run-1',
    agentId: 'a1',
    grants: { nodeId: 'n1', agentId: 'a1', access: 'read-only' as const, allowedTools: ['Read'] },
    workspace: { runId: 'run-1', workspaceRoot: ROOT, cwd: ROOT },
    prompt: 'faca o trabalho',
  };

  function fakeCodex(capture: (o: Parameters<CreateCodexSessionFn>[0]) => void): CreateCodexSessionFn {
    return async (opts) => {
      capture(opts);
      return {
        threadId: 't',
        send: async () => ({
          threadId: 't',
          content: 'feito',
          filesChanged: [],
          commandsRun: [],
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 5,
            reasoningOutputTokens: 0,
            totalTokens: 15,
          },
          status: 'completed' as const,
          applyPatchFailures: 0,
          applyPatchFailureSamples: [],
        }),
        reply: async () => {
          throw new Error('nao usado');
        },
        close: () => undefined,
      };
    };
  }

  it('AC-F3-1 cloud (claude-compat): o backend RECEBE input.model = override (nao descarta)', async () => {
    let captured: Parameters<ClaudeCompatBackend>[0] | undefined;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cloud', allowedTools: ['Read'], model: 'opus-default' }),
      claudeCompat: fakeClaudeBackend((a) => (captured = a)),
    };
    const res = await runNodeAgent({ ...baseInput, effectiveModel: 'claude-sonnet-4-6' }, deps);
    expect(res.ok).toBe(true);
    expect(captured!.model).toBe('claude-sonnet-4-6');
    expect(captured!.runtime).toBe('cloud');
  });

  it('cloud SEM override: o backend recebe resolved.model (byte-identico ao legado)', async () => {
    let captured: Parameters<ClaudeCompatBackend>[0] | undefined;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cloud', allowedTools: ['Read'], model: 'opus-default' }),
      claudeCompat: fakeClaudeBackend((a) => (captured = a)),
    };
    await runNodeAgent(baseInput, deps);
    expect(captured!.model).toBe('opus-default');
  });

  it('AC-F3-1 codex (bridge): o session RECEBE opts.model = override', async () => {
    let codexOpts: Parameters<CreateCodexSessionFn>[0] | undefined;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'codex', allowedTools: [], model: 'gpt-codex-default' }),
      createCodexSession: fakeCodex((o) => (codexOpts = o)),
    };
    const res = await runNodeAgent({ ...baseInput, effectiveModel: 'gpt-5-codex-high' }, deps);
    expect(res.ok).toBe(true);
    expect(codexOpts!.model).toBe('gpt-5-codex-high');
    expect(res.cost).toBeDefined();
  });

  it('AC-F3-2 kimi: override = fatal model-unsupported-runtime (codex-family mas executeAgent)', async () => {
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'kimi', allowedTools: [] }),
      kimiBackend: async () => {
        throw new Error('kimi nao deveria ser chamado com override');
      },
    };
    const res = await runNodeAgent({ ...baseInput, effectiveModel: 'k2.7' }, deps);
    expect(res.ok).toBe(false);
    expect(res.failureClass).toBe('logic');
    expect(res.errorMessage).toContain('model-unsupported-runtime');
    expect(res.runtime).toBe('kimi');
  });

  it('AC-F3-2 local: override = fatal model-unsupported-runtime', async () => {
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'local' }),
    };
    const res = await runNodeAgent({ ...baseInput, effectiveModel: 'llama-3' }, deps);
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toContain('model-unsupported-runtime');
    expect(res.runtime).toBe('local');
  });

  it('AC-F3-2 external: override = fatal model-unsupported-runtime', async () => {
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'external' }),
    };
    const res = await runNodeAgent({ ...baseInput, effectiveModel: 'whatever' }, deps);
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toContain('model-unsupported-runtime');
    expect(res.runtime).toBe('external');
  });

  it('kimi sem override falha fechado quando read-only real nao e comprovado', async () => {
    let kimiCalled = false;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'kimi', allowedTools: ['Read'] }),
      kimiBackend: async (input) => {
        kimiCalled = true;
        return { output: 'ok', model: input.model, inputTokens: 1, outputTokens: 1 };
      },
    };
    const res = await runNodeAgent(baseInput, deps);
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toContain('read-only real');
    expect(kimiCalled).toBe(false);
  });
});

describe('workflow-agent-adapter: runtime cursor (SPEC cursor-runtime E6)', () => {
  const baseInput = {
    runId: 'run-1',
    agentId: 'a1',
    grants: { nodeId: 'n1', agentId: 'a1', access: 'read-only' as const, allowedTools: ['Read'] },
    workspace: { runId: 'run-1', workspaceRoot: ROOT, cwd: ROOT },
    prompt: 'faca o trabalho',
  };

  it('node cursor despacha pelo cursorBackend injetado (familia/mecanismo proprios)', async () => {
    let captured: Parameters<ClaudeCompatBackend>[0] | undefined;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () =>
        fakeResolved({ runtime: 'cursor', model: 'composer-2.5', allowedTools: ['Read', 'Write', 'Bash'] }),
      cursorBackend: async (input) => {
        captured = input;
        return { output: 'feito', model: input.model, inputTokens: 10, outputTokens: 5 };
      },
    };
    const res = await runNodeAgent(baseInput, deps);
    expect(res.ok).toBe(true);
    expect(res.runtime).toBe('cursor');
    expect(res.family).toBe('cursor');
    expect(res.mechanism).toBe('canUseTool');
    expect(captured!.runtime).toBe('cursor');
    expect(captured!.model).toBe('composer-2.5');
    expect(captured!.allowedTools).not.toContain('Write');
    expect(captured!.allowedTools).not.toContain('Bash');
    expect(
      captured!.canUseTool({ toolName: 'Write', input: { file_path: `${ROOT}/x` } }).behavior,
    ).toBe('deny');
  });

  it('model override VALIDA POR CATALOGO, nunca por prefixo: claude-* do catalogo Cursor aplica', async () => {
    let captured: Parameters<ClaudeCompatBackend>[0] | undefined;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cursor', model: 'composer-2.5', allowedTools: ['Read'] }),
      cursorBackend: async (input) => {
        captured = input;
        return { output: 'ok', model: input.model, inputTokens: 1, outputTokens: 1 };
      },
    };
    const res = await runNodeAgent({ ...baseInput, effectiveModel: 'claude-sonnet-5' }, deps);
    expect(res.ok).toBe(true);
    expect(captured!.model).toBe('claude-sonnet-5');
  });

  it('model override FORA do catalogo = fatal model-cross-family (fail-closed, backend nao chamado)', async () => {
    let backendCalled = false;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cursor', model: 'composer-2.5', allowedTools: ['Read'] }),
      cursorBackend: async () => {
        backendCalled = true;
        return { output: '', model: 'x' };
      },
    };
    const res = await runNodeAgent({ ...baseInput, effectiveModel: 'glm-4.7' }, deps);
    expect(res.ok).toBe(false);
    expect(res.failureClass).toBe('logic');
    expect(res.errorMessage).toContain('model-cross-family');
    expect(res.errorMessage).toContain('catalogo');
    expect(backendCalled).toBe(false);
  });

  it('cursorCatalogHasModel injetado decide o pertencimento (seam do cache vivo)', async () => {
    const seen: string[] = [];
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cursor', model: 'composer-2.5', allowedTools: ['Read'] }),
      cursorCatalogHasModel: (m) => {
        seen.push(m);
        return m === 'novo-modelo-live';
      },
      cursorBackend: async (input) => ({ output: 'ok', model: input.model }),
    };
    const ok = await runNodeAgent({ ...baseInput, effectiveModel: 'novo-modelo-live' }, deps);
    expect(ok.ok).toBe(true);
    const bad = await runNodeAgent({ ...baseInput, effectiveModel: 'fora-do-catalogo' }, deps);
    expect(bad.ok).toBe(false);
    expect(bad.errorMessage).toContain('model-cross-family');
    expect(seen).toEqual(['novo-modelo-live', 'fora-do-catalogo']);
  });

  it('model do catalogo Cursor em node de OUTRO runtime segue fatal (cross-provider intacto)', async () => {
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cloud', allowedTools: ['Read'] }),
      claudeCompat: fakeClaudeBackend(),
    };
    const res = await runNodeAgent({ ...baseInput, effectiveModel: 'composer-2.5' }, deps);
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toContain('model-cross-family');
  });

  it('effort override em node cursor = fatal effort-unsupported-model (nenhum modelo 1.0.30 anuncia tiers)', async () => {
    let backendCalled = false;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cursor', model: 'composer-2.5', allowedTools: ['Read'] }),
      cursorBackend: async () => {
        backendCalled = true;
        return { output: '', model: 'x' };
      },
    };
    const res = await runNodeAgent({ ...baseInput, effectiveEffort: 'high' as const }, deps);
    expect(res.ok).toBe(false);
    expect(res.failureClass).toBe('logic');
    expect(res.errorMessage).toContain('effort-unsupported-model');
    expect(backendCalled).toBe(false);
    expect(runtimeSupportsEffortOverride('cursor')).toBe(true);
  });

  it('cursor sem backend injetado falha com erro claro (nunca silencioso)', async () => {
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cursor', model: 'composer-2.5', allowedTools: ['Read'] }),
    };
    const res = await runNodeAgent(baseInput, deps);
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toContain('cursorBackend nao injetado');
  });
});

describe('workflow-agent-adapter: forced structured output (SPEC-010 sec 3/5.1, S08)', () => {
  const baseInput = {
    runId: 'run-1',
    agentId: 'a1',
    grants: { nodeId: 'n1', agentId: 'a1', access: 'read-only' as const, allowedTools: ['Read'] },
    workspace: { runId: 'run-1', workspaceRoot: ROOT, cwd: ROOT },
    prompt: 'gere o plano',
  };
  const SCHEMA = { name: 'plan', type: 'object' as const, required: ['sprints'] };

  it('node SEM schema: caminho legado, sem structuredOutput (texto cru)', async () => {
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cloud', allowedTools: ['Read'] }),
      claudeCompat: fakeClaudeBackend(),
    };
    const res = await runNodeAgent(baseInput, deps);
    expect(res.ok).toBe(true);
    expect(res.structuredOutput).toBeUndefined();
    expect(res.output).toBe('resposta do agente');
  });

  it('forced-tool (cloud): usa o `structured` do backend e devolve em structuredOutput', async () => {
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cloud', allowedTools: ['Read'] }),
      claudeCompat: async (input) => ({
        output: 'ignorado',
        model: input.model,
        inputTokens: 100,
        outputTokens: 20,
        structured: { sprints: [{ id: 's0' }] },
      }),
    };
    const res = await runNodeAgent({ ...baseInput, outputSchema: SCHEMA }, deps);
    expect(res.ok).toBe(true);
    expect(res.structuredOutput).toEqual({ sprints: [{ id: 's0' }] });
  });

  it('parse-repair (codex): extrai o objeto do texto e valida', async () => {
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'codex', allowedTools: [] }),
      createCodexSession: async () => ({
        threadId: 't',
        send: async () => ({
          threadId: 't',
          content: 'aqui esta: {"sprints":[{"id":"s0"}]}',
          filesChanged: [],
          commandsRun: [],
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 5,
            reasoningOutputTokens: 0,
            totalTokens: 15,
          },
          status: 'completed' as const,
          applyPatchFailures: 0,
          applyPatchFailureSamples: [],
        }),
        reply: async () => {
          throw new Error('x');
        },
        close: () => undefined,
      }),
    };
    const res = await runNodeAgent({ ...baseInput, outputSchema: SCHEMA }, deps);
    expect(res.ok).toBe(true);
    expect(res.structuredOutput).toEqual({ sprints: [{ id: 's0' }] });
  });

  it('reprompt bounded: 1a saida invalida, 2a corrige (feedback anexado ao prompt)', async () => {
    const prompts: string[] = [];
    let call = 0;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cloud', allowedTools: ['Read'] }),
      claudeCompat: async (input) => {
        prompts.push(input.prompt);
        call++;
        return {
          output: call === 1 ? '{"foo":1}' : '{"sprints":[]}',
          model: input.model,
          inputTokens: 50,
          outputTokens: 10,
        };
      },
    };
    const res = await runNodeAgent({ ...baseInput, outputSchema: SCHEMA }, deps);
    expect(res.ok).toBe(true);
    expect(res.structuredOutput).toEqual({ sprints: [] });
    expect(call).toBe(2);
    expect(res.cost?.inputTokens).toBe(100);
    expect(res.cost?.outputTokens).toBe(20);
    expect(prompts[1]).toContain('sprints');
  });

  it('saida fora do schema apos retries -> failureClass schema (AC-6)', async () => {
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cloud', allowedTools: ['Read'] }),
      claudeCompat: async (input) => ({
        output: '{"foo":1}', // nunca tem `sprints`
        model: input.model,
        inputTokens: 10,
        outputTokens: 5,
      }),
    };
    const res = await runNodeAgent(
      { ...baseInput, outputSchema: SCHEMA, maxSchemaAttempts: 2 },
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.failureClass).toBe('schema');
    expect(res.structuredOutput).toBeUndefined();
    expect(res.errorMessage).toContain('sprints');
  });
});


describe('workflow-agent-adapter: S4 override de effort por dispatch path', () => {
  const baseInput = {
    runId: 'run-1',
    agentId: 'a1',
    grants: { nodeId: 'n1', agentId: 'a1', access: 'read-only' as const, allowedTools: ['Read'] },
    workspace: { runId: 'run-1', workspaceRoot: ROOT, cwd: ROOT },
    prompt: 'faca o trabalho',
  };

  function fakeCodex(capture: (o: Parameters<CreateCodexSessionFn>[0]) => void): CreateCodexSessionFn {
    return async (opts) => {
      capture(opts);
      return {
        threadId: 't',
        send: async () => ({
          threadId: 't',
          content: 'feito',
          filesChanged: [],
          commandsRun: [],
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 5,
            reasoningOutputTokens: 0,
            totalTokens: 15,
          },
          status: 'completed' as const,
          applyPatchFailures: 0,
          applyPatchFailureSamples: [],
        }),
        reply: async () => {
          throw new Error('nao usado');
        },
        close: () => undefined,
      };
    };
  }

  it('cloud (claude-compat): effort "xhigh" chega ao backend como "max" (mapeamento canonico do chat)', async () => {
    let captured: Parameters<ClaudeCompatBackend>[0] | undefined;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cloud', allowedTools: ['Read'] }),
      claudeCompat: fakeClaudeBackend((a) => (captured = a)),
    };
    const res = await runNodeAgent({ ...baseInput, effectiveEffort: 'xhigh' }, deps);
    expect(res.ok).toBe(true);
    expect(captured!.effort).toBe('max');
  });

  it('zai (claude-compat): effort "low" passa 1:1 ao backend', async () => {
    let captured: Parameters<ClaudeCompatBackend>[0] | undefined;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'zai', allowedTools: ['Read'] }),
      claudeCompat: fakeClaudeBackend((a) => (captured = a)),
    };
    const res = await runNodeAgent({ ...baseInput, effectiveEffort: 'low' }, deps);
    expect(res.ok).toBe(true);
    expect(captured!.effort).toBe('low');
  });

  it('claude-compat SEM override: o backend NAO recebe effort (config do agentType manda; byte-identico)', async () => {
    let captured: Parameters<ClaudeCompatBackend>[0] | undefined;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cloud', allowedTools: ['Read'] }),
      claudeCompat: fakeClaudeBackend((a) => (captured = a)),
    };
    await runNodeAgent(baseInput, deps);
    expect(captured!.effort).toBeUndefined();
  });

  it('codex (bridge): effort do override chega em sessionOptions.reasoningEffort, com PRECEDENCIA sobre o codexConfig do agente', async () => {
    let codexOpts: Parameters<CreateCodexSessionFn>[0] | undefined;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'codex', allowedTools: [], model: 'gpt-5.5' }),
      getAgentConfig: () => ({ codexConfig: { reasoningEffort: 'medium' } }) as never,
      createCodexSession: fakeCodex((o) => (codexOpts = o)),
    };
    const res = await runNodeAgent({ ...baseInput, effectiveEffort: 'low' }, deps);
    expect(res.ok).toBe(true);
    expect(codexOpts!.reasoningEffort).toBe('low');
  });

  it('codex SEM override: reasoningEffort segue o codexConfig do agente (legado intacto)', async () => {
    let codexOpts: Parameters<CreateCodexSessionFn>[0] | undefined;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'codex', allowedTools: [], model: 'gpt-5.5' }),
      getAgentConfig: () => ({ codexConfig: { reasoningEffort: 'medium' } }) as never,
      createCodexSession: fakeCodex((o) => (codexOpts = o)),
    };
    await runNodeAgent(baseInput, deps);
    expect(codexOpts!.reasoningEffort).toBe('medium');
  });

  it('codex preserva effort "xhigh" para o caminho oficial', async () => {
    for (const model of ['gpt-5.5', 'gpt-5.2']) {
      let codexOpts: Parameters<CreateCodexSessionFn>[0] | undefined;
      const deps: WorkflowAdapterDeps = {
        resolveConfig: async () => fakeResolved({ runtime: 'codex', allowedTools: [], model }),
        createCodexSession: fakeCodex((o) => (codexOpts = o)),
      };
      const res = await runNodeAgent({ ...baseInput, effectiveEffort: 'xhigh' }, deps);
      expect(res.ok).toBe(true);
      expect(codexOpts!.reasoningEffort).toBe('xhigh');
    }
  });

  it('kimi reconhece override de effort antes do preflight de sandbox', async () => {
    expect(runtimeSupportsEffortOverride('kimi')).toBe(true);
    const res = await runNodeAgent({ ...baseInput, effectiveEffort: 'high' }, {
      resolveConfig: async () => fakeResolved({ runtime: 'kimi', allowedTools: ['Read'] }),
      kimiBackend: async () => ({ output: 'nao deve rodar', model: 'kimi-code/kimi-for-coding' }),
    });
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toContain('read-only real');
    expect(res.errorMessage).not.toContain('effort-unsupported-runtime');
  });

  it('local/external: effort = fatal effort-unsupported-runtime (logic, backend nunca chamado)', async () => {
    for (const runtime of ['local', 'external'] as const) {
      const deps: WorkflowAdapterDeps = {
        resolveConfig: async () => fakeResolved({ runtime, allowedTools: [] }),
        kimiBackend: async () => {
          throw new Error('kimi nao deveria ser chamado com effort override');
        },
      };
      const res = await runNodeAgent({ ...baseInput, effectiveEffort: 'high' }, deps);
      expect(res.ok).toBe(false);
      expect(res.failureClass).toBe('logic');
      expect(res.errorMessage).toContain('effort-unsupported-runtime');
      expect(res.runtime).toBe(runtime);
    }
  });
});

describe('workflow-agent-adapter: S4 model-cross-family (fail-closed por prefixo)', () => {
  const baseInput = {
    runId: 'run-1',
    agentId: 'a1',
    grants: { nodeId: 'n1', agentId: 'a1', access: 'read-only' as const, allowedTools: ['Read'] },
    workspace: { runId: 'run-1', workspaceRoot: ROOT, cwd: ROOT },
    prompt: 'faca o trabalho',
  };

  it('gpt-* em node CLOUD = fatal model-cross-family (backend nunca chamado)', async () => {
    let backendCalled = false;
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cloud', allowedTools: ['Read'] }),
      claudeCompat: fakeClaudeBackend(() => (backendCalled = true)),
    };
    const res = await runNodeAgent({ ...baseInput, effectiveModel: 'gpt-5.2' }, deps);
    expect(res.ok).toBe(false);
    expect(res.failureClass).toBe('logic');
    expect(res.errorMessage).toContain('model-cross-family');
    expect(res.errorMessage).toContain('gpt-5.2');
    expect(res.errorMessage).toContain('cloud');
    expect(backendCalled).toBe(false);
  });

  it('claude-* em node CODEX = fatal model-cross-family', async () => {
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'codex', allowedTools: [] }),
      createCodexSession: async () => {
        throw new Error('bridge nao deveria ser chamado com model cross-family');
      },
    };
    const res = await runNodeAgent({ ...baseInput, effectiveModel: 'claude-sonnet-5' }, deps);
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toContain('model-cross-family');
    expect(res.errorMessage).toContain('claude-sonnet-5');
    expect(res.errorMessage).toContain('codex');
  });

  it('model de familia DESCONHECIDA = fatal (fail-closed, nao aceita desconhecido-plausivel)', async () => {
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'cloud', allowedTools: ['Read'] }),
      claudeCompat: fakeClaudeBackend(),
    };
    const res = await runNodeAgent({ ...baseInput, effectiveModel: 'llama-3-70b' }, deps);
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toContain('model-cross-family');
    expect(res.errorMessage).toContain('fail-closed');
  });

  it('INTRA-familia continua aplicando: glm-* em zai e MiniMax-* (case-insensitive) em minimax-tp', async () => {
    let captured: Parameters<ClaudeCompatBackend>[0] | undefined;
    const zaiDeps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'zai', allowedTools: ['Read'], model: 'glm-default' }),
      claudeCompat: fakeClaudeBackend((a) => (captured = a)),
    };
    const zaiRes = await runNodeAgent({ ...baseInput, effectiveModel: 'glm-4.7' }, zaiDeps);
    expect(zaiRes.ok).toBe(true);
    expect(captured!.model).toBe('glm-4.7');

    const mmDeps: WorkflowAdapterDeps = {
      resolveConfig: async () =>
        fakeResolved({ runtime: 'minimax-tp', allowedTools: ['Read'], model: 'minimax-default' }),
      claudeCompat: fakeClaudeBackend((a) => (captured = a)),
    };
    const mmRes = await runNodeAgent({ ...baseInput, effectiveModel: 'MiniMax-M2.7' }, mmDeps);
    expect(mmRes.ok).toBe(true);
    expect(captured!.model).toBe('MiniMax-M2.7');
  });
});


describe('S5 codex costStatus honesto (unknown-pricing)', () => {
  const baseInput = {
    runId: 'run-1',
    agentId: 'a1',
    grants: { nodeId: 'n1', agentId: 'a1', access: 'read-only' as const, allowedTools: [] as string[] },
    workspace: { runId: 'run-1', workspaceRoot: ROOT, cwd: ROOT },
    prompt: 'faca o trabalho',
  };

  const fakeCreate: CreateCodexSessionFn = async () => ({
    threadId: 't',
    send: async () => ({
      threadId: 't',
      content: 'feito',
      filesChanged: [],
      commandsRun: [],
      usage: {
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 200,
        reasoningOutputTokens: 0,
        totalTokens: 1200,
      },
      status: 'completed' as const,
      applyPatchFailures: 0,
      applyPatchFailureSamples: [],
    }),
    reply: async () => {
      throw new Error('nao usado');
    },
    close: () => undefined,
  });

  it('model codex FORA da tabela de pricing -> costStatus unknown + unknown-pricing (nao $0 known)', async () => {
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () =>
        fakeResolved({ runtime: 'codex', allowedTools: [], model: 'gpt-99-experimental' }),
      createCodexSession: fakeCreate,
      hasKnownPricing: () => false,
    };
    const res = await runNodeAgent(baseInput, deps);
    expect(res.ok).toBe(true);
    expect(res.runtime).toBe('codex');
    expect(res.cost?.costStatus).toBe('unknown');
    expect(res.cost?.costUnknownReason).toBe('unknown-pricing');
  });

  it('model codex NA tabela (gpt-5.4 via pricing REAL) -> known com custo calculado', async () => {
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () => fakeResolved({ runtime: 'codex', allowedTools: [], model: 'gpt-5.4' }),
      createCodexSession: fakeCreate,
    };
    const res = await runNodeAgent(baseInput, deps);
    expect(res.ok).toBe(true);
    expect(res.cost?.costStatus).toBe('known');
    expect(res.cost?.costUnknownReason).toBeNull();
    expect(res.cost?.costUsd ?? 0).toBeGreaterThan(0);
  });

  it('pricing REAL: model desconhecido de verdade tambem vira unknown (sem injecao)', async () => {
    const deps: WorkflowAdapterDeps = {
      resolveConfig: async () =>
        fakeResolved({ runtime: 'codex', allowedTools: [], model: 'modelo-inexistente-xyz' }),
      createCodexSession: fakeCreate,
    };
    const res = await runNodeAgent(baseInput, deps);
    expect(res.ok).toBe(true);
    expect(res.cost?.costStatus).toBe('unknown');
    expect(res.cost?.costUnknownReason).toBe('unknown-pricing');
    expect(res.cost?.costUsd).toBe(0);
  });
});
