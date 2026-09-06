

export { harnessPlanner, HARNESS_PLANNER_ID } from './harness-planner';
export { harnessCoder, HARNESS_CODER_ID } from './harness-coder';
export { harnessEvaluator, HARNESS_EVALUATOR_ID } from './harness-evaluator';

import { harnessPlanner, HARNESS_PLANNER_ID } from './harness-planner';
import { harnessCoder, HARNESS_CODER_ID } from './harness-coder';
import { harnessEvaluator, HARNESS_EVALUATOR_ID } from './harness-evaluator';

export const HARNESS_AGENT_IDS = [
  HARNESS_PLANNER_ID,
  HARNESS_CODER_ID,
  HARNESS_EVALUATOR_ID,
] as const;

export const HARNESS_SEED_AGENTS = [
  harnessPlanner,
  harnessCoder,
  harnessEvaluator,
];


export { specBuilder, SPEC_BUILDER_ID } from './spec-builder';
export { specValidator, SPEC_VALIDATOR_ID } from './spec-validator';

import { specBuilder, SPEC_BUILDER_ID } from './spec-builder';
import { specValidator, SPEC_VALIDATOR_ID } from './spec-validator';

export const PIPELINE_SPEC_AGENT_IDS = [
  SPEC_BUILDER_ID,
  SPEC_VALIDATOR_ID,
] as const;

export const PIPELINE_SPEC_SEED_AGENTS = [
  specBuilder,
  specValidator,
];


export { specValidatorEnrich, SPEC_VALIDATOR_ENRICH_ID } from './spec-validator-enrich';
export { specEnricher, SPEC_ENRICHER_ID } from './spec-enricher';

import { specValidatorEnrich, SPEC_VALIDATOR_ENRICH_ID } from './spec-validator-enrich';
import { specEnricher, SPEC_ENRICHER_ID } from './spec-enricher';

export const ENRICH_AGENT_IDS = [
  SPEC_VALIDATOR_ENRICH_ID,
  SPEC_ENRICHER_ID,
] as const;

export const ENRICH_SEED_AGENTS = [
  specValidatorEnrich,
  specEnricher,
];


export { discoveryAgent, DISCOVERY_AGENT_ID } from './discovery-agent';
export { prdGenerator, PRD_GENERATOR_ID } from './prd-generator';
export { prdValidator, PRD_VALIDATOR_ID } from './prd-validator';
export { sprintValidator, SPRINT_VALIDATOR_ID } from './sprint-validator';

import { discoveryAgent, DISCOVERY_AGENT_ID } from './discovery-agent';
import { prdGenerator, PRD_GENERATOR_ID } from './prd-generator';
import { prdValidator, PRD_VALIDATOR_ID } from './prd-validator';
import { sprintValidator, SPRINT_VALIDATOR_ID } from './sprint-validator';

export const PIPELINE_AGENT_IDS = [
  DISCOVERY_AGENT_ID,
  PRD_GENERATOR_ID,
  PRD_VALIDATOR_ID,
  SPRINT_VALIDATOR_ID,
] as const;

export const PIPELINE_SEED_AGENTS = [
  discoveryAgent,
  prdGenerator,
  prdValidator,
  sprintValidator,
];


export { techDatabase, TECH_DATABASE_ID } from './tech-database';
export { techBackend, TECH_BACKEND_ID } from './tech-backend';
export { techFrontend, TECH_FRONTEND_ID } from './tech-frontend';
export { techSecurity, TECH_SECURITY_ID } from './tech-security';

import { techDatabase, TECH_DATABASE_ID } from './tech-database';
import { techBackend, TECH_BACKEND_ID } from './tech-backend';
import { techFrontend, TECH_FRONTEND_ID } from './tech-frontend';
import { techSecurity, TECH_SECURITY_ID } from './tech-security';

export const TECH_AGENT_IDS = [
  TECH_DATABASE_ID,
  TECH_BACKEND_ID,
  TECH_FRONTEND_ID,
  TECH_SECURITY_ID,
] as const;

