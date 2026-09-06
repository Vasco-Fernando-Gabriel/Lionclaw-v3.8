import type { RunBundleEntry } from './dynamic-workflow-cockpit';


export const DYNAMIC_WORKFLOW_NODE_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'blocked',
  'skipped',
  'interrupted',
  'cancelled',
] as const;

export type DynamicWorkflowNodeStatus =
  (typeof DYNAMIC_WORKFLOW_NODE_STATUSES)[number];

export const DYNAMIC_WORKFLOW_RUN_STATUSES = [
  'created',
  'running',
  'paused',
  'blocked',
  'interrupted',
  'delivered',
  'completed',
  'failed',
  'aborted',
] as const;

export type DynamicWorkflowRunStatus =
  (typeof DYNAMIC_WORKFLOW_RUN_STATUSES)[number];

export const DYNAMIC_WORKFLOW_SPRINT_STATUSES = [
  'pending',
  'running',
  'passed',
  'failed',
  'skipped',
] as const;

export type DynamicWorkflowSprintStatus =
  (typeof DYNAMIC_WORKFLOW_SPRINT_STATUSES)[number];

export const DYNAMIC_WORKFLOW_SPRINT_MERGE_STATUSES = [
  'pending',
  'merging',
  'merged',
  'conflict',
  'skipped',
] as const;

export type DynamicWorkflowSprintMergeStatus =
  (typeof DYNAMIC_WORKFLOW_SPRINT_MERGE_STATUSES)[number];

export const DYNAMIC_WORKFLOW_FAILURE_CLASSES = [
  'provider-limit',
  'provider-auth',
  'provider-error',
  'timeout',
  'schema',
  'logic',
  'cancelled',
] as const;

export type DynamicWorkflowFailureClass =
  (typeof DYNAMIC_WORKFLOW_FAILURE_CLASSES)[number];

export const DYNAMIC_WORKFLOW_GATE_MODES = [
  'auto',
  'orchestrator',
  'human',
] as const;

export type DynamicWorkflowGateMode =
  (typeof DYNAMIC_WORKFLOW_GATE_MODES)[number];

export const DYNAMIC_WORKFLOW_GATE_DECISIONS = [
  'approved',
  'rejected',
  'override-approved',
  'override-rejected',
] as const;

export type DynamicWorkflowGateDecisionValue =
  (typeof DYNAMIC_WORKFLOW_GATE_DECISIONS)[number];

export const DYNAMIC_WORKFLOW_MESSAGE_SOURCES = [
  'human',
  'orchestrator',
  'workflow-orchestrator-agent',
  'agent',
  'runner',
  'closer',
] as const;

export type DynamicWorkflowMessageSource =
  (typeof DYNAMIC_WORKFLOW_MESSAGE_SOURCES)[number];

export const DYNAMIC_WORKFLOW_INTERVENTION_SOURCES = [
  'human',
  'orchestrator',
  'workflow-orchestrator-agent',
] as const;

export type DynamicWorkflowInterventionSource =
  (typeof DYNAMIC_WORKFLOW_INTERVENTION_SOURCES)[number];


export type DynamicWorkflowNodeAccess = 'read-only' | 'workspace-write';

export type DynamicWorkflowNodeIsolation = 'shared-readonly' | 'run-workspace';

export type DynamicWorkflowNodeType =
  | 'agent'
  | 'parallel'
  | 'gate'
  | 'artifact'
  | 'checkpoint';

export type DynamicWorkflowWorkspaceMode = 'run-worktree' | 'fresh-project';

export type DynamicWorkflowCloserStatus = 'idle' | 'active' | 'closed';

export type DynamicWorkflowAutonomyMode = 'auto';

export type DynamicWorkflowPendingDecisionType =
  | 'gate'
  | 'question'
  | 'error'
  | 'provider';


export interface DynamicWorkflowManifestPhase {
  id: string;
  name: string;
  order: number;
}

