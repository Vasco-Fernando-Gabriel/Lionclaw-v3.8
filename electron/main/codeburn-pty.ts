import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { app, BrowserWindow } from 'electron';
import { createLogger } from './logger';

const logger = createLogger('codeburn-pty');

function resolveNodeBinary(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where node' : 'which node';
    const found = execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim().split('\n')[0];
    if (found && fs.existsSync(found)) return found;
  } catch {
  }
  const candidates = process.platform === 'darwin'
    ? ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\nodejs\\node.exe']
      : ['/usr/bin/node', '/usr/local/bin/node'];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

type Pty = {
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};
type PtyModule = {
  spawn(file: string, args: string[], opts: Record<string, unknown>): Pty;
};

let ptyMod: PtyModule | null = null;
let ptyLoadError: string | null = null;

function loadPty(): PtyModule | null {
  if (ptyMod) return ptyMod;
  if (ptyLoadError) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyMod = require('node-pty') as PtyModule;
    return ptyMod;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ptyLoadError = msg;
    logger.error({ err }, 'failed to load node-pty');
    return null;
  }
}

interface Session {
  pty: Pty;
  window: BrowserWindow;
  windowDestroyHandler: () => void;
}

const sessions = new Map<number, Session>();

function resolveCodeburnEntry(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'node_modules', 'codeburn', 'dist', 'cli.js'),
    process.resourcesPath
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'codeburn', 'dist', 'cli.js')
      : '',
    process.resourcesPath
      ? path.join(process.resourcesPath, 'node_modules', 'codeburn', 'dist', 'cli.js')
      : '',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
    }
  }
  return null;
}

function killSession(senderId: number): void {
  const session = sessions.get(senderId);
  if (!session) return;
  sessions.delete(senderId);
  try {
    session.window.webContents.removeListener('destroyed', session.windowDestroyHandler);
  } catch {
  }
  try {
    session.pty.kill();
  } catch (err) {
    logger.warn({ err }, 'pty kill failed');
  }
}

export function spawnCodeburn(
  window: BrowserWindow,
  cols: number,
  rows: number,
): { ok: true } | { ok: false; error: string } {
  const senderId = window.webContents.id;
  killSession(senderId);

  const mod = loadPty();
  if (!mod) {
    return { ok: false, error: `node-pty nao carregou: ${ptyLoadError ?? 'erro desconhecido'} (rode "npm run rebuild:electron")` };
  }

  const entry = resolveCodeburnEntry();
  if (!entry) {
    return { ok: false, error: 'codeburn nao encontrado em node_modules — rode "npm install"' };
  }

  const nodeBin = resolveNodeBinary();
  if (!nodeBin) {
    return { ok: false, error: 'Node.js nao encontrado no sistema (instale via brew install node)' };
  }

  let pty: Pty;
  try {
    pty = mod.spawn(nodeBin, [entry, 'report'], {
      name: 'xterm-256color',
      cols: Math.max(20, Math.floor(cols) || 120),
      rows: Math.max(5, Math.floor(rows) || 30),
      cwd: app.getPath('home'),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'pty spawn failed');
    return { ok: false, error: `falha ao iniciar codeburn: ${msg}` };
  }

  pty.onData((chunk: string) => {
    if (window.isDestroyed()) return;
    window.webContents.send('codeburn:data', chunk);
  });

  pty.onExit(({ exitCode, signal }) => {
    logger.info({ exitCode, signal, senderId }, 'codeburn exited');
    sessions.delete(senderId);
    if (!window.isDestroyed()) {
      window.webContents.send('codeburn:exit', { exitCode, signal: signal ?? null });
    }
  });

  const windowDestroyHandler = () => killSession(senderId);
  window.webContents.once('destroyed', windowDestroyHandler);

  sessions.set(senderId, { pty, window, windowDestroyHandler });
  logger.info({ senderId, cols, rows }, 'codeburn spawned');
  return { ok: true };
}

export function writeCodeburn(senderId: number, data: string): void {
  const session = sessions.get(senderId);
  if (!session) {
    logger.warn({ senderId, dataLen: data.length }, 'write: no session for sender');
    return;
  }
  try {
    session.pty.write(data);
    logger.debug({ senderId, data: JSON.stringify(data) }, 'pty.write ok');
  } catch (err) {
    logger.warn({ err }, 'pty write failed');
  }
}

export function resizeCodeburn(senderId: number, cols: number, rows: number): void {
  const session = sessions.get(senderId);
  if (!session) return;
  try {
    session.pty.resize(Math.max(20, Math.floor(cols) || 120), Math.max(5, Math.floor(rows) || 30));
  } catch (err) {
    logger.warn({ err }, 'pty resize failed');
  }
}

export function killCodeburn(senderId: number): void {
  killSession(senderId);
}
