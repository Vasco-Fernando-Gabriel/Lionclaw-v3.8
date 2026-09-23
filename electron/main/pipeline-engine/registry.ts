import type { PhaseDefinition } from '../../../src/types/pipeline';
import {
  SECURITY_PIPELINE_PHASES,
  PIPELINE_PHASES,
  FEATURE_PIPELINE_PHASES,
  ARCHITECTURE_REVIEW_PIPELINE_PHASES,
  DEVELOPMENT_V2_PIPELINE_PHASES,
  BUG_PIPELINE_PHASES,
  autoPhasesOf,
  loopPhasesOf,
  resetablePhasesOf,
  maxPhaseOf,
  getPhaseNumberForAgent as getPhaseNumberForAgentByType,
} from '../../../src/types/pipeline';
import {
  DISCOVERY_AGENT_ID,
  PRD_GENERATOR_ID,
  PRD_VALIDATOR_ID,
  SPRINT_VALIDATOR_ID,
  SPEC_ENRICHER_ID,
  SPEC_BUILDER_ID,
  SPEC_VALIDATOR_ID,
  TECH_DATABASE_ID,
  TECH_BACKEND_ID,
  TECH_FRONTEND_ID,
  TECH_SECURITY_ID,
} from '../seed-agents/index';

export type PhaseArtifactMapEntry = { files: string[]; fromPhase: number; wipeSprints: boolean };
type PhaseArtifactMap = Record<number, PhaseArtifactMapEntry>;

export const SECURITY_PHASE_NAMES: Record<number, string> = Object.fromEntries(
  SECURITY_PIPELINE_PHASES.map((p) => [p.number, p.name]),
);

const SECURITY_PHASE_AGENT_IDS: Record<number, string> = Object.fromEntries(
  SECURITY_PIPELINE_PHASES.map((p) => [p.number, p.agentId]),
);

const SECURITY_PHASE_ARTIFACT_MAP: PhaseArtifactMap = {
  1: { files: ['.lionclaw/manifest.json'], fromPhase: 1, wipeSprints: true },
  2: { files: [], fromPhase: 2, wipeSprints: true },
  3: { files: [], fromPhase: 3, wipeSprints: true },
  6: { files: [], fromPhase: 6, wipeSprints: true },
  8: { files: [], fromPhase: 8, wipeSprints: true },
  9: { files: [], fromPhase: 9, wipeSprints: false },
};

const FEATURE_PHASE_NAMES: Record<number, string> = Object.fromEntries(
  FEATURE_PIPELINE_PHASES.map((p) => [p.number, p.name]),
);

const FEATURE_PHASE_AGENT_IDS: Record<number, string> = Object.fromEntries(
  FEATURE_PIPELINE_PHASES.map((p) => [p.number, p.agentId]),
);

const FEATURE_PHASE_ARTIFACT_MAP: PhaseArtifactMap = {
  1: { files: ['stories-requisitos.md', 'PRD.md', 'SPEC.md'], fromPhase: 1, wipeSprints: true },
  2: { files: ['stories-requisitos.md', 'PRD.md', 'SPEC.md'], fromPhase: 2, wipeSprints: true },
  4: { files: ['PRD.md', 'SPEC.md'], fromPhase: 4, wipeSprints: true },
  9: { files: ['SPEC.md'], fromPhase: 9, wipeSprints: true },
  11: { files: [], fromPhase: 11, wipeSprints: true },
  12: { files: [], fromPhase: 12, wipeSprints: false },
};

export const ARCHITECTURE_PHASE_NAMES: Record<number, string> = Object.fromEntries(
  ARCHITECTURE_REVIEW_PIPELINE_PHASES.map((p) => [p.number, p.name]),
);

const ARCHITECTURE_PHASE_AGENT_IDS: Record<number, string> = Object.fromEntries(
  ARCHITECTURE_REVIEW_PIPELINE_PHASES.map((p) => [p.number, p.agentId]),
);

const ARCHITECTURE_PHASE_ARTIFACT_MAP: PhaseArtifactMap = {
  1: { files: ['*'], fromPhase: 1, wipeSprints: true },
  2: {
    files: ['ArchitectureCandidates', 'ArchitectureDiagnosis', 'ArchitectureDecisions', 'SPEC', 'sprints'],
    fromPhase: 2,
    wipeSprints: true,
  },
  3: { files: ['ArchitectureDiagnosis', 'ArchitectureDecisions', 'SPEC', 'sprints'], fromPhase: 3, wipeSprints: true },
  4: { files: ['ArchitectureDecisions', 'SPEC', 'sprints'], fromPhase: 4, wipeSprints: true },
  5: { files: ['SPEC', 'sprints'], fromPhase: 5, wipeSprints: true },
  8: { files: ['sprints'], fromPhase: 8, wipeSprints: true },
  9: { files: [], fromPhase: 9, wipeSprints: false },
};

