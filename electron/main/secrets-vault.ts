import keytar from 'keytar';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';

const logger = createLogger('secrets');
const SERVICE_NAME = 'LionClaw';
const KEYTAR_TIMEOUT_MS = 3000;
const SECRETS_FILE_DIR = path.join(getLionClawHome(), 'data');
const SECRETS_FILE_PATH = path.join(SECRETS_FILE_DIR, '.secrets');


let cachedEncryptionKey: Buffer | null = null;

function deriveEncryptionKey(): Buffer {
  if (cachedEncryptionKey) return cachedEncryptionKey;
  const machineId = `${os.hostname()}::${os.userInfo().username}`;
  const salt = Buffer.from('lionclaw-secrets-v1-salt-2024', 'utf8');
  cachedEncryptionKey = crypto.scryptSync(machineId, salt, 32);
  return cachedEncryptionKey;
}

interface EncryptedStore {
  [key: string]: {
    iv: string;
    authTag: string;
    ciphertext: string;
  };
}

type SecretStoreReadResult =
  | { status: 'ok'; store: EncryptedStore }
  | { status: 'error'; reason: string; backupPath: string | null };

export type SecretNonInteractiveResult =
  | { status: 'found'; value: string }
  | { status: 'absent' }
  | { status: 'error'; code: 'VAULT-CORRUPT'; reason: string; backupPath: string | null }
  | { status: 'error'; code: 'SECRET-UNREADABLE'; reason: string };


export interface SecretsHealth {
  keytarDegraded: boolean;
  vaultCorruptBackupPath: string | null;
  unreadableKeys: Array<{ key: string; reason: string }>;
}

let keytarDegraded = false;
let legacyKeytarReadAttempted = false;
let vaultCorruptBackupPath: string | null = null;
const unreadableSecrets = new Map<string, string>();

export function getSecretsHealth(): SecretsHealth {
  return {
    keytarDegraded,
    vaultCorruptBackupPath,
    unreadableKeys: Array.from(unreadableSecrets.entries()).map(([key, reason]) => ({ key, reason })),
  };
}

export function getSecretReadError(key: string): string | undefined {
  return unreadableSecrets.get(key);
}

export function resetSecretsHealthForTests(): void {
  keytarDegraded = false;
  legacyKeytarReadAttempted = false;
  vaultCorruptBackupPath = null;
  unreadableSecrets.clear();
}

function readSecretStoreResult(): SecretStoreReadResult {
  try {
    if (!fs.existsSync(SECRETS_FILE_PATH)) return { status: 'ok', store: {} };
    const raw = fs.readFileSync(SECRETS_FILE_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('secrets-file: formato raiz invalido');
    }
    return { status: 'ok', store: parsed as EncryptedStore };
  } catch (error) {
    let backupPath: string | null = null;
    try {
      if (fs.existsSync(SECRETS_FILE_PATH)) {
        const candidateBackupPath = `${SECRETS_FILE_PATH}.bak-${Date.now()}`;
        fs.renameSync(SECRETS_FILE_PATH, candidateBackupPath);
        backupPath = candidateBackupPath;
        vaultCorruptBackupPath = backupPath;
        logger.error(
          { error, backupPath, code: 'VAULT-CORRUPT' },
          'secrets-file: store corrompido; backup preservado antes de recomecar',
        );
      } else {
        logger.warn({ error }, 'secrets-file: failed to read store, starting fresh');
      }
    } catch (backupError) {
      logger.error(
        { error, backupError, code: 'VAULT-CORRUPT' },
        'secrets-file: falha ao preservar backup do store corrompido',
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 'error', reason, backupPath };
  }
}

function readSecretStore(): EncryptedStore {
  const result = readSecretStoreResult();
  return result.status === 'ok' ? result.store : {};
}

function writeSecretStore(store: EncryptedStore): void {
  fs.mkdirSync(SECRETS_FILE_DIR, { recursive: true });
  fs.writeFileSync(SECRETS_FILE_PATH, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 });
}

function encryptValue(plaintext: string): { iv: string; authTag: string; ciphertext: string } {
  const key = deriveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
  };
}

