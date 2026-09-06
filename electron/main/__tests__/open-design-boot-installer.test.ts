import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';


vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const APPROOT = '/tmp/lc-boot-approot';
const USERDATA = '/tmp/lc-boot-userdata';
const VENDOR_ROOT = path.join(APPROOT, 'vendor', 'open-design');
const NODE_MODULES = path.join(VENDOR_ROOT, 'node_modules');
const SENTINEL = path.join(USERDATA, 'open-design', 'runtime', '.install', 'lionclaw-install-ok');

vi.mock('electron', () => ({
  app: {
    getAppPath: () => APPROOT,
    getPath: () => USERDATA,
  },
  BrowserWindow: class { static getAllWindows() { return []; } },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

type ProbeCallback = (err: Error | null, stdout: string) => void;
const mockExecFile = vi.fn();
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFileSync: vi.fn(),
}));

import fs from 'fs';

function makeFakeProcess(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; kill: () => boolean } {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; kill: () => boolean };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  (proc.stdout as unknown as { setEncoding: (e: string) => void }).setEncoding = () => undefined;
  (proc.stderr as unknown as { setEncoding: (e: string) => void }).setEncoding = () => undefined;
  proc.exitCode = null;
  proc.kill = () => true;
  return proc;
}

describe('open-design/boot-installer', () => {
  let existsMap: Map<string, boolean>;
  let fileContents: Map<string, string>;
  let rmSyncCalls: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    existsMap = new Map();
    fileContents = new Map();
    rmSyncCalls = [];

    mockExecFile.mockImplementation((bin: string, _args: string[], _opts: unknown, cb: ProbeCallback) => {
      if (bin === 'pnpm') cb(null, '10.33.2\n');
      else cb(new Error('ENOENT'), '');
    });

    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return existsMap.get(String(p)) === true;
    });
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as never);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
      fileContents.set(String(p), String(data));
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      existsMap.set(String(to), true);
      const content = fileContents.get(String(from));
      if (content !== undefined) fileContents.set(String(to), content);
    });
    const realReadFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, opts?: { encoding?: BufferEncoding } | BufferEncoding) => {
      const key = String(p);
      const isInterceptedPath = key === SENTINEL || key.endsWith('/pnpm-lock.yaml');
      if (!isInterceptedPath) {
        return realReadFileSync(p, opts as Parameters<typeof fs.readFileSync>[1]);
      }
      const content = fileContents.get(key);
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
      }
      const wantsString = opts === 'utf-8' || opts === 'utf8' || (typeof opts === 'object' && opts !== null && (opts.encoding === 'utf-8' || opts.encoding === 'utf8'));
      return wantsString ? content : Buffer.from(content);
    }) as typeof fs.readFileSync);
    vi.spyOn(fs, 'rmSync').mockImplementation((p) => {
      rmSyncCalls.push(String(p));
      existsMap.set(String(p), false);
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => {
      existsMap.set(String(p), false);
      fileContents.delete(String(p));
    });

    const { resetPnpmCache } = await import('../open-design/pnpm-runner');
    resetPnpmCache();
    const { resetPathsCache } = await import('../open-design/paths');
    resetPathsCache();
    const { __resetBootInstallerForTests } = await import('../open-design/boot-installer');
    __resetBootInstallerForTests();
  });

  function makeValidSentinelPayload(): string {
    return JSON.stringify({
      ts: '2026-01-01T00:00:00.000Z',
      lockfileHash: '',
      nodeModuleVersion: process.versions.modules,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ready directly when sentinel + node_modules present AND payload matches runtime (SPEC L1054)', async () => {
    existsMap.set(SENTINEL, true);
    existsMap.set(NODE_MODULES, true);
    fileContents.set(SENTINEL, makeValidSentinelPayload());

    const { ensureVendorReady } = await import('../open-design/boot-installer');
    const status = await ensureVendorReady();
    expect(status.kind).toBe('ready');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(rmSyncCalls).toHaveLength(0);
  });

  it('reinstalls when sentinel ABI does not match current Node ABI', async () => {
    existsMap.set(SENTINEL, true);
    existsMap.set(NODE_MODULES, true);
    const staleAbi = String(Number(process.versions.modules) + 1);
    fileContents.set(SENTINEL, JSON.stringify({
      ts: '2025-01-01T00:00:00.000Z',
      lockfileHash: '',
      nodeModuleVersion: staleAbi,  // != current runtime ABI -> reinstall
    }));

    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc);

    const { ensureVendorReady } = await import('../open-design/boot-installer');
    const promise = ensureVendorReady();

    await new Promise((r) => setTimeout(r, 0));
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(rmSyncCalls).toContain(NODE_MODULES);

    proc.emit('exit', 0, null);
    const status = await promise;
    expect(status.kind).toBe('ready');
  });

  it('reinstalls when lockfile hash changed after pull', async () => {
    const LOCKFILE = path.join(VENDOR_ROOT, 'pnpm-lock.yaml');
    existsMap.set(SENTINEL, true);
    existsMap.set(NODE_MODULES, true);
    existsMap.set(LOCKFILE, true);
    fileContents.set(LOCKFILE, 'lockfile-v2-content');
    fileContents.set(SENTINEL, JSON.stringify({
      ts: '2025-01-01T00:00:00.000Z',
      lockfileHash: 'deadbeef'.repeat(8),  // wrong hash — will not match real sha256
      nodeModuleVersion: process.versions.modules,
    }));

    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc);

    const { ensureVendorReady } = await import('../open-design/boot-installer');
    const promise = ensureVendorReady();

    await new Promise((r) => setTimeout(r, 0));
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(rmSyncCalls).toContain(NODE_MODULES);

    proc.emit('exit', 0, null);
    const status = await promise;
    expect(status.kind).toBe('ready');
  });

  it('reinstalls when sentinel payload is corrupt JSON', async () => {
    existsMap.set(SENTINEL, true);
    existsMap.set(NODE_MODULES, true);
    fileContents.set(SENTINEL, 'not-valid-json{{{');

    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc);

    const { ensureVendorReady } = await import('../open-design/boot-installer');
    const promise = ensureVendorReady();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    proc.emit('exit', 0, null);
    const status = await promise;
    expect(status.kind).toBe('ready');
  });

  it('reinstalls when sentinel is from legacy version without nodeModuleVersion field', async () => {
    existsMap.set(SENTINEL, true);
    existsMap.set(NODE_MODULES, true);
    fileContents.set(SENTINEL, JSON.stringify({
      ts: '2025-01-01T00:00:00.000Z',
      lockfileHash: '',
    }));

    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc);

    const { ensureVendorReady } = await import('../open-design/boot-installer');
    const promise = ensureVendorReady();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(rmSyncCalls).toContain(NODE_MODULES);

    proc.emit('exit', 0, null);
    const status = await promise;
    expect(status.kind).toBe('ready');
  });

  it('writes sentinel with current ABI and lockfile hash after successful install', async () => {
    existsMap.set(NODE_MODULES, false);
    existsMap.set(SENTINEL, false);

    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc);

    const { ensureVendorReady } = await import('../open-design/boot-installer');
    const promise = ensureVendorReady();
    await new Promise((r) => setTimeout(r, 0));
    proc.emit('exit', 0, null);
    await promise;

    const sentinelContent = fileContents.get(SENTINEL);
    expect(sentinelContent).toBeDefined();
    const parsed = JSON.parse(sentinelContent!);
    expect(parsed.nodeModuleVersion).toBe(process.versions.modules);
    expect(typeof parsed.lockfileHash).toBe('string');
    expect(typeof parsed.ts).toBe('string');
  });

  it('spawns install when sentinel missing; writes sentinel on success (SPEC L1055)', async () => {
    existsMap.set(NODE_MODULES, true);
    existsMap.set(SENTINEL, false);

    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc);

    const { ensureVendorReady } = await import('../open-design/boot-installer');
    const promise = ensureVendorReady();

    await new Promise((r) => setTimeout(r, 0));
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    proc.emit('exit', 0, null);
    const status = await promise;

    expect(status.kind).toBe('ready');
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(fs.renameSync).toHaveBeenCalled();
    const renameCall = (fs.renameSync as ReturnType<typeof vi.spyOn>).mock.calls.at(-1) as [string, string];
    expect(renameCall[1]).toBe(SENTINEL);
  });

  it('converges concurrent ensureVendorReady calls onto single spawn (SPEC L1056)', async () => {
    existsMap.set(NODE_MODULES, false);
    existsMap.set(SENTINEL, false);

    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc);

    const { ensureVendorReady } = await import('../open-design/boot-installer');
    const p1 = ensureVendorReady();
    const p2 = ensureVendorReady();

    await new Promise((r) => setTimeout(r, 0));
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    proc.emit('exit', 0, null);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.kind).toBe('ready');
    expect(r2.kind).toBe('ready');
  });

  it('marks failed when exit code != 0; does NOT write sentinel (SPEC L1057)', async () => {
    existsMap.set(NODE_MODULES, false);
    existsMap.set(SENTINEL, false);

    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc);

    const { ensureVendorReady, getBootInstallStatus } = await import('../open-design/boot-installer');
    const promise = ensureVendorReady();

    await new Promise((r) => setTimeout(r, 0));
    proc.emit('exit', 1, null);

    const status = await promise;
    expect(status.kind).toBe('failed');
    expect((fs.writeFileSync as ReturnType<typeof vi.spyOn>).mock.calls.length).toBe(0);
    expect(getBootInstallStatus().kind).toBe('failed');
  });

  it('retryBootInstall re-dispatches install after failure (SPEC L1058)', async () => {
    existsMap.set(NODE_MODULES, false);
    existsMap.set(SENTINEL, false);

    const proc1 = makeFakeProcess();
    const proc2 = makeFakeProcess();
    mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

    const mod = await import('../open-design/boot-installer');

    const first = mod.ensureVendorReady();
    await new Promise((r) => setTimeout(r, 0));
    proc1.emit('exit', 1, null);
    await first;
    expect(mod.getBootInstallStatus().kind).toBe('failed');

    const retry = mod.retryBootInstall();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    proc2.emit('exit', 0, null);
    const retryStatus = await retry;
    expect(retryStatus.kind).toBe('ready');
  });

  it('partial install (no sentinel) triggers reinstall on next ensureVendorReady (SPEC L1059)', async () => {
    existsMap.set(NODE_MODULES, true);
    existsMap.set(SENTINEL, false);

    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc);

    const { ensureVendorReady } = await import('../open-design/boot-installer');
    const promise = ensureVendorReady();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    proc.emit('exit', 0, null);
    const status = await promise;
    expect(status.kind).toBe('ready');
  });
});
