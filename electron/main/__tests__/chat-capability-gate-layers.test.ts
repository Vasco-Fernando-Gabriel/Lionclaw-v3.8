
import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const settings: Record<string, string | undefined> = {};
  const logEntries: Array<{ level: string; data: unknown; msg: string }> = [];
  const makeLevel =
    (level: string) =>
    (...args: unknown[]) => {
      const [first, second] = args;
      if (typeof first === 'string') {
        logEntries.push({ level, data: undefined, msg: first });
      } else {
        logEntries.push({
          level,
          data: first,
          msg: typeof second === 'string' ? second : '',
        });
      }
    };
  const state: { activeChatSession: { id: string } | null } = {
    activeChatSession: null,
  };
  return { settings, logEntries, makeLevel, state };
});

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: hoisted.makeLevel('info'),
    warn: hoisted.makeLevel('warn'),
    error: hoisted.makeLevel('error'),
    debug: hoisted.makeLevel('debug'),
  }),
}));

vi.mock('../db', () => ({
  getSetting: (key: string) => hoisted.settings[key],
  getAllAgents: () => [],
  getAgent: () => undefined,
  getActiveChatSession: () => hoisted.state.activeChatSession,
  getPermissionBypass: () => true,
  getCompletedDocsCount: () => 0,
  insertAuditEntry: vi.fn(),
}));


const guardFn = vi.hoisted(() => vi.fn());
const createPermissionGuardMock = vi.hoisted(() => vi.fn());
const getMCPConfigForAgentMock = vi.hoisted(() => vi.fn());
const getMcpToolRegistryEntriesMock = vi.hoisted(() => vi.fn());
const discoverMock = vi.hoisted(() => vi.fn());
const setupMock = vi.hoisted(() => vi.fn());
const callMock = vi.hoisted(() => vi.fn());
const teardownMock = vi.hoisted(() => vi.fn());

vi.mock('../permission-guard', () => ({
  createPermissionGuard: createPermissionGuardMock,
}));

vi.mock('../mcp-manager', () => ({
  getAllMCPServers: () => [],
  getMCPConfigForAgent: getMCPConfigForAgentMock,
  getMcpToolRegistryEntries: getMcpToolRegistryEntriesMock,
  discoverAndSaveMCPTools: discoverMock,
}));

vi.mock('../mcp-tool-bridge', () => ({
  setupMCPsForSession: setupMock,
  callMCPTool: callMock,
  teardownMCPsForSession: teardownMock,
}));


vi.mock('../secrets-vault', () => ({ getSecret: async () => null }));

vi.mock('../skills', () => ({
  listSkills: () => [],
  getSkill: () => null,
}));

vi.mock('../ask-question', () => ({
  sendAskQuestion: async () => ({ id: 'unused', answers: [] }),
}));

const pipelineListCoreMock = vi.hoisted(() => vi.fn());
const pipelineReplyCoreMock = vi.hoisted(() => vi.fn());

vi.mock('../pipeline-control-core', () => ({
  isPipelineWriteAction: () => false,
  pipelineListCore: pipelineListCoreMock,
  pipelineInspectCore: vi.fn(),
  pipelineCreateCore: vi.fn(),
  pipelineDriveCore: vi.fn(),
  pipelineReplyCore: pipelineReplyCoreMock,
  pipelineApproveCore: vi.fn(),
  pipelineEscalateCore: vi.fn(),
  pipelineAbortCore: vi.fn(),
  pipelinePauseCore: vi.fn(),
  designSessionConfigCore: vi.fn(),
  normalizeApproveMetadata: (m: unknown) => m,
}));

const dynamicWorkflowInspectCoreMock = vi.hoisted(() => vi.fn());

vi.mock('../dynamic-workflows/workflow-control-core', () => ({
  isDynamicWorkflowWriteAction: () => false,
  dynamicWorkflowStartCore: vi.fn(),
  dynamicWorkflowAuthorCore: vi.fn(),
  dynamicWorkflowInspectCore: dynamicWorkflowInspectCoreMock,
  dynamicWorkflowReplyCore: vi.fn(),
  dynamicWorkflowApproveCore: vi.fn(),
  dynamicWorkflowInterveneCore: vi.fn(),
  dynamicWorkflowAbortCore: vi.fn(),
  dynamicWorkflowEditCoordinatorCore: vi.fn(),
}));


