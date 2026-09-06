import type Database from 'better-sqlite3';


const ORCHESTRATOR_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['orchestrator_runtime', 'claude-sdk'],
  ['orchestrator_provider', 'anthropic'],
  ['orchestrator_model', 'claude-opus-4-7'],
  ['orchestrator_ollama_base_url', 'http://localhost:11434'],
  ['orchestrator_lmstudio_base_url', 'http://localhost:1234'],
  ['orchestrator_openai_compat_preset', ''],
  ['orchestrator_openai_compat_base_url', ''],
  ['orchestrator_openai_compat_api_key_ref', ''],
  ['orchestrator_zai_api_key_ref', ''],
];

export function applyMigrationV63(db: Database.Database): void {
  const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  const insertAll = db.transaction((rows: ReadonlyArray<readonly [string, string]>) => {
    for (const [key, value] of rows) {
      stmt.run(key, value);
    }
  });
  insertAll(ORCHESTRATOR_DEFAULTS);
}

export const __V63_INTERNAL = {
  ORCHESTRATOR_DEFAULTS,
};
