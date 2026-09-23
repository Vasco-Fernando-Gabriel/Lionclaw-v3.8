import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../../logger';
import { getLionClawHome } from '../../paths';

const logger = createLogger('cursor-session-registry');

const SESSION_FILE = 'lion-session.json';

export interface CursorSessionKeyParts {
  agentId: string;
  cwd: string;
  projectId?: string;
}

export interface CursorSessionRecord {
  cursorAgentId: string;
  model: string;
  updatedAt: string;
}

export function buildCursorSessionKey(parts: CursorSessionKeyParts): string {
  return `${parts.projectId ?? 'standalone'}::${parts.agentId}::${path.resolve(parts.cwd)}`;
}

export function cursorSessionStoreDir(sessionKey: string): string {
  const digest = createHash('sha1').update(sessionKey).digest('hex');
  return path.join(getLionClawHome(), 'data', 'cursor-sessions', digest);
}

export function loadCursorSession(sessionKey: string): CursorSessionRecord | null {
  const file = path.join(cursorSessionStoreDir(sessionKey), SESSION_FILE);
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec['cursorAgentId'] !== 'string' || rec['cursorAgentId'].length === 0) return null;
    return {
      cursorAgentId: rec['cursorAgentId'],
      model: typeof rec['model'] === 'string' ? rec['model'] : '',
      updatedAt: typeof rec['updatedAt'] === 'string' ? rec['updatedAt'] : '',
    };
  } catch (err) {
    logger.warn({ err, sessionKey }, 'lion-session.json ilegivel — retomada vira sessao nova');
    return null;
  }
}

export function saveCursorSession(sessionKey: string, record: CursorSessionRecord): void {
  const dir = cursorSessionStoreDir(sessionKey);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, SESSION_FILE), JSON.stringify(record, null, 2), 'utf8');
  } catch (err) {
    logger.warn({ err, sessionKey }, 'Falha ao persistir lion-session.json do runtime Cursor');
  }
}
