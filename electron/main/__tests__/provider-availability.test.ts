
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
  isKimiAvailable: vi.fn(async () => ({
    installed: false,
    version: null,
    authenticated: false,
    authMode: 'none' as const,
  })),
}));

import { getSetting } from '../db';
import { getSecret } from '../secrets-vault';
import { isCodexAvailable } from '../codex-runtime/binary';
import {
  checkProvider,
  listProviderStatuses,
  invalidateProviderStatusCache,
  normalizeBaseUrl,
  probeOpenAiCompatibleModels,
} from '../provider-availability';
import { CLAUDE_MODELS } from '../../../src/constants/claude-models';
import { CODEX_MODELS } from '../../../src/constants/codex-models';
import { CLAUDE_COMPAT_PRESETS } from '../../../src/constants/claude-compat-presets';

const mockedGetSetting = vi.mocked(getSetting);
const mockedGetSecret = vi.mocked(getSecret);
const mockedIsCodexAvailable = vi.mocked(isCodexAvailable);

function setSettings(map: Record<string, string | undefined>) {
  mockedGetSetting.mockImplementation((key: string) => map[key]);
}

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(impl as never);
}

function makeResponse(opts: { status?: number; body?: string; ok?: boolean } = {}): Response {
  const status = opts.status ?? 200;
  const body = opts.body ?? '';
  const ok = opts.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    text: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateProviderStatusCache();
  mockedGetSecret.mockResolvedValue(null);
  mockedGetSetting.mockReturnValue(undefined);
});

afterEach(() => {
  if (fetchSpy) {
    fetchSpy.mockRestore();
    fetchSpy = null;
  }
});


describe('normalizeBaseUrl', () => {
  it('strips a trailing /v1', () => {
    expect(normalizeBaseUrl('http://localhost:1234/v1')).toBe('http://localhost:1234');
  });

  it('strips a trailing /v1/', () => {
    expect(normalizeBaseUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234');
  });

  it('leaves URLs without a trailing /v1 alone', () => {
    expect(normalizeBaseUrl('http://localhost:1234')).toBe('http://localhost:1234');
    expect(normalizeBaseUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com');
  });

  it('does not strip an internal /v1 segment', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/extra')).toBe('https://api.example.com/v1/extra');
  });
});


describe('checkProvider: claude-sdk / anthropic', () => {
  it('returns connected=true with CLAUDE_MODELS and never probes the network', async () => {
    stubFetch(async () => makeResponse({ status: 500 }));

    const status = await checkProvider('claude-sdk', 'anthropic');

    expect(status).toMatchObject({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      connected: true,
    });
    expect(status.models).toEqual(
      CLAUDE_MODELS.map(m => ({ id: m.id, displayName: m.displayName })),
    );
    expect(fetchSpy?.mock.calls.length ?? 0).toBe(0);
    expect(mockedGetSecret).not.toHaveBeenCalled();
  });
});


describe('checkProvider: claude-compat-sdk / zai', () => {
  it('returns connected=true with curated models when the vault key is present (no HTTP probe)', async () => {
    setSettings({ orchestrator_zai_api_key_ref: 'ZAI_KEY' });
    mockedGetSecret.mockResolvedValueOnce('sk-zai-xyz');
    stubFetch(async () => makeResponse({ status: 500 }));

    const status = await checkProvider('claude-compat-sdk', 'zai');

    expect(status).toMatchObject({
      runtime: 'claude-compat-sdk',
      provider: 'zai',
      connected: true,
    });
    const zaiPreset = CLAUDE_COMPAT_PRESETS.find(p => p.id === 'zai');
    expect(status.models).toEqual(
      (zaiPreset?.models ?? []).map(m => ({ id: m.id, displayName: m.displayName })),
    );
    expect(fetchSpy?.mock.calls.length ?? 0).toBe(0);
  });

  it('returns connected=false when the vault key ref is unset', async () => {
    setSettings({});
    stubFetch(async () => makeResponse({ status: 500 }));

    const status = await checkProvider('claude-compat-sdk', 'zai');

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/not configured/i);
    expect(mockedGetSecret).not.toHaveBeenCalled();
    expect(fetchSpy?.mock.calls.length ?? 0).toBe(0);
  });

  it('returns connected=false when the vault has no value for the ref', async () => {
    setSettings({ orchestrator_zai_api_key_ref: 'ZAI_KEY' });
    mockedGetSecret.mockResolvedValueOnce(null);
    stubFetch(async () => makeResponse({ status: 500 }));

    const status = await checkProvider('claude-compat-sdk', 'zai');

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/missing from vault/i);
    expect(fetchSpy?.mock.calls.length ?? 0).toBe(0);
  });
});


