import { describe, it, expect } from 'vitest';
import { buildDynamicWorkflowSection } from '../prompt-builder';

describe('D16/D19: secao dynamic-workflow do prompt (regras curtas + semaforo)', () => {
  const section = buildDynamicWorkflowSection();

  it('respeita o teto de 4.000 chars (D16)', () => {
    expect(section.length).toBeLessThanOrEqual(4000);
  });

  it('mantem o header que o teste de capabilities usa como ancora', () => {
    expect(section.startsWith('## Dirigir Workflows Dinamicos (tools dynamic-workflow)')).toBe(true);
  });

  it('autoria: guia obrigatorio antes de author e template morto nao lido (D16)', () => {
    expect(section).toContain('authoring_guide');
    expect(section).toMatch(/ANTES de todo author/);
    expect(section).toContain('workflow-templates');
    expect(section).toMatch(/copia morta/);
  });

  it('autoria: proibicoes fatais e lista fechada de agentType (D17/D18)', () => {
    expect(section).toContain('PROIBIDO');
    expect(section).toContain('gate()');
    expect(section).toContain('materializeSprintPlan');
    expect(section).toContain('timeoutMs');
    expect(section).toContain('45 min');
    expect(section).toContain('writer com schema');
    expect(section).toContain('sprintIndex');
    expect(section).toMatch(/ordenacao canonica/);
    expect(section).toMatch(/closer\/narrator\/maestro/);
    expect(section).toMatch(
      /scout, doc-writer, coder\/-codex\/-glm, fixer, validator-spec\/-regression\/-tests, refuter, sprint-planner, plan-validator-\*/,
    );
  });

  it('autoria: doutrina de passos curtos resumida', () => {
    expect(section).toContain('ARQUIVOS TOCADOS');
    expect(section).toContain('greenCheck({ final: false })');
    expect(section).toMatch(/P1 confirmado-real/);
    expect(section).toMatch(/UMA rodada de 3 validadores/);
  });

  it('wake por semaforo (D19): as 5 linhas do semaforo com as acoes certas', () => {
    expect(section).toContain('SEMAFORO');
    expect(section).toContain('ok, seguindo');
    expect(section).toMatch(/SEMAFORO: VERDE => responda 'ok, seguindo'\. Nao chame tools\./);
    expect(section).toContain('boundary:');
    expect(section).toContain('rerun-node');
    expect(section).toMatch(/SEM VEREDITO[\s\S]*dynamic_workflow_inspect/);
    expect(section).toMatch(/Nunca aprove SEM VEREDITO sem antes rerun-node/);
    expect(section).toContain('DECISAO NECESSARIA');
    expect(section).toContain('DECISAO HUMANA');
    expect(section).toMatch(/ate 5 linhas/);
    expect(section).toMatch(/Nunca autore novo run com o atual vivo/);
  });

  it('mantem a mencao a dynamic_workflow_inspect antes de agir em gates', () => {
    expect(section).toMatch(/dynamic_workflow_inspect\(runId\)[^\n]*Use SEMPRE antes de agir num gate/);
  });

  it('intervene anuncia rerun-node, switch-agent e adjust-next-node com "*"', () => {
    expect(section).toMatch(/rerun-node \{ nodeId, instruction \}/);
    expect(section).toMatch(/switch-agent \{ nodeId, newAgentId, reason \}/);
    expect(section).toMatch(/adjust-next-node \{ nodeId ou "\*", instruction \}/);
  });

  it('sem em-dash, sem acentos (estilo do prompt-builder)', () => {
    expect(section).not.toMatch(/[–—]/);
    expect(section).not.toMatch(/[À-ÿ]/);
  });
});
