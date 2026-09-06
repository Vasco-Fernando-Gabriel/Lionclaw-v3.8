
import crypto from "crypto";
import type { BrowserWindow } from "electron";
import { createLogger } from "../logger";
import { smokeAudit } from "../smoke-audit";
import {
  createSession,
  clearSessionPendingSeed,
  getActiveChatSession,
  getSession,
  getSessionMessages,
  getSessionMessagesAfterFence,
  getSetting,
  getTurnIndexForUserMessage,
  getLatestUserTurnIndex,
  insertAuditEntry,
  insertMessage,
  updateSessionTokens,
  setSessionActiveContextTokens,
  setSessionAgenticContextTokens,
} from "../db";
import { persistUserChatMessage } from "../user-attachments-meta";
import {
  normalizeUsage,
  canonicalPromptTokens,
  reconcileActiveContext,
  estimateStrongFloor,
  estimateAgenticContentTokens,
  resolveHistoryFence,
  CODEX_PRESET_TOKENS,
} from "../agent-runtime/context-measure";
import { buildChatContextUsage } from "../chat-context-usage";
import { maybeCompactChatSession } from "../chat-compaction-trigger";
import type {
  CodexResponse,
  CodexTokenUsage,
  CodexToolUseMeta,
} from '../codex-runtime/types';
import type { SyncCodexSession } from "../codex-runtime/types";
import type { QueryOptions } from "../orchestrator";
import type { OrchestratorSelection } from "../orchestrator-selection";
import { type SdkLane, desktopLane } from "../sdk-lane";
import type {
  ArtifactData,
  AuditEntry,
  CodexChatReasoningEffort,
  StreamChunk,
} from "../../../src/types";
import { CODEX_EFFORT_ORDER } from "../../../src/constants/codex-models";
import { clampCodexEffortForModelDiscovered } from "../codex-runtime/model-capabilities";
import { buildCodexHistoryPreamble } from "./history";
import { ZERO_CODEX_USAGE, settleChatCodexBilling } from "./chat-billing";
import { createChatCodexSession, type CodexChatContextMeta } from "./session";
import {
  buildChatRepoContextFingerprint,
  buildChatThreadConfigSignature,
  resolveChatCodexMcpComposition,
} from "../codex-chat-spawn-extras";
import { createCodexStreamTranslator } from "./stream-translator";
import {
  getActiveChatTurnByLane,
  getChatCapabilityTurn,
  computeEffectiveCapabilitiesForTurn,
} from "../chat-capability-context";
import { ensureInitialSessionTitle, generateSessionTitle } from "../title-generator";
import { calculateCost } from "../pricing";
import { getRepoGraphTurnContext } from "../repo-graph/turn-context";
import { validateRepoRootPath } from "../repo-graph/validate-root";
import { prefetchRepoGraphTurnContext } from "../repo-graph/minimal-context";
import { recordCompletedMainChatTurn } from "../dreaming-turn-engine";
import {
  completeOnboardingFromPersistedProfile,
  extractAndProcessOnboardingData,
  resolveOnboardingCompletedFromState,
} from "../onboarding";
import { codexTurnFailureError } from "../agent-runtime/llm-error";
import {
  isSubagentProviderAuthError,
  pendingSubagentProviderAuthError,
  subagentAuthFailure,
} from "../agent-runtime/subagent-dispatch";

const logger = createLogger("codex-sdk");


interface CachedChatCodexSession {
  session: SyncCodexSession;
  model: string;
  provider: string;
  cwd: string | undefined;
  configSignature: string;
  lane: string;
  contextMeta: CodexChatContextMeta | null;
  billedUsage: CodexTokenUsage;
}

const chatCodexSessionCache = new Map<string, CachedChatCodexSession>();

const CHAT_CODEX_SESSION_CACHE_MAX = 4;

