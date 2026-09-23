import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IpcContext } from '../ipc/context';

const ipcRegistry = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcRegistry.handlers.set(channel, fn);
    },
  },
  clipboard: { writeText: vi.fn() },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('../open-design/webview', () => ({
  setODViewBounds: vi.fn(),
  showODView: vi.fn(),
  hideODView: vi.fn(),
}));
vi.mock('../pricing', () => ({ pricingCalculate: vi.fn(() => ({ costUsd: 0 })) }));

const isDriveStartPendingMock = vi.fn<(id: string) => boolean>(() => false);
vi.mock('../open-design/drive-autostart', () => ({
  isDriveStartPending: (id: string) => isDriveStartPendingMock(id),
}));

const isDriveEngagedMock = vi.fn<(id: string) => boolean>(() => false);
vi.mock('../db', () => ({
  isDriveEngaged: (id: string) => isDriveEngagedMock(id),
}));

const ensureSessionMock = vi.fn(async (_id: string): Promise<Record<string, unknown>> => ({
  openDesignProjectId: 'od-1',
  conversationId: 'conv-9',
  webUrl: 'http://127.0.0.1:4810/projects/od-1',
  initialPromptHash: 'h',
  initialPromptSentAt: 't',
  bootstrappedAt: 't',
}));
vi.mock('../open-design/bootstrap', () => ({
  ensureSession: (id: string) => ensureSessionMock(id),
}));

import { registerOpenDesignHandlers } from '../ipc/open-design';

const ctx: IpcContext = {
  getMainWindow: () => null,
  getHarnessEngine: () => null,
  getPipelineEngine: () => null,
};
const PROJECT_ID = 'proj_dev_v2';

function handlerFor(channel: string) {
  const fn = ipcRegistry.handlers.get(channel);
  if (!fn) throw new Error(`${channel} nao registrado`);
  return fn;
}

beforeEach(() => {
  vi.clearAllMocks();
  ipcRegistry.handlers.clear();
  isDriveStartPendingMock.mockReturnValue(false);
  isDriveEngagedMock.mockReturnValue(false);
  registerOpenDesignHandlers(ctx);
});

describe('open-design:ensure-session - gate blocked revertido (A2)', () => {
  it('A2: drive engajado + start pendente -> ensureSession roda, NUNCA { blocked }', async () => {
    isDriveStartPendingMock.mockReturnValue(true);
    isDriveEngagedMock.mockReturnValue(true);

    const res = await handlerFor('open-design:ensure-session')({}, PROJECT_ID);

    expect(ensureSessionMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(res).toMatchObject({ conversationId: 'conv-9' });
    expect(res).not.toHaveProperty('blocked');
  });

  it('fluxo humano SEM drive -> ensureSession direto, nunca blocked', async () => {
    isDriveStartPendingMock.mockReturnValue(false);
    isDriveEngagedMock.mockReturnValue(false);

    const res = await handlerFor('open-design:ensure-session')({}, PROJECT_ID);

    expect(ensureSessionMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(res).not.toHaveProperty('blocked');
  });

  it('erro do ensureSession -> { error } sem throw (convencao da casa)', async () => {
    ensureSessionMock.mockRejectedValueOnce(new Error('daemon indisponivel'));

    const res = await handlerFor('open-design:ensure-session')({}, PROJECT_ID);

    expect(res).toMatchObject({ error: expect.stringContaining('daemon indisponivel') });
  });
});

describe('open-design:get-start-status - predicados canonicos do main (A2-bis)', () => {
  it('A-AC3b: drive engajado + start pendente -> { driveEngaged: true, startPending: true }', async () => {
    isDriveEngagedMock.mockReturnValue(true);
    isDriveStartPendingMock.mockReturnValue(true);

    const res = await handlerFor('open-design:get-start-status')({}, PROJECT_ID);

    expect(res).toEqual({ driveEngaged: true, startPending: true });
    expect(isDriveEngagedMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(isDriveStartPendingMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(Object.keys(res as object).sort()).toEqual(['driveEngaged', 'startPending']);
  });

  it('A-AC7: fora de drive -> { driveEngaged: false, startPending: false } (auto-inicio do renderer)', async () => {
    isDriveEngagedMock.mockReturnValue(false);
    isDriveStartPendingMock.mockReturnValue(false);

    const res = await handlerFor('open-design:get-start-status')({}, PROJECT_ID);

    expect(res).toEqual({ driveEngaged: false, startPending: false });
  });

  it('A-AC7b: drive engajado mas start ja dado -> { driveEngaged: true, startPending: false }', async () => {
    isDriveEngagedMock.mockReturnValue(true);
    isDriveStartPendingMock.mockReturnValue(false);

    const res = await handlerFor('open-design:get-start-status')({}, PROJECT_ID);

    expect(res).toEqual({ driveEngaged: true, startPending: false });
  });

  it('falha defensiva (import/predicado lanca) -> trata como fora de drive', async () => {
    isDriveEngagedMock.mockImplementation(() => {
      throw new Error('db indisponivel');
    });

    const res = await handlerFor('open-design:get-start-status')({}, PROJECT_ID);

    expect(res).toEqual({ driveEngaged: false, startPending: false });
  });
});
