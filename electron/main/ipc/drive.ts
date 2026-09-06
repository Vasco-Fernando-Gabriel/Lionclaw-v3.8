import { ipcMain } from 'electron';
import { createLogger } from '../logger';
import { getDriveState, getActiveChatSession } from '../db';
import { getPipelineDriveCoordinator } from '../pipeline-drive-coordinator';
import type { IpcContext } from './context';
import type { DriveState } from '../../../src/types';

const logger = createLogger('ipc');

export function registerDriveHandlers(_ctx: IpcContext): void {
  ipcMain.handle(
    'drive:get-state',
    (_event, projectId: string): DriveState | null => {
      try {
        const coordinator = getPipelineDriveCoordinator();
        if (coordinator) {
          const live = coordinator.getDrive(projectId);
          if (live) return live;
        }
        return getDriveState(projectId);
      } catch (err) {
        logger.error({ err, projectId }, 'drive:get-state failed');
        return null;
      }
    },
  );

  ipcMain.handle(
    'drive:start',
    (
      _event,
      projectId: string,
      mode: 'semi' | 'full',
    ): { ok: true; drive: DriveState } | { error: string } => {
      try {
        const coordinator = getPipelineDriveCoordinator();
        if (!coordinator) {
          return { error: 'coordenador de drive nao inicializado' };
        }
        const persisted = getDriveState(projectId);
        const sessionId = persisted?.sessionId ?? getActiveChatSession()?.id;
        if (!sessionId) {
          return {
            error:
              'nenhuma sessao de chat ativa para dirigir o pipeline. Abra/foque um chat e tente de novo.',
          };
        }
        const result = coordinator.startDrive(projectId, sessionId, mode);
        if (!result.ok) return { error: result.error };
        return { ok: true, drive: result.drive };
      } catch (err) {
        logger.error({ err, projectId, mode }, 'drive:start failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'drive:assumir',
    (
      _event,
      projectId: string,
    ): { ok: true; drive: DriveState } | { error: string } => {
      try {
        const coordinator = getPipelineDriveCoordinator();
        if (!coordinator) {
          return { error: 'coordenador de drive nao inicializado' };
        }
        const result = coordinator.assumirDrive(projectId);
        if (!result.ok) return { error: result.error };
        return { ok: true, drive: result.drive };
      } catch (err) {
        logger.error({ err, projectId }, 'drive:assumir failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'drive:stop',
    (_event, projectId: string): { ok: true } | { error: string } => {
      try {
        const coordinator = getPipelineDriveCoordinator();
        if (!coordinator) {
          return { error: 'coordenador de drive nao inicializado' };
        }
        coordinator.stopDrive(projectId, 'ui-stop');
        return { ok: true };
      } catch (err) {
        logger.error({ err, projectId }, 'drive:stop failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'drive:resume',
    (
      _event,
      projectId: string,
    ): { ok: true; drive: DriveState } | { error: string } => {
      try {
        const coordinator = getPipelineDriveCoordinator();
        if (!coordinator) {
          return { error: 'coordenador de drive nao inicializado' };
        }
        const result = coordinator.resumeDrive(projectId, { fromHuman: true });
        if (!result.ok) return { error: result.error };
        return { ok: true, drive: result.drive };
      } catch (err) {
        logger.error({ err, projectId }, 'drive:resume failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'drive:set-mode',
    (
      _event,
      projectId: string,
      mode: 'semi' | 'full',
    ): { ok: true; drive: DriveState } | { error: string } => {
      try {
        const coordinator = getPipelineDriveCoordinator();
        if (!coordinator) {
          return { error: 'coordenador de drive nao inicializado' };
        }
        const result = coordinator.setMode(projectId, mode);
        if (!result.ok) return { error: result.error };
        return { ok: true, drive: result.drive };
      } catch (err) {
        logger.error({ err, projectId, mode }, 'drive:set-mode failed');
        return { error: (err as Error).message };
      }
    },
  );
}
