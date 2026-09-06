import type Database from 'better-sqlite3';

interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

function foreignKeyViolationKey(violation: ForeignKeyViolation): string {
  return JSON.stringify([
    violation.table,
    violation.rowid,
    violation.parent,
    violation.fkid,
  ]);
}

export function applyMigrationV146(db: Database.Database): void {
  const violationsBefore = new Set(
    (db.pragma('foreign_key_check') as ForeignKeyViolation[])
      .map(foreignKeyViolationKey),
  );
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE agents_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        system_prompt TEXT DEFAULT '',
        model TEXT DEFAULT 'claude-sonnet-4-6',
        allowed_tools TEXT DEFAULT '[]',
        mcp_servers TEXT DEFAULT '[]',
        is_active INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        effort TEXT DEFAULT 'medium',
        thinking TEXT DEFAULT 'adaptive',
        thinking_budget INTEGER,
        max_turns INTEGER,
        skills TEXT DEFAULT '[]',
        kb_enabled INTEGER NOT NULL DEFAULT 1,
        runtime TEXT DEFAULT 'cloud'
          CHECK (runtime IN ('cloud', 'local', 'external', 'codex', 'zai', 'minimax-tp', 'kimi', 'grok', 'cursor')),
        local_config TEXT DEFAULT NULL,
        external_config TEXT DEFAULT NULL,
        codex_config TEXT DEFAULT NULL,
        local_mode TEXT DEFAULT 'simple',
        max_tool_rounds INTEGER DEFAULT 5,
        squad TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        access TEXT DEFAULT 'read-only',
        allow_bash INTEGER DEFAULT 0,
        allowed_commands TEXT DEFAULT '[]',
        allow_network INTEGER DEFAULT 0
      );

      INSERT INTO agents_new (
        id, name, description, system_prompt, model, allowed_tools, mcp_servers,
        is_active, sort_order, effort, thinking, thinking_budget, max_turns,
        skills, kb_enabled, runtime, local_config, external_config, codex_config,
        local_mode, max_tool_rounds, squad, created_at, updated_at,
        access, allow_bash, allowed_commands, allow_network
      )
      SELECT
        id, name, description, system_prompt, model, allowed_tools, mcp_servers,
        is_active, sort_order, effort, thinking, thinking_budget, max_turns,
        skills, kb_enabled, runtime, local_config, external_config, codex_config,
        local_mode, max_tool_rounds, squad, created_at, updated_at,
        access, allow_bash, allowed_commands, allow_network
      FROM agents;

      DROP TABLE agents;
      ALTER TABLE agents_new RENAME TO agents;
    `);
    const violationsAfter = db.pragma('foreign_key_check') as ForeignKeyViolation[];
    const introduced = violationsAfter.filter(
      (violation) => !violationsBefore.has(foreignKeyViolationKey(violation)),
    );
    if (introduced.length > 0) {
      throw new Error(`Migration v146 deixou ${introduced.length} violacoes novas de foreign key`);
    }
  });

  migrate.immediate();
}
