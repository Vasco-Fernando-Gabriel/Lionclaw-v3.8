
export interface LocalTimeOptions {
  timeZone?: string;
}

export function parseSqliteUtc(value: string | null | undefined): Date | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw.length === 0) return null;
  const iso = raw.includes('T') || raw.includes('Z') ? raw : `${raw.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function partsOf(
  date: Date,
  opts: LocalTimeOptions | undefined,
  fields: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    ...fields,
    hourCycle: 'h23',
    ...(opts?.timeZone ? { timeZone: opts.timeZone } : {}),
  });
  const out: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}

export function formatLocalDateTime(date: Date, opts?: LocalTimeOptions): string {
  const p = partsOf(date, opts, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

export function formatLocalTime(date: Date, opts?: LocalTimeOptions): string {
  const p = partsOf(date, opts, { hour: '2-digit', minute: '2-digit' });
  return `${p.hour}:${p.minute}`;
}

export function dayLabel(date: Date, opts?: LocalTimeOptions): string {
  const p = partsOf(date, opts, { day: '2-digit', month: '2-digit', year: 'numeric' });
  return `${p.day}/${p.month}/${p.year}`;
}