export const TECH_SEED_AGENTS = [
  techDatabase,
  techBackend,
  techFrontend,
  techSecurity,
];


export { skillCreator, SKILL_CREATOR_ID } from './skill-creator';

import { skillCreator } from './skill-creator';

export const SKILL_CREATOR_AGENTS = [skillCreator];


export { repoProfiler, REPO_PROFILER_ID } from './repo-profiler';
export { securitySecretsScanner, SECRETS_SCANNER_ID } from './security-secrets-scanner';
export { securityAuthAuditor, AUTH_AUDITOR_ID } from './security-auth-auditor';
export { securityIsolationInspector, ISOLATION_INSPECTOR_ID } from './security-isolation-inspector';
export { securityDuplicationDetector, DUPLICATION_DETECTOR_ID } from './security-duplication-detector';
export { securityLogicAnalyzer, LOGIC_ANALYZER_ID } from './security-logic-analyzer';
export { securityStandardsChecker, STANDARDS_CHECKER_ID } from './security-standards-checker';
export { securityOwaspScanner, OWASP_SCANNER_ID } from './security-owasp-scanner';
export { securityDeduplicator, SECURITY_DEDUPLICATOR_ID } from './security-deduplicator';
export { securitySkepticSecurity, SECURITY_SKEPTIC_SECURITY_ID } from './security-skeptic-security';
export { securitySkepticQuality, SECURITY_SKEPTIC_QUALITY_ID } from './security-skeptic-quality';
export { securityResolutionTracker, RESOLUTION_TRACKER_ID } from './security-resolution-tracker';
export { securitySpecValidator, SECURITY_SPEC_VALIDATOR_ID } from './security-spec-validator';

import { repoProfiler, REPO_PROFILER_ID } from './repo-profiler';
import { securitySecretsScanner, SECRETS_SCANNER_ID } from './security-secrets-scanner';
import { securityAuthAuditor, AUTH_AUDITOR_ID } from './security-auth-auditor';
import { securityIsolationInspector, ISOLATION_INSPECTOR_ID } from './security-isolation-inspector';
import { securityDuplicationDetector, DUPLICATION_DETECTOR_ID } from './security-duplication-detector';
import { securityLogicAnalyzer, LOGIC_ANALYZER_ID } from './security-logic-analyzer';
import { securityStandardsChecker, STANDARDS_CHECKER_ID } from './security-standards-checker';
import { securityOwaspScanner, OWASP_SCANNER_ID } from './security-owasp-scanner';
import { securityDeduplicator, SECURITY_DEDUPLICATOR_ID } from './security-deduplicator';
import { securitySkepticSecurity, SECURITY_SKEPTIC_SECURITY_ID } from './security-skeptic-security';
import { securitySkepticQuality, SECURITY_SKEPTIC_QUALITY_ID } from './security-skeptic-quality';
import { securityResolutionTracker, RESOLUTION_TRACKER_ID } from './security-resolution-tracker';
import { securitySpecValidator, SECURITY_SPEC_VALIDATOR_ID } from './security-spec-validator';

export const SECURITY_AGENT_IDS = [
  REPO_PROFILER_ID,
  SECRETS_SCANNER_ID,
  AUTH_AUDITOR_ID,
  ISOLATION_INSPECTOR_ID,
  DUPLICATION_DETECTOR_ID,
  LOGIC_ANALYZER_ID,
  STANDARDS_CHECKER_ID,
  OWASP_SCANNER_ID,
  SECURITY_DEDUPLICATOR_ID,
  SECURITY_SKEPTIC_SECURITY_ID,
  SECURITY_SKEPTIC_QUALITY_ID,
  RESOLUTION_TRACKER_ID,
  SECURITY_SPEC_VALIDATOR_ID,
] as const;

