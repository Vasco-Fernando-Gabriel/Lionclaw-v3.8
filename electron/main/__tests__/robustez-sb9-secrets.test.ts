import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { tmpHome, keytarMock, mcpManagerMock } = vi.hoisted(() => {
  const tmpBase = process.env['TMPDIR'] || '/tmp';
  const tmpHome = `${tmpBase.replace(/\/$/, '')}/lionclaw-sb9-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const keytarMock = {
    getPassword: vi.fn<(service: string, key: string) => Promise<string | null>>(),
    setPassword: vi.fn<(service: string, key: string, value: string) => Promise<void>>(),
    deletePassword: vi.fn<(service: string, key: string) => Promise<boolean>>(),
  };
  const mcpManagerMock = {
    updateMCPServer: vi.fn(),
    startServer: vi.fn(async (_id: string) => undefined),
  };
  return { tmpHome, keytarMock, mcpManagerMock };
});

vi.mock('keytar', () => ({ default: keytarMock }));

vi.mock('../paths', () => ({
  getLionClawHome: () => tmpHome,
}));

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
}));

vi.mock('../mcp-manager', () => mcpManagerMock);

vi.mock('../higgsfield-auth', () => ({
  HIGGSFIELD_SESSION_SECRET_KEY: 'HIGGSFIELD_MCP_SESSION',
}));

vi.mock('../blotato-auth', () => ({
  BLOTATO_API_KEY_SECRET: 'BLOTATO_API_KEY',
}));

import {
  getSecret,
  setSecret,
  getSecretsHealth,
  KEYTAR_MAX_SECRET_BYTES,
  getSecretReadError,
  resetSecretsHealthForTests,
} from '../secrets-vault';
import { getVaultEntries, invalidateVaultStatusCache } from '../vault-registry';
import { revokeGoogleAuth } from '../google-auth';
import { startGoogleMcps, GOOGLE_MCP_IDS } from '../google-mcp-startup';

const SECRETS_DIR = path.join(tmpHome, 'data');
const SECRETS_FILE = path.join(SECRETS_DIR, '.secrets');

function keytarUnavailable(): void {
  keytarMock.getPassword.mockRejectedValue(new Error('keychain locked'));
  keytarMock.setPassword.mockRejectedValue(new Error('keychain locked'));
  keytarMock.deletePassword.mockRejectedValue(new Error('keychain locked'));
}

function cleanSecretsDir(): void {
  fs.rmSync(SECRETS_DIR, { recursive: true, force: true });
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  keytarMock.getPassword.mockReset();
  keytarMock.setPassword.mockReset();
  keytarMock.deletePassword.mockReset();
  mcpManagerMock.updateMCPServer.mockReset();
  mcpManagerMock.startServer.mockReset();
  mcpManagerMock.startServer.mockResolvedValue(undefined);
  cleanSecretsDir();
  resetSecretsHealthForTests();
  invalidateVaultStatusCache();
});

describe('SB-9 — store corrompido preservado (AC-B22)', () => {
  it('AC-B22: store corrompido gera .bak-<ts> (renomeado, nao apagado) e nao e sobrescrito silenciosamente', async () => {
    keytarUnavailable();
    const garbage = '{{{nao-e-json';
    fs.writeFileSync(SECRETS_FILE, garbage, 'utf8');

    await getSecret('QUALQUER_CHAVE');

    expect(fs.existsSync(SECRETS_FILE)).toBe(false);
    const bakFiles = fs.readdirSync(SECRETS_DIR).filter((f) => f.startsWith('.secrets.bak-'));
    expect(bakFiles).toHaveLength(1);
    expect(fs.readFileSync(path.join(SECRETS_DIR, bakFiles[0]), 'utf8')).toBe(garbage);

    const health = getSecretsHealth();
    expect(health.vaultCorruptBackupPath).toBe(path.join(SECRETS_DIR, bakFiles[0]));

    await setSecret('NOVA', 'valor');
    expect(fs.existsSync(SECRETS_FILE)).toBe(true);
    expect(fs.readFileSync(path.join(SECRETS_DIR, bakFiles[0]), 'utf8')).toBe(garbage);
    await expect(getSecret('NOVA')).resolves.toBe('valor');
  });

  it('AC-B22 (SECRET-UNREADABLE): entrada que nao decripta vira estado de erro por chave, nao "nunca configurado"', async () => {
    keytarUnavailable();
    await setSecret('ANTHROPIC_API_KEY', 'sk-ant-teste');
    const store = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) as Record<
      string,
      { iv: string; authTag: string; ciphertext: string }
    >;
    store['ANTHROPIC_API_KEY'].ciphertext = 'deadbeef';
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(store), 'utf8');

    const value = await getSecret('ANTHROPIC_API_KEY');
    expect(value).toBeNull();
    expect(getSecretReadError('ANTHROPIC_API_KEY')).toBeTruthy();
    const health = getSecretsHealth();
    expect(health.unreadableKeys.map((k) => k.key)).toContain('ANTHROPIC_API_KEY');

    const entries = await getVaultEntries();
    const anthropic = entries.find((e) => e.key === 'ANTHROPIC_API_KEY');
    expect(anthropic?.status).toBe('error');
    expect(anthropic?.error).toBeTruthy();
    expect(anthropic?.configured).toBe(false);

    await setSecret('ANTHROPIC_API_KEY', 'sk-ant-novo');
    expect(getSecretReadError('ANTHROPIC_API_KEY')).toBeUndefined();
  });

  it('segredo maior que o limite do keychain vai so para o arquivo, sem abrir o circuit breaker', async () => {
    keytarMock.setPassword.mockRejectedValue(new Error('O fragmento de codigo recebeu dados incorretos.'));
    const big = JSON.stringify({
      files: [{ path: 'x_tokens.json', contentBase64: 'A'.repeat(KEYTAR_MAX_SECRET_BYTES) }],
    });
    await setSecret('HIGGSFIELD_MCP_SESSION', big);
    expect(keytarMock.setPassword).not.toHaveBeenCalled();
    expect(getSecretsHealth().keytarDegraded).toBe(false);
    await expect(getSecret('HIGGSFIELD_MCP_SESSION')).resolves.toBe(big);

    keytarMock.setPassword.mockResolvedValue(undefined);
    await setSecret('PEQUENO', 'valor');
    expect(keytarMock.setPassword).toHaveBeenCalledTimes(1);
  });

  it('AC-B22 (KEYTAR-DEGRADED): falha do Keychain abre o circuit breaker e evita novos prompts no processo', async () => {
    keytarUnavailable();
    await getSecret('X');
    expect(getSecretsHealth().keytarDegraded).toBe(true);
    expect(keytarMock.getPassword).toHaveBeenCalledTimes(1);

    keytarMock.getPassword.mockResolvedValue('valor');
    await expect(getSecret('Y')).resolves.toBeNull();
    expect(keytarMock.getPassword).toHaveBeenCalledTimes(1);
    expect(getSecretsHealth().keytarDegraded).toBe(true);
  });
});

describe('SB-9 — revoke Google honesto (AC-B21)', () => {
  async function seedGoogleTokens(): Promise<void> {
    keytarUnavailable();
    await setSecret('GOOGLE_ACCESS_TOKEN', 'ya29.token');
    await setSecret('GOOGLE_REFRESH_TOKEN', '1//refresh');
  }

  it('AC-B21: revoke remoto que LANCA reporta REVOKE-UNCONFIRMED (nao "revogado com sucesso")', async () => {
    await seedGoogleTokens();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('rede caiu');
      }),
    );

    const result = await revokeGoogleAuth();
    expect(result.localCleared).toBe(true);
    expect(result.remoteRevoked).toBe(false);
    expect(result.warning).toBe('REVOKE-UNCONFIRMED');
    await expect(getSecret('GOOGLE_ACCESS_TOKEN')).resolves.toBeNull();
    await expect(getSecret('GOOGLE_REFRESH_TOKEN')).resolves.toBeNull();
  });

  it('AC-B21: revoke remoto com HTTP nao-ok (400) tambem reporta REVOKE-UNCONFIRMED', async () => {
    await seedGoogleTokens();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('invalid_token', { status: 400 })),
    );

    const result = await revokeGoogleAuth();
    expect(result.remoteRevoked).toBe(false);
    expect(result.warning).toBe('REVOKE-UNCONFIRMED');
  });

  it('AC-B21: revoke remoto confirmado (200) NAO carrega warning', async () => {
    await seedGoogleTokens();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 })),
    );

    const result = await revokeGoogleAuth();
    expect(result.localCleared).toBe(true);
    expect(result.remoteRevoked).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it('AC-B21: sem tokens locais, revoke conclui sem warning (nada a revogar)', async () => {
    keytarUnavailable();
    vi.stubGlobal('fetch', vi.fn());

    const result = await revokeGoogleAuth();
    expect(result.localCleared).toBe(true);
    expect(result.warning).toBeUndefined();
  });
});

describe('SB-9 — MCPs Google pos-OAuth (AC-B22b)', () => {
  it('AC-B22b: MCP que falha ao subir volta em mcpStartFailures (os demais ainda sobem)', async () => {
    mcpManagerMock.startServer.mockImplementation(async (id: string) => {
      if (id === 'google-drive') throw new Error('spawn ENOENT');
      return undefined;
    });

    const failures = await startGoogleMcps();
    expect(failures).toEqual([{ id: 'google-drive', error: 'spawn ENOENT' }]);
    expect(mcpManagerMock.startServer).toHaveBeenCalledTimes(GOOGLE_MCP_IDS.length);
    expect(mcpManagerMock.updateMCPServer).toHaveBeenCalledTimes(GOOGLE_MCP_IDS.length);
  });

  it('AC-B22b: tudo subindo -> mcpStartFailures vazio', async () => {
    const failures = await startGoogleMcps();
    expect(failures).toEqual([]);
  });
});
