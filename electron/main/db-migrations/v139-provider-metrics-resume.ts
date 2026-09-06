import type Database from 'better-sqlite3';

const ENRICH_COLUMNS = [
  "validator_cost_status TEXT NOT NULL DEFAULT 'known'",
  "validator_token_status TEXT NOT NULL DEFAULT 'reported'",
  'validator_cost_unknown_reason TEXT',
  'validator_cost_source TEXT',
  'validator_cost_estimation_kind TEXT',
  'validator_unknown_cost_count INTEGER NOT NULL DEFAULT 0',
  'validator_usage_metadata TEXT',
  "enricher_cost_status TEXT NOT NULL DEFAULT 'known'",
  "enricher_token_status TEXT NOT NULL DEFAULT 'reported'",
  'enricher_cost_unknown_reason TEXT',
  'enricher_cost_source TEXT',
  'enricher_cost_estimation_kind TEXT',
  'enricher_unknown_cost_count INTEGER NOT NULL DEFAULT 0',
  'enricher_usage_metadata TEXT',
] as const;

export function applyMigrationV139(db: Database.Database): void {
  const migrate = db.transaction(() => {
    for (const definition of ENRICH_COLUMNS) {
      try {
        db.exec(`ALTER TABLE enrich_sessions ADD COLUMN ${definition}`);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('duplicate column name')) throw error;
      }
    }
    db.exec(`
      DELETE FROM security_agent_status
      WHERE id NOT IN (
        SELECT winner.id
        FROM security_agent_status AS winner
        WHERE winner.id = (
          SELECT candidate.id
          FROM security_agent_status AS candidate
          WHERE candidate.project_id = winner.project_id
            AND candidate.agent_id = winner.agent_id
          ORDER BY
            CASE candidate.status
              WHEN 'completed' THEN 0
              WHEN 'running' THEN 1
              WHEN 'pending' THEN 2
              ELSE 3
            END,
            candidate.id DESC
          LIMIT 1
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_security_agent_project_agent
        ON security_agent_status(project_id, agent_id);
    `);
  });
  migrate.immediate();
}

export const __V139_INTERNAL = { ENRICH_COLUMNS };
