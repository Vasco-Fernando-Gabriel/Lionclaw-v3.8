import { describe, it, expect } from 'vitest';
import {
  normalizeUsage,
  canonicalPromptTokens,
  estimateRequestTokens,
  reconcileActiveContext,
  IMAGE_TOKEN_COST,
} from '../agent-runtime/context-measure';

describe('normalizeUsage — shape Anthropic (3 buckets separados, somam)', () => {
  it('input_tokens e UNCACHED; prompt = input + cache_read + cache_creation', () => {
    const u = normalizeUsage(
      {
        input_tokens: 1000,
        cache_read_input_tokens: 40000,
        cache_creation_input_tokens: 500,
        output_tokens: 200,
      },
      'anthropic',
    );
    expect(u.inputTokens).toBe(1000); // uncached, NAO subtrai nada
    expect(u.cacheReadTokens).toBe(40000);
    expect(u.cacheWriteTokens).toBe(500);
    expect(u.outputTokens).toBe(200);
    expect(canonicalPromptTokens(u)).toBe(1000 + 40000 + 500);
  });
});

describe('normalizeUsage — shape OpenAI chat (prompt_tokens JA inclui cache)', () => {
  it('NAO conta cache 2x: input = prompt_tokens - cached (details)', () => {
    const u = normalizeUsage(
      {
        prompt_tokens: 50000, // JA inclui os 12000 cacheados
        completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 12000 },
      },
      'openai-chat',
    );
    expect(u.cacheReadTokens).toBe(12000);
    expect(u.inputTokens).toBe(50000 - 12000);
    expect(canonicalPromptTokens(u)).toBe(50000);
    expect(u.outputTokens).toBe(300);
  });

  it('fallback top-level estilo Anthropic (proxies OpenAI-compat com modelo Claude)', () => {
    const u = normalizeUsage(
      {
        prompt_tokens: 80000,
        completion_tokens: 100,
        cache_read_input_tokens: 20000,
        cache_creation_input_tokens: 5000,
      },
      'openai-chat',
    );
    expect(u.cacheReadTokens).toBe(20000);
    expect(u.cacheWriteTokens).toBe(5000);
    expect(u.inputTokens).toBe(80000 - 20000 - 5000);
    expect(canonicalPromptTokens(u)).toBe(80000);
  });

  it('reasoning_tokens NAO entram no prompt (ocupam janela? nao — #12026)', () => {
    const u = normalizeUsage(
      {
        prompt_tokens: 30000,
        completion_tokens: 4000,
        output_tokens_details: { reasoning_tokens: 3500 },
      },
      'openai-chat',
    );
    expect(u.reasoningTokens).toBe(3500);
    expect(canonicalPromptTokens(u)).toBe(30000); // reasoning fora
  });
});

describe('normalizeUsage — shape Codex (input_tokens JA inclui cache)', () => {
  it('input = input_tokens - cachedInputTokens (nao dobra cache); prompt = input_total', () => {
    const u = normalizeUsage(
      { inputTokens: 150000, cachedInputTokens: 90000, outputTokens: 400 },
      'codex',
    );
    expect(u.cacheReadTokens).toBe(90000);
    expect(u.inputTokens).toBe(150000 - 90000);
    expect(u.cacheWriteTokens).toBe(0); // app-server nao expoe cache-write
    expect(canonicalPromptTokens(u)).toBe(150000); // volta ao total, sem dobrar
  });
});

describe('estimateRequestTokens — PISO universal (Hermes estimate_request_tokens_rough)', () => {
  it('soma system + mensagens + tool schemas (char/4)', () => {
    const est = estimateRequestTokens({
      systemPrompt: 'x'.repeat(4000), // 1000 tokens
      messageTexts: ['y'.repeat(8000), 'z'.repeat(400)], // 2000 + 100
      toolSchemasJson: 'w'.repeat(80000), // 20000 tokens (50+ tools blind spot)
    });
    expect(est).toBe(1000 + 2000 + 100 + 20000);
  });

  it('imagem = custo FLAT ~1500 (NAO os bytes base64)', () => {
    const est = estimateRequestTokens({ messageTexts: ['oi'], imageCount: 2 });
    expect(est).toBe(1 + 2 * IMAGE_TOKEN_COST);
  });

  it('tool schemas ausentes = 0 (nao explode)', () => {
    expect(estimateRequestTokens({ messageTexts: [] })).toBe(0);
  });
});

describe('reconcileActiveContext — usage_real>0 ? real : estimativa (#2153)', () => {
  it('usa o usage REAL (prompt+output da ultima request) quando presente', () => {
    expect(reconcileActiveContext(50855, 161, 42)).toBe(50855 + 161);
  });

  it('cai no PISO estimado quando NAO ha usage (pos-disconnect)', () => {
    expect(reconcileActiveContext(0, 0, 128000)).toBe(128000);
  });

  it('o real vence mesmo se a estimativa for maior (real e autoritativo)', () => {
    expect(reconcileActiveContext(90000, 500, 200000)).toBe(90500);
  });

  it('nunca negativo; piso e output floorados', () => {
    expect(reconcileActiveContext(-5, -5, -10)).toBe(0);
  });
});
