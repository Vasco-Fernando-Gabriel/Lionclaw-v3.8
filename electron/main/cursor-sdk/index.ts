
import crypto from 'crypto';
import type { BrowserWindow } from 'electron';
import { createLogger } from '../logger';
import {
  clearSessionPendingSeed,
  createSession,
  getActiveChatSession,
  getSession,
  getSessionMessages,
  getLatestUserTurnIndex,
  getSetting,
  getTurnIndexForUserMessage,
  insertAuditEntry,
  insertMessage,
  setSessionActiveContextTokens,
  updateSessionTokens,
} from '../db';
import { persistUserChatMessage } from '../user-attachments-meta';
import { estimateTokens } from '../token-estimator';
import {
  estimateAgenticContentTokens,
  estimateStrongFloor,
  reconcileActiveContext,
} from '../agent-runtime/context-measure';
import { buildChatContextUsage } from '../chat-context-usage';
import { maybeCompactChatSession } from '../chat-compaction-trigger';
import { ensureInitialSessionTitle, generateSessionTitle } from '../title-generator';
import type { QueryOptions } from '../orchestrator';
import type { OrchestratorSelection } from '../orchestrator-selection';
import { type SdkLane, desktopLane } from '../sdk-lane';
import type { ArtifactData, AuditEntry, StreamChunk } from '../../../src/types';
import { emptyResponseExecutionError } from '../agent-runtime/llm-error';
import {
  isSubagentProviderAuthError,
  subagentAuthFailure,
} from '../agent-runtime/subagent-dispatch';
import {
  computeEffectiveCapabilitiesForTurn,
  getActiveChatTurnByLane,
  getChatCapabilityTurn,
} from '../chat-capability-context';
import { recordCompletedMainChatTurn } from '../dreaming-turn-engine';
import {
  completeOnboardingFromPersistedProfile,
  extractAndProcessOnboardingData,
  resolveOnboardingCompletedFromState,
} from '../onboarding';
import { buildCursorHistoryPreamble } from './history';
import { createChatCursorSession, type ChatCursorSession } from './session';
import { buildCursorUsageSnapshot, createCursorStreamTranslator } from './stream-translator';
import type { CursorChatLane } from './workspace';

const logger = createLogger('cursor-sdk');

export { cleanupCursorChatWorkspaces } from './workspace';

export function stopCursorSdkQuery(lane: SdkLane = desktopLane): void {
  lane.currentAbortController?.abort();
  lane.currentAbortController = null;
}

export function isCursorSdkQueryActive(lane: SdkLane = desktopLane): boolean {
  return lane.currentAbortController !== null;
}

export function resetCursorSdkSessionState(lane: SdkLane = desktopLane): void {
  stopCursorSdkQuery(lane);
}

function sendStream(
  getWindow: () => BrowserWindow | null,
  silent: boolean | undefined,
  chunk: StreamChunk,
): void {
  if (silent) return;
  try {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('chat:stream', chunk);
  } catch { /* renderer disposed */ }
}

function sendLog(
  getWindow: () => BrowserWindow | null,
  entry: Omit<AuditEntry, 'id' | 'createdAt'>,
): void {
  try {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('logs:entry', { id: -1, createdAt: new Date().toISOString(), ...entry });
    }
  } catch { /* renderer disposed */ }
}

function audit(
  getWindow: () => BrowserWindow | null,
  entry: Omit<AuditEntry, 'id' | 'createdAt'>,
): void {
  insertAuditEntry(entry);
  sendLog(getWindow, entry);
}

function resolveSessionId(options: QueryOptions, lane: SdkLane): string {
  if (options.sessionId) return options.sessionId;
  if (lane !== desktopLane) throw new Error(`Lane '${lane.name}' exige sessionId explicito.`);
  const active = getActiveChatSession();
  if (active) return active.id;
  const id = crypto.randomUUID();
  createSession(id, '');
  return id;
}

