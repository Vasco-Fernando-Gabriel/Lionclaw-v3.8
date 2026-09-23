import { ipcMain } from 'electron';
import { createLogger } from '../logger';
import { getDriveState, getDriveSessionId, getOpenLaneSessionById } from '../db';
import { isSessionClearing } from '../clearing-sessions';
import { getPipelineDriveCoordinator } from '../pipeline-drive-coordinator';
import type { IpcContext } from './context';
import type { ChatLaneErrorCode, DriveState } from '../../../src/types';

const logger = createLogger('ipc');

type DriveResult = { ok: true; drive: DriveState; sessionId: string } | { error: string; code?: ChatLaneErrorCode };

function resolveLaneForDrive(sessionId: unknown): { sessionId: string } | { error: string; code: ChatLaneErrorCode } {
  if (typeof sessionId !== 'string' || !sessionId) {
    return {
      error: 'session_required: escolha a lane (conversa aberta) que vai dirigir o pipeline.',
      code: 'session_required',
    };
  }
  if (!getOpenLaneSessionById(sessionId)) {
    return {
      error: 'session_not_active: a conversa escolhida nao e uma lane aberta. Escolha outra lane.',
      code: 'session_not_active',
    };
  }
  if (isSessionClearing(sessionId)) {
    return {
      error: 'session_clearing: esta lane esta limpando a conversa. Tente de novo quando terminar.',
      code: 'session_clearing',
    };
  }
  return { sessionId };
}

export function registerDriveHandlers(_ctx: IpcContext): void {
  ipcMain.handle('drive:get-state', (_event, projectId: string): DriveState | null => {
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
  });

  ipcMain.handle('drive:start', (_event, projectId: string, mode: 'semi' | 'full', sessionId?: string): DriveResult => {
    try {
      const coordinator = getPipelineDriveCoordinator();
      if (!coordinator) {
        return { error: 'coordenador de drive nao inicializado' };
      }
      const lane = resolveLaneForDrive(sessionId);
      if ('error' in lane) return lane;
      const result = coordinator.startDrive(projectId, lane.sessionId, mode);
      if (!result.ok) {
        return { error: result.error, ...(result.code ? { code: result.code } : {}) };
      }
      return { ok: true, drive: result.drive, sessionId: lane.sessionId };
    } catch (err) {
      logger.error({ err, projectId, mode }, 'drive:start failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('drive:assumir', (_event, projectId: string): { ok: true; drive: DriveState } | { error: string } => {
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
  });

  ipcMain.handle('drive:stop', (_event, projectId: string): { ok: true } | { error: string } => {
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
  });

  ipcMain.handle('drive:resume', (_event, projectId: string, sessionId?: string): DriveResult => {
    try {
      const coordinator = getPipelineDriveCoordinator();
      if (!coordinator) {
        return { error: 'coordenador de drive nao inicializado' };
      }
      const requestedLane = sessionId ?? undefined;
      let chosenLane: string | undefined;
      if (requestedLane !== undefined) {
        const lane = resolveLaneForDrive(requestedLane);
        if ('error' in lane) return lane;
        chosenLane = lane.sessionId;
      }
      const result = coordinator.resumeDrive(projectId, chosenLane, { fromHuman: true });
      if (!result.ok) {
        return { error: result.error, ...(result.code ? { code: result.code } : {}) };
      }
      const laneSessionId = result.drive.sessionId ?? chosenLane ?? getDriveSessionId(projectId) ?? '';
      return { ok: true, drive: result.drive, sessionId: laneSessionId };
    } catch (err) {
      logger.error({ err, projectId }, 'drive:resume failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle(
    'drive:set-mode',
    (_event, projectId: string, mode: 'semi' | 'full'): { ok: true; drive: DriveState } | { error: string } => {
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
