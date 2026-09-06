
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createLogger } from '../logger';
import type {
  DynamicWorkflowManifest,
  DynamicWorkflowRun,
  DynamicWorkflowRunStatus,
  DynamicWorkflowRunPatch,
  DynamicWorkflowDefinition,
  DynamicWorkflowNodeRunUpsertInput,
  DynamicWorkflowNodeRunPatch,
  DynamicWorkflowNodeRun,
  DynamicWorkflowEvent,
  DynamicWorkflowEventInsertInput,
  DynamicWorkflowGateDecision,
  DynamicWorkflowGateDecisionInsertInput,
  DynamicWorkflowArtifact,
  DynamicWorkflowArtifactInsertInput,
  DynamicWorkflowMessageInsertInput,
  DynamicWorkflowMessage,
  DynamicWorkflowRunCostAggregate,
  DynamicWorkflowResumeOptions,
  DynamicWorkflowNodeCreateInput,
  DynamicWorkflowNodeSprintPatch,
  DynamicWorkflowSprintUpsertInput,
  DynamicWorkflowSprintPatch,
  DynamicWorkflowSprintRow,
  DynamicWorkflowDefinitionPatch,
  MaterializeDynamicWorkflowSprintPlanInput,
  DynamicWorkflowPriorMaterialization,
  DynamicWorkflowJournalEntry,
  DynamicWorkflowJournalAppendInput,
} from './types';
import {
  createWorkflowHostApi,
  parseNodeOutput,
  buildFailurePendingDecision,
  parseFailureGateAction,
  MAX_DEV_ROUNDS_CEILING,
  type HostApiCrud,
  type HostApiDeps,
  type HostApiRunContext,
  type HostRunPatch,
  type GateGate,
  type NodeFailureHookOutcome,
  type PendingGateResolution,
} from './workflow-host-api';
import {
  resolveGateChecks,
  type GateCheckResolutionContext,
} from './workflow-gate-resolver';
import { runGateChecks, type GateCheckSpec, type CommandRunner } from './workflow-gates';
import { readNodeCheckpoint } from './workflow-checkpoints';
import type { runNodeAgent, WorkflowAdapterDeps } from './workflow-agent-adapter';
import { buildSnapshot, type SnapshotDeps } from './workflow-snapshot';
import {
  emitWorkflowEvent,
  broadcastWorkflowStreamChunk,
  type WorkflowEventsDeps,
} from './workflow-events';
import { WorkflowNarrator, type WorkflowNarratorDeps } from './workflow-narrator';
import { compileWorkflowJs } from './workflow-js-compiler';
import { validateWorkflowPackage } from './workflow-validator';
import { deriveClaudeCodeManifest } from './workflow-create';
import { SCHEMAS_SUBDIR } from './workflow-package';
import { jsonSchemaToOutputSchema } from './workflow-schema';
import { buildDevSprintNodes } from './sprint-node-factory';
import {
  runWorkflowSandbox,
  createUtilityProcessFactory,
  SANDBOX_CHILD_ENTRY_BASENAME,
  type SandboxProcessFactory,
  type WorkflowSandboxHandlers,
} from './workflow-sandbox';
import {
  probeProjectState,
  prepareWorkspace,
  recreateWorktree,
  cleanupWorktree,
  prepareSprintWorktree,
  cleanupSprintWorktree,
  type WorkspaceHandle,
  type SprintWorktreeHandle,
} from './workflow-worktree';
import {
  commitNode,
  commitWip,
  commitFailedWip,
  resetToCommit,
  buildTouchedFilesReport,
  squashMergePostGate,
  finalizeStagedMerge,
  runGit,
  WORKFLOW_RUN_LOCK_FILE,
  type GitRunner,
} from './workflow-git';
import { applyNonInteractiveGitEnvToProcess } from './workflow-git-env';
import {
  openCloserSession,
  finalizeWorkflow as closerFinalize,
  mergeSprintsOrdered,
  type CloserEngineDeps,
  type CloserSpawnContext,
  type SprintMergeTarget,
  type OrderedMergeReport,
} from './workflow-closer';
import {
  classifyFailureByRuntime,
  decideRetry,
  DEFAULT_RETRY_POLICY,
  type FailureClassificationInput,
  type WorkflowFailureRuntime,
} from './workflow-failure';
import {
  DYNAMIC_WORKFLOW_FAILURE_CLASSES,
  DYNAMIC_WORKFLOW_AGENT_DENYLIST,
  CC_DELIVERY_GATE_ID,
  AGENT_SWITCH_MESSAGE_KIND,
  boundaryGateId,
  isBoundaryGateId,
  isFailureGateId,
  failureGateId,
  nodeIdOfFailureGate,
  type FailureGateAction,
} from './types';
import { assessBoundary, eventsSince, findWindowStartSeq } from './workflow-outcome';

export const COORDINATOR_VALUE_DIGEST_MAX_CHARS = 2_000;

export function digestCoordinatorValue(value: unknown): {
  value: string | null;
  valueTruncated: boolean;
  valueChars: number;
} {
  if (value === undefined || value === null) return { value: null, valueTruncated: false, valueChars: 0 };
  let serialized: string;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  const truncated = serialized.length > COORDINATOR_VALUE_DIGEST_MAX_CHARS;
  return {
    value: truncated ? `${serialized.slice(0, COORDINATOR_VALUE_DIGEST_MAX_CHARS - 3)}...` : serialized,
    valueTruncated: truncated,
    valueChars: serialized.length,
  };
}
import type { DynamicWorkflowFailureClass, DynamicWorkflowRetryPolicy } from './types';

const logger = createLogger('dynamic-workflow-runner');


const STALL_WATCHDOG_FLOOR_MS = 3 * 60 * 1000;

const STALL_WATCHDOG_GRACE_MS = 60 * 1000;

export function stallDelayFor(nodeTimeoutMs: number | undefined): number {
  const t =
    typeof nodeTimeoutMs === 'number' && Number.isFinite(nodeTimeoutMs) && nodeTimeoutMs > 0
      ? nodeTimeoutMs
      : 0;
  return Math.max(STALL_WATCHDOG_FLOOR_MS, t > 0 ? t + STALL_WATCHDOG_GRACE_MS : 0);
}


const activeRunLocks = new Set<string>();

function acquireRunLock(runId: string): boolean {
  if (activeRunLocks.has(runId)) return false;
  activeRunLocks.add(runId);
  return true;
}

function releaseRunLock(runId: string): void {
  activeRunLocks.delete(runId);
}

export function isWorkflowRunLocked(runId: string): boolean {
  return activeRunLocks.has(runId);
}

export function _resetRunLocksForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error('_resetRunLocksForTesting so pode ser chamado em ambiente de teste');
  }
  activeRunLocks.clear();
}


export const IN_PROGRESS_RUN_STATUSES: readonly DynamicWorkflowRunStatus[] = [
  'running',
  'blocked',
  'paused',
  'interrupted',
] as const;

export function assertNoOtherActiveRun(
  selfRunId: string,
  listRunsByStatus: (status: DynamicWorkflowRunStatus) => DynamicWorkflowRun[],
): string | null {
  for (const status of IN_PROGRESS_RUN_STATUSES) {
    for (const other of listRunsByStatus(status)) {
      if (other.id !== selfRunId) {
        return (
          `single-active-run: ja existe um workflow ativo ("${other.id}", status "${other.status}"). ` +
          'Um workflow por vez - conclua, entregue ou aborte o run atual antes de iniciar outro.'
        );
      }
    }
  }
  return null;
}


export interface WorkflowRunnerCrud {
  getRun: (runId: string) => DynamicWorkflowRun | null;
  getDefinition: (definitionId: string) => DynamicWorkflowDefinition | null;
  listRunsByStatus: (status: DynamicWorkflowRunStatus) => DynamicWorkflowRun[];
  setRunStatus: (runId: string, status: DynamicWorkflowRunStatus) => void;
  updateRun: (runId: string, patch: DynamicWorkflowRunPatch) => void;
  upsertNodeRun: (input: DynamicWorkflowNodeRunUpsertInput) => DynamicWorkflowNodeRun;
  updateNodeRun: (id: string, patch: DynamicWorkflowNodeRunPatch) => void;
  listNodeRuns: (runId: string) => DynamicWorkflowNodeRun[];
  insertEvent: (input: DynamicWorkflowEventInsertInput) => DynamicWorkflowEvent;
  recentEvents: (runId: string, limit: number) => DynamicWorkflowEvent[];
  listEventsSince?: (runId: string, afterSeq: number) => DynamicWorkflowEvent[];
  insertGateDecision: (
    input: DynamicWorkflowGateDecisionInsertInput,
  ) => DynamicWorkflowGateDecision;
  registerArtifact: (
    input: DynamicWorkflowArtifactInsertInput,
  ) => DynamicWorkflowArtifact;
  insertMessage: (input: DynamicWorkflowMessageInsertInput) => DynamicWorkflowMessage;
  listMessages: (runId: string) => DynamicWorkflowMessage[];
  costAggregate: (runId: string) => DynamicWorkflowRunCostAggregate;
  createNodes?: (definitionId: string, nodes: DynamicWorkflowNodeCreateInput[]) => void;
  updateDefinition?: (definitionId: string, patch: DynamicWorkflowDefinitionPatch) => void;
  persistSprints?: (sprints: DynamicWorkflowSprintUpsertInput[]) => void;
  setNodeSprintMeta?: (
    definitionId: string,
    nodeId: string,
    patch: DynamicWorkflowNodeSprintPatch,
  ) => void;
  materializeSprintPlan?: (input: MaterializeDynamicWorkflowSprintPlanInput) => void;
  getPriorMaterialization?: (
    runId: string,
    definitionId: string,
  ) => DynamicWorkflowPriorMaterialization | null;
  updateSprintMerge?: (
    runId: string,
    sprintId: string,
    patch: DynamicWorkflowSprintPatch,
  ) => void;
  listSprints?: (runId: string) => DynamicWorkflowSprintRow[];
  appendJournalEntry?: (input: DynamicWorkflowJournalAppendInput) => void;
  listJournalEntries?: (runId: string) => DynamicWorkflowJournalEntry[];
  truncateJournalFrom?: (runId: string, fromIndex: number) => void;
  claimAdjustmentsForNode?: (runId: string, nodeId: string) => DynamicWorkflowMessage[];
  getConsumedAdjustmentsForNode?: (runId: string, nodeId: string) => DynamicWorkflowMessage[];
}

export interface WorkflowRunnerDeps {
  crud: WorkflowRunnerCrud;
  getWallTimeoutMs?: () => number | undefined;
  quiesceTimeoutMs?: number;
  sleep?: HostApiDeps['sleep'];
  sandboxFactory?: SandboxProcessFactory;
  git?: GitRunner;
  emitIPC?: (channel: string, payload: unknown) => void;
  appendJsonl?: (runId: string, line: string) => void;
  closerDeps?: Partial<CloserEngineDeps>;
  runNodeAgent?: typeof runNodeAgent;
  adapterDeps?: WorkflowAdapterDeps;
  runGateCommand?: CommandRunner;
  sandboxChildEntry?: () => string;
  now?: () => string;
  generateId?: (prefix: string) => string;
  scheduleTimer?: (delayMs: number, cb: () => void) => WorkflowTimerHandle;
  resolvePolicyHashForNode?: (input: {
    runId: string;
    nodeId: string;
    manifest: DynamicWorkflowManifest;
    definition: DynamicWorkflowDefinition;
  }) => string | null;
  validateSwitchAgent?: (input: {
    nodeId: string;
    newAgentId: string;
    manifest: DynamicWorkflowManifest;
  }) => SwitchAgentValidation;
  persistSwitchedDefinition?: (input: {
    prevDefinition: DynamicWorkflowDefinition;
    nodeId: string;
    newAgentId: string;
  }) => { newDefinitionId: string };
  narratorDeps?: WorkflowNarratorDeps;
  loadActiveAgentIds?: () => string[];
  resolveAgentAxes?: HostApiRunContext['resolveAgentAxes'];
  materializeEditedPackage?: (input: {
    projectPath: string;
    revisionId: string;
    workflowJsSource: string;
    manifestJson: string;
    currentWorkflowJsPath?: string;
  }) => {
    workflowJsPath: string;
    manifestPath: string;
    manifestJson: string;
    manifestHash: string;
    schemaPaths: string[];
  };
  createEditedDefinition?: (input: {
    prevDefinition: DynamicWorkflowDefinition;
    revisionId: string;
    workflowJsPath: string;
    manifestPath: string;
    manifestJson: string;
    manifestHash: string;
  }) => { newDefinitionId: string };
  repointRunDefinition?: (runId: string, definitionId: string) => void;
}

export interface WorkflowTimerHandle {
  cancel: () => void;
}

export type ResumeOptions = DynamicWorkflowResumeOptions;

export interface SwitchAgentValidation {
  exists: boolean;
  preflightOk: boolean;
  expandsPermission: boolean;
  reason?: string;
}

export interface EditCoordinatorInput {
  workflowJsSource: string;
  reason: string;
}

export type EditCoordinatorResult =
  | {
      ok: true;
      newDefinitionId: string;
      revisionId: string;
      manifestHash: string;
    }
  | { ok: false; error: string };


export type RunnerResult = { ok: true } | { error: string };

const QUIESCENT_EVENT_TYPES = new Set<string>([
  'run-paused',
  'run-blocked-snapshot',
  'run-aborted',
  'run-failed',
]);

export const RERUN_QUIESCE_TIMEOUT_MS = 60_000;

function ok(): RunnerResult {
  return { ok: true };
}
function err(message: string): RunnerResult {
  return { error: message };
}


function defaultNow(): string {
  return new Date().toISOString();
}
function defaultGenerateId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function defaultScheduleTimer(delayMs: number, cb: () => void): WorkflowTimerHandle {
  const handle = setTimeout(cb, Math.max(0, delayMs));
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    (handle as { unref: () => void }).unref();
  }
  return { cancel: () => clearTimeout(handle) };
}


interface ActiveRunState {
  runId: string;
  abortController: AbortController;
  gateResolvers: Map<string, (resolution: PendingGateResolution) => void>;
  boundaryGateAtCompletion?: boolean;
  stopReason: 'pause' | 'abort' | null;
  nodeAborts: Map<string, AbortController>;
  workspace: WorkspaceHandle | null;
  manifest: DynamicWorkflowManifest;
  definition: DynamicWorkflowDefinition;
  touchedFiles: Set<string>;
  sprintWorktrees: Map<number, SprintWorktreeHandle>;
  gitTransientPaths: string[];
}


export class WorkflowRunner {
  private readonly deps: WorkflowRunnerDeps;
  private readonly now: () => string;
  private readonly generateId: (prefix: string) => string;
  private readonly active = new Map<string, ActiveRunState>();
  private readonly quiesceWaiters = new Map<string, Set<(eventType: string) => void>>();
  private readonly gateInbox = new Map<string, PendingGateResolution>();
  private readonly scheduleTimer: (delayMs: number, cb: () => void) => WorkflowTimerHandle;
  private readonly pendingTimers = new Map<string, WorkflowTimerHandle>();
  private readonly stallTimers = new Map<string, WorkflowTimerHandle>();
  private readonly bundleCache = new Map<
    string,
    {
      protectedPaths: string[];
      baselineMaxErrorsByCommand: Record<string, number>;
      agentCatalog: Array<{ id: string; name: string; description?: string }>;
      hasBuildScript: boolean;
    } | null
  >();
  private readonly narrator: WorkflowNarrator | null;
  private readonly nodeStreamExcerpt = new Map<string, string>();

  constructor(deps: WorkflowRunnerDeps) {
    this.deps = deps;
    this.now = deps.now ?? defaultNow;
    this.generateId = deps.generateId ?? defaultGenerateId;
    this.scheduleTimer = deps.scheduleTimer ?? defaultScheduleTimer;
    this.narrator = deps.narratorDeps ? new WorkflowNarrator(deps.narratorDeps) : null;
  }


  private eventsDeps(): WorkflowEventsDeps {
    return {
      insertEvent: this.deps.crud.insertEvent,
      emit: this.deps.emitIPC ?? (() => {}),
      appendJsonl: this.deps.appendJsonl,
    };
  }

