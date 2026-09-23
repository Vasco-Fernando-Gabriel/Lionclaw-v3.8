import type Database from 'better-sqlite3';

interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

function foreignKeyViolationKey(violation: ForeignKeyViolation): string {
  return JSON.stringify([violation.table, violation.rowid, violation.parent, violation.fkid]);
}

export function applyMigrationV154(db: Database.Database): void {
  const columns = db.pragma('table_info(kanban_card_events)') as Array<{ name: string }>;
  if (columns.length === 0 || columns.some((column) => column.name === 'actor_detail')) return;
  const violationsBefore = new Set(
    (db.pragma('foreign_key_check(kanban_card_events)') as ForeignKeyViolation[]).map(foreignKeyViolationKey),
  );
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE kanban_card_events_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id      INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
        event        TEXT NOT NULL CHECK (event IN
                     ('created','moved','delivered','edited','reopened',
                      'archived','unarchived','attachment-added',
                      'attachment-removed')),
        from_column  TEXT,
        to_column    TEXT,
        reason       TEXT,
        actor        TEXT NOT NULL CHECK (actor IN ('user','orchestrator','scheduler','lioncode')),
        actor_detail TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO kanban_card_events_new
        (id, card_id, event, from_column, to_column, reason, actor, created_at)
      SELECT id, card_id, event, from_column, to_column, reason, actor, created_at
      FROM kanban_card_events;
      DROP TABLE kanban_card_events;
      ALTER TABLE kanban_card_events_new RENAME TO kanban_card_events;
      CREATE INDEX IF NOT EXISTS idx_kanban_events_card
        ON kanban_card_events(card_id, created_at);
    `);
    const violationsAfter = db.pragma('foreign_key_check(kanban_card_events)') as ForeignKeyViolation[];
    const introduced = violationsAfter.filter((violation) => !violationsBefore.has(foreignKeyViolationKey(violation)));
    if (introduced.length > 0) {
      throw new Error(`Migration v154 deixou ${introduced.length} violacoes novas de foreign key`);
    }
  });
  migrate();
}
