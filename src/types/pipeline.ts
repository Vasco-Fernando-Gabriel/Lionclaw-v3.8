export type PipelineType = 'development' | 'development-v2' | 'security' | 'feature' | 'architecture-review' | 'bug';

export type PipelinePhaseNumber = number;

export type SecurityPipelinePhaseNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type PipelinePhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'interrupted';

export type PipelinePhaseType = 'conversation' | 'auto' | 'loop';

export type DiscoveryBlockId = 'vision' | 'features' | 'monetization' | 'technical' | 'context';

export type AgentEffort = 'low' | 'medium' | 'high';

export interface PhaseDefinition {
  number: PipelinePhaseNumber;
  name: string;
  type: PipelinePhaseType;
  agentId: string;
  abbreviation: string;
  stage: number;
  stageName: string;
  groupId?: 'tech' | 'skeptic';
  groupLabel?: string;
  resetable: boolean;
}

export const PIPELINE_PHASES: PhaseDefinition[] = [
  {
    number: 1,
    name: 'Discovery',
    type: 'conversation',
    agentId: 'discovery-agent',
    abbreviation: 'Disc',
    stage: 1,
    stageName: 'Discovery',
    resetable: true,
  },
  {
    number: 2,
    name: 'PRD Generator',
    type: 'auto',
    agentId: 'prd-generator',
    abbreviation: 'PRD',
    stage: 2,
    stageName: 'PRD',
    resetable: true,
  },
  {
    number: 3,
    name: 'PRD Validator',
    type: 'conversation',
    agentId: 'prd-validator',
    abbreviation: 'Val',
    stage: 2,
    stageName: 'PRD',
    resetable: false,
  },
  {
    number: 4,
    name: 'PRD Completo',
    type: 'auto',
    agentId: 'prd-generator',
    abbreviation: 'PRD+',
    stage: 2,
    stageName: 'PRD',
    resetable: true,
  },
  {
    number: 5,
    name: 'Database',
    type: 'conversation',
    agentId: 'tech-database',
    abbreviation: 'DB',
    stage: 3,
    stageName: 'Tech',
    groupId: 'tech',
    groupLabel: 'TECH',
    resetable: false,
  },
  {
    number: 6,
    name: 'Backend',
    type: 'conversation',
    agentId: 'tech-backend',
    abbreviation: 'BE',
    stage: 3,
    stageName: 'Tech',
    groupId: 'tech',
    groupLabel: 'TECH',
    resetable: false,
  },
  {
    number: 7,
    name: 'Frontend',
    type: 'conversation',
    agentId: 'tech-frontend',
    abbreviation: 'FE',
    stage: 3,
    stageName: 'Tech',
    groupId: 'tech',
    groupLabel: 'TECH',
    resetable: false,
  },
  {
    number: 8,
    name: 'Security',
    type: 'conversation',
    agentId: 'tech-security',
    abbreviation: 'SEC',
    stage: 3,
    stageName: 'Tech',
    groupId: 'tech',
    groupLabel: 'TECH',
    resetable: false,
  },
  {
    number: 9,
    name: 'Spec Generation',
    type: 'auto',
    agentId: 'spec-builder',
    abbreviation: 'Spec',
    stage: 4,
    stageName: 'Spec',
    resetable: true,
  },
  {
    number: 10,
    name: 'Spec Enricher',
    type: 'conversation',
    agentId: 'spec-enricher',
    abbreviation: 'Enrich',
    stage: 4,
    stageName: 'Spec',
    resetable: false,
  },
  {
    number: 11,
    name: 'Planner',
    type: 'auto',
    agentId: 'harness-planner',
    abbreviation: 'Plan',
    stage: 5,
    stageName: 'Execution',
    resetable: true,
  },
  {
    number: 12,
    name: 'Sprint Validator',
    type: 'conversation',
    agentId: 'sprint-validator',
    abbreviation: 'SVal',
    stage: 5,
    stageName: 'Execution',
    resetable: true,
  },
  {
    number: 13,
    name: 'Coder',
    type: 'loop',
    agentId: 'harness-coder',
    abbreviation: 'Code',
    stage: 5,
    stageName: 'Execution',
    resetable: false,
  },
  {
    number: 14,
    name: 'Evaluator',
    type: 'loop',
    agentId: 'harness-evaluator',
    abbreviation: 'Eval',
    stage: 5,
    stageName: 'Execution',
    resetable: false,
  },
];

