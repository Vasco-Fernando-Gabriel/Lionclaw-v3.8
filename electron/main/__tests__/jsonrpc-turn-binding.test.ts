import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(() => undefined),
  insertAuditEntry: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getPermissionBypass: vi.fn(() => true),
  getCompletedDocsCount: vi.fn(() => 0),
}));

vi.mock('../mcp-manager', () => ({
  getAllMCPServers: vi.fn(() => []),
  getMCPConfigForAgent: vi.fn(),
}));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(() => null) }));
vi.mock('../skills', () => ({
  listSkills: vi.fn(() => []),
  getSkill: vi.fn(() => null),
  buildSkillsPromptSection: vi.fn(() => ''),
  buildAgentSkillsPromptSection: vi.fn(() => ''),
}));
vi.mock('../ask-question', () => ({ sendAskQuestion: vi.fn() }));
vi.mock('../mcp-invoke', () => ({
  invokeMcpTool: vi.fn(),
  getMcpToolSchema: vi.fn(),
}));
const swarmInspect = vi.hoisted(() => vi.fn(async () => ({ runId: 'r1' })));
vi.mock('../swarm', () => ({ getSwarmService: () => ({ getRunState: swarmInspect }) }));
const pipelineList = vi.hoisted(() => vi.fn(() => ({ ok: true, value: ['ok'] })));
vi.mock('../pipeline-control-core', () => ({
  isPipelineWriteAction: () => false,
  pipelineListCore: () => pipelineList(),
  pipelineInspectCore: vi.fn(),
  pipelineCreateCore: vi.fn(),
  pipelineDriveCore: vi.fn(),
  pipelineReplyCore: vi.fn(),
  pipelineApproveCore: vi.fn(),
  pipelineEscalateCore: vi.fn(),
  pipelineAbortCore: vi.fn(),
  pipelinePauseCore: vi.fn(),
  designSessionConfigCore: vi.fn(),
  normalizeApproveMetadata: (m: unknown) => m,
}));
const lionAgentDispatchMock = vi.hoisted(() => vi.fn(async (_params: unknown) => ({ ok: true, summary: 'done' })));
vi.mock('../lion-sdk/tools/agent', () => ({
  lionAgentDispatch: (params: unknown) => lionAgentDispatchMock(params),
}));

import { getMCPConfigForAgent } from '../mcp-manager';
import { invokeMcpTool } from '../mcp-invoke';
import {
  dispatch,
  handleCallAgent,
  isLegacyHelperBinding,
  isSubagentDispatchInFlight,
  resolveGatedCallTurnContext,
  type JsonRpcContext,
} from '../local-ipc/jsonrpc-methods';
import { MCP_DIST_STALE_HINT } from '../mcp-dist-staleness';
import {
  setActiveChatTurn,
  registerChatCapabilityTurn,
  __resetChatCapabilityContextForTests,
} from '../chat-capability-context';
import { getDesktopLane, resetDesktopLanesForTests } from '../desktop-lanes';
import { lionMcpCallViaWrapper } from '../lion-sdk/tools/mcp';

const mockGetConfig = getMCPConfigForAgent as ReturnType<typeof vi.fn>;
const mockInvoke = invokeMcpTool as ReturnType<typeof vi.fn>;

const ctx: JsonRpcContext = { getWindow: () => null };
const helperCtx = (serverId: string, connectionId = 'conn-1'): JsonRpcContext => ({
  getWindow: () => null,
  connection: { authenticatedHelper: true, serverId, connectionId } as JsonRpcContext['connection'],
});

function registerTurn(sessionId: string, turnId: string): void {
  registerChatCapabilityTurn(
    {
      surface: 'chat',
      sessionId,
      turnId,
      origin: 'user',
      capabilities: { pipelineControl: true, dynamicWorkflows: true },
      cwd: '/tmp/project',
      permissionProfile: {
        mode: 'default',
        dangerouslySkipPermissions: false,
        canUseTool: async () => ({ behavior: 'allow' }),
      },
      allowedTools: ['Agent'],
      allowedServerIds: [],
      readRoots: ['/tmp/project'],
      writeRoots: [],
    },
    60_000,
  );
  setActiveChatTurn({ sessionId, lane: 'desktop', turnId });
  getDesktopLane(sessionId).currentAbortController = new AbortController();
}

