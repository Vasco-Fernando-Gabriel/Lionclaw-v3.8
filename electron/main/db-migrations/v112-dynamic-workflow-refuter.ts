import type Database from 'better-sqlite3';
import { dynamicWorkflowRefuter } from '../seed-agents/dynamic-workflow-refuter';

export function applyMigrationV112(db: Database.Database): void {
  const seed = dynamicWorkflowRefuter;
  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM agents')
    .get() as { m: number };

  db.prepare(
    `INSERT OR IGNORE INTO agents (
        id, name, description, system_prompt, model, allowed_tools, mcp_servers,
        is_active, sort_order, effort, thinking, thinking_budget, max_turns,
        skills, runtime, local_config, external_config, codex_config, local_mode,
        max_tool_rounds, squad
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  );
}
