import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createLogger } from '../logger';
import { canonicalJsonStringify } from '../canonical-json';
import { encodeCostStatusReasonsIntoMetricsMetadata } from './workflow-cost';
import type {
  DynamicWorkflowManifest,
  DynamicWorkflowManifestNode,
  DynamicWorkflowManifestGate,
  DynamicWorkflowNodeAccess,
  DynamicWorkflowGateMode,
  DynamicWorkflowGateDecisionValue,
  DynamicWorkflowEvent,
  DynamicWorkflowEventInsertInput,
  DynamicWorkflowNodeRun,
  DynamicWorkflowNodeRunUpsertInput,
  DynamicWorkflowNodeRunPatch,
  DynamicWorkflowGateDecision,
  DynamicWorkflowGateDecisionInsertInput,
  DynamicWorkflowArtifact,
  DynamicWorkflowArtifactInsertInput,
  DynamicWorkflowMessage,
  DynamicWorkflowMessageInsertInput,
  DynamicWorkflowNodeCreateInput,
  DynamicWorkflowNodeSprintPatch,
  DynamicWorkflowSprintUpsertInput,
  DynamicWorkflowDefinitionPatch,
  MaterializeDynamicWorkflowSprintPlanInput,
  DynamicWorkflowPriorMaterialization,
  PlannedSprint,
  PlannedSprintFeature,
  DynamicWorkflowSprintPlan,
  PlanValidationError,
  DynamicWorkflowJournalEntry,
  DynamicWorkflowJournalAppendInput,
  DynamicWorkflowJournalCallKey,
  DynamicWorkflowJournalPrimitive,
  DynamicWorkflowFailureClass,
} from './types';
import type { DynamicWorkflowStreamChunk } from '../../../src/types/dynamic-workflow';
import type { CodexChatReasoningEffort } from '../../../src/types';
import { validateWorkflowPackage, type ValidateWorkflowPackageInput } from './workflow-validator';
import { DEV_DEFAULT_FIXER_AGENT_ID, DEV_DEFAULT_VALIDATOR_AGENT_IDS } from './dev-loop-ids';
import { DYNAMIC_WORKFLOW_CODER_ID } from '../seed-agents/dynamic-workflow-coder';
import {
  DYNAMIC_WORKFLOW_AGENT_DENYLIST,
  boundaryGateId,
  failureGateId,
  FAILURE_GATE_ACTIONS,
  AGENT_SWITCH_MESSAGE_KIND,
  type FailureGateAction,
} from './types';
import { AGENT_DENYLIST_REASON } from './authored-agent-validation';
import {
  assessBoundary,
  eventsSince,
  extractRefuterVerdicts,
  extractValidatorFindings,
  findWindowStartSeq,
  summarizeParsedOutput,
} from './workflow-outcome';
import {
  runNodeAgent,
  type NodeRunResult,
  type WorkflowAdapterDeps,
  type RunNodeAgentInput,
} from './workflow-agent-adapter';
import { computeNodeGrantsHash, type NodePolicyGrants, type PolicyWorkspace } from './workflow-policy';
import { runGateChecks, type GateCheckSpec, type GateCheckResult, type GateRunResult } from './workflow-gates';
import { writeArtifact, type WorkflowArtifactsDeps } from './workflow-artifacts';
import {
  saveNodeCheckpoint,
  readNodeCheckpoint,
  lookupJournalReplay,
  type WorkflowCheckpointsDeps,
  type DynamicWorkflowNodeCheckpointFile,
} from './workflow-checkpoints';
import { classifyFailureByRuntime, type WorkflowFailureRuntime } from './workflow-failure';
import { jsonSchemaToOutputSchema } from './workflow-schema';
import type { SchemaValidator, WorkflowOutputSchema } from './workflow-schema';

const logger = createLogger('dynamic-workflow-host-api');

export const RUNTIME_AGENT_DENYLIST = new Set<string>(DYNAMIC_WORKFLOW_AGENT_DENYLIST);

const FAILURE_RUNTIME_VALUES: ReadonlySet<WorkflowFailureRuntime> = new Set<WorkflowFailureRuntime>([
  'cloud',
  'local',
  'external',
  'codex',
  'zai',
  'minimax-tp',
  'cursor',
]);

function coerceFailureRuntime(runtime: string): WorkflowFailureRuntime {
  return FAILURE_RUNTIME_VALUES.has(runtime as WorkflowFailureRuntime) ? (runtime as WorkflowFailureRuntime) : 'cloud';
}

export const WORKFLOW_PARALLEL_SPRINT_CAP = 3;

export const WORKFLOW_IMPLICIT_NODE_CAP = 1000;
export const WORKFLOW_PARALLEL_ITEMS_CAP = 4096;

function normalizeGlob(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\//, '')
    .trim();
}

export function globsCanOverlap(globA: string, globB: string): boolean {
  const a = normalizeGlob(globA);
  const b = normalizeGlob(globB);
  if (a === b) return true;
  if (a.length === 0 || b.length === 0) return false;
  return segmentsCanOverlap(a.split('/'), b.split('/'));
}

function segmentsCanOverlap(a: string[], b: string[]): boolean {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const segA = a[i];
    const segB = b[j];
    if (segA === '**' || segB === '**') return true;
    if (!segmentTokensCanOverlap(segA, segB)) return false;
    i++;
    j++;
  }
  const rest = i < a.length ? a.slice(i) : b.slice(j);
  if (rest.length === 0) return true;
  return rest.every((s) => s === '**');
}

function segmentTokensCanOverlap(segA: string, segB: string): boolean {
  const wildA = segA.includes('*') || segA.includes('?');
  const wildB = segB.includes('*') || segB.includes('?');
  if (!wildA && !wildB) return segA === segB;
  return true;
}

export function sprintWriteSetsDisjoint(
  writeSetA: readonly string[] | undefined,
  writeSetB: readonly string[] | undefined,
): boolean {
  const a = (writeSetA ?? []).map(normalizeGlob).filter((g) => g.length > 0);
  const b = (writeSetB ?? []).map(normalizeGlob).filter((g) => g.length > 0);
  if (a.length === 0 || b.length === 0) return false;
  if (a.includes('**') || b.includes('**')) return false;
  for (const gA of a) {
    for (const gB of b) {
      if (globsCanOverlap(gA, gB)) return false;
    }
  }
  return true;
}

export interface ParallelGroupSprint {
  sprintId: string;
  index: number;
  writeSet: readonly string[];
  dependencies: readonly string[];
}

export function partitionSprintsForParallel(
  sprints: readonly ParallelGroupSprint[],
  cap: number = WORKFLOW_PARALLEL_SPRINT_CAP,
): Array<{ sprintIds: string[] }> {
  const SEQUENTIAL_ONLY = true;
  const limit = SEQUENTIAL_ONLY ? 1 : Math.max(1, Math.min(WORKFLOW_PARALLEL_SPRINT_CAP, Math.floor(cap)));
  const ordered = [...sprints].sort((x, y) => x.index - y.index);
  const remaining = new Set(ordered.map((s) => s.sprintId));
  const batched = new Set<string>();
  const byId = new Map(ordered.map((s) => [s.sprintId, s]));
  const batches: Array<{ sprintIds: string[] }> = [];

  while (remaining.size > 0) {
    const batch: ParallelGroupSprint[] = [];
    for (const s of ordered) {
      if (!remaining.has(s.sprintId)) continue;
      if (batch.length >= limit) break;
      const depsReady = s.dependencies.every((d) => batched.has(d) || !byId.has(d));
      if (!depsReady) continue;
      const disjointFromBatch = batch.every((other) => sprintWriteSetsDisjoint(s.writeSet, other.writeSet));
      if (!disjointFromBatch) continue;
      batch.push(s);
    }
    if (batch.length === 0) {
      const next = ordered.find((s) => remaining.has(s.sprintId));
      if (!next) break;
      batch.push(next);
    }
    for (const s of batch) {
      remaining.delete(s.sprintId);
      batched.add(s.sprintId);
    }
    batches.push({ sprintIds: batch.map((s) => s.sprintId) });
  }
  return batches;
}

export function computeCanonicalFailureClass(input: {
  runtime: string;
  error: unknown;
  errorMessage: string | null;
  adapterFailureClass: DynamicWorkflowNodeRunFailureClass | null;
  timedOut?: boolean;
  httpStatus?: number;
  aborted?: boolean;
}): DynamicWorkflowFailureClass {
  if (input.adapterFailureClass === 'cancelled') return 'cancelled';
  return classifyFailureByRuntime({
    runtime: coerceFailureRuntime(input.runtime),
    error: input.error ?? input.errorMessage ?? input.adapterFailureClass ?? 'falha de node',
    schemaExhausted: input.adapterFailureClass === 'schema',
    timedOut: input.timedOut,
    httpStatus: input.httpStatus,
    aborted: input.aborted,
  });
}

export class WorkflowHostFatalError extends Error {
  readonly isWorkflowHostFatal = true as const;
  readonly code: WorkflowHostFatalCode;
  constructor(code: WorkflowHostFatalCode, message: string) {
    super(message);
    this.name = 'WorkflowHostFatalError';
    this.code = code;
  }
}

export type WorkflowHostFatalCode =
  | 'node-not-in-manifest'
  | 'gate-not-in-manifest'
  | 'duplicate-node-id'
  | 'phase-not-in-meta'
  | 'run-aborted'
  | 'policy-invalid'
  | 'gate-rejected'
  | 'gate-inconclusive'
  | 'prompt-invalid'
  | 'agent-denylisted'
  | 'agent-missing'
  | 'writer-schema-forbidden'
  | 'effort-invalid'
  | 'implicit-node-cap-exceeded'
  | 'parallel-items-cap-exceeded'
  | 'isolation-unsupported';

export const WORKFLOW_AGENT_EFFORTS: readonly CodexChatReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

export function isWorkflowAgentEffort(value: string): value is CodexChatReasoningEffort {
  return (WORKFLOW_AGENT_EFFORTS as readonly string[]).includes(value);
}

export interface AgentPrimitiveArg {
  id: string;
  agentId: string;
  label?: string;
  agentType?: string;
  model?: string;
  effort?: string;
  phase?: string;
  access?: DynamicWorkflowNodeAccess;
  allowedTools?: string[];
  allowedMcpServers?: string[];
  allowedMcpTools?: string[];
  allowedCommands?: string[];
  allowBash?: boolean;
  allowNetwork?: boolean;
  writeSet?: string[];
  isolation?: string;
  schema?: string | Record<string, unknown>;
  timeoutMs?: number;
  costCeilingUsd?: number;
  maxTurns?: number;
  prompt: string;
  sprintIndex?: number;
}

export interface GatePrimitiveArg {
  id: string;
  mode: DynamicWorkflowGateMode;
  checks?: unknown[];
  kind?: DynamicWorkflowManifestGate['kind'];
  escalateIfRed?: boolean;
}

export interface GatePrimitiveResult {
  ok: boolean;
  mode: DynamicWorkflowGateMode;
  findings: unknown[];
  approvedBy?: string;
  checks?: GateRunResult['checks'];
  reason?: string;
  decisionPayload?: Record<string, unknown>;
}

export interface GreenCheckPrimitiveArg {
  checks?: unknown[];
  final?: boolean;
  sprintIndex?: number;
}

export interface GreenCheckResult {
  ok: boolean;
  inconclusive: boolean;
  findings: GreenCheckFinding[];
  checks: GateRunResult['checks'];
}

export interface GreenCheckFinding {
  severity: 'P1';
  where: string;
  problem: string;
  fix: string;
}

export interface ArtifactPrimitiveArg {
  id?: string;
  type?: string;
  path: string;
  data?: unknown;
  content?: string;
}

export interface CheckpointPrimitiveArg {
  id: string;
  state?: unknown;
}

export interface ParallelOptions {
  id?: string;
  maxConcurrency?: number;
  failFast?: boolean;
}

export type WorkflowThunk = () => Promise<unknown> | unknown;

export interface PendingGateResolution {
  decision: 'approve' | 'reject';
  approvedBy: string;
  reason?: string;
  payload?: Record<string, unknown>;
}

export interface GateGate {
  awaitDecision: (gateId: string, mode: DynamicWorkflowGateMode) => Promise<PendingGateResolution>;
  discardStaleGate?: (gateId: string) => void;
}

export interface HostApiCrud {
  upsertNodeRun: (input: DynamicWorkflowNodeRunUpsertInput) => DynamicWorkflowNodeRun;
  updateNodeRun: (id: string, patch: DynamicWorkflowNodeRunPatch) => void;
  insertEvent: (input: DynamicWorkflowEventInsertInput) => DynamicWorkflowEvent;
  insertGateDecision: (input: DynamicWorkflowGateDecisionInsertInput) => DynamicWorkflowGateDecision;
  registerArtifact: (input: DynamicWorkflowArtifactInsertInput) => DynamicWorkflowArtifact;
  insertMessage?: (input: DynamicWorkflowMessageInsertInput) => DynamicWorkflowMessage;
  getRunCheckpoint: (runId: string) => string | null;
  persistRunCheckpoint: (runId: string, checkpointJson: string) => void;
  addRunCost: (runId: string, addUsd: number, addDurationMs: number) => void;
  patchRun: (runId: string, patch: HostRunPatch) => void;
  createNodes?: (definitionId: string, nodes: DynamicWorkflowNodeCreateInput[]) => void;
  updateDefinition?: (definitionId: string, patch: DynamicWorkflowDefinitionPatch) => void;
  persistSprints?: (sprints: DynamicWorkflowSprintUpsertInput[]) => void;
  setNodeSprintMeta?: (definitionId: string, nodeId: string, patch: DynamicWorkflowNodeSprintPatch) => void;
  materializeSprintPlan?: (input: MaterializeDynamicWorkflowSprintPlanInput) => void;
  appendJournalEntry?: (input: DynamicWorkflowJournalAppendInput) => void;
  listJournalEntries?: (runId: string) => DynamicWorkflowJournalEntry[];
  truncateJournalFrom?: (runId: string, fromIndex: number) => void;
  listEventsSince?: (runId: string, afterSeq: number) => DynamicWorkflowEvent[];
  claimAdjustmentsForNode?: (runId: string, nodeId: string) => DynamicWorkflowMessage[];
  getConsumedAdjustmentsForNode?: (runId: string, nodeId: string) => DynamicWorkflowMessage[];
}

export const ADJUSTMENT_PROMPT_HEADER = '\n\n[AJUSTE DO ORQUESTRADOR]\n';

export function buildAdjustmentText(adjustments: readonly DynamicWorkflowMessage[]): string | undefined {
  if (adjustments.length === 0) return undefined;
  const seen = new Set<number>();
  const ordered = [...adjustments]
    .filter((a) => {
      if (a.kind === AGENT_SWITCH_MESSAGE_KIND) return false;
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    })
    .sort((a, b) => a.id - b.id);
  const text = ordered
    .map((a) => a.content.trim())
    .filter((c) => c.length > 0)
    .join('\n\n');
  return text.length > 0 ? text : undefined;
}

