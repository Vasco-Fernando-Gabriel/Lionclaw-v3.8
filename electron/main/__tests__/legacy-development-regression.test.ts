
import { describe, it, expect } from 'vitest';
import {
  PIPELINE_PHASES,
  FEATURE_PIPELINE_PHASES,
  SECURITY_PIPELINE_PHASES,
  ARCHITECTURE_REVIEW_PIPELINE_PHASES,
} from '../../../src/types/pipeline';
import {
  getArchitectureReviewConversationGreeting,
  getPhaseNumberForAgent,
  getPhaseAgentId,
} from '../pipeline-engine/phase-helpers';


const EXPECTED_PIPELINE_AGENTS: Record<number, string> = {
  1:  'discovery-agent',
  2:  'prd-generator',
  3:  'prd-validator',
  4:  'prd-generator',       // PRD Completo reuses prd-generator in dev legacy
  5:  'tech-database',
  6:  'tech-backend',
  7:  'tech-frontend',
  8:  'tech-security',
  9:  'spec-builder',
  10: 'spec-enricher',
  11: 'harness-planner',
  12: 'sprint-validator',
  13: 'harness-coder',
  14: 'harness-evaluator',
};

const EXPECTED_FEATURE_AGENTS: Record<number, string> = {
  1:  'feat-discovery',
  2:  'feat-prd-generator',
  3:  'feat-prd-validator',
  4:  'feat-prd-completo',
  5:  'feat-tech-database',
  6:  'feat-tech-backend',
  7:  'feat-tech-frontend',
  8:  'feat-tech-security',
  9:  'spec-builder',
  10: 'spec-enricher',
  11: 'harness-planner',
  12: 'sprint-validator',
  13: 'harness-coder',
  14: 'harness-evaluator',
};

const EXPECTED_SECURITY_AGENTS: Record<number, string> = {
  1:  'repo-profiler',
  2:  'multi-agent',
  3:  'security-deduplicator',
  4:  'security-skeptic-security',
  5:  'security-skeptic-quality',
  6:  'spec-builder',
  7:  'spec-enricher',
  8:  'harness-planner',
  9:  'sprint-validator',
  10: 'harness-coder',
  11: 'harness-evaluator',
};

const EXPECTED_ARCH_AGENTS: Record<number, string> = {
  1:  'architecture-mapper',
  2:  'architecture-target-triage',
  3:  'architecture-diagnostician',
  4:  'architecture-decision-interviewer',
  5:  'spec-builder',
  6:  'arch-spec-validator',
  7:  'architecture-spec-enricher',
  8:  'harness-planner',
  9:  'sprint-validator',
  10: 'harness-coder',
  11: 'harness-evaluator',
};


describe('Legacy PIPELINE_PHASES (development) — 14 phases intact', () => {
  it('has exactly 14 phases', () => {
    expect(PIPELINE_PHASES).toHaveLength(14);
  });

  it.each(Object.entries(EXPECTED_PIPELINE_AGENTS).map(([n, a]) => [Number(n), a] as [number, string]))(
    'phase %d maps to agentId %s',
    (phaseNum, expectedAgent) => {
      const phase = PIPELINE_PHASES.find((p) => p.number === phaseNum);
      expect(phase).toBeDefined();
      expect(phase?.agentId).toBe(expectedAgent);
    },
  );

  it('phase 13 is harness-coder (SPEC L1565 acceptance criterion)', () => {
    const phase = PIPELINE_PHASES.find((p) => p.number === 13);
    expect(phase?.agentId).toBe('harness-coder');
    expect(phase?.type).toBe('loop');
  });

  it('phase 14 is harness-evaluator (SPEC L1565 acceptance criterion)', () => {
    const phase = PIPELINE_PHASES.find((p) => p.number === 14);
    expect(phase?.agentId).toBe('harness-evaluator');
    expect(phase?.type).toBe('loop');
  });

  it('matches full snapshot (regression guard)', () => {
    expect(PIPELINE_PHASES).toMatchSnapshot();
  });
});