export const SECURITY_SEED_AGENTS = [
  repoProfiler,
  securitySecretsScanner,
  securityAuthAuditor,
  securityIsolationInspector,
  securityDuplicationDetector,
  securityLogicAnalyzer,
  securityStandardsChecker,
  securityOwaspScanner,
  securityDeduplicator,
  securitySkepticSecurity,
  securitySkepticQuality,
  securityResolutionTracker,
  securitySpecValidator,
];


export { backendDeveloper, BACKEND_DEVELOPER_ID } from './backend-developer';
export { frontendDeveloper, FRONTEND_DEVELOPER_ID } from './frontend-developer';
export { electronPro, ELECTRON_PRO_ID } from './electron-pro';
export { javascriptPro, JAVASCRIPT_PRO_ID } from './javascript-pro';
export { nextjsDeveloper, NEXTJS_DEVELOPER_ID } from './nextjs-developer';
export { pythonPro, PYTHON_PRO_ID } from './python-pro';
export { typescriptPro, TYPESCRIPT_PRO_ID } from './typescript-pro';
export { reactSpecialist, REACT_SPECIALIST_ID } from './react-specialist';
export { sqlPro, SQL_PRO_ID } from './sql-pro';
export { postgresPro, POSTGRES_PRO_ID } from './postgres-pro';
export { aiEngineer, AI_ENGINEER_ID } from './ai-engineer';
export { llmArchitect, LLM_ARCHITECT_ID } from './llm-architect';
export { mlEngineer, ML_ENGINEER_ID } from './ml-engineer';
export { dataAnalyst, DATA_ANALYST_ID } from './data-analyst';
export { cloudArchitect, CLOUD_ARCHITECT_ID } from './cloud-architect';
export { devopsEngineer, DEVOPS_ENGINEER_ID } from './devops-engineer';
export { codeReviewer, CODE_REVIEWER_ID } from './code-reviewer';
export { debuggerAgent, DEBUGGER_ID } from './debugger';
export { securityAuditor, SECURITY_AUDITOR_ID } from './security-auditor';

import { backendDeveloper, BACKEND_DEVELOPER_ID } from './backend-developer';
import { frontendDeveloper, FRONTEND_DEVELOPER_ID } from './frontend-developer';
import { electronPro, ELECTRON_PRO_ID } from './electron-pro';
import { javascriptPro, JAVASCRIPT_PRO_ID } from './javascript-pro';
import { nextjsDeveloper, NEXTJS_DEVELOPER_ID } from './nextjs-developer';
import { pythonPro, PYTHON_PRO_ID } from './python-pro';
import { typescriptPro, TYPESCRIPT_PRO_ID } from './typescript-pro';
import { reactSpecialist, REACT_SPECIALIST_ID } from './react-specialist';
import { sqlPro, SQL_PRO_ID } from './sql-pro';
import { postgresPro, POSTGRES_PRO_ID } from './postgres-pro';
import { aiEngineer, AI_ENGINEER_ID } from './ai-engineer';
import { llmArchitect, LLM_ARCHITECT_ID } from './llm-architect';
import { mlEngineer, ML_ENGINEER_ID } from './ml-engineer';
import { dataAnalyst, DATA_ANALYST_ID } from './data-analyst';
import { cloudArchitect, CLOUD_ARCHITECT_ID } from './cloud-architect';
import { devopsEngineer, DEVOPS_ENGINEER_ID } from './devops-engineer';
import { codeReviewer, CODE_REVIEWER_ID } from './code-reviewer';
import { debuggerAgent, DEBUGGER_ID } from './debugger';
import { securityAuditor, SECURITY_AUDITOR_ID } from './security-auditor';

