import { getSwarmService } from '../swarm';
import { ipcMain, BrowserWindow } from 'electron';
import { createLogger } from '../logger';
import type { IpcContext } from './context';
import {
  getAllSessions,
  getSessionMessages,
  trashSession,
  getOpenLaneSessionById,
  getSetting,
  insertMessage,
  getSession,
  getChatFeatureToggles,
  setChatFeatureToggles,
  listOpenDesktopSessions,
  createLaneSession,
  setSessionOrchestrator,
  countSessionMessages,
  isOpenDesktopConversation,
  findEngagedDriveBySession,
  getHarnessProject,
  type OpenDesktopSessionRow,
} from '../db';
import { sessionHasActiveDrive } from '../session-drive';
import { getClearingPhase, isSessionClearing, listReservedClearingBadges } from '../clearing-sessions';
import { resolveChatCapabilitiesForTurn, sanitizeChatFeatureTogglesPatch } from '../chat-capability-resolve';
import { CHAT_CAPABILITIES_DEFAULT_OFF } from '../../../src/types';
import type {
  ChatClearCancelResult,
  ChatClearResult,
  ChatFeatureTogglesErrorCode,
  ChatFeatureTogglesResult,
  ChatFeatureToggles,
  ChatLaneErrorCode,
  ChatSendOptions,
  ChatSessionUpdatedEvent,
  LaneSessionState,
  OpenChatSession,
  SessionOrchestrator,
} from '../../../src/types';
import { submitMessage, stopCurrentQuery, getDesktopSessionExecutionState } from '../orchestrator';
import { getPipelineDriveCoordinator } from '../pipeline-drive-coordinator';
import { spawnCodeburn, writeCodeburn, resizeCodeburn, killCodeburn } from '../codeburn-pty';
import { resolveConfirmation } from '../permission-guard';
import { resolveAskQuestion } from '../ask-question';
import { buildChatContextUsage } from '../chat-context-usage';
import { normalizeSelectionEffort, readDefaultOrchestratorColumns } from '../orchestrator-selection';
import { validateOrchestratorOverride } from '../orchestrator-selection-matrix';
import { reasoningOptionsFor } from '../provider-models-catalog';
import { effortSettingKeyForRuntime, pickMostRecentLane } from '../lanes';
import { setLaneSessionUpdatedListener } from '../lane-session-events';
import type { AskQuestionResponse } from '../../../src/types';

const logger = createLogger('ipc');

const CHAT_FEATURE_TOGGLES_ERROR_MESSAGES: Record<ChatFeatureTogglesErrorCode, string> = {
  session_not_found: 'Sessao nao encontrada.',
  session_not_desktop: 'Toggles de capability so existem em sessoes de chat do desktop (chat/manual).',
  session_not_active: 'A sessao nao esta ativa; toggles so podem ser alterados em sessao ativa.',
  invalid_patch: 'Patch invalido: pipelineControl/dynamicWorkflows devem ser boolean.',
  internal_error: 'Erro interno ao acessar os toggles da sessao.',
};

function chatFeatureTogglesError(code: ChatFeatureTogglesErrorCode): ChatFeatureTogglesResult {
  return { ok: false, code, error: CHAT_FEATURE_TOGGLES_ERROR_MESSAGES[code] };
}

const CHAT_LANE_ERROR_MESSAGES: Record<ChatLaneErrorCode, string> = {
  session_required: 'sessionId obrigatorio: toda mensagem do desktop pertence a uma lane.',
  session_not_found: 'Sessao nao encontrada.',
  session_not_active: 'A conversa nao esta aberta.',
  lane_required: 'Esta conversa esta aberta sem lane: de Clear nela ou escolha uma lane.',
  lanes_full: 'Todas as lanes estao ocupadas. De Clear numa lane para abrir outra conversa.',
  provider_locked: 'A lane ja tem mensagens ou um turno pendente: o provider esta travado. De Clear para trocar.',
  invalid_selection: 'Selecao de orquestrador invalida.',
  model_not_in_provider: 'O modelo pedido nao pertence ao provider desta lane.',
  effort_not_supported: 'O effort pedido nao e suportado pelo modelo desta lane.',
  turn_binding_required: 'Nenhum turno de chat em voo.',
  session_clearing: 'Esta lane esta em Clear; aguarde o Clear terminar ou refaca o Clear.',
  orchestrator_unconfigured:
    'Orquestrador padrao nao configurado (runtime, provider e modelo): configure-o em Settings antes de abrir uma conversa.',
  lane_busy: 'Esta lane ja dirige um pipeline: pare-o ou assuma-o pela pagina Pipeline.',
  drive_owned_by_other_lane: 'Este pipeline e dirigido por outra conversa e nao esta disponivel nesta lane.',
  drive_scope_violation: 'Este pipeline nao pertence a esta lane.',
  drive_uniqueness_violated: 'Mais de um pipeline aparece dirigido por esta lane; pare um deles pela pagina Pipeline.',
  drive_turn_in_flight: 'Ha um turno de drive em voo neste pipeline; aguarde ele terminar.',
};

