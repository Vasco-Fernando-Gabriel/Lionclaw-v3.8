import { ipcMain, BrowserWindow } from 'electron';
import crypto from 'crypto';
import { createLogger } from '../logger';
import type { IpcContext } from './context';
import {
  getAllSessions,
  getSessionMessages,
  trashSession,
  updateSessionStatus,
  getActiveChatSession,
  getDesktopActiveSessionById,
  createSession,
  getSetting,
  insertMessage,
  getSession,
  getChatFeatureToggles,
  setChatFeatureToggles,
} from '../db';
import {
  resolveChatCapabilitiesForTurn,
  sanitizeChatFeatureTogglesPatch,
} from '../chat-capability-resolve';
import { CHAT_CAPABILITIES_DEFAULT_OFF } from '../../../src/types';
import type {
  ChatFeatureToggles,
  ChatFeatureTogglesErrorCode,
  ChatFeatureTogglesResult,
} from '../../../src/types';
import {
  submitMessage,
  stopCurrentQuery,
  resetSdkSessionState,
} from '../orchestrator';
import { getPipelineDriveCoordinator } from '../pipeline-drive-coordinator';
import {
  spawnCodeburn,
  writeCodeburn,
  resizeCodeburn,
  killCodeburn,
} from '../codeburn-pty';
import { resolveConfirmation } from '../permission-guard';
import { resolveAskQuestion } from '../ask-question';
import { buildChatContextUsage } from '../chat-context-usage';
import {
  compactActiveChatSession,
  clearSDKSessionFiles,
  getTelegramActiveThreadIds,
} from './_shared/chat-compaction';
import type { AskQuestionResponse } from '../../../src/types';

const logger = createLogger('ipc');

const CHAT_FEATURE_TOGGLES_ERROR_MESSAGES: Record<
  ChatFeatureTogglesErrorCode,
  string
> = {
  session_not_found: 'Sessao nao encontrada.',
  session_not_desktop:
    'Toggles de capability so existem em sessoes de chat do desktop (chat/manual).',
  session_not_active:
    'A sessao nao esta ativa; toggles so podem ser alterados em sessao ativa.',
  invalid_patch:
    'Patch invalido: pipelineControl/dynamicWorkflows devem ser boolean.',
  internal_error: 'Erro interno ao acessar os toggles da sessao.',
};

function chatFeatureTogglesError(
  code: ChatFeatureTogglesErrorCode,
): ChatFeatureTogglesResult {
  return { ok: false, code, error: CHAT_FEATURE_TOGGLES_ERROR_MESSAGES[code] };
}
const onboardingAutostartInFlight = new Set<string>();
const FIRST_ONBOARDING_SESSION_KEY = '__first_onboarding_session__';