export const LIBRARY_AGENT_IDS = [
  BACKEND_DEVELOPER_ID,
  FRONTEND_DEVELOPER_ID,
  ELECTRON_PRO_ID,
  JAVASCRIPT_PRO_ID,
  NEXTJS_DEVELOPER_ID,
  PYTHON_PRO_ID,
  TYPESCRIPT_PRO_ID,
  REACT_SPECIALIST_ID,
  SQL_PRO_ID,
  POSTGRES_PRO_ID,
  AI_ENGINEER_ID,
  LLM_ARCHITECT_ID,
  ML_ENGINEER_ID,
  DATA_ANALYST_ID,
  CLOUD_ARCHITECT_ID,
  DEVOPS_ENGINEER_ID,
  CODE_REVIEWER_ID,
  DEBUGGER_ID,
  SECURITY_AUDITOR_ID,
] as const;

export const LIBRARY_SEED_AGENTS = [
  backendDeveloper,
  frontendDeveloper,
  electronPro,
  javascriptPro,
  nextjsDeveloper,
  pythonPro,
  typescriptPro,
  reactSpecialist,
  sqlPro,
  postgresPro,
  aiEngineer,
  llmArchitect,
  mlEngineer,
  dataAnalyst,
  cloudArchitect,
  devopsEngineer,
  codeReviewer,
  debuggerAgent,
  securityAuditor,
];


export { featDiscovery, FEAT_DISCOVERY_ID } from './feat-discovery';
export { featPrdGenerator, FEAT_PRD_GENERATOR_ID } from './feat-prd-generator';
export { featPrdValidator, FEAT_PRD_VALIDATOR_ID } from './feat-prd-validator';
export { featPrdCompleto, FEAT_PRD_COMPLETO_ID } from './feat-prd-completo';
export { featTechDatabase, FEAT_TECH_DATABASE_ID } from './feat-tech-database';
export { featTechBackend, FEAT_TECH_BACKEND_ID } from './feat-tech-backend';
export { featTechFrontend, FEAT_TECH_FRONTEND_ID } from './feat-tech-frontend';
export { featTechSecurity, FEAT_TECH_SECURITY_ID } from './feat-tech-security';

import { featDiscovery, FEAT_DISCOVERY_ID } from './feat-discovery';
import { featPrdGenerator, FEAT_PRD_GENERATOR_ID } from './feat-prd-generator';
import { featPrdValidator, FEAT_PRD_VALIDATOR_ID } from './feat-prd-validator';
import { featPrdCompleto, FEAT_PRD_COMPLETO_ID } from './feat-prd-completo';
import { featTechDatabase, FEAT_TECH_DATABASE_ID } from './feat-tech-database';
import { featTechBackend, FEAT_TECH_BACKEND_ID } from './feat-tech-backend';
import { featTechFrontend, FEAT_TECH_FRONTEND_ID } from './feat-tech-frontend';
import { featTechSecurity, FEAT_TECH_SECURITY_ID } from './feat-tech-security';

export const FEATURE_AGENT_IDS = [
  FEAT_DISCOVERY_ID,
  FEAT_PRD_GENERATOR_ID,
  FEAT_PRD_VALIDATOR_ID,
  FEAT_PRD_COMPLETO_ID,
  FEAT_TECH_DATABASE_ID,
  FEAT_TECH_BACKEND_ID,
  FEAT_TECH_FRONTEND_ID,
  FEAT_TECH_SECURITY_ID,
] as const;

export const FEATURE_SEED_AGENTS = [
  featDiscovery,
  featPrdGenerator,
  featPrdValidator,
  featPrdCompleto,
  featTechDatabase,
  featTechBackend,
  featTechFrontend,
  featTechSecurity,
];


export { architectureMapper, ARCHITECTURE_MAPPER_ID } from './architecture-mapper';
export { architectureTargetTriage, ARCHITECTURE_TARGET_TRIAGE_ID } from './architecture-target-triage';
export { architectureDiagnostician, ARCHITECTURE_DIAGNOSTICIAN_ID } from './architecture-diagnostician';
export { architectureDecisionInterviewer, ARCHITECTURE_DECISION_INTERVIEWER_ID } from './architecture-decision-interviewer';
export { archSpecValidator, ARCH_SPEC_VALIDATOR_ID } from './arch-spec-validator';
export { architectureSpecEnricher, ARCHITECTURE_SPEC_ENRICHER_ID } from './architecture-spec-enricher';

