
import { describe, it, expect } from 'vitest';
import {
  classifyFailure,
  decideRetry,
  computeBackoffMs,
  DEFAULT_RETRY_POLICY,
  type FailureClassificationInput,
} from '../dynamic-workflows/workflow-failure';

function namedError(name: string, message = ''): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe('workflow-failure: classifyFailure (10.4)', () => {
  it('schemaExhausted tem precedencia e mapeia para schema', () => {
    const input: FailureClassificationInput = {
      runtime: 'cloud',
      error: namedError('CodexAuthError'), // ignorado: schema vence
      schemaExhausted: true,
    };
    expect(classifyFailure(input)).toBe('schema');
  });

  it('CodexAuthError (por nome) -> provider-auth, exige humano', () => {
    expect(
      classifyFailure({ runtime: 'codex', error: namedError('CodexAuthError') }),
    ).toBe('provider-auth');
  });

  it('CodexUnavailableError (por nome) -> provider-limit', () => {
    expect(
      classifyFailure({
        runtime: 'codex',
        error: namedError('CodexUnavailableError'),
      }),
    ).toBe('provider-limit');
  });

  it('reconhece o erro do codex mesmo re-serializado (so name, sem prototype)', () => {
    const plain = { name: 'CodexAuthError', message: 'login required' };
    expect(classifyFailure({ runtime: 'codex', error: plain })).toBe(
      'provider-auth',
    );
  });

  it('timedOut (watchdog do node) -> timeout', () => {
    expect(
      classifyFailure({
        runtime: 'external',
        error: new Error('whatever'),
        timedOut: true,
      }),
    ).toBe('timeout');
  });

  it('HTTP 429 -> provider-limit (Claude-compatible/external)', () => {
    expect(
      classifyFailure({ runtime: 'zai', error: new Error('x'), httpStatus: 429 }),
    ).toBe('provider-limit');
  });

  it('HTTP 401/403 -> provider-auth', () => {
    expect(
      classifyFailure({ runtime: 'external', error: {}, httpStatus: 401 }),
    ).toBe('provider-auth');
    expect(
      classifyFailure({ runtime: 'external', error: {}, httpStatus: 403 }),
    ).toBe('provider-auth');
  });

  it('HTTP 5xx -> provider-error (transitorio)', () => {
    expect(
      classifyFailure({ runtime: 'minimax-tp', error: {}, httpStatus: 503 }),
    ).toBe('provider-error');
  });

  it('le status do proprio erro quando o adapter nao passa httpStatus', () => {
    const err = Object.assign(new Error('boom'), { status: 429 });
    expect(classifyFailure({ runtime: 'cloud', error: err })).toBe(
      'provider-limit',
    );
  });

  it('heuristica de mensagem: rate limit -> provider-limit', () => {
    expect(
      classifyFailure({
        runtime: 'cloud',
        error: new Error('Rate limit exceeded, try again later'),
      }),
    ).toBe('provider-limit');
  });

  it('heuristica de mensagem: sem credito -> provider-limit', () => {
    expect(
      classifyFailure({
        runtime: 'minimax-tp',
        error: new Error('insufficient credit on account'),
      }),
    ).toBe('provider-limit');
  });

  it('heuristica de mensagem: overloaded -> provider-error', () => {
    expect(
      classifyFailure({
        runtime: 'cloud',
        error: new Error('Overloaded'),
      }),
    ).toBe('provider-error');
  });

  it('heuristica de mensagem: authentication -> provider-auth', () => {
    expect(
      classifyFailure({
        runtime: 'zai',
        error: new Error('authentication_error: invalid api key'),
      }),
    ).toBe('provider-auth');
  });

  it('erro generico sem sinal -> logic (nunca inventa provider-limit)', () => {
    expect(
      classifyFailure({
        runtime: 'cloud',
        error: new Error('TypeError: cannot read property foo of undefined'),
      }),
    ).toBe('logic');
  });

  it('string crua e tolerada (sem name/status)', () => {
    expect(classifyFailure({ runtime: 'local', error: 'quota exceeded' })).toBe(
      'provider-limit',
    );
    expect(classifyFailure({ runtime: 'local', error: 'random junk' })).toBe(
      'logic',
    );
  });
});

describe('workflow-failure: retry policy (10.4)', () => {
  it('defaults: 3 retries, blockOn provider-auth, retryOn limit/error/timeout', () => {
    expect(DEFAULT_RETRY_POLICY.maxAutoRetries).toBe(3);
    expect(DEFAULT_RETRY_POLICY.blockOn).toContain('provider-auth');
    expect(DEFAULT_RETRY_POLICY.retryOn).toEqual([
      'provider-limit',
      'provider-error',
      'timeout',
    ]);
  });

  it('provider-auth bloqueia IMEDIATAMENTE (nunca auto-retry)', () => {
    const d = decideRetry('provider-auth', 1);
    expect(d.shouldRetry).toBe(false);
    expect(d.blockImmediately).toBe(true);
    expect(d.escalate).toBe(false);
  });

  it('provider-limit com tentativas restantes -> retry com backoff', () => {
    const d = decideRetry('provider-limit', 1);
    expect(d.shouldRetry).toBe(true);
    expect(d.backoffMs).toBe(30_000); // primeiro retry: 30s
    expect(d.blockImmediately).toBe(false);
  });

  it('provider-limit esgotado -> escala para bloqueio (run blocked)', () => {
    const d = decideRetry('provider-limit', 3); // attemptsMade == maxAutoRetries
    expect(d.shouldRetry).toBe(false);
    expect(d.escalate).toBe(true);
    expect(d.blockImmediately).toBe(false);
  });

  it('logic/schema fora de retryOn -> sem auto-retry, sem escalate', () => {
    for (const fc of ['logic', 'schema'] as const) {
      const d = decideRetry(fc, 1);
      expect(d.shouldRetry).toBe(false);
      expect(d.escalate).toBe(false);
      expect(d.blockImmediately).toBe(false);
    }
  });

  it('backoff exponencial: 30s, 2min, 8min (base 30s * 4^i, curva normativa 10.4 L995, sem random)', () => {
    expect(computeBackoffMs(0)).toBe(30_000); // 30s
    expect(computeBackoffMs(1)).toBe(120_000); // 2min
    expect(computeBackoffMs(2)).toBe(480_000); // 8min
  });
});
