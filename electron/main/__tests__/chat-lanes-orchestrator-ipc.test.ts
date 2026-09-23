import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  webContentsSendMock: vi.fn(),
  submitMessageMock: vi.fn(),
  setSessionOrchestratorMock: vi.fn(),
  executionState: new Map<string, 'streaming' | 'queued' | 'idle'>(),
  lanes: [] as Array<Record<string, unknown>>,
  settings: {} as Record<string, string | undefined>,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      h.ipcHandlers.set(channel, handler);
    },
    on: vi.fn(),
  },
  BrowserWindow: class {},
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../db', () => ({
  getAllSessions: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  trashSession: vi.fn(),
  getSetting: (key: string) => h.settings[key],
  getSessionOrchestrator: (id: string) =>
    (h.lanes.find((l) => l['id'] === id)?.['orchestrator'] as Record<string, unknown> | null | undefined) ?? null,
  insertMessage: vi.fn(),
  getSession: vi.fn((id: string) => h.lanes.find((l) => l['id'] === id)),
  getChatFeatureToggles: vi.fn(() => null),
  setChatFeatureToggles: vi.fn(),
  isOpenDesktopConversation: vi.fn(() => true),
  getOpenLaneSessionById: vi.fn((id: string) => h.lanes.find((l) => l['id'] === id) ?? null),
  listOpenDesktopSessions: vi.fn((resolve: (row: Record<string, unknown>) => string) =>
    h.lanes.map((row) => ({ ...row, state: resolve(row) })),
  ),
  createLaneSession: vi.fn(),
  setSessionOrchestrator: (...args: unknown[]) => {
    h.setSessionOrchestratorMock(...args);
    const lane = h.lanes.find((l) => l['id'] === args[0]);
    if (lane) lane['orchestrator'] = args[1];
  },
  countSessionMessages: vi.fn((id: string) => (h.lanes.find((l) => l['id'] === id)?.['messageCount'] as number) ?? 0),
}));

vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(async () => null) }));
vi.mock('../codex-runtime/model-capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../codex-runtime/model-capabilities')>();
  return { ...actual, getCodexModelCapabilities: vi.fn(async () => null), findDiscoveredCodexModel: () => undefined };
});
vi.mock('../chat-capability-resolve', () => ({
  resolveChatCapabilitiesForTurn: vi.fn(() => ({ pipelineControl: false, dynamicWorkflows: false })),
  sanitizeChatFeatureTogglesPatch: vi.fn(),
}));
vi.mock('../orchestrator', () => ({
  submitMessage: (...args: unknown[]) => h.submitMessageMock(...args),
  stopCurrentQuery: vi.fn(),
  getDesktopSessionExecutionState: (id: string) => h.executionState.get(id) ?? 'idle',
}));
vi.mock('../pipeline-drive-coordinator', () => ({ getPipelineDriveCoordinator: vi.fn(() => null) }));
vi.mock('../session-drive', () => ({ sessionHasActiveDrive: () => false }));
vi.mock('../codeburn-pty', () => ({
  spawnCodeburn: vi.fn(),
  writeCodeburn: vi.fn(),
  resizeCodeburn: vi.fn(),
  killCodeburn: vi.fn(),
}));
vi.mock('../permission-guard', () => ({ resolveConfirmation: vi.fn() }));
vi.mock('../ask-question', () => ({ resolveAskQuestion: vi.fn() }));
vi.mock('../chat-clear', () => ({ clearLaneSession: vi.fn(), cancelQueuedClear: vi.fn() }));

import { registerChatHandlers } from '../ipc/chat';
import type { IpcContext } from '../ipc/context';
import { clearingSessions } from '../clearing-sessions';
import { notifyLaneSessionUpdated } from '../lane-session-events';
import { getPipelineDriveCoordinator } from '../pipeline-drive-coordinator';
import { getSessionMessages, insertMessage } from '../db';

const CLAUDE = { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-5', effort: 'high' };
const CODEX = { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-5.4-mini', effort: 'high' };

function lane(
  id: string,
  badge: number,
  orchestrator: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    laneBadge: badge,
    title: `Lane ${badge}`,
    orchestrator,
    messageCount: 3,
    lastUserMessageAt: '2026-09-08 10:00:00',
    createdAt: '2026-09-08 10:00:00',
    updatedAt: '2026-09-08 10:00:00',
    dreamingStartedAt: null,
    status: 'active',
    type: 'chat',
    activeContextTokensEst: 120_000,
    ...extra,
  };
}

function ctx(): IpcContext {
  return {
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: h.webContentsSendMock } }),
  } as unknown as IpcContext;
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = h.ipcHandlers.get(channel);
  expect(handler, `handler ${channel}`).toBeDefined();
  return Promise.resolve(handler!({}, ...args));
}