  private emit(input: {
    runId: string;
    type: string;
    nodeId?: string | null;
    phaseId?: string | null;
    payload?: unknown;
  }): void {
    emitWorkflowEvent(this.eventsDeps(), input);
    if (QUIESCENT_EVENT_TYPES.has(input.type)) {
      const waiters = this.quiesceWaiters.get(input.runId);
      if (waiters) for (const w of waiters) w(input.type);
    }
    this.syncStallWatchdogFromEvent(
      input.runId,
      input.type,
      input.nodeId ?? null,
      input.payload,
    );
    this.feedNarrator(input.runId, input.type, input.nodeId ?? null, input.payload);
  }

  private feedNarrator(
    runId: string,
    eventType: string,
    nodeId: string | null,
    payload: unknown,
  ): void {
    const narrator = this.narrator;
    if (!narrator || !narrator.enabled) return;
    try {
      if (!narrator.shouldNarrate(runId, eventType)) return;
      const state = this.active.get(runId);
      const abortSignal = state?.abortController.signal ?? new AbortController().signal;
      let agentId: string | null = null;
      let phaseId: string | null = null;
      if (payload && typeof payload === 'object') {
        const p = payload as { agentId?: unknown; phaseId?: unknown };
        if (typeof p.agentId === 'string') agentId = p.agentId;
        if (typeof p.phaseId === 'string') phaseId = p.phaseId;
      }
      const run = this.deps.crud.getRun(runId);
      if (!phaseId) phaseId = run?.currentPhaseId ?? null;
      const recentEvents = (() => {
        try {
          return this.deps.crud.recentEvents(runId, 8);
        } catch {
          return [];
        }
      })();
      void narrator.narrateMark(
        {
          runId,
          eventType,
          phaseId,
          nodeId,
          agentId,
          recentEvents,
          nodeStreamExcerpt: this.nodeStreamExcerpt.get(runId) ?? null,
        },
        abortSignal,
      );
    } catch {
    }
  }

  private captureNodeStreamExcerpt(
    runId: string,
    type: string,
    content: string | undefined,
  ): void {
    if (!this.narrator || type !== 'text' || !content) return;
    const MAX = 1200;
    const prev = this.nodeStreamExcerpt.get(runId) ?? '';
    const next = (prev + content).slice(-MAX);
    this.nodeStreamExcerpt.set(runId, next);
  }

  private forgetNarratorState(runId: string): void {
    this.nodeStreamExcerpt.delete(runId);
    this.narrator?.forget(runId);
  }

  private syncStallWatchdogFromEvent(
    runId: string,
    type: string,
    nodeId: string | null,
    payload?: unknown,
  ): void {
    if (type === 'node-started' && nodeId) {
      const nodeTimeoutMs =
        payload && typeof payload === 'object' && 'timeoutMs' in payload
          ? (payload as { timeoutMs?: unknown }).timeoutMs
          : undefined;
      this.startStallWatchdog(
        runId,
        nodeId,
        typeof nodeTimeoutMs === 'number' ? nodeTimeoutMs : undefined,
      );
      return;
    }
    if (
      type === 'node-completed' ||
      type === 'node-failed' ||
      type === 'node-cache-hit'
    ) {
      this.cancelStallWatchdog(runId);
    }
  }


  async start(runId: string): Promise<RunnerResult> {
    const run = this.deps.crud.getRun(runId);
    if (!run) return err(`run nao encontrado: ${runId}`);
    if (run.status === 'running') {
      logger.warn({ runId }, 'start de run ja running (no-op idempotente)');
      return ok();
    }
    if (run.status === 'delivered') {
      return err(`run ${runId} ja entregue (fase de fechamento); use finalize/closer, nao start`);
    }
    if (run.status === 'completed' || run.status === 'aborted') {
      return err(`run ${runId} esta em estado terminal (${run.status})`);
    }

    const otherActive = assertNoOtherActiveRun(runId, this.deps.crud.listRunsByStatus);
    if (otherActive) {
      return err(otherActive);
    }

    if (!acquireRunLock(runId)) {
      return err(`run ${runId} ja esta em execucao (lock ativo)`);
    }

    applyNonInteractiveGitEnvToProcess();

    const definition = this.deps.crud.getDefinition(run.definitionId);
    if (!definition) {
      releaseRunLock(runId);
      return err(`definition nao encontrada: ${run.definitionId}`);
    }

    let manifest: DynamicWorkflowManifest;
    let transformedSource: string;
    try {
      manifest = JSON.parse(definition.manifestJson) as DynamicWorkflowManifest;
      const source = readFileSync(definition.workflowJsPath, 'utf8');
      const compiled = compileWorkflowJs(source);
      if (!compiled.ok) {
        releaseRunLock(runId);
        const reason = compiled.errors.map((e) => e.message).join('; ');
        this.failRun(runId, `workflow.js invalido na revalidacao: ${reason}`);
        return err(`workflow.js invalido: ${reason}`);
      }
      transformedSource = compiled.transformedSource;
    } catch (e) {
      releaseRunLock(runId);
      const message = e instanceof Error ? e.message : String(e);
      this.failRun(runId, `falha ao carregar/compilar workflow.js: ${message}`);
      return err(message);
    }

    let workspace: WorkspaceHandle;
    try {
      const probe = await probeProjectState(definition.projectPath, this.deps.git ?? runGit);
      workspace = await prepareWorkspace(
        { runId, projectPath: definition.projectPath, probe },
        this.deps.git ?? runGit,
      );
    } catch (e) {
      releaseRunLock(runId);
      const message = e instanceof Error ? e.message : String(e);
      this.failRun(runId, `falha ao preparar o workspace: ${message}`);
      return err(message);
    }

    try {
      this.ensureSpecInWorkspace(definition, workspace);
    } catch (e) {
      releaseRunLock(runId);
      const message = e instanceof Error ? e.message : String(e);
      this.failRun(runId, message);
      return err(message);
    }

    this.deps.crud.updateRun(runId, {
      status: 'running',
      workspaceMode: workspace.mode,
      baseBranch: workspace.baseBranch,
      baseCommitSha: workspace.baseCommitSha,
      baseWorktreeHash: workspace.baseWorktreeHash,
      worktreePath: workspace.worktreePath,
      worktreeBranch: workspace.worktreeBranch,
      startedAt: run.startedAt ?? this.now(),
    });

    const state: ActiveRunState = {
      runId,
      abortController: new AbortController(),
      gateResolvers: new Map(),
      nodeAborts: new Map(),
      stopReason: null,
      workspace,
      manifest,
      definition,
      touchedFiles: new Set<string>(),
      sprintWorktrees: new Map<number, SprintWorktreeHandle>(),
      gitTransientPaths: await this.computeGitTransientPaths(definition, workspace),
    };
    this.hydrateSprintWorktrees(state);
    this.active.set(runId, state);

    this.emit({ runId, type: 'run-started', payload: { mode: workspace.mode } });

    void this.execute(state, transformedSource).finally(() => {
      const current = this.deps.crud.getRun(runId);
      const status = current?.status;
      if (status === 'blocked') {
        if (current && this.parsePendingGate(current)) {
          this.active.delete(runId);
          releaseRunLock(runId);
          this.forgetNarratorState(runId);
        }
        return;
      }
      if (
        status === 'completed' ||
        status === 'delivered' ||
        status === 'aborted' ||
        status === 'failed' ||
        status === 'paused' ||
        status === 'interrupted'
      ) {
        this.active.delete(runId);
        releaseRunLock(runId);
        this.forgetNarratorState(runId);
      }
    });

    return ok();
  }

  private async execute(state: ActiveRunState, transformedSource: string): Promise<void> {
    const { runId, manifest, workspace } = state;
    const runDir = this.runDirOf(state.definition.projectPath, runId);

    const hostCtx: HostApiRunContext = {
      runId,
      manifest,
      resolveAgentAxes: this.deps.resolveAgentAxes,
      definitionId: state.definition.id,
      projectPath: state.definition.projectPath,
      sprintPlanConfig: this.readSprintPlanConfig(state),
      priorMaterialized:
        this.deps.crud.getPriorMaterialization?.(runId, state.definition.id) ??
        undefined,
      catalogAgentIds: this.deps.loadActiveAgentIds?.(),
      schemaFileNames: this.schemaFileNamesForRun(state.definition),
      buildSprintNodes: (plan, cfg) =>
        buildDevSprintNodes(plan, cfg, this.generateId),
      resolveSchemaRef: (schemaRef) =>
        this.resolveSchemaRefForRun(state.definition, schemaRef),
      workspaceRoot: workspace?.workspaceDir ?? state.definition.projectPath,
      resolveSprintCwd: (sprintIndex) => this.resolveSprintCwd(state, sprintIndex),
      prepareSprintWorktrees: async (sprintIndexes) => {
        for (const idx of sprintIndexes) {
          await this.ensureSprintWorktree(state, idx);
        }
      },
      runDir,
      readNodeCheckpoint: (nodeId) => readNodeCheckpoint(runDir, nodeId),
      workflowRevision: state.definition.manifestHash,
      protectedPaths: this.loadBundleProtectedPaths(state.definition),
      hasBuildScript: this.loadBundle(state.definition)?.hasBuildScript ?? false,
      abortSignal: state.abortController.signal,
      resolveGateChecks: (checks) =>
        resolveGateChecks(checks, this.buildGateResolutionContext(state)),
      onFinalGateApproved: (gateId, approvedBy) =>
        this.handleFinalGateApproved(state, gateId, approvedBy),
      onWriterNodeCompleted: (input) => this.commitWriterNode(state, input),
      onNodeFailed: (input) => this.handleNodeFailed(state, input),
      onWriterNodeFailed: (input) => this.commitFailedWriterWip(state, input),
      onNodeSkipped: (input) => this.resetAfterSkip(state, input),
      registerNodeAbort: (nodeId, _attempt, controller) => {
        state.nodeAborts.set(nodeId, controller);
        return () => {
          if (state.nodeAborts.get(nodeId) === controller) state.nodeAborts.delete(nodeId);
        };
      },
    };

    const gateGate: GateGate = {
      awaitDecision: (gateId, _mode) => {
        const inboxKey = `${state.runId}::${gateId}`;
        const preRecorded = this.gateInbox.get(inboxKey);
        if (preRecorded) {
          this.gateInbox.delete(inboxKey);
          this.emit({ runId: state.runId, type: 'gate-orphan-resolved', payload: { gateId } });
          return Promise.resolve(preRecorded);
        }
        return new Promise<PendingGateResolution>((resolve) => {
          state.gateResolvers.set(gateId, resolve);
        });
      },
      discardStaleGate: (gateId) => this.discardStaleBoundaryGate(state.runId, gateId),
    };

    const hostDeps: HostApiDeps = {
      crud: this.hostCrud(),
      gateGate,
      emit: (input) => this.emit(input),
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      emitStreamChunk: (chunk) => {
        this.captureNodeStreamExcerpt(chunk.runId, chunk.type, chunk.content);
        broadcastWorkflowStreamChunk({ emit: this.deps.emitIPC ?? (() => {}) }, chunk);
      },
      now: this.now,
      generateId: this.generateId,
    };
    if (this.deps.runNodeAgent) hostDeps.runNodeAgent = this.deps.runNodeAgent;
    if (this.deps.adapterDeps) hostDeps.adapterDeps = this.deps.adapterDeps;
    const hostApi = createWorkflowHostApi(hostCtx, hostDeps);

    const handlers: WorkflowSandboxHandlers = {
      phase: hostApi.phase,
      agent: hostApi.agent,
      parallel: hostApi.parallel,
      pipeline: hostApi.pipeline,
      gate: hostApi.gate,
      artifact: hostApi.artifact,
      checkpoint: hostApi.checkpoint,
      log: hostApi.log,
      validateSprintPlan: hostApi.validateSprintPlan,
      materializeSprintPlan: hostApi.materializeSprintPlan,
      greenCheck: hostApi.greenCheck,
    };

    const ctxState = this.readRunCtxState(state);

    const sprintPlanCfg = this.readSprintPlanConfig(state);

    const agentCatalog = this.loadBundleAgentCatalog(state.definition);

    const wallTimeoutMs = this.resolveWallTimeoutMs();

    let result;
    try {
      result = await runWorkflowSandbox({
        transformedSource,
        input: ctxState.input,
        maxPlanRounds: sprintPlanCfg.maxPlanRounds,
        maxDevRounds: sprintPlanCfg.maxDevRounds,
        agentCatalog,
        ...(wallTimeoutMs !== undefined ? { wallTimeoutMs } : {}),
        idleTimeoutMs: this.idleTimeoutMs(),
        factory: this.deps.sandboxFactory ?? this.defaultFactory(),
        handlers,
        onLifecycle: (ev) => {
          if (ev.type === 'killed') {
            this.emit({ runId, type: 'sandbox-killed', payload: { reason: ev.reason } });
          }
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.failRun(runId, `sandbox lancou inesperadamente: ${message}`);
      return;
    }

    await this.handleSandboxResult(state, result);
  }

  private async handleSandboxResult(
    state: ActiveRunState,
    result: { status: 'completed'; value: unknown } | { status: 'failed'; reason: string; message: string },
  ): Promise<void> {
    const { runId } = state;
    const current = this.deps.crud.getRun(runId);
    if (!current) return;

    if (this.pendingTimers.has(runId)) {
      this.active.delete(runId);
      releaseRunLock(runId);
      this.emit({ runId, type: 'run-retry-pending-snapshot', payload: { status: current.status } });
      return;
    }

    if (result.status === 'completed') {
      if (current.status === 'delivered' || current.status === 'completed') {
        this.emit({ runId, type: 'run-finished', payload: { value: result.value } });
        return;
      }
      if (state.stopReason === 'pause') {
        await this.commitInterruptWip(state);
        this.deps.crud.updateRun(runId, { status: 'paused' });
        this.emit({ runId, type: 'run-paused', payload: {} });
        return;
      }
      if (state.stopReason === 'abort') {
        await this.commitInterruptWip(state);
        this.deps.crud.updateRun(runId, { status: 'aborted', completedAt: this.now() });
        this.emit({ runId, type: 'run-aborted', payload: {} });
        return;
      }
      if (current.status === 'blocked') {
        this.emit({ runId, type: 'run-blocked-snapshot', payload: {} });
        return;
      }
      this.emit({ runId, type: 'coordinator-finished', payload: digestCoordinatorValue(result.value) });
      const boundary = await this.awaitCompletionBoundaryIfNotGreen(state);
      if (boundary === 'paused') return;
      if (this.shouldInjectCcDeliveryGate(state, result.value)) {
        await this.runCcDeliveryGate(state, result.value);
        return;
      }
      this.deps.crud.updateRun(runId, {
        status: 'delivered',
        deliveredAt: this.now(),
        outputJson: safeJson(result.value),
        completedAt: null,
      });
      this.emit({ runId, type: 'run-delivered', payload: { value: result.value } });
      await this.autoOpenCloser(state, 'delivery', 'Entrega concluida (checks). Walkthrough da entrega.');
      this.autoFinalizeAfterDelivery(runId);
      return;
    }

    if (state.stopReason === 'abort') {
      await this.commitInterruptWip(state);
      this.deps.crud.updateRun(runId, { status: 'aborted', completedAt: this.now() });
      this.emit({ runId, type: 'run-aborted', payload: {} });
      return;
    }
    if (state.stopReason === 'pause') {
      await this.commitInterruptWip(state);
      const run = this.deps.crud.getRun(runId);
      const pendingGate = run ? this.parsePendingGate(run) : null;
      const staleBoundary = pendingGate !== null && isBoundaryGateId(pendingGate.id);
      this.deps.crud.updateRun(runId, {
        status: 'paused',
        ...(staleBoundary ? { inputJson: this.clearPendingDecision(runId) } : {}),
      });
      this.emit({ runId, type: 'run-paused', payload: {} });
      return;
    }

    const reloaded = this.deps.crud.getRun(runId);
    if (reloaded?.status === 'blocked') {
      this.emit({ runId, type: 'run-blocked-snapshot', payload: { reason: result.reason } });
      return;
    }

    await this.commitInterruptWip(state);
    this.failRun(runId, `execucao falhou (${result.reason}): ${result.message}`);
  }


  private async awaitCompletionBoundaryIfNotGreen(
    state: ActiveRunState,
  ): Promise<'continue' | 'paused'> {
    const { runId } = state;
    const listEventsSince = this.deps.crud.listEventsSince;
    if (!listEventsSince) return 'continue';
    let windowEvents: DynamicWorkflowEvent[];
    let history: DynamicWorkflowEvent[];
    try {
      history = listEventsSince(runId, 0);
      windowEvents = eventsSince(history, findWindowStartSeq(history));
    } catch (err) {
      logger.warn({ err, runId }, 'fronteira final: leitura de eventos falhou (sem gate)');
      return 'continue';
    }
    const assessment = assessBoundary(windowEvents, { history });
    const gateId = boundaryGateId('coordinator-finished');
    if (assessment.since.nodes === 0 || assessment.semaphore === 'VERDE') {
      this.discardStaleBoundaryGate(runId, gateId);
      return 'continue';
    }
    const mode: 'orchestrator' = 'orchestrator';

    const inboxKey = `${runId}::${gateId}`;
    const preRecorded = this.gateInbox.get(inboxKey);
    let resolution: PendingGateResolution;
    if (preRecorded) {
      this.gateInbox.delete(inboxKey);
      this.emit({ runId, type: 'gate-orphan-resolved', payload: { gateId } });
      resolution = preRecorded;
    } else {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(this.deps.crud.getRun(runId)?.inputJson || '{}') as Record<string, unknown>;
      } catch {
        input = {};
      }
      input.pendingDecision = {
        type: 'gate',
        id: gateId,
        prompt: `fronteira final com SEMAFORO: ${assessment.semaphore} (${assessment.reasons.join('; ')}) aguardando decisao do orquestrador`,
      };
      this.deps.crud.updateRun(runId, { status: 'blocked', inputJson: JSON.stringify(input) });
      this.emit({
        runId,
        type: 'gate-blocked',
        payload: {
          gateId,
          mode,
          boundary: 'coordinator-finished',
          semaphore: assessment.semaphore,
          reasons: assessment.reasons,
          openP1: assessment.openP1.length,
        },
      });
      state.boundaryGateAtCompletion = true;
      try {
        resolution = await new Promise<PendingGateResolution>((resolve) => {
          state.gateResolvers.set(gateId, resolve);
        });
      } finally {
        state.boundaryGateAtCompletion = false;
      }
    }

    this.deps.crud.insertGateDecision({
      id: this.generateId('dwfg'),
      runId,
      gateId,
      mode,
      decision: resolution.decision === 'approve' ? 'approved' : 'rejected',
      decidedBy: resolution.approvedBy,
      reason: resolution.reason ?? null,
      payloadJson: JSON.stringify({ semaphore: assessment.semaphore, reasons: assessment.reasons }),
    });

    if (state.stopReason === 'abort') {
      await this.commitInterruptWip(state);
      this.deps.crud.updateRun(runId, { status: 'aborted', completedAt: this.now() });
      this.emit({ runId, type: 'run-aborted', payload: { gateId } });
      return 'paused';
    }
    if (state.stopReason === 'pause' || resolution.decision === 'reject') {
      this.deps.crud.updateRun(runId, {
        status: 'paused',
        inputJson: this.clearPendingDecision(runId),
      });
      this.emit({
        runId,
        type: resolution.decision === 'reject' ? 'gate-rejected' : 'run-paused',
        payload: { gateId, decidedBy: resolution.approvedBy },
      });
      if (resolution.decision === 'reject') this.emit({ runId, type: 'run-paused', payload: { gateId } });
      return 'paused';
    }

    this.deps.crud.updateRun(runId, { status: 'running', inputJson: this.clearPendingDecision(runId) });
    this.emit({
      runId,
      type: 'gate-approved',
      payload: { gateId, approvedBy: resolution.approvedBy, semaphore: assessment.semaphore },
    });
    return 'continue';
  }


  private shouldInjectCcDeliveryGate(state: ActiveRunState, _value: unknown): boolean {
    return this.ccRunWroteCode(state);
  }

  private ccRunWroteCode(state: ActiveRunState): boolean {
    if (state.touchedFiles.size > 0) return true;
    const workspace = state.workspace;
    if (!workspace) return false;
    const lastSha = this.lastNodeCommitSha(state.runId);
    const baseSha = workspace.baseCommitSha;
    return !!lastSha && !!baseSha && lastSha !== baseSha;
  }

  private async runCcDeliveryGate(state: ActiveRunState, value: unknown): Promise<void> {
    const { runId } = state;
    const gateId = CC_DELIVERY_GATE_ID;
    const mode: 'orchestrator' | 'human' = 'orchestrator';

    const inboxKey = `${runId}::${gateId}`;
    const preRecorded = this.gateInbox.get(inboxKey);
    if (preRecorded) {
      this.gateInbox.delete(inboxKey);
      this.emit({ runId, type: 'gate-orphan-resolved', payload: { gateId } });
      await this.applyCcDeliveryDecision(state, value, mode, preRecorded);
      return;
    }

    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(this.deps.crud.getRun(runId)?.inputJson || '{}') as Record<string, unknown>;
    } catch {
      input = {};
    }
    input.pendingDecision = {
      type: 'gate',
      id: gateId,
      prompt: `gate '${gateId}' aguardando aprovacao do orquestrador (entrega/merge)`,
    };
    this.deps.crud.updateRun(runId, { status: 'blocked', inputJson: JSON.stringify(input) });
    this.emit({ runId, type: 'gate-blocked', payload: { gateId, mode } });

    const resolution = await new Promise<PendingGateResolution>((resolve) => {
      state.gateResolvers.set(gateId, resolve);
    });
    await this.applyCcDeliveryDecision(state, value, mode, resolution);
  }

  private async applyCcDeliveryDecision(
    state: ActiveRunState,
    _value: unknown,
    mode: 'orchestrator' | 'human',
    resolution: PendingGateResolution,
  ): Promise<void> {
    const { runId } = state;
    const gateId = CC_DELIVERY_GATE_ID;

    if (state.stopReason === 'abort') {
      this.deps.crud.updateRun(runId, { status: 'aborted', completedAt: this.now() });
      this.emit({ runId, type: 'run-aborted', payload: { gateId } });
      return;
    }
    if (state.stopReason === 'pause') {
      this.deps.crud.updateRun(runId, { status: 'paused' });
      this.emit({ runId, type: 'run-paused', payload: { gateId } });
      return;
    }

    const decisionAction =
      resolution.payload && typeof resolution.payload['action'] === 'string'
        ? (resolution.payload['action'] as string)
        : null;
    const isRedev = decisionAction === 'redev' || decisionAction === 'replan';

    this.deps.crud.insertGateDecision({
      id: this.generateId('dwfg'),
      runId,
      gateId,
      mode,
      decision: resolution.decision === 'approve' ? 'approved' : 'rejected',
      decidedBy: resolution.approvedBy,
      reason: resolution.reason ?? null,
      payloadJson: JSON.stringify(resolution.payload ?? {}),
    });

    if (resolution.decision === 'reject' && !isRedev) {
      this.emit({ runId, type: 'gate-rejected', payload: { gateId, decidedBy: resolution.approvedBy } });
      logger.info(
        { runId, gateId, decidedBy: resolution.approvedBy },
        'gate de entrega sintetico REJEITADO sem redev: worktree preservada, run aguardando (recuperavel)',
      );
      return;
    }

    if (isRedev) {
      this.deps.crud.updateRun(runId, { status: 'running', inputJson: this.clearPendingDecision(runId) });
      this.emit({ runId, type: 'gate-redev-requested', payload: { gateId, decidedBy: resolution.approvedBy } });
      return;
    }

    this.deps.crud.updateRun(runId, { status: 'running', inputJson: this.clearPendingDecision(runId) });
    this.emit({ runId, type: 'gate-approved', payload: { gateId, approvedBy: resolution.approvedBy } });
    await this.handleFinalGateApproved(state, gateId, resolution.approvedBy);
  }

  private clearPendingDecision(runId: string): string {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(this.deps.crud.getRun(runId)?.inputJson || '{}') as Record<string, unknown>;
    } catch {
      input = {};
    }
    delete input.pendingDecision;
    return JSON.stringify(input);
  }

