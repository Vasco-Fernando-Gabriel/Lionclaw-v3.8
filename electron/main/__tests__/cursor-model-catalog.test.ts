import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import {
  listCursorModels,
  getCachedCursorModelCatalog,
  isCursorCatalogModel,
  _resetCursorModelCatalogForTesting,
  type ListCursorModelsOptions,
} from '../agent-runtime/cursor-sidecar/model-catalog';
import { CURSOR_MODELS } from '../../../src/constants/cursor-models';

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-cursor-sidecar.cjs');

function opts(mode: string, extra: Partial<ListCursorModelsOptions> = {}): ListCursorModelsOptions {
  return {
    apiKey: 'test-key',
    nodePathOverride: process.execPath,
    entryPathOverride: FIXTURE,
    timeoutMs: 5_000,
    extraEnv: { FAKE_SIDECAR_MODE: mode, ELECTRON_RUN_AS_NODE: '1' },
    ...extra,
  };
}

afterEach(() => {
  _resetCursorModelCatalogForTesting();
});

describe('listCursorModels', () => {
  it('busca o catalogo vivo pelo sidecar e cacheia', async () => {
    const catalog = await listCursorModels(opts('echo'));
    expect(catalog.source).toBe('live');
    expect(catalog.models).toEqual([
      { id: 'composer-2.5', displayName: 'Composer 2.5' },
      { id: 'test-model-x', displayName: 'Test Model X' },
    ]);
    expect(getCachedCursorModelCatalog()).toBe(catalog);

    const again = await listCursorModels(opts('echo', { entryPathOverride: path.join(__dirname, 'nao-existe.cjs') }));
    expect(again).toBe(catalog);
  });

  it('falha da via viva degrada para o snapshot estatico G6 (nunca lanca)', async () => {
    const catalog = await listCursorModels(opts('models-error'));
    expect(catalog.source).toBe('static-fallback');
    expect(catalog.models.map((m) => m.id)).toEqual(CURSOR_MODELS.map((m) => m.slug));
  });
});

describe('isCursorCatalogModel', () => {
  it('aceita o snapshot estatico G6 sem busca previa', () => {
    expect(isCursorCatalogModel('composer-2.5')).toBe(true);
    expect(isCursorCatalogModel('claude-fable-5')).toBe(true);
    expect(isCursorCatalogModel('modelo-inexistente')).toBe(false);
  });

  it('a lista viva AMPLIA o pertencimento (id fora do snapshot)', async () => {
    expect(isCursorCatalogModel('test-model-x')).toBe(false);
    await listCursorModels(opts('echo'));
    expect(isCursorCatalogModel('test-model-x')).toBe(true);
  });
});
