
import { describe, it, expect, vi } from 'vitest';
import {
  applyMigrationV68,
  __V68_INTERNAL,
} from '../db-migrations/v68-orchestrator-compaction-trigger-settings';

describe('applyMigrationV68 - structural', () => {
  it('exports applyMigrationV68 as a function', () => {
    expect(typeof applyMigrationV68).toBe('function');
  });

  it('declares context-window and threshold defaults', () => {
    expect(__V68_INTERNAL.COMPACTION_TRIGGER_DEFAULTS).toContainEqual([
      'orchestrator_context_window_tokens',
      '',
    ]);
    expect(__V68_INTERNAL.COMPACTION_TRIGGER_DEFAULTS).toContainEqual([
      'orchestrator_compaction_threshold_percent',
      '70',
    ]);
  });
});

describe('applyMigrationV68 - mock DB', () => {
  it('uses INSERT OR IGNORE so existing user settings are preserved', () => {
    const run = vi.fn();
    const prepare = vi.fn(() => ({ run }));
    const transaction = vi.fn((fn: (rows: ReadonlyArray<readonly [string, string]>) => void) => fn);
    const mockDb = { prepare, transaction } as unknown as import('better-sqlite3').Database;

    applyMigrationV68(mockDb);

    expect(prepare).toHaveBeenCalledWith(expect.stringMatching(/INSERT\s+OR\s+IGNORE/i));
    expect(run).toHaveBeenCalledWith('orchestrator_context_window_tokens', '');
    expect(run).toHaveBeenCalledWith('orchestrator_compaction_threshold_percent', '70');
  });
});
