import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyMigrationV123, __V123_INTERNAL } from '../db-migrations/v123-telegram-compaction-columns';

function runWithMockDb(execImpl?: (sql: string) => void): string[] {
  const execs: string[] = [];
  const mockDb = {
    exec: vi.fn().mockImplementation((sql: string) => {
      execs.push(sql);
      execImpl?.(sql);
    }),
  } as unknown as import('better-sqlite3').Database;

  applyMigrationV123(mockDb);
  return execs;
}

describe('applyMigrationV123 - colunas', () => {
  it('adiciona exatamente as 4 colunas da SPEC 5.1/9 em sessions', () => {
    const execs = runWithMockDb();
    expect(execs).toHaveLength(4);
    expect(execs[0]).toBe('ALTER TABLE sessions ADD COLUMN compacted_up_to_message_id INTEGER');
    expect(execs[1]).toBe('ALTER TABLE sessions ADD COLUMN rolling_summary TEXT');
    expect(execs[2]).toBe('ALTER TABLE sessions ADD COLUMN pending_seed TEXT');
    expect(execs[3]).toBe('ALTER TABLE sessions ADD COLUMN active_context_tokens_est INTEGER');
  });

  it('todas as colunas sao NULLABLE e sem DEFAULT (aditivo puro: legado fica NULL, AC-12)', () => {
    for (const sql of runWithMockDb()) {
      expect(sql).not.toMatch(/NOT NULL/i);
      expect(sql).not.toMatch(/DEFAULT/i);
      expect(sql).toMatch(/^ALTER TABLE sessions ADD COLUMN /);
    }
  });

  it('__V123_INTERNAL espelha tabela e colunas', () => {
    expect(__V123_INTERNAL.TABLE_NAME).toBe('sessions');
    expect(__V123_INTERNAL.COLUMN_NAMES).toEqual([
      'compacted_up_to_message_id',
      'rolling_summary',
      'pending_seed',
      'active_context_tokens_est',
    ]);
  });
});

describe('applyMigrationV123 - idempotencia', () => {
  it('engole "duplicate column name" (re-rodar e no-op) e ainda tenta as 4 colunas', () => {
    const execs: string[] = [];
    const mockDb = {
      exec: vi.fn().mockImplementation((sql: string) => {
        execs.push(sql);
        throw new Error(`duplicate column name: ${sql.split(' ').pop()}`);
      }),
    } as unknown as import('better-sqlite3').Database;

    expect(() => applyMigrationV123(mockDb)).not.toThrow();
    expect(execs).toHaveLength(4);
  });

  it('propaga qualquer outro erro (ex: tabela ausente)', () => {
    const mockDb = {
      exec: vi.fn().mockImplementation(() => {
        throw new Error('no such table: sessions');
      }),
    } as unknown as import('better-sqlite3').Database;

    expect(() => applyMigrationV123(mockDb)).toThrow('no such table');
  });
});

const dbSource = readFileSync(join(__dirname, '..', 'db.ts'), 'utf-8');

function functionBody(name: string): string {
  const start = dbSource.indexOf(`export function ${name}`);
  expect(start, `export function ${name} deveria existir em db.ts`).toBeGreaterThan(-1);
  const rest = dbSource.slice(start + 1);
  const end = rest.search(/\nexport (function|const|type|interface)/);
  return rest
    .slice(0, end === -1 ? undefined : end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('guardrail estatico - runner da V123 em db.ts', () => {
  it('importa e aplica a V123 com bump de schema_version', () => {
    expect(dbSource).toContain("from './db-migrations/v123-telegram-compaction-columns'");
    expect(dbSource).toContain('if (currentVersion < 123)');
    expect(dbSource).toContain('applyMigrationV123(db)');
    expect(dbSource).toMatch(/INSERT INTO schema_version \(version\) VALUES \(\?\)'\)\.run\(123\)/);
  });
});

describe('AC-21 - contadores (estatico em db.ts)', () => {
  it('updateSessionTokens segue INCREMENTAL nos historicos e NAO toca mais o contador ativo (SUPERSEDING fonte-unica)', () => {
    const body = functionBody('updateSessionTokens');
    expect(body).toContain('input_tokens = input_tokens + ?');
    expect(body).toContain('output_tokens = output_tokens + ?');
    expect(body).toContain('cost_usd = cost_usd + ?');
    expect(body).not.toContain('active_context_tokens_est');
    expect(body).not.toMatch(/input_tokens\s*=\s*\?/);
    expect(body).not.toMatch(/output_tokens\s*=\s*\?/);
    expect(body).not.toMatch(/cost_usd\s*=\s*\?/);
  });

  it('setSessionActiveContextTokens e setter ABSOLUTO restrito a active_context_tokens_est', () => {
    const body = functionBody('setSessionActiveContextTokens');
    expect(body).toContain('active_context_tokens_est = ?');
    for (const col of [
      'input_tokens',
      'output_tokens',
      'cost_usd',
      'pending_seed',
      'rolling_summary',
      'compacted_up_to_message_id',
    ]) {
      expect(body, `setSessionActiveContextTokens nao pode tocar ${col}`).not.toContain(col);
    }
  });

  it('grep AC-21: setSessionActiveContextTokens e o UNICO writer da coluna ativa em db.ts (SET absoluto, zero incremento)', () => {
    const assignments = dbSource.match(/active_context_tokens_est\s*=\s*[^\n]+/g) ?? [];
    const absolute = assignments.filter((a) => /active_context_tokens_est\s*=\s*\?/.test(a));
    const incremental = assignments.filter((a) => a.includes('COALESCE(active_context_tokens_est, 0)'));
    expect(absolute, 'exatamente UM setter absoluto (setSessionActiveContextTokens)').toHaveLength(1);
    expect(incremental, 'zero incremento da coluna ativa em db.ts').toHaveLength(0);
    expect(assignments).toHaveLength(absolute.length);
  });

  it('writers novos da SPEC 5.1 existem e NUNCA tocam os historicos', () => {
    for (const fn of ['setSessionSdkSessionId', 'setSessionCompactionState', 'clearSessionPendingSeed']) {
      const body = functionBody(fn);
      for (const col of ['input_tokens', 'output_tokens', 'cost_usd']) {
        expect(body, `${fn} nao pode tocar ${col}`).not.toContain(col);
      }
    }
  });

  it('setSessionCompactionState escreve fronteira + resumo + seed numa unica UPDATE', () => {
    const body = functionBody('setSessionCompactionState');
    expect(body).toContain('compacted_up_to_message_id = ?');
    expect(body).toContain('rolling_summary = ?');
    expect(body).toContain('pending_seed = ?');
    expect((body.match(/UPDATE sessions/g) ?? []).length).toBe(1);
  });
});