import { architectureMapper, ARCHITECTURE_MAPPER_ID } from './architecture-mapper';
import { architectureTargetTriage, ARCHITECTURE_TARGET_TRIAGE_ID } from './architecture-target-triage';
import { architectureDiagnostician, ARCHITECTURE_DIAGNOSTICIAN_ID } from './architecture-diagnostician';
import { architectureDecisionInterviewer, ARCHITECTURE_DECISION_INTERVIEWER_ID } from './architecture-decision-interviewer';
import { archSpecValidator, ARCH_SPEC_VALIDATOR_ID } from './arch-spec-validator';
import { architectureSpecEnricher, ARCHITECTURE_SPEC_ENRICHER_ID } from './architecture-spec-enricher';

export const ARCHITECTURE_REVIEW_AGENT_IDS = [
  ARCHITECTURE_MAPPER_ID,
  ARCHITECTURE_TARGET_TRIAGE_ID,
  ARCHITECTURE_DIAGNOSTICIAN_ID,
  ARCHITECTURE_DECISION_INTERVIEWER_ID,
  ARCH_SPEC_VALIDATOR_ID,
  ARCHITECTURE_SPEC_ENRICHER_ID,
] as const;

export const ARCHITECTURE_REVIEW_SEED_AGENTS = [
  architectureMapper,
  architectureTargetTriage,
  architectureDiagnostician,
  architectureDecisionInterviewer,
  archSpecValidator,
  architectureSpecEnricher,
];


export { pipe2PrdCompleto, PIPE2_PRD_COMPLETO_ID } from './pipe2-prd-completo';
export { pipe2TechFrontend, PIPE2_TECH_FRONTEND_ID } from './pipe2-tech-frontend';
export { pipe2SpecBuilder, PIPE2_SPEC_BUILDER_ID } from './pipe2-spec-builder';
export { pipe2SpecValidator, PIPE2_SPEC_VALIDATOR_ID } from './pipe2-spec-validator';
export { pipe2SpecEnricher, PIPE2_SPEC_ENRICHER_ID } from './pipe2-spec-enricher';
export { pipe2DesignPlanner, PIPE2_DESIGN_PLANNER_ID } from './pipe2-design-planner';
export { pipe2DesignPlanValidator, PIPE2_DESIGN_PLAN_VALIDATOR_ID } from './pipe2-design-plan-validator';

import { pipe2PrdCompleto, PIPE2_PRD_COMPLETO_ID } from './pipe2-prd-completo';
import { pipe2TechFrontend, PIPE2_TECH_FRONTEND_ID } from './pipe2-tech-frontend';
import { pipe2SpecBuilder, PIPE2_SPEC_BUILDER_ID } from './pipe2-spec-builder';
import { pipe2SpecValidator, PIPE2_SPEC_VALIDATOR_ID } from './pipe2-spec-validator';
import { pipe2SpecEnricher, PIPE2_SPEC_ENRICHER_ID } from './pipe2-spec-enricher';
import { pipe2DesignPlanner, PIPE2_DESIGN_PLANNER_ID } from './pipe2-design-planner';
import { pipe2DesignPlanValidator, PIPE2_DESIGN_PLAN_VALIDATOR_ID } from './pipe2-design-plan-validator';

export const PIPE2_AGENT_IDS = [
  PIPE2_PRD_COMPLETO_ID,
  PIPE2_TECH_FRONTEND_ID,
  PIPE2_SPEC_BUILDER_ID,
  PIPE2_SPEC_VALIDATOR_ID,
  PIPE2_SPEC_ENRICHER_ID,
  PIPE2_DESIGN_PLANNER_ID,
  PIPE2_DESIGN_PLAN_VALIDATOR_ID,
] as const;

