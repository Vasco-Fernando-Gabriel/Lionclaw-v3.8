import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  getDb: vi.fn(),
  getSessionMessages: vi.fn(),
  getSession: vi.fn(),
  getSetting: vi.fn(),
  insertChunkWithEmbedding: vi.fn(),
  insertChunkPlainWithFTS: vi.fn(),
  searchBM25: vi.fn(),
  searchVector: vi.fn(),
  setLastGateRunAt: vi.fn(),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async () => null),
  getApiKey: vi.fn(async () => null),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../paths', () => ({
  getLionClawHome: () => '/tmp/lionclaw-test',
  getBackgroundCwd: () => '/tmp/lionclaw-test/background',
}));

vi.mock('../embedding-provider', () => ({ generateEmbedding: vi.fn() }));
const providerStatusesMock = vi.fn(async (): Promise<Array<Record<string, unknown>>> => []);
vi.mock('../provider-availability', () => ({
  listProviderStatuses: () => providerStatusesMock(),
}));
vi.mock('../mgraph-engine', () => ({
  executeVaultOperation: vi.fn(),
  regenerateVaultIndex: vi.fn(),
  updateVaultHot: vi.fn(),
  appendVaultLog: vi.fn(),
  getExistingVaultFilesList: vi.fn(() => ''),
}));
vi.mock('../memory-pipeline/oneshot-subscription', () => ({
  runSubscriptionPromptWithFallback: vi.fn(),
}));
vi.mock('../lion-sdk/adapters/lmstudio', () => ({ createLmStudioAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/ollama', () => ({ createOllamaAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/openai-compatible', () => ({ createOpenAiCompatibleAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/google-genai', () => ({ createGoogleGenAiAdapter: vi.fn() }));

import { getSetting } from '../db';
import { getSecret } from '../secrets-vault';
import { resolveCompactionSelection, CompactionProviderUnavailableError } from '../memory-pipeline';

const mockedGetSetting = vi.mocked(getSetting);
const mockedGetSecret = vi.mocked(getSecret);

function setSettings(map: Record<string, string | undefined>) {
  mockedGetSetting.mockImplementation((key: string) => map[key]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetSecret.mockResolvedValue(null);
  providerStatusesMock.mockResolvedValue([]);
});

describe('7.8: compactacao Auto NUNCA resolve para provider "off" em provider:list-statuses', () => {
  it('provider da lane off (subscription) = CompactionProviderUnavailableError com a dica de Settings', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
      orchestrator_compaction_provider: '',
      orchestrator_compaction_model: '',
    });
    providerStatusesMock.mockResolvedValue([
      {
        runtime: 'claude-sdk',
        provider: 'anthropic',
        connected: false,
        available: false,
        reason: 'Engine Claude Code nao encontrado.',
      },
    ]);
    await expect(resolveCompactionSelection()).rejects.toBeInstanceOf(CompactionProviderUnavailableError);
    await expect(resolveCompactionSelection()).rejects.toThrowError(/configure o Modelo de compactacao em Settings/);
  });

  it('provider da lane off (lion Auto chat) tambem falha com a dica', async () => {
    setSettings({
      orchestrator_runtime: 'lion-sdk',
      orchestrator_provider: 'ollama',
      orchestrator_model: 'llama3.1:8b',
      orchestrator_ollama_base_url: 'http://localhost:11434',
      orchestrator_compaction_provider: '',
      orchestrator_compaction_model: '',
    });
    providerStatusesMock.mockResolvedValue([
      { runtime: 'lion-sdk', provider: 'ollama', connected: false, available: false, reason: 'Ollama probe failed' },
    ]);
    await expect(resolveCompactionSelection()).rejects.toThrowError(/configure o Modelo de compactacao em Settings/);
  });

  it('provider on = resolve normalmente; modelo de compactacao EXPLICITO nao passa pelo gate', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
      orchestrator_compaction_provider: '',
      orchestrator_compaction_model: '',
    });
    providerStatusesMock.mockResolvedValue([
      { runtime: 'claude-sdk', provider: 'anthropic', connected: true, available: true },
    ]);
    const on = await resolveCompactionSelection();
    expect(on.kind).toBe('subscription');

    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
      orchestrator_compaction_provider: 'anthropic',
      orchestrator_compaction_model: 'claude-haiku-4-5-20251001',
    });
    providerStatusesMock.mockResolvedValue([
      { runtime: 'claude-sdk', provider: 'anthropic', connected: false, available: false },
    ]);
    const explicit = await resolveCompactionSelection();
    expect(explicit.kind).toBe('subscription');
    if (explicit.kind !== 'subscription') throw new Error('expected subscription');
    expect(explicit.selection.model).toBe('claude-haiku-4-5-20251001');
  });
});

