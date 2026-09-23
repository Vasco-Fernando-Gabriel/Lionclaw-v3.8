import { describe, it, expect, beforeEach } from 'vitest';
import {
  emitWorkflowEvent,
  broadcastWorkflowStreamChunk,
  workflowEventBus,
  DYNAMIC_WORKFLOW_STREAM_CHANNEL,
  type WorkflowEventsDeps,
} from '../dynamic-workflows/workflow-events';
import type {
  DynamicWorkflowEvent,
  DynamicWorkflowEventInsertInput,
  DynamicWorkflowStreamChunk,
} from '../dynamic-workflows/types';

function makeInsertFake() {
  const seqByRun = new Map<string, number>();
  const inserted: DynamicWorkflowEvent[] = [];
  const insertEvent = (input: DynamicWorkflowEventInsertInput): DynamicWorkflowEvent => {
    const next = (seqByRun.get(input.runId) ?? 0) + 1;
    seqByRun.set(input.runId, next);
    const event: DynamicWorkflowEvent = {
      id: inserted.length + 1,
      runId: input.runId,
      nodeId: input.nodeId ?? null,
      phaseId: input.phaseId ?? null,
      seq: next,
      type: input.type,
      payloadJson: input.payloadJson ?? '{}',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    inserted.push(event);
    return event;
  };
  return { insertEvent, inserted };
}

function makeDeps(): {
  deps: WorkflowEventsDeps;
  broadcasts: Array<{ channel: string; payload: unknown }>;
  jsonl: Array<{ runId: string; line: string }>;
  inserted: DynamicWorkflowEvent[];
} {
  const { insertEvent, inserted } = makeInsertFake();
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const jsonl: Array<{ runId: string; line: string }> = [];
  const deps: WorkflowEventsDeps = {
    insertEvent,
    emit: (channel, payload) => broadcasts.push({ channel, payload }),
    appendJsonl: (runId, line) => jsonl.push({ runId, line }),
  };
  return { deps, broadcasts, jsonl, inserted };
}

describe('workflow-events: emitWorkflowEvent', () => {
  beforeEach(() => {
    workflowEventBus._resetForTesting();
  });

  it('persiste com seq monotonico por run e devolve o evento', () => {
    const { deps, inserted } = makeDeps();
    const e1 = emitWorkflowEvent(deps, { runId: 'r1', type: 'node-started', nodeId: 'scout' });
    const e2 = emitWorkflowEvent(deps, { runId: 'r1', type: 'node-completed', nodeId: 'scout' });
    const other = emitWorkflowEvent(deps, { runId: 'r2', type: 'run-created' });

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(other.seq).toBe(1);
    expect(inserted).toHaveLength(3);
    expect(inserted[0]?.type).toBe('node-started');
  });

  it('serializa o payload em payload_json (e tolera circular)', () => {
    const { deps, inserted } = makeDeps();
    emitWorkflowEvent(deps, { runId: 'r1', type: 'log', payload: { msg: 'oi', n: 2 } });
    expect(JSON.parse(inserted[0]!.payloadJson)).toEqual({ msg: 'oi', n: 2 });

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    emitWorkflowEvent(deps, { runId: 'r1', type: 'log', payload: circular });
    expect(inserted[1]!.payloadJson).toBe('{}');
  });

  it('faz broadcast dynamic-workflow:stream com kind runner e eventType', () => {
    const { deps, broadcasts } = makeDeps();
    emitWorkflowEvent(deps, {
      runId: 'r1',
      type: 'gate-blocked',
      nodeId: 'gate-global',
      payload: { gateId: 'gate-global' },
    });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.channel).toBe(DYNAMIC_WORKFLOW_STREAM_CHANNEL);
    const chunk = broadcasts[0]!.payload as DynamicWorkflowStreamChunk;
    expect(chunk.kind).toBe('runner');
    expect(chunk.type).toBe('event');
    expect(chunk.eventType).toBe('gate-blocked');
    expect(chunk.runId).toBe('r1');
    expect(chunk.nodeId).toBe('gate-global');
    expect(chunk.payload).toEqual({ gateId: 'gate-global' });
  });

  it('espelha no events.jsonl com seq/type/payload', () => {
    const { deps, jsonl } = makeDeps();
    emitWorkflowEvent(deps, { runId: 'r1', type: 'node-started', nodeId: 'coder', payload: { a: 1 } });
    expect(jsonl).toHaveLength(1);
    const line = JSON.parse(jsonl[0]!.line);
    expect(line.seq).toBe(1);
    expect(line.type).toBe('node-started');
    expect(line.payload).toEqual({ a: 1 });
  });

  it('publica no bus in-process para assinantes (control-core/activity)', () => {
    const { deps } = makeDeps();
    const seen: DynamicWorkflowEvent[] = [];
    const unsub = workflowEventBus.subscribe((e) => seen.push(e));
    emitWorkflowEvent(deps, { runId: 'r1', type: 'phase-changed', phaseId: 'p1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe('phase-changed');
    unsub();
    emitWorkflowEvent(deps, { runId: 'r1', type: 'phase-changed', phaseId: 'p2' });
    expect(seen).toHaveLength(1);
  });

  it('persistencia primeiro: falha de broadcast/jsonl/listener NAO aborta o evento', () => {
    const { insertEvent, inserted } = makeInsertFake();
    const deps: WorkflowEventsDeps = {
      insertEvent,
      emit: () => {
        throw new Error('renderer caiu');
      },
      appendJsonl: () => {
        throw new Error('disco cheio');
      },
    };
    workflowEventBus.subscribe(() => {
      throw new Error('listener quebrado');
    });
    const event = emitWorkflowEvent(deps, { runId: 'r1', type: 'node-started' });
    expect(event.seq).toBe(1);
    expect(inserted).toHaveLength(1);
  });

  it('se a persistencia falha, o erro PROPAGA (evento sem registro nao segue)', () => {
    const deps: WorkflowEventsDeps = {
      insertEvent: () => {
        throw new Error('DB indisponivel');
      },
      emit: () => undefined,
    };
    expect(() => emitWorkflowEvent(deps, { runId: 'r1', type: 'x' })).toThrow('DB indisponivel');
  });

  it('aceita bus injetado (isolamento de teste sem singleton)', () => {
    const { insertEvent } = makeInsertFake();
    const broadcasts: Array<{ channel: string; payload: unknown }> = [];
    const singletonSeen: DynamicWorkflowEvent[] = [];
    workflowEventBus.subscribe((e) => singletonSeen.push(e));
    const deps: WorkflowEventsDeps = {
      insertEvent,
      emit: (c, p) => broadcasts.push({ channel: c, payload: p }),
      bus: workflowEventBus,
    };
    emitWorkflowEvent(deps, { runId: 'r1', type: 'x' });
    expect(singletonSeen).toHaveLength(1);
  });
});

describe('workflow-events: broadcastWorkflowStreamChunk', () => {
  it('multiplexa chunk de node pronto no broadcast unico', () => {
    const broadcasts: Array<{ channel: string; payload: unknown }> = [];
    broadcastWorkflowStreamChunk(
      { emit: (c, p) => broadcasts.push({ channel: c, payload: p }) },
      { kind: 'node', runId: 'r1', nodeId: 'coder', type: 'text', content: 'oi' },
    );
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.channel).toBe(DYNAMIC_WORKFLOW_STREAM_CHANNEL);
    expect((broadcasts[0]!.payload as DynamicWorkflowStreamChunk).kind).toBe('node');
  });

  it('engole erro de broadcast sem propagar', () => {
    expect(() =>
      broadcastWorkflowStreamChunk(
        {
          emit: () => {
            throw new Error('falhou');
          },
        },
        { kind: 'closer', runId: 'r1', type: 'text', content: 'x' },
      ),
    ).not.toThrow();
  });
});
