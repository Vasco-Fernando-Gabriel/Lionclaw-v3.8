import { BrowserWindow } from 'electron';
import os from 'os';
import { createLogger } from './logger';
import { getBootEnvSnapshot } from './boot-env-snapshot';

const logger = createLogger('terminal-pty');

export const MAX_TERMINAL_SESSIONS_PER_WINDOW = 8;

type Pty = {
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};
export type PtyModule = {
  spawn(file: string, args: string[], opts: Record<string, unknown>): Pty;
};

let ptyMod: PtyModule | null = null;
let ptyLoadError: string | null = null;
let ptyLoaderOverride: (() => PtyModule) | null = null;

function loadPty(): PtyModule | null {
  if (ptyMod) return ptyMod;
  if (ptyLoadError) return null;
  try {
    ptyMod = ptyLoaderOverride
      ? ptyLoaderOverride()
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      : (require('node-pty') as PtyModule);
    return ptyMod;
  } catch (err) {
    ptyLoadError = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'failed to load node-pty');
    return null;
  }
}

export function setPtyLoaderForTests(loader: (() => PtyModule) | null): void {
  ptyLoaderOverride = loader;
  ptyMod = null;
  ptyLoadError = null;
}

function resolveUserShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: [] };
  }
  const snapshotShell = getBootEnvSnapshot().SHELL;
  const shell = snapshotShell && snapshotShell.trim().length > 0
    ? snapshotShell
    : '/bin/bash';
  return { file: shell, args: ['-l'] };
}

function clampDim(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(1000, Number.isFinite(n) ? n : fallback));
}

interface TerminalSession {
  pty: Pty;
  senderId: number;
  sessionId: string;
  window: BrowserWindow;
  suppressExit: boolean;
}

function sessionKey(senderId: number, sessionId: string): string {
  return `${senderId}:${sessionId}`;
}

const sessions = new Map<string, TerminalSession>();
const windowCleanupRegistered = new Set<number>();

export function hasActiveTerminalSessions(): boolean {
  return sessions.size > 0;
}

function killSessionByKey(key: string): void {
  const session = sessions.get(key);
  if (!session) return;
  session.suppressExit = true;
  sessions.delete(key);
  try {
    session.pty.kill();
  } catch (err) {
    logger.warn({ err, key }, 'terminal pty kill failed');
  }
}

function killSessionsForSender(senderId: number): void {
  for (const [key, session] of sessions) {
    if (session.senderId === senderId) killSessionByKey(key);
  }
}

export function killAllTerminalSessions(): void {
  for (const key of [...sessions.keys()]) killSessionByKey(key);
}

export function openTerminalSession(
  window: BrowserWindow,
  sessionId: string,
  cols: unknown,
  rows: unknown,
): { ok: true } | { ok: false; error: string } {
  const senderId = window.webContents.id;
  const trimmedId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!trimmedId) {
    return { ok: false, error: 'sessionId invalido' };
  }
  const key = sessionKey(senderId, trimmedId);

  if (sessions.has(key)) {
    return { ok: false, error: `sessao ${trimmedId} ja existe nesta janela` };
  }

  let liveForSender = 0;
  for (const session of sessions.values()) {
    if (session.senderId === senderId) liveForSender += 1;
  }
  if (liveForSender >= MAX_TERMINAL_SESSIONS_PER_WINDOW) {
    return {
      ok: false,
      error: `limite de ${MAX_TERMINAL_SESSIONS_PER_WINDOW} terminais simultaneos atingido`,
    };
  }

  const mod = loadPty();
  if (!mod) {
    return {
      ok: false,
      error: `node-pty nao carregou: ${ptyLoadError ?? 'erro desconhecido'} (rode "npm run rebuild:electron")`,
    };
  }

  const shell = resolveUserShell();
  let pty: Pty;
  try {
    pty = mod.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: clampDim(cols, 80),
      rows: clampDim(rows, 24),
      cwd: os.homedir(),
      env: {
        ...getBootEnvSnapshot(),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, shell: shell.file }, 'terminal pty spawn failed');
    return { ok: false, error: `falha ao iniciar o shell (${shell.file}): ${msg}` };
  }

  const session: TerminalSession = {
    pty,
    senderId,
    sessionId: trimmedId,
    window,
    suppressExit: false,
  };

  pty.onData((chunk: string) => {
    if (window.isDestroyed()) return;
    window.webContents.send('terminal:data', { sessionId: trimmedId, chunk });
  });

  pty.onExit(({ exitCode }) => {
    const current = sessions.get(sessionKey(senderId, trimmedId));
    if (current?.pty === pty) {
      sessions.delete(sessionKey(senderId, trimmedId));
    }
    if (!session.suppressExit && !window.isDestroyed()) {
      window.webContents.send('terminal:exit', { sessionId: trimmedId, exitCode });
    }
    logger.info(
      { senderId, sessionId: trimmedId, exitCode, suppressed: session.suppressExit },
      'terminal shell exited',
    );
  });

  if (!windowCleanupRegistered.has(senderId)) {
    windowCleanupRegistered.add(senderId);
    window.webContents.once('destroyed', () => {
      windowCleanupRegistered.delete(senderId);
      killSessionsForSender(senderId);
    });
    window.webContents.on('did-navigate', () => {
      killSessionsForSender(senderId);
    });
  }

  sessions.set(key, session);
  logger.info({ senderId, sessionId: trimmedId, shell: shell.file }, 'terminal session opened');
  return { ok: true };
}

export function writeTerminalSession(senderId: number, sessionId: string, data: string): void {
  const session = sessions.get(sessionKey(senderId, sessionId));
  if (!session) return;
  try {
    session.pty.write(data);
  } catch (err) {
    logger.warn({ err, sessionId }, 'terminal pty write failed');
  }
}

export function resizeTerminalSession(
  senderId: number,
  sessionId: string,
  cols: unknown,
  rows: unknown,
): void {
  const session = sessions.get(sessionKey(senderId, sessionId));
  if (!session) return;
  try {
    session.pty.resize(clampDim(cols, 80), clampDim(rows, 24));
  } catch (err) {
    logger.warn({ err, sessionId }, 'terminal pty resize failed');
  }
}

export function closeTerminalSession(senderId: number, sessionId: string): void {
  killSessionByKey(sessionKey(senderId, sessionId));
}

export function resetTerminalPtyStateForTests(): void {
  for (const key of [...sessions.keys()]) {
    const session = sessions.get(key);
    sessions.delete(key);
    try {
      session?.pty.kill();
    } catch {
    }
  }
  windowCleanupRegistered.clear();
  ptyMod = null;
  ptyLoadError = null;
}
