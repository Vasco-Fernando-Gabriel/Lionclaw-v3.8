
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
  const match = source.match(new RegExp('const ' + name + " = '([^']*)';"));
  if (!match) throw new Error('marcador ' + name + ' nao encontrado');
  return match[1];
}

const V111_SOURCE = readMigration('v111-dynamic-workflow-builder-green-check.ts');

describe('migration v111 dynamic-workflow builder green-check no dev-loop (R10, sem DB)', () => {
  it('R10 metade 1: a V113 (FIX F2-S7) SUPERSEDE a secao green-check da V111 no seed .ts', () => {
    const neu = grabBlock(V111_SOURCE, 'NEW_SECTION');
    expect(neu).toContain('MESCLAR os findings dela no MESMO set de convergencia');
    expect(dynamicWorkflowBuilder.systemPrompt).not.toContain(
      'MESCLAR os findings dela no MESMO set de convergencia',
    );
    expect(dynamicWorkflowBuilder.systemPrompt).toContain(
      'green-check do host VERDE (green.ok, gate deterministico)',
    );
  });

  it('R10 metade 1: o NEW_PRIMITIVES aparece VERBATIM no seed .ts (greenCheck no ctx)', () => {
    const neu = grabBlock(V111_SOURCE, 'NEW_PRIMITIVES');
    expect(dynamicWorkflowBuilder.systemPrompt).toContain(neu);
  });

  it('os OLD_BLOCKs (ancora) existem no seed e sao substring dos NEW (REPLACE compoe)', () => {
    const oldSection = grabBlock(V111_SOURCE, 'OLD_SECTION');
    const newSection = grabBlock(V111_SOURCE, 'NEW_SECTION');
    const oldPrim = grabBlock(V111_SOURCE, 'OLD_PRIMITIVES');
    const newPrim = grabBlock(V111_SOURCE, 'NEW_PRIMITIVES');
    expect(newSection).toContain(oldSection.replace('\n\n## Regras do workflow.js (subset ESM restrito)', ''));
    expect(newSection).toContain('## Regras do workflow.js (subset ESM restrito)');
    expect(newPrim).toContain(oldPrim.replace('.', ''));
  });

  it('o NEW_MARKER e exclusivo do NEW (ausente nos OLD): guard idempotente', () => {
    const marker = grabMarker(V111_SOURCE, 'NEW_MARKER');
    const oldSection = grabBlock(V111_SOURCE, 'OLD_SECTION');
    const newSection = grabBlock(V111_SOURCE, 'NEW_SECTION');
    expect(marker).toBe('Green-check objetivo por rodada (host; obrigatorio no dev-loop)');
    expect(newSection).toContain(marker);
    expect(oldSection).not.toContain(marker);
  });

  it('o comportamento muda: a secao manda o .js chamar greenCheck e mesclar antes do devBlockersOf', () => {
    const neu = grabBlock(V111_SOURCE, 'NEW_SECTION');
    expect(neu).toContain('greenCheck()');
    expect(neu).toContain('NAO-BLOQUEANTE');
    expect(neu).toContain('dedupeFindings([...validators, { findings: greenCheckFindings }])');
    expect(neu).toContain('ANTES de calcular const blockers = devBlockersOf(findings)');
    expect(neu).toContain('arg.final===true');
  });

  it('idempotencia + alvo: DOIS UPDATEs em dynamic-workflow-builder com guard NOT LIKE', () => {
    expect(V111_SOURCE).toContain("WHERE id = 'dynamic-workflow-builder'");
    expect(V111_SOURCE).toContain('REPLACE(system_prompt');
    expect(V111_SOURCE).toContain('system_prompt LIKE ?');
    expect(V111_SOURCE).toContain('system_prompt NOT LIKE ?');
    const updateCount = (V111_SOURCE.match(/UPDATE agents SET system_prompt = REPLACE/g) || []).length;
    expect(updateCount).toBe(2);
  });

  it('zero em-dash (U+2014) no source da migration v111', () => {
    const EM_DASH = String.fromCharCode(0x2014);
    expect(V111_SOURCE).not.toContain(EM_DASH);
  });
});
