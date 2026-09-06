
import { describe, it, expect } from 'vitest';
import {
  classifyFailure,
  decideRetry,
  DEFAULT_RETRY_POLICY,
  type FailureClassificationInput,
} from '../dynamic-workflows/workflow-failure';

function namedError(name: string, message = ''): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

function classifyAndDecide(input: FailureClassificationInput) {
  const failureClass = classifyFailure(input);
  const decision = decideRetry(failureClass, 1, DEFAULT_RETRY_POLICY);
  return { failureClass, decision };
}

describe('A4 fail-fast: CodexUnavailableError PERMANENTE -> bloqueio', () => {
  it('binario ausente ("codex binary not found ...") -> provider-auth + blockImmediately', () => {
    const { failureClass, decision } = classifyAndDecide({
      runtime: 'codex',
      error: namedError(
        'CodexUnavailableError',
        'codex binary not found on PATH; install Codex CLI',
      ),
    });
    expect(failureClass).toBe('provider-auth');
    expect(decision.blockImmediately).toBe(true);
    expect(decision.shouldRetry).toBe(false);
  });

  it('resolveCodexBinary null ("resolveCodexBinary returned null") -> provider-auth (bloqueio)', () => {
    const { failureClass, decision } = classifyAndDecide({
      runtime: 'codex',
      error: namedError(
        'CodexUnavailableError',
        'resolveCodexBinary returned null',
      ),
    });
    expect(failureClass).toBe('provider-auth');
    expect(decision.blockImmediately).toBe(true);
    expect(decision.shouldRetry).toBe(false);
  });

  it('handshake sem threadId ("thread/start returned no threadId") -> provider-auth (bloqueio)', () => {
    const { failureClass, decision } = classifyAndDecide({
      runtime: 'codex',
      error: namedError(
        'CodexUnavailableError',
        'app-server thread/start returned no threadId',
      ),
    });
    expect(failureClass).toBe('provider-auth');
    expect(decision.blockImmediately).toBe(true);
    expect(decision.shouldRetry).toBe(false);
  });

  it('CodexAuthError -> provider-auth + blockImmediately (re-login humano)', () => {
    const { failureClass, decision } = classifyAndDecide({
      runtime: 'codex',
      error: namedError('CodexAuthError', 'login required'),
    });
    expect(failureClass).toBe('provider-auth');
    expect(decision.blockImmediately).toBe(true);
    expect(decision.shouldRetry).toBe(false);
  });
});

describe('A4 fail-fast: CodexUnavailableError TRANSITORIO -> retryavel', () => {
  const transientMessages = [
    'app-server timed out waiting for response',
    'stalled: no progress for 90s',
    'attempt aborted by watchdog',
    'app-server transport closed unexpectedly',
    'app-server shutting down',
  ];

  for (const message of transientMessages) {
    it(`"${message}" -> provider-limit + shouldRetry`, () => {
      const { failureClass, decision } = classifyAndDecide({
        runtime: 'codex',
        error: namedError('CodexUnavailableError', message),
      });
      expect(failureClass).toBe('provider-limit');
      expect(decision.shouldRetry).toBe(true);
      expect(decision.blockImmediately).toBe(false);
    });
  }

  it('CodexUnavailableError sem mensagem NAO e bloqueada por nome -> provider-limit', () => {
    const { failureClass, decision } = classifyAndDecide({
      runtime: 'codex',
      error: namedError('CodexUnavailableError'),
    });
    expect(failureClass).toBe('provider-limit');
    expect(decision.shouldRetry).toBe(true);
    expect(decision.blockImmediately).toBe(false);
  });
});

describe('A4 fail-fast: handshake GENERICO -> retryavel (escolha conservadora)', () => {
  it('"codex app-server handshake failed: ..." -> provider-limit + shouldRetry', () => {
    const { failureClass, decision } = classifyAndDecide({
      runtime: 'codex',
      error: namedError(
        'CodexUnavailableError',
        'codex app-server handshake failed: protocol mismatch',
      ),
    });
    expect(failureClass).toBe('provider-limit');
    expect(decision.shouldRetry).toBe(true);
    expect(decision.blockImmediately).toBe(false);
  });
});

describe('A4 fail-fast: Kimi intocado (retryavel)', () => {
  it('KimiQuotaError -> provider-limit + shouldRetry (Kimi nao passa pela regra do Codex)', () => {
    const { failureClass, decision } = classifyAndDecide({
      runtime: 'kimi',
      error: namedError('KimiQuotaError', 'quota exceeded'),
    });
    expect(failureClass).toBe('provider-limit');
    expect(decision.shouldRetry).toBe(true);
    expect(decision.blockImmediately).toBe(false);
  });

  it('429 generico (Kimi) -> provider-limit + shouldRetry', () => {
    const { failureClass, decision } = classifyAndDecide({
      runtime: 'kimi',
      error: new Error('too many requests'),
      httpStatus: 429,
    });
    expect(failureClass).toBe('provider-limit');
    expect(decision.shouldRetry).toBe(true);
    expect(decision.blockImmediately).toBe(false);
  });
});
