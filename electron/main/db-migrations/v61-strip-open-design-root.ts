import type Database from 'better-sqlite3';

export function applyMigrationV61(db: Database.Database): void {
  db.exec(`
    UPDATE harness_projects
    SET config = JSON_REMOVE(config, '$.openDesign.openDesignRoot')
    WHERE JSON_TYPE(config, '$.openDesign.openDesignRoot') IS NOT NULL;
  `);
}
