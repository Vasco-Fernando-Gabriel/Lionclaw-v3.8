
import { describe, it, expect } from 'vitest';
import { getDevV2Briefing } from '../pipeline-engine/dev-v2-briefings';
import type { DevelopmentV2SprintMetadata } from '../../../src/types/pipeline';
import { harnessPlanner } from '../seed-agents/harness-planner';
import { sprintValidator } from '../seed-agents/sprint-validator';
import { pipe2PrdCompleto } from '../seed-agents/pipe2-prd-completo';
import { pipe2TechFrontend } from '../seed-agents/pipe2-tech-frontend';
import { pipe2SpecBuilder } from '../seed-agents/pipe2-spec-builder';
import { pipe2SpecValidator } from '../seed-agents/pipe2-spec-validator';
import { pipe2SpecEnricher } from '../seed-agents/pipe2-spec-enricher';


describe('getDevV2Briefing: per-agent trechos', () => {
  it('returns briefing for prd-generator (SPEC 12.1)', () => {
    const b = getDevV2Briefing('prd-generator');
    expect(b).not.toBeNull();
    expect(b).toContain('Development Pipeline 2.0');
    expect(b).toContain('fonte de verdade para a fase Open Design');
    expect(b).toContain('tela, menu, formulario, dashboard');
  });

  it('returns briefing for prd-validator (SPEC 12.2)', () => {
    const b = getDevV2Briefing('prd-validator');
    expect(b).not.toBeNull();
    expect(b).toContain('validando stories antes da fase Open Design');
    expect(b).toContain('escopo, ator, acao, beneficio e criterios de aceite');
  });

  it('returns briefing for tech-database (SPEC 12.4)', () => {
    const b = getDevV2Briefing('tech-database');
    expect(b).not.toBeNull();
    expect(b).toContain('agente Database do Development Pipeline 2.0');
    expect(b).toContain('design-contract.json');
    expect(b).toContain('dataRequirements');
    expect(b).toContain('Edite apenas a secao "### Database"');
  });

  it('returns briefing for tech-backend (SPEC 12.5)', () => {
    const b = getDevV2Briefing('tech-backend');
    expect(b).not.toBeNull();
    expect(b).toContain('agente Backend do Development Pipeline 2.0');
    expect(b).toContain('design-contract.json');
    expect(b).toContain('apiExpectation');
    expect(b).toContain('Edite apenas a secao "### Backend"');
  });

  it('returns briefing for tech-security (SPEC 12.7)', () => {
    const b = getDevV2Briefing('tech-security');
    expect(b).not.toBeNull();
    expect(b).toContain('agente Security do Development Pipeline 2.0');
    expect(b).toContain('design-contract.json');
    expect(b).toContain('rotas protegidas');
    expect(b).toContain('Edite apenas a secao "### Security"');
  });

  it('returns briefing for sprint-validator (touchesUI rule)', () => {
    const b = getDevV2Briefing('sprint-validator');
    expect(b).not.toBeNull();
    expect(b).toContain('touchesUI=true');
    expect(b).toContain('affectedScreenIds');
  });

  it('returns null for discovery-agent (no briefing needed)', () => {
    const b = getDevV2Briefing('discovery-agent');
    expect(b).toBeNull();
  });

  it('returns null for unknown agent', () => {
    const b = getDevV2Briefing('some-random-agent');
    expect(b).toBeNull();
  });
});


describe('getDevV2Briefing: planner briefing with context', () => {
  it('returns briefing for harness-planner with screenIds and componentIds', () => {
    const b = getDevV2Briefing('harness-planner', {
      screenIds: ['screen-dashboard', 'screen-login'],
      componentIds: ['comp-nav', 'comp-form'],
    });
    expect(b).not.toBeNull();
    expect(b).toContain('Development Pipeline 2.0');
    expect(b).toContain('touchesUI');
    expect(b).toContain('affectedScreenIds');
    expect(b).toContain('affectedComponentIds');
    expect(b).toContain('screen-dashboard');
    expect(b).toContain('screen-login');
    expect(b).toContain('comp-nav');
    expect(b).toContain('comp-form');
  });

  it('returns briefing with empty lists when no context provided', () => {
    const b = getDevV2Briefing('harness-planner');
    expect(b).not.toBeNull();
    expect(b).toContain('touchesUI');
    expect(b).toContain('nenhum screen encontrado');
    expect(b).toContain('nenhum componente encontrado');
  });

  it('returns briefing with empty arrays when context has empty arrays', () => {
    const b = getDevV2Briefing('harness-planner', { screenIds: [], componentIds: [] });
    expect(b).not.toBeNull();
    expect(b).toContain('nenhum screen encontrado');
    expect(b).toContain('nenhum componente encontrado');
  });

  it('lists each screenId on its own line', () => {
    const screenIds = ['screen-a', 'screen-b', 'screen-c'];
    const b = getDevV2Briefing('harness-planner', { screenIds, componentIds: [] });
    expect(b).not.toBeNull();
    expect(b).toContain('  - screen-a');
    expect(b).toContain('  - screen-b');
    expect(b).toContain('  - screen-c');
  });
});


