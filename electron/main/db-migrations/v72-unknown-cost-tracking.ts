import type Database from 'better-sqlite3';

export function applyMigrationV72(db: Database.Database): void {
  const alters: string[] = [
    'ALTER TABLE harness_rounds ADD COLUMN unknown_cost_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE harness_projects ADD COLUMN planner_unknown_cost_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE pipeline_phase_metrics ADD COLUMN unknown_cost_count INTEGER NOT NULL DEFAULT 0',
  ];

  for (const sql of alters) {
    try {
      db.exec(sql);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!msg.includes('duplicate column name')) {
        throw err;
      }
    }
  }
}

export const __V72_INTERNAL = {
  alters: [
    'harness_rounds.unknown_cost_count',
    'harness_projects.planner_unknown_cost_count',
    'pipeline_phase_metrics.unknown_cost_count',
  ],
};
