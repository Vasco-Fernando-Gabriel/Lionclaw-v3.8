import type Database from 'better-sqlite3';
import { dynamicWorkflowMaestro } from '../seed-agents/dynamic-workflow-builder';

export function applyMigrationV92(db: Database.Database): void {
  const seed = dynamicWorkflowMaestro;

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM agents').get() as { m: number };

  db.prepare(
    `INSERT OR IGNORE INTO agents (
        id, name, description, system_prompt, model, allowed_tools, mcp_servers,
        is_active, sort_order, effort, thinking, thinking_budget, max_turns,
        skills, kb_enabled, runtime, local_config, external_config, codex_config,
        local_mode, max_tool_rounds, squad
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    0, // kb_enabled = 0 (lean; nunca auto-injetar KB no Maestro)
    seed.runtime || 'cloud',
    null,
    null,
    null,
    'simple',
    seed.maxToolRounds ?? 5,
    seed.squad ?? null,
  );

  const leanTools = JSON.stringify(seed.allowedTools);

  db.prepare(`UPDATE agents SET kb_enabled = 0 WHERE id = ? AND kb_enabled = 1`).run(seed.id);

  db.prepare(
    `UPDATE agents SET skills = '[]'
       WHERE id = ? AND (skills IS NULL OR skills = '[]' OR skills = '')`,
  ).run(seed.id);

  db.prepare(
    `UPDATE agents SET mcp_servers = '[]'
       WHERE id = ? AND (mcp_servers IS NULL OR mcp_servers = '[]' OR mcp_servers = '')`,
  ).run(seed.id);

  db.prepare(
    `UPDATE agents SET allowed_tools = ?
       WHERE id = ? AND (allowed_tools IS NULL OR allowed_tools = '[]' OR allowed_tools = '')`,
  ).run(leanTools, seed.id);
}