function normalizeAutostartMessage(message: string): string {
  return message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function isOnboardingAutostart(message: string): boolean {
  return normalizeAutostartMessage(message) === 'ola! vamos comecar.';
}

function claimOnboardingAutostart(message: string, sessionId?: string): boolean {
  if (getSetting('onboarding_completed') === 'true') return true;
  if (!isOnboardingAutostart(message)) return true;

  const activeSession = sessionId ? undefined : getActiveChatSession();
  const key = sessionId || activeSession?.id || FIRST_ONBOARDING_SESSION_KEY;
  const existingSessionId = sessionId || activeSession?.id;

  if (existingSessionId && getSessionMessages(existingSessionId).length > 0) {
    logger.info({ sessionId: existingSessionId }, 'Ignoring onboarding autostart: session already has messages');
    return false;
  }

  if (
    onboardingAutostartInFlight.has(FIRST_ONBOARDING_SESSION_KEY) ||
    onboardingAutostartInFlight.has(key)
  ) {
    logger.warn({ sessionId: key }, 'Ignoring duplicate onboarding autostart');
    return false;
  }

  onboardingAutostartInFlight.add(FIRST_ONBOARDING_SESSION_KEY);
  onboardingAutostartInFlight.add(key);
  const timeout = setTimeout(() => {
    onboardingAutostartInFlight.delete(FIRST_ONBOARDING_SESSION_KEY);
    onboardingAutostartInFlight.delete(key);
  }, 30_000);
  timeout.unref?.();
  return true;
}

export function registerChatHandlers(ctx: IpcContext): void {
  const getMainWindow = ctx.getMainWindow;

  ipcMain.handle(
    'chat:send',
    async (
      _event,
      message: string,
      options?: {
        sessionId?: string;
        agentId?: string;
        attachments?: Array<{
          id: string;
          type: string;
          filename: string;
          mimeType: string;
          data: string;
          size: number;
          preview?: string;
        }>;
        featureToggles?: ChatFeatureToggles;
      },
    ) => {
      if (!claimOnboardingAutostart(message, options?.sessionId)) {
        return { accepted: false };
      }

      const activeSessionId =
        options?.sessionId ?? getActiveChatSession()?.id ?? null;
      if (
        activeSessionId &&
        getPipelineDriveCoordinator()?.tryInterceptChatForDrive(activeSessionId, message)
      ) {
        try {
          insertMessage(activeSessionId, 'user', message);
        } catch (err) {
          logger.error(
            { err: err instanceof Error ? err.message : String(err), sessionId: activeSessionId },
            'chat:send: falha ao persistir mensagem humana interceptada pelo drive',
          );
          try {
            const win = getMainWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send('chat:stream', {
                type: 'error',
                sessionId: activeSessionId,
                error:
                  'Falha ao salvar sua mensagem no historico (banco de dados). O turno do drive segue, mas esta mensagem pode sumir ao recarregar.',
              });
            }
          } catch {
          }
        }
        return { accepted: true };
      }

      const featureToggles = resolveChatCapabilitiesForTurn({
        sessionId: activeSessionId,
        options: options ?? {},
      });

      submitMessage(message, { ...(options ?? {}), featureToggles }, getMainWindow);
      return { accepted: true };
    },
  );

  ipcMain.handle(
    'chat:get-feature-toggles',
    (_event, sessionId: string): ChatFeatureTogglesResult => {
      try {
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return chatFeatureTogglesError('session_not_found');
        }
        if (!getSession(sessionId)) {
          return chatFeatureTogglesError('session_not_found');
        }
        const persisted = getChatFeatureToggles(sessionId);
        return { ok: true, toggles: persisted ?? { ...CHAT_CAPABILITIES_DEFAULT_OFF } };
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), sessionId },
          'chat:get-feature-toggles falhou',
        );
        return chatFeatureTogglesError('internal_error');
      }
    },
  );

  ipcMain.handle(
    'chat:set-feature-toggles',
    (
      _event,
      sessionId: string,
      patch: Partial<ChatFeatureToggles>,
    ): ChatFeatureTogglesResult => {
      try {
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return chatFeatureTogglesError('session_not_found');
        }
        const sanitized = sanitizeChatFeatureTogglesPatch(patch);
        if (!sanitized.ok) {
          return chatFeatureTogglesError('invalid_patch');
        }
        const result = setChatFeatureToggles(sessionId, sanitized.patch);
        if (!result.ok) {
          return chatFeatureTogglesError(result.code);
        }
        return { ok: true, toggles: result.toggles };
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), sessionId },
          'chat:set-feature-toggles falhou',
        );
        return chatFeatureTogglesError('internal_error');
      }
    },
  );

  ipcMain.handle('chat:stop', () => {
    stopCurrentQuery();
  });

  ipcMain.handle(
    'chat:confirm-response',
    (_event, id: string, approved: boolean) => {
      resolveConfirmation(id, approved);
    },
  );

  ipcMain.handle(
    'chat:ask-response',
    (_event, response: AskQuestionResponse) => {
      resolveAskQuestion(response);
    },
  );

  ipcMain.handle('chat:get-sessions', () => {
    return getAllSessions();
  });

  ipcMain.handle('chat:get-messages', (_event, sessionId: string) => {
    return getSessionMessages(sessionId);
  });

  ipcMain.handle('chat:delete-session', (_event, sessionId: string) => {
    try {
      const result = trashSession(sessionId);
      if (!result.success) {
        logger.warn(
          { sessionId, error: result.error },
          'Trash session rejected',
        );
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, sessionId }, 'Failed to trash session');
      return { success: false, error: message };
    }
  });

  ipcMain.handle('chat:archive-session', (_event, sessionId: string) => {
    updateSessionStatus(sessionId, 'archived');
    return true;
  });

  ipcMain.handle('chat:get-active-session', () => {
    return getActiveChatSession();
  });

  ipcMain.handle('chat:get-context-usage', (_event, sessionId: string) => {
    try {
      const session = getSession(sessionId);
      if (!session || session.activeContextTokensEst === undefined) return null;
      const model = getSetting('orchestrator_model') ?? undefined;
      const provider = getSetting('orchestrator_provider') ?? undefined;
      return (
        buildChatContextUsage({
          model,
          provider,
          contextTokens: session.activeContextTokensEst,
          source: 'estimate',
        }) ?? null
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message, sessionId }, 'chat:get-context-usage failed');
      return null;
    }
  });

  ipcMain.handle('chat:compact-session', async () => {
    return compactActiveChatSession(getMainWindow, 'manual');
  });

  ipcMain.handle('chat:clear-session', async () => {
    const activeSession = getActiveChatSession();
    if (!activeSession) {
      logger.warn('No active session to clear');
      return { success: false, reason: 'no_active_session' };
    }

    logger.info(
      { sessionId: activeSession.id },
      'Session clear triggered (no compaction)',
    );

    updateSessionStatus(activeSession.id, 'archived');

    clearSDKSessionFiles(getTelegramActiveThreadIds());
    resetSdkSessionState();

    const newSessionId = crypto.randomUUID();
    createSession(newSessionId, '');

    return { success: true, newSessionId };
  });

  ipcMain.handle(
    'chat:ensure-session',
    (
      _event,
      req?: { preferredSessionId?: string },
    ): { sessionId: string } | { error: string } => {
      try {
        const preferred = req?.preferredSessionId;
        if (preferred) {
          const ok = getDesktopActiveSessionById(preferred);
          if (ok) return { sessionId: ok.id };
        }
        const active = getActiveChatSession();
        if (active) return { sessionId: active.id };
        const sessionId = crypto.randomUUID();
        createSession(sessionId, '');
        return { sessionId };
      } catch (err) {
        logger.error({ err }, 'chat:ensure-session falhou');
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'codeburn:spawn',
    (event, payload: { cols?: number; rows?: number } = {}) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return { ok: false, error: 'janela nao encontrada' };
      return spawnCodeburn(window, payload.cols ?? 120, payload.rows ?? 30);
    },
  );

  ipcMain.handle('codeburn:write', (event, data: string) => {
    writeCodeburn(event.sender.id, data);
  });

  ipcMain.handle(
    'codeburn:resize',
    (event, payload: { cols: number; rows: number }) => {
      resizeCodeburn(event.sender.id, payload.cols, payload.rows);
    },
  );

  ipcMain.handle('codeburn:kill', (event) => {
    killCodeburn(event.sender.id);
  });
}