describe('resolveCompactionSelection — subscription (Auto, inherit chat)', () => {
  it('claude-sdk/anthropic + no compaction model -> subscription with the chat model', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
      orchestrator_compaction_provider: '',
      orchestrator_compaction_model: '',
    });

    const sel = await resolveCompactionSelection();

    expect(sel.kind).toBe('subscription');
    if (sel.kind !== 'subscription') throw new Error('expected subscription');
    expect(sel.selection.runtime).toBe('claude-sdk');
    expect(sel.selection.provider).toBe('anthropic');
    expect(sel.selection.model).toBe('claude-opus-4-7');
  });

  it('claude-compat-sdk/zai + Auto -> subscription with baseUrl/apiKey resolved', async () => {
    setSettings({
      orchestrator_runtime: 'claude-compat-sdk',
      orchestrator_provider: 'zai',
      orchestrator_model: 'glm-4.7',
      orchestrator_zai_api_key_ref: 'ORCHESTRATOR_ZAI_API_KEY',
      orchestrator_compaction_provider: '',
      orchestrator_compaction_model: '',
    });
    mockedGetSecret.mockResolvedValue('zai-secret-token');

    const sel = await resolveCompactionSelection();

    expect(sel.kind).toBe('subscription');
    if (sel.kind !== 'subscription') throw new Error('expected subscription');
    expect(sel.selection.runtime).toBe('claude-compat-sdk');
    expect(sel.selection.provider).toBe('zai');
    expect(sel.selection.model).toBe('glm-4.7');
    expect(sel.selection.apiKey).toBe('zai-secret-token');
    expect(sel.selection.baseUrl).toBe('https://api.z.ai/api/anthropic');
  });

  it('codex-sdk + Auto -> subscription with runtime codex', async () => {
    setSettings({
      orchestrator_runtime: 'codex-sdk',
      orchestrator_provider: 'codex',
      orchestrator_model: 'gpt-5.5',
      orchestrator_compaction_provider: '',
      orchestrator_compaction_model: '',
    });

    const sel = await resolveCompactionSelection();

    expect(sel.kind).toBe('subscription');
    if (sel.kind !== 'subscription') throw new Error('expected subscription');
    expect(sel.selection.runtime).toBe('codex-sdk');
    expect(sel.selection.model).toBe('gpt-5.5');
  });

  it('kimi-sdk + Auto -> subscription with runtime kimi-sdk (inherits chat)', async () => {
    setSettings({
      orchestrator_runtime: 'kimi-sdk',
      orchestrator_provider: 'kimi',
      orchestrator_model: 'kimi-code/kimi-for-coding',
      orchestrator_compaction_provider: '',
      orchestrator_compaction_model: '',
    });

    const sel = await resolveCompactionSelection();

    expect(sel.kind).toBe('subscription');
    if (sel.kind !== 'subscription') throw new Error('expected subscription');
    expect(sel.selection.runtime).toBe('kimi-sdk');
    expect(sel.selection.model).toBe('kimi-code/kimi-for-coding');
  });
});

