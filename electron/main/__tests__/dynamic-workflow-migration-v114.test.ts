import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dynamicWorkflowBuilder } from '../seed-agents/dynamic-workflow-builder';
import { dynamicWorkflowRefuter } from '../seed-agents/dynamic-workflow-refuter';

const MIGRATIONS_DIR = join(__dirname, '..', 'db-migrations');

function readMigration(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
}

function grabBlock(source: string, name: string): string {
  const match = source.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  if (!match) throw new Error('bloco ' + name + ' nao encontrado');
  return match[1];
}

const V114_SOURCE = readMigration('v114-dynamic-workflow-greencheck-cwd-refuter-id.ts');

describe('migration v114 green-check cwd + refuter id (R10, sem DB)', () => {
  it('R10 metade 1: cada NEW aparece VERBATIM no seed certo (fresh installs)', () => {
    expect(dynamicWorkflowBuilder.systemPrompt).toContain(grabBlock(V114_SOURCE, 'BUILDER_CWD_NEW'));
    expect(dynamicWorkflowBuilder.systemPrompt).toContain(grabBlock(V114_SOURCE, 'BUILDER_ID_NEW'));
    expect(dynamicWorkflowRefuter.systemPrompt).toContain(grabBlock(V114_SOURCE, 'REFUTER_REF_NEW'));
  });

  it('o ensino antigo (por where / ref where-ou-id) NAO sobrevive nos seeds POS-V114', () => {
    expect(dynamicWorkflowBuilder.systemPrompt).not.toContain('por where/ref, 1:1');
    expect(dynamicWorkflowBuilder.systemPrompt).not.toContain('colisao de varios no mesmo where');
    expect(dynamicWorkflowRefuter.systemPrompt).not.toContain('o where (ou id) do finding original');
    expect(dynamicWorkflowBuilder.systemPrompt).toContain('correlaciona por ID ESTAVEL');
    expect(dynamicWorkflowBuilder.systemPrompt).toContain('SEMPRE passe o sprintIndex');
    expect(dynamicWorkflowRefuter.systemPrompt).toContain('o id EXATO do finding original');
  });

  it('cada REPLACE e idempotente: OLD existe e o marcador do NEW e exclusivo dele', () => {
    const pairs: Array<[string, string, string]> = [
      ['BUILDER_CWD_OLD', 'BUILDER_CWD_NEW', 'BUILDER_CWD_MARKER'],
      ['BUILDER_ID_OLD', 'BUILDER_ID_NEW', 'BUILDER_ID_MARKER'],
      ['REFUTER_REF_OLD', 'REFUTER_REF_NEW', 'REFUTER_REF_MARKER'],
    ];
    for (const [, neuName, markerName] of pairs) {
      const neu = grabBlock(V114_SOURCE, neuName);
      const marker = V114_SOURCE.match(new RegExp('const ' + markerName + " = '([^']*)';"))![1];
      expect(neu).toContain(marker);
    }
    const v113 = readMigration('v113-dynamic-workflow-builder-refute.ts');
    expect(v113).toContain(grabBlock(V114_SOURCE, 'BUILDER_ID_OLD'));
  });

  it('3 UPDATEs nos agentes certos (builder x2, refuter x1)', () => {
    const updates = (V114_SOURCE.match(/UPDATE agents SET system_prompt = REPLACE/g) || []).length;
    expect(updates).toBe(3);
    expect((V114_SOURCE.match(/id = 'dynamic-workflow-builder'/g) || []).length).toBe(2);
    expect((V114_SOURCE.match(/id = 'dynamic-workflow-refuter'/g) || []).length).toBe(1);
  });

  it('zero em-dash (U+2014) no source da migration v114', () => {
    expect(V114_SOURCE).not.toContain(String.fromCharCode(0x2014));
  });
});
