import type Database from 'better-sqlite3';
import {
  architectureMapper,
  architectureTargetTriage,
  architectureDiagnostician,
  architectureDecisionInterviewer,
  architectureSpecEnricher,
} from '../seed-agents';


const ARCHITECTURE_REVIEW_SEEDS = [
  architectureMapper,
  architectureTargetTriage,
  architectureDiagnostician,
  architectureDecisionInterviewer,
  architectureSpecEnricher,
] as const;

export function applyMigrationV53(db: Database.Database): void {
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
    for (const seed of ARCHITECTURE_REVIEW_SEEDS) {
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

export const __V53_INTERNAL = {
  ARCHITECTURE_REVIEW_SEEDS,
};