describe('resolveCompactionSelection — subscription (explicit, matches orchestrator)', () => {
  it('claude-sdk + explicit Anthropic compaction model -> subscription with that model', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
      orchestrator_compaction_provider: 'anthropic',
      orchestrator_compaction_model: 'claude-sonnet-4-6',
    });

    const sel = await resolveCompactionSelection();

    expect(sel.kind).toBe('subscription');
    if (sel.kind !== 'subscription') throw new Error('expected subscription');
    expect(sel.selection.model).toBe('claude-sonnet-4-6');
  });

  it('claude-compat-sdk/zai + explicit GLM compaction model -> subscription with that model', async () => {
    setSettings({
      orchestrator_runtime: 'claude-compat-sdk',
      orchestrator_provider: 'zai',
      orchestrator_model: 'glm-4.7',
      orchestrator_zai_api_key_ref: 'ORCHESTRATOR_ZAI_API_KEY',
      orchestrator_compaction_provider: 'zai',
      orchestrator_compaction_model: 'glm-5.1',
    });
    mockedGetSecret.mockResolvedValue('zai-secret-token');

    const sel = await resolveCompactionSelection();

    expect(sel.kind).toBe('subscription');
    if (sel.kind !== 'subscription') throw new Error('expected subscription');
    expect(sel.selection.model).toBe('glm-5.1');
    expect(sel.selection.apiKey).toBe('zai-secret-token');
  });
});

describe('resolveCompactionSelection — lion-sdk explicit (D9, local/independent)', () => {
  it('orchestrator claude-sdk + explicit ollama compaction provider -> lion-sdk source:explicit', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
      orchestrator_compaction_provider: 'ollama',
      orchestrator_compaction_model: 'qwen3:8b',
      orchestrator_ollama_base_url: 'http://localhost:11434',
    });

    const sel = await resolveCompactionSelection();

    expect(sel.kind).toBe('lion-sdk');
    if (sel.kind !== 'lion-sdk') throw new Error('expected lion-sdk');
    expect(sel.provider).toBe('ollama');
    expect(sel.model).toBe('qwen3:8b');
    expect(sel.source).toBe('explicit');
    expect(sel.baseUrl).toBe('http://localhost:11434');
  });

  it('orchestrator codex + explicit lmstudio compaction -> lion-sdk source:explicit (independent of orchestrator)', async () => {
    setSettings({
      orchestrator_runtime: 'codex-sdk',
      orchestrator_provider: 'codex',
      orchestrator_model: 'gpt-5.5',
      orchestrator_compaction_provider: 'lmstudio',
      orchestrator_compaction_model: 'local-model',
      orchestrator_lmstudio_base_url: 'http://localhost:1234',
    });

    const sel = await resolveCompactionSelection();

    expect(sel.kind).toBe('lion-sdk');
    if (sel.kind !== 'lion-sdk') throw new Error('expected lion-sdk');
    expect(sel.provider).toBe('lmstudio');
    expect(sel.source).toBe('explicit');
  });

  it('explicit openai-compatible WITHOUT base url -> throws CLEAR error (D-lion-offline, NO Sonnet)', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
      orchestrator_compaction_provider: 'openai-compatible',
      orchestrator_compaction_model: 'some-model',
      orchestrator_openai_compat_base_url: '',
    });

    await expect(resolveCompactionSelection()).rejects.toThrow(/OpenAI-compatible compaction requer/);
  });
});

