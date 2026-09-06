
export const DB_MIGRATION_ERROR_CODE = 'DB-MIGRATION';
export const DB_INTEGRITY_ERROR_CODE = 'DB-INTEGRITY';
export const DB_BACKUP_ERROR_CODE = 'DB-BACKUP';
export const DB_VERSION_ERROR_CODE = 'DB-VERSION';
export const DB_RECOVERY_ERROR_CODE = 'DB-RECOVERY';
export const DB_SCHEMA_REPAIR_ERROR_CODE = 'DB-SCHEMA-REPAIR';

export type DatabaseInitErrorCode =
  | typeof DB_MIGRATION_ERROR_CODE
  | typeof DB_INTEGRITY_ERROR_CODE
  | typeof DB_BACKUP_ERROR_CODE
  | typeof DB_VERSION_ERROR_CODE
  | typeof DB_RECOVERY_ERROR_CODE
  | typeof DB_SCHEMA_REPAIR_ERROR_CODE;

function causeMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : String(cause ?? fallback);
}

export abstract class DatabaseInitError extends Error {
  abstract readonly code: DatabaseInitErrorCode;
  readonly dbPath: string;
  readonly backupPath: string | null;

  protected constructor(
    message: string,
    dbPath: string,
    backupPath: string | null,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.dbPath = dbPath;
    this.backupPath = backupPath;
  }
}

export class DatabaseIntegrityError extends DatabaseInitError {
  readonly code = DB_INTEGRITY_ERROR_CODE;

  constructor(dbPath: string, cause: unknown) {
    super(
      `Falha de integridade do banco: ${causeMessage(cause, 'integrity_check nao retornou ok')}`,
      dbPath,
      null,
      cause,
    );
    this.name = 'DatabaseIntegrityError';
  }
}

export class DatabaseBackupError extends DatabaseInitError {
  readonly code = DB_BACKUP_ERROR_CODE;

  constructor(dbPath: string, backupPath: string | null, cause: unknown) {
    super(
      `Falha ao criar/validar backup pre-migration: ${causeMessage(cause, 'erro desconhecido')}`,
      dbPath,
      backupPath,
      cause,
    );
    this.name = 'DatabaseBackupError';
  }
}

export class DatabaseVersionError extends DatabaseInitError {
  readonly code = DB_VERSION_ERROR_CODE;
  readonly currentVersion: number;
  readonly latestVersion: number;

  constructor(dbPath: string, currentVersion: number, latestVersion: number, cause?: unknown) {
    super(
      `Versao do banco incompativel: banco v${currentVersion}, app suporta ate v${latestVersion}`,
      dbPath,
      null,
      cause,
    );
    this.name = 'DatabaseVersionError';
    this.currentVersion = currentVersion;
    this.latestVersion = latestVersion;
  }
}

export class DatabaseRecoveryRequiredError extends DatabaseInitError {
  readonly code = DB_RECOVERY_ERROR_CODE;

  constructor(dbPath: string, backupPath: string | null, cause: unknown) {
    super(
      `Upgrade anterior nao foi concluido; restauracao manual necessaria: ${causeMessage(cause, 'marker de recovery presente')}`,
      dbPath,
      backupPath,
      cause,
    );
    this.name = 'DatabaseRecoveryRequiredError';
  }
}

export class DatabaseSchemaRepairError extends DatabaseInitError {
  readonly code = DB_SCHEMA_REPAIR_ERROR_CODE;

  constructor(dbPath: string, backupPath: string | null, cause: unknown) {
    super(
      `Falha no reparo de schema real: ${causeMessage(cause, 'erro desconhecido')}`,
      dbPath,
      backupPath,
      cause,
    );
    this.name = 'DatabaseSchemaRepairError';
  }
}

export class MigrationError extends DatabaseInitError {
  readonly version: number;
  readonly code = DB_MIGRATION_ERROR_CODE;

  constructor(
    version: number,
    dbPath: string,
    cause: unknown,
    backupPath: string | null = null,
  ) {
    super(
      `Migration v${version} falhou: ${causeMessage(cause, 'erro desconhecido de migration')}`,
      dbPath,
      backupPath,
      cause,
    );
    this.name = 'MigrationError';
    this.version = version;
  }
}

export interface DbMigrationErrorBox {
  title: string;
  message: string;
}

export function buildDbMigrationErrorBox(error: unknown, dbPath: string): DbMigrationErrorBox {
  const typedError = error instanceof DatabaseInitError ? error : null;
  const detail = error instanceof Error ? error.message : String(error ?? 'erro desconhecido');
  const resolvedPath = typedError?.dbPath ?? dbPath;
  const code = typedError?.code ?? DB_MIGRATION_ERROR_CODE;
  const backupLine = typedError?.backupPath ? [`Backup pre-upgrade: ${typedError.backupPath}`, ''] : [];
  return {
    title: `LionClaw — Falha no banco de dados (${code})`,
    message: [
      `${code}: nao foi possivel iniciar/migrar o banco de dados.`,
      '',
      `Banco: ${resolvedPath}`,
      '',
      ...backupLine,
      `Detalhe: ${detail}`,
      '',
      'O app vai fechar. Veja o log do app e, se necessario, restaure o backup do banco.',
    ].join('\n'),
  };
}
