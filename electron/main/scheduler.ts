import { BrowserWindow, Notification } from 'electron';
import { CronExpressionParser } from 'cron-parser';
import crypto from 'crypto';
import { getDb, createSession } from './db';
import { createLogger } from './logger';
import { executeCronQuery } from './orchestrator';
import { InvalidOrchestratorSelectionError } from './orchestrator-selection';
import { smokeAudit } from './smoke-audit';
import { sendTelegramNotification, isTelegramConfigured } from './telegram-bridge';
import { buildExecutionError, translateProviderError } from './agent-runtime/llm-error';
const tryBeginBackgroundWorkStart = (_lane: string): (() => void) | null => () => {};
import type { ScheduledTask, TaskRun } from '../../src/types';

const logger = createLogger('scheduler');

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let getWindowFn: (() => BrowserWindow | null) | null = null;
const runningTasks = new Set<string>();
export const SCHEDULER_CRON_TIMEZONE = 'UTC';

export function hasRunningScheduledTasks(): boolean {
  return runningTasks.size > 0;
}

interface SchedulerDb {
  prepare(sql: string): unknown;
}

export function startScheduler(getWindow: () => BrowserWindow | null): void {
  if (schedulerInterval) {
    logger.warn('Scheduler already started, ignoring duplicate start');
    return;
  }

  getWindowFn = getWindow;
  const reconciled = reconcileActiveCronNextRuns(getDb());
  if (reconciled > 0) {
    logger.info({ count: reconciled, timezone: SCHEDULER_CRON_TIMEZONE }, 'Reconciled active cron next_run values');
  }

  schedulerInterval = setInterval(() => {
    checkAndRunTasks();
  }, 30_000);

  checkAndRunTasks();
  logger.info('Scheduler started');
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  logger.info('Scheduler stopped');
}

async function checkAndRunTasks(): Promise<void> {
  const db = getDb();
  const now = new Date();

  const tasks = db.prepare(`
    SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ?
  `).all(now.toISOString()) as Array<Record<string, unknown>>;

  for (const task of tasks) {
    const taskId = task['id'] as string;
    const taskName = task['name'] as string;
    const prompt = task['prompt'] as string;
    const scheduleType = task['schedule_type'] as string;
    const scheduleValue = task['schedule_value'] as string;
    const subagent = task['subagent'] as string | null;
    const notify = (task['notify'] as number) === 1;
    const scheduledFor = task['next_run'] as string;

    if (runningTasks.has(taskId)) {
      logger.debug({ taskId, taskName }, 'Task already running, skipping');
      continue;
    }

    const releaseUpdateLease = tryBeginBackgroundWorkStart('scheduled-task');
    if (releaseUpdateLease === null) {
      logger.info('Scheduler tick pausado: manutencao de update em andamento (D14)');
      break;
    }

    runningTasks.add(taskId);
    if (!claimScheduledTaskForRun(db, taskId, scheduledFor)) {
      runningTasks.delete(taskId);
      releaseUpdateLease();
      logger.debug({ taskId, taskName, scheduledFor }, 'Task already claimed by another scheduler, skipping');
      continue;
    }
    releaseUpdateLease();

    logger.info({ taskId, taskName }, 'Running scheduled task');

    const sessionId = crypto.randomUUID();
    createSession(sessionId, `[Scheduler] ${taskName}`, subagent || undefined, {
      type: 'scheduled',
      taskId,
    });

    const runResult = db.prepare(`
      INSERT INTO task_runs (task_id, started_at, status, session_id, scheduled_for)
      VALUES (?, datetime('now'), 'running', ?, ?)
    `).run(taskId, sessionId, scheduledFor);
    const runId = runResult.lastInsertRowid as number;

    runTaskAsync(taskId, taskName, prompt, subagent, sessionId, runId, scheduleType, scheduleValue, notify);
  }
}