export interface DynamicWorkflowManifestNode {
  id: string;
  type: DynamicWorkflowNodeType;
  phaseId: string;
  agentId?: string;
  label?: string;
  sprintId?: string;
  roundIndex?: number;
  access?: DynamicWorkflowNodeAccess;
  readSet?: string[];
  writeSet?: string[];
  isolation?: DynamicWorkflowNodeIsolation;
  allowedTools?: string[];
  allowedMcpServers?: string[];
  allowedMcpTools?: string[];
  allowedCommands?: string[];
  allowBash?: boolean;
  allowNetwork?: boolean;
  schemaRef?: string;
  timeoutMs?: number;
  costCeilingUsd?: number;
  interruptible?: 'before-start' | 'gate-only' | 'never';
  replanPolicy?: 'input-only' | 'definition-version';
  canResume: boolean;
  produces: string[];
  consumes: string[];
}

export interface DynamicWorkflowManifestGate {
  id: string;
  mode: DynamicWorkflowGateMode;
  blocks: string[];
  kind?: 'plan-review' | 'delivery';
}

export interface DynamicWorkflowManifest {
  version: 1;
  name: string;
  description?: string;
  phases: DynamicWorkflowManifestPhase[];
  nodes: DynamicWorkflowManifestNode[];
  parallelism: {
    maxConcurrentAgents: number;
    parallelWritersAllowed: false;
  };
  gates: DynamicWorkflowManifestGate[];
  estimate: { minUsd: number; maxUsd: number; unknownCostNodes: string[] };
  sprintPlan?: DynamicWorkflowSprintPlanConfig;
}

export interface DynamicWorkflowSprintPlanConfig {
  maxPlanRounds?: number;
  maxDevRounds?: number;
}


export interface PlannedSprintFeature {
  id: string;
  name: string;
  acceptanceCriteria: string[];
}

export interface PlannedSprint {
  id: string;
  index: number;
  name: string;
  description: string;
  stack: string[];
  coderAgentId: string;
  validatorAgentIds: string[];
  features: PlannedSprintFeature[];
  writeSetHint: string[];
  dependencies: string[];
  maxRounds: number;
}

export interface DynamicWorkflowSprintPlan {
  planVersion: number;
  planHash: string;
  sprints: PlannedSprint[];
}

export type PlanValidationError = {
  sprintId?: string;
  code: string;
  message: string;
};


export interface DynamicWorkflowBaselineCommand {
  id: string;
  command: string;
  cwd?: string;
  description?: string;
}

export interface DynamicWorkflowBaselineResult {
  commandId: string;
  ok: boolean;
  exitCode: number | null;
  errorCount?: number;
  summary?: string;
  capturedAt: string;
}

export interface DynamicWorkflowGateTemplate {
  id: string;
  mode: DynamicWorkflowGateMode;
  checks: string[];
  description?: string;
}

export interface DynamicWorkflowAgentSummary {
  id: string;
  name: string;
  description?: string;
  runtime: string;
  model?: string;
  skills?: string[];
  mcpServers?: string[];
}

export interface DynamicWorkflowContextBundle {
  id: string;
  projectPath: string;
  gitRoot?: string | null;
  commitSha?: string | null;
  worktreeHash?: string | null;
  specPath?: string | null;
  specSha256: string;
  repoGraphRunId?: string | null;
  repoGraphPath?: string | null;
  repoScanId?: string | null;
  relevantFiles: Array<{ path: string; reason: string; confidence: number }>;
  protectedPaths: string[];
  baselineCommands: DynamicWorkflowBaselineCommand[];
  baselineResults: DynamicWorkflowBaselineResult[];
  knownGates: DynamicWorkflowGateTemplate[];
  agentCatalogSnapshot: DynamicWorkflowAgentSummary[];
  createdBy: 'orchestrator' | 'manual';
  packageScripts?: Record<string, string>;
  hasBuildScript?: boolean;
  createdAt: string;
}


