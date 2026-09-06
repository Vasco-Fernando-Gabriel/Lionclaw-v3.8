
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
  getSetting: vi.fn(),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(),
}));

import { getSetting } from '../db';
import { getSecret } from '../secrets-vault';
import {
  resolveOrchestratorSelection,
  resolveSubscriptionSelectionFor,
  InvalidOrchestratorSelectionError,
  __internal,
} from '../orchestrator-selection';

const mockedGetSetting = vi.mocked(getSetting);
const mockedGetSecret = vi.mocked(getSecret);

function setSettings(map: Record<string, string | undefined>) {
  mockedGetSetting.mockImplementation((key: string) => map[key]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetSecret.mockResolvedValue(null);
});

describe('Rule #1: triple completo -> settings; incompleto -> orchestrator_unconfigured', () => {
  it('uses orchestrator_* keys when all three are set', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
    });
    const sel = await resolveOrchestratorSelection({ surface: 'main-chat' });
    expect(sel.runtime).toBe('claude-sdk');
    expect(sel.provider).toBe('anthropic');
    expect(sel.model).toBe('claude-opus-4-7');
    expect(sel.source).toBe('settings');
  });

  it('ignores default_model (nao lido) and throws orchestrator_unconfigured', async () => {
    setSettings({
      default_model: 'gpt-5.5',
    });
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat' }),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });

  it('throws orchestrator_unconfigured (missingField runtime) when settings table is empty', async () => {
    setSettings({});
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat' }),
    ).rejects.toMatchObject({
      code: 'orchestrator_unconfigured',
      missingField: 'runtime',
    });
  });

  it('throws with missingField provider when only runtime is set', async () => {
    setSettings({ orchestrator_runtime: 'claude-sdk' });
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat' }),
    ).rejects.toMatchObject({
      code: 'orchestrator_unconfigured',
      missingField: 'provider',
    });
  });

  it('throws with missingField model when runtime+provider are set but model is empty', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: '',
    });
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat' }),
    ).rejects.toMatchObject({
      code: 'orchestrator_unconfigured',
      missingField: 'model',
    });
  });
});


describe('Rule #2: requestedModel cross-runtime validation', () => {
  it('accepts requestedModel that belongs to the resolved runtime', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
    });
    const sel = await resolveOrchestratorSelection({
      surface: 'main-chat',
      requestedModel: 'claude-opus-4-8',
    });
    expect(sel.model).toBe('claude-opus-4-8');
    expect(sel.source).toBe('request');
  });

  it('rejects requestedModel that belongs to a different runtime', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
    });
    await expect(
      resolveOrchestratorSelection({
        surface: 'main-chat',
        requestedModel: 'gpt-5.5', // codex slug under a claude-sdk runtime
      }),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });

  it('rejects requestedModel that belongs to another provider in the same runtime', async () => {
    setSettings({
      orchestrator_runtime: 'claude-compat-sdk',
      orchestrator_provider: 'minimax',
      orchestrator_model: 'MiniMax-M2.7',
      orchestrator_minimax_api_key_ref: 'MINIMAX_KEY',
    });
    mockedGetSecret.mockResolvedValue('mx-token');

    await expect(
      resolveOrchestratorSelection({
        surface: 'main-chat',
        requestedModel: 'glm-5.2',
      }),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });
});


