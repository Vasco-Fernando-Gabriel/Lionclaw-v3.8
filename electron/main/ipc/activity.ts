import { ipcMain } from 'electron';
import { createLogger } from '../logger';
import { getActivityBlocks } from '../db';
import type { IpcContext } from './context';
import type { ActivityTurnBlock } from '../../../src/types';

const logger = createLogger('ipc');

export function registerActivityHandlers(_ctx: IpcContext): void {
  ipcMain.handle(
    'activity:get-blocks',
    (_event, sessionId: string): ActivityTurnBlock[] => {
      try {
        return getActivityBlocks(sessionId);
      } catch (err) {
        logger.error({ err, sessionId }, 'activity:get-blocks failed');
        return [];
      }
    },
  );
}
