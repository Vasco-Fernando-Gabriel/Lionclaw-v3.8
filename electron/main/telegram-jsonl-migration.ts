import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from './logger';
import { listActiveTelegramSessions } from './db';
import { getLionClawHome, getBackgroundCwd } from './paths';

const logger = createLogger('telegram-jsonl-migration');

export function sanitizeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function getClaudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

export interface TelegramJsonlMigrationOptions {
  projectsRoot?: string;
  oldCwd?: string;
  newCwd?: string;
  sessions?: Array<{ id: string; sdkSessionId?: string }>;
}

export interface TelegramJsonlMigrationResult {
  moved: number;
  skipped: number;
}

export function migrateTelegramJsonlOnBoot(
  options: TelegramJsonlMigrationOptions = {},
): TelegramJsonlMigrationResult {
  const projectsRoot = options.projectsRoot ?? getClaudeProjectsRoot();
  const oldDir = path.join(projectsRoot, sanitizeClaudeProjectDir(options.oldCwd ?? getBackgroundCwd()));
  const newDir = path.join(projectsRoot, sanitizeClaudeProjectDir(options.newCwd ?? getLionClawHome()));

  let sessions: Array<{ id: string; sdkSessionId?: string }>;
  try {
    sessions = options.sessions ?? listActiveTelegramSessions();
  } catch (err) {
    logger.warn({ err }, 'Telegram: nao foi possivel listar sessoes active para migrar jsonl (boot continua)');
    return { moved: 0, skipped: 0 };
  }

  let moved = 0;
  let skipped = 0;

  for (const session of sessions) {
    const threadId = session.sdkSessionId ?? session.id;
    const src = path.join(oldDir, `${threadId}.jsonl`);
    const dst = path.join(newDir, `${threadId}.jsonl`);
    try {
      if (!fs.existsSync(src) || fs.existsSync(dst)) {
        skipped++;
        continue;
      }
      fs.mkdirSync(newDir, { recursive: true });
      fs.renameSync(src, dst);
      moved++;
      logger.info(
        { threadId, sessionId: session.id, src, dst },
        'Telegram: jsonl de sessao ativa migrado do diretorio background para o principal (SPEC 10)',
      );
    } catch (err) {
      skipped++;
      logger.warn({ err, threadId, sessionId: session.id }, 'Telegram: falha ao migrar jsonl (segue em frente)');
    }
  }

  return { moved, skipped };
}