function sessionUpdatedEvents(): Array<Record<string, unknown>> {
  return h.webContentsSendMock.mock.calls
    .filter((call) => call[0] === 'chat:session-updated')
    .map((call) => call[1] as Record<string, unknown>);
}

beforeEach(() => {
  h.ipcHandlers.clear();
  h.lanes = [];
  h.executionState.clear();
  h.settings = { onboarding_completed: 'true', orchestrator_effort: 'high', orchestrator_codex_effort: 'high' };
  h.submitMessageMock.mockClear();
  h.setSessionOrchestratorMock.mockClear();
  h.webContentsSendMock.mockClear();
  clearingSessions.clear();
  registerChatHandlers(ctx());
});

describe('AC-11 (main): chat:send com model/effort (7.2)', () => {
  it('modelo fora do provider da lane = model_not_in_provider tipado; nada persiste nem enfileira', async () => {
    h.lanes = [lane('a', 1, CLAUDE)];
    const result = await invoke('chat:send', 'oi', { sessionId: 'a', model: 'gpt-5.5' });
    expect(result).toMatchObject({ accepted: false, code: 'model_not_in_provider' });
    expect(h.setSessionOrchestratorMock).not.toHaveBeenCalled();
    expect(h.submitMessageMock).not.toHaveBeenCalled();
  });

  it('effort fora das opcoes do modelo = effort_not_supported tipado', async () => {
    h.lanes = [lane('a', 1, CLAUDE)];
    const result = await invoke('chat:send', 'oi', { sessionId: 'a', effort: 'ultra' });
    expect(result).toMatchObject({ accepted: false, code: 'effort_not_supported' });
    expect(h.submitMessageMock).not.toHaveBeenCalled();
  });

  it('modelo do MESMO provider + effort validos: persiste nas colunas, emite chat:session-updated com effort e passa ao turno', async () => {
    h.lanes = [lane('a', 1, CLAUDE)];
    const result = await invoke('chat:send', 'oi', { sessionId: 'a', model: 'claude-sonnet-5', effort: 'max' });
    expect(result).toEqual({ accepted: true });
    expect(h.setSessionOrchestratorMock).toHaveBeenCalledWith('a', {
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      effort: 'max',
    });
    expect(sessionUpdatedEvents()).toEqual([
      expect.objectContaining({
        sessionId: 'a',
        orchestrator: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-sonnet-5', effort: 'max' },
      }),
    ]);
    expect(h.submitMessageMock).toHaveBeenCalledTimes(1);
    expect(h.submitMessageMock.mock.calls[0]?.[1]).toMatchObject({
      sessionId: 'a',
      model: 'claude-sonnet-5',
      effort: 'max',
    });
  });

  it('so effort: mantem o modelo da lane e persiste o effort (vale deste turno em diante)', async () => {
    h.lanes = [lane('a', 1, CLAUDE)];
    await invoke('chat:send', 'oi', { sessionId: 'a', effort: 'low' });
    expect(h.setSessionOrchestratorMock).toHaveBeenCalledWith('a', { ...CLAUDE, effort: 'low' });
    expect(h.submitMessageMock.mock.calls[0]?.[1]).toMatchObject({ model: 'claude-opus-5', effort: 'low' });
  });

  it('agentId NAO persiste modelo (so model/effort explicitos gravam nas colunas)', async () => {
    h.lanes = [lane('a', 1, CLAUDE)];
    await invoke('chat:send', 'oi', { sessionId: 'a', agentId: 'explore' });
    expect(h.setSessionOrchestratorMock).not.toHaveBeenCalled();
    expect(h.submitMessageMock.mock.calls[0]?.[1]).toMatchObject({ sessionId: 'a', agentId: 'explore' });
    expect(h.submitMessageMock.mock.calls[0]?.[1]).not.toHaveProperty('model');
  });
});

