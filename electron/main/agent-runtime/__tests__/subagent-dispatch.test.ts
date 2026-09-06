import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
  start: vi.fn(),
  finalize: vi.fn(),
  finalizeRoot: vi.fn(),
  audit: vi.fn(),
  execute: vi.fn(),
  resolveConfig: vi.fn(),
  getMcpTools: vi.fn(),
}));

vi.mock('../../db', () => ({
  getAgent: mocks.getAgent,
  startTaskExecution: mocks.start,
  finalizeTaskExecutionOnce: mocks.finalize,
  finalizeTaskExecutionRootIfIdle: mocks.finalizeRoot,
  insertAuditEntry: mocks.audit,
}));
vi.mock('../execute', () => ({ executeAgent: mocks.execute }));
vi.mock('../../agent-config-resolver', () => ({
  resolveAgentQueryConfig: mocks.resolveConfig,
}));
vi.mock('../../mcp-manager', () => ({
  getMCPToolsFromRegistry: mocks.getMcpTools,
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  createSubagentDispatchContext,
  createSubagentConfinedPermission,
  dispatchLionSubagent,
  MAX_SUBAGENT_DEPTH,
  pendingSubagentProviderAuthError,
  resolveSubagentHostAllowedTools,
  subagentAuthFailure,
  withResolvedRootSubagentGrants,
} from '../subagent-dispatch';

const permission = {
  mode: 'default' as const,
  dangerouslySkipPermissions: false,
};

function host(overrides: Partial<Parameters<typeof createSubagentDispatchContext>[0]> = {}) {
  return createSubagentDispatchContext({
    ownerKind: 'chat',
    ownerId: 'session-1',
    sessionId: 'session-1',
    lane: 'desktop',
    surface: 'test-chat',
    cwd: '/workspace/canonical',
    readRoots: ['/workspace/canonical'],
    writeRoots: ['/workspace/canonical'],
    allowedTools: [
      'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebSearch', 'WebFetch', 'Agent',
    ],
    permission,
    parentAbortSignal: new AbortController().signal,
    inheritedEffort: { claude: 'high', codex: 'high', kimi: 'high', grok: 'high' },
    ...overrides,
  });
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'codex-coder',
    name: 'Cloud Coder',
    runtime: 'cloud',
    model: 'claude-sonnet-4-6',
    isActive: true,
    squad: 'backend',
    ...overrides,
  };
}

function result() {
  return {
    output: 'feito',
    model: 'claude-sonnet-4-6',
    runtime: 'cloud' as const,
    provider: 'anthropic',
    metrics: {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheCreationTokens: 0,
      apiRequests: 2,
      toolUses: 3,
      costUsd: 0.012,
      durationMs: 800,
      costStatus: 'known' as const,
      tokenStatus: 'reported' as const,
    },
    metadata: { providerRequestId: 'req-1' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAgent.mockReturnValue(agent());
  mocks.resolveConfig.mockResolvedValue({
    model: 'claude-sonnet-4-6',
    systemPrompt: 'system',
    allowedTools: ['Read', 'Write'],
    mcpServers: [],
    maxTurns: 10,
    effort: 'high',
    thinking: false,
    thinkingBudget: undefined,
    runtime: 'cloud',
  });
  mocks.getMcpTools.mockReturnValue([]);
  mocks.execute.mockResolvedValue(result());
});

describe('subagent dispatch provider-neutral', () => {
  it('preserva integralmente o perfil de permissao normal da surface', () => {
    const canUseTool = vi.fn(async (_toolName, input) => ({
      behavior: 'allow' as const,
      updatedInput: input,
    }));
    const configuredPermission = {
      mode: 'bypassPermissions' as const,
      dangerouslySkipPermissions: true,
      canUseTool,
    };
    const context = host({ permission: configuredPermission });

    const resolved = createSubagentConfinedPermission(context);

    expect(resolved).toEqual(configuredPermission);
    expect(resolved.canUseTool).toBe(canUseTool);
  });

  it('usa somente workspace, permissao, ancestry e effort cunhados pelo host', async () => {
    const context = host();
    const dispatched = await dispatchLionSubagent(
      {
        agentId: 'codex-coder',
        prompt: 'implemente',
        context: 'contexto validado',
        toolUseId: 'tool-call-1',
      },
      context,
    );

    expect(dispatched).toMatchObject({
      ok: true,
      output: 'feito',
      runtime: 'cloud',
      costUsd: 0.012,
      usage: { inputTokens: 120, outputTokens: 30, apiRequests: 2, toolUses: 3 },
    });
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex-coder',
      prompt: 'contexto validado\n\nimplemente',
      cwd: '/workspace/canonical',
      permission,
      inheritedEffort: { claude: 'high', codex: 'high', kimi: 'high', grok: 'high' },
      executionContext: expect.objectContaining({
        rootExecutionId: context.rootExecutionId,
        depth: 1,
        remainingBudget: 15,
      }),
    }));
    expect(mocks.start).toHaveBeenNthCalledWith(1, expect.objectContaining({
      executionId: context.rootExecutionId,
      rootExecutionId: context.rootExecutionId,
      parentExecutionId: null,
      executionKind: 'root',
      ownerKind: 'chat',
      ownerId: 'session-1',
      sessionId: 'session-1',
      toolUseId: null,
    }));
    expect(mocks.start).toHaveBeenNthCalledWith(2, expect.objectContaining({
      executionId: dispatched.executionId,
      rootExecutionId: context.rootExecutionId,
      parentExecutionId: context.rootExecutionId,
      executionKind: 'subagent',
      toolUseId: 'tool-call-1',
    }));
    expect(mocks.finalize).toHaveBeenCalledWith(dispatched.executionId, expect.objectContaining({
      status: 'completed',
      provider: 'anthropic',
      inputTokens: 120,
      outputTokens: 30,
      metadata: { providerRequestId: 'req-1' },
    }));
  });

  it('persiste request id MCP somente como correlacao de transporte', async () => {
    const context = host();
    const dispatched = await dispatchLionSubagent(
      {
        agentId: 'codex-coder',
        prompt: 'implemente',
        transportCorrelation: { kind: 'mcp-request-id', value: '73' },
      },
      context,
    );

    expect(mocks.start).toHaveBeenNthCalledWith(2, expect.objectContaining({
      executionId: dispatched.executionId,
      toolUseId: null,
      metadata: expect.objectContaining({
        transportCorrelation: { kind: 'mcp-request-id', value: '73' },
      }),
    }));
    expect(mocks.finalize).toHaveBeenCalledWith(dispatched.executionId, expect.objectContaining({
      metadata: expect.objectContaining({
        transportCorrelation: { kind: 'mcp-request-id', value: '73' },
      }),
    }));
  });

  it('propaga cancelamento do pai e finaliza a filha uma unica vez', async () => {
    const parent = new AbortController();
    const context = host({ parentAbortSignal: parent.signal });
    mocks.execute.mockImplementation(async (request) => {
      parent.abort('stop');
      expect(request.abortController.signal.aborted).toBe(true);
      throw new Error('cancelado');
    });

    const dispatched = await dispatchLionSubagent(
      { agentId: 'codex-coder', prompt: 'trabalho' },
      context,
    );

    expect(dispatched).toMatchObject({ ok: false, error: 'cancelado' });
    expect(mocks.finalize).toHaveBeenCalledOnce();
    expect(mocks.finalize).toHaveBeenCalledWith(dispatched.executionId, expect.objectContaining({
      status: 'cancelled',
      tokenStatus: 'not_reported',
      costStatus: 'unknown',
    }));
  });

  it('falha fechado antes de executar quando depth ou budget estouram', async () => {
    const tooDeep = host();
    tooDeep.depth = MAX_SUBAGENT_DEPTH;
    const noBudget = host();
    noBudget.remainingBudget = 0;

    await expect(dispatchLionSubagent({ agentId: 'codex-coder', prompt: 'x' }, tooDeep))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('Profundidade') });
    await expect(dispatchLionSubagent({ agentId: 'codex-coder', prompt: 'x' }, noBudget))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('Budget') });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledTimes(2);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'tool_blocked',
      toolName: 'system:subagent-dispatch',
      approved: false,
    }));
  });

  it('permite qualquer squad configurado e continua rejeitando agente inativo', async () => {
    mocks.getAgent.mockReturnValueOnce(agent({ squad: 'pipeline' }));
    const internal = await dispatchLionSubagent(
      { agentId: 'codex-coder', prompt: 'x' },
      host(),
    );
    mocks.getAgent.mockReturnValueOnce(agent({ isActive: false }));
    const inactive = await dispatchLionSubagent(
      { agentId: 'codex-coder', prompt: 'x' },
      host(),
    );

    expect(internal).toMatchObject({ ok: true });
    expect(inactive).toMatchObject({ ok: false, error: expect.stringContaining('desativado') });
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it('preserva tools configuradas mesmo sem writeRoots adicionais no dispatcher', async () => {
    mocks.getAgent.mockReturnValue(agent({ allowedTools: ['Read', 'Write'] }));
    mocks.resolveConfig.mockResolvedValueOnce({
      ...(await mocks.resolveConfig()),
      allowedTools: ['Read', 'Write'],
    });
    const dispatched = await dispatchLionSubagent(
      { agentId: 'codex-coder', prompt: 'x' },
      host({ writeRoots: [] }),
    );
    expect(dispatched).toMatchObject({ ok: true });
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      allowedToolsOverride: ['Read', 'Write'],
    }));
  });

  it('despacha Codex com a configuracao integral do agente', async () => {
    mocks.getAgent.mockReturnValueOnce(agent({ runtime: 'codex', model: 'gpt-5.6-codex' }));
    mocks.resolveConfig.mockResolvedValueOnce({
      ...(await mocks.resolveConfig()),
      runtime: 'codex',
      model: 'gpt-5.6-codex',
    });

    await expect(dispatchLionSubagent(
      { agentId: 'codex-coder', prompt: 'x' },
      host(),
    )).resolves.toMatchObject({ ok: true });
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      allowedToolsOverride: ['Read', 'Write'],
      resolvedConfigOverride: expect.objectContaining({ runtime: 'codex' }),
    }));
  });

  it('preserva tools configuradas para Local/External', async () => {
    mocks.getAgent.mockReturnValueOnce(agent({ runtime: 'local', model: 'llama-local' }));
    mocks.resolveConfig.mockResolvedValueOnce({
      ...(await mocks.resolveConfig()),
      runtime: 'local',
      model: 'llama-local',
      allowedTools: ['Read', 'Write', 'WebSearch'],
    });

    await dispatchLionSubagent({ agentId: 'codex-coder', prompt: 'x' }, host());
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      allowedToolsOverride: ['Read', 'Write', 'WebSearch'],
    }));
  });

  it('preserva a allowlist configurada do filho sem herdar restricoes do pai', async () => {
    mocks.getAgent.mockReturnValue(agent({ allowedTools: ['Read', 'Bash'] }));
    mocks.resolveConfig.mockResolvedValueOnce({
      ...(await mocks.resolveConfig()),
      allowedTools: ['Read', 'Bash'],
    });
    const context = host({ allowedTools: ['Read'] });
    await dispatchLionSubagent({ agentId: 'codex-coder', prompt: 'x' }, context);
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      allowedToolsOverride: ['Read', 'Bash'],
      executionContext: expect.objectContaining({
        capabilityCeiling: expect.objectContaining({ allowedTools: ['Read', 'Bash'] }),
      }),
    }));
    expect(Object.isFrozen(context.capabilityCeiling)).toBe(true);
    expect(Object.isFrozen(context.capabilityCeiling.allowedTools)).toBe(true);
    expect(Object.isFrozen(context.capabilityCeiling.allowedMcpServerIds)).toBe(true);
  });

  it('consome um budget compartilhado por toda a arvore', async () => {
    let firstChildContext: ReturnType<typeof host> | undefined;
    mocks.execute.mockImplementation(async (request) => {
      firstChildContext ??= request.executionContext;
      return result();
    });
    const root = host({ budget: 2 });
    await dispatchLionSubagent({ agentId: 'codex-coder', prompt: 'primeiro' }, root);
    await dispatchLionSubagent({ agentId: 'codex-coder', prompt: 'segundo' }, root);
    expect(firstChildContext).toBeDefined();
    await expect(dispatchLionSubagent(
      { agentId: 'codex-coder', prompt: 'neto' },
      firstChildContext!,
    )).resolves.toMatchObject({ ok: false, error: expect.stringContaining('Budget') });
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it('exige sessionId host-side para owner de chat', () => {
    expect(() => createSubagentDispatchContext({
      ownerKind: 'chat',
      ownerId: 'turno',
      lane: 'desktop',
      surface: 'test',
      cwd: '/workspace',
      permission,
      parentAbortSignal: new AbortController().signal,
    })).toThrow('sessionId do host');
  });

  it('repropaga auth de provider, marca controle compartilhado e aborta o owner', async () => {
    const { CodexAuthError } = await import('../../codex-runtime/errors');
    const abortOwner = vi.fn();
    const context = host({ abortOwner });
    const authError = new CodexAuthError('login necessario');
    mocks.execute.mockRejectedValueOnce(authError);

    await expect(dispatchLionSubagent(
      { agentId: 'codex-coder', prompt: 'x' },
      context,
    )).rejects.toBe(authError);

    expect(context.controlState?.providerAuthError).toBe(authError);
    expect(abortOwner).toHaveBeenCalledWith(authError);
    expect(subagentAuthFailure(authError)).toEqual({
      code: 'SUBAGENT_AUTH_REQUIRED',
      authProvider: 'codex',
      error: 'login necessario',
    });
    expect(mocks.finalize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      tokenStatus: 'not_reported',
      costStatus: 'unknown',
    }));
  });

  it('repropaga KimiAuthError pelo mesmo boundary provider-neutral', async () => {
    const { KimiAuthError } = await import('../kimi-availability');
    const abortOwner = vi.fn();
    const context = host({ abortOwner });
    const authError = new KimiAuthError('login Kimi necessario');
    mocks.execute.mockRejectedValueOnce(authError);

    await expect(dispatchLionSubagent(
      { agentId: 'codex-coder', prompt: 'x' },
      context,
    )).rejects.toBe(authError);

    expect(context.controlState?.providerAuthError).toBe(authError);
    expect(abortOwner).toHaveBeenCalledWith(authError);
  });

  it('recupera auth tipada propagada como motivo do abort do owner', async () => {
    const { CodexAuthError } = await import('../../codex-runtime/errors');
    const ownerAbort = new AbortController();
    const authError = new CodexAuthError('login necessario');
    ownerAbort.abort(authError);

    expect(pendingSubagentProviderAuthError(undefined, ownerAbort.signal)).toBe(authError);
  });

  it('preserva MCP e server configurados mesmo quando o pai nao os anuncia', async () => {
    mocks.resolveConfig.mockResolvedValueOnce({
      ...(await mocks.resolveConfig()),
      allowedTools: ['Read', 'mcp__skills__get_skill'],
      mcpServers: [{ skills: { command: 'node', args: ['skills.js'] } }],
    });
    const context = host({ allowedTools: ['Read'], allowedMcpServerIds: [] });

    await dispatchLionSubagent({ agentId: 'codex-coder', prompt: 'x' }, context);

    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      resolvedConfigOverride: expect.objectContaining({
        allowedTools: ['Read', 'mcp__skills__get_skill'],
        mcpServers: [{ skills: { command: 'node', args: ['skills.js'] } }],
      }),
    }));
  });

  it('preserva todos os MCPs configurados no filho', async () => {
    mocks.resolveConfig.mockResolvedValueOnce({
      ...(await mocks.resolveConfig()),
      allowedTools: ['Read', 'mcp__skills__get_skill', 'mcp__vault__read_secret'],
      mcpServers: [
        { skills: { command: 'node', args: ['skills.js'] } },
        { vault: { command: 'node', args: ['vault.js'] } },
      ],
    });
    const context = host({
      allowedTools: ['Read', 'mcp__skills__get_skill'],
      allowedMcpServerIds: ['skills'],
    });

    await dispatchLionSubagent({ agentId: 'codex-coder', prompt: 'x' }, context);

    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      resolvedConfigOverride: expect.objectContaining({
        allowedTools: ['Read', 'mcp__skills__get_skill', 'mcp__vault__read_secret'],
        mcpServers: [
          { skills: { command: 'node', args: ['skills.js'] } },
          { vault: { command: 'node', args: ['vault.js'] } },
        ],
      }),
    }));
  });

  it('resolve a configuracao propria em cada nivel da arvore sem teto herdado', async () => {
    const toolA = 'mcp__skills__tool_a';
    const toolB = 'mcp__skills__tool_b';
    const baseConfig = {
      model: 'claude-sonnet-4-6',
      systemPrompt: 'system',
      mcpServers: [{ skills: { command: 'node', args: ['skills.js'] } }],
      maxTurns: 10,
      effort: 'high' as const,
      thinking: 'disabled' as const,
      thinkingBudget: undefined,
      runtime: 'cloud' as const,
    };
    mocks.resolveConfig
      .mockResolvedValueOnce({ ...baseConfig, allowedTools: ['Agent', toolA] })
      .mockResolvedValueOnce({ ...baseConfig, allowedTools: [toolA, toolB] });
    mocks.getMcpTools.mockReturnValue([toolA]);
    const materializedHostTools = await resolveSubagentHostAllowedTools(['Agent'], ['skills']);
    const root = withResolvedRootSubagentGrants(
      host({ allowedTools: ['Agent'], allowedMcpServerIds: [] }),
      { ...baseConfig, allowedTools: materializedHostTools },
    )!;

    expect(root.capabilityCeiling).toMatchObject({
      allowedTools: ['Agent', toolA],
      allowedMcpServerIds: ['skills'],
    });

    await dispatchLionSubagent({ agentId: 'codex-coder', prompt: 'filho' }, root);
    const childContext = mocks.execute.mock.calls[0]![0].executionContext;
    await dispatchLionSubagent({ agentId: 'codex-coder', prompt: 'neto' }, childContext);

    expect(mocks.execute).toHaveBeenNthCalledWith(1, expect.objectContaining({
      allowedToolsOverride: ['Agent', toolA],
    }));
    expect(mocks.execute).toHaveBeenNthCalledWith(2, expect.objectContaining({
      allowedToolsOverride: [toolA, toolB],
      resolvedConfigOverride: expect.objectContaining({
        allowedTools: [toolA, toolB],
        mcpServers: [{ skills: { command: 'node', args: ['skills.js'] } }],
      }),
    }));
  });

  it('preserva tools configuradas em lane com roots vazias', async () => {
    mocks.resolveConfig.mockResolvedValueOnce({
      ...(await mocks.resolveConfig()),
      allowedTools: ['Read', 'Write'],
      mcpServers: [],
    });
    const context = host({
      lane: 'telegram',
      readRoots: [],
      writeRoots: [],
      allowedTools: [],
      allowedMcpServerIds: [],
    });

    await dispatchLionSubagent({ agentId: 'codex-coder', prompt: 'x' }, context);

    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      resolvedConfigOverride: expect.objectContaining({
        allowedTools: ['Read', 'Write'],
        mcpServers: [],
      }),
    }));
  });
});
