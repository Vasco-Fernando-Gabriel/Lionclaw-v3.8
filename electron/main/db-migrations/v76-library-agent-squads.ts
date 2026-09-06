import type Database from 'better-sqlite3';

const LIBRARY_AGENT_SQUADS: Record<string, string> = {
  'backend-developer': 'backend',
  'python-pro': 'backend',
  'typescript-pro': 'backend',
  'frontend-developer': 'frontend',
  'electron-pro': 'frontend',
  'javascript-pro': 'frontend',
  'nextjs-developer': 'frontend',
  'react-specialist': 'frontend',
  'sql-pro': 'database',
  'postgres-pro': 'database',
  'ai-engineer': 'data-ai',
  'llm-architect': 'data-ai',
  'ml-engineer': 'data-ai',
  'data-analyst': 'data-ai',
  'cloud-architect': 'infra',
  'devops-engineer': 'infra',
  'code-reviewer': 'quality',
  'debugger': 'quality',
  'security-auditor': 'quality',
  'pipe2-design-planner': 'pipeline',
  'pipe2-design-plan-validator': 'pipeline',
};

export function applyMigrationV76(db: Database.Database): void {
  const stmt = db.prepare(
    'UPDATE agents SET squad = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (squad IS NULL OR squad != ?)',
  );
  for (const [id, squad] of Object.entries(LIBRARY_AGENT_SQUADS)) {
    stmt.run(squad, id, squad);
  }
}
