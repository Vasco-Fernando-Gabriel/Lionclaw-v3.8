
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyMigrationV97 } from '../db-migrations/v97-dynamic-workflow-maestro-reassert';
import { dynamicWorkflowMaestro } from '../seed-agents/dynamic-workflow-builder';


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

  applyMigrationV97(mockDb);
  return calls;
}


describe('applyMigrationV97 - estrutural', () => {
  it('exporta applyMigrationV97 como funcao', () => {
    expect(typeof applyMigrationV97).toBe('function');
  });

  it('nao lanca num mock db limpo', () => {
    expect(() => runWithMockDb()).not.toThrow();
  });
});

describe('applyMigrationV97 - SQL e leanness', () => {
  const calls = runWithMockDb();
  const insert = calls.find((c) => /INSERT OR IGNORE INTO agents/.test(c.sql));

  it('faz um INSERT OR IGNORE INTO agents (idempotente, preserva customizacao)', () => {
    expect(insert).toBeDefined();
    expect(insert!.sql).toMatch(/INSERT OR IGNORE INTO agents/);
  });

  it('insere o id do Maestro', () => {
    expect(insert!.args[0]).toBe(dynamicWorkflowMaestro.id);
    expect(insert!.args[0]).toBe('dynamic-workflow-maestro');
  });

  it('a linha nasce LEAN: kb_enabled=0, skills/[]/mcp[] vazios, tools so do dominio', () => {
    const args = insert!.args;
    expect(args[5]).toBe(JSON.stringify(['Read', 'Glob', 'Grep']));
    expect(args[6]).toBe(JSON.stringify([]));
    expect(args[13]).toBe(JSON.stringify([]));
    expect(args[14]).toBe(0); // kb_enabled = 0
    expect(args[21]).toBe('dynamic-workflow');
  });

  it('usa model/effort/thinking/max_turns do seed (linha editavel depois)', () => {
    const args = insert!.args;
    expect(args[4]).toBe(dynamicWorkflowMaestro.model); // model
    expect(args[9]).toBe(dynamicWorkflowMaestro.effort); // effort
    expect(args[10]).toBe(dynamicWorkflowMaestro.thinking); // thinking
    expect(args[12]).toBe(dynamicWorkflowMaestro.maxTurns); // max_turns
  });

  it('NAO faz UPDATE de registro existente (so INSERT OR IGNORE: nunca sobrescreve user)', () => {
    expect(calls.some((c) => /^\s*UPDATE agents/.test(c.sql))).toBe(false);
  });
});


const MAIN_DIR = join(__dirname, '..');

function readMainSource(relPath: string): string {
  return readFileSync(join(MAIN_DIR, relPath), 'utf8');
}

describe('applyMigrationV97 - integracao no runner de db.ts (F7, guardrail estatico)', () => {
  const dbSrc = readMainSource('db.ts');

  it('db.ts importa applyMigrationV97 do arquivo da migration', () => {
    expect(dbSrc).toContain(
      "import { applyMigrationV97 } from './db-migrations/v97-dynamic-workflow-maestro-reassert'",
    );
  });

  it('runMigrations tem o bloco if (currentVersion < 97) que aplica e versiona', () => {
    const start = dbSrc.indexOf('if (currentVersion < 97) {');
    expect(start).toBeGreaterThan(-1);
    const block = dbSrc.slice(start, start + 500);
    expect(block).toContain('applyMigrationV97(db)');
    expect(block).toContain(
      "db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(97)",
    );
    expect(block).toMatch(/Applied migration v97/);
  });
});

describe('applyMigrationV97 - registry do seed (R10, guardrail estatico)', () => {
  const indexSrc = readMainSource('seed-agents/index.ts');

  it('o Maestro esta no registry (DYNAMIC_WORKFLOW_AUX_SEED_AGENTS) e flui pra ALL_SEED_AGENTS', () => {
    expect(indexSrc).toContain('DYNAMIC_WORKFLOW_AUX_SEED_AGENTS');
    expect(indexSrc).toMatch(/DYNAMIC_WORKFLOW_AUX_SEED_AGENTS\s*=\s*\[[\s\S]*?dynamicWorkflowMaestro/);
    expect(indexSrc).toMatch(/ALL_SEED_AGENTS[\s\S]*?DYNAMIC_WORKFLOW_AUX_SEED_AGENTS/);
  });
});
