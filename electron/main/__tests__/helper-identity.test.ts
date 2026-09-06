
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { debugSpy, warnSpy } = vi.hoisted(() => ({
  debugSpy: vi.fn(),
  warnSpy: vi.fn(),
}));
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    debug: debugSpy,
  }),
}));

import {
  mintHelperToken,
  isValidHelperToken,
  revokeHelperToken,
  __resetHelperIdentityForTests,
  LIONCLAW_HELPER_TOKEN_ENV,
  CHAT_GATED_HELPER_IDS,
  PROCESS_IDENTITY_HELPER_IDS,
} from '../helper-identity';

beforeEach(() => {
  __resetHelperIdentityForTests();
  debugSpy.mockClear();
  warnSpy.mockClear();
});

describe('mintHelperToken', () => {
  it('cunha token base64url de 32 bytes (43 chars, sem +/=) e o torna valido', () => {
    const token = mintHelperToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isValidHelperToken(token)).toBe(true);
  });

  it('cada mint cunha um token DISTINTO (um por spawn de processo helper)', () => {
    const a = mintHelperToken();
    const b = mintHelperToken();
    expect(a).not.toBe(b);
    expect(isValidHelperToken(a)).toBe(true);
    expect(isValidHelperToken(b)).toBe(true);
  });

  it('NUNCA loga o token inteiro (so hash truncado)', () => {
    const token = mintHelperToken();
    revokeHelperToken(token);
    const allLogPayloads = JSON.stringify([
      ...debugSpy.mock.calls,
      ...warnSpy.mock.calls,
    ]);
    expect(allLogPayloads).not.toContain(token);
    for (const call of debugSpy.mock.calls) {
      const payload = call[0] as { tokenHash?: string };
      if (payload?.tokenHash !== undefined) {
        expect(payload.tokenHash).toMatch(/^[0-9a-f]{12}$/);
      }
    }
  });
});

describe('isValidHelperToken (fail closed)', () => {
  it('token desconhecido -> false', () => {
    expect(isValidHelperToken('token-que-nunca-foi-cunhado')).toBe(false);
  });

  it('string vazia -> false', () => {
    expect(isValidHelperToken('')).toBe(false);
  });

  it('nao-string em runtime -> false (dado chega de env/socket, nao confiar no tipo)', () => {
    expect(isValidHelperToken(undefined as unknown as string)).toBe(false);
    expect(isValidHelperToken(null as unknown as string)).toBe(false);
  });

  it('token parecido mas nao identico -> false (comparacao por hash exato)', () => {
    const token = mintHelperToken();
    expect(isValidHelperToken(token.slice(0, -1))).toBe(false);
    expect(isValidHelperToken(`${token}x`)).toBe(false);
    expect(isValidHelperToken(token.toUpperCase())).toBe(false);
  });
});

describe('revokeHelperToken', () => {
  it('token revogado deixa de validar; os demais continuam validos', () => {
    const a = mintHelperToken();
    const b = mintHelperToken();

    revokeHelperToken(a);
    expect(isValidHelperToken(a)).toBe(false);
    expect(isValidHelperToken(b)).toBe(true);
  });

  it('revogar token desconhecido/vazio e no-op seguro', () => {
    expect(() => revokeHelperToken('nunca-existiu')).not.toThrow();
    expect(() => revokeHelperToken('')).not.toThrow();
  });

  it('revogacao e idempotente', () => {
    const token = mintHelperToken();
    revokeHelperToken(token);
    revokeHelperToken(token);
    expect(isValidHelperToken(token)).toBe(false);
  });
});

describe('__resetHelperIdentityForTests', () => {
  it('invalida todos os tokens cunhados', () => {
    const a = mintHelperToken();
    const b = mintHelperToken();
    __resetHelperIdentityForTests();
    expect(isValidHelperToken(a)).toBe(false);
    expect(isValidHelperToken(b)).toBe(false);
  });
});

describe('contrato com o spawn (S3b depende disso)', () => {
  it('o nome da env var e estavel: LIONCLAW_HELPER_TOKEN', () => {
    expect(LIONCLAW_HELPER_TOKEN_ENV).toBe('LIONCLAW_HELPER_TOKEN');
  });

  it('lionclaw-agents exige identidade porque call_agent herda o turno host', () => {
    expect(PROCESS_IDENTITY_HELPER_IDS.has('lionclaw-agents')).toBe(true);
  });
});

describe('CHAT_GATED_HELPER_IDS — definicao canonica (S4b)', () => {
  it('contem EXATAMENTE os 2 helpers gated da Fase A (lowercase)', () => {
    expect([...CHAT_GATED_HELPER_IDS].sort()).toEqual([
      'lionclaw-dynamic-workflows',
      'lionclaw-pipeline-control',
    ]);
  });

  it('o re-export de codex-sdk/mcp-wrapper-generator e o MESMO objeto (fim do espelho manual)', async () => {
    const { CHAT_GATED_HELPER_IDS: reexported } = await import('../codex-sdk/mcp-wrapper-generator');
    expect(reexported).toBe(CHAT_GATED_HELPER_IDS);
  });
});
