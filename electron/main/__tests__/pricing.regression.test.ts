
import { describe, it, expect } from 'vitest';
import { calculateCost, hasKnownPricing, MODEL_PRICING, PRESET_MODEL_PRICING, pricingCalculate } from '../pricing';
import { VERTEX_MODEL_CATALOG } from '../../../src/constants/vertex-gemini-models';


function costFor(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheRead = 0,
  cacheCreation = 0,
): number {
  return calculateCost(model, inputTokens, outputTokens, cacheRead, cacheCreation);
}


describe('pricing.regression: modelos Claude conhecidos', () => {
  const CLAUDE_SNAPSHOTS: Array<{
    model: string;
    inputRate: number;
    outputRate: number;
    cacheReadRate: number;
    cacheCreationRate: number;
  }> = [
    { model: 'sonnet',  inputRate: 3.00, outputRate: 15.00, cacheReadRate: 0.30, cacheCreationRate: 3.75 },
    { model: 'opus',    inputRate: 5.00, outputRate: 25.00, cacheReadRate: 0.50, cacheCreationRate: 6.25 },
    { model: 'haiku',   inputRate: 1.00, outputRate: 5.00,  cacheReadRate: 0.10, cacheCreationRate: 1.25 },
    { model: 'claude-opus-4-8',           inputRate: 5.00,  outputRate: 25.00, cacheReadRate: 0.50, cacheCreationRate: 6.25 },
    { model: 'claude-opus-4-7',           inputRate: 5.00,  outputRate: 25.00, cacheReadRate: 0.50, cacheCreationRate: 6.25 },
    { model: 'claude-sonnet-4-6',         inputRate: 3.00,  outputRate: 15.00, cacheReadRate: 0.30, cacheCreationRate: 3.75 },
    { model: 'claude-haiku-4-5-20251001', inputRate: 1.00,  outputRate: 5.00,  cacheReadRate: 0.10, cacheCreationRate: 1.25 },
    { model: 'claude-sonnet-4-5-20250514',inputRate: 3.00,  outputRate: 15.00, cacheReadRate: 0.30, cacheCreationRate: 3.75 },
    { model: 'claude-sonnet-4-0-20250514',inputRate: 3.00,  outputRate: 15.00, cacheReadRate: 0.30, cacheCreationRate: 3.75 },
    { model: 'claude-opus-4-0-20250514',  inputRate: 15.00, outputRate: 75.00, cacheReadRate: 1.50, cacheCreationRate: 18.75 },
    { model: 'claude-haiku-3-5-20241022', inputRate: 0.80,  outputRate: 4.00,  cacheReadRate: 0.08, cacheCreationRate: 1.00 },
  ];

  for (const snap of CLAUDE_SNAPSHOTS) {
    it(`${snap.model}: input rate = $${snap.inputRate}/1M`, () => {
      const cost = costFor(snap.model, 1_000_000, 0, 0, 0);
      expect(cost).toBeCloseTo(snap.inputRate, 4);
    });

    it(`${snap.model}: output rate = $${snap.outputRate}/1M`, () => {
      const cost = costFor(snap.model, 0, 1_000_000, 0, 0);
      expect(cost).toBeCloseTo(snap.outputRate, 4);
    });

    it(`${snap.model}: cacheRead rate = $${snap.cacheReadRate}/1M`, () => {
      const cost = costFor(snap.model, 1_000_000, 0, 1_000_000, 0);
      expect(cost).toBeCloseTo(snap.cacheReadRate, 4);
    });

    it(`${snap.model}: cacheCreation rate = $${snap.cacheCreationRate}/1M`, () => {
      const cost = costFor(snap.model, 1_000_000, 0, 0, 1_000_000);
      expect(cost).toBeCloseTo(snap.cacheCreationRate, 4);
    });
  }
});


