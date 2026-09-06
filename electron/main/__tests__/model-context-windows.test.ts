
import { describe, it, expect, afterEach } from 'vitest';
import {
  getContextWindow,
  setProbedContextWindows,
  clearProbedContextWindows,
  CTX_GPT_5_2_UNCONFIRMED,
  CTX_GLM_5_TURBO_UNCONFIRMED,
  CTX_GLM_4_5_AIR_UNCONFIRMED,
} from '../agent-runtime/model-context-windows';
import { getModelContextWindow } from '../pricing';

afterEach(() => {
  clearProbedContextWindows();
});

describe('SA-1 — fonte unica de context window (D4, D5)', () => {
  describe('AC-A1: getContextWindow retorna os valores da SPEC 0.5', () => {
    it('AC-A1: Claude — valores F1 preservados (Fable/Opus/Sonnet 1M; Haiku 200k)', () => {
      expect(getContextWindow('claude-fable-5-1')).toBe(1_000_000);
      expect(getContextWindow('claude-fable-5')).toBe(1_000_000);
      expect(getContextWindow('claude-opus-4-8')).toBe(1_000_000);
      expect(getContextWindow('claude-sonnet-4-6')).toBe(1_000_000);
      expect(getContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
      expect(getContextWindow('opus')).toBe(1_000_000);
    });

    it('AC-A1: Claude — fallback por keyword da familia preservado (200k)', () => {
      expect(getContextWindow('claude-modelo-futuro-desconhecido')).toBe(200_000);
      expect(getContextWindow('algum-sonnet-novo')).toBe(200_000);
    });

    it('AC-A1: Codex — janela REAL 1.05M (nao 272K, que era preco); mini 400K', () => {
      expect(getContextWindow('gpt-5.5')).toBe(1_050_000);
      expect(getContextWindow('gpt-5.5-pro')).toBe(1_050_000);
      expect(getContextWindow('gpt-5.4')).toBe(1_050_000);
      expect(getContextWindow('gpt-5.4-mini')).toBe(400_000);
      expect(getContextWindow('gpt-5.3-codex')).toBe(1_050_000);
    });

    it('AC-A1: GLM — 5.2 = 1M, 5.1 = 200K, 4.7 = 202.752', () => {
      expect(getContextWindow('glm-5.2')).toBe(1_000_000);
      expect(getContextWindow('glm-5.1')).toBe(200_000);
      expect(getContextWindow('glm-4.7')).toBe(202_752);
    });

    it('AC-A1: Kimi — 262.144 exato ("256K" e arredondamento)', () => {
      expect(getContextWindow('kimi-code/kimi-for-coding')).toBe(262_144);
      expect(getContextWindow('kimi-k2.6')).toBe(262_144);
    });

    it('AC-A1: MiniMax — M2.x = 204.800 (corrige o 196.608 errado); M3 = 1M', () => {
      expect(getContextWindow('MiniMax-M2.7')).toBe(204_800);
      expect(getContextWindow('MiniMax-M2.7-highspeed')).toBe(204_800);
      expect(getContextWindow('MiniMax-M2.5')).toBe(204_800);
      expect(getContextWindow('MiniMax-M3')).toBe(1_000_000);
    });

    it('AC-A1: DeepSeek — chat/reasoner = 128.000 (SPEC 0.5); V4 = 1M', () => {
      expect(getContextWindow('deepseek-chat')).toBe(128_000);
      expect(getContextWindow('deepseek-reasoner')).toBe(128_000);
      expect(getContextWindow('deepseek-v4-pro')).toBe(1_000_000);
    });

    it('AC-A1: Gemini (Vertex, F5) — 1.048.576 para o catalogo', () => {
      expect(getContextWindow('gemini-2.5-pro')).toBe(1_048_576);
      expect(getContextWindow('gemini-3.1-pro-preview')).toBe(1_048_576);
      expect(getContextWindow('gemini-2.0-flash-lite')).toBe(1_048_576);
    });

    it('AC-A1: lookup e case-insensitive (chaves lowercase)', () => {
      expect(getContextWindow('GLM-5.2')).toBe(1_000_000);
      expect(getContextWindow('GPT-5.5')).toBe(1_050_000);
      expect(getContextWindow('minimax-m2.7')).toBe(204_800);
    });

    it('AC-A1: familias OSS locais (F2, substring) resolvem por tag', () => {
      expect(getContextWindow('qwen2.5:14b-instruct-q4')).toBe(131_072);
      expect(getContextWindow('llama3:8b')).toBe(131_072);
      expect(getContextWindow('mixtral:8x7b')).toBe(32_768);
    });

    it('AC-A1 (D5): modelo desconhecido -> undefined (nunca chutar)', () => {
      expect(getContextWindow('modelo-inexistente-xyz')).toBeUndefined();
      expect(getContextWindow('')).toBeUndefined();
      expect(getContextWindow('gpt-9000-ultra')).toBeUndefined();
    });

    it('AC-A1: getModelContextWindow (pricing) DELEGA ao resolver unico', () => {
      expect(getModelContextWindow('gpt-5.5')).toBe(1_050_000);
      expect(getModelContextWindow('glm-5.2')).toBe(1_000_000);
      expect(getModelContextWindow('MiniMax-M2.7')).toBe(204_800);
      expect(getModelContextWindow('claude-fable-5')).toBe(1_000_000);
      expect(getModelContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
      expect(getModelContextWindow('claude-modelo-futuro')).toBe(200_000);
      expect(getModelContextWindow('modelo-inexistente-xyz')).toBeUndefined();
      for (const m of [
        'claude-fable-5', 'opus', 'haiku', 'gpt-5.4-mini', 'glm-4.7',
        'kimi-k2.6', 'MiniMax-M3', 'deepseek-chat', 'gemini-2.5-pro',
        'qwen3-max', 'desconhecido-total',
      ]) {
        expect(getModelContextWindow(m)).toBe(getContextWindow(m));
      }
    });

    it('AC-A1 (F6): provider local sobrescreve via probe; sem provider usa o mapa', () => {
      setProbedContextWindows('lmstudio', [
        { id: 'qwen2.5-14b-local', contextWindow: 8_192 },
        { id: 'sem-janela' }, // ignorado (sem contextWindow)
      ]);
      expect(getContextWindow('qwen2.5-14b-local', 'lmstudio')).toBe(8_192);
      expect(getContextWindow('qwen2.5-14b-local')).toBe(131_072);
      expect(getContextWindow('qwen2.5-14b-local', 'zai')).toBe(131_072);
      expect(getContextWindow('sem-janela', 'lmstudio')).toBeUndefined();
      setProbedContextWindows('ollama', [{ id: 'llama3:8b', contextWindow: 4_096 }]);
      expect(getContextWindow('llama3:8b', 'ollama')).toBe(4_096);
      expect(getContextWindow('llama3:8b', 'lmstudio')).toBe(131_072);
    });
  });

  describe('AC-A2: valores `?` da SPEC 0.5 como constantes NOMEADAS', () => {
    it('AC-A2: gpt-5.2 usa CTX_GPT_5_2_UNCONFIRMED (dono confirma antes do merge)', () => {
      expect(CTX_GPT_5_2_UNCONFIRMED).toBe(1_050_000);
      expect(getContextWindow('gpt-5.2')).toBe(CTX_GPT_5_2_UNCONFIRMED);
    });

    it('AC-A2: glm-5-turbo usa CTX_GLM_5_TURBO_UNCONFIRMED', () => {
      expect(CTX_GLM_5_TURBO_UNCONFIRMED).toBe(200_000);
      expect(getContextWindow('glm-5-turbo')).toBe(CTX_GLM_5_TURBO_UNCONFIRMED);
    });

    it('AC-A2: glm-4.5-air usa CTX_GLM_4_5_AIR_UNCONFIRMED', () => {
      expect(CTX_GLM_4_5_AIR_UNCONFIRMED).toBe(131_072);
      expect(getContextWindow('glm-4.5-air')).toBe(CTX_GLM_4_5_AIR_UNCONFIRMED);
    });
  });
});
