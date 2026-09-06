import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  getSetting: vi.fn(() => '/configured/codex'),
  existsSync: vi.fn((candidate: string) => candidate === '/configured/codex' || candidate.endsWith('/.codex/auth.json')),
  realpathSync: vi.fn((candidate: string) => candidate),
  statSync: vi.fn(() => ({ mtimeMs: 123 })),
  which: vi.fn(),
  killProcessTree: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('fs', () => ({
  default: {
    existsSync: mocks.existsSync,
    realpathSync: mocks.realpathSync,
    statSync: mocks.statSync,
  },
}));
vi.mock('os', () => ({ default: { homedir: () => '/home/test' } }));
vi.mock('which', () => ({ default: mocks.which }));
vi.mock('../../db', () => ({ getSetting: mocks.getSetting }));
vi.mock('../../kill-process-tree', () => ({
  DETACH_FOR_TREE_KILL: true,
  killProcessTree: mocks.killProcessTree,
}));

import { getCodexBinaryStatus, invalidateCodexBinaryProbe } from '../binary';

let supportsAppServer = true;

function fakeChild(args: string[]): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  queueMicrotask(() => {
    if (args[0] === '--version') {
      (child.stdout as EventEmitter).emit('data', Buffer.from('codex-cli 0.144.1\n'));
      child.exitCode = 0;
      child.emit('close', 0);
      return;
    }
    if (supportsAppServer) {
      (child.stdout as EventEmitter).emit('data', Buffer.from('Usage: codex app-server\n'));
      child.exitCode = 0;
      child.emit('close', 0);
    } else {
      (child.stderr as EventEmitter).emit('data', Buffer.from('unknown subcommand app-server\n'));
      child.exitCode = 2;
      child.emit('close', 2);
    }
  });
  return child;
}

describe('Codex binary capability probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCodexBinaryProbe();
    supportsAppServer = true;
    mocks.spawn.mockImplementation((_binary: string, args: string[]) => fakeChild(args));
    mocks.existsSync.mockImplementation(
      (candidate: string) => candidate === '/configured/codex' || candidate.endsWith('/.codex/auth.json'),
    );
  });

  it('faz single-flight e cacheia apenas capacidade estavel por realpath+mtime', async () => {
    const [first, concurrent] = await Promise.all([
      getCodexBinaryStatus(),
      getCodexBinaryStatus(),
    ]);
    expect(first).toMatchObject({
      installed: true,
      version: 'codex-cli 0.144.1',
      authenticated: true,
      appServerSupported: true,
    });
    expect(concurrent).toEqual(first);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);

    await getCodexBinaryStatus();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('rele a autenticacao a cada chamada, mesmo quando a capacidade veio do cache', async () => {
    expect((await getCodexBinaryStatus()).authenticated).toBe(true);
    mocks.existsSync.mockImplementation((candidate: string) => candidate === '/configured/codex');
    expect((await getCodexBinaryStatus()).authenticated).toBe(false);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('reporta CLI instalada sem App Server e refaz probes apos invalidacao', async () => {
    supportsAppServer = false;
    const unsupported = await getCodexBinaryStatus();
    expect(unsupported).toMatchObject({ installed: true, appServerSupported: false });
    expect(unsupported.error).toContain('unknown subcommand app-server');

    supportsAppServer = true;
    expect((await getCodexBinaryStatus()).appServerSupported).toBe(false);
    invalidateCodexBinaryProbe();
    expect((await getCodexBinaryStatus()).appServerSupported).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(4);
  });
});