describe('pricing.regression: fallback Claude por keyword', () => {
  it('modelo com "opus" no slug retorna pricing opus', () => {
    const cost = costFor('claude-experimental-opus-2026-12-01', 1_000_000, 0);
    expect(cost).toBeCloseTo(5.00, 4);
  });

  it('modelo com "haiku" no slug retorna pricing haiku', () => {
    const cost = costFor('claude-haiku-future-edition', 1_000_000, 0);
    expect(cost).toBeCloseTo(1.00, 4);
  });

  it('modelo com "sonnet" no slug retorna pricing sonnet', () => {
    const cost = costFor('claude-sonnet-future-edition', 1_000_000, 0);
    expect(cost).toBeCloseTo(3.00, 4);
  });

  it('modelo com "claude" no slug (sem opus/haiku/sonnet) retorna pricing sonnet', () => {
    const cost = costFor('claude-experimental-2026-12-01', 1_000_000, 0);
    expect(cost).toBeCloseTo(3.00, 4);
  });

  it('modelo completamente desconhecido retorna custo zero', () => {
    const cost = costFor('unknown-llm-model-xyz', 1_000_000, 1_000_000);
    expect(cost).toBe(0);
  });
});


describe('hasKnownPricing', () => {
  it('retorna true para modelos Claude mapeados diretamente', () => {
    expect(hasKnownPricing('claude-sonnet-4-6')).toBe(true);
    expect(hasKnownPricing('claude-opus-4-8')).toBe(true);
    expect(hasKnownPricing('claude-opus-4-7')).toBe(true);
    expect(hasKnownPricing('claude-haiku-4-5-20251001')).toBe(true);
    expect(hasKnownPricing('sonnet')).toBe(true);
    expect(hasKnownPricing('opus')).toBe(true);
    expect(hasKnownPricing('haiku')).toBe(true);
  });

  it('retorna true para Claude via fallback keyword', () => {
    expect(hasKnownPricing('claude-experimental-2026-12-01')).toBe(true);
    expect(hasKnownPricing('some-new-claude-opus-model')).toBe(true);
  });

  it('retorna false para modelo desconhecido sem keyword Claude', () => {
    expect(hasKnownPricing('unknown-model-xyz')).toBe(false);
    expect(hasKnownPricing('gpt-999')).toBe(false);
    expect(hasKnownPricing('llama-4-ultra')).toBe(false);
  });

  it('retorna true para OpenAI mapeados (gpt-5.5)', () => {
    expect(hasKnownPricing('gpt-5.5')).toBe(true);
    expect(hasKnownPricing('gpt-5.5-pro')).toBe(true);
  });

  it('retorna true para modelos OpenRouter com prefixo or:', () => {
    expect(hasKnownPricing('or:deepseek/deepseek-v4-pro')).toBe(true);
    expect(hasKnownPricing('or:moonshotai/kimi-k2.6')).toBe(true);
  });
});


describe('pricing: modelos OpenRouter (prefixo or:)', () => {
  const OR_SNAPSHOTS: Array<{ key: string; input: number; output: number }> = [
    { key: 'or:deepseek/deepseek-v4-pro',    input: 0.435,  output: 0.87  },
    { key: 'or:deepseek/deepseek-v4-flash',  input: 0.14,   output: 0.28  },
    { key: 'or:moonshotai/kimi-k2.6',        input: 0.7448, output: 4.655 },
    { key: 'or:moonshotai/kimi-k2-thinking', input: 0.60,   output: 2.50  },
    { key: 'or:qwen/qwen3.6-max-preview',    input: 1.04,   output: 6.24  },
    { key: 'or:qwen/qwen3.6-plus',           input: 0.325,  output: 1.95  },
    { key: 'or:minimax/minimax-m2.7',        input: 0.30,   output: 1.20  },
    { key: 'or:minimax/minimax-m1',          input: 0.40,   output: 2.20  },
    { key: 'or:anthropic/claude-sonnet-4-5', input: 3.00,  output: 15.00 },
    { key: 'or:anthropic/claude-opus-4',     input: 15.00, output: 75.00 },
    { key: 'or:anthropic/claude-haiku-4-5',  input: 1.00,  output: 5.00  },
  ];

  for (const snap of OR_SNAPSHOTS) {
    it(`${snap.key}: input = $${snap.input}/1M`, () => {
      const cost = calculateCost(snap.key, 1_000_000, 0);
      expect(cost).toBeCloseTo(snap.input, 4);
    });

    it(`${snap.key}: output = $${snap.output}/1M`, () => {
      const cost = calculateCost(snap.key, 0, 1_000_000);
      expect(cost).toBeCloseTo(snap.output, 4);
    });
  }
});


