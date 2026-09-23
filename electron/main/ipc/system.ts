import { ipcMain, BrowserWindow, shell, dialog } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger, getSystemLogFilePath } from '../logger';
import { getSystemLogEntries, getSystemLogModules, subscribeSystemLog } from '../system-log-buffer';
import { getLionClawHome } from '../paths';
import { readArtifactState, writeArtifactState } from '../html-artifact';
import { resolveOnboardingCompletedFromState } from '../onboarding';
import type { IpcContext } from './context';
import { getLionClawPath } from './_shared/lionclaw-path';
import { clearSDKSessionFiles } from './_shared/chat-compaction';
import { resetSdkSessionState } from '../orchestrator';
import { searchSemanticMemories } from '../memory-pipeline';
import {
  queryAuditLog,
  getDailySummaries,
  getToolSettings,
  setToolEnabled,
  getEnabledTools,
  getPermissionBypass,
  setPermissionBypass,
  getTelegramArmed,
  setTelegramArmed,
  getDb,
  createAuthRow,
  seedDefaultAgents,
  setSetting,
  getAllSessionIds,
  clearNonSessionResetTables,
} from '../db';
import { deleteSessionsWithTimeline } from '../session-timeline';
import * as auth from '../auth';
import { loadSoul, saveSoul, loadUser, saveUser } from '../prompt-builder';
import type { LogFilters, SystemLogFilters } from '../../../src/types';

const logger = createLogger('ipc');

