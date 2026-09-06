
const SQLITE_UTC_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

export function parseUtcTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const iso = SQLITE_UTC_RE.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

export function formatLocalShort(date: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('day')}/${get('month')} ${hour}:${get('minute')}`;
}

export function toLocalShort(value: unknown, timeZone?: string): string | undefined {
  const date = parseUtcTimestamp(value);
  return date ? formatLocalShort(date, timeZone) : undefined;
}
