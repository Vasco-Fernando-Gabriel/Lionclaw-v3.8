import { describe, it, expect, beforeEach, vi } from 'vitest';

interface FakePty {
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  emitData: (chunk: string) => void;
  emitExit: (exitCode: number) => void;
  spawnArgs: { file: string; args: string[]; opts: Record<string, unknown> };
}

const spawned: FakePty[] = [];
let spawnShouldThrow: string | null = null;

const fakePtyModuleImpl = {
  spawn: (file: string, args: string[], opts: Record<string, unknown>) => {
    if (spawnShouldThrow) throw new Error(spawnShouldThrow);
    let dataCb: (d: string) => void = () => {};
    let exitCb: (e: { exitCode: number }) => void = () => {};
    const fake: FakePty = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      emitData: (chunk) => dataCb(chunk),
      emitExit: (exitCode) => exitCb({ exitCode }),
      spawnArgs: { file, args, opts },
    };
    spawned.push(fake);
    return {
      onData: (cb: (d: string) => void) => { dataCb = cb; return { dispose: vi.fn() }; },
      onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => { exitCb = cb; return { dispose: vi.fn() }; },
      write: fake.write,
      resize: fake.resize,
      kill: fake.kill,
    };
  },
};
const fakePtyModule = fakePtyModuleImpl as unknown as import('../terminal-pty').PtyModule;

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('electron', () => ({ BrowserWindow: class {} }));

import {
  openTerminalSession,
  writeTerminalSession,
  resizeTerminalSession,
  closeTerminalSession,
  killAllTerminalSessions,
  hasActiveTerminalSessions,
  resetTerminalPtyStateForTests,
  setPtyLoaderForTests,
  MAX_TERMINAL_SESSIONS_PER_WINDOW,
} from '../terminal-pty';
import type { BrowserWindow } from 'electron';

interface FakeWindow {
  sent: Array<{ channel: string; payload: unknown }>;
  destroyedCbs: Array<() => void>;
  navCbs: Array<() => void>;
  webContents: {
    id: number;
    send: (channel: string, payload: unknown) => void;
    once: (event: string, cb: () => void) => void;
    on: (event: string, cb: () => void) => void;
  };
  isDestroyed: () => boolean;
}

function makeWindow(id: number): FakeWindow {
  const win: FakeWindow = {
    sent: [],
    destroyedCbs: [],
    navCbs: [],
    webContents: {
      id,
      send: (channel, payload) => win.sent.push({ channel, payload }),
      once: (event, cb) => {
        if (event === 'destroyed') win.destroyedCbs.push(cb);
      },
      on: (event, cb) => {
        if (event === 'did-navigate') win.navCbs.push(cb);
      },
    },
    isDestroyed: () => false,
  };
  return win;
}

const asWindow = (w: FakeWindow) => w as unknown as BrowserWindow;

