
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dynamicWorkflowValidatorTests } from '../seed-agents/dynamic-workflow-validator-tests';

const MIGRATIONS_DIR = join(__dirname, '..', 'db-migrations');

function readMigration(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
}

function grabBlock(source: string, name: string): string {
  const match = source.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  if (!match) throw new Error('bloco ' + name + ' nao encontrado');
  return match[1];
}

const V109_SOURCE = readMigration(
  'v109-dynamic-workflow-validator-tests-no-containment.ts',
);

const BLOCKS: Array<{ old: string; neu: string }> = [
  { old: 'AXIS_OLD', neu: 'AXIS_NEW' },
  { old: 'STEP3_OLD', neu: 'STEP3_NEW' },
  { old: 'OUTPUT_OLD', neu: 'OUTPUT_NEW' },
];

describe('migration v109 dynamic-workflow validator-tests sem containment (R10, sem DB)', () => {
  it('R10 metade 1: cada NEW_BLOCK aparece VERBATIM no seed .ts (fresh installs)', () => {
    for (const { neu } of BLOCKS) {
      const block = grabBlock(V109_SOURCE, neu);
      expect(dynamicWorkflowValidatorTests.systemPrompt).toContain(block);
    }
  });

  it('cada OLD_BLOCK sumiu do seed .ts (foi substituido)', () => {
    for (const { old } of BLOCKS) {
      const block = grabBlock(V109_SOURCE, old);
      expect(dynamicWorkflowValidatorTests.systemPrompt).not.toContain(block);
    }
  });

  it('o comportamento muda: containment de writeSet deixa de ser finding P1', () => {
    const step3New = grabBlock(V109_SOURCE, 'STEP3_NEW');
    expect(step3New).toContain('enforcement do writeSet foi desligado');
    expect(step3New).toContain('NAO e finding');
    const step3Old = grabBlock(V109_SOURCE, 'STEP3_OLD');
    expect(step3Old).toContain('e finding P1');
    expect(step3New).not.toContain('e finding P1');
  });

  it('idempotencia + alvo: UPDATE em validator-tests com guard LIKE %OLD%', () => {
    expect(V109_SOURCE).toContain("WHERE id = 'dynamic-workflow-validator-tests'");
    expect(V109_SOURCE).toContain('REPLACE(system_prompt');
    expect(V109_SOURCE).toContain('system_prompt LIKE ?');
  });

  it('zero em-dash (U+2014) no source da migration v109', () => {
    const EM_DASH = String.fromCharCode(0x2014);
    expect(V109_SOURCE).not.toContain(EM_DASH);
  });
});
