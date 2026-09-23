import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSqliteVecForRuntime } from '../sqlite-vec-runtime';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('sqlite-vec runtime físico', () => {
  it('carrega a dylib ARM64 pelo app.asar.unpacked', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-sqlite-vec-'));
    roots.push(root);
    const dylib = path.join(root, 'app.asar.unpacked', 'node_modules', 'sqlite-vec-darwin-arm64', 'vec0.dylib');
    fs.mkdirSync(path.dirname(dylib), { recursive: true });
    fs.writeFileSync(dylib, 'fixture');
    const database = { loadExtension: vi.fn() };
    expect(
      loadSqliteVecForRuntime(database, {
        resourcesPath: root,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(fs.realpathSync(dylib));
    expect(database.loadExtension).toHaveBeenCalledWith(fs.realpathSync(dylib));
  });

  it('mantém o loader do pacote fora do app empacotado', () => {
    const fallbackLoad = vi.fn();
    const database = { loadExtension: vi.fn() };
    expect(loadSqliteVecForRuntime(database, { resourcesPath: null, fallbackLoad })).toBeNull();
    expect(fallbackLoad).toHaveBeenCalledWith(database);
  });
});
