import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertDatabaseIntegrity,
  clearMigrationInProgressMarker,
  LATEST_SCHEMA_VERSION,
  prepareDatabaseForMigrations,
} from '../db-migration-safety';
import {
  DatabaseBackupError,
  DatabaseIntegrityError,
  DatabaseRecoveryRequiredError,
  DatabaseVersionError,
} from '../db-init-error';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDatabase(version = LATEST_SCHEMA_VERSION): {
  dir: string;
  dbPath: string;
  db: Database.Database;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-db-safety-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'lionclaw.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version(version) VALUES (${version});
    CREATE TABLE user_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO user_data(value) VALUES ('estado-original');
  `);
  return { dir, dbPath, db };
}

function prepare(
  db: Database.Database,
  dbPath: string,
  overrides: Partial<Parameters<typeof prepareDatabaseForMigrations>[0]> = {},
) {
  return prepareDatabaseForMigrations({
    database: db,
    dbPath,
    existingDatabase: true,
    latestSchemaVersion: LATEST_SCHEMA_VERSION,
    requiresSchemaRepair: false,
    openReadonlyDatabase: (candidate) => new Database(candidate, { readonly: true, fileMustExist: true }),
    now: () => new Date('2026-07-11T12:34:56.789Z'),
    randomId: () => 'fixed-id',
    ...overrides,
  });
}

describe('preflight de integridade e versao', () => {
  it('banco saudavel e atualizado segue sem backup', () => {
    const { db, dbPath } = tempDatabase();
    const result = prepare(db, dbPath);
    expect(result).toEqual({
      currentVersion: LATEST_SCHEMA_VERSION,
      backupPath: null,
      markerPath: null,
    });
    db.close();
  });

  it('arquivo fisicamente corrompido falha DB-INTEGRITY antes de backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-db-corrupt-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'lionclaw.db');
    fs.writeFileSync(dbPath, Buffer.alloc(4096, 0x5a));
    const db = new Database(dbPath);
    expect(() => prepare(db, dbPath)).toThrow(DatabaseIntegrityError);
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
    db.close();
  });

  it('resultado de pragma diferente de ok falha fechado', () => {
    const fake = {
      pragma: () => [{ integrity_check: 'row 7 missing from index' }],
    } as unknown as Database.Database;
    expect(() => assertDatabaseIntegrity(fake, '/tmp/broken.db')).toThrow(DatabaseIntegrityError);
  });

  it('downgrade do app falha DB-VERSION antes de backup', () => {
    const { db, dbPath, dir } = tempDatabase(LATEST_SCHEMA_VERSION + 1);
    expect(() => prepare(db, dbPath)).toThrow(DatabaseVersionError);
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
    db.close();
  });

  it('schema_version invalida falha DB-VERSION', () => {
    const { db, dbPath } = tempDatabase();
    db.exec(
      "DROP TABLE schema_version; CREATE TABLE schema_version(version TEXT); INSERT INTO schema_version VALUES ('NaN')",
    );
    expect(() => prepare(db, dbPath)).toThrow(DatabaseVersionError);
    db.close();
  });
});

describe('decisao e consistencia do snapshot', () => {
  it('banco novo nao cria backup mesmo com migrations pendentes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-db-new-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'lionclaw.db');
    const db = new Database(dbPath);
    const result = prepare(db, dbPath, { existingDatabase: false });
    expect(result.currentVersion).toBe(0);
    expect(result.backupPath).toBeNull();
    db.close();
  });

  it('banco sem schema_version e existente recebe backup v0', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-db-v0-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'lionclaw.db');
    const db = new Database(dbPath);
    db.exec("CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES ('preservar')");
    const result = prepare(db, dbPath);
    expect(result.currentVersion).toBe(0);
    expect(result.backupPath).toContain(`lionclaw-v0-to-v${LATEST_SCHEMA_VERSION}-20260711T123456789Z-fixed-id.db`);
    db.close();
  });

  it('reparo schema-real em versao atual tambem exige backup', () => {
    const { db, dbPath } = tempDatabase();
    const result = prepare(db, dbPath, { requiresSchemaRepair: true });
    expect(result.backupPath).not.toBeNull();
    db.close();
  });

  it('valida snapshot com virtual table vec0 realmente consultavel', () => {
    const { db, dbPath } = tempDatabase(LATEST_SCHEMA_VERSION - 1);
    sqliteVec.load(db);
    db.exec(`CREATE VIRTUAL TABLE semantic_memories_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[2]
    )`);
    const result = prepare(db, dbPath, {
      loadSqliteVec: (candidate) => sqliteVec.load(candidate),
    });
    expect(result.backupPath).not.toBeNull();
    db.close();
  });

  it('VACUUM INTO captura commit ainda no WAL e snapshot restaura estado pre-upgrade', () => {
    const { db, dbPath, dir } = tempDatabase(LATEST_SCHEMA_VERSION - 1);
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    const insert = db.prepare('INSERT INTO user_data(value) VALUES (?)');
    const transaction = db.transaction(() => {
      for (let i = 0; i < 200; i += 1) insert.run(`wal-${i}`);
    });
    transaction();
    const walPath = `${dbPath}-wal`;
    expect(fs.existsSync(walPath)).toBe(true);
    expect(fs.statSync(walPath).size).toBeGreaterThan(0);

    const result = prepare(db, dbPath);
    expect(result.backupPath).not.toBeNull();
    const backupPath = result.backupPath!;
    expect(backupPath.endsWith('.partial')).toBe(false);
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    expect(backup.pragma('integrity_check(1)')).toEqual([{ integrity_check: 'ok' }]);
    expect(backup.prepare('SELECT COUNT(*) AS count FROM user_data').get()).toEqual({ count: 201 });
    backup.close();

    db.exec("DELETE FROM user_data; INSERT INTO user_data(value) VALUES ('pos-upgrade')");
    const unchanged = new Database(backupPath, { readonly: true, fileMustExist: true });
    expect(unchanged.prepare('SELECT COUNT(*) AS count FROM user_data').get()).toEqual({ count: 201 });
    unchanged.close();

    const restorePath = path.join(dir, 'restored.db');
    fs.copyFileSync(backupPath, restorePath);
    const restored = new Database(restorePath, { readonly: true, fileMustExist: true });
    expect(restored.pragma('integrity_check(1)')).toEqual([{ integrity_check: 'ok' }]);
    expect(restored.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({
      version: LATEST_SCHEMA_VERSION - 1,
    });
    expect(restored.prepare('SELECT COUNT(*) AS count FROM user_data').get()).toEqual({ count: 201 });
    restored.close();
    db.close();
  });
});

describe('falhas de backup e marker duravel', () => {
  it.each([
    ['EACCES', 'permission denied'],
    ['ENOSPC', 'no space left on device'],
    ['SQLITE_FULL', 'database or disk is full'],
  ])('preserva causa %s e nao libera migrations', (code, message) => {
    const { db, dbPath } = tempDatabase(LATEST_SCHEMA_VERSION - 1);
    const cause = Object.assign(new Error(message), { code });
    let error: unknown;
    try {
      prepare(db, dbPath, {
        deps: {
          vacuumInto: () => {
            throw cause;
          },
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DatabaseBackupError);
    expect((error as Error).cause).toBe(cause);
    db.close();
  });

  it('backup parcial invalido nao e publicado e e removido', () => {
    const { db, dbPath, dir } = tempDatabase(LATEST_SCHEMA_VERSION - 1);
    expect(() =>
      prepare(db, dbPath, {
        deps: {
          vacuumInto: (_database, destination) => fs.writeFileSync(destination, 'not sqlite'),
        },
      }),
    ).toThrow(DatabaseBackupError);
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    expect(backups.some((name) => name.endsWith('.partial'))).toBe(false);
    expect(backups.some((name) => name.endsWith('.db'))).toBe(false);
    db.close();
  });

  it('falha de rename limpa apenas o parcial e nunca publica final', () => {
    const { db, dbPath, dir } = tempDatabase(LATEST_SCHEMA_VERSION - 1);
    expect(() =>
      prepare(db, dbPath, {
        deps: {
          renameSync: () => {
            throw Object.assign(new Error('rename denied'), { code: 'EACCES' });
          },
        },
      }),
    ).toThrow(DatabaseBackupError);
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    expect(backups.filter((name) => name.endsWith('.db'))).toHaveLength(0);
    expect(backups.filter((name) => name.includes('.partial'))).toHaveLength(0);
    db.close();
  });

  it('segundo boot bloqueia pelo marker e preserva o primeiro snapshot', () => {
    const { db, dbPath, dir } = tempDatabase(LATEST_SCHEMA_VERSION - 1);
    const first = prepare(db, dbPath);
    expect(first.backupPath).not.toBeNull();
    expect(() => prepare(db, dbPath, { randomId: () => 'second-id' })).toThrow(DatabaseRecoveryRequiredError);
    const backups = fs.readdirSync(path.join(dir, 'backups')).filter((name) => name.endsWith('.db'));
    expect(backups).toEqual([path.basename(first.backupPath!)]);

    clearMigrationInProgressMarker(dbPath, first.backupPath!, {
      openReadonlyDatabase: (candidate) => new Database(candidate, { readonly: true, fileMustExist: true }),
    });
    expect(fs.existsSync(first.markerPath!)).toBe(false);
    db.close();
  });

  it('cleanup recusa marker corrompido/de outro lote e nao o apaga', () => {
    const { db, dbPath } = tempDatabase(LATEST_SCHEMA_VERSION - 1);
    const first = prepare(db, dbPath);
    const markerPath = first.markerPath!;
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(markerPath, JSON.stringify({ ...marker, backupPath: '/outro/lote.db' }));

    expect(() =>
      clearMigrationInProgressMarker(dbPath, first.backupPath!, {
        openReadonlyDatabase: (candidate) => new Database(candidate, { readonly: true, fileMustExist: true }),
      }),
    ).toThrow(DatabaseRecoveryRequiredError);
    expect(fs.existsSync(markerPath)).toBe(true);
    db.close();
  });

  it('falha ao publicar marker nao libera upgrade e limpa somente marker parcial', () => {
    const { db, dbPath, dir } = tempDatabase(LATEST_SCHEMA_VERSION - 1);
    let renames = 0;
    expect(() =>
      prepare(db, dbPath, {
        deps: {
          renameSync: (source, destination) => {
            renames += 1;
            if (renames === 2) throw Object.assign(new Error('marker rename denied'), { code: 'EACCES' });
            fs.renameSync(source, destination);
          },
        },
      }),
    ).toThrow(DatabaseBackupError);
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    expect(backups.filter((name) => name.endsWith('.db'))).toHaveLength(1);
    expect(backups.some((name) => name.includes('.partial'))).toBe(false);
    expect(backups).not.toContain('migration-in-progress.json');
    db.close();
  });

  it('colisao de nome nao sobrescreve backup existente', () => {
    const { db, dbPath } = tempDatabase(LATEST_SCHEMA_VERSION - 1);
    const first = prepare(db, dbPath);
    clearMigrationInProgressMarker(dbPath, first.backupPath!, {
      openReadonlyDatabase: (candidate) => new Database(candidate, { readonly: true, fileMustExist: true }),
    });
    expect(() => prepare(db, dbPath)).toThrow(DatabaseBackupError);
    expect(fs.existsSync(first.backupPath!)).toBe(true);
    db.close();
  });
});

describe('contrato da migration latest', () => {
  it('constante acompanha maior arquivo e o wiring real em db.ts', () => {
    const migrationsDir = path.join(__dirname, '..', 'db-migrations');
    const latestFile = Math.max(
      ...fs.readdirSync(migrationsDir).map((name) => Number(name.match(/^v(\d+)-/)?.[1] ?? -1)),
    );
    expect(LATEST_SCHEMA_VERSION).toBe(latestFile);

    const source = fs.readFileSync(path.join(__dirname, '..', 'db.ts'), 'utf8');
    expect(source).toContain(`import { applyMigrationV${LATEST_SCHEMA_VERSION} }`);
    expect(source).toContain(`applyMigrationV${LATEST_SCHEMA_VERSION}(db);`);
    expect(source).toContain(`VALUES (?)').run(${LATEST_SCHEMA_VERSION})`);
  });
});