export const SECURITY_PIPELINE_PHASES: PhaseDefinition[] = [
  {
    number: 1,
    name: 'Repo Profiler',
    type: 'auto',
    agentId: 'repo-profiler',
    abbreviation: 'Prof',
    stage: 1,
    stageName: 'Scan',
    resetable: true,
  },
  {
    number: 2,
    name: 'Security Audit',
    type: 'auto',
    agentId: 'multi-agent',
    abbreviation: 'Audit',
    stage: 1,
    stageName: 'Scan',
    resetable: true,
  },
  {
    number: 3,
    name: 'Deduplicador',
    type: 'auto',
    agentId: 'security-deduplicator',
    abbreviation: 'Dedup',
    stage: 1,
    stageName: 'Scan',
    resetable: true,
  },
  {
    number: 4,
    name: 'Skeptic Security',
    type: 'conversation',
    agentId: 'security-skeptic-security',
    abbreviation: 'Sec',
    stage: 2,
    stageName: 'Validacao',
    groupId: 'skeptic',
    groupLabel: 'VALIDAÇÃO',
    resetable: false,
  },
  {
    number: 5,
    name: 'Skeptic Quality',
    type: 'conversation',
    agentId: 'security-skeptic-quality',
    abbreviation: 'Qual',
    stage: 2,
    stageName: 'Validacao',
    groupId: 'skeptic',
    groupLabel: 'VALIDAÇÃO',
    resetable: false,
  },
  {
    number: 6,
    name: 'SPEC Generator',
    type: 'auto',
    agentId: 'spec-builder',
    abbreviation: 'Spec',
    stage: 3,
    stageName: 'Spec',
    resetable: true,
  },
  {
    number: 7,
    name: 'SPEC Enricher',
    type: 'conversation',
    agentId: 'spec-enricher',
    abbreviation: 'Enrich',
    stage: 3,
    stageName: 'Spec',
    resetable: false,
  },
  {
    number: 8,
    name: 'Planner',
    type: 'auto',
    agentId: 'harness-planner',
    abbreviation: 'Plan',
    stage: 4,
    stageName: 'Execucao',
    resetable: true,
  },
  {
    number: 9,
    name: 'Sprint Validator',
    type: 'conversation',
    agentId: 'sprint-validator',
    abbreviation: 'SVal',
    stage: 4,
    stageName: 'Execucao',
    resetable: true,
  },
  {
    number: 10,
    name: 'Coder',
    type: 'loop',
    agentId: 'harness-coder',
    abbreviation: 'Code',
    stage: 4,
    stageName: 'Execucao',
    resetable: false,
  },
  {
    number: 11,
    name: 'Evaluator',
    type: 'loop',
    agentId: 'harness-evaluator',
    abbreviation: 'Eval',
    stage: 4,
    stageName: 'Execucao',
    resetable: false,
  },
];

export const FEATURE_PIPELINE_PHASES: PhaseDefinition[] = [
  {
    number: 1,
    name: 'Feature Discovery',
    type: 'conversation',
    agentId: 'feat-discovery',
    abbreviation: 'FDisc',
    stage: 1,
    stageName: 'Discovery',
    resetable: true,
  },
  {
    number: 2,
    name: 'PRD Generator',
    type: 'auto',
    agentId: 'feat-prd-generator',
    abbreviation: 'PRD',
    stage: 2,
    stageName: 'PRD',
    resetable: true,
  },
  {
    number: 3,
    name: 'PRD Validator',
    type: 'conversation',
    agentId: 'feat-prd-validator',
    abbreviation: 'Val',
    stage: 2,
    stageName: 'PRD',
    resetable: false,
  },
  {
    number: 4,
    name: 'PRD Completo',
    type: 'auto',
    agentId: 'feat-prd-completo',
    abbreviation: 'PRD+',
    stage: 2,
    stageName: 'PRD',
    resetable: true,
  },
  {
    number: 5,
    name: 'Database',
    type: 'conversation',
    agentId: 'feat-tech-database',
    abbreviation: 'DB',
    stage: 3,
    stageName: 'Tech',
    groupId: 'tech',
    groupLabel: 'TECH',
    resetable: false,
  },
  {
    number: 6,
    name: 'Backend',
    type: 'conversation',
    agentId: 'feat-tech-backend',
    abbreviation: 'BE',
    stage: 3,
    stageName: 'Tech',
    groupId: 'tech',
    groupLabel: 'TECH',
    resetable: false,
  },
  {
    number: 7,
    name: 'Frontend',
    type: 'conversation',
    agentId: 'feat-tech-frontend',
    abbreviation: 'FE',
    stage: 3,
    stageName: 'Tech',
    groupId: 'tech',
    groupLabel: 'TECH',
    resetable: false,
  },
  {
    number: 8,
    name: 'Security',
    type: 'conversation',
    agentId: 'feat-tech-security',
    abbreviation: 'SEC',
    stage: 3,
    stageName: 'Tech',
    groupId: 'tech',
    groupLabel: 'TECH',
    resetable: false,
  },
  {
    number: 9,
    name: 'Spec Generation',
    type: 'auto',
    agentId: 'spec-builder',
    abbreviation: 'Spec',
    stage: 4,
    stageName: 'Spec',
    resetable: true,
  },
  {
    number: 10,
    name: 'Spec Enricher',
    type: 'conversation',
    agentId: 'spec-enricher',
    abbreviation: 'Enrich',
    stage: 4,
    stageName: 'Spec',
    resetable: false,
  },
  {
    number: 11,
    name: 'Planner',
    type: 'auto',
    agentId: 'harness-planner',
    abbreviation: 'Plan',
    stage: 5,
    stageName: 'Execution',
    resetable: true,
  },
  {
    number: 12,
    name: 'Sprint Validator',
    type: 'conversation',
    agentId: 'sprint-validator',
    abbreviation: 'SVal',
    stage: 5,
    stageName: 'Execution',
    resetable: true,
  },
  {
    number: 13,
    name: 'Coder',
    type: 'loop',
    agentId: 'harness-coder',
    abbreviation: 'Code',
    stage: 5,
    stageName: 'Execution',
    resetable: false,
  },
  {
    number: 14,
    name: 'Evaluator',
    type: 'loop',
    agentId: 'harness-evaluator',
    abbreviation: 'Eval',
    stage: 5,
    stageName: 'Execution',
    resetable: false,
  },
];

