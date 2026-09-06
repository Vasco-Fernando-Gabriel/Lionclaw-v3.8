
import {
  createCloserPermissionGuard,
  type CloserGitConfirmRequest,
  type CloserGitAuditEvent,
} from './closer-permission-guard';
import { createComposedCanUseTool } from './workflow-agent-adapter';
import { deriveNodeExecutionPolicy } from './workflow-policy';
import { preflightNode } from './workflow-preflight';
import { WorkflowPathGuard } from './workflow-path-guard';
import {
  squashMergePostGate,
  finalizeStagedMerge,
  branchTipSha,
  type GitRunner,
  type MergeOutcome,
} from './workflow-git';
import { cleanupSprintWorktree } from './workflow-worktree';
import type {
  ComposedToolInput,
  ToolDecision,
} from './workflow-agent-adapter';
import type {
  DynamicWorkflowRun,
  DynamicWorkflowRunPatch,
  DynamicWorkflowMessageInsertInput,
  DynamicWorkflowMessage,
  DynamicWorkflowEvent,
  DynamicWorkflowRunCostAggregate,
  DynamicWorkflowSprintMergeStatus,
  DynamicWorkflowSprintPatch,
} from './types';


export type CloserSpawnReason =
  | 'delivery'
  | 'merge-conflict'
  | 'gate-failed'
  | 'user-request'
  | 'broken-state';


export interface CloserNodeDiff {
  nodeId: string;
  attempt: number;
  files: string[];
  summary?: string;
}

export interface CloserSpawnContext {
  reason: CloserSpawnReason;
  motive: string;
  nodeDiffs?: CloserNodeDiff[];
  deliveryReport?: string;
  lastCheckpointSummary?: string;
  recentEventsLimit?: number;
}


export interface CloserTurnResult {
  ok: boolean;
  output: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  model?: string;
  errorMessage?: string;
}

export type CloserAgentTurnRunner = (input: {
  runId: string;
  agentId: string;
  prompt: string;
  cwd: string;
  canUseTool: (input: ComposedToolInput) => Promise<ToolDecision>;
}) => Promise<CloserTurnResult>;


export interface CloserEngineDeps {
  getRun: (runId: string) => DynamicWorkflowRun | null;
  updateRun: (runId: string, patch: DynamicWorkflowRunPatch) => void;
  insertMessage: (
    input: DynamicWorkflowMessageInsertInput,
  ) => DynamicWorkflowMessage;
  listMessages: (runId: string) => DynamicWorkflowMessage[];
  recentEvents: (runId: string, limit: number) => DynamicWorkflowEvent[];
  costAggregate: (runId: string) => DynamicWorkflowRunCostAggregate;
  resolveCloserRuntime?: (agentId: string) => string;
  runAgentTurn: CloserAgentTurnRunner;
  confirmGitWrite?: (req: CloserGitConfirmRequest) => Promise<boolean> | boolean;
  auditGit?: (event: CloserGitAuditEvent) => void;
  emitEvent?: (input: {
    runId: string;
    type: string;
    payload?: unknown;
  }) => void;
  releaseRunLock?: (runId: string) => void;
  newSessionId?: () => string;
  now?: () => string;
}


export class CloserError extends Error {
  constructor(
    message: string,
    readonly code: CloserErrorCode,
  ) {
    super(message);
    this.name = 'CloserError';
  }
}

export type CloserErrorCode =
  | 'run-not-found'
  | 'closer-not-guard-capable'
  | 'finalize-not-delivered'
  | 'session-not-active';


export const DYNAMIC_WORKFLOW_CLOSER_AGENT_ID = 'dynamic-workflow-closer';

function defaultNow(): string {
  return new Date().toISOString();
}

let sessionCounter = 0;
function defaultSessionId(): string {
  sessionCounter += 1;
  return `closer-${Date.now().toString(36)}-${sessionCounter.toString(36)}`;
}


