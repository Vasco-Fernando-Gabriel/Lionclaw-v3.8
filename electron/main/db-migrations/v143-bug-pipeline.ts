import type Database from 'better-sqlite3';
import {
  bugDiscovery,
  bugRootCauseAnalyst,
  bugContextHistorian,
  bugHypothesisRefuter,
  bugSolutionConsolidator,
  bugSpecValidator,
} from '../seed-agents';


const BUG_PIPELINE_SEEDS = [
  bugDiscovery,
  bugRootCauseAnalyst,
  bugContextHistorian,
  bugHypothesisRefuter,
  bugSolutionConsolidator,
  bugSpecValidator,
] as const;

const BUG_ANALYSIS_AGENT_STATUS_DDL = `
  CREATE TABLE IF NOT EXISTS bug_analysis_agent_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES harness_projects(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    agent_slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    output_file TEXT,
    started_at TEXT,
    completed_at TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bug_analysis_agent_status_project
    ON bug_analysis_agent_status(project_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bug_analysis_agent_run_agent
    ON bug_analysis_agent_status(project_id, run_id, agent_id);
`;

export function applyMigrationV143(db: Database.Database): void {
  db.exec(BUG_ANALYSIS_AGENT_STATUS_DDL);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO agents (
      id,
      name,
      description,
      system_prompt,
      model,
      allowed_tools,
      mcp_servers,
      is_active,
      sort_order,
      effort,
      thinking,
      thinking_budget,
      max_turns,
      skills,
      runtime,
      max_tool_rounds,
      squad
    ) VALUES (
      @id,
      @name,
      @description,
      @system_prompt,
      @model,
      @allowed_tools,
      @mcp_servers,
      @is_active,
      0,
      @effort,
      @thinking,
      @thinking_budget,
      @max_turns,
      @skills,
      @runtime,
      @max_tool_rounds,
      @squad
    )
  `);

  const tx = db.transaction(() => {
    for (const seed of BUG_PIPELINE_SEEDS) {
      insertStmt.run({
        id: seed.id,
        name: seed.name,
        description: seed.description,
        system_prompt: seed.systemPrompt,
        model: seed.model,
        allowed_tools: JSON.stringify(seed.allowedTools ?? []),
        mcp_servers: JSON.stringify(seed.mcpServers ?? []),
        is_active: seed.isActive ? 1 : 0,
        effort: seed.effort,
        thinking: seed.thinking,
        thinking_budget: seed.thinkingBudget ?? 0,
        max_turns: seed.maxTurns,
        skills: JSON.stringify(seed.skills ?? []),
        runtime: seed.runtime,
        max_tool_rounds: seed.maxToolRounds,
        squad: seed.squad,
      });
    }
  });
  tx();
}

export const __V143_INTERNAL = {
  BUG_PIPELINE_SEEDS,
  BUG_ANALYSIS_AGENT_STATUS_DDL,
};
