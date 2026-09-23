import type {
  DynamicWorkflowNodeStatus,
  DynamicWorkflowRunStatus,
  DynamicWorkflowGateMode,
  DynamicWorkflowGateDecisionValue,
  DynamicWorkflowMessageSource,
  DynamicWorkflowNodeAccess,
  DynamicWorkflowNodeIsolation,
  DynamicWorkflowNodeType,
  DynamicWorkflowWorkspaceMode,
  DynamicWorkflowCloserStatus,
  DynamicWorkflowRetryPolicy,
  DynamicWorkflowSprintStatus,
  DynamicWorkflowSprintMergeStatus,
  PlannedSprint,
} from '../../../src/types/dynamic-workflow';

export type {
  DynamicWorkflowNodeStatus,
  DynamicWorkflowRunStatus,
  DynamicWorkflowFailureClass,
  DynamicWorkflowGateMode,
  DynamicWorkflowGateDecisionValue,
  DynamicWorkflowMessageSource,
  DynamicWorkflowInterventionSource,
  DynamicWorkflowNodeAccess,
  DynamicWorkflowNodeIsolation,
  DynamicWorkflowNodeType,
  DynamicWorkflowWorkspaceMode,
  DynamicWorkflowCloserStatus,
  DynamicWorkflowAutonomyMode,
  DynamicWorkflowPendingDecisionType,
  DynamicWorkflowManifest,
  DynamicWorkflowSprintPlanConfig,
  DynamicWorkflowManifestPhase,
  DynamicWorkflowManifestNode,
  DynamicWorkflowManifestGate,
  DynamicWorkflowContextBundle,
  DynamicWorkflowBaselineCommand,
  DynamicWorkflowBaselineResult,
  DynamicWorkflowGateTemplate,
  DynamicWorkflowAgentSummary,
  WorkflowNodeExecutionPolicy,
  DynamicWorkflowRetryPolicy,
  DynamicWorkflowResumeOptions,
  DynamicWorkflowIntervention,
  DynamicWorkflowSnapshot,
  DynamicWorkflowValidationIssue,
  DynamicWorkflowValidationReport,
  DynamicWorkflowDefinition,
  DynamicWorkflowRun,
  DynamicWorkflowNode,
  DynamicWorkflowNodeRun,
  PlannedSprint,
  PlannedSprintFeature,
  DynamicWorkflowSprintPlan,
  DynamicWorkflowSprintStatus,
  DynamicWorkflowSprintMergeStatus,
  PlanValidationError,
  DynamicWorkflowEvent,
  DynamicWorkflowEventsQuery,
  DynamicWorkflowMessage,
  DynamicWorkflowArtifact,
  DynamicWorkflowGateDecision,
  DynamicWorkflowStreamChunkKind,
  DynamicWorkflowStreamChunk,
  DynamicWorkflowIpcError,
  DynamicWorkflowReplanRequest,
  DynamicWorkflowGateDecisionInput,
  DynamicWorkflowCreateResult,
  DynamicWorkflowOkResult,
  DynamicWorkflowValidateResult,
  DynamicWorkflowReplanResult,
  DynamicWorkflowSnapshotResult,
  DynamicWorkflowAPI,
} from '../../../src/types/dynamic-workflow';

export {
  DYNAMIC_WORKFLOW_NODE_STATUSES,
  DYNAMIC_WORKFLOW_RUN_STATUSES,
  DYNAMIC_WORKFLOW_SPRINT_STATUSES,
  DYNAMIC_WORKFLOW_SPRINT_MERGE_STATUSES,
  DYNAMIC_WORKFLOW_FAILURE_CLASSES,
  DYNAMIC_WORKFLOW_GATE_MODES,
  DYNAMIC_WORKFLOW_GATE_DECISIONS,
  DYNAMIC_WORKFLOW_MESSAGE_SOURCES,
  DYNAMIC_WORKFLOW_INTERVENTION_SOURCES,
} from '../../../src/types/dynamic-workflow';

export const CC_DELIVERY_GATE_ID = 'cc-delivery';

export const BOUNDARY_GATE_PREFIX = 'boundary:';

export function isBoundaryGateId(gateId: string): boolean {
  return gateId.startsWith(BOUNDARY_GATE_PREFIX);
}

export function boundaryGateId(phaseId: string): string {
  return `${BOUNDARY_GATE_PREFIX}${phaseId}`;
}

export const FAILURE_GATE_PREFIX = 'failure:';

export function isFailureGateId(gateId: string): boolean {
  return gateId.startsWith(FAILURE_GATE_PREFIX);
}

