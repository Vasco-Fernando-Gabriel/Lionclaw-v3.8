import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const MAIN_ROOT = join(__dirname, '..');

const ALLOWED_READERS = new Set(['orchestrator-selection.ts', 'lanes.ts', 'ipc/settings.ts', 'agent-sync.ts']);

const GLOBAL_EFFORT_READ =
  /getSetting\(\s*['"`]orchestrator_(?:effort|codex_effort|kimi_effort|grok_effort)['"`]\s*\)/g;

function listMainSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listMainSources(full, out);
    } else if (/\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('7.6: nenhum executor le o effort global por getSetting fora da allowlist', () => {
  it('electron/main sem leitura direta de orchestrator_*_effort fora de orchestrator-selection/lanes/ipc-settings/agent-sync', () => {
    const offenders: string[] = [];
    for (const file of listMainSources(MAIN_ROOT)) {
      const rel = relative(MAIN_ROOT, file).split(sep).join('/');
      if (ALLOWED_READERS.has(rel)) continue;
      const source = readFileSync(file, 'utf8');
      const matches = source.match(GLOBAL_EFFORT_READ);
      if (matches) offenders.push(`${rel}: ${matches.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('a allowlist continua sendo a unica fonte das leituras (sanidade: orchestrator-selection le as 4 chaves)', () => {
    const source = readFileSync(join(MAIN_ROOT, 'orchestrator-selection.ts'), 'utf8');
    expect(source.match(GLOBAL_EFFORT_READ)?.length).toBe(4);
  });
});
