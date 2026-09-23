import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  rootLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('../db', () => ({
  getSetting: vi.fn(),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(),
}));

vi.mock('../codex-runtime/binary', () => ({
  isCodexAvailable: vi.fn(),
}));

vi.mock('../agent-runtime/kimi-availability', () => ({
  isKimiAvailable: vi.fn(),
}));

import { getSetting } from '../db';
import { getSecret } from '../secrets-vault';
import { isCodexAvailable } from '../codex-runtime/binary';
import { isKimiAvailable } from '../agent-runtime/kimi-availability';
import { checkProvider, listProviderStatuses, invalidateProviderStatusCache } from '../provider-availability';

const mockedGetSetting = vi.mocked(getSetting);
const mockedGetSecret = vi.mocked(getSecret);
const mockedIsCodexAvailable = vi.mocked(isCodexAvailable);
const mockedIsKimiAvailable = vi.mocked(isKimiAvailable);

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetSetting.mockImplementation(() => undefined);
  mockedGetSecret.mockResolvedValue(null);
  mockedIsCodexAvailable.mockResolvedValue({
    installed: false,
    version: null,
    authenticated: false,
    appServerSupported: false,
  });
  mockedIsKimiAvailable.mockResolvedValue({
    installed: false,
    version: null,
    authenticated: false,
    authMode: 'none',
    managedProviderVerified: false,
    modelAvailable: false,
    usable: false,
    availableModels: [],
  });
  invalidateProviderStatusCache();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('network not expected in this test');
  }) as never);
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  invalidateProviderStatusCache();
});

describe('SPEC-011: kimi-sdk availability surface (real probe)', () => {
  it('T-P1a: checkProvider(kimi-sdk, kimi) reports not-connected when the binary is missing', async () => {
    mockedIsKimiAvailable.mockResolvedValue({
      installed: false,
      version: null,
      authenticated: false,
      authMode: 'none',
      managedProviderVerified: false,
      modelAvailable: false,
      usable: false,
      availableModels: [],
    });
    const status = await checkProvider('kimi-sdk', 'kimi');
    expect(status.runtime).toBe('kimi-sdk');
    expect(status.provider).toBe('kimi');
    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/nao encontrado/i);
    expect(status.models).toBeUndefined();
  });

  it('T-P1b: reports not-connected when installed but no auth', async () => {
    mockedIsKimiAvailable.mockResolvedValue({
      installed: true,
      version: '1.2.3',
      authenticated: false,
      authMode: 'none',
      managedProviderVerified: false,
      modelAvailable: false,
      usable: false,
      availableModels: [],
    });
    const status = await checkProvider('kimi-sdk', 'kimi');
    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/nao autenticado/i);
  });

  it('T-P1c: reports connected with the model catalog under subscription login', async () => {
    mockedIsKimiAvailable.mockResolvedValue({
      installed: true,
      version: '1.2.3',
      authenticated: true,
      authMode: 'subscription',
      managedProviderVerified: true,
      modelAvailable: true,
      usable: true,
      availableModels: ['kimi-code/kimi-for-coding'],
    });
    const status = await checkProvider('kimi-sdk', 'kimi');
    expect(status.connected).toBe(true);
    expect(status.reason).toBeUndefined();
    expect(status.models?.length).toBeGreaterThan(0);
    expect(status.models?.map((m) => m.id)).toContain('kimi-code/kimi-for-coding');
  });

  it('mantem connected diagnostico quando autenticado, mas bloqueia usable sem provider/modelo', async () => {
    mockedIsKimiAvailable.mockResolvedValue({
      installed: true,
      version: '1.2.3',
      authenticated: true,
      authMode: 'subscription',
      managedProviderVerified: false,
      modelAvailable: false,
      usable: false,
      availableModels: [],
      reason: 'Provider managed nao verificado.',
    });

    const status = await checkProvider('kimi-sdk', 'kimi');

    expect(status.connected).toBe(true);
    expect(status.authenticated).toBe(true);
    expect(status.usable).toBe(false);
    expect(status.reason).toMatch(/managed nao verificado/i);
  });

  it('T-P2: listProviderStatuses includes exactly one kimi-sdk entry and drops no existing probe', async () => {
    const statuses = await listProviderStatuses();
    const kimiEntries = statuses.filter((s) => s.runtime === 'kimi-sdk');
    expect(kimiEntries).toHaveLength(1);
    expect(kimiEntries[0]?.provider).toBe('kimi');

    expect(statuses[0]?.runtime).toBe('claude-sdk');
    const runtimes = statuses.map((s) => s.runtime);
    expect(runtimes).toContain('claude-sdk');
    expect(runtimes).toContain('claude-compat-sdk');
    expect(runtimes).toContain('codex-sdk');
    expect(runtimes).toContain('lion-sdk');
    expect(runtimes).toContain('kimi-sdk');
    const lionProviders = statuses
      .filter((s) => s.runtime === 'lion-sdk')
      .map((s) => s.provider)
      .sort();
    expect(lionProviders).toEqual(['lmstudio', 'ollama', 'openai-compatible', 'vertex-ai'].sort());
  });
});
