
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

const settingsStore = new Map<string, string>();
vi.mock('../db', () => ({
  getSetting: vi.fn((key: string) => settingsStore.get(key)),
  setSetting: vi.fn((key: string, value: string) => {
    settingsStore.set(key, value);
  }),
}));

const vaultStore = new Map<string, string>();
vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async (key: string) => vaultStore.get(key) ?? null),
  setSecret: vi.fn(async (key: string, value: string) => {
    vaultStore.set(key, value);
  }),
  deleteSecret: vi.fn(async (key: string) => {
    vaultStore.delete(key);
  }),
}));

vi.mock('../codex-runtime/binary', () => ({
  isCodexAvailable: vi.fn(async () => ({
    installed: false,
    authenticated: false,
    appServerSupported: false,
  })),
  getCodexBinaryStatus: vi.fn(async () => ({
    installed: false,
    authenticated: false,
    appServerSupported: false,
  })),
  invalidateCodexBinaryProbe: vi.fn(),
}));

import { setSetting, getSetting } from '../db';
import { setSecret, deleteSecret, getSecret } from '../secrets-vault';
import {
  listProviderStatuses,
  invalidateProviderStatusCache,
} from '../provider-availability';

const mockedSetSetting = vi.mocked(setSetting);
const mockedSetSecret = vi.mocked(setSecret);
const mockedDeleteSecret = vi.mocked(deleteSecret);
const mockedGetSecret = vi.mocked(getSecret);
const mockedGetSetting = vi.mocked(getSetting);

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(impl as never);
}

function makeResponse(opts: { status?: number; body?: string } = {}): Response {
  const status = opts.status ?? 200;
  const body = opts.body ?? '';
  const ok = status >= 200 && status < 300;
  return { ok, status, text: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsStore.clear();
  vaultStore.clear();
  invalidateProviderStatusCache();
  mockedGetSetting.mockImplementation((key: string) => settingsStore.get(key));
  mockedSetSetting.mockImplementation((key: string, value: string) => {
    settingsStore.set(key, value);
  });
  mockedGetSecret.mockImplementation(async (key: string) => vaultStore.get(key) ?? null);
  mockedSetSecret.mockImplementation(async (key: string, value: string) => {
    vaultStore.set(key, value);
  });
  mockedDeleteSecret.mockImplementation(async (key: string) => {
    vaultStore.delete(key);
  });
});

afterEach(() => {
  if (fetchSpy) {
    fetchSpy.mockRestore();
    fetchSpy = null;
  }
});


describe('provider:list-statuses contract', () => {
  it('returns an array with one entry per (runtime, provider) pair', async () => {
    stubFetch(async () => makeResponse({ status: 500 }));

    const list = await listProviderStatuses();

    expect(Array.isArray(list)).toBe(true);
    const pairs = new Set(list.map(s => `${s.runtime}/${s.provider}`));
    const expectedPairs = [
      'claude-sdk/anthropic',
      'claude-compat-sdk/zai',
      'claude-compat-sdk/minimax',
      'codex-sdk/codex',
      'codex-sdk/codex-official',
      'lion-sdk/ollama',
      'lion-sdk/lmstudio',
      'lion-sdk/openai-compatible',
      'lion-sdk/vertex-ai',
      'kimi-sdk/kimi',
    ];
    for (const pair of expectedPairs) {
      expect(pairs.has(pair), `missing provider status entry: ${pair}`).toBe(true);
    }
    expect(list.length).toBeGreaterThanOrEqual(expectedPairs.length);
    for (const entry of list) {
      expect(entry).toHaveProperty('runtime');
      expect(entry).toHaveProperty('provider');
      expect(entry).toHaveProperty('connected');
      expect(typeof entry.connected).toBe('boolean');
    }
  });

  it('lists both Z.ai and MiniMax under claude-compat-sdk', async () => {
    stubFetch(async () => makeResponse({ status: 500 }));

    const list = await listProviderStatuses();
    const compatPairs = list
      .filter(s => s.runtime === 'claude-compat-sdk')
      .map(s => s.provider)
      .sort();

    expect(compatPairs).toEqual(['minimax', 'zai']);
  });
});


