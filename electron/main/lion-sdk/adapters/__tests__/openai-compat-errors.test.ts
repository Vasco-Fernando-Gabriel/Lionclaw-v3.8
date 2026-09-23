import { describe, it, expect } from 'vitest';

import {
  extractOpenAiEmbeddedError,
  normalizeOpenAiCompatEmbeddedError,
  normalizeOpenAiCompatHttpError,
  normalizeOpenAiCompatTransportError,
} from '../openai-compat-errors';

describe('SB-6 openai-compat-errors (AC-B15)', () => {
  it('AC-B15: 402 vira LLM-QUOTA (categoria distinta, nao HTTP cru)', () => {
    const norm = normalizeOpenAiCompatHttpError({
      status: 402,
      bodyText: '{"error":{"message":"insufficient balance"}}',
    });
    expect(norm.code).toBe('LLM-QUOTA');
    expect(norm.status).toBe(402);
    expect(norm.userMessage).toContain('[LLM-QUOTA]');
    expect(norm.userMessage).toContain('Cota ou creditos');
    expect(norm.userMessage).toContain('insufficient balance');
  });

  it('AC-B15: 401 vira LLM-AUTH-401', () => {
    const norm = normalizeOpenAiCompatHttpError({ status: 401, bodyText: 'unauthorized' });
    expect(norm.code).toBe('LLM-AUTH-401');
    expect(norm.userMessage).toContain('[LLM-AUTH-401]');
  });

  it('AC-B15: 429 vira LLM-RATE-429', () => {
    const norm = normalizeOpenAiCompatHttpError({ status: 429 });
    expect(norm.code).toBe('LLM-RATE-429');
    expect(norm.userMessage).toContain('[LLM-RATE-429]');
  });

  it('AC-B15: 404 vira LLM-MODEL-404', () => {
    const norm = normalizeOpenAiCompatHttpError({ status: 404, bodyText: 'model not found' });
    expect(norm.code).toBe('LLM-MODEL-404');
    expect(norm.userMessage).toContain('[LLM-MODEL-404]');
  });

  it('AC-B15: 5xx vira LLM-OVERLOADED-529', () => {
    for (const status of [500, 502, 503, 529]) {
      const norm = normalizeOpenAiCompatHttpError({ status });
      expect(norm.code).toBe('LLM-OVERLOADED-529');
      expect(norm.userMessage).toContain('[LLM-OVERLOADED-529]');
    }
  });

  it('AC-B15: transporte ECONNREFUSED de provider local vira LLM-LOCAL-DOWN', () => {
    const norm = normalizeOpenAiCompatTransportError(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
      provider: 'ollama',
    });
    expect(norm.code).toBe('LLM-LOCAL-DOWN');
    expect(norm.userMessage).toContain('[LLM-LOCAL-DOWN]');
  });

  it('AC-B15: fallback preserva a mensagem crua (nunca "Erro desconhecido" seco)', () => {
    const norm = normalizeOpenAiCompatTransportError(new Error('algo inesperado xyz'));
    expect(norm.code).toBe('LLM-UNKNOWN');
    expect(norm.userMessage).toContain('algo inesperado xyz');
    expect(norm.userMessage).not.toBe('Erro desconhecido');
  });
});

describe('SB-6 corpo de erro embutido em 200 (AC-B16)', () => {
  it('AC-B16: extrai {"error":{...}} estilo OpenAI', () => {
    const embedded = extractOpenAiEmbeddedError({
      error: { message: 'You exceeded your current quota', type: 'insufficient_quota' },
    });
    expect(embedded).not.toBeNull();
    expect(embedded!.message).toContain('quota');
    expect(embedded!.type).toBe('insufficient_quota');
  });

  it('AC-B16: extrai {"error":"..."} estilo Ollama', () => {
    const embedded = extractOpenAiEmbeddedError({ error: 'model requires more system memory' });
    expect(embedded).toEqual({ message: 'model requires more system memory' });
  });

  it('AC-B16: chunk normal (sem error) retorna null', () => {
    expect(extractOpenAiEmbeddedError({ choices: [{ delta: { content: 'oi' } }] })).toBeNull();
    expect(extractOpenAiEmbeddedError({ error: '' })).toBeNull();
    expect(extractOpenAiEmbeddedError(null)).toBeNull();
    expect(extractOpenAiEmbeddedError('texto')).toBeNull();
  });

  it('AC-B16: erro de quota embutido classifica LLM-QUOTA (nao turno vazio)', () => {
    const norm = normalizeOpenAiCompatEmbeddedError({
      message: 'You exceeded your current quota, please check your plan',
      type: 'insufficient_quota',
    });
    expect(norm.code).toBe('LLM-QUOTA');
    expect(norm.userMessage).toContain('[LLM-QUOTA]');
    expect(norm.userMessage).toContain('exceeded your current quota');
  });

  it('AC-B16: erro embutido sem sinal classificavel preserva o detalhe cru', () => {
    const norm = normalizeOpenAiCompatEmbeddedError({ message: 'mistério do provider' });
    expect(norm.code).toBe('LLM-UNKNOWN');
    expect(norm.userMessage).toContain('mistério do provider');
  });
});