const DEV_V2_PHASE_NAMES: Record<number, string> = Object.fromEntries(
  DEVELOPMENT_V2_PIPELINE_PHASES.map((p) => [p.number, p.name]),
);

const DEV_V2_PHASE_AGENT_IDS: Record<number, string> = Object.fromEntries(
  DEVELOPMENT_V2_PIPELINE_PHASES.map((p) => [p.number, p.agentId]),
);

const DEV_V2_PHASE_ARTIFACT_MAP: PhaseArtifactMap = {
  1: { files: [], fromPhase: 1, wipeSprints: true },
  2: { files: [], fromPhase: 2, wipeSprints: true },
  3: { files: [], fromPhase: 3, wipeSprints: true },
  4: { files: [], fromPhase: 4, wipeSprints: true },
  5: { files: [], fromPhase: 5, wipeSprints: true },
  6: { files: [], fromPhase: 5, wipeSprints: true },
  7: { files: [], fromPhase: 7, wipeSprints: true },
  8: { files: [], fromPhase: 8, wipeSprints: false },
  9: { files: [], fromPhase: 9, wipeSprints: false },
  10: { files: [], fromPhase: 10, wipeSprints: false },
  11: { files: [], fromPhase: 11, wipeSprints: false },
  12: { files: [], fromPhase: 12, wipeSprints: true },
  13: { files: [], fromPhase: 13, wipeSprints: false },
  14: { files: [], fromPhase: 14, wipeSprints: true },
  15: { files: [], fromPhase: 15, wipeSprints: false },
};

export const BUG_PHASE_NAMES: Record<number, string> = Object.fromEntries(
  BUG_PIPELINE_PHASES.map((p) => [p.number, p.name]),
);

const BUG_PHASE_AGENT_IDS: Record<number, string> = Object.fromEntries(
  BUG_PIPELINE_PHASES.map((p) => [p.number, p.agentId]),
);

const BUG_PHASE_ARTIFACT_MAP: PhaseArtifactMap = {
  1: { files: ['*'], fromPhase: 1, wipeSprints: true },
  2: {
    files: [
      'analise-01-root-cause',
      'analise-02-historian',
      'analise-03-refuter',
      'plano-de-correcao',
      'SPEC',
      'sprints',
    ],
    fromPhase: 2,
    wipeSprints: true,
  },
  3: { files: ['plano-de-correcao', 'SPEC', 'sprints'], fromPhase: 3, wipeSprints: true },
  4: { files: ['SPEC', 'sprints'], fromPhase: 4, wipeSprints: true },
  6: { files: ['sprints'], fromPhase: 6, wipeSprints: true },
  7: { files: [], fromPhase: 7, wipeSprints: false },
};

const PHASE_ARTIFACT_MAP: PhaseArtifactMap = {
  1: {
    files: ['discovery-notes.md', 'stories-requisitos.md', 'PRD.md', 'SPEC.md'],
    fromPhase: 1,
    wipeSprints: true,
  },
  2: {
    files: ['stories-requisitos.md', 'PRD.md', 'SPEC.md'],
    fromPhase: 2,
    wipeSprints: true,
  },
  4: {
    files: ['PRD.md', 'SPEC.md'],
    fromPhase: 4,
    wipeSprints: true,
  },
  9: {
    files: ['SPEC.md'],
    fromPhase: 9,
    wipeSprints: true,
  },
  11: {
    files: [],
    fromPhase: 11,
    wipeSprints: true,
  },
  12: {
    files: [],
    fromPhase: 12,
    wipeSprints: false,
  },
};

const PHASE_NAMES: Record<number, string> = {
  1: 'Discovery',
  2: 'PRD Generator (Modo 1)',
  3: 'PRD Validator',
  4: 'PRD Generator (Modo 2)',
  5: 'Tech: Database',
  6: 'Tech: Backend',
  7: 'Tech: Frontend',
  8: 'Tech: Security',
  9: 'Spec Generation',
  91: 'Spec Generation (Validator)',
  10: 'Spec Enricher',
  11: 'Planner',
  12: 'Sprint Validator',
  13: 'Coder',
  14: 'Evaluator',
};