describe('P2-1 (7.4): chat:session-updated acompanha o turno inteiro, sempre', () => {
  function simulateProcessor(sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      h.submitMessageMock.mockImplementationOnce(() => {
        h.executionState.set(sessionId, 'streaming');
        notifyLaneSessionUpdated(sessionId);
        setTimeout(() => {
          const lane = h.lanes.find((l) => l['id'] === sessionId)!;
          lane['messageCount'] = 1;
          notifyLaneSessionUpdated(sessionId);
          setTimeout(() => {
            h.executionState.set(sessionId, 'idle');
            notifyLaneSessionUpdated(sessionId);
            resolve();
          }, 0);
        }, 0);
      });
    });
  }

  it('envio SEM override: inicio do turno (streaming), pos-submit (streaming), mensagem persistida (messageCount 1) e fim (idle)', async () => {
    h.lanes = [lane('a', 1, CLAUDE, { messageCount: 0 })];
    const processed = simulateProcessor('a');
    const result = await invoke('chat:send', 'oi', { sessionId: 'a' });
    expect(result).toEqual({ accepted: true });
    await processed;
    expect(h.setSessionOrchestratorMock).not.toHaveBeenCalled();
    expect(sessionUpdatedEvents().map((e) => [e['state'], e['messageCount']])).toEqual([
      ['streaming', 0],
      ['streaming', 0],
      ['streaming', 1],
      ['idle', 1],
    ]);
  });

  it('notificacao de sessao que nao e lane aberta nao emite nada', () => {
    h.lanes = [];
    notifyLaneSessionUpdated('telegram-1');
    expect(sessionUpdatedEvents()).toEqual([]);
  });
});

describe('P3-1 (7.2): override do turno persiste so quando difere das colunas e DEPOIS dos gates', () => {
  it('model/effort iguais as colunas: nada persiste, o turno recebe o override e o evento sai apos o submit', async () => {
    h.lanes = [lane('a', 1, CLAUDE)];
    h.executionState.set('a', 'queued');
    const result = await invoke('chat:send', 'oi', { sessionId: 'a', model: 'claude-opus-5', effort: 'high' });
    expect(result).toEqual({ accepted: true });
    expect(h.setSessionOrchestratorMock).not.toHaveBeenCalled();
    expect(h.submitMessageMock.mock.calls[0]?.[1]).toMatchObject({ model: 'claude-opus-5', effort: 'high' });
    expect(sessionUpdatedEvents()).toEqual([expect.objectContaining({ sessionId: 'a', state: 'queued' })]);
  });

  it('autostart do onboarding recusado: nada persiste, nada enfileira, nenhum evento', async () => {
    h.settings.onboarding_completed = undefined;
    h.lanes = [lane('a', 1, CLAUDE)];
    vi.mocked(getSessionMessages).mockReturnValueOnce([{ id: 1 } as never]);
    const result = await invoke('chat:send', 'Ola! Vamos comecar.', { sessionId: 'a', model: 'claude-sonnet-5' });
    expect(result).toEqual({ accepted: false });
    expect(h.setSessionOrchestratorMock).not.toHaveBeenCalled();
    expect(h.submitMessageMock).not.toHaveBeenCalled();
    expect(sessionUpdatedEvents()).toEqual([]);
  });

  it('mensagem interceptada pelo drive: persiste a mensagem humana e emite o evento, mas nao grava o override', async () => {
    h.lanes = [lane('a', 1, CLAUDE)];
    vi.mocked(getPipelineDriveCoordinator).mockReturnValueOnce({
      tryInterceptChatForDrive: () => true,
    } as never);
    const result = await invoke('chat:send', 'aprovado', { sessionId: 'a', model: 'claude-sonnet-5' });
    expect(result).toEqual({ accepted: true });
    expect(insertMessage).toHaveBeenCalledWith('a', 'user', 'aprovado');
    expect(h.setSessionOrchestratorMock).not.toHaveBeenCalled();
    expect(h.submitMessageMock).not.toHaveBeenCalled();
    expect(sessionUpdatedEvents()).toHaveLength(1);
  });

  it('override diferente: persiste ANTES do submit (o turno ja le as colunas novas) e o evento carrega o orquestrador novo', async () => {
    h.lanes = [lane('a', 1, CLAUDE)];
    const order: string[] = [];
    h.setSessionOrchestratorMock.mockImplementationOnce(() => order.push('persist'));
    h.submitMessageMock.mockImplementationOnce(() => order.push('submit'));
    await invoke('chat:send', 'oi', { sessionId: 'a', model: 'claude-sonnet-5' });
    expect(order).toEqual(['persist', 'submit']);
    expect(sessionUpdatedEvents()).toEqual([
      expect.objectContaining({ orchestrator: expect.objectContaining({ model: 'claude-sonnet-5' }) }),
    ]);
  });
});

