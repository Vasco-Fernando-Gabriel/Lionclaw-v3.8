import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrationV136 } from '../db-migrations/v136-liondesign-branding';
import { pipe2SpecBuilder } from '../seed-agents/pipe2-spec-builder';
import { pipe2DesignPlanValidator } from '../seed-agents/pipe2-design-plan-validator';
import { pipe2DesignPlanner } from '../seed-agents/pipe2-design-planner';

const seeds = [pipe2SpecBuilder, pipe2DesignPlanValidator, pipe2DesignPlanner];

function databaseWith(mode: 'old-defaults' | 'customized'): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY, description TEXT NOT NULL, system_prompt TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO agents (id, description, system_prompt) VALUES (?, ?, ?)');
  for (const seed of seeds) {
    if (mode === 'old-defaults') {
      insert.run(
        seed.id,
        seed.description.replaceAll('LionDesign', 'Open Design'),
        seed.systemPrompt.replaceAll('LionDesign', 'Open Design'),
      );
    } else {
      insert.run(
        seed.id,
        `CUSTOM ${seed.id}: manter Open Design literal`,
        `PROMPT CUSTOM ${seed.id}: nunca altere a expressão Open Design`,
      );
    }
  }
  return db;
}

describe('migration v136 - branding LionDesign', () => {
  it('migra somente os defaults antigos para os defaults LionDesign', () => {
    const db = databaseWith('old-defaults');
    applyMigrationV136(db as never);
    for (const seed of seeds) {
      const row = db.prepare('SELECT description, system_prompt FROM agents WHERE id = ?')
        .get(seed.id) as { description: string; system_prompt: string };
      expect(row).toEqual({ description: seed.description, system_prompt: seed.systemPrompt });
    }
    db.close();
  });

  it('preserva prompts e descriptions customizados byte a byte', () => {
    const db = databaseWith('customized');
    const before = db.prepare('SELECT * FROM agents ORDER BY id').all();
    applyMigrationV136(db as never);
    expect(db.prepare('SELECT * FROM agents ORDER BY id').all()).toEqual(before);
    db.close();
  });

  it('está registrada como schema 136 no runner canônico', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('../db.ts', import.meta.url), 'utf8');
    expect(source).toContain("import { applyMigrationV136 } from './db-migrations/v136-liondesign-branding'");
    expect(source).toMatch(/if \(currentVersion < 136\) \{[\s\S]*?applyMigrationV136\(db\);/);
    expect(source).toContain("INSERT INTO schema_version (version) VALUES (?)').run(136)");
  });
});