export const PIPE2_SEED_AGENTS = [
  pipe2PrdCompleto,
  pipe2TechFrontend,
  pipe2SpecBuilder,
  pipe2SpecValidator,
  pipe2SpecEnricher,
  pipe2DesignPlanner,
  pipe2DesignPlanValidator,
];


export { bugDiscovery, BUG_DISCOVERY_ID } from './bug-discovery';
export { bugRootCauseAnalyst, BUG_ROOT_CAUSE_ANALYST_ID } from './bug-root-cause-analyst';
export { bugContextHistorian, BUG_CONTEXT_HISTORIAN_ID } from './bug-context-historian';
export { bugHypothesisRefuter, BUG_HYPOTHESIS_REFUTER_ID } from './bug-hypothesis-refuter';
export { bugSolutionConsolidator, BUG_SOLUTION_CONSOLIDATOR_ID } from './bug-solution-consolidator';
export { bugSpecValidator, BUG_SPEC_VALIDATOR_ID } from './bug-spec-validator';

import { bugDiscovery, BUG_DISCOVERY_ID } from './bug-discovery';
import { bugRootCauseAnalyst, BUG_ROOT_CAUSE_ANALYST_ID } from './bug-root-cause-analyst';
import { bugContextHistorian, BUG_CONTEXT_HISTORIAN_ID } from './bug-context-historian';
import { bugHypothesisRefuter, BUG_HYPOTHESIS_REFUTER_ID } from './bug-hypothesis-refuter';
import { bugSolutionConsolidator, BUG_SOLUTION_CONSOLIDATOR_ID } from './bug-solution-consolidator';
import { bugSpecValidator, BUG_SPEC_VALIDATOR_ID } from './bug-spec-validator';

export const BUG_AGENT_IDS = [
  BUG_DISCOVERY_ID,
  BUG_ROOT_CAUSE_ANALYST_ID,
  BUG_CONTEXT_HISTORIAN_ID,
  BUG_HYPOTHESIS_REFUTER_ID,
  BUG_SOLUTION_CONSOLIDATOR_ID,
  BUG_SPEC_VALIDATOR_ID,
] as const;

export const BUG_SEED_AGENTS = [
  bugDiscovery,
  bugRootCauseAnalyst,
  bugContextHistorian,
  bugHypothesisRefuter,
  bugSolutionConsolidator,
  bugSpecValidator,
];


export { dynamicWorkflowBuilder, DYNAMIC_WORKFLOW_BUILDER_ID } from './dynamic-workflow-builder';
export {
  dynamicWorkflowMaestro,
  DYNAMIC_WORKFLOW_MAESTRO_ID,
  DYNAMIC_WORKFLOW_MCP_SERVER_ID,
} from './dynamic-workflow-builder';
export { dynamicWorkflowScout, DYNAMIC_WORKFLOW_SCOUT_ID } from './dynamic-workflow-scout';
export { dynamicWorkflowCoder, DYNAMIC_WORKFLOW_CODER_ID } from './dynamic-workflow-coder';
export { dynamicWorkflowFixer, DYNAMIC_WORKFLOW_FIXER_ID } from './dynamic-workflow-fixer';
export { dynamicWorkflowValidatorSpec, DYNAMIC_WORKFLOW_VALIDATOR_SPEC_ID } from './dynamic-workflow-validator-spec';
export { dynamicWorkflowValidatorRegression, DYNAMIC_WORKFLOW_VALIDATOR_REGRESSION_ID } from './dynamic-workflow-validator-regression';
export { dynamicWorkflowValidatorTests, DYNAMIC_WORKFLOW_VALIDATOR_TESTS_ID } from './dynamic-workflow-validator-tests';
export { dynamicWorkflowCloser, DYNAMIC_WORKFLOW_CLOSER_ID } from './dynamic-workflow-closer';
export { dynamicWorkflowNarrator, DYNAMIC_WORKFLOW_NARRATOR_ID } from './dynamic-workflow-narrator';
export { dynamicWorkflowSprintPlanner, DYNAMIC_WORKFLOW_SPRINT_PLANNER_ID } from './dynamic-workflow-sprint-planner';
export { dynamicWorkflowPlanValidatorCoverage, DYNAMIC_WORKFLOW_PLAN_VALIDATOR_COVERAGE_ID } from './dynamic-workflow-plan-validator-coverage';
export { dynamicWorkflowPlanValidatorTopology, DYNAMIC_WORKFLOW_PLAN_VALIDATOR_TOPOLOGY_ID } from './dynamic-workflow-plan-validator-topology';
export { dynamicWorkflowPlanValidatorCriteria, DYNAMIC_WORKFLOW_PLAN_VALIDATOR_CRITERIA_ID } from './dynamic-workflow-plan-validator-criteria';
export { dynamicWorkflowRefuter, DYNAMIC_WORKFLOW_REFUTER_ID } from './dynamic-workflow-refuter';
export { dynamicWorkflowCoderCodex, DYNAMIC_WORKFLOW_CODER_CODEX_ID } from './dynamic-workflow-coder-codex';
export { dynamicWorkflowCoderGlm, DYNAMIC_WORKFLOW_CODER_GLM_ID } from './dynamic-workflow-coder-glm';
export { dynamicWorkflowDocWriter, DYNAMIC_WORKFLOW_DOC_WRITER_ID } from './dynamic-workflow-doc-writer';

