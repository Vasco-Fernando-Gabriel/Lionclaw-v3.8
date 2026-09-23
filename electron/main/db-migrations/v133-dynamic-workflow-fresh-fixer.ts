import type Database from 'better-sqlite3';

const ANCHOR_LINE = '## Regras do manifest';

const NEW_SECTION = `## Fresh fixer: cerebro novo apos nao-progresso persistente (obrigatorio no dev-loop)

O reframe do retry efetivo muda o ENQUADRAMENTO, mas mantem o MESMO cerebro. Quando o nao-progresso PERSISTE (stuck >= 2, a 3a tentativa contra o MESMO conjunto de blockers - o reframe sozinho ja falhou uma vez), a rodada de fix TROCA o agente: chame o node 'fixer-' + sid + '-r' + devRound (contrato fixer-s{S}-r{R}; materializeSprintPlan ja o materializa por sprint/rodada ao lado do fix) com o fixer dedicado do squad dynamic-workflow (o chamador informa o id exato no prompt), mantendo o stuckNote e os MESMOS grants de writer do fix (workspace-write, sem schema). Cerebro fresco + reframe, nao so reframe. Fail-safe: se o fixer nao estiver no catalogo (ctx.agentCatalog nao-vazio sem o id), siga no coder da sprint (node fix-...) com um log claro; NUNCA falhe o run por isso. So no dev-loop: o plano nao tem fixer (o re-plan ja e o proprio Planner re-rodando).`;

const NEW_MARKER = '## Fresh fixer: cerebro novo apos nao-progresso persistente';

export function applyMigrationV133(db: Database.Database): void {
  db.prepare(
    `UPDATE agents
        SET system_prompt = replace(system_prompt, ?, ?)
      WHERE id = 'dynamic-workflow-builder'
        AND system_prompt LIKE '%' || ? || '%'
        AND system_prompt NOT LIKE '%' || ? || '%'`,
  ).run(ANCHOR_LINE, NEW_SECTION + '\n\n' + ANCHOR_LINE, ANCHOR_LINE, NEW_MARKER);
}