describe('getDevV2Briefing: coder briefing', () => {
  it('returns null when no context provided', () => {
    const b = getDevV2Briefing('harness-coder');
    expect(b).toBeNull();
  });

  it('returns null when touchesUI=false', () => {
    const meta: DevelopmentV2SprintMetadata = {
      touchesUI: false,
      affectedScreenIds: [],
      affectedComponentIds: [],
    };
    const b = getDevV2Briefing('harness-coder', { sprintMetadata: meta });
    expect(b).toBeNull();
  });

  it('returns briefing when touchesUI=true', () => {
    const meta: DevelopmentV2SprintMetadata = {
      touchesUI: true,
      affectedScreenIds: ['screen-dashboard'],
      affectedComponentIds: ['comp-sidebar'],
      designArtifactPath: '/path/to/artifact/index.html',
    };
    const b = getDevV2Briefing('harness-coder', { sprintMetadata: meta });
    expect(b).not.toBeNull();
    expect(b).toContain('Esta sprint toca UI');
    expect(b).toContain('/path/to/artifact/index.html');
    expect(b).toContain('screen-dashboard');
    expect(b).toContain('comp-sidebar');
  });

  it('includes "Telas afetadas" and "Componentes afetados" labels', () => {
    const meta: DevelopmentV2SprintMetadata = {
      touchesUI: true,
      affectedScreenIds: ['screen-a', 'screen-b'],
      affectedComponentIds: ['comp-x'],
      designArtifactPath: '/artifact/index.html',
    };
    const b = getDevV2Briefing('harness-coder', { sprintMetadata: meta });
    expect(b).toContain('Telas afetadas:');
    expect(b).toContain('Componentes afetados:');
    expect(b).toContain('screen-a, screen-b');
    expect(b).toContain('comp-x');
  });

  it('handles empty affectedScreenIds gracefully when touchesUI=true', () => {
    const meta: DevelopmentV2SprintMetadata = {
      touchesUI: true,
      affectedScreenIds: [],
      affectedComponentIds: [],
    };
    const b = getDevV2Briefing('harness-coder', { sprintMetadata: meta });
    expect(b).not.toBeNull();
    expect(b).toContain('Esta sprint toca UI');
    expect(b).toContain('(nao especificado)');
  });
});


describe('getDevV2Briefing: sprint-validator touchesUI rule', () => {
  it('briefing mentions the fail condition', () => {
    const b = getDevV2Briefing('sprint-validator');
    expect(b).not.toBeNull();
    expect(b).toContain('[FAIL]');
    expect(b).toContain('touchesUI=true');
    expect(b).toContain('affectedScreenIds');
    expect(b).toContain('design-contract.json');
  });

  it('briefing does not return null', () => {
    expect(getDevV2Briefing('sprint-validator')).not.toBeNull();
  });
});


describe('DevelopmentV2SprintMetadata type', () => {
  it('can create a valid touchesUI=true instance', () => {
    const meta: DevelopmentV2SprintMetadata = {
      touchesUI: true,
      affectedScreenIds: ['screen-1'],
      affectedComponentIds: ['comp-1'],
      designArtifactPath: '/path/artifact.html',
    };
    expect(meta.touchesUI).toBe(true);
    expect(meta.affectedScreenIds).toHaveLength(1);
    expect(meta.affectedComponentIds).toHaveLength(1);
    expect(meta.designArtifactPath).toBe('/path/artifact.html');
  });

  it('can create a valid touchesUI=false instance without designArtifactPath', () => {
    const meta: DevelopmentV2SprintMetadata = {
      touchesUI: false,
      affectedScreenIds: [],
      affectedComponentIds: [],
    };
    expect(meta.touchesUI).toBe(false);
    expect(meta.designArtifactPath).toBeUndefined();
  });
});


