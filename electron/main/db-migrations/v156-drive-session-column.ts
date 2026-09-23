import type Database from 'better-sqlite3';
import { createLogger } from '../logger';

const logger = createLogger('db-migration-v156');

const ENGAGED_DRIVE_SQL = `
  json_extract(config, '$.drive.driver') = 'orchestrator'
  AND COALESCE(json_extract(config, '$.drive.status'), 'stopped') <> 'stopped'
`;

interface EngagedDriveRow {
  id: string;
  session_id: string;
  started_at: string;
  updated_at: string;
}

export function applyMigrationV156(db: Database.Database): void {
  const columns = db.pragma('table_info(harness_projects)') as Array<{ name: string }>;
  if (columns.length === 0) return;

  const migrate = db.transaction(() => {
    if (!columns.some((column) => column.name === 'session_id')) {
      db.exec('ALTER TABLE harness_projects ADD COLUMN session_id TEXT');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_harness_projects_session_id
        ON harness_projects(session_id);
    `);
    db.exec(`
      UPDATE harness_projects
         SET session_id = json_extract(config, '$.drive.sessionId')
       WHERE session_id IS NULL
         AND json_extract(config, '$.drive.sessionId') IS NOT NULL;
    `);

    const engaged = db
      .prepare(
        `
      SELECT id,
             session_id,
             COALESCE(json_extract(config, '$.drive.startedAt'), '') AS started_at,
             COALESCE(updated_at, '') AS updated_at
        FROM harness_projects
       WHERE session_id IS NOT NULL AND ${ENGAGED_DRIVE_SQL}
    `,
      )
      .all() as EngagedDriveRow[];

    const bySession = new Map<string, EngagedDriveRow[]>();
    for (const row of engaged) {
      const rows = bySession.get(row.session_id);
      if (rows) rows.push(row);
      else bySession.set(row.session_id, [row]);
    }

    const stopConflicting = db.prepare(`
      UPDATE harness_projects
         SET config = json_set(
               config,
               '$.drive.status', 'stopped',
               '$.drive.stoppedReason', 'lane_conflict_v156'
             )
       WHERE id = ?
    `);

    for (const [sessionId, rows] of bySession) {
      if (rows.length < 2) continue;
      const ordered = [...rows].sort(
        (a, b) => b.started_at.localeCompare(a.started_at) || b.updated_at.localeCompare(a.updated_at),
      );
      const kept = ordered[0];
      const stopped = ordered.slice(1);
      for (const loser of stopped) stopConflicting.run(loser.id);
      logger.warn(
        {
          sessionId,
          keptProjectId: kept.id,
          stoppedProjectIds: stopped.map((row) => row.id),
        },
        'v156: mais de um drive engajado na mesma sessao - mantido o start mais recente, os demais parados (lane_conflict_v156)',
      );
    }
  });

  migrate();
}
