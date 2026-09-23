import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  enabled: false,
  sender: {},
  start: vi.fn(),
  abort: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => h.handlers.set(name, handler),
  },
}));
vi.mock('../db', () => ({
  getSession: (id: string) => (id === 's1' ? { id } : null),
  getDesktopActiveSessionById: (id: string) => (id === 's1' ? { id } : null),
  getChatFeatureToggles: () => ({ swarm: h.enabled }),
  getSessionActiveRepository: () => ({ repositoryId: 'repo' }),
  getLocalRepository: () => ({ rootPath: '/authorized' }),
}));
vi.mock('../swarm', () => ({ getSwarmService: () => ({ start: h.start, abort: h.abort, subscribe: h.subscribe }) }));
import { registerSwarmHandlers } from '../ipc/swarm';
describe('Swarm IPC', () => {
  beforeEach(() => {
    h.handlers.clear();
    h.enabled = false;
    vi.clearAllMocks();
    registerSwarmHandlers({ getMainWindow: () => ({ webContents: h.sender }) } as never);
  });
  it('recusa remetente externo antes de domínio e aceita remetente correto', async () => {
    const start = h.handlers.get('swarm:start')!;
    expect(await start({ sender: {} }, 's1', {})).toMatchObject({ code: 'auth-required' });
    expect(h.start).not.toHaveBeenCalled();
    await start({ sender: h.sender }, 's1', { objective: 'x' });
    expect(h.start).toHaveBeenCalledWith(
      { sessionId: 's1', swarmEnabled: false, readRoots: ['/authorized'] },
      { objective: 'x' },
    );
  });
  it('aborto permanece disponível com chip desligado e sessão inválida falha', async () => {
    await h.handlers.get('swarm:abort')!({ sender: h.sender }, 's1', 'r1');
    expect(h.abort).toHaveBeenCalledWith('s1', 'r1');
    expect(await h.handlers.get('swarm:abort')!({ sender: h.sender }, 'forged', 'r1')).toMatchObject({
      error: 'Sessão não encontrada.',
    });
  });
});