function createLaneOrError(): { ok: true; sessionId: string } | { ok: false; error: string; code: ChatLaneErrorCode } {
  const orchestrator = readDefaultOrchestratorColumns();
  if (!orchestrator) return { ok: false, ...laneError('orchestrator_unconfigured') };
  const created = createLaneSession({
    orchestrator,
    reservedBadges: listReservedClearingBadges(),
  });
  if (!created.ok) return { ok: false, ...laneError(created.code) };
  return { ok: true, sessionId: created.session.id };
}

function isSelectableLaneState(state: LaneSessionState): boolean {
  return state !== 'interrupted' && state !== 'clearing';
}

function laneError(code: ChatLaneErrorCode, detail?: string): { error: string; code: ChatLaneErrorCode } {
  return { error: detail ?? CHAT_LANE_ERROR_MESSAGES[code], code };
}

function trimmedOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveInitialLaneEffort(
  runtime: SessionOrchestrator['runtime'],
  provider: SessionOrchestrator['provider'],
  model: string,
): string | undefined {
  const { options, defaultReasoning } = reasoningOptionsFor(runtime, provider, model);
  if (options.length === 0) return undefined;
  const effortKey = effortSettingKeyForRuntime(runtime);
  const global = effortKey ? (getSetting(effortKey) || '').trim() : '';
  if (global && options.includes(global)) return global;
  return normalizeSelectionEffort(runtime, model, defaultReasoning ?? undefined);
}

type LaneTurnOverrideResult =
  | { ok: true; orchestrator: SessionOrchestrator; changed: boolean }
  | { ok: false; code: ChatLaneErrorCode; error: string };