describe('checkProvider: cursor-sdk / cursor', () => {
  it('returns connected=true with the G6 catalog when CURSOR_API_KEY is in the vault (no HTTP probe)', async () => {
    mockedGetSecret.mockImplementation(async (key: string) =>
      key === 'CURSOR_API_KEY' ? 'key_abc' : null,
    );
    stubFetch(async () => makeResponse({ status: 500 }));

    const status = await checkProvider('cursor-sdk', 'cursor');

    expect(status).toMatchObject({
      runtime: 'cursor-sdk',
      provider: 'cursor',
      connected: true,
    });
    expect(status.models?.map(m => m.id)).toContain('composer-2.5');
    expect(status.models?.every(m => typeof m.contextWindow === 'number')).toBe(true);
    expect(fetchSpy?.mock.calls.length ?? 0).toBe(0);
  });

  it('returns connected=false with the catalog when the vault has no CURSOR_API_KEY', async () => {
    stubFetch(async () => makeResponse({ status: 500 }));

    const status = await checkProvider('cursor-sdk', 'cursor');

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/missing from vault/i);
    expect(status.models?.length ?? 0).toBeGreaterThan(0);
    expect(fetchSpy?.mock.calls.length ?? 0).toBe(0);
  });
});


describe('checkProvider: claude-compat-sdk / minimax', () => {
  it('returns connected=false with curated models when the vault setting is unset', async () => {
    setSettings({});
    stubFetch(async () => makeResponse({ status: 500 }));

    const status = await checkProvider('claude-compat-sdk', 'minimax');

    expect(status.runtime).toBe('claude-compat-sdk');
    expect(status.provider).toBe('minimax');
    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/not configured/i);
    const minimax = CLAUDE_COMPAT_PRESETS.find(p => p.id === 'minimax');
    expect(status.models?.length).toBe(minimax?.models.length);
    expect(status.models?.length).toBe(5);
    expect(fetchSpy?.mock.calls.length ?? 0).toBe(0);
    expect(mockedGetSecret).not.toHaveBeenCalled();
  });

  it('returns connected=true with the 5 MiniMax models when vault has the key', async () => {
    setSettings({ orchestrator_minimax_api_key_ref: 'ORCHESTRATOR_MINIMAX_API_KEY' });
    mockedGetSecret.mockResolvedValueOnce('mx-fake-token');
    stubFetch(async () => makeResponse({ status: 500 }));

    const status = await checkProvider('claude-compat-sdk', 'minimax');

    expect(status.runtime).toBe('claude-compat-sdk');
    expect(status.provider).toBe('minimax');
    expect(status.connected).toBe(true);
    expect(status.models?.length).toBe(5);
    const ids = (status.models ?? []).map(m => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'MiniMax-M2.7',
        'MiniMax-M2.7-highspeed',
        'MiniMax-M2.5',
        'MiniMax-M2.5-highspeed',
        'MiniMax-M3',
      ]),
    );
    expect(fetchSpy?.mock.calls.length ?? 0).toBe(0);
  });

  it('returns connected=false when the vault has no value for the ref', async () => {
    setSettings({ orchestrator_minimax_api_key_ref: 'ORCHESTRATOR_MINIMAX_API_KEY' });
    mockedGetSecret.mockResolvedValueOnce(null);
    stubFetch(async () => makeResponse({ status: 500 }));

    const status = await checkProvider('claude-compat-sdk', 'minimax');

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/missing from vault/i);
    expect(fetchSpy?.mock.calls.length ?? 0).toBe(0);
  });
});


