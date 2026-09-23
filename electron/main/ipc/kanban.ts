import fs from 'node:fs';
import { ipcMain, shell } from 'electron';
import { createLogger } from '../logger';
import { getKanbanEngine } from '../kanban-engine';
import type { IpcContext } from './context';
import type {
  KanbanBoardCreateInput,
  KanbanCardCreateInput,
  KanbanCardPatch,
  KanbanQueryFilters,
  KanbanReadAttachmentResult,
} from '../../../src/types/kanban';

const logger = createLogger('ipc');

const READ_ATTACHMENT_LIMIT_BYTES = 2 * 1024 * 1024;

export function registerKanbanHandlers(ctx: IpcContext): void {
  const engine = getKanbanEngine();

  engine.setChangeEmitter((event) => {
    try {
      ctx.getMainWindow()?.webContents.send('kanban:changed', event);
    } catch (err) {
      logger.warn({ err }, 'kanban:changed broadcast failed');
    }
  });

  ipcMain.handle('kanban:list-boards', () => {
    try {
      return engine.listBoards();
    } catch (err) {
      logger.error({ err }, 'kanban:list-boards failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('kanban:create-board', (_event, input: KanbanBoardCreateInput) => {
    try {
      return engine.createBoard(input);
    } catch (err) {
      logger.error({ err }, 'kanban:create-board failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('kanban:delete-board', (_event, boardId: string) => {
    try {
      return engine.deleteBoard(boardId);
    } catch (err) {
      logger.error({ err, boardId }, 'kanban:delete-board failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('kanban:query-cards', (_event, filters: KanbanQueryFilters) => {
    try {
      return engine.queryCards(filters ?? {});
    } catch (err) {
      logger.error({ err }, 'kanban:query-cards failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('kanban:create-card', (_event, input: KanbanCardCreateInput) => {
    try {
      return engine.createCard(input, 'user');
    } catch (err) {
      logger.error({ err }, 'kanban:create-card failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('kanban:get-card', (_event, board: string, localId: number) => {
    try {
      return engine.getCard(board, localId);
    } catch (err) {
      logger.error({ err, board, localId }, 'kanban:get-card failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('kanban:update-card', (_event, board: string, localId: number, patch: KanbanCardPatch) => {
    try {
      return engine.updateCard(board, localId, patch ?? {}, 'user');
    } catch (err) {
      logger.error({ err, board, localId }, 'kanban:update-card failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle(
    'kanban:move-card',
    (_event, board: string, localId: number, toColumn: string, reason?: string | null) => {
      try {
        return engine.moveCard(board, localId, toColumn, reason ?? null, 'user');
      } catch (err) {
        logger.error({ err, board, localId, toColumn }, 'kanban:move-card failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'kanban:deliver-card',
    (_event, board: string, localId: number, commit: string, toColumn?: string | null) => {
      try {
        return engine.deliverCard(board, localId, commit, toColumn ?? null, 'user');
      } catch (err) {
        logger.error({ err, board, localId }, 'kanban:deliver-card failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle('kanban:archive-card', (_event, board: string, localId: number) => {
    try {
      return engine.archiveCard(board, localId, 'user');
    } catch (err) {
      logger.error({ err, board, localId }, 'kanban:archive-card failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('kanban:unarchive-card', (_event, board: string, localId: number) => {
    try {
      return engine.unarchiveCard(board, localId, 'user');
    } catch (err) {
      logger.error({ err, board, localId }, 'kanban:unarchive-card failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('kanban:delete-card', (_event, board: string, localId: number, hard?: boolean) => {
    try {
      return engine.deleteCard(board, localId, hard === true, 'user');
    } catch (err) {
      logger.error({ err, board, localId, hard }, 'kanban:delete-card failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('kanban:attach-file', (_event, board: string, localId: number, filePath: string) => {
    try {
      return engine.attachFile(board, localId, filePath, 'user');
    } catch (err) {
      logger.error({ err, board, localId, filePath }, 'kanban:attach-file failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('kanban:remove-attachment', (_event, attachmentId: string) => {
    try {
      return engine.removeAttachment(attachmentId, 'user');
    } catch (err) {
      logger.error({ err, attachmentId }, 'kanban:remove-attachment failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('kanban:open-attachment', async (_event, attachmentId: string) => {
    try {
      const resolved = engine.resolveAttachment(attachmentId);
      if ('error' in resolved) return resolved;
      const failure = await shell.openPath(resolved.absolutePath);
      if (failure !== '') return { error: failure };
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, attachmentId }, 'kanban:open-attachment failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('kanban:read-attachment', (_event, attachmentId: string): KanbanReadAttachmentResult => {
    try {
      const resolved = engine.resolveAttachment(attachmentId);
      if ('error' in resolved) return resolved;
      const sizeBytes = fs.statSync(resolved.absolutePath).size;
      if (sizeBytes > READ_ATTACHMENT_LIMIT_BYTES) {
        return { ok: false, tooLarge: true, sizeBytes };
      }
      return {
        ok: true,
        attachment: resolved.attachment,
        content: fs.readFileSync(resolved.absolutePath, 'utf8'),
      };
    } catch (err) {
      logger.error({ err, attachmentId }, 'kanban:read-attachment failed');
      return { error: (err as Error).message };
    }
  });
}