const PHASE_AGENT_IDS: Record<number, string> = {
  1: DISCOVERY_AGENT_ID,
  2: PRD_GENERATOR_ID,
  3: PRD_VALIDATOR_ID,
  4: PRD_GENERATOR_ID,
  5: TECH_DATABASE_ID,
  6: TECH_BACKEND_ID,
  7: TECH_FRONTEND_ID,
  8: TECH_SECURITY_ID,
  9: SPEC_BUILDER_ID,
  91: SPEC_VALIDATOR_ID,
  10: SPEC_ENRICHER_ID,
  11: 'harness-planner',
  12: SPRINT_VALIDATOR_ID,
  13: 'harness-coder',
  14: 'harness-evaluator',
};

export { PHASE_NAMES, PHASE_AGENT_IDS };

export function getPhasesForProject(project: { pipelineType?: string }): readonly PhaseDefinition[] {
  if (project.pipelineType === 'security') return SECURITY_PIPELINE_PHASES;
  if (project.pipelineType === 'feature') return FEATURE_PIPELINE_PHASES;
  if (project.pipelineType === 'architecture-review') return ARCHITECTURE_REVIEW_PIPELINE_PHASES;
  if (project.pipelineType === 'development-v2') return DEVELOPMENT_V2_PIPELINE_PHASES;
  if (project.pipelineType === 'bug') return BUG_PIPELINE_PHASES;
  return PIPELINE_PHASES;
}

export function getAutoPhases(project: { pipelineType?: string }): Set<number> {
  return autoPhasesOf(project.pipelineType);
}

export function getLoopPhases(project: { pipelineType?: string }): Set<number> {
  return loopPhasesOf(project.pipelineType);
}

export function getResetablePhases(project: {
  pipelineType?: string;
  config?: { openDesign?: { locked?: boolean } };
}): Set<number> {
  return resetablePhasesOf(project.pipelineType, project.config?.openDesign?.locked === true);
}

export function getPhaseName(phaseNumber: number, project: { pipelineType?: string } | undefined): string | undefined {
  if (!project) return PHASE_NAMES[phaseNumber];
  if (project.pipelineType === 'security') return SECURITY_PHASE_NAMES[phaseNumber];
  if (project.pipelineType === 'feature') return FEATURE_PHASE_NAMES[phaseNumber];
  if (project.pipelineType === 'architecture-review') return ARCHITECTURE_PHASE_NAMES[phaseNumber];
  if (project.pipelineType === 'development-v2') return DEV_V2_PHASE_NAMES[phaseNumber];
  if (project.pipelineType === 'bug') return BUG_PHASE_NAMES[phaseNumber];
  return PHASE_NAMES[phaseNumber];
}

export function getPhaseNumberForAgent(project: { pipelineType?: string }, agentId: string): number | undefined {
  return getPhaseNumberForAgentByType(project.pipelineType, agentId);
}

export function getPhaseAgentId(phaseNumber: number, project: { pipelineType?: string }): string | undefined {
  if (project.pipelineType === 'security') return SECURITY_PHASE_AGENT_IDS[phaseNumber];
  if (project.pipelineType === 'feature') return FEATURE_PHASE_AGENT_IDS[phaseNumber];
  if (project.pipelineType === 'architecture-review') return ARCHITECTURE_PHASE_AGENT_IDS[phaseNumber];
  if (project.pipelineType === 'development-v2') return DEV_V2_PHASE_AGENT_IDS[phaseNumber];
  if (project.pipelineType === 'bug') return BUG_PHASE_AGENT_IDS[phaseNumber];
  return PHASE_AGENT_IDS[phaseNumber];
}

export function getPhaseArtifactMap(
  phaseNumber: number,
  project: { pipelineType?: string },
): PhaseArtifactMapEntry | undefined {
  if (project.pipelineType === 'security') return SECURITY_PHASE_ARTIFACT_MAP[phaseNumber];
  if (project.pipelineType === 'feature') return FEATURE_PHASE_ARTIFACT_MAP[phaseNumber];
  if (project.pipelineType === 'architecture-review') return ARCHITECTURE_PHASE_ARTIFACT_MAP[phaseNumber];
  if (project.pipelineType === 'development-v2') return DEV_V2_PHASE_ARTIFACT_MAP[phaseNumber];
  if (project.pipelineType === 'bug') return BUG_PHASE_ARTIFACT_MAP[phaseNumber];
  return PHASE_ARTIFACT_MAP[phaseNumber];
}

export function getMaxPhase(project: { pipelineType?: string }): number {
  return maxPhaseOf(project.pipelineType);
}