export interface WorkflowNodeExecutionPolicy {
  runId: string;
  nodeId: string;
  agentId?: string;
  workspaceRoot: string;
  cwd: string;
  access: DynamicWorkflowNodeAccess;
  allowedTools: string[];
  deniedTools: string[];
  allowedMcpServers: string[];
  allowedMcpTools: string[];
  allowedCommands: string[];
  effectiveTools: string[];
  effectiveMcpServers: string[];
  policyHash: string;
  allowBash: boolean;
  allowNetwork: boolean;
  timeoutMs: number;
  idleTimeoutMs: number;
  costCeilingUsd: number;
}


export interface DynamicWorkflowRetryPolicy {
  maxAutoRetries: number;
  backoff: 'exponential-jitter';
  retryOn: DynamicWorkflowFailureClass[];
  blockOn: DynamicWorkflowFailureClass[];
  escalateAfterRetries: boolean;
}


export type DynamicWorkflowIntervention =
  | { type: 'reply'; message: string; targetNodeId?: string }
  | { type: 'pause'; reason?: string }
  | {
      type: 'resume';
      reason?: string;
      acceptBoundary?: boolean;
    }
  | {
      type: 'rerun-node';
      nodeId: string;
      instruction: string;
    }
  | {
      type: 'approve-gate';
      gateId: string;
      decision: 'approve' | 'reject';
      reason?: string;
      payload?: Record<string, unknown>;
    }
  | { type: 'switch-agent'; nodeId: string; newAgentId: string; reason: string }
  | { type: 'adjust-next-node'; nodeId: string; instruction: string }
  | { type: 'request-replan'; scope: 'remaining' | 'phase' | 'node'; reason: string };


export interface DynamicWorkflowSnapshot {
  runId: string;
  repoPath: string;
  status: string;
  currentPhaseId?: string;
  currentNodeId?: string;
  lastCheckpointAt?: string;
  lastCheckpointAtLocal?: string;
  recentEvents: Array<{ type: string; summary: string; at: string; atLocal?: string }>;
  pendingDecision?: {
    type: DynamicWorkflowPendingDecisionType;
    id: string;
    prompt: string;
  };
  cost: { actualUsd: number; liveNodesUsd?: number; estimatedRemainingUsd?: number };
  since?: {
    nodes: number;
    green: number;
    attention: number;
    pending: number;
    failed: number;
    costUsd: number;
    durationMs: number;
  };
  lastOutcomes?: OutcomeDigest[];
}

export type OutcomeVerdict =
  | 'green'
  | 'attention'
  | 'pending'
  | 'needs-decision'
  | 'needs-human'
  | 'blocked';

export interface OutcomeDigest {
  seq: number;
  type: string;
  at: string;
  atLocal?: string;
  nodeId?: string;
  phaseId?: string;
  agentId?: string;
  label?: string;
  attempt?: number;
  verdict: OutcomeVerdict;
  wakes: boolean;
  precursor?: boolean;
  durationMs?: number;
  costUsd?: number;
  failureClass?: string;
  errorExcerpt?: string;
  outputDigest?: string;
  gateId?: string;
  p1Count?: number;
  suggestion?: 'resume';
}


export interface DynamicWorkflowValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  severity: 'error' | 'warning';
}

export interface DynamicWorkflowValidationReport {
  ok: boolean;
  issues: DynamicWorkflowValidationIssue[];
  manifestHash?: string;
  checkedAt: string;
}


