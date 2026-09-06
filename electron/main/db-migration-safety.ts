import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  DatabaseBackupError,
  DatabaseIntegrityError,
  DatabaseRecoveryRequiredError,
  DatabaseVersionError,
} from './db-init-error';

export const LATEST_SCHEMA_VERSION = 151;
const RECOVERY_MARKER_NAME = 'migration-in-progress.json';

export interface MigrationSafetyResult {
  currentVersion: number;
  backupPath: string | null;
  markerPath: string | null;
}

interface RecoveryMarker {
  dbPath: string;
  backupPath: string;
  fromVersion: number;
  targetVersion: number;
  startedAt: string;
}

export interface MigrationSafetyDependencies {
  mkdirSync: typeof fs.mkdirSync;
  existsSync: typeof fs.existsSync;
  readFileSync: typeof fs.readFileSync;
  renameSync: typeof fs.renameSync;
  unlinkSync: typeof fs.unlinkSync;
  writeDurableFile: (filePath: string, content: string) => void;
  fsyncFile: (filePath: string) => void;
  fsyncDirectory: (directoryPath: string) => void;
  vacuumInto: (database: Database.Database, destinationPath: string) => void;
  openReadonlyDatabase: (databasePath: string) => Database.Database;
  loadSqliteVec?: (database: Database.Database) => void;
}

export interface MigrationSafetyOptions {
  database: Database.Database;
  dbPath: string;
  existingDatabase: boolean;
  latestSchemaVersion?: number;
  requiresSchemaRepair: boolean;
  integrityAlreadyChecked?: boolean;
  openReadonlyDatabase: (databasePath: string) => Database.Database;
  loadSqliteVec?: (database: Database.Database) => void;
  deps?: Partial<Omit<MigrationSafetyDependencies, 'openReadonlyDatabase' | 'loadSqliteVec'>>;
  now?: () => Date;
  randomId?: () => string;
}

