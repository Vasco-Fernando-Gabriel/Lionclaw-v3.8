import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const getActiveChatSessionMock = vi.fn<() => { id: string } | null>(() => ({
  id: 'chat-1',
}));
vi.mock('../in-flight-desktop-session', () => ({
  getInFlightDesktopSession: () => getActiveChatSessionMock()?.id ?? null,
  setInFlightDesktopSession: () => {},
}));
vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  insertAuditEntry: vi.fn(),
  getAgent: vi.fn(() => undefined),
  getActiveChatSession: () => getActiveChatSessionMock(),
}));

vi.mock('../mcp-manager', () => ({ getAllMCPServers: vi.fn(() => []) }));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(async () => null) }));
vi.mock('../skills', () => ({ listSkills: vi.fn(() => []), getSkill: vi.fn() }));
vi.mock('../ask-question', () => ({ sendAskQuestion: vi.fn() }));

vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => vi.fn(async () => ({ behavior: 'allow' })),
}));

const pipelineListCore = vi.fn(() => ({ ok: true, value: ['ok'] }));
const pipelineInspectCore = vi.fn(() => ({ ok: true, value: { id: 'p1' } }));
const pipelineReplyCore = vi.fn(async () => ({ ok: true, value: { id: 'p1' } }));
const pipelineEscalateCore = vi.fn(() => ({ ok: true, value: { id: 'p1' } }));
vi.mock('../pipeline-control-core', () => ({
  assertPipeVisibleToLane: vi.fn(() => null),
  isPipelineWriteAction: (a: string) =>
    new Set([
      'pipeline_create',
      'pipeline_drive',
      'pipeline_reply',
      'pipeline_approve',
      'pipeline_escalate',
      'pipeline_abort',
      'pipeline_pause',
    ]).has(a),
  pipelineListCore: () => pipelineListCore(),
  pipelineInspectCore: () => pipelineInspectCore(),
  pipelineCreateCore: vi.fn(async () => ({ ok: true, value: {} })),
  pipelineDriveCore: vi.fn(() => ({ ok: true, value: {} })),
  pipelineReplyCore: () => pipelineReplyCore(),
  pipelineApproveCore: vi.fn(async () => ({ ok: true, value: {} })),
  pipelineEscalateCore: () => pipelineEscalateCore(),
  pipelineAbortCore: vi.fn(() => ({ ok: true, value: {} })),
  pipelinePauseCore: vi.fn(() => ({ ok: true, value: {} })),
}));

const lionAgentDispatchMock = vi.fn(async (_params: unknown) => ({ ok: true, summary: 'done' }));
vi.mock('../lion-sdk/tools/agent', () => ({
  lionAgentDispatch: (params: unknown) => lionAgentDispatchMock(params),
}));