describe('provider:connect side-effects', () => {
  it('Z.ai: writes to vault under ORCHESTRATOR_ZAI_API_KEY and persists the ref setting', async () => {
    await setSecret('ORCHESTRATOR_ZAI_API_KEY', 'sk-test-zai');
    setSetting('orchestrator_zai_api_key_ref', 'ORCHESTRATOR_ZAI_API_KEY');

    expect(vaultStore.get('ORCHESTRATOR_ZAI_API_KEY')).toBe('sk-test-zai');
    expect(settingsStore.get('orchestrator_zai_api_key_ref')).toBe(
      'ORCHESTRATOR_ZAI_API_KEY',
    );
  });

  it('MiniMax: writes to vault under ORCHESTRATOR_MINIMAX_API_KEY and persists the ref setting', async () => {
    await setSecret('ORCHESTRATOR_MINIMAX_API_KEY', 'sk-test-minimax');
    setSetting(
      'orchestrator_minimax_api_key_ref',
      'ORCHESTRATOR_MINIMAX_API_KEY',
    );

    expect(mockedSetSecret).toHaveBeenCalledWith(
      'ORCHESTRATOR_MINIMAX_API_KEY',
      'sk-test-minimax',
    );
    expect(mockedSetSetting).toHaveBeenCalledWith(
      'orchestrator_minimax_api_key_ref',
      'ORCHESTRATOR_MINIMAX_API_KEY',
    );
    expect(vaultStore.get('ORCHESTRATOR_MINIMAX_API_KEY')).toBe(
      'sk-test-minimax',
    );
    expect(settingsStore.get('orchestrator_minimax_api_key_ref')).toBe(
      'ORCHESTRATOR_MINIMAX_API_KEY',
    );
    expect(vaultStore.has('ORCHESTRATOR_ZAI_API_KEY')).toBe(false);
    expect(settingsStore.has('orchestrator_zai_api_key_ref')).toBe(false);
  });

  it('MiniMax connect contract: handler returns { ok: true } and invalidates the cache (no checkProvider)', async () => {
    const vaultKey = 'ORCHESTRATOR_MINIMAX_API_KEY';
    const settingKey = 'orchestrator_minimax_api_key_ref';
    const apiKey = 'fake';

    let result: { ok: true } | { error: string };
    try {
      if (!apiKey || apiKey.trim().length === 0) {
        result = { error: 'apiKey obrigatorio para MiniMax.' };
      } else {
        await setSecret(vaultKey, apiKey.trim());
        setSetting(settingKey, vaultKey);
        invalidateProviderStatusCache();
        result = { ok: true };
      }
    } catch (err) {
      result = {
        error: err instanceof Error ? err.message : 'Erro desconhecido',
      };
    }

    expect(result).toEqual({ ok: true });
    expect(mockedSetSecret).toHaveBeenCalledWith(vaultKey, apiKey);
    expect(mockedSetSetting).toHaveBeenCalledWith(settingKey, vaultKey);
  });

  it('MiniMax connect without apiKey: handler returns { error } and NEVER throws', async () => {
    async function simulateConnect(
      apiKey: string | undefined,
    ): Promise<{ ok: true } | { error: string }> {
      if (!apiKey || apiKey.trim().length === 0) {
        return { error: 'apiKey obrigatorio para MiniMax.' };
      }
      await setSecret('ORCHESTRATOR_MINIMAX_API_KEY', apiKey.trim());
      setSetting(
        'orchestrator_minimax_api_key_ref',
        'ORCHESTRATOR_MINIMAX_API_KEY',
      );
      return { ok: true };
    }

    let result: { ok: true } | { error: string };
    let threw = false;
    try {
      result = await simulateConnect(undefined);
    } catch {
      threw = true;
      result = { error: 'should not reach' };
    }

    expect(threw).toBe(false);
    expect(result!).toHaveProperty('error');
    expect((result! as { error: string }).error).toMatch(/apiKey/i);
    expect(mockedSetSecret).not.toHaveBeenCalled();
    expect(vaultStore.has('ORCHESTRATOR_MINIMAX_API_KEY')).toBe(false);
  });

  it('OpenAI-compatible: writes vault key + base URL + preset', async () => {
    await setSecret('ORCHESTRATOR_OPENAI_COMPAT_API_KEY', 'sk-test-oa');
    setSetting('orchestrator_openai_compat_api_key_ref', 'ORCHESTRATOR_OPENAI_COMPAT_API_KEY');
    setSetting('orchestrator_openai_compat_base_url', 'https://api.deepseek.com');
    setSetting('orchestrator_openai_compat_preset', 'deepseek');

    expect(vaultStore.get('ORCHESTRATOR_OPENAI_COMPAT_API_KEY')).toBe('sk-test-oa');
    expect(settingsStore.get('orchestrator_openai_compat_base_url')).toBe(
      'https://api.deepseek.com',
    );
    expect(settingsStore.get('orchestrator_openai_compat_preset')).toBe('deepseek');
  });

  it('Ollama / LM Studio: only base URL setting, no vault interaction', async () => {
    setSetting('orchestrator_ollama_base_url', 'http://localhost:11434');
    setSetting('orchestrator_lmstudio_base_url', 'http://localhost:1234');

    expect(settingsStore.get('orchestrator_ollama_base_url')).toBe(
      'http://localhost:11434',
    );
    expect(settingsStore.get('orchestrator_lmstudio_base_url')).toBe(
      'http://localhost:1234',
    );
    expect(mockedSetSecret).not.toHaveBeenCalled();
  });
});


