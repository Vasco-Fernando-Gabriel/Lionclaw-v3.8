
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));


const getHarnessProjectMock = vi.fn<(id: string) => Record<string, unknown> | null>();
const getDriveStateMock = vi.fn<(id: string) => Record<string, unknown> | null>(() => null);
const getActiveChatSessionMock = vi.fn<() => { id: string } | null>(() => ({ id: 'chat-1' }));

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  insertAuditEntry: vi.fn(),
  getAgent: vi.fn(() => undefined),
  getActiveChatSession: () => getActiveChatSessionMock(),
  getHarnessProject: (id: string) => getHarnessProjectMock(id),
  listHarnessProjects: vi.fn(() => []),
  getPipelinePhaseMessagesAsChatHistory: vi.fn(() => []),
  getDriveState: (id: string) => getDriveStateMock(id),
  isDriveEngaged: (id: string) => {
    const d = getDriveStateMock(id) as { driver?: string; status?: string } | null;
    return !!d && d.driver === 'orchestrator' && d.status !== 'stopped';
  },
}));


vi.mock('../pipeline-create', () => ({ createPipelineProject: vi.fn() }));
vi.mock('../pipeline-engine-ref', () => ({ getPipelineEngineRef: vi.fn(() => null) }));
vi.mock('../pipeline-drive-coordinator', () => ({ getPipelineDriveCoordinator: vi.fn(() => null) }));
vi.mock('../pipeline-event-bus', () => ({ pipelineEventBus: { on: vi.fn(), emit: vi.fn() } }));
vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: vi.fn() }));


vi.mock('../mcp-manager', () => ({ getAllMCPServers: vi.fn(() => []) }));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(async () => null) }));
vi.mock('../skills', () => ({ listSkills: vi.fn(() => []), getSkill: vi.fn() }));
vi.mock('../ask-question', () => ({ sendAskQuestion: vi.fn() }));
vi.mock('../preview-open', () => ({
  previewOpenCore: vi.fn(async () => ({ ok: true, value: {} })),
}));

const permissionGuardMock = vi.fn(async () => ({ behavior: 'allow' as const }));
vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => permissionGuardMock,
}));

const lionAgentDispatchMock = vi.fn(async (_params: unknown) => ({ ok: true, summary: 'done' }));
vi.mock('../lion-sdk/tools/agent', () => ({
  lionAgentDispatch: (params: unknown) => lionAgentDispatchMock(params),
}));


const getSessionConfigMock = vi.fn<(id: string) => Record<string, unknown> | null>();
vi.mock('../open-design/session-config', () => ({
  getSessionConfig: (id: string) => getSessionConfigMock(id),
}));

const getOpenDesignConfigMock = vi.fn<(id: string) => Record<string, unknown> | null>();
vi.mock('../open-design/config', () => ({
  getOpenDesignConfig: (id: string) => getOpenDesignConfigMock(id),
}));

const managerStatusMock = vi.fn<(id: string) => Record<string, unknown>>();
vi.mock('../open-design/manager', () => ({
  status: (id: string) => managerStatusMock(id),
}));

const putMessageMock = vi.fn(async () => undefined);
const startRunMock = vi.fn(async (_payload: Record<string, unknown>) => ({ runId: 'run-77' }));
const createAdapterMock = vi.fn((_cfg: unknown) => ({
  putMessage: putMessageMock,
  startRun: startRunMock,
}));
vi.mock('../open-design/adapter-http', () => ({
  createAdapter: (cfg: unknown) => createAdapterMock(cfg as never),
}));


import {
  sendDesignPrompt,
  DESIGN_SESSION_INACTIVE_ERROR,
} from '../open-design/design-prompt';
import { PIPELINE_WRITE_ACTIONS } from '../pipeline-control-core';
import { dispatch, handleCallAgent } from '../local-ipc/jsonrpc-methods';
import type { JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import { bindActiveDesktopTurn, type ActiveChatTurnFixture } from './helpers/active-chat-turn-fixture';

const ctx: JsonRpcContext = { getWindow: () => null };
const agentCtx: JsonRpcContext = {
  getWindow: () => null,
  connection: { authenticatedHelper: true, serverId: 'lionclaw-agents', connectionId: 'design-prompt-agent-test' },
};
let activeTurn: ActiveChatTurnFixture;

function devV2Project(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    name: 'Projeto Dev V2',
    pipelineType: 'development-v2',
    status: 'paused',
    projectPath: '/tmp/projeto',
    ...partial,
  };
}