describe('pricing: modelos OpenAI direto', () => {
  it('gpt-5.5: input = $5/1M', () => {
    expect(calculateCost('gpt-5.5', 1_000_000, 0)).toBeCloseTo(5.00, 4);
  });

  it('gpt-5.5: output = $30/1M', () => {
    expect(calculateCost('gpt-5.5', 0, 1_000_000)).toBeCloseTo(30.00, 4);
  });

  it('gpt-5.5: cacheRead = $0.50/1M', () => {
    expect(calculateCost('gpt-5.5', 1_000_000, 0, 1_000_000, 0)).toBeCloseTo(0.50, 4);
  });

  it('gpt-5.5-pro: input = $30/1M', () => {
    expect(calculateCost('gpt-5.5-pro', 1_000_000, 0)).toBeCloseTo(30.00, 4);
  });

  it('gpt-5.5-pro: output = $180/1M', () => {
    expect(calculateCost('gpt-5.5-pro', 0, 1_000_000)).toBeCloseTo(180.00, 4);
  });
});


describe('pricing: integridade de MODEL_PRICING', () => {
  const REQUIRED_CLAUDE_KEYS = [
    'sonnet',
    'opus',
    'haiku',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5-20250514',
    'claude-sonnet-4-0-20250514',
    'claude-opus-4-0-20250514',
    'claude-haiku-3-5-20241022',
  ];

  for (const key of REQUIRED_CLAUDE_KEYS) {
    it(`MODEL_PRICING tem entrada para "${key}"`, () => {
      expect(MODEL_PRICING[key]).toBeDefined();
      expect(typeof MODEL_PRICING[key].input).toBe('number');
      expect(typeof MODEL_PRICING[key].output).toBe('number');
      expect(MODEL_PRICING[key].input).toBeGreaterThan(0);
      expect(MODEL_PRICING[key].output).toBeGreaterThan(0);
    });
  }

  it('MODEL_PRICING tem entrada para gpt-5.5', () => {
    expect(MODEL_PRICING['gpt-5.5']).toBeDefined();
  });

  it('MODEL_PRICING tem entrada para gpt-5.5-pro', () => {
    expect(MODEL_PRICING['gpt-5.5-pro']).toBeDefined();
  });

  it('MODEL_PRICING tem 8 entradas OpenRouter com prefixo or:', () => {
    const orKeys = Object.keys(MODEL_PRICING).filter(k => k.startsWith('or:'));
    expect(orKeys.length).toBeGreaterThanOrEqual(8);
  });
});


describe('pricing: calculo composto', () => {
  it('sonnet: 500k input puro + 200k cacheRead + 300k cacheCreation + 100k output', () => {
    const cost = calculateCost('claude-sonnet-4-6', 1_000_000, 100_000, 200_000, 300_000);
    expect(cost).toBeCloseTo(4.185, 4);
  });

  it('calculo sem cache usa totalInput como pureInput', () => {
    const costWithCache = calculateCost('sonnet', 1_000_000, 0, 0, 0);
    const costWithoutCache = calculateCost('sonnet', 1_000_000, 0);
    expect(costWithCache).toBeCloseTo(costWithoutCache, 6);
  });
});