async function resolveLaneTurnOverride(input: {
  lane: SessionOrchestrator;
  model?: string;
  effort?: string;
}): Promise<LaneTurnOverrideResult> {
  const model = input.model ?? input.lane.model;
  const validation = await validateOrchestratorOverride({
    runtime: input.lane.runtime,
    provider: input.lane.provider,
    model,
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
  });
  if (!validation.ok) return { ok: false, code: validation.code, error: validation.error };
  const modelChanged = input.model !== undefined && input.model !== input.lane.model;
  const effort =
    input.effort ??
    (modelChanged ? resolveInitialLaneEffort(input.lane.runtime, input.lane.provider, model) : input.lane.effort);
  const orchestrator: SessionOrchestrator = {
    runtime: input.lane.runtime,
    provider: input.lane.provider,
    model,
    ...(effort ? { effort } : {}),
  };
  const changed = modelChanged || (effort ?? undefined) !== (input.lane.effort ?? undefined);
  return { ok: true, orchestrator, changed };
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

function claimOnboardingAutostart(message: string, sessionId: string): boolean {
  if (getSetting('onboarding_completed') === 'true') return true;
  if (!isOnboardingAutostart(message)) return true;

  if (getSessionMessages(sessionId).length > 0) {
    logger.info({ sessionId }, 'Ignoring onboarding autostart: session already has messages');
    return false;
  }

  if (onboardingAutostartInFlight.has(FIRST_ONBOARDING_SESSION_KEY) || onboardingAutostartInFlight.has(sessionId)) {
    logger.warn({ sessionId }, 'Ignoring duplicate onboarding autostart');
    return false;
  }

  onboardingAutostartInFlight.add(FIRST_ONBOARDING_SESSION_KEY);
  onboardingAutostartInFlight.add(sessionId);
  const timeout = setTimeout(() => {
    onboardingAutostartInFlight.delete(FIRST_ONBOARDING_SESSION_KEY);
    onboardingAutostartInFlight.delete(sessionId);
  }, 30_000);
  timeout.unref?.();
  return true;
}

export function resolveLaneState(row: OpenDesktopSessionRow): LaneSessionState {
  const clearing = getClearingPhase(row.id);
  if (clearing === 'interrupted') return 'interrupted';
  if (clearing) return 'clearing';
  if (row.dreamingStartedAt) return 'interrupted';
  const execution = getDesktopSessionExecutionState(row.id);
  if (execution !== 'idle') return execution;
  if (sessionHasActiveDrive(row.id)) return 'drive';
  return 'idle';
}

function resolveSessionDrive(row: OpenDesktopSessionRow): OpenChatSession['drive'] {
  let project: ReturnType<typeof findEngagedDriveBySession>;
  try {
    project = findEngagedDriveBySession(row.id);
  } catch (err) {
    logger.error(
      { sessionId: row.id, err: err instanceof Error ? err.message : String(err) },
      'chat:list-open-sessions: lane com mais de um drive engajado; lane segue sem pipeline',
    );
    return null;
  }
  if (!project) return null;
  const status = project.config.drive?.status;
  if (!status) return null;
  const name = getHarnessProject(project.id)?.name;
  if (!name) return null;
  return { projectId: project.id, name, status };
}

function toOpenChatSession(row: OpenDesktopSessionRow, state: LaneSessionState): OpenChatSession {
  return {
    id: row.id,
    laneBadge: row.laneBadge,
    title: row.title,
    orchestrator: row.orchestrator,
    messageCount: row.messageCount,
    lastUserMessageAt: row.lastUserMessageAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    state,
    drive: resolveSessionDrive(row),
  };
}

export function listOpenChatSessions(): OpenChatSession[] {
  return listOpenDesktopSessions(resolveLaneState).map((row) => toOpenChatSession(row, row.state));
}

function emitSessionUpdated(getMainWindow: () => BrowserWindow | null, sessionId: string): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  const lane = getOpenLaneSessionById(sessionId);
  const payload: ChatSessionUpdatedEvent = lane
    ? {
        sessionId,
        laneBadge: lane.laneBadge,
        orchestrator: lane.orchestrator,
        messageCount: lane.messageCount,
        state: resolveLaneState(lane),
      }
    : {
        sessionId,
        laneBadge: null,
        orchestrator: getSession(sessionId)?.orchestrator ?? null,
        messageCount: countSessionMessages(sessionId),
        state: 'idle',
      };
  win.webContents.send('chat:session-updated', payload);
  win.webContents.send('chat:sessions-updated');
}

function emitOpenLaneUpdated(getMainWindow: () => BrowserWindow | null, sessionId: string): void {
  if (!getOpenLaneSessionById(sessionId)) return;
  emitSessionUpdated(getMainWindow, sessionId);
}

