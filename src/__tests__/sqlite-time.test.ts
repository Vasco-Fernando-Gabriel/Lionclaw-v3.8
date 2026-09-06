import { describe, expect, it } from 'vitest';
import {
  dayLabel,
  formatLocalDateTime,
  formatLocalTime,
  parseSqliteUtc,
} from '@/lib/sqlite-time';
import { formatDateTime } from '@/components/kanban/kanban-ui';

const SP = { timeZone: 'America/Sao_Paulo' };

describe('parseSqliteUtc', () => {
  it("trata 'YYYY-MM-DD HH:MM:SS' como UTC", () => {
    const d = parseSqliteUtc('2026-09-02 04:42:52');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-09-02T04:42:52.000Z');
  });

  it('mantem ISO com Z intacto', () => {
    const d = parseSqliteUtc('2026-09-02T04:42:52.000Z');
    expect(d!.getTime()).toBe(Date.parse('2026-09-02T04:42:52.000Z'));
  });

  it('mantem ISO com offset explicito intacto', () => {
    const d = parseSqliteUtc('2026-09-02T01:42:52-03:00');
    expect(d!.toISOString()).toBe('2026-09-02T04:42:52.000Z');
  });

  it('formato invalido/vazio => null', () => {
    expect(parseSqliteUtc('nao-e-data')).toBeNull();
    expect(parseSqliteUtc('')).toBeNull();
    expect(parseSqliteUtc('   ')).toBeNull();
    expect(parseSqliteUtc(null)).toBeNull();
    expect(parseSqliteUtc(undefined)).toBeNull();
  });
});

describe('formatadores em fuso explicito', () => {
  it("VA-10: '2026-09-02 04:42:52' em America/Sao_Paulo => 02/09 01:42", () => {
    const d = parseSqliteUtc('2026-09-02 04:42:52')!;
    expect(formatLocalDateTime(d, SP)).toBe('02/09 01:42');
    expect(formatLocalTime(d, SP)).toBe('01:42');
    expect(dayLabel(d, SP)).toBe('02/09/2026');
  });

  it('cruza a meia-noite corretamente (UTC 02:10 = 23:10 do dia anterior em SP)', () => {
    const d = parseSqliteUtc('2026-09-02 02:10:00')!;
    expect(formatLocalDateTime(d, SP)).toBe('01/09 23:10');
    expect(dayLabel(d, SP)).toBe('01/09/2026');
  });

  it('meia-noite local sai 00:xx (hourCycle h23), nunca 24:xx', () => {
    const d = parseSqliteUtc('2026-09-02 03:05:00')!;
    expect(formatLocalTime(d, SP)).toBe('00:05');
  });

  it('outro fuso: UTC => 04:42', () => {
    const d = parseSqliteUtc('2026-09-02 04:42:52')!;
    expect(formatLocalDateTime(d, { timeZone: 'UTC' })).toBe('02/09 04:42');
  });
});

describe('kanban-ui.formatDateTime usa o parser unico (D22)', () => {
  it('formato invalido cai no fallback (texto original)', () => {
    expect(formatDateTime('nao-e-data')).toBe('nao-e-data');
  });

  it('formato SQLite e ISO com Z apontam para o MESMO instante', () => {
    expect(formatDateTime('2026-09-02 04:42:52')).toBe(formatDateTime('2026-09-02T04:42:52.000Z'));
    expect(formatDateTime('2026-09-02 04:42:52')).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });
});
