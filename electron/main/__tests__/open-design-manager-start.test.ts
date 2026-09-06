import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';


vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const APPROOT = '/tmp/lc-test-approot';
const USERDATA = '/tmp/lc-test-userdata';
const VENDOR_ROOT = `${APPROOT}/vendor/open-design`;

vi.mock('electron', () => ({
  app: {
    getAppPath: () => APPROOT,
    getPath: () => USERDATA,
  },
  BrowserWindow: class { static getAllWindows() { return []; } },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

type ProbeCallback = (err: Error | null, stdout: string) => void;
const mockExecFile = vi.fn<
  (bin: string, args: string[], options: unknown, callback: ProbeCallback) => void
>();
const mockSpawn = vi.fn<(...args: unknown[]) => unknown>();
const mockExec = vi.fn((_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
  cb(null, '', '');
});
vi.mock('child_process', () => ({
  exec: (
    command: string,
    options: unknown,
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => mockExec(command, options, callback),
  execFile: (
    bin: string,
    args: string[],
    options: unknown,
    callback: ProbeCallback,
  ) => mockExecFile(bin, args, options, callback),
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFileSync: vi.fn(),
}));

const mockGetHarnessProject = vi.fn();
const mockUpdateHarnessProject = vi.fn();
vi.mock('../db', () => ({
  getHarnessProject: (...args: unknown[]) => mockGetHarnessProject(...args),
  updateHarnessProject: (...args: unknown[]) => mockUpdateHarnessProject(...args),
}));

import fs from 'fs';

const mockFetch = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).fetch = mockFetch;

function makeFakeProcess(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; kill: (s?: string) => boolean } {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; kill: (s?: string) => boolean };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  (proc.stdout as unknown as { pipe: (target: unknown) => void }).pipe = () => undefined;
  (proc.stderr as unknown as { pipe: (target: unknown) => void }).pipe = () => undefined;
  proc.exitCode = null;
  proc.kill = () => true;
  return proc;
}

describe('open-design/manager.start (Sprint 1)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockExecFile.mockImplementation((bin: string, _args: string[], _opts: unknown, cb: ProbeCallback) => {
      if (bin === 'pnpm') cb(new Error('ENOENT'), '');
      else cb(null, '10.33.2\n');
    });
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as never);
    vi.spyOn(fs, 'createWriteStream').mockImplementation(() => ({
      end: vi.fn(),
      on: vi.fn(),
    } as never));

    const { resetPnpmCache } = await import('../open-design/pnpm-runner');
    resetPnpmCache();
    const { resetPathsCache } = await import('../open-design/paths');
    resetPathsCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('R-NO-ENV: ignores process.env.OPEN_DESIGN_ROOT, spawns with cwd=vendor (SPEC L1050)', async () => {
    process.env['OPEN_DESIGN_ROOT'] = '/tmp/should-be-ignored';
    try {
      mockGetHarnessProject.mockReturnValue({
        id: 'p',
        config: { openDesign: { enabled: true, runId: 'r1', runDir: '/tmp/rundir' } },
      });
      mockUpdateHarnessProject.mockReturnValue({ id: 'p' });

      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const proc = makeFakeProcess();
      mockSpawn.mockReturnValue(proc);

      const { start } = await import('../open-design/manager');
      void start('p');

      await new Promise((r) => setTimeout(r, 0));
      expect(mockSpawn).toHaveBeenCalled();
      const [, , opts] = mockSpawn.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }];
      expect(opts.cwd).toBe(VENDOR_ROOT);
      expect(opts.cwd).not.toBe('/tmp/should-be-ignored');
    } finally {
      delete process.env['OPEN_DESIGN_ROOT'];
    }
  });

  it('filters OD_/OPEN_DESIGN_/NEXT_ envs and injects OD_DATA_DIR (SPEC L1051)', async () => {
    process.env['OD_SIDECAR_BASE'] = 'http://leaky';
    process.env['NEXT_PORT'] = '9999';
    process.env['OPEN_DESIGN_FOO'] = 'leaky';
    process.env['PATH'] = process.env['PATH'] ?? '/usr/bin';
    try {
      mockGetHarnessProject.mockReturnValue({
        id: 'p',
        config: { openDesign: { enabled: true, runId: 'r1', runDir: '/tmp/rundir' } },
      });
      mockUpdateHarnessProject.mockReturnValue({ id: 'p' });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      const proc = makeFakeProcess();
      mockSpawn.mockReturnValue(proc);

      const { start } = await import('../open-design/manager');
      void start('p');
      await new Promise((r) => setTimeout(r, 0));

      const [, , opts] = mockSpawn.mock.calls[0] as [string, string[], { env: Record<string, string> }];
      expect(opts.env).not.toHaveProperty('OD_SIDECAR_BASE');
      expect(opts.env).not.toHaveProperty('NEXT_PORT');
      expect(opts.env).not.toHaveProperty('OPEN_DESIGN_FOO');
      expect(opts.env).toHaveProperty('PATH');
      expect(opts.env).toHaveProperty('OD_DATA_DIR');
      expect(opts.env['OD_DATA_DIR']).toContain('open-design/runtime/.od');
      expect(opts.env['OD_DATA_DIR']).toContain(USERDATA);
    } finally {
      delete process.env['OD_SIDECAR_BASE'];
      delete process.env['NEXT_PORT'];
      delete process.env['OPEN_DESIGN_FOO'];
    }
  });

  it('injects OD_EMBED_HOST=lionclaw in spawn env (Sprint 3, SPEC L951 + L1090)', async () => {
    process.env['OD_EMBED_HOST'] = 'should-be-overwritten';
    try {
      mockGetHarnessProject.mockReturnValue({
        id: 'p',
        config: { openDesign: { enabled: true, runId: 'r1', runDir: '/tmp/rundir' } },
      });
      mockUpdateHarnessProject.mockReturnValue({ id: 'p' });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      const proc = makeFakeProcess();
      mockSpawn.mockReturnValue(proc);

      const { start } = await import('../open-design/manager');
      void start('p');
      await new Promise((r) => setTimeout(r, 0));

      const [, , opts] = mockSpawn.mock.calls[0] as [string, string[], { env: Record<string, string> }];
      expect(opts.env).toHaveProperty('OD_EMBED_HOST');
      expect(opts.env['OD_EMBED_HOST']).toBe('lionclaw');
    } finally {
      delete process.env['OD_EMBED_HOST'];
    }
  });

  it('returns web UI timeout when daemon healthy but web / fails (SPEC L1052)', async () => {
    mockGetHarnessProject.mockReturnValue({
      id: 'p',
      config: { openDesign: { enabled: true, runId: 'r1', runDir: '/tmp/rundir' } },
    });
    mockUpdateHarnessProject.mockReturnValue({ id: 'p' });

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/health')) {
        return { ok: true, status: 200 };
      }
      throw new Error('ECONNREFUSED');
    });

    const proc = makeFakeProcess();
    mockSpawn.mockReturnValue(proc);

    const { start } = await import('../open-design/manager');
    const resultPromise = start('p');

    const result = await resultPromise;
    expect(result).toEqual({ error: 'web UI timeout' });
  }, 45000);

  it('persiste daemonUrl, webUrl e dataDir pela mesma costura usada no runtime empacotado', async () => {
    mockGetHarnessProject.mockReturnValue({
      id: 'p',
      config: { openDesign: { runId: 'r1', runDir: '/tmp/rundir', locked: false } },
    });
    const { persistRuntimeCoordinates } = await import('../open-design/manager');
    persistRuntimeCoordinates('p', 'http://127.0.0.1:31001', 'http://127.0.0.1:31002');
    expect(mockUpdateHarnessProject).toHaveBeenCalledWith('p', {
      config: {
        openDesign: expect.objectContaining({
          runId: 'r1',
          runDir: '/tmp/rundir',
          locked: false,
          daemonUrl: 'http://127.0.0.1:31001',
          webUrl: 'http://127.0.0.1:31002',
          dataDir: expect.stringContaining('open-design/runtime/.od'),
        }),
      },
    });
  });

  it('runtime empacotado persiste as coordenadas antes de retornar readiness', () => {
    const source = fs.readFileSync(new URL('../open-design/manager.ts', import.meta.url), 'utf8');
    const packaged = source.slice(
      source.indexOf('async function startPackagedRuntime'),
      source.indexOf('export async function start('),
    );
    expect(packaged).toMatch(
      /active = handle;\s*persistRuntimeCoordinates\(projectId, ready\.daemonUrl, ready\.webUrl\);/,
    );
    expect(packaged.indexOf('persistRuntimeCoordinates')).toBeLessThan(packaged.lastIndexOf('return { ok: true'));
  });
});
