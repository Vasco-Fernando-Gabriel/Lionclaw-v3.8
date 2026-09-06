import { describe, expect, it } from 'vitest';
import { pricingCalculate } from '../pricing';

describe('pricingCalculate', () => {
  it('claude opus 4.7 retorna custo positivo', () => {
    const result = pricingCalculate({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(result.costUsd).toBeTypeOf('number');
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeCloseTo(30.0, 4);
  });

  it('claude sonnet 4.6 retorna custo correto (regressao zero)', () => {
    const result = pricingCalculate({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(result.costUsd).toBeCloseTo(18.0, 4);
  });

  it('claude haiku 4.5 retorna custo menor que sonnet', () => {
    const resultHaiku = pricingCalculate({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    const resultSonnet = pricingCalculate({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(resultHaiku.costUsd).toBeTypeOf('number');
    expect(resultHaiku.costUsd!).toBeLessThan(resultSonnet.costUsd!);
  });

  it('codex gpt-5.5 retorna custo positivo', () => {
    const result = pricingCalculate({
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-5.5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(result.costUsd).toBeTypeOf('number');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('codex gpt-5.4-mini retorna custo menor que gpt-5.5', () => {
    const resultMini = pricingCalculate({
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-5.4-mini',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    const resultFull = pricingCalculate({
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-5.5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(resultMini.costUsd!).toBeLessThan(resultFull.costUsd!);
  });

  it('codex gpt-5.3-codex retorna custo positivo', () => {
    const result = pricingCalculate({
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-5.3-codex',
      inputTokens: 500_000,
      outputTokens: 500_000,
    });
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('z.ai glm-4.7 retorna custo positivo', () => {
    const result = pricingCalculate({
      runtime: 'claude-compat-sdk',
      provider: 'zai',
      model: 'glm-4.7',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(result.costUsd).toBeTypeOf('number');
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeCloseTo(2.8, 4);
  });

  it('z.ai glm-4.5-air retorna custo positivo', () => {
    const result = pricingCalculate({
      runtime: 'claude-compat-sdk',
      provider: 'zai',
      model: 'glm-4.5-air',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('preset kimi retorna custo correto para moonshot-v1-32k', () => {
    const result = pricingCalculate({
      runtime: 'lion-sdk',
      provider: 'openai-compatible',
      model: 'moonshot-v1-32k',
      presetId: 'kimi',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(result.costUsd).toBeTypeOf('number');
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeCloseTo(0.48, 4);
  });

  it('preset qwen retorna custo correto para qwen-turbo', () => {
    const result = pricingCalculate({
      runtime: 'lion-sdk',
      provider: 'openai-compatible',
      model: 'qwen-turbo',
      presetId: 'qwen',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeCloseTo(0.8, 4);
  });

  it('preset deepseek retorna custo para deepseek-chat', () => {
    const result = pricingCalculate({
      runtime: 'lion-sdk',
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      presetId: 'deepseek',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('preset minimax retorna custo para minimax-m2', () => {
    const result = pricingCalculate({
      runtime: 'lion-sdk',
      provider: 'openai-compatible',
      model: 'minimax-m2',
      presetId: 'minimax',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('preset conhecido com modelo desconhecido retorna null', () => {
    const result = pricingCalculate({
      runtime: 'lion-sdk',
      provider: 'openai-compatible',
      model: 'unknown-exotic-model',
      presetId: 'qwen',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(result.costUsd).toBeNull();
  });

  it('local ollama retorna costUsd 0', () => {
    const result = pricingCalculate({
      runtime: 'lion-sdk',
      provider: 'ollama',
      model: 'llama3:8b',
      inputTokens: 10_000,
      outputTokens: 10_000,
    });
    expect(result.costUsd).toBe(0);
  });

  it('local lmstudio retorna costUsd 0', () => {
    const result = pricingCalculate({
      runtime: 'lion-sdk',
      provider: 'lmstudio',
      model: 'qwen2.5-7b',
      inputTokens: 10_000,
      outputTokens: 10_000,
    });
    expect(result.costUsd).toBe(0);
  });

  it('custom openai-compat sem pricing retorna null', () => {
    const result = pricingCalculate({
      runtime: 'lion-sdk',
      provider: 'openai-compatible',
      model: 'my-private-model',
      presetId: 'custom',
      inputTokens: 10_000,
      outputTokens: 10_000,
    });
    expect(result.costUsd).toBeNull();
  });

  it('openai-compatible sem presetId usa fallback de calculateCost', () => {
    const result = pricingCalculate({
      runtime: 'lion-sdk',
      provider: 'openai-compatible',
      model: 'some-model',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(result.costUsd).toBeDefined();
  });

  it('claude sonnet com cache tokens calcula corretamente', () => {
    const result = pricingCalculate({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 200_000,
      cacheCreationTokens: 100_000,
    });
    expect(result.costUsd).toBeTypeOf('number');
    expect(result.costUsd!).toBeGreaterThan(0);
  });
});
