import type Database from 'better-sqlite3';


const OLD_BLOCK = `5. ESCOPO FECHADO
   - Sprints cobrem TODA a SPEC; nada que a SPEC pede pode ficar de fora
   - Nenhuma sprint inventa trabalho que a SPEC nao pediu`;

const NEW_BLOCK = `5. ESCOPO FECHADO (a SPEC manda)
   - Sprints cobrem TODA a SPEC; nada que a SPEC pede pode ficar de fora
   - Nenhuma sprint inventa trabalho que a SPEC nao pediu
   - RESPEITE a secao "fora de escopo" / "out of scope" / "NAO implementar" da SPEC: o que estiver marcado como fora de escopo NUNCA vira feature, criterio ou sprint. Se houver conflito aparente entre a SPEC e o que parece util, a SPEC PREVALECE; nao expanda o escopo por conta propria (expandir gera conflito SPEC vs plano e churn no fix loop)
   - writeSetHint: quando declarar, inclua TODOS os arquivos que a sprint vai tocar de fato (codigo-fonte + configs que a sprint precisa: package.json, tsconfig*, etc). Um hint que esquece arquivo legitimo faz o coder "falhar por fora do writeSet"; na duvida, prefira um hint MAIS LARGO (ou nenhum) a um estreito demais`;

export function applyMigrationV101(db: Database.Database): void {
  db.prepare(
    `UPDATE agents SET system_prompt = REPLACE(system_prompt, ?, ?)
       WHERE id = 'dynamic-workflow-sprint-planner' AND system_prompt LIKE ?`,
  ).run(OLD_BLOCK, NEW_BLOCK, `%${OLD_BLOCK}%`);
}
