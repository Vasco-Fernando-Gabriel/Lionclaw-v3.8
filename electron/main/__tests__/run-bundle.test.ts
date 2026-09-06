import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listRunBundle, RUN_BUNDLE_MAX_ENTRIES } from '../dynamic-workflows/run-bundle';

let base: string;
let runDir: string;
let outside: string;

function write(rel: string, content = 'x'): void {
  const abs = join(runDir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lion-run-bundle-'));
  runDir = join(base, 'run-1');
  outside = join(base, 'outside');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'nao pode aparecer');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('listRunBundle (D25c)', () => {
  it('lista SO a lista fechada, com name/relativePath/sizeBytes/mtime, em ordem estavel', () => {
    write('workflow.js', 'meta');
    write('workflow.manifest.json', '{}');
    write('logs/events.jsonl', '{"a":1}\n');
    write('schemas/validator.json', '{}');
    write('checkpoints/c-0001.json', '{}');
    write('artifacts/sub/relatorio.md', '# ok');
    write('artifacts/a.txt', 'aa');
    write('notes.txt', 'solto');
    write('logs/other.log', 'nao');
    write('worktree/src/index.ts', 'nao');

    const entries = listRunBundle(runDir);
    expect(entries.map((e) => e.relativePath)).toEqual([
      'workflow.js',
      'workflow.manifest.json',
      'logs/events.jsonl',
      'schemas/validator.json',
      'checkpoints/c-0001.json',
      'artifacts/a.txt',
      'artifacts/sub/relatorio.md',
    ]);
    const manifest = entries.find((e) => e.relativePath === 'workflow.manifest.json')!;
    expect(manifest.name).toBe('workflow.manifest.json');
    expect(manifest.sizeBytes).toBe(2);
    expect(() => new Date(manifest.mtime).toISOString()).not.toThrow();
    expect(manifest.mtime).toBe(new Date(manifest.mtime).toISOString());
    for (const e of entries) {
      expect(e.relativePath).not.toMatch(/\\|\.\./);
    }
  });

  it('entradas ausentes sao puladas (runDir parcial ou vazio => lista parcial/vazia, sem lancar)', () => {
    expect(listRunBundle(runDir)).toEqual([]);
    write('workflow.js');
    expect(listRunBundle(runDir).map((e) => e.relativePath)).toEqual(['workflow.js']);
    expect(listRunBundle(join(base, 'inexistente'))).toEqual([]);
  });

  it('cap de entradas: para em maxEntries (default RUN_BUNDLE_MAX_ENTRIES = 500)', () => {
    write('workflow.js');
    for (let i = 0; i < 12; i += 1) write(`artifacts/f-${String(i).padStart(2, '0')}.txt`);
    expect(listRunBundle(runDir, 5)).toHaveLength(5);
    expect(listRunBundle(runDir)).toHaveLength(13);
    expect(RUN_BUNDLE_MAX_ENTRIES).toBe(500);
  });

  it('symlink/junction dentro de artifacts NAO e seguido: nada de fora do runDir aparece', () => {
    write('artifacts/a.txt');
    let linked = false;
    try {
      symlinkSync(outside, join(runDir, 'artifacts', 'link-dir'), 'junction');
      linked = true;
    } catch {
    }
    try {
      symlinkSync(join(outside, 'secret.txt'), join(runDir, 'artifacts', 'link-file'));
      linked = true;
    } catch {
    }
    const entries = listRunBundle(runDir);
    expect(entries.map((e) => e.relativePath)).toEqual(['artifacts/a.txt']);
    expect(entries.some((e) => e.relativePath.includes('link'))).toBe(false);
    expect(entries.some((e) => e.relativePath.includes('secret'))).toBe(false);
    if (!linked) {
      expect(entries).toHaveLength(1);
    }
  });

  it('nunca sai do runDir: `..` na raiz nao vaza e a pasta pai fica intocada', () => {
    writeFileSync(join(base, 'workflow.js'), 'pai');
    write('workflow.manifest.json');
    const entries = listRunBundle(join(runDir, 'artifacts', '..'));
    expect(entries.map((e) => e.relativePath)).toEqual(['workflow.manifest.json']);
  });
});
