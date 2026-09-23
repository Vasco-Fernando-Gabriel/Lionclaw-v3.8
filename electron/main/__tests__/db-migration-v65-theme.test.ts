import { describe, it, expect, vi } from 'vitest';

import { applyMigrationV65 } from '../db-migrations/v65-drop-theme-setting';

describe('applyMigrationV65 - structural', () => {
  it('exports applyMigrationV65 as a function', () => {
    expect(typeof applyMigrationV65).toBe('function');
  });
});

describe('applyMigrationV65 - mock DB', () => {
  it('calls prepare with DELETE WHERE key = theme and then run', () => {
    const mockRun = vi.fn();
    const mockPrepare = vi.fn().mockReturnValue({ run: mockRun });
    const mockDb = { prepare: mockPrepare } as unknown as import('better-sqlite3').Database;

    applyMigrationV65(mockDb);

    expect(mockPrepare).toHaveBeenCalledOnce();
    const sql: string = mockPrepare.mock.calls[0][0];
    expect(sql).toMatch(/DELETE\s+FROM\s+settings\s+WHERE\s+key\s*=\s*'theme'/i);
    expect(mockRun).toHaveBeenCalledOnce();
  });

  it('is idempotent by design: second call also invokes prepare+run without error', () => {
    const mockRun = vi.fn();
    const mockPrepare = vi.fn().mockReturnValue({ run: mockRun });
    const mockDb = { prepare: mockPrepare } as unknown as import('better-sqlite3').Database;

    expect(() => applyMigrationV65(mockDb)).not.toThrow();
    expect(() => applyMigrationV65(mockDb)).not.toThrow();
    expect(mockPrepare).toHaveBeenCalledTimes(2);
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('does not run any INSERT or CREATE statement', () => {
    const mockRun = vi.fn();
    const mockPrepare = vi.fn().mockReturnValue({ run: mockRun });
    const mockDb = { prepare: mockPrepare } as unknown as import('better-sqlite3').Database;

    applyMigrationV65(mockDb);

    const sql: string = mockPrepare.mock.calls[0][0];
    expect(sql.toUpperCase()).not.toContain('INSERT');
    expect(sql.toUpperCase()).not.toContain('CREATE');
    expect(sql.toUpperCase()).not.toContain('ALTER');
  });
});
