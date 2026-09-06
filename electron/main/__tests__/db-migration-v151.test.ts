import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationV151, __V151_INTERNAL } from '../db-migrations/v151-dynamic-workflow-writer-turns';
import { LATEST_SCHEMA_VERSION } from '../db-migration-safety';
import { dynamicWorkflowCoder } from '../seed-agents/dynamic-workflow-coder';
import { dynamicWorkflowCoderCodex } from '../seed-agents/dynamic-workflow-coder-codex';
import { dynamicWorkflowCoderGlm } from '../seed-agents/dynamic-workflow-coder-glm';
import { dynamicWorkflowFixer } from '../seed-agents/dynamic-workflow-fixer';
import { dynamicWorkflowDocWriter } from '../seed-agents/dynamic-workflow-doc-writer';


const OLD_CMDS = JSON.stringify(['npm run typecheck', 'npm run test', 'npm install', 'npm ci']);

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      max_turns INTEGER,
      allowed_commands TEXT
    )
  `);
  return db;
}

function insert(db: Database.Database, id: string, maxTurns: number | null, commands: string | null): void {
  db.prepare('INSERT INTO agents (id, name, max_turns, allowed_commands) VALUES (?, ?, ?, ?)').run(id, id, maxTurns, commands);
}

function row(db: Database.Database, id: string): { max_turns: number | null; allowed_commands: string | null } {
  return db.prepare('SELECT max_turns, allowed_commands FROM agents WHERE id = ?').get(id) as { max_turns: number | null; allowed_commands: string | null };
}

describe('migration v151 - writers do dynamic-workflow (maxTurns + allowedCommands)', () => {
  it('sobe 80->150 nos 4 writers de codigo, 60->100 no doc-writer e amplia allowed_commands SO de quem esta no seed antigo', () => {
    const db = makeDb();
    for (const id of __V151_INTERNAL.CODE_WRITER_IDS) insert(db, id, 80, OLD_CMDS);
    insert(db, __V151_INTERNAL.DOC_WRITER_ID, 60, '[]');
    applyMigrationV151(db);
    for (const id of __V151_INTERNAL.CODE_WRITER_IDS) {
      const r = row(db, id);
      expect(r.max_turns).toBe(150);
      expect(JSON.parse(r.allowed_commands!)).toEqual(__V151_INTERNAL.NEW_CODE_WRITER_COMMANDS);
    }
    const doc = row(db, __V151_INTERNAL.DOC_WRITER_ID);
    expect(doc.max_turns).toBe(100);
    expect(doc.allowed_commands).toBe('[]');
  });

  it('preserva customizacao do usuario (max_turns ou allowed_commands fora do seed antigo ficam intactos)', () => {
    const db = makeDb();
    insert(db, 'dynamic-workflow-coder', 42, JSON.stringify(['npm run typecheck', 'make']));
    insert(db, 'dynamic-workflow-fixer', 80, JSON.stringify(['pnpm test']));
    insert(db, 'dynamic-workflow-doc-writer', 25, '[]');
    insert(db, 'outro-agente', 80, OLD_CMDS);
    applyMigrationV151(db);
    expect(row(db, 'dynamic-workflow-coder')).toEqual({ max_turns: 42, allowed_commands: JSON.stringify(['npm run typecheck', 'make']) });
    expect(row(db, 'dynamic-workflow-fixer')).toEqual({ max_turns: 150, allowed_commands: JSON.stringify(['pnpm test']) });
    expect(row(db, 'dynamic-workflow-doc-writer').max_turns).toBe(25);
    expect(row(db, 'outro-agente')).toEqual({ max_turns: 80, allowed_commands: OLD_CMDS });
  });

  it('e idempotente e tolera seeds ausentes', () => {
    const db = makeDb();
    insert(db, 'dynamic-workflow-coder', 80, OLD_CMDS);
    applyMigrationV151(db);
    expect(() => applyMigrationV151(db)).not.toThrow();
    expect(row(db, 'dynamic-workflow-coder').max_turns).toBe(150);
    expect(() => applyMigrationV151(makeDb())).not.toThrow();
  });

  it('R10: os .ts dos seeds carregam os MESMOS valores da migration', () => {
    for (const seed of [dynamicWorkflowCoder, dynamicWorkflowCoderCodex, dynamicWorkflowCoderGlm, dynamicWorkflowFixer]) {
      expect(seed.maxTurns).toBe(__V151_INTERNAL.NEW_CODE_WRITER_MAX_TURNS);
      expect(seed.allowedCommands).toEqual(__V151_INTERNAL.NEW_CODE_WRITER_COMMANDS);
    }
    expect(dynamicWorkflowDocWriter.maxTurns).toBe(__V151_INTERNAL.NEW_DOC_WRITER_MAX_TURNS);
    expect(dynamicWorkflowDocWriter.allowedCommands).toEqual([]);
  });

  it('LATEST_SCHEMA_VERSION = 150', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(150);
  });
});
