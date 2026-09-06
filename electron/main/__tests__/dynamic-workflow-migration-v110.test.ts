
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dynamicWorkflowBuilder } from '../seed-agents/dynamic-workflow-builder';

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

const V110_SOURCE = readMigration('v110-dynamic-workflow-builder-coder-green.ts');

describe('migration v110 dynamic-workflow builder coder rodar-ate-verde (R10, sem DB)', () => {
  it('R10 metade 1: o CONTEUDO do NEW_BLOCK sobrevive no seed .ts (fresh installs)', () => {
    const old = grabBlock(V110_SOURCE, 'OLD_BLOCK');
    const neu = grabBlock(V110_SOURCE, 'NEW_BLOCK');
    expect(neu.startsWith(old)).toBe(true);
    const disciplina = neu.slice(old.length).replace(/^\n+/, '');
    expect(disciplina.startsWith('## Disciplina do coder: rodar ate VERDE (obrigatoria)')).toBe(
      true,
    );
    expect(dynamicWorkflowBuilder.systemPrompt).toContain(old);
    expect(dynamicWorkflowBuilder.systemPrompt).toContain(disciplina);
  });

  it('o OLD_BLOCK (ancora) existe no seed e e substring do NEW (REPLACE compoe)', () => {
    const old = grabBlock(V110_SOURCE, 'OLD_BLOCK');
    const neu = grabBlock(V110_SOURCE, 'NEW_BLOCK');
    expect(dynamicWorkflowBuilder.systemPrompt).toContain(old);
    expect(neu).toContain(old);
  });

  it('o NEW_MARKER e exclusivo do NEW (ausente no OLD): guard idempotente', () => {
    const marker = grabMarker(V110_SOURCE, 'NEW_MARKER');
    const old = grabBlock(V110_SOURCE, 'OLD_BLOCK');
    const neu = grabBlock(V110_SOURCE, 'NEW_BLOCK');
    expect(marker).toBe('rodar ate VERDE (obrigatoria)');
    expect(neu).toContain(marker);
    expect(old).not.toContain(marker);
  });

  it('o comportamento muda: contrato exige rodar typecheck/test/build ate verde', () => {
    const neu = grabBlock(V110_SOURCE, 'NEW_BLOCK');
    expect(neu).toContain('typecheck');
    expect(neu).toContain('build');
    expect(neu).toContain('iterando ate TODOS passarem');
    expect(neu).toContain('vermelho NAO e pronto');
    expect(neu).toContain('valide antes de declarar pronto');
    expect(neu).toContain('NUNCA o generico');
  });

  it('idempotencia + alvo: UPDATE em dynamic-workflow-builder com guard NOT LIKE', () => {
    expect(V110_SOURCE).toContain("WHERE id = 'dynamic-workflow-builder'");
    expect(V110_SOURCE).toContain('REPLACE(system_prompt');
    expect(V110_SOURCE).toContain('system_prompt LIKE ?');
    expect(V110_SOURCE).toContain('system_prompt NOT LIKE ?');
  });

  it('zero em-dash (U+2014) no source da migration v110', () => {
    const EM_DASH = String.fromCharCode(0x2014);
    expect(V110_SOURCE).not.toContain(EM_DASH);
  });
});
