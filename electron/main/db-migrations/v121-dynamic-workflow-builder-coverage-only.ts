import type Database from 'better-sqlite3';

export function applyMigrationV121(db: Database.Database): void {
  const planOld =
    '1. Planejamento: um node Sprint Planner gera as sprints EM RUNTIME (forced structured output). Um check deterministico em codigo (validateSprintPlan) normaliza e valida o plano; reprovou -> os erros voltam pro PROPRIO Planner re-rodar (planner-r1..). Depois, 3 validadores adversariais de plano (eixos cobertura/topologia/criterios) auditam o plano em paralelo; ha findings acionaveis -> o Planner re-roda corrigindo SO as sprints sinalizadas. Loop bounded por MAX_PLAN_ROUNDS; converge ou escala pro humano. NAO existe node plan-fixer separado: o fix do plano e o Planner re-rodando.';
  const planNew =
    '1. Planejamento: um node Sprint Planner gera as sprints EM RUNTIME (forced structured output). validateSprintPlan (host) AUTO-CORRIGE o cosmetico (id duplicado, name/description, coder fora do catalogo, dependencia orfa/ciclo, ordem topologica das sprints) e SO reprova o defeito REAL objetivo (plano vazio, sprint sem features, feature sem criterio de aceite); reprovou -> os erros voltam pro PROPRIO Planner re-rodar (planner-r1..). Depois, UM validador objetivo de COBERTURA da SPEC (a SPEC inteira esta coberta por alguma sprint?) audita o plano; ha buraco de cobertura (P1) -> o Planner re-roda corrigindo SO as sprints sinalizadas. A integridade ESTRUTURAL do plano e deterministica no host (nao precisa de LLM): os eixos topologia/criterios foram APOSENTADOS. Loop bounded por MAX_PLAN_ROUNDS; converge ou escala pro orquestrador. NAO existe node plan-fixer separado: o fix do plano e o Planner re-rodando.';
  db.prepare(
    `UPDATE agents
        SET system_prompt = REPLACE(system_prompt, ?, ?),
            updated_at = datetime('now')
      WHERE id = 'dynamic-workflow-builder'
        AND system_prompt LIKE '%' || ? || '%'
        AND system_prompt NOT LIKE '%AUTO-CORRIGE o cosmetico%'`,
  ).run(planOld, planNew, planOld);

  const helpersOld =
    'A funcao reusa os MESMOS helpers do seu loop de plano (o node do Sprint Planner, validateSprintPlan, os 3 plan-validators, dedupeFindings, o seu actionableOf, o planFeedback, a var planConverged) e roda UMA rodada extra de planner+validators por replan pedido, RE-ABRINDO o gate ate o humano aprovar as-is ou esgotar o cap.';
  const helpersNew =
    'A funcao reusa os MESMOS helpers do seu loop de plano (o node do Sprint Planner, validateSprintPlan, o validador de cobertura, dedupeFindings, o seu actionableOf, o planFeedback, a var planConverged) e roda UMA rodada extra de planner+validador por replan pedido, RE-ABRINDO o gate ate o humano aprovar as-is ou esgotar o cap.';
  db.prepare(
    `UPDATE agents
        SET system_prompt = REPLACE(system_prompt, ?, ?),
            updated_at = datetime('now')
      WHERE id = 'dynamic-workflow-builder'
        AND system_prompt LIKE '%' || ? || '%'
        AND system_prompt NOT LIKE '%validateSprintPlan, o validador de cobertura, dedupeFindings%'`,
  ).run(helpersOld, helpersNew, helpersOld);

  const manifestOld =
    'Nodes de PLANEJAMENTO sao conhecidos no build: PRE-EXPANDA por rodada ate MAX_PLAN_ROUNDS (planner-r0..rN + os 3 plan-validators-r0..rN por eixo + o grupo paralelo plan-validators-r0..rN). Alem desses, PRE-EXPANDA TAMBEM os nodes de REPLAN HUMANO usados pelo runPlanReviewGate: planner-replan-1..MAX_PLAN_ROUNDS + plan-validators-replan-1..MAX_PLAN_ROUNDS (os 3 eixos por rodada + o grupo paralelo plan-validators-replan-N), 1-based, COMPARTILHADOS pelos dois caminhos do gate. Id gerado em runtime fora desse conjunto e erro estrutural.';
  const manifestNew =
    'Nodes de PLANEJAMENTO sao conhecidos no build: PRE-EXPANDA por rodada ate MAX_PLAN_ROUNDS (planner-r0..rN + o plan-validator-coverage-r0..rN + o grupo paralelo plan-validators-r0..rN). Alem desses, PRE-EXPANDA TAMBEM os nodes de REPLAN HUMANO usados pelo runPlanReviewGate: planner-replan-1..MAX_PLAN_ROUNDS + plan-validators-replan-1..MAX_PLAN_ROUNDS (o eixo de cobertura por rodada + o grupo paralelo plan-validators-replan-N), 1-based, COMPARTILHADOS pelos dois caminhos do gate. Id gerado em runtime fora desse conjunto e erro estrutural.';
  db.prepare(
    `UPDATE agents
        SET system_prompt = REPLACE(system_prompt, ?, ?),
            updated_at = datetime('now')
      WHERE id = 'dynamic-workflow-builder'
        AND system_prompt LIKE '%' || ? || '%'
        AND system_prompt NOT LIKE '%o plan-validator-coverage-r0..rN + o grupo paralelo plan-validators-r0..rN%'`,
  ).run(manifestOld, manifestNew, manifestOld);

  const agentsOld =
    '- SPRINT PLANNER e PLAN-VALIDATORS: use os agentes de PLANO dedicados do squad dynamic-workflow (sprint-planner + os 3 plan-validators de eixo coverage/topology/criteria). O chamador informa os ids exatos no prompt.';
  const agentsNew =
    '- SPRINT PLANNER e PLAN-VALIDATOR: use os agentes de PLANO dedicados do squad dynamic-workflow (sprint-planner + o plan-validator de eixo coverage; os eixos topology/criteria foram APOSENTADOS - a integridade estrutural e deterministica no host). O chamador informa os ids exatos no prompt.';
  db.prepare(
    `UPDATE agents
        SET system_prompt = REPLACE(system_prompt, ?, ?),
            updated_at = datetime('now')
      WHERE id = 'dynamic-workflow-builder'
        AND system_prompt LIKE '%' || ? || '%'
        AND system_prompt NOT LIKE '%o plan-validator de eixo coverage; os eixos topology/criteria foram APOSENTADOS%'`,
  ).run(agentsOld, agentsNew, agentsOld);
}
