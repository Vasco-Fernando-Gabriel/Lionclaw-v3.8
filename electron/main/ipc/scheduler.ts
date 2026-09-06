import { ipcMain } from 'electron';
import type { IpcContext } from './context';
import {
  getAllScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  getTaskRuns,
  reviewTaskRun,
  getPendingReviewCount,
  getActivities,
  getActivityStats,
  getAllTags,
} from '../scheduler';
import {
  deleteSessionById,
  getScheduledSessions,
  deleteScheduledSessions,
  getAllTasks,
  getTask,
  insertTask,
  updateTask as updateTaskDb,
  deleteTask as deleteTaskDb,
  getTaskCategories,
  getPendingTasksDueCount,
} from '../db';

export function registerSchedulerHandlers(_ctx: IpcContext): void {
  ipcMain.handle('scheduler:list', () => {
    return getAllScheduledTasks();
  });

  ipcMain.handle('scheduler:create', (_event, task) => {
    return createScheduledTask(task);
  });

  ipcMain.handle('scheduler:update', (_event, id: string, updates) => {
    return updateScheduledTask(id, updates);
  });

  ipcMain.handle('scheduler:delete', (_event, id: string) => {
    deleteScheduledTask(id);
  });

  ipcMain.handle('scheduler:pause', (_event, id: string) => {
    return updateScheduledTask(id, { status: 'paused' });
  });

  ipcMain.handle('scheduler:resume', (_event, id: string) => {
    return updateScheduledTask(id, { status: 'active' });
  });

  ipcMain.handle('scheduler:get-runs', (_event, taskId: string) => {
    return getTaskRuns(taskId);
  });

  ipcMain.handle(
    'scheduler:review-run',
    (
      _event,
      runId: number,
      status: 'validated' | 'rejected',
      note?: string,
    ) => {
      reviewTaskRun(runId, status, note);
    },
  );

  ipcMain.handle('scheduler:pending-count', () => {
    return getPendingReviewCount();
  });

  ipcMain.handle('scheduler:get-sessions', () => {
    return getScheduledSessions();
  });

  ipcMain.handle('scheduler:delete-session', (_event, sessionId: string) => {
    deleteSessionById(sessionId);
  });

  ipcMain.handle('scheduler:cleanup-sessions', () => {
    deleteScheduledSessions();
  });

  ipcMain.handle(
    'scheduler:get-activities',
    (
      _event,
      filters: {
        from: string;
        to: string;
        subagent?: string;
        status?: string;
        tags?: string[];
      },
    ) => {
      return getActivities(filters);
    },
  );

  ipcMain.handle(
    'scheduler:get-activity-stats',
    (_event, from: string, to: string) => {
      return getActivityStats(from, to);
    },
  );

  ipcMain.handle('scheduler:get-all-tags', () => {
    return getAllTags();
  });

  ipcMain.handle(
    'tasks:list',
    (
      _event,
      filters?: {
        status?: string;
        category?: string;
        priority?: string;
        period?: 'last30' | 'last90' | 'all';
      },
    ) => {
      return getAllTasks(filters);
    },
  );

  ipcMain.handle('tasks:get', (_event, id: string) => {
    return getTask(id);
  });

  ipcMain.handle(
    'tasks:create',
    (
      _event,
      task: {
        title: string;
        description?: string;
        category?: string;
        priority?: string;
        due_date?: string;
      },
    ) => {
      return insertTask(task);
    },
  );

  ipcMain.handle(
    'tasks:update',
    (_event, id: string, updates: Record<string, unknown>) => {
      return updateTaskDb(id, updates);
    },
  );

  ipcMain.handle('tasks:delete', (_event, id: string) => {
    deleteTaskDb(id);
  });

  ipcMain.handle('tasks:categories', () => {
    return getTaskCategories();
  });

  ipcMain.handle('tasks:pending-due-count', () => {
    return getPendingTasksDueCount();
  });
}
