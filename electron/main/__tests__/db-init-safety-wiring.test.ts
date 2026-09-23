import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));

vi.mock('../paths', () => ({ getLionClawHome: () => state.root }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { getDb, initDatabase } from '../db';
import { DatabaseBackupError, MigrationError } from '../db-init-error';

const roots: string[] = [];

function seedDatabase(version: number): string {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-db-init-wiring-'));
  roots.push(state.root);
  const dataDir = path.join(state.root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'lionclaw.db');
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version(version) VALUES (${version});
    CREATE TABLE user_data(value TEXT);
    INSERT INTO user_data VALUES ('antes');
  `);
  seed.close();
  return dbPath;
}

beforeEach(() => {
  state.root = '';
});

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe('initDatabase: wiring comportamental fail-closed', () => {
  it('preflight falho nao alcanca migrations e fecha/invalida o handle global', () => {
    const dbPath = seedDatabase(134);
    const runMigrations = vi.fn();
    const failure = new DatabaseBackupError(dbPath, null, new Error('ENOSPC'));

    expect(() =>
      initDatabase({
        loadSqliteVec: () => {
          throw new Error('vec indisponivel');
        },
        prepareSafety: () => {
          throw failure;
        },
        runMigrations,
      }),
    ).toThrow(failure);

    expect(runMigrations).not.toHaveBeenCalled();
    expect(() => getDb()).toThrow('Database not initialized');
    const reopened = new Database(dbPath, { readonly: true, fileMustExist: true });
    expect(reopened.pragma('integrity_check(1)')).toEqual([{ integrity_check: 'ok' }]);
    reopened.close();
  });

  it('migration falha preserva primeiro snapshot+marker e fecha a conexao', () => {
    const dbPath = seedDatabase(133);
    let thrown: unknown;
    try {
      initDatabase({
        loadSqliteVec: () => {
          throw new Error('vec indisponivel');
        },
        runMigrations: () => {
          throw new Error('DDL falhou');
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MigrationError);
    const migrationError = thrown as MigrationError;
    expect(migrationError.backupPath).not.toBeNull();
    expect(fs.existsSync(migrationError.backupPath!)).toBe(true);
    const markerPath = path.join(path.dirname(migrationError.backupPath!), 'migration-in-progress.json');
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf8')).backupPath).toBe(migrationError.backupPath);
    expect(() => getDb()).toThrow('Database not initialized');

    const reopened = new Database(dbPath, { readonly: true, fileMustExist: true });
    expect(reopened.prepare('SELECT value FROM user_data').get()).toEqual({ value: 'antes' });
    reopened.close();
  });

  it('sqlite-vec indisponivel continua degradado durante upgrade sem migration vec', () => {
    const dbPath = seedDatabase(133);
    const repairVecSchema = vi.fn();
    expect(() =>
      initDatabase({
        loadSqliteVec: () => {
          throw new Error('vec indisponivel');
        },
        runMigrations: vi.fn(),
        repairVecSchema,
      }),
    ).not.toThrow();

    expect(repairVecSchema).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT value FROM user_data').get()).toEqual({ value: 'antes' });
    const backupDir = path.join(path.dirname(dbPath), 'backups');
    expect(fs.existsSync(path.join(backupDir, 'migration-in-progress.json'))).toBe(false);
    getDb().close();
  });
});
