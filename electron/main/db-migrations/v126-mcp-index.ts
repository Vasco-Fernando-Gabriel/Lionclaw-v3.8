import type Database from 'better-sqlite3';

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const NEW_COLUMNS: ReadonlyArray<{ table: string; column: string; sql: string }> = [
  {
    table: 'mcp_tool_registry',
    column: 'input_schema',
    sql: 'ALTER TABLE mcp_tool_registry ADD COLUMN input_schema TEXT',
  },
  {
    table: 'mcp_tool_registry',
    column: 'last_discovered_at',
    sql: 'ALTER TABLE mcp_tool_registry ADD COLUMN last_discovered_at TEXT',
  },
  {
    table: 'mcp_servers',
    column: 'index_mode',
    sql: "ALTER TABLE mcp_servers ADD COLUMN index_mode TEXT NOT NULL DEFAULT 'tools'",
  },
];

const MCP_PROMPT_MODE_SEED: readonly [string, string] = ['mcp_prompt_mode', 'index'];

export function applyMigrationV126(db: Database.Database): void {
  for (const { table, column, sql } of NEW_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info('${table}')`).all() as TableInfoRow[];
    const exists = columns.some((col) => col.name === column);
    if (exists) continue;
    db.exec(sql);
  }

  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(
    MCP_PROMPT_MODE_SEED[0],
    MCP_PROMPT_MODE_SEED[1],
  );
}

export const __V126_INTERNAL = {
  NEW_COLUMNS,
  MCP_PROMPT_MODE_SEED,
};
