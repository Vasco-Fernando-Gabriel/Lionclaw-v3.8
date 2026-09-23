import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
  shell: {
    openPath: vi.fn(async () => ''),
    openExternal: vi.fn(async () => undefined),
  },
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
  getHarnessProject: vi.fn(() => undefined),
  getTelegramArmed: vi.fn(() => true),
  listHarnessProjects: vi.fn(() => []),
  getPipelinePhaseMessagesAsChatHistory: vi.fn(() => []),
}));

const { sendTelegramNotificationMock } = vi.hoisted(() => ({
  sendTelegramNotificationMock: vi.fn<(text: string) => Promise<void>>(async () => undefined),
}));
vi.mock('../telegram-bridge', () => ({
  isTelegramRunning: () => true,
  sendTelegramNotification: (text: string) => sendTelegramNotificationMock(text),
}));

vi.mock('../mcp-manager', () => ({ getAllMCPServers: vi.fn(() => []) }));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(async () => null) }));
vi.mock('../skills', () => ({ listSkills: vi.fn(() => []), getSkill: vi.fn() }));
vi.mock('../ask-question', () => ({ sendAskQuestion: vi.fn() }));

vi.mock('../pipeline-create', () => ({ createPipelineProject: vi.fn() }));
vi.mock('../pipeline-drive-coordinator', () => ({
  getPipelineDriveCoordinator: vi.fn(() => null),
}));

type GuardDecision = { behavior: 'allow' | 'deny'; message?: string };
const guardMock = vi.fn<(tool: string, input: Record<string, unknown>) => Promise<GuardDecision>>(async () => ({
  behavior: 'allow',
}));
vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => guardMock,
}));

const previewOpenCoreMock = vi.fn(async (target: string) => ({
  ok: true as const,
  value: { opened: true, kind: 'file', target },
}));
vi.mock('../preview-open', () => ({
  previewOpenCore: (target: string) => previewOpenCoreMock(target),
  previewCaptureCore: vi.fn(),
}));

const lionAgentDispatchMock = vi.fn(async (_params: unknown) => ({ ok: true, summary: 'done' }));
vi.mock('../lion-sdk/tools/agent', () => ({
  lionAgentDispatch: (params: unknown) => lionAgentDispatchMock(params),
}));