function writeDurableFile(filePath: string, content: string): void {
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(directoryPath: string): void {
  if (process.platform === 'win32') return;
  let fd: number | null = null;
  try {
    fd = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function fsyncFile(filePath: string): void {
  const fd = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function resolveDependencies(options: MigrationSafetyOptions): MigrationSafetyDependencies {
  return {
    mkdirSync: fs.mkdirSync,
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
    writeDurableFile,
    fsyncFile,
    fsyncDirectory,
    vacuumInto: (database, destinationPath) => {
      database.prepare('VACUUM INTO ?').run(destinationPath);
    },
    openReadonlyDatabase: options.openReadonlyDatabase,
    loadSqliteVec: options.loadSqliteVec,
    ...options.deps,
  };
}

function firstPragmaValue(rows: unknown): unknown {
  if (!Array.isArray(rows) || rows.length !== 1) return undefined;
  const row = rows[0];
  if (!row || typeof row !== 'object') return undefined;
  const values = Object.values(row as Record<string, unknown>);
  return values.length === 1 ? values[0] : undefined;
}

export function assertDatabaseIntegrity(database: Database.Database, dbPath: string): void {
  try {
    const result = database.pragma('integrity_check(1)');
    if (String(firstPragmaValue(result) ?? '').trim().toLowerCase() !== 'ok') {
      throw new Error(`integrity_check retornou: ${JSON.stringify(result)}`);
    }
  } catch (cause) {
    if (cause instanceof DatabaseIntegrityError) throw cause;
    throw new DatabaseIntegrityError(dbPath, cause);
  }
}

export function readCurrentSchemaVersion(
  database: Database.Database,
  dbPath: string,
  latestSchemaVersion = LATEST_SCHEMA_VERSION,
): number {
  try {
    const table = database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get() as { present: number } | undefined;
    if (!table) return 0;
    const row = database.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
      | { version: unknown }
      | undefined;
    const value = row?.version ?? 0;
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new Error(`schema_version invalida: ${String(value)}`);
    }
    return Number(value);
  } catch (cause) {
    if (cause instanceof DatabaseVersionError) throw cause;
    throw new DatabaseVersionError(dbPath, -1, latestSchemaVersion, cause);
  }
}

function backupDirectoryFor(dbPath: string): string {
  return path.join(path.dirname(dbPath), 'backups');
}

function markerPathFor(dbPath: string): string {
  return path.join(backupDirectoryFor(dbPath), RECOVERY_MARKER_NAME);
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

function safeRandomId(raw: string): string {
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  if (!safe) throw new Error('randomId nao produziu identificador filesystem-safe');
  return safe;
}

function readRecoveryMarker(
  dbPath: string,
  deps: MigrationSafetyDependencies,
): RecoveryMarker | null {
  const markerPath = markerPathFor(dbPath);
  if (!deps.existsSync(markerPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(deps.readFileSync(markerPath, 'utf8'));
  } catch (cause) {
    throw new DatabaseRecoveryRequiredError(dbPath, null, cause);
  }
  const marker = parsed as Partial<RecoveryMarker>;
  const backupPath = typeof marker.backupPath === 'string' ? marker.backupPath : null;
  if (
    marker.dbPath !== dbPath ||
    !backupPath ||
    !Number.isSafeInteger(marker.fromVersion) ||
    !Number.isSafeInteger(marker.targetVersion) ||
    typeof marker.startedAt !== 'string'
  ) {
    throw new DatabaseRecoveryRequiredError(
      dbPath,
      backupPath,
      new Error(`marker de recovery invalido: ${markerPath}`),
    );
  }
  return marker as RecoveryMarker;
}

function smokeReadVecTables(database: Database.Database): void {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%USING vec0%'")
    .all() as Array<{ name: string }>;
  for (const table of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table.name)) {
      throw new Error(`nome de virtual table inseguro no backup: ${table.name}`);
    }
    database.prepare(`SELECT * FROM "${table.name}" LIMIT 1`).get();
  }
}

function validateBackup(
  partialPath: string,
  deps: MigrationSafetyDependencies,
): void {
  let verifier: Database.Database | null = null;
  try {
    verifier = deps.openReadonlyDatabase(partialPath);
    assertDatabaseIntegrity(verifier, partialPath);
    deps.loadSqliteVec?.(verifier);
    smokeReadVecTables(verifier);
  } finally {
    verifier?.close();
  }
}

function cleanupAttemptPartial(partialPath: string, deps: MigrationSafetyDependencies): void {
  try {
    if (deps.existsSync(partialPath)) deps.unlinkSync(partialPath);
  } catch {
  }
}

function createBackupAndMarker(
  options: MigrationSafetyOptions,
  deps: MigrationSafetyDependencies,
  currentVersion: number,
  latestVersion: number,
): { backupPath: string; markerPath: string } {
  const backupDir = backupDirectoryFor(options.dbPath);
  let finalPath: string | null = null;
  let partialPath: string | null = null;
  let markerPartial: string | null = null;
  try {
    deps.mkdirSync(backupDir, { recursive: true });
    const stamp = safeTimestamp((options.now ?? (() => new Date()))());
    const id = safeRandomId((options.randomId ?? crypto.randomUUID)());
    const basename = `lionclaw-v${currentVersion}-to-v${latestVersion}-${stamp}-${id}.db`;
    finalPath = path.join(backupDir, basename);
    partialPath = `${finalPath}.partial`;
    if (deps.existsSync(finalPath) || deps.existsSync(partialPath)) {
      throw new Error(`colisao de nome de backup: ${finalPath}`);
    }

    deps.vacuumInto(options.database, partialPath);
    validateBackup(partialPath, deps);
    deps.fsyncFile(partialPath);
    deps.renameSync(partialPath, finalPath);
    deps.fsyncDirectory(backupDir);

    const markerPath = markerPathFor(options.dbPath);
    if (deps.existsSync(markerPath)) {
      throw new Error(`marker de recovery ja existe: ${markerPath}`);
    }
    markerPartial = `${markerPath}.${id}.partial`;
    const marker: RecoveryMarker = {
      dbPath: options.dbPath,
      backupPath: finalPath,
      fromVersion: currentVersion,
      targetVersion: latestVersion,
      startedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
    deps.writeDurableFile(markerPartial, `${JSON.stringify(marker, null, 2)}\n`);
    deps.renameSync(markerPartial, markerPath);
    deps.fsyncDirectory(backupDir);
    return { backupPath: finalPath, markerPath };
  } catch (cause) {
    if (partialPath) cleanupAttemptPartial(partialPath, deps);
    if (markerPartial) cleanupAttemptPartial(markerPartial, deps);
    throw new DatabaseBackupError(options.dbPath, finalPath, cause);
  }
}

export function prepareDatabaseForMigrations(
  options: MigrationSafetyOptions,
): MigrationSafetyResult {
  const deps = resolveDependencies(options);
  if (!options.integrityAlreadyChecked) {
    assertDatabaseIntegrity(options.database, options.dbPath);
  }

  const existingMarker = readRecoveryMarker(options.dbPath, deps);
  if (existingMarker) {
    throw new DatabaseRecoveryRequiredError(
      options.dbPath,
      existingMarker.backupPath,
      new Error('upgrade anterior nao concluido'),
    );
  }

  const latestVersion = options.latestSchemaVersion ?? LATEST_SCHEMA_VERSION;
  const currentVersion = readCurrentSchemaVersion(
    options.database,
    options.dbPath,
    latestVersion,
  );
  if (currentVersion > latestVersion) {
    throw new DatabaseVersionError(options.dbPath, currentVersion, latestVersion);
  }

  const needsUpgrade = currentVersion < latestVersion || options.requiresSchemaRepair;
  if (!options.existingDatabase || !needsUpgrade) {
    return { currentVersion, backupPath: null, markerPath: null };
  }

  const created = createBackupAndMarker(options, deps, currentVersion, latestVersion);
  return { currentVersion, ...created };
}

export function clearMigrationInProgressMarker(
  dbPath: string,
  backupPath: string,
  options: Pick<MigrationSafetyOptions, 'openReadonlyDatabase' | 'deps'>,
): void {
  const deps = resolveDependencies({
    database: {} as Database.Database,
    dbPath,
    existingDatabase: true,
    requiresSchemaRepair: false,
    openReadonlyDatabase: options.openReadonlyDatabase,
    deps: options.deps,
  });
  const markerPath = markerPathFor(dbPath);
  try {
    const marker = readRecoveryMarker(dbPath, deps);
    if (!marker) {
      throw new Error(`marker de recovery ausente: ${markerPath}`);
    }
    if (marker.backupPath !== backupPath) {
      throw new Error(
        `marker pertence a outro snapshot: esperado ${backupPath}, encontrado ${marker.backupPath}`,
      );
    }
    deps.unlinkSync(markerPath);
    deps.fsyncDirectory(path.dirname(markerPath));
  } catch (cause) {
    throw new DatabaseRecoveryRequiredError(dbPath, backupPath, cause);
  }
}
