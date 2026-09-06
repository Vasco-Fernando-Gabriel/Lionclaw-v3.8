import type Database from 'better-sqlite3';
import {
  DEFAULT_CHAT_COMPACTION_TARGET_TOKENS,
  CHAT_COMPACTION_TARGET_TOKENS_SETTING_KEY,
  DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT,
  CHAT_COMPACTION_TRIGGER_PERCENT_SETTING_KEY,
} from '../chat-compaction-defaults';


const CHAT_COMPACTION_SETTING_SEEDS: ReadonlyArray<readonly [string, string]> = [
  [CHAT_COMPACTION_TARGET_TOKENS_SETTING_KEY, String(DEFAULT_CHAT_COMPACTION_TARGET_TOKENS)],
  [CHAT_COMPACTION_TRIGGER_PERCENT_SETTING_KEY, String(DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT)],
];

export function applyMigrationV129(db: Database.Database): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
  );
  for (const [key, value] of CHAT_COMPACTION_SETTING_SEEDS) {
    insert.run(key, value);
  }
}

export const __V129_INTERNAL = {
  CHAT_COMPACTION_SETTING_SEEDS,
};
