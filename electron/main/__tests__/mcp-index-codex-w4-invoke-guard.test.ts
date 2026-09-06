
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  bypass: true,
  registry: [] as Array<{
    mcpId: string;
    toolName: string;
    description: string | null;
    inputSchema: string | null;
    lastDiscoveredAt: string | null;
  }>,
  surfaceConfig: {} as Record<string, { command: string; args: string[] }>,
}));

const callMock = vi.hoisted(() => vi.fn());
const setupMock = vi.hoisted(() => vi.fn());
const teardownMock = vi.hoisted(() => vi.fn());

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(() => undefined),
  insertAuditEntry: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getPermissionBypass: vi.fn(() => state.bypass),
  getCompletedDocsCount: vi.fn(() => 0),
  getSetting: vi.fn(() => undefined),
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

import { initMcpInvoke, _resetMcpInvokeForTesting } from '../mcp-invoke';
import { dispatch, type JsonRpcContext } from '../local-ipc/jsonrpc-methods';

const ctx: JsonRpcContext = { getWindow: () => null };

function rpc(params: Record<string, unknown>) {
  return dispatch(ctx, { jsonrpc: '2.0', id: 11, method: 'mcp_invoke', params });
}

const SCHEMA = JSON.stringify({ type: 'object', properties: { path: { type: 'string' } } });

beforeEach(() => {
  vi.clearAllMocks();
  _resetMcpInvokeForTesting();
  state.bypass = true;
  state.registry = [
    {
      mcpId: 'srv',
      toolName: 'delete_file',
      description: 'Deleta um arquivo',
      inputSchema: SCHEMA,
      lastDiscoveredAt: '2026-01-01T00:00:00.000Z',
    },
    {
      mcpId: 'srv',
      toolName: 'get_events',
      description: 'Lista eventos',
      inputSchema: SCHEMA,
      lastDiscoveredAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  state.surfaceConfig = { srv: { command: 'node', args: ['srv.js'] } };
  setupMock.mockImplementation(async (servers: Record<string, unknown>) => ({
    client: { connections: Object.keys(servers).map((serverId) => ({ serverId })) },
    tools: [],
  }));
  callMock.mockResolvedValue({ content: [{ type: 'text', text: 'executado' }] });
  teardownMock.mockResolvedValue(undefined);
  initMcpInvoke({ getWindow: () => null });
});

describe('guard de destrutivos via gateway codex (nivel invokeMcpTool)', () => {
  it('bypass ON => destrutiva auto-aprovada e executada (paridade claude)', async () => {
    state.bypass = true;
    const res = await rpc({
      server: 'srv',
      tool: 'delete_file',
      args: { path: '/tmp/x' },
      surface: 'codex-sdk',
    });
    expect(res.error).toBeUndefined();
    const result = res.result as { content: string; isError?: boolean; displayName: string };
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('executado');
    expect(result.displayName).toBe('mcp__srv__delete_file');
    expect(callMock).toHaveBeenCalledTimes(1);
  });

  it('bypass OFF => guard dispara e, fail-closed sem janela, a tool NAO executa', async () => {
    state.bypass = false;
    const res = await rpc({
      server: 'srv',
      tool: 'delete_file',
      args: { path: '/tmp/x' },
      surface: 'codex-sdk',
    });
    expect(res.error).toBeUndefined();
    const result = res.result as { content: string; isError?: boolean; displayName: string };
    expect(result.isError).toBe(true);
    expect(result.content).toContain('negada pelo guard');
    expect(result.displayName).toBe('mcp__srv__delete_file');
    expect(callMock).not.toHaveBeenCalled();
  });

  it('tool SAFE nao consulta o guard mesmo com bypass OFF (so destrutiva confirma)', async () => {
    state.bypass = false;
    const res = await rpc({
      server: 'srv',
      tool: 'get_events',
      args: {},
      surface: 'codex-sdk',
    });
    expect(res.error).toBeUndefined();
    const result = res.result as { content: string; isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(callMock).toHaveBeenCalledTimes(1);
  });
});