describe('checkProvider: codex-sdk / codex', () => {
  it('returns connected=true with CODEX_MODELS when isCodexAvailable reports installed + authenticated', async () => {
    mockedIsCodexAvailable.mockResolvedValueOnce({
      installed: true,
      version: '0.1.0',
      authenticated: true,
      appServerSupported: true,
    });

    const status = await checkProvider('codex-sdk', 'codex');

    expect(status).toMatchObject({
      runtime: 'codex-sdk',
      provider: 'codex',
      connected: true,
    });
    expect(status.models).toEqual(
      CODEX_MODELS.map(m => ({ id: m.slug, displayName: m.label })),
    );
  });

  it('returns connected=false when the codex binary is not installed', async () => {
    mockedIsCodexAvailable.mockResolvedValueOnce({
      installed: false,
      version: null,
      authenticated: false,
      appServerSupported: false,
    });

    const status = await checkProvider('codex-sdk', 'codex');

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/binary not found/i);
  });

  it('returns connected=false when the codex binary is installed but not authenticated', async () => {
    mockedIsCodexAvailable.mockResolvedValueOnce({
      installed: true,
      version: '0.1.0',
      authenticated: false,
      appServerSupported: true,
    });

    const status = await checkProvider('codex-sdk', 'codex');

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/not authenticated/i);
  });

  it('returns connected=false when isCodexAvailable throws', async () => {
    mockedIsCodexAvailable.mockRejectedValueOnce(new Error('spawn failed'));

    const status = await checkProvider('codex-sdk', 'codex');

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/spawn failed/);
  });
});


describe('checkProvider: lion-sdk / ollama', () => {
  it('returns connected=true when GET {base}/api/tags returns 200', async () => {
    setSettings({ orchestrator_ollama_base_url: 'http://localhost:11434' });
    const body = JSON.stringify({
      models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }],
    });
    stubFetch(async (url) => {
      expect(url).toBe('http://localhost:11434/api/tags');
      return makeResponse({ status: 200, body });
    });

    const status = await checkProvider('lion-sdk', 'ollama');

    expect(status.connected).toBe(true);
    expect(status.runtime).toBe('lion-sdk');
    expect(status.provider).toBe('ollama');
    expect(status.models).toEqual([
      { id: 'llama3.1:8b', displayName: 'llama3.1:8b' },
      { id: 'qwen2.5:7b', displayName: 'qwen2.5:7b' },
    ]);
  });

  it('returns connected=false on a network error', async () => {
    setSettings({ orchestrator_ollama_base_url: 'http://localhost:11434' });
    stubFetch(async () => {
      throw new Error('ECONNREFUSED');
    });

    const status = await checkProvider('lion-sdk', 'ollama');

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/ECONNREFUSED/);
  });

  it('returns connected=false on a non-2xx response', async () => {
    setSettings({ orchestrator_ollama_base_url: 'http://localhost:11434' });
    stubFetch(async () => makeResponse({ status: 503 }));

    const status = await checkProvider('lion-sdk', 'ollama');

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/HTTP 503/);
  });

  it('returns connected=false when the base URL is unset', async () => {
    setSettings({});
    stubFetch(async () => makeResponse({ status: 200 }));

    const status = await checkProvider('lion-sdk', 'ollama');

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/not configured/i);
    expect(fetchSpy?.mock.calls.length ?? 0).toBe(0);
  });

  it('normalizes a trailing /v1 in the base URL before probing', async () => {
    setSettings({ orchestrator_ollama_base_url: 'http://localhost:11434/v1' });
    let calledUrl = '';
    stubFetch(async (url) => {
      calledUrl = url;
      return makeResponse({ status: 200, body: '{"models":[]}' });
    });

    await checkProvider('lion-sdk', 'ollama');

    expect(calledUrl).toBe('http://localhost:11434/api/tags');
  });
});