export function failureGateId(nodeId: string): string {
  return `${FAILURE_GATE_PREFIX}${nodeId}`;
}

export function nodeIdOfFailureGate(gateId: string): string | null {
  return isFailureGateId(gateId) ? gateId.slice(FAILURE_GATE_PREFIX.length) : null;
}

export const FAILURE_GATE_ACTIONS = ['retry', 'switch-agent', 'skip', 'abort'] as const;
export type FailureGateAction = (typeof FAILURE_GATE_ACTIONS)[number];

export const AGENT_SWITCH_MESSAGE_KIND = 'agent-switch';

export const DYNAMIC_WORKFLOW_AGENT_DENYLIST = [
  'dynamic-workflow-builder',
  'dynamic-workflow-closer',
  'dynamic-workflow-narrator',
  'dynamic-workflow-maestro',
] as const;

export interface DynamicWorkflowDefinitionCreateInput {
  id: string;
  name: string;
  definitionVersion?: number;
  parentDefinitionId?: string | null;
  supersedesDefinitionId?: string | null;
  sourceType: string;
  projectPath: string;
  specPath?: string | null;
  specSha256?: string | null;
  workflowJsPath: string;
  manifestPath: string;
  manifestJson: string;
  manifestHash: string;
  contextBundlePath?: string | null;
  builderModel?: string | null;
  status: string;
}

export interface DynamicWorkflowDefinitionPatch {
  name?: string;
  definitionVersion?: number;
  parentDefinitionId?: string | null;
  supersedesDefinitionId?: string | null;
  specPath?: string | null;
  specSha256?: string | null;
  workflowJsPath?: string;
  manifestPath?: string;
  manifestJson?: string;
  manifestHash?: string;
  contextBundlePath?: string | null;
  builderModel?: string | null;
  status?: string;
}

export interface DynamicWorkflowRunCreateInput {
  id: string;
  definitionId: string;
  chatSessionId?: string | null;
  status?: DynamicWorkflowRunStatus;
  createdBy: string;
  inputJson?: string;
  workspaceMode?: DynamicWorkflowWorkspaceMode | null;
  baseBranch?: string | null;
  baseCommitSha?: string | null;
  baseWorktreeHash?: string | null;
  worktreePath?: string | null;
  worktreeBranch?: string | null;
}