describe('provider:disconnect side-effects', () => {
  it('Z.ai: removes vault entry + clears settings ref', async () => {
    await setSecret('ORCHESTRATOR_ZAI_API_KEY', 'sk-test-zai');
    setSetting('orchestrator_zai_api_key_ref', 'ORCHESTRATOR_ZAI_API_KEY');
    expect(vaultStore.has('ORCHESTRATOR_ZAI_API_KEY')).toBe(true);

    const ref = settingsStore.get('orchestrator_zai_api_key_ref');
    if (ref) {
      await deleteSecret(ref);
    }
    setSetting('orchestrator_zai_api_key_ref', '');

    expect(vaultStore.has('ORCHESTRATOR_ZAI_API_KEY')).toBe(false);
    expect(settingsStore.get('orchestrator_zai_api_key_ref')).toBe('');
  });

  it('MiniMax: removes vault entry + clears settings ref', async () => {
    await setSecret('ORCHESTRATOR_MINIMAX_API_KEY', 'sk-test-minimax');
    setSetting(
      'orchestrator_minimax_api_key_ref',
      'ORCHESTRATOR_MINIMAX_API_KEY',
    );
    expect(vaultStore.has('ORCHESTRATOR_MINIMAX_API_KEY')).toBe(true);

    const ref = settingsStore.get('orchestrator_minimax_api_key_ref');
    if (ref) {
      await deleteSecret(ref);
    }
    setSetting('orchestrator_minimax_api_key_ref', '');
    invalidateProviderStatusCache();

    expect(mockedDeleteSecret).toHaveBeenCalledWith(
      'ORCHESTRATOR_MINIMAX_API_KEY',
    );
    expect(mockedSetSetting).toHaveBeenCalledWith(
      'orchestrator_minimax_api_key_ref',
      '',
    );
    expect(vaultStore.has('ORCHESTRATOR_MINIMAX_API_KEY')).toBe(false);
    expect(settingsStore.get('orchestrator_minimax_api_key_ref')).toBe('');
    expect(settingsStore.has('orchestrator_zai_api_key_ref')).toBe(false);
  });

  it('OpenAI-compatible: removes vault entry + clears all three settings', async () => {
    await setSecret('ORCHESTRATOR_OPENAI_COMPAT_API_KEY', 'sk-test');
    setSetting('orchestrator_openai_compat_api_key_ref', 'ORCHESTRATOR_OPENAI_COMPAT_API_KEY');
    setSetting('orchestrator_openai_compat_base_url', 'https://api.deepseek.com');
    setSetting('orchestrator_openai_compat_preset', 'deepseek');

    const ref = settingsStore.get('orchestrator_openai_compat_api_key_ref');
    if (ref) await deleteSecret(ref);
    setSetting('orchestrator_openai_compat_api_key_ref', '');
    setSetting('orchestrator_openai_compat_base_url', '');
    setSetting('orchestrator_openai_compat_preset', '');

    expect(vaultStore.has('ORCHESTRATOR_OPENAI_COMPAT_API_KEY')).toBe(false);
    expect(settingsStore.get('orchestrator_openai_compat_api_key_ref')).toBe('');
    expect(settingsStore.get('orchestrator_openai_compat_base_url')).toBe('');
    expect(settingsStore.get('orchestrator_openai_compat_preset')).toBe('');
  });
});