describe('checkProvider: lion-sdk / lmstudio', () => {
  it('returns connected=true and enriches context when LM Studio reports it', async () => {
    setSettings({ orchestrator_lmstudio_base_url: 'http://localhost:1234' });
    const openAiBody = JSON.stringify({
      data: [{ id: 'qwen2.5-coder' }, { id: 'llama3.1-8b' }],
    });
    const nativeBody = JSON.stringify({
      models: [
        {
          type: 'llm',
          key: 'qwen2.5-coder',
          display_name: 'Qwen Coder',
          max_context_length: 131072,
          loaded_instances: [
            {
              id: 'qwen2.5-coder',
              config: { context_length: 65536 },
            },
          ],
        },
        {
          type: 'llm',
          key: 'llama3.1-8b',
          display_name: 'Llama 3.1 8B',
          max_context_length: 131072,
          loaded_instances: [],
        },
      ],
    });
    const calls: string[] = [];
    stubFetch(async (url) => {
      calls.push(String(url));
      if (url === 'http://localhost:1234/api/v1/models') {
        return makeResponse({ status: 200, body: nativeBody });
      }
      return makeResponse({ status: 200, body: openAiBody });
    });

    const status = await checkProvider('lion-sdk', 'lmstudio');

    expect(status.connected).toBe(true);
    expect(calls).toEqual([
      'http://localhost:1234/v1/models',
      'http://localhost:1234/api/v1/models',
    ]);
    expect(status.models).toEqual([
      { id: 'qwen2.5-coder', displayName: 'qwen2.5-coder', contextWindow: 65536 },
      { id: 'llama3.1-8b', displayName: 'llama3.1-8b', contextWindow: 131072 },
    ]);
  });

  it('returns connected=false on a network error', async () => {
    setSettings({ orchestrator_lmstudio_base_url: 'http://localhost:1234' });
    stubFetch(async () => {
      throw new Error('fetch failed');
    });

    const status = await checkProvider('lion-sdk', 'lmstudio');

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/fetch failed/);
  });

  it('returns connected=false on a non-2xx response', async () => {
    setSettings({ orchestrator_lmstudio_base_url: 'http://localhost:1234' });
    stubFetch(async () => makeResponse({ status: 404 }));

    const status = await checkProvider('lion-sdk', 'lmstudio');

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/HTTP 404/);
  });

  it('normalizes a trailing /v1/ before probing', async () => {
    setSettings({ orchestrator_lmstudio_base_url: 'http://localhost:1234/v1/' });
    const calls: string[] = [];
    stubFetch(async (url) => {
      calls.push(String(url));
      return makeResponse({ status: 200, body: '{"data":[]}' });
    });

    await checkProvider('lion-sdk', 'lmstudio');

    expect(calls[0]).toBe('http://localhost:1234/v1/models');
    expect(calls[1]).toBe('http://localhost:1234/api/v1/models');
  });
});