export const ARCHITECTURE_REVIEW_PIPELINE_PHASES: PhaseDefinition[] = [
  {
    number: 1,
    name: 'Mapeamento Arquitetural',
    type: 'auto',
    agentId: 'architecture-mapper',
    abbreviation: 'Map',
    stage: 1,
    stageName: 'Review',
    resetable: true,
  },
  {
    number: 2,
    name: 'Triagem de Alvos',
    type: 'conversation',
    agentId: 'architecture-target-triage',
    abbreviation: 'Target',
    stage: 1,
    stageName: 'Review',
    resetable: true,
  },
  {
    number: 3,
    name: 'Diagnostico Arquitetural',
    type: 'auto',
    agentId: 'architecture-diagnostician',
    abbreviation: 'Diag',
    stage: 2,
    stageName: 'Evidence',
    resetable: true,
  },
  {
    number: 4,
    name: 'Entrevista de Decisao',
    type: 'conversation',
    agentId: 'architecture-decision-interviewer',
    abbreviation: 'Decide',
    stage: 3,
    stageName: 'Decision',
    resetable: true,
  },
  {
    number: 5,
    name: 'Spec Generation',
    type: 'auto',
    agentId: 'spec-builder',
    abbreviation: 'Spec',
    stage: 4,
    stageName: 'Spec',
    resetable: true,
  },
  {
    number: 6,
    name: 'Spec Validation',
    type: 'conversation',
    agentId: 'arch-spec-validator',
    abbreviation: 'Val',
    stage: 4,
    stageName: 'Spec',
    resetable: false,
  },
  {
    number: 7,
    name: 'Spec Enricher',
    type: 'conversation',
    agentId: 'architecture-spec-enricher',
    abbreviation: 'Enrich',
    stage: 4,
    stageName: 'Spec',
    resetable: false,
  },
  {
    number: 8,
    name: 'Planner',
    type: 'auto',
    agentId: 'harness-planner',
    abbreviation: 'Plan',
    stage: 5,
    stageName: 'Execution',
    resetable: true,
  },
  {
    number: 9,
    name: 'Sprint Validator',
    type: 'conversation',
    agentId: 'sprint-validator',
    abbreviation: 'SVal',
    stage: 5,
    stageName: 'Execution',
    resetable: true,
  },
  {
    number: 10,
    name: 'Coder',
    type: 'loop',
    agentId: 'harness-coder',
    abbreviation: 'Code',
    stage: 5,
    stageName: 'Execution',
    resetable: false,
  },
  {
    number: 11,
    name: 'Evaluator',
    type: 'loop',
    agentId: 'harness-evaluator',
    abbreviation: 'Eval',
    stage: 5,
    stageName: 'Execution',
    resetable: false,
  },
];