import { dispatch, handleCallAgent } from '../local-ipc/jsonrpc-methods';
import type { JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import { bindActiveDesktopTurn, type ActiveChatTurnFixture } from './helpers/active-chat-turn-fixture';

const ctx: JsonRpcContext = { getWindow: () => null };
const agentCtx: JsonRpcContext = {
  getWindow: () => null,
  connection: { authenticatedHelper: true, serverId: 'lionclaw-agents', connectionId: 'pipeline-caller-agent-test' },
};
let activeTurn: ActiveChatTurnFixture;
const activeBinding = () => ({ sessionId: activeTurn.sessionId, turnId: activeTurn.turnId });

beforeEach(() => {
  activeTurn = bindActiveDesktopTurn();
  vi.clearAllMocks();
  getActiveChatSessionMock.mockReturnValue({ id: 'chat-1' });
  lionAgentDispatchMock.mockResolvedValue({ ok: true, summary: 'done' });
});

afterEach(() => activeTurn.dispose());

describe('FX3 / TOOLS-2 — gate de caller (orquestrador-only)', () => {
  it('atende pipeline_list quando ha chat ativo e nenhum subagente em curso', async () => {
    const res = await dispatch(ctx, { method: 'pipeline_list', id: 1, params: activeBinding() });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual(['ok']);
    expect(pipelineListCore).toHaveBeenCalledTimes(1);
  });

  it('atende pipeline_reply (WRITE) quando ha chat ativo e nenhum subagente em curso (I6-AC5)', async () => {
    const res = await dispatch(ctx, {
      method: 'pipeline_reply',
      id: 6,
      params: { ...activeBinding(), id: 'p1', message: 'segue' },
    });
    expect(res.error).toBeUndefined();
    expect(pipelineReplyCore).toHaveBeenCalledTimes(1);
  });

  it('atende pipeline_escalate (WRITE) quando ha chat ativo e nenhum subagente em curso (C-02)', async () => {
    const res = await dispatch(ctx, {
      method: 'pipeline_escalate',
      id: 7,
      params: { ...activeBinding(), id: 'p1', message: 'preciso do seu OK no PRD' },
    });
    expect(res.error).toBeUndefined();
    expect(pipelineEscalateCore).toHaveBeenCalledTimes(1);
  });

  it('recusa pipeline_escalate (WRITE) quando NAO ha sessao de chat ativa (subagente) - C-02', async () => {
    activeTurn.dispose();
    const res = await dispatch(ctx, {
      method: 'pipeline_escalate',
      id: 8,
      params: { ...activeBinding(), id: 'p1', message: 'sub tentou escalar' },
    });
    expect(res.result).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error?.message).toMatch(/orquestrador/i);
    expect(pipelineEscalateCore).not.toHaveBeenCalled();
  });

  it('atende pipeline_inspect (READ) quando ha chat ativo', async () => {
    const res = await dispatch(ctx, {
      method: 'pipeline_inspect',
      id: 2,
      params: { ...activeBinding(), id: 'p1' },
    });
    expect(res.error).toBeUndefined();
    expect(pipelineInspectCore).toHaveBeenCalledTimes(1);
  });

  it('recusa pipeline_list (READ) quando NAO ha sessao de chat ativa', async () => {
    activeTurn.dispose();
    const res = await dispatch(ctx, { method: 'pipeline_list', id: 3, params: activeBinding() });
    expect(res.result).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error?.message).toMatch(/orquestrador/i);
    expect(pipelineListCore).not.toHaveBeenCalled();
  });

  it('recusa pipeline_reply (WRITE) quando NAO ha sessao de chat ativa', async () => {
    activeTurn.dispose();
    const res = await dispatch(ctx, {
      method: 'pipeline_reply',
      id: 4,
      params: { ...activeBinding(), id: 'p1', message: 'oi' },
    });
    expect(res.error).toBeDefined();
    expect(pipelineReplyCore).not.toHaveBeenCalled();
  });

  it('recusa pipeline_* (read E write) enquanto ha um dispatch de subagente EM CURSO', async () => {
    const innerResults: Array<{ method: string; refused: boolean }> = [];
    lionAgentDispatchMock.mockImplementation(async () => {
      const listRes = await dispatch(ctx, { method: 'pipeline_list', id: 10, params: activeBinding() });
      innerResults.push({ method: 'pipeline_list', refused: !!listRes.error });
      const replyRes = await dispatch(ctx, {
        method: 'pipeline_reply',
        id: 11,
        params: { ...activeBinding(), id: 'p1', message: 'sub tentou' },
      });
      innerResults.push({ method: 'pipeline_reply', refused: !!replyRes.error });
      return { ok: true, summary: 'done' };
    });

    await handleCallAgent(agentCtx, {
      agent_id: 'sub-1',
      task: 'algo',
      binding: { lane: 'desktop', ...activeBinding() },
    });

    expect(innerResults).toEqual([
      { method: 'pipeline_list', refused: true },
      { method: 'pipeline_reply', refused: true },
    ]);
    expect(pipelineListCore).not.toHaveBeenCalled();
    expect(pipelineReplyCore).not.toHaveBeenCalled();
  });

  it('libera o gate apos o subagente terminar (orquestrador volta a poder dirigir)', async () => {
    await handleCallAgent(agentCtx, {
      agent_id: 'sub-1',
      task: 'algo',
      binding: { lane: 'desktop', ...activeBinding() },
    });
    const res = await dispatch(ctx, { method: 'pipeline_list', id: 20, params: activeBinding() });
    expect(res.error).toBeUndefined();
    expect(pipelineListCore).toHaveBeenCalledTimes(1);
  });
});
