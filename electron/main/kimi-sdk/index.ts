import { swarmAggregationGuard } from '../swarm/aggregation-policy';
import { persistSwarmResponse } from '../swarm/chat-persistence';

import crypto from 'crypto';
import type { BrowserWindow } from 'electron';
import { smokeAudit } from '../smoke-audit';
import { createLogger } from '../logger';
import {
  clearSessionPendingSeed,
  getSession,
  getSessionMessages,
  getPermissionBypass,
  getSetting,
  getTurnIndexForUserMessage,
  getLatestUserTurnIndex,
  insertAuditEntry,
  insertMessage,
  updateSessionTokens,
  setSessionActiveContextTokens,
} from '../db';
import { persistUserChatMessage } from '../user-attachments-meta';
import { getAgentCwd } from '../paths';
import {
  beginTimelineTurn,
  buildToolsBlocksByAnchor,
  computeTimelineMetrics,
  logTimelineMetrics,
  resolveCliTimelineOrigin,
  resolveTimelineAnchor,
} from '../session-timeline';
import { estimateTokens } from '../token-estimator';
import {
  normalizeUsage,
  canonicalPromptTokens,
  reconcileActiveContext,
  estimateStrongFloor,
  estimateAgenticContentTokens,
  KIMI_PRESET_TOKENS,
} from '../agent-runtime/context-measure';
import { buildChatContextUsage } from '../chat-context-usage';
import { isChatTimelineReinjectEnabled, maybeCompactChatSession } from '../chat-compaction-trigger';
import { KIMI_PRICING_REMAP } from '../agent-runtime/kimi-executor';
import { ensureInitialSessionTitle, generateSessionTitle } from '../title-generator';
import type { QueryOptions } from '../orchestrator';
import type { OrchestratorSelection } from '../orchestrator-selection';
import type { SdkLane } from '../sdk-lane';
import { resolveLaneForOptions, lanesOrAllDesktop } from '../desktop-lanes';
import { SessionRequiredError } from '../lanes';
import type { ArtifactData, AuditEntry, StreamChunk } from '../../../src/types';
import { buildKimiHistoryPreamble } from './history';
import { createChatKimiSession } from './session';
import { buildKimiUsageSnapshot, createKimiStreamTranslator } from './stream-translator';
import { createPermissionGuard } from '../permission-guard';
import { PERM_BYPASS_NO_GUARD, PERM_DEFAULT_WITH_GUARD } from '../agent-runtime/permission-profiles';
import { isSubagentProviderAuthError, subagentAuthFailure } from '../agent-runtime/subagent-dispatch';
import { isKimiEffort } from '../../../src/constants/kimi-models';
import {
  getActiveChatTurnBinding,
  getChatCapabilityTurn,
  computeEffectiveCapabilitiesForTurn,
} from '../chat-capability-context';
import { recordCompletedMainChatTurn } from '../dreaming-turn-engine';
import {
  completeOnboardingFromPersistedProfile,
  extractAndProcessOnboardingData,
  resolveOnboardingCompletedFromState,
} from '../onboarding';

const logger = createLogger('kimi-sdk');

export function stopKimiSdkQuery(laneArg?: SdkLane): void {
  for (const lane of lanesOrAllDesktop(laneArg)) {
    if (lane.currentAbortController) {
      lane.currentAbortController.abort();
      lane.currentAbortController = null;
    }
  }
}

export function isKimiSdkQueryActive(laneArg?: SdkLane): boolean {
  return lanesOrAllDesktop(laneArg).some((lane) => lane.currentAbortController !== null);
}

export function resetKimiSdkSessionState(laneArg?: SdkLane): void {
  for (const lane of lanesOrAllDesktop(laneArg)) {
    stopKimiSdkQuery(lane);
  }
}

function sendStream(getWindow: () => BrowserWindow | null, silent: boolean | undefined, chunk: StreamChunk): void {
  if (silent) return;
  try {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('chat:stream', chunk);
    }
  } catch {}
}

function sendLogEntry(getWindow: () => BrowserWindow | null, entry: Omit<AuditEntry, 'id' | 'createdAt'>): void {
  try {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      const liveEntry: AuditEntry = {
        id: -1,
        createdAt: new Date().toISOString(),
        ...entry,
      };
      win.webContents.send('logs:entry', liveEntry);
    }
  } catch {}
}