export async function executeCursorSdkQuery(
  message: string,
  options: QueryOptions,
  getWindow: () => BrowserWindow | null,
  lane: SdkLane = desktopLane,
  selection: OrchestratorSelection,
): Promise<void> {
  const sessionId = resolveSessionId(options, lane);
  const emit = (chunk: StreamChunk): void => {
    const withSession = { ...chunk, sessionId };
    options.onStreamChunk?.(withSession);
    sendStream(getWindow, options.silent, withSession);
  };
  emit({ type: 'session', content: sessionId });

  const skipUser = options.origin === 'system-event' || options.skipUserMessagePersistence === true;
  let currentTurnIndex = 0;
  if (!skipUser) {
    const display = options.displayMessage ?? message;
    const userMessageId = persistUserChatMessage(sessionId, display, options.attachmentsMeta);
    try {
      currentTurnIndex = getTurnIndexForUserMessage(sessionId, userMessageId);
    } catch {
      currentTurnIndex = 0;
    }
    ensureInitialSessionTitle(sessionId, display);
  } else {
    try {
      currentTurnIndex = getLatestUserTurnIndex(sessionId);
    } catch {
      currentTurnIndex = 0;
    }
  }

  const abort = new AbortController();
  lane.currentAbortController = abort;
  let isOnboarding = getSetting('onboarding_completed') !== 'true';
  if (isOnboarding && resolveOnboardingCompletedFromState()) {
    emit({ type: 'onboarding_completed' });
    isOnboarding = false;
  }
  const capabilities = lane.name === 'desktop'
    ? (() => {
        const active = getActiveChatTurnByLane('desktop');
        const context = active ? getChatCapabilityTurn(active) : undefined;
        return context ? computeEffectiveCapabilitiesForTurn(context) : undefined;
      })()
    : undefined;

  const artifacts: ArtifactData[] = [];
  const translator = createCursorStreamTranslator({
    sessionId,
    model: selection.model,
    emit,
    subagent: options.agentId,
    turnIndex: currentTurnIndex,
    onArtifact: (artifact) => artifacts.push(artifact),
    onAuditEntry: (entry) => sendLog(getWindow, entry),
  });

  let session: ChatCursorSession;
  try {
    session = await createChatCursorSession({
      sessionId,
      model: selection.model,
      getWindow,
      abortController: abort,
      lane: lane.name as CursorChatLane,
      agentId: options.agentId,
      isOnboarding,
      capabilities,
    });
  } catch (error) {
    translator.fail(error);
    lane.currentAbortController = null;
    if (lane !== desktopLane) throw error;
    return;
  }

  const row = getSession(sessionId);
  const compactedUpTo = row?.compactedUpToMessageId ?? null;
  let basePrompt = message;
  let historyChars = 0;
  if (!session.resuming) {
    const allMessages = getSessionMessages(sessionId);
    const priorMessages = compactedUpTo === null
      ? allMessages
      : allMessages.filter((item) => item.id > compactedUpTo);
    const history = buildCursorHistoryPreamble(priorMessages, { dropLast: !skipUser });
    historyChars = history.length;
    basePrompt = history
      ? `Conversation so far:\n${history}\n\nNew user message:\n${message}`
      : message;
  }
  const pendingSeed = row?.pendingSeed ?? null;
  const prompt = pendingSeed ? `${pendingSeed}\n\n${basePrompt}` : basePrompt;
  audit(getWindow, {
    sessionId,
    subagent: options.agentId,
    eventType: 'tool_call',
    toolName: 'cursor.context',
    input: JSON.stringify({
      runtime: 'cursor-sdk',
      provider: 'cursor',
      model: selection.model,
      resuming: session.resuming,
      historyChars,
    }),
  });

  let agenticTokens = 0;
  const onEvent = (relayed: { event: unknown }): void => {
    const evt = relayed.event;
    if (
      evt !== null
      && typeof evt === 'object'
      && (evt as Record<string, unknown>)['type'] === 'tool_call'
    ) {
      const rec = evt as Record<string, unknown>;
      if (rec['status'] === 'completed' || rec['status'] === 'error') {
        agenticTokens += estimateAgenticContentTokens(rec['args'])
          + estimateAgenticContentTokens(rec['result']);
      }
    }
    translator.onEvent(evt);
  };

  try {
    const result = await session.send(prompt, onEvent);
    if (abort.signal.aborted) return;
    if (result.status === 'cancelled') {
      translator.fail(new Error(
        'Turno Cursor cancelado pelo SDK (interrupcao externa ou permissao negada).',
      ));
      return;
    }
    if (result.status !== 'finished') {
      translator.fail(new Error(
        `Turno Cursor terminou com status "${result.status}"`
          + `${result.errorMessage !== undefined ? `: ${result.errorMessage}` : ''}`,
      ));
      if (lane !== desktopLane) {
        throw new Error(result.errorMessage ?? `cursor run status=${result.status}`);
      }
      return;
    }

    let finalText = result.finalText.length > 0
      ? result.finalText
      : result.resultText ?? translator.assistantText();
    if (finalText.trim()) {
      const cleaned = extractAndProcessOnboardingData(finalText, {
        sendStream: emit,
        onAudit: ({ toolName, input, output }) => audit(getWindow, {
          sessionId,
          subagent: options.agentId,
          eventType: 'tool_call',
          toolName,
          input,
          output,
        }),
      });
      if (cleaned !== null) finalText = cleaned;
      else if (isOnboarding) {
        completeOnboardingFromPersistedProfile({ sendStream: emit });
      }
    }

    const toolUses = translator.toolUses();
    const usageSnapshot = buildCursorUsageSnapshot(
      result.usage,
      selection.model,
      {
        inputTokens: estimateTokens(prompt),
        outputTokens: estimateTokens(finalText),
      },
    );
    const emptyError = emptyResponseExecutionError({
      content: finalText,
      toolUses,
      aborted: abort.signal.aborted,
      provider: 'cursor',
      model: selection.model,
    });
    if (emptyError) {
      emit({ type: 'error', code: emptyError.code, error: emptyError.userMessage });
      return;
    }
    translator.finalize(usageSnapshot);

    const hasAssistantText = finalText.trim().length > 0;
    const hasValidToolOnlyTurn = !hasAssistantText && toolUses > 0;
    if (hasAssistantText) {
      insertMessage(
        sessionId,
        'assistant',
        finalText,
        options.agentId,
        artifacts.length > 0 ? JSON.stringify({ artifacts }) : undefined,
      );
      recordCompletedMainChatTurn(sessionId, getWindow);
    }
    if ((hasAssistantText || hasValidToolOnlyTurn) && pendingSeed) {
      clearSessionPendingSeed(sessionId);
    }

    const tokenReported = usageSnapshot.tokenStatus === 'reported';
    updateSessionTokens(
      sessionId,
      tokenReported ? usageSnapshot.inputTokens : 0,
      tokenReported ? usageSnapshot.outputTokens : 0,
      usageSnapshot.costStatus !== 'unknown' ? (usageSnapshot.costUsd ?? 0) : 0,
      {
        costStatus: usageSnapshot.costStatus ?? 'unknown',
        tokenStatus: usageSnapshot.tokenStatus ?? 'not_reported',
        costUnknownReason: usageSnapshot.costUnknownReason ?? null,
        runtime: 'cursor',
        costEstimationKind: 'subscription-equivalent-payg',
      },
    );

    const estimate = estimateStrongFloor({
      systemPromptTokens: session.contextMeta.systemPromptTokens,
      presetTokens: 0,
      mcpSchemasTokens: session.contextMeta.toolSchemasTokens,
      messageTexts: [prompt, finalText],
      agenticTokens,
    });
    const liveContext = reconcileActiveContext(0, 0, estimate);
    setSessionActiveContextTokens(sessionId, liveContext);
    const contextUsage = buildChatContextUsage({
      model: selection.model,
      provider: 'cursor',
      contextTokens: liveContext,
      source: 'estimate',
    });
    if (contextUsage) emit({ type: 'context_usage', contextUsage });

    const persisted = hasAssistantText ? getSession(sessionId) : null;
    if (persisted && persisted.type !== 'scheduled' && persisted.type !== 'telegram') {
      const messages = getSessionMessages(sessionId);
      const assistantCount = messages.filter((item) => item.role === 'assistant').length;
      if ((!persisted.title || assistantCount === 1) && messages.length >= 2) {
        void generateSessionTitle(sessionId).catch((error) => logger.warn({ error }, 'cursor title generation failed'));
      }
    }
    await maybeCompactChatSession(sessionId, emit, { model: selection.model, provider: 'cursor' });
  } catch (error) {
    if (isSubagentProviderAuthError(error)) {
      emit({ type: 'error', sessionId, ...subagentAuthFailure(error) });
      if (lane !== desktopLane) throw error;
    } else if (!abort.signal.aborted) {
      translator.fail(error);
      if (lane !== desktopLane) throw error;
    }
  } finally {
    session.close();
    if (lane.currentAbortController === abort) lane.currentAbortController = null;
  }
}
