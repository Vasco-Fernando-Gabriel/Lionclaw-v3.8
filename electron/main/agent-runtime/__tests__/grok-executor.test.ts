import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentQueryConfig } from '../../agent-config-resolver';
import type { CliAgenticResponse, CliRunHandle } from '../cli-agentic/contract';

const state = vi.hoisted(() => ({
  createRun: vi.fn(),
  send: vi.fn(),
  close: vi.fn(async () => undefined),
  bridgeStop: vi.fn(async () => undefined),
  bridgeTools: [] as Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    handler: (
      input: Record<string, unknown>,
      context?: { toolUseId: string },
    ) => Promise<{ output: string; message: string }>;
  }>,
  sessionTools: null as null | {
    externalTools: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      handler: (
        input: Record<string, unknown>,
        context?: { toolUseId: string },
      ) => Promise<{ output: string; message: string }>;
    }>;
    systemPrompt: string;
  },
  maxConcurrency: '3',
}));

vi.mock('../../db', () => ({
  getSetting: vi.fn((key: string) => key === 'grok_max_concurrency' ? state.maxConcurrency : ''),
}));

vi.mock('../../grok-acp/acp-driver', () => ({
  getGrokAcpDriver: () => ({ createRun: state.createRun }),
}));

vi.mock('../../grok-acp/mcp-http-bridge', () => ({
  startGrokMcpBridge: vi.fn(async ({ tools }) => {
    state.bridgeTools = tools;
    return {
      mcpServerEntry: {
        id: 'bridge',
        name: 'bridge',
        type: 'http',
        url: 'http://127.0.0.1/mcp',
        headers: [],
        env: [],
      },
      stop: state.bridgeStop,
    };
  }),
}));

vi.mock('../grok-session-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../grok-session-config')>();
  return {
    ...actual,
    buildGrokSessionTools: vi.fn(async (...args: Parameters<typeof actual.buildGrokSessionTools>) =>
      state.sessionTools ?? actual.buildGrokSessionTools(...args)),
  };
});

vi.mock('../grok-availability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../grok-availability')>();
  return {
    ...actual,
    assertGrokWorkspaceIsolation: vi.fn(),
    prepareGrokWorkspace: vi.fn(async () => undefined),
    buildGrokChildEnv: vi.fn(() => ({ GROK_HOME: '/tmp/grok-home', HOME: '/tmp/grok-home' })),
    resolveGrokHome: vi.fn(() => '/tmp/grok-home'),
    resolveGrokBinary: vi.fn(async () => '/fake/grok'),
    isGrokAvailable: vi.fn(async () => ({
      installed: true,
      version: '0.2.103',
      authenticated: true,
      authMode: 'subscription' as const,
      subscriptionRouteVerified: true,
      backendVerified: true,
      isolationVerified: true,
      toolPolicyVerified: true,
      modelAvailable: true,
      usable: true,
    })),
  };
});

vi.mock('../../grok-sdk/workspace', () => ({
  acquireGrokSandboxSpawnLock: vi.fn(async () => vi.fn()),
  resolveGrokWorkspaceGrant: vi.fn(() => ({
    processCwd: '/tmp/grok-neutral',
    sessionCwd: '/tmp/project',
    readRoots: ['/tmp/project'],
    writeRoots: ['/tmp/project'],
    source: 'desktop-repository',
    projectSources: [],
  })),
  inspectGrokWorkspace: vi.fn(async () => undefined),
  ensureGrokSandboxProfile: vi.fn((_grant, _home, requested) => requested ?? 'workspace'),
  snapshotGrokSandboxAttestation: vi.fn(() => ({})),
  waitForGrokSandboxApplied: vi.fn(async () => undefined),
  attestGrokSession: vi.fn(),
  assertGrokWorkspaceUnchanged: vi.fn(),
  grokInputTouchesProtectedSource: vi.fn(() => false),
}));

import { _grokPoolStateForTests, _resetGrokPoolForTests } from '../grok-concurrency';
import { grokExecutor } from '../grok-executor';
import { GrokAuthError, isGrokAvailable } from '../grok-availability';
import { createGrokAccumulator, finalizeGrokResponse } from '../../grok-acp/acp-translator';

const config: AgentQueryConfig = {
  model: 'grok-4.5',
  systemPrompt: 'Regras',
  allowedTools: [],
  mcpServers: [],
  maxTurns: undefined,
  effort: 'medium',
  thinking: 'enabled',
  thinkingBudget: undefined,
  runtime: 'grok',
};

function request() {
  return {
    agentId: 'tester',
    prompt: 'responda',
    cwd: '/tmp/project',
    abortController: new AbortController(),
    permission: { mode: 'default' as const, dangerouslySkipPermissions: false },
  };
}

