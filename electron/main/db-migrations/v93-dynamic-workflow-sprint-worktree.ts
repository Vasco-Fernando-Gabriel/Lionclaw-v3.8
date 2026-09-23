import type Database from 'better-sqlite3';
import { DYNAMIC_WORKFLOW_SPRINT_MERGE_STATUSES } from '../../../src/types/dynamic-workflow';

function checkIn(column: string, values: readonly string[]): string {
  return `CHECK (${column} IN (${values.map((v) => `'${v}'`).join(', ')}))`;
}

export const V93_SPRINT_WORKTREE_ALTERS: readonly string[] = [
  'ALTER TABLE dynamic_workflow_sprints ADD COLUMN worktree_path TEXT',
  'ALTER TABLE dynamic_workflow_sprints ADD COLUMN branch TEXT',
  'ALTER TABLE dynamic_workflow_sprints ADD COLUMN base_sha TEXT',
  'ALTER TABLE dynamic_workflow_sprints ADD COLUMN head_sha TEXT',
  `ALTER TABLE dynamic_workflow_sprints ADD COLUMN merge_status TEXT NOT NULL DEFAULT 'pending' ${checkIn(
    'merge_status',
    DYNAMIC_WORKFLOW_SPRINT_MERGE_STATUSES,
  )}`,
];

export function applyMigrationV93(db: Database.Database): void {
  for (const alter of V93_SPRINT_WORKTREE_ALTERS) {
    try {
      db.exec(alter);
    } catch {}
  }
}

export const __V93_INTERNAL = {
  TABLE: 'dynamic_workflow_sprints',
  ADDED_COLUMNS: ['worktree_path', 'branch', 'base_sha', 'head_sha', 'merge_status'],
  ALTERS: V93_SPRINT_WORKTREE_ALTERS,
  checkIn,
};
