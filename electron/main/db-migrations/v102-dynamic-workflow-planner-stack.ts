import type Database from 'better-sqlite3';


const OLD_BLOCK = `4. ESCOLHA DO ESPECIALISTA POR STACK
   - Atribua o coder de cada sprint conforme a stack: backend, frontend, banco, etc`;

const NEW_BLOCK = `4. ESCOLHA DO ESPECIALISTA POR STACK
   - PREENCHA o campo \`stack\` de cada sprint com as tecnologias REAIS dela, lidas do SPEC (ex: ["typescript","vitest","node"]). NUNCA deixe \`stack\` vazio: mesmo em projeto novo/sem package.json, infira a stack do TEXTO do SPEC. Stack vazia impede escolher o especialista certo e vira finding de validacao
   - Atribua o coder de cada sprint conforme a stack: backend, frontend, banco, etc`;

export function applyMigrationV102(db: Database.Database): void {
  db.prepare(
    `UPDATE agents SET system_prompt = REPLACE(system_prompt, ?, ?)
       WHERE id = 'dynamic-workflow-sprint-planner' AND system_prompt LIKE ?`,
  ).run(OLD_BLOCK, NEW_BLOCK, `%${OLD_BLOCK}%`);
}
