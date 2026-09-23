import { ipcMain } from 'electron';
import { createLogger } from '../logger';
import type { IpcContext } from './context';
import { getActiveChatSession, listOpenDesktopSessionRows, replaceLaneSession } from '../db';
import { readDefaultOrchestratorColumns } from '../orchestrator-selection';
import { pickMostRecentLane } from '../lanes';
import { isSessionClearing } from '../clearing-sessions';
import { getDesktopSessionExecutionState } from '../orchestrator';
import { pruneIdleDesktopLane } from '../desktop-lanes';
import type { ChatClearResult } from '../../../src/types';

const logger = createLogger('ipc-chat-deprecated');

function deprecatedArchiveRefusal(channel: string, sessionId: string): 'session_clearing' | 'session_busy' | null {
  if (isSessionClearing(sessionId)) {
    logger.warn({ channel, sessionId }, 'canal deprecated recusado: sessao em Clear');
    return 'session_clearing';
  }
  if (getDesktopSessionExecutionState(sessionId) !== 'idle') {
    logger.warn({ channel, sessionId }, 'canal deprecated recusado: turno em voo ou na fila');
    return 'session_busy';
  }
  return null;
}

function resolveDeprecatedSessionId(channel: string, sessionId?: string): string | null {
  if (typeof sessionId === 'string' && sessionId) return sessionId;
  logger.warn({ channel }, 'canal deprecated chamado sem sessionId: resolvendo pela heuristica antiga');
  return getActiveChatSession()?.id ?? null;
}

function resolveDeprecatedClearTarget(channel: string, sessionId?: string): string | null {
  if (typeof sessionId === 'string' && sessionId) return sessionId;
  logger.warn({ channel }, 'canal deprecated chamado sem sessionId: Clear na lane com lastUserMessageAt mais recente');
  return pickMostRecentLane(listOpenDesktopSessionRows())?.id ?? null;
}

function toLegacyCompactResult(result: ChatClearResult): {
  success: boolean;
  newSessionId?: string;
  reason?: string;
  error?: string;
} {
  if (result.ok) {
    return { success: true, ...(result.newSessionId ? { newSessionId: result.newSessionId } : {}) };
  }
  return { success: false, reason: result.code, error: result.error };
}

export function registerChatDeprecatedHandlers(ctx: IpcContext): void {
  const getMainWindow = ctx.getMainWindow;

  ipcMain.handle('chat:get-active-session', () => {
    logger.warn('chat:get-active-session e deprecated (heuristica global)');
    return getActiveChatSession();
  });

  ipcMain.handle('chat:compact-session', async (_event, sessionId?: string) => {
    const target = resolveDeprecatedClearTarget('chat:compact-session', sessionId);
    if (!target) return { success: false, reason: 'no_active_session' };
    const { clearLaneSession } = await import('../chat-clear');
    return toLegacyCompactResult(await clearLaneSession(target, { getMainWindow }));
  });

  ipcMain.handle(
    'memory:trigger-compaction',
    async (_event, sessionId?: string): Promise<ChatClearResult | undefined> => {
      const target = resolveDeprecatedClearTarget('memory:trigger-compaction', sessionId);
      if (!target) return undefined;
      const { clearLaneSession } = await import('../chat-clear');
      return clearLaneSession(target, { getMainWindow });
    },
  );

  ipcMain.handle('chat:clear-session', async (_event, sessionId?: string) => {
    const target = resolveDeprecatedSessionId('chat:clear-session', sessionId);
    if (!target) {
      logger.warn('No active session to clear');
      return { success: false, reason: 'no_active_session' };
    }

    const refusal = deprecatedArchiveRefusal('chat:clear-session', target);
    if (refusal) return { success: false, reason: refusal };

    logger.info({ sessionId: target }, 'Session clear triggered (no compaction)');

    const replaced = replaceLaneSession({
      sessionId: target,
      finalStatus: 'archived',
      orchestrator: readDefaultOrchestratorColumns(),
    });
    pruneIdleDesktopLane(target);
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('chat:sessions-updated');

    return { success: true, ...(replaced.newSessionId ? { newSessionId: replaced.newSessionId } : {}) };
  });

  ipcMain.handle('chat:archive-session', (_event, sessionId: string) => {
    if (deprecatedArchiveRefusal('chat:archive-session', sessionId)) return false;
    replaceLaneSession({
      sessionId,
      finalStatus: 'archived',
      orchestrator: readDefaultOrchestratorColumns(),
    });
    pruneIdleDesktopLane(sessionId);
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('chat:sessions-updated');
    return true;
  });
}
