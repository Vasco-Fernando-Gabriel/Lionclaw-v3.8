
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KimiExternalTool } from '../../agent-runtime/kimi-external-tools';
import type { KimiAcpMcpServerEntry } from '../types';
import type { KimiMcpBridgeConfig } from '../mcp-http-bridge';
import type {
  CliAgenticResponse,
  CliRunHandle,
  CliStreamCallbacks,
} from '../../agent-runtime/cli-agentic/contract';
import type { AgentQueryConfig } from '../../agent-config-resolver';
import type { AgentExecutionRequest } from '../../agent-runtime/types';


vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../paths', () => ({
  getAgentCwd: () => '/work/chat',
  getLionClawHome: () => '/tmp/lion-home',
}));

vi.mock('../../prompt-builder', () => ({
  buildSystemPrompt: () => 'Voce e o orquestrador.',
  loadGeneratedAgentContext: () => '',
}));

vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async () => ({})),
}));

vi.mock('../../db', () => ({
  getEnabledTools: vi.fn(() => []),
}));

vi.mock('../../agent-runtime/kimi-availability', () => ({
  isKimiAvailable: vi.fn(async () => ({
    installed: true,
    authenticated: true,
    authMode: 'subscription' as const,
  })),
  resolveKimiBinary: vi.fn(async () => '/usr/local/bin/kimi'),
  KimiUnavailableError: class KimiUnavailableError extends Error {},
  KimiAuthError: class KimiAuthError extends Error {},
}));

const releaseSlotMock = vi.fn();
const acquireKimiSlotMock = vi.fn(async (_request: unknown) => releaseSlotMock);
vi.mock('../../agent-runtime/kimi-concurrency', () => ({
  acquireKimiSlot: (request: unknown) => acquireKimiSlotMock(request),
  isKimiQuotaFailure: vi.fn(() => false),
  KimiQuotaError: class KimiQuotaError extends Error {},
  KIMI_QUOTA_MESSAGE: 'quota',
}));

vi.mock('../../pricing', () => ({
  calculateCost: vi.fn(() => 0),
}));

const buildKimiSessionToolsMock = vi.fn();
vi.mock('../../agent-runtime/kimi-session-config', () => ({
  buildKimiSessionTools: (args: unknown) => buildKimiSessionToolsMock(args),
}));

const startKimiMcpBridgeMock = vi.fn();
vi.mock('../mcp-http-bridge', () => ({
  startKimiMcpBridge: (config: KimiMcpBridgeConfig) => startKimiMcpBridgeMock(config),
}));

interface CapturedCreateRun {
  mcpServers?: KimiAcpMcpServerEntry[];
  [key: string]: unknown;
}
let lastCreateRunOpts: CapturedCreateRun | null = null;
const handleSendMock = vi.fn(
  async (
    _prompt: string,
    _cb?: CliStreamCallbacks,
    _abortSignal?: AbortSignal,
  ): Promise<CliAgenticResponse> => ({
    content: 'ok',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    toolUses: 0,
    status: 'finished',
  }),
);
const handleCloseMock = vi.fn(async () => undefined);
function makeFakeHandle(): CliRunHandle {
  return {
    send: (prompt: string, cb?: CliStreamCallbacks, abortSignal?: AbortSignal) =>
      handleSendMock(prompt, cb, abortSignal),
    reply: async () => ({
      content: '',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      toolUses: 0,
      status: 'finished' as const,
    }),
    interrupt: async () => undefined,
    close: () => handleCloseMock(),
    forceKillFallback: async () => undefined,
  };
}
let createRunImpl: (opts: CapturedCreateRun) => Promise<CliRunHandle> = async (opts) => {
  lastCreateRunOpts = opts;
  return makeFakeHandle();
};
vi.mock('../acp-driver', () => ({
  getKimiAcpDriver: () => ({
    createRun: (opts: CapturedCreateRun) => createRunImpl(opts),
  }),
}));

import { createChatKimiSession } from '../../kimi-sdk/session';
import { kimiExecutor } from '../../agent-runtime/kimi-executor';


function fakeTool(name: string): KimiExternalTool {
  return {
    name,
    description: 'fake ' + name,
    parameters: { type: 'object', properties: {} },
    handler: vi.fn(async () => ({ output: 'unused', message: 'ok' })),
  };
}

const CANNED_ENTRY: KimiAcpMcpServerEntry = {
  id: 'lionbridge',
  name: 'LionClaw Bridge',
  type: 'http',
  url: 'http://127.0.0.1:54123/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer deadbeef' }],
  env: [],
};

