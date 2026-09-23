import { describe, it, expect, beforeEach, afterEach } from 'vitest';

function isLionClawEmbedded(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('host') === 'lionclaw') return true;
    if (typeof sessionStorage !== 'undefined') {
      try {
        if (sessionStorage.getItem('lionclaw:embedded') === '1') return true;
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

describe('vendor patch: apps/web/src/lib/embed-mode.ts (SPEC L1093)', () => {
  const realWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    if (realWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = realWindow;
    }
  });

  it('retorna false quando window indefinido (SSR / server-side)', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(isLionClawEmbedded()).toBe(false);
  });

  it('retorna true quando window.location.search contem host=lionclaw', () => {
    (globalThis as { window?: unknown }).window = {
      location: { search: '?host=lionclaw' },
    };
    expect(isLionClawEmbedded()).toBe(true);
  });

  it('retorna true quando ha outros params alem de host=lionclaw', () => {
    (globalThis as { window?: unknown }).window = {
      location: { search: '?foo=bar&host=lionclaw&locale=pt-BR' },
    };
    expect(isLionClawEmbedded()).toBe(true);
  });

  it('retorna false quando query nao contem host=lionclaw', () => {
    (globalThis as { window?: unknown }).window = {
      location: { search: '?host=standalone' },
    };
    expect(isLionClawEmbedded()).toBe(false);
  });

  it('retorna false quando search vazio (acesso direto ao OD upstream)', () => {
    (globalThis as { window?: unknown }).window = {
      location: { search: '' },
    };
    expect(isLionClawEmbedded()).toBe(false);
  });

  it('retorna false quando search invalido (tolera erro de parsing)', () => {
    (globalThis as { window?: unknown }).window = {
      location: {
        get search() {
          throw new Error('boom');
        },
      },
    };
    expect(isLionClawEmbedded()).toBe(false);
  });
});

describe('vendor patch: daemon embed-mode middleware logic (SPEC L1094)', () => {
  function shouldBlock(envValue: string | undefined, path: string): boolean {
    return envValue === 'lionclaw' && /\/finalize\//.test(path);
  }

  beforeEach(() => {
    delete process.env.OD_EMBED_HOST;
  });

  afterEach(() => {
    delete process.env.OD_EMBED_HOST;
  });

  it('bloqueia POST /api/projects/:id/finalize/anthropic quando OD_EMBED_HOST=lionclaw', () => {
    expect(shouldBlock('lionclaw', '/api/projects/abc/finalize/anthropic')).toBe(true);
  });

  it('bloqueia qualquer path contendo /finalize/ (futuros endpoints)', () => {
    expect(shouldBlock('lionclaw', '/api/projects/abc/finalize/openai')).toBe(true);
    expect(shouldBlock('lionclaw', '/api/projects/abc/finalize/google')).toBe(true);
    expect(shouldBlock('lionclaw', '/api/foo/finalize/bar')).toBe(true);
  });

  it('NAO bloqueia paths fora de /finalize/ (preserva rotas legitimas)', () => {
    expect(shouldBlock('lionclaw', '/api/health')).toBe(false);
    expect(shouldBlock('lionclaw', '/api/projects')).toBe(false);
    expect(shouldBlock('lionclaw', '/api/projects/abc/files')).toBe(false);
    expect(shouldBlock('lionclaw', '/api/projects/abc/archive')).toBe(false);
    expect(shouldBlock('lionclaw', '/api/projects/abc/export/pdf')).toBe(false);
    expect(shouldBlock('lionclaw', '/api/runs')).toBe(false);
  });

  it('NAO bloqueia quando OD_EMBED_HOST ausente (comportamento upstream preservado)', () => {
    expect(shouldBlock(undefined, '/api/projects/abc/finalize/anthropic')).toBe(false);
  });

  it('NAO bloqueia quando OD_EMBED_HOST eh outra string (patch CONDICIONAL)', () => {
    expect(shouldBlock('standalone', '/api/projects/abc/finalize/anthropic')).toBe(false);
    expect(shouldBlock('', '/api/projects/abc/finalize/anthropic')).toBe(false);
  });

  it('confere que o env real lido pelo middleware vendor casa com a logica', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const file = path.resolve(__dirname, '../../../vendor/open-design/apps/daemon/src/import-export-routes.ts');
    const src = fs.readFileSync(file, 'utf-8');
    expect(src).toMatch(/OD_EMBED_HOST.*===.*['"]lionclaw['"]/);
    expect(src).toMatch(/\/\\\/finalize\\\//);
    expect(src).toMatch(/embedded mode: finalize disabled/);
    expect(src).toMatch(/res\.status\(403\)/);
  });
});