import { dynamicWorkflowMaestro } from './dynamic-workflow-builder';
import { dynamicWorkflowScout, DYNAMIC_WORKFLOW_SCOUT_ID } from './dynamic-workflow-scout';
import { dynamicWorkflowCoder, DYNAMIC_WORKFLOW_CODER_ID } from './dynamic-workflow-coder';
import { dynamicWorkflowFixer, DYNAMIC_WORKFLOW_FIXER_ID } from './dynamic-workflow-fixer';
import { dynamicWorkflowValidatorSpec, DYNAMIC_WORKFLOW_VALIDATOR_SPEC_ID } from './dynamic-workflow-validator-spec';
import { dynamicWorkflowValidatorRegression, DYNAMIC_WORKFLOW_VALIDATOR_REGRESSION_ID } from './dynamic-workflow-validator-regression';
import { dynamicWorkflowValidatorTests, DYNAMIC_WORKFLOW_VALIDATOR_TESTS_ID } from './dynamic-workflow-validator-tests';
import { dynamicWorkflowCloser, DYNAMIC_WORKFLOW_CLOSER_ID } from './dynamic-workflow-closer';
import { dynamicWorkflowNarrator } from './dynamic-workflow-narrator';
import { dynamicWorkflowSprintPlanner, DYNAMIC_WORKFLOW_SPRINT_PLANNER_ID } from './dynamic-workflow-sprint-planner';
import { dynamicWorkflowPlanValidatorCoverage, DYNAMIC_WORKFLOW_PLAN_VALIDATOR_COVERAGE_ID } from './dynamic-workflow-plan-validator-coverage';
import { dynamicWorkflowPlanValidatorTopology, DYNAMIC_WORKFLOW_PLAN_VALIDATOR_TOPOLOGY_ID } from './dynamic-workflow-plan-validator-topology';
import { dynamicWorkflowPlanValidatorCriteria, DYNAMIC_WORKFLOW_PLAN_VALIDATOR_CRITERIA_ID } from './dynamic-workflow-plan-validator-criteria';
import { dynamicWorkflowRefuter, DYNAMIC_WORKFLOW_REFUTER_ID } from './dynamic-workflow-refuter';
import { dynamicWorkflowCoderCodex } from './dynamic-workflow-coder-codex';
import { dynamicWorkflowCoderGlm } from './dynamic-workflow-coder-glm';
import { dynamicWorkflowDocWriter } from './dynamic-workflow-doc-writer';