export function buildCloserCanUseTool(params: {
  runId: string;
  workspaceCwd: string;
  confirmGitWrite?: (req: CloserGitConfirmRequest) => Promise<boolean> | boolean;
  auditGit?: (event: CloserGitAuditEvent) => void;
}): (input: ComposedToolInput) => Promise<ToolDecision> {
  const policy = deriveNodeExecutionPolicy(
    { allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], mcpServers: [], runtime: 'cloud' },
    {
      nodeId: `closer:${params.runId}`,
      agentId: DYNAMIC_WORKFLOW_CLOSER_AGENT_ID,
      access: 'workspace-write',
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
    },
    { runId: params.runId, workspaceRoot: params.workspaceCwd, cwd: params.workspaceCwd },
    'canUseTool',
  );
  const pathGuard = new WorkflowPathGuard({ workspaceRoot: params.workspaceCwd });
  const composedDelegate = createComposedCanUseTool(policy, pathGuard);

  return createCloserPermissionGuard({
    runId: params.runId,
    workspaceCwd: params.workspaceCwd,
    confirmGitWrite: params.confirmGitWrite,
    auditGit: params.auditGit,
    delegate: (input) => composedDelegate(input),
  });
}


export function resolveCloserCwd(params: {
  run: DynamicWorkflowRun;
  reason: CloserSpawnReason;
  repoRoot: string;
}): string {
  const { run, reason, repoRoot } = params;
  if (run.workspaceMode === 'fresh-project') {
    return repoRoot;
  }
  const mergeFriction = reason === 'merge-conflict' || reason === 'gate-failed';
  if (mergeFriction && run.worktreePath) {
    return run.worktreePath;
  }
  return repoRoot;
}


function roleLabel(message: DynamicWorkflowMessage): string {
  if (message.source === 'human') return 'Usuario';
  if (message.source === 'closer') return 'Closer';
  if (message.source === 'runner') return 'Sistema';
  return message.source;
}

export function buildCloserTurnPrompt(params: {
  run: DynamicWorkflowRun;
  cost: DynamicWorkflowRunCostAggregate;
  recentEvents: DynamicWorkflowEvent[];
  context: CloserSpawnContext;
  history: DynamicWorkflowMessage[];
}): string {
  const { run, cost, recentEvents, context, history } = params;
  const lines: string[] = [];

  lines.push('## Contexto da entrega');
  lines.push(`Run: ${run.id}`);
  lines.push(`Status: ${run.status}`);
  lines.push(`Modo de workspace: ${run.workspaceMode ?? 'desconhecido'}`);
  lines.push(`Motivo do fechamento: ${context.reason}`);
  lines.push(`Custo acumulado do run: USD ${cost.totalCostUsd.toFixed(4)}`);
  lines.push('');
  lines.push('### Motivo / walkthrough');
  lines.push(context.motive);

  if (context.deliveryReport) {
    lines.push('');
    lines.push('### Delivery report');
    lines.push(context.deliveryReport);
  }

  if (context.lastCheckpointSummary) {
    lines.push('');
    lines.push('### Ultimo checkpoint');
    lines.push(context.lastCheckpointSummary);
  }

  if (context.nodeDiffs && context.nodeDiffs.length > 0) {
    lines.push('');
    lines.push('### Diff por node');
    for (const d of context.nodeDiffs) {
      const files = d.files.length > 0 ? d.files.join(', ') : '(nenhum arquivo)';
      lines.push(`- ${d.nodeId} (attempt ${d.attempt}): ${files}`);
      if (d.summary) lines.push(`  ${d.summary}`);
    }
  }

  if (recentEvents.length > 0) {
    lines.push('');
    lines.push('### Eventos recentes');
    for (const ev of recentEvents) {
      lines.push(`- [${ev.seq}] ${ev.type}`);
    }
  }

  if (history.length > 0) {
    lines.push('');
    lines.push('## Conversa');
    for (const m of history) {
      lines.push(`${roleLabel(m)}: ${m.content}`);
    }
  }

  return lines.join('\n');
}


function sumTurnCostToRun(
  deps: CloserEngineDeps,
  run: DynamicWorkflowRun,
  turn: CloserTurnResult,
): void {
  const addUsd = turn.costUsd ?? 0;
  if (addUsd <= 0) return;
  deps.updateRun(run.id, {
    totalCostUsd: run.totalCostUsd + addUsd,
  });
}


