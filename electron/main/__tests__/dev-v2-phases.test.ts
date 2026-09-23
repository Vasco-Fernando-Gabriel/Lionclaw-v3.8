import { describe, it, expect } from 'vitest';
import {
  PIPELINE_PHASES,
  FEATURE_PIPELINE_PHASES,
  SECURITY_PIPELINE_PHASES,
  ARCHITECTURE_REVIEW_PIPELINE_PHASES,
  DEVELOPMENT_V2_PIPELINE_PHASES,
  DEVELOPMENT_V2_AUTO_PHASES,
  DEVELOPMENT_V2_LOOP_PHASES,
  DEVELOPMENT_V2_CONVERSATION_PHASES,
  DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK,
  DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK,
  isValidPhaseForProject,
} from '../../../src/types/pipeline';
import { getPhaseNumberForAgent, getPhaseAgentId } from '../pipeline-engine/phase-helpers';

describe('DEVELOPMENT_V2_PIPELINE_PHASES', () => {
  it('has exactly 17 phases', () => {
    expect(DEVELOPMENT_V2_PIPELINE_PHASES).toHaveLength(17);
  });

  it('phase numbers are 1 through 17 in order', () => {
    const numbers = DEVELOPMENT_V2_PIPELINE_PHASES.map((p) => p.number);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('phase 16 is Coder (harness-coder, loop)', () => {
    const phase = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 16);
    expect(phase).toBeDefined();
    expect(phase?.agentId).toBe('harness-coder');
    expect(phase?.type).toBe('loop');
  });

  it('phase 17 is Evaluator (harness-evaluator, loop)', () => {
    const phase = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 17);
    expect(phase).toBeDefined();
    expect(phase?.agentId).toBe('harness-evaluator');
    expect(phase?.type).toBe('loop');
  });

  it('phase 4 Design Plan is auto', () => {
    const phase = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 4);
    expect(phase?.name).toBe('Design Plan');
    expect(phase?.agentId).toBe('design-plan');
    expect(phase?.type).toBe('auto');
  });

  it('phase 5 LionDesign Studio is conversation', () => {
    const phase = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 5);
    expect(phase?.name).toBe('LionDesign Studio');
    expect(phase?.type).toBe('conversation');
  });

  it('phase 6 Design Lock is auto', () => {
    const phase = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 6);
    expect(phase?.name).toBe('Design Lock');
    expect(phase?.type).toBe('auto');
  });

  it('phase 7 PRD Completo uses pipe2-prd-completo', () => {
    const phase = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 7);
    expect(phase?.agentId).toBe('pipe2-prd-completo');
    expect(phase?.type).toBe('auto');
  });

  it('phase 10 Frontend Tecnico uses pipe2-tech-frontend', () => {
    const phase = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 10);
    expect(phase?.agentId).toBe('pipe2-tech-frontend');
  });

  it('phase 12 Spec Generation uses pipe2-spec-builder (auto)', () => {
    const phase = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 12);
    expect(phase?.agentId).toBe('pipe2-spec-builder');
    expect(phase?.type).toBe('auto');
  });

  it('phase 13 Spec Enricher uses pipe2-spec-enricher (conversation)', () => {
    const phase = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 13);
    expect(phase?.agentId).toBe('pipe2-spec-enricher');
    expect(phase?.type).toBe('conversation');
  });

  it('phase 14 is Planner (harness-planner, auto)', () => {
    const phase = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 14);
    expect(phase?.agentId).toBe('harness-planner');
    expect(phase?.type).toBe('auto');
  });

  it('phase 15 is Sprint Validator (sprint-validator, conversation)', () => {
    const phase = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 15);
    expect(phase?.agentId).toBe('sprint-validator');
    expect(phase?.type).toBe('conversation');
  });

  it('all entries have required shape (number, name, type, agentId, abbreviation, stage, stageName, resetable)', () => {
    for (const phase of DEVELOPMENT_V2_PIPELINE_PHASES) {
      expect(typeof phase.number).toBe('number');
      expect(typeof phase.name).toBe('string');
      expect(['auto', 'conversation', 'loop']).toContain(phase.type);
      expect(typeof phase.agentId).toBe('string');
      expect(typeof phase.abbreviation).toBe('string');
      expect(typeof phase.stage).toBe('number');
      expect(typeof phase.stageName).toBe('string');
      expect(typeof phase.resetable).toBe('boolean');
    }
  });

  it('matches snapshot', () => {
    expect(DEVELOPMENT_V2_PIPELINE_PHASES).toMatchSnapshot();
  });
});

