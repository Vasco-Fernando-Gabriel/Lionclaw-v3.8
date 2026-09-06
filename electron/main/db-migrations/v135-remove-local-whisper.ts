import type Database from 'better-sqlite3';

export function applyMigrationV135(db: Database.Database): void {
  db.prepare(
    `UPDATE settings
        SET value = 'whisper-1'
      WHERE key = 'voice_transcription_model'
        AND value LIKE 'local-whisper-%'`,
  ).run();

  db.prepare(
    `DELETE FROM settings
      WHERE key IN (
        'voice_local_whisper_model_path',
        'voice_local_whisper_binary_path',
        'voice_local_ffmpeg_path'
      )`,
  ).run();
}
