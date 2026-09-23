import type { BrowserWindow } from 'electron';
import { createLogger } from '../logger';
import {
  clearSessionPendingSeed,
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
import { isChatTimelineReinjectEnabled, maybeCompactChatSession } from '../chat-compaction-trigger';
import { ensureInitialSessionTitle, generateSessionTitle } from '../title-generator';
import type { QueryOptions } from '../orchestrator';
import type { OrchestratorSelection } from '../orchestrator-selection';
import type { SdkLane } from '../sdk-lane';
import { resolveLaneForOptions, lanesOrAllDesktop } from '../desktop-lanes';
import { SessionRequiredError } from '../lanes';
import type { ArtifactData, AuditEntry, StreamChunk } from '../../../src/types';
import { emptyResponseExecutionError } from '../agent-runtime/llm-error';
import { isSubagentProviderAuthError, subagentAuthFailure } from '../agent-runtime/subagent-dispatch';
import {
  computeEffectiveCapabilitiesForTurn,
  getActiveChatTurnBinding,
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
import {
  beginTimelineTurn,
  buildToolsBlocksByAnchor,
  computeTimelineMetrics,
  logTimelineMetrics,
  resolveCliTimelineOrigin,
  resolveTimelineAnchor,
} from '../session-timeline';

const logger = createLogger('cursor-sdk');

export { cleanupCursorChatWorkspaces } from './workspace';

export function stopCursorSdkQuery(laneArg?: SdkLane): void {
  for (const lane of lanesOrAllDesktop(laneArg)) {
    lane.currentAbortController?.abort();
    lane.currentAbortController = null;
  }
}

export function isCursorSdkQueryActive(laneArg?: SdkLane): boolean {
  return lanesOrAllDesktop(laneArg).some((lane) => lane.currentAbortController !== null);
}

export function resetCursorSdkSessionState(laneArg?: SdkLane): void {
  for (const lane of lanesOrAllDesktop(laneArg)) {
    stopCursorSdkQuery(lane);
  }
}

function sendStream(getWindow: () => BrowserWindow | null, silent: boolean | undefined, chunk: StreamChunk): void {
  if (silent) return;
  try {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('chat:stream', chunk);
  } catch {
    /* renderer disposed */
  }
}

function sendLog(getWindow: () => BrowserWindow | null, entry: Omit<AuditEntry, 'id' | 'createdAt'>): void {
  try {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('logs:entry', { id: -1, createdAt: new Date().toISOString(), ...entry });
    }
  } catch {
    /* renderer disposed */
  }
}

function audit(getWindow: () => BrowserWindow | null, entry: Omit<AuditEntry, 'id' | 'createdAt'>): void {
  insertAuditEntry(entry);
  sendLog(getWindow, entry);
}

function resolveSessionId(options: QueryOptions, lane: SdkLane): string {
  if (options.sessionId) return options.sessionId;
  throw new SessionRequiredError(lane.name, 'cursor-sdk');
}

export async function executeCursorSdkQuery(
  message: string,
  options: QueryOptions,
  getWindow: () => BrowserWindow | null,
  laneArg: SdkLane | undefined,
  selection: OrchestratorSelection,
): Promise<void> {
  const lane = laneArg ?? resolveLaneForOptions(options, 'cursor-sdk');
  const sessionId = resolveSessionId(options, lane);
  const emit = (chunk: StreamChunk): void => {
    const withSession = { ...chunk, sessionId };
    options.onStreamChunk?.(withSession);
    sendStream(getWindow, options.silent, withSession);
  };
  emit({ type: 'session', content: sessionId });

  const skipUser = options.origin === 'system-event' || options.skipUserMessagePersistence === true;
  let currentTurnIndex = 0;
  let persistedUserMessageId: number | null = null;
  if (!skipUser) {
    const display = options.displayMessage ?? message;
    const userMessageId = persistUserChatMessage(sessionId, display, options.attachmentsMeta);
    persistedUserMessageId = userMessageId;
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
  const capabilities =
    lane.kind === 'desktop'
      ? (() => {
          const active = getActiveChatTurnBinding({ sessionId, lane: 'desktop' });
          const context = active ? getChatCapabilityTurn(active) : undefined;
          return context ? computeEffectiveCapabilitiesForTurn(context) : undefined;
        })()
      : undefined;

  let session: ChatCursorSession;
  try {
    session = await createChatCursorSession({
      sessionId,
      model: selection.model,
      ...(selection.effort ? { effort: selection.effort } : {}),
      getWindow,
      abortController: abort,
      lane: lane.kind,
      agentId: options.agentId,
      isOnboarding,
      capabilities,
      turnBinding: getActiveChatTurnBinding({ sessionId, lane: lane.kind }),
    });
  } catch (error) {
    emit({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    lane.currentAbortController = null;
    if (lane.kind !== 'desktop') throw error;
    return;
  }

  const timelineOrigin = resolveCliTimelineOrigin({
    laneKind: lane.kind,
    origin: options.origin,
    swarmDelivery: options.swarmDelivery !== undefined,
    forceNewSession: options._forceNewSession === true,
    persistedUserMessageId,
  });
  const timelineAnchor = resolveTimelineAnchor({
    origin: timelineOrigin,
    persistedUserMessageId,
    answeredUserMessageId: null,
  });
  const timeline = beginTimelineTurn({
    sessionId,
    turnIndex: currentTurnIndex,
    anchorMessageId: timelineAnchor.anchorMessageId,
    currentUserMessageId: timelineAnchor.currentUserMessageId,
    origin: timelineOrigin,
    runtime: 'cursor',
    fidelity: 'observed',
    cwd: session.workspace.workspaceDir,
  });
  const artifacts: ArtifactData[] = [];
  const translator = createCursorStreamTranslator({
    sessionId,
    model: selection.model,
    emit,
    subagent: options.agentId,
    turnIndex: currentTurnIndex,
    onArtifact: (artifact) => artifacts.push(artifact),
    onAuditEntry: (entry) => sendLog(getWindow, entry),
    timeline,
  });
  let timelineSettled = false;
  const settleTimeline = (complete: boolean): void => {
    if (timelineSettled) return;
    timelineSettled = true;
    const metrics = computeTimelineMetrics('cursor', translator.timelineEvents());
    timeline.metrics(metrics);
    if (complete && !timeline.persistFailed) timeline.complete();
    logTimelineMetrics({
      runId: timeline.runId,
      runtime: 'cursor',
      status: complete && !timeline.persistFailed ? 'complete' : 'interrupted',
      ...metrics,
    });
  };

  const row = getSession(sessionId);
  const compactedUpTo = row?.compactedUpToMessageId ?? null;
  let basePrompt = message;
  let historyChars = 0;
  if (!session.resuming) {
    const allMessages = getSessionMessages(sessionId);
    const priorMessages = compactedUpTo === null ? allMessages : allMessages.filter((item) => item.id > compactedUpTo);
    const history = buildCursorHistoryPreamble(priorMessages, {
      dropLast: !skipUser,
      ...(isChatTimelineReinjectEnabled()
        ? { toolsByAnchor: buildToolsBlocksByAnchor(sessionId, priorMessages, compactedUpTo) }
        : {}),
    });
    historyChars = history.length;
    basePrompt = history ? `Conversation so far:\n${history}\n\nNew user message:\n${message}` : message;
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
    if (evt !== null && typeof evt === 'object' && (evt as Record<string, unknown>)['type'] === 'tool_call') {
      const rec = evt as Record<string, unknown>;
      if (rec['status'] === 'completed' || rec['status'] === 'error') {
        agenticTokens += estimateAgenticContentTokens(rec['args']) + estimateAgenticContentTokens(rec['result']);
      }
    }
    translator.onEvent(evt);
  };

  let turnOk = false;
  try {
    const result = await session.send(prompt, onEvent);
    if (abort.signal.aborted) return;
    if (result.status === 'cancelled') {
      translator.fail(new Error('Turno Cursor cancelado pelo SDK (interrupcao externa ou permissao negada).'));
      return;
    }
    if (result.status !== 'finished') {
      translator.fail(
        new Error(
          `Turno Cursor terminou com status "${result.status}"` +
            `${result.errorMessage !== undefined ? `: ${result.errorMessage}` : ''}`,
        ),
      );
      if (lane.kind !== 'desktop') {
        throw new Error(result.errorMessage ?? `cursor run status=${result.status}`);
      }
      return;
    }

    let finalText = result.finalText.length > 0 ? result.finalText : (result.resultText ?? translator.assistantText());
    if (finalText.trim()) {
      const cleaned = extractAndProcessOnboardingData(finalText, {
        sendStream: emit,
        onAudit: ({ toolName, input, output }) =>
          audit(getWindow, {
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
    const usageSnapshot = buildCursorUsageSnapshot(result.usage, selection.model, {
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens(finalText),
    });
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
    turnOk = true;
    await maybeCompactChatSession(sessionId, emit, { model: selection.model, provider: 'cursor' });
  } catch (error) {
    if (isSubagentProviderAuthError(error)) {
      emit({ type: 'error', sessionId, ...subagentAuthFailure(error) });
      if (lane.kind !== 'desktop') throw error;
    } else if (!abort.signal.aborted) {
      translator.fail(error);
      if (lane.kind !== 'desktop') throw error;
    }
  } finally {
    settleTimeline(turnOk && !abort.signal.aborted && !translator.settledPending());
    session.close();
    if (lane.currentAbortController === abort) lane.currentAbortController = null;
  }
}