export const DEVELOPMENT_V2_PIPELINE_PHASES: PhaseDefinition[] = [
  {
    number: 1,
    name: 'Discovery',
    type: 'conversation',
    agentId: 'discovery-agent',
    abbreviation: 'Disc',
    stage: 1,
    stageName: 'Discovery',
    resetable: true,
  },
  {
    number: 2,
    name: 'User Stories',
    type: 'auto',
    agentId: 'prd-generator',
    abbreviation: 'Story',
    stage: 2,
    stageName: 'PRD',
    resetable: true,
  },
  {
    number: 3,
    name: 'PRD Validator',
    type: 'conversation',
    agentId: 'prd-validator',
    abbreviation: 'Val',
    stage: 2,
    stageName: 'PRD',
    resetable: false,
  },
  {
    number: 4,
    name: 'Design Plan',
    type: 'auto',
    agentId: 'design-plan',
    abbreviation: 'DPlan',
    stage: 3,
    stageName: 'Design',
    resetable: true,
  },
  {
    number: 5,
    name: 'LionDesign Studio',
    type: 'conversation',
    agentId: 'open-design-studio',
    abbreviation: 'LDS',
    stage: 3,
    stageName: 'Design',
    resetable: true,
  },
  {
    number: 6,
    name: 'Design Lock',
    type: 'auto',
    agentId: 'design-lock',
    abbreviation: 'Lock',
    stage: 3,
    stageName: 'Design',
    resetable: false,
  },
  {
    number: 7,
    name: 'PRD Completo',
    type: 'auto',
    agentId: 'pipe2-prd-completo',
    abbreviation: 'PRD+',
    stage: 4,
    stageName: 'PRD+',
    resetable: true,
  },
  {
    number: 8,
    name: 'Database',
    type: 'conversation',
    agentId: 'tech-database',
    abbreviation: 'DB',
    stage: 5,
    stageName: 'Tech',
    groupId: 'tech',
    groupLabel: 'TECH',
    resetable: false,
  },
  {
    number: 9,
    name: 'Backend',
    type: 'conversation',
    agentId: 'tech-backend',
    abbreviation: 'BE',
    stage: 5,
    stageName: 'Tech',
    groupId: 'tech',
    groupLabel: 'TECH',
    resetable: false,
  },
  {
    number: 10,
    name: 'Frontend Tecnico',
    type: 'conversation',
    agentId: 'pipe2-tech-frontend',
    abbreviation: 'FE',
    stage: 5,
    stageName: 'Tech',
    groupId: 'tech',
    groupLabel: 'TECH',
    resetable: false,
  },
  {
    number: 11,
    name: 'Security',
    type: 'conversation',
    agentId: 'tech-security',
    abbreviation: 'SEC',
    stage: 5,
    stageName: 'Tech',
    groupId: 'tech',
    groupLabel: 'TECH',
    resetable: false,
  },
  {
    number: 12,
    name: 'Spec Generation',
    type: 'auto',
    agentId: 'pipe2-spec-builder',
    abbreviation: 'Spec',
    stage: 6,
    stageName: 'Spec',
    resetable: true,
  },
  {
    number: 13,
    name: 'Spec Enricher',
    type: 'conversation',
    agentId: 'pipe2-spec-enricher',
    abbreviation: 'Enrich',
    stage: 6,
    stageName: 'Spec',
    resetable: false,
  },
  {
    number: 14,
    name: 'Planner',
    type: 'auto',
    agentId: 'harness-planner',
    abbreviation: 'Plan',
    stage: 7,
    stageName: 'Execution',
    resetable: true,
  },
  {
    number: 15,
    name: 'Sprint Validator',
    type: 'conversation',
    agentId: 'sprint-validator',
    abbreviation: 'SVal',
    stage: 7,
    stageName: 'Execution',
    resetable: true,
  },
  {
    number: 16,
    name: 'Coder',
    type: 'loop',
    agentId: 'harness-coder',
    abbreviation: 'Code',
    stage: 7,
    stageName: 'Execution',
    resetable: false,
  },
  {
    number: 17,
    name: 'Evaluator',
    type: 'loop',
    agentId: 'harness-evaluator',
    abbreviation: 'Eval',
    stage: 7,
    stageName: 'Execution',
    resetable: false,
  },
];