describe('Legacy pipeline phases regression snapshots', () => {
  it('PIPELINE_PHASES (development) matches snapshot', () => {
    expect(PIPELINE_PHASES).toMatchSnapshot();
  });

  it('FEATURE_PIPELINE_PHASES matches snapshot', () => {
    expect(FEATURE_PIPELINE_PHASES).toMatchSnapshot();
  });

  it('SECURITY_PIPELINE_PHASES matches snapshot', () => {
    expect(SECURITY_PIPELINE_PHASES).toMatchSnapshot();
  });

  it('ARCHITECTURE_REVIEW_PIPELINE_PHASES matches snapshot', () => {
    expect(ARCHITECTURE_REVIEW_PIPELINE_PHASES).toMatchSnapshot();
  });

  it('PIPELINE_PHASES has exactly 14 phases (unchanged)', () => {
    expect(PIPELINE_PHASES).toHaveLength(14);
  });

  it('FEATURE_PIPELINE_PHASES has exactly 14 phases (unchanged)', () => {
    expect(FEATURE_PIPELINE_PHASES).toHaveLength(14);
  });

  it('SECURITY_PIPELINE_PHASES has exactly 11 phases (unchanged)', () => {
    expect(SECURITY_PIPELINE_PHASES).toHaveLength(11);
  });

  it('ARCHITECTURE_REVIEW_PIPELINE_PHASES has exactly 11 phases (unchanged)', () => {
    expect(ARCHITECTURE_REVIEW_PIPELINE_PHASES).toHaveLength(11);
  });

  it('PIPELINE_PHASES phase 13 is harness-coder', () => {
    const phase = PIPELINE_PHASES.find((p) => p.number === 13);
    expect(phase?.agentId).toBe('harness-coder');
  });

  it('PIPELINE_PHASES phase 14 is harness-evaluator', () => {
    const phase = PIPELINE_PHASES.find((p) => p.number === 14);
    expect(phase?.agentId).toBe('harness-evaluator');
  });
});

describe('isValidPhaseForProject', () => {
  const devProject = { pipelineType: 'development' as const };
  const devV2Project = { pipelineType: 'development-v2' as const };
  const secProject = { pipelineType: 'security' as const };
  const featProject = { pipelineType: 'feature' as const };
  const archProject = { pipelineType: 'architecture-review' as const };

  it('development: phases 1-14 are valid', () => {
    for (let i = 1; i <= 14; i++) {
      expect(isValidPhaseForProject(devProject, i)).toBe(true);
    }
  });

  it('development: phase 15 is invalid', () => {
    expect(isValidPhaseForProject(devProject, 15)).toBe(false);
  });

  it('development-v2: phases 1-17 are valid', () => {
    for (let i = 1; i <= 17; i++) {
      expect(isValidPhaseForProject(devV2Project, i)).toBe(true);
    }
  });

  it('development-v2: phase 18 is invalid', () => {
    expect(isValidPhaseForProject(devV2Project, 18)).toBe(false);
  });

  it('security: phases 1-11 are valid', () => {
    for (let i = 1; i <= 11; i++) {
      expect(isValidPhaseForProject(secProject, i)).toBe(true);
    }
  });

  it('security: phase 12 is invalid', () => {
    expect(isValidPhaseForProject(secProject, 12)).toBe(false);
  });

  it('feature: phases 1-14 are valid', () => {
    for (let i = 1; i <= 14; i++) {
      expect(isValidPhaseForProject(featProject, i)).toBe(true);
    }
  });

  it('feature: phase 15 is invalid', () => {
    expect(isValidPhaseForProject(featProject, 15)).toBe(false);
  });

  it('architecture-review: phases 1-11 are valid', () => {
    for (let i = 1; i <= 11; i++) {
      expect(isValidPhaseForProject(archProject, i)).toBe(true);
    }
  });

  it('architecture-review: phase 12 is invalid', () => {
    expect(isValidPhaseForProject(archProject, 12)).toBe(false);
  });

  it('unknown pipelineType falls back to development (PIPELINE_PHASES)', () => {
    const unknownProject = { pipelineType: 'unknown-future-type' };
    expect(isValidPhaseForProject(unknownProject, 1)).toBe(true);
    expect(isValidPhaseForProject(unknownProject, 14)).toBe(true);
    expect(isValidPhaseForProject(unknownProject, 15)).toBe(false);
  });

  it('phase 0 is invalid for all pipeline types', () => {
    expect(isValidPhaseForProject(devProject, 0)).toBe(false);
    expect(isValidPhaseForProject(devV2Project, 0)).toBe(false);
    expect(isValidPhaseForProject(secProject, 0)).toBe(false);
  });
});