function recordAuditEntry(getWindow: () => BrowserWindow | null, entry: Omit<AuditEntry, 'id' | 'createdAt'>): void {
  insertAuditEntry(entry);
  sendLogEntry(getWindow, entry);
}

function resolveSessionId(
  options: QueryOptions,
  lane: SdkLane,
): {
  sessionId: string;
  created: boolean;
} {
  if (options.sessionId) {
    return { sessionId: options.sessionId, created: false };
  }
  throw new SessionRequiredError(lane.name, 'kimi-sdk');
}

export async function executeKimiSdkQuery(
  message: string,
  options: QueryOptions,
  getWindow: () => BrowserWindow | null,
  laneArg: SdkLane | undefined,
  selection: OrchestratorSelection,
): Promise<void> {
  const lane = laneArg ?? resolveLaneForOptions(options, 'kimi-sdk');
  const queryId = crypto.randomUUID();
  const { sessionId, created } = resolveSessionId(options, lane);
  logger.info(
    {
      queryId,
      sessionId,
      createdSession: created,
      agentId: options.agentId,
      model: selection.model,
      provider: selection.provider,
      messageChars: message.length,
    },
    'Kimi SDK query started',
  );

  options.onStreamChunk?.({ type: 'session', content: sessionId });
  sendStream(getWindow, options.silent, {
    type: 'session',
    content: sessionId,
    sessionId,
  });

  const displayContent = options.displayMessage ?? message;
  const skipUserPersistence = options.origin === 'system-event' || options.skipUserMessagePersistence === true;
  let currentTurnIndex = 0;
  let persistedUserMessageId: number | null = null;
  if (skipUserPersistence) {
    try {
      currentTurnIndex = getLatestUserTurnIndex(sessionId);
    } catch {
      currentTurnIndex = 0;
    }
  } else {
    try {
      const userMessageId = persistUserChatMessage(sessionId, displayContent, options.attachmentsMeta);
      persistedUserMessageId = userMessageId;
      currentTurnIndex = getTurnIndexForUserMessage(sessionId, userMessageId);
      logger.debug(
        { queryId, sessionId, displayChars: displayContent.length, turnIndex: currentTurnIndex },
        'Kimi SDK user message persisted',
      );
      ensureInitialSessionTitle(sessionId, displayContent);
    } catch (err) {
      logger.warn({ err, queryId, sessionId }, 'failed to persist user message');
      try {
        currentTurnIndex = getLatestUserTurnIndex(sessionId);
      } catch {
        currentTurnIndex = 0;
      }
    }
  }

  const abort = new AbortController();
  lane.currentAbortController = abort;

  const emit = (chunk: StreamChunk): void => {
    options.onStreamChunk?.({ ...chunk, sessionId });
    sendStream(getWindow, options.silent, { ...chunk, sessionId });
  };

  let isOnboarding = getSetting('onboarding_completed') !== 'true';
  if (isOnboarding && resolveOnboardingCompletedFromState()) {
    emit({ type: 'onboarding_completed' });
    isOnboarding = false;
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
    runtime: 'kimi',
    fidelity: 'observed',
    cwd: getAgentCwd(isOnboarding),
  });
  const collectedArtifacts: ArtifactData[] = [];
  const translator = createKimiStreamTranslator({
    sessionId,
    turnIndex: currentTurnIndex,
    emit,
    subagent: options.agentId,
    onArtifact: (artifact) => {
      collectedArtifacts.push(artifact);
    },
    onAuditEntry: (entry) => sendLogEntry(getWindow, entry),
    timeline,
  });
  let timelineSettled = false;
  const settleTimeline = (complete: boolean): void => {
    if (timelineSettled) return;
    timelineSettled = true;
    const metrics = computeTimelineMetrics('kimi', translator.timelineEvents());
    timeline.metrics(metrics);
    if (complete && !timeline.persistFailed) timeline.complete();
    logTimelineMetrics({
      runId: timeline.runId,
      runtime: 'kimi',
      status: complete && !timeline.persistFailed ? 'complete' : 'interrupted',
      ...metrics,
    });
  };

  const chatCaps =
    lane.kind === 'desktop'
      ? (() => {
          const t = getActiveChatTurnBinding({ sessionId, lane: 'desktop' });
          const ctx = t ? getChatCapabilityTurn(t) : undefined;
          return ctx ? computeEffectiveCapabilitiesForTurn(ctx) : undefined;
        })()
      : undefined;

  let session;
  try {
    logger.info({ queryId, sessionId, model: selection.model, agentId: options.agentId }, 'Creating chat Kimi session');
    session = await createChatKimiSession({
      swarmReadOnly: !!options.swarmDelivery,
      sessionId,
      model: selection.model,
      ...(isKimiEffort(selection.effort) ? { effort: selection.effort } : {}),
      permission: options.swarmDelivery
        ? PERM_DEFAULT_WITH_GUARD(swarmAggregationGuard)
        : !isOnboarding && getPermissionBypass()
          ? PERM_BYPASS_NO_GUARD
          : PERM_DEFAULT_WITH_GUARD(createPermissionGuard(getWindow, { isOnboarding, sessionId })),
      abortSignal: abort.signal,
      agentId: options.agentId,
      isOnboarding,
      capabilities: chatCaps,
      lane: lane.kind,
      turnBinding: getActiveChatTurnBinding({ sessionId, lane: lane.kind }),
    });
    logger.info({ queryId, sessionId }, 'Chat Kimi session created');
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.error({ err, queryId, sessionId }, 'failed to create chat Kimi session');
    emit({ type: 'error', error: errMessage });
    try {
      recordAuditEntry(getWindow, {
        sessionId,
        subagent: options.agentId,
        eventType: 'error',
        toolName: 'kimi.session',
        output: errMessage,
      });
    } catch (auditErr) {
      logger.debug({ err: auditErr, sessionId }, 'audit insert for kimi session error failed');
    }
    settleTimeline(false);
    if (lane.currentAbortController === abort) {
      lane.currentAbortController = null;
    }
    if (lane.kind !== 'desktop') throw err;
    return;
  }

  const kimiSessionContextMeta = session.contextMeta;

  const sessionRow = getSession(sessionId);
  const compactedUpTo = sessionRow?.compactedUpToMessageId ?? null;
  const allPriorTurns = getSessionMessages(sessionId);
  const priorTurns = compactedUpTo !== null ? allPriorTurns.filter((m) => m.id > compactedUpTo) : allPriorTurns;
  const historyPreamble = buildKimiHistoryPreamble(priorTurns, {
    dropLast: !skipUserPersistence,
    ...(isChatTimelineReinjectEnabled()
      ? { toolsByAnchor: buildToolsBlocksByAnchor(sessionId, priorTurns, compactedUpTo) }
      : {}),
  });
  const historyTurns = historyPreamble ? historyPreamble.split('\n\n').length : 0;
  const basePrompt = historyPreamble
    ? `Conversation so far:\n${historyPreamble}\n\nNew user message:\n${message}`
    : message;
  const pendingSeed = sessionRow?.pendingSeed ?? null;
  const prompt = pendingSeed ? `${pendingSeed}\n\n${basePrompt}` : basePrompt;
  logger.info(
    {
      queryId,
      sessionId,
      priorTurns: priorTurns.length,
      historyTurns,
      historyChars: historyPreamble.length,
      promptChars: prompt.length,
    },
    'Kimi SDK context prepared',
  );
  try {
    recordAuditEntry(getWindow, {
      sessionId,
      subagent: options.agentId,
      eventType: 'tool_call',
      toolName: 'kimi.context',
      input: JSON.stringify({
        runtime: 'kimi-sdk',
        model: selection.model,
        provider: selection.provider,
        historyChars: historyPreamble.length,
        historyTurns,
        messageChars: message.length,
      }),
    });
  } catch (err) {
    logger.debug({ err, sessionId }, 'audit insert for kimi context failed');
  }

  let assistantText = '';
  let firstTextLogged = false;
  let agenticTurnTokens = 0;
  const wrappedCallbacks = {
    ...translator.callbacks,
    onText: (delta: string) => {
      if (!firstTextLogged) {
        firstTextLogged = true;
        logger.info({ queryId, sessionId, deltaChars: delta.length }, 'Kimi SDK first text delta');
      }
      assistantText += delta;
      translator.callbacks.onText?.(delta);
    },
    onToolUseIO: (tool: string, input: unknown, output: unknown, toolCallId?: string) => {
      agenticTurnTokens += estimateAgenticContentTokens(input) + estimateAgenticContentTokens(output);
      translator.callbacks.onToolUseIO?.(tool, input, output, toolCallId);
    },
  };

  let turnOk = false;
  let responseFinished = false;
  smokeAudit('turn_start', { lane: lane.name, runtime: 'kimi-sdk', sessionId });

  try {
    logger.info({ queryId, sessionId, promptChars: prompt.length }, 'Kimi SDK send starting');
    const response = await session.send(prompt, wrappedCallbacks, abort.signal);
    responseFinished = response.status === 'finished';
    logger.info(
      {
        queryId,
        sessionId,
        status: response.status,
        contentChars: response.content.length,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      },
      'Kimi SDK send completed',
    );
    if (abort.signal.aborted || response.status === 'cancelled') {
      logger.info({ queryId, sessionId, status: response.status }, 'Kimi SDK query cancelled');
      return;
    }
    const finalText = response.content || assistantText;
    if (options.swarmDelivery && (abort.signal.aborted || response.status !== 'finished')) {
      throw new Error(`Agregação Swarm não concluída: ${response.status}`);
    }
    let persistedFinalText = finalText;
    if (persistedFinalText.trim().length > 0) {
      const recordOnboardingAudit = ({
        toolName,
        input,
        output,
      }: {
        toolName: string;
        input: string;
        output: string;
      }) => {
        recordAuditEntry(getWindow, {
          sessionId,
          subagent: options.agentId,
          eventType: 'tool_call',
          toolName,
          input,
          output,
        });
      };
      const cleaned = options.swarmDelivery
        ? null
        : extractAndProcessOnboardingData(persistedFinalText, {
            sendStream: emit,
            onAudit: recordOnboardingAudit,
          });
      if (cleaned !== null) persistedFinalText = cleaned;
      if (cleaned === null && isOnboarding && !options.swarmDelivery) {
        completeOnboardingFromPersistedProfile({
          sendStream: emit,
          onAudit: recordOnboardingAudit,
        });
      }
    }
    const kimiUsageSnapshot = buildKimiUsageSnapshot(
      response,
      selection.model,
      KIMI_PRICING_REMAP[selection.model] ?? selection.model,
      {
        inputTokens: estimateTokens(prompt),
        outputTokens: estimateTokens(persistedFinalText),
      },
    );
    translator.finalize({ ...response, content: persistedFinalText }, kimiUsageSnapshot);
    const hasAssistantText = persistedFinalText.trim().length > 0;
    const hasValidToolOnlyTurn = !hasAssistantText && response.toolUses > 0;
    if (hasAssistantText) {
      try {
        const messageMetadata =
          collectedArtifacts.length > 0 ? JSON.stringify({ artifacts: collectedArtifacts }) : undefined;
        if (!persistSwarmResponse(options, sessionId, persistedFinalText, messageMetadata)) {
          insertMessage(sessionId, 'assistant', persistedFinalText, options.agentId, messageMetadata);
        }
        recordCompletedMainChatTurn(sessionId, getWindow);
        const session = getSession(sessionId);
        if (session && session.type !== 'scheduled' && session.type !== 'telegram') {
          const msgs = getSessionMessages(session.id);
          const assistantCount = msgs.filter((m) => m.role === 'assistant').length;
          const shouldGenerateTitle = !session.title || assistantCount === 1;
          if (shouldGenerateTitle && msgs.length >= 2) {
            void generateSessionTitle(session.id).catch((err) =>
              logger.error({ err, queryId, sessionId }, 'Kimi: title generation failed'),
            );
          }
        }
      } catch (err) {
        logger.warn({ err, queryId, sessionId }, 'failed to persist assistant message');
      }
    } else {
      logger.debug({ queryId, sessionId }, 'Kimi: empty response - skipping insertMessage and dreaming hook');
    }
    if ((hasAssistantText || hasValidToolOnlyTurn) && pendingSeed) {
      clearSessionPendingSeed(sessionId);
      logger.info({ queryId, sessionId }, 'Kimi: pending_seed consumido no sucesso do turno');
    }
    if (hasAssistantText || hasValidToolOnlyTurn) {
      try {
        const u = response.usage;
        updateSessionTokens(
          sessionId,
          u.inputTokens,
          u.outputTokens,
          kimiUsageSnapshot.costStatus === 'known' ? (kimiUsageSnapshot.costUsd ?? 0) : 0,
          {
            costStatus: kimiUsageSnapshot.costStatus ?? 'unknown',
            tokenStatus: kimiUsageSnapshot.tokenStatus ?? 'not_reported',
            costUnknownReason: kimiUsageSnapshot.costUnknownReason ?? null,
            runtime: 'kimi',
            costEstimationKind: 'subscription-equivalent-payg',
          },
        );
        const kimiContextEstimate = estimateStrongFloor({
          systemPromptTokens: kimiSessionContextMeta.systemPromptTokens,
          presetTokens: KIMI_PRESET_TOKENS,
          mcpSchemasTokens: kimiSessionContextMeta.toolSchemasTokens,
          messageTexts: [prompt, persistedFinalText],
          agenticTokens: agenticTurnTokens,
        });
        const kimiCanonical = normalizeUsage(response.usage, 'anthropic');
        const usageComplete = kimiUsageSnapshot.tokenStatus === 'reported';
        const realPromptTokens = usageComplete ? canonicalPromptTokens(kimiCanonical) : 0;
        const realOutputTokens = usageComplete ? kimiCanonical.outputTokens : 0;
        const liveContextTokens = reconcileActiveContext(realPromptTokens, realOutputTokens, kimiContextEstimate);
        setSessionActiveContextTokens(sessionId, liveContextTokens);
        const turnContextUsage = buildChatContextUsage({
          model: selection.model,
          provider: selection.provider,
          contextTokens: liveContextTokens,
          source: realPromptTokens > 0 ? 'provider' : 'estimate',
        });
        if (turnContextUsage) emit({ type: 'context_usage', contextUsage: turnContextUsage });
      } catch (err) {
        logger.warn({ err, queryId, sessionId }, 'Kimi: token persistence failed');
      }
    }
    try {
      recordAuditEntry(getWindow, {
        sessionId,
        subagent: options.agentId,
        eventType: 'tool_result',
        toolName: 'kimi.send',
        output: `inputTokens=${response.usage.inputTokens} outputTokens=${response.usage.outputTokens} status=${response.status}`,
      });
    } catch (err) {
      logger.debug({ err }, 'audit insert for completion failed');
    }
    turnOk = true;

    await maybeCompactChatSession(sessionId, emit, {
      model: selection.model,
      provider: selection.provider,
    });
  } catch (err) {
    if (isSubagentProviderAuthError(err)) {
      const failure = subagentAuthFailure(err);
      emit({ type: 'error', sessionId, ...failure });
      logger.warn({ queryId, sessionId, provider: failure.authProvider }, 'Kimi chat subagent auth required');
      if (lane.kind !== 'desktop') throw err;
    } else if (abort.signal.aborted) {
      logger.info({ queryId, sessionId }, 'Kimi SDK query aborted');
    } else {
      translator.fail(err);
      logger.error({ err, queryId, sessionId }, 'Kimi SDK query failed');
      const errMessage = err instanceof Error ? err.message : String(err);
      try {
        recordAuditEntry(getWindow, {
          sessionId,
          subagent: options.agentId,
          eventType: 'error',
          toolName: 'kimi.send',
          output: errMessage,
        });
      } catch (auditErr) {
        logger.debug({ err: auditErr, sessionId }, 'audit insert for kimi send error failed');
      }
      if (lane.kind !== 'desktop') throw err;
    }
  } finally {
    settleTimeline(turnOk && responseFinished && !abort.signal.aborted);
    smokeAudit('turn_done', { lane: lane.name, runtime: 'kimi-sdk', sessionId, ok: turnOk });
    try {
      await session.close();
    } catch (err) {
      logger.debug({ err }, 'session.close threw');
    }
    if (lane.currentAbortController === abort) {
      lane.currentAbortController = null;
    }
    logger.info({ queryId, sessionId }, 'Kimi SDK query finished');
  }
}
