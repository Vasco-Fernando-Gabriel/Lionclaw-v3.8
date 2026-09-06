import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipcState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcState.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../db', () => ({
  getSetting: vi.fn((key: string) => key === 'grok_binary_path' ? '/opt/grok/bin/grok' : ''),
  setSetting: vi.fn(),
}));

vi.mock('../provider-availability', () => ({
  invalidateProviderStatusCache: vi.fn(),
}));

vi.mock('../agent-runtime/grok-availability', () => ({
  isGrokAvailable: vi.fn(async () => ({
    installed: true,
    version: 'grok 0.2.103',
    authenticated: true,
    authMode: 'subscription',
    subscriptionRouteVerified: true,
    isolationVerified: true,
    toolPolicyVerified: true,
    modelAvailable: true,
    usable: true,
  })),
  assertGrokChildEnv: vi.fn(),
  buildGrokChildEnv: vi.fn(() => ({
    GROK_HOME: '/tmp/lionclaw-grok',
    HOME: '/tmp/lionclaw-grok',
    PATH: '/usr/bin',
  })),
  ensureGrokHome: vi.fn(),
  resolveGrokBinary: vi.fn(async () => '/opt/grok/bin/grok'),
  resolveGrokHome: vi.fn(() => '/tmp/lionclaw-grok'),
}));

import {
  buildMacGrokLoginCommand,
  buildPosixGrokLoginArgv,
  launchLinuxGrokLoginTerminal,
  registerGrokHandlers,
} from '../ipc/grok';
import { setSetting } from '../db';
import { invalidateProviderStatusCache } from '../provider-availability';

type SpawnProcess = NonNullable<Parameters<typeof launchLinuxGrokLoginTerminal>[2]>;

function createSpawn(outcomes: Array<'spawn' | 'error'>): ReturnType<typeof vi.fn<SpawnProcess>> {
  return vi.fn<SpawnProcess>((executable) => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
    child.unref = vi.fn();
    const outcome = outcomes.shift() ?? 'error';
    queueMicrotask(() => {
      if (outcome === 'spawn') child.emit('spawn');
      else child.emit('error', new Error(`${executable} ausente`));
    });
    return child as unknown as ChildProcess;
  });
}

beforeEach(() => {
  ipcState.handlers.clear();
});

describe('grok IPC', () => {
  it('tenta os terminais Linux em sequencia e so resolve depois do evento spawn', async () => {
    const spawnProcess = createSpawn(['error', 'error', 'spawn']);

    await expect(launchLinuxGrokLoginTerminal('grok', {}, spawnProcess)).resolves.toBeUndefined();

    expect(spawnProcess.mock.calls.map(([executable]) => executable)).toEqual([
      'x-terminal-emulator',
      'gnome-terminal',
      'konsole',
    ]);
  });

  it('separa env do launcher Linux do env-i entregue ao Grok', async () => {
    const spawnProcess = createSpawn(['spawn']);
    const childEnv = {
      GROK_HOME: '/tmp/lionclaw-grok',
      HOME: '/tmp/lionclaw-grok',
      PATH: '/usr/bin',
    };
    const launcherEnv = {
      ...childEnv,
      DISPLAY: ':1',
      XAUTHORITY: '/tmp/xauthority',
      SECRET_CANARY: 'nao-pode-chegar-ao-grok',
    };

    await launchLinuxGrokLoginTerminal('/opt/grok/bin/grok', childEnv, spawnProcess, launcherEnv);

    const [, args, options] = spawnProcess.mock.calls[0]!;
    expect(args).toEqual([
      '-e',
      'env',
      '-i',
      'GROK_HOME=/tmp/lionclaw-grok',
      'HOME=/tmp/lionclaw-grok',
      'PATH=/usr/bin',
      '/opt/grok/bin/grok',
      'login',
      '--device-auth',
    ]);
    expect(options.env).toMatchObject({ DISPLAY: ':1', SECRET_CANARY: 'nao-pode-chegar-ao-grok' });
    expect(args).not.toContain('DISPLAY=:1');
    expect(args).not.toContain('SECRET_CANARY=nao-pode-chegar-ao-grok');
  });

  it('gera comando macOS com env-i e somente a allowlist do child', () => {
    const childEnv = {
      GROK_HOME: '/tmp/lion home',
      HOME: '/tmp/lion home',
      PATH: '/usr/bin',
    };
    const command = buildMacGrokLoginCommand('/opt/Grok Build/grok', childEnv);

    expect(command).toContain('env -i');
    expect(command).toContain("'GROK_HOME=/tmp/lion home'");
    expect(command).toContain("'/opt/Grok Build/grok'");
    expect(command).not.toContain('SECRET_CANARY');
  });

  it('mantem argv POSIX sem shell e sem variaveis ausentes', () => {
    expect(buildPosixGrokLoginArgv('grok', { HOME: '/tmp/home', SECRET_CANARY: undefined }))
      .toEqual(['env', '-i', 'HOME=/tmp/home', 'grok', 'login', '--device-auth']);
  });

  it('retorna erro controlado quando nenhum terminal Linux abre', async () => {
    const spawnProcess = createSpawn(['error', 'error', 'error', 'error']);

    await expect(launchLinuxGrokLoginTerminal('grok', {}, spawnProcess))
      .rejects.toThrow('Nenhum emulador de terminal conseguiu abrir o login do Grok');
    expect(spawnProcess).toHaveBeenCalledTimes(4);
  });

  it('expoe o path persistido junto do status', async () => {
    registerGrokHandlers({} as never);
    const handler = ipcState.handlers.get('grok:status');
    if (!handler) throw new Error('handler grok:status nao registrado');

    await expect(handler()).resolves.toMatchSnapshot();
  });

  it('confirma que o Grok conectado esta pronto para uso', async () => {
    registerGrokHandlers({} as never);
    const handler = ipcState.handlers.get('grok:test');
    if (!handler) throw new Error('handler grok:test nao registrado');

    await expect(handler()).resolves.toEqual(expect.objectContaining({
      ok: true,
      message: expect.stringMatching(/conectado e pronto para uso/i),
    }));
  });

  it('persiste path e invalida o cache de availability', async () => {
    registerGrokHandlers({} as never);
    const handler = ipcState.handlers.get('grok:set-binary-path');
    if (!handler) throw new Error('handler grok:set-binary-path nao registrado');

    await expect(handler({}, '  /opt/grok/new  ')).resolves.toEqual({ ok: true });
    expect(setSetting).toHaveBeenCalledWith('grok_binary_path', '/opt/grok/new');
    expect(invalidateProviderStatusCache).toHaveBeenCalled();
  });
});
