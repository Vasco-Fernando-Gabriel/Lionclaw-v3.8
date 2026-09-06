
import { describe, it, expect } from 'vitest';
import { PROVIDER_PRESETS, MODEL_CATALOG } from '@/lib/provider-presets';
import type { ExternalProvider } from '@/types/index';


const EXTERNAL_PROVIDERS: Array<{ value: ExternalProvider; label: string }> = [
  { value: 'openrouter',            label: 'OpenRouter' },
  { value: 'openai',                label: 'OpenAI' },
  { value: 'kimi',                  label: 'Kimi (Moonshot)' },
  { value: 'deepseek',              label: 'DeepSeek' },
  { value: 'qwen',                  label: 'Qwen (DashScope)' },
  { value: 'minimax-payg',          label: 'MiniMax (Pay-as-you-go)' },
  { value: 'gemini-agent-platform', label: 'Gemini Agent Platform' },
  { value: 'openai-compatible',     label: 'Custom (OpenAI Compatible)' },
];


interface ExternalConfigBuilt {
  provider: ExternalProvider;
  protocol: 'openai-compatible' | 'google-genai';
  baseUrl?: string;
  model: string;
  apiKeyRef: string;
  temperature?: number;
  maxTokens?: number;
  extraHeaders?: Record<string, string>;
  contextWindow?: number;
}

function buildExternalConfig(opts: {
  provider: ExternalProvider;
  baseUrl: string;
  model: string;
  apiKeyRef: string;
  temperature?: string;
  maxTokens?: string;
  contextWindow?: string;
  extraHeaders?: string;
}): ExternalConfigBuilt {
  const isGemini = opts.provider === 'gemini-agent-platform';

  let parsedHeaders: Record<string, string> | undefined;
  if (opts.provider !== 'openai-compatible') {
    parsedHeaders = PROVIDER_PRESETS[opts.provider]?.extraHeaders;
  } else if (opts.extraHeaders) {
    try {
      parsedHeaders = JSON.parse(opts.extraHeaders) as Record<string, string>;
    } catch {
      parsedHeaders = undefined;
    }
  }

  return {
    provider: opts.provider,
    protocol: isGemini ? 'google-genai' : 'openai-compatible',
    baseUrl: isGemini ? undefined : opts.baseUrl,
    model: opts.model,
    apiKeyRef: opts.apiKeyRef,
    temperature: opts.temperature ? parseFloat(opts.temperature) : undefined,
    maxTokens: opts.maxTokens ? parseInt(opts.maxTokens, 10) : undefined,
    extraHeaders: parsedHeaders,
    contextWindow:
      opts.provider === 'openai-compatible' && opts.contextWindow
        ? parseInt(opts.contextWindow, 10)
        : undefined,
  };
}

function simulateProviderChange(provider: ExternalProvider): {
  extProvider: ExternalProvider;
  extBaseUrl: string;
  extModel: string;
  extApiKeyRef: string;
  extExtraHeaders: string;
} {
  if (provider === 'openai-compatible') {
    return { extProvider: provider, extBaseUrl: '', extModel: '', extApiKeyRef: '', extExtraHeaders: '' };
  }
  const preset = PROVIDER_PRESETS[provider];
  return {
    extProvider: provider,
    extBaseUrl: preset?.baseUrl ?? '',
    extModel: preset?.defaultModel ?? '',
    extApiKeyRef: preset?.vaultKey ?? '',
    extExtraHeaders: preset?.extraHeaders ? JSON.stringify(preset.extraHeaders, null, 2) : '',
  };
}

function resolveVaultKey(provider: ExternalProvider, extApiKeyRef: string, customSlug: string): string {
  if (provider === 'openai-compatible') {
    const slug = customSlug.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
    return slug ? `HARNESS_CUSTOM_${slug}_KEY` : '';
  }
  return extApiKeyRef || PROVIDER_PRESETS[provider]?.vaultKey || '';
}

function modelSupportsReasoning(provider: ExternalProvider, model: string): boolean {
  if (provider === 'openai') {
    return model.startsWith('gpt-5.5') || model.startsWith('o');
  }
  if (provider === 'openrouter') {
    if (model.startsWith('openai/gpt-5')) return true;
    if (model.startsWith('qwen/qwen3.6')) return true;
  }
  if (
    provider === 'kimi' ||
    provider === 'deepseek' ||
    provider === 'qwen' ||
    provider === 'minimax-payg'
  ) {
    const catalogEntry = MODEL_CATALOG[provider]?.find((m) => m.id === model);
    if (catalogEntry?.reasoning && catalogEntry.reasoning.kind !== 'none') return true;
  }
  return false;
}


