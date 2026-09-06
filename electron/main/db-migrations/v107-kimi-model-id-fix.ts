import type Database from 'better-sqlite3';


const SHORT_ID = 'kimi-for-coding';
const NAMESPACED_ID = 'kimi-code/kimi-for-coding';

const SETTINGS_MODEL_KEYS: ReadonlyArray<string> = ['orchestrator_model', 'default_model'];

export function applyMigrationV107(db: Database.Database): void {
  const updateAgent = db.prepare(
    `UPDATE agents SET model = ?, updated_at = datetime('now') WHERE model = ?`,
  );

  const updateSetting = db.prepare(
    `UPDATE settings SET value = ? WHERE key = ? AND value = ?`,
  );

  const run = db.transaction(() => {
    updateAgent.run(NAMESPACED_ID, SHORT_ID);
    for (const key of SETTINGS_MODEL_KEYS) {
      updateSetting.run(NAMESPACED_ID, key, SHORT_ID);
    }
  });

  run();
}

export const __V107_INTERNAL = {
  SHORT_ID,
  NAMESPACED_ID,
  SETTINGS_MODEL_KEYS,
};
