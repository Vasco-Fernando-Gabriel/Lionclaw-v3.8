import { describe, it, expect, vi } from 'vitest';
import { applyMigrationV66 } from '../db-migrations/v66-lion-session-summaries';

describe('applyMigrationV66 - structural', () => {
  it('exports applyMigrationV66 as a function', () => {
    expect(typeof applyMigrationV66).toBe('function');
  });
});

describe('applyMigrationV66 - mock DB', () => {
  it('calls exec with CREATE TABLE IF NOT EXISTS lion_session_summaries', () => {
    const mockExec = vi.fn();
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;

    applyMigrationV66(mockDb);

    expect(mockExec).toHaveBeenCalledOnce();
    const sql: string = mockExec.mock.calls[0][0];
    expect(sql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+lion_session_summaries/i);
  });

  it('schema includes all required columns', () => {
    const mockExec = vi.fn();
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;

    applyMigrationV66(mockDb);

    const sql: string = mockExec.mock.calls[0][0];
    expect(sql).toContain('session_id');
    expect(sql).toContain('summary_text');
    expect(sql).toContain('covers_until_message_id');
    expect(sql).toContain('model_used');
    expect(sql).toContain('provider_used');
    expect(sql).toContain('input_tokens');
    expect(sql).toContain('output_tokens');
    expect(sql).toContain('created_at');
  });

  it('schema includes FK to sessions and ON DELETE CASCADE', () => {
    const mockExec = vi.fn();
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;

    applyMigrationV66(mockDb);

    const sql: string = mockExec.mock.calls[0][0];
    expect(sql).toMatch(/REFERENCES\s+sessions\s*\(\s*id\s*\)\s*ON\s+DELETE\s+CASCADE/i);
  });

  it('is idempotent: second call does not throw', () => {
    const mockExec = vi.fn();
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;

    expect(() => applyMigrationV66(mockDb)).not.toThrow();
    expect(() => applyMigrationV66(mockDb)).not.toThrow();
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it('does not DROP any table', () => {
    const mockExec = vi.fn();
    const mockDb = { exec: mockExec } as unknown as import('better-sqlite3').Database;

    applyMigrationV66(mockDb);

    const sql: string = mockExec.mock.calls[0][0];
    expect(sql.toUpperCase()).not.toContain('DROP');
  });
});