function assertCloserGuardCapable(
  deps: CloserEngineDeps,
  agentId: string,
): void {
  const runtime = deps.resolveCloserRuntime
    ? deps.resolveCloserRuntime(agentId)
    : 'cloud';
  const pre = preflightNode({
    grants: { nodeId: `closer:${agentId}`, agentId, access: 'workspace-write' },
    runtime,
    role: 'closer',
  });
  if (!pre.ok) {
    throw new CloserError(pre.message, 'closer-not-guard-capable');
  }
}


export interface CloserSessionResult {
  sessionId: string;
  message: DynamicWorkflowMessage;
  addedCostUsd: number;
}

export async function openCloserSession(
  runId: string,
  context: CloserSpawnContext,
  deps: CloserEngineDeps,
  options: { repoRoot: string; agentId?: string },
): Promise<CloserSessionResult> {
  const newSessionId = deps.newSessionId ?? defaultSessionId;
  const agentId = options.agentId ?? DYNAMIC_WORKFLOW_CLOSER_AGENT_ID;

  const run = deps.getRun(runId);
  if (!run) {
    throw new CloserError(`run ${runId} nao encontrado`, 'run-not-found');
  }

  assertCloserGuardCapable(deps, agentId);

  const sessionId = run.closerSessionId ?? newSessionId();
  const cwd = resolveCloserCwd({ run, reason: context.reason, repoRoot: options.repoRoot });

  deps.updateRun(runId, {
    closerSessionId: sessionId,
    closerStatus: 'active',
  });

  deps.emitEvent?.({
    runId,
    type: 'closer-opened',
    payload: { sessionId, reason: context.reason, cwd },
  });

  const result = await runCloserTurnInternal({
    runId,
    agentId,
    cwd,
    context,
    incomingMessage: null, // o motive ja esta no contexto; nao duplica como msg.
    deps,
  });

  return { sessionId, message: result.message, addedCostUsd: result.addedCostUsd };
}

export async function sendCloserMessage(
  runId: string,
  message: string,
  context: CloserSpawnContext,
  deps: CloserEngineDeps,
  options: { repoRoot: string; agentId?: string },
): Promise<CloserSessionResult> {
  const agentId = options.agentId ?? DYNAMIC_WORKFLOW_CLOSER_AGENT_ID;
  const run = deps.getRun(runId);
  if (!run) {
    throw new CloserError(`run ${runId} nao encontrado`, 'run-not-found');
  }
  if (run.closerStatus !== 'active') {
    throw new CloserError(
      `sessao do closer do run ${runId} nao esta ativa (closer_status=${run.closerStatus ?? 'null'})`,
      'session-not-active',
    );
  }
  assertCloserGuardCapable(deps, agentId);

  const cwd = resolveCloserCwd({ run, reason: context.reason, repoRoot: options.repoRoot });

  const result = await runCloserTurnInternal({
    runId,
    agentId,
    cwd,
    context,
    incomingMessage: message,
    deps,
  });

  return {
    sessionId: run.closerSessionId ?? '',
    message: result.message,
    addedCostUsd: result.addedCostUsd,
  };
}

export function finalizeWorkflow(runId: string, deps: CloserEngineDeps): void {
  const now = deps.now ?? defaultNow;
  const run = deps.getRun(runId);
  if (!run) {
    throw new CloserError(`run ${runId} nao encontrado`, 'run-not-found');
  }
  if (run.status !== 'delivered') {
    throw new CloserError(
      `finalize so e valido com o run em 'delivered' (status atual: ${run.status})`,
      'finalize-not-delivered',
    );
  }

  const ts = now();
  deps.updateRun(runId, {
    status: 'completed',
    closerStatus: 'closed',
    finalizedAt: ts,
    completedAt: ts,
  });

  deps.emitEvent?.({
    runId,
    type: 'workflow-finalized',
    payload: { finalizedAt: ts },
  });

  deps.releaseRunLock?.(runId);
}


interface RunCloserTurnInternalInput {
  runId: string;
  agentId: string;
  cwd: string;
  context: CloserSpawnContext;
  incomingMessage: string | null;
  deps: CloserEngineDeps;
}

interface RunCloserTurnInternalResult {
  message: DynamicWorkflowMessage;
  addedCostUsd: number;
}

