
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcHandlers,
    submitMessageMock: vi.fn(),
    insertMessageMock: vi.fn(),
    getSettingMock: vi.fn(() => 'true'),
    getSessionMessagesMock: vi.fn(() => [] as unknown[]),
    getActiveChatSessionMock: vi.fn(() => ({ id: 'session-1' })),
    tryInterceptMock: vi.fn(() => false),
    webContentsSendMock: vi.fn(),
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
  getSessionMessages: h.getSessionMessagesMock,
  trashSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  getActiveChatSession: h.getActiveChatSessionMock,
  getDesktopActiveSessionById: vi.fn(),
  createSession: vi.fn(),
  getSetting: h.getSettingMock,
  insertMessage: h.insertMessageMock,
  getSession: vi.fn(() => ({ id: 'session-1' })),
  getChatFeatureToggles: vi.fn(() => null),
  setChatFeatureToggles: vi.fn(),
}));

vi.mock('../chat-capability-resolve', () => ({
  resolveChatCapabilitiesForTurn: vi.fn(() => ({ pipelineControl: false, dynamicWorkflows: false })),
  sanitizeChatFeatureTogglesPatch: vi.fn(),
}));

vi.mock('../orchestrator', () => ({
  submitMessage: h.submitMessageMock,
  stopCurrentQuery: vi.fn(),
  resetSdkSessionState: vi.fn(),
}));

vi.mock('../pipeline-drive-coordinator', () => ({
  getPipelineDriveCoordinator: vi.fn(() => ({
    tryInterceptChatForDrive: h.tryInterceptMock,
  })),
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
  getTelegramActiveThreadIds: vi.fn(() => []),
}));

import { registerChatHandlers } from '../ipc/chat';
import type { IpcContext } from '../ipc/context';

function fakeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: h.webContentsSendMock },
  };
}

function buildCtx(): IpcContext {
  return {
    getMainWindow: () => fakeWindow(),
  } as unknown as IpcContext;
}

async function invokeChatSend(message: string, options?: Record<string, unknown>) {
  const handler = h.ipcHandlers.get('chat:send');
  expect(handler).toBeDefined();
  return handler!({}, message, options);
}

beforeEach(() => {
  h.ipcHandlers.clear();
  h.submitMessageMock.mockClear();
  h.insertMessageMock.mockReset();
  h.webContentsSendMock.mockClear();
  h.tryInterceptMock.mockReset().mockReturnValue(false);
  h.getSettingMock.mockReset().mockReturnValue('true');
  h.getSessionMessagesMock.mockReset().mockReturnValue([]);
  registerChatHandlers(buildCtx());
});

describe('SB-10 AC-B26 — chat:send retorna { accepted } (nao mais fire-and-forget void)', () => {
  it('AC-B26: envio normal enfileira via submitMessage e retorna { accepted: true }', async () => {
    const result = await invokeChatSend('oi', { sessionId: 'session-1' });

    expect(result).toEqual({ accepted: true });
    expect(h.submitMessageMock).toHaveBeenCalledTimes(1);
    expect(h.submitMessageMock.mock.calls[0][0]).toBe('oi');
  });

  it('AC-B26: autostart de onboarding duplicado NAO enfileira e retorna { accepted: false }', async () => {
    h.getSettingMock.mockReturnValue('');
    h.getSessionMessagesMock.mockReturnValue([{ id: 1 }]);

    const result = await invokeChatSend('Ola! Vamos comecar.', { sessionId: 'session-1' });

    expect(result).toEqual({ accepted: false });
    expect(h.submitMessageMock).not.toHaveBeenCalled();
  });

  it('AC-B26: drive-intercept aceito persiste a bolha e retorna { accepted: true } sem submitMessage', async () => {
    h.tryInterceptMock.mockReturnValue(true);

    const result = await invokeChatSend('segue', { sessionId: 'session-1' });

    expect(result).toEqual({ accepted: true });
    expect(h.insertMessageMock).toHaveBeenCalledWith('session-1', 'user', 'segue');
    expect(h.submitMessageMock).not.toHaveBeenCalled();
    expect(h.webContentsSendMock).not.toHaveBeenCalled();
  });
});

describe('SB-10 AC-B27 — falha do insertMessage no drive-intercept emite {type:error}', () => {
  it('AC-B27: insertMessage que lanca emite chat:stream {type:error} via getMainWindow (nao so log)', async () => {
    h.tryInterceptMock.mockReturnValue(true);
    h.insertMessageMock.mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    const result = await invokeChatSend('segue', { sessionId: 'session-1' });

    expect(result).toEqual({ accepted: true });
    expect(h.webContentsSendMock).toHaveBeenCalledTimes(1);
    const [channel, chunk] = h.webContentsSendMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(channel).toBe('chat:stream');
    expect(chunk.type).toBe('error');
    expect(chunk.sessionId).toBe('session-1');
    expect(typeof chunk.error).toBe('string');
    expect((chunk.error as string).length).toBeGreaterThan(0);
  });
});