async function runTaskAsync(
  taskId: string,
  taskName: string,
  prompt: string,
  subagent: string | null,
  sessionId: string,
  runId: number,
  scheduleType: string,
  scheduleValue: string,
  notify: boolean,
): Promise<void> {
  const db = getDb();

  try {
    if (getWindowFn) {
      await executeCronQuery(prompt, {
        agentId: subagent || undefined,
        sessionId,
        silent: true,
      }, getWindowFn);
    }

    db.prepare(`
      UPDATE task_runs SET completed_at = datetime('now'), status = 'success', review_status = 'pending_review' WHERE id = ?
    `).run(runId);

    if (notify) {
      showNotification(taskName, 'Tarefa concluida - clique para revisar');
      if (isTelegramConfigured()) {
        sendTelegramNotification(`Tarefa "${taskName}" concluida com sucesso. Abra o app para revisar.`).catch(() => {});
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    db.prepare(`
      UPDATE task_runs SET completed_at = datetime('now'), status = 'error', error = ? WHERE id = ?
    `).run(errorMsg, runId);

    if (notify) {
      const friendly = buildTaskFailureNotification(taskName, error);
      showNotification(taskName, friendly.substring(0, 180));
      if (isTelegramConfigured()) {
        sendTelegramNotification(friendly).catch(() => {});
      }
    }

    const orchestratorCode =
      error instanceof InvalidOrchestratorSelectionError ? error.code : undefined;
    if (error instanceof InvalidOrchestratorSelectionError) {
      smokeAudit('orchestrator_error', {
        lane: 'cron',
        code: error.code,
        missingField: error.missingField ?? null,
      });
    }
    logger.error({ taskId, error, orchestratorCode }, 'Task execution failed');
  } finally {
    runningTasks.delete(taskId);

    const nextRun = scheduleType === 'once' ? null : calculateNextRun(scheduleType, scheduleValue);

    db.prepare(`
      UPDATE scheduled_tasks
      SET last_run = datetime('now'),
          run_count = run_count + 1,
          next_run = ?,
          status = ?
      WHERE id = ?
    `).run(
      nextRun?.toISOString() || null,
      scheduleType === 'once' ? 'completed' : 'active',
      taskId,
    );

    logger.info({ taskId, taskName }, 'Scheduled task completed');
  }
}

export function claimScheduledTaskForRun(
  db: SchedulerDb,
  taskId: string,
  scheduledFor: string,
): boolean {
  const statement = db.prepare(`
    UPDATE scheduled_tasks
    SET next_run = NULL
    WHERE id = ?
      AND status = 'active'
      AND next_run = ?
  `) as { run: (...params: unknown[]) => { changes?: number } };
  const result = statement.run(taskId, scheduledFor);
  return result.changes === 1;
}

export function calculateNextRun(
  scheduleType: string,
  scheduleValue: string,
  currentDate = new Date(),
): Date | null {
  switch (scheduleType) {
    case 'cron': {
      try {
        const interval = CronExpressionParser.parse(scheduleValue, {
          currentDate,
          tz: SCHEDULER_CRON_TIMEZONE,
        });
        return interval.next().toDate();
      } catch {
        logger.error({ scheduleValue }, 'Invalid cron expression');
        return null;
      }
    }
    case 'interval': {
      const ms = parseInt(scheduleValue, 10);
      if (isNaN(ms)) return null;
      return new Date(currentDate.getTime() + ms);
    }
    case 'once': {
      const date = new Date(scheduleValue);
      return isNaN(date.getTime()) ? null : date;
    }
    default:
      return null;
  }
}

export function reconcileActiveCronNextRuns(
  db: SchedulerDb,
  currentDate = new Date(),
): number {
  const select = db.prepare(`
    SELECT id, schedule_value, next_run
    FROM scheduled_tasks
    WHERE status = 'active'
      AND schedule_type = 'cron'
  `) as { all: () => Array<Record<string, unknown>> };
  const rows = select.all();
  const update = db.prepare(
    'UPDATE scheduled_tasks SET next_run = ? WHERE id = ?',
  ) as { run: (...params: unknown[]) => unknown };
  let updated = 0;

  for (const row of rows) {
    const id = row['id'] as string;
    const scheduleValue = row['schedule_value'] as string;
    const currentNextRun = (row['next_run'] as string | null) ?? null;
    const nextRun = calculateNextRun('cron', scheduleValue, currentDate);
    const nextRunIso = nextRun?.toISOString() ?? null;

    if (nextRunIso !== currentNextRun) {
      update.run(nextRunIso, id);
      updated++;
    }
  }

  return updated;
}

function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title: `LionClaw: ${title}`, body }).show();
  }
}


export function buildTaskFailureNotification(taskName: string, error: unknown): string {
  const typed = translateProviderError(error);
  return `Tarefa "${taskName}" falhou: ${typed.userMessage} ${typed.suggestedAction}`;
}

