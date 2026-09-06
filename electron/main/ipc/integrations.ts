import { ipcMain } from 'electron';
import fs from 'fs';
import TelegramBot from 'node-telegram-bot-api';
import { createLogger } from '../logger';
import type { IpcContext } from './context';
import {
  getAllMCPServers,
  updateMCPServer,
  restartServer,
  stopServer,
} from '../mcp-manager';
import { startGoogleMcps } from '../google-mcp-startup';
import {
  generateSpeech,
  transcribeAudio,
} from '../voice-engine';
import {
  generateCartesiaSpeech,
  generateLiveSpeech,
  listCartesiaVoices,
} from '../cartesia-engine';
import { generateImage, editImage } from '../image-engine';
import {
  runOAuthFlow,
  getGoogleAuthStatus,
  revokeGoogleAuth,
} from '../google-auth';
import {
  getVaultEntries,
  setVaultSecret,
  deleteVaultSecret,
  checkVaultSecret,
  invalidateVaultStatusCache,
  registerVaultEntry,
  type VaultEntry,
} from '../vault-registry';
import {
  getAllChannels,
  getChannel,
  upsertChannel,
  toggleChannel,
} from '../channels-db';
import {
  startTelegramBot,
  stopTelegramBot,
  isTelegramRunning,
} from '../telegram-bridge';
import { syncCodexMcpConfig } from '../codex-sdk/mcp-config-sync';
import {
  connectHiggsfield,
  deleteHiggsfieldSession,
  getHiggsfieldAuthStatus,
  HIGGSFIELD_SESSION_SECRET_KEY,
} from '../higgsfield-auth';

const logger = createLogger('ipc');