function remapWorkflowToolOffsets(
  previousContent: string,
  nextContent: string,
  tools: Array<{ textOffset: number }>,
): void {
  if (previousContent === nextContent) return;

  let prefix = 0;
  const prefixLimit = Math.min(previousContent.length, nextContent.length);
  while (prefix < prefixLimit && previousContent[prefix] === nextContent[prefix]) prefix += 1;

  let suffix = 0;
  const suffixLimit = Math.min(previousContent.length - prefix, nextContent.length - prefix);
  while (
    suffix < suffixLimit &&
    previousContent[previousContent.length - 1 - suffix] === nextContent[nextContent.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const previousChangedEnd = previousContent.length - suffix;
  const delta = nextContent.length - previousContent.length;
  for (const tool of tools) {
    const offset = tool.textOffset;
    const remapped = offset <= prefix ? offset : offset >= previousChangedEnd ? offset + delta : prefix;
    tool.textOffset = Math.max(0, Math.min(nextContent.length, remapped));
  }
}

export interface HostRunPatch {
  status?: DynamicWorkflowNodeStatusRunSubset;
  currentPhaseId?: string | null;
  currentNodeId?: string | null;
  pendingDecisionJson?: string;
  error?: string | null;
}

export type DynamicWorkflowNodeStatusRunSubset = 'running' | 'blocked' | 'failed';

export interface HostApiDeps {
  crud: HostApiCrud;
  runNodeAgent?: typeof runNodeAgent;
  adapterDeps?: WorkflowAdapterDeps;
  runGateChecks?: typeof runGateChecks;
  gateGate: GateGate;
  emit: (input: {
    runId: string;
    type: string;
    nodeId?: string | null;
    phaseId?: string | null;
    payload?: unknown;
  }) => void;
  emitStreamChunk?: (chunk: DynamicWorkflowStreamChunk) => void;
  generateId?: (prefix: string) => string;
  now?: () => string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface HostApiRunContext {
  runId: string;
  manifest: DynamicWorkflowManifest;
  workspaceRoot: string;
  resolveSprintCwd?: (sprintIndex: number) => string | null;
  prepareSprintWorktrees?: (sprintIndexes: number[]) => Promise<void>;
  definitionId?: string;
  projectPath?: string;
  hasBuildScript?: boolean;
  sprintPlanConfig?: {
    maxDevRounds?: number;
    maxPlanRounds?: number;
  };
  maxImplicitNodesPerRun?: number;
  maxParallelItemsPerCall?: number;
  priorMaterialized?: DynamicWorkflowPriorMaterialization;
  catalogAgentIds?: string[];
  schemaFileNames?: string[];
  resolveSchemaRef?: (schemaRef: string) => WorkflowOutputSchema | null | undefined;
  schemaValidator?: SchemaValidator;
  buildSprintNodes?: (
    plan: DynamicWorkflowSprintPlan,
    config: {
      maxDevRounds: number;
      fixerAgentId?: string | null;
    },
  ) => {
    manifestNodes: DynamicWorkflowManifestNode[];
    createInputs: DynamicWorkflowNodeCreateInput[];
    sprintNodeIds: Array<{ sprintId: string; nodeIds: string[] }>;
  };
  runDir: string;
  readNodeCheckpoint?: (nodeId: string) => DynamicWorkflowNodeCheckpointFile | null;
  workflowRevision?: string;
  protectedPaths?: string[];
  resolveGateChecks?: (checks: GateCheckSpec[], gateId: string) => GateCheckSpec[];
  abortSignal: AbortSignal;
  onFinalGateApproved?: (gateId: string, approvedBy: string) => Promise<void>;
  onWriterNodeCompleted?: (input: {
    nodeId: string;
    attempt: number;
    access: DynamicWorkflowNodeAccess;
    writeSet: string[];
  }) => Promise<{ sha: string; touchedFiles: string[] } | null>;
  onNodeFailed?: (input: {
    nodeId: string;
    attempt: number;
    failureClass: DynamicWorkflowNodeRunFailureClass | null;
    runtime: string;
    error: unknown;
    errorMessage?: string | null;
    recoverable: boolean;
  }) => void | NodeFailureHookOutcome | Promise<void | NodeFailureHookOutcome>;
  onWriterNodeFailed?: (input: { nodeId: string; attempt: number }) => Promise<{ sha: string | null } | null>;
  onNodeSkipped?: (input: { nodeId: string; attempt: number; wipSha: string | null }) => Promise<void>;
  registerNodeAbort?: (nodeId: string, attempt: number, controller: AbortController) => () => void;
  resolveAgentAxes?: (agentType: string) => {
    access: DynamicWorkflowNodeAccess;
    allowBash: boolean;
    allowedCommands: string[];
    allowNetwork: boolean;
    allowedTools: string[];
  } | null;
}

export type DynamicWorkflowNodeRunFailureClass = NonNullable<DynamicWorkflowNodeRunPatch['failureClass']>;

export interface NodeFailureHookOutcome {
  outcome: 'retry-scheduled' | 'blocked-provider' | 'cancelled';
  backoffMs: number;
  failureClass: DynamicWorkflowNodeRunFailureClass;
  retriesExhausted?: boolean;
  attemptsMade?: number;
}

function isNodeFailureHookOutcome(value: unknown): value is NodeFailureHookOutcome {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    (v.outcome === 'retry-scheduled' || v.outcome === 'blocked-provider' || v.outcome === 'cancelled') &&
    typeof v.backoffMs === 'number'
  );
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function agentSwitchFrom(messages: readonly DynamicWorkflowMessage[]): string | undefined {
  let latest: DynamicWorkflowMessage | undefined;
  for (const m of messages) {
    if (m.kind !== AGENT_SWITCH_MESSAGE_KIND) continue;
    if (!latest || m.id > latest.id) latest = m;
  }
  const value = latest?.content.trim();
  return value && value.length > 0 ? value : undefined;
}

export function parseFailureGateAction(value: unknown): FailureGateAction | null {
  return typeof value === 'string' && (FAILURE_GATE_ACTIONS as readonly string[]).includes(value)
    ? (value as FailureGateAction)
    : null;
}

export function buildFailurePendingDecision(input: {
  nodeId: string;
  failureClass: string | null;
  nodeError: string | null;
  retriesExhausted: boolean;
  attemptsMade: number;
}): {
  type: 'provider';
  id: string;
  gateId: string;
  prompt: string;
  nodeId: string;
  failureClass: string | null;
  retriesExhausted: boolean;
  attemptsMade: number;
  nodeError: string | null;
  actions: FailureGateAction[];
} {
  const gateId = failureGateId(input.nodeId);
  const cls = input.failureClass ?? 'desconhecida';
  const why = input.retriesExhausted
    ? `esgotou ${input.attemptsMade} tentativa(s) automatica(s)`
    : `classe ${cls} nao e retryavel (${input.attemptsMade} tentativa(s))`;
  return {
    type: 'provider',
    id: gateId,
    gateId,
    prompt:
      `node '${input.nodeId}' falhou (classe ${cls}; ${why}): ${input.nodeError ?? 'sem detalhe'}. ` +
      `O coordenador esta PARADO ate a decisao. Aprove o gate '${gateId}' com payload.action = ` +
      `retry (nova attempt agora; payload.instruction opcional) | switch-agent (payload.agentType) | ` +
      `skip (devolve null ao workflow.js) | abort; reject = abort.`,
    nodeId: input.nodeId,
    failureClass: input.failureClass,
    retriesExhausted: input.retriesExhausted,
    attemptsMade: input.attemptsMade,
    nodeError: input.nodeError,
    actions: [...FAILURE_GATE_ACTIONS],
  };
}

export function nodeOutputForScript(
  result: Pick<NodeRunResult, 'output' | 'structuredOutput'>,
  schemaRef: string | null,
): unknown {
  if (result.structuredOutput !== undefined) return result.structuredOutput;
  return schemaRef ? parseNodeOutput(result.output) : result.output;
}

export function unwrapLegacyOutputEnvelope(state: unknown, schemaRef: string | null): unknown {
  if (schemaRef) return state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  const keys = Object.keys(state as Record<string, unknown>);
  const output = (state as Record<string, unknown>).output;
  if (keys.length === 1 && keys[0] === 'output' && typeof output === 'string') return output;
  return state;
}

export function detectBuildScript(cwd: string): boolean | null {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: unknown };
    const scripts = parsed && typeof parsed === 'object' ? parsed.scripts : undefined;
    if (!scripts || typeof scripts !== 'object') return false;
    return typeof (scripts as Record<string, unknown>).build === 'string';
  } catch {
    return null;
  }
}

export interface WorkflowHostApi {
  phase: (arg: unknown) => Promise<unknown>;
  agent: (arg: unknown) => Promise<unknown>;
  parallel: (arg: unknown) => Promise<unknown>;
  pipeline: (arg: unknown) => Promise<unknown>;
  gate: (arg: unknown) => Promise<unknown>;
  artifact: (arg: unknown) => Promise<unknown>;
  checkpoint: (arg: unknown) => Promise<unknown>;
  log: (arg: unknown) => Promise<unknown>;
  validateSprintPlan: (arg: unknown) => Promise<unknown>;
  materializeSprintPlan: (arg: unknown) => Promise<unknown>;
  greenCheck: (arg: unknown) => Promise<unknown>;
}

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultGenerateId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

export interface AgentSemaphore {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export const CODEX_NODE_CONCURRENCY_CEILING = 3;

export function effectiveMaxConcurrentAgents(ctx: HostApiRunContext): number {
  return Math.min(ctx.manifest.parallelism.maxConcurrentAgents, CODEX_NODE_CONCURRENCY_CEILING);
}

export function createAgentSemaphore(max: number): AgentSemaphore {
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
  let active = 0;
  const queue: Array<() => void> = [];

  function release(): void {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  }

  function acquire(): Promise<void> {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queue.push(() => {
        active += 1;
        resolve();
      });
    });
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

export { canonicalJsonStringify };

export function computeInlineSchemaRef(schema: Record<string, unknown>): string {
  const hash = createHash('sha256').update(canonicalJsonStringify(schema)).digest('hex');
  return `cc-schema:${hash}`;
}

export function computeNodeInputHash(input: {
  agentId: string;
  prompt: string;
  access?: string;
  schemaRef?: string;
  writeSet?: string[];
  effectiveModel?: string;
  effectiveEffort?: string;
  adjustment?: string;
  effectiveMaxTurns?: number;
}): string {
  const canonical = {
    agentId: input.agentId,
    prompt: input.prompt,
    access: input.access ?? 'read-only',
    schemaRef: input.schemaRef ?? null,
    writeSet: [...(input.writeSet ?? [])].sort(),
    ...(input.effectiveModel ? { effectiveModel: input.effectiveModel } : {}),
    ...(input.effectiveEffort ? { effectiveEffort: input.effectiveEffort } : {}),
    ...(input.effectiveMaxTurns !== undefined ? { effectiveMaxTurns: input.effectiveMaxTurns } : {}),
    ...(input.adjustment ? { adjustment: input.adjustment } : {}),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export const AGENT_MAX_TURNS_CEILING = 400;

export function clampMaxTurns(value: unknown, nodeId?: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    logger.warn({ nodeId, maxTurns: value }, 'agent({ maxTurns }) ignorado: valor nao numerico');
    return undefined;
  }
  return Math.min(AGENT_MAX_TURNS_CEILING, Math.max(1, Math.floor(value)));
}

const USER_QUESTION_MCP_SERVER = 'lionclaw-user-question';

export function isUserQuestionTool(toolName: string | undefined): boolean {
  return typeof toolName === 'string' && toolName.includes(USER_QUESTION_MCP_SERVER);
}

export function createWorkflowHostApi(ctx: HostApiRunContext, deps: HostApiDeps): WorkflowHostApi {
  const now = deps.now ?? defaultNow;
  const generateId = deps.generateId ?? defaultGenerateId;
  const adapterRun = deps.runNodeAgent ?? runNodeAgent;
  const gateChecks = deps.runGateChecks ?? runGateChecks;

  const nodeById = new Map<string, DynamicWorkflowManifestNode>();
  for (const n of ctx.manifest.nodes) nodeById.set(n.id, n);
  const gateById = new Map<string, DynamicWorkflowManifestGate>();
  for (const g of ctx.manifest.gates) gateById.set(g.id, g);
  const phaseIds = new Set(ctx.manifest.phases.map((p) => p.id));

  const attemptByNode = new Map<string, number>();
  const seenNodeIds = new Set<string>();
  let currentPhaseId: string | null = null;

  const implicitOccByBase = new Map<string, number>();
  const implicitNodeIds = new Set<string>();

  let implicitNodesCreated = 0;
  const implicitNodeCap = ctx.maxImplicitNodesPerRun ?? WORKFLOW_IMPLICIT_NODE_CAP;
  const parallelItemsCap = ctx.maxParallelItemsPerCall ?? WORKFLOW_PARALLEL_ITEMS_CAP;

  const ccSchemaRegistry = new Map<string, WorkflowOutputSchema>();

  function resolveCanonicalSchema(schemaRef: string | null): WorkflowOutputSchema | undefined {
    if (!schemaRef) return undefined;
    const fromRegistry = ccSchemaRegistry.get(schemaRef);
    if (fromRegistry) return fromRegistry;
    return ctx.resolveSchemaRef ? (ctx.resolveSchemaRef(schemaRef) ?? undefined) : undefined;
  }

  let planVersionCounter = 0;
  let lastValidatedHash: string | null = null;
  const materialized = new Map<
    number,
    { planHash: string; sprintNodeIds: Array<{ sprintId: string; nodeIds: string[] }> }
  >();

  if (ctx.priorMaterialized) {
    materialized.set(ctx.priorMaterialized.planVersion, {
      planHash: ctx.priorMaterialized.planHash,
      sprintNodeIds: ctx.priorMaterialized.sprintNodeIds,
    });
  }

  let journalCursor = 0;
  let journalPrefixIntact = true;
  const journalEntries: DynamicWorkflowJournalEntry[] = (() => {
    try {
      return deps.crud.listJournalEntries?.(ctx.runId) ?? [];
    } catch (err) {
      logger.warn({ err, runId: ctx.runId }, 'falha ao ler journal (resume degrada para sem-reuso)');
      return [];
    }
  })();

  let journalPlanHashAsOf: string | null =
    journalEntries.length > 0 ? journalEntries[0]!.planHash : (ctx.priorMaterialized?.planHash ?? null);

  function currentPlanHash(): string | null {
    return journalPlanHashAsOf;
  }

  interface JournalClaim {
    callIndex: number;
    decision: 'reuse' | 'fresh';
    entry?: DynamicWorkflowJournalEntry;
  }

  function claimJournalCall(
    key: Omit<DynamicWorkflowJournalCallKey, 'model' | 'runtime'> & {
      model?: string | null;
      runtime?: string | null;
    },
  ): JournalClaim {
    const callIndex = ++journalCursor;
    if (!journalPrefixIntact) return { callIndex, decision: 'fresh' };
    const incoming: DynamicWorkflowJournalCallKey = {
      callPath: key.callPath,
      primitive: key.primitive,
      nodeId: key.nodeId,
      argHash: key.argHash,
      schemaRef: key.schemaRef,
      policyHash: key.policyHash,
      agentId: key.agentId,
      model: key.model ?? null,
      runtime: key.runtime ?? null,
      planHash: key.planHash,
      workflowRevision: key.workflowRevision,
    };
    const lookup = lookupJournalReplay(journalEntries, callIndex, incoming);
    if (lookup.kind === 'reuse' && lookup.entry) {
      return { callIndex, decision: 'reuse', entry: lookup.entry };
    }
    journalPrefixIntact = false;
    if (lookup.kind === 'diverge') {
      try {
        deps.crud.truncateJournalFrom?.(ctx.runId, callIndex);
      } catch (err) {
        logger.warn({ err, runId: ctx.runId, callIndex }, 'falha ao truncar sufixo do journal');
      }
    }
    return { callIndex, decision: 'fresh' };
  }

  function recordJournalCall(
    callIndex: number,
    key: DynamicWorkflowJournalCallKey,
    extra: { outputRef?: string | null; sideEffectKey?: string | null },
  ): void {
    if (!deps.crud.appendJournalEntry) return;
    try {
      deps.crud.appendJournalEntry({
        runId: ctx.runId,
        callIndex,
        ...key,
        outputRef: extra.outputRef ?? null,
        sideEffectKey: extra.sideEffectKey ?? null,
      });
    } catch (err) {
      logger.warn({ err, runId: ctx.runId, callIndex }, 'falha ao gravar entrada do journal (ignorado)');
    }
  }

  function readRealNodeOutput(nodeId: string): unknown | undefined {
    const reader = ctx.readNodeCheckpoint ?? ((id: string) => readNodeCheckpoint(ctx.runDir, id));
    const file = reader(nodeId);
    if (!file) return undefined;
    return file.state;
  }

  function argHashOf(value: unknown): string {
    let serialized: string;
    try {
      serialized = JSON.stringify(value ?? null);
    } catch {
      serialized = 'null';
    }
    return createHash('sha256').update(serialized).digest('hex');
  }

  function sideEffectJournalKey(
    primitive: DynamicWorkflowJournalPrimitive,
    nodeId: string | null,
    arg: unknown,
  ): DynamicWorkflowJournalCallKey {
    return {
      callPath: `${nodeId ?? primitive}:${primitive}`,
      primitive,
      nodeId,
      argHash: argHashOf(arg),
      schemaRef: null,
      policyHash: null,
      agentId: null,
      model: null,
      runtime: null,
      planHash: currentPlanHash(),
      workflowRevision: ctx.workflowRevision ?? null,
    };
  }

  const agentSemaphore = createAgentSemaphore(effectiveMaxConcurrentAgents(ctx));

  let blockedFatal: WorkflowHostFatalError | null = null;

  function raiseBlockedFatal(error: WorkflowHostFatalError): never {
    blockedFatal = error;
    throw error;
  }

  function assertNotAborted(): void {
    if (blockedFatal) throw blockedFatal;
    if (ctx.abortSignal.aborted) {
      throw new WorkflowHostFatalError('run-aborted', 'run abortado/pausado durante a execucao');
    }
  }

  async function notifyNodeFailed(input: {
    nodeId: string;
    attempt: number;
    failureClass: DynamicWorkflowNodeRunFailureClass | null;
    runtime: string;
    error: unknown;
    errorMessage?: string | null;
    recoverable: boolean;
  }): Promise<NodeFailureHookOutcome | undefined> {
    if (!ctx.onNodeFailed) return undefined;
    try {
      const outcome = await ctx.onNodeFailed(input);
      return isNodeFailureHookOutcome(outcome) ? outcome : undefined;
    } catch (err) {
      logger.warn({ err, nodeId: input.nodeId }, 'onNodeFailed hook lancou (ignorado)');
      return undefined;
    }
  }

  async function phase(arg: unknown): Promise<unknown> {
    const name = typeof arg === 'string' ? arg : (arg as { name?: string })?.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new WorkflowHostFatalError('phase-not-in-meta', `phase('${String(name)}') nao declarada em meta.phases`);
    }
    if (!phaseIds.has(name)) {
      phaseIds.add(name);
      ctx.manifest.phases.push({ id: name, name, order: ctx.manifest.phases.length });
    }
    if (currentPhaseId !== null) {
      await awaitBoundaryGateIfNotGreen(name);
    }
    currentPhaseId = name;
    deps.emit({ runId: ctx.runId, type: 'phase-changed', phaseId: name, payload: { phase: name } });
    deps.crud.patchRun(ctx.runId, { currentPhaseId: name });
    return undefined;
  }

  async function awaitBoundaryGateIfNotGreen(boundaryId: string): Promise<void> {
    const listEventsSince = deps.crud.listEventsSince;
    if (!listEventsSince) return;
    let windowEvents: DynamicWorkflowEvent[];
    let history: DynamicWorkflowEvent[];
    try {
      history = listEventsSince(ctx.runId, 0);
      windowEvents = eventsSince(history, findWindowStartSeq(history));
    } catch (err) {
      logger.warn({ err, runId: ctx.runId, boundaryId }, 'fronteira: leitura de eventos falhou (sem gate)');
      return;
    }
    const assessment = assessBoundary(windowEvents, { history });
    const gateId = boundaryGateId(boundaryId);
    if (assessment.since.nodes === 0 || assessment.semaphore === 'VERDE') {
      deps.gateGate.discardStaleGate?.(gateId);
      return;
    }
    const mode: DynamicWorkflowGateMode = 'orchestrator';
    const pendingDecision = {
      type: 'gate' as const,
      id: gateId,
      prompt: `fronteira '${boundaryId}' com SEMAFORO: ${assessment.semaphore} (${assessment.reasons.join('; ')}) aguardando decisao do orquestrador`,
    };
    deps.crud.patchRun(ctx.runId, {
      status: 'blocked',
      pendingDecisionJson: JSON.stringify({ pendingDecision }),
    });
    deps.emit({
      runId: ctx.runId,
      type: 'gate-blocked',
      phaseId: boundaryId,
      payload: {
        gateId,
        mode,
        boundary: boundaryId,
        semaphore: assessment.semaphore,
        reasons: assessment.reasons,
        openP1: assessment.openP1.length,
      },
    });

    const resolution = await deps.gateGate.awaitDecision(gateId, mode);
    persistGateDecision(deps, ctx, {
      gateId,
      mode,
      decision: resolution.decision === 'approve' ? 'approved' : 'rejected',
      decidedBy: resolution.approvedBy,
      reason: resolution.reason,
      payload: { semaphore: assessment.semaphore, reasons: assessment.reasons },
    });
    if (resolution.decision === 'reject') {
      deps.emit({
        runId: ctx.runId,
        type: 'gate-rejected',
        payload: { gateId, decidedBy: resolution.approvedBy },
      });
      throw new WorkflowHostFatalError(
        'run-aborted',
        `fronteira '${boundaryId}' rejeitada por ${resolution.approvedBy}: run pausado`,
      );
    }
    deps.crud.patchRun(ctx.runId, { status: 'running', pendingDecisionJson: JSON.stringify({}) });
    deps.emit({
      runId: ctx.runId,
      type: 'gate-approved',
      payload: { gateId, approvedBy: resolution.approvedBy, semaphore: assessment.semaphore },
    });
  }

  function resolveImplicitSchemaRef(
    schema: AgentPrimitiveArg['schema'],
    access: DynamicWorkflowNodeAccess,
    agentType: string,
  ): string | null {
    if (schema === undefined || schema === null) return null;
    const isString = typeof schema === 'string';
    const isObject = !isString && typeof schema === 'object' && !Array.isArray(schema);
    if (!isString && !isObject) return null;
    if (isString && schema.length === 0) return null;

    if (access === 'workspace-write') {
      throw new WorkflowHostFatalError(
        'writer-schema-forbidden',
        `agent(prompt, { agentType: '${agentType}', schema }): node writer (workspace-write) nao pode declarar schema ` +
          `(structured output trava o turno do writer; schema so vale para node read-only)`,
      );
    }

    if (isString) return schema;

    const converted = jsonSchemaToOutputSchema(schema);
    if (!converted) return null;
    const ref = computeInlineSchemaRef(schema);
    ccSchemaRegistry.set(ref, converted);
    return ref;
  }

  function maybeCreateImplicitNode(argIn: AgentPrimitiveArg): AgentPrimitiveArg {
    const hasId = typeof argIn.id === 'string' && argIn.id.length > 0;
    if (hasId) return argIn;
    const agentType = argIn.agentType;
    if (typeof agentType !== 'string' || agentType.length === 0) return argIn;

    if (!ctx.resolveAgentAxes) return argIn;
    const axes = ctx.resolveAgentAxes(agentType);
    if (!axes) {
      throw new WorkflowHostFatalError(
        'agent-missing',
        `agent(prompt, { agentType: '${agentType}' }): agentType nao existe no catalogo de agentes`,
      );
    }

    const callPhase = typeof argIn.phase === 'string' && argIn.phase.length > 0 ? argIn.phase : null;
    if (callPhase && !phaseIds.has(callPhase)) {
      phaseIds.add(callPhase);
      ctx.manifest.phases.push({
        id: callPhase,
        name: callPhase,
        order: ctx.manifest.phases.length,
      });
    }
    const phaseId = callPhase ?? (currentPhaseId || 'unknown');
    const base = argIn.label && argIn.label.length > 0 ? argIn.label : agentType;
    const occ = implicitOccByBase.get(base) ?? 0;
    implicitOccByBase.set(base, occ + 1);
    const id = `cc:${phaseId}:${base}:${occ}`;

    const implicitSchemaRef = resolveImplicitSchemaRef(argIn.schema, axes.access, agentType);

    if (!nodeById.has(id)) {
      if (implicitNodesCreated >= implicitNodeCap) {
        throw new WorkflowHostFatalError(
          'implicit-node-cap-exceeded',
          `agent(): o run ja criou ${implicitNodesCreated} nodes implicitos - teto anti-runaway de ${implicitNodeCap} por run atingido (provavel loop descontrolado de agent() no workflow.js, nao um limite de capacidade real)`,
        );
      }
      implicitNodesCreated += 1;
      implicitNodeIds.add(id);
      const node: DynamicWorkflowManifestNode = {
        id,
        type: 'agent',
        phaseId,
        agentId: agentType,
        label: argIn.label,
        access: axes.access,
        allowedTools: axes.allowedTools,
        allowedCommands: axes.allowedCommands,
        allowBash: axes.allowBash,
        allowNetwork: axes.allowNetwork,
        schemaRef: implicitSchemaRef ?? undefined,
        canResume: true,
        produces: [],
        consumes: [],
      };
      ctx.manifest.nodes.push(node);
      nodeById.set(id, node);
    }

    return {
      ...argIn,
      id,
      agentId: agentType,
      access: axes.access,
      allowBash: axes.allowBash,
      allowNetwork: axes.allowNetwork,
      allowedCommands: axes.allowedCommands,
      allowedTools: axes.allowedTools,
      ...(typeof argIn.model === 'string' && argIn.model.length > 0 ? { model: argIn.model } : {}),
      ...(typeof argIn.effort === 'string' && argIn.effort.length > 0 ? { effort: argIn.effort } : {}),
    };
  }

  async function runAgentNode(argIn: AgentPrimitiveArg): Promise<unknown> {
    assertNotAborted();

    const promptRaw = (argIn as { prompt?: unknown }).prompt;
    if (promptRaw !== undefined && typeof promptRaw !== 'string') {
      const looksPromise = typeof (promptRaw as { then?: unknown } | null)?.then === 'function';
      throw new WorkflowHostFatalError(
        'prompt-invalid',
        looksPromise
          ? `agent(${argIn.id ?? argIn.agentType ?? '?'}): prompt e uma Promise - faltou await no resultado de agent()/parallel() antes de interpolar no prompt.`
          : `agent(${argIn.id ?? argIn.agentType ?? '?'}): prompt deve ser string (recebeu ${typeof promptRaw}).`,
      );
    }
    if (typeof promptRaw === 'string' && promptRaw.includes('[object Promise]')) {
      logger.warn(
        { runId: ctx.runId, nodeId: argIn.id ?? argIn.agentType ?? null },
        "prompt contem '[object Promise]' - possivel interpolacao sem await na autoria (segue mesmo assim)",
      );
    }

    if (argIn.isolation !== undefined) {
      throw new WorkflowHostFatalError(
        'isolation-unsupported',
        `agent(prompt, { isolation: '${String(argIn.isolation)}' }): isolation por chamada nao e suportado - todo o run roda numa worktree dedicada. Remova o campo isolation das opcoes.`,
      );
    }

    const arg = maybeCreateImplicitNode(argIn);

    if (!arg || typeof arg.id !== 'string' || arg.id.length === 0) {
      throw new WorkflowHostFatalError('node-not-in-manifest', 'agent() sem id valido');
    }
    const manifestNode = nodeById.get(arg.id);
    if (!manifestNode) {
      throw new WorkflowHostFatalError(
        'node-not-in-manifest',
        `node '${arg.id}' nao existe no manifest (id em runtime fora do conjunto pre-expandido)`,
      );
    }
    if (seenNodeIds.has(arg.id)) {
      throw new WorkflowHostFatalError('duplicate-node-id', `node id '${arg.id}' usado mais de uma vez na execucao`);
    }
    seenNodeIds.add(arg.id);

    const phaseId = manifestNode.phaseId || currentPhaseId || 'unknown';
    let access: DynamicWorkflowNodeAccess = clampAccess(arg.access, manifestNode.access);
    let agentId = manifestNode.agentId ?? arg.agentId ?? '';
    if (RUNTIME_AGENT_DENYLIST.has(agentId)) {
      throw new WorkflowHostFatalError(
        'agent-denylisted',
        `node '${arg.id}' referencia o agente "${agentId}", que esta na denylist de runtime ` +
          `(nenhum workflow, novo ou antigo, pode invoca-lo): ${AGENT_DENYLIST_REASON}`,
      );
    }
    const writeSet = clampList(arg.writeSet, manifestNode.writeSet);

    const canonicalSchemaRef = manifestNode.schemaRef ?? null;

    const effectiveModel = typeof arg.model === 'string' && arg.model.length > 0 ? arg.model : undefined;

    const rawEffort = typeof arg.effort === 'string' && arg.effort.length > 0 ? arg.effort : undefined;
    if (rawEffort !== undefined && !isWorkflowAgentEffort(rawEffort)) {
      throw new WorkflowHostFatalError(
        'effort-invalid',
        `effort '${rawEffort}' invalido no node '${arg.id}': valores aceitos sao ${WORKFLOW_AGENT_EFFORTS.join(' | ')} (use 'max' (raciocinio maximo) ou 'ultra' (delegacao interna, so quando o humano pediu)'max')`,
      );
    }
    const effectiveEffort: CodexChatReasoningEffort | undefined = rawEffort;

    const effectiveMaxTurns = clampMaxTurns(arg.maxTurns, arg.id);

    let consumedAdjustments = deps.crud.getConsumedAdjustmentsForNode?.(ctx.runId, arg.id) ?? [];
    let adjustment = buildAdjustmentText(consumedAdjustments);
    const consumedSwitch = agentSwitchFrom(consumedAdjustments);
    if (consumedSwitch) {
      if (RUNTIME_AGENT_DENYLIST.has(consumedSwitch)) {
        throw new WorkflowHostFatalError(
          'agent-denylisted',
          `node '${arg.id}' foi trocado para o agente "${consumedSwitch}", que esta na denylist de runtime: ${AGENT_DENYLIST_REASON}`,
        );
      }
      agentId = consumedSwitch;
    }
    let inputHash = computeNodeInputHash({
      agentId,
      prompt: arg.prompt,
      access,
      schemaRef: canonicalSchemaRef ?? undefined,
      writeSet,
      effectiveModel,
      effectiveEffort,
      effectiveMaxTurns,
      adjustment,
    });
    let grants: NodePolicyGrants = {
      nodeId: arg.id,
      agentId,
      access,
      allowedTools: clampList(arg.allowedTools, manifestNode.allowedTools),
      allowedMcpServers: clampList(arg.allowedMcpServers, manifestNode.allowedMcpServers),
      allowedMcpTools: clampList(arg.allowedMcpTools, manifestNode.allowedMcpTools),
      allowedCommands: clampList(arg.allowedCommands, manifestNode.allowedCommands),
      allowBash: clampFlag(arg.allowBash, manifestNode.allowBash),
      allowNetwork: clampFlag(arg.allowNetwork, manifestNode.allowNetwork),
      timeoutMs: clampCeiling(arg.timeoutMs, manifestNode.timeoutMs),
      costCeilingUsd: clampCeiling(arg.costCeilingUsd, manifestNode.costCeilingUsd),
    };
    if (consumedSwitch && implicitNodeIds.has(arg.id) && ctx.resolveAgentAxes) {
      const axes = ctx.resolveAgentAxes(consumedSwitch);
      if (axes) {
        access = clampAccess(axes.access, manifestNode.access);
        grants = {
          ...grants,
          access,
          allowedTools: axes.allowedTools,
          allowedCommands: axes.allowedCommands,
          allowBash: axes.allowBash,
          allowNetwork: axes.allowNetwork,
        };
      }
    }
    let policyHash = computeNodeGrantsHash(grants);

    const journalKey: DynamicWorkflowJournalCallKey = {
      callPath: `${arg.id}:agent`,
      primitive: 'agent',
      nodeId: arg.id,
      argHash: inputHash,
      schemaRef: canonicalSchemaRef,
      policyHash,
      agentId,
      model: null,
      runtime: null,
      planHash: currentPlanHash(),
      workflowRevision: ctx.workflowRevision ?? null,
    };
    const claim = claimJournalCall(journalKey);
    if (claim.decision === 'reuse') {
      const rawRealOutput = readRealNodeOutput(arg.id);
      if (rawRealOutput !== undefined) {
        const realOutput = unwrapLegacyOutputEnvelope(rawRealOutput, canonicalSchemaRef);
        const realPayloadView = typeof realOutput === 'string' ? parseNodeOutput(realOutput) : realOutput;
        deps.emit({
          runId: ctx.runId,
          type: 'node-cache-hit',
          nodeId: arg.id,
          phaseId,
          payload: {
            inputHash,
            callIndex: claim.callIndex,
            replay: 'journal',
            agentId,
            access,
            ...(manifestNode.label ? { label: manifestNode.label } : {}),
            ...describeParsedForPayload(realPayloadView),
          },
        });
        return realOutput;
      }
      journalPrefixIntact = false;
      try {
        deps.crud.truncateJournalFrom?.(ctx.runId, claim.callIndex);
      } catch {}
    }

    type AttemptOutcome = { kind: 'completed'; value: unknown } | { kind: 'retry' } | { kind: 'skip' };

    const grantsUserQuestion = (grants.allowedMcpServers ?? []).includes('lionclaw-user-question');
    const isImplicitNode = implicitNodeIds.has(arg.id);

    const recomputeInputHash = (): void => {
      inputHash = computeNodeInputHash({
        agentId,
        prompt: arg.prompt,
        access,
        schemaRef: canonicalSchemaRef ?? undefined,
        writeSet,
        effectiveModel,
        effectiveEffort,
        effectiveMaxTurns,
        adjustment,
      });
      journalKey.argHash = inputHash;
      journalKey.agentId = agentId;
      journalKey.policyHash = policyHash;
    };

    const applyAgentSwitch = (newAgentId: string): void => {
      if (RUNTIME_AGENT_DENYLIST.has(newAgentId)) {
        throw new WorkflowHostFatalError(
          'agent-denylisted',
          `switch-agent para "${newAgentId}" recusado: agente na denylist de runtime (${AGENT_DENYLIST_REASON})`,
        );
      }
      if (isImplicitNode && ctx.resolveAgentAxes) {
        const axes = ctx.resolveAgentAxes(newAgentId);
        if (!axes) {
          throw new WorkflowHostFatalError(
            'agent-missing',
            `switch-agent para "${newAgentId}" recusado: agentType nao existe no catalogo de agentes`,
          );
        }
        access = clampAccess(axes.access, manifestNode.access);
        grants = {
          ...grants,
          agentId: newAgentId,
          access,
          allowedTools: axes.allowedTools,
          allowedCommands: axes.allowedCommands,
          allowBash: axes.allowBash,
          allowNetwork: axes.allowNetwork,
        };
      } else {
        grants = { ...grants, agentId: newAgentId };
      }
      agentId = newAgentId;
      policyHash = computeNodeGrantsHash(grants);
    };

    const sleep = deps.sleep ?? defaultSleep;

    const runAttemptOnce = async (): Promise<AttemptOutcome> => {
      assertNotAborted();

      const claimedAdjustments = deps.crud.claimAdjustmentsForNode?.(ctx.runId, arg.id) ?? [];
      if (claimedAdjustments.length > 0) {
        consumedAdjustments = [...consumedAdjustments, ...claimedAdjustments];
        adjustment = buildAdjustmentText(consumedAdjustments);
        const switched = agentSwitchFrom(consumedAdjustments);
        if (switched && switched !== agentId) applyAgentSwitch(switched);
        recomputeInputHash();
      }
      const effectivePrompt = adjustment ? `${arg.prompt}${ADJUSTMENT_PROMPT_HEADER}${adjustment}` : arg.prompt;

      const attempt = nextAttempt(arg.id);
      let sprintCwd: string | null = null;
      if (typeof arg.sprintIndex === 'number' && ctx.resolveSprintCwd) {
        const resolved = ctx.resolveSprintCwd(arg.sprintIndex);
        if (resolved && isAbsolute(resolved)) {
          sprintCwd = resolved;
        }
      }
      const writerCwd = sprintCwd ?? ctx.workspaceRoot;
      const workspace: PolicyWorkspace = {
        runId: ctx.runId,
        workspaceRoot: writerCwd,
        cwd: writerCwd,
      };

      const nodeRowId = generateId('dwfnr');
      deps.crud.upsertNodeRun({
        id: nodeRowId,
        runId: ctx.runId,
        nodeId: arg.id,
        phaseId,
        type: 'agent',
        agentId,
        status: 'running',
        attempt,
        inputHash,
        inputJson: JSON.stringify({ prompt: effectivePrompt, schema: canonicalSchemaRef }),
        startedAt: now(),
      });
      deps.crud.patchRun(ctx.runId, { status: 'running', currentNodeId: arg.id });
      const nodeStartedAt = now();
      deps.emit({
        runId: ctx.runId,
        type: 'node-started',
        nodeId: arg.id,
        phaseId,
        payload: {
          attempt,
          agentId,
          access,
          timeoutMs: grants.timeoutMs,
          startedAt: nodeStartedAt,
          ...(manifestNode.label ? { label: manifestNode.label } : {}),
        },
      });

      const outputSchema = resolveCanonicalSchema(canonicalSchemaRef);
      let streamedText = '';
      const streamedTools: Array<{
        tool: string;
        input: unknown;
        sequence: number;
        textOffset: number;
        status: 'running' | 'done';
      }> = [];

      const nodeAbort = new AbortController();
      const onRunAbort = (): void => nodeAbort.abort();
      if (ctx.abortSignal.aborted) nodeAbort.abort();
      else ctx.abortSignal.addEventListener('abort', onRunAbort, { once: true });
      const unregisterNodeAbort = ctx.registerNodeAbort?.(arg.id, attempt, nodeAbort);

      const adapterInput: RunNodeAgentInput = {
        runId: ctx.runId,
        agentId,
        grants,
        workspace,
        prompt: effectivePrompt,
        writeSet,
        protectedPaths: ctx.protectedPaths,
        abortSignal: nodeAbort.signal,
        grantsUserQuestion,
        role: 'node',
        ...(effectiveModel ? { effectiveModel } : {}),
        ...(effectiveEffort ? { effectiveEffort } : {}),
        ...(effectiveMaxTurns !== undefined ? { effectiveMaxTurns } : {}),
        ...(outputSchema ? { outputSchema } : {}),
        ...(outputSchema && ctx.schemaValidator ? { schemaValidator: ctx.schemaValidator } : {}),
        onStreamChunk: deps.emitStreamChunk
          ? (partial) => {
              if (partial.type === 'text' && partial.content) {
                streamedText += partial.content;
              }
              if (partial.type === 'tool_call_start' && partial.toolName) {
                streamedTools.push({
                  tool: partial.toolName,
                  input: partial.content ?? null,
                  sequence: streamedTools.length,
                  textOffset: streamedText.length,
                  status: 'running',
                });
              } else if (partial.type === 'tool_call' && partial.toolName) {
                const candidates = streamedTools.filter(
                  (tool) => tool.tool === partial.toolName && tool.status === 'running',
                );
                if (candidates.length === 1) {
                  candidates[0].input = partial.content ?? candidates[0].input;
                  candidates[0].status = 'done';
                }
              }
              if (grantsUserQuestion && isUserQuestionTool(partial.toolName)) {
                if (partial.type === 'tool_call_start') {
                  deps.emit({
                    runId: ctx.runId,
                    type: 'question-pending',
                    nodeId: arg.id,
                    phaseId,
                    payload: { nodeId: arg.id, prompt: effectivePrompt },
                  });
                } else if (partial.type === 'tool_call') {
                  deps.emit({
                    runId: ctx.runId,
                    type: 'question-resolved',
                    nodeId: arg.id,
                    phaseId,
                    payload: { nodeId: arg.id },
                  });
                }
              }
              if (partial.type === 'tool_call') return;
              deps.emitStreamChunk?.({
                kind: 'node',
                runId: ctx.runId,
                nodeId: arg.id,
                attempt,
                type: partial.type === 'tool_call_start' ? 'tool_call' : partial.type,
                content: partial.content,
                toolName: partial.toolName,
              });
            }
          : undefined,
      };

      let result: NodeRunResult;
      let adapterError: unknown = null;
      try {
        result = await adapterRun(adapterInput, deps.adapterDeps ?? {});
      } catch (err) {
        adapterError = err;
        logger.error({ err, nodeId: arg.id }, 'adapter lancou (inesperado); marcando node failed');
        result = {
          ok: false,
          output: '',
          runtime: 'cloud',
          family: 'claude-compatible',
          failureClass: 'logic',
          errorMessage: err instanceof Error ? err.message : String(err),
          policy: {
            runId: ctx.runId,
            nodeId: arg.id,
            workspaceRoot: ctx.workspaceRoot,
            cwd: ctx.workspaceRoot,
            access,
            allowedTools: [],
            deniedTools: [],
            allowedMcpServers: [],
            allowedMcpTools: [],
            allowedCommands: [],
            effectiveTools: [],
            effectiveMcpServers: [],
            policyHash: '',
            allowBash: false,
            allowNetwork: false,
            timeoutMs: 0,
            idleTimeoutMs: 0,
            costCeilingUsd: 0,
          },
          mechanism: 'none',
          durationMs: 0,
        };
      } finally {
        ctx.abortSignal.removeEventListener('abort', onRunAbort);
        unregisterNodeAbort?.();
      }

      const finishVisibleNodeStream = (succeeded: boolean): void => {
        if (deps.crud.insertMessage && (streamedText || result.output || streamedTools.length > 0)) {
          const content = result.output || streamedText;
          remapWorkflowToolOffsets(streamedText, content, streamedTools);
          deps.crud.insertMessage({
            runId: ctx.runId,
            nodeId: arg.id,
            role: 'assistant',
            source: 'agent',
            kind: 'node-output',
            content,
            toolCallsJson:
              streamedTools.length > 0
                ? JSON.stringify(
                    streamedTools.map((tool) => ({
                      ...tool,
                      status: succeeded ? 'done' : 'incomplete',
                    })),
                  )
                : null,
            agentId,
          });
        }
        deps.emitStreamChunk?.({
          kind: 'node',
          runId: ctx.runId,
          nodeId: arg.id,
          attempt,
          type: 'done',
        });
      };

      const cost = result.cost;
      const costPatch: DynamicWorkflowNodeRunPatch = {};
      if (cost) {
        costPatch.inputTokens = cost.inputTokens;
        costPatch.outputTokens = cost.outputTokens;
        costPatch.cacheReadTokens = cost.cacheReadTokens;
        costPatch.cacheCreationTokens = cost.cacheCreationTokens;
        costPatch.costUsd = cost.costUsd;
        costPatch.costStatus = cost.costStatus;
        costPatch.tokenStatus = cost.tokenStatus;
        costPatch.costUnknownReason = cost.costUnknownReason;
        if ((cost.costStatusReasons?.length ?? 0) > 0) {
          costPatch.metricsMetadataJson = encodeCostStatusReasonsIntoMetricsMetadata(
            costPatch.metricsMetadataJson,
            cost.costStatusReasons ?? [],
          );
        }
        costPatch.apiRequests = cost.apiRequests;
        costPatch.toolUses = cost.toolUses;
      }

      const completedAt = now();
      const metricsPayload: Record<string, unknown> = {
        durationMs: result.durationMs,
        runtime: result.runtime,
        completedAt,
        ...(cost
          ? {
              inputTokens: cost.inputTokens,
              outputTokens: cost.outputTokens,
              cacheReadTokens: cost.cacheReadTokens,
              cacheCreationTokens: cost.cacheCreationTokens,
              costUsd: cost.costUsd,
              costStatus: cost.costStatus,
              tokenStatus: cost.tokenStatus,
              costUnknownReason: cost.costUnknownReason,
              costStatusReasons: cost.costStatusReasons,
              apiRequests: cost.apiRequests,
              toolUses: cost.toolUses,
            }
          : {}),
      };

      if (ctx.abortSignal.aborted) {
        deps.crud.updateNodeRun(nodeRowId, {
          ...costPatch,
          runtime: result.runtime,
          durationMs: result.durationMs,
          completedAt,
        });
        deps.crud.addRunCost(ctx.runId, cost?.costUsd ?? 0, result.durationMs);
        deps.emit({
          runId: ctx.runId,
          type: 'node-interrupted',
          nodeId: arg.id,
          phaseId,
          payload: { attempt, agentId, access, reason: 'run-aborted', ...metricsPayload },
        });
        finishVisibleNodeStream(false);
        throw new WorkflowHostFatalError(
          'run-aborted',
          `run abortado/pausado durante o node '${arg.id}' (attempt ${attempt} interrompida)`,
        );
      }
      const stalled = nodeAbort.signal.aborted;
      if (stalled) {
        result = {
          ...result,
          ok: false,
          failureClass: 'timeout',
          errorMessage: `node abortado pelo watchdog de stall (sem progresso): ${result.errorMessage ?? 'sem detalhe'}`,
        };
      }

      let worktreeCommitSha: string | null = null;
      let writerTouchedFiles: string[] = [];
      let writesetViolation = false;
      if (result.ok && access === 'workspace-write' && ctx.onWriterNodeCompleted) {
        try {
          const committed = await ctx.onWriterNodeCompleted({
            nodeId: arg.id,
            attempt,
            access,
            writeSet,
          });
          worktreeCommitSha = committed?.sha ?? null;
          writerTouchedFiles = committed?.touchedFiles ?? [];
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writesetViolation = true;
          adapterError = null;
          result = { ...result, ok: false, failureClass: 'logic', errorMessage: message };
        }
      }

      const canonicalFailureClass = result.ok
        ? null
        : writesetViolation
          ? 'logic'
          : stalled
            ? 'timeout'
            : computeCanonicalFailureClass({
                runtime: result.runtime,
                error: adapterError,
                errorMessage: result.errorMessage ?? null,
                adapterFailureClass: result.failureClass ?? null,
                aborted: ctx.abortSignal.aborted,
              });

      const patch: DynamicWorkflowNodeRunPatch = {
        ...costPatch,
        status: result.ok ? 'completed' : 'failed',
        policyHash: result.policy.policyHash,
        policySnapshotJson: JSON.stringify(result.policy),
        outputJson: result.output ? JSON.stringify({ output: result.output }) : null,
        error: result.ok ? null : (result.errorMessage ?? null),
        failureClass: canonicalFailureClass,
        runtime: result.runtime,
        durationMs: result.durationMs,
        completedAt,
      };
      deps.crud.updateNodeRun(nodeRowId, patch);
      deps.crud.addRunCost(ctx.runId, cost?.costUsd ?? 0, result.durationMs);

      const scriptValue = nodeOutputForScript(result, canonicalSchemaRef);
      const payloadView =
        result.structuredOutput !== undefined ? result.structuredOutput : parseNodeOutput(result.output);

      if (result.ok) {
        const verdict = extractValidatorVerdict(payloadView);
        if (verdict) {
          logger.info(
            {
              phase: 'validator-verdict',
              runId: ctx.runId,
              nodeId: arg.id,
              agentId,
              verdict: verdict.verdict,
              findingsTotal: verdict.findingsTotal,
              blockers: verdict.blockers,
            },
            `validador ${arg.id}: ${verdict.verdict} (${verdict.blockers} bloqueadores de ${verdict.findingsTotal} findings)`,
          );
        }
        if (access === 'workspace-write') {
          logger.info(
            {
              phase: 'coder-touched',
              runId: ctx.runId,
              nodeId: arg.id,
              agentId,
              writeSet,
              worktreeCommitSha,
            },
            `writer ${arg.id} concluido (writeSet declarado + commit do host na worktree)`,
          );
        }
      }

      if (!result.ok) {
        let wipSha: string | null = null;
        if (access === 'workspace-write' && ctx.onWriterNodeFailed) {
          try {
            wipSha = (await ctx.onWriterNodeFailed({ nodeId: arg.id, attempt }))?.sha ?? null;
          } catch (err) {
            logger.warn({ err, runId: ctx.runId, nodeId: arg.id }, 'WIP do writer falho falhou (ignorado)');
          }
        }
        deps.emit({
          runId: ctx.runId,
          type: 'node-failed',
          nodeId: arg.id,
          phaseId,
          payload: {
            attempt,
            agentId,
            access,
            ...(writesetViolation ? { reason: 'writeset-violation' } : {}),
            ...(stalled ? { stalled: true } : {}),
            failureClass: canonicalFailureClass,
            error: result.errorMessage,
            ...metricsPayload,
            ...(wipSha ? { wipSha } : {}),
          },
        });
        finishVisibleNodeStream(false);
        return resolveFailureDisposition({
          attempt,
          failureClass: canonicalFailureClass,
          runtime: result.runtime,
          error: adapterError ?? result.errorMessage ?? null,
          errorMessage: result.errorMessage ?? null,
          recoverable: !writesetViolation,
          wipSha,
        });
      }

      finishVisibleNodeStream(true);
      const touchedFilesCap = 50;
      const writerPayload: Record<string, unknown> =
        access === 'workspace-write'
          ? {
              touchedFiles: writerTouchedFiles.slice(0, touchedFilesCap),
              touchedFilesTotal: writerTouchedFiles.length,
              touchedFilesTruncated: writerTouchedFiles.length > touchedFilesCap,
              worktreeCommitSha,
            }
          : {};
      deps.emit({
        runId: ctx.runId,
        type: 'node-completed',
        nodeId: arg.id,
        phaseId,
        payload: {
          attempt,
          costUsd: cost?.costUsd ?? 0,
          ...metricsPayload,
          agentId,
          access,
          ...(manifestNode.label ? { label: manifestNode.label } : {}),
          ...describeParsedForPayload(payloadView),
          ...writerPayload,
        },
      });
      persistNodeCheckpoint(deps, ctx, {
        nodeId: arg.id,
        attempt,
        state: scriptValue,
        inputHash,
        schemaRef: canonicalSchemaRef,
        agentId,
        worktreeCommitSha,
      });
      recordJournalCall(
        claim.callIndex,
        { ...journalKey, runtime: result.runtime },
        { outputRef: `${arg.id}#${attempt}` },
      );
      return { kind: 'completed', value: scriptValue };
    };

    const resolveFailureDisposition = async (failure: {
      attempt: number;
      failureClass: DynamicWorkflowNodeRunFailureClass | null;
      runtime: string;
      error: unknown;
      errorMessage: string | null;
      recoverable: boolean;
      wipSha: string | null;
    }): Promise<AttemptOutcome> => {
      const hook = await notifyNodeFailed({
        nodeId: arg.id,
        attempt: failure.attempt,
        failureClass: failure.failureClass,
        runtime: failure.runtime,
        error: failure.error,
        errorMessage: failure.errorMessage,
        recoverable: failure.recoverable,
      });
      if (!hook) return { kind: 'skip' };
      if (hook.outcome === 'cancelled') {
        assertNotAborted();
        return { kind: 'skip' };
      }
      if (hook.outcome === 'retry-scheduled') {
        await sleep(Math.max(0, hook.backoffMs), ctx.abortSignal);
        assertNotAborted();
        return { kind: 'retry' };
      }
      return awaitFailureGate(failure, hook);
    };

    const awaitFailureGate = async (
      failure: {
        attempt: number;
        failureClass: DynamicWorkflowNodeRunFailureClass | null;
        errorMessage: string | null;
        wipSha: string | null;
      },
      hook: NodeFailureHookOutcome,
    ): Promise<AttemptOutcome> => {
      const gateId = failureGateId(arg.id);
      const mode: DynamicWorkflowGateMode = 'orchestrator';
      const pendingDecision = buildFailurePendingDecision({
        nodeId: arg.id,
        failureClass: failure.failureClass ?? hook.failureClass,
        nodeError: failure.errorMessage,
        retriesExhausted: hook.retriesExhausted ?? false,
        attemptsMade: hook.attemptsMade ?? failure.attempt,
      });
      deps.crud.patchRun(ctx.runId, {
        status: 'blocked',
        pendingDecisionJson: JSON.stringify({ pendingDecision }),
      });
      deps.emit({
        runId: ctx.runId,
        type: 'gate-blocked',
        nodeId: arg.id,
        phaseId,
        payload: {
          gateId,
          mode,
          failure: true,
          nodeId: arg.id,
          attempt: failure.attempt,
          failureClass: failure.failureClass ?? hook.failureClass,
          error: failure.errorMessage,
          retriesExhausted: hook.retriesExhausted ?? false,
          attemptsMade: hook.attemptsMade ?? failure.attempt,
          ...(failure.wipSha ? { wipSha: failure.wipSha } : {}),
          actions: [...FAILURE_GATE_ACTIONS],
        },
      });

      const resolution = await deps.gateGate.awaitDecision(gateId, mode);
      const action =
        resolution.decision === 'reject' ? 'abort' : (parseFailureGateAction(resolution.payload?.action) ?? 'retry');
      persistGateDecision(deps, ctx, {
        gateId,
        mode,
        decision: resolution.decision === 'approve' ? 'approved' : 'rejected',
        decidedBy: resolution.approvedBy,
        reason: resolution.reason,
        payload: { action, nodeId: arg.id, failureClass: failure.failureClass, ...(resolution.payload ?? {}) },
      });
      if (action === 'abort') {
        deps.emit({
          runId: ctx.runId,
          type: 'gate-rejected',
          nodeId: arg.id,
          payload: { gateId, decidedBy: resolution.approvedBy, action },
        });
        throw new WorkflowHostFatalError(
          'run-aborted',
          `gate de falha '${gateId}' decidido como abort por ${resolution.approvedBy}: run abortado/pausado`,
        );
      }
      deps.crud.patchRun(ctx.runId, { status: 'running', pendingDecisionJson: JSON.stringify({}) });
      deps.emit({
        runId: ctx.runId,
        type: 'gate-approved',
        nodeId: arg.id,
        payload: { gateId, approvedBy: resolution.approvedBy, action },
      });
      if (action === 'skip') {
        if (ctx.onNodeSkipped) {
          try {
            await ctx.onNodeSkipped({ nodeId: arg.id, attempt: failure.attempt, wipSha: failure.wipSha });
          } catch (err) {
            logger.warn({ err, runId: ctx.runId, nodeId: arg.id }, 'reset apos skip falhou (ignorado)');
          }
        }
        return { kind: 'skip' };
      }
      assertNotAborted();
      return { kind: 'retry' };
    };

    for (;;) {
      const outcome = await runAttemptOnce();
      if (outcome.kind === 'completed') return outcome.value;
      if (outcome.kind === 'skip') return null;
    }
  }

  function nextAttempt(nodeId: string): number {
    const prev = attemptByNode.get(nodeId) ?? 0;
    const next = prev + 1;
    attemptByNode.set(nodeId, next);
    return next;
  }

  async function runParallel(thunks: WorkflowThunk[], options: ParallelOptions): Promise<unknown[]> {
    assertNotAborted();
    if (thunks.length > parallelItemsCap) {
      throw new WorkflowHostFatalError(
        'parallel-items-cap-exceeded',
        `parallel(): ${thunks.length} itens numa unica chamada excede o teto anti-runaway de ${parallelItemsCap} - divida o trabalho em chamadas menores`,
      );
    }
    const globalCap = effectiveMaxConcurrentAgents(ctx) || thunks.length || 1;
    const localCap = options.maxConcurrency ?? globalCap;
    const concurrency = Math.max(1, Math.min(globalCap, localCap, thunks.length || 1));
    const failFast = options.failFast === true;
    if (options.id) {
      deps.emit({
        runId: ctx.runId,
        type: 'parallel-started',
        payload: { groupId: options.id, size: thunks.length, concurrency },
      });
    }

    const results = new Array<unknown>(thunks.length);
    let nextIndex = 0;
    let fatal: WorkflowHostFatalError | null = null;
    let aborted = false;
    const abortController = new AbortController();

    async function worker(): Promise<void> {
      while (true) {
        if (aborted || fatal) return;
        const idx = nextIndex++;
        if (idx >= thunks.length) return;
        try {
          results[idx] = await thunks[idx]();
        } catch (err) {
          if (err instanceof WorkflowHostFatalError) {
            fatal = err;
            abortController.abort();
            return;
          }
          results[idx] = null;
          if (failFast) {
            aborted = true;
            abortController.abort();
            return;
          }
        }
      }
    }

    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);

    if (fatal) {
      if (options.id) {
        deps.emit({ runId: ctx.runId, type: 'parallel-cancelled', payload: { groupId: options.id } });
      }
      throw fatal;
    }
    if (options.id) {
      deps.emit({
        runId: ctx.runId,
        type: 'parallel-completed',
        payload: { groupId: options.id, results: results.length },
      });
    }
    return results;
  }

  async function runPipeline(
    items: unknown[],
    stages: Array<(prevResult: unknown, originalItem: unknown, index: number) => Promise<unknown> | unknown>,
  ): Promise<unknown[]> {
    assertNotAborted();
    if (items.length > parallelItemsCap) {
      throw new WorkflowHostFatalError(
        'parallel-items-cap-exceeded',
        `pipeline(): ${items.length} itens numa unica chamada excede o teto anti-runaway de ${parallelItemsCap} - divida o trabalho em chamadas menores`,
      );
    }
    const globalCap = effectiveMaxConcurrentAgents(ctx) || items.length || 1;
    const concurrency = Math.max(1, Math.min(globalCap, items.length || 1));
    deps.emit({
      runId: ctx.runId,
      type: 'pipeline-started',
      payload: { size: items.length, stages: stages.length, concurrency },
    });

    const results = new Array<unknown>(items.length);
    let nextIndex = 0;
    let fatal: WorkflowHostFatalError | null = null;

    async function runItem(item: unknown, index: number): Promise<unknown> {
      let acc: unknown = item;
      for (const stage of stages) {
        if (fatal) return null;
        acc = await stage(acc, item, index);
      }
      return acc;
    }

    async function worker(): Promise<void> {
      while (true) {
        if (fatal) return;
        const idx = nextIndex++;
        if (idx >= items.length) return;
        try {
          results[idx] = await runItem(items[idx], idx);
        } catch (err) {
          if (err instanceof WorkflowHostFatalError) {
            fatal = err;
            return;
          }
          results[idx] = null;
        }
      }
    }

    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);

    if (fatal) {
      deps.emit({ runId: ctx.runId, type: 'pipeline-cancelled', payload: {} });
      throw fatal;
    }
    deps.emit({ runId: ctx.runId, type: 'pipeline-completed', payload: { results: results.length } });
    return results;
  }

  async function runGate(arg: GatePrimitiveArg): Promise<GatePrimitiveResult> {
    assertNotAborted();

    if (!arg || typeof arg.id !== 'string' || arg.id.length === 0) {
      throw new WorkflowHostFatalError('gate-not-in-manifest', 'gate() sem id valido');
    }
    const manifestGate = gateById.get(arg.id);
    if (!manifestGate) {
      throw new WorkflowHostFatalError('gate-not-in-manifest', `gate '${arg.id}' nao existe no manifest`);
    }
    const mode = manifestGate.mode;
    if (arg.mode !== undefined && arg.mode !== mode) {
      throw new WorkflowHostFatalError(
        'policy-invalid',
        `gate '${arg.id}': mode '${arg.mode}' do script diverge do manifest '${mode}' (o modo e fonte de verdade do manifest)`,
      );
    }

    const gateKey = sideEffectJournalKey('gate', arg.id, { id: arg.id, mode, checks: arg.checks ?? [] });
    const gateClaim = claimJournalCall(gateKey);
    if (gateClaim.decision === 'reuse' && gateClaim.entry?.sideEffectKey) {
      deps.emit({
        runId: ctx.runId,
        type: 'gate-replayed',
        payload: { gateId: arg.id, mode, callIndex: gateClaim.callIndex },
      });
      const replayedRedev = parseGateRedevAction(gateClaim.entry.sideEffectKey);
      if (replayedRedev) {
        return { ok: true, mode, findings: [], decisionPayload: { action: replayedRedev } };
      }
      return { ok: true, mode, findings: [] };
    }

    const rawSpecs = (arg.checks ?? []) as GateCheckSpec[];
    const specs = ctx.resolveGateChecks ? ctx.resolveGateChecks(rawSpecs, arg.id) : rawSpecs;
    const checkResult = gateChecks(specs, mode);
    const findings = checkResult.checks.filter((c) => !c.ok && c.inconclusive !== true);
    const inconclusiveChecks = checkResult.checks.filter((c) => c.inconclusive === true);

    deps.emit({
      runId: ctx.runId,
      type: 'gate-checks',
      payload: {
        gateId: arg.id,
        mode,
        ok: checkResult.ok,
        failed: findings.length,
        inconclusive: inconclusiveChecks.length,
      },
    });

    if (mode === 'auto') {
      if (!checkResult.ok && checkResult.inconclusive) {
        const inconclusiveChecks = checkResult.checks.filter((c) => c.inconclusive === true);
        const reasons = inconclusiveChecks.map((c) => `${c.id}: ${c.reason ?? 'sem veredito'}`).join('; ');
        logger.warn(
          {
            phase: 'gate-decision',
            runId: ctx.runId,
            gateId: arg.id,
            mode,
            decision: 'inconclusive',
            inconclusiveChecks: inconclusiveChecks.map((c) => ({
              id: c.id,
              kind: c.kind,
              reason: c.reason,
            })),
          },
          'gate auto INCONCLUSIVO (toolchain/infra nao produziu veredito)',
        );
        persistGateDecision(deps, ctx, {
          gateId: arg.id,
          mode,
          decision: 'rejected',
          decidedBy: 'auto',
          payload: { checks: checkResult.checks, inconclusive: true },
        });
        const gateInconclusivePrompt =
          `gate auto '${arg.id}' INCONCLUSIVO: os checks nao produziram veredito (falha de toolchain/infra, nao de codigo). ${reasons}. ` +
          'Conserte o ambiente e RETOME o run.';
        deps.crud.patchRun(ctx.runId, {
          status: 'blocked',
          pendingDecisionJson: JSON.stringify({
            pendingDecision: {
              type: 'error',
              id: `gate:${arg.id}:inconclusive`,
              prompt: gateInconclusivePrompt,
            },
          }),
        });
        raiseBlockedFatal(new WorkflowHostFatalError('gate-inconclusive', gateInconclusivePrompt));
      }
      const decision: DynamicWorkflowGateDecisionValue = checkResult.ok ? 'approved' : 'rejected';
      logger.info(
        {
          phase: 'gate-decision',
          runId: ctx.runId,
          gateId: arg.id,
          mode,
          decision,
          decidedBy: 'auto',
          reason: checkResult.ok
            ? 'todos os checks deterministicos passaram'
            : `checks reprovados: ${findings.map((f) => f.id).join(', ')}`,
          failedChecks: findings.map((f) => ({ id: f.id, kind: f.kind, reason: f.reason })),
        },
        checkResult.ok ? 'gate auto aprovado' : 'gate auto reprovado',
      );
      persistGateDecision(deps, ctx, {
        gateId: arg.id,
        mode,
        decision,
        decidedBy: 'auto',
        payload: { checks: checkResult.checks },
      });
      if (!checkResult.ok) {
        throw new WorkflowHostFatalError('gate-rejected', `gate auto '${arg.id}' reprovou nos checks`);
      }
      recordJournalCall(gateClaim.callIndex, gateKey, {
        sideEffectKey: `gate#${arg.id}#approved#auto`,
      });
      return { ok: true, mode, findings, checks: checkResult.checks };
    }

    if (manifestGate.kind === 'delivery' && !checkResult.ok && findings.length === 0 && inconclusiveChecks.length > 0) {
      const reasons = inconclusiveChecks.map((c) => `${c.id}: ${c.reason ?? 'sem veredito'}`).join('; ');
      const deliveryInconclusivePrompt =
        `gate de entrega '${arg.id}' INCONCLUSIVO: nenhum check produziu veredito (toolchain/infra). ${reasons}. ` +
        'A entrega NAO pode ser julgada sem veredito mecanico. Conserte o ambiente e RETOME o run.';
      persistGateDecision(deps, ctx, {
        gateId: arg.id,
        mode,
        decision: 'rejected',
        decidedBy: 'auto-checks',
        reason: deliveryInconclusivePrompt,
        payload: { checks: checkResult.checks, inconclusive: true },
      });
      deps.crud.patchRun(ctx.runId, {
        status: 'blocked',
        pendingDecisionJson: JSON.stringify({
          pendingDecision: {
            type: 'error',
            id: `gate:${arg.id}:inconclusive`,
            prompt: deliveryInconclusivePrompt,
          },
        }),
      });
      raiseBlockedFatal(new WorkflowHostFatalError('gate-inconclusive', deliveryInconclusivePrompt));
    }

    if (manifestGate.kind === 'delivery' && !checkResult.ok && findings.length > 0 && arg.escalateIfRed !== true) {
      const failureDirection =
        'A entrega reprovou nos checks deterministicos - conserte ate TODOS passarem (verde) e nao declare pronto antes disso. Falhas: ' +
        findings.map((f) => `${f.kind}/${f.id}: ${f.reason}`).join(' | ');
      logger.info(
        {
          phase: 'gate-decision',
          runId: ctx.runId,
          gateId: arg.id,
          mode,
          decision: 'redev-auto',
          decidedBy: 'auto-checks',
          reason: failureDirection,
          failedChecks: findings.map((f) => ({ id: f.id, kind: f.kind, reason: f.reason })),
        },
        'gate de entrega reprovou nos checks -> redev automatico (volta pro dev com as falhas)',
      );
      persistGateDecision(deps, ctx, {
        gateId: arg.id,
        mode,
        decision: 'rejected',
        decidedBy: 'auto-checks',
        reason: failureDirection,
        payload: { checks: checkResult.checks },
      });
      deps.emit({
        runId: ctx.runId,
        type: 'gate-redev-auto',
        payload: { gateId: arg.id, mode, failed: findings.length },
      });
      return {
        ok: true,
        mode,
        findings,
        checks: checkResult.checks,
        reason: failureDirection,
        decisionPayload: { action: 'redev' },
      };
    }

    const humanGatePrompt =
      manifestGate.kind === 'plan-review'
        ? `gate humano '${arg.id}' aguardando aprovacao (revise o plano de sprints)`
        : `gate humano '${arg.id}' aguardando aprovacao (merge/aceite da entrega)`;
    const inconclusiveNote =
      inconclusiveChecks.length > 0
        ? ` [ATENCAO: ${inconclusiveChecks.length} check(s) INCONCLUSIVO(s) - toolchain/infra nao produziu veredito: ${inconclusiveChecks
            .map((c) => `${c.id} (${c.reason ?? 'sem veredito'})`)
            .join('; ')}]`
        : '';
    const pendingDecision = {
      type: 'gate' as const,
      id: arg.id,
      prompt:
        (mode === 'human' ? humanGatePrompt : `gate '${arg.id}' aguardando aprovacao do orquestrador`) +
        inconclusiveNote,
    };
    deps.crud.patchRun(ctx.runId, {
      status: 'blocked',
      pendingDecisionJson: JSON.stringify({ pendingDecision }),
    });
    deps.emit({
      runId: ctx.runId,
      type: 'gate-blocked',
      payload: { gateId: arg.id, mode },
    });

    const resolution = await deps.gateGate.awaitDecision(arg.id, mode);

    logger.info(
      {
        phase: 'gate-decision',
        runId: ctx.runId,
        gateId: arg.id,
        mode,
        decision: resolution.decision === 'approve' ? 'approved' : 'rejected',
        decidedBy: resolution.approvedBy,
        reason: resolution.reason,
        mechanicalChecksOk: checkResult.ok,
        failedChecks: findings.map((f) => ({ id: f.id, kind: f.kind, reason: f.reason })),
      },
      `gate ${mode} resolvido por ${resolution.approvedBy}: ${resolution.decision}`,
    );

    persistGateDecision(deps, ctx, {
      gateId: arg.id,
      mode,
      decision: resolution.decision === 'approve' ? 'approved' : 'rejected',
      decidedBy: resolution.approvedBy,
      reason: resolution.reason,
      payload: { checks: checkResult.checks },
    });

    if (resolution.decision === 'reject') {
      throw new WorkflowHostFatalError('gate-rejected', `gate '${arg.id}' rejeitado por ${resolution.approvedBy}`);
    }

    deps.crud.patchRun(ctx.runId, { status: 'running', pendingDecisionJson: JSON.stringify({}) });
    deps.emit({
      runId: ctx.runId,
      type: 'gate-approved',
      payload: { gateId: arg.id, approvedBy: resolution.approvedBy },
    });

    const decisionAction =
      resolution.payload && typeof resolution.payload['action'] === 'string'
        ? (resolution.payload['action'] as string)
        : null;
    const isRedevApprove = decisionAction === 'redev' || decisionAction === 'replan';

    if (!isRedevApprove && isFinalGate(manifestGate, ctx.manifest) && ctx.onFinalGateApproved) {
      await ctx.onFinalGateApproved(arg.id, resolution.approvedBy);
    }

    recordJournalCall(gateClaim.callIndex, gateKey, {
      sideEffectKey: isRedevApprove
        ? `gate#${arg.id}#approved#${resolution.approvedBy}#redev:${decisionAction}`
        : `gate#${arg.id}#approved#${resolution.approvedBy}`,
    });

    return {
      ok: true,
      mode,
      findings,
      approvedBy: resolution.approvedBy,
      checks: checkResult.checks,
      reason: resolution.reason,
      decisionPayload: resolution.payload,
    };
  }

  async function runArtifact(arg: ArtifactPrimitiveArg): Promise<unknown> {
    assertNotAborted();
    if (!arg || typeof arg.path !== 'string' || arg.path.length === 0) {
      throw new WorkflowHostFatalError('policy-invalid', 'artifact() sem path valido');
    }
    const content =
      typeof arg.content === 'string'
        ? arg.content
        : arg.data !== undefined
          ? serializeArtifactData(arg.type, arg.data)
          : '';

    const artifactKey = sideEffectJournalKey('artifact', arg.id ?? null, {
      path: arg.path,
      type: arg.type ?? 'artifact',
      content,
    });
    const artifactClaim = claimJournalCall(artifactKey);
    const reusing = artifactClaim.decision === 'reuse' && !!artifactClaim.entry?.sideEffectKey;

    const artDeps: WorkflowArtifactsDeps = {
      registerArtifact: reusing
        ? (input) => ({
            id: 'replayed',
            runId: input.runId,
            nodeId: input.nodeId ?? null,
            kind: input.kind,
            path: input.path,
            sha256: input.sha256,
            metadataJson: input.metadataJson ?? '{}',
            createdAt: now(),
          })
        : deps.crud.registerArtifact,
      generateId: () => generateId('dwfa'),
    };
    const written = writeArtifact(artDeps, {
      runId: ctx.runId,
      runDir: ctx.runDir,
      relativePath: arg.path,
      content,
      kind: arg.type ?? 'artifact',
      nodeId: arg.id ?? null,
      metadata: { artifactNodeId: arg.id ?? null },
    });
    deps.emit({
      runId: ctx.runId,
      type: reusing ? 'artifact-replayed' : 'artifact-written',
      payload: { path: written.absolutePath, sha256: written.sha256, kind: arg.type ?? 'artifact' },
    });
    if (!reusing) {
      recordJournalCall(artifactClaim.callIndex, artifactKey, {
        sideEffectKey: `artifact#${arg.path}#${written.sha256}`,
        outputRef: written.sha256,
      });
    }
    return { ok: true, path: written.absolutePath, sha256: written.sha256 };
  }

  async function runCheckpoint(arg: CheckpointPrimitiveArg): Promise<unknown> {
    assertNotAborted();
    if (!arg || typeof arg.id !== 'string' || arg.id.length === 0) {
      throw new WorkflowHostFatalError('policy-invalid', 'checkpoint() sem id valido');
    }
    const checkpointKey = sideEffectJournalKey('checkpoint', arg.id, {
      id: arg.id,
      state: arg.state ?? null,
    });
    const checkpointClaim = claimJournalCall(checkpointKey);
    if (checkpointClaim.decision === 'reuse' && checkpointClaim.entry?.sideEffectKey) {
      deps.emit({
        runId: ctx.runId,
        type: 'checkpoint-replayed',
        nodeId: arg.id,
        payload: { callIndex: checkpointClaim.callIndex },
      });
      return { ok: true };
    }
    const cpDeps: WorkflowCheckpointsDeps = {
      getRunCheckpoint: deps.crud.getRunCheckpoint,
      persistRunCheckpoint: deps.crud.persistRunCheckpoint,
      now: () => new Date(now()),
    };
    const saved = saveNodeCheckpoint(cpDeps, {
      runId: ctx.runId,
      runDir: ctx.runDir,
      nodeId: arg.id,
      attempt: attemptByNode.get(arg.id) ?? 0,
      state: arg.state ?? null,
      revision: ctx.workflowRevision ?? null,
    });
    deps.emit({ runId: ctx.runId, type: 'checkpoint-saved', nodeId: arg.id, payload: { path: saved.absolutePath } });
    recordJournalCall(checkpointClaim.callIndex, checkpointKey, {
      sideEffectKey: `checkpoint#${arg.id}`,
    });
    return { ok: true };
  }

  async function runLog(arg: unknown): Promise<unknown> {
    const message = typeof arg === 'string' ? arg : ((arg as { message?: string })?.message ?? '');
    const data = (arg as { data?: unknown })?.data;
    deps.emit({ runId: ctx.runId, type: 'log', payload: { message, data } });
    return undefined;
  }

  async function runValidateSprintPlan(arg: unknown): Promise<{
    ok: boolean;
    plan: DynamicWorkflowSprintPlan;
    errors: PlanValidationError[];
  }> {
    const rawSprints = extractRawSprints(arg);
    const maxDevRounds = effectiveMaxDevRounds(ctx);
    const { normalized, errors } = normalizeAndValidatePlan(rawSprints, {
      maxDevRounds,
      catalogAgentIds: ctx.catalogAgentIds ?? null,
      projectPath: ctx.projectPath,
    });

    const planHash = computeCanonicalPlanHash(normalized);
    if (planHash !== lastValidatedHash) {
      planVersionCounter += 1;
      lastValidatedHash = planHash;
      while (true) {
        const collided = materialized.get(planVersionCounter);
        if (!collided || collided.planHash === planHash) break;
        planVersionCounter += 1;
      }
    }
    const planVersion = planVersionCounter;
    journalPlanHashAsOf = planHash;

    const plan: DynamicWorkflowSprintPlan = {
      planVersion,
      planHash,
      sprints: normalized,
    };

    deps.emit({
      runId: ctx.runId,
      type: 'sprint-plan-validated',
      payload: {
        ok: errors.length === 0,
        planVersion,
        planHash,
        sprints: normalized.length,
        errorCount: errors.length,
      },
    });

    return { ok: errors.length === 0, plan, errors };
  }

  async function runGreenCheck(arg: GreenCheckPrimitiveArg): Promise<GreenCheckResult> {
    assertNotAborted();

    const sprintCwdForChecks =
      typeof arg?.sprintIndex === 'number' && ctx.resolveSprintCwd ? ctx.resolveSprintCwd(arg.sprintIndex) : null;
    const buildScriptDetected = detectBuildScript(sprintCwdForChecks ?? ctx.workspaceRoot);
    const hasBuild = buildScriptDetected ?? ctx.hasBuildScript === true;
    const wantsBuild = arg?.final === true && hasBuild;
    const provided = Array.isArray(arg?.checks) ? (arg!.checks as GateCheckSpec[]) : null;
    const symbolicChecks: GateCheckSpec[] =
      provided && provided.length > 0 ? provided : defaultGreenCheckSpecs(wantsBuild);

    const specs = ctx.resolveGateChecks
      ? ctx.resolveGateChecks(symbolicChecks, GREEN_CHECK_PSEUDO_GATE_ID)
      : symbolicChecks;

    let resolvedSpecs = specs;
    if (typeof arg?.sprintIndex === 'number' && ctx.resolveSprintCwd) {
      const sprintCwd = ctx.resolveSprintCwd(arg.sprintIndex);
      if (sprintCwd) {
        resolvedSpecs = specs.map((s) => (s.kind === 'command' ? { ...s, cwd: sprintCwd } : s));
      }
    }

    const result = gateChecks(resolvedSpecs, 'auto');
    const redChecks = result.checks.filter((c) => !c.ok && c.inconclusive !== true);
    const inconclusiveChecks = result.checks.filter((c) => c.inconclusive === true);
    const findings: GreenCheckFinding[] = redChecks.map((c) => greenCheckFindingOf(c));

    deps.emit({
      runId: ctx.runId,
      type: 'green-check',
      payload: {
        ok: result.ok,
        inconclusive: result.inconclusive,
        final: wantsBuild,
        buildScriptDetected,
        checkCount: result.checks.length,
        redCount: redChecks.length,
        redChecks: redChecks.map((c) => ({ id: c.id, kind: c.kind, reason: c.reason })),
        inconclusiveChecks: inconclusiveChecks.map((c) => ({
          id: c.id,
          kind: c.kind,
          reason: c.reason,
        })),
      },
    });

    if (!result.ok && result.inconclusive) {
      const reasons = inconclusiveChecks.map((c) => `${c.id}: ${c.reason ?? 'sem veredito'}`).join('; ');
      const prompt =
        `green-check INCONCLUSIVO: a toolchain nao produziu veredito (${reasons}). ` +
        'Isso e falha de AMBIENTE, nao do codigo do run. Conserte (ex: dependencias instaladas na worktree, binarios no PATH) e retome o run.';
      deps.crud.patchRun(ctx.runId, {
        status: 'blocked',
        pendingDecisionJson: JSON.stringify({
          pendingDecision: { type: 'error', id: 'green-check:inconclusive', prompt },
        }),
      });
      raiseBlockedFatal(new WorkflowHostFatalError('gate-inconclusive', prompt));
    }

    return { ok: result.ok, inconclusive: result.inconclusive, findings, checks: result.checks };
  }

  async function runMaterializeSprintPlan(arg: unknown): Promise<{
    sprints: Array<{ sprintId: string; nodeIds: string[] }>;
    planVersion: number;
    parallelGroups: Array<{ sprintIds: string[] }>;
  }> {
    assertNotAborted();
    const plan = arg as DynamicWorkflowSprintPlan | null;
    if (
      !plan ||
      typeof plan !== 'object' ||
      typeof plan.planVersion !== 'number' ||
      typeof plan.planHash !== 'string' ||
      !Array.isArray(plan.sprints)
    ) {
      throw new WorkflowHostFatalError(
        'policy-invalid',
        'materializeSprintPlan: plano invalido (esperado { planVersion, planHash, sprints[] } do validateSprintPlan)',
      );
    }

    const catalogIds = ctx.catalogAgentIds;
    if (Array.isArray(catalogIds) && catalogIds.length > 0) {
      const catalog = new Set(catalogIds);
      const fallbackCoder = catalog.has(DYNAMIC_WORKFLOW_CODER_ID) ? DYNAMIC_WORKFLOW_CODER_ID : catalogIds[0]!;
      for (const sprint of plan.sprints) {
        if (!sprint) continue;
        if (typeof sprint.coderAgentId !== 'string' || !catalog.has(sprint.coderAgentId)) {
          logger.warn(
            {
              runId: ctx.runId,
              sprintIndex: sprint.index,
              badAgent: sprint.coderAgentId,
              fallback: fallbackCoder,
            },
            'SM-25: coderAgentId fora do catalogo; remapeado pro coder fallback (run nao crasha)',
          );
          sprint.coderAgentId = fallbackCoder;
        }
        if (Array.isArray(sprint.validatorAgentIds)) {
          const before = sprint.validatorAgentIds;
          const filtered = before.filter((v) => typeof v === 'string' && catalog.has(v));
          if (filtered.length !== before.length) {
            logger.warn(
              {
                runId: ctx.runId,
                sprintIndex: sprint.index,
                dropped: before.filter((v) => typeof v !== 'string' || !catalog.has(v)),
              },
              'SM-50: validatorAgentId fora do catalogo (ex typescript-validator); removido -> fabrica usa os 3 validadores default por eixo (run nao crasha)',
            );
            sprint.validatorAgentIds = filtered;
          }
        }
      }
    }

    const materializeKey = sideEffectJournalKey('materializeSprintPlan', null, plan);
    const materializeClaim = claimJournalCall(materializeKey);

    const parallelGroups = partitionSprintsForParallel(
      plan.sprints.map((s) => ({
        sprintId: `s${s.index}`,
        index: s.index,
        writeSet: Array.isArray(s.writeSetHint) ? s.writeSetHint : [],
        dependencies: Array.isArray(s.dependencies) ? s.dependencies : [],
      })),
    );

    emitPlanArtifacts(
      { registerArtifact: deps.crud.registerArtifact, generateId: () => generateId('dwfa') },
      { runId: ctx.runId, runDir: ctx.runDir, plan, parallelGroups },
    );

    if (ctx.prepareSprintWorktrees) {
      const parallelIdxs: number[] = [];
      for (const g of parallelGroups) {
        if (g.sprintIds.length <= 1) continue;
        for (const sid of g.sprintIds) {
          const idx = Number(/^s(\d+)$/.exec(sid)?.[1]);
          if (Number.isInteger(idx)) parallelIdxs.push(idx);
        }
      }
      if (parallelIdxs.length > 0) {
        try {
          await ctx.prepareSprintWorktrees(parallelIdxs);
        } catch (err) {
          logger.warn(
            { err, runId: ctx.runId, parallelIdxs },
            'falha ao preparar worktrees de sprint (degrada para sequencial)',
          );
        }
      }
    }

    const prior = materialized.get(plan.planVersion);
    if (prior) {
      if (prior.planHash !== plan.planHash) {
        throw new WorkflowHostFatalError(
          'policy-invalid',
          `materializeSprintPlan: planVersion ${plan.planVersion} ja materializada com hash diferente (esperado ${prior.planHash}, recebido ${plan.planHash}) - inconsistencia`,
        );
      }
      recordJournalCall(materializeClaim.callIndex, materializeKey, {
        sideEffectKey: `materialize#${plan.planVersion}#${plan.planHash}`,
      });
      return { sprints: prior.sprintNodeIds, planVersion: plan.planVersion, parallelGroups };
    }

    if (!ctx.buildSprintNodes) {
      throw new WorkflowHostFatalError(
        'policy-invalid',
        'materializeSprintPlan: buildSprintNodes nao injetado (host nao configurado para o fluxo de sprints)',
      );
    }
    const crudMaterialize = deps.crud.materializeSprintPlan;
    const crudCreateNodes = deps.crud.createNodes;
    const crudUpdateDefinition = deps.crud.updateDefinition;
    const crudPersistSprints = deps.crud.persistSprints;
    if (!crudMaterialize && (!crudCreateNodes || !crudUpdateDefinition || !crudPersistSprints)) {
      throw new WorkflowHostFatalError(
        'policy-invalid',
        'materializeSprintPlan: CRUD de runtime (materializeSprintPlan combinada OU createNodes/updateDefinition/persistSprints) nao injetada (host nao configurado para o fluxo de sprints)',
      );
    }
    const definitionId = ctx.definitionId;
    if (!definitionId) {
      throw new WorkflowHostFatalError(
        'policy-invalid',
        'materializeSprintPlan: ctx.definitionId ausente (sem definition nao ha onde gravar os nodes de dev)',
      );
    }

    const maxDevRounds = effectiveMaxDevRounds(ctx);
    let fixerAgentId: string | null | undefined = undefined;
    if (Array.isArray(catalogIds) && catalogIds.length > 0) {
      if (catalogIds.includes(DEV_DEFAULT_FIXER_AGENT_ID)) {
        fixerAgentId = DEV_DEFAULT_FIXER_AGENT_ID;
      } else {
        fixerAgentId = null;
        logger.warn(
          { runId: ctx.runId, fixerAgentId: DEV_DEFAULT_FIXER_AGENT_ID },
          'S6: fixer dedicado fora do catalogo (deletado?); nodes fixer-* remapeados pro coder da sprint (fallback; run nao crasha)',
        );
      }
    }
    const { manifestNodes, createInputs, sprintNodeIds } = ctx.buildSprintNodes(plan, {
      maxDevRounds,
      fixerAgentId,
    });

    const candidateManifest: DynamicWorkflowManifest = {
      ...ctx.manifest,
      nodes: [...ctx.manifest.nodes, ...manifestNodes],
    };
    const validationInput: ValidateWorkflowPackageInput = {
      workflowJsSource: '',
      manifest: candidateManifest,
      catalogAgentIds: ctx.catalogAgentIds,
      schemaFileNames: ctx.schemaFileNames,
    };
    const report = validateWorkflowPackage(validationInput);
    const blocking = report.issues.filter((i) => i.severity === 'error' && !COMPILER_ONLY_ISSUE_CODES.has(i.code));
    if (blocking.length > 0) {
      const detail = blocking.map((i) => `${i.code}: ${i.message}`).join('; ');
      throw new WorkflowHostFatalError(
        'policy-invalid',
        `materializeSprintPlan: grafo expandido invalido como pacote runtime (${detail})`,
      );
    }

    const protectedHit = findProtectedWriteSetHit(manifestNodes, ctx.protectedPaths ?? []);
    if (protectedHit) {
      throw new WorkflowHostFatalError(
        'policy-invalid',
        `materializeSprintPlan: node '${protectedHit.nodeId}' escreve em path protegido '${protectedHit.path}' (sec 5.1)`,
      );
    }

    for (const node of manifestNodes) {
      ctx.manifest.nodes.push(node);
      nodeById.set(node.id, node);
    }
    const definitionPatch: DynamicWorkflowDefinitionPatch = {
      manifestJson: JSON.stringify(ctx.manifest),
      manifestHash: createHash('sha256').update(JSON.stringify(ctx.manifest)).digest('hex'),
    };
    const nodeSprintMeta = manifestNodes
      .filter((node) => node.sprintId !== undefined)
      .map((node) => ({
        nodeId: node.id,
        patch: { sprintId: node.sprintId, roundIndex: node.roundIndex ?? null },
      }));
    const sprintUpserts: DynamicWorkflowSprintUpsertInput[] = plan.sprints.map((s) => ({
      runId: ctx.runId,
      sprintId: s.id,
      planVersion: plan.planVersion,
      planHash: plan.planHash,
      sprintIndex: s.index,
      name: s.name,
      coderAgentId: s.coderAgentId ?? null,
      validatorAgentIds: s.validatorAgentIds,
      features: s.features,
      writeSetHint: s.writeSetHint,
      dependencies: s.dependencies,
      maxRounds: s.maxRounds,
    }));
    if (crudMaterialize) {
      crudMaterialize({
        definitionId,
        nodes: createInputs,
        definitionPatch,
        nodeSprintMeta,
        sprints: sprintUpserts,
      });
    } else {
      crudCreateNodes!(definitionId, createInputs);
      crudUpdateDefinition!(definitionId, definitionPatch);
      const setNodeSprintMeta = deps.crud.setNodeSprintMeta;
      if (setNodeSprintMeta) {
        for (const meta of nodeSprintMeta) {
          setNodeSprintMeta(definitionId, meta.nodeId, meta.patch);
        }
      }
      crudPersistSprints!(sprintUpserts);
    }
    persistPlanRefOnRun(deps, ctx, plan.planVersion, plan.planHash);

    materialized.set(plan.planVersion, {
      planHash: plan.planHash,
      sprintNodeIds,
    });

    deps.emit({
      runId: ctx.runId,
      type: 'sprint-plan-materialized',
      payload: {
        planVersion: plan.planVersion,
        planHash: plan.planHash,
        sprints: sprintNodeIds.length,
        nodes: manifestNodes.length,
      },
    });

    recordJournalCall(materializeClaim.callIndex, materializeKey, {
      sideEffectKey: `materialize#${plan.planVersion}#${plan.planHash}`,
    });

    return { sprints: sprintNodeIds, planVersion: plan.planVersion, parallelGroups };
  }

  return {
    phase: (arg) => phase(arg),
    agent: (arg) => agentSemaphore.run(() => runAgentNode(arg as AgentPrimitiveArg)),
    parallel: (arg) => {
      const a = arg as { thunks?: WorkflowThunk[]; options?: ParallelOptions };
      if (Array.isArray((arg as { thunks?: unknown }).thunks)) {
        return runParallel(a.thunks ?? [], a.options ?? {});
      }
      return runParallel([], a?.options ?? {});
    },
    pipeline: (arg) => {
      const a = arg as {
        items?: unknown[];
        stages?: Array<(prevResult: unknown, originalItem: unknown, index: number) => Promise<unknown> | unknown>;
      };
      return runPipeline(a?.items ?? [], a?.stages ?? []);
    },
    gate: (arg) => runGate(arg as GatePrimitiveArg),
    artifact: (arg) => runArtifact(arg as ArtifactPrimitiveArg),
    checkpoint: (arg) => runCheckpoint(arg as CheckpointPrimitiveArg),
    log: (arg) => runLog(arg),
    validateSprintPlan: (arg) => runValidateSprintPlan(arg),
    materializeSprintPlan: (arg) => runMaterializeSprintPlan(arg),
    greenCheck: (arg) => runGreenCheck(arg as GreenCheckPrimitiveArg),
  };
}

