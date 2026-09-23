import { describe, it, expect } from 'vitest';
import {
  LLM_ERROR_TABLE,
  TypedProviderError,
  EmptyProviderResponseError,
  translateProviderError,
  buildExecutionError,
  emptyResponseExecutionError,
  isEmptyFailedTurn,
  type LlmErrorCode,
} from '../llm-error';

describe('SB-2 — tabela de codigos B.2', () => {
  const B2_CODES: LlmErrorCode[] = [
    'LLM-QUOTA',
    'LLM-RATE-429',
    'LLM-OVERLOADED-529',
    'LLM-AUTH-401',
    'LLM-MODEL-404',
    'LLM-EMPTY',
    'LLM-NET',
    'LLM-TIMEOUT',
    'LLM-LOCAL-DOWN',
    'CODEX-EXIT',
    'CODEX-WEDGE',
    'COMPACT-EMPTY',
    'COMPACT-SKIPPED',
    'EMBED-FAIL',
    'DB-MIGRATION',
    'DB-FULL',
    'DB-BUSY',
    'DB-CORRUPT-ROW',
    'VEC-UNAVAILABLE',
    'MCP-START-FAIL',
    'MCP-DISCOVERY-FAIL',
    'MCP-EMPTY',
    'SECRET-UNREADABLE',
    'KEYTAR-DEGRADED',
    'VAULT-CORRUPT',
    'REVOKE-UNCONFIRMED',
    'CRON-INVALID',
    'STT-FAIL',
    'TTS-FAIL',
    'IMG-FAIL',
  ];

  it('AC-B4: todos os 30 codigos da tabela B.2 existem com category + userMessage PT-BR + suggestedAction', () => {
    for (const code of B2_CODES) {
      const entry = LLM_ERROR_TABLE[code];
      expect(entry, `codigo ${code} ausente da tabela`).toBeDefined();
      expect(entry.category.length).toBeGreaterThan(0);
      expect(entry.userMessage.length).toBeGreaterThan(0);
      expect(entry.suggestedAction.length).toBeGreaterThan(0);
    }
  });

  it('buildExecutionError projeta a entrada da tabela + raw opcional', () => {
    const e = buildExecutionError('LLM-EMPTY', 'model=x');
    expect(e.code).toBe('LLM-EMPTY');
    expect(e.category).toBe(LLM_ERROR_TABLE['LLM-EMPTY'].category);
    expect(e.userMessage).toBe(LLM_ERROR_TABLE['LLM-EMPTY'].userMessage);
    expect(e.suggestedAction).toBe(LLM_ERROR_TABLE['LLM-EMPTY'].suggestedAction);
    expect(e.raw).toBe('model=x');
    expect(buildExecutionError('LLM-QUOTA').raw).toBeUndefined();
  });
});