function cacheChatCodexSession(sessionId: string, entry: CachedChatCodexSession): void {
  chatCodexSessionCache.delete(sessionId);
  chatCodexSessionCache.set(sessionId, entry);
  while (chatCodexSessionCache.size > CHAT_CODEX_SESSION_CACHE_MAX) {
    const oldest = chatCodexSessionCache.keys().next().value;
    if (oldest === undefined) break;
    logger.info(
      { sessionId: oldest, cap: CHAT_CODEX_SESSION_CACHE_MAX },
      "Codex chat: LRU cap reached; evicting oldest persistent thread",
    );
    closeCachedChatCodexSession(oldest, "lru-evicted");
  }
}

function closeCachedChatCodexSession(sessionId: string, reason: string): void {
  const entry = chatCodexSessionCache.get(sessionId);
  if (!entry) return;
  chatCodexSessionCache.delete(sessionId);
  try {
    entry.session.close();
  } catch (err) {
    logger.debug({ err, sessionId, reason }, "cached codex chat session close threw");
  }
  logger.info({ sessionId, reason }, "Codex chat: persistent thread closed");
}

export function closeAllCachedChatCodexSessions(reason: string, laneName?: string): void {
  for (const [sessionId, entry] of Array.from(chatCodexSessionCache.entries())) {
    if (laneName !== undefined && entry.lane !== laneName) continue;
    closeCachedChatCodexSession(sessionId, reason);
  }
}

export function stopCodexSdkQuery(lane: SdkLane = desktopLane): void {
  if (lane.currentAbortController) {
    lane.currentAbortController.abort();
    lane.currentAbortController = null;
  }
}

export function isCodexSdkQueryActive(lane: SdkLane = desktopLane): boolean {
  return lane.currentAbortController !== null;
}

export function resetCodexSdkSessionState(lane: SdkLane = desktopLane): void {
  stopCodexSdkQuery(lane);
  closeAllCachedChatCodexSessions(`reset-sdk-session-state:${lane.name}`, lane.name);
}

function sendStream(
  getWindow: () => BrowserWindow | null,
  silent: boolean | undefined,
  chunk: StreamChunk,
): void {
  if (silent) return;
  try {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("chat:stream", chunk);
    }
  } catch {
  }
}

function sendLogEntry(
  getWindow: () => BrowserWindow | null,
  entry: Omit<AuditEntry, "id" | "createdAt">,
): void {
  try {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      const liveEntry: AuditEntry = {
        id: -1,
        createdAt: new Date().toISOString(),
        ...entry,
      };
      win.webContents.send("logs:entry", liveEntry);
    }
  } catch {
  }
}

function recordAuditEntry(
  getWindow: () => BrowserWindow | null,
  entry: Omit<AuditEntry, "id" | "createdAt">,
): void {
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
  if (lane !== desktopLane) {
    throw new Error(
      `Lane '${lane.name}' exige options.sessionId explicito (guard de sessao, SPEC 3.3)`,
    );
  }
  const active = getActiveChatSession();
  if (active) {
    return { sessionId: active.id, created: false };
  }
  const sessionId = crypto.randomUUID();
  createSession(sessionId, "");
  return { sessionId, created: true };
}

