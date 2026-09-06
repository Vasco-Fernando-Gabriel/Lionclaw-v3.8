import { ipcMain } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IpcContext } from './context';
import { createLogger } from '../logger';
import { getSetting, setSetting } from '../db';
import { getApiKey } from '../secrets-vault';
import {
  getClaudeCodeExecutablePath,
} from '../pipeline-shared/sdk-bootstrap';
import {
  isPackagedDistributionRuntime,
  resolveInternalNodeBinary,
} from '../distribution-runtime';


const logger = createLogger('claude-cli');

type ClaudeAuthMode = 'oauth' | 'api-key' | 'none';

async function detectClaudeAuthMode(): Promise<ClaudeAuthMode> {
  if (process.env.ANTHROPIC_API_KEY) return 'api-key';
  const claudeDir = path.join(os.homedir(), '.claude');
  if (fs.existsSync(claudeDir)) return 'oauth';
  try {
    const apiKey = await getApiKey();
    if (apiKey) return 'api-key';
  } catch {
  }
  return 'none';
}

function readAdjacentPackageVersion(cliPath: string): string | null {
  try {
    const pkgPath = path.join(path.dirname(cliPath), 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function readNativeCliVersion(cliPath: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    void (async () => {
      try {
        const { spawn } = await import('child_process');
        const useShell =
          process.platform === 'win32' && cliPath.toLowerCase().endsWith('.cmd');
        const child = spawn(cliPath, ['--version'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: useShell,
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString();
        });
        const timeout = setTimeout(() => {
          child.kill();
          resolve(null);
        }, 10_000);
        child.on('close', (code: number | null) => {
          clearTimeout(timeout);
          if (code !== 0) return resolve(null);
          const raw = out.trim().split('\n')[0]?.trim() ?? '';
          if (!raw) return resolve(null);
          const semver = raw.match(/\d+\.\d+\.\d+[\w.-]*/);
          resolve(semver ? semver[0] : raw.slice(0, 80));
        });
        child.on('error', () => {
          clearTimeout(timeout);
          resolve(null);
        });
      } catch {
        resolve(null);
      }
    })();
  });
}

function isJsEntry(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs');
}

export async function readClaudeCliVersion(cliPath: string): Promise<string | null> {
  return isJsEntry(cliPath)
    ? readAdjacentPackageVersion(cliPath)
    : readNativeCliVersion(cliPath);
}

function authLabel(mode: ClaudeAuthMode): string {
  if (mode === 'oauth') return 'OAuth (assinatura Claude)';
  if (mode === 'api-key') return 'ANTHROPIC_API_KEY';
  return 'sem auth';
}

export function registerClaudeCliHandlers(_ctx: IpcContext): void {
  ipcMain.handle('claude-cli:status', async () => {
    let resolvedPath = '';
    let resolveError: string | null = null;
    try {
      resolvedPath = getClaudeCodeExecutablePath();
    } catch (err) {
      resolveError = err instanceof Error ? err.message : String(err);
    }
    const installed = resolvedPath !== '' && fs.existsSync(resolvedPath);
    const version = installed ? await readClaudeCliVersion(resolvedPath) : null;
    const authMode = await detectClaudeAuthMode();
    logger.info(
      { resolvedPath, installed, version, authMode, resolveError },
      'claude-cli:status',
    );
    return {
      installed,
      version,
      authenticated: authMode !== 'none',
      authMode,
      resolvedPath: resolvedPath || (resolveError ?? ''),
    };
  });

  ipcMain.handle('claude-cli:test', async () => {
    const { spawn } = await import('child_process');
    let cliPath = '';
    try {
      cliPath = getClaudeCodeExecutablePath();
    } catch (err) {
      return {
        ok: false,
        message: `Engine do Claude Code nao resolvido: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!fs.existsSync(cliPath)) {
      return {
        ok: false,
        message: `Binario do Claude Code CLI nao encontrado em: ${cliPath}`,
      };
    }

    const runViaNode = isJsEntry(cliPath);
    const cmd = runViaNode
      ? isPackagedDistributionRuntime()
        ? resolveInternalNodeBinary()
        : 'node'
      : cliPath;
    const argv = runViaNode ? [cliPath, '--version'] : ['--version'];
    const useShell =
      process.platform === 'win32' && cmd.toLowerCase().endsWith('.cmd');
    const authMode = await detectClaudeAuthMode();

    return new Promise<{ ok: boolean; message: string }>((resolve) => {
      const child = spawn(cmd, argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString();
      });
      const timeout = setTimeout(() => {
        child.kill();
        resolve({ ok: false, message: 'Timeout - o Claude Code CLI nao respondeu' });
      }, 10_000);
      child.on('close', (code: number | null) => {
        clearTimeout(timeout);
        if (code === 0) {
          const ver = out.trim() || 'ok';
          resolve({ ok: true, message: `${ver} | auth: ${authLabel(authMode)}` });
        } else {
          resolve({
            ok: false,
            message:
              (err || out).trim() || `Claude Code CLI saiu com codigo ${code}`,
          });
        }
      });
      child.on('error', (e: Error) => {
        clearTimeout(timeout);
        resolve({ ok: false, message: `Erro ao executar o Claude Code CLI: ${e.message}` });
      });
    });
  });

  ipcMain.handle('claude-cli:set-binary-path', async (_event, p: string) => {
    setSetting('claude_cli_binary_path', p);
    return { ok: true };
  });

  ipcMain.handle('claude-cli:open-login', async () => {
    const { spawn } = await import('child_process');
    const { shellEscapePOSIX, appleScriptEscape, cmdQuote } = await import(
      '../shell-escape'
    );

    const custom = (getSetting('claude_cli_binary_path') || '').trim();
    let resolvedEngine = '';
    try {
      const candidate = getClaudeCodeExecutablePath();
      if (fs.existsSync(candidate)) resolvedEngine = candidate;
    } catch {
    }
    const loginBin = custom || resolvedEngine || 'claude';
    const viaNode = loginBin !== 'claude' ? isJsEntry(loginBin) : false;
    const platform = process.platform;

    if (platform === 'darwin') {
      const shellCmd = viaNode
        ? `node ${shellEscapePOSIX(loginBin)} login`
        : `${shellEscapePOSIX(loginBin)} login`;
      const asExpr = `tell application "Terminal" to do script "${appleScriptEscape(shellCmd)}"`;
      spawn('osascript', ['-e', asExpr]);
    } else if (platform === 'win32') {
      const inner = viaNode
        ? `node ${cmdQuote(loginBin)} login`
        : `${cmdQuote(loginBin)} login`;
      spawn('cmd', ['/c', 'start', '""', 'cmd', '/k', inner], {
        detached: true,
        shell: false,
        windowsVerbatimArguments: true,
      });
    } else {
      const shellCmd = viaNode
        ? `node ${shellEscapePOSIX(loginBin)} login; exec bash`
        : `${shellEscapePOSIX(loginBin)} login; exec bash`;
      const term = spawn('gnome-terminal', ['--', 'bash', '-c', shellCmd], {
        detached: true,
      });
      term.on('error', () => {
        spawn('xterm', ['-e', 'bash', '-c', shellCmd], { detached: true });
      });
    }
    return { ok: true };
  });
}