describe('AC-B4 — translateProviderError classifica cada categoria', () => {
  it('AC-B4: HTTP 402 -> LLM-QUOTA', () => {
    const t = translateProviderError(Object.assign(new Error('Payment required'), { status: 402 }));
    expect(t.code).toBe('LLM-QUOTA');
    expect(t.category).toBe('quota');
  });

  it('AC-B4: HTTP 401 e 403 -> LLM-AUTH-401', () => {
    expect(translateProviderError(Object.assign(new Error('x'), { status: 401 })).code).toBe('LLM-AUTH-401');
    expect(translateProviderError(Object.assign(new Error('x'), { statusCode: 403 })).code).toBe('LLM-AUTH-401');
  });

  it('AC-B4: HTTP 429 -> LLM-RATE-429', () => {
    const t = translateProviderError(Object.assign(new Error('slow down'), { status: 429 }));
    expect(t.code).toBe('LLM-RATE-429');
    expect(t.category).toBe('rate-limit');
  });

  it('AC-B4: HTTP 529 (e 5xx) -> LLM-OVERLOADED-529', () => {
    expect(translateProviderError(Object.assign(new Error('x'), { status: 529 })).code).toBe('LLM-OVERLOADED-529');
    expect(translateProviderError(Object.assign(new Error('x'), { status: 503 })).code).toBe('LLM-OVERLOADED-529');
  });

  it('AC-B4: HTTP 404 -> LLM-MODEL-404', () => {
    expect(translateProviderError(Object.assign(new Error('not found'), { status: 404 })).code).toBe('LLM-MODEL-404');
  });

  it('AC-B4: httpStatus explicito do ctx tem precedencia sobre a mensagem', () => {
    const t = translateProviderError(new Error('quota exceeded'), { httpStatus: 401 });
    expect(t.code).toBe('LLM-AUTH-401');
  });

  it('AC-B4: codex usageLimitExceeded / usage_limit_exceeded -> LLM-QUOTA', () => {
    expect(translateProviderError(new Error('Codex error [usage_limit_exceeded]: limit')).code).toBe('LLM-QUOTA');
    expect(translateProviderError(new Error('UsageLimitExceeded')).code).toBe('LLM-QUOTA');
    expect(translateProviderError(new Error('Limite da sua assinatura ChatGPT foi atingido.')).code).toBe('LLM-QUOTA');
  });

  it('AC-B4: mensagem de quota/credito -> LLM-QUOTA', () => {
    expect(translateProviderError(new Error('insufficient_quota for this key')).code).toBe('LLM-QUOTA');
    expect(
      translateProviderError(
        new Error('Cota Kimi esgotada ou rate limit atingido; tente de novo apos a janela de quota renovar.'),
      ).code,
    ).toBe('LLM-QUOTA');
  });

  it('AC-B4: mensagem de auth -> LLM-AUTH-401', () => {
    expect(translateProviderError(new Error('Unauthorized: invalid api key')).code).toBe('LLM-AUTH-401');
  });

  it('AC-B4: mensagem de rate limit -> LLM-RATE-429', () => {
    expect(translateProviderError(new Error('Too many requests, retry later')).code).toBe('LLM-RATE-429');
  });

  it('AC-B4: mensagem de overload -> LLM-OVERLOADED-529', () => {
    expect(translateProviderError(new Error('overloaded_error: try again')).code).toBe('LLM-OVERLOADED-529');
    expect(translateProviderError(new Error('Modelo Codex sobrecarregado nos servidores da OpenAI.')).code).toBe(
      'LLM-OVERLOADED-529',
    );
  });

  it('AC-B4: ECONNREFUSED em runtime local -> LLM-LOCAL-DOWN', () => {
    const t = translateProviderError(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { runtime: 'local' });
    expect(t.code).toBe('LLM-LOCAL-DOWN');
  });

  it('AC-B4: ECONNREFUSED em provider ollama/lmstudio ou localhost -> LLM-LOCAL-DOWN', () => {
    expect(translateProviderError(new Error('ECONNREFUSED'), { provider: 'ollama' }).code).toBe('LLM-LOCAL-DOWN');
    expect(translateProviderError(new Error('ECONNREFUSED'), { provider: 'lmstudio' }).code).toBe('LLM-LOCAL-DOWN');
    expect(translateProviderError(new Error('connect ECONNREFUSED localhost:1234')).code).toBe('LLM-LOCAL-DOWN');
  });

  it('AC-B4: ECONNREFUSED remoto (sem sinal local) -> LLM-NET', () => {
    expect(translateProviderError(new Error('connect ECONNREFUSED 34.120.0.1:443')).code).toBe('LLM-NET');
  });

  it('AC-B4: erros de rede -> LLM-NET', () => {
    expect(translateProviderError(new Error('fetch failed')).code).toBe('LLM-NET');
    expect(translateProviderError(new Error('read ECONNRESET')).code).toBe('LLM-NET');
    expect(translateProviderError(new Error('getaddrinfo ENOTFOUND api.x.com')).code).toBe('LLM-NET');
  });

  it('AC-B4: timeout -> LLM-TIMEOUT', () => {
    expect(translateProviderError(new Error('request timed out after 60s')).code).toBe('LLM-TIMEOUT');
    expect(translateProviderError(Object.assign(new Error('x'), { status: 408 })).code).toBe('LLM-TIMEOUT');
  });

  it('AC-B4: morte do app-server codex -> CODEX-EXIT; stall -> CODEX-WEDGE', () => {
    expect(translateProviderError(new Error('codex app-server exited (code=null)')).code).toBe('CODEX-EXIT');
    expect(translateProviderError(new Error('app-server transport closed')).code).toBe('CODEX-EXIT');
    expect(translateProviderError(new Error('stalled: no progress for 3min')).code).toBe('CODEX-WEDGE');
  });

  it('AC-B4: sem sinal classificavel -> LLM-UNKNOWN (nunca chutar categoria)', () => {
    const t = translateProviderError(new Error('algo muito estranho aconteceu'));
    expect(t.code).toBe('LLM-UNKNOWN');
    expect(t.category).toBe('unknown');
  });

  it('AC-B5 (pura): TypedProviderError passa DIRETO (idempotente, mesma instancia)', () => {
    const original = new TypedProviderError('LLM-QUOTA');
    expect(translateProviderError(original)).toBe(original);
  });

  it('AC-B5 (pura): erro cru preserva message e stack em cause + raw', () => {
    const raw = new Error('HTTP 429: rate limit exceeded');
    const t = translateProviderError(raw);
    expect(t).toBeInstanceOf(TypedProviderError);
    expect(t.cause).toBe(raw);
    expect((t.cause as Error).stack).toBe(raw.stack);
    expect(t.message).toBe(raw.message);
    expect(t.raw).toBe(raw.message);
    expect(t.userMessage).toBe(LLM_ERROR_TABLE['LLM-RATE-429'].userMessage);
  });

  it('EmptyProviderResponseError e classe IRMA (nao subclasse) e vira COMPACT-EMPTY na traducao', () => {
    const e = new EmptyProviderResponseError('zai', 'glm-5.2', 'zai');
    expect(e).not.toBeInstanceOf(TypedProviderError);
    expect(e.code).toBe('COMPACT-EMPTY');
    expect(e.userMessage).toBe(LLM_ERROR_TABLE['COMPACT-EMPTY'].userMessage);
    expect(e.provider).toBe('zai');
    expect(e.model).toBe('glm-5.2');
    expect(e.runtime).toBe('zai');
    const t = translateProviderError(e);
    expect(t.code).toBe('COMPACT-EMPTY');
    expect(t.cause).toBe(e);
  });

  it('string crua tambem classifica (input nao-Error)', () => {
    expect(translateProviderError('quota exceeded for project').code).toBe('LLM-QUOTA');
  });
});

