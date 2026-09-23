import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dynamicWorkflowBuilder } from '../seed-agents/dynamic-workflow-builder';

const V118_SOURCE = readFileSync(
  join(__dirname, '..', 'db-migrations', 'v118-dynamic-workflow-builder-effective-retry.ts'),
  'utf8',
);

function grabTemplate(source: string, name: string): string {
  const m = source.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  if (!m) throw new Error('template ' + name + ' nao encontrado');
  return m[1];
}

const SECTION = grabTemplate(V118_SOURCE, 'retrySection');
const ANCHOR = '## Regras do workflow.js (subset ESM restrito)';

describe('migration v118 retry efetivo no builder (R10, sem DB)', () => {
  it('R10 metade 1: a secao aparece VERBATIM no seed (fresh installs)', () => {
    expect(SECTION.length).toBeGreaterThan(0);
    expect(dynamicWorkflowBuilder.systemPrompt).toContain(SECTION);
  });

  it('placement: a secao precede imediatamente "## Regras do workflow.js"', () => {
    expect(dynamicWorkflowBuilder.systemPrompt).toContain(SECTION + '\n\n' + ANCHOR);
  });

  it('ensino-chave no seed: nao-progresso + assinatura por where|problem + nao mexe na convergencia', () => {
    const p = dynamicWorkflowBuilder.systemPrompt;
    expect(p).toContain('detectar NAO-PROGRESSO');
    expect(p).toContain('blockerSignature(findings)');
    expect(p).toContain('stuckNote(stuck)');
    expect(p).toContain('where|problem, NUNCA por id');
    expect(p).toContain('NAO mexe na condicao de convergencia');
  });

  it('migration: 1 UPDATE, SO o builder, guards de ancora + idempotencia', () => {
    expect((V118_SOURCE.match(/UPDATE agents/g) || []).length).toBe(1);
    const ids = [...V118_SOURCE.matchAll(/id = '([^']+)'/g)].map((m) => m[1]);
    expect(new Set(ids)).toEqual(new Set(['dynamic-workflow-builder']));
    expect(V118_SOURCE).toContain("NOT LIKE '%## Retry efetivo: nao-progresso%'");
  });

  it('zero em-dash (U+2014) no source da migration v118', () => {
    expect(V118_SOURCE).not.toContain(String.fromCharCode(0x2014));
  });
});
