import type Database from 'better-sqlite3';

const PREVIOUS_MODEL = 'gpt-6-astra';
const NEW_MODEL = 'gpt-6-sol';

export function applyMigrationV158(db: Database.Database): void {
  db.prepare(
    `UPDATE agents
        SET model = ?,
            codex_config = json_set(codex_config, '$.model', ?)
      WHERE id = 'dynamic-workflow-coder-codex'
        AND model = ?
        AND codex_config IS NOT NULL
        AND json_valid(codex_config)
        AND json_extract(codex_config, '$.model') = ?`,
  ).run(NEW_MODEL, NEW_MODEL, PREVIOUS_MODEL, PREVIOUS_MODEL);
}

export const __V158_INTERNAL = { PREVIOUS_MODEL, NEW_MODEL };