  private discardStaleBoundaryGate(runId: string, gateId: string): void {
    if (!isBoundaryGateId(gateId)) return;
    const inboxKey = `${runId}::${gateId}`;
    const hadInbox = this.gateInbox.delete(inboxKey);
    const run = this.deps.crud.getRun(runId);
    const pending = run ? this.parsePendingGate(run) : null;
    const hadPending = pending?.id === gateId;
    if (hadPending) {
      this.deps.crud.updateRun(runId, { inputJson: this.clearPendingDecision(runId) });
    }
    if (hadInbox || hadPending) {
      this.emit({ runId, type: 'gate-orphan-discarded', payload: { gateId, hadInbox, hadPending } });
    }
  }


  private resolveProjectSpec(
    definition: DynamicWorkflowDefinition,
  ): { specAbs: string; rel: string } | null {
    const specPath = definition.specPath;
    if (!specPath) return null;
    const projectPath = definition.projectPath;
    const specAbs = isAbsolute(specPath) ? specPath : join(projectPath, specPath);
    const rel = relative(resolve(projectPath), resolve(specAbs));
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return { specAbs, rel };
  }

  private copySpecIntoWorktree(
    definition: DynamicWorkflowDefinition,
    worktreePath: string,
  ): void {
    const spec = this.resolveProjectSpec(definition);
    if (!spec) return;
    const target = join(worktreePath, spec.rel);
    if (!existsSync(target)) {
      if (!existsSync(spec.specAbs)) return;
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(spec.specAbs, target);
      logger.info(
        { worktreePath, specPath: definition.specPath, target },
        'SPEC untracked no HEAD copiada para a worktree (preflight D9)',
      );
    }
  }

  private async computeGitTransientPaths(
    definition: DynamicWorkflowDefinition,
    workspace: WorkspaceHandle,
  ): Promise<string[]> {
    const paths = [WORKFLOW_RUN_LOCK_FILE];
    if (workspace.mode !== 'run-worktree') return paths;
    const spec = this.resolveProjectSpec(definition);
    if (!spec) return paths;
    const rel = spec.rel.replace(/\\/g, '/');
    try {
      const git = this.deps.git ?? runGit;
      const revOk = await git(
        ['rev-parse', '--verify', '--quiet', `${workspace.baseCommitSha}^{commit}`],
        workspace.repoRoot,
      );
      if (revOk.code !== 0) {
        logger.warn(
          { specRel: rel, baseCommitSha: workspace.baseCommitSha, stderr: revOk.stderr },
          'baseCommitSha nao verificado; check de SPEC-na-base inconclusivo; SPEC NAO tratada como transitoria',
        );
        return paths;
      }
      const inBase = await git(
        ['cat-file', '-e', `${workspace.baseCommitSha}:${rel}`],
        workspace.repoRoot,
      );
      if (inBase.code !== 0) paths.push(rel);
    } catch (err) {
      logger.warn(
        { err, specRel: rel },
        'check de SPEC-na-base inconclusivo; SPEC NAO tratada como transitoria',
      );
    }
    return paths;
  }

  private ensureSpecInWorkspace(
    definition: DynamicWorkflowDefinition,
    workspace: WorkspaceHandle,
  ): void {
    if (workspace.mode !== 'run-worktree' || !workspace.worktreePath) return;
    const spec = this.resolveProjectSpec(definition);
    if (!spec) return;

    const target = join(workspace.worktreePath, spec.rel);
    if (!existsSync(target) && !existsSync(spec.specAbs)) {
      throw new Error(
        `SPEC nao encontrada: ${definition.specPath}. O arquivo nao existe no projeto nem na worktree do run - verifique o caminho ou recrie a SPEC antes de iniciar o run.`,
      );
    }
    this.copySpecIntoWorktree(definition, workspace.worktreePath);
  }

  private resolveSprintCwd(state: ActiveRunState, sprintIndex: number): string | null {
    if (!Number.isInteger(sprintIndex) || sprintIndex < 0) return null;
    if (state.workspace?.mode !== 'run-worktree') return null;
    const handle = state.sprintWorktrees.get(sprintIndex);
    return handle?.worktreePath ?? null;
  }

  private hydrateSprintWorktrees(state: ActiveRunState): void {
    if (state.workspace?.mode !== 'run-worktree') return;
    const list = this.deps.crud.listSprints?.(state.runId);
    if (!list) return;
    for (const row of list) {
      const idx = this.sprintIndexOf(row.sprintId);
      if (idx === null || !row.worktreePath || !row.branch || !row.baseSha) continue;
      state.sprintWorktrees.set(idx, {
        runId: state.runId,
        sprintIndex: idx,
        worktreePath: row.worktreePath,
        branch: row.branch,
        baseSha: row.baseSha,
        fellBackToTemp: false,
      });
    }
  }

  async ensureSprintWorktree(state: ActiveRunState, sprintIndex: number): Promise<SprintWorktreeHandle | null> {
    const workspace = state.workspace;
    if (!workspace || workspace.mode !== 'run-worktree') return null;
    if (!this.deps.crud.updateSprintMerge) return null;
    const existing = state.sprintWorktrees.get(sprintIndex);
    if (existing) return existing;

    const git = this.deps.git ?? runGit;
    try {
      const handle = await prepareSprintWorktree(
        {
          runId: state.runId,
          repoRoot: workspace.repoRoot,
          projectPath: state.definition.projectPath,
          sprintIndex,
          baseCommitSha: workspace.baseCommitSha,
        },
        git,
      );
      state.sprintWorktrees.set(sprintIndex, handle);
      this.copySpecIntoWorktree(state.definition, handle.worktreePath);
      this.deps.crud.updateSprintMerge(state.runId, `s${sprintIndex}`, {
        worktreePath: handle.worktreePath,
        branch: handle.branch,
        baseSha: handle.baseSha,
        mergeStatus: 'pending',
      });
      this.emit({
        runId: state.runId,
        type: 'sprint-worktree-ready',
        payload: { sprintIndex, branch: handle.branch, fellBackToTemp: handle.fellBackToTemp },
      });
      return handle;
    } catch (e) {
      logger.warn(
        { err: e, runId: state.runId, sprintIndex },
        'falha ao preparar worktree da sprint (degrada para sequencial)',
      );
      return null;
    }
  }

  async mergeSprintsForRun(
    state: ActiveRunState,
    gateId?: string,
  ): Promise<OrderedMergeReport | null> {
    const workspace = state.workspace;
    if (!workspace || workspace.mode !== 'run-worktree') return null;
    const updateSprintMerge = this.deps.crud.updateSprintMerge;
    const listSprints = this.deps.crud.listSprints;
    if (!updateSprintMerge || !listSprints) return null;

    const rows = listSprints(state.runId).filter((r) => r.branch && r.worktreePath);
    if (rows.length === 0) return null;

    const targets: SprintMergeTarget[] = rows
      .map((r) => {
        const idx = this.sprintIndexOf(r.sprintId);
        if (idx === null) return null;
        return {
          sprintId: r.sprintId,
          index: idx,
          branch: r.branch as string,
          baseSha: (r.baseSha as string | null) ?? workspace.baseCommitSha,
          worktreePath: r.worktreePath,
          deliverySummary: `entrega da sprint ${r.sprintId}`,
        } as SprintMergeTarget;
      })
      .filter((t): t is SprintMergeTarget => t !== null);

    return mergeSprintsOrdered(targets, {
      repoRoot: workspace.repoRoot,
      baseBranch: workspace.baseBranch,
      name: state.definition.name,
      runId: state.runId,
      transientPaths: state.gitTransientPaths,
      updateSprintMerge,
      emitEvent: (input) => this.emit({ runId: input.runId, type: input.type, payload: input.payload }),
      runStagedRechecks: gateId ? () => this.runStagedRechecks(state, gateId) : undefined,
      git: this.deps.git ?? runGit,
    });
  }

  private sprintIndexOf(sprintId: string): number | null {
    const m = /^s(\d+)$/.exec(sprintId);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }


