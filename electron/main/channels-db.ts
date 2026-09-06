import { getDb } from './db';
import { createLogger } from './logger';

const logger = createLogger('channels-db');

export interface Channel {
  id: string;
  type: 'telegram' | 'slack' | 'discord' | 'whatsapp';
  name: string;
  config: Record<string, unknown>;
  isActive: boolean;
  status: 'connected' | 'disconnected' | 'error';
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export function getAllChannels(): Channel[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM channels ORDER BY created_at ASC').all() as Array<Record<string, unknown>>;
  return rows.map(mapChannel);
}

export function getChannel(type: string): Channel | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM channels WHERE type = ?').get(type) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapChannel(row);
}

export function upsertChannel(type: string, config: Record<string, unknown>): Channel {
  const db = getDb();
  const existing = getChannel(type);

  if (existing) {
    db.prepare(`
      UPDATE channels SET config = ?, is_active = 1, updated_at = datetime('now') WHERE type = ?
    `).run(JSON.stringify(config), type);
  } else {
    const id = type;
    const name = type.charAt(0).toUpperCase() + type.slice(1);
    db.prepare(`
      INSERT INTO channels (id, type, name, config, is_active, status)
      VALUES (?, ?, ?, ?, 1, 'disconnected')
    `).run(id, type, name, JSON.stringify(config));
  }

  logger.info({ type }, 'Channel upserted');
  return getChannel(type)!;
}

export function toggleChannel(type: string, active: boolean): void {
  const db = getDb();
  db.prepare(`
    UPDATE channels SET is_active = ?, updated_at = datetime('now') WHERE type = ?
  `).run(active ? 1 : 0, type);
  logger.info({ type, active }, 'Channel toggled');
}

export function updateChannelStatus(type: string, status: string, errorMessage?: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE channels SET status = ?, error_message = ?, updated_at = datetime('now') WHERE type = ?
  `).run(status, errorMessage || null, type);
}

function mapChannel(row: Record<string, unknown>): Channel {
  return {
    id: row['id'] as string,
    type: row['type'] as Channel['type'],
    name: row['name'] as string,
    config: JSON.parse((row['config'] as string) || '{}'),
    isActive: (row['is_active'] as number) === 1,
    status: (row['status'] as Channel['status']) || 'disconnected',
    errorMessage: row['error_message'] as string | undefined,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}
