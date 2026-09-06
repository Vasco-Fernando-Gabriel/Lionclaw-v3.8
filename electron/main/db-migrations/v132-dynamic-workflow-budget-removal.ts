import type Database from 'better-sqlite3';


const OLD_LINE =
  '- Respeite o budget e a politica de gates fornecidos no prompt; preencha estimate com honestidade e liste em unknownCostNodes os nodes sem pricing conhecido.';

const NEW_LINE =
  '- Respeite a politica de gates fornecida no prompt; preencha estimate com honestidade e liste em unknownCostNodes os nodes sem pricing conhecido.';

export function applyMigrationV132(db: Database.Database): void {
  db.prepare(
    `UPDATE agents
        SET system_prompt = replace(system_prompt, ?, ?)
      WHERE id = 'dynamic-workflow-builder'
        AND system_prompt LIKE '%' || ? || '%'`,
  ).run(OLD_LINE, NEW_LINE, OLD_LINE);
}