interface FakeBridge {
  url: string;
  token: string;
  mcpServerEntry: KimiAcpMcpServerEntry;
  bridgeId: string;
  stop: ReturnType<typeof vi.fn>;
}

function makeFakeBridge(stop?: () => Promise<void>): FakeBridge {
  return {
    url: CANNED_ENTRY.url,
    token: 'deadbeef',
    mcpServerEntry: CANNED_ENTRY,
    bridgeId: 'fake-bridge-id',
    stop: vi.fn(stop ?? (async () => undefined)),
  };
}

beforeEach(() => {
  lastCreateRunOpts = null;
  buildKimiSessionToolsMock.mockReset();
  startKimiMcpBridgeMock.mockReset();
  handleSendMock.mockClear();
  handleCloseMock.mockClear();
  releaseSlotMock.mockClear();
  acquireKimiSlotMock.mockClear();
  createRunImpl = async (opts) => {
    lastCreateRunOpts = opts;
    return makeFakeHandle();
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('B4: chat-lane HTTP-MCP bridge wiring (SPEC-BRIDGE section 5.1)', () => {
  const permission = { mode: 'default' as const, dangerouslySkipPermissions: false };
  it('AC-B4.1: a non-empty chat externalTools carries the bridge entry + starts the bridge with the SAME tools', async () => {
    const tools = [fakeTool('lion_run_subagent'), fakeTool('lion_ask_user_question')];
    buildKimiSessionToolsMock.mockResolvedValue({
      externalTools: tools,
      systemPrompt: 'Voce e o orquestrador.',
    });
    const fakeBridge = makeFakeBridge();
    startKimiMcpBridgeMock.mockResolvedValue(fakeBridge);

    await createChatKimiSession({ sessionId: 's1', model: 'kimi-code/kimi-for-coding', permission });

    expect(startKimiMcpBridgeMock).toHaveBeenCalledTimes(1);
    const bridgeConfig = startKimiMcpBridgeMock.mock.calls[0][0] as KimiMcpBridgeConfig;
    expect(bridgeConfig.tools).toBe(tools);
    expect(bridgeConfig.serverName).toBe('LionClaw Bridge');

    expect(lastCreateRunOpts).not.toBeNull();
    expect(lastCreateRunOpts?.mcpServers).toEqual([CANNED_ENTRY]);
    expect(acquireKimiSlotMock).toHaveBeenCalledWith(expect.objectContaining({
      role: 'parent',
      toolBearing: true,
      executionDepth: 0,
      rootExecutionId: expect.any(String),
      parentExecutionId: expect.any(String),
    }));
    const slotRequest = acquireKimiSlotMock.mock.calls[0][0] as {
      rootExecutionId: string;
      parentExecutionId: string;
    };
    expect(slotRequest.parentExecutionId).toBe(slotRequest.rootExecutionId);
  });

  it('AC-B4.2: an EMPTY chat externalTools starts NO bridge and createRun receives mcpServers:[]', async () => {
    buildKimiSessionToolsMock.mockResolvedValue({
      externalTools: [],
      systemPrompt: 'Voce e o orquestrador.',
    });

    await createChatKimiSession({ sessionId: 's2', model: 'kimi-code/kimi-for-coding', permission });

    expect(startKimiMcpBridgeMock).not.toHaveBeenCalled();
    expect(lastCreateRunOpts?.mcpServers).toEqual([]);
  });

  it('AC-B4.3: close() stops the bridge exactly once (alongside handle.close()); a stop() rejection is caught and close() still resolves', async () => {
    const tools = [fakeTool('lion_run_subagent')];
    buildKimiSessionToolsMock.mockResolvedValue({
      externalTools: tools,
      systemPrompt: 'Voce e o orquestrador.',
    });
    const rejectingBridge = makeFakeBridge(async () => {
      throw new Error('boom on stop');
    });
    startKimiMcpBridgeMock.mockResolvedValue(rejectingBridge);

    const session = await createChatKimiSession({ sessionId: 's3', model: 'kimi-code/kimi-for-coding', permission });

    await expect(session.close()).resolves.toBeUndefined();
    expect(handleCloseMock).toHaveBeenCalledTimes(1);
    expect(rejectingBridge.stop).toHaveBeenCalledTimes(1);
  });

  it('AC-B4.3: with no bridge (empty tools), close() does not attempt a stop()', async () => {
    buildKimiSessionToolsMock.mockResolvedValue({
      externalTools: [],
      systemPrompt: 'Voce e o orquestrador.',
    });

    const session = await createChatKimiSession({ sessionId: 's4', model: 'kimi-code/kimi-for-coding', permission });
    await expect(session.close()).resolves.toBeUndefined();
    expect(handleCloseMock).toHaveBeenCalledTimes(1);
    expect(startKimiMcpBridgeMock).not.toHaveBeenCalled();
    expect(releaseSlotMock).toHaveBeenCalledTimes(1);
  });

  it('AC-B4.3: falha em createRun para a bridge e libera o slot', async () => {
    const tools = [fakeTool('lion_run_subagent')];
    buildKimiSessionToolsMock.mockResolvedValue({
      externalTools: tools,
      systemPrompt: 'Voce e o orquestrador.',
    });
    const fakeBridge = makeFakeBridge();
    startKimiMcpBridgeMock.mockResolvedValue(fakeBridge);
    createRunImpl = async () => {
      throw new Error('handshake failed');
    };

    await expect(createChatKimiSession({
      sessionId: 's-create-fail',
      model: 'kimi-code/kimi-for-coding',
      permission,
    })).rejects.toThrow('handshake failed');

    expect(fakeBridge.stop).toHaveBeenCalledTimes(1);
    expect(releaseSlotMock).toHaveBeenCalledTimes(1);
    expect(handleCloseMock).not.toHaveBeenCalled();
  });

  it('AC-B4.4: DB7 un-strip - the skills block in the reconciled systemPrompt survives into the FIRST-turn leading prompt because the session has the tools', async () => {
    const skillsBlock = `## Skills Disponiveis (via MCP)
- mcp__skills__list_skills: lista
- mcp__skills__load_skill: carrega
- mcp__skills__get_skill_metadata: meta`;
    const tools = [
      fakeTool('mcp__skills__list_skills'),
      fakeTool('mcp__skills__load_skill'),
      fakeTool('mcp__skills__get_skill_metadata'),
    ];
    buildKimiSessionToolsMock.mockResolvedValue({
      externalTools: tools,
      systemPrompt: `Voce e o orquestrador.\n\n${skillsBlock}`,
    });
    startKimiMcpBridgeMock.mockResolvedValue(makeFakeBridge());

    const session = await createChatKimiSession({ sessionId: 's5', model: 'kimi-code/kimi-for-coding', permission });

    await session.send('faca algo', {}, new AbortController().signal);

    expect(handleSendMock).toHaveBeenCalledTimes(1);
    const leadingPrompt = handleSendMock.mock.calls[0][0] as string;
    expect(leadingPrompt).toContain('## Skills Disponiveis (via MCP)');
    expect(leadingPrompt).toContain('mcp__skills__load_skill');
    expect(lastCreateRunOpts?.mcpServers).toEqual([CANNED_ENTRY]);
  });
});


function fakeConfig(over: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
  return {
    model: 'kimi-code/kimi-for-coding',
    systemPrompt: 'Voce e um subagente.',
    allowedTools: [],
    mcpServers: [],
    maxTurns: undefined,
    effort: 'medium',
    thinking: 'disabled',
    thinkingBudget: undefined,
    runtime: 'kimi',
    ...over,
  };
}

function fakeRequest(over: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    agentId: 'sub-agent',
    prompt: 'faca a tarefa',
    cwd: '/work/agent',
    abortController: new AbortController(),
    permission: { mode: 'bypassPermissions', dangerouslySkipPermissions: true },
    ...over,
  };
}

describe('B5: agent-scoped-lane HTTP-MCP bridge wiring (SPEC-BRIDGE section 5.2)', () => {
  it('AC-B5.1: agent-scoped (no projectId, non-empty allowlist) carries the bridge entry + starts the bridge with the agent-scoped tools', async () => {
    const tools = [fakeTool('mcp__google_calendar__list_events')];
    buildKimiSessionToolsMock.mockResolvedValue({
      externalTools: tools,
      systemPrompt: 'Voce e um subagente.',
    });
    const fakeBridge = makeFakeBridge();
    startKimiMcpBridgeMock.mockResolvedValue(fakeBridge);

    await kimiExecutor.run(
      fakeRequest(),
      fakeConfig({ allowedTools: ['mcp__google_calendar__list_events'] }),
    );

    expect(startKimiMcpBridgeMock).toHaveBeenCalledTimes(1);
    const bridgeConfig = startKimiMcpBridgeMock.mock.calls[0][0] as KimiMcpBridgeConfig;
    expect(bridgeConfig.tools).toBe(tools);
    expect(bridgeConfig.serverName).toBe('LionClaw Bridge');

    expect(lastCreateRunOpts).not.toBeNull();
    expect(lastCreateRunOpts?.mcpServers).toEqual([CANNED_ENTRY]);
  });

  it('AC-B5.2: pipeline (projectId set => empty externalTools) starts NO bridge and createRun receives mcpServers:[]', async () => {
    buildKimiSessionToolsMock.mockResolvedValue({
      externalTools: [],
      systemPrompt: 'Voce e um subagente.',
    });

    await kimiExecutor.run(
      fakeRequest({ projectId: 'proj-1' }),
      fakeConfig({ allowedTools: ['Read', 'Write'] }),
    );

    expect(startKimiMcpBridgeMock).not.toHaveBeenCalled();
    expect(lastCreateRunOpts?.mcpServers).toEqual([]);
  });

  it('AC-B5.3: one-shot (no projectId, empty allowlist => empty externalTools) starts NO bridge and createRun receives mcpServers:[]', async () => {
    buildKimiSessionToolsMock.mockResolvedValue({
      externalTools: [],
      systemPrompt: 'Voce e um subagente.',
    });

    await kimiExecutor.run(fakeRequest(), fakeConfig({ allowedTools: [] }));

    expect(startKimiMcpBridgeMock).not.toHaveBeenCalled();
    expect(lastCreateRunOpts?.mcpServers).toEqual([]);
  });

  it('AC-B5.4: on a normal agent-scoped run, bridge.stop() is called once in the finally (after handle.close(), before releaseSlot())', async () => {
    const tools = [fakeTool('mcp__google_calendar__list_events')];
    buildKimiSessionToolsMock.mockResolvedValue({
      externalTools: tools,
      systemPrompt: 'Voce e um subagente.',
    });
    const fakeBridge = makeFakeBridge();
    startKimiMcpBridgeMock.mockResolvedValue(fakeBridge);

    await kimiExecutor.run(
      fakeRequest(),
      fakeConfig({ allowedTools: ['mcp__google_calendar__list_events'] }),
    );

    expect(handleCloseMock).toHaveBeenCalledTimes(1);
    expect(fakeBridge.stop).toHaveBeenCalledTimes(1);
    expect(releaseSlotMock).toHaveBeenCalledTimes(1);
    const closeOrder = handleCloseMock.mock.invocationCallOrder[0];
    const stopOrder = fakeBridge.stop.mock.invocationCallOrder[0];
    const releaseOrder = releaseSlotMock.mock.invocationCallOrder[0];
    expect(closeOrder).toBeLessThan(stopOrder);
    expect(stopOrder).toBeLessThan(releaseOrder);
  });

  it('AC-B5.4: on a THROWN createRun, the finally still stops the bridge (no leak on the error path) and releases the slot', async () => {
    const tools = [fakeTool('mcp__google_calendar__list_events')];
    buildKimiSessionToolsMock.mockResolvedValue({
      externalTools: tools,
      systemPrompt: 'Voce e um subagente.',
    });
    const fakeBridge = makeFakeBridge();
    startKimiMcpBridgeMock.mockResolvedValue(fakeBridge);
    createRunImpl = async () => {
      throw new Error('createRun blew up');
    };

    await expect(
      kimiExecutor.run(
        fakeRequest(),
        fakeConfig({ allowedTools: ['mcp__google_calendar__list_events'] }),
      ),
    ).rejects.toThrow('createRun blew up');

    expect(startKimiMcpBridgeMock).toHaveBeenCalledTimes(1);
    expect(fakeBridge.stop).toHaveBeenCalledTimes(1);
    expect(releaseSlotMock).toHaveBeenCalledTimes(1);
  });

  it('AC-B5.4: a bridge.stop() rejection is caught/logged and does not mask the original handle.send error', async () => {
    const tools = [fakeTool('mcp__google_calendar__list_events')];
    buildKimiSessionToolsMock.mockResolvedValue({
      externalTools: tools,
      systemPrompt: 'Voce e um subagente.',
    });
    const rejectingBridge = makeFakeBridge(async () => {
      throw new Error('boom on stop');
    });
    startKimiMcpBridgeMock.mockResolvedValue(rejectingBridge);
    handleSendMock.mockRejectedValueOnce(new Error('send blew up'));

    await expect(
      kimiExecutor.run(
        fakeRequest(),
        fakeConfig({ allowedTools: ['mcp__google_calendar__list_events'] }),
      ),
    ).rejects.toThrow('send blew up');

    expect(rejectingBridge.stop).toHaveBeenCalledTimes(1);
    expect(releaseSlotMock).toHaveBeenCalledTimes(1);
  });
});
