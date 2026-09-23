import { createLogger } from '../logger';
import type { DynamicWorkflowEvent, DynamicWorkflowEventInsertInput, DynamicWorkflowStreamChunk } from './types';

const logger = createLogger('dynamic-workflow-events');

export type WorkflowEventListener = (event: DynamicWorkflowEvent) => void;

class WorkflowEventBus {
  private listeners = new Set<WorkflowEventListener>();

  subscribe(listener: WorkflowEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: DynamicWorkflowEvent): void {
    if (this.listeners.size === 0) return;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (err) {
        logger.warn({ err, runId: event.runId, type: event.type }, 'workflow event listener falhou (ignorado)');
      }
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  _resetForTesting(): void {
    if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
      throw new Error('_resetForTesting so pode ser chamado em ambiente de teste');
    }
    this.listeners.clear();
  }
}

export const workflowEventBus = new WorkflowEventBus();

export const DYNAMIC_WORKFLOW_STREAM_CHANNEL = 'dynamic-workflow:stream';

export interface WorkflowEventsDeps {
  insertEvent: (input: DynamicWorkflowEventInsertInput) => DynamicWorkflowEvent;
  emit: (channel: string, payload: unknown) => void;
  appendJsonl?: (runId: string, line: string) => void;
  bus?: WorkflowEventBus;
}

export interface WorkflowEventInput {
  runId: string;
  type: string;
  nodeId?: string | null;
  phaseId?: string | null;
  payload?: unknown;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function toStreamChunk(event: DynamicWorkflowEvent): DynamicWorkflowStreamChunk {
  const chunk: DynamicWorkflowStreamChunk = {
    kind: 'runner',
    runId: event.runId,
    type: 'event',
    eventType: event.type,
  };
  if (event.nodeId) chunk.nodeId = event.nodeId;
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(event.payloadJson);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined) chunk.payload = parsed;
  return chunk;
}

export function emitWorkflowEvent(deps: WorkflowEventsDeps, input: WorkflowEventInput): DynamicWorkflowEvent {
  const payloadJson = safeStringify(input.payload);

  const event = deps.insertEvent({
    runId: input.runId,
    nodeId: input.nodeId ?? null,
    phaseId: input.phaseId ?? null,
    type: input.type,
    payloadJson,
  });

  if (deps.appendJsonl) {
    try {
      deps.appendJsonl(
        event.runId,
        JSON.stringify({
          seq: event.seq,
          type: event.type,
          nodeId: event.nodeId,
          phaseId: event.phaseId,
          payload: input.payload ?? {},
          at: event.createdAt,
        }),
      );
    } catch (err) {
      logger.warn({ err, runId: event.runId, seq: event.seq }, 'falha ao espelhar evento em events.jsonl (ignorado)');
    }
  }

  const bus = deps.bus ?? workflowEventBus;
  bus.publish(event);

  try {
    deps.emit(DYNAMIC_WORKFLOW_STREAM_CHANNEL, toStreamChunk(event));
  } catch (err) {
    logger.warn({ err, runId: event.runId, seq: event.seq }, 'falha no broadcast dynamic-workflow:stream (ignorado)');
  }

  return event;
}

export function broadcastWorkflowStreamChunk(
  deps: Pick<WorkflowEventsDeps, 'emit'>,
  chunk: DynamicWorkflowStreamChunk,
): void {
  try {
    deps.emit(DYNAMIC_WORKFLOW_STREAM_CHANNEL, chunk);
  } catch (err) {
    logger.warn(
      { err, runId: chunk.runId, kind: chunk.kind },
      'falha no broadcast de chunk dynamic-workflow:stream (ignorado)',
    );
  }
}