function mcpInvoke(surface: string, sessionId: string, turnId?: string, lane?: string) {
  return dispatch(ctx, {
    jsonrpc: '2.0',
    id: 1,
    method: 'mcp_invoke',
    params: {
      server: 'google-gmail',
      tool: 'send_email',
      args: {},
      surface,
      sessionId,
      ...(turnId ? { turnId } : {}),
      ...(lane ? { lane } : {}),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDesktopLanesForTests();
  mockGetConfig.mockResolvedValue({ 'google-gmail': { command: 'node', args: ['/x/gmail.js'] } });
  mockInvoke.mockResolvedValue({ content: 'ok', displayName: 'mcp__google-gmail__send_email' });
  registerTurn('sess-a', 'turn-a');
  registerTurn('sess-b', 'turn-b');
});

afterEach(() => {
  __resetChatCapabilityContextForTests();
});

describe('AC-18: chamadas intercaladas com bindings distintos resolvem {sessionId, turnId} distintos', () => {
  for (const surface of ['claude-sdk', 'claude-compat-sdk', 'codex-sdk'] as const) {
    it(`gateway ${surface}: A e B intercaladas chegam ao wrapper com a identidade de cada lane`, async () => {
      const turnA = surface === 'codex-sdk' ? undefined : 'turn-a';
      const turnB = surface === 'codex-sdk' ? undefined : 'turn-b';
      const calls = [
        await mcpInvoke(surface, 'sess-a', turnA),
        await mcpInvoke(surface, 'sess-b', turnB),
        await mcpInvoke(surface, 'sess-a', turnA),
      ];
      for (const res of calls) {
        expect(res.error?.message).toBeUndefined();
        expect((res.result as { isError?: boolean }).isError).toBeUndefined();
      }
      const seen = mockInvoke.mock.calls.map((c) => {
        const req = c[0] as { sessionId: string; turnId: string; context: { sessionId?: string; turnId?: string } };
        return [req.sessionId, req.turnId, req.context.sessionId, req.context.turnId];
      });
      expect(seen).toEqual([
        ['sess-a', 'turn-a', 'sess-a', 'turn-a'],
        ['sess-b', 'turn-b', 'sess-b', 'turn-b'],
        ['sess-a', 'turn-a', 'sess-a', 'turn-a'],
      ]);
    });
  }

  it('turnId defasado para a sessao (turno ja trocou) e recusado com turn_binding_required', async () => {
    const res = await mcpInvoke('claude-sdk', 'sess-a', 'turn-velho');
    expect((res.result as { isError?: boolean; content: string }).isError).toBe(true);
    expect((res.result as { content: string }).content).toContain('turn_binding_required');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('lion via wrapper: o binding do turno viaja no context do invokeMcpTool', async () => {
    await lionMcpCallViaWrapper(
      { server_id: 'google-gmail', tool: 'send_email', args: {} },
      {
        sessionId: 'sess-b',
        turnId: '3',
        allowedServerIds: ['google-gmail'],
        binding: { sessionId: 'sess-b', turnId: 'turn-b', lane: 'desktop' },
      },
    );
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'lion-sdk',
        context: { surface: 'chat', sessionId: 'sess-b', turnId: 'turn-b', lane: 'desktop' },
      }),
    );
  });

  it('resolveGatedCallTurnContext resolve cada helper pela sua propria lane, sem "turno ativo da lane"', () => {
    const a = resolveGatedCallTurnContext(helperCtx('lionclaw-kanban'), undefined, {
      lane: 'desktop',
      sessionId: 'sess-a',
    });
    const b = resolveGatedCallTurnContext(helperCtx('lionclaw-kanban'), undefined, {
      lane: 'desktop',
      sessionId: 'sess-b',
      turnId: 'turn-b',
    });
    expect(a).toMatchObject({ ok: true, sessionId: 'sess-a', turnId: 'turn-a' });
    expect(b).toMatchObject({ ok: true, sessionId: 'sess-b', turnId: 'turn-b' });
    expect(resolveGatedCallTurnContext(helperCtx('lionclaw-kanban'))).toMatchObject({
      ok: false,
      reason: 'turn-binding-required',
      code: 'turn_binding_required',
    });
  });
});

describe('9.4: subagentDispatchDepth por sessao', () => {
  it('call_agent em voo na lane A bloqueia pipeline_* de A, mas nao de B', async () => {
    const seen: Array<{ session: string; refused: boolean }> = [];
    lionAgentDispatchMock.mockImplementation(async () => {
      expect(isSubagentDispatchInFlight('sess-a')).toBe(true);
      expect(isSubagentDispatchInFlight('sess-b')).toBe(false);
      const a = await dispatch(ctx, {
        jsonrpc: '2.0',
        id: 10,
        method: 'pipeline_list',
        params: { sessionId: 'sess-a', turnId: 'turn-a' },
      });
      seen.push({ session: 'sess-a', refused: !!a.error });
      const b = await dispatch(ctx, {
        jsonrpc: '2.0',
        id: 11,
        method: 'pipeline_list',
        params: { sessionId: 'sess-b', turnId: 'turn-b' },
      });
      seen.push({ session: 'sess-b', refused: !!b.error });
      return { ok: true, summary: 'done' };
    });

    await handleCallAgent(helperCtx('lionclaw-agents'), {
      agent_id: 'sub-1',
      task: 'algo',
      binding: { lane: 'desktop', sessionId: 'sess-a', turnId: 'turn-a' },
    });

    expect(seen).toEqual([
      { session: 'sess-a', refused: true },
      { session: 'sess-b', refused: false },
    ]);
    expect(pipelineList).toHaveBeenCalledTimes(1);
    expect(isSubagentDispatchInFlight('sess-a')).toBe(false);
    expect(isSubagentDispatchInFlight()).toBe(false);
  });

  it('call_agent sem binding valido e recusado com turn_binding_required', async () => {
    await expect(handleCallAgent(helperCtx('lionclaw-agents'), { agent_id: 'sub-1', task: 'algo' })).rejects.toThrow(
      /turn_binding_required/,
    );
    expect(lionAgentDispatchMock).not.toHaveBeenCalled();
  });
});

describe('9.2 rollout (P1-1c): helper com dist antigo recebe a instrucao de rebuild na recusa', () => {
  const content = (res: Awaited<ReturnType<typeof dispatch>>) => (res.result as { content: string }).content;

  it('gateway antigo (sessionId sintetico gateway-*) = turn_binding_required + "rode npm run build:mcps"', async () => {
    const res = await mcpInvoke('claude-sdk', 'gateway-4242-abcd');
    expect(content(res)).toContain('turn_binding_required');
    expect(content(res)).toContain(MCP_DIST_STALE_HINT);
    expect(content(res)).toContain('npm run build:mcps');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('helper antigo sem _meta (desktop sem sessionId) = mesma instrucao', async () => {
    const res = await dispatch(ctx, {
      jsonrpc: '2.0',
      id: 2,
      method: 'mcp_invoke',
      params: { server: 'google-gmail', tool: 'send_email', args: {}, surface: 'claude-sdk' },
    });
    expect(content(res)).toContain('turn_binding_required');
    expect(content(res)).toContain(MCP_DIST_STALE_HINT);
    expect(isLegacyHelperBinding({ lane: 'desktop' })).toBe(true);
    expect(isLegacyHelperBinding({ lane: 'desktop', sessionId: 'gateway-1-ab' })).toBe(true);
  });

  it('helper novo com turnId defasado NAO recebe a instrucao (o dist esta certo; o turno e que trocou)', async () => {
    const res = await mcpInvoke('claude-sdk', 'sess-a', 'turn-velho');
    expect(content(res)).toContain('turn_binding_required');
    expect(content(res)).not.toContain('build:mcps');
    expect(isLegacyHelperBinding({ lane: 'desktop', sessionId: 'sess-a', turnId: 'turn-velho' })).toBe(false);
  });

  it('lane telegram sem turno ativo NAO recebe a instrucao (binding por lane e legitimo la)', async () => {
    const res = await dispatch(ctx, {
      jsonrpc: '2.0',
      id: 3,
      method: 'mcp_invoke',
      params: { server: 'google-gmail', tool: 'send_email', args: {}, surface: 'claude-sdk', lane: 'telegram' },
    });
    expect(content(res)).toContain('turn_binding_required');
    expect(content(res)).not.toContain('build:mcps');
    expect(isLegacyHelperBinding({ lane: 'telegram' })).toBe(false);
  });
});

describe('Swarm preserva binding do chat paralelo', () => {
  it('inspeciona somente sessão do binding válido; ausência e turno cruzado não entram no domínio', async () => {
    const call = (params: Record<string, unknown>) =>
      dispatch(helperCtx('lionclaw-swarm'), {
        jsonrpc: '2.0',
        id: 1,
        method: 'swarm_inspect',
        params: { runId: 'r1', ...params },
      });
    await call({ sessionId: 'sess-a', turnId: 'turn-a', lane: 'desktop' });
    await call({ sessionId: 'sess-b', turnId: 'turn-b', lane: 'desktop' });
    expect(swarmInspect.mock.calls).toEqual([
      ['sess-a', 'r1'],
      ['sess-b', 'r1'],
    ]);
    expect((await call({})).result).toMatchObject({ code: 'chat_capability_no_turn_context' });
    expect((await call({ sessionId: 'sess-a', turnId: 'turn-b' })).result).toMatchObject({
      code: 'chat_capability_no_turn_context',
    });
    expect(swarmInspect).toHaveBeenCalledTimes(2);
  });
});
