
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { ipcHandlers, googleAuthMock, startGoogleMcpsMock } = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const googleAuthMock = {
    runOAuthFlow: vi.fn(async () => ({ success: true })),
    getGoogleAuthStatus: vi.fn(async () => ({ hasCredentials: true, isAuthenticated: true })),
    revokeGoogleAuth: vi.fn(async () => ({
      localCleared: true,
      remoteRevoked: false,
      warning: 'REVOKE-UNCONFIRMED' as const,
    })),
  };
  const startGoogleMcpsMock = vi.fn(async () => [{ id: 'google-drive', error: 'spawn ENOENT' }]);
  return { ipcHandlers, googleAuthMock, startGoogleMcpsMock };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    },
  },
}));

vi.mock('node-telegram-bot-api', () => ({ default: class TelegramBot {} }));

vi.mock('../mcp-manager', () => ({
  getAllMCPServers: vi.fn(() => []),
  updateMCPServer: vi.fn(),
  restartServer: vi.fn(),
  stopServer: vi.fn(),
}));

vi.mock('../voice-engine', () => ({
  generateSpeech: vi.fn(),
  transcribeAudio: vi.fn(),
}));

vi.mock('../cartesia-engine', () => ({
  generateCartesiaSpeech: vi.fn(),
  generateLiveSpeech: vi.fn(),
  listCartesiaVoices: vi.fn(),
}));

vi.mock('../image-engine', () => ({
  generateImage: vi.fn(),
  editImage: vi.fn(),
}));

vi.mock('../google-auth', () => googleAuthMock);

vi.mock('../google-mcp-startup', () => ({
  startGoogleMcps: startGoogleMcpsMock,
}));

vi.mock('../vault-registry', () => ({
  getVaultEntries: vi.fn(async () => []),
  setVaultSecret: vi.fn(),
  deleteVaultSecret: vi.fn(),
  checkVaultSecret: vi.fn(),
  invalidateVaultStatusCache: vi.fn(),
  registerVaultEntry: vi.fn(),
}));

vi.mock('../channels-db', () => ({
  getAllChannels: vi.fn(() => []),
  getChannel: vi.fn(),
  upsertChannel: vi.fn(),
  toggleChannel: vi.fn(),
}));

vi.mock('../telegram-bridge', () => ({
  startTelegramBot: vi.fn(),
  stopTelegramBot: vi.fn(),
  isTelegramRunning: vi.fn(() => false),
}));

vi.mock('../codex-sdk/mcp-config-sync', () => ({
  syncCodexMcpConfig: vi.fn(),
}));

vi.mock('../higgsfield-auth', () => ({
  connectHiggsfield: vi.fn(),
  deleteHiggsfieldSession: vi.fn(),
  getHiggsfieldAuthStatus: vi.fn(),
  HIGGSFIELD_SESSION_SECRET_KEY: 'HIGGSFIELD_MCP_SESSION',
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async () => null),
  setSecret: vi.fn(),
  getSecretsHealth: vi.fn(() => ({
    keytarDegraded: false,
    vaultCorruptBackupPath: null,
    unreadableKeys: [],
  })),
}));

import { registerIntegrationsHandlers } from '../ipc/integrations';
import type { IpcContext } from '../ipc/context';

beforeEach(() => {
  ipcHandlers.clear();
  googleAuthMock.runOAuthFlow.mockClear();
  startGoogleMcpsMock.mockClear();
  const ctx = { getMainWindow: () => null } as unknown as IpcContext;
  registerIntegrationsHandlers(ctx);
});

describe('SB-9 — contrato IPC google:* (AC-B22b / AC-B21)', () => {
  it('AC-B22b: google:authenticate com OAuth ok carrega mcpStartFailures no resultado', async () => {
    const handler = ipcHandlers.get('google:authenticate');
    expect(handler).toBeDefined();

    const result = (await handler!({})) as {
      success: boolean;
      mcpStartFailures?: Array<{ id: string; error: string }>;
    };
    expect(result.success).toBe(true);
    expect(result.mcpStartFailures).toEqual([{ id: 'google-drive', error: 'spawn ENOENT' }]);
  });

  it('AC-B22b: OAuth que falha NAO tenta subir MCPs (sem mcpStartFailures)', async () => {
    googleAuthMock.runOAuthFlow.mockResolvedValueOnce({ success: false, error: 'timeout' } as never);
    const handler = ipcHandlers.get('google:authenticate');

    const result = (await handler!({})) as {
      success: boolean;
      mcpStartFailures?: unknown;
    };
    expect(result.success).toBe(false);
    expect(result.mcpStartFailures).toBeUndefined();
    expect(startGoogleMcpsMock).not.toHaveBeenCalled();
  });

  it('AC-B21: google:revoke devolve o resultado honesto (REVOKE-UNCONFIRMED chega ao renderer)', async () => {
    const handler = ipcHandlers.get('google:revoke');
    expect(handler).toBeDefined();

    const result = (await handler!({})) as {
      localCleared: boolean;
      remoteRevoked: boolean;
      warning?: string;
    };
    expect(result.localCleared).toBe(true);
    expect(result.remoteRevoked).toBe(false);
    expect(result.warning).toBe('REVOKE-UNCONFIRMED');
  });

  it('SB-9: vault:health exposto via IPC (KEYTAR-DEGRADED / VAULT-CORRUPT / SECRET-UNREADABLE)', async () => {
    const handler = ipcHandlers.get('vault:health');
    expect(handler).toBeDefined();

    const result = (await handler!({})) as {
      keytarDegraded: boolean;
      vaultCorruptBackupPath: string | null;
      unreadableKeys: unknown[];
    };
    expect(result).toEqual({
      keytarDegraded: false,
      vaultCorruptBackupPath: null,
      unreadableKeys: [],
    });
  });
});