export function registerChatHandlers(ctx: IpcContext): void {
  const getMainWindow = ctx.getMainWindow;
  setLaneSessionUpdatedListener((sessionId) => emitOpenLaneUpdated(getMainWindow, sessionId));

  ipcMain.handle(
    'chat:send',
    async (
      _event,
      message: string,
      options?: ChatSendOptions,
    ): Promise<{ accepted: boolean; code?: ChatLaneErrorCode; error?: string }> => {
      const sessionId = options?.sessionId;
      if (!sessionId) {
        logger.warn('chat:send sem sessionId (session_required)');
        return { accepted: false, ...laneError('session_required') };
      }
      const session = getSession(sessionId);
      if (!session) return { accepted: false, ...laneError('session_not_found') };
      if (!isOpenDesktopConversation(session)) {
        return { accepted: false, ...laneError('session_not_active') };
      }
      if (session.laneBadge === null || session.laneBadge === undefined) {
        return { accepted: false, ...laneError('lane_required') };
      }
      if (isSessionClearing(sessionId)) {
        return { accepted: false, ...laneError('session_clearing') };
      }

      const requestedModel = trimmedOrUndefined(options?.model);
      const requestedEffort = trimmedOrUndefined(options?.effort);
      let turnOverride: { model?: string; effort?: string } = {};
      let laneOrchestratorToPersist: SessionOrchestrator | null = null;
      if (requestedModel !== undefined || requestedEffort !== undefined) {
        if (!session.orchestrator) {
          return { accepted: false, ...laneError('orchestrator_unconfigured') };
        }
        const resolved = await resolveLaneTurnOverride({
          lane: session.orchestrator,
          ...(requestedModel !== undefined ? { model: requestedModel } : {}),
          ...(requestedEffort !== undefined ? { effort: requestedEffort } : {}),
        });
        if (!resolved.ok) return { accepted: false, code: resolved.code, error: resolved.error };
        if (resolved.changed) laneOrchestratorToPersist = resolved.orchestrator;
        turnOverride = {
          model: resolved.orchestrator.model,
          ...(resolved.orchestrator.effort ? { effort: resolved.orchestrator.effort } : {}),
        };
      }

      if (!claimOnboardingAutostart(message, sessionId)) {
        return { accepted: false };
      }

      if (getPipelineDriveCoordinator()?.tryInterceptChatForDrive(sessionId, message)) {
        try {
          insertMessage(sessionId, 'user', message);
          emitSessionUpdated(getMainWindow, sessionId);
        } catch (err) {
          logger.error(
            { err: err instanceof Error ? err.message : String(err), sessionId },
            'chat:send: falha ao persistir mensagem humana interceptada pelo drive',
          );
          try {
            const win = getMainWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send('chat:stream', {
                type: 'error',
                sessionId,
                error:
                  'Falha ao salvar sua mensagem no historico (banco de dados). O turno do drive segue, mas esta mensagem pode sumir ao recarregar.',
              });
            }
          } catch {}
        }
        return { accepted: true };
      }

      const featureToggles = resolveChatCapabilitiesForTurn({
        sessionId,
        options: options ?? {},
      });

      if (laneOrchestratorToPersist) setSessionOrchestrator(sessionId, laneOrchestratorToPersist);
      submitMessage(message, { ...(options ?? {}), ...turnOverride, sessionId, featureToggles }, getMainWindow);
      emitSessionUpdated(getMainWindow, sessionId);
      return { accepted: true };
    },
  );

  ipcMain.handle('chat:get-feature-toggles', (_event, sessionId: string): ChatFeatureTogglesResult => {
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
  });

  ipcMain.handle(
    'chat:set-feature-toggles',
    (_event, sessionId: string, patch: Partial<ChatFeatureToggles>): ChatFeatureTogglesResult => {
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

  ipcMain.handle('chat:stop', (_event, sessionId?: string) => {
    stopCurrentQuery(typeof sessionId === 'string' && sessionId ? sessionId : undefined);
  });

  ipcMain.handle(
    'chat:clear',
    async (_event, sessionId: string, opts?: { force?: boolean }): Promise<ChatClearResult> => {
      try {
        const { clearLaneSession } = await import('../chat-clear');
        const result = await clearLaneSession(sessionId, {
          force: opts?.force === true,
          getMainWindow,
        });
        if (result.ok) {
          emitSessionUpdated(getMainWindow, result.sessionId);
          if (result.newSessionId) emitSessionUpdated(getMainWindow, result.newSessionId);
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err: message, sessionId }, 'chat:clear falhou');
        return { ok: false, code: 'clear_failed', error: message };
      }
    },
  );

  ipcMain.handle('chat:clear-cancel', async (_event, sessionId: string): Promise<ChatClearCancelResult> => {
    const { cancelQueuedClear } = await import('../chat-clear');
    return cancelQueuedClear(sessionId);
  });

  ipcMain.handle('chat:confirm-response', (_event, id: string, approved: boolean) => {
    resolveConfirmation(id, approved);
  });

  ipcMain.handle('chat:ask-response', (_event, response: AskQuestionResponse) => {
    resolveAskQuestion(response);
  });

  ipcMain.handle('chat:get-sessions', () => {
    return getAllSessions();
  });

  ipcMain.handle('chat:get-messages', (_event, sessionId: string) => {
    return getSessionMessages(sessionId);
  });

  ipcMain.handle('chat:delete-session', (_event, sessionId: string) => {
    try {
      if (getSwarmService().hasActiveWork(sessionId))
        return { success: false, error: 'Aborte o Swarm desta sessão antes de excluí-la.' };
      const result = trashSession(sessionId);
      if (!result.success) {
        logger.warn({ sessionId, error: result.error }, 'Trash session rejected');
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, sessionId }, 'Failed to trash session');
      return { success: false, error: message };
    }
  });

  ipcMain.handle('chat:get-context-usage', (_event, sessionId: string) => {
    try {
      const session = getSession(sessionId);
      if (!session || session.activeContextTokensEst === undefined) return null;
      const lane = session.orchestrator;
      if (!lane) return null;
      return (
        buildChatContextUsage({
          model: lane.model,
          provider: lane.provider,
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

  ipcMain.handle(
    'chat:ensure-session',
    (
      _event,
      req?: { preferredSessionId?: string },
    ): { sessionId: string } | { error: string; code?: ChatLaneErrorCode } => {
      try {
        const preferred = req?.preferredSessionId;
        if (preferred) {
          const ok = getOpenLaneSessionById(preferred);
          if (ok && isSelectableLaneState(resolveLaneState(ok))) return { sessionId: ok.id };
        }
        const lanes = listOpenDesktopSessions(resolveLaneState).filter((lane) => isSelectableLaneState(lane.state));
        const recent = pickMostRecentLane(lanes);
        if (recent) return { sessionId: recent.id };
        const created = createLaneOrError();
        if (!created.ok) return { error: created.error, code: created.code };
        emitSessionUpdated(getMainWindow, created.sessionId);
        return { sessionId: created.sessionId };
      } catch (err) {
        logger.error({ err }, 'chat:ensure-session falhou');
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'chat:create-session',
    (): { session: OpenChatSession } | { error: string; code: ChatLaneErrorCode } => {
      try {
        const created = createLaneOrError();
        if (!created.ok) return { error: created.error, code: created.code };
        emitSessionUpdated(getMainWindow, created.sessionId);
        const row = getOpenLaneSessionById(created.sessionId);
        if (!row) return laneError('session_not_found');
        return { session: toOpenChatSession(row, resolveLaneState(row)) };
      } catch (err) {
        logger.error({ err }, 'chat:create-session falhou');
        return { error: err instanceof Error ? err.message : String(err), code: 'session_not_found' };
      }
    },
  );

  ipcMain.handle('chat:list-open-sessions', (): OpenChatSession[] | { error: string } => {
    try {
      return listOpenChatSessions();
    } catch (err) {
      logger.error({ err }, 'chat:list-open-sessions falhou');
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    'chat:set-session-orchestrator',
    async (
      _event,
      sessionId: string,
      selection: { runtime: string; provider: string; model: string; effort?: string },
    ): Promise<{ ok: true; orchestrator: SessionOrchestrator } | { error: string; code: ChatLaneErrorCode }> => {
      try {
        if (typeof sessionId !== 'string' || !sessionId) return laneError('session_required');
        const lane = getOpenLaneSessionById(sessionId);
        if (!lane) return laneError('session_not_found');
        if (isSessionClearing(sessionId)) return laneError('session_clearing');
        if (
          !selection ||
          typeof selection.runtime !== 'string' ||
          typeof selection.provider !== 'string' ||
          typeof selection.model !== 'string'
        ) {
          return laneError('invalid_selection');
        }
        const runtime = selection.runtime as SessionOrchestrator['runtime'];
        const provider = selection.provider as SessionOrchestrator['provider'];
        const providerChanges =
          !lane.orchestrator || lane.orchestrator.runtime !== runtime || lane.orchestrator.provider !== provider;
        if (providerChanges) {
          const busy = resolveLaneState(lane) !== 'idle';
          if (lane.messageCount > 0 || busy) return laneError('provider_locked');
        }
        const requestedEffort = trimmedOrUndefined(selection.effort);
        const validation = await validateOrchestratorOverride({
          runtime,
          provider,
          model: selection.model,
          ...(requestedEffort !== undefined ? { effort: requestedEffort } : {}),
        });
        if (!validation.ok) return laneError(validation.code, validation.error);
        const effort = requestedEffort ?? resolveInitialLaneEffort(runtime, provider, selection.model);
        const orchestrator: SessionOrchestrator = {
          runtime,
          provider,
          model: selection.model,
          ...(effort ? { effort } : {}),
        };
        setSessionOrchestrator(sessionId, orchestrator);
        emitSessionUpdated(getMainWindow, sessionId);
        return { ok: true, orchestrator };
      } catch (err) {
        logger.error({ err, sessionId }, 'chat:set-session-orchestrator falhou');
        return { error: err instanceof Error ? err.message : String(err), code: 'invalid_selection' };
      }
    },
  );

  ipcMain.handle('codeburn:spawn', (event, payload: { cols?: number; rows?: number } = {}) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return { ok: false, error: 'janela nao encontrada' };
    return spawnCodeburn(window, payload.cols ?? 120, payload.rows ?? 30);
  });

  ipcMain.handle('codeburn:write', (event, data: string) => {
    writeCodeburn(event.sender.id, data);
  });

  ipcMain.handle('codeburn:resize', (event, payload: { cols: number; rows: number }) => {
    resizeCodeburn(event.sender.id, payload.cols, payload.rows);
  });

  ipcMain.handle('codeburn:kill', (event) => {
    killCodeburn(event.sender.id);
  });
}