export const DYNAMIC_WORKFLOW_AGENT_IDS = [
  DYNAMIC_WORKFLOW_SCOUT_ID,
  DYNAMIC_WORKFLOW_CODER_ID,
  DYNAMIC_WORKFLOW_FIXER_ID,
  DYNAMIC_WORKFLOW_VALIDATOR_SPEC_ID,
  DYNAMIC_WORKFLOW_VALIDATOR_REGRESSION_ID,
  DYNAMIC_WORKFLOW_VALIDATOR_TESTS_ID,
  DYNAMIC_WORKFLOW_CLOSER_ID,
  DYNAMIC_WORKFLOW_SPRINT_PLANNER_ID,
  DYNAMIC_WORKFLOW_PLAN_VALIDATOR_COVERAGE_ID,
  DYNAMIC_WORKFLOW_PLAN_VALIDATOR_TOPOLOGY_ID,
  DYNAMIC_WORKFLOW_PLAN_VALIDATOR_CRITERIA_ID,
  DYNAMIC_WORKFLOW_REFUTER_ID,
] as const;

export const DYNAMIC_WORKFLOW_SEED_AGENTS = [
  dynamicWorkflowScout,
  dynamicWorkflowCoder,
  dynamicWorkflowFixer,
  dynamicWorkflowValidatorSpec,
  dynamicWorkflowValidatorRegression,
  dynamicWorkflowValidatorTests,
  dynamicWorkflowCloser,
  dynamicWorkflowSprintPlanner,
  dynamicWorkflowPlanValidatorCoverage,
  dynamicWorkflowPlanValidatorTopology,
  dynamicWorkflowPlanValidatorCriteria,
  dynamicWorkflowRefuter,
];

export const DYNAMIC_WORKFLOW_AUX_SEED_AGENTS = [
  dynamicWorkflowNarrator,
  dynamicWorkflowMaestro,
];

export const DYNAMIC_WORKFLOW_CODER_VARIANT_SEED_AGENTS = [
  dynamicWorkflowCoderCodex,
  dynamicWorkflowCoderGlm,
];

export const DYNAMIC_WORKFLOW_AUTHORED_SEED_AGENTS = [dynamicWorkflowDocWriter];


import type { AgentConfig } from '../../../src/types';

type SeedAgent = Omit<AgentConfig, 'sortOrder'>;

export const ALL_SEED_AGENTS: readonly SeedAgent[] = [
  ...SKILL_CREATOR_AGENTS,
  ...HARNESS_SEED_AGENTS,
  ...PIPELINE_SPEC_SEED_AGENTS,
  ...ENRICH_SEED_AGENTS,
  ...LIBRARY_SEED_AGENTS,
  ...PIPELINE_SEED_AGENTS,
  ...TECH_SEED_AGENTS,
  ...SECURITY_SEED_AGENTS,
  ...FEATURE_SEED_AGENTS,
  ...ARCHITECTURE_REVIEW_SEED_AGENTS,
  ...PIPE2_SEED_AGENTS,
  ...BUG_SEED_AGENTS,
  ...DYNAMIC_WORKFLOW_SEED_AGENTS,
  ...DYNAMIC_WORKFLOW_AUX_SEED_AGENTS,
  ...DYNAMIC_WORKFLOW_CODER_VARIANT_SEED_AGENTS,
  ...DYNAMIC_WORKFLOW_AUTHORED_SEED_AGENTS,
];

const SEED_AGENT_BY_ID = new Map<string, SeedAgent>(
  ALL_SEED_AGENTS.map((a) => [a.id, a] as const),
);

export function listSeedAgentIds(): string[] {
  return ALL_SEED_AGENTS.map((a) => a.id);
}

export function getSeedAgentById(id: string): SeedAgent | undefined {
  return SEED_AGENT_BY_ID.get(id);
}

export function isSeedAgent(id: string): boolean {
  return SEED_AGENT_BY_ID.has(id);
}
