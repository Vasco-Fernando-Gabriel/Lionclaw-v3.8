import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const indexSrc = readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

describe('terminal quit seams (index.ts, assercao de fonte)', () => {
  it('boot-env-snapshot e o PRIMEIRO import (antes das mutacoes de env)', () => {
    const firstImport = indexSrc.match(/^import .*$/m);
    expect(firstImport?.[0]).toContain('./boot-env-snapshot');
  });

  it('before-quit chama killAllTerminalSessions ANTES dos awaits de rede', () => {
    const beforeQuitIdx = indexSrc.indexOf("app.on('before-quit'");
    expect(beforeQuitIdx).toBeGreaterThan(-1);
    const killIdx = indexSrc.indexOf('killAllTerminalSessions()', beforeQuitIdx);
    const firstAwaitIdx = indexSrc.indexOf('await stopTelegramBot()', beforeQuitIdx);
    const exitIdx = indexSrc.indexOf('app.exit(0);', beforeQuitIdx);
    expect(killIdx).toBeGreaterThan(beforeQuitIdx);
    expect(firstAwaitIdx).toBeGreaterThan(-1);
    expect(killIdx).toBeLessThan(firstAwaitIdx);
    expect(killIdx).toBeLessThan(exitIdx);
  });

  it('handler de SIGTERM/SIGINT tambem chama killAllTerminalSessions', () => {
    const signalIdx = indexSrc.indexOf("for (const signal of ['SIGTERM', 'SIGINT']");
    expect(signalIdx).toBeGreaterThan(-1);
    const killIdx = indexSrc.indexOf('killAllTerminalSessions()', signalIdx);
    const processExitIdx = indexSrc.indexOf('process.exit(0)', signalIdx);
    expect(killIdx).toBeGreaterThan(signalIdx);
    expect(killIdx).toBeLessThan(processExitIdx);
  });
});
