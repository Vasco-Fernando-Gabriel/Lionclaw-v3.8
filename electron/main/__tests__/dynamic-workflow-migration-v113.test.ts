
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dynamicWorkflowBuilder } from '../seed-agents/dynamic-workflow-builder';

const MIGRATIONS_DIR = join(__dirname, '..', 'db-migrations');

function readMigration(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
}

function grabBlock(source: string, name: string): string {
  const match = source.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  if (!match) throw new Error('bloco ' + name + ' nao encontrado');
  return match[1];
}

function grabMarker(source: string, name: string): string {
  const match = source.match(new RegExp('const ' + name + " = '([^']*)';"));
  if (!match) throw new Error('marcador ' + name + ' nao encontrado');
  return match[1];
}

const V113_SOURCE = readMigration('v113-dynamic-workflow-builder-refute.ts');
const V111_SOURCE = readMigration('v111-dynamic-workflow-builder-green-check.ts');

describe('migration v113 dynamic-workflow builder refute no dev-loop (R10, sem DB)', () => {
  it('R10 metade 1: a V114 SUPERSEDE partes da secao da V113 no seed; o nucleo da V113 sobrevive', () => {
    const neu = grabBlock(V113_SOURCE, 'NEW_SECTION');
    expect(neu).toContain('por where/ref, 1:1'); // ensino antigo vivia no NEW da V113
    expect(dynamicWorkflowBuilder.systemPrompt).not.toContain('por where/ref, 1:1'); // trocado pela V114
    expect(dynamicWorkflowBuilder.systemPrompt).toContain('green-check do host VERDE (green.ok, gate deterministico)');
    expect(dynamicWorkflowBuilder.systemPrompt).toContain('AND de DUAS condicoes INDEPENDENTES');
    expect(dynamicWorkflowBuilder.systemPrompt).toContain('FAIL-CLOSED');
    expect(dynamicWorkflowBuilder.systemPrompt).toContain('correlaciona por ID ESTAVEL'); // supersession V114
    expect(dynamicWorkflowBuilder.systemPrompt).toContain('SEMPRE passe o sprintIndex'); // supersession V114
  });

  it('o OLD_SECTION ancora na secao do green-check da V111 (REPLACE substitui a secao inteira)', () => {
    const oldSection = grabBlock(V113_SOURCE, 'OLD_SECTION');
    const newSection = grabBlock(V113_SOURCE, 'NEW_SECTION');
    expect(oldSection).toContain('MESCLAR os findings dela no MESMO set de convergencia');
    expect(oldSection).toContain('## Regras do workflow.js (subset ESM restrito)');
    expect(newSection).not.toContain('MESCLAR os findings dela no MESMO set de convergencia');
    expect(dynamicWorkflowBuilder.systemPrompt).not.toContain('MESCLAR os findings dela no MESMO set de convergencia');
    expect(newSection).toContain('## Regras do workflow.js (subset ESM restrito)');
    expect(dynamicWorkflowBuilder.systemPrompt).toContain('## Regras do workflow.js (subset ESM restrito)');
  });

  it('o OLD_SECTION da V113 e EXATAMENTE o NEW_SECTION da V111 (sem drift na cadeia v111->v113)', () => {
    const v111New = grabBlock(V111_SOURCE, 'NEW_SECTION');
    const v113Old = grabBlock(V113_SOURCE, 'OLD_SECTION');
    expect(v111New).toContain(v113Old);
  });

  it('o NEW_MARKER (frase corrigida do green.ok gate) e exclusivo do NEW: guard idempotente', () => {
    const marker = grabMarker(V113_SOURCE, 'NEW_MARKER');
    const oldSection = grabBlock(V113_SOURCE, 'OLD_SECTION');
    const newSection = grabBlock(V113_SOURCE, 'NEW_SECTION');
    expect(marker).toBe('green-check do host VERDE (green.ok, gate deterministico)');
    expect(newSection).toContain(marker);
    expect(oldSection).not.toContain(marker);
  });

  it('o comportamento muda: refuter julga SO validadores; green.ok e gate separado; fail-closed', () => {
    const neu = grabBlock(V113_SOURCE, 'NEW_SECTION');
    expect(neu).toContain('no REFUTER');
    expect(neu).toContain('schemas/refute.schema.json');
    expect(neu).toContain("verdict==='real'");
    expect(neu).toContain('severityConfirmada em {P1,P2}');
    expect(neu).toContain('SEQUENCIA OBRIGATORIA');
    expect(neu).toContain('NAO rebaixa severidade');
    expect(neu).toContain('gate DETERMINISTICO SEPARADO');
    expect(neu).toContain('NAO entram no refuter');
    expect(neu).toContain('AND de DUAS condicoes INDEPENDENTES');
    expect(neu).toContain('FAIL-CLOSED');
    expect(neu).toContain('NAO pode auto-convergir a sprint');
  });

  it('idempotencia + alvo: UPDATE em dynamic-workflow-builder com guard NOT LIKE', () => {
    expect(V113_SOURCE).toContain("WHERE id = 'dynamic-workflow-builder'");
    expect(V113_SOURCE).toContain('REPLACE(system_prompt');
    expect(V113_SOURCE).toContain('system_prompt LIKE ?');
    expect(V113_SOURCE).toContain('system_prompt NOT LIKE ?');
    const updateCount = (V113_SOURCE.match(/UPDATE agents SET system_prompt = REPLACE/g) || []).length;
    expect(updateCount).toBe(1);
  });

  it('zero em-dash (U+2014) no source da migration v113', () => {
    const EM_DASH = String.fromCharCode(0x2014);
    expect(V113_SOURCE).not.toContain(EM_DASH);
  });
});