describe('AC-11 (main): chat:set-session-orchestrator (7.4)', () => {
  it('lane COM mensagens: trocar provider = provider_locked', async () => {
    h.lanes = [lane('a', 1, CLAUDE)];
    const result = await invoke('chat:set-session-orchestrator', 'a', CODEX);
    expect(result).toMatchObject({ code: 'provider_locked' });
    expect(h.setSessionOrchestratorMock).not.toHaveBeenCalled();
  });

  it('lane VAZIA mas com turno pendente (fila) = provider_locked', async () => {
    h.lanes = [lane('a', 1, CLAUDE, { messageCount: 0 })];
    h.executionState.set('a', 'queued');
    const result = await invoke('chat:set-session-orchestrator', 'a', CODEX);
    expect(result).toMatchObject({ code: 'provider_locked' });
  });

  it('lane VAZIA e ociosa aceita outro provider (runtime+provider+modelo+effort) e emite session-updated', async () => {
    h.lanes = [lane('a', 1, CLAUDE, { messageCount: 0 })];
    const result = await invoke('chat:set-session-orchestrator', 'a', { ...CODEX, effort: 'xhigh' });
    expect(result).toEqual({
      ok: true,
      orchestrator: { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-5.4-mini', effort: 'xhigh' },
    });
    expect(sessionUpdatedEvents()).toEqual([
      expect.objectContaining({ sessionId: 'a', orchestrator: expect.objectContaining({ effort: 'xhigh' }) }),
    ]);
  });

  it('lane COM mensagens aceita modelo e effort do MESMO provider', async () => {
    h.lanes = [lane('a', 1, CLAUDE)];
    const result = await invoke('chat:set-session-orchestrator', 'a', {
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      effort: 'low',
    });
    expect(result).toMatchObject({ ok: true, orchestrator: { model: 'claude-haiku-4-5-20251001', effort: 'low' } });
  });

  it('effort ausente na selecao = referencia inicial do global quando valida; senao o default do modelo', async () => {
    h.lanes = [lane('a', 1, CLAUDE, { messageCount: 0 })];
    h.settings.orchestrator_codex_effort = 'max';
    const withGlobal = await invoke('chat:set-session-orchestrator', 'a', {
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-5.6-luna',
    });
    expect(withGlobal).toMatchObject({ ok: true, orchestrator: { effort: 'max' } });

    h.lanes = [lane('b', 2, CLAUDE, { messageCount: 0 })];
    h.settings.orchestrator_codex_effort = 'ultra';
    const clamped = await invoke('chat:set-session-orchestrator', 'b', {
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-5.2',
    });
    expect(clamped).toMatchObject({ ok: true, orchestrator: { effort: 'high' } });
  });

  it('modelo fora do provider ou effort invalido = erros tipados', async () => {
    h.lanes = [lane('a', 1, CLAUDE, { messageCount: 0 })];
    expect(
      await invoke('chat:set-session-orchestrator', 'a', {
        runtime: 'codex-sdk',
        provider: 'codex',
        model: 'claude-opus-5',
      }),
    ).toMatchObject({ code: 'model_not_in_provider' });
    expect(await invoke('chat:set-session-orchestrator', 'a', { ...CLAUDE, effort: 'xhigh' })).toMatchObject({
      code: 'effort_not_supported',
    });
  });
});

describe('AC-13 (main): chat:get-context-usage por lane (10.6)', () => {
  it('lane Claude e lane Codex abertas: janela e limiar de cada uma vem do proprio modelo', async () => {
    h.lanes = [lane('a', 1, CLAUDE), lane('b', 2, CODEX)];
    const usageA = (await invoke('chat:get-context-usage', 'a')) as Record<string, unknown>;
    const usageB = (await invoke('chat:get-context-usage', 'b')) as Record<string, unknown>;
    expect(usageA).toMatchObject({ contextTokens: 120_000, contextWindowTokens: 1_000_000, source: 'estimate' });
    expect(usageB).toMatchObject({ contextTokens: 120_000, contextWindowTokens: 400_000, source: 'estimate' });
  });

  it('lane sem orquestrador = null (RM7, sem fallback ao padrao)', async () => {
    h.lanes = [lane('a', 1, null)];
    h.settings.orchestrator_model = 'claude-opus-5';
    expect(await invoke('chat:get-context-usage', 'a')).toBeNull();
  });
});
