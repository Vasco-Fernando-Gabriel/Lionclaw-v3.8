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
  const match = source.match(new RegExp('const ' + name + " = '([^']*)';"));
  if (!match) throw new Error('marcador ' + name + ' nao encontrado');
  return match[1];
}

const V101_SOURCE = readMigration('v101-dynamic-workflow-planner-respects-spec.ts');
const V108_SOURCE = readMigration('v108-dynamic-workflow-planner-writeset-integration.ts');

describe('migration v108 dynamic-workflow planner writeSetHint integracao (R10, sem DB)', () => {
  it('a cadeia compoe: o V108.OLD_BLOCK e a linha writeSetHint que a V101 introduziu', () => {
    const v101New = grabBlock(V101_SOURCE, 'NEW_BLOCK');
    const v108Old = grabBlock(V108_SOURCE, 'OLD_BLOCK');
    expect(v101New).toContain(v108Old);
  });

  it('o NEW_MARKER da V108 e exclusivo do NEW (ausente no OLD): guard idempotente', () => {
    const marker = grabMarker(V108_SOURCE, 'NEW_MARKER');
    const old = grabBlock(V108_SOURCE, 'OLD_BLOCK');
    const neu = grabBlock(V108_SOURCE, 'NEW_BLOCK');
    expect(marker).toBe('pontos de integracao/wiring');
    expect(neu).toContain(marker);
    expect(old).not.toContain(marker);
  });

  it('o NEW_BLOCK da V108 ataca os 2 modos de falha vistos (entry do pacote + cross-pacote)', () => {
    const neu = grabBlock(V108_SOURCE, 'NEW_BLOCK');
    expect(neu).toContain('ENTRY do pacote');
    expect(neu).toContain('index.ts');
    expect(neu).toContain('SEMPRE entra no writeSet');
    expect(neu).toContain('cross-pacote');
    expect(neu).toContain('renderer');
  });

  it('o NEW_BLOCK preserva a guarda anti-over-scope com tie-breaker ASSIMETRICO', () => {
    const neu = grabBlock(V108_SOURCE, 'NEW_BLOCK');
    expect(neu).toContain('MINIMO porem COMPLETO');
    expect(neu).toContain('isolacao/paralelismo');
    expect(neu).toContain('caminho LITERAL');
    expect(neu).toContain('NUNCA alargue');
    expect(neu).toContain('SEQUENCIAL');
    expect(neu).not.toContain('prefira o LARGO');
  });

  it('R10 metade 1: o NEW_BLOCK da V108 aparece VERBATIM no seed .ts (fresh installs)', () => {
    const neu = grabBlock(V108_SOURCE, 'NEW_BLOCK');
    const neuLiteral = neu.replace(/\\`/g, '`');
    expect(dynamicWorkflowSprintPlanner.systemPrompt).toContain(neuLiteral);
  });

  it('idempotencia do UPDATE: o guard NOT LIKE %NEW_MARKER% impede re-aplicacao', () => {
    expect(V108_SOURCE).toContain('system_prompt LIKE ?');
    expect(V108_SOURCE).toContain('system_prompt NOT LIKE ?');
    expect(V108_SOURCE).toContain("WHERE id = 'dynamic-workflow-sprint-planner'");
    expect(V108_SOURCE).toContain('REPLACE(system_prompt');
  });

  it('zero em-dash (U+2014) no source da migration v108', () => {
    const EM_DASH = String.fromCharCode(0x2014);
    expect(V108_SOURCE).not.toContain(EM_DASH);
  });
});
