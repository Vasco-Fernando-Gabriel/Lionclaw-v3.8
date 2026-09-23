import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dynamicWorkflowBuilder } from '../seed-agents/dynamic-workflow-builder';

const V121_PATH = join(__dirname, '..', 'db-migrations', 'v121-dynamic-workflow-builder-coverage-only.ts');
const V121_SOURCE = readFileSync(V121_PATH, 'utf8');

const NEW_PLAN = 'validateSprintPlan (host) AUTO-CORRIGE o cosmetico';
const NEW_HELPERS = 'validateSprintPlan, o validador de cobertura, dedupeFindings';
const NEW_MANIFEST = 'o plan-validator-coverage-r0..rN + o grupo paralelo plan-validators-r0..rN';
const NEW_AGENTS = 'o plan-validator de eixo coverage; os eixos topology/criteria foram APOSENTADOS';

const OLD_PLAN = '3 validadores adversariais de plano (eixos cobertura/topologia/criterios)';
const OLD_HELPERS = 'validateSprintPlan, os 3 plan-validators, dedupeFindings';
const OLD_MANIFEST = 'os 3 plan-validators-r0..rN por eixo';
const OLD_AGENTS = 'os 3 plan-validators de eixo coverage/topology/criteria';

describe('migration v121 planejamento sem gauntlet: coverage-only + auto-fix (R10)', () => {
  it('R10 metade 1: o seed .ts JA tem o texto coverage-only (fresh installs)', () => {
    const p = dynamicWorkflowBuilder.systemPrompt;
    expect(p).toContain(NEW_PLAN);
    expect(p).toContain(NEW_HELPERS);
    expect(p).toContain(NEW_MANIFEST);
    expect(p).toContain(NEW_AGENTS);
    expect(p).not.toContain(OLD_PLAN);
    expect(p).not.toContain(OLD_HELPERS);
    expect(p).not.toContain(OLD_MANIFEST);
    expect(p).not.toContain(OLD_AGENTS);
    expect(p).not.toContain('3 plan-validators');
    expect(p).not.toContain('coverage/topology/criteria');
    expect(p).not.toContain('cobertura/topologia/criterios');
  });

  it('R10 metade 2: o source da migration injeta os 4 NEW e mira os OLD', () => {
    expect(V121_SOURCE).toContain(NEW_PLAN);
    expect(V121_SOURCE).toContain(NEW_HELPERS);
    expect(V121_SOURCE).toContain(NEW_MANIFEST);
    expect(V121_SOURCE).toContain(NEW_AGENTS);
    expect(V121_SOURCE).toContain(OLD_PLAN);
    expect(V121_SOURCE).toContain(OLD_HELPERS);
    expect(V121_SOURCE).toContain(OLD_MANIFEST);
    expect(V121_SOURCE).toContain(OLD_AGENTS);
  });

  it('sem drift R10: cada NEW da migration e substring REAL do seed .ts (e o OLD nao)', () => {
    const p = dynamicWorkflowBuilder.systemPrompt;
    expect(p).toContain(NEW_PLAN);
    expect(p).toContain(NEW_HELPERS);
    expect(p).toContain(NEW_MANIFEST);
    expect(p).toContain(NEW_AGENTS);
    expect(p).not.toContain(OLD_PLAN);
    expect(p).not.toContain(OLD_HELPERS);
    expect(p).not.toContain(OLD_MANIFEST);
    expect(p).not.toContain(OLD_AGENTS);
  });

  it('migration: 4 REPLACE/UPDATE, SO o builder, 4 guards de idempotencia', () => {
    expect((V121_SOURCE.match(/UPDATE agents/g) || []).length).toBe(4);
    const ids = [...V121_SOURCE.matchAll(/id = '([^']+)'/g)].map((m) => m[1]);
    expect(new Set(ids)).toEqual(new Set(['dynamic-workflow-builder']));
    expect((V121_SOURCE.match(/AND system_prompt NOT LIKE/g) || []).length).toBe(4);
  });

  it('zero em-dash (U+2014) no source da migration v121', () => {
    expect(V121_SOURCE).not.toContain(String.fromCharCode(0x2014));
  });
});
