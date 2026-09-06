import type Database from 'better-sqlite3';

export function applyMigrationV134(db: Database.Database): void {
  db.prepare(
    `UPDATE agents
        SET model = 'gpt-5.6-sol',
            codex_config = json_set(codex_config, '$.model', 'gpt-5.6-sol')
      WHERE id = 'dynamic-workflow-coder-codex'
        AND model = 'gpt-5.5'
        AND codex_config IS NOT NULL
        AND json_valid(codex_config)
        AND json_extract(codex_config, '$.model') = 'gpt-5.5'`,
  ).run();
}
