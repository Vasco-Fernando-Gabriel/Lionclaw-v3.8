import type Database from 'better-sqlite3';


const OLD_BLOCK = `   - Use SOMENTE agentes ATIVOS no catalogo fornecido na execucao
   - Sem especialista adequado, use o coder generico fornecido
   - A stack escolhe SO o CODER. Os validadores sao FIXOS por EIXO (regressao, spec, testes) e o host os aplica automaticamente: DEIXE \`validatorAgentIds\` VAZIO ([]). NUNCA invente um validador por stack (ex: \`typescript-validator\`, \`<stack>-validator\`) - ele nao existe no catalogo e reprova a materializacao`;

const NEW_BLOCK = `   - Use SOMENTE agentes ATIVOS da lista "Coders disponiveis" fornecida na execucao (id EXATO). NUNCA invente um id que nao esteja na lista
   - Escolha o MELHOR especialista por stack: TypeScript/Node -> typescript-pro ou backend-developer; React/Next/UI -> frontend-developer ou nextjs-developer; Electron/desktop -> electron-pro; Python -> python-pro; JS generico -> javascript-pro. Combine a stack REAL da sprint com a descricao do agente na lista
   - O coder generico dynamic-workflow-coder e FALLBACK DE ULTIMO RECURSO: use-o SO quando nenhum especialista da lista cobrir a stack da sprint
   - A stack escolhe SO o CODER. Os validadores sao FIXOS por EIXO (regressao, spec, testes) e o host os aplica automaticamente: DEIXE \`validatorAgentIds\` VAZIO ([]). NUNCA invente um validador por stack (ex: \`typescript-validator\`, \`<stack>-validator\`) - ele nao existe no catalogo e reprova a materializacao`;

const NEW_MARKER = 'FALLBACK DE ULTIMO RECURSO';

export function applyMigrationV105(db: Database.Database): void {
  db.prepare(
    `UPDATE agents SET system_prompt = REPLACE(system_prompt, ?, ?)
       WHERE id = 'dynamic-workflow-sprint-planner'
         AND system_prompt LIKE ?
         AND system_prompt NOT LIKE ?`,
  ).run(OLD_BLOCK, NEW_BLOCK, `%${OLD_BLOCK}%`, `%${NEW_MARKER}%`);
}
