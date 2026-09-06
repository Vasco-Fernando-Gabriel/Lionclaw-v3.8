
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const bridge = vi.hoisted(() => ({
  getCodexBinaryStatus: vi.fn(async () => ({
    installed: true,
    version: '0.144.1',
    authenticated: true,
    appServerSupported: true,
    binaryPath: '/usr/local/bin/codex',
  })),
  isCodexAvailable: vi.fn(async () => ({ installed: true, authenticated: true })),
  CodexUnavailableError: class CodexUnavailableError extends Error {},
  CodexAuthError: class CodexAuthError extends Error {},
}));
vi.mock('../codex-runtime/binary', () => ({
  getCodexBinaryStatus: bridge.getCodexBinaryStatus,
  isCodexAvailable: bridge.isCodexAvailable,
}));
vi.mock('../codex-runtime/errors', () => ({
  CodexUnavailableError: bridge.CodexUnavailableError,
  CodexAuthError: bridge.CodexAuthError,
}));

vi.mock('../codex-runtime/windows-preflight', () => ({
  runOfficialPreFlight: vi.fn(() => ({ status: 'not-windows' })),
  resetOfficialPreparedRepos: vi.fn(),
}));

vi.mock('../app-version', () => ({ getAppVersion: () => '9.9.9' }));

const spawned = vi.hoisted(() => ({
  calls: [] as Array<{ binary: string; args: string[] }>,
}));
vi.mock('child_process', () => ({
  spawn: vi.fn((binary: string, args: string[]) => {
    spawned.calls.push({ binary, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  }),
}));

import {
  OfficialAppServerDriver,
  defaultTransportFactory,
  type AppServerTransport,
  type AppServerSpawnConfig,
} from '../codex-runtime/official-app-server-driver';
import type { CodexRunOptions } from '../codex-runtime/types';

const EXTRAS = ['-c', 'mcp_servers.drive.enabled=false', '-c', 'mcp_servers.lionclaw-gateway.enabled=true'];

function makeOpts(over: Partial<CodexRunOptions> = {}): CodexRunOptions {
  return {
    key: { surface: 'chat', ownerKind: 'chat', mcpProfile: 'chat', runId: 'run-1' },
    model: 'gpt-5.5',
    cwd: '/tmp/project',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    ...over,
  };
}

function fakeTransport(): AppServerTransport {
  return {
    request: async () => ({}),
    notify: () => undefined,
    onNotification: () => () => undefined,
    onError: () => () => undefined,
    kill: () => undefined,
    waitClosed: async () => true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  spawned.calls.length = 0;
});

describe('createRun -> AppServerSpawnConfig.extraArgs', () => {
  it('extraArgs do run atravessam para o spawn config do transport factory', async () => {
    const seen: AppServerSpawnConfig[] = [];
    const driver = new OfficialAppServerDriver(async (config) => {
      seen.push(config);
      return fakeTransport();
    });
    await driver.createRun(makeOpts({ extraArgs: EXTRAS }));
    expect(seen).toHaveLength(1);
    expect(seen[0].extraArgs).toEqual(EXTRAS);
    await driver.shutdown();
  });

  it('sem extraArgs: spawn config segue com undefined (parity)', async () => {
    const seen: AppServerSpawnConfig[] = [];
    const driver = new OfficialAppServerDriver(async (config) => {
      seen.push(config);
      return fakeTransport();
    });
    await driver.createRun(makeOpts());
    expect(seen[0].extraArgs).toBeUndefined();
    await driver.shutdown();
  });
});

describe('defaultTransportFactory -> argv do app-server', () => {
  it('override de rede incondicional PRIMEIRO, extras estruturais depois', async () => {
    await defaultTransportFactory({
      binary: '/usr/local/bin/codex',
      cwd: '/tmp/project',
      extraArgs: EXTRAS,
    });
    expect(spawned.calls).toHaveLength(1);
    expect(spawned.calls[0].args).toEqual([
      'app-server',
      '-c',
      'sandbox_workspace_write.network_access=true',
      ...EXTRAS,
    ]);
  });

  it('sem extras: argv byte-identico ao atual (AC-C5)', async () => {
    await defaultTransportFactory({ binary: '/usr/local/bin/codex', cwd: '/tmp/project' });
    expect(spawned.calls[0].args).toEqual([
      'app-server',
      '-c',
      'sandbox_workspace_write.network_access=true',
    ]);
  });
});