describe('resolveCompactionSelection - non-active subscription pick is honored (S2)', () => {
  it('Case A: orchestrator codex + compaction zai/glm-4.7 (runtime saved, ref present) -> subscription zai', async () => {
    setSettings({
      orchestrator_runtime: 'codex-sdk',
      orchestrator_provider: 'codex',
      orchestrator_model: 'gpt-5.5',
      orchestrator_compaction_runtime: 'claude-compat-sdk',
      orchestrator_compaction_provider: 'zai',
      orchestrator_compaction_model: 'glm-4.7',
      orchestrator_zai_api_key_ref: 'ORCHESTRATOR_ZAI_API_KEY',
    });
    mockedGetSecret.mockResolvedValue('zai-secret');

    const sel = await resolveCompactionSelection();

    expect(sel.kind).toBe('subscription');
    if (sel.kind !== 'subscription') throw new Error('expected subscription');
    expect(sel.selection.runtime).toBe('claude-compat-sdk');
    expect(sel.selection.provider).toBe('zai');
    expect(sel.selection.model).toBe('glm-4.7');
    expect(sel.selection.apiKey).toBe('zai-secret');
    expect(sel.selection.baseUrl).toBe('https://api.z.ai/api/anthropic');
  });

  it('Case B: non-active subscription pick with missing credential -> throws CompactionProviderUnavailableError', async () => {
    setSettings({
      orchestrator_runtime: 'codex-sdk',
      orchestrator_provider: 'codex',
      orchestrator_model: 'gpt-5.5',
      orchestrator_compaction_runtime: 'claude-compat-sdk',
      orchestrator_compaction_provider: 'zai',
      orchestrator_compaction_model: 'glm-4.7',
    });

    await expect(resolveCompactionSelection()).rejects.toBeInstanceOf(CompactionProviderUnavailableError);
    await expect(resolveCompactionSelection()).rejects.toMatchObject({
      code: 'compaction_provider_unavailable',
    });
  });

  it('orchestrator kimi + compaction anthropic -> subscription claude-sdk', async () => {
    setSettings({
      orchestrator_runtime: 'kimi-sdk',
      orchestrator_provider: 'kimi',
      orchestrator_model: 'kimi-code/kimi-for-coding',
      orchestrator_compaction_runtime: 'claude-sdk',
      orchestrator_compaction_provider: 'anthropic',
      orchestrator_compaction_model: 'claude-sonnet-4-6',
    });

    const sel = await resolveCompactionSelection();

    expect(sel.kind).toBe('subscription');
    if (sel.kind !== 'subscription') throw new Error('expected subscription');
    expect(sel.selection.runtime).toBe('claude-sdk');
    expect(sel.selection.provider).toBe('anthropic');
    expect(sel.selection.model).toBe('claude-sonnet-4-6');
    expect(sel.selection.apiKey).toBeUndefined();
    expect(sel.selection.baseUrl).toBeUndefined();
  });

  it('orchestrator zai + compaction kimi -> subscription kimi-sdk (static map, no inference)', async () => {
    setSettings({
      orchestrator_runtime: 'claude-compat-sdk',
      orchestrator_provider: 'zai',
      orchestrator_model: 'glm-4.7',
      orchestrator_zai_api_key_ref: 'ORCHESTRATOR_ZAI_API_KEY',
      orchestrator_compaction_runtime: 'kimi-sdk',
      orchestrator_compaction_provider: 'kimi',
      orchestrator_compaction_model: 'kimi-code/kimi-for-coding',
    });

    const sel = await resolveCompactionSelection();

    expect(sel.kind).toBe('subscription');
    if (sel.kind !== 'subscription') throw new Error('expected subscription');
    expect(sel.selection.runtime).toBe('kimi-sdk');
    expect(sel.selection.provider).toBe('kimi');
    expect(sel.selection.model).toBe('kimi-code/kimi-for-coding');
    expect(sel.selection.apiKey).toBeUndefined();
  });

  it('orchestrator codex + compaction minimax (ref present) -> subscription claude-compat-sdk/minimax', async () => {
    setSettings({
      orchestrator_runtime: 'codex-sdk',
      orchestrator_provider: 'codex',
      orchestrator_model: 'gpt-5.5',
      orchestrator_compaction_runtime: 'claude-compat-sdk',
      orchestrator_compaction_provider: 'minimax',
      orchestrator_compaction_model: 'MiniMax-M2.7',
      orchestrator_minimax_api_key_ref: 'ORCHESTRATOR_MINIMAX_API_KEY',
    });
    mockedGetSecret.mockResolvedValue('minimax-secret');

    const sel = await resolveCompactionSelection();

    expect(sel.kind).toBe('subscription');
    if (sel.kind !== 'subscription') throw new Error('expected subscription');
    expect(sel.selection.runtime).toBe('claude-compat-sdk');
    expect(sel.selection.provider).toBe('minimax');
    expect(sel.selection.model).toBe('MiniMax-M2.7');
    expect(sel.selection.apiKey).toBe('minimax-secret');
    expect(sel.selection.baseUrl).toBe('https://api.minimax.io/anthropic');
  });

  it('legacy row: compaction provider zai without saved runtime -> static map resolves claude-compat-sdk', async () => {
    setSettings({
      orchestrator_runtime: 'codex-sdk',
      orchestrator_provider: 'codex',
      orchestrator_model: 'gpt-5.5',
      orchestrator_compaction_provider: 'zai',
      orchestrator_compaction_model: 'glm-4.7',
      orchestrator_zai_api_key_ref: 'ORCHESTRATOR_ZAI_API_KEY',
    });
    mockedGetSecret.mockResolvedValue('zai-secret');

    const sel = await resolveCompactionSelection();

    expect(sel.kind).toBe('subscription');
    if (sel.kind !== 'subscription') throw new Error('expected subscription');
    expect(sel.selection.runtime).toBe('claude-compat-sdk');
    expect(sel.selection.provider).toBe('zai');
    expect(sel.selection.model).toBe('glm-4.7');
    expect(sel.selection.apiKey).toBe('zai-secret');
  });
});

