import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const MAIN = join(__dirname, '..');

const ALLOWLIST = new Set(['ipc/chat-deprecated.ts', 'db.ts']);

const RE_IMPORT_BLOCK = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
const RE_NAMESPACE_CALL = /\bdb\.getActive(?:Chat)?Session\s*\(/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function importsHeuristic(source: string): boolean {
  for (const match of source.matchAll(RE_IMPORT_BLOCK)) {
    const names = match[1] ?? '';
    if (/\bgetActiveChatSession\b/.test(names) || /\bgetActiveSession\b/.test(names)) return true;
  }
  return RE_NAMESPACE_CALL.test(source);
}

describe('AC-3 (RM2): nenhum arquivo do main fora da allowlist importa getActiveChatSession/getActiveSession', () => {
  it('varredura de electron/main (exceto __tests__)', () => {
    const offenders: string[] = [];
    for (const file of walk(MAIN)) {
      const rel = relative(MAIN, file).split(sep).join('/');
      if (ALLOWLIST.has(rel)) continue;
      if (importsHeuristic(readFileSync(file, 'utf8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('a allowlist e exatamente ipc/chat-deprecated.ts (+ db.ts, onde a funcao e definida)', () => {
    expect([...ALLOWLIST].sort()).toEqual(['db.ts', 'ipc/chat-deprecated.ts']);
    const deprecated = readFileSync(join(MAIN, 'ipc', 'chat-deprecated.ts'), 'utf8');
    expect(importsHeuristic(deprecated)).toBe(true);
  });
});
