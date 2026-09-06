
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dynamicWorkflowSprintPlanner } from '../seed-agents/dynamic-workflow-sprint-planner';

const MIGRATIONS_DIR = join(__dirname, '..', 'db-migrations');

function readMigration(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
}

function grabBlock(source: string, name: string): string {
  const match = source.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  if (!match) throw new Error('bloco ' + name + ' nao encontrado');
  return match[1];
}

function grabMarker(source: string, name: string): string {
  const match = source.match(new RegExp("const " + name + " = '([^']*)';"));
  if (!match) throw new Error('marcador ' + name + ' nao encontrado');
  return match[1];
}

const V104_SOURCE = readMigration(
  'v104-dynamic-workflow-planner-validators-fixed.ts',
);
const V105_SOURCE = readMigration(
  'v105-dynamic-workflow-planner-coder-catalog.ts',
);

describe('migration v105 dynamic-workflow planner coder catalog (R10, sem DB)', () => {
  it('a cadeia compoe: V104.NEW_BLOCK e EXATAMENTE o V105.OLD_BLOCK (V105 roda depois)', () => {
    const v104New = grabBlock(V104_SOURCE, 'NEW_BLOCK');
    const v105Old = grabBlock(V105_SOURCE, 'OLD_BLOCK');
    expect(v105Old).toBe(v104New);
  });

  it('o NEW_MARKER da V105 e exclusivo do NEW (ausente no OLD): guard idempotente', () => {
    const marker = grabMarker(V105_SOURCE, 'NEW_MARKER');
    const old = grabBlock(V105_SOURCE, 'OLD_BLOCK');
    const neu = grabBlock(V105_SOURCE, 'NEW_BLOCK');
    expect(marker).toBe('FALLBACK DE ULTIMO RECURSO');
    expect(neu).toContain(marker);
    expect(old).not.toContain(marker);
  });

  it('a V105 PRESERVA o bullet de validatorAgentIds da V104 (replace coeso, nao apaga)', () => {
    const old = grabBlock(V105_SOURCE, 'OLD_BLOCK');
    const neu = grabBlock(V105_SOURCE, 'NEW_BLOCK');
    expect(old).toContain('validatorAgentIds');
    expect(neu).toContain('validatorAgentIds');
    expect(neu).toContain('VAZIO');
  });

  it('o NEW_BLOCK da V105 elege o especialista por stack e marca o generico como fallback', () => {
    const neu = grabBlock(V105_SOURCE, 'NEW_BLOCK');
    expect(neu).toContain('Coders disponiveis');
    expect(neu).toContain('typescript-pro');
    expect(neu).toContain('electron-pro');
    expect(neu).toContain('frontend-developer');
    expect(neu).toContain('python-pro');
    expect(neu).toContain('dynamic-workflow-coder');
    expect(neu).toContain('FALLBACK DE ULTIMO RECURSO');
  });

  it('R10 metade 1: o NEW_BLOCK da V105 aparece VERBATIM no seed .ts (fresh installs)', () => {
    const neu = grabBlock(V105_SOURCE, 'NEW_BLOCK');
    const neuLiteral = neu.replace(/\\`/g, '`');
    expect(dynamicWorkflowSprintPlanner.systemPrompt).toContain(neuLiteral);
  });

  it('idempotencia do UPDATE: o guard NOT LIKE %NEW_MARKER% impede re-aplicacao', () => {
    expect(V105_SOURCE).toContain('system_prompt LIKE ?');
    expect(V105_SOURCE).toContain('system_prompt NOT LIKE ?');
    expect(V105_SOURCE).toContain("WHERE id = 'dynamic-workflow-sprint-planner'");
    expect(V105_SOURCE).toContain('REPLACE(system_prompt');
  });

  it('zero em-dash (U+2014) no source da migration v105', () => {
    const EM_DASH = String.fromCharCode(0x2014);
    expect(V105_SOURCE).not.toContain(EM_DASH);
  });
});
