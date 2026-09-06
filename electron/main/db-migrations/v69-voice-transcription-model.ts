import type Database from 'better-sqlite3';

const VOICE_TRANSCRIPTION_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['voice_transcription_model', 'whisper-1'],
];

export function applyMigrationV69(db: Database.Database): void {
  const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  const insertAll = db.transaction((rows: ReadonlyArray<readonly [string, string]>) => {
    for (const [key, value] of rows) {
      stmt.run(key, value);
    }
  });
  insertAll(VOICE_TRANSCRIPTION_DEFAULTS);
}

export const __V69_INTERNAL = {
  VOICE_TRANSCRIPTION_DEFAULTS,
};