describe('checkProvider: lion-sdk / openai-compatible', () => {
  it('returns connected=true when vault key present AND GET {base}/v1/models with Bearer returns 200', async () => {
    setSettings({
      orchestrator_openai_compat_base_url: 'https://api.deepseek.com',
      orchestrator_openai_compat_api_key_ref: 'DEEPSEEK_KEY',
      orchestrator_openai_compat_preset: 'deepseek',
    });
    mockedGetSecret.mockResolvedValueOnce('sk-deepseek-xyz');
    const body = JSON.stringify({
      data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
    });
    let calledUrl = '';
    let calledHeaders: Record<string, string> | undefined;
    stubFetch(async (url, init) => {
      calledUrl = url;
      calledHeaders = init?.headers as Record<string, string> | undefined;
      return makeResponse({ status: 200, body });
    });

    const status = await checkProvider('lion-sdk', 'openai-compatible');

    expect(status.connected).toBe(true);
    expect(calledUrl).toBe('https://api.deepseek.com/v1/models');
    expect(calledHeaders?.Authorization).toBe('Bearer sk-deepseek-xyz');
    expect(status.models).toEqual([
      { id: 'deepseek-chat', displayName: 'deepseek-chat' },
      { id: 'deepseek-reasoner', displayName: 'deepseek-reasoner' },
    ]);
  });

  it('returns connected=false when the api key ref is unset', async () => {
    setSettings({
      orchestrator_openai_compat_base_url: 'https://api.deepseek.com',
    });
    stubFetch(async () => makeResponse({ status: 200, body: '{"data":[]}' }));

    const status = await checkProvider('lion-sdk', 'openai-compatible');

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/api key reference not configured/i);
    expect(fetchSpy?.mock.calls.length ?? 0).toBe(0);
  });

  it('returns connected=false when the base URL is unset', async () => {
    setSettings({
      orchestrator_openai_compat_api_key_ref: 'DEEPSEEK_KEY',
    });
    stubFetch(async () => makeResponse({ status: 200 }));

    const status = await checkProvider('lion-sdk', 'openai-compatible');

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/base URL not configured/i);
    expect(fetchSpy?.mock.calls.length ?? 0).toBe(0);
  });

  it('returns connected=false when the vault has no value for the ref', async () => {
    setSettings({
      orchestrator_openai_compat_base_url: 'https://api.deepseek.com',
      orchestrator_openai_compat_api_key_ref: 'DEEPSEEK_KEY',
    });
    mockedGetSecret.mockResolvedValueOnce(null);
    stubFetch(async () => makeResponse({ status: 200 }));

    const status = await checkProvider('lion-sdk', 'openai-compatible');

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/missing from vault/i);
    expect(fetchSpy?.mock.calls.length ?? 0).toBe(0);
  });

  it('returns connected=false on a non-2xx response from /v1/models', async () => {
    setSettings({
      orchestrator_openai_compat_base_url: 'https://api.deepseek.com',
      orchestrator_openai_compat_api_key_ref: 'DEEPSEEK_KEY',
    });
    mockedGetSecret.mockResolvedValueOnce('sk-deepseek-xyz');
    stubFetch(async () => makeResponse({ status: 401 }));

    const status = await checkProvider('lion-sdk', 'openai-compatible');

    expect(status.connected).toBe(false);
    expect(status.reason).toMatch(/HTTP 401/);
  });

  it('includes provider error body and Kimi region hint on auth failures', async () => {
    setSettings({
      orchestrator_openai_compat_base_url: 'https://api.moonshot.cn',
      orchestrator_openai_compat_api_key_ref: 'KIMI_KEY',
      orchestrator_openai_compat_preset: 'kimi-cn',
    });
    mockedGetSecret.mockResolvedValueOnce('sk-kimi-xyz');
    stubFetch(async () => makeResponse({
      status: 401,
      body: JSON.stringify({ error: { message: 'invalid api key' } }),
    }));

    const status = await checkProvider('lion-sdk', 'openai-compatible');

    expect(status.connected).toBe(false);
    expect(status.reason).toContain('invalid api key');
    expect(status.reason).toContain('platform.kimi.ai');
    expect(status.reason).toContain('platform.kimi.com');
  });

  it('raw probe can test an OpenAI-compatible key before saving', async () => {
    let calledUrl = '';
    let calledHeaders: Record<string, string> | undefined;
    stubFetch(async (url, init) => {
      calledUrl = url;
      calledHeaders = init?.headers as Record<string, string> | undefined;
      return makeResponse({
        status: 200,
        body: JSON.stringify({ data: [{ id: 'moonshot-v1-128k' }] }),
      });
    });

    const probe = await probeOpenAiCompatibleModels(
      'https://api.moonshot.ai/v1',
      'sk-kimi-global',
      'kimi',
    );

    expect(probe.ok).toBe(true);
    expect(calledUrl).toBe('https://api.moonshot.ai/v1/models');
    expect(calledHeaders?.Authorization).toBe('Bearer sk-kimi-global');
    expect(probe.models).toEqual([
      { id: 'moonshot-v1-128k', displayName: 'moonshot-v1-128k' },
    ]);
  });

  it('falls back to the preset static list when /v1/models returns an empty data array', async () => {
    setSettings({
      orchestrator_openai_compat_base_url: 'https://api.deepseek.com',
      orchestrator_openai_compat_api_key_ref: 'DEEPSEEK_KEY',
      orchestrator_openai_compat_preset: 'deepseek',
    });
    mockedGetSecret.mockResolvedValueOnce('sk-deepseek-xyz');
    stubFetch(async () => makeResponse({ status: 200, body: '{"data":[]}' }));

    const status = await checkProvider('lion-sdk', 'openai-compatible');

    expect(status.connected).toBe(true);
    expect(status.models?.length).toBeGreaterThan(0);
    expect(status.models?.some(m => m.id === 'deepseek-chat')).toBe(true);
  });

  it('normalizes a trailing /v1 in the base URL before probing', async () => {
    setSettings({
      orchestrator_openai_compat_base_url: 'https://api.deepseek.com/v1',
      orchestrator_openai_compat_api_key_ref: 'DEEPSEEK_KEY',
    });
    mockedGetSecret.mockResolvedValueOnce('sk-deepseek-xyz');
    let calledUrl = '';
    stubFetch(async (url) => {
      calledUrl = url;
      return makeResponse({ status: 200, body: '{"data":[]}' });
    });

    await checkProvider('lion-sdk', 'openai-compatible');

    expect(calledUrl).toBe('https://api.deepseek.com/v1/models');
  });
});


