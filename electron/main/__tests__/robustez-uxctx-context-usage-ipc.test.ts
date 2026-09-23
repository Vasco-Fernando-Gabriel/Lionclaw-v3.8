import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcHandlers,
    getSessionMock: vi.fn<(id: string) => unknown>(() => undefined),
    getSettingMock: vi.fn<(key: string) => string | undefined>(() => undefined),
  };
});

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
}));

vi.mock('../db', () => ({
  getAllSessions: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  trashSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getDesktopActiveSessionById: vi.fn(),
  createSession: vi.fn(),
  getSetting: (key: string) => h.getSettingMock(key),
  insertMessage: vi.fn(),
  getSession: (id: string) => h.getSessionMock(id),
  getChatFeatureToggles: vi.fn(() => null),
  setChatFeatureToggles: vi.fn(),
}));

vi.mock('../chat-capability-resolve', () => ({
  resolveChatCapabilitiesForTurn: vi.fn(() => ({ pipelineControl: false, dynamicWorkflows: false })),
  sanitizeChatFeatureTogglesPatch: vi.fn(),
}));

vi.mock('../orchestrator', () => ({
  submitMessage: vi.fn(),
  stopCurrentQuery: vi.fn(),
  resetSdkSessionState: vi.fn(),
}));

vi.mock('../pipeline-drive-coordinator', () => ({
  getPipelineDriveCoordinator: vi.fn(() => ({ tryInterceptChatForDrive: vi.fn(() => false) })),
}));

vi.mock('../codeburn-pty', () => ({
  spawnCodeburn: vi.fn(),
  writeCodeburn: vi.fn(),
  resizeCodeburn: vi.fn(),
  killCodeburn: vi.fn(),
}));

vi.mock('../permission-guard', () => ({ resolveConfirmation: vi.fn() }));
vi.mock('../ask-question', () => ({ resolveAskQuestion: vi.fn() }));

vi.mock('../ipc/_shared/chat-compaction', () => ({
  compactActiveChatSession: vi.fn(),
  clearSDKSessionFiles: vi.fn(),
}));

import { registerChatHandlers } from '../ipc/chat';
import type { IpcContext } from '../ipc/context';

function buildCtx(): IpcContext {
  return { getMainWindow: () => null } as unknown as IpcContext;
}

function invokeGetContextUsage(sessionId: string): unknown {
  const handler = h.ipcHandlers.get('chat:get-context-usage');
  expect(handler).toBeDefined();
  return handler!({}, sessionId);
}

function mockOrchestrator(model = 'claude-fable-5', provider = 'anthropic'): void {
  h.getSettingMock.mockImplementation((key) => {
    if (key === 'orchestrator_model') return model;
    if (key === 'orchestrator_provider') return provider;
    return undefined;
  });
}

beforeEach(() => {
  h.ipcHandlers.clear();
  h.getSessionMock.mockReset().mockReturnValue(undefined);
  h.getSettingMock.mockReset().mockReturnValue(undefined);
  registerChatHandlers(buildCtx());
});

describe('UX-CTX-2 (main) — chat:get-context-usage hidrata a barrinha ao abrir sessao', () => {
  it('sessao com tokens + modelo conhecido -> shape do chunk context_usage (source estimate)', () => {
    mockOrchestrator();
    h.getSessionMock.mockReturnValue({
      id: 's1',
      activeContextTokensEst: 123_456,
      orchestrator: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-fable-5' },
    });

    const result = invokeGetContextUsage('s1');

    expect(result).toEqual({
      contextTokens: 123_456,
      contextWindowTokens: 1_000_000,
      compactionThresholdPercent: 80,
      source: 'estimate',
    });
  });

  it('D5: modelo desconhecido -> null (sem barra, sem crash)', () => {
    mockOrchestrator('modelo-misterioso-9000', 'external');
    h.getSessionMock.mockReturnValue({ id: 's1', activeContextTokensEst: 5000 });

    expect(invokeGetContextUsage('s1')).toBeNull();
  });

  it('sessao sem activeContextTokensEst (ainda sem turno) -> null', () => {
    mockOrchestrator();
    h.getSessionMock.mockReturnValue({ id: 's1', activeContextTokensEst: undefined });

    expect(invokeGetContextUsage('s1')).toBeNull();
  });

  it('sessao inexistente -> null', () => {
    mockOrchestrator();
    h.getSessionMock.mockReturnValue(undefined);

    expect(invokeGetContextUsage('nao-existe')).toBeNull();
  });

  it('getSession que lanca -> null (catch, sem throw pro renderer)', () => {
    mockOrchestrator();
    h.getSessionMock.mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    expect(invokeGetContextUsage('s1')).toBeNull();
  });

  it('orchestrator_model ausente -> null (buildChatContextUsage sem modelo)', () => {
    h.getSettingMock.mockReturnValue(undefined);
    h.getSessionMock.mockReturnValue({ id: 's1', activeContextTokensEst: 5000 });

    expect(invokeGetContextUsage('s1')).toBeNull();
  });
});