async function runCloserTurnInternal(
  input: RunCloserTurnInternalInput,
): Promise<RunCloserTurnInternalResult> {
  const { runId, agentId, cwd, context, incomingMessage, deps } = input;

  if (incomingMessage !== null) {
    deps.insertMessage({
      runId,
      nodeId: null,
      role: 'user',
      source: 'human',
      kind: 'text',
      content: incomingMessage,
    });
  }

  const run = deps.getRun(runId);
  if (!run) {
    throw new CloserError(`run ${runId} sumiu durante o turno do closer`, 'run-not-found');
  }
  const cost = deps.costAggregate(runId);
  const recentEvents = deps.recentEvents(runId, context.recentEventsLimit ?? 20);
  const history = deps.listMessages(runId);

  const prompt = buildCloserTurnPrompt({ run, cost, recentEvents, context, history });

  const canUseTool = buildCloserCanUseTool({
    runId,
    workspaceCwd: cwd,
    confirmGitWrite: deps.confirmGitWrite,
    auditGit: deps.auditGit,
  });

  const turn = await deps.runAgentTurn({
    runId,
    agentId,
    prompt,
    cwd,
    canUseTool,
  });

  const runForCost = deps.getRun(runId) ?? run;
  sumTurnCostToRun(deps, runForCost, turn);

  const content = turn.ok
    ? turn.output
    : `[closer indisponivel: ${turn.errorMessage ?? 'erro desconhecido'}]`;
  const message = deps.insertMessage({
    runId,
    nodeId: null,
    role: 'assistant',
    source: 'closer',
    kind: 'text',
    content,
    agentId,
  });

  deps.emitEvent?.({
    runId,
    type: 'closer-turn',
    payload: { ok: turn.ok, addedCostUsd: turn.costUsd ?? 0 },
  });

  return { message, addedCostUsd: turn.costUsd ?? 0 };
}


export interface SprintMergeTarget {
  sprintId: string;
  index: number;
  branch: string;
  baseSha: string;
  worktreePath: string | null;
  deliverySummary?: string;
}

export interface SprintMergeResult {
  sprintId: string;
  index: number;
  mergeStatus: DynamicWorkflowSprintMergeStatus;
  outcome?: MergeOutcome;
  conflictPaths?: string[];
}

export interface OrderedMergeReport {
  sprints: SprintMergeResult[];
  allMerged: boolean;
  conflictedSprintId?: string;
}

export interface OrderedMergeDeps {
  repoRoot: string;
  baseBranch: string;
  name: string;
  runId: string;
  transientPaths?: string[];
  updateSprintMerge: (
    runId: string,
    sprintId: string,
    patch: DynamicWorkflowSprintPatch,
  ) => void;
  emitEvent?: (input: { runId: string; type: string; payload?: unknown }) => void;
  runStagedRechecks?: (sprintId: string) => Promise<boolean>;
  git?: GitRunner;
  cleanupSprint?: (input: {
    repoRoot: string;
    worktreePath: string;
    runId: string;
    sprintIndex: number;
  }) => Promise<void>;
}