import {
  initMcpInvoke,
  invokeMcpTool,
  _resetMcpInvokeForTesting,
} from '../mcp-invoke';
import {
  dispatch,
  type JsonRpcContext,
} from '../local-ipc/jsonrpc-methods';
import { lionMcpCall, lionMcpCallViaWrapper } from '../lion-sdk/tools/mcp';
import {
  registerChatCapabilityTurn,
  setActiveChatTurn,
  __resetChatCapabilityContextForTests,
  type ChatCapabilityTurnContextInput,
} from '../chat-capability-context';
import {
  createInternalCapabilityLease,
  __resetInternalCapabilityLeasesForTests,
} from '../chat-capability-lease';
import { CHAT_CAPABILITY_GATE_MODE_SETTING_KEY } from '../chat-capability-gate';

const PIPELINE_SERVER = 'lionclaw-pipeline-control';
const PIPELINE_OFF_MESSAGE =
  'Pipeline está desligado para esta sessão. Ligue o chip Pipeline no chat e envie novamente.';

function setMode(mode: 'shadow' | 'enforce' | undefined): void {
  if (mode === undefined) {
    delete hoisted.settings[CHAT_CAPABILITY_GATE_MODE_SETTING_KEY];
  } else {
    hoisted.settings[CHAT_CAPABILITY_GATE_MODE_SETTING_KEY] = mode;
  }
}

function seedTurn(
  overrides?: Partial<ChatCapabilityTurnContextInput>,
): void {
  const sessionId = overrides?.sessionId ?? 'sess-1';
  const turnId = overrides?.turnId ?? 'turn-1';
  registerChatCapabilityTurn({
    surface: 'chat',
    sessionId,
    turnId,
    capabilities: { pipelineControl: false, dynamicWorkflows: false },
    ...overrides,
  });
  setActiveChatTurn({ sessionId, lane: 'desktop', turnId });
}

const AUTHED_CTX: JsonRpcContext = {
  getWindow: () => null,
  connection: { authenticatedHelper: true, serverId: 'lionclaw-pipeline-control' },
};
const WORKFLOW_AUTHED_CTX: JsonRpcContext = {
  getWindow: () => null,
  connection: { authenticatedHelper: true, serverId: 'lionclaw-dynamic-workflows' },
};
const ANON_CTX: JsonRpcContext = { getWindow: () => null };

beforeEach(() => {
  vi.clearAllMocks();
  _resetMcpInvokeForTesting();
  hoisted.logEntries.length = 0;
  hoisted.state.activeChatSession = { id: 'sess-1' };
  for (const key of Object.keys(hoisted.settings)) delete hoisted.settings[key];
  __resetChatCapabilityContextForTests();
  __resetInternalCapabilityLeasesForTests();

  createPermissionGuardMock.mockImplementation(() => guardFn);
  guardFn.mockImplementation(async () => ({ behavior: 'allow' }));
  getMCPConfigForAgentMock.mockImplementation(async () => ({
    [PIPELINE_SERVER]: { command: 'node', args: ['pc.js'] },
    'google-gmail': { command: 'node', args: ['gmail.js'] },
  }));
  getMcpToolRegistryEntriesMock.mockImplementation((mcpId?: string) => {
    const rows = [
      {
        mcpId: PIPELINE_SERVER,
        toolName: 'pipeline_list',
        description: 'Lista pipelines',
        inputSchema: null,
        lastDiscoveredAt: null,
      },
      {
        mcpId: 'google-gmail',
        toolName: 'send_email',
        description: 'Envia email',
        inputSchema: null,
        lastDiscoveredAt: null,
      },
    ];
    return mcpId === undefined ? rows : rows.filter((r) => r.mcpId === mcpId);
  });
  discoverMock.mockResolvedValue([]);
  setupMock.mockImplementation(async (servers: Record<string, unknown>) => ({
    client: { connections: Object.keys(servers).map((serverId) => ({ serverId })) },
    tools: [],
  }));
  callMock.mockResolvedValue({ content: [{ type: 'text', text: 'resultado-ok' }] });
  teardownMock.mockResolvedValue(undefined);

  pipelineListCoreMock.mockReturnValue({ ok: true, value: [{ id: 'p1' }] });
  pipelineReplyCoreMock.mockResolvedValue({ ok: true, value: { replied: true } });
  dynamicWorkflowInspectCoreMock.mockResolvedValue({ ok: true, value: { runId: 'r1' } });

  initMcpInvoke({ getWindow: () => null });
});


