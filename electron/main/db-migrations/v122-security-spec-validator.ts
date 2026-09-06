import type Database from 'better-sqlite3';
import { securitySpecValidator } from '../seed-agents/security-spec-validator';

export function applyMigrationV122(db: Database.Database): void {
  const seed = securitySpecValidator;
  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM agents')
    .get() as { m: number };

  db.prepare(
    `INSERT OR IGNORE INTO agents (
        id, name, description, system_prompt, model, allowed_tools, mcp_servers,
        is_active, sort_order, effort, thinking, thinking_budget, max_turns,
        skills, runtime, local_config, external_config, codex_config, local_mode,
        max_tool_rounds, squad, access, allow_bash, allowed_commands, allow_network
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.id,
    seed.name,
    seed.description,
    seed.systemPrompt,
    seed.model,
    JSON.stringify(seed.allowedTools),
    JSON.stringify(seed.mcpServers),
    seed.isActive ? 1 : 0,
    maxOrder.m + 1,
    seed.effort || 'medium',
    seed.thinking || 'adaptive',
    seed.thinkingBudget ?? null,
    seed.maxTurns ?? null,
    JSON.stringify(seed.skills || []),
    seed.runtime || 'cloud',
    null,
    null,
    null,
    'simple',
    seed.maxToolRounds ?? 5,
    seed.squad ?? null,
    seed.access ?? 'read-only',
    seed.allowBash ? 1 : 0,
    JSON.stringify(seed.allowedCommands ?? []),
    seed.allowNetwork ? 1 : 0,
  );

  db.prepare(
    `UPDATE agents SET access = 'workspace-write' WHERE id = ? AND access = 'read-only'`,
  ).run(seed.id);
}