export interface DynamicWorkflowRunPatch {
  status?: DynamicWorkflowRunStatus;
  chatSessionId?: string | null;
  currentPhaseId?: string | null;
  currentNodeId?: string | null;
  workspaceMode?: DynamicWorkflowWorkspaceMode | null;
  baseBranch?: string | null;
  baseCommitSha?: string | null;
  baseWorktreeHash?: string | null;
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  deliveredAt?: string | null;
  finalizedAt?: string | null;
  closerSessionId?: string | null;
  closerStatus?: DynamicWorkflowCloserStatus | null;
  inputJson?: string;
  outputJson?: string | null;
  checkpointJson?: string;
  error?: string | null;
  totalCostUsd?: number;
  totalDurationMs?: number;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface DynamicWorkflowNodeMcpGrants {
  servers: string[];
  tools: string[];
}

export interface DynamicWorkflowNodeCreateInput {
  id: string;
  definitionId: string;
  nodeId: string;
  phaseId: string;
  type: DynamicWorkflowNodeType;
  agentId?: string | null;
  label?: string | null;
  access?: DynamicWorkflowNodeAccess | null;
  readSet?: string[];
  writeSet?: string[];
  isolation?: DynamicWorkflowNodeIsolation | null;
  allowedTools?: string[];
  allowedMcp?: DynamicWorkflowNodeMcpGrants;
  policyHash?: string | null;
  timeoutMs?: number | null;
  costCeilingUsd?: number | null;
  dependencies?: string[];
  retryPolicy?: DynamicWorkflowRetryPolicy | Record<string, unknown>;
  gateConfig?: Record<string, unknown>;
  riskLevel?: string | null;
  schemaRef?: string | null;
  produces: string[];
  consumes: string[];
}

export interface DynamicWorkflowNodeSprintPatch {
  sprintId?: string | null;
  roundIndex?: number | null;
}

export interface DynamicWorkflowSprintUpsertInput {
  runId: string;
  sprintId: string;
  planVersion: number;
  planHash: string;
  sprintIndex: number;
  name: string;
  coderAgentId?: string | null;
  validatorAgentIds: string[];
  features: PlannedSprint['features'];
  writeSetHint: string[];
  dependencies: string[];
  maxRounds: number;
  worktreePath?: string | null;
  branch?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  mergeStatus?: DynamicWorkflowSprintMergeStatus;
}

export interface DynamicWorkflowSprintPatch {
  status?: DynamicWorkflowSprintStatus;
  worktreePath?: string | null;
  branch?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  mergeStatus?: DynamicWorkflowSprintMergeStatus;
}

export interface MaterializeDynamicWorkflowSprintPlanInput {
  definitionId: string;
  nodes: DynamicWorkflowNodeCreateInput[];
  definitionPatch: DynamicWorkflowDefinitionPatch;
  nodeSprintMeta: Array<{
    nodeId: string;
    patch: DynamicWorkflowNodeSprintPatch;
  }>;
  sprints: DynamicWorkflowSprintUpsertInput[];
}

export interface DynamicWorkflowPriorMaterialization {
  planVersion: number;
  planHash: string;
  sprintNodeIds: Array<{ sprintId: string; nodeIds: string[] }>;
}

export type DynamicWorkflowJournalPrimitive = 'agent' | 'gate' | 'artifact' | 'checkpoint' | 'materializeSprintPlan';

export interface DynamicWorkflowJournalCallKey {
  callPath: string;
  primitive: DynamicWorkflowJournalPrimitive;
  nodeId: string | null;
  argHash: string;
  schemaRef: string | null;
  policyHash: string | null;
  agentId: string | null;
  model: string | null;
  runtime: string | null;
  planHash: string | null;
  workflowRevision: string | null;
}

export interface DynamicWorkflowJournalEntry extends DynamicWorkflowJournalCallKey {
  runId: string;
  callIndex: number;
  outputRef: string | null;
  sideEffectKey: string | null;
  createdAt: string;
}

export interface DynamicWorkflowJournalAppendInput extends DynamicWorkflowJournalCallKey {
  runId: string;
  callIndex: number;
  outputRef?: string | null;
  sideEffectKey?: string | null;
}

export interface DynamicWorkflowSprintRow {
  runId: string;
  sprintId: string;
  planVersion: number;
  planHash: string;
  sprintIndex: number;
  name: string;
  coderAgentId: string | null;
  validatorAgentIdsJson: string;
  featuresJson: string;
  writeSetHintJson: string;
  dependenciesJson: string;
  maxRounds: number | null;
  status: DynamicWorkflowSprintStatus;
  worktreePath: string | null;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
  mergeStatus: DynamicWorkflowSprintMergeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DynamicWorkflowNodeRunUpsertInput {
  id: string;
  runId: string;
  nodeId: string;
  phaseId: string;
  type: DynamicWorkflowNodeType;
  agentId?: string | null;
  status: DynamicWorkflowNodeStatus;
  attempt: number;
  inputHash?: string | null;
  policyHash?: string | null;
  policySnapshotJson?: string;
  inputJson?: string;
  startedAt?: string | null;
}

export interface DynamicWorkflowNodeRunPatch {
  status?: DynamicWorkflowNodeStatus;
  inputHash?: string | null;
  policyHash?: string | null;
  policySnapshotJson?: string;
  inputJson?: string;
  outputHash?: string | null;
  outputJson?: string | null;
  error?: string | null;
  failureClass?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  costStatus?: string | null;
  tokenStatus?: string | null;
  costUnknownReason?: string | null;
  metricsMetadataJson?: string;
  model?: string | null;
  runtime?: string | null;
  provider?: string | null;
  toolUses?: number;
  apiRequests?: number;
  durationMs?: number;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface DynamicWorkflowEventInsertInput {
  runId: string;
  nodeId?: string | null;
  phaseId?: string | null;
  type: string;
  payloadJson?: string;
}

export interface DynamicWorkflowMessageInsertInput {
  runId: string;
  nodeId?: string | null;
  role: string;
  source: DynamicWorkflowMessageSource;
  kind: string;
  content: string;
  toolCallsJson?: string | null;
  agentId?: string | null;
}

export interface DynamicWorkflowArtifactInsertInput {
  id: string;
  runId: string;
  nodeId?: string | null;
  kind: string;
  path: string;
  sha256: string;
  metadataJson?: string;
}

export interface DynamicWorkflowGateDecisionInsertInput {
  id: string;
  runId: string;
  gateId: string;
  nodeId?: string | null;
  mode: DynamicWorkflowGateMode;
  decision: DynamicWorkflowGateDecisionValue;
  decidedBy: string;
  reason?: string | null;
  payloadJson?: string;
}

export interface DynamicWorkflowRunCostAggregate {
  runId: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalDurationMs: number;
  nodeRunCount: number;
  unknownCostNodeRuns: number;
}

export interface DynamicWorkflowPhaseCostAggregate {
  phaseId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  nodeRunCount: number;
}
