import { describe, it, expect } from 'vitest';

import {
  CODEX_MODELS,
  CODEX_DEFAULT_MODEL,
  staticEffortsFor,
  codexModelRequiresOfficial,
  isKnownStaticCodexModel,
} from '../../../src/constants/codex-models';
import { MODEL_CATALOG, PROVIDER_PRESETS } from '../../../src/lib/provider-presets';
import { formatModelLabel } from '../../../src/utils/model-display';
import { MODEL_PRICING, calculateCost } from '../pricing';
import { getContextWindow } from '../agent-runtime/model-context-windows';
import { mapReasoningParams } from '../agent-runtime/external-http';
import { dynamicWorkflowCoderCodex } from '../seed-agents/dynamic-workflow-coder-codex';

describe('GPT-6 Sol e Luna — catalogo Codex', () => {
  it('gpt-6-sol e gpt-6-luna estao em CODEX_MODELS; Sol antes de Astra; nao existe gpt-6-terra', () => {
    const slugs = CODEX_MODELS.map((m) => m.slug);
    expect(slugs.indexOf('gpt-6-sol')).toBe(0);
    expect(slugs.indexOf('gpt-6-astra')).toBe(1);
    expect(slugs.indexOf('gpt-6-luna')).toBe(2);
    expect(slugs).not.toContain('gpt-6-terra');
  });

  it('gpt-6-sol e o CODEX_DEFAULT_MODEL e o modelo do seed coder-codex', () => {
    expect(CODEX_DEFAULT_MODEL).toBe('gpt-6-sol');
    expect(dynamicWorkflowCoderCodex.model).toBe('gpt-6-sol');
    expect(dynamicWorkflowCoderCodex.codexConfig?.model).toBe('gpt-6-sol');
  });

  it('efforts: Sol ate ultra, Luna ate max; ambos exigem o driver oficial', () => {
    expect([...staticEffortsFor('gpt-6-sol')]).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect([...staticEffortsFor('gpt-6-luna')]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(isKnownStaticCodexModel('gpt-6-luna')).toBe(true);
    expect(codexModelRequiresOfficial('gpt-6-sol')).toBe(true);
    expect(codexModelRequiresOfficial('gpt-6-luna')).toBe(true);
  });

  it('gpt-5.6-* continuam no catalogo (sem data de retirada)', () => {
    const slugs = CODEX_MODELS.map((m) => m.slug);
    expect(slugs).toEqual(expect.arrayContaining(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']));
  });
});

describe('GPT-6 Sol e Luna — pricing e janela', () => {
  it('Sol $2/$10, Luna $0.10/$0.50, cache read a 10%, long-context acima de 272K', () => {
    expect(MODEL_PRICING['gpt-6-sol']).toMatchObject({ input: 2.0, output: 10.0, cacheRead: 0.2 });
    expect(MODEL_PRICING['gpt-6-luna']).toMatchObject({ input: 0.1, output: 0.5, cacheRead: 0.01 });
    expect(MODEL_PRICING['gpt-6-sol'].longContext).toBeDefined();
    expect(MODEL_PRICING['gpt-6-luna'].longContext).toBeDefined();
  });

  it('tabela oficial dos gpt-5.6: Sol $4/$20, Terra $2/$12, Luna $0.20/$1.20', () => {
    expect(MODEL_PRICING['gpt-5.6-sol']).toMatchObject({ input: 4.0, output: 20.0, cacheRead: 0.4 });
    expect(MODEL_PRICING['gpt-5.6-terra']).toMatchObject({ input: 2.0, output: 12.0, cacheRead: 0.2 });
    expect(MODEL_PRICING['gpt-5.6-luna']).toMatchObject({ input: 0.2, output: 1.2, cacheRead: 0.02 });
  });

  it('calculateCost de 1M in + 1M out: Sol $12, Luna $0.60', () => {
    expect(calculateCost('gpt-6-sol', 1_000_000, 1_000_000, 0, 0)).toBeCloseTo(12, 4);
    expect(calculateCost('gpt-6-luna', 1_000_000, 1_000_000, 0, 0)).toBeCloseTo(0.6, 4);
  });

  it('janela de 1.05M para os dois', () => {
    expect(getContextWindow('gpt-6-sol', 'codex')).toBe(1_050_000);
    expect(getContextWindow('gpt-6-luna', 'codex')).toBe(1_050_000);
  });
});

describe('GPT-6 Sol e Luna — runtime external (OpenAI direto e OpenRouter)', () => {
  it('catalogo OpenAI lista os dois e o default do preset e gpt-6-sol', () => {
    const ids = MODEL_CATALOG.openai.map((m) => m.id);
    expect(ids.slice(0, 2)).toEqual(['gpt-6-sol', 'gpt-6-luna']);
    expect(PROVIDER_PRESETS.openai.defaultModel).toBe('gpt-6-sol');
  });

  it('catalogo OpenRouter lista openai/gpt-6-sol e openai/gpt-6-luna com pricingKey or:', () => {
    for (const id of ['openai/gpt-6-sol', 'openai/gpt-6-luna']) {
      const entry = MODEL_CATALOG.openrouter.find((m) => m.id === id);
      expect(entry?.pricingKey).toBe(`or:${id}`);
      expect(MODEL_PRICING[`or:${id}`]).toBeDefined();
    }
  });

  it('mapReasoningParams envia reasoning_effort para gpt-6 na OpenAI e no OpenRouter', () => {
    expect(mapReasoningParams('high', undefined, undefined, 'openai', 'gpt-6-sol')).toEqual({
      reasoning_effort: 'high',
    });
    expect(mapReasoningParams('low', undefined, undefined, 'openrouter', 'openai/gpt-6-luna')).toEqual({
      reasoning_effort: 'low',
    });
    expect(mapReasoningParams('high', 'disabled', undefined, 'openai', 'gpt-6-sol')).toEqual({});
  });

  it('display: "GPT-6 Sol" e "GPT-6 Luna" via OpenRouter', () => {
    expect(formatModelLabel('openai/gpt-6-sol')).toBe('GPT-6 Sol');
    expect(formatModelLabel('openai/gpt-6-luna')).toBe('GPT-6 Luna');
  });
});