  private async commitWriterNode(
    state: ActiveRunState,
    input: { nodeId: string; attempt: number; access: string; writeSet: string[] },
  ): Promise<{ sha: string; touchedFiles: string[] } | null> {
    const cwd = state.workspace?.workspaceDir;
    if (!cwd) return null;
    const git = this.deps.git ?? runGit;

    const prevSha = this.lastNodeCommitSha(state.runId);
    const commit = await commitNode(
      {
        runId: state.runId,
        nodeId: input.nodeId,
        attempt: input.attempt,
        cwd,
        transientPaths: state.gitTransientPaths,
      },
      git,
    );
    if (commit.empty || !commit.sha) {
      return null;
    }

    const report = await buildTouchedFilesReport(
      {
        runId: state.runId,
        nodeId: input.nodeId,
        attempt: input.attempt,
        cwd,
        fromSha: prevSha,
        toSha: commit.sha,
        writeSet: input.writeSet,
      },
      git,
    );
    for (const f of report.files) state.touchedFiles.add(f);
    this.emit({
      runId: state.runId,
      type: 'node-committed',
      nodeId: input.nodeId,
      payload: { sha: commit.sha, files: report.files.length, outside: report.outsideWriteSet.length },
    });
    if (report.outsideWriteSet.length > 0) {
      logger.warn(
        { runId: state.runId, nodeId: input.nodeId, outsideWriteSet: report.outsideWriteSet },
        'node tocou arquivos fora do writeSet (enforcement desligado - apenas auditoria)',
      );
    }
    return { sha: commit.sha, touchedFiles: [...report.files] };
  }

  private lastNodeCommitSha(runId: string): string | null {
    try {
      const run = this.deps.crud.getRun(runId);
      if (!run) return null;
      const idx = JSON.parse(run.checkpointJson || '{}') as {
        nodes?: Record<string, { worktreeCommitSha?: string | null; savedAt?: string }>;
      };
      const nodes = idx.nodes ?? {};
      let latestSha: string | null = null;
      let latestAt = '';
      for (const key of Object.keys(nodes)) {
        const n = nodes[key];
        if (n?.worktreeCommitSha && (n.savedAt ?? '') >= latestAt) {
          latestAt = n.savedAt ?? '';
          latestSha = n.worktreeCommitSha;
        }
      }
      return latestSha ?? run.baseCommitSha;
    } catch {
      return null;
    }
  }


  private loadBundle(definition: DynamicWorkflowDefinition): {
    protectedPaths: string[];
    baselineMaxErrorsByCommand: Record<string, number>;
    agentCatalog: Array<{ id: string; name: string; description?: string }>;
    hasBuildScript: boolean;
  } | null {
    const cached = this.bundleCache.get(definition.id);
    if (cached !== undefined) return cached;
    let parsed: {
      protectedPaths: string[];
      baselineMaxErrorsByCommand: Record<string, number>;
      agentCatalog: Array<{ id: string; name: string; description?: string }>;
      hasBuildScript: boolean;
    } | null = null;
    try {
      const path = definition.contextBundlePath;
      if (path && existsSync(path)) {
        const bundle = JSON.parse(readFileSync(path, 'utf8')) as {
          protectedPaths?: string[];
          baselineCommands?: Array<{ id: string; command: string }>;
          baselineResults?: Array<{ commandId: string; errorCount?: number }>;
          agentCatalogSnapshot?: Array<{ id: string; name: string; description?: string }>;
          hasBuildScript?: boolean;
        };
        const byCommandId = new Map<string, number>();
        for (const r of bundle.baselineResults ?? []) {
          if (typeof r.errorCount === 'number') byCommandId.set(r.commandId, r.errorCount);
        }
        const baselineMaxErrorsByCommand: Record<string, number> = {};
        for (const c of bundle.baselineCommands ?? []) {
          const errs = byCommandId.get(c.id);
          if (typeof errs === 'number') baselineMaxErrorsByCommand[c.command] = errs;
        }
        const agentCatalog = Array.isArray(bundle.agentCatalogSnapshot)
          ? bundle.agentCatalogSnapshot.map((a) => ({
              id: a.id,
              name: a.name,
              description: a.description,
            }))
          : [];
        parsed = {
          protectedPaths: Array.isArray(bundle.protectedPaths) ? bundle.protectedPaths : [],
          baselineMaxErrorsByCommand,
          agentCatalog,
          hasBuildScript: bundle.hasBuildScript === true,
        };
      }
    } catch (e) {
      logger.warn({ err: e, definitionId: definition.id }, 'falha ao ler context bundle (resolucao de gate degrada)');
    }
    this.bundleCache.set(definition.id, parsed);
    return parsed;
  }

  private loadBundleProtectedPaths(definition: DynamicWorkflowDefinition): string[] {
    return this.loadBundle(definition)?.protectedPaths ?? [];
  }

  private loadBundleAgentCatalog(
    definition: DynamicWorkflowDefinition,
  ): Array<{ id: string; name: string; description?: string }> {
    return this.loadBundle(definition)?.agentCatalog ?? [];
  }

  private buildGateResolutionContext(
    state: ActiveRunState,
    opts?: { cwdBase?: 'workspace' | 'repo-root' },
  ): GateCheckResolutionContext {
    const bundle = this.loadBundle(state.definition);
    const repoRoot =
      opts?.cwdBase === 'repo-root'
        ? (state.workspace?.repoRoot ?? state.definition.projectPath)
        : (state.workspace?.workspaceDir ??
          state.workspace?.repoRoot ??
          state.definition.projectPath);
    return {
      repoRoot,
      protectedPaths: bundle?.protectedPaths ?? [],
      touchedFiles: [...state.touchedFiles],
      nodeOutputs: this.collectNodeOutputs(state.runId),
      baselineMaxErrorsByCommand: bundle?.baselineMaxErrorsByCommand ?? {},
    };
  }

