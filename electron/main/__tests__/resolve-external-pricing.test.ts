
import { describe, it, expect, vi } from 'vitest';


vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../ollama-client', () => ({
  ollamaChatWithTools: vi.fn(),
}));

vi.mock('../vault-registry', () => ({
  getSecret: vi.fn().mockResolvedValue(null),
}));


import { resolveExternalPricing, computePricingKey } from '../agent-runtime/external-http';
import type { ExternalConfig } from '../../../src/types';


function makeExtCfg(overrides: Partial<ExternalConfig>): ExternalConfig {
  return {
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-pro',
    apiKeyRef: 'HARNESS_OPENROUTER_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    ...overrides,
  };
}


describe('resolveExternalPricing - legacy providers (always known)', () => {
  it('openrouter: returns { status: known, pricingKey: or:<model> }', () => {
    const cfg = makeExtCfg({ provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' });
    const result = resolveExternalPricing(cfg);
    expect(result.status).toBe('known');
    expect(result.pricingKey).toBe('or:deepseek/deepseek-v4-pro');
  });

  it('openai: returns { status: known, pricingKey: <model> }', () => {
    const cfg = makeExtCfg({ provider: 'openai', model: 'gpt-5.5', baseUrl: 'https://api.openai.com/v1' });
    const result = resolveExternalPricing(cfg);
    expect(result.status).toBe('known');
    expect(result.pricingKey).toBe('gpt-5.5');
  });

  it('openai-compatible (Custom): returns { status: known, pricingKey: <model> }', () => {
    const cfg = makeExtCfg({ provider: 'openai-compatible', model: 'my-custom-model', baseUrl: 'https://my-endpoint.example.com/v1' });
    const result = resolveExternalPricing(cfg);
    expect(result.status).toBe('known');
    expect(result.pricingKey).toBe('my-custom-model');
  });

  it('openrouter pricingKey matches computePricingKey output', () => {
    const cfg = makeExtCfg({ provider: 'openrouter', model: 'moonshotai/kimi-k2.6' });
    const result = resolveExternalPricing(cfg);
    expect(result.status).toBe('known');
    expect(result.pricingKey).toBe(computePricingKey(cfg));
  });
});


describe('resolveExternalPricing - new providers with known pricing', () => {
  it('deepseek + deepseek-chat: returns { status: known, pricingKey: deepseek-chat }', () => {
    const cfg = makeExtCfg({
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyRef: 'HARNESS_DEEPSEEK_KEY',
    });
    const result = resolveExternalPricing(cfg);
    expect(result.status).toBe('known');
    expect(result.pricingKey).toBe('deepseek-chat');
  });

  it('deepseek + deepseek-reasoner: returns { status: known, pricingKey: deepseek-reasoner }', () => {
    const cfg = makeExtCfg({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyRef: 'HARNESS_DEEPSEEK_KEY',
    });
    const result = resolveExternalPricing(cfg);
    expect(result.status).toBe('known');
    expect(result.pricingKey).toBe('deepseek-reasoner');
  });

  it('qwen + qwen3-max: returns { status: known, pricingKey: qwen3-max }', () => {
    const cfg = makeExtCfg({
      provider: 'qwen',
      model: 'qwen3-max',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      apiKeyRef: 'HARNESS_QWEN_KEY',
    });
    const result = resolveExternalPricing(cfg);
    expect(result.status).toBe('known');
    expect(result.pricingKey).toBe('qwen3-max');
  });

  it('minimax-payg + MiniMax-M2.7: returns { status: known, pricingKey: minimax-m2.7 }', () => {
    const cfg = makeExtCfg({
      provider: 'minimax-payg',
      model: 'MiniMax-M2.7',
      baseUrl: 'https://api.minimax.io/v1',
      apiKeyRef: 'HARNESS_MINIMAX_PAYG_KEY',
    });
    const result = resolveExternalPricing(cfg);
    expect(result.status).toBe('known');
    expect(result.pricingKey).toBe('minimax-m2.7');
  });

  it('minimax-payg + M2-her: returns { status: known, pricingKey: m2-her }', () => {
    const cfg = makeExtCfg({
      provider: 'minimax-payg',
      model: 'M2-her',
      baseUrl: 'https://api.minimax.io/v1',
      apiKeyRef: 'HARNESS_MINIMAX_PAYG_KEY',
    });
    const result = resolveExternalPricing(cfg);
    expect(result.status).toBe('known');
    expect(result.pricingKey).toBe('m2-her');
  });
});


describe('resolveExternalPricing - new providers with pricingKey: null', () => {
  it('minimax-payg + MiniMax-Text-01: returns { status: unknown, pricingKey: null }', () => {
    const cfg = makeExtCfg({
      provider: 'minimax-payg',
      model: 'MiniMax-Text-01',
      baseUrl: 'https://api.minimax.io/v1',
      apiKeyRef: 'HARNESS_MINIMAX_PAYG_KEY',
    });
    const result = resolveExternalPricing(cfg);
    expect(result.status).toBe('unknown');
    expect(result.pricingKey).toBeNull();
  });

  it('kimi + kimi-k2-turbo-preview: returns { status: unknown, pricingKey: null }', () => {
    const cfg = makeExtCfg({
      provider: 'kimi',
      model: 'kimi-k2-turbo-preview',
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKeyRef: 'HARNESS_KIMI_KEY',
    });
    const result = resolveExternalPricing(cfg);
    expect(result.status).toBe('unknown');
    expect(result.pricingKey).toBeNull();
  });

  it('gemini-agent-platform + gemini-2.5-pro-preview-05-06: returns { status: unknown, pricingKey: null }', () => {
    const cfg = makeExtCfg({
      provider: 'gemini-agent-platform',
      model: 'gemini-2.5-pro-preview-05-06',
      apiKeyRef: 'orchestrator_vertex_api_key_ref',
    });
    const result = resolveExternalPricing(cfg);
    expect(result.status).toBe('unknown');
    expect(result.pricingKey).toBeNull();
  });

  it('qwen + qwen3-coder: returns { status: unknown, pricingKey: null }', () => {
    const cfg = makeExtCfg({
      provider: 'qwen',
      model: 'qwen3-coder',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      apiKeyRef: 'HARNESS_QWEN_KEY',
    });
    const result = resolveExternalPricing(cfg);
    expect(result.status).toBe('unknown');
    expect(result.pricingKey).toBeNull();
  });
});


describe('resolveExternalPricing - model not in catalog', () => {
  it('kimi + unknown-model: returns { status: unknown, pricingKey: null }', () => {
    const cfg = makeExtCfg({
      provider: 'kimi',
      model: 'kimi-v99-does-not-exist',
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKeyRef: 'HARNESS_KIMI_KEY',
    });
    const result = resolveExternalPricing(cfg);
    expect(result.status).toBe('unknown');
    expect(result.pricingKey).toBeNull();
  });

  it('deepseek + unknown-model: returns { status: unknown, pricingKey: null }', () => {
    const cfg = makeExtCfg({
      provider: 'deepseek',
      model: 'deepseek-v99-not-in-catalog',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyRef: 'HARNESS_DEEPSEEK_KEY',
    });
    const result = resolveExternalPricing(cfg);
    expect(result.status).toBe('unknown');
    expect(result.pricingKey).toBeNull();
  });
});
