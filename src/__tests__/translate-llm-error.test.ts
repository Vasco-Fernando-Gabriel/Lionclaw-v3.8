import { describe, it, expect } from 'vitest';
import { translateLlmError } from '@/utils/translate-llm-error';

describe('AC-B9: translateLlmError e puro e deterministico', () => {
  it('AC-B9: mesma entrada -> mesma saida (deterministico), sem mutar a entrada', () => {
    const input = Object.freeze({ code: 'LLM-QUOTA', error: 'usage_limit_exceeded' });
    const a = translateLlmError(input);
    const b = translateLlmError(input);
    expect(a).toEqual(b);
    expect(input).toEqual({ code: 'LLM-QUOTA', error: 'usage_limit_exceeded' });
  });

  it('AC-B9: mapeamento por CODE tipado -> {title, body, action, persist}', () => {
    const t = translateLlmError({ code: 'LLM-RATE-429' });
    expect(t.code).toBe('LLM-RATE-429');
    expect(t.title).toBe('Muitas requisicoes');
    expect(t.body).toContain('rate limit');
    expect(t.action).toBeTruthy();
    expect(t.persist).toBe(false);
  });

  it('AC-B9: mapeamento por ERROR (mensagem crua com sinal de quota) -> LLM-QUOTA', () => {
    const t = translateLlmError({ error: 'Provider said: usage_limit_exceeded, try later' });
    expect(t.code).toBe('LLM-QUOTA');
    expect(t.title).toBe('Limite do provedor');
    expect(t.persist).toBe(true);
    expect(t.detail).toContain('usage_limit_exceeded');
  });

  it('AC-B9: mapeamento por REASON (campo reason, ex.: compactSession) -> classificado', () => {
    const t = translateLlmError({ reason: 'request timed out after 60s' });
    expect(t.code).toBe('LLM-TIMEOUT');
    expect(t.title).toBe('Tempo esgotado');
  });

  it('AC-B9: string crua e Error tambem sao aceitos', () => {
    expect(translateLlmError('ECONNREFUSED 127.0.0.1:11434').code).toBe('LLM-NET');
    expect(translateLlmError(new Error('invalid api key')).code).toBe('LLM-AUTH-401');
  });

  it('AC-B9: fallback honesto — sem sinal classificavel preserva a mensagem crua', () => {
    const t = translateLlmError({ error: 'algo muito especifico do dominio' });
    expect(t.code).toBe('UNKNOWN');
    expect(t.title).toBe('Erro');
    expect(t.body).toBe('algo muito especifico do dominio');
    expect(t.persist).toBe(false);
  });

  it('AC-B9: entrada vazia/null -> fallback "Erro desconhecido" (sem crash)', () => {
    expect(translateLlmError(null).body).toBe('Erro desconhecido');
    expect(translateLlmError(undefined).body).toBe('Erro desconhecido');
    expect(translateLlmError({}).body).toBe('Erro desconhecido');
  });
});

describe('AC-B7 (mapeamento): classe acionavel quota/auth e persistente', () => {
  it('AC-B7: LLM-QUOTA -> titulo/acao traduzidos + persist:true (nao some em 8s)', () => {
    const t = translateLlmError({ code: 'LLM-QUOTA' });
    expect(t.title).toBe('Limite do provedor');
    expect(t.body).toBe('Cota ou creditos do provider esgotados.');
    expect(t.action).toContain('billing');
    expect(t.persist).toBe(true);
  });

  it('AC-B7: LLM-AUTH-401 tambem e persistente (classe acionavel)', () => {
    const t = translateLlmError({ code: 'LLM-AUTH-401' });
    expect(t.title).toBe('Autenticacao caiu');
    expect(t.persist).toBe(true);
  });

  it('AC-B7 (contraste): classes nao-acionaveis NAO sao persistentes', () => {
    for (const code of ['LLM-RATE-429', 'LLM-OVERLOADED-529', 'LLM-EMPTY', 'LLM-NET', 'CODEX-EXIT']) {
      expect(translateLlmError({ code }).persist).toBe(false);
    }
  });
});

describe('AC-B9b (mapeamento): LLM-EMPTY -> fallback do turno vazio', () => {
  it('AC-B9b: code LLM-EMPTY traduz para "O agente terminou sem resposta."', () => {
    const t = translateLlmError({ code: 'LLM-EMPTY', error: 'O agente terminou sem resposta.' });
    expect(t.code).toBe('LLM-EMPTY');
    expect(t.body).toBe('O agente terminou sem resposta.');
  });
});