function decryptValue(entry: { iv: string; authTag: string; ciphertext: string }): string {
  const key = deriveEncryptionKey();
  const iv = Buffer.from(entry.iv, 'hex');
  const authTag = Buffer.from(entry.authTag, 'hex');
  const ciphertext = Buffer.from(entry.ciphertext, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}


function fileSetSecret(key: string, value: string): void {
  const store = readSecretStore();
  store[key] = encryptValue(value);
  writeSecretStore(store);
  unreadableSecrets.delete(key);
  logger.info({ key }, 'secrets-file: secret stored');
}

function fileDeleteSecret(key: string): void {
  const store = readSecretStore();
  if (key in store) {
    delete store[key];
    writeSecretStore(store);
    logger.info({ key }, 'secrets-file: secret deleted');
  }
  unreadableSecrets.delete(key);
}


function keytarTimeout(): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error('keytar timed out')), KEYTAR_TIMEOUT_MS),
  );
}

async function keytarGet(key: string): Promise<string | null> {
  return Promise.race([keytar.getPassword(SERVICE_NAME, key), keytarTimeout()]);
}

async function keytarSet(key: string, value: string): Promise<void> {
  return Promise.race([keytar.setPassword(SERVICE_NAME, key, value), keytarTimeout()]);
}

async function keytarDelete(key: string): Promise<void> {
  await Promise.race([keytar.deletePassword(SERVICE_NAME, key), keytarTimeout()]);
}


export async function getSecretNonInteractive(key: string): Promise<SecretNonInteractiveResult> {
  const storeResult = readSecretStoreResult();
  if (storeResult.status === 'error') {
    return {
      status: 'error',
      code: 'VAULT-CORRUPT',
      reason: storeResult.reason,
      backupPath: storeResult.backupPath,
    };
  }

  const entry = storeResult.store[key];
  if (!entry) return { status: 'absent' };

  try {
    const value = decryptValue(entry);
    unreadableSecrets.delete(key);
    return { status: 'found', value };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    unreadableSecrets.set(key, reason);
    logger.error({ key, error, code: 'SECRET-UNREADABLE' }, 'secrets-file: failed to get secret');
    return { status: 'error', code: 'SECRET-UNREADABLE', reason };
  }
}

export async function getSecretNonInteractiveOrThrow(key: string): Promise<string | null> {
  const result = await getSecretNonInteractive(key);
  if (result.status === 'found') return result.value;
  if (result.status === 'absent') return null;
  throw new Error(`${result.code}: ${result.reason}`);
}

export async function getSecret(key: string): Promise<string | null> {
  const fallback = await getSecretNonInteractive(key);
  if (fallback.status === 'found') return fallback.value;
  if (fallback.status === 'error') return null;

  if (keytarDegraded || legacyKeytarReadAttempted) return null;
  legacyKeytarReadAttempted = true;

  try {
    const value = await keytarGet(key);
    keytarDegraded = false;
    if (value !== null) {
      try {
        fileSetSecret(key, value);
      } catch (fileError) {
        logger.warn(
          { key, fileError },
          'secrets-file: failed to mirror legacy Keychain secret',
        );
      }
    }
    return value;
  } catch (error) {
    keytarDegraded = true;
    logger.warn(
      { key, error, code: 'KEYTAR-DEGRADED' },
      'keytar unavailable for get, falling back to encrypted file',
    );
  }

  return null;
}

export async function setSecret(key: string, value: string): Promise<void> {
  let keytarOk = false;

  try {
    await keytarSet(key, value);
    keytarOk = true;
    keytarDegraded = false;
    logger.info({ key }, 'keytar: secret stored');
  } catch (error) {
    keytarDegraded = true;
    logger.warn(
      { key, error, code: 'KEYTAR-DEGRADED' },
      'keytar unavailable for set, falling back to encrypted file',
    );
  }

  try {
    fileSetSecret(key, value);
  } catch (fileError) {
    if (!keytarOk) {
      logger.error({ key, fileError }, 'secrets-file: also failed to store secret');
      throw new Error(`Falha ao salvar secret: ${key}`);
    }
    logger.warn({ key, fileError }, 'secrets-file: write failed but keytar succeeded');
  }
}

export async function deleteSecret(key: string): Promise<void> {
  try {
    await keytarDelete(key);
    keytarDegraded = false;
    logger.info({ key }, 'keytar: secret deleted');
  } catch (error) {
    keytarDegraded = true;
    logger.warn(
      { key, error, code: 'KEYTAR-DEGRADED' },
      'keytar unavailable for delete, proceeding with file cleanup',
    );
  }

  try {
    fileDeleteSecret(key);
  } catch (fileError) {
    logger.error({ key, fileError }, 'secrets-file: failed to delete secret');
  }
}

export async function getApiKey(): Promise<string | null> {
  return getSecret('ANTHROPIC_API_KEY');
}

export async function setApiKey(key: string): Promise<void> {
  return setSecret('ANTHROPIC_API_KEY', key);
}
