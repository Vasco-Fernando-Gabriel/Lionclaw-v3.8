import type Database from 'better-sqlite3';

export function applyMigrationV64(db: Database.Database): void {
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
        CHECK (runtime IN ('cloud', 'local', 'external', 'codex', 'zai')),
      local_config TEXT DEFAULT NULL,
      external_config TEXT DEFAULT NULL,
      codex_config TEXT DEFAULT NULL,
      local_mode TEXT DEFAULT 'simple',
      max_tool_rounds INTEGER DEFAULT 5,
      squad TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO agents_new (
      id, name, description, system_prompt, model, allowed_tools, mcp_servers,
      is_active, sort_order, effort, thinking, thinking_budget, max_turns,
      skills, kb_enabled, runtime, local_config, external_config, codex_config,
      local_mode, max_tool_rounds, squad, created_at, updated_at
    )
    SELECT
      id, name, description, system_prompt, model, allowed_tools, mcp_servers,
      is_active, sort_order, effort, thinking, thinking_budget, max_turns,
      skills, kb_enabled, runtime, local_config, external_config, codex_config,
      local_mode, max_tool_rounds, squad, created_at, updated_at
    FROM agents;

    DROP TABLE agents;
    ALTER TABLE agents_new RENAME TO agents;
  `);
}

