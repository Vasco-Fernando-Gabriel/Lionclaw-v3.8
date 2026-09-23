import type { SystemLogEntry, SystemLogFilters } from '../../src/types';

const BUFFER_MAX = 2000;
const MSG_MAX = 2000;
const EXTRA_MAX = 4000;

const LEVEL_LABELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

const buffer: SystemLogEntry[] = [];
let seq = 0;
const subscribers = new Set<(entry: SystemLogEntry) => void>();

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}... [truncado]` : value;
}

function toEntry(line: string): SystemLogEntry {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const { level, time, module: mod, msg, pid: _pid, hostname: _hostname, ...rest } = obj;
    const numLevel = typeof level === 'number' ? level : 30;
    return {
      seq: ++seq,
      time: typeof time === 'number' ? time : Date.now(),
      level: numLevel,
      levelLabel: LEVEL_LABELS[numLevel] ?? String(numLevel),
      module: typeof mod === 'string' ? mod : undefined,
      msg: typeof msg === 'string' ? truncate(msg, MSG_MAX) : undefined,
      extra: Object.keys(rest).length > 0 ? truncate(JSON.stringify(rest), EXTRA_MAX) : undefined,
    };
  } catch {
    return {
      seq: ++seq,
      time: Date.now(),
      level: 30,
      levelLabel: 'info',
      msg: truncate(line, MSG_MAX),
    };
  }
}

export const systemLogStream = {
  write(chunk: string): void {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      const entry = toEntry(line);
      buffer.push(entry);
      if (buffer.length > BUFFER_MAX) buffer.shift();
      for (const sub of subscribers) {
        try {
          sub(entry);
        } catch {}
      }
    }
  },
};

export function getSystemLogEntries(filters: SystemLogFilters = {}): SystemLogEntry[] {
  const limit = Math.min(filters.limit ?? 500, BUFFER_MAX);
  const search = filters.search?.toLowerCase();
  const out: SystemLogEntry[] = [];
  for (let i = buffer.length - 1; i >= 0 && out.length < limit; i--) {
    const entry = buffer[i];
    if (filters.minLevel !== undefined && entry.level < filters.minLevel) continue;
    if (filters.module && entry.module !== filters.module) continue;
    if (search) {
      const haystack = `${entry.module ?? ''} ${entry.msg ?? ''} ${entry.extra ?? ''}`.toLowerCase();
      if (!haystack.includes(search)) continue;
    }
    out.push(entry);
  }
  return out;
}

export function getSystemLogModules(): string[] {
  const modules = new Set<string>();
  for (const entry of buffer) {
    if (entry.module) modules.add(entry.module);
  }
  return [...modules].sort();
}

export function subscribeSystemLog(cb: (entry: SystemLogEntry) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