describe('DEVELOPMENT_V2 derived sets', () => {
  it('AUTO_PHASES contains phases 2, 4, 6, 7, 12, 14', () => {
    expect(DEVELOPMENT_V2_AUTO_PHASES).toEqual(new Set([2, 4, 6, 7, 12, 14]));
  });

  it('LOOP_PHASES contains phases 16 and 17', () => {
    expect(DEVELOPMENT_V2_LOOP_PHASES).toEqual(new Set([16, 17]));
  });

  it('CONVERSATION_PHASES contains phases 1, 3, 5, 8, 9, 10, 11, 12, 13, 15', () => {
    expect(DEVELOPMENT_V2_CONVERSATION_PHASES).toEqual(new Set([1, 3, 5, 8, 9, 10, 11, 12, 13, 15]));
  });

  it('CONVERSATION_PHASES contains phase 12 (Spec Generation review gate)', () => {
    expect(DEVELOPMENT_V2_CONVERSATION_PHASES.has(12)).toBe(true);
  });

  it('AUTO_PHASES still contains phase 12 (auto loop AND conversational, like dev/feature phase 9)', () => {
    expect(DEVELOPMENT_V2_AUTO_PHASES.has(12)).toBe(true);
  });

  it('phase 12 contract unchanged: name "Spec Generation", agentId "pipe2-spec-builder", type "auto"', () => {
    const phase12 = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 12);
    expect(phase12).toBeDefined();
    expect(phase12?.name).toBe('Spec Generation');
    expect(phase12?.agentId).toBe('pipe2-spec-builder');
    expect(phase12?.type).toBe('auto');
  });

  it('auto + loop + conversation covers all 17 phases', () => {
    const allPhases = new Set([
      ...DEVELOPMENT_V2_AUTO_PHASES,
      ...DEVELOPMENT_V2_LOOP_PHASES,
      ...DEVELOPMENT_V2_CONVERSATION_PHASES,
    ]);
    expect(allPhases.size).toBe(17);
    for (let i = 1; i <= 17; i++) {
      expect(allPhases.has(i)).toBe(true);
    }
  });

  it('RESETABLE_PHASES_BEFORE_LOCK contains phases 1, 2, 3, 4, 5', () => {
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it('RESETABLE_PHASES_AFTER_LOCK contains phases 7-15', () => {
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK).toEqual(new Set([7, 8, 9, 10, 11, 12, 13, 14, 15]));
  });

  it('phase 4 (Design Plan) and phase 5 (Open Design Studio) ARE resetable before lock', () => {
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK.has(4)).toBe(true);
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK.has(5)).toBe(true);
  });

  it('phase 4 (Design Plan) and phase 5 (Open Design Studio) are NOT resetable after lock', () => {
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK.has(4)).toBe(false);
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK.has(5)).toBe(false);
  });

  it('phases 16/17 (loop) are NOT in resetable sets', () => {
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK.has(16)).toBe(false);
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK.has(17)).toBe(false);
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK.has(16)).toBe(false);
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK.has(17)).toBe(false);
  });
});

describe('getPhaseNumberForAgent', () => {
  it.each([
    ['development', 'harness-coder', 13],
    ['development', 'harness-evaluator', 14],
    ['feature', 'harness-coder', 13],
    ['feature', 'harness-evaluator', 14],
    ['security', 'harness-coder', 10],
    ['security', 'harness-evaluator', 11],
    ['architecture-review', 'harness-coder', 10],
    ['architecture-review', 'harness-evaluator', 11],
    ['development-v2', 'harness-coder', 16],
    ['development-v2', 'harness-evaluator', 17],
  ])('returns %d for %s/%s', (pipelineType, agentId, expected) => {
    expect(getPhaseNumberForAgent({ pipelineType }, agentId)).toBe(expected);
  });
});

describe('legacy dispatch regression', () => {
  it('development phase 13 resolves to harness-coder', () => {
    expect(getPhaseAgentId(13, { pipelineType: 'development' })).toBe('harness-coder');
  });

  it('development phase 14 resolves to harness-evaluator', () => {
    expect(getPhaseAgentId(14, { pipelineType: 'development' })).toBe('harness-evaluator');
  });

  it('feature phase 13 resolves to harness-coder', () => {
    expect(getPhaseAgentId(13, { pipelineType: 'feature' })).toBe('harness-coder');
  });

  it('feature phase 14 resolves to harness-evaluator', () => {
    expect(getPhaseAgentId(14, { pipelineType: 'feature' })).toBe('harness-evaluator');
  });

  it('development-v2 phase 16 resolves to harness-coder', () => {
    expect(getPhaseAgentId(16, { pipelineType: 'development-v2' })).toBe('harness-coder');
  });

  it('development-v2 phase 17 resolves to harness-evaluator', () => {
    expect(getPhaseAgentId(17, { pipelineType: 'development-v2' })).toBe('harness-evaluator');
  });
});