export function registerIntegrationsHandlers(ctx: IpcContext): void {
  const getMainWindow = ctx.getMainWindow;

  ipcMain.handle('vault:list', async () => {
    return getVaultEntries();
  });

  ipcMain.handle('vault:set', async (_event, key: string, value: string) => {
    await setVaultSecret(key, value);
  });

  ipcMain.handle('vault:delete', async (_event, key: string) => {
    await deleteVaultSecret(key);
  });

  ipcMain.handle('vault:check', async (_event, key: string) => {
    return checkVaultSecret(key);
  });

  ipcMain.handle('vault:health', async () => {
    const { getSecretsHealth } = await import('../secrets-vault');
    return getSecretsHealth();
  });

  ipcMain.handle(
    'vault:register-and-set',
    async (_event, entry: Omit<VaultEntry, 'configured'>, value: string) => {
      try {
        registerVaultEntry(entry);
        await setVaultSecret(entry.key, value);
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: message };
      }
    },
  );

  ipcMain.handle('higgsfield:auth-status', async () => {
    return getHiggsfieldAuthStatus();
  });

  ipcMain.handle('higgsfield:connect', async (_event, options?: { force?: boolean }) => {
    const result = await connectHiggsfield(options);
    invalidateVaultStatusCache(HIGGSFIELD_SESSION_SECRET_KEY);
    if (result.ok) {
      const higgsfield = getAllMCPServers().find((server) => server.id === 'higgsfield');
      if (higgsfield?.isActive) {
        try {
          await restartServer('higgsfield');
        } catch (error) {
          logger.warn({ error }, 'Failed to restart Higgsfield MCP after auth');
        }
      }
      await syncCodexMcpConfig();
    }
    return result;
  });

  ipcMain.handle('higgsfield:disconnect', async () => {
    stopServer('higgsfield');
    await deleteHiggsfieldSession();
    invalidateVaultStatusCache(HIGGSFIELD_SESSION_SECRET_KEY);
    await syncCodexMcpConfig();
    return { ok: true, status: await getHiggsfieldAuthStatus() };
  });

  ipcMain.handle(
    'image:generate',
    async (_event, prompt: string, options?: { aspectRatio?: string }) => {
      return generateImage(
        prompt,
        options as { aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9' },
      );
    },
  );

  ipcMain.handle(
    'image:edit',
    async (
      _event,
      prompt: string,
      imageBase64: string,
      imageMimeType: string,
      options?: { aspectRatio?: string },
    ) => {
      return editImage(
        prompt,
        imageBase64,
        imageMimeType,
        options as { aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9' },
      );
    },
  );

  ipcMain.handle('voice:transcribe', async (_event, audioBase64: string) => {
    return transcribeAudio(audioBase64);
  });

  ipcMain.handle(
    'voice:speak',
    async (_event, text: string, voiceId?: string) => {
      const result = await generateSpeech(text, voiceId);
      return result;
    },
  );

  ipcMain.handle('voice:speak-live', async (_event, text: string) => {
    return generateLiveSpeech(text);
  });

  ipcMain.handle(
    'voice:speak-cartesia',
    async (_event, text: string, voiceId?: string, language?: string) => {
      return generateCartesiaSpeech(text, voiceId, language);
    },
  );

  ipcMain.handle('voice:list-voices', async () => {
    const apiKey = await (
      await import('../secrets-vault')
    ).getSecret('ELEVENLABS_API_KEY');
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY nao configurada');

    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey },
    });

    if (!response.ok) throw new Error(`ElevenLabs failed: ${response.status}`);

    const data = (await response.json()) as {
      voices: Array<{
        voice_id: string;
        name: string;
        category: string;
        labels: Record<string, string>;
        preview_url: string;
      }>;
    };
    return data.voices.map((v) => ({
      voice_id: v.voice_id,
      name: v.name,
      category: v.category,
      labels: v.labels || {},
      preview_url: v.preview_url || '',
    }));
  });

  ipcMain.handle(
    'voice:list-cartesia-voices',
    async (_event, options?: { q?: string; language?: string; limit?: number }) => {
      return listCartesiaVoices(options);
    },
  );

  ipcMain.handle('voice:read-audio-file', async (_event, filePath: string) => {
    const buffer = fs.readFileSync(filePath);
    return buffer.toString('base64');
  });

  ipcMain.handle(
    'google:setup',
    async (_event, config: { clientId: string; clientSecret: string }) => {
      const { setSecret } = await import('../secrets-vault');
      await setSecret('GOOGLE_CLIENT_ID', config.clientId);
      await setSecret('GOOGLE_CLIENT_SECRET', config.clientSecret);
      return { success: true };
    },
  );

  ipcMain.handle('google:authenticate', async () => {
    const result = await runOAuthFlow();

    if (result.success) {
      const mcpStartFailures = await startGoogleMcps();
      return { ...result, mcpStartFailures };
    }

    return result;
  });

  ipcMain.handle('google:status', async () => {
    return getGoogleAuthStatus();
  });

  ipcMain.handle('google:revoke', async () => {
    const googleMcps = ['google-gmail', 'google-drive', 'google-sheets'];
    for (const id of googleMcps) {
      stopServer(id);
      updateMCPServer(id, { isActive: false });
    }
    return revokeGoogleAuth();
  });

  ipcMain.handle('channels:list', () => {
    return getAllChannels();
  });

  ipcMain.handle('channels:get', (_event, type: string) => {
    return getChannel(type);
  });

  ipcMain.handle(
    'channels:save-telegram',
    async (
      _event,
      config: {
        botToken: string;
        allowedUserId: number;
        allowedUserName: string;
        notifyOnSchedulerTasks: boolean;
        notifyOnDriveHandoff: boolean;
      },
    ) => {
      if (config.botToken && config.botToken !== '__keep__') {
        const { setSecret } = await import('../secrets-vault');
        await setSecret('TELEGRAM_BOT_TOKEN', config.botToken);
      }

      upsertChannel('telegram', {
        allowedUserId: config.allowedUserId,
        allowedUserName: config.allowedUserName,
        sessionMode: 'continuous',
        notifyOnSchedulerTasks: config.notifyOnSchedulerTasks,
        notifyOnDriveHandoff: config.notifyOnDriveHandoff,
      });

      await stopTelegramBot();
      await startTelegramBot(getMainWindow);

      return getChannel('telegram');
    },
  );

  ipcMain.handle(
    'channels:toggle',
    async (_event, type: string, active: boolean) => {
      toggleChannel(type, active);
      if (type === 'telegram') {
        await stopTelegramBot();
        if (active) await startTelegramBot(getMainWindow);
      }
    },
  );

  ipcMain.handle('channels:test-telegram', async () => {
    const { getSecret } = await import('../secrets-vault');
    const token = await getSecret('TELEGRAM_BOT_TOKEN');
    if (!token) return { success: false, error: 'Token nao configurado' };

    try {
      const testBot = new TelegramBot(token, { polling: false });
      const me = await testBot.getMe();
      return {
        success: true,
        botUsername: me.username,
        botName: me.first_name,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('channels:telegram-status', () => {
    return { running: isTelegramRunning() };
  });
}