describe('AC-B6b (pura) — emptyResponseExecutionError decide vazio-falho vs empty-ok', () => {
  it('AC-B6b: content vazio + 0 tools + sem abort -> LLM-EMPTY com raw provider/model', () => {
    const e = emptyResponseExecutionError({ content: '', toolUses: 0, provider: 'ollama', model: 'llama3' });
    expect(e?.code).toBe('LLM-EMPTY');
    expect(e?.raw).toBe('provider=ollama model=llama3');
  });

  it('AC-B6b: content presente -> undefined (sucesso normal)', () => {
    expect(emptyResponseExecutionError({ content: 'oi', toolUses: 0 })).toBeUndefined();
  });

  it('AC-B6b: turno so-tool (toolUses>0) e vazio LEGITIMO -> undefined', () => {
    expect(emptyResponseExecutionError({ content: '', toolUses: 2 })).toBeUndefined();
  });

  it('AC-B6b: abortado pelo usuario e vazio LEGITIMO -> undefined', () => {
    expect(emptyResponseExecutionError({ content: '', toolUses: 0, aborted: true })).toBeUndefined();
  });
});

describe('AC-B4b (pura) — isEmptyFailedTurn (path D6 do orquestrador)', () => {
  it('AC-B4b: sem texto + 0 output tokens + 0 artifacts -> empty-failed (true)', () => {
    expect(isEmptyFailedTurn({ assistantContent: '', outputTokens: 0, artifactCount: 0 })).toBe(true);
  });

  it('AC-B4b: turno com texto NAO e empty-failed', () => {
    expect(isEmptyFailedTurn({ assistantContent: 'resposta', outputTokens: 10, artifactCount: 0 })).toBe(false);
  });

  it('AC-B4b: turno so-tool (outputTokens>0) e empty-ok -> false', () => {
    expect(isEmptyFailedTurn({ assistantContent: '', outputTokens: 42, artifactCount: 0 })).toBe(false);
  });

  it('AC-B4b: turno com artifacts e empty-ok -> false', () => {
    expect(isEmptyFailedTurn({ assistantContent: '', outputTokens: 0, artifactCount: 1 })).toBe(false);
  });
});
