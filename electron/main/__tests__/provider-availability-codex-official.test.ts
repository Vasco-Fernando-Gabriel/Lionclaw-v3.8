import { describe, it, expect, vi, beforeEach } from 'vitest';

const { isAvailableMock, isCodexAvailableMock, getSettingMock, getSecretMock } = vi.hoisted(() => ({
  isAvailableMock: vi.fn(),
  isCodexAvailableMock: vi.fn(),
  getSettingMock: vi.fn(),
  getSecretMock: vi.fn(),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../db', () => ({ getSetting: (k: string) => getSettingMock(k) }));
vi.mock('../secrets-vault', () => ({ getSecret: (r: string) => getSecretMock(r) }));
vi.mock('../codex-runtime/binary', () => ({
  isCodexAvailable: () => isCodexAvailableMock(),
}));
vi.mock('../codex-runtime/factory', () => ({
  createCodexDriver: () => ({ isAvailable: () => isAvailableMock() }),
}));

import { checkProvider, listProviderStatuses, invalidateProviderStatusCache } from '../provider-availability';

beforeEach(() => {
  vi.clearAllMocks();
  invalidateProviderStatusCache();
  isCodexAvailableMock.mockResolvedValue({
    installed: true,
    version: '1.2.3',
    authenticated: true,
    appServerSupported: true,
  });
  isAvailableMock.mockResolvedValue({
    installed: true,
    authenticated: true,
    appServerSupported: true,
    implementation: 'official-app-server',
    version: '1.2.3',
  });
  getSettingMock.mockReturnValue(undefined);
  getSecretMock.mockResolvedValue(undefined);
});

describe('probe do Codex App Server via checkProvider', () => {
  it('(a) installed + authenticated => connected codex-official on runtime codex-sdk', async () => {
    const res = await checkProvider('codex-sdk', 'codex-official');
    expect(res).toMatchObject({ runtime: 'codex-sdk', provider: 'codex-official', connected: true });
  });

  it('(b) not installed => connected:false with a reason', async () => {
    isAvailableMock.mockResolvedValueOnce({
      installed: false,
      authenticated: false,
      appServerSupported: false,
      implementation: 'official-app-server',
    });
    const res = await checkProvider('codex-sdk', 'codex-official');
    expect(res.connected).toBe(false);
    expect(res.reason).toBeTruthy();
    expect(res.reason).toContain('official-app-server');
  });

  it('installed but not authenticated => connected:false', async () => {
    isAvailableMock.mockResolvedValueOnce({
      installed: true,
      authenticated: false,
      appServerSupported: true,
      implementation: 'official-app-server',
    });
    const res = await checkProvider('codex-sdk', 'codex-official');
    expect(res.connected).toBe(false);
    expect(res.reason).toContain('not authenticated');
  });

  it('(c) checkProvider routes codex-official to the official probe (not the bridge probe)', async () => {
    await checkProvider('codex-sdk', 'codex-official');
    expect(isAvailableMock).toHaveBeenCalledTimes(1);
    expect(isCodexAvailableMock).not.toHaveBeenCalled();
  });
});

describe('checkCodexSdk', () => {
  it('(d) usa o probe canonico do binario sem construir outro driver', async () => {
    const res = await checkProvider('codex-sdk', 'codex');
    expect(res).toMatchObject({ runtime: 'codex-sdk', provider: 'codex', connected: true });
    expect(isCodexAvailableMock).toHaveBeenCalledTimes(1);
    expect(isAvailableMock).not.toHaveBeenCalled();
  });
});

describe('listProviderStatuses', () => {
  it('(e) includes BOTH a codex (bridge) and a codex-official entry', async () => {
    const statuses = await listProviderStatuses();
    const codex = statuses.filter((s) => s.runtime === 'codex-sdk' && s.provider === 'codex');
    const official = statuses.filter((s) => s.runtime === 'codex-sdk' && s.provider === 'codex-official');
    expect(codex.length).toBe(1);
    expect(official.length).toBe(1);
  });
});