  private collectNodeOutputs(runId: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    try {
      const runs = this.deps.crud.listNodeRuns(runId);
      const sorted = [...runs].sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0));
      for (const r of sorted) {
        if (r.status !== 'completed' || !r.outputJson) continue;
        try {
          const env = JSON.parse(r.outputJson) as { output?: unknown };
          const raw = typeof env.output === 'string' ? env.output : '';
          out[r.nodeId] = raw ? parseNodeOutput(raw) : env.output ?? {};
        } catch {
        }
      }
    } catch (e) {
      logger.warn({ err: e, runId }, 'falha ao coletar outputs de node para resolucao de gate (degrada)');
    }
    return out;
  }

  private async commitFailedWriterWip(
    state: ActiveRunState,
    input: { nodeId: string; attempt: number },
  ): Promise<{ sha: string | null } | null> {
    const cwd = state.workspace?.workspaceDir;
    if (!cwd) return null;
    try {
      const commit = await commitFailedWip(
        { runId: state.runId, nodeId: input.nodeId, attempt: input.attempt, cwd, transientPaths: state.gitTransientPaths },
        this.deps.git ?? runGit,
      );
      if (commit.sha) {
        this.emit({
          runId: state.runId,
          type: 'node-wip-committed',
          nodeId: input.nodeId,
          payload: { sha: commit.sha, attempt: input.attempt, reason: 'failed' },
        });
      }
      return { sha: commit.sha };
    } catch (e) {
      logger.warn({ err: e, runId: state.runId, nodeId: input.nodeId }, 'falha no WIP commit do writer falho (ignorado)');
      return null;
    }
  }

  private async resetAfterSkip(
    state: ActiveRunState,
    input: { nodeId: string; attempt: number; wipSha: string | null },
  ): Promise<void> {
    const cwd = state.workspace?.workspaceDir;
    if (!cwd || !input.wipSha) return;
    const target = this.lastNodeCommitSha(state.runId) ?? state.workspace?.baseCommitSha ?? null;
    if (!target) return;
    try {
      await resetToCommit(cwd, target, this.deps.git ?? runGit);
      this.emit({
        runId: state.runId,
        type: 'node-skipped-reset',
        nodeId: input.nodeId,
        payload: { nodeId: input.nodeId, attempt: input.attempt, discardedWipSha: input.wipSha, resetTo: target },
      });
    } catch (e) {
      logger.warn({ err: e, runId: state.runId, nodeId: input.nodeId }, 'reset apos skip falhou (ignorado)');
    }
  }

  private async commitInterruptWip(state: ActiveRunState): Promise<void> {
    const cwd = state.workspace?.workspaceDir;
    if (!cwd) return;
    try {
      const node = this.deps.crud.getRun(state.runId)?.currentNodeId ?? 'unknown';
      await commitWip(
        { runId: state.runId, nodeId: node, attempt: 0, cwd, transientPaths: state.gitTransientPaths },
        this.deps.git ?? runGit,
      );
    } catch (e) {
      logger.warn({ err: e, runId: state.runId }, 'falha no WIP commit de interrupcao (ignorado)');
    }
  }


  private async handleFinalGateApproved(
    state: ActiveRunState,
    gateId: string,
    approvedBy: string,
  ): Promise<void> {
    const { runId, workspace } = state;
    if (!workspace) {
      this.failRun(runId, 'gate final aprovado sem workspace preparado');
      return;
    }
    const git = this.deps.git ?? runGit;

    if (workspace.mode === 'fresh-project') {
      this.emit({ runId, type: 'merge-accepted-fresh', payload: { gateId, approvedBy } });
      await this.markDeliveredAndCloser(state, 'fresh-project aceito (gate final).');
      return;
    }

    let sprintMerge: OrderedMergeReport | null = null;
    try {
      sprintMerge = await this.mergeSprintsForRun(state, gateId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error({ err: e, runId }, 'falha no merge ordenado de sprints');
      await this.autoOpenCloser(state, 'merge-conflict', `Falha no merge ordenado de sprints: ${message}`);
      return;
    }
    if (sprintMerge && !sprintMerge.allMerged) {
      this.emit({
        runId,
        type: 'sprint-merge-blocked',
        payload: { conflictedSprintId: sprintMerge.conflictedSprintId },
      });
      await this.autoOpenCloser(
        state,
        'merge-conflict',
        `Conflito no merge ordenado da sprint ${sprintMerge.conflictedSprintId ?? '?'}. Resolver com agente.`,
      );
      return;
    }

    const name = state.definition.name;
    const deliverySummary = `entrega do gate ${gateId}`;
    let outcome;
    try {
      outcome = await squashMergePostGate(
        {
          cwd: workspace.repoRoot,
          baseBranch: workspace.baseBranch,
          runBranch: workspace.worktreeBranch ?? `dynworkflow/${runId}`,
          baseCommitSha: workspace.baseCommitSha,
          name,
          deliverySummary,
          runId,
          transientPaths: state.gitTransientPaths,
        },
        git,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error({ err: e, runId }, 'falha no merge pos-gate');
      await this.autoOpenCloser(state, 'merge-conflict', `Falha no merge pos-gate: ${message}`);
      return;
    }

    if (outcome.kind === 'conflict') {
      this.emit({
        runId,
        type: 'merge-conflict',
        payload: { gateId, conflictPaths: outcome.conflictPaths },
      });
      await this.autoOpenCloser(
        state,
        'merge-conflict',
        `Conflito de merge em ${outcome.conflictPaths.length} arquivo(s). Resolver com agente.`,
      );
      return;
    }

    if (outcome.kind === 'staged') {
      this.emit({ runId, type: 'merge-staged', payload: { stagingSha: outcome.stagingSha } });
      const rechecksGreen = await this.runStagedRechecks(state, gateId);
      if (rechecksGreen) {
        try {
          const fin = await finalizeStagedMerge(
            { cwd: workspace.repoRoot, baseBranch: workspace.baseBranch, stagingSha: outcome.stagingSha },
            git,
          );
          this.emit({
            runId,
            type: 'merge-revalidated',
            payload: { mergeSha: fin.mergeSha, mechanical: true },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await this.autoOpenCloser(state, 'merge-conflict', `Falha ao concluir staging: ${message}`);
          return;
        }
      } else {
        this.emit({ runId, type: 'merge-recheck-failed', payload: {} });
        await this.autoOpenCloser(
          state,
          'merge-conflict',
          'Re-checks da staging falharam apos a base andar. Resolver com agente.',
        );
        return;
      }
    } else {
      this.emit({
        runId,
        type: 'merge-squashed',
        payload: {
          mergeSha: outcome.mergeSha,
          ...(outcome.empty ? { empty: true } : {}),
        },
      });
    }

    try {
      await cleanupWorktree(
        { repoRoot: workspace.repoRoot, worktreePath: workspace.worktreePath ?? '', runId },
        git,
      );
    } catch (e) {
      logger.warn({ err: e, runId }, 'cleanup da worktree pos-merge falhou (ignorado)');
    }

    await this.cleanupAllSprintWorktrees(state);

    await this.markDeliveredAndCloser(state, 'Entrega mergeada na base. Walkthrough da entrega.');
  }

  async cleanupAllSprintWorktrees(state: ActiveRunState): Promise<void> {
    const workspace = state.workspace;
    if (!workspace || workspace.mode !== 'run-worktree') return;
    const git = this.deps.git ?? runGit;
    const byIdx = new Map<number, string>();
    for (const [idx, handle] of state.sprintWorktrees) byIdx.set(idx, handle.worktreePath);
    const rows = this.deps.crud.listSprints?.(state.runId) ?? [];
    for (const row of rows) {
      const idx = this.sprintIndexOf(row.sprintId);
      if (idx !== null && row.worktreePath && !byIdx.has(idx)) byIdx.set(idx, row.worktreePath);
    }
    for (const [idx, worktreePath] of byIdx) {
      try {
        await cleanupSprintWorktree(
          { repoRoot: workspace.repoRoot, worktreePath, runId: state.runId, sprintIndex: idx },
          git,
        );
      } catch (e) {
        logger.debug({ err: e, runId: state.runId, sprintIndex: idx }, 'cleanup de worktree de sprint falhou (ignorado)');
      }
    }
    state.sprintWorktrees.clear();
  }

  private async runStagedRechecks(state: ActiveRunState, gateId: string): Promise<boolean> {
    try {
      const run = this.deps.crud.getRun(state.runId);
      const parsed = JSON.parse(run?.inputJson || '{}') as { recheckOverride?: 'green' | 'red' };
      if (parsed.recheckOverride === 'red') return false;
      if (parsed.recheckOverride === 'green') return true;
    } catch {
    }

    const symbolic = this.finalGateChecks(state, gateId);
    if (symbolic.length === 0) {
      return true;
    }
    try {
      const rc = this.buildGateResolutionContext(state, { cwdBase: 'repo-root' });
      const resolved = resolveGateChecks(symbolic, rc);
      const runCommand = this.deps.runGateCommand;
      const result = runGateChecks(resolved, 'auto', runCommand ? { runCommand } : {});
      this.emit({
        runId: state.runId,
        type: 'merge-recheck-result',
        payload: { ok: result.ok, failed: result.checks.filter((c) => !c.ok).length },
      });
      return result.ok;
    } catch (e) {
      logger.error({ err: e, runId: state.runId }, 'falha ao re-rodar checks da staging (trata como vermelho)');
      return false;
    }
  }

  private finalGateChecks(state: ActiveRunState, gateId: string): GateCheckSpec[] {
    const node = state.manifest.nodes.find((n) => n.id === gateId && n.type === 'gate');
    const gateConfig = (node as { gateConfig?: { checks?: unknown } } | undefined)?.gateConfig;
    const checks = gateConfig?.checks;
    return Array.isArray(checks) ? (checks as GateCheckSpec[]) : [];
  }

  private async markDeliveredAndCloser(state: ActiveRunState, walkthrough: string): Promise<void> {
    this.deps.crud.updateRun(state.runId, {
      status: 'delivered',
      deliveredAt: this.now(),
    });
    this.emit({ runId: state.runId, type: 'run-delivered', payload: {} });
    await this.autoOpenCloser(state, 'delivery', walkthrough);
    this.autoFinalizeAfterDelivery(state.runId);
  }

  private async autoOpenCloser(
    state: ActiveRunState,
    reason: CloserSpawnContext['reason'],
    motive: string,
  ): Promise<void> {
    const closerDeps = this.buildCloserDeps();
    if (!closerDeps) {
      logger.warn({ runId: state.runId }, 'closer nao configurado; pulando fechamento automatico');
      return;
    }
    const repoRoot = state.workspace?.repoRoot ?? state.definition.projectPath;
    try {
      await openCloserSession(state.runId, { reason, motive }, closerDeps, { repoRoot });
      this.emit({ runId: state.runId, type: 'closer-auto-opened', payload: { reason } });
    } catch (e) {
      logger.warn({ err: e, runId: state.runId }, 'fechamento automatico do closer falhou (ignorado)');
    }
  }

  private autoFinalizeAfterDelivery(runId: string): void {
    const run = this.deps.crud.getRun(runId);
    if (!run || run.status !== 'delivered') return;
    try {
      closerFinalize(runId, this.buildFinalizeDeps(runId));
      this.active.delete(runId);
    } catch (e) {
      logger.warn(
        { err: e, runId },
        'SM-48: auto-finalize pos-entrega falhou (ignorado; finalize humano segue valido)',
      );
    }
  }

  private buildCloserDeps(): CloserEngineDeps | null {
    const injected = this.deps.closerDeps;
    if (!injected?.runAgentTurn) return null;
    return {
      getRun: this.deps.crud.getRun,
      updateRun: this.deps.crud.updateRun,
      insertMessage: this.deps.crud.insertMessage,
      listMessages: this.deps.crud.listMessages,
      recentEvents: this.deps.crud.recentEvents,
      costAggregate: this.deps.crud.costAggregate,
      runAgentTurn: injected.runAgentTurn,
      resolveCloserRuntime: injected.resolveCloserRuntime,
      confirmGitWrite: injected.confirmGitWrite,
      auditGit: injected.auditGit,
      emitEvent: (input) => this.emit(input),
      releaseRunLock: (runId) => releaseRunLock(runId),
      now: this.now,
    };
  }


  async pause(runId: string): Promise<RunnerResult> {
    const state = this.active.get(runId);
    if (!state) {
      const run = this.deps.crud.getRun(runId);
      if (!run) return err(`run nao encontrado: ${runId}`);
      if (run.status === 'paused' || run.status === 'blocked') return ok();
      return err(`run ${runId} nao esta em execucao`);
    }
    state.stopReason = 'pause';
    this.markRunningAttemptsInterrupted(runId);
    state.abortController.abort();
    this.emit({ runId, type: 'pause-requested', payload: {} });
    return ok();
  }

  async pauseAllForAuthorizationLoss(): Promise<number> {
    const runIds = [...this.active.keys()];
    await Promise.all(runIds.map(async (runId) => {
      await this.pause(runId);
    }));
    return runIds.length;
  }

  async resume(runId: string, opts?: ResumeOptions): Promise<RunnerResult> {
    const run = this.deps.crud.getRun(runId);
    if (!run) return err(`run nao encontrado: ${runId}`);

    if (opts?.scheduledAt !== undefined || opts?.delayMs !== undefined) {
      const atIso =
        opts.scheduledAt ?? this.isoAfter(Math.max(0, opts.delayMs ?? 0));
      return this.scheduleResume(runId, atIso);
    }

    if (run.status === 'running') return ok();
    if (run.status === 'completed') {
      return err(`run ${runId} ja finalizado (terminal de leitura); nao ha o que re-executar`);
    }
    if (run.status === 'delivered') {
      return err(`run ${runId} ja entregue (fase de fechamento); use finalize/closer, nao resume`);
    }

    if (run.status === 'aborted' || run.status === 'failed') {
      this.markRunningAttemptsInterrupted(runId);
      this.deps.crud.updateRun(runId, { status: 'interrupted', completedAt: null, error: null });
      this.emit({
        runId,
        type: 'run-recovered-from-terminal',
        payload: { from: run.status },
      });
    }

    if (run.status === 'blocked') {
      if (opts?.acceptPolicyChange && this.isPolicyChangedBlock(run)) {
        this.acceptPolicyChange(runId);
      } else if (this.isResumableInfoBlock(run)) {
        this.acceptInfoBlockOnResume(runId);
      } else {
        return err(`run ${runId} esta bloqueado aguardando decisao (use approve-gate/intervene)`);
      }
    } else {
      const { invalidated } = this.detectPolicyInvalidation(runId);
      if (invalidated.length > 0) {
        return err(
          `run ${runId}: a permissao/config de ${invalidated.length} node(s) mudou; aceite reusar ou reexecute antes de retomar (10.1)`,
        );
      }
    }

    if (run.workspaceMode === 'run-worktree' && run.worktreePath && run.baseCommitSha) {
      const definition = this.deps.crud.getDefinition(run.definitionId);
      if (definition && !existsSync(run.worktreePath)) {
        try {
          await recreateWorktree(
            {
              repoRoot: definition.projectPath,
              worktreePath: run.worktreePath,
              runId,
              baseCommitSha: run.baseCommitSha,
            },
            this.deps.git ?? runGit,
          );
          this.emit({ runId, type: 'worktree-recreated', payload: {} });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return err(`falha ao recriar worktree no resume: ${message}`);
        }
      }
    }

    this.emit({
      runId,
      type: 'resume-requested',
      payload: opts?.acceptBoundary ? { acceptBoundary: true } : {},
    });
    return this.start(runId);
  }

  async abort(runId: string): Promise<RunnerResult> {
    const state = this.active.get(runId);
    if (state) {
      state.stopReason = 'abort';
      this.markRunningAttempts(runId, 'cancelled');
      this.rejectPendingGates(state);
      state.abortController.abort();
      this.emit({ runId, type: 'abort-requested', payload: {} });
      return ok();
    }
    const run = this.deps.crud.getRun(runId);
    if (!run) return err(`run nao encontrado: ${runId}`);
    if (run.status === 'aborted' || run.status === 'completed') return ok();
    this.deps.crud.updateRun(runId, { status: 'aborted', completedAt: this.now() });
    this.emit({ runId, type: 'run-aborted', payload: { preservedBranch: run.worktreeBranch } });
    releaseRunLock(runId);
    return ok();
  }

  async reopen(runId: string): Promise<RunnerResult> {
    const run = this.deps.crud.getRun(runId);
    if (!run) return err(`run nao encontrado: ${runId}`);
    if (run.status !== 'aborted') {
      return this.resume(runId);
    }
    this.markRunningAttemptsInterrupted(runId);
    this.deps.crud.updateRun(runId, { status: 'interrupted', completedAt: null, error: null });
    this.emit({ runId, type: 'run-recovered-from-terminal', payload: { from: 'aborted' } });
    return this.resume(runId);
  }


  async approveGate(
    runId: string,
    gateId: string,
    decision: { decision: 'approve' | 'reject'; reason?: string; payload?: Record<string, unknown> },
    decidedBy = 'human',
  ): Promise<RunnerResult> {
    const state = this.active.get(runId);
    if (!state) {
      return this.resolveOrphanedGate(runId, gateId, decision, decidedBy);
    }
    const resolver = state.gateResolvers.get(gateId);
    if (!resolver) return err(`gate ${gateId} nao esta pendente no run ${runId}`);

    if (isFailureGateId(gateId)) {
      const prepared = this.prepareFailureGateDecision(runId, gateId, decision, decidedBy);
      if ('error' in prepared) return err(prepared.error);
      state.gateResolvers.delete(gateId);
      if (prepared.action === 'abort') {
        await this.abort(runId);
        resolver({ decision: 'reject', approvedBy: decidedBy, reason: decision.reason });
        return ok();
      }
      this.emit({
        runId,
        type: 'gate-decision-received',
        payload: { gateId, decision: 'approve', decidedBy, action: prepared.action },
      });
      resolver({
        decision: 'approve',
        approvedBy: decidedBy,
        reason: decision.reason,
        payload: { ...(decision.payload ?? {}), action: prepared.action },
      });
      return ok();
    }

    const gateKind = this.resolveGateKind(state, gateId);
    state.gateResolvers.delete(gateId);
    if (isBoundaryGateId(gateId) && decision.decision === 'reject' && !state.boundaryGateAtCompletion) {
      await this.pause(runId);
    }
    resolver(this.buildGateResolution(runId, gateId, gateKind, decision, decidedBy));
    return ok();
  }

  private buildGateResolution(
    runId: string,
    gateId: string,
    gateKind: 'plan-review' | 'delivery' | undefined,
    decision: { decision: 'approve' | 'reject'; reason?: string; payload?: Record<string, unknown> },
    decidedBy: string,
  ): PendingGateResolution {
    const wantsReplan =
      decision.decision === 'reject' || decision.payload?.['action'] === 'replan';
    const replanOnPlanReview = gateKind === 'plan-review' && wantsReplan;
    const wantsRedev =
      decision.decision === 'reject' ||
      decision.payload?.['action'] === 'redev' ||
      decision.payload?.['action'] === 'replan';
    const redevOnDelivery = gateKind === 'delivery' && wantsRedev;

    if (replanOnPlanReview) {
      this.emit({
        runId,
        type: 'gate-replan-requested',
        payload: { gateId, originalDecision: decision.decision, decidedBy },
      });
      return {
        decision: 'approve',
        approvedBy: decidedBy,
        reason: decision.reason,
        payload: { ...(decision.payload ?? {}), action: 'replan', originalDecision: decision.decision },
      };
    }

    if (redevOnDelivery) {
      this.emit({
        runId,
        type: 'gate-redev-requested',
        payload: { gateId, originalDecision: decision.decision, decidedBy },
      });
      return {
        decision: 'approve',
        approvedBy: decidedBy,
        reason: decision.reason,
        payload: { ...(decision.payload ?? {}), action: 'redev', originalDecision: decision.decision },
      };
    }

    this.emit({
      runId,
      type: 'gate-decision-received',
      payload: { gateId, decision: decision.decision, decidedBy },
    });
    return {
      decision: decision.decision,
      approvedBy: decidedBy,
      reason: decision.reason,
      payload: decision.payload,
    };
  }

  private async resolveOrphanedGate(
    runId: string,
    gateId: string,
    decision: { decision: 'approve' | 'reject'; reason?: string; payload?: Record<string, unknown> },
    decidedBy: string,
  ): Promise<RunnerResult> {
    const run = this.deps.crud.getRun(runId);
    if (!run) return err(`run nao encontrado: ${runId}`);
    if (run.status !== 'blocked') {
      return err(`run ${runId} nao esta aguardando gate (status ${run.status})`);
    }
    const pending = this.parsePendingGate(run);
    if (!pending || pending.id !== gateId) {
      return err(`gate ${gateId} nao esta pendente no run ${runId}`);
    }

    const inboxKey = `${runId}::${gateId}`;
    let resolution: PendingGateResolution;
    if (isFailureGateId(gateId)) {
      const prepared = this.prepareFailureGateDecision(runId, gateId, decision, decidedBy);
      if ('error' in prepared) return err(prepared.error);
      if (prepared.action === 'abort') {
        this.deps.crud.updateRun(runId, { inputJson: this.clearPendingDecision(runId) });
        return this.abort(runId);
      }
      this.emit({
        runId,
        type: 'gate-decision-received',
        payload: { gateId, decision: 'approve', decidedBy, action: prepared.action, orphan: true },
      });
      resolution = {
        decision: 'approve',
        approvedBy: decidedBy,
        reason: decision.reason,
        payload: { ...(decision.payload ?? {}), action: prepared.action },
      };
    } else {
      const gateKind = this.resolveGateKindFromManifest(run, gateId);
      resolution = this.buildGateResolution(runId, gateId, gateKind, decision, decidedBy);
    }
    this.gateInbox.set(inboxKey, resolution);

    this.markRunningAttemptsInterrupted(runId);
    this.deps.crud.updateRun(runId, {
      status: 'interrupted',
      completedAt: null,
      error: null,
      ...(isFailureGateId(gateId) ? { inputJson: this.clearPendingDecision(runId) } : {}),
    });
    this.emit({
      runId,
      type: 'gate-orphan-rearm',
      payload: { gateId, decision: decision.decision, decidedBy },
    });

    const resumed = await this.resume(runId);
    if ('error' in resumed) {
      this.gateInbox.delete(inboxKey);
    }
    return resumed;
  }

  private parsePendingGate(run: DynamicWorkflowRun): { id: string } | null {
    try {
      const input = JSON.parse(run.inputJson || '{}') as {
        pendingDecision?: { type?: string; id?: string; gateId?: string };
      };
      const pd = input.pendingDecision;
      if (pd && pd.type === 'gate' && typeof pd.id === 'string' && pd.id.length > 0) {
        return { id: pd.id };
      }
      if (pd && pd.type === 'provider' && typeof pd.gateId === 'string' && isFailureGateId(pd.gateId)) {
        return { id: pd.gateId };
      }
      return null;
    } catch {
      return null;
    }
  }

  private prepareFailureGateDecision(
    runId: string,
    gateId: string,
    decision: { decision: 'approve' | 'reject'; payload?: Record<string, unknown> },
    source: string,
  ): { action: FailureGateAction } | { error: string } {
    const nodeId = nodeIdOfFailureGate(gateId);
    if (!nodeId) return { error: `gate ${gateId} nao e um gate de falha` };
    if (decision.decision === 'reject') return { action: 'abort' };
    const rawAction = decision.payload?.['action'];
    const action = rawAction === undefined ? 'retry' : parseFailureGateAction(rawAction);
    if (!action) {
      return {
        error: `gate ${gateId}: payload.action invalida "${String(rawAction)}" (aceitas: retry | switch-agent | skip | abort)`,
      };
    }
    const instruction = decision.payload?.['instruction'];
    if (action === 'switch-agent') {
      const agentType = decision.payload?.['agentType'];
      if (typeof agentType !== 'string' || agentType.trim().length === 0) {
        return { error: `gate ${gateId}: switch-agent exige payload.agentType` };
      }
      const target = agentType.trim();
      if ((DYNAMIC_WORKFLOW_AGENT_DENYLIST as readonly string[]).includes(target)) {
        return { error: `gate ${gateId}: agentType "${target}" esta na denylist de dynamic workflows` };
      }
      if (this.deps.resolveAgentAxes && !this.deps.resolveAgentAxes(target)) {
        return { error: `gate ${gateId}: agentType "${target}" nao existe no catalogo de agentes` };
      }
      this.deps.crud.insertMessage({
        runId,
        nodeId,
        role: 'user',
        source: source as DynamicWorkflowMessageInsertInput['source'],
        kind: AGENT_SWITCH_MESSAGE_KIND,
        content: target,
      });
    }
    if ((action === 'retry' || action === 'switch-agent') && typeof instruction === 'string' && instruction.trim()) {
      this.deps.crud.insertMessage({
        runId,
        nodeId,
        role: 'user',
        source: source as DynamicWorkflowMessageInsertInput['source'],
        kind: 'adjustment',
        content: instruction,
      });
    }
    return { action };
  }

  private resolveGateKindFromManifest(
    run: DynamicWorkflowRun,
    gateId: string,
  ): 'plan-review' | 'delivery' | undefined {
    if (gateId === CC_DELIVERY_GATE_ID) return 'delivery';
    try {
      const definition = this.deps.crud.getDefinition(run.definitionId);
      if (!definition) return undefined;
      const manifest = JSON.parse(definition.manifestJson) as DynamicWorkflowManifest;
      const gates = Array.isArray(manifest.gates) ? manifest.gates : [];
      return gates.find((g) => g.id === gateId)?.kind;
    } catch {
      return undefined;
    }
  }

  private resolveGateKind(
    state: ActiveRunState,
    gateId: string,
  ): 'plan-review' | 'delivery' | undefined {
    if (gateId === CC_DELIVERY_GATE_ID) return 'delivery';
    const gates = Array.isArray(state.manifest.gates) ? state.manifest.gates : [];
    return gates.find((g) => g.id === gateId)?.kind;
  }

  async intervene(
    runId: string,
    intervention: import('./types').DynamicWorkflowIntervention,
    source: 'human' | 'orchestrator' | 'workflow-orchestrator-agent' = 'human',
  ): Promise<RunnerResult> {
    const run = this.deps.crud.getRun(runId);
    if (!run) return err(`run nao encontrado: ${runId}`);

    switch (intervention.type) {
      case 'pause':
        await this.recordIntervention(runId, intervention, source);
        return this.pause(runId);
      case 'resume':
        await this.recordIntervention(runId, intervention, source);
        return this.resume(runId, intervention.acceptBoundary ? { acceptBoundary: true } : undefined);
      case 'rerun-node':
        await this.recordIntervention(runId, intervention, source);
        return this.rerunNode(runId, intervention.nodeId, intervention.instruction, source);
      case 'approve-gate':
        await this.recordIntervention(runId, intervention, source);
        return this.approveGate(
          runId,
          intervention.gateId,
          {
            decision: intervention.decision,
            reason: intervention.reason,
            ...(intervention.payload ? { payload: intervention.payload } : {}),
          },
          source,
        );
      case 'reply':
        await this.recordIntervention(runId, intervention, source);
        this.deps.crud.insertMessage({
          runId,
          nodeId: intervention.targetNodeId ?? null,
          role: 'user',
          source,
          kind: 'text',
          content: intervention.message,
        });
        return ok();
      case 'adjust-next-node':
        await this.recordIntervention(runId, intervention, source);
        this.deps.crud.insertMessage({
          runId,
          nodeId: intervention.nodeId,
          role: 'user',
          source,
          kind: 'adjustment',
          content: intervention.instruction,
        });
        return ok();
      case 'switch-agent':
        await this.recordIntervention(runId, intervention, source);
        return this.switchAgent(
          runId,
          intervention.nodeId,
          intervention.newAgentId,
          intervention.reason,
          source,
        );
      case 'request-replan':
        return err('request-replan e tratado pela IPC request-replan (S14), nao por intervene');
      default:
        return err('intervencao desconhecida');
    }
  }


  async rerunNode(
    runId: string,
    nodeId: string,
    instruction: string,
    source: 'human' | 'orchestrator' | 'workflow-orchestrator-agent' = 'orchestrator',
  ): Promise<RunnerResult> {
    if (!nodeId) return err('rerun-node: nodeId obrigatorio');
    if (!instruction || !instruction.trim()) return err('rerun-node: instruction obrigatoria');
    const listJournal = this.deps.crud.listJournalEntries;
    const truncate = this.deps.crud.truncateJournalFrom;
    if (!listJournal || !truncate) {
      return err('rerun-node indisponivel: journal ordenado nao configurado neste runner');
    }
    let run = this.deps.crud.getRun(runId);
    if (!run) return err(`run nao encontrado: ${runId}`);
    if (run.status === 'completed' || run.status === 'delivered') {
      return err(
        `rerun-node: o run "${runId}" esta "${run.status}" (ciclo cumprido); nao ha o que re-executar`,
      );
    }

    if (run.status === 'blocked') {
      const pendingGate = this.parsePendingGate(run);
      if (pendingGate && pendingGate.id === failureGateId(nodeId)) {
        return this.approveGate(
          runId,
          pendingGate.id,
          { decision: 'approve', payload: { action: 'retry', instruction } },
          source,
        );
      }
    }

    const quiesced = await this.quiesceRun(runId);
    if ('error' in quiesced) return quiesced;

    run = this.deps.crud.getRun(runId);
    if (!run) return err(`run nao encontrado: ${runId}`);
    if (run.status === 'running') {
      return err(
        `rerun-node: o run "${runId}" consta "running" sem execucao ativa neste processo; aguarde o boot-recovery e tente de novo`,
      );
    }

    let clearedDecision: unknown = null;
    if (run.status === 'blocked') {
      clearedDecision = this.readPendingDecision(run);
      this.deps.crud.updateRun(runId, {
        status: 'interrupted',
        inputJson: this.clearPendingDecision(runId),
        error: null,
      });
      for (const key of [...this.gateInbox.keys()]) {
        if (key.startsWith(`${runId}::`)) this.gateInbox.delete(key);
      }
    } else if (quiesced.resolvedGates > 0) {
      clearedDecision = this.readPendingDecision(run);
      if (clearedDecision !== null) {
        this.deps.crud.updateRun(runId, { inputJson: this.clearPendingDecision(runId) });
      }
    }

    let fromCallIndex: number;
    try {
      const entries = listJournal(runId);
      const first = entries.find((e) => e.nodeId === nodeId);
      if (!first) {
        return err(
          `rerun-node: o node "${nodeId}" nao esta no journal do run "${runId}" (nunca concluiu ou o id esta errado); nada a re-executar`,
        );
      }
      fromCallIndex = first.callIndex;
      truncate(runId, fromCallIndex);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(`rerun-node: falha ao truncar o journal: ${message}`);
    }

    this.deps.crud.insertMessage({
      runId,
      nodeId,
      role: 'user',
      source,
      kind: 'adjustment',
      content: instruction,
    });
    this.emit({
      runId,
      type: 'rerun-requested',
      nodeId,
      payload: { nodeId, fromCallIndex, clearedDecision, source },
    });
    return this.resume(runId);
  }

  private async quiesceRun(
    runId: string,
    timeoutMs: number = this.deps.quiesceTimeoutMs ?? RERUN_QUIESCE_TIMEOUT_MS,
  ): Promise<{ ok: true; resolvedGates: number } | { error: string }> {
    const state = this.active.get(runId);
    if (!state) return { ok: true, resolvedGates: 0 };
    const run = this.deps.crud.getRun(runId);
    if (!run) return { error: `run nao encontrado: ${runId}` };

    if (run.status === 'blocked' && !this.parsePendingGate(run)) {
      this.active.delete(runId);
      releaseRunLock(runId);
      this.forgetNarratorState(runId);
      return { ok: true, resolvedGates: 0 };
    }
    if (
      run.status === 'paused' ||
      run.status === 'interrupted' ||
      run.status === 'failed' ||
      run.status === 'aborted'
    ) {
      const settled = await this.waitActiveGone(runId, timeoutMs);
      return settled
        ? { ok: true, resolvedGates: 0 }
        : { error: `rerun-node: o run "${runId}" nao quiesceu em ${timeoutMs} ms; nada foi truncado` };
    }

    const stopped = new Promise<boolean>((resolve) => {
      let waiters = this.quiesceWaiters.get(runId);
      if (!waiters) {
        waiters = new Set();
        this.quiesceWaiters.set(runId, waiters);
      }
      const timer = setTimeout(() => {
        waiters!.delete(waiter);
        if (waiters!.size === 0) this.quiesceWaiters.delete(runId);
        resolve(false);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const waiter = (): void => {
        clearTimeout(timer);
        waiters!.delete(waiter);
        if (waiters!.size === 0) this.quiesceWaiters.delete(runId);
        resolve(true);
      };
      waiters.add(waiter);
    });
    const paused = await this.pause(runId);
    if ('error' in paused) return paused;
    let resolvedGates = 0;
    if (run.status === 'blocked') {
      for (const [gateId, resolver] of state.gateResolvers.entries()) {
        resolver({
          decision: 'reject',
          approvedBy: 'rerun-node',
          reason: 'quiescencia para rerun-node (gate re-alcancado apos a re-execucao)',
        });
        state.gateResolvers.delete(gateId);
        resolvedGates += 1;
      }
    }
    const gotEvent = await stopped;
    if (!gotEvent) {
      return { error: `rerun-node: o run "${runId}" nao quiesceu em ${timeoutMs} ms (child ainda vivo); nada foi truncado` };
    }
    const gone = await this.waitActiveGone(runId, timeoutMs);
    if (!gone) {
      return { error: `rerun-node: o run "${runId}" parou mas o estado ativo nao foi liberado em ${timeoutMs} ms; nada foi truncado` };
    }
    return { ok: true, resolvedGates };
  }

  private async waitActiveGone(runId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.active.has(runId)) {
      if (Date.now() >= deadline) return false;
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    return true;
  }

  private readPendingDecision(run: DynamicWorkflowRun): unknown {
    try {
      const input = JSON.parse(run.inputJson || '{}') as { pendingDecision?: unknown };
      return input.pendingDecision ?? null;
    } catch {
      return null;
    }
  }



  private async handleNodeFailed(
    state: ActiveRunState,
    input: {
      nodeId: string;
      attempt: number;
      failureClass: string | null;
      runtime: string;
      error: unknown;
      errorMessage?: string | null;
      recoverable: boolean;
    },
  ): Promise<NodeFailureHookOutcome | undefined> {
    const failureInput: FailureClassificationInput = {
      runtime: coerceFailureRuntime(input.runtime),
      error: input.error ?? input.errorMessage ?? input.failureClass ?? 'falha de node',
    };
    const attemptsMade = this.durableAttemptsMade(state.runId, input.nodeId);
    const canonicalClass = this.coerceCanonicalFailureClass(input.failureClass);
    try {
      const decided = await this.handleProviderFailure(
        state.runId,
        input.nodeId,
        failureInput,
        attemptsMade,
        DEFAULT_RETRY_POLICY,
        canonicalClass,
        { inProcessRetry: true, failureGateId: failureGateId(input.nodeId) },
      );
      return {
        outcome: decided.outcome,
        backoffMs: decided.backoffMs,
        failureClass: decided.failureClass,
        retriesExhausted: decided.retriesExhausted,
        attemptsMade,
      };
    } catch (e) {
      logger.warn({ err: e, runId: state.runId, nodeId: input.nodeId }, 'handleProviderFailure falhou (ignorado)');
      return undefined;
    }
  }

  private coerceCanonicalFailureClass(
    value: string | null,
  ): DynamicWorkflowFailureClass | null {
    if (value && FAILURE_CLASSES.has(value as DynamicWorkflowFailureClass)) {
      return value as DynamicWorkflowFailureClass;
    }
    return null;
  }

  private durableAttemptsMade(runId: string, nodeId: string): number {
    const failedAttempts = this.deps.crud
      .listNodeRuns(runId)
      .filter(
        (nr) => nr.nodeId === nodeId && (nr.status === 'failed' || nr.status === 'interrupted'),
      ).length;
    return Math.max(1, failedAttempts);
  }

  async handleProviderFailure(
    runId: string,
    nodeId: string,
    failureInput: FailureClassificationInput,
    attemptsMade: number,
    policy: DynamicWorkflowRetryPolicy = DEFAULT_RETRY_POLICY,
    precomputedClass?: DynamicWorkflowFailureClass | null,
    opts?: { inProcessRetry?: boolean; failureGateId?: string },
  ): Promise<{
    outcome: 'retry-scheduled' | 'blocked-provider' | 'cancelled';
    backoffMs: number;
    failureClass: DynamicWorkflowFailureClass;
    retriesExhausted?: boolean;
  }> {
    const failureClass = precomputedClass ?? classifyFailureByRuntime(failureInput);
    this.markNodeAttemptInterrupted(runId, nodeId, failureClass, failureInput.error);

    if (failureClass === 'cancelled') {
      const active = this.active.get(runId);
      const corroborated =
        (active?.stopReason ?? null) !== null ||
        active?.abortController.signal.aborted === true;
      if (corroborated) {
        logger.info(
          { runId, nodeId, failureClass },
          'node cancelado pelo usuario/run - sem retry e sem bloqueio de provedor',
        );
        return { outcome: 'cancelled', backoffMs: 0, failureClass };
      }
      logger.warn(
        { runId, nodeId },
        'falha classificada cancelled SEM corroboracao de parada (mensagem de abort espuria) - bloqueia honesto em vez de sumir com o node',
      );
    }

    const rawNodeErr: unknown = failureInput.error;
    const nodeError =
      rawNodeErr instanceof Error
        ? rawNodeErr.message
        : typeof rawNodeErr === 'string'
          ? rawNodeErr
          : null;

    const decision = decideRetry(failureClass, attemptsMade, policy);

    if (decision.blockImmediately) {
      this.blockProvider(runId, nodeId, failureClass, {
        instruction: this.reconnectInstruction(failureInput.runtime),
        retriesExhausted: false,
        attemptsMade,
        nodeError,
        gateId: opts?.failureGateId,
      });
      return { outcome: 'blocked-provider', backoffMs: 0, failureClass, retriesExhausted: false };
    }

    if (decision.shouldRetry) {
      this.emit({
        runId,
        type: 'node-retry-scheduled',
        nodeId,
        payload: {
          failureClass,
          attempt: attemptsMade,
          backoffMs: decision.backoffMs,
          nextAttemptAt: this.isoAfter(decision.backoffMs),
          ...(opts?.inProcessRetry ? { inProcess: true } : {}),
        },
      });
      if (opts?.inProcessRetry) {
        return { outcome: 'retry-scheduled', backoffMs: decision.backoffMs, failureClass };
      }
      this.deps.crud.setRunStatus(runId, 'interrupted');
      this.armScheduledResume(runId, decision.backoffMs, 'retry-backoff');
      return { outcome: 'retry-scheduled', backoffMs: decision.backoffMs, failureClass };
    }

    if (decision.escalate) {
      this.blockProvider(runId, nodeId, failureClass, {
        instruction:
          'Limite do provedor persistiu apos as tentativas automaticas. Retomar agora, Agendar retomada, Trocar agente ou Abortar.',
        retriesExhausted: true,
        attemptsMade,
        nodeError,
        gateId: opts?.failureGateId,
      });
      return { outcome: 'blocked-provider', backoffMs: 0, failureClass, retriesExhausted: true };
    }

    const isProviderClass =
      failureClass === 'provider-limit' ||
      failureClass === 'provider-error' ||
      failureClass === 'timeout';
    const retriesExhausted = isProviderClass && attemptsMade > 0;
    this.blockProvider(runId, nodeId, failureClass, {
      instruction: isProviderClass
        ? `Node falhou (${failureClass}) e a politica nao escala: ${nodeError ?? 'sem detalhe'}. Retome, troque de agente ou aborte.`
        : `Node falhou (${failureClass}): ${nodeError ?? 'sem detalhe'}. Nao e limite de provedor - ajuste/reset e re-execute, ou resolva com agente.`,
      retriesExhausted,
      attemptsMade,
      nodeError,
      gateId: opts?.failureGateId,
    });
    return { outcome: 'blocked-provider', backoffMs: 0, failureClass, retriesExhausted };
  }

  private blockProvider(
    runId: string,
    nodeId: string,
    failureClass: DynamicWorkflowFailureClass,
    detail: {
      instruction: string;
      retriesExhausted: boolean;
      attemptsMade: number;
      nodeError?: string | null;
      gateId?: string;
    },
  ): void {
    const run = this.deps.crud.getRun(runId);
    if (!run) return;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(run.inputJson || '{}');
    } catch {
      input = {};
    }
    input.pendingDecision = detail.gateId
      ? buildFailurePendingDecision({
          nodeId,
          failureClass,
          nodeError: detail.nodeError ?? null,
          retriesExhausted: detail.retriesExhausted,
          attemptsMade: detail.attemptsMade,
        })
      : {
          type: 'provider',
          id: `provider:${nodeId}`,
          prompt: detail.instruction,
          nodeId,
          failureClass,
          retriesExhausted: detail.retriesExhausted,
          nodeError: detail.nodeError ?? null,
        };
    this.deps.crud.updateRun(runId, { status: 'blocked', inputJson: JSON.stringify(input) });
    this.emit({
      runId,
      type: 'run-blocked-provider',
      nodeId,
      payload: {
        failureClass,
        retriesExhausted: detail.retriesExhausted,
        attemptsMade: detail.attemptsMade,
        nodeError: detail.nodeError ?? null,
        ...(detail.gateId ? { gateId: detail.gateId } : {}),
      },
    });
  }

  private reconnectInstruction(runtime: WorkflowFailureRuntime): string {
    if (runtime === 'codex') return 'Reconecte o Codex em Settings > Provedores e clique em Retomar.';
    return 'A credencial do provedor expirou. Reconecte em Settings > Provedores e clique em Retomar.';
  }

  private markNodeAttemptInterrupted(
    runId: string,
    nodeId: string,
    failureClass: DynamicWorkflowFailureClass,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : (typeof error === 'string' ? error : null);
    const runs = this.deps.crud
      .listNodeRuns(runId)
      .filter((nr) => nr.nodeId === nodeId && nr.status === 'running')
      .sort((a, b) => b.attempt - a.attempt);
    const target = runs[0];
    if (!target) return;
    this.deps.crud.updateNodeRun(target.id, {
      status: 'interrupted',
      failureClass,
      error: message,
      completedAt: this.now(),
    });
  }

  scheduleResume(runId: string, atIso: string): RunnerResult {
    const run = this.deps.crud.getRun(runId);
    if (!run) return err(`run nao encontrado: ${runId}`);
    const at = Date.parse(atIso);
    if (Number.isNaN(at)) return err(`timestamp invalido para retomada agendada: ${atIso}`);
    const delayMs = Math.max(0, at - Date.parse(this.now()));
    this.persistScheduledResumeAt(runId, atIso);
    this.armResumeTimer(runId, delayMs);
    this.emit({ runId, type: 'resume-scheduled', payload: { scheduledResumeAt: atIso } });
    return ok();
  }

  private armScheduledResume(runId: string, delayMs: number, reason: string): void {
    const atIso = this.isoAfter(delayMs);
    this.persistScheduledResumeAt(runId, atIso);
    this.armResumeTimer(runId, delayMs);
    this.emit({ runId, type: 'resume-scheduled', payload: { scheduledResumeAt: atIso, reason } });
  }

  private persistScheduledResumeAt(runId: string, atIso: string): void {
    const run = this.deps.crud.getRun(runId);
    if (!run) return;
    let cp: Record<string, unknown> = {};
    try {
      cp = JSON.parse(run.checkpointJson || '{}');
    } catch {
      cp = {};
    }
    cp.scheduledResumeAt = atIso;
    this.deps.crud.updateRun(runId, { checkpointJson: JSON.stringify(cp) });
  }

  private clearScheduledResumeAt(runId: string): void {
    const run = this.deps.crud.getRun(runId);
    if (!run) return;
    let cp: Record<string, unknown> = {};
    try {
      cp = JSON.parse(run.checkpointJson || '{}');
    } catch {
      cp = {};
    }
    if ('scheduledResumeAt' in cp) {
      delete cp.scheduledResumeAt;
      this.deps.crud.updateRun(runId, { checkpointJson: JSON.stringify(cp) });
    }
  }

  private armResumeTimer(runId: string, delayMs: number): void {
    this.cancelPendingTimer(runId);
    const handle = this.scheduleTimer(delayMs, () => {
      this.pendingTimers.delete(runId);
      this.clearScheduledResumeAt(runId);
      this.emit({ runId, type: 'scheduled-resume-fired', payload: {} });
      void this.resume(runId).catch((e) =>
        logger.warn({ err: e, runId }, 'retomada agendada falhou (ignorado)'),
      );
    });
    this.pendingTimers.set(runId, handle);
  }

  private cancelPendingTimer(runId: string): void {
    const existing = this.pendingTimers.get(runId);
    if (existing) {
      existing.cancel();
      this.pendingTimers.delete(runId);
    }
  }

  private isoAfter(delayMs: number): string {
    return new Date(Date.parse(this.now()) + Math.max(0, delayMs)).toISOString();
  }

  private isPolicyChangedBlock(run: DynamicWorkflowRun): boolean {
    try {
      const input = JSON.parse(run.inputJson || '{}') as {
        pendingDecision?: { policyChanged?: boolean };
      };
      return input.pendingDecision?.policyChanged === true;
    } catch {
      return false;
    }
  }

  private isResumableInfoBlock(run: DynamicWorkflowRun): boolean {
    try {
      const input = JSON.parse(run.inputJson || '{}') as {
        pendingDecision?: { type?: string };
      };
      return input.pendingDecision?.type === 'error' || input.pendingDecision?.type === 'budget';
    } catch {
      return false;
    }
  }

  private acceptInfoBlockOnResume(runId: string): void {
    const run = this.deps.crud.getRun(runId);
    if (!run) return;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(run.inputJson || '{}');
    } catch {
      input = {};
    }
    const pending = input.pendingDecision as { type?: string } | undefined;
    delete input.pendingDecision;
    this.deps.crud.updateRun(runId, {
      status: 'interrupted',
      inputJson: JSON.stringify(input),
      error: null,
    });
    this.emit({
      runId,
      type: 'run-info-block-accepted',
      payload: {
        blockType: pending?.type ?? 'unknown',
      },
    });
  }

  private acceptPolicyChange(runId: string): void {
    const run = this.deps.crud.getRun(runId);
    if (!run) return;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(run.inputJson || '{}');
    } catch {
      input = {};
    }
    delete input.pendingDecision;
    this.deps.crud.updateRun(runId, { status: 'interrupted', inputJson: JSON.stringify(input) });
    this.emit({ runId, type: 'policy-change-accepted', payload: {} });
  }

  detectPolicyInvalidation(
    runId: string,
    resolveOverride?: WorkflowRunnerDeps['resolvePolicyHashForNode'],
  ): { invalidated: string[] } {
    const run = this.deps.crud.getRun(runId);
    if (!run) return { invalidated: [] };
    const resolve = resolveOverride ?? this.deps.resolvePolicyHashForNode;
    if (!resolve) return { invalidated: [] };
    const definition = this.deps.crud.getDefinition(run.definitionId);
    if (!definition) return { invalidated: [] };
    let manifest: DynamicWorkflowManifest;
    try {
      manifest = JSON.parse(definition.manifestJson) as DynamicWorkflowManifest;
    } catch {
      return { invalidated: [] };
    }

    const completedByNode = new Map<string, DynamicWorkflowNodeRun>();
    for (const nr of this.deps.crud.listNodeRuns(runId)) {
      if (nr.status !== 'completed' || !nr.policyHash) continue;
      const prev = completedByNode.get(nr.nodeId);
      if (!prev || nr.attempt > prev.attempt) completedByNode.set(nr.nodeId, nr);
    }

    const invalidated: string[] = [];
    for (const [nodeId, nr] of completedByNode.entries()) {
      const current = resolve({ runId, nodeId, manifest, definition });
      if (current === null || current !== nr.policyHash) {
        invalidated.push(nodeId);
        this.emit({
          runId,
          type: 'cache-invalidated:policy-changed',
          nodeId,
          payload: { previousPolicyHash: nr.policyHash, currentPolicyHash: current },
        });
      }
    }

    if (invalidated.length > 0) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(run.inputJson || '{}');
      } catch {
        input = {};
      }
      input.pendingDecision = {
        type: 'provider',
        id: 'policy-changed',
        prompt:
          'A permissao/config de um ou mais nodes mudou desde a ultima execucao. Aceite reusar os resultados antigos ou reexecute os nodes afetados.',
        policyChanged: true,
        invalidatedNodeIds: invalidated,
      };
      this.deps.crud.updateRun(runId, { status: 'blocked', inputJson: JSON.stringify(input) });
    }
    return { invalidated };
  }

  startStallWatchdog(runId: string, nodeId: string, nodeTimeoutMs?: number): void {
    this.cancelStallWatchdog(runId);
    const delayMs = stallDelayFor(nodeTimeoutMs);
    const handle = this.scheduleTimer(delayMs, () => {
      this.stallTimers.delete(runId);
      const minutes = Math.round(delayMs / 60000);
      logger.warn(
        {
          phase: 'stall-watchdog-fired',
          runId,
          nodeId,
          derivedDelayMs: delayMs,
          derivedDelayMinutes: minutes,
          nodeTimeoutMs: nodeTimeoutMs ?? null,
          floorApplied: !(typeof nodeTimeoutMs === 'number' && nodeTimeoutMs > 0),
        },
        `watchdog de stall disparou para ${nodeId} apos ${minutes}min (net de seguranca)`,
      );
      this.emit({
        runId,
        type: 'node-stalled',
        nodeId,
        payload: { stalledForMs: delayMs, message: `sem progresso ha ${minutes}min` },
      });
      const nodeAbort = this.active.get(runId)?.nodeAborts.get(nodeId);
      if (nodeAbort && !nodeAbort.signal.aborted) {
        nodeAbort.abort();
        return;
      }
      void this.pause(runId).catch((e) =>
        logger.warn({ err: e, runId }, 'pause por stall falhou (ignorado)'),
      );
    });
    this.stallTimers.set(runId, handle);
  }

  pokeStallWatchdog(runId: string, nodeId: string, nodeTimeoutMs?: number): void {
    if (this.stallTimers.has(runId)) this.startStallWatchdog(runId, nodeId, nodeTimeoutMs);
  }

  cancelStallWatchdog(runId: string): void {
    const existing = this.stallTimers.get(runId);
    if (existing) {
      existing.cancel();
      this.stallTimers.delete(runId);
    }
  }

  async switchAgent(
    runId: string,
    nodeId: string,
    newAgentId: string,
    reason: string,
    source: 'human' | 'orchestrator' | 'workflow-orchestrator-agent' = 'human',
    s17Override?: {
      validateSwitchAgent?: WorkflowRunnerDeps['validateSwitchAgent'];
      persistSwitchedDefinition?: WorkflowRunnerDeps['persistSwitchedDefinition'];
    },
  ): Promise<RunnerResult> {
    const run = this.deps.crud.getRun(runId);
    if (!run) return err(`run nao encontrado: ${runId}`);
    const definition = this.deps.crud.getDefinition(run.definitionId);
    if (!definition) return err(`definition nao encontrada: ${run.definitionId}`);

    let manifest: DynamicWorkflowManifest;
    try {
      manifest = JSON.parse(definition.manifestJson) as DynamicWorkflowManifest;
    } catch (e) {
      return err(`manifest invalido: ${e instanceof Error ? e.message : String(e)}`);
    }
    const manifestNode = manifest.nodes.find((n) => n.id === nodeId);
    if (!manifestNode) return err(`node ${nodeId} nao existe no manifest`);

    const nodeRuns = this.deps.crud
      .listNodeRuns(runId)
      .filter((nr) => nr.nodeId === nodeId)
      .sort((a, b) => b.attempt - a.attempt);
    const last = nodeRuns[0];
    if (last && last.status === 'completed') {
      return err(`node ${nodeId} ja concluido; switch-agent so vale para node pendente/interrompido (14.1.1)`);
    }

    const validate = s17Override?.validateSwitchAgent ?? this.deps.validateSwitchAgent;
    if (!validate) return err('switch-agent indisponivel: validador de catalogo/preflight nao configurado');
    const verdict = validate({ nodeId, newAgentId, manifest });
    if (!verdict.exists) {
      return err(verdict.reason ?? `agente ${newAgentId} nao existe no catalogo`);
    }
    if (!verdict.preflightOk) {
      return err(verdict.reason ?? `agente ${newAgentId} nao passa no preflight 8.7 para o node ${nodeId}`);
    }

    if (verdict.expandsPermission) {
      this.emit({
        runId,
        type: 'switch-agent-needs-gate',
        nodeId,
        payload: { newAgentId, reason },
      });
      this.deps.crud.insertGateDecision({
        id: this.generateId('dwfg'),
        runId,
        gateId: `switch-agent:${nodeId}`,
        mode: 'human',
        decision: 'rejected',
        decidedBy: source,
        reason: `switch-agent para ${newAgentId} amplia permissao efetiva: exige gate humano`,
        payloadJson: JSON.stringify({ nodeId, newAgentId, expandsPermission: true }),
      });
      return err(`troca para ${newAgentId} amplia permissao efetiva do node ${nodeId}: requer aprovacao humana (gate)`);
    }

    const persist = s17Override?.persistSwitchedDefinition ?? this.deps.persistSwitchedDefinition;
    if (!persist) return err('switch-agent indisponivel: persistencia de definition nao configurada');
    const { newDefinitionId } = persist({ prevDefinition: definition, nodeId, newAgentId });

    this.emit({
      runId,
      type: 'switch-agent-applied',
      nodeId,
      payload: {
        newAgentId,
        fromDefinitionId: definition.id,
        toDefinitionId: newDefinitionId,
        newVersion: definition.definitionVersion + 1,
        expandsPermission: verdict.expandsPermission,
      },
    });
    this.deps.crud.insertMessage({
      runId,
      nodeId,
      role: 'user',
      source,
      kind: 'switch-agent',
      content: `switch-agent ${nodeId} -> ${newAgentId}: ${reason}`,
    });
    return ok();
  }


  async editCoordinator(
    runId: string,
    input: EditCoordinatorInput,
    source: 'human' | 'orchestrator' | 'workflow-orchestrator-agent' = 'orchestrator',
  ): Promise<EditCoordinatorResult> {
    const run = this.deps.crud.getRun(runId);
    if (!run) return { ok: false, error: `run nao encontrado: ${runId}` };
    const definition = this.deps.crud.getDefinition(run.definitionId);
    if (!definition) {
      return { ok: false, error: `definition nao encontrada: ${run.definitionId}` };
    }

    if (typeof input?.workflowJsSource !== 'string' || input.workflowJsSource.length === 0) {
      return { ok: false, error: 'workflowJsSource obrigatorio (o JS reescrito do coordenador)' };
    }

    if (
      run.status === 'completed' ||
      run.status === 'aborted' ||
      run.status === 'failed' ||
      run.status === 'delivered'
    ) {
      return {
        ok: false,
        error: `editar o coordenador exige o run pausado; o run "${runId}" esta "${run.status}" (encerrado/entregue). Nao ha o que reapontar.`,
      };
    }
    if (run.status === 'running' || this.active.has(runId)) {
      return {
        ok: false,
        error:
          `quiescence: o run "${runId}" ainda esta em execucao. Pause-o (intervene pause) e aguarde o ` +
          'attempt encerrar de fato ANTES de editar o coordenador. Partial output de node interrompido ' +
          'nao entra no journal reutilizavel.',
      };
    }
    const inFlightAttempts = this.deps.crud
      .listNodeRuns(runId)
      .filter((nr) => nr.status === 'running');
    if (inFlightAttempts.length > 0) {
      const ids = inFlightAttempts.map((nr) => nr.nodeId).join(', ');
      return {
        ok: false,
        error:
          `quiescence: ${inFlightAttempts.length} node(s) ainda em voo (${ids}). ` +
          'Aguarde o encerramento real (pause -> attempt interrompido) antes de editar.',
      };
    }

    const materialize = this.deps.materializeEditedPackage;
    const createDef = this.deps.createEditedDefinition;
    const repoint = this.deps.repointRunDefinition;
    if (!materialize || !createDef || !repoint) {
      return {
        ok: false,
        error: 'edicao transacional indisponivel: host de materializacao/definition/reaponte nao configurado',
      };
    }

    const compiled = compileWorkflowJs(input.workflowJsSource);
    if (!compiled.ok) {
      const reasons = compiled.errors.map((er) => er.message).join('; ');
      return { ok: false, error: `compilacao do workflow.js editado falhou: ${reasons}` };
    }

    let prevNodes: DynamicWorkflowManifest['nodes'] = [];
    try {
      const prevManifest = JSON.parse(definition.manifestJson) as DynamicWorkflowManifest;
      prevNodes = Array.isArray(prevManifest?.nodes) ? prevManifest.nodes : [];
    } catch {
      prevNodes = [];
    }
    const manifest: DynamicWorkflowManifest = {
      ...deriveClaudeCodeManifest({
        name: definition.name || compiled.meta.name,
        description:
          typeof compiled.meta.description === 'string'
            ? compiled.meta.description
            : undefined,
        phases: compiled.meta.phases,
      }),
      nodes: prevNodes,
    };
    const manifestJsonRaw = JSON.stringify(manifest, null, 2);

    const schemaFileNames = this.schemaFileNamesForRun(definition);
    const report = validateWorkflowPackage(
      {
        workflowJsSource: input.workflowJsSource,
        manifest,
        catalogAgentIds: this.deps.loadActiveAgentIds?.(),
        schemaFileNames,
      },
      this.now,
    );
    if (!report.ok) {
      const reasons = report.issues
        .filter((i) => i.severity === 'error')
        .map((i) => i.message)
        .join('; ');
      return {
        ok: false,
        error: `pacote editado invalido (secao 15): ${reasons}`,
      };
    }

    const revisionId = this.generateId('rev');
    let materialized: ReturnType<NonNullable<WorkflowRunnerDeps['materializeEditedPackage']>>;
    try {
      materialized = materialize({
        projectPath: definition.projectPath,
        revisionId,
        workflowJsSource: input.workflowJsSource,
        manifestJson: manifestJsonRaw,
        currentWorkflowJsPath: definition.workflowJsPath,
      });
    } catch (e) {
      return {
        ok: false,
        error: `falha ao materializar o pacote editado: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    let created: { newDefinitionId: string };
    try {
      created = createDef({
        prevDefinition: definition,
        revisionId,
        workflowJsPath: materialized.workflowJsPath,
        manifestPath: materialized.manifestPath,
        manifestJson: materialized.manifestJson,
        manifestHash: materialized.manifestHash,
      });
    } catch (e) {
      return {
        ok: false,
        error: `falha ao criar a nova definition version: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    repoint(runId, created.newDefinitionId);

    this.truncateJournalAtCurrentNode(runId);

    this.emit({
      runId,
      type: 'coordinator-edited',
      payload: {
        revisionId,
        fromDefinitionId: definition.id,
        toDefinitionId: created.newDefinitionId,
        newVersion: definition.definitionVersion + 1,
        manifestHash: materialized.manifestHash,
        reason: input.reason,
      },
    });
    this.deps.crud.insertMessage({
      runId,
      role: 'user',
      source,
      kind: 'coordinator-edit',
      content: `edit-coordinator (rev ${revisionId}): ${input.reason}`,
    });

    logger.info(
      {
        runId,
        revisionId,
        fromDefinitionId: definition.id,
        toDefinitionId: created.newDefinitionId,
        manifestHash: materialized.manifestHash,
      },
      'coordenador editado ao vivo (nova revisao auditavel + run re-apontado)',
    );

    return {
      ok: true,
      newDefinitionId: created.newDefinitionId,
      revisionId,
      manifestHash: materialized.manifestHash,
    };
  }

  private truncateJournalAtCurrentNode(runId: string): void {
    const listJournal = this.deps.crud.listJournalEntries;
    const truncate = this.deps.crud.truncateJournalFrom;
    if (!listJournal || !truncate) return;
    const run = this.deps.crud.getRun(runId);
    const currentNodeId = run?.currentNodeId ?? null;
    if (!currentNodeId) return;
    try {
      const entries = listJournal(runId);
      const first = entries.find((e) => e.nodeId === currentNodeId);
      if (first) truncate(runId, first.callIndex);
    } catch (e) {
      logger.warn(
        { err: e, runId, currentNodeId },
        'editCoordinator: falha ao truncar o sufixo do journal (resume cai no replay por revisao)',
      );
    }
  }


  finalize(runId: string): RunnerResult {
    const run = this.deps.crud.getRun(runId);
    if (run?.status === 'completed') {
      this.active.delete(runId);
      return ok();
    }
    const closerDeps = this.buildFinalizeDeps(runId);
    try {
      closerFinalize(runId, closerDeps);
      this.active.delete(runId);
      return ok();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(message);
    }
  }

  private buildFinalizeDeps(_runId: string): CloserEngineDeps {
    return {
      getRun: this.deps.crud.getRun,
      updateRun: this.deps.crud.updateRun,
      insertMessage: this.deps.crud.insertMessage,
      listMessages: this.deps.crud.listMessages,
      recentEvents: this.deps.crud.recentEvents,
      costAggregate: this.deps.crud.costAggregate,
      runAgentTurn: async () => ({ ok: true, output: '' }),
      emitEvent: (input) => this.emit(input),
      releaseRunLock: (id) => releaseRunLock(id),
      now: this.now,
    };
  }


  getSnapshot(runId: string): import('./types').DynamicWorkflowSnapshot | null {
    const run = this.deps.crud.getRun(runId);
    if (!run) return null;
    const definition = this.deps.crud.getDefinition(run.definitionId);
    const repoPath = definition?.projectPath ?? '';
    const snapDeps: SnapshotDeps = {
      getRun: this.deps.crud.getRun,
      recentEvents: this.deps.crud.recentEvents,
      costAggregate: this.deps.crud.costAggregate,
      listEventsSince: this.deps.crud.listEventsSince,
    };
    return buildSnapshot(runId, repoPath, snapDeps);
  }


  recoverInterrupted(): { recovered: number; rearmed: number } {
    const running = this.deps.crud.listRunsByStatus('running');
    let recovered = 0;
    for (const run of running) {
      try {
        this.markRunningAttemptsInterrupted(run.id);
        this.deps.crud.setRunStatus(run.id, 'interrupted');
        this.emit({ runId: run.id, type: 'run-interrupted-recovery', payload: {} });
        recovered += 1;
      } catch (e) {
        logger.warn({ err: e, runId: run.id }, 'falha ao recuperar run no boot (ignorado)');
      }
    }
    const rearmed = this.rearmScheduledResumes();
    if (recovered > 0 || rearmed > 0) {
      logger.info({ recovered, rearmed }, 'boot recovery: running -> interrupted + retomadas agendadas re-armadas');
    }
    return { recovered, rearmed };
  }

  private rearmScheduledResumes(): number {
    let rearmed = 0;
    const candidateStatuses: DynamicWorkflowRunStatus[] = ['blocked', 'interrupted', 'paused'];
    const seen = new Set<string>();
    for (const status of candidateStatuses) {
      for (const run of this.deps.crud.listRunsByStatus(status)) {
        if (seen.has(run.id)) continue;
        seen.add(run.id);
        let cp: { scheduledResumeAt?: unknown };
        try {
          cp = JSON.parse(run.checkpointJson || '{}');
        } catch {
          continue;
        }
        const at = typeof cp.scheduledResumeAt === 'string' ? Date.parse(cp.scheduledResumeAt) : NaN;
        if (Number.isNaN(at)) continue;
        const delayMs = Math.max(0, at - Date.parse(this.now()));
        this.armResumeTimer(run.id, delayMs);
        this.emit({ runId: run.id, type: 'resume-rearmed', payload: { scheduledResumeAt: cp.scheduledResumeAt, delayMs } });
        rearmed += 1;
      }
    }
    return rearmed;
  }


  private markRunningAttempts(runId: string, status: 'interrupted' | 'cancelled'): void {
    for (const nr of this.deps.crud.listNodeRuns(runId)) {
      if (nr.status === 'running') {
        this.deps.crud.updateNodeRun(nr.id, { status, completedAt: this.now() });
      }
    }
  }

  private markRunningAttemptsInterrupted(runId: string): void {
    this.markRunningAttempts(runId, 'interrupted');
  }

  private rejectPendingGates(state: ActiveRunState): void {
    for (const [gateId, resolver] of state.gateResolvers.entries()) {
      resolver({ decision: 'reject', approvedBy: 'abort', reason: 'run abortado' });
      state.gateResolvers.delete(gateId);
    }
  }

  private async recordIntervention(
    runId: string,
    intervention: import('./types').DynamicWorkflowIntervention,
    source: string,
  ): Promise<void> {
    this.emit({
      runId,
      type: 'intervention',
      payload: { type: intervention.type, source },
    });
  }

  private failRun(runId: string, message: string): void {
    try {
      this.deps.crud.updateRun(runId, {
        status: 'failed',
        error: message,
        completedAt: this.now(),
      });
      this.emit({ runId, type: 'run-failed', payload: { error: message } });
    } catch (e) {
      logger.error({ err: e, runId, message }, 'falha ao marcar run como failed');
    }
    this.active.delete(runId);
    releaseRunLock(runId);
  }

  private hostCrud(): HostApiCrud {
    return {
      upsertNodeRun: this.deps.crud.upsertNodeRun,
      updateNodeRun: this.deps.crud.updateNodeRun,
      insertEvent: this.deps.crud.insertEvent,
      insertGateDecision: this.deps.crud.insertGateDecision,
      registerArtifact: this.deps.crud.registerArtifact,
      insertMessage: this.deps.crud.insertMessage,
      listEventsSince: this.deps.crud.listEventsSince,
      getRunCheckpoint: (runId) => this.deps.crud.getRun(runId)?.checkpointJson ?? null,
      persistRunCheckpoint: (runId, checkpointJson) =>
        this.deps.crud.updateRun(runId, { checkpointJson }),
      addRunCost: (runId, addUsd, addDurationMs) => {
        const run = this.deps.crud.getRun(runId);
        if (!run) return;
        this.deps.crud.updateRun(runId, {
          totalCostUsd: run.totalCostUsd + addUsd,
          totalDurationMs: run.totalDurationMs + addDurationMs,
        });
      },
      patchRun: (runId, patch: HostRunPatch) => {
        const runPatch: DynamicWorkflowRunPatch = {};
        if (patch.status !== undefined) runPatch.status = patch.status;
        if (patch.currentPhaseId !== undefined) runPatch.currentPhaseId = patch.currentPhaseId;
        if (patch.currentNodeId !== undefined) runPatch.currentNodeId = patch.currentNodeId;
        if (patch.error !== undefined) runPatch.error = patch.error;
        if (patch.pendingDecisionJson !== undefined) {
          const run = this.deps.crud.getRun(runId);
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(run?.inputJson || '{}');
          } catch {
            input = {};
          }
          const pd = JSON.parse(patch.pendingDecisionJson) as { pendingDecision?: unknown };
          if (pd.pendingDecision) input.pendingDecision = pd.pendingDecision;
          else delete input.pendingDecision;
          runPatch.inputJson = JSON.stringify(input);
        }
        this.deps.crud.updateRun(runId, runPatch);
      },
      materializeSprintPlan: this.deps.crud.materializeSprintPlan,
      createNodes: this.deps.crud.createNodes,
      updateDefinition: this.deps.crud.updateDefinition,
      persistSprints: this.deps.crud.persistSprints,
      setNodeSprintMeta: this.deps.crud.setNodeSprintMeta,
      appendJournalEntry: this.deps.crud.appendJournalEntry,
      listJournalEntries: this.deps.crud.listJournalEntries,
      truncateJournalFrom: this.deps.crud.truncateJournalFrom,
      claimAdjustmentsForNode: this.deps.crud.claimAdjustmentsForNode,
      getConsumedAdjustmentsForNode: this.deps.crud.getConsumedAdjustmentsForNode,
    };
  }

  private readSprintPlanConfig(state: ActiveRunState): {
    maxDevRounds?: number;
    maxPlanRounds?: number;
  } {
    let fromInput: { maxDevRounds?: number; maxPlanRounds?: number } = {};
    try {
      const run = this.deps.crud.getRun(state.runId);
      const input = JSON.parse(run?.inputJson || '{}') as {
        sprintPlan?: { maxDevRounds?: number; maxPlanRounds?: number };
      };
      if (input.sprintPlan && typeof input.sprintPlan === 'object') {
        fromInput = input.sprintPlan;
      }
    } catch {
      fromInput = {};
    }
    const manifestCfg = state.manifest.sprintPlan;
    const clampCeil = (n: number): number => Math.min(n, MAX_DEV_ROUNDS_CEILING);
    const pick = (key: 'maxDevRounds' | 'maxPlanRounds'): number | undefined => {
      const fromIn = fromInput[key];
      if (typeof fromIn === 'number' && Number.isFinite(fromIn) && fromIn >= 1) return clampCeil(fromIn);
      const fromManifest = manifestCfg?.[key];
      if (typeof fromManifest === 'number' && Number.isFinite(fromManifest) && fromManifest >= 1) {
        return clampCeil(fromManifest);
      }
      return undefined;
    };
    const result: { maxDevRounds?: number; maxPlanRounds?: number } = {};
    const dev = pick('maxDevRounds');
    const plan = pick('maxPlanRounds');
    if (dev !== undefined) result.maxDevRounds = dev;
    if (plan !== undefined) result.maxPlanRounds = plan;
    return result;
  }

  private readRunCtxState(state: ActiveRunState): {
    input: Record<string, unknown>;
  } {
    let input: Record<string, unknown> = {};
    try {
      const run = this.deps.crud.getRun(state.runId);
      const parsed = JSON.parse(run?.inputJson || '{}') as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      input = {};
    }
    return { input };
  }

  private runDirOf(projectPath: string, runId: string): string {
    return join(projectPath, '.lionclaw', 'workflows', runId);
  }

  private resolveSchemaRefForRun(
    definition: DynamicWorkflowDefinition,
    schemaRef: string,
  ): ReturnType<typeof jsonSchemaToOutputSchema> {
    if (!schemaRef) return null;
    const slash = schemaRef.lastIndexOf('/');
    const basename = slash >= 0 ? schemaRef.slice(slash + 1) : schemaRef;
    if (!basename || basename.includes('..')) return null;
    const schemaPath = join(dirname(definition.workflowJsPath), SCHEMAS_SUBDIR, basename);
    try {
      const raw = JSON.parse(readFileSync(schemaPath, 'utf8')) as unknown;
      return jsonSchemaToOutputSchema(raw, basename);
    } catch (err) {
      logger.warn(
        { err, schemaRef, schemaPath },
        'resolveSchemaRef: schema ilegivel/inexistente; node segue com texto cru',
      );
      return null;
    }
  }

  private schemaFileNamesForRun(definition: DynamicWorkflowDefinition): string[] {
    const schemasDir = join(dirname(definition.workflowJsPath), SCHEMAS_SUBDIR);
    try {
      return readdirSync(schemasDir).filter((f) => f.endsWith('.json'));
    } catch (err) {
      logger.warn(
        { err, schemasDir },
        'schemaFileNamesForRun: dir de schemas ilegivel; materializacao sem nomes de schema',
      );
      return [];
    }
  }

  private resolveWallTimeoutMs(): number | undefined {
    const get = this.deps.getWallTimeoutMs;
    if (!get) return undefined;
    try {
      const value = get();
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
      return Math.floor(value);
    } catch (err) {
      logger.warn({ err }, 'getWallTimeoutMs lancou; run segue SEM teto de wall-clock');
      return undefined;
    }
  }

  private idleTimeoutMs(): number {
    return 30 * 60 * 1000;
  }

  private defaultFactory(): SandboxProcessFactory {
    const entry = this.deps.sandboxChildEntry?.() ?? this.defaultChildEntry();
    return createUtilityProcessFactory(entry);
  }

  private defaultChildEntry(): string {
    let appPath: string | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const electron = require('electron') as { app?: { getAppPath?: () => string } };
      appPath = electron.app?.getAppPath?.();
    } catch {
      appPath = undefined;
    }
    return resolveSandboxChildEntry(__dirname, appPath);
  }
}

