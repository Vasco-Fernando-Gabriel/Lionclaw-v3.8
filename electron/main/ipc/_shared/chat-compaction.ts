import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from '../../logger';
import { getLionClawHome } from '../../paths';
import { sanitizeClaudeProjectDir } from '../../telegram-jsonl-migration';

const logger = createLogger('ipc');

export function clearSDKSessionFiles(preserveThreadIds: string[] = []): void {
  const homedir = os.homedir();
  const preserve = new Set(preserveThreadIds.map((id) => `${id}.jsonl`));
  const projectDir = path.join(homedir, '.claude', 'projects', sanitizeClaudeProjectDir(getLionClawHome()));
  if (!fs.existsSync(projectDir)) return;
  for (const file of fs.readdirSync(projectDir)) {
    if (!file.endsWith('.jsonl')) continue;
    if (preserve.has(file)) {
      logger.info({ file }, 'Preserved Telegram SDK session file (SPEC 14-obs)');
      continue;
    }
    fs.unlinkSync(path.join(projectDir, file));
    logger.info({ file }, 'Cleared SDK session file');
  }
}
