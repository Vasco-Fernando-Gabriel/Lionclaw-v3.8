
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  computeRepoGraphSavings,
  REPO_GRAPH_METRICS_MIN_TURNS,
} from '../repo-graph/metrics';
import type { RepoGraphTurnSample } from '../repo-graph/types';


function turns(count: number, toolCalls: number, tokens: number): RepoGraphTurnSample[] {
  return Array.from({ length: count }, () => ({ toolCalls, tokens }));
}


describe('computeRepoGraphSavings - medias por grupo', () => {
  it('grupos vazios: turns=0, medias null, percentuais null, windowMet=false', () => {
    const result = computeRepoGraphSavings([], []);
    expect(result.withRepo).toEqual({ turns: 0, avgToolCalls: null, avgTokens: null });
    expect(result.withoutRepo).toEqual({ turns: 0, avgToolCalls: null, avgTokens: null });
    expect(result.toolCallsSavingsPct).toBeNull();
    expect(result.tokensSavingsPct).toBeNull();
    expect(result.windowMet).toBe(false);
    expect(result.minTurnsWindow).toBe(REPO_GRAPH_METRICS_MIN_TURNS);
  });

  it('media simples por turno com arredondamento a 1 casa', () => {
    const withRepo: RepoGraphTurnSample[] = [
      { toolCalls: 2, tokens: 1000 },
      { toolCalls: 3, tokens: 2000 },
      { toolCalls: 5, tokens: 1500 },
    ];
    const result = computeRepoGraphSavings(withRepo, []);
    expect(result.withRepo.turns).toBe(3);
    expect(result.withRepo.avgToolCalls).toBe(3.3);
    expect(result.withRepo.avgTokens).toBe(1500);
  });

  it('a constante da janela e 50 (formula fixada da spec)', () => {
    expect(REPO_GRAPH_METRICS_MIN_TURNS).toBe(50);
  });
});

describe('computeRepoGraphSavings - janela 50+ (windowMet)', () => {
  it('49 turnos num grupo: windowMet=false e percentuais null (medias parciais retornam)', () => {
    const result = computeRepoGraphSavings(turns(49, 3, 1000), turns(80, 6, 2000));
    expect(result.windowMet).toBe(false);
    expect(result.toolCallsSavingsPct).toBeNull();
    expect(result.tokensSavingsPct).toBeNull();
    expect(result.withRepo.turns).toBe(49);
    expect(result.withRepo.avgToolCalls).toBe(3);
    expect(result.withoutRepo.avgTokens).toBe(2000);
  });

  it('50 turnos exatos nos 2 grupos: windowMet=true (janela e 50+, inclusive)', () => {
    const result = computeRepoGraphSavings(turns(50, 3, 1000), turns(50, 6, 2000));
    expect(result.windowMet).toBe(true);
    expect(result.toolCallsSavingsPct).not.toBeNull();
  });

  it('janela so no grupo SEM repo: windowMet=false', () => {
    const result = computeRepoGraphSavings(turns(120, 3, 1000), turns(10, 6, 2000));
    expect(result.windowMet).toBe(false);
    expect(result.toolCallsSavingsPct).toBeNull();
  });
});

describe('computeRepoGraphSavings - percentuais de economia', () => {
  it('economia positiva: COM repo gasta menos (sinal positivo)', () => {
    const result = computeRepoGraphSavings(turns(60, 2, 1000), turns(60, 8, 4000));
    expect(result.windowMet).toBe(true);
    expect(result.toolCallsSavingsPct).toBe(75); // (8-2)/8 = 75%
    expect(result.tokensSavingsPct).toBe(75); // (4000-1000)/4000 = 75%
  });

  it('economia negativa: COM repo gasta MAIS (sinal preservado, sem clamp)', () => {
    const result = computeRepoGraphSavings(turns(60, 9, 6000), turns(60, 6, 4000));
    expect(result.toolCallsSavingsPct).toBe(-50); // (6-9)/6 = -50%
    expect(result.tokensSavingsPct).toBe(-50);
  });

  it('base zero (sem repo com media 0): percentual null (divisao indefinida)', () => {
    const result = computeRepoGraphSavings(turns(60, 2, 1000), turns(60, 0, 0));
    expect(result.windowMet).toBe(true);
    expect(result.toolCallsSavingsPct).toBeNull();
    expect(result.tokensSavingsPct).toBeNull();
  });

  it('percentual arredondado a 1 casa', () => {
    const result = computeRepoGraphSavings(turns(60, 1, 1), turns(60, 3, 3));
    expect(result.toolCallsSavingsPct).toBe(66.7);
  });
});


