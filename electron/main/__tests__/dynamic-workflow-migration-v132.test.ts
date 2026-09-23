import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dynamicWorkflowBuilder } from '../seed-agents/dynamic-workflow-builder';

const V132_SOURCE = readFileSync(
  join(__dirname, '..', 'db-migrations', 'v132-dynamic-workflow-budget-removal.ts'),
  'utf8',
);

const OLD_LINE =
  '- Respeite o budget e a politica de gates fornecidos no prompt; preencha estimate com honestidade e liste em unknownCostNodes os nodes sem pricing conhecido.';
const NEW_LINE =
  '- Respeite a politica de gates fornecida no prompt; preencha estimate com honestidade e liste em unknownCostNodes os nodes sem pricing conhecido.';

describe('migration v132 - remocao do budget do prompt do builder (R10, sem DB)', () => {
  it('R10 metade 1: o seed .ts nao instrui mais "Respeite o budget" (fresh installs)', () => {
    const prompt = dynamicWorkflowBuilder.systemPrompt;
    expect(prompt).toContain(NEW_LINE);
    expect(prompt).not.toContain(OLD_LINE);
    expect(prompt.toLowerCase()).not.toContain('budget');
  });

  it('R10 metade 2: a V132 troca a LINHA antiga pela nova, guardada por LIKE (preserva customizacao)', () => {
    expect(V132_SOURCE).toContain(OLD_LINE);
    expect(V132_SOURCE).toContain(NEW_LINE);
    expect(V132_SOURCE).toContain('SET system_prompt = replace(system_prompt, ?, ?)');
    expect(V132_SOURCE).toContain("WHERE id = 'dynamic-workflow-builder'");
    expect(V132_SOURCE).toMatch(/LIKE '%' \|\| \? \|\| '%'/);
    expect(V132_SOURCE).not.toContain('SET id');
    expect(V132_SOURCE).not.toContain('SET name');
    expect(V132_SOURCE).not.toContain('SET squad');
  });

  it('a migration esta registrada no runner de migrations do db.ts', () => {
    const dbSrc = readFileSync(join(__dirname, '..', 'db.ts'), 'utf8');
    expect(dbSrc).toContain(
      "import { applyMigrationV132 } from './db-migrations/v132-dynamic-workflow-budget-removal'",
    );
    expect(dbSrc).toContain('if (currentVersion < 132)');
    expect(dbSrc).toContain('applyMigrationV132(db)');
    expect(dbSrc).toMatch(/INSERT INTO schema_version \(version\) VALUES \(\?\)'\)\.run\(132\)/);
  });
});
