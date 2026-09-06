
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger';
import { getLionClawHome } from '../paths';

const logger = createLogger('cursor-chat-workspace');

export const CURSOR_CHAT_RULES_FILENAME = 'lionclaw-identity.internal.mdc';

export const CURSOR_CHAT_RULES_RELPATH = path.join('.cursor', 'rules', CURSOR_CHAT_RULES_FILENAME);

export const CURSOR_CHAT_TRANSIENT_RELPATHS: readonly string[] = [
  CURSOR_CHAT_RULES_RELPATH.replace(/\\/g, '/'),
];

export type CursorChatLane = 'desktop' | 'telegram' | 'cron';

export interface CursorChatWorkspace {
  lane: CursorChatLane;
  sessionId: string;
  workspaceDir: string;
  rulesFilePath: string;
}

export function cursorChatWorkspacesRoot(): string {
  return path.join(getLionClawHome(), 'runtime', 'cursor-chat-workspaces');
}

export function resolveCursorChatWorkspace(
  lane: CursorChatLane,
  sessionId: string,
): CursorChatWorkspace {
  const digest = createHash('sha1').update(sessionId).digest('hex');
  const workspaceDir = path.join(cursorChatWorkspacesRoot(), lane, digest);
  fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(workspaceDir, 0o700); } catch { /* best effort no Windows */ }
  return {
    lane,
    sessionId,
    workspaceDir,
    rulesFilePath: path.join(workspaceDir, CURSOR_CHAT_RULES_RELPATH),
  };
}

export function materializeCursorChatRules(
  workspace: CursorChatWorkspace,
  content: string,
): void {
  fs.mkdirSync(path.dirname(workspace.rulesFilePath), { recursive: true });
  const body = [
    '---',
    'alwaysApply: true',
    '---',
    '',
    content,
    '',
  ].join('\n');
  fs.writeFileSync(workspace.rulesFilePath, body, 'utf8');
}

export function cursorChatInputTouchesRules(
  workspace: CursorChatWorkspace,
  input: unknown,
): boolean {
  return inputTouchesProtectedRoot(
    path.resolve(workspace.workspaceDir, '.cursor'),
    [workspace.workspaceDir],
    input,
  );
}

export function cursorChatInputTouchesWorkspacesRoot(input: unknown): boolean {
  return inputTouchesProtectedRoot(cursorChatWorkspacesRoot(), [getLionClawHome()], input);
}

function inputTouchesProtectedRoot(
  protectedRoot: string,
  relativeBases: readonly string[],
  input: unknown,
): boolean {
  if (input === null || typeof input !== 'object') return false;
  const values: string[] = [];
  for (const value of Object.values(input as Record<string, unknown>)) {
    if (typeof value === 'string') values.push(value);
  }
  const needle = path.resolve(protectedRoot).toLowerCase();
  const needleFwd = needle.replace(/\\/g, '/');
  for (const value of values) {
    const candidate = value.toLowerCase().replace(/\\/g, '/');
    if (candidate.includes(needleFwd)) return true;
    if (path.isAbsolute(value)) {
      const resolved = path.resolve(value).toLowerCase();
      if (resolved === needle || resolved.startsWith(needle + path.sep)) return true;
    } else {
      for (const base of relativeBases) {
        const resolved = path.resolve(base, value).toLowerCase();
        if (resolved === needle || resolved.startsWith(needle + path.sep)) return true;
      }
    }
  }
  return false;
}

export function cleanupCursorChatWorkspaces(): void {
  const root = cursorChatWorkspacesRoot();
  try {
    if (!fs.existsSync(root)) return;
    fs.rmSync(root, { recursive: true, force: true });
    logger.info({ root }, 'Workspaces de chat cursor residuais removidos no boot');
  } catch (err) {
    logger.warn({ err, root }, 'Falha ao limpar workspaces de chat cursor no boot');
  }
}