const DEFAULT_MAX_DEV_ROUNDS = 3;
export const MAX_DEV_ROUNDS_CEILING = 12;

const COMPILER_ONLY_ISSUE_CODES: ReadonlySet<string> = new Set([
  'subset-esm',
  'meta-literal',
  'run-export',
  'forbidden-api',
  'determinism',
  'empty-source',
  'parse-error',
  'compiler-error',
]);

export function renderPlanMarkdown(
  plan: DynamicWorkflowSprintPlan,
  parallelGroups: Array<{ sprintIds: string[] }>,
): string {
  const lines: string[] = [];
  lines.push(`# Plano de sprints (versao ${plan.planVersion})`);
  lines.push('');
  lines.push(`- planVersion: ${plan.planVersion}`);
  lines.push(`- planHash: ${plan.planHash}`);
  lines.push(`- sprints: ${plan.sprints.length}`);
  const parallel = parallelGroups.filter((g) => g.sprintIds.length > 1);
  if (parallel.length > 0) {
    lines.push(`- batches paralelos: ${parallel.map((g) => `[${g.sprintIds.join(', ')}]`).join(' ')}`);
  } else {
    lines.push('- execucao: sequencial (sem batches paralelos)');
  }
  lines.push('');
  for (const s of plan.sprints) {
    lines.push(`## ${s.id} - ${s.name}`);
    lines.push('');
    if (s.description) {
      lines.push(s.description);
      lines.push('');
    }
    lines.push(`- index: ${s.index}`);
    if (s.stack.length > 0) lines.push(`- stack: ${s.stack.join(', ')}`);
    lines.push(`- coder: ${s.coderAgentId}`);
    if (s.validatorAgentIds.length > 0) {
      lines.push(`- validadores: ${s.validatorAgentIds.join(', ')}`);
    }
    if (s.dependencies.length > 0) {
      lines.push(`- depende de: ${s.dependencies.join(', ')}`);
    }
    if (s.writeSetHint.length > 0) {
      lines.push(`- write set: ${s.writeSetHint.join(', ')}`);
    }
    lines.push(`- maxRounds: ${s.maxRounds}`);
    if (s.features.length > 0) {
      lines.push('');
      lines.push('### Features');
      lines.push('');
      for (const f of s.features) {
        lines.push(`- ${f.id}: ${f.name}`);
        for (const ac of f.acceptanceCriteria) {
          lines.push(`  - [ ] ${ac}`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function emitPlanArtifacts(
  artDeps: WorkflowArtifactsDeps,
  input: {
    runId: string;
    runDir: string;
    plan: DynamicWorkflowSprintPlan;
    parallelGroups: Array<{ sprintIds: string[] }>;
  },
): void {
  const meta = { planVersion: input.plan.planVersion, planHash: input.plan.planHash };
  try {
    writeArtifact(artDeps, {
      runId: input.runId,
      runDir: input.runDir,
      relativePath: 'plan.md',
      content: renderPlanMarkdown(input.plan, input.parallelGroups),
      kind: 'plan',
      metadata: meta,
    });
  } catch (err) {
    logger.warn({ err, runId: input.runId }, 'falha ao gravar plan.md (ignorado)');
  }
  try {
    writeArtifact(artDeps, {
      runId: input.runId,
      runDir: input.runDir,
      relativePath: 'sprints.json',
      content: JSON.stringify(
        {
          planVersion: input.plan.planVersion,
          planHash: input.plan.planHash,
          parallelGroups: input.parallelGroups,
          sprints: input.plan.sprints,
        },
        null,
        2,
      ),
      kind: 'sprints',
      metadata: meta,
    });
  } catch (err) {
    logger.warn({ err, runId: input.runId }, 'falha ao gravar sprints.json (ignorado)');
  }
}

export const GREEN_CHECK_PSEUDO_GATE_ID = '__green-check__';

export function defaultGreenCheckSpecs(wantsBuild: boolean): GateCheckSpec[] {
  const specs: GateCheckSpec[] = [
    {
      kind: 'command',
      id: 'green-check:typecheck',
      command: 'npm run typecheck',
      baselineRef: 'context-bundle.baselineResults',
    } as unknown as GateCheckSpec,
    {
      kind: 'command',
      id: 'green-check:test',
      command: 'npm run test',
      baselineRef: 'context-bundle.baselineResults',
    } as unknown as GateCheckSpec,
  ];
  if (wantsBuild) {
    specs.push({
      kind: 'command',
      id: 'green-check:build',
      command: 'npm run build',
    } as unknown as GateCheckSpec);
  }
  return specs;
}

export function greenCheckFindingOf(check: GateCheckResult): GreenCheckFinding {
  const where = typeof check.detail?.command === 'string' ? (check.detail.command as string) : check.id;
  return {
    severity: 'P1',
    where,
    problem: `green-check: ${check.kind} '${check.id}' vermelho${check.reason ? ` (${check.reason})` : ''}`,
    fix: 'rode o comando de verificacao localmente e conserte ate ficar verde (o host re-roda a cada rodada)',
  };
}

function effectiveMaxDevRounds(ctx: HostApiRunContext): number {
  const raw = ctx.sprintPlanConfig?.maxDevRounds;
  const v = typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_DEV_ROUNDS;
  return Math.min(v, MAX_DEV_ROUNDS_CEILING);
}

function extractRawSprints(arg: unknown): unknown[] {
  if (Array.isArray(arg)) return arg;
  if (arg && typeof arg === 'object' && Array.isArray((arg as { sprints?: unknown }).sprints)) {
    return (arg as { sprints: unknown[] }).sprints;
  }
  return [];
}

function planError(code: string, message: string, sprintId?: string): PlanValidationError {
  return sprintId ? { sprintId, code, message } : { code, message };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export function normalizeAndValidatePlan(
  rawSprints: unknown[],
  opts: {
    maxDevRounds: number;
    catalogAgentIds: string[] | null;
    projectPath?: string;
  },
): { normalized: PlannedSprint[]; errors: PlanValidationError[] } {
  const errors: PlanValidationError[] = [];
  const normalized: PlannedSprint[] = [];
  const catalog = opts.catalogAgentIds ? new Set(opts.catalogAgentIds) : null;

  if (!Array.isArray(rawSprints) || rawSprints.length === 0) {
    errors.push(planError('plan-empty', 'plano sem sprints (esperado ao menos uma sprint)'));
    return { normalized, errors };
  }

  const fallbackCoder =
    catalog && !catalog.has(DYNAMIC_WORKFLOW_CODER_ID) && opts.catalogAgentIds && opts.catalogAgentIds.length > 0
      ? opts.catalogAgentIds[0]!
      : DYNAMIC_WORKFLOW_CODER_ID;

  const seenIds = new Set<string>();
  rawSprints.forEach((raw, idx) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    let id = typeof s.id === 'string' && s.id.length > 0 ? s.id : `s${idx}`;
    if (seenIds.has(id)) {
      let n = 2;
      while (seenIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    seenIds.add(id);

    const name = typeof s.name === 'string' && s.name.length > 0 ? s.name : `Sprint ${idx}`;
    const description = typeof s.description === 'string' && s.description.length > 0 ? s.description : name;

    let coderAgentId = typeof s.coderAgentId === 'string' && s.coderAgentId.length > 0 ? s.coderAgentId : fallbackCoder;
    if (catalog && !catalog.has(coderAgentId)) coderAgentId = fallbackCoder;

    let validatorAgentIds = asStringArray(s.validatorAgentIds);
    if (validatorAgentIds.length === 0) validatorAgentIds = [...DEV_DEFAULT_VALIDATOR_AGENT_IDS];
    if (catalog) validatorAgentIds = validatorAgentIds.filter((v) => catalog.has(v));
    if (validatorAgentIds.length === 0) validatorAgentIds = [...DEV_DEFAULT_VALIDATOR_AGENT_IDS];

    const featuresRaw = Array.isArray(s.features) ? s.features : [];
    if (featuresRaw.length === 0) {
      errors.push(planError('features-empty', `sprint '${id}' sem features`, id));
    }
    const features: PlannedSprintFeature[] = featuresRaw.map((f, fi) => {
      const fr = (f ?? {}) as Record<string, unknown>;
      const fid = typeof fr.id === 'string' && fr.id.length > 0 ? fr.id : `${id}-f${fi}`;
      const fname = typeof fr.name === 'string' ? fr.name : '';
      const ac = asStringArray(fr.acceptanceCriteria).filter((c) => c.trim().length > 0);
      if (ac.length === 0) {
        errors.push(
          planError(
            'acceptance-criteria-missing',
            `feature '${fid}' da sprint '${id}' sem acceptanceCriteria verificavel`,
            id,
          ),
        );
      }
      return { id: fid, name: fname, acceptanceCriteria: ac };
    });

    let maxRounds = opts.maxDevRounds;
    if (s.maxRounds !== undefined) {
      const m = Number(s.maxRounds);
      if (Number.isFinite(m)) maxRounds = Math.min(MAX_DEV_ROUNDS_CEILING, Math.max(1, Math.floor(m)));
    }

    const writeSetHint = asStringArray(s.writeSetHint).filter(
      (w) => !(w.startsWith('/') || w.startsWith('~') || w.split(/[\\/]+/).includes('..')),
    );

    normalized.push({
      id,
      index: idx,
      name,
      description,
      stack: asStringArray(s.stack),
      coderAgentId,
      validatorAgentIds,
      features,
      writeSetHint,
      dependencies: asStringArray(s.dependencies),
      maxRounds,
    });
  });

  const idSet = new Set(normalized.map((s) => s.id));
  for (const s of normalized) {
    s.dependencies = s.dependencies.filter((dep) => idSet.has(dep));
  }
  breakDependencyCycles(normalized);

  const ordered = topologicalSortByDeps(normalized);
  ordered.forEach((s, i) => {
    s.index = i;
  });

  return { normalized: ordered, errors };
}

function topologicalSortByDeps(sprints: PlannedSprint[]): PlannedSprint[] {
  const byId = new Map(sprints.map((s) => [s.id, s]));
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const s of sprints) {
    indeg.set(s.id, 0);
    dependents.set(s.id, []);
  }
  for (const s of sprints) {
    let d = 0;
    for (const dep of s.dependencies) {
      if (byId.has(dep)) {
        d += 1;
        dependents.get(dep)!.push(s.id);
      }
    }
    indeg.set(s.id, d);
  }
  const queue = sprints.filter((s) => (indeg.get(s.id) ?? 0) === 0).map((s) => s.id);
  const out: PlannedSprint[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node) out.push(node);
    for (const dependent of dependents.get(id) ?? []) {
      indeg.set(dependent, (indeg.get(dependent) ?? 0) - 1);
      if ((indeg.get(dependent) ?? 0) === 0) queue.push(dependent);
    }
  }
  for (const s of sprints) if (!seen.has(s.id)) out.push(s);
  return out;
}

function breakDependencyCycles(sprints: PlannedSprint[]): void {
  const byId = new Map(sprints.map((s) => [s.id, s]));
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const s of sprints) color.set(s.id, WHITE);

  function visit(id: string): void {
    color.set(id, GRAY);
    const node = byId.get(id);
    if (node) {
      for (const dep of [...node.dependencies]) {
        if (!byId.has(dep)) continue;
        const c = color.get(dep) ?? WHITE;
        if (c === GRAY) {
          node.dependencies = node.dependencies.filter((d) => d !== dep);
          continue;
        }
        if (c === WHITE) visit(dep);
      }
    }
    color.set(id, BLACK);
  }

  for (const s of sprints) {
    if ((color.get(s.id) ?? WHITE) === WHITE) visit(s.id);
  }
}

export function computeCanonicalPlanHash(sprints: PlannedSprint[]): string {
  const canonical = sprints
    .map((s) => ({
      id: s.id,
      index: s.index,
      name: s.name,
      description: s.description,
      stack: [...s.stack],
      coderAgentId: s.coderAgentId,
      validatorAgentIds: [...s.validatorAgentIds],
      features: s.features.map((f) => ({
        id: f.id,
        name: f.name,
        acceptanceCriteria: [...f.acceptanceCriteria],
      })),
      writeSetHint: [...s.writeSetHint].sort(),
      dependencies: [...s.dependencies].sort(),
      maxRounds: s.maxRounds,
    }))
    .sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
  return createHash('sha256')
    .update(JSON.stringify({ sprints: canonical }))
    .digest('hex');
}

export function findProtectedWriteSetHit(
  nodes: DynamicWorkflowManifestNode[],
  protectedPaths: string[],
): { nodeId: string; path: string } | null {
  if (protectedPaths.length === 0) return null;
  for (const node of nodes) {
    for (const w of node.writeSet ?? []) {
      for (const p of protectedPaths) {
        if (w === p || w.startsWith(`${p}/`) || p.startsWith(`${w}/`)) {
          return { nodeId: node.id, path: w };
        }
      }
    }
  }
  return null;
}

function persistPlanRefOnRun(deps: HostApiDeps, ctx: HostApiRunContext, planVersion: number, planHash: string): void {
  deps.emit({
    runId: ctx.runId,
    type: 'sprint-plan-ref',
    payload: { planVersion, planHash },
  });
}

export function clampAccess(
  argAccess: DynamicWorkflowNodeAccess | undefined,
  manifestAccess: DynamicWorkflowNodeAccess | undefined,
): DynamicWorkflowNodeAccess {
  const ceiling: DynamicWorkflowNodeAccess = manifestAccess ?? 'read-only';
  if (ceiling === 'workspace-write' && argAccess === 'workspace-write') {
    return 'workspace-write';
  }
  return 'read-only';
}

export function clampList(argList: string[] | undefined, manifestList: string[] | undefined): string[] {
  const ceiling = manifestList ?? [];
  if (ceiling.length === 0) return [];
  if (argList === undefined) return [...ceiling];
  const requested = new Set(argList);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of ceiling) {
    if (requested.has(item) && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

export function clampFlag(argFlag: boolean | undefined, manifestFlag: boolean | undefined): boolean {
  const ceiling = manifestFlag === true;
  if (!ceiling) return false;
  return argFlag !== false;
}

export function clampCeiling(argValue: number | undefined, manifestValue: number | undefined): number | undefined {
  const argOk = typeof argValue === 'number' && Number.isFinite(argValue) && argValue > 0;
  const manifestOk = typeof manifestValue === 'number' && Number.isFinite(manifestValue) && manifestValue > 0;
  if (manifestOk && argOk) return Math.min(argValue, manifestValue);
  if (manifestOk) return manifestValue;
  return argOk ? argValue : manifestValue;
}

export function parseGateRedevAction(sideEffectKey: string): string | null {
  const marker = '#redev:';
  const at = sideEffectKey.lastIndexOf(marker);
  if (at < 0) return null;
  const action = sideEffectKey.slice(at + marker.length);
  return action.length > 0 ? action : null;
}

export function isFinalGate(gate: DynamicWorkflowManifestGate, manifest: DynamicWorkflowManifest): boolean {
  if (gate.mode !== 'human' && gate.mode !== 'orchestrator') return false;
  if (gate.kind === 'delivery') return true;
  if (gate.kind === 'plan-review') return false;
  if (gate.id === 'gate-global' || gate.id === 'gate-final') return true;
  const finalCandidates = manifest.gates.filter(
    (g) => (g.mode === 'human' || g.mode === 'orchestrator') && g.kind !== 'plan-review',
  );
  return finalCandidates.length > 0 && finalCandidates[finalCandidates.length - 1].id === gate.id;
}

export function parseNodeOutput(output: string): unknown {
  if (!output || output.trim().length === 0) return { output: '' };
  try {
    return JSON.parse(output);
  } catch {
    return { output };
  }
}

export function extractValidatorVerdict(
  value: unknown,
): { verdict: string; findingsTotal: number; blockers: number } | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.verdict !== 'string' || !Array.isArray(obj.findings)) return null;
  const findings = obj.findings as Array<unknown>;
  const blockers = findings.filter((f) => {
    if (!f || typeof f !== 'object') return false;
    const sev = (f as Record<string, unknown>).severity;
    return sev === 'P1' || sev === 'P2';
  }).length;
  return { verdict: obj.verdict, findingsTotal: findings.length, blockers };
}

export function describeParsedForPayload(parsed: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const digest = summarizeParsedOutput(parsed);
  if (digest) out.outputDigest = digest;
  const verdict = extractValidatorVerdict(parsed);
  if (verdict) {
    out.validatorVerdict = verdict;
    const findings = extractValidatorFindings(parsed);
    if (findings) {
      out.p1Count = findings.p1;
      out.p2Count = findings.p2;
      out.p3Count = findings.p3;
      out.findings = findings.findings;
    }
    return out;
  }
  const refuter = extractRefuterVerdicts(parsed);
  if (refuter && refuter.length > 0) out.refuterVerdicts = refuter;
  return out;
}

function serializeArtifactData(type: string | undefined, data: unknown): string {
  if (type === 'markdown' || type === 'md' || type === 'text') {
    return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  }
  return JSON.stringify(data, null, 2);
}

function persistGateDecision(
  deps: HostApiDeps,
  ctx: HostApiRunContext,
  input: {
    gateId: string;
    mode: DynamicWorkflowGateMode;
    decision: DynamicWorkflowGateDecisionValue;
    decidedBy: string;
    reason?: string;
    payload?: unknown;
  },
): void {
  const generateId = deps.generateId ?? defaultGenerateId;
  deps.crud.insertGateDecision({
    id: generateId('dwfg'),
    runId: ctx.runId,
    gateId: input.gateId,
    mode: input.mode,
    decision: input.decision,
    decidedBy: input.decidedBy,
    reason: input.reason ?? null,
    payloadJson: JSON.stringify(input.payload ?? {}),
  });
}

function persistNodeCheckpoint(
  deps: HostApiDeps,
  ctx: HostApiRunContext,
  input: {
    nodeId: string;
    attempt: number;
    state: unknown;
    inputHash: string;
    schemaRef: string | null;
    agentId: string;
    worktreeCommitSha: string | null;
  },
): void {
  const cpDeps: WorkflowCheckpointsDeps = {
    getRunCheckpoint: deps.crud.getRunCheckpoint,
    persistRunCheckpoint: deps.crud.persistRunCheckpoint,
    now: () => new Date((deps.now ?? defaultNow)()),
  };
  saveNodeCheckpoint(cpDeps, {
    runId: ctx.runId,
    runDir: ctx.runDir,
    nodeId: input.nodeId,
    attempt: input.attempt,
    state: input.state,
    inputHash: input.inputHash,
    schemaRef: input.schemaRef,
    agentId: input.agentId,
    worktreeCommitSha: input.worktreeCommitSha,
    revision: ctx.workflowRevision ?? null,
  });
}
