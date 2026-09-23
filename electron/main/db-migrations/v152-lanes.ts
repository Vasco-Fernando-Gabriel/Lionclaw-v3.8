import type Database from 'better-sqlite3';
import {
  MAX_DESKTOP_LANES,
  buildDefaultOrchestratorColumns,
  planLaneMigration,
  type LaneMigrationCandidate,
} from '../lanes';

const DESKTOP_CONVERSATION_WHERE = `
  type IN ('chat', 'manual')
  AND task_id IS NULL
  AND (title IS NULL OR title NOT LIKE '[Scheduler]%')
  AND id NOT LIKE 'dw-drive-%'
`;

export function applyMigrationV152(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN lane_badge INTEGER;
      ALTER TABLE sessions ADD COLUMN orchestrator_runtime TEXT;
      ALTER TABLE sessions ADD COLUMN orchestrator_provider TEXT;
      ALTER TABLE sessions ADD COLUMN orchestrator_model TEXT;
      ALTER TABLE sessions ADD COLUMN orchestrator_effort TEXT;
      ALTER TABLE sessions ADD COLUMN sdk_thread_history TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE sessions ADD COLUMN dreaming_started_at TEXT;
      ALTER TABLE sessions ADD COLUMN dreaming_turn_count INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_sessions_status_type ON sessions(status, type);
    `);

    const candidates = db
      .prepare(
        `
      SELECT s.id AS id,
             (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
      FROM sessions s
      WHERE s.status = 'active' AND ${DESKTOP_CONVERSATION_WHERE}
      ORDER BY s.updated_at DESC, s.created_at DESC
    `,
      )
      .all() as Array<{ id: string; message_count: number }>;

    const plan = planLaneMigration(
      candidates.map((row): LaneMigrationCandidate => ({
        id: row.id,
        messageCount: row.message_count,
      })),
      MAX_DESKTOP_LANES,
    );

    const setBadge = db.prepare('UPDATE sessions SET lane_badge = ? WHERE id = ?');
    for (const entry of plan.badges) setBadge.run(entry.badge, entry.id);

    const archive = db.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?");
    for (const id of plan.archive) archive.run(id);

    const readSetting = (key: string): string | undefined => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value;
    };
    const defaults = buildDefaultOrchestratorColumns(readSetting);
    if (defaults) {
      db.prepare(
        `
        UPDATE sessions
        SET orchestrator_runtime = ?,
            orchestrator_provider = ?,
            orchestrator_model = ?,
            orchestrator_effort = ?
        WHERE status = 'active'
          AND (
            (${DESKTOP_CONVERSATION_WHERE})
            OR (type = 'chat' AND id LIKE 'dw-drive-%')
          )
      `,
      ).run(defaults.runtime, defaults.provider, defaults.model, defaults.effort ?? null);
    }
  });
  migrate.immediate();
}

export const __V152_INTERNAL = {
  DESKTOP_CONVERSATION_WHERE,
};
