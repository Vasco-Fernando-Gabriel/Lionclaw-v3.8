
import { describe, it, expect, vi } from 'vitest';


import { applyMigrationV72, __V72_INTERNAL } from '../db-migrations/v72-unknown-cost-tracking';

describe('applyMigrationV72 - structural', () => {
  it('exports applyMigrationV72 as a function', () => {
    expect(typeof applyMigrationV72).toBe('function');
  });

  it('__V72_INTERNAL lists the 3 expected column paths', () => {
    expect(__V72_INTERNAL.alters).toContain('harness_rounds.unknown_cost_count');
    expect(__V72_INTERNAL.alters).toContain('harness_projects.planner_unknown_cost_count');
    expect(__V72_INTERNAL.alters).toContain('pipeline_phase_metrics.unknown_cost_count');
    expect(__V72_INTERNAL.alters).toHaveLength(3);
  });
});


describe('applyMigrationV72 - mock DB (normal execution)', () => {
  it('calls db.exec exactly 3 times (one ALTER per table)', () => {
    const mockExec = vi.fn();
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;

    applyMigrationV72(mockDb);

    expect(mockExec).toHaveBeenCalledTimes(3);
  });

  it('first ALTER targets harness_rounds.unknown_cost_count', () => {
    const mockExec = vi.fn();
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;

    applyMigrationV72(mockDb);

    const firstSql: string = mockExec.mock.calls[0][0];
    expect(firstSql).toMatch(/ALTER TABLE harness_rounds/i);
    expect(firstSql).toMatch(/ADD COLUMN unknown_cost_count/i);
    expect(firstSql).toMatch(/INTEGER NOT NULL DEFAULT 0/i);
  });

  it('second ALTER targets harness_projects.planner_unknown_cost_count', () => {
    const mockExec = vi.fn();
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;

    applyMigrationV72(mockDb);

    const secondSql: string = mockExec.mock.calls[1][0];
    expect(secondSql).toMatch(/ALTER TABLE harness_projects/i);
    expect(secondSql).toMatch(/ADD COLUMN planner_unknown_cost_count/i);
    expect(secondSql).toMatch(/INTEGER NOT NULL DEFAULT 0/i);
  });

  it('third ALTER targets pipeline_phase_metrics.unknown_cost_count', () => {
    const mockExec = vi.fn();
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;

    applyMigrationV72(mockDb);

    const thirdSql: string = mockExec.mock.calls[2][0];
    expect(thirdSql).toMatch(/ALTER TABLE pipeline_phase_metrics/i);
    expect(thirdSql).toMatch(/ADD COLUMN unknown_cost_count/i);
    expect(thirdSql).toMatch(/INTEGER NOT NULL DEFAULT 0/i);
  });

  it('does not emit any INSERT, CREATE, or DROP statements', () => {
    const mockExec = vi.fn();
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;

    applyMigrationV72(mockDb);

    for (const call of mockExec.mock.calls) {
      const sql: string = (call[0] as string).toUpperCase();
      expect(sql).not.toContain('INSERT');
      expect(sql).not.toContain('CREATE');
      expect(sql).not.toContain('DROP');
    }
  });
});


describe('applyMigrationV72 - idempotency', () => {
  it('does NOT throw when db.exec raises "duplicate column name"', () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error('duplicate column name: unknown_cost_count');
    });
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;

    expect(() => applyMigrationV72(mockDb)).not.toThrow();
  });

  it('catches duplicate column errors for all three ALTER statements independently', () => {
    let callCount = 0;
    const mockExec = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1 || callCount === 3) {
        throw new Error('duplicate column name: unknown_cost_count');
      }
    });
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;

    expect(() => applyMigrationV72(mockDb)).not.toThrow();
    expect(mockExec).toHaveBeenCalledTimes(3);
  });
});


describe('applyMigrationV72 - unexpected errors', () => {
  it('re-throws errors that are NOT duplicate column name', () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error('table harness_rounds has no column named x');
    });
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;

    expect(() => applyMigrationV72(mockDb)).toThrow('table harness_rounds has no column named x');
  });

  it('re-throws disk I/O errors', () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;

    expect(() => applyMigrationV72(mockDb)).toThrow('disk I/O error');
  });
});