describe('Legacy FEATURE_PIPELINE_PHASES — 14 phases intact', () => {
  it('has exactly 14 phases', () => {
    expect(FEATURE_PIPELINE_PHASES).toHaveLength(14);
  });

  it.each(Object.entries(EXPECTED_FEATURE_AGENTS).map(([n, a]) => [Number(n), a] as [number, string]))(
    'phase %d maps to agentId %s',
    (phaseNum, expectedAgent) => {
      const phase = FEATURE_PIPELINE_PHASES.find((p) => p.number === phaseNum);
      expect(phase).toBeDefined();
      expect(phase?.agentId).toBe(expectedAgent);
    },
  );

  it('phase 13 is harness-coder', () => {
    expect(FEATURE_PIPELINE_PHASES.find((p) => p.number === 13)?.agentId).toBe('harness-coder');
  });

  it('phase 14 is harness-evaluator', () => {
    expect(FEATURE_PIPELINE_PHASES.find((p) => p.number === 14)?.agentId).toBe('harness-evaluator');
  });

  it('matches full snapshot', () => {
    expect(FEATURE_PIPELINE_PHASES).toMatchSnapshot();
  });
});


describe('Legacy SECURITY_PIPELINE_PHASES — 11 phases intact', () => {
  it('has exactly 11 phases', () => {
    expect(SECURITY_PIPELINE_PHASES).toHaveLength(11);
  });

  it.each(Object.entries(EXPECTED_SECURITY_AGENTS).map(([n, a]) => [Number(n), a] as [number, string]))(
    'phase %d maps to agentId %s',
    (phaseNum, expectedAgent) => {
      const phase = SECURITY_PIPELINE_PHASES.find((p) => p.number === phaseNum);
      expect(phase).toBeDefined();
      expect(phase?.agentId).toBe(expectedAgent);
    },
  );

  it('phase 10 is harness-coder', () => {
    expect(SECURITY_PIPELINE_PHASES.find((p) => p.number === 10)?.agentId).toBe('harness-coder');
  });

  it('phase 11 is harness-evaluator', () => {
    expect(SECURITY_PIPELINE_PHASES.find((p) => p.number === 11)?.agentId).toBe('harness-evaluator');
  });

  it('matches full snapshot', () => {
    expect(SECURITY_PIPELINE_PHASES).toMatchSnapshot();
  });
});


describe('Legacy ARCHITECTURE_REVIEW_PIPELINE_PHASES — 11 phases intact', () => {
  it('has exactly 11 phases', () => {
    expect(ARCHITECTURE_REVIEW_PIPELINE_PHASES).toHaveLength(11);
  });

  it.each(Object.entries(EXPECTED_ARCH_AGENTS).map(([n, a]) => [Number(n), a] as [number, string]))(
    'phase %d maps to agentId %s',
    (phaseNum, expectedAgent) => {
      const phase = ARCHITECTURE_REVIEW_PIPELINE_PHASES.find((p) => p.number === phaseNum);
      expect(phase).toBeDefined();
      expect(phase?.agentId).toBe(expectedAgent);
    },
  );

  it('phase 10 is harness-coder', () => {
    expect(ARCHITECTURE_REVIEW_PIPELINE_PHASES.find((p) => p.number === 10)?.agentId).toBe('harness-coder');
  });

  it('phase 11 is harness-evaluator', () => {
    expect(ARCHITECTURE_REVIEW_PIPELINE_PHASES.find((p) => p.number === 11)?.agentId).toBe('harness-evaluator');
  });

  it('phase 7 uses the architecture-specific spec enricher', () => {
    expect(ARCHITECTURE_REVIEW_PIPELINE_PHASES.find((p) => p.number === 7)?.agentId)
      .toBe('architecture-spec-enricher');
  });

  it('phase 7 greeting cannot fall back to frontend PRD/stories instructions', () => {
    const greeting = getArchitectureReviewConversationGreeting(7, 'SMith');
    expect(greeting).toContain('architecture-review');
    expect(greeting).toContain('SPEC arquitetural');
    expect(greeting).toContain('Nao procure PRD.md');
    expect(greeting).not.toContain('especialista em Frontend');
    expect(greeting).not.toContain('leia o stories-requisitos.md e o PRD.md');
  });

  it('matches full snapshot', () => {
    expect(ARCHITECTURE_REVIEW_PIPELINE_PHASES).toMatchSnapshot();
  });
});


