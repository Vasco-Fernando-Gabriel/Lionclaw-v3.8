
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dynamicWorkflowSprintPlanner } from '../seed-agents/dynamic-workflow-sprint-planner';

const MIGRATIONS_DIR = join(__dirname, '..', 'db-migrations');
const V116_SOURCE = readFileSync(
  join(MIGRATIONS_DIR, 'v116-dynamic-workflow-sprint-planner-whole-project.ts'),
  'utf8',
);

function grabPrinciple6(source: string): string {
  const arr = source.match(/const principle6 = \[([\s\S]*?)\]\.join/);
  if (!arr) throw new Error('array principle6 nao encontrado na migration');
  const lines = [...arr[1].matchAll(/^\s*'(.*)',\s*$/gm)].map((m) => m[1]);
  if (lines.length === 0) throw new Error('nenhuma linha extraida do principle6');
  return lines.join('\n');
}

const PRINCIPLE6 = grabPrinciple6(V116_SOURCE);
const ANCHOR = '## O que voce retorna';
const MARKER = 'PLANEJA O PROJETO INTEIRO';

describe('migration v116 sprint-planner planeja o projeto INTEIRO (R10, sem DB)', () => {
  it('R10 metade 1: o principio 6 aparece VERBATIM no seed (fresh installs)', () => {
    expect(PRINCIPLE6.length).toBeGreaterThan(0);
    expect(dynamicWorkflowSprintPlanner.systemPrompt).toContain(PRINCIPLE6);
  });

  it('placement: o principio 6 precede imediatamente "## O que voce retorna"', () => {
    expect(dynamicWorkflowSprintPlanner.systemPrompt).toContain(
      PRINCIPLE6 + '\n\n' + ANCHOR,
    );
  });

  it('o ensino novo (ancora no repo + ignora secao de outro motor) esta no seed', () => {
    const p = dynamicWorkflowSprintPlanner.systemPrompt;
    expect(p).toContain('O estado REAL do repo');
    expect(p).toContain('DevelopmentV2SprintMetadata');
    expect(p).toContain('NUNCA herde a numeracao de sprint');
    expect(p).toContain('A primeira sprint e a fundacao');
  });

  it('migration: UPDATE UNICO no agente certo, com guard de ancora + idempotencia', () => {
    expect((V116_SOURCE.match(/UPDATE agents/g) || []).length).toBe(1);
    expect(
      (V116_SOURCE.match(/id = 'dynamic-workflow-sprint-planner'/g) || []).length,
    ).toBe(1);
    expect(V116_SOURCE).toContain("system_prompt LIKE '%' || ? || '%'");
    expect(V116_SOURCE).toContain(
      "system_prompt NOT LIKE '%PLANEJA O PROJETO INTEIRO%'",
    );
    expect(PRINCIPLE6).toContain(MARKER);
  });

  it('migration NAO toca nenhum outro agente (so o sprint-planner)', () => {
    const ids = [...V116_SOURCE.matchAll(/id = '([^']+)'/g)].map((m) => m[1]);
    expect(new Set(ids)).toEqual(new Set(['dynamic-workflow-sprint-planner']));
  });

  it('zero em-dash (U+2014) no source da migration v116', () => {
    expect(V116_SOURCE).not.toContain(String.fromCharCode(0x2014));
  });
});
