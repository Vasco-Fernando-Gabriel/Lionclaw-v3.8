import { swarmSecretsScanner } from './swarm-secrets-scanner';
export { swarmSecretsScanner } from './swarm-secrets-scanner';
import { swarmAuthAuditor } from './swarm-auth-auditor';
export { swarmAuthAuditor } from './swarm-auth-auditor';
import { swarmOwaspScanner } from './swarm-owasp-scanner';
export { swarmOwaspScanner } from './swarm-owasp-scanner';
import { swarmIsolationInspector } from './swarm-isolation-inspector';
export { swarmIsolationInspector } from './swarm-isolation-inspector';
import { swarmSpecCoverageValidator } from './swarm-spec-coverage-validator';
export { swarmSpecCoverageValidator } from './swarm-spec-coverage-validator';
import { swarmDocDriftDetector } from './swarm-doc-drift-detector';
export { swarmDocDriftDetector } from './swarm-doc-drift-detector';
import { swarmContractChecker } from './swarm-contract-checker';
export { swarmContractChecker } from './swarm-contract-checker';
import { swarmTestCoverageAnalyst } from './swarm-test-coverage-analyst';
export { swarmTestCoverageAnalyst } from './swarm-test-coverage-analyst';
import { swarmWebResearcher } from './swarm-web-researcher';
export { swarmWebResearcher } from './swarm-web-researcher';
import { swarmCodeExplorer } from './swarm-code-explorer';
export { swarmCodeExplorer } from './swarm-code-explorer';
import { swarmBugHypothesisHunter } from './swarm-bug-hypothesis-hunter';
export { swarmBugHypothesisHunter } from './swarm-bug-hypothesis-hunter';

export const SWARM_SEED_AGENTS = [
  swarmSecretsScanner,
  swarmAuthAuditor,
  swarmOwaspScanner,
  swarmIsolationInspector,
  swarmSpecCoverageValidator,
  swarmDocDriftDetector,
  swarmContractChecker,
  swarmTestCoverageAnalyst,
  swarmWebResearcher,
  swarmCodeExplorer,
  swarmBugHypothesisHunter,
] as const;
export const SWARM_AGENT_IDS = SWARM_SEED_AGENTS.map((seed) => seed.id);