describe('grokExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetGrokPoolForTests();
    state.bridgeTools = [];
    state.sessionTools = null;
    state.maxConcurrency = '3';
    const handle: CliRunHandle = {
      send: state.send,
      reply: vi.fn(),
      interrupt: vi.fn(),
      close: state.close,
      forceKillFallback: vi.fn(),
    };
    state.createRun.mockResolvedValue(handle);
  });

  it('usa ticks/modelCalls/reasoning do provider e fecha o handle', async () => {
    state.send.mockResolvedValue({
      content: 'ok',
      usage: {
        reported: true,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 0,
        reasoningTokens: 7,
        modelCalls: 2,
        costUsdTicks: 270_800_000,
      },
      toolUses: 1,
      status: 'finished',
    } as CliAgenticResponse);
    const result = await grokExecutor.run(request(), config);
    expect(result).toMatchObject({
      output: 'ok',
      runtime: 'grok',
      provider: 'grok',
      metrics: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        apiRequests: 2,
        costUsd: 0.02708,
        costStatus: 'known',
        tokenStatus: 'reported',
      },
      metadata: {
        costEstimationKind: 'subscription-equivalent-payg',
        costSource: 'provider-reported-equivalent',
        grok: {
          reasoningTokens: 7,
          modelCalls: 2,
          costUsdTicks: 270_800_000,
        },
      },
    });
    expect(state.createRun).toHaveBeenCalledWith(expect.objectContaining({
      model: 'grok-4.5',
      effort: 'medium',
      nativeToolArgs: ['--tools', '', '--disable-web-search'],
      processCwd: '/tmp/grok-neutral',
      sandbox: 'strict',
      attestSession: expect.any(Function),
      assertWorkspaceUnchanged: expect.any(Function),
    }));
    expect(state.close).toHaveBeenCalledOnce();
  });

  it('usa default 3 quando grok_max_concurrency persistido esta fora de 1..16', async () => {
    state.maxConcurrency = '17';
    state.send.mockResolvedValue({
      content: 'ok',
      usage: { reported: true, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      toolUses: 0,
      status: 'finished',
    });

    await expect(grokExecutor.run(request(), config)).resolves.toMatchObject({ output: 'ok' });
    expect(_grokPoolStateForTests().cap).toBe(3);
  });

  it('integra a surface pipeline ao fake ACP sem MCP e persiste o contrato canonico', async () => {
    state.send.mockResolvedValue({
      content: 'pipeline ok',
      usage: {
        reported: true,
        inputTokens: 12,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        modelCalls: 1,
      },
      toolUses: 0,
      status: 'finished',
    } as CliAgenticResponse);

    const result = await grokExecutor.run({
      ...request(),
      projectId: 'project-1',
    }, config);

    expect(result).toMatchObject({ output: 'pipeline ok', runtime: 'grok', provider: 'grok' });
    expect(state.createRun).toHaveBeenCalledWith(expect.objectContaining({
      surface: 'pipeline',
      ownerKind: 'pipeline',
      projectId: 'project-1',
      mcpServers: [],
    }));
    expect(state.close).toHaveBeenCalledOnce();
  });

  it('classifica perda de auth antes de criar o fake ACP', async () => {
    vi.mocked(isGrokAvailable).mockResolvedValueOnce({
      installed: true,
      version: '0.2.103',
      authenticated: false,
      authMode: 'none',
      subscriptionRouteVerified: false,
      backendVerified: false,
      isolationVerified: true,
      toolPolicyVerified: false,
      modelAvailable: false,
      usable: false,
      reason: 'cached_token authentication failed',
    });

    await expect(grokExecutor.run({ ...request(), projectId: 'project-auth' }, config))
      .rejects.toBeInstanceOf(GrokAuthError);
    expect(state.createRun).not.toHaveBeenCalled();
  });

  it('mantem fallback desconhecido quando modelUsage nao separa cada chamada', async () => {
    state.send.mockResolvedValue({
      content: 'ok',
      usage: {
        reported: true,
        inputTokens: 300_000,
        outputTokens: 20_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        modelCalls: 2,
        modelUsage: {
          'grok-4.5': {
            inputTokens: 300_000,
            outputTokens: 20_000,
            cachedReadTokens: 0,
            reasoningTokens: 0,
            modelCalls: 2,
          },
        },
      },
      toolUses: 0,
      status: 'finished',
    });
    const ambiguous = await grokExecutor.run(request(), config);
    expect(ambiguous.metrics).toMatchObject({ costStatus: 'unknown', costUsd: 0 });
  });

  it('preserva modelUsage em metadata e rejeita pricing desconhecido', async () => {
    state.send.mockResolvedValue({
      content: 'ok',
      usage: {
        reported: true,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheCreationTokens: 0,
        modelCalls: 1,
        modelUsage: {
          'grok-internal-unknown': {
            inputTokens: 100,
            outputTokens: 20,
            cachedReadTokens: 10,
            reasoningTokens: 7,
            modelCalls: 1,
          },
        },
      },
      toolUses: 0,
      status: 'finished',
    });
    const result = await grokExecutor.run(request(), config);
    expect(result.metrics).toMatchObject({
      costStatus: 'unknown',
      costUsd: 0,
      costUnknownReason: 'unknown-pricing',
    });
    expect(result.metadata?.modelUsage).toEqual({
      'grok-internal-unknown': {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 0,
        costUSD: 0,
        reasoningTokens: 7,
        modelCalls: 1,
      },
    });
  });

  it('nao fabrica tokens/custo quando ACP omite usage', async () => {
    state.send.mockResolvedValue({
      content: 'texto sem usage',
      usage: { reported: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      toolUses: 0,
      status: 'finished',
    });
    const result = await grokExecutor.run(request(), config);
    expect(result.metrics).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costStatus: 'unknown',
      tokenStatus: 'not_reported',
      costUnknownReason: 'no-usage-reported',
      apiRequests: 0,
    });
  });

  it('ignora ticks quando ACP nao reporta tokens', async () => {
    state.send.mockResolvedValue({
      content: 'texto sem usage',
      usage: {
        reported: false,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsdTicks: 1_250_000_000,
      },
      toolUses: 0,
      status: 'finished',
    });
    const result = await grokExecutor.run(request(), config);
    expect(result.metrics).toMatchObject({
      costUsd: 0,
      costStatus: 'unknown',
      tokenStatus: 'not_reported',
      costUnknownReason: 'no-usage-reported',
      apiRequests: 0,
    });
    expect(result.metadata?.costSource).toBeUndefined();
  });

  it('zera custo e tokens quando o wire veta usage positiva explicitamente', async () => {
    state.send.mockResolvedValue(finalizeGrokResponse(
      createGrokAccumulator(),
      'completed',
      {
        _meta: {
          usage: {
            reported: false,
            inputTokens: 100,
            outputTokens: 20,
            cachedReadTokens: 10,
            costUsdTicks: 1_250_000_000,
          },
        },
      },
    ));

    const result = await grokExecutor.run(request(), config);

    expect(result.metrics).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      costStatus: 'unknown',
      tokenStatus: 'not_reported',
      costUnknownReason: 'no-usage-reported',
      apiRequests: 0,
    });
    expect(result.metadata?.costSource).toBeUndefined();
    expect(result.metadata?.grok?.rawUsage).toEqual(expect.objectContaining({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      costUsdTicks: 1_250_000_000,
    }));
  });

  it('nao aceita tokens nem ticks de envelope com cache creation', async () => {
    state.send.mockResolvedValue(finalizeGrokResponse(
      createGrokAccumulator(),
      'completed',
      {
        _meta: {
          usage: {
            reported: true,
            inputTokens: 100,
            outputTokens: 20,
            cachedReadTokens: 10,
            cacheCreationTokens: 9,
            costUsdTicks: 1_250_000_000,
          },
        },
      },
    ));

    const result = await grokExecutor.run(request(), config);

    expect(result.metrics).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      costStatus: 'unknown',
      tokenStatus: 'not_reported',
      costUnknownReason: 'no-usage-reported',
      apiRequests: 0,
    });
    expect(result.metadata?.grok).not.toHaveProperty('costUsdTicks');
  });

  it('nao promove envelope unilateral a usage/custo conhecido', async () => {
    state.send.mockResolvedValue({
      content: 'ok',
      usage: {
        reported: false,
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 10,
        cacheCreationTokens: 0,
        costUsdTicks: 1_250_000_000,
      },
      toolUses: 0,
      status: 'finished',
    });
    const result = await grokExecutor.run(request(), config);
    expect(result.metrics).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costStatus: 'unknown',
      tokenStatus: 'not_reported',
      costUnknownReason: 'no-usage-reported',
      apiRequests: 0,
    });
    expect(result.metadata?.modelUsage).toBeUndefined();
    expect(result.metadata?.grok?.rawUsage).toEqual(expect.objectContaining({
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      costUsdTicks: 1_250_000_000,
    }));
  });

  it('rejeita breakdown que nao reconcilia com usage agregado', async () => {
    state.send.mockResolvedValue({
      content: 'ok',
      usage: {
        reported: true,
        inputTokens: 300_000,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        modelCalls: 1,
        modelUsage: {
          'grok-4.5': {
            inputTokens: 0,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
            modelCalls: 1,
          },
        },
      },
      toolUses: 0,
      status: 'finished',
    });
    const result = await grokExecutor.run(request(), config);
    expect(result.metrics).toMatchObject({
      costUsd: 0,
      costStatus: 'unknown',
      costUnknownReason: 'unknown-pricing',
    });
  });

  it('preserva toolUseId ao proteger handlers de external tools', async () => {
    const handler = vi.fn(async () => ({ output: 'ok', message: 'ok' }));
    state.sessionTools = {
      systemPrompt: 'Regras',
      externalTools: [{
        name: 'mcp__fake__echo',
        description: 'echo',
        parameters: { type: 'object' },
        handler,
      }],
    };
    state.send.mockResolvedValue({
      content: 'ok',
      usage: {
        reported: true,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        modelCalls: 1,
      },
      toolUses: 1,
      status: 'finished',
    });

    await grokExecutor.run(request(), {
      ...config,
      allowedTools: ['mcp__fake__echo'],
    });
    expect(state.bridgeTools).toHaveLength(1);
    await state.bridgeTools[0]!.handler(
      { text: 'ola' },
      { toolUseId: 'tool-executor-42' },
    );
    expect(handler).toHaveBeenCalledWith(
      { text: 'ola' },
      { toolUseId: 'tool-executor-42' },
    );
  });
});
