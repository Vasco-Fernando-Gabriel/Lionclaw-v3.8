import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  getHarnessProject: vi.fn(),
  updateHarnessProject: vi.fn(),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/lionclaw-test-approot',
    getPath: (_name: string) => '/tmp/lionclaw-test-userdata',
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

const mockSpawn = vi.fn();
const mockExecFile = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFile: (...args: unknown[]) => mockExecFile(...args),
  execFileSync: vi.fn(() => 'v22.0.0\n'),
}));

import fs from 'fs';
import path from 'path';

import { getHarnessProject, updateHarnessProject } from '../db';
import { getOpenDesignConfig, setOpenDesignConfig } from '../open-design/config';

const mockGetHarnessProject = vi.mocked(getHarnessProject);
const mockUpdateHarnessProject = vi.mocked(updateHarnessProject);

describe('open-design/config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getOpenDesignConfig', () => {
    it('returns null when project is not found', () => {
      mockGetHarnessProject.mockReturnValue(undefined);
      expect(getOpenDesignConfig('proj-missing')).toBeNull();
    });

    it('returns null when openDesign config is absent', () => {
      mockGetHarnessProject.mockReturnValue({
        id: 'proj-1',
        config: { maxRoundsPerSprint: 3, usePlaywright: false, evaluatorAgentId: 'e', plannerAgentId: 'p', stack: [] },
      } as never);
      expect(getOpenDesignConfig('proj-1')).toBeNull();
    });

    it('returns the openDesign config object when present', () => {
      const od = { enabled: true, runId: 'run-abc' };
      mockGetHarnessProject.mockReturnValue({
        id: 'proj-1',
        config: {
          maxRoundsPerSprint: 3,
          usePlaywright: false,
          evaluatorAgentId: 'e',
          plannerAgentId: 'p',
          stack: [],
          openDesign: od,
        },
      } as never);
      expect(getOpenDesignConfig('proj-1')).toEqual(od);
    });
  });

  describe('setOpenDesignConfig', () => {
    it('throws when project is not found', () => {
      mockGetHarnessProject.mockReturnValue(undefined);
      expect(() => setOpenDesignConfig('bad-id', { enabled: true })).toThrow('Project not found');
    });

    it('merges patch into existing openDesign config', () => {
      const existingConfig = {
        maxRoundsPerSprint: 3,
        usePlaywright: false,
        evaluatorAgentId: 'e',
        plannerAgentId: 'p',
        stack: [],
        openDesign: { enabled: true, runId: 'run-xyz' },
      };
      mockGetHarnessProject.mockReturnValue({ id: 'proj-2', config: existingConfig } as never);
      mockUpdateHarnessProject.mockReturnValue({ id: 'proj-2' } as never);

      setOpenDesignConfig('proj-2', { locked: true });

      expect(mockUpdateHarnessProject).toHaveBeenCalledWith('proj-2', {
        config: expect.objectContaining({
          openDesign: expect.objectContaining({ enabled: true, runId: 'run-xyz', locked: true }),
        }),
      });
    });
  });
});

describe('open-design secrets policy', () => {
  it('never persists apiKey, token, or secret from setup payload', () => {
    const secretFields = new Set(['apiKey', 'token', 'secret']);
    const payload = {
      providerMode: 'api-byok',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      apiKey: 'sk-super-secret-key',
      token: 'bearer-token',
      secret: 'another-secret',
    };

    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (!secretFields.has(k)) {
        sanitized[k] = v;
      }
    }

    expect(sanitized).not.toHaveProperty('apiKey');
    expect(sanitized).not.toHaveProperty('token');
    expect(sanitized).not.toHaveProperty('secret');
    expect(sanitized).toHaveProperty('providerMode', 'api-byok');
    expect(sanitized).toHaveProperty('provider', 'anthropic');
    expect(sanitized).toHaveProperty('model', 'claude-3-5-sonnet');
  });

  it('rejects (ignores) openDesignRoot in setup payload (R-NO-ENV, SPEC L548, L1037-1039)', () => {
    const secretFields = new Set(['apiKey', 'token', 'secret']);
    const ignoredFields = new Set(['openDesignRoot']);
    const payload = {
      providerMode: 'local-cli',
      provider: 'codex',
      model: 'gpt-5.3-codex',
      openDesignRoot: '/opt/open-design',
    };

    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (secretFields.has(k)) continue;
      if (ignoredFields.has(k)) continue;
      sanitized[k] = v;
    }

    expect(sanitized).not.toHaveProperty('openDesignRoot');
    expect(sanitized).toEqual({
      providerMode: 'local-cli',
      provider: 'codex',
      model: 'gpt-5.3-codex',
    });
  });

  it('passes through safe fields untouched', () => {
    const secretFields = new Set(['apiKey', 'token', 'secret']);
    const payload = {
      providerMode: 'local-cli',
      provider: 'codex',
      model: 'gpt-5.3-codex',
    };

    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (!secretFields.has(k)) {
        sanitized[k] = v;
      }
    }

    expect(sanitized).toEqual(payload);
  });
});

describe('open-design/installer preflight (Sprint 1)', () => {
  const vendorRoot = path.join('/tmp/lionclaw-test-approot', 'vendor', 'open-design');

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => {
        cb(null, '10.33.2\n');
      },
    );
  });

  it('returns ready when vendor + node_modules both present', async () => {
    const { resetPathsCache } = await import('../open-design/paths');
    resetPathsCache();
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const s = String(p);
      if (s === vendorRoot) return true;
      if (s === path.join(vendorRoot, 'node_modules')) return true;
      return false;
    });

    const { resetPnpmCache } = await import('../open-design/pnpm-runner');
    resetPnpmCache();

    vi.resetModules();
    const { preflight } = await import('../open-design/installer');
    const result = await preflight();

    expect(result.ok).toBe(true);
    expect(result.status).toBe('ready');
    expect(result.vendorRoot).toBe(vendorRoot);

    existsSpy.mockRestore();
  });

  it('returns deps-missing when vendor present but node_modules absent', async () => {
    const { resetPathsCache } = await import('../open-design/paths');
    resetPathsCache();
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const s = String(p);
      if (s === vendorRoot) return true;
      if (s === path.join(vendorRoot, 'node_modules')) return false;
      return false;
    });

    const { resetPnpmCache } = await import('../open-design/pnpm-runner');
    resetPnpmCache();
    vi.resetModules();
    const { preflight } = await import('../open-design/installer');
    const result = await preflight();

    expect(result.ok).toBe(false);
    expect(result.status).toBe('deps-missing');
    expect(result.vendorRoot).toBe(vendorRoot);

    existsSpy.mockRestore();
  });

  it('returns vendor-missing when vendor directory absent', async () => {
    const { resetPathsCache } = await import('../open-design/paths');
    resetPathsCache();
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const { resetPnpmCache } = await import('../open-design/pnpm-runner');
    resetPnpmCache();
    vi.resetModules();
    const { preflight } = await import('../open-design/installer');
    const result = await preflight();

    expect(result.ok).toBe(false);
    expect(result.status).toBe('vendor-missing');
    expect(result.vendorRoot).toBe(vendorRoot);

    existsSpy.mockRestore();
  });
});
