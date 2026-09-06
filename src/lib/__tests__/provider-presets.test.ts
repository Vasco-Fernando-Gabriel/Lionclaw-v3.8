
import { describe, it, expect } from 'vitest';
import { PROVIDER_PRESETS, MODEL_CATALOG } from '../provider-presets';
import { VERTEX_DEFAULT_MODEL, VERTEX_MODEL_CATALOG } from '../../constants/vertex-gemini-models';
import type { CatalogedModel } from '../provider-presets';


describe('PROVIDER_PRESETS: openrouter', () => {
  it('tem entry para openrouter', () => {
    expect(PROVIDER_PRESETS['openrouter']).toBeDefined();
  });

  it('openrouter.label = "OpenRouter"', () => {
    expect(PROVIDER_PRESETS['openrouter'].label).toBe('OpenRouter');
  });

  it('openrouter.baseUrl correto', () => {
    expect(PROVIDER_PRESETS['openrouter'].baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('openrouter.vaultKey = "HARNESS_OPENROUTER_KEY"', () => {
    expect(PROVIDER_PRESETS['openrouter'].vaultKey).toBe('HARNESS_OPENROUTER_KEY');
  });

  it('openrouter.requiresApiKey = true', () => {
    expect(PROVIDER_PRESETS['openrouter'].requiresApiKey).toBe(true);
  });

  it('openrouter.defaultModel e definido', () => {
    expect(PROVIDER_PRESETS['openrouter'].defaultModel).toBeTruthy();
  });

  it('openrouter.extraHeaders tem HTTP-Referer e X-Title', () => {
    expect(PROVIDER_PRESETS['openrouter'].extraHeaders).toBeDefined();
    expect(PROVIDER_PRESETS['openrouter'].extraHeaders?.['HTTP-Referer']).toBe('https://lionclaw.app');
    expect(PROVIDER_PRESETS['openrouter'].extraHeaders?.['X-Title']).toBe('LionClaw');
  });

  it('openrouter.testEndpoint esta definido', () => {
    expect(PROVIDER_PRESETS['openrouter'].testEndpoint).toBeTruthy();
  });

  it('openrouter.protocol = "openai-compatible"', () => {
    expect(PROVIDER_PRESETS['openrouter'].protocol).toBe('openai-compatible');
  });
});

describe('PROVIDER_PRESETS: openai', () => {
  it('tem entry para openai', () => {
    expect(PROVIDER_PRESETS['openai']).toBeDefined();
  });

  it('openai.label = "OpenAI"', () => {
    expect(PROVIDER_PRESETS['openai'].label).toBe('OpenAI');
  });

  it('openai.baseUrl correto', () => {
    expect(PROVIDER_PRESETS['openai'].baseUrl).toBe('https://api.openai.com/v1');
  });

  it('openai.vaultKey = "HARNESS_OPENAI_KEY"', () => {
    expect(PROVIDER_PRESETS['openai'].vaultKey).toBe('HARNESS_OPENAI_KEY');
  });

  it('openai.requiresApiKey = true', () => {
    expect(PROVIDER_PRESETS['openai'].requiresApiKey).toBe(true);
  });

  it('openai.defaultModel = "gpt-5.5"', () => {
    expect(PROVIDER_PRESETS['openai'].defaultModel).toBe('gpt-5.5');
  });

  it('openai.protocol = "openai-compatible"', () => {
    expect(PROVIDER_PRESETS['openai'].protocol).toBe('openai-compatible');
  });
});

describe('PROVIDER_PRESETS: Custom (openai-compatible) NAO esta no preset', () => {
  it('nao tem entry "openai-compatible" em PROVIDER_PRESETS', () => {
    expect(PROVIDER_PRESETS['openai-compatible']).toBeUndefined();
  });
});

describe('PROVIDER_PRESETS: novos providers (SPEC-005)', () => {
  const NEW_PROVIDERS = [
    { key: 'kimi',                   label: 'Kimi (Moonshot)',            vaultKey: 'HARNESS_KIMI_KEY',          protocol: 'openai-compatible' },
    { key: 'deepseek',               label: 'DeepSeek',                   vaultKey: 'HARNESS_DEEPSEEK_KEY',      protocol: 'openai-compatible' },
    { key: 'qwen',                   label: 'Qwen (Alibaba DashScope)',   vaultKey: 'HARNESS_QWEN_KEY',          protocol: 'openai-compatible' },
    { key: 'minimax-payg',           label: 'MiniMax (Pay-as-you-go)',    vaultKey: 'HARNESS_MINIMAX_PAYG_KEY',  protocol: 'openai-compatible' },
    { key: 'gemini-agent-platform',  label: 'Gemini Agent Platform',      vaultKey: 'ORCHESTRATOR_VERTEX_API_KEY', protocol: 'google-genai' },
  ] as const;

  for (const p of NEW_PROVIDERS) {
    it(`tem entry para ${p.key}`, () => {
      expect(PROVIDER_PRESETS[p.key]).toBeDefined();
    });

    it(`${p.key}.label = "${p.label}"`, () => {
      expect(PROVIDER_PRESETS[p.key].label).toBe(p.label);
    });

    it(`${p.key}.vaultKey = "${p.vaultKey}"`, () => {
      expect(PROVIDER_PRESETS[p.key].vaultKey).toBe(p.vaultKey);
    });

    it(`${p.key}.protocol = "${p.protocol}"`, () => {
      expect(PROVIDER_PRESETS[p.key].protocol).toBe(p.protocol);
    });

    it(`${p.key}.requiresApiKey = true`, () => {
      expect(PROVIDER_PRESETS[p.key].requiresApiKey).toBe(true);
    });
  }

  it('gemini-agent-platform NAO tem baseUrl (SDK Google gerencia endpoint internamente)', () => {
    expect(PROVIDER_PRESETS['gemini-agent-platform'].baseUrl).toBeFalsy();
  });

  it('gemini-agent-platform usa o mesmo default do Vertex Gemini do orquestrador', () => {
    expect(PROVIDER_PRESETS['gemini-agent-platform'].defaultModel).toBe(VERTEX_DEFAULT_MODEL);
  });

  it('kimi.baseUrl = "https://api.moonshot.ai/v1"', () => {
    expect(PROVIDER_PRESETS['kimi'].baseUrl).toBe('https://api.moonshot.ai/v1');
  });

  it('deepseek.baseUrl = "https://api.deepseek.com/v1"', () => {
    expect(PROVIDER_PRESETS['deepseek'].baseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('minimax-payg.baseUrl = "https://api.minimax.io/v1"', () => {
    expect(PROVIDER_PRESETS['minimax-payg'].baseUrl).toBe('https://api.minimax.io/v1');
  });
});


describe('MODEL_CATALOG: openai', () => {
  it('tem 2 modelos OpenAI curados', () => {
    expect(MODEL_CATALOG['openai']).toHaveLength(2);
  });

  it('contem gpt-5.5', () => {
    const model = MODEL_CATALOG['openai'].find((m: CatalogedModel) => m.id === 'gpt-5.5');
    expect(model).toBeDefined();
  });

  it('contem gpt-5.5-pro', () => {
    const model = MODEL_CATALOG['openai'].find((m: CatalogedModel) => m.id === 'gpt-5.5-pro');
    expect(model).toBeDefined();
  });

  it('gpt-5.5: supportsTools = true', () => {
    const model = MODEL_CATALOG['openai'].find((m: CatalogedModel) => m.id === 'gpt-5.5');
    expect(model?.supportsTools).toBe(true);
  });

  it('gpt-5.5: contextWindow = 1_000_000', () => {
    const model = MODEL_CATALOG['openai'].find((m: CatalogedModel) => m.id === 'gpt-5.5');
    expect(model?.contextWindow).toBe(1_000_000);
  });

  it('gpt-5.5: pricingKey = "gpt-5.5"', () => {
    const model = MODEL_CATALOG['openai'].find((m: CatalogedModel) => m.id === 'gpt-5.5');
    expect(model?.pricingKey).toBe('gpt-5.5');
  });

  it('gpt-5.5-pro: contextWindow = 1_000_000', () => {
    const model = MODEL_CATALOG['openai'].find((m: CatalogedModel) => m.id === 'gpt-5.5-pro');
    expect(model?.contextWindow).toBe(1_000_000);
  });
});


describe('MODEL_CATALOG: openrouter', () => {
  it('tem 12 modelos OpenRouter curados', () => {
    expect(MODEL_CATALOG['openrouter']).toHaveLength(12);
  });

  const OPENROUTER_MODELS: Array<{ id: string; contextWindow: number; pricingKey: string }> = [
    { id: 'deepseek/deepseek-v4-pro',    contextWindow: 1_000_000, pricingKey: 'or:deepseek/deepseek-v4-pro' },
    { id: 'deepseek/deepseek-v4-flash',  contextWindow: 1_000_000, pricingKey: 'or:deepseek/deepseek-v4-flash' },
    { id: 'moonshotai/kimi-k2.6',        contextWindow: 256_000,   pricingKey: 'or:moonshotai/kimi-k2.6' },
    { id: 'moonshotai/kimi-k2-thinking', contextWindow: 256_000,   pricingKey: 'or:moonshotai/kimi-k2-thinking' },
    { id: 'qwen/qwen3.6-max-preview',    contextWindow: 262_000,   pricingKey: 'or:qwen/qwen3.6-max-preview' },
    { id: 'qwen/qwen3.6-plus',           contextWindow: 262_000,   pricingKey: 'or:qwen/qwen3.6-plus' },
    { id: 'minimax/minimax-m2.7',        contextWindow: 196_608,   pricingKey: 'or:minimax/minimax-m2.7' },
    { id: 'minimax/minimax-m2.5',        contextWindow: 196_608,   pricingKey: 'or:minimax/minimax-m2.5' },
    { id: 'minimax/minimax-m1',          contextWindow: 1_000_000, pricingKey: 'or:minimax/minimax-m1' },
    { id: 'z-ai/glm-4.7',               contextWindow: 202_752,   pricingKey: 'or:z-ai/glm-4.7' },
    { id: 'z-ai/glm-4.7-flash',         contextWindow: 202_752,   pricingKey: 'or:z-ai/glm-4.7-flash' },
  ];

  for (const expected of OPENROUTER_MODELS) {
    it(`contem ${expected.id}`, () => {
      const model = MODEL_CATALOG['openrouter'].find((m: CatalogedModel) => m.id === expected.id);
      expect(model).toBeDefined();
    });

    it(`${expected.id}: contextWindow = ${expected.contextWindow}`, () => {
      const model = MODEL_CATALOG['openrouter'].find((m: CatalogedModel) => m.id === expected.id);
      expect(model?.contextWindow).toBe(expected.contextWindow);
    });

    it(`${expected.id}: pricingKey = "${expected.pricingKey}"`, () => {
      const model = MODEL_CATALOG['openrouter'].find((m: CatalogedModel) => m.id === expected.id);
      expect(model?.pricingKey).toBe(expected.pricingKey);
    });

    it(`${expected.id}: supportsTools = true`, () => {
      const model = MODEL_CATALOG['openrouter'].find((m: CatalogedModel) => m.id === expected.id);
      expect(model?.supportsTools).toBe(true);
    });
  }
});


describe('MODEL_CATALOG: novos providers (SPEC-005)', () => {
  it('tem entry para kimi', () => {
    expect(MODEL_CATALOG['kimi']).toBeDefined();
    expect(MODEL_CATALOG['kimi'].length).toBeGreaterThanOrEqual(1);
  });

  it('tem entry para deepseek', () => {
    expect(MODEL_CATALOG['deepseek']).toBeDefined();
    expect(MODEL_CATALOG['deepseek'].length).toBeGreaterThanOrEqual(1);
  });

  it('tem entry para qwen', () => {
    expect(MODEL_CATALOG['qwen']).toBeDefined();
    expect(MODEL_CATALOG['qwen'].length).toBeGreaterThanOrEqual(1);
  });

  it('tem entry para minimax-payg', () => {
    expect(MODEL_CATALOG['minimax-payg']).toBeDefined();
    expect(MODEL_CATALOG['minimax-payg'].length).toBeGreaterThanOrEqual(1);
  });

  it('tem entry para gemini-agent-platform', () => {
    expect(MODEL_CATALOG['gemini-agent-platform']).toBeDefined();
    expect(MODEL_CATALOG['gemini-agent-platform'].length).toBeGreaterThanOrEqual(1);
  });

  it('gemini-agent-platform espelha o catalogo Vertex Gemini do orquestrador', () => {
    expect(MODEL_CATALOG['gemini-agent-platform'].map((m) => m.id)).toEqual(
      VERTEX_MODEL_CATALOG.map((m) => m.id),
    );
  });

  it('deepseek-chat tem pricingKey nao-null', () => {
    const m = MODEL_CATALOG['deepseek'].find((e: CatalogedModel) => e.id === 'deepseek-chat');
    expect(m).toBeDefined();
    expect(m?.pricingKey).not.toBeNull();
    expect(m?.pricingKey).toBe('deepseek-chat');
  });

  it('deepseek-reasoner tem reasoning: reasoning-content-builtin', () => {
    const m = MODEL_CATALOG['deepseek'].find((e: CatalogedModel) => e.id === 'deepseek-reasoner');
    expect(m?.reasoning?.kind).toBe('reasoning-content-builtin');
  });

  it('minimax-payg expõe os 5 modelos oficiais (M2.7, M2.7-highspeed, M2.5, M2.5-highspeed, M2-her) com pricing confirmado', () => {
    const expected = ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'M2-her'];
    for (const id of expected) {
      const m = MODEL_CATALOG['minimax-payg'].find((e: CatalogedModel) => e.id === id);
      expect(m, `modelo ${id} ausente no catalogo`).toBeDefined();
      expect(m?.pricingKey, `pricingKey de ${id} nao deveria ser null`).not.toBeNull();
    }
  });

  it('kimi-k2-turbo-preview tem pricingKey: null (pricing nao confirmado)', () => {
    const m = MODEL_CATALOG['kimi'].find((e: CatalogedModel) => e.id === 'kimi-k2-turbo-preview');
    expect(m).toBeDefined();
    expect(m?.pricingKey).toBeNull();
  });

  it('todos os modelos novos tem reasoning definido', () => {
    const newProviders = ['kimi', 'deepseek', 'qwen', 'minimax-payg', 'gemini-agent-platform'];
    for (const provider of newProviders) {
      for (const model of MODEL_CATALOG[provider] ?? []) {
        expect(model.reasoning).toBeDefined();
      }
    }
  });
});


describe('MODEL_CATALOG: integridade geral', () => {
  it('total de modelos OpenAI + OpenRouter = 14 (2 OpenAI + 12 OpenRouter)', () => {
    const openaiCount = MODEL_CATALOG['openai']?.length ?? 0;
    const openrouterCount = MODEL_CATALOG['openrouter']?.length ?? 0;
    expect(openaiCount + openrouterCount).toBe(14);
  });

  it('todos os modelos openai/openrouter tem id, label, pricingKey nao-null, supportsTools, contextWindow', () => {
    const allModels = [
      ...(MODEL_CATALOG['openai'] ?? []),
      ...(MODEL_CATALOG['openrouter'] ?? []),
    ];

    for (const model of allModels) {
      expect(model.id).toBeTruthy();
      expect(model.label).toBeTruthy();
      expect(model.pricingKey).not.toBeNull();
      expect(model.pricingKey).toBeTruthy();
      expect(typeof model.supportsTools).toBe('boolean');
      expect(typeof model.contextWindow).toBe('number');
      expect(model.contextWindow).toBeGreaterThan(0);
    }
  });

  it('modelos OpenRouter tem pricingKey com prefixo "or:"', () => {
    for (const model of MODEL_CATALOG['openrouter'] ?? []) {
      expect(model.pricingKey).not.toBeNull();
      expect(typeof model.pricingKey === 'string' && model.pricingKey.startsWith('or:')).toBe(true);
    }
  });

  it('modelos OpenAI NAO tem pricingKey com prefixo "or:"', () => {
    for (const model of MODEL_CATALOG['openai'] ?? []) {
      expect(model.pricingKey).not.toBeNull();
      expect(typeof model.pricingKey === 'string' && !model.pricingKey.startsWith('or:')).toBe(true);
    }
  });

  it('todos os modelos de qualquer provider tem id, label, supportsTools, contextWindow', () => {
    for (const [, models] of Object.entries(MODEL_CATALOG)) {
      for (const model of models) {
        expect(model.id).toBeTruthy();
        expect(model.label).toBeTruthy();
        expect(typeof model.supportsTools).toBe('boolean');
        expect(typeof model.contextWindow).toBe('number');
        expect(model.contextWindow).toBeGreaterThan(0);
      }
    }
  });
});
