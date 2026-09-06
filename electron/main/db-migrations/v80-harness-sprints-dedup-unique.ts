import type Database from 'better-sqlite3';

export function applyMigrationV80(db: Database.Database): void {
  const run = db.transaction(() => {
    db.exec(`
      DELETE FROM harness_rounds WHERE sprint_id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY project_id, sprint_index
            ORDER BY created_at DESC, rowid DESC
          ) AS rn
          FROM harness_sprints
        ) WHERE rn > 1
      );
    `);

    db.exec(`
      DELETE FROM harness_sprints WHERE rowid NOT IN (
        SELECT rowid FROM (
          SELECT rowid, ROW_NUMBER() OVER (
            PARTITION BY project_id, sprint_index
            ORDER BY created_at DESC, rowid DESC
          ) AS rn
          FROM harness_sprints
        ) WHERE rn = 1
      );
    `);

    db.exec(`
      DELETE FROM harness_rounds WHERE sprint_id IN (
        SELECT s.id FROM harness_sprints s
        JOIN harness_projects p ON p.id = s.project_id
        WHERE p.total_sprints > 0 AND s.sprint_index >= p.total_sprints
      );
    `);

    db.exec(`
      DELETE FROM harness_sprints WHERE id IN (
        SELECT s.id FROM harness_sprints s
        JOIN harness_projects p ON p.id = s.project_id
        WHERE p.total_sprints > 0 AND s.sprint_index >= p.total_sprints
      );
    `);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_sprints_project_sprint
        ON harness_sprints(project_id, sprint_index);
    `);
  });
  run();
}

export const __V80_INTERNAL = {
  INDEX_NAME: 'idx_harness_sprints_project_sprint',
};
