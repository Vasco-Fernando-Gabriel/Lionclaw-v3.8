import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  createRun: vi.fn(),
  handleClose: vi.fn(async () => undefined),
  bridgeStop: vi.fn(async () => undefined),
  releaseSlot: vi.fn(),
  handler: vi.fn(async (_input: Record<string, unknown>, _context?: { toolUseId: string; signal?: AbortSignal }) => ({
    output: 'ok',
    message: 'ok',
  })),
  bridgeTools: [] as Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    handler: (
      input: Record<string, unknown>,
      context?: { toolUseId: string; signal?: AbortSignal },
    ) => Promise<{ output: string; message: string }>;
  }>,
}));

vi.mock('../db', () => ({
  getEnabledTools: () => ['Read'],
  getSetting: () => '3',
}));
vi.mock('../prompt-builder', () => ({
  buildSystemPrompt: () => 'Prompt Lion',
  loadGeneratedAgentContext: () => '',
}));
vi.mock('../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async () => undefined),
}));
vi.mock('../agent-runtime/context-measure', () => ({ estimateTokensRough: () => 1 }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../grok-acp/acp-driver', () => ({
  getGrokAcpDriver: () => ({ createRun: state.createRun }),
}));
vi.mock('../grok-acp/mcp-http-bridge', () => ({
  startGrokMcpBridge: vi.fn(async ({ tools }: { tools: typeof state.bridgeTools }) => {
    state.bridgeTools = tools;
    return {
      url: 'http://127.0.0.1/mcp',
      token: 'token',
      bridgeId: 'bridge',
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
vi.mock('../agent-runtime/grok-session-config', () => ({
  buildGrokNativeToolPolicy: () => ({ argv: ['--tools', 'read_file'], effectiveTools: ['read_file'] }),
  buildGrokSessionTools: vi.fn(async () => ({
    systemPrompt: 'Prompt reconciliado',
    externalTools: [
      {
        name: 'mcp__fake__echo',
        description: 'echo',
        parameters: { type: 'object' },
        handler: state.handler,
      },
    ],
  })),
}));
vi.mock('../agent-runtime/subagent-dispatch', () => ({
  createSubagentDispatchContext: () => ({ ownerKind: 'chat' }),
  resolveSubagentHostAllowedTools: async (allowedTools: string[]) => allowedTools,
}));
vi.mock('../agent-runtime/chat-effort-inheritance', () => ({
  resolveChatInheritedEffort: () => ({ grok: 'high' }),
}));
vi.mock('../agent-runtime/grok-concurrency', () => ({
  acquireGrokSlot: vi.fn(async () => state.releaseSlot),
  configureGrokConcurrency: vi.fn(),
}));
vi.mock('../agent-runtime/grok-availability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-runtime/grok-availability')>();
  return {
    ...actual,
    buildGrokChildEnv: () => ({ GROK_HOME: '/tmp/grok-home', HOME: '/tmp/grok-home' }),
    isGrokAvailable: vi.fn(async () => ({ usable: true })),
    prepareGrokWorkspace: vi.fn(async () => undefined),
    resolveGrokBinary: vi.fn(async () => '/fake/grok'),
    resolveGrokHome: () => '/tmp/grok-home',
  };
});
vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => vi.fn(async () => ({ behavior: 'allow' as const })),
}));
vi.mock('../agent-runtime/permission-profiles', () => ({
  PERM_DEFAULT_WITH_GUARD: (canUseTool: unknown) => ({
    mode: 'default',
    dangerouslySkipPermissions: false,
    canUseTool,
  }),
}));
vi.mock('../grok-sdk/workspace', () => ({
  acquireGrokSandboxSpawnLock: vi.fn(async () => vi.fn()),
  assertGrokWorkspaceUnchanged: vi.fn(),
  attestGrokSession: vi.fn(),
  ensureGrokSandboxProfile: () => 'workspace',
  grokInputTouchesProtectedSource: () => false,
  inspectGrokWorkspace: vi.fn(async () => undefined),
  snapshotGrokSandboxAttestation: vi.fn(() => ({})),
  waitForGrokSandboxApplied: vi.fn(async () => undefined),
}));

import { createChatGrokSession } from '../grok-sdk/session';

describe('Grok chat external tool wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.bridgeTools = [];
    state.createRun.mockResolvedValue({
      send: vi.fn(),
      reply: vi.fn(),
      interrupt: vi.fn(),
      close: state.handleClose,
      forceKillFallback: vi.fn(),
    });
  });

  it('preserva toolUseId recebido da bridge', async () => {
    const abort = new AbortController();
    const session = await createChatGrokSession({
      sessionId: 'session-1',
      model: 'grok-4.5',
      effort: 'high',
      getWindow: () => null,
      abortSignal: abort.signal,
      lane: 'desktop',
      workspaceGrant: {
        processCwd: '/tmp/project',
        sessionCwd: '/tmp/project',
        readRoots: ['/tmp/project'],
        writeRoots: ['/tmp/project'],
        source: 'desktop-repository',
        projectSources: [],
      },
    });

    expect(state.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: abort.signal,
      }),
    );

    expect(state.bridgeTools).toHaveLength(1);
    await state.bridgeTools[0]!.handler({ text: 'ola' }, { toolUseId: 'tool-chat-42' });
    expect(state.handler).toHaveBeenCalledWith({ text: 'ola' }, { toolUseId: 'tool-chat-42' });

    await session.close();
    expect(state.handleClose).toHaveBeenCalledOnce();
    expect(state.bridgeStop).toHaveBeenCalledOnce();
    expect(state.releaseSlot).toHaveBeenCalledOnce();
  });
});
