import { ipcMain } from 'electron';
import { getCodexModelCapabilities, getCodexModelCapabilitiesState } from '../codex-runtime/model-capabilities';
import type { IpcContext } from './context';
import { getSetting, setSetting } from '../db';
import { invalidateProviderStatusCache } from '../provider-availability';

export function registerCodexHandlers(_ctx: IpcContext): void {
  ipcMain.handle('codex:status', async () => {
    const { isCodexAvailable } = await import('../codex-runtime/binary');
    return isCodexAvailable();
  });

  ipcMain.handle('codex:list-model-capabilities', async () => {
    const caps = await getCodexModelCapabilities();
    return {
      state: getCodexModelCapabilitiesState(),
      capabilities: caps,
    };
  });

  ipcMain.handle('codex:test', async () => {
    const { getCodexBinaryStatus, invalidateCodexBinaryProbe } = await import('../codex-runtime/binary');
    const status = await getCodexBinaryStatus();
    if (!status.installed || !status.authenticated || !status.appServerSupported) {
      return { ok: false, message: status.error ?? 'Codex indisponivel ou nao autenticado' };
    }
    invalidateCodexBinaryProbe();
    invalidateProviderStatusCache();
    return { ok: true, message: status.version ?? 'Codex App Server disponivel' };
  });

  ipcMain.handle('codex:open-login', async () => {
    const { spawn } = await import('child_process');
    const { resolveCodexBinary } = await import('../codex-runtime/binary');
    const { shellEscapePOSIX, appleScriptEscape, cmdQuote } = await import('../shell-escape');

    const resolvedPath = await resolveCodexBinary();
    const binaryPath = resolvedPath || getSetting('codex_binary_path') || 'codex';
    const platform = process.platform;

    if (platform === 'darwin') {
      const shellCmd = `${shellEscapePOSIX(binaryPath)} login`;
      const asExpr = `tell application "Terminal" to do script "${appleScriptEscape(shellCmd)}"`;
      spawn('osascript', ['-e', asExpr]);
    } else if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', 'cmd', '/k', `${cmdQuote(binaryPath)} login`], {
        detached: true,
        shell: false,
        windowsVerbatimArguments: true,
      });
    } else {
      const shellCmd = `${shellEscapePOSIX(binaryPath)} login; exec bash`;
      const term = spawn('gnome-terminal', ['--', 'bash', '-c', shellCmd], {
        detached: true,
      });
      term.on('error', () => {
        spawn('xterm', ['-e', 'bash', '-c', shellCmd], { detached: true });
      });
    }
    return { ok: true };
  });

  ipcMain.handle('codex:set-binary-path', async (_event, path: string) => {
    setSetting('codex_binary_path', path);
    const { invalidateCodexBinaryProbe } = await import('../codex-runtime/binary');
    invalidateCodexBinaryProbe();
    invalidateProviderStatusCache();
    return { ok: true };
  });

  ipcMain.handle('codex:check-prep-needed', async (_event, projectPath: string) => {
    const { checkProjectNeedsPrep } = await import('../codex-windows-prep');
    return checkProjectNeedsPrep(projectPath);
  });

  ipcMain.handle('codex:apply-prep', async (_event, repoRoot: string) => {
    const { applyPrepWithConsent } = await import('../codex-windows-prep');
    return applyPrepWithConsent(repoRoot);
  });

  ipcMain.handle('codex:grant-consent', async (_event, payload: { repoRoot: string; action: 'skip' }) => {
    const { grantSkipConsent } = await import('../codex-windows-prep');
    if (payload.action === 'skip') {
      grantSkipConsent(payload.repoRoot);
      return { ok: true };
    }
    return { ok: false, error: 'Unsupported action' };
  });
}