describe('camada 1 (invokeMcpTool)', () => {
  const gatedReq = {
    serverId: PIPELINE_SERVER,
    toolName: 'pipeline_list',
    args: {},
    surface: 'kimi-sdk',
    sessionId: 'caps-sess',
    turnId: '1',
    allowedServerIds: [PIPELINE_SERVER, 'google-gmail'],
    context: { surface: 'chat' as const },
  };

  it('enforce + capability OFF -> isError com _meta {code, capability}, SEM spawn/discovery/guard', async () => {
    setMode('enforce');
    seedTurn(); // off/off
    const result = await invokeMcpTool(gatedReq);
    expect(result.isError).toBe(true);
    expect(result.content).toBe(PIPELINE_OFF_MESSAGE);
    expect(result.displayName).toBe(`mcp__${PIPELINE_SERVER}__pipeline_list`);
    expect(result._meta).toEqual({
      code: 'chat_capability_pipeline_disabled',
      capability: 'pipelineControl',
    });
    expect(getMCPConfigForAgentMock).not.toHaveBeenCalled();
    expect(setupMock).not.toHaveBeenCalled();
    expect(guardFn).not.toHaveBeenCalled();
    expect(callMock).not.toHaveBeenCalled();
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it('enforce + fail-closed (sem turn-context) -> isError no-turn-context sem executar', async () => {
    setMode('enforce');
    const result = await invokeMcpTool(gatedReq);
    expect(result.isError).toBe(true);
    expect(result._meta?.code).toBe('chat_capability_no_turn_context');
    expect(callMock).not.toHaveBeenCalled();
  });

  it('shadow (DEFAULT) + capability OFF -> fluxo NORMAL (executa) + log "negaria"', async () => {
    seedTurn(); // off/off, setting ausente
    const result = await invokeMcpTool(gatedReq);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('resultado-ok');
    expect(result._meta).toBeUndefined();
    expect(callMock).toHaveBeenCalledTimes(1);
    const negaria = hoisted.logEntries.filter((e) => e.msg.includes('negaria'));
    expect(negaria).toHaveLength(1);
  });

  it('context AUSENTE (caller nao-chat legado) -> gate nao se aplica, mesmo em enforce', async () => {
    setMode('enforce');
    const { context: _context, ...semContext } = gatedReq;
    const result = await invokeMcpTool(semContext);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('resultado-ok');
  });

  it('enforce + capability ON -> executa normal', async () => {
    setMode('enforce');
    seedTurn({ capabilities: { pipelineControl: true, dynamicWorkflows: false } });
    const result = await invokeMcpTool(gatedReq);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('resultado-ok');
  });

  it('server nao-gated + enforce + sem turn-context -> nao e afetado pelo gate', async () => {
    setMode('enforce');
    const result = await invokeMcpTool({
      ...gatedReq,
      serverId: 'google-gmail',
      toolName: 'send_email',
      allowedServerIds: ['google-gmail'],
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('resultado-ok');
  });
});


describe('camada 2 (dispatch pipeline_*/dynamic_workflow_*)', () => {
  it('enforce + capability OFF -> erro estruturado {error, code, capability} SEM executar o core', async () => {
    setMode('enforce');
    seedTurn(); // off/off
    const res = await dispatch(AUTHED_CTX, {
      jsonrpc: '2.0',
      id: 1,
      method: 'pipeline_list',
      params: {},
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      error: PIPELINE_OFF_MESSAGE,
      code: 'chat_capability_pipeline_disabled',
      capability: 'pipelineControl',
    });
    expect(pipelineListCoreMock).not.toHaveBeenCalled();
  });

  it('enforce + workflows OFF -> nega dynamic_workflow_* com o code de workflows', async () => {
    setMode('enforce');
    seedTurn({ capabilities: { pipelineControl: true, dynamicWorkflows: false } });
    const res = await dispatch(WORKFLOW_AUTHED_CTX, {
      jsonrpc: '2.0',
      id: 2,
      method: 'dynamic_workflow_inspect',
      params: { runId: 'r1' },
    });
    expect(res.result).toMatchObject({
      code: 'chat_capability_workflows_disabled',
      capability: 'dynamicWorkflows',
    });
    expect(dynamicWorkflowInspectCoreMock).not.toHaveBeenCalled();
  });

  it('enforce + conexao NAO autenticada -> fail closed (no-turn-context) sem re-resolver pela lane', async () => {
    setMode('enforce');
    seedTurn({ capabilities: { pipelineControl: true, dynamicWorkflows: true } });
    const res = await dispatch(ANON_CTX, {
      jsonrpc: '2.0',
      id: 3,
      method: 'pipeline_list',
      params: {},
    });
    expect(res.result).toMatchObject({ code: 'chat_capability_no_turn_context' });
    expect(pipelineListCoreMock).not.toHaveBeenCalled();
  });

  it('enforce + capability ON -> executa (core chamado, resultado normal)', async () => {
    setMode('enforce');
    seedTurn({ capabilities: { pipelineControl: true, dynamicWorkflows: false } });
    const res = await dispatch(AUTHED_CTX, {
      jsonrpc: '2.0',
      id: 4,
      method: 'pipeline_list',
      params: {},
    });
    expect(res.result).toEqual([{ id: 'p1' }]);
    expect(pipelineListCoreMock).toHaveBeenCalledTimes(1);
  });

  it('enforce + turno system-event com lease valida -> passa o gate e executa (0.5.1)', async () => {
    setMode('enforce');
    const { token } = createInternalCapabilityLease({
      coordinator: 'pipeline-drive-coordinator',
      driveProjectId: 'proj-1',
      driveTurnId: 'dt-1',
      allowedServerIds: [PIPELINE_SERVER],
      allowedToolPrefixes: ['pipeline_'],
      ttlMs: 60_000,
    });
    seedTurn({
      origin: 'system-event',
      internalLeaseToken: token,
      driveProjectId: 'proj-1',
      driveTurnId: 'dt-1',
    }); // toggles off/off — a lease e quem libera
    const res = await dispatch(AUTHED_CTX, {
      jsonrpc: '2.0',
      id: 5,
      method: 'pipeline_reply',
      params: { id: 'p1', message: 'go' },
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ replied: true });
    expect(pipelineReplyCoreMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(hoisted.logEntries)).not.toContain(token);
  });

  it('shadow (DEFAULT) + capability OFF -> fluxo IDENTICO ao pre-S4 (executa + log S3b)', async () => {
    seedTurn(); // off/off, setting ausente
    const res = await dispatch(AUTHED_CTX, {
      jsonrpc: '2.0',
      id: 6,
      method: 'pipeline_list',
      params: {},
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual([{ id: 'p1' }]);
    expect(pipelineListCoreMock).toHaveBeenCalledTimes(1);
    const s3b = hoisted.logEntries.filter((e) => e.msg.startsWith('S3b shadow'));
    expect(s3b).toHaveLength(1);
  });

  it('shadow (DEFAULT) + conexao anonima -> nada negado (comportamento pre-S4)', async () => {
    const res = await dispatch(ANON_CTX, {
      jsonrpc: '2.0',
      id: 7,
      method: 'pipeline_list',
      params: {},
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual([{ id: 'p1' }]);
  });

  it('S6b (S4-ii): shadow + capability OFF -> executa normal E loga o would-deny da capability (alem do S3b)', async () => {
    seedTurn(); // off/off, setting ausente = shadow
    const res = await dispatch(AUTHED_CTX, {
      jsonrpc: '2.0',
      id: 9,
      method: 'pipeline_list',
      params: {},
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual([{ id: 'p1' }]);
    expect(pipelineListCoreMock).toHaveBeenCalledTimes(1);
    const negaria = hoisted.logEntries.filter((e) => e.msg.includes('negaria'));
    expect(negaria).toHaveLength(1);
    expect(negaria[0].msg).toContain(
      'negaria pipelineControl em lionclaw-pipeline-control.pipeline_list',
    );
    expect((negaria[0].data as Record<string, unknown>)['shadow']).toBe(true);
    const s3b = hoisted.logEntries.filter((e) => e.msg.startsWith('S3b shadow'));
    expect(s3b).toHaveLength(1);
  });

  it('S6b: shadow + conexao anonima -> executa E loga would-deny fail-closed (no-turn-context)', async () => {
    seedTurn(); // turno ativo existe, mas a conexao nao provou quem e
    const res = await dispatch(ANON_CTX, {
      jsonrpc: '2.0',
      id: 10,
      method: 'pipeline_list',
      params: {},
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual([{ id: 'p1' }]);
    const negaria = hoisted.logEntries.filter((e) => e.msg.includes('negaria'));
    expect(negaria).toHaveLength(1);
    expect((negaria[0].data as Record<string, unknown>)['reason']).toBe(
      'unauthenticated-connection',
    );
    expect((negaria[0].data as Record<string, unknown>)['code']).toBe(
      'chat_capability_no_turn_context',
    );
  });

  it('S6b: shadow com lease system-event NAO esgota a lease (dryRun); so o enforce consome', async () => {
    const { token } = createInternalCapabilityLease({
      coordinator: 'pipeline-drive-coordinator',
      driveProjectId: 'proj-1',
      driveTurnId: 'dt-1',
      allowedServerIds: [PIPELINE_SERVER],
      allowedToolPrefixes: ['pipeline_'],
      ttlMs: 60_000,
      maxUses: 1, // um UNICO uso
    });
    seedTurn({
      origin: 'system-event',
      internalLeaseToken: token,
      driveProjectId: 'proj-1',
      driveTurnId: 'dt-1',
      leaseCoordinator: 'pipeline-drive-coordinator',
      leaseCapability: 'pipelineControl',
    });

    for (let i = 0; i < 3; i++) {
      const res = await dispatch(AUTHED_CTX, {
        jsonrpc: '2.0',
        id: 11 + i,
        method: 'pipeline_reply',
        params: { id: 'p1', message: 'go' },
      });
      expect(res.result).toEqual({ replied: true });
    }
    expect(hoisted.logEntries.filter((e) => e.msg.includes('negaria'))).toHaveLength(0);

    setMode('enforce');
    const ok = await dispatch(AUTHED_CTX, {
      jsonrpc: '2.0',
      id: 20,
      method: 'pipeline_reply',
      params: { id: 'p1', message: 'go' },
    });
    expect(ok.result).toEqual({ replied: true });

    const denied = await dispatch(AUTHED_CTX, {
      jsonrpc: '2.0',
      id: 21,
      method: 'pipeline_reply',
      params: { id: 'p1', message: 'go' },
    });
    expect(denied.result).toMatchObject({ code: 'chat_capability_lease_invalid' });
    expect(pipelineReplyCoreMock).toHaveBeenCalledTimes(4); // 3 shadow + 1 enforce
  });

  it('metodo NAO-gated nunca consulta o gate (sem log, sem negacao) mesmo em enforce', async () => {
    setMode('enforce');
    const res = await dispatch(ANON_CTX, {
      jsonrpc: '2.0',
      id: 8,
      method: 'list_skills',
      params: {},
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual([]);
  });
});


describe('camada 3 (lion mcp_call)', () => {
  it('lionMcpCallViaWrapper herda a camada 1: enforce + OFF -> isError com a mensagem A.7', async () => {
    setMode('enforce');
    seedTurn(); // off/off
    const result = await lionMcpCallViaWrapper(
      { server_id: PIPELINE_SERVER, tool: 'pipeline_list', args: {} },
      { sessionId: 's', turnId: '1', allowedServerIds: [PIPELINE_SERVER] },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe(PIPELINE_OFF_MESSAGE);
    expect(callMock).not.toHaveBeenCalled();
  });

  it('lionMcpCall legado: enforce + OFF -> nega ANTES do bridge; shadow -> segue normal', async () => {
    setMode('enforce');
    seedTurn(); // off/off
    const client = {
      connections: [{ serverId: PIPELINE_SERVER }],
    } as never;
    const denied = await lionMcpCall(client, {
      server_id: PIPELINE_SERVER,
      tool: 'pipeline_list',
    });
    expect(denied.ok).toBe(false);
    expect(denied.error).toBe(PIPELINE_OFF_MESSAGE);
    expect(callMock).not.toHaveBeenCalled();

    setMode(undefined); // shadow default
    const allowed = await lionMcpCall(client, {
      server_id: PIPELINE_SERVER,
      tool: 'pipeline_list',
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.content).toBe('resultado-ok');
    expect(callMock).toHaveBeenCalledTimes(1);
  });

  it('lionMcpCall com server nao-gated preserva o comportamento atual', async () => {
    setMode('enforce');
    const client = { connections: [] } as never;
    const result = await lionMcpCall(client, {
      server_id: 'does-not-exist',
      tool: 'some_tool',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/nenhum MCP ativo/);
  });
});
