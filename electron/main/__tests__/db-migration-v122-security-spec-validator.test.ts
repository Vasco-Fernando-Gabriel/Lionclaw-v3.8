import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyMigrationV122 } from '../db-migrations/v122-security-spec-validator';
import { securitySpecValidator, SECURITY_SPEC_VALIDATOR_ID } from '../seed-agents/security-spec-validator';

interface PreparedCall {
  sql: string;
  args: unknown[];
}

function runWithMockDb(): PreparedCall[] {
  const calls: PreparedCall[] = [];
  const mockDb = {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      run: (...args: unknown[]) => {
        calls.push({ sql, args });
        return { changes: 0, lastInsertRowid: 0 };
      },
      get: () => ({ m: 5 }), // SELECT COALESCE(MAX(sort_order)...)
    })),
  } as unknown as import('better-sqlite3').Database;

  applyMigrationV122(mockDb);
  return calls;
}

describe('applyMigrationV122 - estrutural', () => {
  it('exporta applyMigrationV122 como funcao', () => {
    expect(typeof applyMigrationV122).toBe('function');
  });

  it('nao lanca num mock db limpo', () => {
    expect(() => runWithMockDb()).not.toThrow();
  });
});

describe('applyMigrationV122 - SQL e leanness', () => {
  const calls = runWithMockDb();
  const insert = calls.find((c) => /INSERT OR IGNORE INTO agents/.test(c.sql));

  it('faz um UNICO INSERT OR IGNORE INTO agents (idempotente, preserva customizacao)', () => {
    expect(insert).toBeDefined();
    expect(insert!.sql).toMatch(/INSERT OR IGNORE INTO agents/);
    const inserts = calls.filter((c) => /INSERT OR IGNORE INTO agents/.test(c.sql));
    expect(inserts).toHaveLength(1);
  });

  it('insere o id do security-spec-validator', () => {
    expect(insert!.args[0]).toBe(securitySpecValidator.id);
    expect(insert!.args[0]).toBe('security-spec-validator');
    expect(insert!.args[0]).toBe(SECURITY_SPEC_VALIDATOR_ID);
  });

  it('insere a linha com squad security e os campos do seed (linha editavel depois)', () => {
    const args = insert!.args;
    expect(args[1]).toBe(securitySpecValidator.name);
    expect(args[4]).toBe(securitySpecValidator.model);
    expect(args[5]).toBe(JSON.stringify(securitySpecValidator.allowedTools));
    expect(args[6]).toBe(JSON.stringify(securitySpecValidator.mcpServers));
    expect(args[7]).toBe(securitySpecValidator.isActive ? 1 : 0);
    expect(args[9]).toBe(securitySpecValidator.effort);
    expect(args[10]).toBe(securitySpecValidator.thinking);
    expect(args[14]).toBe(securitySpecValidator.runtime);
    expect(args[20]).toBe('security');
    expect(args[20]).toBe(securitySpecValidator.squad);
  });

  it('insere o validador como writer (access=workspace-write), sem Bash/rede', () => {
    const args = insert!.args;
    expect(args[21]).toBe('workspace-write');
    expect(args[21]).toBe(securitySpecValidator.access);
    expect(args[22]).toBe(0);
    expect(args[23]).toBe('[]');
    expect(args[24]).toBe(0);
  });

  it('faz UM UPDATE direcionado do eixo writer (access=workspace-write) scoped ao id', () => {
    const updates = calls.filter((c) => /UPDATE agents\s+SET access/.test(c.sql));
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toMatch(/access\s*=\s*'workspace-write'/);
    expect(updates[0].sql).toMatch(/WHERE id = \?/);
    expect(updates[0].sql).toMatch(/access = 'read-only'/);
    expect(updates[0].args[0]).toBe(SECURITY_SPEC_VALIDATOR_ID);
  });
});

const MAIN_DIR = join(__dirname, '..');

function readMainSource(relPath: string): string {
  return readFileSync(join(MAIN_DIR, relPath), 'utf8');
}

describe('applyMigrationV122 - integracao no runner de db.ts (F7, guardrail estatico)', () => {
  const dbSrc = readMainSource('db.ts');

  it('db.ts importa applyMigrationV122 do arquivo da migration', () => {
    expect(dbSrc).toContain("import { applyMigrationV122 } from './db-migrations/v122-security-spec-validator'");
  });

  it('runMigrations tem o bloco if (currentVersion < 122) que aplica e versiona', () => {
    const start = dbSrc.indexOf('if (currentVersion < 122) {');
    expect(start).toBeGreaterThan(-1);
    const block = dbSrc.slice(start, start + 500);
    expect(block).toContain('applyMigrationV122(db)');
    expect(block).toContain("db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(122)");
  });
});

describe('applyMigrationV122 - registry do seed (R10, guardrail estatico)', () => {
  const indexSrc = readMainSource('seed-agents/index.ts');

  it('o validator esta no registry (SECURITY_SEED_AGENTS) e flui pra ALL_SEED_AGENTS', () => {
    expect(indexSrc).toContain('securitySpecValidator');
    expect(indexSrc).toMatch(/SECURITY_SEED_AGENTS\s*=\s*\[[\s\S]*?securitySpecValidator/);
    expect(indexSrc).toMatch(/ALL_SEED_AGENTS[\s\S]*?SECURITY_SEED_AGENTS/);
  });
});
