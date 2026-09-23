import type Database from 'better-sqlite3';

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as TableInfoRow[];
  return cols.some((c) => c.name === column);
}

export function applyMigrationV115(db: Database.Database): void {
  if (!hasColumn(db, 'dynamic_workflow_definitions', 'authoring_model')) {
    db.exec(`ALTER TABLE dynamic_workflow_definitions ADD COLUMN authoring_model TEXT NOT NULL DEFAULT 'manifest';`);
  }

  if (!hasColumn(db, 'agents', 'access')) {
    db.exec(`ALTER TABLE agents ADD COLUMN access TEXT DEFAULT 'read-only';`);
  }
  if (!hasColumn(db, 'agents', 'allow_bash')) {
    db.exec(`ALTER TABLE agents ADD COLUMN allow_bash INTEGER DEFAULT 0;`);
  }
  if (!hasColumn(db, 'agents', 'allowed_commands')) {
    db.exec(`ALTER TABLE agents ADD COLUMN allowed_commands TEXT DEFAULT '[]';`);
  }
  if (!hasColumn(db, 'agents', 'allow_network')) {
    db.exec(`ALTER TABLE agents ADD COLUMN allow_network INTEGER DEFAULT 0;`);
  }

  const writerCommandsJson = JSON.stringify(['npm run typecheck', 'npm run test', 'npm install', 'npm ci']);
  const setWriterAxes = db.prepare(
    `UPDATE agents
        SET access = 'workspace-write',
            allow_bash = 1,
            allowed_commands = ?,
            allow_network = 0
      WHERE id = ?;`,
  );
  for (const writerId of ['dynamic-workflow-coder', 'dynamic-workflow-fixer']) {
    setWriterAxes.run(writerCommandsJson, writerId);
  }
}