describe('resolveCompactionSelection — sem fallback (SPEC 4.1: aborta em vez de Sonnet)', () => {
  it('subscription resolve throws (missing zai credential) -> throws CompactionProviderUnavailableError', async () => {
    setSettings({
      orchestrator_runtime: 'claude-compat-sdk',
      orchestrator_provider: 'zai',
      orchestrator_model: 'glm-4.7',
      orchestrator_compaction_provider: '',
      orchestrator_compaction_model: '',
    });

    await expect(resolveCompactionSelection()).rejects.toBeInstanceOf(CompactionProviderUnavailableError);
    await expect(resolveCompactionSelection()).rejects.toMatchObject({
      code: 'compaction_provider_unavailable',
    });
  });

  it('unknown/empty runtime -> throws CompactionProviderUnavailableError', async () => {
    setSettings({
      orchestrator_runtime: '',
      orchestrator_provider: '',
      orchestrator_model: '',
      orchestrator_compaction_provider: '',
      orchestrator_compaction_model: '',
    });

    await expect(resolveCompactionSelection()).rejects.toBeInstanceOf(CompactionProviderUnavailableError);
  });
});

describe('resolveCompactionSelection — lion-sdk Auto (inherit chat, regression)', () => {
  it('runtime lion-sdk + Auto -> lion-sdk source:chat from the chat provider/model', async () => {
    setSettings({
      orchestrator_runtime: 'lion-sdk',
      orchestrator_provider: 'lmstudio',
      orchestrator_model: 'qwen/qwen3-27b',
      orchestrator_lmstudio_base_url: 'http://localhost:1234',
      orchestrator_compaction_provider: '',
      orchestrator_compaction_model: '',
    });

    const sel = await resolveCompactionSelection();

    expect(sel.kind).toBe('lion-sdk');
    if (sel.kind !== 'lion-sdk') throw new Error('expected lion-sdk');
    expect(sel.provider).toBe('lmstudio');
    expect(sel.model).toBe('qwen/qwen3-27b');
    expect(sel.source).toBe('chat');
  });
});

describe('resolveCompactionSelection — D9: legacy ollama settings ignored', () => {
  it('ollama_enabled + ollama_compaction_model set, no selector pick -> NOT legacy-ollama; falls to Auto/subscription', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
      orchestrator_compaction_provider: '',
      orchestrator_compaction_model: '',
      ollama_enabled: 'true',
      ollama_compaction_model: 'llama3:8b',
      ollama_base_url: 'http://localhost:11434',
    });

    const sel = await resolveCompactionSelection();

    expect(sel.kind).toBe('subscription');
    if (sel.kind !== 'subscription') throw new Error('expected subscription');
    expect(sel.selection.runtime).toBe('claude-sdk');
    expect(sel.selection.model).toBe('claude-opus-4-7');
  });
});