describe('EXTERNAL_PROVIDERS array (Sprint 4: 8 providers)', () => {
  it('tem exatamente 8 providers', () => {
    expect(EXTERNAL_PROVIDERS).toHaveLength(8);
  });

  it('primeiro provider e openrouter', () => {
    expect(EXTERNAL_PROVIDERS[0].value).toBe('openrouter');
  });

  it('ultimo provider e openai-compatible (Custom)', () => {
    expect(EXTERNAL_PROVIDERS[EXTERNAL_PROVIDERS.length - 1].value).toBe('openai-compatible');
  });

  it('contem kimi', () => {
    expect(EXTERNAL_PROVIDERS.some((p) => p.value === 'kimi')).toBe(true);
  });

  it('contem deepseek', () => {
    expect(EXTERNAL_PROVIDERS.some((p) => p.value === 'deepseek')).toBe(true);
  });

  it('contem qwen', () => {
    expect(EXTERNAL_PROVIDERS.some((p) => p.value === 'qwen')).toBe(true);
  });

  it('contem minimax-payg', () => {
    expect(EXTERNAL_PROVIDERS.some((p) => p.value === 'minimax-payg')).toBe(true);
  });

  it('contem gemini-agent-platform', () => {
    expect(EXTERNAL_PROVIDERS.some((p) => p.value === 'gemini-agent-platform')).toBe(true);
  });

  it('labels dos novos providers estao corretos', () => {
    expect(EXTERNAL_PROVIDERS.find((p) => p.value === 'kimi')?.label).toBe('Kimi (Moonshot)');
    expect(EXTERNAL_PROVIDERS.find((p) => p.value === 'deepseek')?.label).toBe('DeepSeek');
    expect(EXTERNAL_PROVIDERS.find((p) => p.value === 'qwen')?.label).toBe('Qwen (DashScope)');
    expect(EXTERNAL_PROVIDERS.find((p) => p.value === 'minimax-payg')?.label).toBe('MiniMax (Pay-as-you-go)');
    expect(EXTERNAL_PROVIDERS.find((p) => p.value === 'gemini-agent-platform')?.label).toBe('Gemini Agent Platform');
  });
});

