import type Database from 'better-sqlite3';

export function applyMigrationV120(db: Database.Database): void {
  const gateCallOld =
    '        // DOIS ids de plan-review predeclarados (espelho do delivery); o modo e fonte\n' +
    '        // do MANIFEST e o .js escolhe pela autonomia ATUAL (tabela de autonomia): so\n' +
    "        // 'auto-drive' vira orquestrador; 'semi'/'full' mantem o humano-estrito.\n" +
    "        const planGateId = ctx.autonomy === 'auto-drive' ? PLAN_REVIEW_ORCHESTRATOR_GATE_ID : PLAN_REVIEW_HUMAN_GATE_ID;\n" +
    "        const planGateMode = ctx.autonomy === 'auto-drive' ? 'orchestrator' : 'human';\n" +
    "        const review = await gate({ id: planGateId, mode: planGateMode, kind: 'plan-review' });";
  const gateCallNew =
    "        // UM gate de plan-review, modo SEMPRE 'orchestrator' (modo unico full-auto):\n" +
    '        // o orquestrador conduz o plan-review sozinho, nunca bloqueia esperando humano.\n' +
    "        const review = await gate({ id: 'gate-plan-review', mode: 'orchestrator', kind: 'plan-review' });";
  db.prepare(
    `UPDATE agents
        SET system_prompt = REPLACE(system_prompt, ?, ?),
            updated_at = datetime('now')
      WHERE id = 'dynamic-workflow-builder'
        AND system_prompt LIKE '%' || ? || '%'
        AND system_prompt NOT LIKE '%UM gate de plan-review, modo SEMPRE%'`,
  ).run(gateCallOld, gateCallNew, gateCallOld);

  const autonomyOld =
    "- A autonomia atual e lida defensivamente de ctx.autonomy (conjunto fechado 'semi' | 'full' | 'auto-drive'); flags opcionais (ex: pauseAfterPlan) de ctx.input. Ambos podem estar ausentes: trate com fallback seguro (humano). Tabela: 'semi' -> humano em plan-review E entrega; 'full' -> humano no plan-review, orquestrador na entrega; 'auto-drive' -> orquestrador em AMBOS (plan-review E entrega). Selecao de entrega: (autonomia === 'full' || autonomia === 'auto-drive') -> gate-delivery-orchestrator, senao gate-delivery-human. Selecao de plan-review: autonomia === 'auto-drive' -> gate-plan-review-orchestrator, senao gate-plan-review-human.";
  const autonomyNew =
    "- MODO UNICO full-automatico: o orquestrador conduz TODO gate sozinho (plan-review E entrega), sempre mode 'orchestrator', nunca bloqueia esperando humano. NAO leia ctx.autonomy nem ramifique por modo. Flags opcionais (ex: pauseAfterPlan) ainda vem de ctx.input (podem estar ausentes; fallback seguro). O unico freio humano e pausar o run pelo chat (fora do .js).";
  db.prepare(
    `UPDATE agents
        SET system_prompt = REPLACE(system_prompt, ?, ?),
            updated_at = datetime('now')
      WHERE id = 'dynamic-workflow-builder'
        AND system_prompt LIKE '%' || ? || '%'
        AND system_prompt NOT LIKE '%MODO UNICO full-automatico: o orquestrador conduz TODO gate sozinho%'`,
  ).run(autonomyOld, autonomyNew, autonomyOld);

  const gatesOld =
    "- Gates: predeclare em gates[] os DOIS gates de plan-review (kind 'plan-review'): um id gate-plan-review-human com mode 'human' e um id gate-plan-review-orchestrator com mode 'orchestrator' - espelho do delivery; o modo e fonte de verdade do MANIFEST e o workflow.js escolhe pela autonomia (auto-drive -> orquestrador; semi/full -> humano). NUNCA declare um unico gate plan-review humano-estrito: em auto-drive o orquestrador conduz o plan-review. Predeclare TAMBEM os DOIS gates de entrega (kind 'delivery'): um com mode 'human' (id gate-delivery-human) e outro com mode 'orchestrator' (id gate-delivery-orchestrator); o workflow.js le a autonomia atual ((full||auto-drive) -> orchestrator, senao human) e chama o gate correspondente. Gate auto somente com checks deterministicos (schema, command, containment, arquivos esperados).";
  const gatesNew =
    "- Gates: predeclare em gates[] UM gate de plan-review (kind 'plan-review', id gate-plan-review, mode 'orchestrator') e UM gate de entrega (kind 'delivery', id gate-delivery, mode 'orchestrator'). Modo unico full-auto: ambos sao SEMPRE conduzidos pelo orquestrador; NUNCA declare gate de modo 'human'. O modo e fonte de verdade do MANIFEST (o host barra o .js se ele passar outro mode). Gate auto somente com checks deterministicos (schema, command, containment, arquivos esperados).";
  db.prepare(
    `UPDATE agents
        SET system_prompt = REPLACE(system_prompt, ?, ?),
            updated_at = datetime('now')
      WHERE id = 'dynamic-workflow-builder'
        AND system_prompt LIKE '%' || ? || '%'
        AND system_prompt NOT LIKE '%predeclare em gates[] UM gate de plan-review%'`,
  ).run(gatesOld, gatesNew, gatesOld);

  const entregaOld =
    '4. Entrega: um gate de entrega (humano OU orquestrador conforme a autonomia atual) com checks deterministicos -> artifact de relatorio.';
  const entregaNew =
    '4. Entrega: um gate de entrega conduzido pelo ORQUESTRADOR (modo unico full-auto) com checks deterministicos -> artifact de relatorio. O merge e LOCAL e reversivel; push e SEMPRE bloqueado por codigo.';
  db.prepare(
    `UPDATE agents
        SET system_prompt = REPLACE(system_prompt, ?, ?),
            updated_at = datetime('now')
      WHERE id = 'dynamic-workflow-builder'
        AND system_prompt LIKE '%' || ? || '%'
        AND system_prompt NOT LIKE '%gate de entrega conduzido pelo ORQUESTRADOR (modo unico full-auto)%'`,
  ).run(entregaOld, entregaNew, entregaOld);
}