export async function mergeSprintsOrdered(
  targets: readonly SprintMergeTarget[],
  deps: OrderedMergeDeps,
): Promise<OrderedMergeReport> {
  const git = deps.git;
  const cleanup =
    deps.cleanupSprint ??
    ((input) =>
      cleanupSprintWorktree(
        {
          repoRoot: input.repoRoot,
          worktreePath: input.worktreePath,
          runId: input.runId,
          sprintIndex: input.sprintIndex,
        },
        git,
      ));
  const ordered = [...targets].sort((a, b) => a.index - b.index);
  const results: SprintMergeResult[] = [];
  let conflictedSprintId: string | undefined;

  for (const sprint of ordered) {
    if (!sprint.branch || !sprint.worktreePath) {
      deps.updateSprintMerge(deps.runId, sprint.sprintId, { mergeStatus: 'skipped' });
      results.push({ sprintId: sprint.sprintId, index: sprint.index, mergeStatus: 'skipped' });
      continue;
    }

    deps.updateSprintMerge(deps.runId, sprint.sprintId, { mergeStatus: 'merging' });
    deps.emitEvent?.({
      runId: deps.runId,
      type: 'sprint-merge-start',
      payload: { sprintId: sprint.sprintId, branch: sprint.branch },
    });

    let outcome: MergeOutcome;
    try {
      outcome = await squashMergePostGate(
        {
          cwd: deps.repoRoot,
          baseBranch: deps.baseBranch,
          runBranch: sprint.branch,
          baseCommitSha: sprint.baseSha,
          name: deps.name,
          deliverySummary: sprint.deliverySummary ?? `entrega da sprint ${sprint.sprintId}`,
          runId: deps.runId,
          stagingBranch: `dynworkflow-staging/${deps.runId}/s${sprint.index}`,
          transientPaths: deps.transientPaths,
        },
        git,
      );
    } catch (err) {
      deps.updateSprintMerge(deps.runId, sprint.sprintId, { mergeStatus: 'conflict' });
      results.push({
        sprintId: sprint.sprintId,
        index: sprint.index,
        mergeStatus: 'conflict',
        conflictPaths: [],
      });
      conflictedSprintId = sprint.sprintId;
      deps.emitEvent?.({
        runId: deps.runId,
        type: 'sprint-merge-conflict',
        payload: { sprintId: sprint.sprintId, error: err instanceof Error ? err.message : String(err) },
      });
      break;
    }

    if (outcome.kind === 'conflict') {
      deps.updateSprintMerge(deps.runId, sprint.sprintId, { mergeStatus: 'conflict' });
      results.push({
        sprintId: sprint.sprintId,
        index: sprint.index,
        mergeStatus: 'conflict',
        outcome,
        conflictPaths: outcome.conflictPaths,
      });
      conflictedSprintId = sprint.sprintId;
      deps.emitEvent?.({
        runId: deps.runId,
        type: 'sprint-merge-conflict',
        payload: { sprintId: sprint.sprintId, conflictPaths: outcome.conflictPaths },
      });
      break;
    }

    if (outcome.kind === 'staged') {
      deps.emitEvent?.({
        runId: deps.runId,
        type: 'sprint-merge-staged',
        payload: { sprintId: sprint.sprintId, stagingSha: outcome.stagingSha },
      });
      const rechecksGreen = deps.runStagedRechecks
        ? await deps.runStagedRechecks(sprint.sprintId)
        : true;
      if (!rechecksGreen) {
        deps.updateSprintMerge(deps.runId, sprint.sprintId, { mergeStatus: 'conflict' });
        results.push({
          sprintId: sprint.sprintId,
          index: sprint.index,
          mergeStatus: 'conflict',
          outcome,
        });
        conflictedSprintId = sprint.sprintId;
        deps.emitEvent?.({
          runId: deps.runId,
          type: 'sprint-merge-recheck-failed',
          payload: { sprintId: sprint.sprintId },
        });
        break;
      }
      try {
        await finalizeStagedMerge(
          { cwd: deps.repoRoot, baseBranch: deps.baseBranch, stagingSha: outcome.stagingSha },
          git,
        );
      } catch (err) {
        deps.updateSprintMerge(deps.runId, sprint.sprintId, { mergeStatus: 'conflict' });
        results.push({
          sprintId: sprint.sprintId,
          index: sprint.index,
          mergeStatus: 'conflict',
          outcome,
        });
        conflictedSprintId = sprint.sprintId;
        deps.emitEvent?.({
          runId: deps.runId,
          type: 'sprint-merge-conflict',
          payload: {
            sprintId: sprint.sprintId,
            error: err instanceof Error ? err.message : String(err),
          },
        });
        break;
      }
    }

    const headSha = await branchTipSha(deps.repoRoot, deps.baseBranch, git);
    deps.updateSprintMerge(deps.runId, sprint.sprintId, {
      mergeStatus: 'merged',
      headSha: headSha ?? sprint.baseSha,
    });
    results.push({
      sprintId: sprint.sprintId,
      index: sprint.index,
      mergeStatus: 'merged',
      outcome,
    });
    deps.emitEvent?.({
      runId: deps.runId,
      type: 'sprint-merged',
      payload: { sprintId: sprint.sprintId, kind: outcome.kind },
    });

    try {
      await cleanup({
        repoRoot: deps.repoRoot,
        worktreePath: sprint.worktreePath,
        runId: deps.runId,
        sprintIndex: sprint.index,
      });
    } catch {
    }
  }

  const allMerged =
    conflictedSprintId === undefined &&
    results.every((r) => r.mergeStatus === 'merged' || r.mergeStatus === 'skipped');

  return { sprints: results, allMerged, conflictedSprintId };
}