export function validateScheduleValue(scheduleType: string, scheduleValue: string): string | null {
  switch (scheduleType) {
    case 'cron': {
      try {
        CronExpressionParser.parse(scheduleValue, { tz: SCHEDULER_CRON_TIMEZONE });
        return null;
      } catch {
        const entry = buildExecutionError('CRON-INVALID', `scheduleValue=${scheduleValue}`);
        return `${entry.userMessage} ${entry.suggestedAction}`;
      }
    }
    case 'interval': {
      const ms = parseInt(scheduleValue, 10);
      return isNaN(ms) || ms <= 0
        ? 'Intervalo invalido: informe o periodo em milissegundos (> 0).'
        : null;
    }
    case 'once': {
      const date = new Date(scheduleValue);
      return isNaN(date.getTime())
        ? 'Data invalida para execucao unica.'
        : null;
    }
    default:
      return `Tipo de agendamento desconhecido: ${scheduleType}`;
  }
}


export function getAllScheduledTasks(): ScheduledTask[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map(mapTask);
}

export function createScheduledTask(
  task: Omit<ScheduledTask, 'id' | 'lastRun' | 'nextRun' | 'runCount' | 'scheduleError'>,
): ScheduledTask | { error: string } {
  const validationError = validateScheduleValue(task.scheduleType, task.scheduleValue);
  if (validationError) {
    logger.warn({ scheduleType: task.scheduleType, scheduleValue: task.scheduleValue }, 'createScheduledTask: schedule invalido rejeitado');
    return { error: validationError };
  }

  const db = getDb();
  const id = crypto.randomUUID();

  const nextRun = calculateNextRun(task.scheduleType, task.scheduleValue);

  db.prepare(`
    INSERT INTO scheduled_tasks (id, name, prompt, subagent, schedule_type, schedule_value, status, next_run, notify, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    task.name,
    task.prompt,
    task.subagent || null,
    task.scheduleType,
    task.scheduleValue,
    task.status,
    nextRun?.toISOString() || null,
    task.notify ? 1 : 0,
    JSON.stringify(task.tags || []),
  );

  return getScheduledTask(id)!;
}

export function updateScheduledTask(
  id: string,
  updates: Partial<ScheduledTask>,
): ScheduledTask | { error: string } {
  const db = getDb();

  if (updates.scheduleType !== undefined || updates.scheduleValue !== undefined) {
    const current = getScheduledTask(id);
    const effectiveType = updates.scheduleType ?? current?.scheduleType ?? '';
    const effectiveValue = updates.scheduleValue ?? current?.scheduleValue ?? '';
    const validationError = validateScheduleValue(effectiveType, effectiveValue);
    if (validationError) {
      logger.warn({ id, effectiveType, effectiveValue }, 'updateScheduledTask: schedule invalido rejeitado');
      return { error: validationError };
    }
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.prompt !== undefined) { fields.push('prompt = ?'); values.push(updates.prompt); }
  if (updates.subagent !== undefined) { fields.push('subagent = ?'); values.push(updates.subagent); }
  if (updates.scheduleType !== undefined) { fields.push('schedule_type = ?'); values.push(updates.scheduleType); }
  if (updates.scheduleValue !== undefined) { fields.push('schedule_value = ?'); values.push(updates.scheduleValue); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.notify !== undefined) { fields.push('notify = ?'); values.push(updates.notify ? 1 : 0); }
  if (updates.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(updates.tags)); }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  if (updates.scheduleType || updates.scheduleValue) {
    const task = getScheduledTask(id);
    if (task) {
      const nextRun = calculateNextRun(task.scheduleType, task.scheduleValue);
      db.prepare('UPDATE scheduled_tasks SET next_run = ? WHERE id = ?').run(nextRun?.toISOString() || null, id);
    }
  }

  return getScheduledTask(id)!;
}

export function deleteScheduledTask(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getTaskRuns(taskId: string): TaskRun[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 50'
  ).all(taskId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as number,
    taskId: r['task_id'] as string,
    startedAt: r['started_at'] as string,
    completedAt: r['completed_at'] as string | undefined,
    status: r['status'] as TaskRun['status'],
    result: r['result'] as string | undefined,
    error: r['error'] as string | undefined,
    tokensUsed: (r['tokens_used'] as number) || 0,
    costUsd: (r['cost_usd'] as number) || 0,
    sessionId: r['session_id'] as string | undefined,
    reviewStatus: r['review_status'] as TaskRun['reviewStatus'],
    reviewNote: r['review_note'] as string | undefined,
    reviewedAt: r['reviewed_at'] as string | undefined,
  }));
}

export function reviewTaskRun(runId: number, status: 'validated' | 'rejected', note?: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE task_runs SET review_status = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ?
  `).run(status, note || null, runId);
}

export function getPendingReviewCount(): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as c FROM task_runs WHERE review_status = 'pending_review'"
  ).get() as { c: number };
  return row.c;
}

