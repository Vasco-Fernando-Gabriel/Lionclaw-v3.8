
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

const FROZEN_PATHS: string[] = [];

function gitDiffEmpty(relPath: string): { empty: boolean; diff: string } {
  try {
    const out = execFileSync('git', ['diff', '--', relPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    return { empty: out.trim().length === 0, diff: out };
  } catch (err) {
    const e = err as { stdout?: string };
    return { empty: false, diff: e.stdout ?? String(err) };
  }
}

describe('S8 isolation: frozen paths byte-identical (T17)', () => {
  it('nao mantem frozen paths aposentados pela campanha Codex oficial', () => {
    expect(FROZEN_PATHS).toEqual([]);
  });
  for (const p of FROZEN_PATHS) {
    it(`git diff is empty for frozen path ${p}`, () => {
      const { empty, diff } = gitDiffEmpty(p);
      expect(empty, `frozen path changed:\n${diff.slice(0, 4000)}`).toBe(true);
    });
  }

});

describe('S8 isolation: no public runtime-union mutation (T17)', () => {
  it("does NOT add a 'codex-official' literal to the canonical public runtime union", () => {
    const typesPath = path.join(REPO_ROOT, 'src/types/index.ts');
    const src = fs.readFileSync(typesPath, 'utf8');
    expect(src).not.toMatch(/runtime:\s*'cloud'[^\n]*'codex-official'/);
    expect(src).toMatch(/runtime:\s*'cloud'[^\n]*'codex'/);
    const driverTypes = fs.readFileSync(
      path.join(REPO_ROOT, 'electron/main/codex-runtime/types.ts'),
      'utf8',
    );
    expect(driverTypes).toContain("'official-app-server'");
  });

  it('the S7-owned codex-runtime package is the ONLY S8 surface (factory resolves official)', () => {
    const factoryPath = path.join(REPO_ROOT, 'electron/main/codex-runtime/factory.ts');
    const factory = fs.readFileSync(factoryPath, 'utf8');
    expect(factory).toContain("official-app-server");
    expect(factory).toContain('OfficialAppServerDriver');
    expect(factory).toContain('OfficialAppServerDriver');
  });
});
