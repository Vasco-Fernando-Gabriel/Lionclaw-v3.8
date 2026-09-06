import { ipcMain } from 'electron';
import type { IpcContext } from './context';
import { setSetting } from '../db';

export function registerKimiHandlers(_ctx: IpcContext): void {

  ipcMain.handle('kimi:status', async () => {
    const { isKimiAvailable } = await import('../agent-runtime/kimi-availability');
    return isKimiAvailable();
  });

  ipcMain.handle('kimi:test', async () => {
    const { probeKimiProvider } = await import('../kimi-acp/provider-probe');
    const result = await probeKimiProvider();
    return { ok: result.ok, message: result.message };
  });

  ipcMain.handle('kimi:open-login', async () => {
    const { createLogger } = await import('../logger');
    const logger = createLogger('ipc-kimi');
    const { spawn } = await import('child_process');
    const {
      buildKimiChildEnv,
      resolveKimiBinary,
      ensureKimiHome,
    } = await import('../agent-runtime/kimi-availability');
    const { getSetting } = await import('../db');
    const {
      shellEscapePOSIX,
      appleScriptEscape,
      cmdQuote,
    } = await import('../shell-escape');

    const resolvedPath = await resolveKimiBinary();
    const binaryPath = resolvedPath || getSetting('kimi_binary_path') || 'kimi';
    const kimiHome = ensureKimiHome();
    const childEnv = buildKimiChildEnv({ home: kimiHome });
    const launcherEnv: NodeJS.ProcessEnv = { ...childEnv };
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS']) {
      if (process.env[key]) launcherEnv[key] = process.env[key];
    }
    const envAssignments = Object.entries(childEnv)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => shellEscapePOSIX(`${key}=${value}`));
    const platform = process.platform;

    if (platform === 'darwin') {
      const shellCmd = ['env', '-i', ...envAssignments, shellEscapePOSIX(binaryPath), 'acp', '--login'].join(' ');
      const asExpr = `tell application "Terminal" to do script "${appleScriptEscape(shellCmd)}"`;
      const t = spawn('osascript', ['-e', asExpr], { env: childEnv });
      t.on('error', (err) => logger.warn({ err }, 'kimi open-login: falha ao abrir Terminal via osascript'));
      t.unref();
    } else if (platform === 'win32') {
      const t = spawn(
        'cmd',
        ['/c', 'start', '""', 'cmd', '/k', `${cmdQuote(binaryPath)} acp --login`],
        { detached: true, shell: false, windowsVerbatimArguments: true, env: childEnv },
      );
      t.on('error', (err) => logger.warn({ err }, 'kimi open-login: falha ao abrir cmd'));
      t.unref();
    } else {
      const shellCmd = `${['env', '-i', ...envAssignments, shellEscapePOSIX(binaryPath), 'acp', '--login'].join(' ')}; exec bash`;
      const launchers: Array<[string, string[]]> = [
        ['x-terminal-emulator', ['-e', 'bash', '-c', shellCmd]],
        ['gnome-terminal', ['--', 'bash', '-c', shellCmd]],
        ['konsole', ['-e', 'bash', '-c', shellCmd]],
        ['xterm', ['-e', 'bash', '-c', shellCmd]],
      ];
      const tryLaunch = (i: number): void => {
        if (i >= launchers.length) {
          logger.warn('kimi open-login: nenhum emulador de terminal encontrado');
          return;
        }
        const [cmd, args] = launchers[i];
        const t = spawn(cmd, args, { detached: true, env: launcherEnv });
        t.on('error', () => tryLaunch(i + 1));
        t.unref();
      };
      tryLaunch(0);
    }
    return { ok: true };
  });

  ipcMain.handle('kimi:set-binary-path', async (_event, path: string) => {
    setSetting('kimi_binary_path', path);
    return { ok: true };
  });
}