function getScheduledTask(id: string): ScheduledTask | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapTask(row);
}

function mapTask(row: Record<string, unknown>): ScheduledTask {
  const scheduleType = row['schedule_type'] as ScheduledTask['scheduleType'];
  const scheduleValue = row['schedule_value'] as string;
  const scheduleError = validateScheduleValue(scheduleType, scheduleValue);
  return {
    ...(scheduleError !== null ? { scheduleError } : {}),
    id: row['id'] as string,
    name: row['name'] as string,
    prompt: row['prompt'] as string,
    subagent: row['subagent'] as string | undefined,
    scheduleType: row['schedule_type'] as ScheduledTask['scheduleType'],
    scheduleValue: row['schedule_value'] as string,
    status: row['status'] as ScheduledTask['status'],
    lastRun: row['last_run'] as string | undefined,
    nextRun: row['next_run'] as string | undefined,
    runCount: (row['run_count'] as number) || 0,
    notify: (row['notify'] as number) === 1,
    tags: JSON.parse((row['tags'] as string) || '[]'),
  };
}


export interface ActivityItem {
  runId: number;
  taskId: string;
  taskName: string;
  prompt: string;
  subagent: string | null;
  tags: string[];
  scheduledFor: string;
  startedAt: string | null;
  completedAt: string | null;
  status: 'scheduled' | 'running' | 'success' | 'error';
  reviewStatus: 'pending_review' | 'validated' | 'rejected' | null;
  sessionId: string | null;
  error: string | null;
}

function projectOccurrences(
  scheduleType: string,
  scheduleValue: string,
  nextRun: string | null,
  from: Date,
  to: Date,
  maxOccurrences = 200,
): string[] {
  const results: string[] = [];

  if (scheduleType === 'cron') {
    try {
      const startFrom = new Date(Math.min(from.getTime(), Date.now()));
      const interval = CronExpressionParser.parse(scheduleValue, {
        currentDate: startFrom,
        tz: SCHEDULER_CRON_TIMEZONE,
      });
      for (let i = 0; i < maxOccurrences; i++) {
        const next = interval.next().toDate();
        if (next >= to) break;
        if (next >= from) {
          results.push(next.toISOString());
        }
      }
    } catch {
      if (nextRun) {
        const d = new Date(nextRun);
        if (d >= from && d < to) results.push(d.toISOString());
      }
    }
  } else if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (!isNaN(ms) && ms > 0 && nextRun) {
      let cursor = new Date(nextRun).getTime();
      while (cursor - ms >= from.getTime()) {
        cursor -= ms;
      }
      for (let i = 0; i < maxOccurrences; i++) {
        if (cursor >= to.getTime()) break;
        if (cursor >= from.getTime()) {
          results.push(new Date(cursor).toISOString());
        }
        cursor += ms;
      }
    }
  } else if (scheduleType === 'once') {
    if (nextRun) {
      const d = new Date(nextRun);
      if (d >= from && d < to) results.push(d.toISOString());
    }
  }

  return results;
}