export function resolveSandboxChildEntry(
  dirName: string,
  appPath?: string,
  existsCheck: (p: string) => boolean = existsSync,
): string {
  const candidates: string[] = [];
  const pushUnpackedVariant = (p: string): void => {
    if (
      p.includes(ASAR_SEGMENT_POSIX) ||
      p.includes(ASAR_SEGMENT_WIN) ||
      p.endsWith(ASAR_SEGMENT)
    ) {
      candidates.push(p.replace(ASAR_SEGMENT, ASAR_UNPACKED_SEGMENT));
    }
    candidates.push(p);
  };

  pushUnpackedVariant(join(dirName, SANDBOX_CHILD_ENTRY_BASENAME));

  if (typeof appPath === 'string' && appPath.length > 0) {
    pushUnpackedVariant(resolve(appPath, DIST_MAIN_SUBDIR, SANDBOX_CHILD_ENTRY_BASENAME));
  }

  for (const candidate of candidates) {
    if (existsCheck(candidate)) return candidate;
  }
  return candidates[0];
}

const DIST_MAIN_SUBDIR = join('dist', 'main');
const ASAR_SEGMENT = 'app.asar';
const ASAR_UNPACKED_SEGMENT = 'app.asar.unpacked';
const ASAR_SEGMENT_POSIX = 'app.asar/';
const ASAR_SEGMENT_WIN = 'app.asar\\';

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return 'null';
  }
}