import { dispatch, handleCallAgent } from '../local-ipc/jsonrpc-methods';
import type { JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import { PIPELINE_WRITE_ACTIONS, isPipelineWriteAction } from '../pipeline-control-core';
import { bindActiveDesktopTurn, type ActiveChatTurnFixture } from './helpers/active-chat-turn-fixture';

const ctx: JsonRpcContext = {
  getWindow: () => null,
  connection: { authenticatedHelper: true, serverId: 'lionclaw-preview' },
};
const agentCtx: JsonRpcContext = {
  getWindow: () => null,
  connection: {
    authenticatedHelper: true,
    serverId: 'lionclaw-agents',
    connectionId: 'preview-gate-agents-test',
  },
};
const TARGET = '/Users/user/proj/dist/index.html';
let activeTurn: ActiveChatTurnFixture;
const activeBinding = () => ({ sessionId: activeTurn.sessionId, turnId: activeTurn.turnId });

beforeEach(() => {
  activeTurn = bindActiveDesktopTurn();
  vi.clearAllMocks();
  getActiveChatSessionMock.mockReturnValue({ id: 'chat-1' });
  guardMock.mockResolvedValue({ behavior: 'allow' });
  previewOpenCoreMock.mockImplementation(async (target: string) => ({
    ok: true as const,
    value: { opened: true, kind: 'file', target },
  }));
  lionAgentDispatchMock.mockResolvedValue({ ok: true, summary: 'done' });
});

afterEach(() => activeTurn.dispose());

describe('I8 — camada 1: preview independente de Pipeline', () => {
  it("PIPELINE_WRITE_ACTIONS nao contem 'preview_open'", () => {
    expect(PIPELINE_WRITE_ACTIONS.has('preview_open')).toBe(false);
  });

  it("isPipelineWriteAction('preview_open') === false", () => {
    expect(isPipelineWriteAction('preview_open')).toBe(false);
  });
});

describe('I8 — camada 2: gates de caller e permissao no dispatch', () => {
  it('conexao anonima ou de outro helper falha antes de abrir o preview', async () => {
    for (const connection of [
      { authenticatedHelper: false },
      { authenticatedHelper: true, serverId: 'lionclaw-telegram' },
    ]) {
      const res = await dispatch(
        { getWindow: () => null, connection },
        {
          method: 'preview_open',
          id: 99,
          params: { ...activeBinding(), target: TARGET },
        },
      );
      expect(res.error?.message).toMatch(/nao autenticada como lionclaw-preview/i);
    }
    expect(previewOpenCoreMock).not.toHaveBeenCalled();
  });

  it('orquestrador: sucesso e guard chamado pelo helper dedicado', async () => {
    const res = await dispatch(ctx, {
      method: 'preview_open',
      id: 1,
      params: { ...activeBinding(), target: TARGET },
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ opened: true, kind: 'file', target: TARGET });
    expect(previewOpenCoreMock).toHaveBeenCalledWith(TARGET);
    expect(guardMock).toHaveBeenCalledWith('mcp__lionclaw-preview__preview_open', {
      target: TARGET,
    });
  });

  it('subagente em curso (call_agent re-entrante): { error }, core nunca alcancado', async () => {
    let innerRefused = false;
    lionAgentDispatchMock.mockImplementation(async () => {
      const inner = await dispatch(ctx, {
        method: 'preview_open',
        id: 10,
        params: { ...activeBinding(), target: TARGET },
      });
      innerRefused = !!inner.error;
      return { ok: true, summary: 'done' };
    });

    await handleCallAgent(agentCtx, {
      agent_id: 'sub-1',
      task: 'abrir preview',
      binding: { lane: 'desktop', ...activeBinding() },
    });

    expect(innerRefused).toBe(true);
    expect(previewOpenCoreMock).not.toHaveBeenCalled();
  });

  it('sem sessao de chat ativa: { error }, core nunca alcancado', async () => {
    activeTurn.dispose();
    const res = await dispatch(ctx, {
      method: 'preview_open',
      id: 2,
      params: { ...activeBinding(), target: TARGET },
    });
    expect(res.result).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error?.message).toMatch(/orquestrador/i);
    expect(previewOpenCoreMock).not.toHaveBeenCalled();
  });

  it('humano nega no permission guard: { error }, core nunca alcancado', async () => {
    guardMock.mockResolvedValue({ behavior: 'deny', message: 'negado pelo humano' });
    const res = await dispatch(ctx, {
      method: 'preview_open',
      id: 3,
      params: { ...activeBinding(), target: TARGET },
    });
    expect(res.error).toBeDefined();
    expect(res.error?.message).toMatch(/negada pelo gate de permissao/i);
    expect(previewOpenCoreMock).not.toHaveBeenCalled();
  });

  it('gate liberado apos o subagente terminar (orquestrador volta a abrir preview)', async () => {
    await handleCallAgent(agentCtx, {
      agent_id: 'sub-1',
      task: 'algo',
      binding: { lane: 'desktop', ...activeBinding() },
    });
    const res = await dispatch(ctx, {
      method: 'preview_open',
      id: 4,
      params: { ...activeBinding(), target: TARGET },
    });
    expect(res.error).toBeUndefined();
    expect(previewOpenCoreMock).toHaveBeenCalledTimes(1);
  });
});

describe('telegram_notify — identidade e confirmação real de envio', () => {
  const telegramCtx: JsonRpcContext = {
    getWindow: () => null,
    connection: { authenticatedHelper: true, serverId: 'lionclaw-telegram' },
  };

  it('recusa chamada originada pelo helper de preview', async () => {
    const res = await dispatch(ctx, {
      method: 'telegram_notify',
      id: 20,
      params: { ...activeBinding(), message: 'ola' },
    });
    expect(res.error?.message).toMatch(/lionclaw-telegram/);
    expect(sendTelegramNotificationMock).not.toHaveBeenCalled();
  });

  it('retorna sent:false quando a API do Telegram falha', async () => {
    sendTelegramNotificationMock.mockRejectedValueOnce(new Error('network down'));
    const res = await dispatch(telegramCtx, {
      method: 'telegram_notify',
      id: 21,
      params: { ...activeBinding(), message: 'ola' },
    });
    expect(res.result).toMatchObject({ sent: false, reason: 'send-failed' });
  });

  it('retorna sent:true somente depois do envio confirmado', async () => {
    sendTelegramNotificationMock.mockResolvedValueOnce(undefined);
    const res = await dispatch(telegramCtx, {
      method: 'telegram_notify',
      id: 22,
      params: { ...activeBinding(), message: 'ola' },
    });
    expect(res.result).toEqual({ sent: true });
  });
});
