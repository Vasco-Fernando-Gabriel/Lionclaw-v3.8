import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrationV135 } from '../db-migrations/v135-remove-local-whisper';

describe('migration v135 - remove local Whisper', () => {
  let db: Database.Database | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it('moves local model selections to whisper-1 and removes obsolete paths', () => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    insert.run('voice_transcription_model', 'local-whisper-large-v3-turbo');
    insert.run('voice_local_whisper_model_path', '/models/model.bin');
    insert.run('voice_local_whisper_binary_path', '/bin/whisper-cli');
    insert.run('voice_local_ffmpeg_path', '/bin/ffmpeg');
    insert.run('unrelated', 'preserved');

    applyMigrationV135(db);

    const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
    expect(rows).toEqual([
      { key: 'unrelated', value: 'preserved' },
      { key: 'voice_transcription_model', value: 'whisper-1' },
    ]);
  });

  it.each(['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe'])(
    'preserves API selection %s and is idempotent',
    (model) => {
      db = new Database(':memory:');
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('voice_transcription_model', model);

      applyMigrationV135(db);
      applyMigrationV135(db);

      expect(db.prepare("SELECT value FROM settings WHERE key = 'voice_transcription_model'").pluck().get()).toBe(
        model,
      );
    },
  );

  it('is registered as schema version 135 in the canonical migration runner', () => {
    const source = readFileSync(join(process.cwd(), 'electron/main/db.ts'), 'utf8');
    expect(source).toContain("import { applyMigrationV135 } from './db-migrations/v135-remove-local-whisper'");
    expect(source).toMatch(/if \(currentVersion < 135\) \{[\s\S]*?applyMigrationV135\(db\);/);
    expect(source).toContain("INSERT INTO schema_version (version) VALUES (?)').run(135)");
  });
});