describe('pricing.regression: Vertex Gemini (SPEC-003 §12.2)', () => {
  it.each(VERTEX_MODEL_CATALOG.map((m) => m.id))(
    'pricingCalculate retorna { costUsd: null } para %s (unknown pricing)',
    (modelId) => {
      const result = pricingCalculate({
        runtime: 'lion-sdk',
        provider: 'vertex-ai',
        model: modelId,
        inputTokens: 100,
        outputTokens: 200,
      });
      expect(result).toEqual({ costUsd: null });
    },
  );

  it('Vertex Gemini com modelo arbitrario retorna { costUsd: null } (nunca $0)', () => {
    const result = pricingCalculate({
      runtime: 'lion-sdk',
      provider: 'vertex-ai',
      model: 'gemini-future-3.5-pro',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    expect(result).toEqual({ costUsd: null });
    expect(result.costUsd).not.toBe(0);
  });

  it('Vertex Gemini branch vem ANTES do fallthrough calculateCost', () => {
    expect(MODEL_PRICING['gemini-3-flash-preview']).toBeUndefined();
    const result = pricingCalculate({
      runtime: 'lion-sdk',
      provider: 'vertex-ai',
      model: 'gemini-3-flash-preview',
      inputTokens: 100,
      outputTokens: 100,
    });
    expect(result).toEqual({ costUsd: null });
  });

  it('R2 — outros providers nao foram afetados (claude-sdk continua calculando)', () => {
    const result = pricingCalculate({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'sonnet',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(result.costUsd).toBeCloseTo(3.0, 6);
  });

  it('R2 — local providers (ollama) continuam retornando $0', () => {
    const result = pricingCalculate({
      runtime: 'lion-sdk',
      provider: 'ollama',
      model: 'llama3.1:8b',
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(result.costUsd).toBe(0);
  });
});


describe('pricing: SPEC-004 MiniMax Token Plan (MODEL_PRICING top-level)', () => {

  it('MODEL_PRICING tem entrada para minimax-m2.7 (lowercase)', () => {
    expect(MODEL_PRICING['minimax-m2.7']).toEqual({
      input: 0.30,
      output: 1.20,
      cacheRead: 0.06,
      cacheCreation: 0.375,
    });
  });

  it('MODEL_PRICING tem entrada para minimax-m2.7-highspeed (lowercase)', () => {
    expect(MODEL_PRICING['minimax-m2.7-highspeed']).toEqual({
      input: 0.60,
      output: 2.40,
      cacheRead: 0.06,
      cacheCreation: 0.375,
    });
  });

  it('MODEL_PRICING tem entrada para minimax-m2.5 (lowercase)', () => {
    expect(MODEL_PRICING['minimax-m2.5']).toEqual({
      input: 0.30,
      output: 1.20,
      cacheRead: 0.03,
      cacheCreation: 0.375,
    });
  });

  it('MODEL_PRICING tem entrada para minimax-m2.5-highspeed (lowercase)', () => {
    expect(MODEL_PRICING['minimax-m2.5-highspeed']).toEqual({
      input: 0.60,
      output: 2.40,
      cacheRead: 0.03,
      cacheCreation: 0.375,
    });
  });

  it('calculateCost(MiniMax-M2.7, 1M, 1M) retorna 1.50 (case-insensitive via toLowerCase)', () => {
    const cost = calculateCost('MiniMax-M2.7', 1_000_000, 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(1.50, 4);
  });

  it('calculateCost e case-insensitive: CamelCase e lowercase retornam o mesmo valor', () => {
    const costCamel = calculateCost('MiniMax-M2.7', 1_000_000, 1_000_000, 0, 0);
    const costLower = calculateCost('minimax-m2.7', 1_000_000, 1_000_000, 0, 0);
    expect(costCamel).toBeCloseTo(costLower, 6);
    expect(costCamel).toBeCloseTo(1.50, 4);
  });

  it('formula manual sobre MODEL_PRICING[minimax-m2.7] retorna 1.50 para 1M input + 1M output', () => {
    const p = MODEL_PRICING['minimax-m2.7'];
    const cost = (1_000_000 / 1_000_000) * p.input + (1_000_000 / 1_000_000) * p.output;
    expect(cost).toBeCloseTo(1.50, 4);
  });

  it('PRESET_MODEL_PRICING.minimax inclui MiniMax-M3 (pay-as-you-go) + entries originais', () => {
    expect(PRESET_MODEL_PRICING.minimax).toBeDefined();
    const keys = Object.keys(PRESET_MODEL_PRICING.minimax);
    expect(keys.length).toBe(5);
    expect(keys.sort()).toEqual(
      ['MiniMax-M3', 'MiniMax-Text-01', 'abab6.5g-chat', 'abab6.5s-chat', 'minimax-m2'].sort(),
    );
    expect(PRESET_MODEL_PRICING.minimax['MiniMax-M3']).toEqual({
      input: 0.60,
      output: 2.40,
      cacheRead: 0.12,
      cacheCreation: 0,
    });
    expect(PRESET_MODEL_PRICING.minimax['MiniMax-Text-01']).toEqual({
      input: 0.40,
      output: 2.20,
      cacheRead: 0,
      cacheCreation: 0,
    });
    expect(PRESET_MODEL_PRICING.minimax['abab6.5s-chat']).toEqual({
      input: 0.10,
      output: 0.10,
      cacheRead: 0,
      cacheCreation: 0,
    });
    expect(PRESET_MODEL_PRICING.minimax['abab6.5g-chat']).toEqual({
      input: 0.15,
      output: 0.15,
      cacheRead: 0,
      cacheCreation: 0,
    });
    expect(PRESET_MODEL_PRICING.minimax['minimax-m2']).toEqual({
      input: 0.30,
      output: 1.20,
      cacheRead: 0.059,
      cacheCreation: 0,
    });
  });
});
