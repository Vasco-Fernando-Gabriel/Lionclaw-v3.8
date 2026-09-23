import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';

const state = vi.hoisted(() => ({
  registry: [] as Array<{
    mcpId: string;
    toolName: string;
    description: string | null;
    inputSchema: string | null;
    lastDiscoveredAt: string | null;
  }>,
  surfaceConfig: {} as Record<string, { command: string; args: string[] }>,
  lanes: new Map<string, { title: string; laneBadge: number }>(),
}));

const callMock = vi.hoisted(() => vi.fn());
const setupMock = vi.hoisted(() => vi.fn());
const teardownMock = vi.hoisted(() => vi.fn());

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(() => undefined),
  insertAuditEntry: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getPermissionBypass: vi.fn(() => false),
  getCompletedDocsCount: vi.fn(() => 0),
  getSetting: vi.fn(() => undefined),
  getSession: vi.fn((id: string) => {
    const lane = state.lanes.get(id);
    return lane ? { id, title: lane.title } : undefined;
  }),
  getOpenLaneSessionById: vi.fn((id: string) => {
    const lane = state.lanes.get(id);
    return lane ? { id, title: lane.title, laneBadge: lane.laneBadge } : null;
  }),
}));

vi.mock('../mcp-manager', () => ({
  getAllMCPServers: vi.fn(() => []),
  getMCPConfigForAgent: vi.fn(async () => state.surfaceConfig),
  getMcpToolRegistryEntries: vi.fn((mcpId?: string) =>
    mcpId === undefined ? [...state.registry] : state.registry.filter((e) => e.mcpId === mcpId),
  ),
  discoverAndSaveMCPTools: vi.fn(async () => []),
}));

vi.mock('../mcp-tool-bridge', () => ({
  setupMCPsForSession: setupMock,
  callMCPTool: callMock,
  teardownMCPsForSession: teardownMock,
}));

vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(() => null) }));
vi.mock('../skills', () => ({
  listSkills: vi.fn(() => []),
  getSkill: vi.fn(() => null),
  buildSkillsPromptSection: vi.fn(() => ''),
  buildAgentSkillsPromptSection: vi.fn(() => ''),
}));
vi.mock('../ask-question', () => ({ sendAskQuestion: vi.fn() }));
vi.mock('../repo-profiler', () => ({ EXCLUDED_FROM_AUDIT_PATTERNS: [] }));

import { initMcpInvoke, invokeMcpTool, _resetMcpInvokeForTesting } from '../mcp-invoke';
import { dispatch, type JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import { resolveConfirmation } from '../permission-guard';
import { setActiveChatTurn, __resetChatCapabilityContextForTests } from '../chat-capability-context';
import { resetDesktopLanesForTests } from '../desktop-lanes';
import type { ConfirmAction } from '../../../src/types';

const SCHEMA = JSON.stringify({ type: 'object', properties: { to: { type: 'string' } } });

function makeWindow(): { win: BrowserWindow; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const win = { webContents: { send }, isDestroyed: () => false } as unknown as BrowserWindow;
  return { win, send };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function confirmRequests(send: ReturnType<typeof vi.fn>): ConfirmAction[] {
  return send.mock.calls.filter((c) => c[0] === 'chat:confirm-request').map((c) => c[1] as ConfirmAction);
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetMcpInvokeForTesting();
  __resetChatCapabilityContextForTests();
  resetDesktopLanesForTests();
  state.lanes.clear();
  state.lanes.set('sess-a', { title: 'Conversa A', laneBadge: 1 });
  state.lanes.set('sess-b', { title: 'Conversa B', laneBadge: 2 });
  setActiveChatTurn({ sessionId: 'sess-a', lane: 'desktop', turnId: 'turn-a' });
  setActiveChatTurn({ sessionId: 'sess-b', lane: 'desktop', turnId: 'turn-b' });
  state.registry = [
    {
      mcpId: 'google-gmail',
      toolName: 'send_email',
      description: 'Envia um email',
      inputSchema: SCHEMA,
      lastDiscoveredAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  state.surfaceConfig = { 'google-gmail': { command: 'node', args: ['gmail.js'] } };
  setupMock.mockImplementation(async (servers: Record<string, unknown>) => ({
    client: { connections: Object.keys(servers).map((serverId) => ({ serverId })) },
    tools: [],
  }));
  callMock.mockResolvedValue({ content: [{ type: 'text', text: 'enviado' }] });
  teardownMock.mockResolvedValue(undefined);
});

describe('10.4 lado main (P2-2): o guard das tools de risco carrega a lane do turno', () => {
  it('mcp_invoke com binding de B emite chat:confirm-request com sessionId B, title e laneBadge 2', async () => {
    const { win, send } = makeWindow();
    initMcpInvoke({ getWindow: () => win });
    const ctx: JsonRpcContext = { getWindow: () => win };

    const pending = dispatch(ctx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'mcp_invoke',
      params: {
        server: 'google-gmail',
        tool: 'send_email',
        args: { to: 'x@y.z' },
        surface: 'codex-sdk',
        sessionId: 'sess-b',
        turnId: 'turn-b',
      },
    });

    await waitFor(() => confirmRequests(send).length === 1);
    const action = confirmRequests(send)[0]!;
    expect(action).toMatchObject({
      tool: 'mcp__google-gmail__send_email',
      risk: 'high',
      sessionId: 'sess-b',
      title: 'Conversa B',
      laneBadge: 2,
    });

    resolveConfirmation(action.id, true);
    const res = await pending;
    expect((res.result as { isError?: boolean }).isError).toBeUndefined();
    expect(callMock).toHaveBeenCalledTimes(1);
  });

  it('chamadas intercaladas de A e B: cada popup sai rotulado com a propria lane', async () => {
    const { win, send } = makeWindow();
    initMcpInvoke({ getWindow: () => win });

    const invoke = (sessionId: string, turnId: string) =>
      invokeMcpTool({
        serverId: 'google-gmail',
        toolName: 'send_email',
        args: {},
        surface: 'lion-sdk',
        sessionId,
        turnId,
        allowedServerIds: ['google-gmail'],
        context: { surface: 'chat', sessionId, turnId, lane: 'desktop' },
      });

    const a = invoke('sess-a', 'turn-a');
    const b = invoke('sess-b', 'turn-b');
    await waitFor(() => confirmRequests(send).length === 2);
    const byLane = confirmRequests(send).map((c) => [c.sessionId, c.laneBadge, c.title]);
    expect(byLane).toEqual(
      expect.arrayContaining([
        ['sess-a', 1, 'Conversa A'],
        ['sess-b', 2, 'Conversa B'],
      ]),
    );
    for (const c of confirmRequests(send)) resolveConfirmation(c.id, false);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.isError).toBe(true);
    expect(rb.isError).toBe(true);
    expect(callMock).not.toHaveBeenCalled();
  });

  it('P2-2 (RM7): sem sessao no context o guard usa o sessionId da requisicao; o popup nunca sai sem sessao', async () => {
    const { win, send } = makeWindow();
    initMcpInvoke({ getWindow: () => win });

    const pending = invokeMcpTool({
      serverId: 'google-gmail',
      toolName: 'send_email',
      args: {},
      surface: 'lion-sdk',
      sessionId: 'tg-session',
      turnId: '1',
      allowedServerIds: ['google-gmail'],
    });
    await waitFor(() => confirmRequests(send).length === 1);
    const action = confirmRequests(send)[0]!;
    expect(action.sessionId).toBe('tg-session');
    expect(action.laneBadge).toBeNull();
    resolveConfirmation(action.id, true);
    await pending;
  });
});
