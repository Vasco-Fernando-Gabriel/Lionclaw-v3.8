import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let SANDBOX = '';
const vault = new Map<string, string>();

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: async (key: string) => vault.get(key) ?? null,
  getSecretNonInteractiveOrThrow: async (key: string) => vault.get(key) ?? null,
  setSecret: async (key: string, value: string) => {
    vault.set(key, value);
  },
  deleteSecret: async (key: string) => {
    vault.delete(key);
  },
}));

import {
  HIGGSFIELD_SESSION_SECRET_KEY,
  _resetHiggsfieldSessionStateForTests,
  captureHiggsfieldSessionToVault,
  getHiggsfieldAuthDir,
  reconcileHiggsfieldSession,
  restoreHiggsfieldSessionFromVault,
} from '../higgsfield-auth';

function writeLocalTokens(): string {
  const dir = path.join(getHiggsfieldAuthDir(), 'mcp-remote-0.1.37');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'abc_tokens.json');
  fs.writeFileSync(file, JSON.stringify({ access_token: 'a', refresh_token: 'r' }));
  return file;
}

beforeEach(() => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-higgs-'));
  vi.spyOn(os, 'homedir').mockReturnValue(SANDBOX);
  vault.clear();
  _resetHiggsfieldSessionStateForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

describe('higgsfield-auth :: reconcile da sessao (token invalidado pelo servidor)', () => {
  it('token presente: salva no Vault', async () => {
    writeLocalTokens();
    expect(await reconcileHiggsfieldSession()).toBe('saved');
    expect(vault.has(HIGGSFIELD_SESSION_SECRET_KEY)).toBe(true);
  });

  it('token some depois de ter sido visto: remove o snapshot do Vault', async () => {
    const file = writeLocalTokens();
    expect(await captureHiggsfieldSessionToVault()).toBe(true);
    fs.rmSync(file);
    expect(await reconcileHiggsfieldSession()).toBe('invalidated');
    expect(vault.has(HIGGSFIELD_SESSION_SECRET_KEY)).toBe(false);
    expect(await reconcileHiggsfieldSession()).toBe('noop');
  });

  it('sem token e sem sessao vista neste processo: nao toca no Vault', async () => {
    vault.set(HIGGSFIELD_SESSION_SECRET_KEY, JSON.stringify({ version: 1, capturedAt: 'x', files: [] }));
    expect(await reconcileHiggsfieldSession()).toBe('noop');
    expect(vault.has(HIGGSFIELD_SESSION_SECRET_KEY)).toBe(true);
  });

  it('snapshot restaurado do Vault e invalidado em seguida nao volta no proximo boot', async () => {
    const file = writeLocalTokens();
    await captureHiggsfieldSessionToVault();
    fs.rmSync(getHiggsfieldAuthDir(), { recursive: true, force: true });
    _resetHiggsfieldSessionStateForTests();

    expect(await restoreHiggsfieldSessionFromVault()).toBe(true);
    expect(fs.existsSync(file)).toBe(true);

    fs.rmSync(file);
    expect(await reconcileHiggsfieldSession()).toBe('invalidated');

    _resetHiggsfieldSessionStateForTests();
    expect(await restoreHiggsfieldSessionFromVault()).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });
});
