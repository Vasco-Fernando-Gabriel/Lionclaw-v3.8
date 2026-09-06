import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { buildDynamicWorkflowSection } from '../prompt-builder';

describe('F4-prompt: guidance de autoria conversacional (dynamic_workflow_author)', () => {
  const section = buildDynamicWorkflowSection();

  it('anuncia a tool dynamic_workflow_author com seus parametros', () => {
    expect(section).toContain('dynamic_workflow_author(projectPath, name?, workflowJsSource, start?)');
  });

  it('explica o formato claude-code do .js (meta literal + primitivas)', () => {
    expect(section).toContain('export const meta = { name, description }');
    expect(section).toContain('agent(prompt, { agentType, label?, phase?, schema?, model?, effort? })');
    expect(section).toContain('SEM mudar a fase corrente');
    expect(section).toContain('parallel(');
    expect(section).toContain('global `args`');
  });

  it('frisa a regra dura: agentType string literal, squad allowlist dynamic-workflow', () => {
    expect(section).toContain('STRING LITERAL');
    expect(section).toContain('squad "dynamic-workflow"');
    expect(section).toMatch(/REJEITADO/);
  });

  it('permite writers da squad sob o gate de entrega cc-delivery (sem push)', () => {
    expect(section).toContain('WRITER da squad "dynamic-workflow" SAO permitidos');
    expect(section).toContain('cc-delivery');
    expect(section).toContain('dynamic-workflow-doc-writer');
    expect(section).toMatch(/push sempre bloqueado/);
  });

  it('S4: guidance de model/effort POR NODE (dinamismo conforme a conversa com o humano)', () => {
    expect(section).toContain('DINAMISMO POR NODE');
    expect(section).toContain('"low" | "medium" | "high" | "xhigh" | "max" | "ultra"');
    expect(section).toContain('NUNCA escolha "ultra" por conta propria');
    expect(section).toContain('REGRA INTRA-FAMILIA');
    expect(section).toContain('model-cross-family');
    expect(section).toMatch(/Matriz por runtime no guia/);
  });

  it('mantem a descricao MCP alinhada com Kimi model-aware e Grok executavel', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../../mcp-servers/lionclaw-dynamic-workflows/src/index.ts'),
      'utf8',
    );
    expect(source).toContain('grok-* on grok');
    expect(source).toContain('tiered Kimi models accept only their advertised tiers');
    expect(source).toContain('boolean-only Kimi models reject explicit effort');
    expect(source).toContain('Grok accepts low/medium/high and executes authored nodes');
  });

  it('anuncia os casos de uso reais (analise, criacao de documentos/specs, dev)', () => {
    expect(section).toContain('analise/validacao de codigo');
    expect(section).toContain('CRIACAO de documentos/specs');
    expect(section).toContain('desenvolvimento de codigo');
  });

  it('anuncia author como a UNICA via de criacao (generate/generate_and_start removidos)', () => {
    expect(section).toContain('UNICA via de criacao');
    expect(section).not.toContain('dynamic_workflow_generate');
    expect(section).not.toContain('generate_and_start');
  });
});