export const BUG_PIPELINE_PHASES: PhaseDefinition[] = [
  {
    number: 1,
    name: 'Bug Discovery',
    type: 'conversation',
    agentId: 'bug-discovery',
    abbreviation: 'Bug',
    stage: 1,
    stageName: 'Diagnostico',
    resetable: true,
  },
  {
    number: 2,
    name: 'Analise Paralela',
    type: 'auto',
    agentId: 'bug-analysis-multi',
    abbreviation: 'Analise',
    stage: 2,
    stageName: 'Analise',
    resetable: true,
  },
  {
    number: 3,
    name: 'Consolidacao',
    type: 'conversation',
    agentId: 'bug-solution-consolidator',
    abbreviation: 'Plano',
    stage: 2,
    stageName: 'Analise',
    resetable: true,
  },
  {
    number: 4,
    name: 'Spec Generation',
    type: 'auto',
    agentId: 'spec-builder',
    abbreviation: 'Spec',
    stage: 3,
    stageName: 'Spec',
    resetable: true,
  },
  {
    number: 5,
    name: 'Spec Validator',
    type: 'conversation',
    agentId: 'bug-spec-validator',
    abbreviation: 'Val',
    stage: 3,
    stageName: 'Spec',
    resetable: false,
  },
  {
    number: 6,
    name: 'Planner',
    type: 'auto',
    agentId: 'harness-planner',
    abbreviation: 'Plan',
    stage: 4,
    stageName: 'Execution',
    resetable: true,
  },
  {
    number: 7,
    name: 'Sprint Validator',
    type: 'conversation',
    agentId: 'sprint-validator',
    abbreviation: 'SVal',
    stage: 4,
    stageName: 'Execution',
    resetable: true,
  },
  {
    number: 8,
    name: 'Coder',
    type: 'loop',
    agentId: 'harness-coder',
    abbreviation: 'Code',
    stage: 4,
    stageName: 'Execution',
    resetable: false,
  },
  {
    number: 9,
    name: 'Evaluator',
    type: 'loop',
    agentId: 'harness-evaluator',
    abbreviation: 'Eval',
    stage: 4,
    stageName: 'Execution',
    resetable: false,
  },
];

export const DEVELOPMENT_V2_AUTO_PHASES = new Set([2, 4, 6, 7, 12, 14]);
export const DEVELOPMENT_V2_LOOP_PHASES = new Set([16, 17]);
export const DEVELOPMENT_V2_CONVERSATION_PHASES = new Set([1, 3, 5, 8, 9, 10, 11, 12, 13, 15]);

export const DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK = new Set([1, 2, 3, 4, 5]);

export const DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK = new Set([7, 8, 9, 10, 11, 12, 13, 14, 15]);

export function getPhasesForProject(project: { pipelineType?: string }): readonly PhaseDefinition[] {
  if (project.pipelineType === 'security') return SECURITY_PIPELINE_PHASES;
  if (project.pipelineType === 'feature') return FEATURE_PIPELINE_PHASES;
  if (project.pipelineType === 'architecture-review') return ARCHITECTURE_REVIEW_PIPELINE_PHASES;
  if (project.pipelineType === 'development-v2') return DEVELOPMENT_V2_PIPELINE_PHASES;
  if (project.pipelineType === 'bug') return BUG_PIPELINE_PHASES;
  return PIPELINE_PHASES;
}

export function isValidPhaseForProject(project: { pipelineType?: string }, phase: number): boolean {
  return getPhasesForProject(project).some((p) => p.number === phase);
}

export function getPhaseNumberForAgent(pipelineType: string | undefined, agentId: string): number | undefined {
  return getPhasesForProject({ pipelineType }).find((p) => p.agentId === agentId)?.number;
}

export function isCoderPhaseForProject(pipelineType: string | undefined, phase: number | null): boolean {
  return phase !== null && phase === getPhaseNumberForAgent(pipelineType, 'harness-coder');
}

export function isEvaluatorPhaseForProject(pipelineType: string | undefined, phase: number | null): boolean {
  return phase !== null && phase === getPhaseNumberForAgent(pipelineType, 'harness-evaluator');
}

const PIPELINE_TYPES: PipelineType[] = [
  'development',
  'development-v2',
  'security',
  'feature',
  'architecture-review',
  'bug',
];

const CONVERSATION_OVER_AUTO_OVERRIDES: Partial<Record<PipelineType, number[]>> = {
  development: [9],
  feature: [9],
  'development-v2': [12],
  security: [6],
};

export const LOOP_HISTORY_BY_TYPE: Record<PipelineType, number[]> = {
  development: [],
  feature: [],
  security: [13, 14],
  'architecture-review': [13, 14],
  'development-v2': [13, 14],
  bug: [],
};

export function autoPhasesOf(type: string | undefined): Set<number> {
  return new Set(
    getPhasesForProject({ pipelineType: type })
      .filter((p) => p.type === 'auto')
      .map((p) => p.number),
  );
}

