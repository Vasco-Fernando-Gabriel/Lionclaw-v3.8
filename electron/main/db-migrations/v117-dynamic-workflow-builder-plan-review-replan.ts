import type Database from 'better-sqlite3';

export function applyMigrationV117(db: Database.Database): void {
  const planReviewSection = `## Gate de revisao do plano (plan-review): HONRA o replan do humano (obrigatorio)

O gate de plano NUNCA pode ser um await gate(...) PELADO que descarta o retorno. Um gate cru materializa o plano as-is mesmo quando o humano responde a decisao com { action: 'replan' }: o replan vira no-op, o humano so consegue aprovar as-is ou abortar, e uma lacuna de plano (validador reprovando com P1) fica sem conserto a nao ser matando o run. ERRADO. Gere uma funcao runPlanReviewGate(escalated) que HONRA o replan, e chame-a nos DOIS caminhos do gate.

A funcao reusa os MESMOS helpers do seu loop de plano (o node do Sprint Planner, validateSprintPlan, o validador de cobertura, dedupeFindings, o seu actionableOf, o planFeedback, a var planConverged) e roda UMA rodada extra de planner+validador por replan pedido, RE-ABRINDO o gate ate o humano aprovar as-is ou esgotar o cap. Padrao (adapte aos nomes dos seus helpers, NAO copie cego):

    async function runPlanReviewGate(escalated) {
      let extraReplans = 0;
      while (true) {
        // UM gate de plan-review, modo SEMPRE 'orchestrator' (modo unico full-auto):
        // o orquestrador conduz o plan-review sozinho, nunca bloqueia esperando humano.
        const review = await gate({ id: 'gate-plan-review', mode: 'orchestrator', kind: 'plan-review' });
        const action = review && review.decisionPayload ? review.decisionPayload.action : null;
        // aprovou as-is (ou esgotou os replans extras) -> sai e materializa o plano corrente
        if (action !== 'replan' || extraReplans >= MAX_PLAN_ROUNDS) return;
        extraReplans++;
        planConverged = false; // o replan reabre a convergencia (a re-validacao manda)
        const replanned = await agent({ id: 'planner-replan-' + extraReplans, agentId: SPRINT_PLANNER_ID,
          access: 'read-only', schema: PLAN_SCHEMA_REF,
          prompt: 'Re-planeje corrigindo SO as sprints sinalizadas pelos findings, preservando o resto. '
            + (review && review.reason ? 'Direcao do humano: ' + review.reason + '. ' : '')
            + 'Plano anterior: ' + JSON.stringify(plan ? plan.sprints : [])
            + ' Findings: ' + JSON.stringify(planFeedback || []) + ' Coders disponiveis: ' + AGENT_CATALOG_TEXT });
        const v = await validateSprintPlan(replanned);
        if (!v.ok) { plan = v.plan; planFeedback = (v.errors || []).map((e) => ({ severity: 'P1', where: e.sprintId || 'plano', problem: e.message, fix: 'corrija o erro deterministico de validacao do plano' })); continue; }
        plan = v.plan;
        const replanValidators = await parallel(PLAN_AXES.map((axis) => () => agent({ id: 'plan-validator-' + axis + '-replan-' + extraReplans, agentId: PLAN_VALIDATOR_BY_AXIS[axis], access: 'read-only', schema: PLAN_FINDINGS_SCHEMA_REF, prompt: 'Valide o PLANO de sprints no seu eixo. Plano: ' + JSON.stringify(plan.sprints) })), { id: 'plan-validators-replan-' + extraReplans, maxConcurrency: 3 });
        const blockers = actionableOf(dedupeFindings(replanValidators));
        if (blockers.length === 0) { planConverged = true; return; } // convergiu apos o replan dirigido
        planFeedback = blockers; // nao convergiu -> volta ao topo do while (re-abre o gate)
      }
    }

    // CHAME nos DOIS caminhos, SEMPRE ANTES de materializeSprintPlan:
    let escalatedPlanReview = false;
    if (!planConverged) { escalatedPlanReview = true; await runPlanReviewGate(true); }
    const pauseAfterPlan = !!(ctx.input && ctx.input.pauseAfterPlan);
    if (planConverged && !escalatedPlanReview && pauseAfterPlan) { await runPlanReviewGate(false); }
    const materialized = await materializeSprintPlan(plan);

Regras DURAS:
- NUNCA materialize antes de chamar runPlanReviewGate: um replan dirigido pelo humano tem que re-materializar o plano NOVO, nunca deixar os nodes de dev presos ao plano antigo.
- Cap = MAX_PLAN_ROUNDS replans EXTRAS do humano (espelha o teto automatico; evita loop humano infinito).
- O replan viaja SEMPRE no approve + review.decisionPayload.action === 'replan' (NUNCA num branch de reject: um reject de verdade NAO volta ao .js, o host aborta o sandbox). Leia SO review.decisionPayload.action.
- Os ids planner-replan-N e plan-validator-<eixo>-replan-N sao COMPARTILHADOS pelos dois caminhos e PRE-EXPANDIDOS no manifest (ver Regras do manifest).`;

  const sectionAnchor = '## Disciplina do coder: rodar ate VERDE (obrigatoria)';
  db.prepare(
    `UPDATE agents
        SET system_prompt = REPLACE(system_prompt, ?, ? || char(10) || char(10) || ?),
            updated_at = datetime('now')
      WHERE id = 'dynamic-workflow-builder'
        AND system_prompt LIKE '%' || ? || '%'
        AND system_prompt NOT LIKE '%runPlanReviewGate%'`,
  ).run(sectionAnchor, planReviewSection, sectionAnchor, sectionAnchor);

  const manifestOld =
    '(planner-r0..rN + os 3 plan-validators-r0..rN por eixo + o grupo paralelo plan-validators-r0..rN). Id gerado em runtime fora desse conjunto e erro estrutural.';
  const manifestNew =
    '(planner-r0..rN + o plan-validator-coverage-r0..rN + o grupo paralelo plan-validators-r0..rN). Alem desses, PRE-EXPANDA TAMBEM os nodes de REPLAN HUMANO usados pelo runPlanReviewGate: planner-replan-1..MAX_PLAN_ROUNDS + plan-validators-replan-1..MAX_PLAN_ROUNDS (o eixo de cobertura por rodada + o grupo paralelo plan-validators-replan-N), 1-based, COMPARTILHADOS pelos dois caminhos do gate. Id gerado em runtime fora desse conjunto e erro estrutural.';
  db.prepare(
    `UPDATE agents
        SET system_prompt = REPLACE(system_prompt, ?, ?),
            updated_at = datetime('now')
      WHERE id = 'dynamic-workflow-builder'
        AND system_prompt LIKE '%' || ? || '%'
        AND system_prompt NOT LIKE '%REPLAN HUMANO usados pelo runPlanReviewGate%'`,
  ).run(manifestOld, manifestNew, manifestOld);
}
