import type Database from 'better-sqlite3';

export function applyMigrationV119(db: Database.Database): void {
  const gateCallOld =
    "        const review = await gate({ id: PLAN_REVIEW_GATE_ID, mode: 'human', kind: 'plan-review' });";
  const gateCallNew =
    "        // DOIS ids de plan-review predeclarados (espelho do delivery); o modo e fonte\n" +
    "        // do MANIFEST e o .js escolhe pela autonomia ATUAL (tabela de autonomia): so\n" +
    "        // 'auto-drive' vira orquestrador; 'semi'/'full' mantem o humano-estrito.\n" +
    "        const planGateId = ctx.autonomy === 'auto-drive' ? PLAN_REVIEW_ORCHESTRATOR_GATE_ID : PLAN_REVIEW_HUMAN_GATE_ID;\n" +
    "        const planGateMode = ctx.autonomy === 'auto-drive' ? 'orchestrator' : 'human';\n" +
    "        const review = await gate({ id: planGateId, mode: planGateMode, kind: 'plan-review' });";
  db.prepare(
    `UPDATE agents
        SET system_prompt = REPLACE(system_prompt, ?, ?),
            updated_at = datetime('now')
      WHERE id = 'dynamic-workflow-builder'
        AND system_prompt LIKE '%' || ? || '%'
        AND system_prompt NOT LIKE '%PLAN_REVIEW_ORCHESTRATOR_GATE_ID%'`,
  ).run(gateCallOld, gateCallNew, gateCallOld);

  const autonomyOld =
    '- A autonomia atual e lida defensivamente de ctx.autonomy; flags opcionais (ex: pauseAfterPlan) de ctx.input. Ambos podem estar ausentes: trate com fallback seguro (autonomia != \'full\' -> gate de entrega humano).';
  const autonomyNew =
    "- A autonomia atual e lida defensivamente de ctx.autonomy (conjunto fechado 'semi' | 'full' | 'auto-drive'); flags opcionais (ex: pauseAfterPlan) de ctx.input. Ambos podem estar ausentes: trate com fallback seguro (humano). Tabela: 'semi' -> humano em plan-review E entrega; 'full' -> humano no plan-review, orquestrador na entrega; 'auto-drive' -> orquestrador em AMBOS (plan-review E entrega). Selecao de entrega: (autonomia === 'full' || autonomia === 'auto-drive') -> gate-delivery-orchestrator, senao gate-delivery-human. Selecao de plan-review: autonomia === 'auto-drive' -> gate-plan-review-orchestrator, senao gate-plan-review-human.";
  db.prepare(
    `UPDATE agents
        SET system_prompt = REPLACE(system_prompt, ?, ?),
            updated_at = datetime('now')
      WHERE id = 'dynamic-workflow-builder'
        AND system_prompt LIKE '%' || ? || '%'
        AND system_prompt NOT LIKE '%conjunto fechado ''semi'' | ''full'' | ''auto-drive''%'`,
  ).run(autonomyOld, autonomyNew, autonomyOld);

  const gatesOld =
    "- Gates: predeclare em gates[] o gate de plano OPCIONAL (id plan-review, kind 'plan-review', mode 'human' - humano-estrito, nunca auto-aprovado) e os DOIS gates de entrega (kind 'delivery'): um com mode 'human' e outro com mode 'orchestrator'. O modo do gate de entrega e fonte de verdade do MANIFEST; o workflow.js le a autonomia atual e chama o gate correspondente. Gate auto somente com checks deterministicos (schema, command, containment, arquivos esperados).";
  const gatesNew =
    "- Gates: predeclare em gates[] os DOIS gates de plan-review (kind 'plan-review'): um id gate-plan-review-human com mode 'human' e um id gate-plan-review-orchestrator com mode 'orchestrator' - espelho do delivery; o modo e fonte de verdade do MANIFEST e o workflow.js escolhe pela autonomia (auto-drive -> orquestrador; semi/full -> humano). NUNCA declare um unico gate plan-review humano-estrito: em auto-drive o orquestrador conduz o plan-review. Predeclare TAMBEM os DOIS gates de entrega (kind 'delivery'): um com mode 'human' (id gate-delivery-human) e outro com mode 'orchestrator' (id gate-delivery-orchestrator); o workflow.js le a autonomia atual ((full||auto-drive) -> orchestrator, senao human) e chama o gate correspondente. Gate auto somente com checks deterministicos (schema, command, containment, arquivos esperados).";
  db.prepare(
    `UPDATE agents
        SET system_prompt = REPLACE(system_prompt, ?, ?),
            updated_at = datetime('now')
      WHERE id = 'dynamic-workflow-builder'
        AND system_prompt LIKE '%' || ? || '%'
        AND system_prompt NOT LIKE '%os DOIS gates de plan-review (kind ''plan-review'')%'`,
  ).run(gatesOld, gatesNew, gatesOld);
}