export function loopPhasesOf(type: string | undefined): Set<number> {
  return new Set(
    getPhasesForProject({ pipelineType: type })
      .filter((p) => p.type === 'loop')
      .map((p) => p.number),
  );
}

export function conversationPhasesOf(type: string | undefined): Set<number> {
  const phases = getPhasesForProject({ pipelineType: type });
  const auto = autoPhasesOf(type);
  const loop = loopPhasesOf(type);
  const result = new Set<number>(phases.filter((p) => !auto.has(p.number) && !loop.has(p.number)).map((p) => p.number));
  const overrides = CONVERSATION_OVER_AUTO_OVERRIDES[type as PipelineType] ?? [];
  for (const n of overrides) result.add(n);
  return result;
}

export function resetablePhasesOf(type: string | undefined, locked?: boolean): Set<number> {
  if (type === 'development-v2') {
    return locked === true
      ? new Set(DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK)
      : new Set(DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK);
  }
  return new Set(
    getPhasesForProject({ pipelineType: type })
      .filter((p) => p.resetable)
      .map((p) => p.number),
  );
}

export function maxPhaseOf(type: string | undefined): number {
  return getPhasesForProject({ pipelineType: type }).reduce((max, p) => Math.max(max, p.number), 0);
}

export function phaseOfAgent(type: string | undefined, agentId: string): number | undefined {
  return getPhaseNumberForAgent(type, agentId);
}

export function allLoopPhases(): Set<number> {
  const result = new Set<number>();
  for (const type of PIPELINE_TYPES) {
    for (const n of loopPhasesOf(type)) result.add(n);
  }
  return result;
}

export function allLoopPhasesWithHistory(): Set<number> {
  const result = allLoopPhases();
  for (const type of PIPELINE_TYPES) {
    for (const n of LOOP_HISTORY_BY_TYPE[type]) result.add(n);
  }
  return result;
}

export function loopPhasesByRoleWithHistoryOf(type: string | undefined, role: 'coder' | 'evaluator'): Set<number> {
  const roleIndex = role === 'coder' ? 0 : 1;
  const result = new Set<number>();
  const loops = [...loopPhasesOf(type)].sort((a, b) => a - b);
  const phase = loops[roleIndex];
  if (phase !== undefined) result.add(phase);
  const histPhase = (LOOP_HISTORY_BY_TYPE[type as PipelineType] ?? [])[roleIndex];
  if (histPhase !== undefined) result.add(histPhase);
  return result;
}

export interface DevelopmentV2SprintMetadata {
  touchesUI: boolean;
  affectedScreenIds: string[];
  affectedComponentIds: string[];
  designArtifactPath?: string;
}

export interface SecurityAgentStatus {
  agentId: string;
  agentName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  findingsCount: number;
  error?: string;
}

export interface PhaseActionButtonConfig {
  label: string;
  variant: 'primary' | 'secondary' | 'danger' | 'warning' | 'success';
  action: string;
  disabled?: boolean;
  tooltip?: string;
}

export interface ThinkingConfig {
  enabled: boolean;
  budgetTokens?: number;
}

export interface McpServerConfigPipeline {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface AgentQueryConfig {
  agentId: string;
  model: string;
  effort: AgentEffort;
  maxTurns: number;
  maxToolRounds: number;
  thinking?: ThinkingConfig;
  mcpServers?: McpServerConfigPipeline[];
  allowedTools?: string[];
}

export interface HarnessConfigPipelineExtension {
  maxRounds: number;
  maxSprints?: number;
  stopOnFirstFailure?: boolean;
}

export interface PipelineProject {
  id: string;
  name: string;
  projectPath: string;
  specPath: string;
  status: 'idle' | 'running' | 'paused' | 'done' | 'failed' | 'aborted' | 'interrupted';
  currentPhase: PipelinePhaseNumber | null;
  awaitingUser?: boolean;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  pipelineType?: PipelineType;
  sprints?: Array<{
    index: number;
    name: string;
    status?: string;
    coderAgentId?: string;
    evaluatorAgentId?: string;
    sprintJsonId?: string;
    sprintId?: string;
    rounds?: number;
    metrics?: Record<string, unknown>;
  }>;
}

export type BugOutcome = 'pending' | 'fix' | 'no-bug';

export function readBugOutcome(
  project: { pipelineType?: string; metadata?: Record<string, unknown> } | null | undefined,
): BugOutcome | null {
  if (!project || project.pipelineType !== 'bug') return null;
  const raw = project.metadata?.['bugOutcome'];
  if (raw === 'pending' || raw === 'fix' || raw === 'no-bug') return raw;
  return null;
}

export interface PipelineMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: import('./stream-timeline').PersistedTimelineToolCall[];
  attachments?: import('./index').ChatAttachment[];
  metadata?: Record<string, unknown>;
  sprintIndex?: number;
  roundIndex?: number;
  agentId?: string;
}

