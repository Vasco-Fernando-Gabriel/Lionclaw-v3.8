
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dynamicWorkflowBuilder } from '../seed-agents/dynamic-workflow-builder';

const V120_PATH = join(
  __dirname,
  '..',
  'db-migrations',
  'v120-dynamic-workflow-builder-single-gate.ts',
);
const V120_SOURCE = readFileSync(V120_PATH, 'utf8');

const NEW_GATE_CALL =
  "        const review = await gate({ id: 'gate-plan-review', mode: 'orchestrator', kind: 'plan-review' });";
const NEW_AUTONOMY_RULE =
  "MODO UNICO full-automatico: o orquestrador conduz TODO gate sozinho (plan-review E entrega), sempre mode 'orchestrator', nunca bloqueia esperando humano. NAO leia ctx.autonomy nem ramifique por modo.";
const NEW_GATES_RULE =
  "- Gates: predeclare em gates[] UM gate de plan-review (kind 'plan-review', id gate-plan-review, mode 'orchestrator') e UM gate de entrega (kind 'delivery', id gate-delivery, mode 'orchestrator').";
const NEW_ENTREGA_RULE =
  '4. Entrega: um gate de entrega conduzido pelo ORQUESTRADOR (modo unico full-auto) com checks deterministicos -> artifact de relatorio. O merge e LOCAL e reversivel; push e SEMPRE bloqueado por codigo.';

const OLD_GATE_CALL =
  "        const planGateId = ctx.autonomy === 'auto-drive' ? PLAN_REVIEW_ORCHESTRATOR_GATE_ID : PLAN_REVIEW_HUMAN_GATE_ID;";
const OLD_AUTONOMY_RULE = "conjunto fechado 'semi' | 'full' | 'auto-drive'";
const OLD_GATES_RULE = "os DOIS gates de plan-review (kind 'plan-review')";
const OLD_ENTREGA_RULE =
  '4. Entrega: um gate de entrega (humano OU orquestrador conforme a autonomia atual) com checks deterministicos -> artifact de relatorio.';

describe('migration v120 modo unico full-auto: 1 id por gate, sempre orchestrator (R10)', () => {
  it('R10 metade 1: o seed .ts JA tem o texto de modo unico (fresh installs)', () => {
    const p = dynamicWorkflowBuilder.systemPrompt;
    expect(p).toContain(NEW_GATE_CALL);
    expect(p).toContain(NEW_AUTONOMY_RULE);
    expect(p).toContain(NEW_GATES_RULE);
    expect(p).toContain(NEW_ENTREGA_RULE);
    expect(p).toContain("id: 'gate-plan-review', mode: 'orchestrator'");
    expect(p).toContain('id gate-plan-review, mode');
    expect(p).toContain('id gate-delivery, mode');
    expect(p).not.toContain('gate-plan-review-human');
    expect(p).not.toContain('gate-plan-review-orchestrator');
    expect(p).not.toContain('gate-delivery-human');
    expect(p).not.toContain('gate-delivery-orchestrator');
    expect(p).not.toContain(OLD_GATE_CALL);
    expect(p).not.toContain(OLD_AUTONOMY_RULE);
    expect(p).not.toContain(OLD_GATES_RULE);
    expect(p).not.toContain(OLD_ENTREGA_RULE);
    expect(p).not.toContain('auto-drive');
    expect(p).not.toContain('PLAN_REVIEW_ORCHESTRATOR_GATE_ID');
    expect(p).not.toContain('PLAN_REVIEW_HUMAN_GATE_ID');
    expect(p).not.toContain("mode 'human'");
  });

  it('R10 metade 2: o source da migration injeta os 4 NEW e mira os OLD', () => {
    expect(V120_SOURCE).toContain(NEW_GATE_CALL);
    expect(V120_SOURCE).toContain(NEW_AUTONOMY_RULE);
    expect(V120_SOURCE).toContain(NEW_GATES_RULE);
    expect(V120_SOURCE).toContain(NEW_ENTREGA_RULE);
    expect(V120_SOURCE).toContain(OLD_GATE_CALL);
    expect(V120_SOURCE).toContain(OLD_AUTONOMY_RULE);
    expect(V120_SOURCE).toContain(OLD_GATES_RULE);
    expect(V120_SOURCE).toContain(OLD_ENTREGA_RULE);
  });

  it('sem drift R10: cada NEW da migration e substring REAL do seed .ts (e o OLD nao)', () => {
    const p = dynamicWorkflowBuilder.systemPrompt;
    expect(p).toContain(NEW_GATE_CALL);
    expect(p).toContain(NEW_AUTONOMY_RULE);
    expect(p).toContain(NEW_GATES_RULE);
    expect(p).toContain(NEW_ENTREGA_RULE);
    expect(p).not.toContain(OLD_GATE_CALL);
    expect(p).not.toContain(OLD_AUTONOMY_RULE);
    expect(p).not.toContain(OLD_GATES_RULE);
    expect(p).not.toContain(OLD_ENTREGA_RULE);
  });

  it('migration: 4 REPLACE/UPDATE, SO o builder, 4 guards de idempotencia', () => {
    expect((V120_SOURCE.match(/UPDATE agents/g) || []).length).toBe(4);
    const ids = [...V120_SOURCE.matchAll(/id = '([^']+)'/g)].map((m) => m[1]);
    expect(new Set(ids)).toEqual(new Set(['dynamic-workflow-builder']));
    expect((V120_SOURCE.match(/AND system_prompt NOT LIKE/g) || []).length).toBe(4);
  });

  it('zero em-dash (U+2014) no source da migration v120', () => {
    expect(V120_SOURCE).not.toContain(String.fromCharCode(0x2014));
  });
});
