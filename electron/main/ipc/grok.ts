import { ipcMain } from 'electron';
import { spawn } from 'child_process';
import type { ChildProcess, SpawnOptions } from 'child_process';
import type { IpcContext } from './context';
import { getSetting, setSetting } from '../db';
import { invalidateProviderStatusCache } from '../provider-availability';
import { appleScriptEscape, cmdQuote, shellEscapePOSIX } from '../shell-escape';

function run(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && executable.toLowerCase().endsWith('.cmd'),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: { ok: boolean; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => finish({ ok: false, stdout, stderr: error.message }));
    child.on('close', (code) => finish({ ok: code === 0, stdout, stderr }));
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, stdout, stderr: stderr || 'timeout' });
    }, timeoutMs);
  });
}

type SpawnProcess = (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

function spawnDetachedConfirmed(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  spawnProcess: SpawnProcess = spawn,
  options: SpawnOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(executable, args, { detached: true, env, ...options });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

export async function launchLinuxGrokLoginTerminal(
  binary: string,
  childEnv: NodeJS.ProcessEnv,
  spawnProcess: SpawnProcess = spawn,
  launcherEnv: NodeJS.ProcessEnv = childEnv,
): Promise<void> {
  const command = buildPosixGrokLoginArgv(binary, childEnv);
  const terminals: Array<{ executable: string; args: string[] }> = [
    { executable: 'x-terminal-emulator', args: ['-e', ...command] },
    { executable: 'gnome-terminal', args: ['--', ...command] },
    { executable: 'konsole', args: ['-e', ...command] },
    { executable: 'xterm', args: ['-e', ...command] },
  ];
  const failures: string[] = [];

  for (const terminal of terminals) {
    try {
      await spawnDetachedConfirmed(terminal.executable, terminal.args, launcherEnv, spawnProcess);
      return;
    } catch (error) {
      failures.push(`${terminal.executable}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Nenhum emulador de terminal conseguiu abrir o login do Grok. ${failures.join('; ')}`);
}

function sortedEnvAssignments(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
}

export function buildPosixGrokLoginArgv(binary: string, childEnv: NodeJS.ProcessEnv): string[] {
  return ['env', '-i', ...sortedEnvAssignments(childEnv), binary, 'login', '--device-auth'];
}

export function buildMacGrokLoginCommand(binary: string, childEnv: NodeJS.ProcessEnv): string {
  const assignments = sortedEnvAssignments(childEnv).map(shellEscapePOSIX);
  return ['env', '-i', ...assignments, shellEscapePOSIX(binary), 'login', '--device-auth'].join(' ');
}

export function registerGrokHandlers(_ctx: IpcContext): void {
  ipcMain.handle('grok:status', async () => {
    const { isGrokAvailable } = await import('../agent-runtime/grok-availability');
    return {
      ...(await isGrokAvailable()),
      binaryPath: getSetting('grok_binary_path') || '',
    };
  });

  ipcMain.handle('grok:test', async () => {
    const { isGrokAvailable } = await import('../agent-runtime/grok-availability');
    invalidateProviderStatusCache();
    const status = await isGrokAvailable();
    return status.usable
      ? {
          ok: true,
          message: `Grok Build ${status.version ?? ''} conectado e pronto para uso.`.trim(),
        }
      : { ok: false, message: status.reason ?? 'Grok Build nao esta pronto para uso.' };
  });

  ipcMain.handle('grok:open-login', async () => {
    const { assertGrokChildEnv, buildGrokChildEnv, ensureGrokHome, resolveGrokBinary, resolveGrokHome } =
      await import('../agent-runtime/grok-availability');
    const binary = (await resolveGrokBinary()) || getSetting('grok_binary_path') || 'grok';
    ensureGrokHome();
    const childEnv: NodeJS.ProcessEnv = buildGrokChildEnv(resolveGrokHome());
    assertGrokChildEnv(childEnv as Record<string, string>);
    const launcherEnv: NodeJS.ProcessEnv = { ...childEnv };
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS']) {
      if (process.env[key]) launcherEnv[key] = process.env[key];
    }
    const platform = process.platform;
    try {
      if (platform === 'darwin') {
        const command = buildMacGrokLoginCommand(binary, childEnv);
        await spawnDetachedConfirmed(
          'osascript',
          ['-e', `tell application "Terminal" to do script "${appleScriptEscape(command)}"`],
          childEnv,
        );
      } else if (platform === 'win32') {
        await spawnDetachedConfirmed(
          'cmd',
          ['/c', 'start', '', 'cmd', '/k', `${cmdQuote(binary)} login --device-auth`],
          childEnv,
          spawn,
          {
            windowsVerbatimArguments: true,
          },
        );
      } else {
        await launchLinuxGrokLoginTerminal(binary, childEnv, spawn, launcherEnv);
      }
      invalidateProviderStatusCache();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('grok:logout', async () => {
    const { buildGrokChildEnv, resolveGrokBinary, resolveGrokHome } =
      await import('../agent-runtime/grok-availability');
    const binary = (await resolveGrokBinary()) || getSetting('grok_binary_path') || 'grok';
    const result = await run(binary, ['logout'], buildGrokChildEnv(resolveGrokHome()));
    invalidateProviderStatusCache();
    return result.ok
      ? { ok: true }
      : { ok: false, error: result.stderr.trim() || result.stdout.trim() || 'grok logout falhou' };
  });

  ipcMain.handle('grok:set-binary-path', async (_event, path: string) => {
    setSetting('grok_binary_path', typeof path === 'string' ? path.trim() : '');
    invalidateProviderStatusCache();
    return { ok: true };
  });
}