export function getActivities(filters: {
  from: string;
  to: string;
  subagent?: string;
  status?: string;
  tags?: string[];
}): ActivityItem[] {
  const db = getDb();

  const runConditions: string[] = [
    '(COALESCE(tr.scheduled_for, tr.started_at) >= ? AND COALESCE(tr.scheduled_for, tr.started_at) < ?)',
  ];
  const runParams: unknown[] = [filters.from, filters.to];

  if (filters.subagent) {
    runConditions.push('st.subagent = ?');
    runParams.push(filters.subagent);
  }
  if (filters.status && filters.status !== 'scheduled') {
    runConditions.push('tr.status = ?');
    runParams.push(filters.status);
  }

  const runsQuery = `
    SELECT
      tr.id as run_id,
      tr.task_id,
      st.name as task_name,
      st.prompt,
      st.subagent,
      st.tags,
      COALESCE(tr.scheduled_for, tr.started_at) as scheduled_for,
      tr.started_at,
      tr.completed_at,
      tr.status,
      tr.review_status,
      tr.session_id,
      tr.error
    FROM task_runs tr
    JOIN scheduled_tasks st ON st.id = tr.task_id
    WHERE ${runConditions.join(' AND ')}
    ORDER BY scheduled_for ASC
  `;

  const runs = db.prepare(runsQuery).all(...runParams) as Array<Record<string, unknown>>;

  const items: ActivityItem[] = [];

  for (const r of runs) {
    items.push({
      runId: r['run_id'] as number,
      taskId: r['task_id'] as string,
      taskName: r['task_name'] as string,
      prompt: r['prompt'] as string,
      subagent: (r['subagent'] as string) || null,
      tags: JSON.parse((r['tags'] as string) || '[]'),
      scheduledFor: r['scheduled_for'] as string,
      startedAt: (r['started_at'] as string) || null,
      completedAt: (r['completed_at'] as string) || null,
      status: r['status'] as 'running' | 'success' | 'error',
      reviewStatus: (r['review_status'] as ActivityItem['reviewStatus']) || null,
      sessionId: (r['session_id'] as string) || null,
      error: (r['error'] as string) || null,
    });
  }

  if (!filters.status || filters.status === 'scheduled') {
    const taskConditions: string[] = ["st.status = 'active'"];
    const taskParams: unknown[] = [];

    if (filters.subagent) {
      taskConditions.push('st.subagent = ?');
      taskParams.push(filters.subagent);
    }

    const tasksQuery = `
      SELECT
        st.id as task_id,
        st.name as task_name,
        st.prompt,
        st.subagent,
        st.tags,
        st.schedule_type,
        st.schedule_value,
        st.next_run
      FROM scheduled_tasks st
      WHERE ${taskConditions.join(' AND ')}
    `;

    const activeTasks = db.prepare(tasksQuery).all(...taskParams) as Array<Record<string, unknown>>;

    const fromDate = new Date(filters.from);
    const toDate = new Date(filters.to);

    const existingRunTimes = new Set(
      items.map(i => `${i.taskId}|${i.scheduledFor.slice(0, 16)}`),
    );

    for (const t of activeTasks) {
      const taskId = t['task_id'] as string;
      const scheduleType = t['schedule_type'] as string;
      const scheduleValue = t['schedule_value'] as string;
      const nextRun = (t['next_run'] as string) || null;

      const occurrences = projectOccurrences(scheduleType, scheduleValue, nextRun, fromDate, toDate);

      for (const occ of occurrences) {
        const key = `${taskId}|${occ.slice(0, 16)}`;
        if (existingRunTimes.has(key)) continue;

        if (new Date(occ) <= new Date()) continue;

        items.push({
          runId: 0,
          taskId,
          taskName: t['task_name'] as string,
          prompt: t['prompt'] as string,
          subagent: (t['subagent'] as string) || null,
          tags: JSON.parse((t['tags'] as string) || '[]'),
          scheduledFor: occ,
          startedAt: null,
          completedAt: null,
          status: 'scheduled',
          reviewStatus: null,
          sessionId: null,
          error: null,
        });
      }
    }
  }

  items.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));

  if (filters.tags && filters.tags.length > 0) {
    return items.filter(item =>
      filters.tags!.some(tag => item.tags.includes(tag))
    );
  }

  return items;
}

export function getActivityStats(from: string, to: string): {
  scheduled: number;
  running: number;
  success: number;
  error: number;
} {
  const db = getDb();
  const stats = { scheduled: 0, running: 0, success: 0, error: 0 };

  const rows = db.prepare(`
    SELECT status, COUNT(*) as c
    FROM task_runs
    WHERE COALESCE(scheduled_for, started_at) >= ? AND COALESCE(scheduled_for, started_at) < ?
    GROUP BY status
  `).all(from, to) as Array<{ status: string; c: number }>;

  for (const row of rows) {
    if (row.status in stats) {
      stats[row.status as keyof typeof stats] = row.c;
    }
  }

  const activeTasks = db.prepare(`
    SELECT schedule_type, schedule_value, next_run
    FROM scheduled_tasks
    WHERE status = 'active'
  `).all() as Array<Record<string, unknown>>;

  const fromDate = new Date(from);
  const toDate = new Date(to);
  const now = new Date();

  for (const t of activeTasks) {
    const occurrences = projectOccurrences(
      t['schedule_type'] as string,
      t['schedule_value'] as string,
      (t['next_run'] as string) || null,
      fromDate,
      toDate,
    );
    stats.scheduled += occurrences.filter(occ => new Date(occ) > now).length;
  }

  return stats;
}

export function getAllTags(): string[] {
  const db = getDb();
  const rows = db.prepare("SELECT DISTINCT tags FROM scheduled_tasks WHERE tags != '[]'").all() as Array<{ tags: string }>;
  const tagSet = new Set<string>();
  for (const row of rows) {
    const tags = JSON.parse(row.tags) as string[];
    tags.forEach(t => tagSet.add(t));
  }
  return Array.from(tagSet).sort();
}
