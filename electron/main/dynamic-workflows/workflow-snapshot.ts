import { createLogger } from '../logger';
import type {
  DynamicWorkflowSnapshot,
  DynamicWorkflowPendingDecisionType,
  DynamicWorkflowRun,
  DynamicWorkflowEvent,
  DynamicWorkflowRunCostAggregate,
} from './types';
import { computeSinceStats, deriveOutcomesSince, eventsSince, findWindowStartSeq } from './workflow-outcome';
import { toLocalShort } from './local-time';

const logger = createLogger('dynamic-workflow-snapshot');

export const SNAPSHOT_RECENT_EVENTS_DEFAULT = 12;

export interface DynamicWorkflowPendingDecisionState {
  type: DynamicWorkflowPendingDecisionType;
  id: string;
  prompt: string;
}

interface RunInputJsonShape {
  pendingDecision?: {
    type?: string;
    id?: string;
    prompt?: string;
  };
}

export interface SnapshotDeps {
  getRun: (runId: string) => DynamicWorkflowRun | null;
  recentEvents: (runId: string, limit: number) => DynamicWorkflowEvent[];
  costAggregate: (runId: string) => DynamicWorkflowRunCostAggregate;
  estimateRemainingUsd?: (runId: string) => number | undefined;
  listEventsSince?: (runId: string, afterSeq: number) => DynamicWorkflowEvent[];
}

export const SNAPSHOT_LAST_OUTCOMES_MAX = 12;

const PENDING_DECISION_TYPES: ReadonlySet<DynamicWorkflowPendingDecisionType> =
  new Set<DynamicWorkflowPendingDecisionType>(['gate', 'question', 'error', 'provider']);

function isPendingDecisionType(value: unknown): value is DynamicWorkflowPendingDecisionType {
  return typeof value === 'string' && PENDING_DECISION_TYPES.has(value as DynamicWorkflowPendingDecisionType);
}

export function derivePendingDecision(run: DynamicWorkflowRun): DynamicWorkflowPendingDecisionState | undefined {
  const isBlocking = run.status === 'blocked' || run.status === 'failed';
  if (!isBlocking) return undefined;

  let parsed: RunInputJsonShape = {};
  try {
    parsed = JSON.parse(run.inputJson || '{}') as RunInputJsonShape;
  } catch (err) {
    logger.warn({ err, runId: run.id }, 'input_json do run ilegivel ao derivar pendingDecision');
    parsed = {};
  }

  const pd = parsed.pendingDecision;
  if (pd && isPendingDecisionType(pd.type)) {
    return {
      type: pd.type,
      id: typeof pd.id === 'string' && pd.id.length > 0 ? pd.id : run.id,
      prompt: typeof pd.prompt === 'string' && pd.prompt.length > 0 ? pd.prompt : defaultPromptFor(pd.type, run),
    };
  }

  if (run.status === 'failed') {
    return {
      type: 'error',
      id: run.id,
      prompt: run.error ?? 'run falhou com erro estrutural',
    };
  }

  return {
    type: 'error',
    id: run.id,
    prompt: 'run bloqueado sem decisao pendente registrada',
  };
}

function defaultPromptFor(type: DynamicWorkflowPendingDecisionType, run: DynamicWorkflowRun): string {
  switch (type) {
    case 'gate':
      return 'gate aguardando aprovacao';
    case 'provider':
      return 'limite/auth do provider; retomar, agendar, trocar agente ou abortar';
    case 'question':
      return 'um agente fez uma pergunta; responda para continuar';
    case 'error':
      return run.error ?? 'run bloqueado por erro';
  }
}

function summarizeEvent(event: DynamicWorkflowEvent): {
  type: string;
  summary: string;
  at: string;
  atLocal?: string;
} {
  let summary = event.type;
  try {
    const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
    const candidate =
      pickString(payload['summary']) ??
      pickString(payload['message']) ??
      pickString(payload['label']) ??
      pickString(payload['nodeId']) ??
      pickString(payload['decision']);
    if (candidate) summary = `${event.type}: ${candidate}`;
  } catch {}
  const atLocal = toLocalShort(event.createdAt);
  return { type: event.type, summary, at: event.createdAt, ...(atLocal ? { atLocal } : {}) };
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function buildSnapshot(
  runId: string,
  repoPath: string,
  deps: SnapshotDeps,
  opts?: { recentEventsLimit?: number },
): DynamicWorkflowSnapshot | null {
  const run = deps.getRun(runId);
  if (!run) return null;

  const limit = opts?.recentEventsLimit ?? SNAPSHOT_RECENT_EVENTS_DEFAULT;
  const events = deps.recentEvents(runId, limit);
  const cost = deps.costAggregate(runId);
  const pendingDecision = derivePendingDecision(run);

  const snapshot: DynamicWorkflowSnapshot = {
    runId: run.id,
    repoPath,
    status: run.status,
    recentEvents: events.map(summarizeEvent),
    cost: {
      actualUsd: Math.max(run.totalCostUsd ?? 0, cost.totalCostUsd),
      liveNodesUsd: cost.totalCostUsd,
    },
  };

  if (run.currentPhaseId) snapshot.currentPhaseId = run.currentPhaseId;
  if (run.currentNodeId) snapshot.currentNodeId = run.currentNodeId;
  if (pendingDecision) snapshot.pendingDecision = pendingDecision;

  const lastCheckpointAt = deriveLastCheckpointAt(run);
  if (lastCheckpointAt) {
    snapshot.lastCheckpointAt = lastCheckpointAt;
    const local = toLocalShort(lastCheckpointAt);
    if (local) snapshot.lastCheckpointAtLocal = local;
  }

  const remaining = deps.estimateRemainingUsd?.(runId);
  if (typeof remaining === 'number') {
    snapshot.cost.estimatedRemainingUsd = remaining;
  }

  if (deps.listEventsSince) {
    try {
      const all = deps.listEventsSince(runId, 0);
      const start = findWindowStartSeq(all);
      const outcomes = deriveOutcomesSince(eventsSince(all, start), start);
      snapshot.since = computeSinceStats(outcomes);
      snapshot.lastOutcomes = [...outcomes].reverse().slice(0, SNAPSHOT_LAST_OUTCOMES_MAX);
    } catch (err) {
      logger.warn({ err, runId }, 'snapshot: falha ao derivar since/lastOutcomes (omitidos)');
    }
  }

  return snapshot;
}

function deriveLastCheckpointAt(run: DynamicWorkflowRun): string | undefined {
  try {
    const idx = JSON.parse(run.checkpointJson || '{}') as {
      nodes?: Record<string, { savedAt?: string }>;
    };
    const nodes = idx.nodes ?? {};
    let latest: string | undefined;
    for (const key of Object.keys(nodes)) {
      const savedAt = nodes[key]?.savedAt;
      if (typeof savedAt === 'string' && (!latest || savedAt > latest)) {
        latest = savedAt;
      }
    }
    return latest;
  } catch {
    return undefined;
  }
}
