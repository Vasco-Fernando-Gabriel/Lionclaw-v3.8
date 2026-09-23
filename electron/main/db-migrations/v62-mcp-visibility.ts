import type Database from 'better-sqlite3';

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export function applyMigrationV62(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info('mcp_servers')`).all() as TableInfoRow[];
  const hasVisibleTo = columns.some((col) => col.name === 'visible_to');
  if (hasVisibleTo) return;

  db.exec(`ALTER TABLE mcp_servers ADD COLUMN visible_to TEXT NOT NULL DEFAULT 'all';`);
}
