import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  executeCronQueryMock:
    vi.fn<(prompt: string, options: Record<string, unknown>, getWindow: unknown) => Promise<void>>(),
  createSessionMock: vi.fn(),
  currentDb: { value: null as unknown },
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  Notification: {
    isSupported: () => false,
  },
}));

vi.mock('../db', () => ({
  getDb: () => h.currentDb.value,
  createSession: h.createSessionMock,
}));

vi.mock('../orchestrator', () => ({
  executeCronQuery: h.executeCronQueryMock,
}));

vi.mock('../telegram-bridge', () => ({
  sendTelegramNotification: vi.fn(),
  isTelegramConfigured: vi.fn(() => false),
}));

import {
  calculateNextRun,
  claimScheduledTaskForRun,
  reconcileActiveCronNextRuns,
  startScheduler,
  stopScheduler,
  SCHEDULER_CRON_TIMEZONE,
} from '../scheduler';

describe('scheduler cron timezone', () => {
  it('interprets cron expressions as UTC explicitly', () => {
    const next = calculateNextRun('cron', '0 11 * * *', new Date('2026-05-26T00:00:00.000Z'));

    expect(SCHEDULER_CRON_TIMEZONE).toBe('UTC');
    expect(next?.toISOString()).toBe('2026-05-26T11:00:00.000Z');
  });

  it('keeps interval schedules relative to the provided clock', () => {
    const next = calculateNextRun('interval', String(60_000), new Date('2026-05-26T10:00:00.000Z'));

    expect(next?.toISOString()).toBe('2026-05-26T10:01:00.000Z');
  });
});

describe('scheduler task claim', () => {
  it('claims a task only when the atomic update affects one row', () => {
    const db = {
      sql: '',
      params: [] as unknown[],
      prepare(sql: string) {
        this.sql = sql;
        return {
          run: (...params: unknown[]) => {
            this.params = params;
            return { changes: 1 };
          },
        };
      },
    };

    expect(claimScheduledTaskForRun(db, 'task-1', '2026-05-26T11:00:00.000Z')).toBe(true);
    expect(db.sql).toContain("status = 'active'");
    expect(db.sql).toContain('next_run = ?');
    expect(db.params).toEqual(['task-1', '2026-05-26T11:00:00.000Z']);
  });

  it('skips a task when another scheduler already claimed it', () => {
    const db = {
      prepare: () => ({
        run: () => ({ changes: 0 }),
      }),
    };

    expect(claimScheduledTaskForRun(db, 'task-1', '2026-05-26T11:00:00.000Z')).toBe(false);
  });
});

interface FakeSchedulerDb {
  taskRunUpdates: Array<{ sql: string; params: unknown[] }>;
  insertedRuns: unknown[][];
  prepare(sql: string): {
    all?: (...params: unknown[]) => Array<Record<string, unknown>>;
    run?: (...params: unknown[]) => { changes?: number; lastInsertRowid?: number };
  };
}

function makeSchedulerDb(taskRow: Record<string, unknown>): FakeSchedulerDb {
  let dueServed = false;
  const db: FakeSchedulerDb = {
    taskRunUpdates: [],
    insertedRuns: [],
    prepare(sql: string) {
      if (sql.includes("WHERE status = 'active' AND next_run <= ?")) {
        return {
          all: () => {
            if (dueServed) return [];
            dueServed = true;
            return [taskRow];
          },
        };
      }
      if (sql.includes('SELECT id, schedule_value, next_run')) {
        return { all: () => [] };
      }
      if (sql.includes('INSERT INTO task_runs')) {
        return {
          run: (...params: unknown[]) => {
            db.insertedRuns.push(params);
            return { lastInsertRowid: 42 };
          },
        };
      }
      if (sql.includes('UPDATE task_runs SET completed_at')) {
        return {
          run: (...params: unknown[]) => {
            db.taskRunUpdates.push({ sql, params });
            return { changes: 1 };
          },
        };
      }
      return { run: () => ({ changes: 1 }) };
    },
  };
  return db;
}

const DUE_TASK_ROW: Record<string, unknown> = {
  id: 'task-x',
  name: 'Tarefa X',
  prompt: 'faz algo',
  subagent: null,
  schedule_type: 'once',
  schedule_value: '2020-01-01T00:00:00.000Z',
  notify: 0,
  next_run: '2020-01-01T00:00:00.000Z',
};

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condicao nao satisfeita a tempo');
}

describe('contrato de erro do cron (SPEC 1.3/7.1, AC-71)', () => {
  beforeEach(() => {
    h.executeCronQueryMock.mockReset();
    h.createSessionMock.mockClear();
  });

  afterEach(() => {
    stopScheduler();
  });

  it('query rejeitada -> task_run marcado error com a mensagem REAL (nunca success)', async () => {
    const db = makeSchedulerDb({ ...DUE_TASK_ROW });
    h.currentDb.value = db;
    h.executeCronQueryMock.mockRejectedValueOnce(new Error('quebrou de verdade'));

    startScheduler(() => null);
    await waitFor(() => db.taskRunUpdates.length > 0);

    expect(db.taskRunUpdates).toHaveLength(1);
    expect(db.taskRunUpdates[0].sql).toContain("status = 'error'");
    expect(db.taskRunUpdates[0].sql).not.toContain("status = 'success'");
    expect(db.taskRunUpdates[0].params).toContain('quebrou de verdade');
    expect(h.createSessionMock).toHaveBeenCalledWith(
      expect.any(String),
      '[Scheduler] Tarefa X',
      undefined,
      expect.objectContaining({ type: 'scheduled' }),
    );
  });

  it('query resolvida -> task_run marcado success (fluxo feliz preservado)', async () => {
    const db = makeSchedulerDb({ ...DUE_TASK_ROW });
    h.currentDb.value = db;
    h.executeCronQueryMock.mockResolvedValueOnce(undefined);

    startScheduler(() => null);
    await waitFor(() => db.taskRunUpdates.length > 0);

    expect(db.taskRunUpdates).toHaveLength(1);
    expect(db.taskRunUpdates[0].sql).toContain("status = 'success'");
    const call = h.executeCronQueryMock.mock.calls[0];
    expect((call[1] as { sessionId?: string }).sessionId).toBeTruthy();
  });
});

describe('scheduler cron reconciliation', () => {
  it('updates stale active cron next_run values using UTC semantics', () => {
    const updates: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        if (sql.includes('SELECT id, schedule_value, next_run')) {
          return {
            all: () => [
              {
                id: 'task-1',
                schedule_value: '0 11 * * *',
                next_run: '2026-05-26T14:00:00.000Z',
              },
            ],
          };
        }
        return {
          run: (...params: unknown[]) => {
            updates.push(params);
          },
        };
      },
    };

    const count = reconcileActiveCronNextRuns(db, new Date('2026-05-26T00:00:00.000Z'));

    expect(count).toBe(1);
    expect(updates).toEqual([['2026-05-26T11:00:00.000Z', 'task-1']]);
  });

  it('does not update cron rows whose next_run is already consistent', () => {
    const updates: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        if (sql.includes('SELECT id, schedule_value, next_run')) {
          return {
            all: () => [
              {
                id: 'task-1',
                schedule_value: '0 11 * * *',
                next_run: '2026-05-26T11:00:00.000Z',
              },
            ],
          };
        }
        return {
          run: (...params: unknown[]) => {
            updates.push(params);
          },
        };
      },
    };

    const count = reconcileActiveCronNextRuns(db, new Date('2026-05-26T00:00:00.000Z'));

    expect(count).toBe(0);
    expect(updates).toEqual([]);
  });
});
