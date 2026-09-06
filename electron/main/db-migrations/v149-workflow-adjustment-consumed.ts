import type Database from 'better-sqlite3';


const TABLE = 'dynamic_workflow_messages';
const COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: 'applied_node_id', ddl: 'applied_node_id TEXT' },
  { name: 'consumed_at', ddl: 'consumed_at TEXT' },
];

function existingColumns(db: Database.Database): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

export function applyMigrationV149(db: Database.Database): void {
  const migrate = db.transaction(() => {
    const present = existingColumns(db);
    for (const col of COLUMNS) {
      if (present.has(col.name)) continue;
      db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${col.ddl}`);
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_dwf_messages_adjustment_claim
         ON ${TABLE} (run_id, kind, node_id, consumed_at)`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_dwf_messages_adjustment_applied
         ON ${TABLE} (run_id, applied_node_id)`,
    );
  });
  migrate.immediate();
}

export const __V149_INTERNAL = { TABLE, COLUMNS: COLUMNS.map((c) => c.name) };
