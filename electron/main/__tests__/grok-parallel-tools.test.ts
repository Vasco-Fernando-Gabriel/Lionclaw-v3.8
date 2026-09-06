import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ insertAuditEntry: vi.fn() }));
vi.mock('../activity-log', () => ({
  recordActivity: vi.fn((_sessionId, _turn, activity, emit) => {
    emit({ type: 'activity', activity });
  }),
  isWriteTool: vi.fn(() => false),
}));

import { createGrokAccumulator, translateGrokSessionUpdate } from '../grok-acp/acp-translator';
import { createGrokStreamTranslator } from '../grok-sdk/stream-translator';
import type { StreamChunk } from '../../../src/types';

type ActivityChunk = StreamChunk & { activity?: { id: string; phase: string; status?: string } };

function activitiesOf(chunks: StreamChunk[]): Array<{ id: string; phase: string; status?: string }> {
  return (chunks as ActivityChunk[])
    .filter((chunk) => chunk.type === 'activity' && chunk.activity !== undefined)
    .map((chunk) => chunk.activity!);
}

describe('Grok: tools em paralelo fecham a atividade CERTA (correlacao por toolCallId)', () => {
  it('fecha cada tool pelo seu proprio id, sem depender da ordem de conclusao', () => {
    const chunks: StreamChunk[] = [];
    const translator = createGrokStreamTranslator({
      sessionId: 'session-1',
      model: 'grok-4.5',
      emit: (chunk) => chunks.push(chunk),
    });
    const accumulator = createGrokAccumulator();

    translateGrokSessionUpdate(
      { sessionUpdate: 'tool_call', toolCallId: 'acp-A', title: 'read_file' },
      accumulator,
      translator.callbacks,
    );
    translateGrokSessionUpdate(
      { sessionUpdate: 'tool_call', toolCallId: 'acp-B', title: 'list_dir' },
      accumulator,
      translator.callbacks,
    );

    const started = activitiesOf(chunks).filter((activity) => activity.phase === 'start');
    expect(started).toHaveLength(2);
    const [activityA, activityB] = started;
    expect(activityA.id).not.toBe(activityB.id);

    translateGrokSessionUpdate(
      { sessionUpdate: 'tool_call_update', toolCallId: 'acp-B', status: 'completed', rawOutput: 'ok-B' },
      accumulator,
      translator.callbacks,
    );
    let ended = activitiesOf(chunks).filter((activity) => activity.phase === 'end');
    expect(ended.map((activity) => activity.id)).toEqual([activityB.id]);

    translateGrokSessionUpdate(
      { sessionUpdate: 'tool_call_update', toolCallId: 'acp-A', status: 'completed', rawOutput: 'ok-A' },
      accumulator,
      translator.callbacks,
    );
    ended = activitiesOf(chunks).filter((activity) => activity.phase === 'end');
    expect(ended.map((activity) => activity.id)).toEqual([activityB.id, activityA.id]);
    expect(ended.every((activity) => activity.status === 'done')).toBe(true);
  });

  it('sem toolCallId do driver mantem o comportamento serie anterior', () => {
    const chunks: StreamChunk[] = [];
    const translator = createGrokStreamTranslator({
      sessionId: 'session-1',
      model: 'grok-4.5',
      emit: (chunk) => chunks.push(chunk),
    });

    translator.callbacks.onToolUse?.('read_file');
    translator.callbacks.onToolUseIO?.('read_file', {}, 'saida');

    const activities = activitiesOf(chunks);
    expect(activities.map((activity) => activity.phase)).toEqual(['start', 'end']);
    expect(activities[0].id).toBe(activities[1].id);
  });
});