describe('terminal-pty registry', () => {
  beforeEach(() => {
    resetTerminalPtyStateForTests();
    setPtyLoaderForTests(() => fakePtyModule);
    spawned.length = 0;
    spawnShouldThrow = null;
  });

  it('happy path: abre, dados fluem para terminal:data, write/resize/close funcionam', () => {
    const win = makeWindow(1);
    const res = openTerminalSession(asWindow(win), 'tab-a', 100, 30);
    expect(res).toEqual({ ok: true });
    expect(hasActiveTerminalSessions()).toBe(true);
    expect(spawned).toHaveLength(1);

    spawned[0].emitData('hello');
    expect(win.sent).toEqual([
      { channel: 'terminal:data', payload: { sessionId: 'tab-a', chunk: 'hello' } },
    ]);

    writeTerminalSession(1, 'tab-a', 'ls\r');
    expect(spawned[0].write).toHaveBeenCalledWith('ls\r');

    resizeTerminalSession(1, 'tab-a', 120, 40);
    expect(spawned[0].resize).toHaveBeenCalledWith(120, 40);

    closeTerminalSession(1, 'tab-a');
    expect(spawned[0].kill).toHaveBeenCalledTimes(1);
    expect(hasActiveTerminalSessions()).toBe(false);
  });

  it('DN-5: spawn usa cwd home e clamp de cols/rows', () => {
    const win = makeWindow(1);
    openTerminalSession(asWindow(win), 'tab-a', 999999, -5);
    const opts = spawned[0].spawnArgs.opts;
    expect(opts.cols).toBe(1000);
    expect(opts.rows).toBe(1); // negativo -> clamp de piso
    expect(typeof opts.cwd).toBe('string');
    expect((opts.env as Record<string, string>).TERM).toBe('xterm-256color');
  });

  it('ownership: senderId de OUTRA janela nao alcanca a sessao', () => {
    const win = makeWindow(1);
    openTerminalSession(asWindow(win), 'tab-a', 80, 24);

    writeTerminalSession(2, 'tab-a', 'malicioso');
    resizeTerminalSession(2, 'tab-a', 10, 10);
    closeTerminalSession(2, 'tab-a');

    expect(spawned[0].write).not.toHaveBeenCalled();
    expect(spawned[0].resize).not.toHaveBeenCalled();
    expect(spawned[0].kill).not.toHaveBeenCalled();
    expect(hasActiveTerminalSessions()).toBe(true);
  });

  it('colisao de senderId:sessionId: retorna erro SEM matar a sessao viva', () => {
    const win = makeWindow(1);
    expect(openTerminalSession(asWindow(win), 'tab-a', 80, 24)).toEqual({ ok: true });
    const second = openTerminalSession(asWindow(win), 'tab-a', 80, 24);
    expect(second.ok).toBe(false);
    expect(spawned).toHaveLength(1); // nao spawnou outro
    expect(spawned[0].kill).not.toHaveBeenCalled();
  });

  it('mesmo sessionId em JANELAS diferentes: permitido (chave composta)', () => {
    expect(openTerminalSession(asWindow(makeWindow(1)), 'tab-a', 80, 24)).toEqual({ ok: true });
    expect(openTerminalSession(asWindow(makeWindow(2)), 'tab-a', 80, 24)).toEqual({ ok: true });
    expect(spawned).toHaveLength(2);
  });

  it('teto por janela: 9a sessao retorna erro', () => {
    const win = makeWindow(1);
    for (let i = 0; i < MAX_TERMINAL_SESSIONS_PER_WINDOW; i += 1) {
      expect(openTerminalSession(asWindow(win), `tab-${i}`, 80, 24)).toEqual({ ok: true });
    }
    const over = openTerminalSession(asWindow(win), 'tab-extra', 80, 24);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain('limite');
    expect(openTerminalSession(asWindow(makeWindow(2)), 'tab-a', 80, 24)).toEqual({ ok: true });
  });

  it('guarda de identidade: onExit ATRASADO do shell antigo nao apaga a sessao reaberta', () => {
    const win = makeWindow(1);
    openTerminalSession(asWindow(win), 'tab-a', 80, 24);
    const oldPty = spawned[0];

    oldPty.emitExit(1);
    expect(hasActiveTerminalSessions()).toBe(false);
    expect(win.sent.at(-1)).toEqual({
      channel: 'terminal:exit',
      payload: { sessionId: 'tab-a', exitCode: 1 },
    });

    expect(openTerminalSession(asWindow(win), 'tab-a', 80, 24)).toEqual({ ok: true });
    expect(hasActiveTerminalSessions()).toBe(true);

    oldPty.emitExit(1);
    expect(hasActiveTerminalSessions()).toBe(true);
    writeTerminalSession(1, 'tab-a', 'ainda-viva');
    expect(spawned[1].write).toHaveBeenCalledWith('ainda-viva');
  });

  it('janela destruida: mata todas as sessoes daquele sender (e so daquele)', () => {
    const win1 = makeWindow(1);
    const win2 = makeWindow(2);
    openTerminalSession(asWindow(win1), 'tab-a', 80, 24);
    openTerminalSession(asWindow(win1), 'tab-b', 80, 24);
    openTerminalSession(asWindow(win2), 'tab-a', 80, 24);

    for (const cb of win1.destroyedCbs) cb();

    expect(spawned[0].kill).toHaveBeenCalled();
    expect(spawned[1].kill).toHaveBeenCalled();
    expect(spawned[2].kill).not.toHaveBeenCalled();
    expect(hasActiveTerminalSessions()).toBe(true); // win2 segue viva
  });

  it('close explicito NAO emite terminal:exit (teardown silencioso)', () => {
    const win = makeWindow(1);
    openTerminalSession(asWindow(win), 'tab-a', 80, 24);

    closeTerminalSession(1, 'tab-a');
    spawned[0].emitExit(1);

    expect(win.sent.filter((m) => m.channel === 'terminal:exit')).toEqual([]);
    openTerminalSession(asWindow(win), 'tab-b', 80, 24);
    spawned[1].emitExit(0);
    expect(win.sent.at(-1)).toEqual({
      channel: 'terminal:exit',
      payload: { sessionId: 'tab-b', exitCode: 0 },
    });
  });

  it('reload do renderer (did-navigate): mata as sessoes orfas do sender', () => {
    const win = makeWindow(1);
    openTerminalSession(asWindow(win), 'tab-a', 80, 24);
    openTerminalSession(asWindow(win), 'tab-b', 80, 24);
    expect(hasActiveTerminalSessions()).toBe(true);

    for (const cb of win.navCbs) cb();

    expect(spawned[0].kill).toHaveBeenCalled();
    expect(spawned[1].kill).toHaveBeenCalled();
    expect(hasActiveTerminalSessions()).toBe(false);
    expect(openTerminalSession(asWindow(win), 'tab-a', 80, 24)).toEqual({ ok: true });
  });

  it('killAllTerminalSessions: sincrono, mata tudo (seams de quit)', () => {
    openTerminalSession(asWindow(makeWindow(1)), 'tab-a', 80, 24);
    openTerminalSession(asWindow(makeWindow(2)), 'tab-a', 80, 24);
    killAllTerminalSessions();
    expect(spawned[0].kill).toHaveBeenCalled();
    expect(spawned[1].kill).toHaveBeenCalled();
    expect(hasActiveTerminalSessions()).toBe(false);
  });

  it('spawn que lanca (shell ausente): erro amigavel, sem sessao fantasma', () => {
    spawnShouldThrow = 'posix_spawn failed';
    const res = openTerminalSession(asWindow(makeWindow(1)), 'tab-a', 80, 24);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('falha ao iniciar o shell');
    expect(hasActiveTerminalSessions()).toBe(false);
  });

  it('node-pty que nao carrega (ABI): erro amigavel com dica de rebuild', () => {
    setPtyLoaderForTests(() => {
      throw new Error('was compiled against a different Node.js ABI');
    });
    const res = openTerminalSession(asWindow(makeWindow(1)), 'tab-a', 80, 24);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('node-pty nao carregou');
    expect(hasActiveTerminalSessions()).toBe(false);
  });

  it('sessionId vazio: rejeitado', () => {
    const res = openTerminalSession(asWindow(makeWindow(1)), '   ', 80, 24);
    expect(res.ok).toBe(false);
  });
});