const MAIN_DIR = join(__dirname, '..');
const ROOT_DIR = join(MAIN_DIR, '..', '..');

function readSource(absOrRel: string, base: string = MAIN_DIR): string {
  return readFileSync(join(base, absOrRel), 'utf8');
}

describe('D-5 - guardrail estatico do SQL em db.ts', () => {
  const dbSrc = readSource('db.ts');

  it('db.ts exporta getRepoGraphSavingsMetrics e delega ao modulo puro', () => {
    expect(dbSrc).toContain('export function getRepoGraphSavingsMetrics');
    expect(dbSrc).toContain("import { computeRepoGraphSavings } from './repo-graph/metrics'");
    expect(dbSrc).toContain('return computeRepoGraphSavings(');
  });

  it('agrega activity_log por turno (GROUP BY session_id, turn_index)', () => {
    const start = dbSrc.indexOf('export function getRepoGraphSavingsMetrics');
    const block = dbSrc.slice(start, start + 2500);
    expect(block).toContain('FROM activity_log a');
    expect((block.match(/GROUP BY a\.session_id, a\.turn_index/g) ?? []).length).toBe(2);
  });

  it("conta SO tool calls nao-repo-graph (kind='tool' + NOT LIKE nas 2 grafias)", () => {
    const start = dbSrc.indexOf('export function getRepoGraphSavingsMetrics');
    const block = dbSrc.slice(start, start + 2500);
    expect(block).toContain("a.kind = 'tool'");
    expect(block).toContain("NOT LIKE '%repo\\\\_graph%' ESCAPE '\\\\'");
    expect(block).toContain("NOT LIKE '%repo-graph%'");
  });

  it('tokens = input_tokens + output_tokens (COALESCE 0)', () => {
    const start = dbSrc.indexOf('export function getRepoGraphSavingsMetrics');
    const block = dbSrc.slice(start, start + 2500);
    expect(block).toContain('COALESCE(a.input_tokens, 0) + COALESCE(a.output_tokens, 0)');
  });

  it('grupo COM repo: turnos com used=1 em repo_graph_turn_usage (EXISTS correlacionado)', () => {
    const start = dbSrc.indexOf('export function getRepoGraphSavingsMetrics');
    const block = dbSrc.slice(start, start + 2500);
    expect(block).toContain('FROM repo_graph_turn_usage u');
    expect(block).toContain('u.used = 1');
    expect(block).toContain('u.turn_index = a.turn_index');
  });

  it('grupo SEM repo: exclui sessoes com attach E com uso historico do graph', () => {
    const start = dbSrc.indexOf('export function getRepoGraphSavingsMetrics');
    const block = dbSrc.slice(start, start + 2500);
    expect(block).toContain(
      'NOT IN (SELECT session_id FROM session_active_repository)',
    );
    expect(block).toContain(
      'NOT IN (SELECT DISTINCT session_id FROM repo_graph_turn_usage)',
    );
  });
});

describe('D-5 - guardrail estatico do canal IPC e do preload', () => {
  it("ipc/repo-graph.ts registra repo-graph:metrics com { error } sem throw", () => {
    const ipcSrc = readSource('ipc/repo-graph.ts');
    expect(ipcSrc).toContain("ipcMain.handle('repo-graph:metrics'");
    expect(ipcSrc).toContain('getRepoGraphSavingsMetrics()');
    const start = ipcSrc.indexOf("ipcMain.handle('repo-graph:metrics'");
    const block = ipcSrc.slice(start, start + 500);
    expect(block).toContain('return { error: (err as Error).message }');
  });

  it('preload expoe window.lionclaw.repoGraph.metrics', () => {
    const preloadSrc = readSource(join('electron', 'preload', 'index.ts'), ROOT_DIR);
    expect(preloadSrc).toContain("metrics: () => ipcRenderer.invoke('repo-graph:metrics')");
  });

  it('golden channel list inclui o canal novo com justificativa', () => {
    const listSrc = readSource(join('electron', 'main', '__tests__', 'ipc-channel-list.test.ts'), ROOT_DIR);
    expect(listSrc).toContain("'repo-graph:metrics',");
    expect(listSrc).toContain('Sprint A4');
  });
});