describe('Rule #3: agentModel sobrescreve o MODELO, nunca o runtime (source agent)', () => {
  it('usa agentModel como model com source agent, mantendo runtime/provider dos settings', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
    });
    const sel = await resolveOrchestratorSelection({
      surface: 'main-chat',
      agentModel: 'claude-sonnet-4-6',
    });
    expect(sel.runtime).toBe('claude-sdk');
    expect(sel.provider).toBe('anthropic');
    expect(sel.model).toBe('claude-sonnet-4-6');
    expect(sel.source).toBe('agent');
  });

  it('agente SEM modelo herda o orquestrador (model dos settings, source settings)', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
    });
    const sel = await resolveOrchestratorSelection({
      surface: 'main-chat',
      agentModel: undefined,
    });
    expect(sel.model).toBe('claude-opus-4-7');
    expect(sel.source).toBe('settings');
  });

  it('agentModel NUNCA muda o runtime, mesmo apontando para outro runtime (delegado ao provider)', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
    });
    const sel = await resolveOrchestratorSelection({
      surface: 'main-chat',
      agentModel: 'gpt-5.5',
    });
    expect(sel.runtime).toBe('claude-sdk');
    expect(sel.provider).toBe('anthropic');
    expect(sel.model).toBe('gpt-5.5');
    expect(sel.source).toBe('agent');
  });

  it('NAO lanca quando agentModel e incompativel com o runtime (validacao delegada ao provider)', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
    });
    await expect(
      resolveOrchestratorSelection({
        surface: 'main-chat',
        agentModel: 'glm-4.7',
      }),
    ).resolves.toMatchObject({ runtime: 'claude-sdk', model: 'glm-4.7', source: 'agent' });
  });

  it('requestedModel (override do turno) tem precedencia sobre agentModel', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
    });
    const sel = await resolveOrchestratorSelection({
      surface: 'main-chat',
      requestedModel: 'claude-opus-4-8',
      agentModel: 'claude-sonnet-4-6',
    });
    expect(sel.model).toBe('claude-opus-4-8');
    expect(sel.source).toBe('request');
  });

  it('override por agente vale em qualquer lane (o resolver e lane-agnostico)', async () => {
    setSettings({
      orchestrator_runtime: 'claude-compat-sdk',
      orchestrator_provider: 'zai',
      orchestrator_model: 'glm-4.7',
      orchestrator_zai_api_key_ref: 'ZAI_KEY',
    });
    mockedGetSecret.mockResolvedValue('sk-zai-abc');
    const sel = await resolveOrchestratorSelection({
      surface: 'main-chat',
      agentModel: 'glm-4.6',
    });
    expect(sel.runtime).toBe('claude-compat-sdk');
    expect(sel.provider).toBe('zai');
    expect(sel.model).toBe('glm-4.6');
    expect(sel.source).toBe('agent');
  });
});


