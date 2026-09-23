import { describe, it, expect, vi } from 'vitest';
import { applyMigrationV69, __V69_INTERNAL } from '../db-migrations/v69-voice-transcription-model';

describe('applyMigrationV69 - structural', () => {
  it('exports applyMigrationV69 as a function', () => {
    expect(typeof applyMigrationV69).toBe('function');
  });

  it('declares whisper-1 as the default transcription model', () => {
    expect(__V69_INTERNAL.VOICE_TRANSCRIPTION_DEFAULTS).toContainEqual(['voice_transcription_model', 'whisper-1']);
  });
});

describe('applyMigrationV69 - mock DB', () => {
  it('uses INSERT OR IGNORE so existing user settings are preserved', () => {
    const run = vi.fn();
    const prepare = vi.fn(() => ({ run }));
    const transaction = vi.fn((fn: (rows: ReadonlyArray<readonly [string, string]>) => void) => fn);
    const mockDb = { prepare, transaction } as unknown as import('better-sqlite3').Database;

    applyMigrationV69(mockDb);

    expect(prepare).toHaveBeenCalledWith(expect.stringMatching(/INSERT\s+OR\s+IGNORE/i));
    expect(run).toHaveBeenCalledWith('voice_transcription_model', 'whisper-1');
  });
});
