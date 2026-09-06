import type Database from 'better-sqlite3';


const ALIAS_TO_MODEL_ID: ReadonlyArray<readonly [string, string]> = [
  ['opus',   'claude-opus-4-7'],
  ['sonnet', 'claude-sonnet-4-6'],
  ['haiku',  'claude-haiku-4-5-20251001'],
];

export function applyMigrationV60(db: Database.Database): void {
  const updateAgent = db.prepare(
    `UPDATE agents SET model = ? WHERE model = ?`,
  );

  const updateDefaultModel = db.prepare(
    `UPDATE settings SET value = ? WHERE key = 'default_model' AND value = ?`,
  );

  const run = db.transaction(() => {
    for (const [alias, modelId] of ALIAS_TO_MODEL_ID) {
      updateAgent.run(modelId, alias);
      updateDefaultModel.run(modelId, alias);
    }
  });

  run();
}

export const __V60_INTERNAL = {
  ALIAS_TO_MODEL_ID,
};
