import type { BrowserWindow } from 'electron';
import { recordActivity } from '../activity-log';
import { getDynamicWorkflowRun, getLatestUserTurnIndex } from '../db';
import { createLogger } from '../logger';
import { workflowEventBus } from './workflow-events';
import type { DynamicWorkflowEvent, DynamicWorkflowRun } from './types';
import type { LiveActivityEvent, StreamChunk } from '../../../src/types';

type WorkflowEventBusHandle = typeof workflowEventBus;

const logger = createLogger('dynamic-workflow-activity');

function rootActivityId(runId: string): string {
  return `workflow:${runId}`;
}

function nodeActivityId(runId: string, nodeId: string, attempt: number): string {
  return `workflow:${runId}:node:${nodeId}#${attempt}`;
}

function groupActivityId(runId: string, groupId: string): string {
  return `workflow:${runId}:group:${groupId}`;
}

function gateActivityId(runId: string, gateId: string): string {
  return `workflow:${runId}:gate:${gateId}`;
}

function numFrom(payload: Record<string, unknown>, key: string): number | undefined {
  const v = payload[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function strFrom(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function rootLabel(run: DynamicWorkflowRun): string {
  return run.currentPhaseId ? `Workflow - ${run.currentPhaseId}` : 'Workflow';
}

function rootDescription(run: DynamicWorkflowRun): string | undefined {
  if (run.currentPhaseId && run.currentNodeId) {
    return `Fase ${run.currentPhaseId} - node ${run.currentNodeId}`;
  }
  if (run.currentPhaseId) return `Fase ${run.currentPhaseId}`;
  return undefined;
}

export function mapWorkflowEventToActivities(
  event: DynamicWorkflowEvent,
  run: DynamicWorkflowRun,
): LiveActivityEvent[] {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = event.payloadJson ? JSON.parse(event.payloadJson) : {};
    if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }

  const runId = event.runId;
  const rootId = rootActivityId(runId);
  const out: LiveActivityEvent[] = [];

  const rootBase: LiveActivityEvent = {
    id: rootId,
    kind: 'workflow',
    phase: 'update',
    label: rootLabel(run),
    status: 'running',
    projectId: runId,
    description: rootDescription(run),
    costUsd: run.totalCostUsd,
  };

  switch (event.type) {
    case 'run-started': {
      out.push({ ...rootBase, phase: 'start', startedAt: run.startedAt ?? event.createdAt });
      return out;
    }
    case 'run-delivered': {
      out.push({ ...rootBase, summary: 'entrega concluida; fechamento com o closer' });
      return out;
    }
    case 'run-finished': {
      out.push({ ...rootBase, phase: 'end', status: 'done', summary: 'workflow concluido', endedAt: event.createdAt });
      return out;
    }
    case 'run-failed': {
      out.push({
        ...rootBase,
        phase: 'end',
        status: 'error',
        summary: strFrom(payload, 'message') ?? 'workflow falhou',
        endedAt: event.createdAt,
      });
      return out;
    }
    case 'run-aborted': {
      out.push({
        ...rootBase,
        phase: 'end',
        status: 'stopped',
        summary: 'workflow abortado',
        endedAt: event.createdAt,
      });
      return out;
    }
    case 'run-paused':
    case 'pause-requested': {
      out.push({ ...rootBase, summary: 'pausado' });
      return out;
    }
    case 'resume-requested': {
      out.push({ ...rootBase, summary: 'retomado' });
      return out;
    }
    case 'phase-changed': {
      const phaseId = event.phaseId ?? strFrom(payload, 'phase');
      out.push({
        ...rootBase,
        description: phaseId
          ? `Fase ${phaseId}${run.currentNodeId ? ` - node ${run.currentNodeId}` : ''}`
          : rootBase.description,
      });
      return out;
    }
    case 'node-started': {
      const nodeId = event.nodeId ?? strFrom(payload, 'nodeId') ?? 'node';
      const attempt = numFrom(payload, 'attempt') ?? 1;
      out.push(rootBase);
      out.push({
        id: nodeActivityId(runId, nodeId, attempt),
        parentId: rootId,
        kind: 'subagent',
        phase: 'start',
        label: nodeId,
        status: 'running',
        agentId: strFrom(payload, 'agentId') ?? null,
        description: attempt > 1 ? `tentativa ${attempt}` : undefined,
        startedAt: event.createdAt,
      });
      return out;
    }
    case 'node-completed': {
      const nodeId = event.nodeId ?? strFrom(payload, 'nodeId') ?? 'node';
      const attempt = numFrom(payload, 'attempt') ?? 1;
      out.push({
        id: nodeActivityId(runId, nodeId, attempt),
        parentId: rootId,
        kind: 'subagent',
        phase: 'end',
        label: nodeId,
        status: 'done',
        costUsd: numFrom(payload, 'costUsd'),
        endedAt: event.createdAt,
      });
      return out;
    }
    case 'node-failed': {
      const nodeId = event.nodeId ?? strFrom(payload, 'nodeId') ?? 'node';
      const attempt = numFrom(payload, 'attempt') ?? 1;
      out.push({
        id: nodeActivityId(runId, nodeId, attempt),
        parentId: rootId,
        kind: 'subagent',
        phase: 'end',
        label: nodeId,
        status: 'error',
        summary: strFrom(payload, 'failureClass') ?? strFrom(payload, 'error'),
        endedAt: event.createdAt,
      });
      return out;
    }
    case 'node-cache-hit': {
      const nodeId = event.nodeId ?? strFrom(payload, 'nodeId') ?? 'node';
      const attempt = numFrom(payload, 'attempt') ?? 1;
      out.push({
        id: nodeActivityId(runId, nodeId, attempt),
        parentId: rootId,
        kind: 'subagent',
        phase: 'end',
        label: nodeId,
        status: 'done',
        summary: 'cache reaproveitado',
        endedAt: event.createdAt,
      });
      return out;
    }
    case 'parallel-started': {
      const groupId = strFrom(payload, 'groupId') ?? 'grupo';
      const size = numFrom(payload, 'size');
      out.push(rootBase);
      out.push({
        id: groupActivityId(runId, groupId),
        parentId: rootId,
        kind: 'subagent',
        phase: 'start',
        label: `grupo paralelo: ${groupId}`,
        status: 'running',
        description: typeof size === 'number' ? `${size} agentes em paralelo` : undefined,
        startedAt: event.createdAt,
      });
      return out;
    }
    case 'parallel-completed': {
      const groupId = strFrom(payload, 'groupId') ?? 'grupo';
      out.push({
        id: groupActivityId(runId, groupId),
        parentId: rootId,
        kind: 'subagent',
        phase: 'end',
        label: `grupo paralelo: ${groupId}`,
        status: 'done',
        endedAt: event.createdAt,
      });
      return out;
    }
    case 'parallel-cancelled': {
      const groupId = strFrom(payload, 'groupId') ?? 'grupo';
      out.push({
        id: groupActivityId(runId, groupId),
        parentId: rootId,
        kind: 'subagent',
        phase: 'end',
        label: `grupo paralelo: ${groupId}`,
        status: 'stopped',
        endedAt: event.createdAt,
      });
      return out;
    }
    case 'gate-blocked': {
      const gateId = strFrom(payload, 'gateId') ?? 'gate';
      out.push(rootBase);
      out.push({
        id: gateActivityId(runId, gateId),
        parentId: rootId,
        kind: 'subagent',
        phase: 'update',
        label: `gate: ${gateId}`,
        status: 'running',
        description: `gate aguardando decisao (${strFrom(payload, 'mode') ?? 'human'})`,
      });
      return out;
    }
    case 'gate-approved':
    case 'gate-decision-received': {
      const gateId = strFrom(payload, 'gateId') ?? 'gate';
      out.push({
        id: gateActivityId(runId, gateId),
        parentId: rootId,
        kind: 'subagent',
        phase: 'end',
        label: `gate: ${gateId}`,
        status: 'done',
        summary: strFrom(payload, 'decision'),
        endedAt: event.createdAt,
      });
      return out;
    }
    case 'intervention': {
      const itype = strFrom(payload, 'type') ?? 'intervencao';
      const source = strFrom(payload, 'source') ?? 'humano';
      out.push({
        id: `workflow:${runId}:intervention:${event.seq}`,
        parentId: rootId,
        kind: 'subagent',
        phase: 'end',
        label: `intervencao: ${itype}`,
        status: 'done',
        description: `origem: ${source}`,
        endedAt: event.createdAt,
      });
      return out;
    }
    case 'autonomy-changed': {
      out.push({ ...rootBase, summary: `autonomia: ${strFrom(payload, 'mode') ?? '?'}` });
      return out;
    }
    default: {
      out.push(rootBase);
      return out;
    }
  }
}

export interface WorkflowActivityDeps {
  getRun: (runId: string) => DynamicWorkflowRun | null;
  getTurnIndex: (sessionId: string) => number;
  record: (sessionId: string, turnIndex: number, ev: LiveActivityEvent, send: (chunk: StreamChunk) => void) => void;
  getWindow: () => BrowserWindow | null;
  bus?: WorkflowEventBusHandle;
}

function handleEvent(deps: WorkflowActivityDeps, event: DynamicWorkflowEvent): void {
  try {
    const run = deps.getRun(event.runId);
    if (!run) return;
    const sessionId = run.chatSessionId;
    if (!sessionId) return;

    const turnIndex = deps.getTurnIndex(sessionId);
    const win = deps.getWindow();
    const send = (chunk: StreamChunk): void => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('chat:stream', { ...chunk, sessionId });
      }
    };

    const activities = mapWorkflowEventToActivities(event, run);
    for (const ev of activities) {
      deps.record(sessionId, turnIndex, ev, send);
    }
  } catch (err) {
    logger.warn(
      { err, runId: event.runId, type: event.type },
      'falha ao espelhar evento de workflow na activity bar (ignorado)',
    );
  }
}

let activeUnsubscribe: (() => void) | null = null;

export function initWorkflowActivityBridge(
  getWindow: () => BrowserWindow | null,
  overrides?: Partial<WorkflowActivityDeps>,
): () => void {
  const deps: WorkflowActivityDeps = {
    getRun: overrides?.getRun ?? getDynamicWorkflowRun,
    getTurnIndex: overrides?.getTurnIndex ?? getLatestUserTurnIndex,
    record: overrides?.record ?? recordActivity,
    getWindow: overrides?.getWindow ?? getWindow,
    bus: overrides?.bus,
  };

  if (activeUnsubscribe) {
    activeUnsubscribe();
    activeUnsubscribe = null;
  }

  const bus = deps.bus ?? workflowEventBus;
  const unsubscribe = bus.subscribe((event) => handleEvent(deps, event));
  activeUnsubscribe = unsubscribe;
  logger.info('workflow activity bridge inicializado');
  return unsubscribe;
}
