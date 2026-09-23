import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dynamicWorkflowBuilder } from '../seed-agents/dynamic-workflow-builder';
import { DEV_FRESH_FIXER_STUCK_THRESHOLD } from '../dynamic-workflows/dev-loop-ids';

const V133_SOURCE = readFileSync(
  join(__dirname, '..', 'db-migrations', 'v133-dynamic-workflow-fresh-fixer.ts'),
  'utf8',
).replace(/\r\n/g, '\n');

function grabBlock(source: string, name: string): string {
  const match = source.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  if (!match) throw new Error('bloco ' + name + ' nao encontrado');
  return match[1];
}

const ANCHOR_LINE = '## Regras do manifest';
const NEW_MARKER = '## Fresh fixer: cerebro novo apos nao-progresso persistente';

describe('migration v133 - fresh fixer no prompt do builder (R10, sem DB)', () => {
  it('R10 metade 1: a NEW_SECTION aparece VERBATIM no seed .ts (fresh installs)', () => {
    const section = grabBlock(V133_SOURCE, 'NEW_SECTION');
    expect(section.length).toBeGreaterThan(0);
    expect(dynamicWorkflowBuilder.systemPrompt).toContain(section);
  });

  it('placement: a secao precede imediatamente "## Regras do manifest" (fora do bloco da V118)', () => {
    const section = grabBlock(V133_SOURCE, 'NEW_SECTION');
    expect(dynamicWorkflowBuilder.systemPrompt).toContain(section + '\n\n' + ANCHOR_LINE);
  });

  it('ensino-chave no seed: threshold 2, contrato de id do fixer, reframe mantido, fail-safe pro coder', () => {
    const p = dynamicWorkflowBuilder.systemPrompt;
    expect(p).toContain('stuck >= 2');
    expect(p).toContain('fixer-s{S}-r{R}');
    expect(p).toContain('Cerebro fresco + reframe, nao so reframe');
    expect(p).toContain('NUNCA falhe o run por isso');
    expect(DEV_FRESH_FIXER_STUCK_THRESHOLD).toBe(2);
  });

  it('R10 metade 2: a V133 insere na LINHA-ancora, guardada por LIKE + NOT LIKE (idempotente)', () => {
    expect(V133_SOURCE).toContain(`const ANCHOR_LINE = '${ANCHOR_LINE}';`);
    expect(V133_SOURCE).toContain(NEW_MARKER);
    expect(V133_SOURCE).toContain('SET system_prompt = replace(system_prompt, ?, ?)');
    expect(V133_SOURCE).toContain("WHERE id = 'dynamic-workflow-builder'");
    expect(V133_SOURCE).toMatch(/LIKE '%' \|\| \? \|\| '%'/);
    expect(V133_SOURCE).toMatch(/NOT LIKE '%' \|\| \? \|\| '%'/);
    expect(ANCHOR_LINE.includes(NEW_MARKER)).toBe(false);
    expect(V133_SOURCE).not.toContain('SET id');
    expect(V133_SOURCE).not.toContain('SET name');
    expect(V133_SOURCE).not.toContain('SET squad');
  });

  it('nao-interferencia: a secao Retry efetivo (V118) segue intacta e imediatamente antes de "## Regras do workflow.js"', () => {
    const p = dynamicWorkflowBuilder.systemPrompt;
    expect(p).toContain(
      '- stuck=0 quando NAO ha repeticao: o retry normal segue barato; o reframe so entra quando o agente esta de fato preso nos mesmos blockers.\n\n## Regras do workflow.js (subset ESM restrito)',
    );
  });

  it('a migration esta registrada no runner de migrations do db.ts', () => {
    const dbSrc = readFileSync(join(__dirname, '..', 'db.ts'), 'utf8');
    expect(dbSrc).toContain("import { applyMigrationV133 } from './db-migrations/v133-dynamic-workflow-fresh-fixer'");
    expect(dbSrc).toContain('if (currentVersion < 133)');
    expect(dbSrc).toContain('applyMigrationV133(db)');
    expect(dbSrc).toMatch(/INSERT INTO schema_version \(version\) VALUES \(\?\)'\)\.run\(133\)/);
  });

  it('zero em-dash (U+2014) no source da migration v133', () => {
    const EM_DASH = String.fromCharCode(0x2014);
    expect(V133_SOURCE).not.toContain(EM_DASH);
  });
});
