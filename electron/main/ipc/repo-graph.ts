import { ipcMain } from 'electron';
import { createLogger } from '../logger';
import {
  upsertLocalRepository,
  getLocalRepository,
  listLocalRepositories,
  removeLocalRepository,
  updateLocalRepositoryGraphState,
  setRepoGraphPromptSuppressedGlobal,
  insertRepoGraphRun,
  updateRepoGraphRun,
  getLatestRepoGraphRun,
  attachSessionRepository,
  detachSessionRepository,
  getSessionActiveRepository,
  setSessionGraphPromptSuppressed,
  getRepoGraphSavingsMetrics,
  getKanbanBoardByRepositoryId,
} from '../db';
import { RepoGraphEngine } from '../repo-graph/engine';
import { CodegraphCliProvider } from '../repo-graph/provider-codegraph';
import type { IpcContext } from './context';
import type { LocalRepositoryRecord, SessionRepoGraphState, RepoGraphSavingsMetrics } from '../repo-graph/types';

const logger = createLogger('ipc');

let engineSingleton: RepoGraphEngine | null = null;

export function getRepoGraphEngine(): RepoGraphEngine {
  if (!engineSingleton) {
    engineSingleton = new RepoGraphEngine(
      {
        upsertLocalRepository,
        getLocalRepository,
        listLocalRepositories,
        removeLocalRepository,
        updateLocalRepositoryGraphState,
        setRepoGraphPromptSuppressedGlobal,
        insertRepoGraphRun,
        updateRepoGraphRun,
        getLatestRepoGraphRun,
        attachSessionRepository,
        detachSessionRepository,
        getSessionActiveRepository,
        setSessionGraphPromptSuppressed,
        getKanbanBoardForRepository: getKanbanBoardByRepositoryId,
      },
      new CodegraphCliProvider(),
    );
    void engineSingleton.reconcileOrphanRuns();
    void engineSingleton.reconcileErroredRepos();
  }
  return engineSingleton;
}

export function registerRepoGraphHandlers(ctx: IpcContext): void {
  const engine = getRepoGraphEngine();

  engine.setStatusEmitter((event) => {
    try {
      ctx.getMainWindow()?.webContents.send('repo-graph:on-status', event);
    } catch (err) {
      logger.warn({ err }, 'repo-graph:on-status broadcast failed');
    }
  });

  ipcMain.handle('repo-graph:list', (): LocalRepositoryRecord[] | { error: string } => {
    try {
      return engine.listRepositories();
    } catch (err) {
      logger.error({ err }, 'repo-graph:list failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle(
    'repo-graph:add-repository',
    async (_event, rawPath: string): Promise<LocalRepositoryRecord | { error: string }> => {
      try {
        return await engine.addRepository(rawPath);
      } catch (err) {
        logger.error({ err, rawPath }, 'repo-graph:add-repository failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle('repo-graph:remove-repository', (_event, repositoryId: string): { ok: true } | { error: string } => {
    try {
      return engine.removeRepository(repositoryId);
    } catch (err) {
      logger.error({ err, repositoryId }, 'repo-graph:remove-repository failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle(
    'repo-graph:get-session-state',
    (_event, sessionId: string): SessionRepoGraphState | { error: string } => {
      try {
        return engine.getSessionState(sessionId);
      } catch (err) {
        logger.error({ err, sessionId }, 'repo-graph:get-session-state failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'repo-graph:attach-session',
    (_event, sessionId: string, repositoryId: string): { ok: true } | { error: string } => {
      try {
        return engine.attachSession(sessionId, repositoryId);
      } catch (err) {
        logger.error({ err, sessionId, repositoryId }, 'repo-graph:attach-session failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle('repo-graph:detach-session', (_event, sessionId: string): { ok: true } | { error: string } => {
    try {
      return engine.detachSession(sessionId);
    } catch (err) {
      logger.error({ err, sessionId }, 'repo-graph:detach-session failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle(
    'repo-graph:set-prompt-suppressed',
    (_event, sessionId: string, suppressed: boolean): { ok: true } | { error: string } => {
      try {
        return engine.setPromptSuppressed(sessionId, Boolean(suppressed));
      } catch (err) {
        logger.error({ err, sessionId }, 'repo-graph:set-prompt-suppressed failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'repo-graph:set-global-prompt-suppressed',
    (_event, repositoryId: string, suppressed: boolean): { ok: true } | { error: string } => {
      try {
        return engine.setGlobalPromptSuppressed(repositoryId, Boolean(suppressed));
      } catch (err) {
        logger.error({ err, repositoryId }, 'repo-graph:set-global-prompt-suppressed failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle('repo-graph:metrics', (): RepoGraphSavingsMetrics | { error: string } => {
    try {
      return getRepoGraphSavingsMetrics();
    } catch (err) {
      logger.error({ err }, 'repo-graph:metrics failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('repo-graph:status', async (_event, repositoryId: string) => {
    try {
      return await engine.status(repositoryId);
    } catch (err) {
      logger.error({ err, repositoryId }, 'repo-graph:status failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle(
    'repo-graph:build',
    async (_event, repositoryId: string, sessionId?: string | null): Promise<{ runId: string } | { error: string }> => {
      try {
        return await engine.startRun(repositoryId, 'build', sessionId ?? null);
      } catch (err) {
        logger.error({ err, repositoryId }, 'repo-graph:build failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'repo-graph:update',
    async (_event, repositoryId: string, sessionId?: string | null): Promise<{ runId: string } | { error: string }> => {
      try {
        return await engine.startRun(repositoryId, 'update', sessionId ?? null);
      } catch (err) {
        logger.error({ err, repositoryId }, 'repo-graph:update failed');
        return { error: (err as Error).message };
      }
    },
  );
}
