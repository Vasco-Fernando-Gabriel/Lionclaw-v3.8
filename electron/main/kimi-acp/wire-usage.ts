import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface KimiWireUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface KimiWireOffsetSnapshot {
  sessionDir: string;
  offsets: Record<string, number>;
}

export function deriveKimiSessionDir(kimiHome: string, workDir: string, sessionId: string): string {
  const raw = path.isAbsolute(workDir) ? workDir : path.resolve(workDir);
  const absWorkDir = raw.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const slug = (absWorkDir.split('/').pop() ?? '').toLowerCase();
  const hash = crypto.createHash('sha256').update(absWorkDir).digest('hex').slice(0, 12);
  const bareSessionId = sessionId.startsWith('session_') ? sessionId.slice('session_'.length) : sessionId;
  const home = kimiHome.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${home}/sessions/wd_${slug}_${hash}/session_${bareSessionId}`;
}

function listWireFiles(sessionDir: string): string[] {
  const agentsDir = path.join(sessionDir, 'agents');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wirePath = path.join(agentsDir, entry.name, 'wire.jsonl');
    if (fs.existsSync(wirePath)) files.push(wirePath);
  }
  return files;
}

export function snapshotKimiWireOffsets(sessionDir: string): KimiWireOffsetSnapshot | null {
  if (!fs.existsSync(sessionDir)) return null;
  const offsets: Record<string, number> = {};
  for (const file of listWireFiles(sessionDir)) {
    try {
      offsets[file] = fs.statSync(file).size;
    } catch {}
  }
  return { sessionDir, offsets };
}

export function readKimiWireUsageDelta(snapshot: KimiWireOffsetSnapshot): KimiWireUsage | null {
  if (!fs.existsSync(snapshot.sessionDir)) return null;
  const currentFiles = listWireFiles(snapshot.sessionDir);
  const currentSet = new Set(currentFiles);
  for (const known of Object.keys(snapshot.offsets)) {
    if (!currentSet.has(known)) return null;
  }

  const totals: KimiWireUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  for (const file of currentFiles) {
    const offset = snapshot.offsets[file] ?? 0;
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return null;
    }
    if (size < offset) return null;
    if (size === offset) continue;

    let chunk: string;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        chunk = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }

    const lines = chunk.split('\n');
    const trailing = lines.pop() ?? '';
    if (trailing.trim().length > 0 && looksLikeUsageRecord(trailing)) {
      return null;
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        if (looksLikeUsageRecord(trimmed)) return null;
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const rec = parsed as Record<string, unknown>;
      if (rec['type'] !== 'usage.record') continue;
      const scope = rec['usageScope'];
      if (scope !== undefined && typeof scope !== 'string') return null;
      if (scope !== undefined && scope !== 'turn') continue;
      const usage = rec['usage'];
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
      const u = usage as Record<string, unknown>;
      const integer = (key: string): number | null => {
        const value = u[key];
        return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
      };
      const inputOther = integer('inputOther');
      const inputCacheRead = integer('inputCacheRead');
      const inputCacheCreation = integer('inputCacheCreation');
      const output = integer('output');
      if (inputOther === null || inputCacheRead === null || inputCacheCreation === null || output === null) return null;
      const inclusiveInput = inputOther + inputCacheRead + inputCacheCreation;
      if (!Number.isSafeInteger(inclusiveInput)) return null;
      for (const totalKey of ['input', 'inputTokens', 'inputTotal']) {
        if (u[totalKey] === undefined) continue;
        const reportedTotal = integer(totalKey);
        if (reportedTotal === null || reportedTotal !== inclusiveInput) return null;
      }
      totals.inputTokens += inclusiveInput;
      totals.outputTokens += output;
      totals.cacheReadTokens += inputCacheRead;
      totals.cacheCreationTokens += inputCacheCreation;
      if (
        !Number.isSafeInteger(totals.inputTokens) ||
        !Number.isSafeInteger(totals.outputTokens) ||
        !Number.isSafeInteger(totals.cacheReadTokens) ||
        !Number.isSafeInteger(totals.cacheCreationTokens)
      )
        return null;
    }
  }

  return totals;
}

function looksLikeUsageRecord(line: string): boolean {
  return /usage\.record|"usage"\s*:|"usageScope"\s*:/.test(line);
}
