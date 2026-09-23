import type Database from 'better-sqlite3';

const PREVIOUS_DEFAULT_MODEL = 'claude-opus-5';
const NEW_DEFAULT_MODEL = 'claude-opus-5-5';
const PREVIOUS_SEED_MODELS = ['claude-opus-4-8', 'claude-opus-4-7'];

const SEED_AGENT_IDS = [
  'ai-engineer',
  'architecture-diagnostician',
  'architecture-mapper',
  'backend-developer',
  'bug-context-historian',
  'bug-discovery',
  'bug-hypothesis-refuter',
  'bug-root-cause-analyst',
  'bug-solution-consolidator',
  'cloud-architect',
  'code-reviewer',
  'data-analyst',
  'debugger',
  'devops-engineer',
  'dynamic-workflow-builder',
  'dynamic-workflow-sprint-planner',
  'electron-pro',
  'feat-discovery',
  'frontend-developer',
  'harness-planner',
  'javascript-pro',
  'llm-architect',
  'ml-engineer',
  'pipe2-design-plan-validator',
  'pipe2-design-planner',
  'pipe2-prd-completo',
  'pipe2-spec-builder',
  'postgres-pro',
  'python-pro',
  'react-specialist',
  'security-auditor',
  'security-skeptic-security',
  'sql-pro',
  'typescript-pro',
];

export function applyMigrationV157(db: Database.Database): void {
  const idPlaceholders = SEED_AGENT_IDS.map(() => '?').join(', ');
  const modelPlaceholders = PREVIOUS_SEED_MODELS.map(() => '?').join(', ');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `UPDATE settings
          SET value = ?
        WHERE key = 'orchestrator_model'
          AND value = ?`,
    ).run(NEW_DEFAULT_MODEL, PREVIOUS_DEFAULT_MODEL);

    db.prepare(
      `UPDATE agents
          SET model = ?
        WHERE id IN (${idPlaceholders})
          AND runtime = 'cloud'
          AND model IN (${modelPlaceholders})`,
    ).run(NEW_DEFAULT_MODEL, ...SEED_AGENT_IDS, ...PREVIOUS_SEED_MODELS);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export const __V157_INTERNAL = { PREVIOUS_DEFAULT_MODEL, NEW_DEFAULT_MODEL, PREVIOUS_SEED_MODELS, SEED_AGENT_IDS };
