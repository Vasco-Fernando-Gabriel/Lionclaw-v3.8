
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dynamicWorkflowMaestro } from '../seed-agents/dynamic-workflow-builder';

const V131_SOURCE = readFileSync(
  join(__dirname, '..', 'db-migrations', 'v131-dynamic-workflow-maestro-narrator.ts'),
  'utf8',
);

function grabTemplate(source: string, name: string): string {
  const match = source.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  if (!match) throw new Error('bloco ' + name + ' nao encontrado');
  return match[1];
}

const CONTROL_TOOLS = [
  'dynamic_workflow_approve',
  'dynamic_workflow_intervene',
  'dynamic_workflow_edit_coordinator',
  'dynamic_workflow_abort',
  'dynamic_workflow_reply',
  'dynamic_workflow_inspect',
];

describe('migration v131 - maestro vira narrador puro (R10, sem DB)', () => {
  it('R10 metade 1: o seed .ts e narrador puro (fresh installs)', () => {
    const prompt = dynamicWorkflowMaestro.systemPrompt;
    expect(prompt).toContain('NARRADOR');
    expect(prompt).toContain('1 a 3 frases por marco');
    expect(prompt).toContain('Voce NAO controla o run');
    expect(prompt).toContain('NUNCA aprova, rejeita, pausa, retoma, aborta');
    for (const tool of CONTROL_TOOLS) {
      expect(prompt, `prompt do narrador menciona ${tool}`).not.toContain(tool);
    }
    expect(prompt).not.toContain('PLANO DE CONTROLE');
    expect(prompt).not.toContain('aprova a entrega');
  });

  it('a description nova tambem e de narrador (nao "autor e controlador")', () => {
    expect(dynamicWorkflowMaestro.description).toContain('narra os marcos do run');
    expect(dynamicWorkflowMaestro.description).toContain('nunca aprova, intervem ou executa');
    expect(dynamicWorkflowMaestro.description).not.toContain('Autor e controlador');
  });

  it('R10 metade 2: o OLD hardcoded e o prompt de CONTROLE antigo (pos-v103)', () => {
    const old = grabTemplate(V131_SOURCE, 'OLD_MAESTRO_PROMPT');
    expect(old).toContain('PLANO DE CONTROLE');
    expect(old).toContain('dynamic_workflow_approve');
    expect(old).toContain('dynamic_workflow_edit_coordinator');
    expect(old).toContain('DEPOIS de chamar uma tool de controle');
    expect(old).not.toBe(dynamicWorkflowMaestro.systemPrompt);
  });

  it('UPDATE guardado por igualdade estrita (preserva customizacao) e NEW importado do seed', () => {
    expect(V131_SOURCE).toContain(
      "UPDATE agents SET system_prompt = ? WHERE id = 'dynamic-workflow-maestro' AND system_prompt = ?",
    );
    expect(V131_SOURCE).toContain(
      "UPDATE agents SET description = ? WHERE id = 'dynamic-workflow-maestro' AND description = ?",
    );
    expect(V131_SOURCE).toContain('dynamicWorkflowMaestro.systemPrompt');
    expect(V131_SOURCE).toContain('dynamicWorkflowMaestro.description');
    expect(V131_SOURCE).not.toContain('SET id');
    expect(V131_SOURCE).not.toContain('SET name');
    expect(V131_SOURCE).not.toContain('SET squad');
  });

  it('a migration esta registrada no runner de migrations do db.ts', () => {
    const dbSrc = readFileSync(join(__dirname, '..', 'db.ts'), 'utf8');
    expect(dbSrc).toContain(
      "import { applyMigrationV131 } from './db-migrations/v131-dynamic-workflow-maestro-narrator'",
    );
    expect(dbSrc).toContain('if (currentVersion < 131)');
    expect(dbSrc).toContain('applyMigrationV131(db)');
    expect(dbSrc).toMatch(/INSERT INTO schema_version \(version\) VALUES \(\?\)'\)\.run\(131\)/);
  });
});