export interface PipelineSprintMessage {
  id: number;
  phaseNumber: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: import('./stream-timeline').PersistedTimelineToolCall[];
  sprintIndex: number | null;
  roundIndex: number | null;
  agentId: string | null;
  createdAt: string;
}

export interface PipelineResetPreview {
  filesToDelete: string[];
  messagesToDelete: number;
  metricsToDelete: number;
  sprintsAffected: number[];
}

export type PipelineStreamChunk =
  | {
      type: 'thinking';
      projectId: string;
      phase: number;
    }
  | {
      type: 'text';
      projectId: string;
      phase: number;
      content: string;
      auditAgentId?: string;
      auditAgentSlug?: string;
    }
  | {
      type: 'tool_call';
      projectId: string;
      phase: number;
      tool: string;
      toolCallId?: string;
      input?: unknown;
      auditAgentId?: string;
      auditAgentSlug?: string;
    }
  | {
      type: 'tool_result';
      projectId: string;
      phase: number;
      tool: string;
      toolCallId?: string;
      content?: string;
      isError?: boolean;
    }
  | {
      type: 'done';
      projectId: string;
      phase: number;
    }
  | {
      type: 'error';
      projectId: string;
      phase: number;
      message: string;
    }
  | {
      type: 'usage';
      projectId: string;
      phase: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      costUsd?: number;
    }
  | {
      type: 'phase_changed';
      projectId: string;
      phase: number;
      phaseName?: string;
      status: string;
      awaitingUser: boolean;
      metadata?: Record<string, unknown>;
    }
  | {
      type: 'sprint_complete';
      projectId: string;
      phase: number;
      sprintIndex: number;
      sprintName: string;
      verdict: string;
      reportPath?: string;
      rounds?: number;
      metrics?: Record<string, unknown>;
    };

export interface PipelinePhaseChangedEvent {
  projectId: string;
  phase: number | null;
  phaseName?: string;
  status: string;
  awaitingUser: boolean;
  metadata?: Record<string, unknown>;
  currentModel?: string | null;
}

export interface PipelineNotesUpdatedEvent {
  projectId: string;
  path: string;
  content: string;
}

export interface PipelineSprintCompleteEvent {
  projectId: string;
  sprintIndex: number;
  sprintName: string;
  verdict: string;
  reportPath?: string;
  rounds?: number;
  metrics?: Record<string, unknown>;
}

export interface PipelineProjectUpdatedEvent {
  projectId: string;
  patch: {
    status?: PipelineProject['status'];
    currentPhase?: PipelinePhaseNumber | null;
  };
}

export interface PipelineMetricsTotals {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  apiRequests: number;
  costStatus?: 'known' | 'unknown' | 'estimated-partial';
  tokenStatus?: 'reported' | 'not_reported';
  unknownCostCount?: number;
  costUnknownReasons?: string[];
}

export interface PipelinePhaseMetrics {
  id: number;
  projectId: string;
  phaseNumber: number;
  sprintIndex?: number;
  phaseName: string;
  agentId: string | null;
  status: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  apiRequests: number;
  model: string | null;
  runtime: string | null;
  startedAt: string | null;
  completedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  unknownCostCount?: number;
}

