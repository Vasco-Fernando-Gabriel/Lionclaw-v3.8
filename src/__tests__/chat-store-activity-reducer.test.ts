import { describe, it, expect } from 'vitest';
import { upsertActivity, flattenBlocksToActivities } from '@/stores/chat-store';
import type { LiveActivity, LiveActivityEvent, ActivityTurnBlock } from '@/types';


function startEvent(over: Partial<LiveActivityEvent> = {}): LiveActivityEvent {
  return {
    id: 't1',
    kind: 'tool',
    phase: 'start',
    label: 'Bash',
    status: 'running',
    ...over,
  };
}

describe('upsertActivity reducer (chat-store)', () => {
  it('insere uma nova atividade quando o id ainda nao existe', () => {
    const next = upsertActivity([], startEvent());
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('t1');
    expect(next[0].label).toBe('Bash');
    expect(next[0].status).toBe('running');
  });

  it('start->update->end preserva changed:false, exitCode:0, durationMs:0 e tokens:0 (nao apagados pelo merge ??)', () => {
    let activities = upsertActivity([], startEvent({
      changed: false,
      exitCode: 0,
      durationMs: 0,
      tokens: { input: 0, output: 0 },
    }));

    activities = upsertActivity(activities, {
      id: 't1',
      kind: 'tool',
      phase: 'update',
      label: 'Bash',
      status: 'running',
    });

    expect(activities).toHaveLength(1);
    let item = activities[0];
    expect(item.changed).toBe(false);
    expect(item.exitCode).toBe(0);
    expect(item.durationMs).toBe(0);
    expect(item.tokens).toEqual({ input: 0, output: 0 });

    activities = upsertActivity(activities, {
      id: 't1',
      kind: 'tool',
      phase: 'end',
      label: '',
      status: 'done',
    });

    expect(activities).toHaveLength(1);
    item = activities[0];
    expect(item.status).toBe('done');
    expect(item.changed).toBe(false);
    expect(item.exitCode).toBe(0);
    expect(item.durationMs).toBe(0);
    expect(item.tokens).toEqual({ input: 0, output: 0 });
  });

  it('label vazio do end NAO apaga o label real do start (regra do `||`)', () => {
    let activities = upsertActivity([], startEvent({ label: 'Bash' }));
    activities = upsertActivity(activities, {
      id: 't1',
      kind: 'tool',
      phase: 'end',
      label: '',
      status: 'done',
    });
    expect(activities[0].label).toBe('Bash');
  });

  it('phase=end sem status explicito deriva status terminal "done"', () => {
    let activities = upsertActivity([], startEvent());
    activities = upsertActivity(activities, {
      id: 't1',
      kind: 'tool',
      phase: 'end',
      label: 'Bash',
    });
    expect(activities[0].status).toBe('done');
  });
});

describe('flattenBlocksToActivities (hidratacao)', () => {
  function block(items: LiveActivity[]): ActivityTurnBlock {
    return {
      turnIndex: 1,
      sessionId: 's1',
      items,
      startedAt: '2026-06-08T00:00:00.000Z',
      totals: { tokens: 0, costUsd: 0, subagents: 0, tools: 0 },
      status: 'done',
    };
  }

  it('STORE-4: item hidratado com status running vira stopped (nunca esta vivo)', () => {
    const out = flattenBlocksToActivities([
      block([{ id: 'a', kind: 'subagent', label: 'sub', status: 'running' }]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('stopped');
  });

  it('preserva status terminais ao hidratar e herda turnIndex do bloco', () => {
    const out = flattenBlocksToActivities([
      block([
        { id: 'a', kind: 'tool', label: 'Bash', status: 'done' },
        { id: 'b', kind: 'tool', label: 'Read', status: 'error' },
      ]),
    ]);
    expect(out.map((i) => i.status)).toEqual(['done', 'error']);
    expect(out.every((i) => i.turnIndex === 1)).toBe(true);
  });
});
