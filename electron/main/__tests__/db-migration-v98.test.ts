
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyMigrationV98 } from '../db-migrations/v98-dynamic-workflow-narrator-delta';
import { dynamicWorkflowNarrator } from '../seed-agents/dynamic-workflow-narrator';

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
    })),
  } as unknown as import('better-sqlite3').Database;
  applyMigrationV98(mockDb);
  return calls;
}

describe('applyMigrationV98 - estrutural', () => {
  it('exporta applyMigrationV98 como funcao', () => {
    expect(typeof applyMigrationV98).toBe('function');
  });

  it('nao lanca num mock db limpo', () => {
    expect(() => runWithMockDb()).not.toThrow();
  });
});

describe('applyMigrationV98 - SQL direcionado e preserva customizacao', () => {
  const calls = runWithMockDb();
  const update = calls.find((c) => /UPDATE agents SET system_prompt/.test(c.sql));

  it('faz UM UPDATE direcionado por id do narrator E pelo prompt OLD (preserva user)', () => {
    expect(update).toBeDefined();
    expect(update!.sql).toMatch(/UPDATE agents SET system_prompt = \?/);
    expect(update!.sql).toMatch(/WHERE id = 'dynamic-workflow-narrator'/);
    expect(update!.sql).toMatch(/AND system_prompt = \?/);
  });

  it('NEW (arg 0) e o systemPrompt ATUAL do seed (fonte de verdade)', () => {
    expect(update!.args[0]).toBe(dynamicWorkflowNarrator.systemPrompt);
  });

  it('OLD (arg 1) e DIFERENTE do NEW (a migration de fato converge)', () => {
    expect(update!.args[1]).not.toBe(update!.args[0]);
  });

  it('NEW pede DELTA por marco e proibe re-descrever o projeto (SM-23)', () => {
    const newPrompt = String(update!.args[0]);
    expect(newPrompt).toContain('UMA frase');
    expect(newPrompt).toMatch(/NAO redescreva o projeto inteiro/i);
  });

  it('OLD ainda tinha o comportamento pre-SM-23 (1 ou 2 frases / o que esta sendo construido)', () => {
    const oldPrompt = String(update!.args[1]);
    expect(oldPrompt).toContain('escrever 1 ou 2 frases');
    expect(oldPrompt).toContain('o que esta sendo construido');
  });
});

const MAIN_DIR = join(__dirname, '..');
function readMainSource(relPath: string): string {
  return readFileSync(join(MAIN_DIR, relPath), 'utf8');
}

describe('applyMigrationV98 - integracao no runner de db.ts (F7, guardrail estatico)', () => {
  const dbSrc = readMainSource('db.ts');

  it('db.ts importa applyMigrationV98 do arquivo da migration', () => {
    expect(dbSrc).toContain(
      "import { applyMigrationV98 } from './db-migrations/v98-dynamic-workflow-narrator-delta'",
    );
  });

  it('runMigrations tem o bloco if (currentVersion < 98) que aplica e versiona', () => {
    const start = dbSrc.indexOf('if (currentVersion < 98) {');
    expect(start).toBeGreaterThan(-1);
    const block = dbSrc.slice(start, start + 500);
    expect(block).toContain('applyMigrationV98(db)');
    expect(block).toContain(
      "db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(98)",
    );
    expect(block).toMatch(/Applied migration v98/);
  });
});
