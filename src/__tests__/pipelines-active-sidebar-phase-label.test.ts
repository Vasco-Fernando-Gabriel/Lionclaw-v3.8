import { describe, it, expect } from 'vitest';
import { getPhaseLabel } from '../components/common/sidebar-utils';
import {
  PIPELINE_PHASES,
  SECURITY_PIPELINE_PHASES,
  FEATURE_PIPELINE_PHASES,
  ARCHITECTURE_REVIEW_PIPELINE_PHASES,
  DEVELOPMENT_V2_PIPELINE_PHASES,
  getPhasesForProject,
} from '../types/pipeline';

describe('getPhaseLabel (I3)', () => {
  it('deriva "Fase N - nome" da fase corrente no pipeline dev', () => {
    expect(getPhaseLabel(1, 'running', PIPELINE_PHASES)).toBe('Fase 1 - Discovery');
    expect(getPhaseLabel(13, 'running', PIPELINE_PHASES)).toBe('Fase 13 - Coder');
  });

  it('deriva o nome certo por tipo de pipeline (security/feature/arch-review/dev-v2)', () => {
    expect(getPhaseLabel(2, 'running', SECURITY_PIPELINE_PHASES)).toBe('Fase 2 - Security Audit');
    expect(getPhaseLabel(1, 'running', FEATURE_PIPELINE_PHASES)).toBe('Fase 1 - Feature Discovery');
    expect(getPhaseLabel(3, 'running', ARCHITECTURE_REVIEW_PIPELINE_PHASES)).toBe('Fase 3 - Diagnostico Arquitetural');
    expect(getPhaseLabel(5, 'running', DEVELOPMENT_V2_PIPELINE_PHASES)).toBe('Fase 5 - LionDesign Studio');
  });

  it('usa as fases resolvidas via getPhasesForProject pelo pipelineType do projeto', () => {
    const devV2Phases = getPhasesForProject({ pipelineType: 'development-v2' });
    expect(getPhaseLabel(6, 'running', devV2Phases)).toBe('Fase 6 - Design Lock');
    const defaultPhases = getPhasesForProject({});
    expect(getPhaseLabel(2, 'running', defaultPhases)).toBe('Fase 2 - PRD Generator');
  });

  it('cai em "Fase N" quando a fase nao existe na lista ou a lista esta vazia', () => {
    expect(getPhaseLabel(99, 'running', PIPELINE_PHASES)).toBe('Fase 99');
    expect(getPhaseLabel(3, 'running', [])).toBe('Fase 3');
  });

  it('sem fase corrente, cai no phaseStatus ou em "Aguardando"', () => {
    expect(getPhaseLabel(null, 'running', PIPELINE_PHASES)).toBe('running');
    expect(getPhaseLabel(null, '', PIPELINE_PHASES)).toBe('Aguardando');
  });

  it('usa hifen na copy, nunca em-dash', () => {
    const label = getPhaseLabel(5, 'running', DEVELOPMENT_V2_PIPELINE_PHASES);
    expect(label).toContain(' - ');
    expect(label).not.toContain('—');
    expect(label).not.toContain('–');
  });
});
