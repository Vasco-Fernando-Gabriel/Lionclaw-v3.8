import { describe, it, expect, vi, beforeEach } from 'vitest';


vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

type ProbeCallback = (err: Error | null, stdout: string) => void;
const mockExecFile = vi.fn();
const mockSpawn = vi.fn();

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFileSync: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/lc-pnpm-runner-userdata',
  },
}));

describe('open-design/pnpm-runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('picks `pnpm` when pnpm --version responds', async () => {
    mockExecFile.mockImplementation((bin: string, _args: string[], _opts: unknown, cb: ProbeCallback) => {
      if (bin === 'pnpm') cb(null, '10.33.2\n');
      else cb(new Error('not found'), '');
    });

    const mod = await import('../open-design/pnpm-runner');
    mod.resetPnpmCache();
    const inv = await mod.ensurePnpm();
    expect(inv.kind).toBe('pnpm');
    expect(inv.bin).toBe('pnpm');
    expect(inv.prefixArgs).toEqual([]);
  });

  it('falls back to `corepack pnpm@x` when pnpm fails', async () => {
    mockExecFile.mockImplementation((bin: string, _args: string[], _opts: unknown, cb: ProbeCallback) => {
      if (bin === 'pnpm') cb(new Error('ENOENT'), '');
      else if (bin === 'corepack') cb(null, '10.33.2\n');
      else cb(new Error('not tried'), '');
    });

    const mod = await import('../open-design/pnpm-runner');
    mod.resetPnpmCache();
    const inv = await mod.ensurePnpm();
    expect(inv.kind).toBe('corepack');
    expect(inv.bin).toBe('corepack');
    expect(inv.prefixArgs[0]).toMatch(/^pnpm@/);
  });

  it('falls back to `npx -y pnpm@x` when pnpm + corepack both fail', async () => {
    mockExecFile.mockImplementation((bin: string, _args: string[], _opts: unknown, cb: ProbeCallback) => {
      if (bin === 'pnpm') cb(new Error('ENOENT'), '');
      else if (bin === 'corepack') cb(new Error('not installed'), '');
      else if (bin === 'npx') cb(null, '10.33.2\n');
      else cb(new Error('???'), '');
    });

    const mod = await import('../open-design/pnpm-runner');
    mod.resetPnpmCache();
    const inv = await mod.ensurePnpm();
    expect(inv.kind).toBe('npx');
    expect(inv.bin).toBe('npx');
    expect(inv.prefixArgs[0]).toBe('-y');
  });

  it('throws when the entire cascade fails (SPEC L1047)', async () => {
    mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: ProbeCallback) => {
      cb(new Error('ENOENT'), '');
    });

    const mod = await import('../open-design/pnpm-runner');
    mod.resetPnpmCache();
    await expect(mod.ensurePnpm()).rejects.toThrow(/cascade exhausted/);
  });

  it('caches the result and does not re-invoke probe (SPEC L1048)', async () => {
    mockExecFile.mockImplementation((bin: string, _args: string[], _opts: unknown, cb: ProbeCallback) => {
      if (bin === 'pnpm') cb(null, '10.33.2\n');
      else cb(new Error('not found'), '');
    });

    const mod = await import('../open-design/pnpm-runner');
    mod.resetPnpmCache();
    await mod.ensurePnpm();
    const callsAfterFirst = mockExecFile.mock.calls.length;

    await mod.ensurePnpm();
    expect(mockExecFile.mock.calls.length).toBe(callsAfterFirst);

    mod.resetPnpmCache();
    await mod.ensurePnpm();
    expect(mockExecFile.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('spawnPnpm throws when called before ensurePnpm (SPEC L1049)', async () => {
    const mod = await import('../open-design/pnpm-runner');
    mod.resetPnpmCache();
    expect(() => mod.spawnPnpm(['install'], { cwd: '/tmp' })).toThrow(/before ensurePnpm/);
  });

  it('spawnPnpm uses cached bin and prefixArgs to spawn', async () => {
    mockExecFile.mockImplementation((bin: string, _args: string[], _opts: unknown, cb: ProbeCallback) => {
      if (bin === 'pnpm') cb(new Error('no'), '');
      else if (bin === 'corepack') cb(null, '10.33.2\n');
      else cb(new Error('no'), '');
    });
    mockSpawn.mockReturnValue({ stdout: null, stderr: null, on: vi.fn() });

    const mod = await import('../open-design/pnpm-runner');
    mod.resetPnpmCache();
    await mod.ensurePnpm();
    mod.spawnPnpm(['install', '--frozen-lockfile'], { cwd: '/some/root' });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [calledBin, calledArgs] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(calledBin).toBe('corepack');
    expect(calledArgs[0]).toMatch(/^pnpm@/);
    expect(calledArgs.slice(-2)).toEqual(['install', '--frozen-lockfile']);
  });

  describe('ensurePnpmShimDir — no recursion when cascade picks direct pnpm', () => {
    const sourceText = (() => {
      const fs = require('fs') as typeof import('fs');
      const p = require('path') as typeof import('path');
      return fs.readFileSync(
        p.resolve(__dirname, '..', 'open-design', 'pnpm-runner.ts'),
        'utf-8',
      );
    })();

    it('source exports `findBinInPath` helper used by the shim writer', () => {
      expect(sourceText).toMatch(/function findBinInPath\(/);
    });

    it('shim writer branches on `cached.kind === \'pnpm\'` to resolve absolute path', () => {
      expect(sourceText).toMatch(/cached\.kind === 'pnpm'/);
      expect(sourceText).toMatch(/findBinInPath\(['"]pnpm['"]/);
    });

    it('shim writer NEVER builds the recursive `exec pnpm` body for the direct branch', () => {
      const directBranchMatch = sourceText.match(
        /cached\.kind === 'pnpm'[\s\S]*?cmdParts =[\s\S]*?(?=\n\s*\}\s*else)/,
      );
      expect(directBranchMatch).not.toBeNull();
      if (directBranchMatch) {
        expect(directBranchMatch[0]).toMatch(/quoted\(realPnpm\)/);
        expect(directBranchMatch[0]).not.toMatch(/quoted\(cached\.bin\)/);
      }
    });

    it('findBinInPath excludes the shim dir from PATH search', () => {
      expect(sourceText).toMatch(/excludeDir/);
      expect(sourceText).toMatch(/resolvedDir === normalizedExclude/);
    });
  });
});