async function factoryResetOnboarding(): Promise<void> {
  const lionclawPath = getLionClawHome();

  setSetting('onboarding_completed', 'false');

  const cleanUser =
    '# Sobre o Usuario\n\nNenhuma informacao coletada ainda. Execute o onboarding para conhecer o usuario.\n';
  const cleanMemory =
    '# Memoria de Trabalho\n\nNenhum contexto ativo. A memoria sera preenchida automaticamente conforme as conversas.\n';

  fs.writeFileSync(path.join(lionclawPath, 'USER.md'), cleanUser, 'utf-8');
  fs.writeFileSync(path.join(lionclawPath, 'MEMORY.md'), cleanMemory, 'utf-8');

  const homedir = os.homedir();
  const possibleCwds = [process.cwd(), getLionClawHome(), homedir];
  for (const cwd of possibleCwds) {
    const sanitized = cwd.replace(/\//g, '-').replace(/^-/, '-');
    const projectDir = path.join(homedir, '.claude', 'projects', sanitized);
    const autoMemoryDir = path.join(projectDir, 'memory');
    if (fs.existsSync(autoMemoryDir)) {
      for (const file of fs.readdirSync(autoMemoryDir)) {
        fs.unlinkSync(path.join(autoMemoryDir, file));
      }
      logger.info({ dir: autoMemoryDir }, 'Cleared Claude Code auto-memory');
    }
  }

  clearSDKSessionFiles();
  resetSdkSessionState();

  const sessionIds = getAllSessionIds();
  await deleteSessionsWithTimeline(sessionIds);
  clearNonSessionResetTables();

  logger.info('Factory reset completed - ready for fresh onboarding');
}

export function registerSystemHandlers(_ctx: IpcContext): void {
  ipcMain.handle('logs:query', (_event, filters: LogFilters) => {
    return queryAuditLog(filters);
  });

  ipcMain.handle('logs:export-csv', async (_event, filters: LogFilters) => {
    const entries = queryAuditLog({ ...filters, limit: 10000, offset: 0 });
    const headers = [
      'ID',
      'Timestamp',
      'Source',
      'Session',
      'SubAgent',
      'Event Type',
      'Tool',
      'Input',
      'Output',
      'Duration (ms)',
      'Approved',
    ];
    const rows = entries.map((e) =>
      [
        e.id,
        e.createdAt,
        e.source || '',
        e.sessionId || '',
        e.subagent || '',
        e.eventType,
        e.toolName || '',
        (e.input || '').replace(/"/g, '""'),
        (e.output || '').replace(/"/g, '""'),
        e.durationMs ?? '',
        e.approved !== undefined ? (e.approved ? 'Yes' : 'No') : '',
      ]
        .map((v) => `"${v}"`)
        .join(','),
    );
    return [headers.join(','), ...rows].join('\n');
  });

  ipcMain.handle('logs:export-json', async (_event, filters: LogFilters) => {
    const entries = queryAuditLog({ ...filters, limit: 10000, offset: 0 });
    return JSON.stringify(entries, null, 2);
  });

  ipcMain.handle('logs:query-system', (_event, filters?: SystemLogFilters) => {
    return {
      entries: getSystemLogEntries(filters ?? {}),
      modules: getSystemLogModules(),
      logFilePath: getSystemLogFilePath(),
    };
  });

  subscribeSystemLog((entry) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('logs:system-entry', entry);
      }
    }
  });

  ipcMain.handle('usage:provider-limits', async (): Promise<{ providers: unknown[] }> => {
    const { getProviderUsageLimits } = await import('../provider-usage-limits');
    const full = await getProviderUsageLimits();
    return { providers: full.providers.filter((p) => p.status === 'ok') };
  });

  ipcMain.handle('memory:get-working', () => {
    const filePath = path.join(getLionClawPath(), 'MEMORY.md');
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  });

  ipcMain.handle('memory:update-working', (_event, content: string) => {
    const filePath = path.join(getLionClawPath(), 'MEMORY.md');
    fs.writeFileSync(filePath, content, 'utf-8');
  });

  ipcMain.handle('memory:search-semantic', async (_event, query: string, limit?: number) => {
    return searchSemanticMemories(query, limit);
  });

  ipcMain.handle('memory:get-summaries', (_event, from?: string, to?: string) => {
    return getDailySummaries(from, to);
  });

  const toolsGetSettings = () => getToolSettings();
  const toolsSetEnabled = (_e: unknown, tool: string, enabled: boolean) => {
    setToolEnabled(tool, enabled);
    return getToolSettings();
  };
  const toolsGetEnabled = () => getEnabledTools();
  const toolsGetBypass = () => getPermissionBypass();
  const toolsSetBypass = (_e: unknown, enabled: boolean) => {
    setPermissionBypass(enabled);
    return getPermissionBypass();
  };
  const toolsGetTelegramArmed = () => getTelegramArmed();
  const toolsSetTelegramArmed = (_e: unknown, enabled: boolean) => {
    setTelegramArmed(enabled);
    return getTelegramArmed();
  };

  ipcMain.handle('tools:get-settings', toolsGetSettings);
  ipcMain.handle('tools:getSettings', toolsGetSettings);
  ipcMain.handle('tools:set-enabled', toolsSetEnabled);
  ipcMain.handle('tools:setEnabled', toolsSetEnabled);
  ipcMain.handle('tools:get-enabled', toolsGetEnabled);
  ipcMain.handle('tools:get-bypass', toolsGetBypass);
  ipcMain.handle('tools:set-bypass', toolsSetBypass);
  ipcMain.handle('tools:get-telegram-armed', toolsGetTelegramArmed);
  ipcMain.handle('tools:set-telegram-armed', toolsSetTelegramArmed);
  ipcMain.handle('tools:getEnabled', toolsGetEnabled);

  ipcMain.handle('auth:login', async (_event, password: string, totpCode?: string) => {
    return auth.login(password, totpCode);
  });

  ipcMain.handle('auth:logout', () => {
    auth.logout();
  });

  ipcMain.handle('auth:is-authenticated', () => {
    return auth.isAuthenticated();
  });

  ipcMain.handle('auth:is-first-run', () => {
    return auth.isFirstRun();
  });

  ipcMain.handle('auth:setup-password', async (_event, password: string) => {
    const passwordHash = await auth.setupPassword(password);
    getDb().transaction(() => {
      createAuthRow(passwordHash);
      seedDefaultAgents();
      setSetting('orchestrator_setup_completed', '');
    })();
  });

  ipcMain.handle('auth:enable-totp', () => {
    return auth.enableTOTP();
  });

  ipcMain.handle('auth:verify-totp', (_event, code: string) => {
    return auth.verifyTOTP(code);
  });

  ipcMain.handle('soul:get', () => {
    return loadSoul();
  });

  ipcMain.handle('soul:update', (_event, content: string) => {
    saveSoul(content);
    return true;
  });

  ipcMain.handle('user:get', () => {
    return loadUser();
  });

  ipcMain.handle('user:update', (_event, content: string) => {
    saveUser(content);
    return true;
  });

  ipcMain.handle('rules:get-global', () => {
    const filePath = path.join(getLionClawPath(), 'RULES.md');
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  });

  ipcMain.handle('rules:update-global', (_event, content: string) => {
    const filePath = path.join(getLionClawPath(), 'RULES.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  });

  ipcMain.handle('rules:get-agent', (_event, agentId: string) => {
    const filePath = path.join(getLionClawPath(), 'agents', agentId, 'RULES.md');
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  });

  ipcMain.handle('rules:update-agent', (_event, agentId: string, content: string) => {
    const dirPath = path.join(getLionClawPath(), 'agents', agentId);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'RULES.md'), content, 'utf-8');
  });

  ipcMain.handle('onboarding:is-completed', () => {
    return resolveOnboardingCompletedFromState();
  });

  ipcMain.handle('onboarding:mark-completed', () => {
    setSetting('onboarding_completed', 'true');
  });

  ipcMain.handle('onboarding:reset', async () => {
    await factoryResetOnboarding();
  });

  ipcMain.handle('shell:show-in-folder', async (_event, filePath: string) => {
    const resolved = path.resolve(filePath);
    const lionclawDir = getLionClawPath();
    if (!resolved.startsWith(path.resolve(lionclawDir))) {
      return { error: 'Path fora do diretorio permitido' };
    }
    if (!fs.existsSync(resolved)) {
      return { error: 'Arquivo nao encontrado' };
    }
    shell.showItemInFolder(resolved);
    return { ok: true as const };
  });

  ipcMain.handle('shell:open-path', async (_event, dirPath: string) => {
    const resolved = path.resolve(dirPath);
    const lionclawDir = getLionClawPath();
    if (!resolved.startsWith(path.resolve(lionclawDir))) {
      return { error: 'Path fora do diretorio permitido' };
    }
    await shell.openPath(resolved);
    return { ok: true as const };
  });

  ipcMain.handle('shell:open-file', async (_event, rawTarget: string) => {
    if (typeof rawTarget !== 'string' || rawTarget.trim().length === 0) {
      return { error: 'Caminho vazio' };
    }
    let candidate = rawTarget.trim();
    if (/^file:/i.test(candidate)) {
      try {
        candidate = fileURLToPath(candidate);
      } catch {
        return { error: 'URL file:// invalida' };
      }
    } else {
      try {
        candidate = decodeURIComponent(candidate);
      } catch {
        return { error: 'Caminho com codificacao invalida' };
      }
    }
    if (!path.isAbsolute(candidate)) {
      return { error: 'O caminho precisa ser absoluto' };
    }
    let realTarget: string;
    let realHome: string;
    try {
      realTarget = fs.realpathSync(candidate);
      realHome = fs.realpathSync(os.homedir());
    } catch {
      return { error: 'Arquivo nao encontrado' };
    }
    if (!fs.statSync(realTarget).isFile()) {
      return { error: 'O caminho nao e um arquivo' };
    }
    if (realTarget !== realHome && !realTarget.startsWith(realHome + path.sep)) {
      return { error: 'Arquivo fora da pasta do usuario' };
    }
    const openError = await shell.openPath(realTarget);
    if (openError) {
      logger.warn({ target: realTarget, openError }, 'shell:open-file: openPath falhou');
      return { error: openError };
    }
    return { ok: true as const };
  });

  ipcMain.handle('artifact:get-state', async (_event, storageKey: string) => {
    try {
      return readArtifactState(storageKey);
    } catch (err) {
      logger.warn({ storageKey, err }, 'artifact:get-state falhou');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('artifact:set-state', async (_event, storageKey: string, state: unknown) => {
    try {
      return writeArtifactState(storageKey, state);
    } catch (err) {
      logger.warn({ storageKey, err }, 'artifact:set-state falhou');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle(
    'dialog:open-file',
    async (_event, args: { filters?: Array<{ name: string; extensions: string[] }> }) => {
      const win = BrowserWindow.getFocusedWindow();
      const filters = args?.filters ?? [{ name: 'Documents', extensions: ['md', 'json', 'txt'] }];
      const result = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0], {
        properties: ['openFile'],
        filters,
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    },
  );

  ipcMain.handle('dialog:open-directory', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0], {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Selecionar pasta do projeto',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });
}
