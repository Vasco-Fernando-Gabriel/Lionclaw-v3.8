
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dynamicWorkflowBuilder } from '../seed-agents/dynamic-workflow-builder';

const V117_SOURCE = readFileSync(
  join(__dirname, '..', 'db-migrations', 'v117-dynamic-workflow-builder-plan-review-replan.ts'),
  'utf8',
);

function grabTemplate(source: string, name: string): string {
  const m = source.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  if (!m) throw new Error('template ' + name + ' nao encontrado');
  return m[1];
}
function grabString(source: string, name: string): string {
  const m = source.match(new RegExp('const ' + name + " =\\s*'([^']*)';"));
  if (!m) throw new Error('string ' + name + ' nao encontrada');
  return m[1];
}

const SECTION = grabTemplate(V117_SOURCE, 'planReviewSection');
const MANIFEST_NEW = grabString(V117_SOURCE, 'manifestNew');
const DISCIPLINA_ANCHOR = '## Disciplina do coder: rodar ate VERDE (obrigatoria)';

describe('migration v117 builder honra replan no plan-review (R10, sem DB)', () => {
  it('R10 metade 1: a secao + a frase do manifest aparecem VERBATIM no seed', () => {
    expect(SECTION.length).toBeGreaterThan(0);
    expect(dynamicWorkflowBuilder.systemPrompt).toContain(SECTION);
    expect(dynamicWorkflowBuilder.systemPrompt).toContain(MANIFEST_NEW);
  });

  it('placement: a secao precede imediatamente "## Disciplina do coder"', () => {
    expect(dynamicWorkflowBuilder.systemPrompt).toContain(SECTION + '\n\n' + DISCIPLINA_ANCHOR);
  });

  it('ensino-chave no seed: honra decisionPayload.action + proibe gate pelado + 2 caminhos', () => {
    const p = dynamicWorkflowBuilder.systemPrompt;
    expect(p).toContain('runPlanReviewGate(escalated)');
    expect(p).toContain('review.decisionPayload.action');
    expect(p).toContain('await gate(...) PELADO');
    expect(p).toContain("'planner-replan-' + extraReplans");
    expect(p).toContain('await runPlanReviewGate(true)');
    expect(p).toContain('await runPlanReviewGate(false)');
    expect(p).toContain('planner-replan-1..MAX_PLAN_ROUNDS');
  });

  it('migration: 2 UPDATEs, SO o builder, guards de ancora + idempotencia', () => {
    expect((V117_SOURCE.match(/UPDATE agents/g) || []).length).toBe(2);
    const ids = [...V117_SOURCE.matchAll(/id = '([^']+)'/g)].map((m) => m[1]);
    expect(new Set(ids)).toEqual(new Set(['dynamic-workflow-builder']));
    expect(V117_SOURCE).toContain("NOT LIKE '%runPlanReviewGate%'");
    expect(V117_SOURCE).toContain("NOT LIKE '%REPLAN HUMANO usados pelo runPlanReviewGate%'");
  });

  it('zero em-dash (U+2014) no source da migration v117', () => {
    expect(V117_SOURCE).not.toContain(String.fromCharCode(0x2014));
  });
});