function odSessionDefaults(): void {
  getSessionConfigMock.mockReturnValue({
    agentId: 'claude',
    model: 'claude-test-model',
    memoryEnabled: false,
    mcpServerIds: [],
    locale: 'pt-BR',
    configuredAt: '2026-06-10T00:00:00.000Z',
  });
  getOpenDesignConfigMock.mockReturnValue({
    openDesignProjectId: 'lionclaw-run1',
    conversationId: 'conv-1',
  });
  managerStatusMock.mockReturnValue({
    running: true,
    daemonUrl: 'http://127.0.0.1:4811',
    webUrl: 'http://127.0.0.1:4810',
    daemonPort: 4811,
    webPort: 4810,
  });
}

beforeEach(() => {
  activeTurn = bindActiveDesktopTurn();
  vi.clearAllMocks();
  getActiveChatSessionMock.mockReturnValue({ id: 'chat-1' });
  getDriveStateMock.mockReturnValue(null);
  getHarnessProjectMock.mockReturnValue(devV2Project());
  startRunMock.mockResolvedValue({ runId: 'run-77' });
  putMessageMock.mockResolvedValue(undefined);
  permissionGuardMock.mockResolvedValue({ behavior: 'allow' as const });
  lionAgentDispatchMock.mockResolvedValue({ ok: true, summary: 'done' });
  odSessionDefaults();
});

afterEach(() => activeTurn.dispose());


