
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
const setSessionConfigMock = vi.fn<(id: string, cfg: Record<string, unknown>) => void>();
vi.mock('../open-design/session-config', () => ({
  getSessionConfig: (id: string) => getSessionConfigMock(id),
  setSessionConfig: (id: string, cfg: Record<string, unknown>) => setSessionConfigMock(id, cfg),
}));

const resolveAutostartBaseMock = vi.fn<() => Record<string, unknown>>();
vi.mock('../open-design/drive-autostart', () => ({
  resolveAutostartBaseSessionConfig: () => resolveAutostartBaseMock(),
}));

const ensureSessionMock = vi.fn(async (_id: string): Promise<Record<string, unknown>> => ({
  openDesignProjectId: 'od-1',
  conversationId: 'conv-9',
  webUrl: 'http://127.0.0.1:4810/projects/od-1',
  initialPromptHash: 'h',
  initialPromptSentAt: 't',
  bootstrappedAt: 't',
}));
const hasActiveDesignRunMock = vi.fn(async (_id: string): Promise<boolean> => false);
vi.mock('../open-design/bootstrap', () => ({
  ensureSession: (id: string) => ensureSessionMock(id),
  hasActiveDesignRun: (id: string) => hasActiveDesignRunMock(id),
}));

const setOpenDesignConfigMock = vi.fn<(id: string, patch: Record<string, unknown>) => void>();
vi.mock('../open-design/config', () => ({
  setOpenDesignConfig: (id: string, patch: Record<string, unknown>) =>
    setOpenDesignConfigMock(id, patch),
}));


