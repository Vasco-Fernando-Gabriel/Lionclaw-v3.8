import { describe, expect, it } from 'vitest';


describe('kimi:status golden shape (canal aditivo, R2)', () => {
  it('subscription: logado via /login', () => {
    const result = {
      installed: true,
      version: 'kimi 0.1.8',
      authenticated: true,
      authMode: 'subscription' as const,
    };
    expect(result).toMatchSnapshot();
  });

  it('none: instalado mas sem login (sem fallback api-key)', () => {
    const result = {
      installed: true,
      version: 'kimi 0.1.8',
      authenticated: false,
      authMode: 'none' as const,
    };
    expect(result).toMatchSnapshot();
  });

  it('nao instalado: binario kimi nao resolvel', () => {
    const result = {
      installed: false,
      version: null,
      authenticated: false,
      authMode: 'none' as const,
    };
    expect(result).toMatchSnapshot();
  });
});
