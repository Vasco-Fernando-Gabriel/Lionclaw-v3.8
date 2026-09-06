import { ipcMain, BrowserWindow } from 'electron';
import type { IpcContext } from './context';
import {
  closeTerminalSession,
  openTerminalSession,
  resizeTerminalSession,
  writeTerminalSession,
} from '../terminal-pty';

interface TerminalOpenPayload {
  sessionId?: unknown;
  cols?: unknown;
  rows?: unknown;
}
interface TerminalWritePayload {
  sessionId?: unknown;
  data?: unknown;
}

export function registerTerminalHandlers(_ctx: IpcContext): void {
  ipcMain.handle('terminal:open', (event, payload: TerminalOpenPayload) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return { ok: false as const, error: 'janela de origem nao encontrada' };
    }
    return openTerminalSession(
      window,
      typeof payload?.sessionId === 'string' ? payload.sessionId : '',
      payload?.cols,
      payload?.rows,
    );
  });

  ipcMain.handle('terminal:write', (event, payload: TerminalWritePayload) => {
    if (typeof payload?.sessionId !== 'string' || typeof payload?.data !== 'string') return;
    writeTerminalSession(event.sender.id, payload.sessionId, payload.data);
  });

  ipcMain.handle('terminal:resize', (event, payload: TerminalOpenPayload) => {
    if (typeof payload?.sessionId !== 'string') return;
    resizeTerminalSession(event.sender.id, payload.sessionId, payload?.cols, payload?.rows);
  });

  ipcMain.handle('terminal:close', (event, payload: TerminalWritePayload) => {
    if (typeof payload?.sessionId !== 'string') return;
    closeTerminalSession(event.sender.id, payload.sessionId);
  });
}