describe('sendDesignPrompt — validacoes do handler (B1-AC2)', () => {
  it('projeto inexistente -> { error } sem tocar o adapter', async () => {
    getHarnessProjectMock.mockReturnValue(null);
    const res = await sendDesignPrompt('p404', 'deixe o header mais compacto');
    expect(res).toHaveProperty('error');
    expect((res as { error: string }).error).toMatch(/nao encontrado/);
    expect(createAdapterMock).not.toHaveBeenCalled();
  });

  it('pipeline nao dev-v2 -> { error } citando development-v2', async () => {
    getHarnessProjectMock.mockReturnValue(devV2Project({ pipelineType: 'security' }));
    const res = await sendDesignPrompt('p1', 'ajuste o layout');
    expect(res).toHaveProperty('error');
    expect((res as { error: string }).error).toMatch(/development-v2/);
    expect((res as { error: string }).error).toMatch(/security/);
    expect(createAdapterMock).not.toHaveBeenCalled();
  });

  it('sem sessionConfig -> { error } instrutivo (autostart na fase do studio)', async () => {
    getSessionConfigMock.mockReturnValue(null);
    const res = await sendDesignPrompt('p1', 'ajuste o layout');
    expect((res as { error: string }).error).toContain(DESIGN_SESSION_INACTIVE_ERROR);
    expect(createAdapterMock).not.toHaveBeenCalled();
  });

  it('sem conversationId (bootstrap nao rodou) -> { error } instrutivo', async () => {
    getOpenDesignConfigMock.mockReturnValue({ openDesignProjectId: 'lionclaw-run1' });
    const res = await sendDesignPrompt('p1', 'ajuste o layout');
    expect((res as { error: string }).error).toContain(DESIGN_SESSION_INACTIVE_ERROR);
    expect(createAdapterMock).not.toHaveBeenCalled();
  });

  it('sidecar parado (manager.status running=false) -> { error } instrutivo', async () => {
    managerStatusMock.mockReturnValue({
      running: false,
      daemonUrl: null,
      webUrl: null,
      daemonPort: null,
      webPort: null,
    });
    const res = await sendDesignPrompt('p1', 'ajuste o layout');
    expect((res as { error: string }).error).toContain(DESIGN_SESSION_INACTIVE_ERROR);
    expect(createAdapterMock).not.toHaveBeenCalled();
  });

  it('message vazia -> { error } de obrigatorios', async () => {
    const res = await sendDesignPrompt('p1', '   ');
    expect((res as { error: string }).error).toMatch(/obrigatorios/);
    expect(getHarnessProjectMock).not.toHaveBeenCalled();
  });

  it('happy path: PUT user + PUT assistant placeholder + POST /api/runs (sequencia do Send do OD)', async () => {
    const res = await sendDesignPrompt('p1', 'deixe o header mais compacto');

    expect(res).toMatchObject({
      delivered: true,
      projectId: 'p1',
      openDesignProjectId: 'lionclaw-run1',
      conversationId: 'conv-1',
      runId: 'run-77',
    });

    expect(createAdapterMock).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:4811' });

    expect(putMessageMock).toHaveBeenCalledTimes(2);
    const [projIdUser, convIdUser, userMsgId, userMsg] = putMessageMock.mock.calls[0] as unknown as [
      string,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(projIdUser).toBe('lionclaw-run1');
    expect(convIdUser).toBe('conv-1');
    expect(userMsg).toMatchObject({ role: 'user', content: 'deixe o header mais compacto' });
    expect(userMsg['id']).toBe(userMsgId);

    const [, , assistantMsgId, assistantMsg] = putMessageMock.mock.calls[1] as unknown as [
      string,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(assistantMsg).toMatchObject({ role: 'assistant', content: '', runStatus: 'running' });

    expect(startRunMock).toHaveBeenCalledTimes(1);
    const runPayload = startRunMock.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(runPayload).toMatchObject({
      projectId: 'lionclaw-run1',
      conversationId: 'conv-1',
      assistantMessageId: assistantMsgId,
      agentId: 'claude',
      model: 'claude-test-model',
      message: 'deixe o header mais compacto',
      currentPrompt: 'deixe o header mais compacto',
      designSystemId: null,
    });
  });

  it('falha do adapter (HTTP) -> { error } tecnico, nunca throw', async () => {
    putMessageMock.mockRejectedValueOnce(new Error('Adapter HTTP PUT -> 500'));
    const res = await sendDesignPrompt('p1', 'ajuste o layout');
    expect((res as { error: string }).error).toMatch(/Adapter HTTP PUT -> 500/);
    expect(startRunMock).not.toHaveBeenCalled();
  });
});


describe('design_prompt removida do catalogo do orquestrador (A4 / A2-AC6)', () => {
  it('design_prompt NAO esta em PIPELINE_WRITE_ACTIONS', () => {
    expect(PIPELINE_WRITE_ACTIONS.has('design_prompt')).toBe(false);
  });

  it('design_session_config segue no catalogo das WRITE (revert nao removeu o vizinho)', () => {
    expect(PIPELINE_WRITE_ACTIONS.has('design_session_config')).toBe(true);
  });

  it('dispatch jsonrpc nao roteia design_prompt: cai no default -32601 Method not found', async () => {
    const res = await dispatch(ctx, {
      method: 'design_prompt',
      id: 1,
      params: { id: 'p1', message: 'deixe o header mais compacto' },
    });
    expect(res.result).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32601);
    expect(res.error?.message).toMatch(/Method not found/i);
    expect(createAdapterMock).not.toHaveBeenCalled();
    expect(startRunMock).not.toHaveBeenCalled();
  });

  it('subagente (call_agent re-entrante) tambem nao acha design_prompt: -32601', async () => {
    const inner: Array<{ notFound: boolean }> = [];
    lionAgentDispatchMock.mockImplementation(async () => {
      const res = await dispatch(ctx, {
        method: 'design_prompt',
        id: 10,
        params: { id: 'p1', message: 'sub tentou' },
      });
      inner.push({ notFound: res.error?.code === -32601 });
      return { ok: true, summary: 'done' };
    });

    await handleCallAgent(agentCtx, { agent_id: 'sub-1', task: 'algo' });

    expect(inner).toEqual([{ notFound: true }]);
    expect(createAdapterMock).not.toHaveBeenCalled();
    expect(startRunMock).not.toHaveBeenCalled();
  });
});