describe('Rule #4: Z.ai requires Vault API key', () => {
  it('resolves the apiKey from the vault when the ref + value are set', async () => {
    setSettings({
      orchestrator_runtime: 'claude-compat-sdk',
      orchestrator_provider: 'zai',
      orchestrator_model: 'glm-4.7',
      orchestrator_zai_api_key_ref: 'ZAI_KEY',
    });
    mockedGetSecret.mockResolvedValueOnce('sk-zai-xyz');
    const sel = await resolveOrchestratorSelection({ surface: 'main-chat' });
    expect(sel.apiKey).toBe('sk-zai-xyz');
    expect(sel.baseUrl).toBe('https://api.z.ai/api/anthropic');
  });

  it('throws when the vault key reference is unset', async () => {
    setSettings({
      orchestrator_runtime: 'claude-compat-sdk',
      orchestrator_provider: 'zai',
      orchestrator_model: 'glm-4.7',
    });
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat' }),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });

  it('throws when the vault value is missing for the configured ref', async () => {
    setSettings({
      orchestrator_runtime: 'claude-compat-sdk',
      orchestrator_provider: 'zai',
      orchestrator_model: 'glm-4.7',
      orchestrator_zai_api_key_ref: 'ZAI_KEY',
    });
    mockedGetSecret.mockResolvedValueOnce(null);
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat' }),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });
});


describe('Rule #4 (SPEC-004 §5.4): MiniMax claude-compat resolver', () => {
  it('resolves MiniMax selection (baseUrl + apiKey) when setting + vault are populated', async () => {
    setSettings({
      orchestrator_runtime: 'claude-compat-sdk',
      orchestrator_provider: 'minimax',
      orchestrator_model: 'MiniMax-M2.7',
      orchestrator_minimax_api_key_ref: 'ORCHESTRATOR_MINIMAX_API_KEY',
    });
    mockedGetSecret.mockResolvedValueOnce('mx-fake-token');
    const sel = await resolveOrchestratorSelection({ surface: 'main-chat' });
    expect(sel.runtime).toBe('claude-compat-sdk');
    expect(sel.provider).toBe('minimax');
    expect(sel.model).toBe('MiniMax-M2.7');
    expect(sel.apiKey).toBe('mx-fake-token');
    expect(sel.baseUrl).toBe('https://api.minimax.io/anthropic');
  });

  it('throws with Settings > External Providers when minimax setting is missing', async () => {
    setSettings({
      orchestrator_runtime: 'claude-compat-sdk',
      orchestrator_provider: 'minimax',
      orchestrator_model: 'MiniMax-M2.7',
    });
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat' }),
    ).rejects.toThrowError(/Settings > External Providers/);
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat' }),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });

  it('throws with "reconecte" hint when minimax vault has no value for the ref', async () => {
    setSettings({
      orchestrator_runtime: 'claude-compat-sdk',
      orchestrator_provider: 'minimax',
      orchestrator_model: 'MiniMax-M2.7',
      orchestrator_minimax_api_key_ref: 'ORCHESTRATOR_MINIMAX_API_KEY',
    });
    mockedGetSecret.mockResolvedValue(null);
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat' }),
    ).rejects.toThrowError(/reconecte/i);
  });

  it('Z.ai regression: selection shape is identical to the legacy hardcoded resolver', async () => {
    setSettings({
      orchestrator_runtime: 'claude-compat-sdk',
      orchestrator_provider: 'zai',
      orchestrator_model: 'glm-4.7',
      orchestrator_zai_api_key_ref: 'ORCHESTRATOR_ZAI_API_KEY',
    });
    mockedGetSecret.mockResolvedValueOnce('sk-zai-regression');
    const sel = await resolveOrchestratorSelection({ surface: 'main-chat' });
    expect(sel).toMatchObject({
      runtime: 'claude-compat-sdk',
      provider: 'zai',
      model: 'glm-4.7',
      baseUrl: 'https://api.z.ai/api/anthropic',
      apiKey: 'sk-zai-regression',
      source: 'settings',
    });
  });
});


describe('Rule #5: lion-sdk requires baseUrl from settings', () => {
  it('resolves the Ollama baseUrl when configured', async () => {
    setSettings({
      orchestrator_runtime: 'lion-sdk',
      orchestrator_provider: 'ollama',
      orchestrator_model: 'llama3.1:8b',
      orchestrator_ollama_base_url: 'http://localhost:11434',
    });
    const sel = await resolveOrchestratorSelection({ surface: 'main-chat' });
    expect(sel.baseUrl).toBe('http://localhost:11434');
  });

  it('resolves the LM Studio baseUrl when configured', async () => {
    setSettings({
      orchestrator_runtime: 'lion-sdk',
      orchestrator_provider: 'lmstudio',
      orchestrator_model: 'qwen2.5-coder',
      orchestrator_lmstudio_base_url: 'http://localhost:1234',
    });
    const sel = await resolveOrchestratorSelection({ surface: 'main-chat' });
    expect(sel.baseUrl).toBe('http://localhost:1234');
  });

  it('throws when the matching baseUrl key is empty', async () => {
    setSettings({
      orchestrator_runtime: 'lion-sdk',
      orchestrator_provider: 'ollama',
      orchestrator_model: 'llama3.1:8b',
    });
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat' }),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });
});


describe('Rule #6: openai-compatible additionally requires Vault API key', () => {
  it('resolves both baseUrl and apiKey when fully configured', async () => {
    setSettings({
      orchestrator_runtime: 'lion-sdk',
      orchestrator_provider: 'openai-compatible',
      orchestrator_model: 'deepseek-chat',
      orchestrator_openai_compat_base_url: 'https://api.deepseek.com',
      orchestrator_openai_compat_api_key_ref: 'DEEPSEEK_KEY',
    });
    mockedGetSecret.mockResolvedValueOnce('sk-deepseek-xyz');
    const sel = await resolveOrchestratorSelection({ surface: 'main-chat' });
    expect(sel.baseUrl).toBe('https://api.deepseek.com');
    expect(sel.apiKey).toBe('sk-deepseek-xyz');
  });

  it('throws when the API key ref is configured but the vault has no value', async () => {
    setSettings({
      orchestrator_runtime: 'lion-sdk',
      orchestrator_provider: 'openai-compatible',
      orchestrator_model: 'deepseek-chat',
      orchestrator_openai_compat_base_url: 'https://api.deepseek.com',
      orchestrator_openai_compat_api_key_ref: 'DEEPSEEK_KEY',
    });
    mockedGetSecret.mockResolvedValueOnce(null);
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat' }),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });

  it('throws when the API key ref is not configured at all', async () => {
    setSettings({
      orchestrator_runtime: 'lion-sdk',
      orchestrator_provider: 'openai-compatible',
      orchestrator_model: 'deepseek-chat',
      orchestrator_openai_compat_base_url: 'https://api.deepseek.com',
    });
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat' }),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });
});


describe('Rule #7: resolver rejects non-main-chat surfaces', () => {
  it('throws when invoked with a surface other than "main-chat"', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
    });
    await expect(
      // @ts-expect-error: deliberately violating the surface type to assert the guard
      resolveOrchestratorSelection({ surface: 'pipeline' }),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });

  it('accepts the documented main-chat surface', async () => {
    setSettings({
      orchestrator_runtime: 'claude-sdk',
      orchestrator_provider: 'anthropic',
      orchestrator_model: 'claude-opus-4-7',
    });
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat' }),
    ).resolves.toMatchObject({ runtime: 'claude-sdk' });
  });
});


describe('inferRuntimeFromModel / isModelInRuntime', () => {
  it('maps claude-* to claude-sdk and rejects under codex-sdk', () => {
    expect(__internal.inferRuntimeFromModel('claude-opus-4-8')).toBe('claude-sdk');
    expect(__internal.isModelInRuntime('claude-opus-4-8', 'claude-sdk')).toBe(true);
    expect(__internal.inferRuntimeFromModel('claude-opus-4-7')).toBe('claude-sdk');
    expect(__internal.isModelInRuntime('claude-opus-4-7', 'claude-sdk')).toBe(true);
    expect(__internal.isModelInRuntime('claude-opus-4-7', 'codex-sdk')).toBe(false);
  });

  it('maps gpt-5.* to codex-sdk and rejects under claude-sdk', () => {
    expect(__internal.inferRuntimeFromModel('gpt-5.5')).toBe('codex-sdk');
    expect(__internal.isModelInRuntime('gpt-5.5', 'codex-sdk')).toBe(true);
    expect(__internal.isModelInRuntime('gpt-5.5', 'claude-sdk')).toBe(false);
  });

  it('maps glm-* to claude-compat-sdk and rejects under lion-sdk', () => {
    expect(__internal.inferRuntimeFromModel('glm-4.7')).toBe('claude-compat-sdk');
    expect(__internal.isModelInRuntime('glm-4.7', 'claude-compat-sdk')).toBe(true);
    expect(__internal.isModelInRuntime('glm-4.7', 'lion-sdk')).toBe(false);
  });

  it('maps MiniMax-* to claude-compat-sdk (Token Plan preset)', () => {
    expect(__internal.inferRuntimeFromModel('MiniMax-M2.7')).toBe('claude-compat-sdk');
    expect(__internal.isModelInRuntime('MiniMax-M2.7', 'claude-compat-sdk')).toBe(true);
    expect(__internal.isModelInRuntime('MiniMax-M2.7', 'lion-sdk')).toBe(false);
  });

  it('accepts unknown slugs under lion-sdk (residual catalog)', () => {
    expect(__internal.inferRuntimeFromModel('llama3.1:8b')).toBe('lion-sdk');
    expect(__internal.isModelInRuntime('llama3.1:8b', 'lion-sdk')).toBe(true);
  });

  it('maps gemini-* to lion-sdk (Vertex catch-all)', () => {
    expect(__internal.inferRuntimeFromModel('gemini-3-flash-preview')).toBe('lion-sdk');
    expect(__internal.isModelInRuntime('gemini-3-flash-preview', 'lion-sdk')).toBe(true);
  });
});


describe('lion-sdk / vertex-ai resolver', () => {
  it('throws InvalidOrchestratorSelectionError when vault ref is missing', async () => {
    setSettings({
      orchestrator_runtime: 'lion-sdk',
      orchestrator_provider: 'vertex-ai',
      orchestrator_model: 'gemini-3-flash-preview',
      orchestrator_vertex_api_key_ref: '',
    });
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat' }),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });

  it('throws InvalidOrchestratorSelectionError when vault secret is missing', async () => {
    setSettings({
      orchestrator_runtime: 'lion-sdk',
      orchestrator_provider: 'vertex-ai',
      orchestrator_model: 'gemini-3-flash-preview',
      orchestrator_vertex_api_key_ref: 'ORCHESTRATOR_VERTEX_API_KEY',
    });
    mockedGetSecret.mockResolvedValue(null);
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat' }),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });

  it('populates apiKey + default authMode api-key without location/project', async () => {
    setSettings({
      orchestrator_runtime: 'lion-sdk',
      orchestrator_provider: 'vertex-ai',
      orchestrator_model: 'gemini-3-flash-preview',
      orchestrator_vertex_api_key_ref: 'ORCHESTRATOR_VERTEX_API_KEY',
      orchestrator_vertex_location: '',
      orchestrator_vertex_project_id: '',
      orchestrator_vertex_auth_mode: '',
    });
    mockedGetSecret.mockResolvedValue('fake-google-key');
    const sel = await resolveOrchestratorSelection({ surface: 'main-chat' });
    expect(sel.runtime).toBe('lion-sdk');
    expect(sel.provider).toBe('vertex-ai');
    expect(sel.apiKey).toBe('fake-google-key');
    expect(sel.vertexLocation).toBeUndefined();
    expect(sel.vertexProjectId).toBeUndefined();
    expect(sel.vertexAuthMode).toBe('api-key');
    expect(sel.baseUrl).toBeUndefined(); // NO baseUrl required for Vertex
  });

  it('ignores legacy location and projectId settings in API-key mode', async () => {
    setSettings({
      orchestrator_runtime: 'lion-sdk',
      orchestrator_provider: 'vertex-ai',
      orchestrator_model: 'gemini-3-flash-preview',
      orchestrator_vertex_api_key_ref: 'ORCHESTRATOR_VERTEX_API_KEY',
      orchestrator_vertex_location: 'us-central1',
      orchestrator_vertex_project_id: 'my-project',
      orchestrator_vertex_auth_mode: 'api-key',
    });
    mockedGetSecret.mockResolvedValue('fake-google-key');
    const sel = await resolveOrchestratorSelection({ surface: 'main-chat' });
    expect(sel.vertexLocation).toBeUndefined();
    expect(sel.vertexProjectId).toBeUndefined();
  });

  it('throws orchestrator_unconfigured (missingField model) when orchestrator_model is empty', async () => {
    setSettings({
      orchestrator_runtime: 'lion-sdk',
      orchestrator_provider: 'vertex-ai',
      orchestrator_model: '',
      orchestrator_vertex_api_key_ref: 'ORCHESTRATOR_VERTEX_API_KEY',
    });
    mockedGetSecret.mockResolvedValue('fake-google-key');
    await expect(
      resolveOrchestratorSelection({ surface: 'main-chat' }),
    ).rejects.toMatchObject({
      code: 'orchestrator_unconfigured',
      missingField: 'model',
    });
  });

  it('R2 — other providers do NOT receive vertex* fields', async () => {
    setSettings({
      orchestrator_runtime: 'lion-sdk',
      orchestrator_provider: 'ollama',
      orchestrator_model: 'llama3.1:8b',
      orchestrator_ollama_base_url: 'http://localhost:11434',
    });
    const sel = await resolveOrchestratorSelection({ surface: 'main-chat' });
    expect(sel.vertexLocation).toBeUndefined();
    expect(sel.vertexProjectId).toBeUndefined();
    expect(sel.vertexAuthMode).toBeUndefined();
  });
});


describe('resolveSubscriptionSelectionFor', () => {
  it('claude-sdk/anthropic: returns selection without apiKey/baseUrl', async () => {
    setSettings({});
    const sel = await resolveSubscriptionSelectionFor(
      'claude-sdk',
      'anthropic',
      'claude-opus-4-7',
    );
    expect(sel).toEqual({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      source: 'request',
    });
    expect(sel.apiKey).toBeUndefined();
    expect(sel.baseUrl).toBeUndefined();
    expect(mockedGetSecret).not.toHaveBeenCalled();
  });

  it('claude-compat-sdk/zai: resolves apiKey + preset baseUrl when the ref is in the vault', async () => {
    setSettings({
      orchestrator_zai_api_key_ref: 'ORCHESTRATOR_ZAI_API_KEY',
    });
    mockedGetSecret.mockResolvedValueOnce('sk-zai-compaction');
    const sel = await resolveSubscriptionSelectionFor(
      'claude-compat-sdk',
      'zai',
      'glm-4.7',
    );
    expect(sel.runtime).toBe('claude-compat-sdk');
    expect(sel.provider).toBe('zai');
    expect(sel.model).toBe('glm-4.7');
    expect(sel.source).toBe('request');
    expect(sel.apiKey).toBe('sk-zai-compaction');
    expect(sel.baseUrl).toBe('https://api.z.ai/api/anthropic');
  });

  it('claude-compat-sdk/minimax: resolves apiKey + preset baseUrl when the ref is in the vault', async () => {
    setSettings({
      orchestrator_minimax_api_key_ref: 'ORCHESTRATOR_MINIMAX_API_KEY',
    });
    mockedGetSecret.mockResolvedValueOnce('mx-compaction-token');
    const sel = await resolveSubscriptionSelectionFor(
      'claude-compat-sdk',
      'minimax',
      'MiniMax-M2.7',
    );
    expect(sel.runtime).toBe('claude-compat-sdk');
    expect(sel.provider).toBe('minimax');
    expect(sel.model).toBe('MiniMax-M2.7');
    expect(sel.source).toBe('request');
    expect(sel.apiKey).toBe('mx-compaction-token');
    expect(sel.baseUrl).toBe('https://api.minimax.io/anthropic');
  });

  it('claude-compat-sdk/zai: throws when the api key ref is NOT in the vault', async () => {
    setSettings({});
    await expect(
      resolveSubscriptionSelectionFor('claude-compat-sdk', 'zai', 'glm-4.7'),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
    await expect(
      resolveSubscriptionSelectionFor('claude-compat-sdk', 'zai', 'glm-4.7'),
    ).rejects.toThrowError(/nao configurada/i);
  });

  it('kimi-sdk/kimi: returns valid selection without apiKey/baseUrl', async () => {
    setSettings({});
    const sel = await resolveSubscriptionSelectionFor(
      'kimi-sdk',
      'kimi',
      'kimi-code/kimi-for-coding',
    );
    expect(sel).toEqual({
      runtime: 'kimi-sdk',
      provider: 'kimi',
      model: 'kimi-code/kimi-for-coding',
      source: 'request',
    });
    expect(sel.apiKey).toBeUndefined();
    expect(sel.baseUrl).toBeUndefined();
    expect(mockedGetSecret).not.toHaveBeenCalled();
  });

  it('codex-sdk/codex: returns valid selection without apiKey/baseUrl', async () => {
    setSettings({});
    const sel = await resolveSubscriptionSelectionFor('codex-sdk', 'codex', 'gpt-5.5');
    expect(sel).toEqual({
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-5.5',
      source: 'request',
    });
    expect(sel.apiKey).toBeUndefined();
    expect(sel.baseUrl).toBeUndefined();
    expect(mockedGetSecret).not.toHaveBeenCalled();
  });

  it('throws for a cross-runtime model id (glm-4.7 under codex-sdk)', async () => {
    setSettings({});
    await expect(
      resolveSubscriptionSelectionFor('codex-sdk', 'codex', 'glm-4.7'),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });

  it('throws for the non-subscription lion-sdk runtime', async () => {
    setSettings({});
    await expect(
      resolveSubscriptionSelectionFor('lion-sdk', 'ollama', 'llama3.1:8b'),
    ).rejects.toBeInstanceOf(InvalidOrchestratorSelectionError);
  });

  it('does NOT read orchestrator_runtime/provider/model from settings', async () => {
    setSettings({
      orchestrator_runtime: 'codex-sdk',
      orchestrator_provider: 'codex',
      orchestrator_model: 'gpt-5.5',
    });
    const sel = await resolveSubscriptionSelectionFor(
      'claude-sdk',
      'anthropic',
      'claude-opus-4-8',
    );
    expect(sel.runtime).toBe('claude-sdk');
    expect(sel.provider).toBe('anthropic');
    expect(sel.model).toBe('claude-opus-4-8');
    expect(mockedGetSetting).not.toHaveBeenCalledWith('orchestrator_runtime');
    expect(mockedGetSetting).not.toHaveBeenCalledWith('orchestrator_provider');
    expect(mockedGetSetting).not.toHaveBeenCalledWith('orchestrator_model');
  });
});