const FAILURE_RUNTIMES: ReadonlySet<WorkflowFailureRuntime> = new Set([
  'cloud',
  'local',
  'external',
  'codex',
  'kimi',
  'grok',
  'zai',
  'minimax-tp',
  'cursor',
]);

const FAILURE_CLASSES: ReadonlySet<DynamicWorkflowFailureClass> = new Set(
  DYNAMIC_WORKFLOW_FAILURE_CLASSES,
);

function coerceFailureRuntime(runtime: string): WorkflowFailureRuntime {
  return FAILURE_RUNTIMES.has(runtime as WorkflowFailureRuntime)
    ? (runtime as WorkflowFailureRuntime)
    : 'cloud';
}


let singleton: WorkflowRunner | null = null;

export function getWorkflowRunner(deps?: WorkflowRunnerDeps): WorkflowRunner {
  if (!singleton) {
    if (!deps) {
      throw new Error('WorkflowRunner ainda nao inicializado: forneca deps na primeira chamada');
    }
    singleton = new WorkflowRunner(deps);
  }
  return singleton;
}

export function getWorkflowRunnerIfInitialized(): WorkflowRunner | null {
  return singleton;
}

export function _resetWorkflowRunnerForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error('_resetWorkflowRunnerForTesting so pode ser chamado em ambiente de teste');
  }
  singleton = null;
}

export function recoverInterruptedRuns(runner?: WorkflowRunner): { recovered: number; rearmed: number } {
  const r = runner ?? singleton;
  if (!r) {
    logger.warn('recoverInterruptedRuns chamado antes do runner ser inicializado (no-op)');
    return { recovered: 0, rearmed: 0 };
  }
  return r.recoverInterrupted();
}

export { broadcastWorkflowStreamChunk };
