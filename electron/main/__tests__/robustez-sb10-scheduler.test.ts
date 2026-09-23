import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  executeCronQueryMock:
    vi.fn<(prompt: string, options: Record<string, unknown>, getWindow: unknown) => Promise<void>>(),
  createSessionMock: vi.fn(),
  sendTelegramNotificationMock: vi.fn<(text: string) => Promise<void>>(async () => undefined),
  isTelegramConfiguredMock: vi.fn(() => true),
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
  sendTelegramNotification: h.sendTelegramNotificationMock,
  isTelegramConfigured: h.isTelegramConfiguredMock,
}));

import {
  buildTaskFailureNotification,
  validateScheduleValue,
  createScheduledTask,
  updateScheduledTask,
  getAllScheduledTasks,
  startScheduler,
  stopScheduler,
} from '../scheduler';
import { TypedProviderError, LLM_ERROR_TABLE } from '../agent-runtime/llm-error';

describe('SB-10 AC-B23 — notificacao acionavel de falha de task', () => {
  it('AC-B23: falha por quota vira userMessage + suggestedAction (nao string tecnica crua)', () => {
    const quotaError = new TypedProviderError('LLM-QUOTA', {
      message: 'HTTP 402: insufficient credits {"type":"error"}',
    });
    const text = buildTaskFailureNotification('Relatorio diario', quotaError);

    expect(text).toContain('Tarefa "Relatorio diario" falhou');
    expect(text).toContain(LLM_ERROR_TABLE['LLM-QUOTA'].userMessage);
    expect(text).toContain(LLM_ERROR_TABLE['LLM-QUOTA'].suggestedAction);
    expect(text).not.toContain('HTTP 402');
  });

  it('AC-B23: erro CRU (nao tipado) e classificado pelo tradutor central', () => {
    const raw = new Error('Request failed with status code 429: rate limit exceeded');
    const text = buildTaskFailureNotification('Sync', raw);

    expect(text).toContain(LLM_ERROR_TABLE['LLM-RATE-429'].userMessage);
    expect(text).toContain(LLM_ERROR_TABLE['LLM-RATE-429'].suggestedAction);
  });

  it('AC-B23 (fim-a-fim): task com notify que falha manda a notificacao acionavel no Telegram', async () => {
    const taskRow = {
      id: 'task-1',
      name: 'Relatorio',
      prompt: 'gera o relatorio',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      subagent: null,
      notify: 1,
      next_run: new Date(Date.now() - 1000).toISOString(),
    };
    h.currentDb.value = {
      prepare: (sql: string) => ({
        all: () => (sql.includes('FROM scheduled_tasks') ? [taskRow] : []),
        run: () => ({ changes: 1, lastInsertRowid: 7 }),
        get: () => undefined,
      }),
    };
    h.executeCronQueryMock.mockRejectedValueOnce(
      new TypedProviderError('LLM-QUOTA', { message: 'usageLimitExceeded' }),
    );

    startScheduler(() => null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    stopScheduler();

    expect(h.sendTelegramNotificationMock).toHaveBeenCalled();
    const sent = h.sendTelegramNotificationMock.mock.calls.map((c) => c[0]).find((m) => m.includes('falhou'));
    expect(sent).toBeDefined();
    expect(sent).toContain(LLM_ERROR_TABLE['LLM-QUOTA'].userMessage);
    expect(sent).toContain(LLM_ERROR_TABLE['LLM-QUOTA'].suggestedAction);
    expect(sent).not.toContain('usageLimitExceeded');
  });
});

describe('SB-10 AC-B24 — cron invalido visivel e rejeitado', () => {
  beforeEach(() => {
    h.currentDb.value = null;
  });

  it('AC-B24: validateScheduleValue rejeita cron invalido com a mensagem CRON-INVALID', () => {
    const err = validateScheduleValue('cron', 'isso nao e cron');
    expect(err).toBeTruthy();
    expect(err).toContain(LLM_ERROR_TABLE['CRON-INVALID'].userMessage);
    expect(err).toContain(LLM_ERROR_TABLE['CRON-INVALID'].suggestedAction);

    expect(validateScheduleValue('cron', '0 9 * * *')).toBeNull();
    expect(validateScheduleValue('interval', '60000')).toBeNull();
    expect(validateScheduleValue('interval', 'abc')).toBeTruthy();
    expect(validateScheduleValue('once', '2026-12-01T10:00:00Z')).toBeNull();
    expect(validateScheduleValue('once', 'nunca')).toBeTruthy();
  });

  it('AC-B24: createScheduledTask com cron invalido retorna { error } e NAO grava', () => {
    const runs: string[] = [];
    h.currentDb.value = {
      prepare: (sql: string) => ({
        run: () => {
          runs.push(sql);
          return { changes: 1 };
        },
        get: () => undefined,
        all: () => [],
      }),
    };

    const result = createScheduledTask({
      name: 'Quebrada',
      prompt: 'x',
      scheduleType: 'cron',
      scheduleValue: '99 99 * * *',
      status: 'active',
      notify: false,
      tags: [],
    });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain(LLM_ERROR_TABLE['CRON-INVALID'].userMessage);
    expect(runs.some((sql) => sql.includes('INSERT INTO scheduled_tasks'))).toBe(false);
  });

  it('AC-B24: updateScheduledTask com cron invalido retorna { error } e NAO grava', () => {
    const runs: string[] = [];
    const currentRow = {
      id: 'task-1',
      name: 'Boa',
      prompt: 'x',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      status: 'active',
      run_count: 0,
      notify: 0,
      tags: '[]',
    };
    h.currentDb.value = {
      prepare: (sql: string) => ({
        run: () => {
          runs.push(sql);
          return { changes: 1 };
        },
        get: () => (sql.includes('WHERE id = ?') ? currentRow : undefined),
        all: () => [],
      }),
    };

    const result = updateScheduledTask('task-1', { scheduleValue: 'lixo' });

    expect(result).toHaveProperty('error');
    expect(runs.some((sql) => sql.startsWith('UPDATE scheduled_tasks'))).toBe(false);
  });

  it('AC-B24: task pre-existente com cron invalido sai do list com scheduleError (badge no card)', () => {
    const rows = [
      {
        id: 'ok',
        name: 'Valida',
        prompt: 'x',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        status: 'active',
        run_count: 0,
        notify: 0,
        tags: '[]',
      },
      {
        id: 'broken',
        name: 'Inerte',
        prompt: 'x',
        schedule_type: 'cron',
        schedule_value: 'not-a-cron',
        status: 'active',
        run_count: 0,
        notify: 0,
        tags: '[]',
      },
    ];
    h.currentDb.value = {
      prepare: () => ({
        all: () => rows,
        run: () => ({ changes: 1 }),
        get: () => undefined,
      }),
    };

    const tasks = getAllScheduledTasks();
    const ok = tasks.find((t) => t.id === 'ok');
    const broken = tasks.find((t) => t.id === 'broken');

    expect(ok?.scheduleError).toBeUndefined();
    expect(broken?.scheduleError).toContain(LLM_ERROR_TABLE['CRON-INVALID'].userMessage);
  });
});
