import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, 'electron/main/pipeline-engine', rel), 'utf-8');
}

function count(haystack: string, needle: string): number {
  let n = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    n++;
    pos += needle.length;
  }
  return n;
}

describe('SC-1 — provas de fonte (AC-C8 / AC-C10)', () => {
  it('AC-C8 [INV]: caminho feliz de spawnAgent e dispatch das fases AUTO byte-identicos (mudanca so no catch)', () => {
    const source = read('index.ts');

    expect(count(source, 'executeAgent({')).toBe(1);

    const spawnStart = source.indexOf('public async spawnAgent');
    const tryStart = source.indexOf('try {', spawnStart);
    const catchStart = source.indexOf('} catch (caughtError) {', tryStart);
    expect(spawnStart).toBeGreaterThan(-1);
    expect(tryStart).toBeGreaterThan(spawnStart);
    expect(catchStart).toBeGreaterThan(tryStart);
    const happyPath = source.slice(tryStart, catchStart);
    expect(happyPath).not.toContain('rebuildPromptOnRetry');
    expect(happyPath).not.toContain('isTransientCodexSessionError');
    expect(happyPath).not.toContain('retryRequest');

    expect(source).toContain('const MAX_CODEX_AUTO_RETRIES = 1;');
    expect(source).toContain('this.closeCodexSessions(state);');
    expect(source).toContain(
      '[Codex parou sem produzir saida — reiniciando a fase automaticamente com um processo novo...]',
    );

    const catchBlock = source.slice(catchStart);
    expect(catchBlock).toContain('throw new PipelinePausedError(');
    expect(catchBlock).toContain("title: 'CODEX FALHOU',");
  });

  it('AC-C8 [INV]: o retry e limitado por flag LOCAL inline (sem recursao, sem contador persistente)', () => {
    const source = read('index.ts');
    expect(source).toContain('let codexSessionRetryAttempted = false;');
    expect(count(source, '!codexSessionRetryAttempted')).toBe(1);
    expect(count(source, 'codexSessionRetryAttempted = true;')).toBe(1);
    const spawnStart = source.indexOf('public async spawnAgent');
    const spawnBody = source.slice(spawnStart, source.indexOf('private closeCodexSessions'));
    expect(spawnBody).not.toContain('this.spawnAgent(');
  });

  it('AC-C10: as DUAS interfaces SpawnAgentOptions declaram rebuildPromptOnRetry?', () => {
    expect(read('index.ts')).toContain('rebuildPromptOnRetry?: () => string;');
    expect(read('handlers/context.ts')).toContain('rebuildPromptOnRetry?: () => string;');
  });

  it('AC-C10: TODOS os handlers conversacionais passam o callback em CADA callsite com continueSession', () => {
    const expectations: Array<{ file: string; conversationalCallsites: number }> = [
      { file: 'handlers/dev-feature.ts', conversationalCallsites: 6 },
      { file: 'handlers/security.ts', conversationalCallsites: 5 },
      { file: 'handlers/architecture-review.ts', conversationalCallsites: 4 },
      { file: 'handlers/development-v2.ts', conversationalCallsites: 4 },
    ];

    for (const { file, conversationalCallsites } of expectations) {
      const src = read(file);
      const callsites = count(src, 'continueSession: true') + count(src, 'continueSession: sessionEntry.alive');
      const callbacks = count(src, 'rebuildPromptOnRetry: () =>');
      expect(callsites, `${file}: numero de callsites conversacionais mudou — atualize o retry SC-1 junto`).toBe(
        conversationalCallsites,
      );
      expect(
        callbacks,
        `${file}: todo callsite conversacional com continueSession deve passar rebuildPromptOnRetry`,
      ).toBe(conversationalCallsites);
      expect(count(src, 'buildCodexResumePrompt(')).toBeGreaterThanOrEqual(conversationalCallsites);
    }
  });
});