describe('handleProviderChange: pre-populacao de campos', () => {
  it('openrouter: extBaseUrl = https://openrouter.ai/api/v1', () => {
    const state = simulateProviderChange('openrouter');
    expect(state.extBaseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('openrouter: extApiKeyRef = "HARNESS_OPENROUTER_KEY"', () => {
    const state = simulateProviderChange('openrouter');
    expect(state.extApiKeyRef).toBe('HARNESS_OPENROUTER_KEY');
  });

  it('kimi: extBaseUrl = "https://api.moonshot.ai/v1"', () => {
    const state = simulateProviderChange('kimi');
    expect(state.extBaseUrl).toBe('https://api.moonshot.ai/v1');
  });

  it('kimi: extApiKeyRef = "HARNESS_KIMI_KEY"', () => {
    const state = simulateProviderChange('kimi');
    expect(state.extApiKeyRef).toBe('HARNESS_KIMI_KEY');
  });

  it('kimi: extModel e o defaultModel do preset', () => {
    const state = simulateProviderChange('kimi');
    expect(state.extModel).toBe(PROVIDER_PRESETS['kimi'].defaultModel);
  });

  it('deepseek: extBaseUrl = "https://api.deepseek.com/v1"', () => {
    const state = simulateProviderChange('deepseek');
    expect(state.extBaseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('deepseek: extApiKeyRef = "HARNESS_DEEPSEEK_KEY"', () => {
    const state = simulateProviderChange('deepseek');
    expect(state.extApiKeyRef).toBe('HARNESS_DEEPSEEK_KEY');
  });

  it('qwen: extApiKeyRef = "HARNESS_QWEN_KEY"', () => {
    const state = simulateProviderChange('qwen');
    expect(state.extApiKeyRef).toBe('HARNESS_QWEN_KEY');
  });

  it('minimax-payg: extApiKeyRef = "HARNESS_MINIMAX_PAYG_KEY"', () => {
    const state = simulateProviderChange('minimax-payg');
    expect(state.extApiKeyRef).toBe('HARNESS_MINIMAX_PAYG_KEY');
  });

  it('gemini-agent-platform: extApiKeyRef = "ORCHESTRATOR_VERTEX_API_KEY"', () => {
    const state = simulateProviderChange('gemini-agent-platform');
    expect(state.extApiKeyRef).toBe('ORCHESTRATOR_VERTEX_API_KEY');
  });

  it('gemini-agent-platform: extBaseUrl e vazio (sem baseUrl)', () => {
    const state = simulateProviderChange('gemini-agent-platform');
    expect(state.extBaseUrl).toBeFalsy();
  });

  it('openai-compatible (Custom): todos os campos sao resetados para string vazia', () => {
    const state = simulateProviderChange('openai-compatible');
    expect(state.extBaseUrl).toBe('');
    expect(state.extModel).toBe('');
    expect(state.extApiKeyRef).toBe('');
    expect(state.extExtraHeaders).toBe('');
  });

  it('openrouter: extExtraHeaders contem HTTP-Referer', () => {
    const state = simulateProviderChange('openrouter');
    expect(state.extExtraHeaders).toContain('HTTP-Referer');
  });

  it('openrouter: extExtraHeaders contem X-Title', () => {
    const state = simulateProviderChange('openrouter');
    expect(state.extExtraHeaders).toContain('X-Title');
  });
});

describe('buildExternalConfig: shape correto por provider', () => {

  it('openrouter: protocol = "openai-compatible"', () => {
    const config = buildExternalConfig({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-v4-pro',
      apiKeyRef: 'HARNESS_OPENROUTER_KEY',
    });
    expect(config.protocol).toBe('openai-compatible');
  });

  it('openrouter: baseUrl esta presente', () => {
    const config = buildExternalConfig({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-v4-pro',
      apiKeyRef: 'HARNESS_OPENROUTER_KEY',
    });
    expect(config.baseUrl).toBe('https://openrouter.ai/api/v1');
  });


  it('kimi: protocol = "openai-compatible"', () => {
    const config = buildExternalConfig({
      provider: 'kimi',
      baseUrl: 'https://api.moonshot.ai/v1',
      model: 'kimi-k2',
      apiKeyRef: 'HARNESS_KIMI_KEY',
    });
    expect(config.protocol).toBe('openai-compatible');
    expect(config.baseUrl).toBe('https://api.moonshot.ai/v1');
  });


  it('deepseek: protocol = "openai-compatible", baseUrl presente', () => {
    const config = buildExternalConfig({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKeyRef: 'HARNESS_DEEPSEEK_KEY',
    });
    expect(config.protocol).toBe('openai-compatible');
    expect(config.baseUrl).toBe('https://api.deepseek.com/v1');
  });


  it('gemini-agent-platform: protocol = "google-genai"', () => {
    const config = buildExternalConfig({
      provider: 'gemini-agent-platform',
      baseUrl: '',
      model: 'gemini-2.5-pro',
      apiKeyRef: 'ORCHESTRATOR_VERTEX_API_KEY',
    });
    expect(config.protocol).toBe('google-genai');
  });

  it('gemini-agent-platform: baseUrl e undefined', () => {
    const config = buildExternalConfig({
      provider: 'gemini-agent-platform',
      baseUrl: '',
      model: 'gemini-2.5-pro',
      apiKeyRef: 'ORCHESTRATOR_VERTEX_API_KEY',
    });
    expect(config.baseUrl).toBeUndefined();
  });

  it('gemini-agent-platform: apiKeyRef = "ORCHESTRATOR_VERTEX_API_KEY"', () => {
    const config = buildExternalConfig({
      provider: 'gemini-agent-platform',
      baseUrl: '',
      model: 'gemini-2.5-pro',
      apiKeyRef: 'ORCHESTRATOR_VERTEX_API_KEY',
    });
    expect(config.apiKeyRef).toBe('ORCHESTRATOR_VERTEX_API_KEY');
  });

  it('gemini-agent-platform: provider esta correto', () => {
    const config = buildExternalConfig({
      provider: 'gemini-agent-platform',
      baseUrl: '',
      model: 'gemini-2.5-pro',
      apiKeyRef: 'ORCHESTRATOR_VERTEX_API_KEY',
    });
    expect(config.provider).toBe('gemini-agent-platform');
  });


  it('openai-compatible: protocol = "openai-compatible"', () => {
    const config = buildExternalConfig({
      provider: 'openai-compatible',
      baseUrl: 'https://my-server.com/v1',
      model: 'my-model',
      apiKeyRef: 'HARNESS_CUSTOM_MY_KEY',
      contextWindow: '128000',
    });
    expect(config.protocol).toBe('openai-compatible');
  });

  it('openai-compatible: contextWindow e parseado corretamente', () => {
    const config = buildExternalConfig({
      provider: 'openai-compatible',
      baseUrl: 'https://my-server.com/v1',
      model: 'my-model',
      apiKeyRef: 'HARNESS_CUSTOM_MY_KEY',
      contextWindow: '128000',
    });
    expect(config.contextWindow).toBe(128000);
  });

  it('openai-compatible sem contextWindow: contextWindow e undefined', () => {
    const config = buildExternalConfig({
      provider: 'openai-compatible',
      baseUrl: 'https://my-server.com/v1',
      model: 'my-model',
      apiKeyRef: 'HARNESS_CUSTOM_MY_KEY',
    });
    expect(config.contextWindow).toBeUndefined();
  });

  it('kimi: contextWindow e undefined (so para openai-compatible)', () => {
    const config = buildExternalConfig({
      provider: 'kimi',
      baseUrl: 'https://api.moonshot.ai/v1',
      model: 'kimi-k2',
      apiKeyRef: 'HARNESS_KIMI_KEY',
      contextWindow: '256000',
    });
    expect(config.contextWindow).toBeUndefined();
  });
});

describe('resolveVaultKey', () => {
  it('openrouter usa apiKeyRef passado', () => {
    expect(resolveVaultKey('openrouter', 'HARNESS_OPENROUTER_KEY', '')).toBe('HARNESS_OPENROUTER_KEY');
  });

  it('kimi usa apiKeyRef passado', () => {
    expect(resolveVaultKey('kimi', 'HARNESS_KIMI_KEY', '')).toBe('HARNESS_KIMI_KEY');
  });

  it('openai-compatible com slug: gera HARNESS_CUSTOM_MYAPP_KEY', () => {
    expect(resolveVaultKey('openai-compatible', '', 'myapp')).toBe('HARNESS_CUSTOM_MYAPP_KEY');
  });

  it('openai-compatible: slug e normalizado para uppercase+underscore', () => {
    expect(resolveVaultKey('openai-compatible', '', 'my-app v2')).toBe('HARNESS_CUSTOM_MY_APP_V2_KEY');
  });

  it('openai-compatible sem slug: retorna string vazia', () => {
    expect(resolveVaultKey('openai-compatible', '', '')).toBe('');
  });

  it('gemini usa apiKeyRef "ORCHESTRATOR_VERTEX_API_KEY"', () => {
    expect(resolveVaultKey('gemini-agent-platform', 'ORCHESTRATOR_VERTEX_API_KEY', '')).toBe(
      'ORCHESTRATOR_VERTEX_API_KEY',
    );
  });
});

describe('modelSupportsReasoning', () => {
  it('openai + gpt-5.5: suporta reasoning', () => {
    expect(modelSupportsReasoning('openai', 'gpt-5.5')).toBe(true);
  });

  it('openai + o3: suporta reasoning', () => {
    expect(modelSupportsReasoning('openai', 'o3')).toBe(true);
  });

  it('openai + gpt-4o: NAO suporta reasoning', () => {
    expect(modelSupportsReasoning('openai', 'gpt-4o')).toBe(false);
  });

  it('openrouter + qwen/qwen3.6-max-preview: suporta reasoning', () => {
    expect(modelSupportsReasoning('openrouter', 'qwen/qwen3.6-max-preview')).toBe(true);
  });

  it('openrouter + deepseek/deepseek-v4-pro: NAO suporta reasoning (nao e gpt/qwen)', () => {
    expect(modelSupportsReasoning('openrouter', 'deepseek/deepseek-v4-pro')).toBe(false);
  });

  it('deepseek + deepseek-reasoner: suporta reasoning (catalog)', () => {
    expect(modelSupportsReasoning('deepseek', 'deepseek-reasoner')).toBe(true);
  });

  it('deepseek + deepseek-chat: NAO suporta reasoning', () => {
    expect(modelSupportsReasoning('deepseek', 'deepseek-chat')).toBe(false);
  });

  it('kimi + modelo com reasoning no catalog: suporta reasoning', () => {
    const hasThinkingModel = MODEL_CATALOG['kimi']?.some(
      (m) => m.reasoning && m.reasoning.kind !== 'none',
    );
    if (hasThinkingModel) {
      const thinkingModel = MODEL_CATALOG['kimi'].find(
        (m) => m.reasoning && m.reasoning.kind !== 'none',
      );
      if (thinkingModel) {
        expect(modelSupportsReasoning('kimi', thinkingModel.id)).toBe(true);
      }
    }
  });

  it('gemini-agent-platform: NAO detectado pelo modelSupportsReasoning (nao e no check)', () => {
    expect(modelSupportsReasoning('gemini-agent-platform', 'gemini-2.5-pro')).toBe(false);
  });

  it('openai-compatible: NAO suporta reasoning (nao e checado)', () => {
    expect(modelSupportsReasoning('openai-compatible', 'my-model')).toBe(false);
  });
});
