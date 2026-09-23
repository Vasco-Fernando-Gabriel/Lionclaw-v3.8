import os from 'os';
import path from 'path';
import fs from 'fs';

function isActive(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { app?: { isPackaged?: boolean } };
    const app = electron?.app;
    if (!app || typeof app.isPackaged !== 'boolean') return true;
    return !app.isPackaged;
  } catch {
    return true;
  }
}

const AUDIT_FILE = path.join(os.homedir(), '.lionclaw', 'data', 'smoke-audit-fonte-unica.txt');

function serializeValue(value: unknown): string {
  if (value === undefined) return '(undefined)';
  if (value === null) return '(null)';
  if (typeof value === 'string') {
    return /\s/.test(value) ? `"${value}"` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json.length > 120 ? `${json.slice(0, 117)}...` : json;
  } catch {
    return '(unserializable)';
  }
}

export function smokeAudit(event: string, data: Record<string, unknown>): void {
  try {
    if (!isActive()) return;
    const parts = [new Date().toISOString(), event];
    for (const [key, value] of Object.entries(data)) {
      parts.push(`${key}=${serializeValue(value)}`);
    }
    const line = `${parts.join(' | ')}\n`;
    fs.appendFile(AUDIT_FILE, line, () => {});
  } catch {}
}