describe('getPhaseNumberForAgent — legacy pipelines', () => {
  it('development: harness-coder === 13 (SPEC L1565)', () => {
    expect(getPhaseNumberForAgent({ pipelineType: 'development' }, 'harness-coder')).toBe(13);
  });

  it('development: harness-evaluator === 14 (SPEC L1565)', () => {
    expect(getPhaseNumberForAgent({ pipelineType: 'development' }, 'harness-evaluator')).toBe(14);
  });

  it('feature: harness-coder === 13', () => {
    expect(getPhaseNumberForAgent({ pipelineType: 'feature' }, 'harness-coder')).toBe(13);
  });

  it('feature: harness-evaluator === 14', () => {
    expect(getPhaseNumberForAgent({ pipelineType: 'feature' }, 'harness-evaluator')).toBe(14);
  });

  it('security: harness-coder === 10', () => {
    expect(getPhaseNumberForAgent({ pipelineType: 'security' }, 'harness-coder')).toBe(10);
  });

  it('security: harness-evaluator === 11', () => {
    expect(getPhaseNumberForAgent({ pipelineType: 'security' }, 'harness-evaluator')).toBe(11);
  });

  it('architecture-review: harness-coder === 10', () => {
    expect(getPhaseNumberForAgent({ pipelineType: 'architecture-review' }, 'harness-coder')).toBe(10);
  });

  it('architecture-review: harness-evaluator === 11', () => {
    expect(getPhaseNumberForAgent({ pipelineType: 'architecture-review' }, 'harness-evaluator')).toBe(11);
  });
});


describe('getPhaseAgentId dispatch — legacy pipelines', () => {
  it.each([
    ['development', 1, 'discovery-agent'],
    ['development', 2, 'prd-generator'],
    ['development', 9, 'spec-builder'],
    ['development', 11, 'harness-planner'],
    ['development', 12, 'sprint-validator'],
    ['development', 13, 'harness-coder'],
    ['development', 14, 'harness-evaluator'],
    ['feature', 1, 'feat-discovery'],
    ['feature', 13, 'harness-coder'],
    ['feature', 14, 'harness-evaluator'],
    ['security', 1, 'repo-profiler'],
    ['security', 10, 'harness-coder'],
    ['security', 11, 'harness-evaluator'],
    ['architecture-review', 1, 'architecture-mapper'],
    ['architecture-review', 10, 'harness-coder'],
    ['architecture-review', 11, 'harness-evaluator'],
  ])(
    '%s phase %d resolves to %s',
    (pipelineType, phaseNum, expectedAgent) => {
      expect(getPhaseAgentId(phaseNum as number, { pipelineType })).toBe(expectedAgent);
    },
  );
});


describe('development-v2 vs development legacy — no behavioral regression', () => {
  it('development legacy max phase is 14', () => {
    const maxPhase = Math.max(...PIPELINE_PHASES.map((p) => p.number));
    expect(maxPhase).toBe(14);
  });

  it('development-v2 adds phases 16+17 for coder/evaluator (not overlapping legacy 13/14)', async () => {
    const { DEVELOPMENT_V2_PIPELINE_PHASES } = await import('../../../src/types/pipeline');
    expect(getPhaseNumberForAgent({ pipelineType: 'development-v2' }, 'harness-coder')).toBe(16);
    expect(getPhaseNumberForAgent({ pipelineType: 'development-v2' }, 'harness-evaluator')).toBe(17);
    expect(DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 16)?.agentId).toBe('harness-coder');
    expect(DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 17)?.agentId).toBe('harness-evaluator');
  });

  it('development legacy does not have phase 15 or 16', () => {
    expect(PIPELINE_PHASES.find((p) => p.number === 15)).toBeUndefined();
    expect(PIPELINE_PHASES.find((p) => p.number === 16)).toBeUndefined();
  });
});