export async function executeCodexSdkQuery(
  message: string,
  options: QueryOptions,
  getWindow: () => BrowserWindow | null,
  lane: SdkLane = desktopLane,
  selection: OrchestratorSelection,
): Promise<void> {
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
    "Codex SDK query started",
  );

  options.onStreamChunk?.({ type: "session", content: sessionId });
  sendStream(getWindow, options.silent, {
    type: "session",
    content: sessionId,
  });

  const displayContent = options.displayMessage ?? message;
  const skipUserPersistence =
    options.origin === "system-event" || options.skipUserMessagePersistence === true;
  let currentTurnIndex = 0;
  let userMessagePersisted = false;
  if (skipUserPersistence) {
    try {
      currentTurnIndex = getLatestUserTurnIndex(sessionId);
    } catch {
      currentTurnIndex = 0;
    }
  } else {
    try {
      const userMessageId = persistUserChatMessage(sessionId, displayContent, options.attachmentsMeta);
      userMessagePersisted = true;
      currentTurnIndex = getTurnIndexForUserMessage(sessionId, userMessageId);
      ensureInitialSessionTitle(sessionId, displayContent);
      logger.debug(
        { queryId, sessionId, displayChars: displayContent.length, turnIndex: currentTurnIndex },
        "Codex SDK user message persisted",
      );
    } catch (err) {
      logger.warn({ err, queryId, sessionId }, "failed to persist user message");
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

  let isOnboarding = getSetting("onboarding_completed") !== "true";
  if (isOnboarding && resolveOnboardingCompletedFromState()) {
    emit({ type: "onboarding_completed" });
    isOnboarding = false;
  }

  const collectedArtifacts: ArtifactData[] = [];
  const translator = createCodexStreamTranslator({
    sessionId,
    turnIndex: currentTurnIndex,
    emit,
    subagent: options.agentId,
    onArtifact: (artifact) => {
      collectedArtifacts.push(artifact);
    },
    onAuditEntry: (entry) => sendLogEntry(getWindow, entry),
  });

  const repoCtx = isOnboarding ? null : getRepoGraphTurnContext();
  let repoCwdOverride: string | undefined;
  if (repoCtx) {
    const validated = validateRepoRootPath(repoCtx.canonicalRootPath);
    if ("error" in validated) {
      logger.warn(
        { queryId, sessionId, error: validated.error },
        "repo-graph: canonical root invalido; sessao codex segue SEM cwdOverride",
      );
    } else {
      repoCwdOverride = validated.canonicalRootPath;
    }
  }

  const chatCaps =
    lane.name === "desktop"
      ? (() => {
          const t = getActiveChatTurnByLane("desktop");
          const ctx = t ? getChatCapabilityTurn(t) : undefined;
          return ctx ? computeEffectiveCapabilitiesForTurn(ctx) : undefined;
        })()
      : undefined;

  const savedCodexEffort =
    (getSetting("orchestrator_codex_effort") as CodexChatReasoningEffort) || "high";
  const requestedCodexEffort: CodexChatReasoningEffort = (
    CODEX_EFFORT_ORDER as readonly string[]
  ).includes(savedCodexEffort)
    ? savedCodexEffort
    : "high";
  const codexEffort: CodexChatReasoningEffort = clampCodexEffortForModelDiscovered(
    requestedCodexEffort,
    selection.model,
  );

  const persistentChatThread = lane.name === "desktop";
  const mcpComposition = resolveChatCodexMcpComposition({
    agentId: options.agentId,
    isOnboarding,
    lane: lane.name,
  });
  const threadConfigSignature = buildChatThreadConfigSignature(
    {
      pipelineControl: chatCaps?.pipelineControl ?? null,
      dynamicWorkflows: chatCaps?.dynamicWorkflows ?? null,
      onboarding: isOnboarding,
      repoContextFingerprint: buildChatRepoContextFingerprint(repoCtx),
    },
    mcpComposition,
  );

  const sessionRow = getSession(sessionId);
  const pendingSeed = sessionRow?.pendingSeed ?? null;
  const compactedUpTo = sessionRow?.compactedUpToMessageId ?? null;
  const historyFence = persistentChatThread
    ? resolveHistoryFence(compactedUpTo, sessionRow?.threadResetMessageId ?? null)
    : compactedUpTo;

  let cachedEntry = persistentChatThread ? chatCodexSessionCache.get(sessionId) : undefined;
  if (
    cachedEntry &&
    (cachedEntry.model !== selection.model ||
      cachedEntry.provider !== selection.provider ||
      cachedEntry.cwd !== repoCwdOverride ||
      cachedEntry.configSignature !== threadConfigSignature)
  ) {
    closeCachedChatCodexSession(sessionId, "session-config-changed");
    cachedEntry = undefined;
  }
  if (cachedEntry && pendingSeed) {
    closeCachedChatCodexSession(sessionId, "pending-seed-compaction-reset");
    cachedEntry = undefined;
  }
  let reuseLiveThread = cachedEntry !== undefined;

  let session: SyncCodexSession;
  let codexSessionContextMeta: CodexChatContextMeta | null = null;
  if (cachedEntry) {
    session = cachedEntry.session;
    codexSessionContextMeta = cachedEntry.contextMeta;
    cacheChatCodexSession(sessionId, cachedEntry);
    logger.info(
      { queryId, sessionId, model: selection.model },
      "Reusing persistent chat Codex thread",
    );
  } else {
  try {
    logger.info(
      { queryId, sessionId, model: selection.model, agentId: options.agentId },
      "Creating chat Codex session",
    );
    session = await createChatCodexSession({
      onContextMeta: (meta) => {
        codexSessionContextMeta = meta;
      },
      sessionId,
      model: selection.model,
      agentId: options.agentId,
      isOnboarding,
      cwdOverride: repoCwdOverride,
      capabilities: chatCaps,
      reasoningEffort: requestedCodexEffort,
      mcpComposition,
    });
    logger.info({ queryId, sessionId }, "Chat Codex session created");
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, queryId, sessionId },
      "failed to create chat Codex session",
    );
    emit({ type: "error", error: errMessage });
    try {
      recordAuditEntry(getWindow, {
        sessionId,
        subagent: options.agentId,
        eventType: "error",
        toolName: "codex.session",
        output: errMessage,
      });
    } catch (auditErr) {
      logger.debug(
        { err: auditErr, sessionId },
        "audit insert for codex session error failed",
      );
    }
    if (lane.currentAbortController === abort) {
      lane.currentAbortController = null;
    }
    return;
  }
  if (persistentChatThread) {
    const meta = codexSessionContextMeta as CodexChatContextMeta | null;
    cachedEntry = {
      session,
      model: selection.model,
      provider: selection.provider,
      cwd: repoCwdOverride,
      configSignature: threadConfigSignature,
      lane: lane.name,
      contextMeta: meta,
      billedUsage: ZERO_CODEX_USAGE,
    };
    cacheChatCodexSession(sessionId, cachedEntry);
  }
  }

  const allPriorTurns = getSessionMessages(sessionId);
  const priorTurns =
    historyFence !== null
      ? allPriorTurns.filter((m) => m.id > historyFence)
      : allPriorTurns;
  const historyPreamble = persistentChatThread
    ? reuseLiveThread
      ? ""
      : buildCodexHistoryPreamble(priorTurns, { dropLast: userMessagePersisted })
    : buildCodexHistoryPreamble(priorTurns);
  const historyTurns = historyPreamble
    ? historyPreamble.split("\n\n").length
    : 0;
  let repoBaseline: string | null = null;
  const skipRepoBaselineOnReuse = persistentChatThread && reuseLiveThread;
  if (repoCtx && !skipRepoBaselineOnReuse) {
    const prefetched = await prefetchRepoGraphTurnContext(message, {
      emitChunk: (chunk) =>
        sendStream(getWindow, options.silent, { ...chunk, sessionId }),
    });
    repoBaseline = prefetched?.renderedMarkdown ?? null;
  }
  const officialRehydrateBlock =
    persistentChatThread && !reuseLiveThread && !pendingSeed
      ? [
          ...(sessionRow?.rollingSummary ? [sessionRow.rollingSummary] : []),
          ...(historyPreamble ? [`Conversation so far:\n${historyPreamble}`] : []),
        ].join("\n\n")
      : "";
  const basePrompt = persistentChatThread
    ? officialRehydrateBlock
      ? `${officialRehydrateBlock}\n\nNew user message:\n${message}`
      : message
    : historyPreamble
      ? `Conversation so far:\n${historyPreamble}\n\nNew user message:\n${message}`
      : message;
  const promptWithBaseline = repoBaseline ? `${repoBaseline}\n\n${basePrompt}` : basePrompt;
  const prompt = pendingSeed ? `${pendingSeed}\n\n${promptWithBaseline}` : promptWithBaseline;
  const fenceOffset = userMessagePersisted ? 2 : 1;
  let threadResetFenceToWrite: number | undefined =
    persistentChatThread &&
    !reuseLiveThread &&
    !pendingSeed &&
    historyPreamble !== "" &&
    priorTurns.length >= fenceOffset
      ? priorTurns[priorTurns.length - fenceOffset].id
      : undefined;
  logger.info(
    {
      queryId,
      sessionId,
      priorTurns: priorTurns.length,
      historyTurns,
      historyChars: historyPreamble.length,
      promptChars: prompt.length,
    },
    "Codex SDK context prepared",
  );
  try {
    recordAuditEntry(getWindow, {
      sessionId,
      subagent: options.agentId,
      eventType: "tool_call",
      toolName: "codex.context",
      input: JSON.stringify({
        runtime: "codex-sdk",
        model: selection.model,
        provider: selection.provider,
        historyChars: historyPreamble.length,
        historyTurns,
        messageChars: message.length,
      }),
    });
  } catch (err) {
    logger.debug({ err, sessionId }, "audit insert for codex context failed");
  }

  let assistantText = "";
  let firstActivityLogged = false;
  let firstTextLogged = false;
  let firstReasoningLogged = false;
  let firstToolLogged = false;
  let agenticTurnTokens = 0;
  const wrappedCallbacks = {
    ...translator.callbacks,
    onActivity: () => {
      if (!firstActivityLogged) {
        firstActivityLogged = true;
        logger.info({ queryId, sessionId }, "Codex SDK first App Server activity");
      }
    },
    onText: (delta: string) => {
      if (!firstTextLogged) {
        firstTextLogged = true;
        logger.info(
          { queryId, sessionId, deltaChars: delta.length },
          "Codex SDK first text delta",
        );
      }
      assistantText += delta;
      translator.callbacks.onText?.(delta);
    },
    onReasoning: (delta: string) => {
      if (!firstReasoningLogged) {
        firstReasoningLogged = true;
        logger.info(
          { queryId, sessionId, deltaChars: delta.length },
          "Codex SDK first reasoning delta",
        );
      }
      translator.callbacks.onReasoning?.(delta);
    },
    onToolUse: (tool: string, meta?: CodexToolUseMeta) => {
      if (!firstToolLogged) {
        firstToolLogged = true;
        logger.info({ queryId, sessionId, tool }, "Codex SDK first tool call");
      }
      translator.callbacks.onToolUse?.(tool, meta);
    },
    onToolUseComplete: (tool: string, result: unknown, meta?: { callId?: string }) => {
      logger.debug({ queryId, sessionId, tool }, "Codex SDK tool completed");
      agenticTurnTokens += estimateAgenticContentTokens(result);
      translator.callbacks.onToolUseComplete?.(tool, result, meta);
    },
  };

  let turnOk = false;
  smokeAudit("turn_start", { lane: lane.name, runtime: "codex-sdk", sessionId });

  try {
    logger.info(
      { queryId, sessionId, promptChars: prompt.length, reuseLiveThread },
      "Codex SDK send starting",
    );
    let response: CodexResponse;
    if (reuseLiveThread) {
      session.setReasoningEffort?.(codexEffort);
      try {
        response = await session.reply(prompt, wrappedCallbacks, abort.signal);
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        let transient = false;
        if (!abort.signal.aborted) {
          try {
            const { isTransientCodexSessionError } = await import(
              "../pipeline-engine/codex-sessions"
            );
            transient = isTransientCodexSessionError(errMessage);
          } catch (importErr) {
            logger.debug(
              { err: importErr, queryId, sessionId },
              "transient-error helper import failed; treating error as fatal",
            );
          }
        }
        if (!transient) {
          throw err;
        }
        logger.warn(
          { queryId, sessionId, err: errMessage },
          "Codex chat: persistent thread dead; recovering with a fresh thread (SC-1)",
        );
        closeCachedChatCodexSession(sessionId, "transient-session-error");
        codexSessionContextMeta = null;
        session = await createChatCodexSession({
          onContextMeta: (meta) => {
            codexSessionContextMeta = meta;
          },
          sessionId,
          model: selection.model,
          agentId: options.agentId,
          isOnboarding,
          cwdOverride: repoCwdOverride,
          capabilities: chatCaps,
          reasoningEffort: requestedCodexEffort,
          mcpComposition,
        });
        cachedEntry = {
          session,
          model: selection.model,
          provider: selection.provider,
          cwd: repoCwdOverride,
          configSignature: threadConfigSignature,
          lane: lane.name,
          contextMeta: codexSessionContextMeta as CodexChatContextMeta | null,
          billedUsage: ZERO_CODEX_USAGE,
        };
        cacheChatCodexSession(sessionId, cachedEntry);
        reuseLiveThread = false;
        const recoveryPreamble = buildCodexHistoryPreamble(priorTurns, {
          dropLast: userMessagePersisted,
        });
        const recoveryBlock = [
          ...(sessionRow?.rollingSummary ? [sessionRow.rollingSummary] : []),
          ...(recoveryPreamble ? [`Conversation so far:\n${recoveryPreamble}`] : []),
        ].join("\n\n");
        const recoveryBase = recoveryBlock
          ? `${recoveryBlock}\n\nNew user message:\n${message}`
          : message;
        let recoveryBaseline = repoBaseline;
        if (!recoveryBaseline && repoCtx) {
          try {
            const prefetched = await prefetchRepoGraphTurnContext(message, {
              emitChunk: (chunk) =>
                sendStream(getWindow, options.silent, { ...chunk, sessionId }),
            });
            recoveryBaseline = prefetched?.renderedMarkdown ?? null;
          } catch (prefetchErr) {
            logger.debug(
              { err: prefetchErr, queryId, sessionId },
              "repo baseline prefetch failed during SC-1 recovery; proceeding without",
            );
          }
        }
        const recoveryPrompt = recoveryBaseline
          ? `${recoveryBaseline}\n\n${recoveryBase}`
          : recoveryBase;
        threadResetFenceToWrite =
          recoveryPreamble !== "" && priorTurns.length >= fenceOffset
            ? priorTurns[priorTurns.length - fenceOffset].id
            : undefined;
        response = await session.send(recoveryPrompt, wrappedCallbacks, abort.signal);
      }
    } else {
      response = await session.send(prompt, wrappedCallbacks, abort.signal);
    }
    const resolvedChildAuthError = pendingSubagentProviderAuthError(undefined, abort.signal);
    if (resolvedChildAuthError) throw resolvedChildAuthError;
    logger.info(
      {
        queryId,
        sessionId,
        status: response.status,
        threadId: response.threadId,
        contentChars: response.content.length,
        totalTokens: response.usage.totalTokens,
      },
      "Codex SDK send completed",
    );
    if (response.status === "failed" || response.status === "timeout") {
      const typed = codexTurnFailureError({
        status: response.status,
        ...(response.errorCode !== undefined ? { errorCode: response.errorCode } : {}),
        model: selection.model,
      });
      logger.warn(
        { queryId, sessionId, status: response.status, errorCode: response.errorCode, code: typed.code },
        "Codex turn resolved as failure; emitting classified error chunk (SB-4 P6)",
      );
      emit({ type: "error", code: typed.code, error: typed.userMessage });
      try {
        recordAuditEntry(getWindow, {
          sessionId,
          subagent: options.agentId,
          eventType: "error",
          toolName: "codex.send",
          output: `${typed.code}: ${typed.message}`,
        });
      } catch (auditErr) {
        logger.debug(
          { err: auditErr, sessionId },
          "audit insert for codex turn failure failed",
        );
      }
    }
    const finalText = response.content || assistantText;
    let persistedFinalText = finalText;
    if (persistedFinalText.trim().length > 0) {
      const recordOnboardingAudit = ({ toolName, input, output }: { toolName: string; input: string; output: string }) => {
        recordAuditEntry(getWindow, {
          sessionId,
          subagent: options.agentId,
          eventType: "tool_call",
          toolName,
          input,
          output,
        });
      };
      const cleaned = extractAndProcessOnboardingData(persistedFinalText, {
        sendStream: emit,
        onAudit: recordOnboardingAudit,
      });
      if (cleaned !== null) persistedFinalText = cleaned;
      if (cleaned === null && isOnboarding) {
        completeOnboardingFromPersistedProfile({
          sendStream: emit,
          onAudit: recordOnboardingAudit,
        });
      }
    }
    translator.finalize({ ...response, content: persistedFinalText });
    if (persistedFinalText.trim().length > 0) {
      try {
        const messageMetadata =
          collectedArtifacts.length > 0
            ? JSON.stringify({ artifacts: collectedArtifacts })
            : undefined;
        insertMessage(
          sessionId,
          "assistant",
          persistedFinalText,
          options.agentId,
          messageMetadata,
        );
        recordCompletedMainChatTurn(sessionId, getWindow);
        if (pendingSeed) {
          clearSessionPendingSeed(sessionId);
          logger.info({ queryId, sessionId }, "Codex: pending_seed consumido no sucesso do turno");
        }
        try {
          const persistentEntry = persistentChatThread
            ? chatCodexSessionCache.get(sessionId)
            : undefined;
          const settledBilling = persistentEntry
            ? settleChatCodexBilling(response.usage, persistentEntry.billedUsage)
            : null;
          const u = settledBilling ? settledBilling.delta : response.usage;
          if (u.inputTokens > 0 || u.outputTokens > 0) {
            const costUsd = calculateCost(
              selection.model,
              u.inputTokens,
              u.outputTokens,
              u.cachedInputTokens,
              0,
            );
            updateSessionTokens(sessionId, u.inputTokens, u.outputTokens, costUsd, {
              costStatus: 'known',
              tokenStatus: 'reported',
              runtime: 'codex',
              costEstimationKind: 'subscription-equivalent-payg',
            });
          }
          if (persistentEntry && settledBilling) {
            persistentEntry.billedUsage = settledBilling.nextBaseline;
          }
          const staticMeta = codexSessionContextMeta as CodexChatContextMeta | null;
          let floorMessageTexts: readonly string[];
          let floorAgenticTokens: number;
          if (persistentChatThread) {
            const priorAgentic = reuseLiveThread
              ? Math.max(0, sessionRow?.agenticContextTokensEst ?? 0)
              : 0;
            floorAgenticTokens = priorAgentic + agenticTurnTokens;
            setSessionAgenticContextTokens(
              sessionId,
              floorAgenticTokens,
              threadResetFenceToWrite,
            );
            const floorFence =
              threadResetFenceToWrite !== undefined
                ? threadResetFenceToWrite
                : historyFence;
            const fencedMessages = getSessionMessagesAfterFence(sessionId, floorFence);
            floorMessageTexts = [
              ...(sessionRow?.rollingSummary ? [sessionRow.rollingSummary] : []),
              ...fencedMessages.map((m) => m.content),
            ];
          } else {
            floorMessageTexts = [prompt, persistedFinalText];
            floorAgenticTokens = agenticTurnTokens;
          }
          const codexContextEstimate = estimateStrongFloor({
            systemPromptTokens: staticMeta?.systemPromptTokens ?? 0,
            presetTokens: CODEX_PRESET_TOKENS,
            mcpSchemasTokens: staticMeta?.mcpSchemasTokens ?? 0,
            messageTexts: floorMessageTexts,
            agenticTokens: floorAgenticTokens,
          });
          const lastCanonical = response.lastUsage
            ? normalizeUsage(response.lastUsage, "codex")
            : null;
          const realPromptTokens = lastCanonical
            ? canonicalPromptTokens(lastCanonical)
            : 0;
          const realOutputTokens = lastCanonical ? lastCanonical.outputTokens : 0;
          const liveContextTokens = reconcileActiveContext(
            realPromptTokens,
            realOutputTokens,
            codexContextEstimate,
          );
          setSessionActiveContextTokens(sessionId, liveContextTokens);
          const turnContextUsage = buildChatContextUsage({
            model: selection.model,
            provider: selection.provider,
            contextTokens: liveContextTokens,
            source: realPromptTokens > 0 ? "provider" : "estimate",
          });
          if (turnContextUsage) {
            emit({ type: "context_usage", contextUsage: turnContextUsage });
          }
          const session = getSession(sessionId);
          if (session && session.type !== "scheduled" && session.type !== "telegram") {
            const msgs = getSessionMessages(session.id);
            const assistantCount = msgs.filter((m) => m.role === "assistant").length;
            const shouldGenerateTitle = !session.title || assistantCount === 1;
            if (shouldGenerateTitle && msgs.length >= 2) {
              void generateSessionTitle(session.id).catch((err) =>
                logger.error({ err, queryId, sessionId }, "Codex: title generation failed"),
              );
            }
          }
        } catch (err) {
          logger.warn({ err, queryId, sessionId }, "Codex: token/title persistence failed");
        }
      } catch (err) {
        logger.warn(
          { err, queryId, sessionId },
          "failed to persist assistant message",
        );
      }
    } else {
      logger.debug(
        { queryId, sessionId },
        "Codex: empty response — skipping insertMessage and dreaming hook",
      );
    }
    try {
      recordAuditEntry(getWindow, {
        sessionId,
        subagent: options.agentId,
        eventType: "tool_result",
        toolName: "codex.send",
        output: `tokens=${response.usage.totalTokens} status=${response.status}`,
      });
    } catch (err) {
      logger.debug({ err }, "audit insert for completion failed");
    }
    turnOk = true;

    await maybeCompactChatSession(sessionId, emit, {
      model: selection.model,
      provider: selection.provider,
    });
  } catch (err) {
    const childAuthError = pendingSubagentProviderAuthError(undefined, abort.signal);
    if (childAuthError && isSubagentProviderAuthError(childAuthError)) {
      const failure = subagentAuthFailure(childAuthError);
      emit({ type: "error", ...failure });
      logger.warn(
        { queryId, sessionId, provider: failure.authProvider },
        "Codex chat subagent auth required",
      );
      try {
        recordAuditEntry(getWindow, {
          sessionId,
          subagent: options.agentId,
          eventType: "error",
          toolName: "call_agent",
          output: failure.error,
        });
      } catch (auditErr) {
        logger.debug({ err: auditErr, sessionId }, "audit insert for subagent auth failed");
      }
    } else if (abort.signal.aborted) {
      logger.info({ queryId, sessionId }, "Codex SDK query aborted");
    } else {
      if (persistentChatThread) {
        closeCachedChatCodexSession(sessionId, "turn-error");
      }
      translator.fail(err);
      logger.error({ err, queryId, sessionId }, "Codex SDK query failed");
      const errMessage = err instanceof Error ? err.message : String(err);
      try {
        recordAuditEntry(getWindow, {
          sessionId,
          subagent: options.agentId,
          eventType: "error",
          toolName: "codex.send",
          output: errMessage,
        });
      } catch (auditErr) {
        logger.debug(
          { err: auditErr, sessionId },
          "audit insert for codex send error failed",
        );
      }
    }
  } finally {
    smokeAudit("turn_done", { lane: lane.name, runtime: "codex-sdk", sessionId, ok: turnOk });
    const keepOpen =
      persistentChatThread &&
      chatCodexSessionCache.get(sessionId)?.session === session;
    if (!keepOpen) {
      try {
        session.close();
      } catch (err) {
        logger.debug({ err }, "session.close threw");
      }
    }
    if (lane.currentAbortController === abort) {
      lane.currentAbortController = null;
    }
    logger.info({ queryId, sessionId }, "Codex SDK query finished");
  }
}
