import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildContextBundle,
  type BuildContextBundleInput,
  type ContextBundleDeps,
} from '../dynamic-workflows/workflow-context-bundle';

const PROJECT_PATH = '/abs/project';
const PKG_PATH = join(PROJECT_PATH, 'package.json');

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'dwf-bundle-'));
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function baseInput(): BuildContextBundleInput {
  return {
    projectPath: PROJECT_PATH,
    runDir,
    specText: 'SPEC: feature X',
    createdBy: 'manual',
  };
}

function depsWith(files: Record<string, string | 'unreadable'>): ContextBundleDeps {
  return {
    readTextFile: (path: string) => {
      const v = files[path];
      if (v === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      if (v === 'unreadable') {
        throw new Error(`EACCES: ${path}`);
      }
      return v;
    },
    pathExists: (path: string) => path in files,
    loadAgentCatalog: () => [],
    now: () => '2026-06-21T00:00:00.000Z',
  };
}

describe('context bundle: build-detection (packageScripts/hasBuildScript)', () => {
  it('package.json com scripts.build => hasBuildScript=true e packageScripts populado', () => {
    const deps = depsWith({
      [PKG_PATH]: JSON.stringify({
        name: 'proj',
        scripts: { build: 'tsc -b', test: 'vitest run', typecheck: 'tsc --noEmit' },
      }),
    });

    const { bundle } = buildContextBundle(baseInput(), deps);

    expect(bundle.hasBuildScript).toBe(true);
    expect(bundle.packageScripts).toEqual({
      build: 'tsc -b',
      test: 'vitest run',
      typecheck: 'tsc --noEmit',
    });
  });

  it('package.json sem scripts.build => hasBuildScript=false, mas packageScripts ainda populado', () => {
    const deps = depsWith({
      [PKG_PATH]: JSON.stringify({
        name: 'proj',
        scripts: { test: 'vitest run', lint: 'eslint .' },
      }),
    });

    const { bundle } = buildContextBundle(baseInput(), deps);

    expect(bundle.hasBuildScript).toBe(false);
    expect(bundle.packageScripts).toEqual({ test: 'vitest run', lint: 'eslint .' });
  });

  it('package.json sem campo scripts => hasBuildScript=false, packageScripts={}', () => {
    const deps = depsWith({
      [PKG_PATH]: JSON.stringify({ name: 'proj', version: '1.0.0' }),
    });

    const { bundle } = buildContextBundle(baseInput(), deps);

    expect(bundle.hasBuildScript).toBe(false);
    expect(bundle.packageScripts).toEqual({});
  });

  it('package.json ausente => hasBuildScript=false, packageScripts={} (sem throw)', () => {
    const deps = depsWith({});

    const { bundle } = buildContextBundle(baseInput(), deps);

    expect(bundle.hasBuildScript).toBe(false);
    expect(bundle.packageScripts).toEqual({});
  });

  it('package.json ilegivel => hasBuildScript=false, packageScripts={} (sem throw)', () => {
    const deps = depsWith({ [PKG_PATH]: 'unreadable' });

    const { bundle } = buildContextBundle(baseInput(), deps);

    expect(bundle.hasBuildScript).toBe(false);
    expect(bundle.packageScripts).toEqual({});
  });

  it('package.json malformado (JSON invalido) => hasBuildScript=false, packageScripts={} (sem throw)', () => {
    const deps = depsWith({ [PKG_PATH]: '{ not valid json' });

    const { bundle } = buildContextBundle(baseInput(), deps);

    expect(bundle.hasBuildScript).toBe(false);
    expect(bundle.packageScripts).toEqual({});
  });

  it('scripts com valores nao-string sao ignorados (so strings entram em packageScripts)', () => {
    const deps = depsWith({
      [PKG_PATH]: JSON.stringify({
        scripts: { build: 'tsc -b', weird: 42, nested: { a: 1 } },
      }),
    });

    const { bundle } = buildContextBundle(baseInput(), deps);

    expect(bundle.hasBuildScript).toBe(true);
    expect(bundle.packageScripts).toEqual({ build: 'tsc -b' });
  });
});