import { applyDesignSessionConfig } from '../open-design/session-config-tool';
import { designSessionConfigCore, PIPELINE_WRITE_ACTIONS } from '../pipeline-control-core';
import { dispatch, handleCallAgent } from '../local-ipc/jsonrpc-methods';
import type { JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import { bindActiveDesktopTurn, type ActiveChatTurnFixture } from './helpers/active-chat-turn-fixture';

const ctx: JsonRpcContext = { getWindow: () => null };
const agentCtx: JsonRpcContext = {
  getWindow: () => null,
  connection: { authenticatedHelper: true, serverId: 'lionclaw-agents', connectionId: 'design-session-agent-test' },
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

function existingSessionConfig(): Record<string, unknown> {
  return {
    agentId: 'claude',
    model: 'claude-test-model',
    memoryEnabled: false,
    mcpServerIds: [],
    locale: 'pt-BR',
    configuredAt: '2026-06-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  activeTurn = bindActiveDesktopTurn();
  vi.clearAllMocks();
  getActiveChatSessionMock.mockReturnValue({ id: 'chat-1' });
  getDriveStateMock.mockReturnValue(null);
  getHarnessProjectMock.mockReturnValue(devV2Project());
  getSessionConfigMock.mockReturnValue(existingSessionConfig());
  setSessionConfigMock.mockImplementation(() => undefined);
  resolveAutostartBaseMock.mockReturnValue({
    agentId: 'claude',
    model: 'claude-fallback-model',
    memoryEnabled: false,
    mcpServerIds: [],
    locale: 'pt-BR',
    configuredAt: '2026-06-01T00:00:00.000Z',
  });
  ensureSessionMock.mockResolvedValue({
    openDesignProjectId: 'od-1',
    conversationId: 'conv-9',
    webUrl: 'http://127.0.0.1:4810/projects/od-1',
    initialPromptHash: 'h',
    initialPromptSentAt: 't',
    bootstrappedAt: 't',
  });
  hasActiveDesignRunMock.mockResolvedValue(false);
  setOpenDesignConfigMock.mockImplementation(() => undefined);
  permissionGuardMock.mockResolvedValue({ behavior: 'allow' as const });
  lionAgentDispatchMock.mockResolvedValue({ ok: true, summary: 'done' });
});

afterEach(() => activeTurn.dispose());


describe('applyDesignSessionConfig — validacoes do handler', () => {
  it('projeto inexistente -> { error } sem tocar o setSessionConfig', async () => {
    getHarnessProjectMock.mockReturnValue(null);
    const res = await applyDesignSessionConfig('p404', { agentId: 'claude' });
    expect((res as { error: string }).error).toMatch(/nao encontrado/);
    expect(setSessionConfigMock).not.toHaveBeenCalled();
  });

  it('pipeline nao dev-v2 -> { error } citando development-v2', async () => {
    getHarnessProjectMock.mockReturnValue(devV2Project({ pipelineType: 'security' }));
    const res = await applyDesignSessionConfig('p1', { model: 'opus' });
    expect((res as { error: string }).error).toMatch(/development-v2/);
    expect((res as { error: string }).error).toMatch(/security/);
    expect(setSessionConfigMock).not.toHaveBeenCalled();
  });

  it('W3.0-AC4: patch vazio SEM sessionConfig vigente -> { error } instrutivo, sem set nem ensure', async () => {
    getSessionConfigMock.mockReturnValue(null);
    const res = await applyDesignSessionConfig('p1', {});
    expect((res as { error: string }).error).toMatch(/ao menos um campo/);
    expect((res as { error: string }).error).toContain('agentId');
    expect(setSessionConfigMock).not.toHaveBeenCalled();
    expect(ensureSessionMock).not.toHaveBeenCalled();
  });

  it('W3.0-AC4: patch vazio COM sessionConfig vigente -> GO start-only (ensureSession idempotente, ZERO setSessionConfig)', async () => {
    const res = await applyDesignSessionConfig('p1', {});
    expect(res).toMatchObject({
      applied: true,
      projectId: 'p1',
      agentId: 'claude',
      model: 'claude-test-model',
      sessionEnsured: true,
      conversationId: 'conv-9',
    });
    expect(setSessionConfigMock).not.toHaveBeenCalled();
    expect(ensureSessionMock).toHaveBeenCalledWith('p1');
  });

  it('W3.0-AC4: GO start-only best-effort: ensureSession falha -> applied:true + ensureError, config vigente preservado', async () => {
    ensureSessionMock.mockResolvedValue({ error: 'sidecar nao subiu' });
    const res = await applyDesignSessionConfig('p1', {});
    expect(res).toMatchObject({
      applied: true,
      sessionEnsured: false,
      ensureError: 'sidecar nao subiu',
    });
    expect(setSessionConfigMock).not.toHaveBeenCalled();
  });

  it('F6-AC1 merge: patch parcial { model } preserva os demais campos do config atual', async () => {
    const res = await applyDesignSessionConfig('p1', { model: 'opus' });
    expect(res).toMatchObject({ applied: true, agentId: 'claude', model: 'opus' });
    expect(setSessionConfigMock).toHaveBeenCalledTimes(1);
    const [projId, cfg] = setSessionConfigMock.mock.calls[0]!;
    expect(projId).toBe('p1');
    expect(cfg).toMatchObject({
      agentId: 'claude',
      model: 'opus',
      memoryEnabled: false,
      mcpServerIds: [],
      locale: 'pt-BR',
    });
    expect(cfg['configuredAt']).not.toBe('2026-06-01T00:00:00.000Z');
  });

  it('sem sessionConfig atual: merge sobre a base do drive-autostart (ultimo-usado/fallback)', async () => {
    getSessionConfigMock.mockReturnValue(null);
    const res = await applyDesignSessionConfig('p1', { agentId: 'claude', model: 'opus' });
    expect(res).toMatchObject({ applied: true, agentId: 'claude', model: 'opus' });
    expect(resolveAutostartBaseMock).toHaveBeenCalledTimes(1);
    const [, cfg] = setSessionConfigMock.mock.calls[0]!;
    expect(cfg).toMatchObject({ agentId: 'claude', model: 'opus', locale: 'pt-BR' });
  });

  it('setSessionConfig rejeita (validacao agente/modelo) -> { error } instrutivo, ensureSession nao roda', async () => {
    setSessionConfigMock.mockImplementation(() => {
      throw new Error('modelo "gpt-x" nao pertence ao agente Claude');
    });
    const res = await applyDesignSessionConfig('p1', { model: 'gpt-x' });
    expect((res as { error: string }).error).toMatch(/nao pertence ao agente Claude/);
    expect(ensureSessionMock).not.toHaveBeenCalled();
  });

  it('happy path: setSessionConfig + ensureSession main-side -> sessionEnsured true + conversationId', async () => {
    const res = await applyDesignSessionConfig('p1', { agentId: 'claude', model: 'opus' });
    expect(res).toMatchObject({
      applied: true,
      projectId: 'p1',
      sessionEnsured: true,
      conversationId: 'conv-9',
    });
    expect(ensureSessionMock).toHaveBeenCalledWith('p1');
  });

  it('ensureSession falha: set NAO e desfeito; applied:true + sessionEnsured:false + ensureError', async () => {
    ensureSessionMock.mockResolvedValue({ error: 'sidecar nao subiu' });
    const res = await applyDesignSessionConfig('p1', { model: 'opus' });
    expect(res).toMatchObject({
      applied: true,
      sessionEnsured: false,
      ensureError: 'sidecar nao subiu',
    });
    expect(setSessionConfigMock).toHaveBeenCalledTimes(1);
  });

  it('ensureSession LANCA: erro capturado e reportado, nunca throw pro caller', async () => {
    ensureSessionMock.mockRejectedValue(new Error('boom http'));
    const res = await applyDesignSessionConfig('p1', { model: 'opus' });
    expect(res).toMatchObject({ applied: true, sessionEnsured: false, ensureError: 'boom http' });
  });
});


describe('applyDesignSessionConfig - briefing revertido (A-AC4)', () => {
  it('A-AC4: GO start-only (patch vazio) inicia a geracao SEM nenhum driverBriefing', async () => {
    const res = await applyDesignSessionConfig('p1', {});
    expect(res).toMatchObject({ applied: true, sessionEnsured: true, conversationId: 'conv-9' });
    expect(ensureSessionMock).toHaveBeenCalledWith('p1');
    expect(setOpenDesignConfigMock).not.toHaveBeenCalled();
    for (const [, cfg] of setSessionConfigMock.mock.calls) {
      expect(cfg).not.toHaveProperty('briefing');
      expect(cfg).not.toHaveProperty('driverBriefing');
    }
  });

  it('A-AC4: patch de config (agentId/model) da o GO, NUNCA persiste driverBriefing', async () => {
    const res = await applyDesignSessionConfig('p1', { agentId: 'claude', model: 'opus' });
    expect(res).toMatchObject({ applied: true, model: 'opus' });
    expect(setSessionConfigMock).toHaveBeenCalledTimes(1);
    const [, cfg] = setSessionConfigMock.mock.calls[0]!;
    expect(cfg).not.toHaveProperty('briefing');
    expect(cfg).not.toHaveProperty('driverBriefing');
    for (const [, patch] of setOpenDesignConfigMock.mock.calls) {
      expect(patch).not.toHaveProperty('driverBriefing');
    }
  });

  it('A-AC4: nenhum payload ao setSessionConfig contem briefing/driverBriefing', async () => {
    await applyDesignSessionConfig('p1', { model: 'opus' });
    const [, cfg] = setSessionConfigMock.mock.calls[0]!;
    expect(JSON.stringify(cfg)).not.toContain('driverBriefing');
    expect(JSON.stringify(cfg)).not.toContain('briefing');
  });

  it('W3-AC2: run ATIVO na conversa OD -> { error } instrutivo, ZERO set, ZERO ensure', async () => {
    hasActiveDesignRunMock.mockResolvedValue(true);
    const res = await applyDesignSessionConfig('p1', { agentId: 'codex', model: 'gpt-5' });
    expect((res as { error: string }).error).toMatch(/geracao em curso/i);
    expect(setSessionConfigMock).not.toHaveBeenCalled();
    expect(ensureSessionMock).not.toHaveBeenCalled();
  });

  it('W3-AC2: GO start-only (patch vazio) NAO passa pelo gate (nao invalida nada)', async () => {
    hasActiveDesignRunMock.mockResolvedValue(true);
    const res = await applyDesignSessionConfig('p1', {});
    expect(res).toMatchObject({ applied: true, sessionEnsured: true });
    expect(hasActiveDesignRunMock).not.toHaveBeenCalled();
  });
});


function drive(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    driver: 'orchestrator',
    status: 'driving',
    mode: 'semi',
    handoff: 'none',
    sessionId: 's1',
    requiresHumanPhases: [],
    ...partial,
  };
}

describe('designSessionConfigCore — gate driveConductBlocked (enforcement Parar/Assumir)', () => {
  it('F6-AC4: design_session_config esta em PIPELINE_WRITE_ACTIONS (unico elo fail-open do checklist)', () => {
    expect(PIPELINE_WRITE_ACTIONS.has('design_session_config')).toBe(true);
  });

  it('drive PARADO (status stopped): bloqueia ANTES de alcancar o handler', async () => {
    getDriveStateMock.mockReturnValue(drive({ status: 'stopped' }));
    const res = await designSessionConfigCore({ id: 'p1', model: 'opus' });
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain('PARADO');
    expect(setSessionConfigMock).not.toHaveBeenCalled();
    expect(getHarnessProjectMock).not.toHaveBeenCalled();
  });

  it('humano ASSUMIU (driver human): bloqueia ANTES de alcancar o handler', async () => {
    getDriveStateMock.mockReturnValue(drive({ driver: 'human', handoff: 'permanent' }));
    const res = await designSessionConfigCore({ id: 'p1', model: 'opus' });
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain('ASSUMIU');
    expect(setSessionConfigMock).not.toHaveBeenCalled();
  });

  it('awaiting-human (escalacao do semi): NAO bloqueia, delega ao handler', async () => {
    getDriveStateMock.mockReturnValue(drive({ status: 'awaiting-human' }));
    const res = await designSessionConfigCore({ id: 'p1', agentId: 'claude', model: 'opus' });
    expect(res.ok).toBe(true);
    expect(setSessionConfigMock).toHaveBeenCalledTimes(1);
  });

  it('sem DriveState (uso ad-hoc): delega ao handler e retorna ok', async () => {
    const res = await designSessionConfigCore({ id: 'p1', model: 'opus' });
    expect(res.ok).toBe(true);
    expect((res as { ok: true; value: Record<string, unknown> }).value).toMatchObject({
      applied: true,
      model: 'opus',
    });
  });

  it('{ error } do handler vira fail do core (ex: projeto nao dev-v2)', async () => {
    getHarnessProjectMock.mockReturnValue(devV2Project({ pipelineType: 'feature' }));
    const res = await designSessionConfigCore({ id: 'p1', model: 'opus' });
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toMatch(/development-v2/);
  });

  it('id obrigatorio', async () => {
    const res = await designSessionConfigCore({ id: '', model: 'opus' });
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toMatch(/obrigatorio/);
  });
});


describe('jsonrpc design_session_config — proxy + gates de caller/permissao', () => {
  it('roteia pro handler (end-to-end): result applied + gate de permissao consultado', async () => {
    const res = await dispatch(ctx, {
      method: 'design_session_config',
      id: 1,
      params: { id: 'p1', agentId: 'claude', model: 'opus' },
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ applied: true, agentId: 'claude', model: 'opus' });
    expect(setSessionConfigMock).toHaveBeenCalledTimes(1);
    expect(permissionGuardMock).toHaveBeenCalledWith(
      'mcp__pipeline-control__design_session_config',
      expect.objectContaining({ id: 'p1' }),
    );
  });

  it('subagente em curso (call_agent re-entrante): RECUSADO pelo gate de caller', async () => {
    const inner: Array<{ refused: boolean }> = [];
    lionAgentDispatchMock.mockImplementation(async () => {
      const res = await dispatch(ctx, {
        method: 'design_session_config',
        id: 10,
        params: { id: 'p1', model: 'opus' },
      });
      inner.push({ refused: !!res.error });
      return { ok: true, summary: 'done' };
    });

    await handleCallAgent(agentCtx, { agent_id: 'sub-1', task: 'algo' });

    expect(inner).toEqual([{ refused: true }]);
    expect(setSessionConfigMock).not.toHaveBeenCalled();
  });

  it('sem sessao de chat ativa: RECUSADO (sem orquestrador para dirigir)', async () => {
    getActiveChatSessionMock.mockReturnValue(null);
    const res = await dispatch(ctx, {
      method: 'design_session_config',
      id: 2,
      params: { id: 'p1', model: 'opus' },
    });
    expect(res.result).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error?.message).toMatch(/orquestrador/i);
    expect(setSessionConfigMock).not.toHaveBeenCalled();
  });

  it('F6-AC4: gate de permissao NEGA -> erro propagado e o handler nao roda', async () => {
    permissionGuardMock.mockResolvedValueOnce({
      behavior: 'deny',
      message: 'humano negou',
    } as never);
    const res = await dispatch(ctx, {
      method: 'design_session_config',
      id: 3,
      params: { id: 'p1', model: 'opus' },
    });
    expect(res.error).toBeDefined();
    expect(res.error?.message).toMatch(/negada/);
    expect(setSessionConfigMock).not.toHaveBeenCalled();
  });
});
