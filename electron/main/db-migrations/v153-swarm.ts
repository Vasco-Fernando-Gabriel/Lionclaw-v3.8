import type Database from 'better-sqlite3';
import { SWARM_SEED_AGENTS } from '../seed-agents/swarm-registry';
import { DEFAULT_SWARM_SETTINGS } from '../../../src/types/swarm';

export function applyMigrationV153(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS swarm_runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 0),
        created_at TEXT NOT NULL,
        summary_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_swarm_runs_session ON swarm_runs(session_id, created_at DESC, run_id DESC);
      CREATE TABLE IF NOT EXISTS swarm_delivery_outbox (
        run_id TEXT NOT NULL,
        terminal_revision INTEGER NOT NULL CHECK(terminal_revision >= 0),
        session_id TEXT NOT NULL,
        envelope TEXT NOT NULL,
        run_status TEXT NOT NULL CHECK(run_status IN ('done','partial','failed','aborted')),
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','delivered','undeliverable')),
        claim_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (run_id, terminal_revision)
      );
      CREATE TABLE IF NOT EXISTS swarm_chat_receipts (
        run_id TEXT NOT NULL,
        terminal_revision INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('event','response')),
        session_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        PRIMARY KEY (run_id, terminal_revision, kind),
        FOREIGN KEY (run_id, terminal_revision) REFERENCES swarm_delivery_outbox(run_id, terminal_revision)
      );
    `);
    const columns = db.prepare('PRAGMA table_info(chat_session_features)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'swarm_enabled')) {
      db.exec('ALTER TABLE chat_session_features ADD COLUMN swarm_enabled INTEGER NOT NULL DEFAULT 0');
    }
    const setting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries({
      swarm_concurrency_cap: DEFAULT_SWARM_SETTINGS.concurrencyCap,
      swarm_max_attempts: DEFAULT_SWARM_SETTINGS.maxAttempts,
      swarm_idle_timeout_ms: DEFAULT_SWARM_SETTINGS.idleTimeoutMs,
      swarm_hard_timeout_ms: DEFAULT_SWARM_SETTINGS.hardTimeoutMs,
    }))
      setting.run(key, String(value));
    const seedInsert = db.prepare(`INSERT OR IGNORE INTO agents (
      id,name,description,system_prompt,model,allowed_tools,mcp_servers,is_active,sort_order,
      effort,thinking,thinking_budget,max_turns,skills,runtime,max_tool_rounds,squad,codex_config
    ) VALUES (@id,@name,@description,@system_prompt,@model,@allowed_tools,@mcp_servers,@is_active,0,
      @effort,@thinking,@thinking_budget,@max_turns,@skills,@runtime,@max_tool_rounds,@squad,@codex_config)`);
    for (const seed of SWARM_SEED_AGENTS)
      seedInsert.run({
        id: seed.id,
        name: seed.name,
        description: seed.description,
        system_prompt: seed.systemPrompt,
        model: seed.model,
        allowed_tools: JSON.stringify(seed.allowedTools),
        mcp_servers: JSON.stringify(seed.mcpServers),
        is_active: seed.isActive ? 1 : 0,
        effort: seed.effort,
        thinking: seed.thinking,
        thinking_budget: seed.thinkingBudget ?? 0,
        max_turns: seed.maxTurns,
        skills: JSON.stringify(seed.skills),
        runtime: seed.runtime,
        max_tool_rounds: seed.maxToolRounds,
        squad: seed.squad,
        codex_config: seed.codexConfig ? JSON.stringify(seed.codexConfig) : null,
      });
  })();
}