describe('pipe2-* seed agents: final prompts', () => {
  it('pipe2-prd-completo has final prompt (not placeholder)', () => {
    expect(pipe2PrdCompleto.systemPrompt).not.toContain('Prompt placeholder');
    expect(pipe2PrdCompleto.systemPrompt).toContain('Development Pipeline 2.0');
    expect(pipe2PrdCompleto.systemPrompt).toContain('design-contract.json travado');
    expect(pipe2PrdCompleto.systemPrompt).toContain('Design Lock');
  });

  it('pipe2-tech-frontend has final prompt (not placeholder)', () => {
    expect(pipe2TechFrontend.systemPrompt).not.toContain('Prompt placeholder');
    expect(pipe2TechFrontend.systemPrompt).toContain('Frontend Tecnico do Development Pipeline 2.0');
    expect(pipe2TechFrontend.systemPrompt).toContain('artifact/index.html');
    expect(pipe2TechFrontend.systemPrompt).toContain('Proibido');
    expect(pipe2TechFrontend.systemPrompt).toContain('criar nova tela');
  });

  it('pipe2-spec-builder has final prompt with section 4.8', () => {
    expect(pipe2SpecBuilder.systemPrompt).not.toContain('Prompt placeholder');
    expect(pipe2SpecBuilder.systemPrompt).toContain('Spec Builder do Development Pipeline 2.0');
    expect(pipe2SpecBuilder.systemPrompt).toContain('4.8 Metadados para Planejamento de Sprints UI');
    expect(pipe2SpecBuilder.systemPrompt).toContain('DevelopmentV2SprintMetadata');
    expect(pipe2SpecBuilder.systemPrompt).toContain('touchesUI');
    expect(pipe2SpecBuilder.systemPrompt).toContain('affectedScreenIds');
    expect(pipe2SpecBuilder.systemPrompt).toContain('design-contract.json');
  });

  it('pipe2-spec-validator has final prompt', () => {
    expect(pipe2SpecValidator.systemPrompt).not.toContain('Prompt placeholder');
    expect(pipe2SpecValidator.systemPrompt).toContain('design lock');
    expect(pipe2SpecValidator.systemPrompt).toContain('[MISS]');
    expect(pipe2SpecValidator.systemPrompt).toContain('[CONFLICT]');
  });

  it('pipe2-spec-validator prompt uses "## Status:" header and "spec-validation.md" filename (SPEC-007 Correcao #3 regression guard)', () => {
    const prompt = pipe2SpecValidator.systemPrompt;
    expect(prompt).toContain('## Status:');
    expect(prompt).toContain('## Status: PASS');
    expect(prompt).toContain('## Status: FAIL');
    expect(prompt).toContain('spec-validation.md');
    expect(prompt).not.toContain('validation-report.md');
    expect(prompt).not.toContain('- Status: PASS');
    expect(prompt).not.toContain('- Status: FAIL');
  });

  it('pipe2-spec-enricher has final prompt with design lock restriction', () => {
    expect(pipe2SpecEnricher.systemPrompt).not.toContain('Prompt placeholder');
    expect(pipe2SpecEnricher.systemPrompt).toContain('design lock');
    expect(pipe2SpecEnricher.systemPrompt).toContain('nao pode criar novas telas');
  });
});


describe('reused agents: systemPrompt snapshot (unchanged)', () => {
  it('harness-planner systemPrompt is unchanged (contains key sentinel phrases)', () => {
    expect(harnessPlanner.systemPrompt).toContain('Harness Planner');
    expect(harnessPlanner.systemPrompt).toContain('Coder comeca com contexto ZERADO');
    expect(harnessPlanner.systemPrompt).toContain('Formato de output');
    expect(harnessPlanner.systemPrompt).not.toContain('DevelopmentV2SprintMetadata');
    expect(harnessPlanner.systemPrompt).not.toContain('Development Pipeline 2.0');
  });

  it('sprint-validator systemPrompt is unchanged (contains key sentinel phrases)', () => {
    expect(sprintValidator.systemPrompt).toContain('Sprint Validator');
    expect(sprintValidator.systemPrompt).toContain('Cobertura');
    expect(sprintValidator.systemPrompt).toContain('PHASE_COMPLETE');
    expect(sprintValidator.systemPrompt).not.toContain('DevelopmentV2SprintMetadata');
    expect(sprintValidator.systemPrompt).not.toContain('Development Pipeline 2.0');
    expect(sprintValidator.systemPrompt).not.toContain('touchesUI');
  });
});