export interface RoundDetail {
  roundNumber: number;
  verdict: string | null;
  feedbackSummary: string | null;
  coderModel: string | null;
  evaluatorModel: string | null;
  coderInputTokens: number;
  coderOutputTokens: number;
  coderCostUsd: number;
  coderDurationMs: number;
  evaluatorInputTokens: number;
  evaluatorOutputTokens: number;
  evaluatorCostUsd: number;
  evaluatorDurationMs: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PipelineMetricsResult {
  totals: PipelineMetricsTotals;
  cloudCost: number;
  localCost: number;
  costByRuntime: Record<string, number>;
  costStatusByRuntime?: Record<string, 'known' | 'unknown' | 'estimated-partial'>;
  subscriptionEquivalentCost: number;
  phases: PipelinePhaseMetrics[];
  sprintPhases: PipelinePhaseMetrics[];
  agentNames: Record<string, string>;
}

export interface RepoManifest {
  projectPath: string;
  language: string;
  framework: string;
  scannedAt: string;
  totalFiles: number;
  classifiedFiles: number;
  ignoredDirs: string[];
  filesByRole: Record<string, string[]>;
  previousScan: string | null;
  skippedLargeFiles?: Array<{ path: string; sizeBytes: number }>;
}

export interface PipelineAuditAgentProgressEvent {
  projectId: string;
  agentId: string;
  slug: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  filesAnalyzed: number;
  additionalFilesAfterStart: number;
  toolCallsCount: number;
  costUsd: number;
  durationMs: number;
  findingsCount?: number;
  model?: string | null;
  agentName?: string;
  runtime?: 'cloud' | 'local' | 'external' | 'codex' | 'zai' | 'minimax-tp' | 'kimi' | 'grok' | 'cursor' | null;
}

export interface AuditAgentState {
  agentId: string;
  slug: string;
  name: string;
  model: string | null;
  runtime?: 'cloud' | 'local' | 'external' | 'codex' | 'zai' | 'minimax-tp' | 'kimi' | 'grok' | 'cursor' | null;
  status: 'queued' | 'running' | 'completed' | 'failed';
  streamContent: string;
  toolCalls: Array<{ tool: string; input: unknown }>;
  filesAnalyzed: number;
  additionalFilesAfterStart: number;
  toolCallsCount: number;
  costUsd: number;
  durationMs: number;
  findingsCount?: number;
  startedAt?: number;
  completedAt?: number;
}

export type AuditPanelSlots = readonly [string | null, string | null, string | null];

export type Role =
  | 'auth'
  | 'query'
  | 'crypto'
  | 'route'
  | 'middleware'
  | 'template'
  | 'async'
  | 'error-handling'
  | 'config'
  | 'migration';

export const ROLE_METADATA: Record<
  Role,
  {
    label: string;
    description: string;
    threshold: number;
    samplePatterns: string[];
  }
> = {
  auth: {
    label: 'Auth',
    description: 'Arquivos com logica de autenticacao',
    threshold: 2,
    samplePatterns: ['session', 'token', 'jwt.verify', 'bcrypt'],
  },
  query: {
    label: 'Query',
    description: 'Arquivos com queries de banco',
    threshold: 1,
    samplePatterns: ['SELECT', '.query(', 'prisma.', 'findOne'],
  },
  crypto: {
    label: 'Crypto',
    description: 'Arquivos com operacoes criptograficas',
    threshold: 2,
    samplePatterns: ['crypto.', 'createHash', 'encrypt', 'pbkdf2'],
  },
  route: {
    label: 'Route',
    description: 'Arquivos de rotas/handlers HTTP',
    threshold: 2,
    samplePatterns: ['router.', 'app.get(', '@Get(', '@Post('],
  },
  middleware: {
    label: 'Middleware',
    description: 'Arquivos com middlewares ou interceptors',
    threshold: 2,
    samplePatterns: ['middleware', 'next()', 'cors(', 'helmet('],
  },
  template: {
    label: 'Template',
    description: 'Arquivos de template/render HTML',
    threshold: 1,
    samplePatterns: ['innerHTML', 'dangerouslySetInnerHTML', '<%', '{{'],
  },
  async: {
    label: 'Async',
    description: 'Arquivos com codigo assincrono pesado',
    threshold: 5,
    samplePatterns: ['async', 'await', 'Promise.', 'setTimeout'],
  },
  'error-handling': {
    label: 'Error Handling',
    description: 'Arquivos com try/catch ou throw. NAO significa arquivos com bugs.',
    threshold: 3,
    samplePatterns: ['try {', 'catch (', 'throw new', 'Error('],
  },
  config: {
    label: 'Config',
    description: 'Arquivos de configuracao (env, config, settings)',
    threshold: 1,
    samplePatterns: ['.env', 'config.json', 'settings.json'],
  },
  migration: {
    label: 'Migration',
    description: 'Arquivos de migration de banco',
    threshold: 1,
    samplePatterns: ['migrations/', 'CREATE TABLE', 'ALTER TABLE'],
  },
};

export interface SecurityAgentStatusEvent {
  projectId: string;
  agentId: string;
  agentName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  findingsCount?: number;
  error?: string;
}

export interface SecuritySummary {
  totalFindings?: number;
  bySeverity?: {
    critical?: number;
    high?: number;
    medium?: number;
    low?: number;
  };
  removedByValidator?: number;
  confirmedFindings?: number;
  resolved?: number;
  partiallyResolved?: number;
  unresolved?: number;
}
