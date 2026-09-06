import crypto from 'crypto';
import type { BrowserWindow } from 'electron';
import { createLogger } from '../logger';
import {
  clearSessionPendingSeed,
  createSession,
  getActiveChatSession,
  getSession,
  getSessionMessages,
  getSessionActiveRepository,
  getLatestUserTurnIndex,
  getLocalRepository,
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
import type { GrokReasoningEffort } from '../../../src/constants/grok-models';
import { emptyResponseExecutionError } from '../agent-runtime/llm-error';
import { buildGrokHistoryPreamble } from './history';
import { createChatGrokSession } from './session';
import { buildGrokUsageSnapshot, createGrokStreamTranslator } from './stream-translator';
import { assertGrokWorkspaceUnchanged, resolveGrokWorkspaceGrant } from './workspace';
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
import {
  isSubagentProviderAuthError,
  subagentAuthFailure,
} from '../agent-runtime/subagent-dispatch';

const logger = createLogger('grok-sdk');

export function stopGrokSdkQuery(lane: SdkLane = desktopLane): void {
  lane.currentAbortController?.abort();
  lane.currentAbortController = null;
}

export function isGrokSdkQueryActive(lane: SdkLane = desktopLane): boolean {
  return lane.currentAbortController !== null;
}

export function resetGrokSdkSessionState(lane: SdkLane = desktopLane): void {
  stopGrokSdkQuery(lane);
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

export async function executeGrokSdkQuery(
  message: string,
  options: QueryOptions,
  getWindow: () => BrowserWindow | null,
  lane: SdkLane = desktopLane,
  selection: OrchestratorSelection,
): Promise<void> {
  const sessionId = resolveSessionId(options, lane);
  const repoRootSnapshot = lane.name === 'desktop'
    ? (() => {
        const attachment = getSessionActiveRepository(sessionId);
        return attachment
          ? getLocalRepository(attachment.repositoryId)?.canonicalRootPath
          : undefined;
      })()
    : undefined;
  const workspaceGrant = resolveGrokWorkspaceGrant({
    lane: lane.name as 'desktop' | 'telegram' | 'cron',
    repoRootSnapshot,
  });
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
  const translator = createGrokStreamTranslator({
    sessionId,
    model: selection.model,
    emit,
    subagent: options.agentId,
    turnIndex: currentTurnIndex,
    onArtifact: (artifact) => artifacts.push(artifact),
    onAuditEntry: (entry) => sendLog(getWindow, entry),
  });

  let session;
  try {
    session = await createChatGrokSession({
      sessionId,
      model: selection.model,
      effort: (selection.effort ?? 'high') as GrokReasoningEffort,
      getWindow,
      abortSignal: abort.signal,
      lane: lane.name as 'desktop' | 'telegram' | 'cron',
      agentId: options.agentId,
      isOnboarding,
      capabilities,
      workspaceGrant,
    });
  } catch (error) {
    translator.fail(error);
    lane.currentAbortController = null;
    if (lane !== desktopLane) throw error;
    return;
  }

  const row = getSession(sessionId);
  const compactedUpTo = row?.compactedUpToMessageId ?? null;
  const allMessages = getSessionMessages(sessionId);
  const priorMessages = compactedUpTo === null
    ? allMessages
    : allMessages.filter((item) => item.id > compactedUpTo);
  const history = buildGrokHistoryPreamble(priorMessages, { dropLast: !skipUser });
  const basePrompt = history
    ? `Conversation so far:\n${history}\n\nNew user message:\n${message}`
    : message;
  const pendingSeed = row?.pendingSeed ?? null;
  const prompt = pendingSeed ? `${pendingSeed}\n\n${basePrompt}` : basePrompt;
  audit(getWindow, {
    sessionId,
    subagent: options.agentId,
    eventType: 'tool_call',
    toolName: 'grok.context',
    input: JSON.stringify({ runtime: 'grok-sdk', provider: 'grok', model: selection.model, historyChars: history.length }),
  });

  let assistantText = '';
  let agenticTokens = 0;
  let toolUses = 0;
  const callbacks = {
    ...translator.callbacks,
    onText(delta: string) {
      assistantText += delta;
      translator.callbacks.onText?.(delta);
    },
    onToolUse(name: string) {
      toolUses += 1;
      translator.callbacks.onToolUse?.(name);
    },
    onToolUseIO(tool: string, input: unknown, output: unknown) {
      agenticTokens += estimateAgenticContentTokens(input) + estimateAgenticContentTokens(output);
      translator.callbacks.onToolUseIO?.(tool, input, output);
    },
  };

  try {
    const response = await session.send(prompt, callbacks, abort.signal);
    if (abort.signal.aborted) return;
    if (response.status === 'cancelled') {
      translator.fail(new Error(
        'Turno Grok cancelado pelo CLI (permissao negada ou interrupcao externa).',
      ));
      return;
    }
    assertGrokWorkspaceUnchanged(workspaceGrant);
    let finalText = response.content || assistantText;
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
    const usageSnapshot = buildGrokUsageSnapshot(
      response,
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
      provider: 'grok',
      model: selection.model,
    });
    if (emptyError) {
      emit({ type: 'error', code: emptyError.code, error: emptyError.userMessage });
      return;
    }
    translator.finalize({ ...response, content: finalText }, usageSnapshot);
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

    const usage = response.usage;
    const hasUsage = usageSnapshot.tokenStatus === 'reported';
    updateSessionTokens(
      sessionId,
      hasUsage ? usage.inputTokens : 0,
      hasUsage ? usage.outputTokens : 0,
      usageSnapshot.costStatus === 'known' ? (usageSnapshot.costUsd ?? 0) : 0,
      {
        costStatus: usageSnapshot.costStatus ?? 'unknown',
        tokenStatus: usageSnapshot.tokenStatus ?? 'not_reported',
        costUnknownReason: usageSnapshot.costUnknownReason ?? null,
        runtime: 'grok',
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
    const modelCalls = response.metadata?.modelCalls ?? 1;
    const realPrompt = hasUsage && modelCalls <= 1 ? usage.inputTokens : 0;
    const realOutput = hasUsage && modelCalls <= 1 ? usage.outputTokens : 0;
    const liveContext = reconcileActiveContext(realPrompt, realOutput, estimate);
    setSessionActiveContextTokens(sessionId, liveContext);
    const contextUsage = buildChatContextUsage({
      model: selection.model,
      provider: 'grok',
      contextTokens: liveContext,
      source: realPrompt > 0 ? 'provider' : 'estimate',
    });
    if (contextUsage) emit({ type: 'context_usage', contextUsage });
    const persisted = hasAssistantText ? getSession(sessionId) : null;
    if (persisted && persisted.type !== 'scheduled' && persisted.type !== 'telegram') {
      const messages = getSessionMessages(sessionId);
      const assistantCount = messages.filter((item) => item.role === 'assistant').length;
      if ((!persisted.title || assistantCount === 1) && messages.length >= 2) {
        void generateSessionTitle(sessionId).catch((error) => logger.warn({ error }, 'grok title generation failed'));
      }
    }
    await maybeCompactChatSession(sessionId, emit, { model: selection.model, provider: 'grok' });
  } catch (error) {
    if (isSubagentProviderAuthError(error)) {
      emit({ type: 'error', sessionId, ...subagentAuthFailure(error) });
      if (lane !== desktopLane) throw error;
    } else if (!abort.signal.aborted) {
      translator.fail(error);
      if (lane !== desktopLane) throw error;
    }
  } finally {
    await session.close();
    if (lane.currentAbortController === abort) lane.currentAbortController = null;
  }
}