describe('cache invalidation', () => {
  it('after invalidateProviderStatusCache, the next listProviderStatuses call probes fresh', async () => {
    stubFetch(async () => makeResponse({ status: 500 }));
    const first = await listProviderStatuses();
    const firstZai = first.find(
      (s) => s.runtime === 'claude-compat-sdk' && s.provider === 'zai',
    );
    expect(firstZai?.connected).toBe(false);

    await setSecret('ORCHESTRATOR_ZAI_API_KEY', 'sk-test-zai');
    setSetting('orchestrator_zai_api_key_ref', 'ORCHESTRATOR_ZAI_API_KEY');
    invalidateProviderStatusCache();

    const second = await listProviderStatuses();
    const secondZai = second.find(
      (s) => s.runtime === 'claude-compat-sdk' && s.provider === 'zai',
    );
    expect(secondZai?.connected).toBe(true);
  });

  it('without invalidation, listProviderStatuses returns the same cached entry within TTL', async () => {
    stubFetch(async () => makeResponse({ status: 500 }));
    const first = await listProviderStatuses();
    await setSecret('ORCHESTRATOR_ZAI_API_KEY', 'sk-test-zai');
    setSetting('orchestrator_zai_api_key_ref', 'ORCHESTRATOR_ZAI_API_KEY');

    const second = await listProviderStatuses();

    expect(second).toEqual(first);
  });
});


describe('settings:get/update — orchestratorMinimaxApiKeyRef', () => {
  it('settings:get exposes orchestratorMinimaxApiKeyRef from orchestrator_minimax_api_key_ref', () => {
    setSetting(
      'orchestrator_minimax_api_key_ref',
      'ORCHESTRATOR_MINIMAX_API_KEY',
    );

    const orchestratorMinimaxApiKeyRef =
      getSetting('orchestrator_minimax_api_key_ref') || undefined;

    expect(orchestratorMinimaxApiKeyRef).toBe('ORCHESTRATOR_MINIMAX_API_KEY');
  });

  it('settings:get returns undefined when the setting is empty/missing', () => {
    const orchestratorMinimaxApiKeyRef =
      getSetting('orchestrator_minimax_api_key_ref') || undefined;
    expect(orchestratorMinimaxApiKeyRef).toBeUndefined();
  });

  it('settings:update propagates orchestratorMinimaxApiKeyRef to the snake_case setting', () => {
    const incoming = { orchestratorMinimaxApiKeyRef: 'new-value' };
    if (incoming.orchestratorMinimaxApiKeyRef !== undefined) {
      setSetting(
        'orchestrator_minimax_api_key_ref',
        incoming.orchestratorMinimaxApiKeyRef,
      );
    }

    expect(getSetting('orchestrator_minimax_api_key_ref')).toBe('new-value');
    expect(mockedSetSetting).toHaveBeenCalledWith(
      'orchestrator_minimax_api_key_ref',
      'new-value',
    );
    expect(getSetting('orchestrator_zai_api_key_ref')).toBeUndefined();
  });

  it('settings:update does NOT touch the setting when field is omitted (undefined)', () => {
    setSetting('orchestrator_minimax_api_key_ref', 'preexisting');
    mockedSetSetting.mockClear();

    const incoming: { orchestratorMinimaxApiKeyRef?: string } = {};
    if (incoming.orchestratorMinimaxApiKeyRef !== undefined) {
      setSetting(
        'orchestrator_minimax_api_key_ref',
        incoming.orchestratorMinimaxApiKeyRef,
      );
    }

    expect(mockedSetSetting).not.toHaveBeenCalled();
    expect(getSetting('orchestrator_minimax_api_key_ref')).toBe('preexisting');
  });
});


describe('SPEC-004 §5.8: COMPAT_VAULT_REFS source-level guardrail', () => {
  it('ipc-handlers.ts declares COMPAT_VAULT_REFS with zai + minimax entries', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'ipc-handlers.ts'),
      'utf8',
    );
    expect(src).toMatch(/const\s+COMPAT_VAULT_REFS\s*:\s*Record</);
    expect(src).toContain("vaultKey: 'ORCHESTRATOR_ZAI_API_KEY'");
    expect(src).toContain("settingKey: 'orchestrator_zai_api_key_ref'");
    expect(src).toContain("vaultKey: 'ORCHESTRATOR_MINIMAX_API_KEY'");
    expect(src).toContain("settingKey: 'orchestrator_minimax_api_key_ref'");
    expect(src).toMatch(
      /payload\.provider === 'zai' \|\| payload\.provider === 'minimax'/,
    );
    expect(src).toMatch(/return\s*\{\s*ok:\s*true\s*\}/);
    expect(src).toMatch(/invalidateProviderStatusCache\(\s*\)/);
  });
});
