
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MigrationError,
  buildDbMigrationErrorBox,
  DB_MIGRATION_ERROR_CODE,
} from '../db-init-error';

describe('SB-7 AC-B17: MigrationError + caixa de erro DB-MIGRATION', () => {
  it('AC-B17: MigrationError carrega versao, path e cause (message/stack preservados)', () => {
    const cause = new Error('SQLITE_ERROR: no such table: settings');
    const err = new MigrationError(87, '/home/x/.lionclaw/data/lionclaw.db', cause);
    expect(err.version).toBe(87);
    expect(err.dbPath).toBe('/home/x/.lionclaw/data/lionclaw.db');
    expect(err.code).toBe(DB_MIGRATION_ERROR_CODE);
    expect(err.message).toContain('Migration v87 falhou');
    expect(err.message).toContain('no such table: settings');
    expect(err.cause).toBe(cause);
  });

  it('AC-B17: buildDbMigrationErrorBox contem DB-MIGRATION + path do banco', () => {
    const err = new MigrationError(129, '/tmp/db/lionclaw.db', new Error('disk I/O error'));
    const box = buildDbMigrationErrorBox(err, '/ignored/fallback.db');
    expect(box.title).toContain('DB-MIGRATION');
    expect(box.message).toContain('DB-MIGRATION');
    expect(box.message).toContain('/tmp/db/lionclaw.db');
    expect(box.message).toContain('Migration v129 falhou');
    expect(box.message).toContain('disk I/O error');
  });

  it('AC-B17: erro generico (nao-MigrationError) ainda produz caixa com codigo + path', () => {
    const box = buildDbMigrationErrorBox(new Error('cannot open database file'), '/x/lionclaw.db');
    expect(box.title).toContain('DB-MIGRATION');
    expect(box.message).toContain('/x/lionclaw.db');
    expect(box.message).toContain('cannot open database file');
  });
});

describe('SB-7 AC-B17: wiring do boot (assercao de fonte, index.ts + db.ts)', () => {
  const indexSrc = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8');
  const dbSrc = readFileSync(join(__dirname, '..', 'db.ts'), 'utf-8');

  it('AC-B17: index.ts embrulha initDatabase em try/catch com showErrorBox + app.quit', () => {
    const tryIdx = indexSrc.indexOf('initDatabase();');
    expect(tryIdx).toBeGreaterThan(-1);
    const catchBlock = indexSrc.slice(tryIdx, tryIdx + 800);
    expect(catchBlock).toContain('buildDbMigrationErrorBox');
    expect(catchBlock).toContain('dialog.showErrorBox');
    expect(catchBlock).toContain('app.quit()');
  });

  it('AC-B17: o dialog roda ANTES da chamada de createWindow no boot', () => {
    const showErrorIdx = indexSrc.indexOf('dialog.showErrorBox');
    const createWindowCall = indexSrc.search(/^\s*createWindow\(\);/m);
    expect(showErrorIdx).toBeGreaterThan(-1);
    expect(createWindowCall).toBeGreaterThan(-1);
    expect(showErrorIdx).toBeLessThan(createWindowCall);
  });

  it('AC-B17: db.ts converte falha de runMigrations em MigrationError (estado escrito antes do re-throw)', () => {
    expect(dbSrc).toContain('new MigrationError(');
    expect(dbSrc).toContain('databaseInitError = failed;');
    expect(dbSrc).toContain('throw failed;');
  });

  it('SB-7 (P7): sqliteVec.load falho vira VEC-UNAVAILABLE degradado (nao boot mudo)', () => {
    expect(dbSrc).toContain("code: 'VEC-UNAVAILABLE'");
    expect(dbSrc).toContain('vecAvailable = false;');
    expect(dbSrc).toMatch(/if \(vecAvailable\) \{\s*\n\s*\(hooks\.repairVecSchema \?\? fixVecTableIfNeeded\)\(\);/);
  });

  it('SB-7 (P7): catch da V19 estreitado para duplicate column (nao engole tudo)', () => {
    expect(dbSrc).toContain('/duplicate column/i');
    const v19Idx = dbSrc.indexOf('MIGRATION_V19);');
    const v19Block = dbSrc.slice(v19Idx, v19Idx + 700);
    expect(v19Block).toContain('throw error;');
  });
});
