import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { tmpHome, keytarMock } = vi.hoisted(() => {
  const tmpBase = process.env['TMPDIR'] || '/tmp';
  return {
    tmpHome: `${tmpBase.replace(/\/$/, '')}/lionclaw-qa008-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    keytarMock: {
      getPassword: vi.fn(),
      setPassword: vi.fn(),
      deletePassword: vi.fn(),
    },
  };
});

vi.mock('keytar', () => ({ default: keytarMock }));
vi.mock('../paths', () => ({ getLionClawHome: () => tmpHome }));
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { getSecret, getSecretNonInteractive, resetSecretsHealthForTests } from '../secrets-vault';

const secretsDir = path.join(tmpHome, 'data');
const secretsFile = path.join(secretsDir, '.secrets');

function encryptedEntry(plaintext: string): { iv: string; authTag: string; ciphertext: string } {
  const machineId = `${os.hostname()}::${os.userInfo().username}`;
  const salt = Buffer.from('lionclaw-secrets-v1-salt-2024', 'utf8');
  const key = crypto.scryptSync(machineId, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

function expectNoKeytarCalls(): void {
  expect(keytarMock.getPassword).not.toHaveBeenCalled();
  expect(keytarMock.setPassword).not.toHaveBeenCalled();
  expect(keytarMock.deletePassword).not.toHaveBeenCalled();
}

beforeEach(() => {
  fs.rmSync(secretsDir, { recursive: true, force: true });
  fs.mkdirSync(secretsDir, { recursive: true });
  keytarMock.getPassword.mockReset();
  keytarMock.setPassword.mockReset();
  keytarMock.deletePassword.mockReset();
  resetSecretsHealthForTests();
});

describe('QA008 — getSecretNonInteractive', () => {
  it('retorna secret valido do arquivo sem consultar keytar', async () => {
    fs.writeFileSync(secretsFile, JSON.stringify({ TELEGRAM_BOT_TOKEN: encryptedEntry('token-file-only') }), 'utf8');

    await expect(getSecretNonInteractive('TELEGRAM_BOT_TOKEN')).resolves.toEqual({
      status: 'found',
      value: 'token-file-only',
    });
    expectNoKeytarCalls();
  });

  it('retorna ausencia estruturada sem consultar keytar', async () => {
    fs.writeFileSync(secretsFile, JSON.stringify({}), 'utf8');

    await expect(getSecretNonInteractive('NAO_CONFIGURADO')).resolves.toEqual({ status: 'absent' });
    expectNoKeytarCalls();
  });

  it('retorna SECRET-UNREADABLE para entrada cifrada corrompida sem consultar keytar', async () => {
    const entry = encryptedEntry('valor');
    entry.ciphertext = 'deadbeef';
    fs.writeFileSync(secretsFile, JSON.stringify({ CORROMPIDO: entry }), 'utf8');

    const result = await getSecretNonInteractive('CORROMPIDO');
    expect(result).toMatchObject({ status: 'error', code: 'SECRET-UNREADABLE' });
    expectNoKeytarCalls();
  });

  it('retorna VAULT-CORRUPT e preserva backup para store invalido sem consultar keytar', async () => {
    const garbage = '{{nao-e-json';
    fs.writeFileSync(secretsFile, garbage, 'utf8');

    const result = await getSecretNonInteractive('QUALQUER');
    expect(result).toMatchObject({ status: 'error', code: 'VAULT-CORRUPT' });
    if (result.status !== 'error' || result.code !== 'VAULT-CORRUPT') {
      throw new Error('resultado inesperado');
    }
    expect(result.backupPath).not.toBeNull();
    expect(fs.readFileSync(result.backupPath as string, 'utf8')).toBe(garbage);
    expectNoKeytarCalls();
  });
});

describe('QA008 — getSecret silencioso no boot', () => {
  it('prefere o arquivo cifrado e nao consulta o Keychain', async () => {
    fs.writeFileSync(secretsFile, JSON.stringify({ TELEGRAM_BOT_TOKEN: encryptedEntry('token-file-only') }), 'utf8');

    await expect(getSecret('TELEGRAM_BOT_TOKEN')).resolves.toBe('token-file-only');
    expectNoKeytarCalls();
  });

  it('consulta o Keychain legado uma unica vez e espelha o valor para o arquivo', async () => {
    keytarMock.getPassword.mockResolvedValue('token-legado');

    await expect(getSecret('TELEGRAM_BOT_TOKEN')).resolves.toBe('token-legado');
    await expect(getSecret('OUTRA_CHAVE')).resolves.toBeNull();
    expect(keytarMock.getPassword).toHaveBeenCalledTimes(1);

    resetSecretsHealthForTests();
    keytarMock.getPassword.mockReset();
    await expect(getSecret('TELEGRAM_BOT_TOKEN')).resolves.toBe('token-legado');
    expect(keytarMock.getPassword).not.toHaveBeenCalled();
  });
});