export interface DynamicWorkflowDefinition {
  id: string;
  name: string;
  definitionVersion: number;
  authoringModel: string;
  parentDefinitionId: string | null;
  supersedesDefinitionId: string | null;
  sourceType: string;
  projectPath: string;
  specPath: string | null;
  specSha256: string | null;
  workflowJsPath: string;
  manifestPath: string;
  manifestJson: string;
  manifestHash: string;
  contextBundlePath: string | null;
  builderModel: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface DynamicWorkflowRun {
  id: string;
  definitionId: string;
  chatSessionId: string | null;
  status: DynamicWorkflowRunStatus;
  currentPhaseId: string | null;
  currentNodeId: string | null;
  workspaceMode: DynamicWorkflowWorkspaceMode | null;
  baseBranch: string | null;
  baseCommitSha: string | null;
  baseWorktreeHash: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  deliveredAt: string | null;
  finalizedAt: string | null;
  closerSessionId: string | null;
  closerStatus: DynamicWorkflowCloserStatus | null;
  inputJson: string;
  outputJson: string | null;
  checkpointJson: string;
  error: string | null;
  totalCostUsd: number;
  totalDurationMs: number;
  createdBy: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  projectPath?: string | null;
  sprintsTotal?: number;
  sprintsDone?: number;
  featuresTotal?: number;
}

export interface DynamicWorkflowNode {
  id: string;
  definitionId: string;
  nodeId: string;
  phaseId: string;
  sprintId: string | null;
  roundIndex: number | null;
  type: DynamicWorkflowNodeType;
  agentId: string | null;
  label: string | null;
  access: DynamicWorkflowNodeAccess | null;
  readSetJson: string;
  writeSetJson: string;
  isolation: DynamicWorkflowNodeIsolation | null;
  allowedToolsJson: string;
  allowedMcpJson: string;
  policyHash: string | null;
  timeoutMs: number | null;
  costCeilingUsd: number | null;
  dependenciesJson: string;
  retryPolicyJson: string;
  gateConfigJson: string;
  riskLevel: string | null;
  schemaRef: string | null;
  producesJson: string;
  consumesJson: string;
}

export interface DynamicWorkflowNodeRun {
  id: string;
  runId: string;
  nodeId: string;
  phaseId: string;
  type: DynamicWorkflowNodeType;
  agentId: string | null;
  status: DynamicWorkflowNodeStatus;
  attempt: number;
  inputHash: string | null;
  policyHash: string | null;
  policySnapshotJson: string;
  inputJson: string;
  outputHash: string | null;
  outputJson: string | null;
  error: string | null;
  failureClass: DynamicWorkflowFailureClass | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  costStatus: string | null;
  tokenStatus: string | null;
  costUnknownReason: string | null;
  metricsMetadataJson: string;
  model: string | null;
  runtime: string | null;
  provider: string | null;
  toolUses: number;
  apiRequests: number;
  durationMs: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DynamicWorkflowEvent {
  id: number;
  runId: string;
  nodeId: string | null;
  phaseId: string | null;
  seq: number;
  type: string;
  payloadJson: string;
  createdAt: string;
}

export interface DynamicWorkflowEventsQuery {
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  types?: string[];
}

export const COCKPIT_STRUCTURAL_EVENT_TYPES: readonly string[] = [
  'node-started',
  'node-completed',
  'node-failed',
  'node-interrupted',
  'node-cache-hit',
  'node-retry-scheduled',
  'node-stalled',
  'checkpoint-saved',
  'phase-changed',
  'gate-blocked',
  'gate-approved',
  'gate-rejected',
  'gate-decision-received',
  'gate-orphan-discarded',
  'green-check',
  'coordinator-finished',
  'run-started',
  'run-paused',
  'run-blocked-provider',
  'run-delivered',
  'run-finished',
  'run-failed',
  'run-aborted',
  'wake-planned',
  'wake-completed',
  'wake-runaway',
  'rerun-requested',
];

export interface DynamicWorkflowMessage {
  id: number;
  runId: string;
  nodeId: string | null;
  role: string;
  source: DynamicWorkflowMessageSource;
  kind: string;
  content: string;
  toolCallsJson: string | null;
  agentId: string | null;
  createdAt: string;
  appliedNodeId?: string | null;
  consumedAt?: string | null;
}

export interface DynamicWorkflowArtifact {
  id: string;
  runId: string;
  nodeId: string | null;
  kind: string;
  path: string;
  sha256: string;
  metadataJson: string;
  createdAt: string;
}

export interface DynamicWorkflowGateDecision {
  id: string;
  runId: string;
  gateId: string;
  nodeId: string | null;
  mode: DynamicWorkflowGateMode;
  decision: DynamicWorkflowGateDecisionValue;
  decidedBy: string;
  reason: string | null;
  payloadJson: string;
  createdAt: string;
}


export type DynamicWorkflowStreamChunkKind =
  | 'node'
  | 'closer'
  | 'runner'
  | 'builder'
  | 'narrator';

export interface DynamicWorkflowStreamChunk {
  kind: DynamicWorkflowStreamChunkKind;
  runId: string;
  nodeId?: string;
  attempt?: number;
  type: 'text' | 'tool_call' | 'event' | 'done' | 'error';
  content?: string;
  toolName?: string;
  eventType?: string;
  payload?: unknown;
  final?: boolean;
}


export interface DynamicWorkflowIpcError {
  error: string;
}

export interface DynamicWorkflowReplanRequest {
  scope: 'remaining' | 'phase' | 'node';
  reason: string;
  nodeId?: string;
  instruction?: string;
}

export interface DynamicWorkflowGateDecisionInput {
  decision: 'approve' | 'reject';
  reason?: string;
  payload?: Record<string, unknown>;
}

export type DynamicWorkflowCreateResult =
  | { runId: string; fallback?: boolean; fallbackReason?: string }
  | DynamicWorkflowIpcError;

export type DynamicWorkflowOkResult = { ok: true } | DynamicWorkflowIpcError;

export type DynamicWorkflowValidateResult =
  | { ok: true; report: DynamicWorkflowValidationReport }
  | DynamicWorkflowIpcError;

export type DynamicWorkflowReplanResult =
  | { ok: true; definitionId?: string }
  | DynamicWorkflowIpcError;

export type DynamicWorkflowSnapshotResult =
  | DynamicWorkflowSnapshot
  | DynamicWorkflowIpcError;


export interface DynamicWorkflowResumeOptions {
  scheduledAt?: string;
  delayMs?: number;
  acceptPolicyChange?: boolean;
  acceptBoundary?: boolean;
}

export interface DynamicWorkflowAPI {
  validate(runId: string): Promise<DynamicWorkflowValidateResult>;
  start(runId: string): Promise<DynamicWorkflowOkResult>;
  pause(runId: string): Promise<DynamicWorkflowOkResult>;
  resume(
    runId: string,
    opts?: DynamicWorkflowResumeOptions,
  ): Promise<DynamicWorkflowOkResult>;
  abort(runId: string): Promise<DynamicWorkflowOkResult>;
  reopen(runId: string): Promise<DynamicWorkflowOkResult>;
  deleteRun(runId: string): Promise<DynamicWorkflowOkResult>;
  sendMessage(
    runId: string,
    message: string,
    attachments?: string[],
  ): Promise<DynamicWorkflowOkResult>;
  intervene(
    runId: string,
    intervention: DynamicWorkflowIntervention,
  ): Promise<DynamicWorkflowOkResult>;
  requestReplan(
    runId: string,
    request: DynamicWorkflowReplanRequest,
  ): Promise<DynamicWorkflowReplanResult>;
  approveGate(
    runId: string,
    gateId: string,
    decision: DynamicWorkflowGateDecisionInput,
  ): Promise<DynamicWorkflowOkResult>;
  resolveWithCloser(
    runId: string,
    reason: string,
  ): Promise<DynamicWorkflowOkResult>;
  sendCloserMessage(
    runId: string,
    message: string,
  ): Promise<DynamicWorkflowOkResult>;
  finalizeWorkflow(runId: string): Promise<DynamicWorkflowOkResult>;
  getRun(runId: string): Promise<DynamicWorkflowRun | null>;
  getSnapshot(runId: string): Promise<DynamicWorkflowSnapshotResult>;
  listRuns(): Promise<DynamicWorkflowRun[]>;
  getNodes(runId: string): Promise<DynamicWorkflowNode[]>;
  getEvents(runId: string, opts?: DynamicWorkflowEventsQuery): Promise<DynamicWorkflowEvent[]>;
  getRunBundle(runId: string): Promise<RunBundleEntry[] | { error: string }>;
  openRunDir(runId: string): Promise<{ ok: true } | { error: string }>;
  getArtifacts(runId: string): Promise<DynamicWorkflowArtifact[]>;
  getMessages(runId: string): Promise<DynamicWorkflowMessage[]>;
  onEvent(cb: (chunk: DynamicWorkflowStreamChunk) => void): () => void;
}