describe('listProviderStatuses: 60s TTL cache and invalidation', () => {
  function arrangeAllProvidersHappy() {
    setSettings({
      orchestrator_zai_api_key_ref: 'ZAI_KEY',
      orchestrator_ollama_base_url: 'http://localhost:11434',
      orchestrator_lmstudio_base_url: 'http://localhost:1234',
      orchestrator_openai_compat_base_url: 'https://api.deepseek.com',
      orchestrator_openai_compat_api_key_ref: 'DEEPSEEK_KEY',
      orchestrator_openai_compat_preset: 'deepseek',
      orchestrator_vertex_api_key_ref: 'ORCHESTRATOR_VERTEX_API_KEY',
    });
    mockedGetSecret.mockImplementation(async (ref: string) => {
      if (ref === 'ZAI_KEY') return 'sk-zai';
      if (ref === 'DEEPSEEK_KEY') return 'sk-deepseek';
      if (ref === 'ORCHESTRATOR_VERTEX_API_KEY') return 'fake-google-key';
      return null;
    });
    mockedIsCodexAvailable.mockResolvedValue({
      installed: true,
      version: '0.1.0',
      authenticated: true,
      appServerSupported: true,
    });
    stubFetch(async (url) => {
      if (typeof url === 'string' && url.includes('/api/tags')) {
        return makeResponse({ status: 200, body: '{"models":[{"name":"llama3.1:8b"}]}' });
      }
      return makeResponse({ status: 200, body: '{"data":[{"id":"some-model"}]}' });
    });
  }

  it('returns all expected (runtime, provider) pairs (one per claude-compat preset)', async () => {
    arrangeAllProvidersHappy();

    const statuses = await listProviderStatuses();
    const pairs = statuses.map(s => `${s.runtime}/${s.provider}`).sort();

    expect(pairs).toEqual(
      [
        'claude-sdk/anthropic',
        'claude-compat-sdk/zai',
        'claude-compat-sdk/minimax',
        'codex-sdk/codex',
        'codex-sdk/codex-official',
        'cursor-sdk/cursor',
        'grok-sdk/grok',
        'kimi-sdk/kimi',
        'lion-sdk/ollama',
        'lion-sdk/lmstudio',
        'lion-sdk/openai-compatible',
        'lion-sdk/vertex-ai',
      ].sort(),
    );
  });

  it('serves the second call within 60s from cache (single underlying probe burst)', async () => {
    arrangeAllProvidersHappy();

    const first = await listProviderStatuses();
    const fetchCallsAfterFirst = fetchSpy?.mock.calls.length ?? 0;
    const secretCallsAfterFirst = mockedGetSecret.mock.calls.length;
    const codexCallsAfterFirst = mockedIsCodexAvailable.mock.calls.length;

    const second = await listProviderStatuses();

    expect(second).toBe(first);
    expect(fetchSpy?.mock.calls.length ?? 0).toBe(fetchCallsAfterFirst);
    expect(mockedGetSecret.mock.calls.length).toBe(secretCallsAfterFirst);
    expect(mockedIsCodexAvailable.mock.calls.length).toBe(codexCallsAfterFirst);
  });

  it('hits the network again after invalidateProviderStatusCache()', async () => {
    arrangeAllProvidersHappy();

    await listProviderStatuses();
    const fetchCallsAfterFirst = fetchSpy?.mock.calls.length ?? 0;
    const codexCallsAfterFirst = mockedIsCodexAvailable.mock.calls.length;

    invalidateProviderStatusCache();

    await listProviderStatuses();

    expect((fetchSpy?.mock.calls.length ?? 0)).toBeGreaterThan(fetchCallsAfterFirst);
    expect(mockedIsCodexAvailable.mock.calls.length).toBeGreaterThan(codexCallsAfterFirst);
  });

  it('keeps serving cached results across multiple awaited calls within the TTL', async () => {
    arrangeAllProvidersHappy();

    const first = await listProviderStatuses();
    const second = await listProviderStatuses();
    const third = await listProviderStatuses();

    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});
