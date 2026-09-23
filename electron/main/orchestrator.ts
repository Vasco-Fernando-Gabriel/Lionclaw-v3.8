import { swarmAggregationSdkOptions } from './swarm/aggregation-policy';
import { persistSwarmResponse, releaseSwarmTurn, canBeginSwarmTurn } from './swarm/chat-persistence';
import { BrowserWindow } from 'electron';
import { createLogger } from './logger';
import {
  getAllAgents,
  getAgent,
  insertMessage,
  insertAuditEntry,
  getSetting,
  updateSessionTokens,
  setSessionActiveContextTokens,
  threadIdOf,
  getSession,
  getEnabledTools,
  getSessionMessages,
  insertTaskExecution,
  startTaskExecution,
  finalizeTaskExecutionOnce,
  finalizeRunningTaskExecutionTree,
  getTurnIndexForUserMessage,
  getLatestUserTurnIndex,
  getHarnessProject,
  getDriveSessionId,
  isDriveEngaged,
  clearSessionPendingSeed,
} from './db';
import { recordActivity, isWriteTool, deriveToolDetail } from './activity-log';
import { setActiveAgentId } from './knowledge-state';
import { extractAndProcessOnboardingData } from './onboarding';
import { calculateCost, hasKnownPricing } from './pricing';
import { getApiKey, getSecret } from './secrets-vault';
import { createPermissionGuard, GUARD_GATED_TOOLS, ASK_USER_ANSWERS_MARKER } from './permission-guard';

function isAskUserAnswersResult(toolName: string | undefined, content: string): boolean {
  return toolName === 'AskUserQuestion' && content.includes(ASK_USER_ANSWERS_MARKER);
}
import { getMCPConfigForAgent } from './mcp-manager';
import {
  resolveAgentQueryConfig,
  mergeRepoGraphAllowlist,
  buildRepoGraphMcpSpec,
  REPO_GRAPH_MCP_SERVER_ID,
  type McpServerEntry,
} from './agent-config-resolver';
import { getDisabledSDKMcps } from './mcp-discovery';
import { resolveMcpServerRuntime } from './mcp-path-resolver';
import { captureToolUse, captureToolResult, resetArtifactDetector } from './artifact-detector';
import { artifactsDirHtmlWritePath, detectHtmlArtifact, htmlArtifactFromPath } from './html-artifact';
import { buildSystemPrompt } from './prompt-builder';
import { getAgentCwd, getCronCwd, getLionClawHome } from './paths';
import { getClaudeSdkProcessOptions } from './pipeline-shared/sdk-bootstrap';
import { SDK_DISALLOWED_TOOLS, toSdkToolNames } from './agent-runtime/sdk-tool-names';
import { getCodexAgentsServer } from './codex-agents-mcp';
import {
  applySubagentCapabilityCeiling,
  createSubagentDispatchContext,
  isSubagentProviderAuthError,
  MAX_SUBAGENT_DEPTH,
  pendingSubagentProviderAuthError,
  reserveSubagentInvocation,
  resolveSubagentHostAllowedTools,
  resolveSubagentConfigWithinCeiling,
  subagentAuthFailure,
} from './agent-runtime/subagent-dispatch';
import type { SubagentDispatchContext } from './agent-runtime/types';
import { resolveChatInheritedEffort } from './agent-runtime/chat-effort-inheritance';
import { PERM_DEFAULT_WITH_GUARD } from './agent-runtime/permission-profiles';
import { buildExecutionError, isEmptyFailedTurn } from './agent-runtime/llm-error';
import {
  createChatTurnStreamFlags,
  trackChatTurnChunk,
  markChatTurnDelegated,
  shouldEmitChatTurnFallbackError,
  chatTurnFallbackError,
} from './chat-turn-safety-net';
import { buildChatContextUsage } from './chat-context-usage';
import { maybeCompactChatSession } from './chat-compaction-trigger';
import type {
  AgentDefinition,
  McpSdkServerConfigWithInstance,
  McpServerConfig,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import crypto from 'crypto';
import type {
  StreamChunk,
  AuditEntry,
  AgentConfig,
  ArtifactData,
  LiveActivityEvent,
  OrchestratorRuntime,
  ChatAttachmentMeta,
  ChatFeatureToggles,
  PersistedTimelineToolCall,
} from '../../src/types';
import { buildUserAttachmentsMeta, persistUserChatMessage } from './user-attachments-meta';
import { ensureInitialSessionTitle, generateSessionTitle } from './title-generator';
import type { QueuedMessage } from './message-queue';

type AgentDefinitionCompat = Omit<AgentDefinition, 'prompt'> & {
  prompt?: string;
};
import {
  resolveOrchestratorSelection,
  InvalidOrchestratorSelectionError,
  type OrchestratorSelection,
} from './orchestrator-selection';
import { type SdkLane, telegramLane, cronLane } from './sdk-lane';
import {
  getDesktopLane,
  listDesktopLanes,
  peekDesktopLane,
  pruneIdleDesktopLanes,
  resolveLaneForOptions,
  type DesktopLane,
} from './desktop-lanes';
import { SessionRequiredError, isDynamicWorkflowDriveSessionId } from './lanes';
import { DriveTurnAdmissionAbortedError, DriveTurnSemaphore, readDriveParallelTurns } from './drive-turn-semaphore';
import {
  getInFlightDesktopSessions,
  isDesktopSessionInFlight,
  markDesktopSessionInFlight,
  setInFlightDesktopTurn,
  clearInFlightDesktopTurn,
} from './in-flight-desktop-session';
import { notifyLaneSessionUpdated } from './lane-session-events';
import { isSessionClearing } from './clearing-sessions';
import { registerExternalStopWaiter } from './turn-settle';
import { runtimeSupportsImageInput, runtimeSupportsEffort } from './agent-runtime/runtime-capabilities';
import { describeImage, buildTranscriptionBlock, visionUnavailableNotice } from './vision-engine';
import {
  executeClaudeCompatSdkQuery,
  isClaudeCompatQueryActive,
  resetClaudeCompatSdkSessionState,
  stopClaudeCompatQuery,
} from './claude-compat-sdk';
import { executeCodexSdkQuery, isCodexSdkQueryActive, resetCodexSdkSessionState, stopCodexSdkQuery } from './codex-sdk';
import { executeKimiSdkQuery, isKimiSdkQueryActive, resetKimiSdkSessionState, stopKimiSdkQuery } from './kimi-sdk';
import { executeGrokSdkQuery, isGrokSdkQueryActive, resetGrokSdkSessionState, stopGrokSdkQuery } from './grok-sdk';
import {
  executeCursorSdkQuery,
  isCursorSdkQueryActive,
  resetCursorSdkSessionState,
  stopCursorSdkQuery,
} from './cursor-sdk';
import { executeLionSdkQuery, isLionSdkQueryActive, resetLionSdkSessionState, stopLionSdkQuery } from './lion-sdk';
import { smokeAudit } from './smoke-audit';
import { recordCompletedMainChatTurn } from './dreaming-turn-engine';
import { reportDriveTurnUsage, reportDriveTurnComplete, type DriveTurnOutcome } from './drive-usage-sink';
import {
  setRepoGraphTurnSession,
  clearRepoGraphTurnSession,
  setRepoGraphTurnContext,
  getRepoGraphTurnContext,
  type RepoChatContext,
} from './repo-graph/turn-context';
import {
  appendRepoGraphSection,
  summarizeRepoGraphStats,
  buildRepoGraphSubagentSection,
} from './prompt-builder-repo-graph';
import {
  registerChatCapabilityTurn,
  clearChatCapabilityTurn,
  setActiveChatTurn,
  clearActiveChatTurn,
  CHAT_TURN_CONTEXT_TTL_SETTING_KEY,
  getActiveChatTurnBinding,
  getChatCapabilityTurn,
  computeEffectiveCapabilitiesForTurn,
  DEFAULT_CHAT_TURN_CONTEXT_TTL_MS,
  type ChatCapabilityName,
} from './chat-capability-context';
import type { InternalCapabilityCoordinator } from './chat-capability-lease';
import { CHAT_CAPABILITIES_DEFAULT_OFF } from '../../src/types';
const privilegedAccessGate = {
  isBound: false as const,
  captureGenerationIfBound: (): number | null => null,
  assertAllowed: (_generation?: number): void => {},
  isGenerationCurrent: (_generation: number): boolean => true,
};
class PrivilegedAccessDeniedError extends Error {
  constructor() {
    super('privileged access gate ausente na edicao comunidade');
    this.name = 'PrivilegedAccessDeniedError';
  }
}
const tryBeginBackgroundWorkStart =
  (_lane: string): (() => void) | null =>
  () => {};
class UpdateMaintenanceBarrierClosedError extends Error {
  constructor() {
    super('barreira de manutencao de update ausente na edicao comunidade');
    this.name = 'UpdateMaintenanceBarrierClosedError';
  }
}

const logger = createLogger('orchestrator');

let telegramLanePendingJobs = 0;
let cronLanePendingJobs = 0;

let telegramQueueChain: Promise<void> = Promise.resolve();
let cronQueueChain: Promise<void> = Promise.resolve();
const STALE_QUEUE_GRACE_MS = 30_000;

const driveTurnSemaphore = new DriveTurnSemaphore(() => readDriveParallelTurns(getSetting));

export function getDriveTurnSemaphoreForTests(): DriveTurnSemaphore {
  return driveTurnSemaphore;
}

function isLaneRuntimeQueryActive(lane: SdkLane): boolean {
  return (
    lane.currentAbortController !== null ||
    isClaudeCompatQueryActive(lane) ||
    isCodexSdkQueryActive(lane) ||
    isKimiSdkQueryActive(lane) ||
    isGrokSdkQueryActive(lane) ||
    isCursorSdkQueryActive(lane) ||
    isLionSdkQueryActive(lane)
  );
}

function hasActiveDesktopRuntimeQuery(): boolean {
  return listDesktopLanes().some(isLaneRuntimeQueryActive);
}

function abandonDesktopQueueProcessor(lane: DesktopLane, reason: string): void {
  lane.processorId++;
  lane.queue.isProcessing = false;
  logger.warn({ reason, sessionId: lane.sessionId }, 'Desktop message queue processor abandoned');
}

function signalDiscardedDriveTurns(drained: QueuedMessage[]): number {
  let signaled = 0;
  for (const item of drained) {
    releaseSwarmTurn(item.options, 'Fila cancelada');
    if (item.options?.origin === 'system-event' && item.options?.driveProjectId) {
      reportDriveTurnComplete(item.options.driveProjectId, item.options.driveTurnId, 'discarded');
      signaled++;
    }
  }
  return signaled;
}

function drainDesktopQueueSignalingDriveTurns(lane: DesktopLane, reason: string): void {
  const drained = lane.queue.drain();
  const signaled = signalDiscardedDriveTurns(drained);
  if (signaled > 0) {
    logger.info(
      { reason, sessionId: lane.sessionId, drained: drained.length, signaled },
      'fila da lane esvaziada: fim de turno emitido para os turnos de drive descartados',
    );
  }
}

function stopLaneRuntimes(lane: SdkLane): void {
  if (lane.currentAbortController) {
    lane.currentAbortController.abort();
    lane.currentAbortController = null;
  }
  stopClaudeCompatQuery(lane);
  stopCodexSdkQuery(lane);
  stopKimiSdkQuery(lane);
  stopGrokSdkQuery(lane);
  stopCursorSdkQuery(lane);
  stopLionSdkQuery(lane);
}

export function resetSdkSessionState(): void {
  for (const lane of listDesktopLanes()) {
    lane.sdkActiveSessionId = null;
    resetClaudeCompatSdkSessionState(lane);
    resetCodexSdkSessionState(lane);
    resetKimiSdkSessionState(lane);
    resetGrokSdkSessionState(lane);
    resetCursorSdkSessionState(lane);
    resetLionSdkSessionState(lane);
    drainDesktopQueueSignalingDriveTurns(lane, 'reset-sdk-session-state');
    if (lane.queue.isProcessing) {
      abandonDesktopQueueProcessor(lane, 'reset-sdk-session-state');
    }
  }
}

export function submitMessage(message: string, options: QueryOptions, getWindow: () => BrowserWindow | null): boolean {
  const sessionId = options.sessionId;
  if (!sessionId) {
    logger.error({ origin: options.origin ?? 'user' }, 'submitMessage sem options.sessionId (session_required)');
    throw new SessionRequiredError('desktop', 'submitMessage');
  }
  if (isSessionClearing(sessionId)) {
    logger.warn(
      { sessionId, origin: options.origin ?? 'user' },
      'submitMessage recusado: sessao em Clear (session_clearing)',
    );
    if (options.origin === 'system-event' && options.driveProjectId) {
      reportDriveTurnComplete(options.driveProjectId, options.driveTurnId, 'discarded');
    }
    return false;
  }
  const releaseUpdateLease = tryBeginBackgroundWorkStart('chat-turn');
  if (releaseUpdateLease === null) {
    logger.warn('submitMessage recusado: manutencao de update em andamento (D14)');
    return false;
  }
  const lane = getDesktopLane(sessionId);
  try {
    const authorizationGeneration = privilegedAccessGate.captureGenerationIfBound();
    lane.queue.enqueue({
      message,
      options: {
        ...options,
        ...(authorizationGeneration === null ? {} : { authorizationGeneration }),
      },
      enqueuedAt: Date.now(),
    });
  } finally {
    releaseUpdateLease();
  }

  if (!lane.queue.isProcessing) {
    processQueue(lane, getWindow);
    return true;
  }

  if (lane.queue.processingDurationMs > STALE_QUEUE_GRACE_MS && !isLaneRuntimeQueryActive(lane)) {
    logger.warn(
      {
        sessionId,
        queueLength: lane.queue.length,
        processingDurationMs: lane.queue.processingDurationMs,
      },
      'Recovering stale desktop message queue processor',
    );
    abandonDesktopQueueProcessor(lane, 'stale-without-active-runtime');
    processQueue(lane, getWindow);
  }
  return true;
}

export function shouldDiscardStaleDriveTurn(options: QueryOptions, laneSessionId: string): boolean {
  if (options.origin !== 'system-event' || !options.driveProjectId) return false;
  if (typeof options.drivePhase !== 'number') return false;
  try {
    const project = getHarnessProject(options.driveProjectId);
    const realPhase = project?.pipelineCurrentPhase;

    if (options.drivePhase >= 1) {
      const drive = project?.config?.drive;
      if (typeof options.driveEpoch === 'string' && drive?.startedAt && drive.startedAt !== options.driveEpoch) {
        logger.warn(
          { driveProjectId: options.driveProjectId, drivePhase: options.drivePhase },
          '(Passo 1) turno de drive de EPOCA MORTA descartado no dequeue (drive foi religado depois do enqueue)',
        );
        return true;
      }
      if (drive && drive.driver === 'orchestrator' && drive.status === 'stopped') {
        logger.warn(
          { driveProjectId: options.driveProjectId, drivePhase: options.drivePhase },
          '(Passo 1) turno de drive descartado no dequeue: o drive deste projeto ja foi encerrado',
        );
        return true;
      }
    }

    if (project && !isDynamicWorkflowDriveSessionId(laneSessionId) && isDriveEngaged(options.driveProjectId)) {
      const driveLane = getDriveSessionId(options.driveProjectId);
      if (driveLane !== laneSessionId) {
        logger.warn(
          { driveProjectId: options.driveProjectId, laneSessionId, driveLane },
          '(5.3) turno de drive descartado no dequeue: a lane da fila nao e a lane que dirige o projeto',
        );
        return true;
      }
    }

    if (typeof realPhase !== 'number') return false;
    if (options.drivePhase < realPhase) {
      logger.warn(
        { driveProjectId: options.driveProjectId, drivePhase: options.drivePhase, realPhase },
        '(F7) turno de drive DEFASADO descartado no dequeue (fase real ja avancou)',
      );
      return true;
    }
    return false;
  } catch (err) {
    logger.warn(
      {
        driveProjectId: options.driveProjectId,
        error: err instanceof Error ? err.message : String(err),
      },
      '(F7) guard de dequeue falhou ao ler o projeto; fail-open (turno passa)',
    );
    return false;
  }
}

async function admitDriveTurn(lane: DesktopLane): Promise<(() => void) | null> {
  const admission = new AbortController();
  lane.currentAbortController = admission;
  try {
    const release = await driveTurnSemaphore.acquire(admission.signal);
    return release;
  } catch (err) {
    if (err instanceof DriveTurnAdmissionAbortedError) return null;
    throw err;
  } finally {
    if (lane.currentAbortController === admission) lane.currentAbortController = null;
  }
}

async function processQueue(lane: DesktopLane, getWindow: () => BrowserWindow | null): Promise<void> {
  if (lane.queue.isProcessing) return;
  const processorId = ++lane.processorId;
  lane.queue.isProcessing = true;

  try {
    while (lane.processorId === processorId && lane.queue.length > 0) {
      const item = lane.queue.dequeue()!;
      const sessionId = item.options.sessionId ?? lane.sessionId;
      try {
        if (item.options.authorizationGeneration !== undefined) {
          privilegedAccessGate.assertAllowed(item.options.authorizationGeneration);
        }
      } catch (error) {
        if (!(error instanceof PrivilegedAccessDeniedError)) throw error;
        releaseSwarmTurn(item.options, 'Autorização expirada');
        logger.warn('Queued message discarded because its authorization lease is no longer valid');
        if (item.options.origin === 'system-event' && item.options.driveProjectId) {
          reportDriveTurnComplete(item.options.driveProjectId, item.options.driveTurnId, 'discarded');
        }
        continue;
      }
      if (!canBeginSwarmTurn(item.options)) continue;
      if (shouldDiscardStaleDriveTurn(item.options, sessionId)) {
        if (item.options?.origin === 'system-event' && item.options?.driveProjectId) {
          reportDriveTurnComplete(item.options.driveProjectId, item.options.driveTurnId, 'discarded');
        }
        continue;
      }
      logger.info(
        { sessionId, queueLength: lane.queue.length, message: item.message.substring(0, 80) },
        'Processing queued message',
      );
      let driveTurnOutcome: DriveTurnOutcome = 'failed-before-execution';
      let releaseDriveSlot: (() => void) | null = null;
      markDesktopSessionInFlight(sessionId, true);
      notifyLaneSessionUpdated(sessionId);
      try {
        if (item.options.origin === 'system-event' && isDynamicWorkflowDriveSessionId(sessionId)) {
          releaseDriveSlot = await admitDriveTurn(lane);
          if (releaseDriveSlot === null) {
            driveTurnOutcome = 'discarded';
            logger.warn(
              { sessionId, driveProjectId: item.options.driveProjectId },
              'turno de drive descartado enquanto aguardava vaga (stop da lane)',
            );
            continue;
          }
        }
        const turn = executeQuery(item.message, { ...item.options, sessionId }, getWindow, lane);
        setInFlightDesktopTurn(sessionId, turn);
        await turn;
        driveTurnOutcome = 'executed';
      } catch (err) {
        if (err instanceof InvalidOrchestratorSelectionError) {
          smokeAudit('orchestrator_error', {
            lane: 'desktop',
            code: err.code,
            missingField: err.missingField ?? null,
          });
          logger.error(
            { code: err.code, missingField: err.missingField, sessionId },
            'Orchestrator selection failed (desktop lane); turno pulado, fila segue',
          );
          sendStream(
            getWindow,
            item.options?.silent,
            {
              type: 'error',
              code: err.code,
              error: err.message,
              sessionId,
            },
            item.options.authorizationGeneration,
          );
        } else if (err instanceof PrivilegedAccessDeniedError) {
          logger.warn('Turno descartado porque a autorizacao expirou durante a execucao');
        } else {
          throw err;
        }
      } finally {
        releaseSwarmTurn(item.options, 'Turno encerrado sem resposta final');
        if (releaseDriveSlot) releaseDriveSlot();
        markDesktopSessionInFlight(sessionId, false);
        clearInFlightDesktopTurn(sessionId);
        notifyLaneSessionUpdated(sessionId);
        if (item.options?.origin === 'system-event' && item.options?.driveProjectId) {
          reportDriveTurnComplete(item.options.driveProjectId, item.options.driveTurnId, driveTurnOutcome);
        }
      }
    }
  } finally {
    if (lane.processorId === processorId) {
      lane.queue.isProcessing = false;
    }
  }
}

export { getInFlightDesktopSessions };

export function getDesktopSessionExecutionState(sessionId: string): 'streaming' | 'queued' | 'idle' {
  if (isDesktopSessionInFlight(sessionId)) return 'streaming';
  const lane = peekDesktopLane(sessionId);
  if (lane && lane.queue.some((item) => item.options.sessionId === sessionId)) return 'queued';
  return 'idle';
}

export async function buildAgentDefinitions(
  repoChatContext?: RepoChatContext,
  dispatchContext?: SubagentDispatchContext,
): Promise<Record<string, AgentDefinitionCompat>> {
  const agents = getAllAgents().filter((a: AgentConfig) => a.isActive && a.runtime === 'cloud' && a.squad !== 'swarm');
  const definitions: Record<string, AgentDefinitionCompat> = {};

  const repoGraphSpec = repoChatContext ? buildRepoGraphMcpSpec() : null;
  const repoGraphSection = repoChatContext ? buildRepoGraphSubagentSection(repoChatContext) : null;

  for (const agent of agents) {
    const resolved = dispatchContext
      ? await resolveSubagentConfigWithinCeiling(agent.id, dispatchContext)
      : { config: await resolveAgentQueryConfig(agent.id) };
    if (!resolved.config) continue;
    let config = resolved.config;

    let tools: string[] | undefined = config.allowedTools.length > 0 ? config.allowedTools : undefined;
    let prompt: string | undefined = config.systemPrompt || undefined;
    let mcpServers: McpServerEntry[] = config.mcpServers.length > 0 ? config.mcpServers : [];

    if (repoChatContext && repoGraphSection) {
      if (tools) tools = mergeRepoGraphAllowlist(tools);
      prompt = prompt ? `${prompt}\n\n${repoGraphSection}` : repoGraphSection;
      if (repoGraphSpec && !mcpServers.some((spec) => REPO_GRAPH_MCP_SERVER_ID in spec)) {
        mcpServers = [...mcpServers, repoGraphSpec];
      }
    }

    if (dispatchContext) {
      const restricted = applySubagentCapabilityCeiling(
        {
          ...config,
          allowedTools: tools ?? [],
          systemPrompt: prompt ?? '',
          mcpServers,
        },
        dispatchContext,
      );
      if (!restricted.config) continue;
      config = restricted.config;
      tools = config.allowedTools;
      prompt = config.systemPrompt || undefined;
      mcpServers = config.mcpServers;
    }

    definitions[agent.id] = {
      description: agent.description,
      tools: tools ? toSdkToolNames(tools) : undefined,
      prompt,
      model: agent.model !== 'default' ? agent.model : undefined,
      maxTurns: config.maxTurns || undefined,
      mcpServers,
    };
  }

  return definitions;
}

export interface QueryOptions {
  swarmDelivery?: { runId: string; terminalRevision: number; claimId: string };
  sessionId?: string;
  agentId?: string;
  model?: string;
  effort?: string;
  silent?: boolean;
  displayMessage?: string;
  _forceNewSession?: boolean;
  answeredUserMessageId?: number;
  origin?: 'user' | 'system-event';
  skipUserMessagePersistence?: boolean;
  driveProjectId?: string;
  drivePhase?: number;
  driveTurnId?: string;
  driveEpoch?: string;
  internalLeaseToken?: string;
  leaseCoordinator?: InternalCapabilityCoordinator;
  leaseCapability?: ChatCapabilityName;
  featureToggles?: ChatFeatureToggles;
  authorizationGeneration?: number;
  attachments?: Array<{
    id: string;
    type: string;
    filename: string;
    mimeType: string;
    data: string;
    size: number;
    preview?: string;
  }>;
  skipVisionTranscription?: boolean;
  attachmentsMeta?: ChatAttachmentMeta[];
  onStreamChunk?: (chunk: StreamChunk) => void;
}

const SDK_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type SdkImageMediaType = (typeof SDK_IMAGE_MEDIA_TYPES)[number];

export function buildSdkPrompt(
  finalMessage: string,
  attachments: QueryOptions['attachments'],
  sdkThreadId: string,
): string | AsyncIterable<SDKUserMessage> {
  const images = (attachments ?? []).filter((att) => att.type === 'image');
  if (images.length === 0) return finalMessage;

  type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: SdkImageMediaType; data: string } };

  const content: ContentBlock[] = [
    {
      type: 'text',
      text: finalMessage || 'O usuario enviou estas imagens. Analise cada uma e responda sobre elas.',
    },
  ];
  for (const att of images) {
    const mediaType: SdkImageMediaType = (SDK_IMAGE_MEDIA_TYPES as readonly string[]).includes(att.mimeType)
      ? (att.mimeType as SdkImageMediaType)
      : 'image/png';
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: att.data },
    });
  }

  return (async function* () {
    yield {
      type: 'user' as const,
      session_id: sdkThreadId,
      parent_tool_use_id: null,
      message: { role: 'user' as const, content },
    };
  })();
}

export interface DesktopVisionTurnResult {
  message: string;
  options: QueryOptions;
  notice: string | null;
}

export async function resolveDesktopVisionTurn(
  message: string,
  options: QueryOptions,
  runtime: OrchestratorRuntime,
  laneName: string,
): Promise<DesktopVisionTurnResult> {
  const imageAttachments = (options.attachments ?? []).filter((att) => att.type === 'image');
  const supportsNativeImage = runtimeSupportsImageInput(runtime);

  let outMessage = message;
  let outOptions = options;
  let notice: string | null = null;

  if (imageAttachments.length > 0 && !options.skipVisionTranscription) {
    let visionUsed = false;
    try {
      const parts: string[] = [];
      for (const att of imageAttachments) {
        const transcription = await describeImage({
          data: att.data,
          mimeType: att.mimeType,
          hint: message,
        });
        if (transcription.trim()) parts.push(transcription.trim());
      }
      const joined = parts.join('\n\n');
      if (joined) {
        outMessage = buildTranscriptionBlock(message, joined);
        outOptions = {
          ...outOptions,
          displayMessage: buildTranscriptionBlock(options.displayMessage ?? '', joined),
        };
        visionUsed = true;
      }
    } catch (err) {
      notice = visionUnavailableNotice(err);
    }

    smokeAudit('attachment_capability', {
      lane: laneName,
      runtime,
      supported: supportsNativeImage,
      noticeSent: !visionUsed,
      visionUsed,
    });
  }

  if (imageAttachments.length > 0 && !supportsNativeImage) {
    outOptions = {
      ...outOptions,
      attachments: (outOptions.attachments ?? []).filter((att) => att.type !== 'image'),
    };
  }

  return { message: outMessage, options: outOptions, notice };
}

function resolveClaudeSelectionEffort(effort: string | undefined): 'low' | 'medium' | 'high' | 'max' {
  return effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max' ? effort : 'high';
}

function buildTurnTimestampPreamble(now: Date = new Date()): string {
  const data = now.toLocaleDateString('pt-BR', {
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const hora = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `[Contexto: ${data} ${hora}]`;
}

export async function executeQuery(
  message: string,
  options: QueryOptions,
  getWindow: () => BrowserWindow | null,
  laneArg?: SdkLane,
): Promise<void> {
  const lane = laneArg ?? resolveLaneForOptions(options, 'executeQuery');
  if (privilegedAccessGate.isBound) {
    const generation = options.authorizationGeneration ?? privilegedAccessGate.captureGenerationIfBound();
    if (generation === null) throw new PrivilegedAccessDeniedError();
    privilegedAccessGate.assertAllowed(generation);
    options = { ...options, authorizationGeneration: generation };
  }
  const turnSessionId = options.sessionId;
  if (!turnSessionId) {
    logger.error(
      { lane: lane.name, origin: options.origin ?? 'user' },
      'executeQuery sem options.sessionId (session_required)',
    );
    throw new SessionRequiredError(lane.name, 'executeQuery');
  }
  if (options.agentId && getAgent(options.agentId)?.squad === 'swarm') {
    sendStream(
      getWindow,
      options.silent,
      {
        type: 'error',
        code: 'SWARM-RUNNER-REQUIRED',
        error: 'Membros Swarm executam somente pelo runner swarm_start.',
      },
      options.authorizationGeneration,
    );
    return;
  }
  const selection = await resolveOrchestratorSelection({
    surface: 'main-chat',
    lane,
    sessionId: options.sessionId,
    requestedModel: options.model,
    requestedEffort: options.effort,
    agentModel: options.agentId ? getAgent(options.agentId)?.model : undefined,
  });

  if (options.swarmDelivery && (selection.runtime === 'grok-sdk' || selection.runtime === 'cursor-sdk')) {
    releaseSwarmTurn(options, `SWARM-AGGREGATOR-UNSUPPORTED:${selection.runtime}`);
    sendStream(
      getWindow,
      options.silent,
      {
        type: 'error',
        code: 'SWARM-AGGREGATOR-UNSUPPORTED',
        error: 'A agregação Swarm requer runtime compatível. Relatórios preservados.',
      },
      options.authorizationGeneration,
    );
    return;
  }
  smokeAudit('turn_selection', {
    lane: lane.name,
    runtime: selection.runtime,
    provider: selection.provider,
    model: selection.model,
    source: selection.source,
    sessionId: options.sessionId ?? null,
  });

  {
    const attachmentsMeta = buildUserAttachmentsMeta(options.attachments);
    if (attachmentsMeta) options = { ...options, attachmentsMeta };
  }

  {
    const resolved = await resolveDesktopVisionTurn(message, options, selection.runtime, lane.name);
    message = resolved.message;
    options = resolved.options;
    if (resolved.notice) {
      sendStream(
        getWindow,
        options.silent,
        {
          type: 'text',
          content: resolved.notice,
          sessionId: turnSessionId,
        },
        options.authorizationGeneration,
      );
      logger.warn(
        { runtime: selection.runtime, lane: lane.name },
        'Vision indisponivel no desktop; turno segue so com texto (P5)',
      );
    }
  }

  if (!runtimeSupportsEffort(selection.runtime)) {
    const configuredEffort = (selection.effort ?? '').trim();
    if (configuredEffort) {
      logger.debug(
        { runtime: selection.runtime, effort: configuredEffort },
        'Effort ignorado: runtime configurado nao suporta o controle (3.6)',
      );
    }
  }

  const repoTurnSessionId = turnSessionId;
  const capabilityLane = lane.kind;
  const capabilityTurnId = crypto.randomUUID();
  const chatTurnFlags = createChatTurnStreamFlags();
  let chatTurnSessionId: string = repoTurnSessionId;
  {
    const callerOnStreamChunk = options.onStreamChunk;
    options = {
      ...options,
      onStreamChunk: (chunk: StreamChunk) => {
        trackChatTurnChunk(chatTurnFlags, chunk.type);
        if (chunk.type === 'session' && typeof chunk.content === 'string') {
          chatTurnSessionId = chunk.content;
        }
        callerOnStreamChunk?.(chunk);
      },
    };
  }
  try {
    if (repoTurnSessionId) {
      setRepoGraphTurnSession(repoTurnSessionId, selection.runtime);
      await prepareRepoGraphTurn(repoTurnSessionId);
    }
    if (repoTurnSessionId && capabilityLane) {
      let capabilityTurnTtlMs: number = DEFAULT_CHAT_TURN_CONTEXT_TTL_MS;
      try {
        capabilityTurnTtlMs = Number(getSetting(CHAT_TURN_CONTEXT_TTL_SETTING_KEY));
      } catch (err) {
        logger.warn(
          { err },
          'getSetting(chat_turn_context_ttl_ms) falhou; usando TTL default do turn-context (fail-safe S6a)',
        );
      }
      const isRemoteCapabilityLane = capabilityLane === 'telegram' || capabilityLane === 'cron';
      const capabilityTurnCwd =
        capabilityLane === 'cron'
          ? getCronCwd()
          : (getRepoGraphTurnContext(repoTurnSessionId)?.canonicalRootPath ?? getAgentCwd(false));
      let capabilityTurnAllowedTools = isRemoteCapabilityLane ? [] : getEnabledTools();
      const capabilityTurnReadRoots = isRemoteCapabilityLane ? [] : [capabilityTurnCwd];
      const capabilityTurnWriteRoots = isRemoteCapabilityLane
        ? []
        : getSetting('onboarding_completed') === 'true'
          ? [capabilityTurnCwd]
          : [];
      let capabilityTurnServerIds: string[] = [];
      if (!isRemoteCapabilityLane) {
        try {
          capabilityTurnServerIds = Object.keys(
            (await getMCPConfigForAgent(options.agentId, {
              surface: selection.runtime,
              fullCatalog: true,
              capabilities: options.featureToggles ?? CHAT_CAPABILITIES_DEFAULT_OFF,
            })) ?? {},
          );
          capabilityTurnAllowedTools = await resolveSubagentHostAllowedTools(
            capabilityTurnAllowedTools,
            capabilityTurnServerIds,
          );
        } catch (err) {
          logger.warn({ err }, 'composicao do escopo MCP do turno falhou; allowedServerIds vazio (fail-safe Fase B)');
        }
      }
      const capabilityPermissionGuard = createPermissionGuard(getWindow, {
        isOnboarding: getSetting('onboarding_completed') !== 'true',
        ...(repoTurnSessionId ? { sessionId: repoTurnSessionId } : {}),
      });
      registerChatCapabilityTurn(
        {
          surface: 'chat',
          sessionId: repoTurnSessionId,
          turnId: capabilityTurnId,
          origin: options.origin ?? 'user',
          capabilities: options.featureToggles ?? CHAT_CAPABILITIES_DEFAULT_OFF,
          orchestrator: {
            runtime: selection.runtime,
            ...(selection.effort ? { effort: selection.effort } : {}),
          },
          cwd: capabilityTurnCwd,
          permissionProfile: PERM_DEFAULT_WITH_GUARD(capabilityPermissionGuard),
          allowedTools: capabilityTurnAllowedTools,
          allowedServerIds: capabilityTurnServerIds,
          readRoots: capabilityTurnReadRoots,
          writeRoots: capabilityTurnWriteRoots,
          ...(options.origin === 'system-event'
            ? {
                internalLeaseToken: options.internalLeaseToken,
                driveProjectId: options.driveProjectId,
                driveTurnId: options.driveTurnId,
                leaseCoordinator: options.leaseCoordinator,
                leaseCapability: options.leaseCapability,
              }
            : {}),
        },
        capabilityTurnTtlMs,
      );
      setActiveChatTurn({
        sessionId: repoTurnSessionId,
        lane: capabilityLane,
        turnId: capabilityTurnId,
      });
    }
    if (options.displayMessage === undefined) {
      options = { ...options, displayMessage: message };
    }
    message = `${buildTurnTimestampPreamble()}\n\n${message}`;

    switch (selection.runtime) {
      case 'claude-sdk':
        return await executeClaudeSdkQuery(message, options, getWindow, lane, selection);
      case 'claude-compat-sdk':
        return await executeClaudeCompatSdkQuery(message, options, getWindow, lane, selection);
      case 'codex-sdk':
        return await executeCodexSdkQuery(message, options, getWindow, lane, selection);
      case 'kimi-sdk':
        return await executeKimiSdkQuery(message, options, getWindow, lane, selection);
      case 'grok-sdk':
        return await executeGrokSdkQuery(message, options, getWindow, lane, selection);
      case 'cursor-sdk':
        return await executeCursorSdkQuery(message, options, getWindow, lane, selection);
      case 'lion-sdk':
        return await executeLionSdkQuery(message, options, getWindow, lane, selection);
    }
  } finally {
    if (repoTurnSessionId) clearRepoGraphTurnSession(repoTurnSessionId);
    if (repoTurnSessionId && capabilityLane) {
      clearChatCapabilityTurn({ sessionId: repoTurnSessionId, turnId: capabilityTurnId });
      clearActiveChatTurn({
        sessionId: repoTurnSessionId,
        lane: capabilityLane,
        turnId: capabilityTurnId,
      });
    }
    if (
      shouldEmitChatTurnFallbackError(chatTurnFlags, {
        isDesktopLane: lane.kind === 'desktop',
        silent: options.silent === true,
      })
    ) {
      const fallback = chatTurnFallbackError(`lane=${lane.name} runtime=${selection.runtime}`);
      logger.warn(
        { sessionId: chatTurnSessionId, lane: lane.name, runtime: selection.runtime },
        'turno terminou sem chunk de erro, sem conteudo e sem done — emitindo LLM-EMPTY de fallback (AC-B26)',
      );
      sendStream(
        getWindow,
        options.silent,
        {
          type: 'error',
          code: fallback.code,
          error: fallback.userMessage,
          sessionId: chatTurnSessionId,
        },
        options.authorizationGeneration,
      );
    }
  }
}

async function prepareRepoGraphTurn(sessionId: string): Promise<void> {
  try {
    if (getSetting('onboarding_completed') !== 'true') return;
    const { getRepoGraphEngine } = await import('./ipc/repo-graph');
    const state = getRepoGraphEngine().getSessionState(sessionId);
    const repo = state.repository;
    if (!repo) return;
    if (repo.status !== 'ready' && repo.status !== 'stale') return;
    setRepoGraphTurnContext(sessionId, {
      repositoryId: repo.id,
      canonicalRootPath: repo.canonicalRootPath,
      status: repo.status,
      statsResumo: summarizeRepoGraphStats(repo.statsJson),
    });
  } catch (err) {
    logger.warn({ err, sessionId }, 'prepareRepoGraphTurn falhou (turno segue sem repo-graph)');
  }
}

export async function executeClaudeSdkQuery(
  message: string,
  options: QueryOptions,
  getWindow: () => BrowserWindow | null,
  laneArg?: SdkLane,
  selection?: OrchestratorSelection,
): Promise<void> {
  const lane = laneArg ?? resolveLaneForOptions(options, 'executeClaudeSdkQuery');
  const apiKey = await getApiKey();
  if (!apiKey) {
    const missingKeyChunk: StreamChunk = {
      type: 'error',
      error: 'API key nao configurada. Va em Settings.',
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    };
    options.onStreamChunk?.(missingKeyChunk);
    sendStream(getWindow, options.silent, missingKeyChunk, options.authorizationGeneration);
    return;
  }

  const sessionId = options.sessionId;
  let shouldContinueSession = false;

  if (!sessionId) {
    logger.error({ lane: lane.name }, 'executeQuery sem options.sessionId (session_required)');
    throw new SessionRequiredError(lane.name, 'executeQuery');
  } else {
    const existingMessages = getSessionMessages(sessionId);
    shouldContinueSession = existingMessages.length > 0;
    if (options._forceNewSession) {
      shouldContinueSession = false;
      logger.info({ sessionId }, 'Forced fresh SDK session (retry after resume failure)');
    } else if (!shouldContinueSession) {
      logger.info({ sessionId }, 'Session has no messages, starting fresh SDK session (post-compaction)');
    }
  }

  const sessionRow = getSession(sessionId);
  const sdkThreadId = threadIdOf({ id: sessionId, sdkSessionId: sessionRow?.sdkSessionId });

  const pendingSeed = sessionRow?.pendingSeed ?? null;
  if (pendingSeed) {
    shouldContinueSession = false;
    logger.info(
      { sessionId, sdkThreadId },
      'pending_seed presente: thread SDK nova com seed de compactacao (SPEC 4.3)',
    );
  }

  options.onStreamChunk?.({ type: 'session', content: sessionId, sessionId });
  sendStream(
    getWindow,
    options.silent,
    { type: 'session', content: sessionId, sessionId },
    options.authorizationGeneration,
  );

  let resolveEngineExit: () => void = () => {};
  const engineExited = new Promise<void>((resolve) => {
    resolveEngineExit = resolve;
  });
  if (lane.kind === 'desktop') {
    registerExternalStopWaiter(sessionId, 'claude-sdk', () => engineExited);
  }

  const turnStreamFlags = createChatTurnStreamFlags();
  const sendSessionStream = (chunk: StreamChunk) => {
    trackChatTurnChunk(turnStreamFlags, chunk.type);
    options.onStreamChunk?.({ ...chunk, sessionId });
    sendStream(getWindow, options.silent, { ...chunk, sessionId }, options.authorizationGeneration);
  };

  let currentTurnIndex = 0;
  let currentUserMessageId = options.answeredUserMessageId;

  const emitActivity = (a: LiveActivityEvent) => recordActivity(sessionId, currentTurnIndex, a, sendSessionStream);

  const skipUserPersistence = options.origin === 'system-event' || options.skipUserMessagePersistence === true;

  if (skipUserPersistence) {
    currentTurnIndex = getLatestUserTurnIndex(sessionId);
  } else if (!options._forceNewSession) {
    const visibleUserMessage = options.displayMessage ?? message;
    const userMessageId = persistUserChatMessage(sessionId, visibleUserMessage, options.attachmentsMeta);
    currentUserMessageId = userMessageId;
    currentTurnIndex = getTurnIndexForUserMessage(sessionId, userMessageId);
    ensureInitialSessionTitle(sessionId, visibleUserMessage);
  } else {
    currentTurnIndex = getLatestUserTurnIndex(sessionId);
  }

  const agent = options.agentId ? getAllAgents().find((a) => a.id === options.agentId) : undefined;
  const selectedModel = selection?.model ?? options.model;
  const model = selectedModel ?? 'unknown';

  const orchestratorEffort = resolveClaudeSelectionEffort(selection?.effort);

  logger.info(
    {
      model,
      source: selection?.source ?? 'unknown',
      agentModel: agent?.model ?? null,
      orchestratorModel: selection?.model ?? null,
      lane: lane.name,
    },
    'Claude SDK model resolved',
  );

  if (options.agentId) {
    setActiveAgentId(options.agentId);
  }

  const isOnboarding = getSetting('onboarding_completed') !== 'true';
  const activeTurnBinding = getActiveChatTurnBinding({ sessionId, lane: lane.kind });
  const chatCaps =
    lane.kind === 'desktop'
      ? (() => {
          const ctx = activeTurnBinding ? getChatCapabilityTurn(activeTurnBinding) : undefined;
          return ctx ? computeEffectiveCapabilitiesForTurn(ctx) : undefined;
        })()
      : undefined;
  const fullSystemPrompt = appendRepoGraphSection(
    buildSystemPrompt(options.agentId, {
      mode: 'full',
      isOnboarding,
      model,
      capabilities: chatCaps,
    }),
    sessionId,
  );

  const permissionGuard = createPermissionGuard(getWindow, { isOnboarding, sessionId });
  lane.currentAbortController = new AbortController();

  let finalMessage = message;

  if (pendingSeed) {
    finalMessage = `${pendingSeed}\n\n${finalMessage}`;
  }

  if (isOnboarding) {
    logger.info({ promptLength: fullSystemPrompt.length, hasTools: false }, 'Onboarding: text-only prompt, no tools');
  }

  let mcpServers: Record<string, McpServerConfig> | undefined = await getMCPConfigForAgent(options.agentId, {
    surface: 'claude-sdk',
    capabilities: chatCaps,
    lane: lane.kind,
    ...(activeTurnBinding ? { turn: activeTurnBinding } : {}),
  });

  const allAgents = getAllAgents();
  const hasLocalAgent = allAgents.some((a: AgentConfig) => a.isActive && a.runtime === 'local');
  const hasExternalAgent = allAgents.some((a: AgentConfig) => a.isActive && a.runtime === 'external');

  if (hasLocalAgent || hasExternalAgent) {
    const resolvedRuntime = resolveMcpServerRuntime('local-agents', 'dist/index.js', { cwd: process.cwd() });
    const resolvedPath = resolvedRuntime.entryPath ?? resolvedRuntime.candidates[0];
    if (!resolvedRuntime.command) {
      throw new Error('Runtime Node do MCP local-agents não foi resolvido');
    }

    const lionclawHome = getLionClawHome();

    const envVars: Record<string, string> = { LIONCLAW_HOME: lionclawHome };
    if (hasExternalAgent) {
      const externalAgents = allAgents.filter(
        (a: AgentConfig) => a.isActive && a.runtime === 'external' && a.externalConfig,
      );
      const keyRefs = new Set<string>();
      for (const agent of externalAgents) {
        const ref = agent.externalConfig?.apiKeyRef;
        if (ref) keyRefs.add(ref);
      }
      for (const ref of keyRefs) {
        const value = await getSecret(ref);
        if (value) envVars[ref] = value;
      }
    }

    if (mcpServers) {
      if (!mcpServers['local-agents']) {
        mcpServers['local-agents'] = {
          command: resolvedRuntime.command,
          args: [resolvedPath],
          env: { ...resolvedRuntime.env, ...envVars },
        };
      }
    } else {
      mcpServers = {
        'local-agents': {
          command: resolvedRuntime.command,
          args: [resolvedPath],
          env: { ...resolvedRuntime.env, ...envVars },
        },
      };
    }
  }

  const hasCodexAgent = allAgents.some((a: AgentConfig) => a.isActive && a.runtime === 'codex');
  const repoChatContext = lane.kind === 'desktop' ? (getRepoGraphTurnContext(sessionId) ?? undefined) : undefined;
  const subagentCwd =
    lane === cronLane ? getCronCwd() : (repoChatContext?.canonicalRootPath ?? getAgentCwd(isOnboarding));
  const subagentAbortController = lane.currentAbortController;
  if (!subagentAbortController) throw new Error('Turno sem AbortController para subagentes.');
  const subagentDispatchContext = createSubagentDispatchContext({
    ownerKind: 'chat',
    ownerId: sessionId,
    sessionId,
    lane: lane.kind,
    surface: 'claude-sdk',
    cwd: subagentCwd,
    readRoots: [subagentCwd],
    writeRoots: isOnboarding ? [] : [subagentCwd],
    allowedTools: await resolveSubagentHostAllowedTools(getEnabledTools(), Object.keys(mcpServers ?? {})),
    allowedMcpServerIds: Object.keys(mcpServers ?? {}),
    permission: PERM_DEFAULT_WITH_GUARD(permissionGuard),
    parentAbortSignal: subagentAbortController.signal,
    abortOwner: (reason) => subagentAbortController.abort(reason),
    inheritedEffort: resolveChatInheritedEffort(selection?.runtime, selection?.effort),
  });
  if (hasCodexAgent) {
    const codexServerConfig: McpSdkServerConfigWithInstance = await getCodexAgentsServer(subagentDispatchContext);
    if (mcpServers) {
      if (!mcpServers['codex-agents']) {
        mcpServers['codex-agents'] = codexServerConfig;
      }
    } else {
      mcpServers = { 'codex-agents': codexServerConfig };
    }
  }

  const agentDefinitions = isOnboarding ? {} : await buildAgentDefinitions(repoChatContext, subagentDispatchContext);

  let turnOk = false;
  let swarmResultSucceeded = false;
  const nativeTaskRootExecutionId = subagentDispatchContext.rootExecutionId;
  smokeAudit('turn_start', { lane: lane.name, sessionId });

  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    resetArtifactDetector();

    let assistantContent = '';
    const persistedTimelineToolCalls: PersistedTimelineToolCall[] = [];
    let inTool = false;
    let currentToolName: string | null = null;
    let currentParentToolUseId: string | null = null;
    let currentToolActivityId: string | null = null;
    let toolActivitySeq = 0;
    const toolNameById = new Map<string, string>();
    const pendingHtmlWrites = new Map<string, string>();
    const collectedArtifacts: ArtifactData[] = [];
    const captureWrittenHtmlArtifact = (toolUseId: string, isError: boolean): void => {
      const writtenHtmlPath = pendingHtmlWrites.get(toolUseId);
      if (!writtenHtmlPath) return;
      pendingHtmlWrites.delete(toolUseId);
      if (isError || lane.kind !== 'desktop') return;
      const written = htmlArtifactFromPath(writtenHtmlPath);
      if (written?.kind === 'artifact') {
        const already = collectedArtifacts.some(
          (a) => a.type === 'html' && a.data.filePath === written.artifact.data.filePath,
        );
        if (already) return;
        logger.info({ filePath: written.artifact.data.filePath }, 'HTML artifact detected from Write in artifacts dir');
        collectedArtifacts.push(written.artifact);
        sendSessionStream({ type: 'artifact', artifact: written.artifact });
      } else if (written?.kind === 'error') {
        logger.warn(
          { filePath: writtenHtmlPath, reason: written.error },
          'HTML written in artifacts dir but not accepted',
        );
      }
    };
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    let turnCacheReadTokens = 0;
    let turnCacheCreationTokens = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;
    let sidechainInputTokens = 0;
    let sidechainOutputTokens = 0;
    let sidechainCacheReadTokens = 0;
    let sidechainCacheCreationTokens = 0;
    let turnParentToolUseId: string | null = null;
    const accumulateTurnUsage = (): void => {
      if (turnParentToolUseId) {
        sidechainInputTokens += turnInputTokens;
        sidechainOutputTokens += turnOutputTokens;
        sidechainCacheReadTokens += turnCacheReadTokens;
        sidechainCacheCreationTokens += turnCacheCreationTokens;
      } else {
        totalInputTokens += turnInputTokens;
        totalOutputTokens += turnOutputTokens;
        totalCacheReadTokens += turnCacheReadTokens;
        totalCacheCreationTokens += turnCacheCreationTokens;
      }
    };
    let lastMainContextInput = -1;
    let lastMainOutput = 0;

    const subagentTokens = new Map<
      string,
      {
        agentId: string | null;
        agentName: string | null;
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        requestCount: number;
      }
    >();

    const taskMap = new Map<
      string,
      {
        taskId: string;
        description: string;
        agentId: string | null;
        executionId?: string;
      }
    >();
    let pendingAgentId: string | null = null;

    const q = query({
      prompt: buildSdkPrompt(finalMessage, options.attachments, sdkThreadId),
      options: {
        ...getClaudeSdkProcessOptions(),
        cwd: lane === cronLane ? getCronCwd() : getAgentCwd(isOnboarding),
        ...(selectedModel ? { model: selectedModel } : {}),
        effort: orchestratorEffort,
        includePartialMessages: true,
        systemPrompt: isOnboarding
          ? fullSystemPrompt
          : {
              type: 'preset',
              preset: 'claude_code' as const,
              append: fullSystemPrompt,
            },
        ...(isOnboarding
          ? {
              allowedTools: [],
              disallowedTools: [...SDK_DISALLOWED_TOOLS],
              settingSources: [],
              env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
            }
          : {
              allowedTools: toSdkToolNames(getEnabledTools().filter((t) => !GUARD_GATED_TOOLS.includes(t))),
              disallowedTools: [...SDK_DISALLOWED_TOOLS],
              permissionMode: 'default' as const,
              settingSources: ['project', 'user'],
              canUseTool: (tool: string, input: Record<string, unknown>) => permissionGuard(tool, input),
              agents: agentDefinitions as Record<string, AgentDefinition>,
              hooks: {
                SubagentStart: [
                  {
                    hooks: [
                      async (input: Record<string, unknown>) => {
                        const agentId =
                          typeof input['agent_type'] === 'string'
                            ? input['agent_type']
                            : String(input['agent_id'] ?? '');
                        const reservationContext =
                          typeof input['agent_id'] === 'string'
                            ? { ...subagentDispatchContext, depth: MAX_SUBAGENT_DEPTH }
                            : subagentDispatchContext;
                        const refusal = reserveSubagentInvocation(reservationContext, agentId);
                        if (refusal) return { continue: false, stopReason: refusal };
                        pendingAgentId = agentId;
                        return { continue: true };
                      },
                    ],
                  },
                ],
              },
            }),
        ...(lane.kind !== 'desktop' && shouldContinueSession && lane.sdkActiveSessionId === sdkThreadId
          ? { continue: true }
          : shouldContinueSession
            ? { resume: sdkThreadId }
            : { sessionId: sdkThreadId }),
        abortController: lane.currentAbortController,
        ...(!isOnboarding && mcpServers ? { mcpServers } : {}),
        ...(options.swarmDelivery ? swarmAggregationSdkOptions() : {}),
      },
    });

    if (!isOnboarding) {
      const disabledSdkMcps = getDisabledSDKMcps();

      const hasBuiltinExcalidraw = mcpServers && Object.keys(mcpServers).includes('excalidraw');
      if (hasBuiltinExcalidraw) {
        disabledSdkMcps.push('claude_ai_Excalidraw');
      }

      for (const name of disabledSdkMcps) {
        try {
          await q.toggleMcpServer(name, false);
        } catch {
          // Server may not exist anymore, ignore
        }
      }
    }

    for await (const sdkMessage of q) {
      if (sdkMessage.type === 'stream_event') {
        const event = sdkMessage.event as unknown as Record<string, unknown>;

        if (event.type === 'content_block_start') {
          const contentBlock = event.content_block as Record<string, unknown>;
          if (contentBlock.type === 'tool_use') {
            currentToolName = contentBlock.name as string;
            const toolCallId = contentBlock.id as string | undefined;
            persistedTimelineToolCalls.push({
              tool: currentToolName,
              input: {},
              toolCallId,
              sequence: persistedTimelineToolCalls.length,
              textOffset: assistantContent.length,
              status: 'running',
            });
            inTool = true;
            sendSessionStream({
              type: 'tool_call',
              tool: currentToolName,
              toolCallId,
              input: {},
            });
            if (currentToolName === 'Task') {
              currentToolActivityId = null;
            } else {
              currentToolActivityId = (contentBlock.id as string) || `tool-${++toolActivitySeq}`;
              emitActivity({
                id: currentToolActivityId,
                parentId: currentParentToolUseId ?? undefined,
                kind: 'tool',
                phase: 'start',
                label: currentToolName,
                status: 'running',
                toolName: currentToolName,
                startedAt: new Date().toISOString(),
              });
            }
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown>;
          if (delta.type === 'text_delta' && !inTool) {
            const text = delta.text as string;
            assistantContent += text;
            sendSessionStream({ type: 'text', content: text });
          }
        } else if (event.type === 'content_block_stop') {
          if (inTool && currentToolName) {
            inTool = false;
            currentToolName = null;
            currentToolActivityId = null;
          }
        } else if (event.type === 'message_start') {
          const parentToolUseId = (sdkMessage as Record<string, unknown>).parent_tool_use_id as
            string | null | undefined;
          currentParentToolUseId = parentToolUseId ?? null;

          accumulateTurnUsage();
          turnParentToolUseId = parentToolUseId ?? null;
          turnInputTokens = 0;
          turnOutputTokens = 0;
          turnCacheReadTokens = 0;
          turnCacheCreationTokens = 0;

          const msg = event.message as Record<string, unknown> | undefined;
          const usage = msg?.usage as Record<string, number> | undefined;
          if (usage) {
            const inputBase = usage.input_tokens || 0;
            const cacheRead = usage.cache_read_input_tokens || 0;
            const cacheCreation = usage.cache_creation_input_tokens || 0;
            turnInputTokens = inputBase + cacheRead + cacheCreation;
            turnCacheReadTokens = cacheRead;
            turnCacheCreationTokens = cacheCreation;

            if (!parentToolUseId) {
              lastMainContextInput = turnInputTokens;
              lastMainOutput = 0;
            }

            if (parentToolUseId) {
              const msgModel = (msg?.model as string) || model;
              logger.debug(
                { parentToolUseId, msgModel, inputBase, cacheRead, cacheCreation },
                'Subagent stream_event message_start',
              );
              const existing = subagentTokens.get(parentToolUseId);
              if (existing) {
                existing.inputTokens += turnInputTokens;
                existing.cacheReadTokens += cacheRead;
                existing.cacheCreationTokens += cacheCreation;
                existing.requestCount += 1;
                if (msgModel && !existing.model) {
                  existing.model = msgModel;
                }
              } else {
                subagentTokens.set(parentToolUseId, {
                  agentId: null,
                  agentName: null,
                  model: msgModel,
                  inputTokens: turnInputTokens,
                  outputTokens: 0,
                  cacheReadTokens: cacheRead,
                  cacheCreationTokens: cacheCreation,
                  requestCount: 1,
                });
              }
            }

            sendSessionStream({
              type: 'usage',
              usage: {
                inputTokens: totalInputTokens + sidechainInputTokens + turnInputTokens,
                outputTokens: totalOutputTokens + sidechainOutputTokens,
                cacheReadTokens: totalCacheReadTokens + sidechainCacheReadTokens + cacheRead,
                cacheCreationTokens: totalCacheCreationTokens + sidechainCacheCreationTokens + cacheCreation,
              },
            });
          }
        } else if (event.type === 'message_delta') {
          const parentToolUseId = (sdkMessage as Record<string, unknown>).parent_tool_use_id as
            string | null | undefined;
          const usage = event.usage as Record<string, number> | undefined;
          if (usage) {
            turnOutputTokens = usage.output_tokens || 0;

            if (!parentToolUseId) {
              lastMainOutput = turnOutputTokens;
            }

            if (parentToolUseId) {
              const existing = subagentTokens.get(parentToolUseId);
              if (existing) {
                existing.outputTokens += turnOutputTokens;
              }
            }

            sendSessionStream({
              type: 'usage',
              usage: {
                inputTokens: totalInputTokens + sidechainInputTokens + turnInputTokens,
                outputTokens: totalOutputTokens + sidechainOutputTokens + turnOutputTokens,
                cacheReadTokens: totalCacheReadTokens + sidechainCacheReadTokens + turnCacheReadTokens,
                cacheCreationTokens: totalCacheCreationTokens + sidechainCacheCreationTokens + turnCacheCreationTokens,
              },
            });
          }
        }
      } else if (sdkMessage.type === 'assistant') {
        const blockTypes = sdkMessage.message.content.map((b) => b.type);
        logger.info({ blockTypes }, 'Assistant message block types');

        for (const block of sdkMessage.message.content) {
          const blockAny = block as unknown as Record<string, unknown>;

          if (block.type === 'tool_use' || blockAny.type === 'mcp_tool_use') {
            const toolName = (blockAny.name as string) || '';
            const toolInput = (blockAny.input as Record<string, unknown>) || {};
            const toolId = (blockAny.id as string) || crypto.randomUUID();

            const persistedTool = persistedTimelineToolCalls.find((entry) => entry.toolCallId === toolId);
            if (persistedTool) {
              persistedTool.tool = toolName;
              persistedTool.input = JSON.stringify(toolInput);
            }

            logger.info({ blockType: blockAny.type, toolName, toolId }, 'Captured tool_use/mcp_tool_use block');

            const toolCallEntry: Omit<AuditEntry, 'id' | 'createdAt'> = {
              sessionId,
              subagent: options.agentId,
              eventType: 'tool_call',
              toolName,
              input: JSON.stringify(toolInput).substring(0, 1000),
            };
            insertAuditEntry(toolCallEntry);
            sendLogEntry(getWindow, toolCallEntry);

            if (toolName !== 'Task') {
              toolNameById.set(toolId, toolName);
              const detail = deriveToolDetail(toolName, toolInput);
              emitActivity({
                id: toolId,
                kind: 'tool',
                phase: 'update',
                label: toolName,
                toolName,
                file: detail.file,
                command: detail.command,
                description: detail.description,
              });
            }

            const htmlWritePath = artifactsDirHtmlWritePath(toolName, toolInput);
            if (htmlWritePath) pendingHtmlWrites.set(toolId, htmlWritePath);

            const artifact = captureToolUse(toolId, toolName, toolInput);
            if (artifact) {
              collectedArtifacts.push(artifact);
              sendSessionStream({ type: 'artifact', artifact });
            }
          }

          if (blockAny.type === 'mcp_tool_result' || blockAny.type === 'tool_result') {
            const resultContent =
              typeof blockAny.content === 'string'
                ? blockAny.content
                : Array.isArray(blockAny.content)
                  ? (blockAny.content as Array<{ text?: string }>).map((b) => b.text || '').join('')
                  : '';
            logger.info(
              {
                toolUseId: blockAny.tool_use_id,
                isError: blockAny.is_error,
                contentLength: resultContent.length,
                contentSnippet: resultContent.substring(0, 200),
              },
              'Captured mcp_tool_result block',
            );
            const resultToolUseId = blockAny.tool_use_id as string | undefined;
            if (resultToolUseId) {
              const resultToolName = toolNameById.get(resultToolUseId);
              const isError = blockAny.is_error === true && !isAskUserAnswersResult(resultToolName, resultContent);
              const persistedTool = persistedTimelineToolCalls.find((entry) => entry.toolCallId === resultToolUseId);
              if (persistedTool) {
                persistedTool.result = resultContent;
                persistedTool.isError = isError;
                persistedTool.status = isError ? 'error' : 'done';
              }
              sendSessionStream({
                type: 'tool_result',
                tool: resultToolName ?? 'Tool',
                toolCallId: resultToolUseId,
                result: resultContent,
                isError,
              });
              emitActivity({
                id: resultToolUseId,
                kind: 'tool',
                phase: 'update',
                label: resultToolName ?? '',
                status: isError ? 'error' : 'done',
                changed: !isError && isWriteTool(resultToolName),
                endedAt: new Date().toISOString(),
              });
              captureWrittenHtmlArtifact(resultToolUseId, isError);
            }

            const artifact = captureToolResult(
              blockAny.tool_use_id as string,
              resultContent,
              blockAny.is_error as boolean,
            );
            if (artifact) {
              logger.info(
                { artifactType: artifact.type, artifactTitle: artifact.title },
                'Artifact created, sending to renderer',
              );
              collectedArtifacts.push(artifact);
              sendSessionStream({ type: 'artifact', artifact });
            }
          }
        }
        const fullText = sdkMessage.message.content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { type: string; text?: string }) => b.text || '')
          .join('');
        if (fullText && fullText.length > assistantContent.length) {
          const missing = fullText.slice(assistantContent.length);
          if (missing) {
            sendSessionStream({ type: 'text', content: missing });
          }
          assistantContent = fullText;
        }
      } else if (sdkMessage.type === 'user') {
        const userContent = Array.isArray(sdkMessage.message.content) ? sdkMessage.message.content : [];
        for (const contentBlock of userContent) {
          const block = contentBlock as unknown as Record<string, unknown>;
          if (block.type === 'mcp_tool_result' || block.type === 'tool_result') {
            const resultContent =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? (block.content as Array<{ text?: string }>).map((b) => b.text || '').join('')
                  : '';
            logger.info(
              {
                toolUseId: block.tool_use_id,
                isError: block.is_error,
                contentLength: resultContent.length,
                contentSnippet: resultContent.substring(0, 200),
              },
              'Captured tool_result from user message',
            );
            const resultToolUseId = block.tool_use_id as string | undefined;
            if (resultToolUseId) {
              const resultToolName = toolNameById.get(resultToolUseId);
              const isError = block.is_error === true && !isAskUserAnswersResult(resultToolName, resultContent);
              const persistedTool = persistedTimelineToolCalls.find((entry) => entry.toolCallId === resultToolUseId);
              if (persistedTool) {
                persistedTool.result = resultContent;
                persistedTool.isError = isError;
                persistedTool.status = isError ? 'error' : 'done';
              }
              sendSessionStream({
                type: 'tool_result',
                tool: resultToolName ?? 'Tool',
                toolCallId: resultToolUseId,
                result: resultContent,
                isError,
              });
              emitActivity({
                id: resultToolUseId,
                kind: 'tool',
                phase: 'update',
                label: resultToolName ?? '',
                status: isError ? 'error' : 'done',
                changed: !isError && isWriteTool(resultToolName),
                endedAt: new Date().toISOString(),
              });
              captureWrittenHtmlArtifact(resultToolUseId, isError);
            }

            const artifact = captureToolResult(block.tool_use_id as string, resultContent, block.is_error as boolean);
            if (artifact) {
              const skipHtml =
                artifact.type === 'html' &&
                (lane.kind !== 'desktop' ||
                  collectedArtifacts.some((a) => a.type === 'html' && a.data.filePath === artifact.data.filePath));
              if (!skipHtml) {
                logger.info(
                  { artifactType: artifact.type, artifactTitle: artifact.title },
                  'Artifact created from user tool_result, sending to renderer',
                );
                collectedArtifacts.push(artifact);
                sendSessionStream({ type: 'artifact', artifact });
              }
            }
          }
        }
      } else if (sdkMessage.type === 'result') {
        if (options.swarmDelivery) swarmResultSucceeded = sdkMessage.subtype === 'success' && !sdkMessage.is_error;
        if (lane.kind === 'desktop' && assistantContent.includes('ARQUIVO_HTML:')) {
          const htmlDetection = detectHtmlArtifact(assistantContent);
          if (htmlDetection?.kind === 'artifact') {
            const already = collectedArtifacts.some(
              (a) => a.type === 'html' && a.data.filePath === htmlDetection.artifact.data.filePath,
            );
            if (!already) {
              logger.info(
                { filePath: htmlDetection.artifact.data.filePath },
                'HTML artifact detected from assistant text',
              );
              collectedArtifacts.push(htmlDetection.artifact);
              sendSessionStream({ type: 'artifact', artifact: htmlDetection.artifact });
            }
          } else if (htmlDetection?.kind === 'error') {
            logger.warn(
              { candidate: htmlDetection.candidate, reason: htmlDetection.error },
              'ARQUIVO_HTML marker rejected',
            );
            const notice = `\n\n> Artefato nao aberto: ${htmlDetection.error} (${htmlDetection.candidate})`;
            assistantContent += notice;
            sendSessionStream({ type: 'text', content: notice });
          }
        }
        if (assistantContent.includes('ARQUIVO_AUDIO:')) {
          const audioMatches = assistantContent.matchAll(/ARQUIVO_AUDIO:\s*(.+?)(?:\n|$)/g);
          for (const match of audioMatches) {
            const audioPath = match[1].trim();
            const artifact = captureToolResult('text-detect', `ARQUIVO_AUDIO: ${audioPath}`, false);
            if (artifact) {
              logger.info({ artifactType: artifact.type, audioPath }, 'Audio artifact detected from assistant text');
              collectedArtifacts.push(artifact);
              sendSessionStream({ type: 'artifact', artifact });
            }
          }
        }
        sendSessionStream({ type: 'done', content: sessionId });
      } else {
        const msgAny = sdkMessage as Record<string, unknown>;
        if (msgAny.type === 'system') {
          const subtype = msgAny.subtype as string;

          if (subtype === 'init') {
            logger.debug({ sessionId, tools: msgAny.tools }, 'sdk init tools');
          }

          if (subtype === 'status') {
            const status = msgAny.status as string | null;
            if (status === 'compacting') {
              sendSessionStream({ type: 'compacting', isCompacting: true });
              logger.info({ sessionId }, 'SDK compaction started');
            } else if (status === null) {
              sendSessionStream({ type: 'compacting', isCompacting: false });
              logger.info({ sessionId }, 'SDK compaction finished');
            }
          }

          if (subtype === 'compact_boundary') {
            const metadata = msgAny.compact_metadata as { trigger: string; pre_tokens: number };
            logger.info(
              { sessionId, trigger: metadata.trigger, preTokens: metadata.pre_tokens },
              'SDK compact boundary',
            );
            insertAuditEntry({
              sessionId,
              eventType: 'tool_call',
              toolName: 'system:sdk_compaction',
              output: `Compactacao ${metadata.trigger}: ${metadata.pre_tokens} tokens antes`,
            });
          }

          if (subtype === 'task_started') {
            const taskId = msgAny.task_id as string;
            const toolUseId = msgAny.tool_use_id as string;
            const description = (msgAny.description as string) || '';
            const taskType = (msgAny.task_type as string) || '';

            const capturedAgentId = pendingAgentId;
            pendingAgentId = null;

            let resolvedId: string | null = null;
            let resolvedName: string | null = null;

            if (capturedAgentId) {
              const agentRecord = getAgent(capturedAgentId);
              if (agentRecord) {
                resolvedId = capturedAgentId;
                resolvedName = agentRecord.name;
              }
            }

            if (!resolvedId && taskType) {
              const agentRecord = getAgent(taskType);
              if (agentRecord) {
                resolvedId = taskType;
                resolvedName = agentRecord.name;
              }
            }

            if (!resolvedName) {
              resolvedName = description || taskId;
            }

            let executionId = taskMap.get(toolUseId)?.executionId;
            if (!executionId) {
              const candidateExecutionId = crypto.randomUUID();
              try {
                startTaskExecution({
                  executionId: nativeTaskRootExecutionId,
                  rootExecutionId: nativeTaskRootExecutionId,
                  parentExecutionId: null,
                  executionKind: 'root',
                  ownerKind: 'chat',
                  ownerId: sessionId,
                  sessionId,
                  toolUseId: null,
                  agentId: null,
                  agentName: 'root',
                  model: '',
                  description: subagentDispatchContext.surface,
                  runtime: null,
                  provider: null,
                  metadata: { lane: subagentDispatchContext.lane, surface: subagentDispatchContext.surface },
                });
                startTaskExecution({
                  executionId: candidateExecutionId,
                  taskId,
                  rootExecutionId: nativeTaskRootExecutionId,
                  parentExecutionId: nativeTaskRootExecutionId,
                  executionKind: 'native-task',
                  ownerKind: 'chat',
                  ownerId: sessionId,
                  sessionId,
                  toolUseId,
                  agentId: resolvedId,
                  agentName: resolvedName,
                  model,
                  description,
                  runtime: 'cloud',
                  provider: selection?.provider ?? 'anthropic',
                  metadata: { source: 'sdk-native-task', taskId },
                });
                executionId = candidateExecutionId;
              } catch (err) {
                logger.error({ err, toolUseId }, 'Failed to start native task execution ledger');
              }
            }

            taskMap.set(toolUseId, {
              taskId,
              description,
              agentId: resolvedId,
              ...(executionId ? { executionId } : {}),
            });

            const tokenEntry = subagentTokens.get(toolUseId);
            if (tokenEntry) {
              tokenEntry.agentId = resolvedId;
              tokenEntry.agentName = resolvedName;
            }

            logger.info(
              {
                taskId,
                toolUseId,
                agentId: resolvedId,
                agentName: resolvedName,
                taskType,
                description,
                capturedHookAgentId: capturedAgentId,
              },
              'Task started',
            );

            emitActivity({
              id: toolUseId,
              kind: 'subagent',
              phase: 'start',
              label: resolvedName,
              status: 'running',
              agentId: resolvedId,
              description: description || undefined,
              startedAt: new Date().toISOString(),
            });
          }

          if (subtype === 'task_notification') {
            const toolUseId = msgAny.tool_use_id as string;
            const taskId = (msgAny.task_id as string) || '';
            const taskStatus = (msgAny.status as string) || 'completed';
            const summary = (msgAny.summary as string) || '';
            const notifUsage = msgAny.usage as Record<string, number> | undefined;

            const taskMeta = taskMap.get(toolUseId);

            const tokenEntry =
              subagentTokens.get(toolUseId) ||
              (taskId ? subagentTokens.get(taskId) : undefined) ||
              (taskMeta?.taskId ? subagentTokens.get(taskMeta.taskId) : undefined);

            const effectiveTokens = tokenEntry;

            const resolvedAgentId = taskMeta?.agentId ?? effectiveTokens?.agentId ?? null;
            let resolvedAgentName = effectiveTokens?.agentName ?? taskMeta?.description ?? '';
            if (!resolvedAgentName && resolvedAgentId) {
              const agentRecord = getAgent(resolvedAgentId);
              resolvedAgentName = agentRecord?.name ?? resolvedAgentId;
            }
            if (!resolvedAgentName) {
              resolvedAgentName = summary || taskId || toolUseId;
            }

            const resolvedModel = effectiveTokens?.model || model;
            const inputTokens = effectiveTokens?.inputTokens ?? 0;
            const outputTokens = effectiveTokens?.outputTokens ?? 0;
            const cacheReadTokens = effectiveTokens?.cacheReadTokens ?? 0;
            const cacheCreationTokens = effectiveTokens?.cacheCreationTokens ?? 0;
            const apiRequests = effectiveTokens?.requestCount ?? 0;
            const toolUsesCount = notifUsage?.tool_uses ?? 0;
            const durationMs = notifUsage?.duration_ms ?? 0;

            const costUsd = calculateCost(
              resolvedModel,
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheCreationTokens,
            );

            emitActivity({
              id: toolUseId,
              kind: 'subagent',
              phase: 'end',
              label: resolvedAgentName,
              status: taskStatus === 'completed' ? 'done' : 'error',
              agentId: resolvedAgentId,
              model: resolvedModel,
              tokens: {
                input: inputTokens,
                output: outputTokens,
                cacheRead: cacheReadTokens,
                cacheCreation: cacheCreationTokens,
              },
              costUsd,
              durationMs,
              summary,
              toolUses: toolUsesCount,
              description: taskMeta?.description || undefined,
              endedAt: new Date().toISOString(),
            });

            if (taskMeta?.executionId) {
              const hasReportedUsage = Boolean(
                effectiveTokens && apiRequests > 0 && inputTokens > 0 && outputTokens > 0,
              );
              try {
                finalizeTaskExecutionOnce(taskMeta.executionId, {
                  status:
                    taskStatus === 'completed'
                      ? 'completed'
                      : taskStatus === 'cancelled' || taskStatus === 'stopped'
                        ? 'cancelled'
                        : 'failed',
                  summary,
                  model: resolvedModel,
                  runtime: 'cloud',
                  provider: selection?.provider ?? 'anthropic',
                  inputTokens,
                  outputTokens,
                  cacheReadTokens,
                  cacheCreationTokens,
                  costUsd,
                  apiRequests,
                  toolUses: toolUsesCount,
                  durationMs,
                  costStatus: !hasReportedUsage ? 'unknown' : hasKnownPricing(resolvedModel) ? 'known' : 'unknown',
                  tokenStatus: hasReportedUsage ? 'reported' : 'not_reported',
                  costUnknownReason: !hasReportedUsage
                    ? 'no-usage-reported'
                    : hasKnownPricing(resolvedModel)
                      ? null
                      : 'unknown-pricing',
                  metadata: { source: 'sdk-native-task', taskId: taskMeta.taskId },
                });
              } catch (err) {
                logger.error({ err, toolUseId }, 'Failed to finalize native task execution ledger');
              }
            }

            try {
              if (!taskMeta?.executionId) {
                insertTaskExecution({
                  sessionId,
                  taskId: taskMeta?.taskId ?? toolUseId,
                  toolUseId,
                  agentId: resolvedAgentId,
                  agentName: resolvedAgentName,
                  model: resolvedModel,
                  description: taskMeta?.description ?? '',
                  status: taskStatus,
                  summary,
                  inputTokens,
                  outputTokens,
                  cacheReadTokens,
                  cacheCreationTokens,
                  costUsd,
                  apiRequests,
                  toolUses: toolUsesCount,
                  durationMs,
                });
              }

              insertAuditEntry({
                sessionId,
                subagent: resolvedAgentId ?? undefined,
                eventType: 'tool_call',
                toolName: 'system:task_execution',
                output: `Tarefa concluida (${taskStatus}): ${summary || taskMeta?.description || toolUseId} | tokens: ${inputTokens}in/${outputTokens}out | custo: $${costUsd.toFixed(6)}`,
              });

              logger.info(
                {
                  taskId: taskMeta?.taskId,
                  toolUseId,
                  agentId: resolvedAgentId,
                  agentName: resolvedAgentName,
                  inputTokens,
                  outputTokens,
                  costUsd,
                  taskStatus,
                },
                'Task execution recorded',
              );
            } catch (err) {
              logger.error({ err, toolUseId }, 'Failed to insert task execution');
            }

            taskMap.delete(toolUseId);
            subagentTokens.delete(toolUseId);
            if (taskId) subagentTokens.delete(taskId);
            if (taskMeta?.taskId) subagentTokens.delete(taskMeta.taskId);
          }
        }
      }
    }

    lane.sdkActiveSessionId = sdkThreadId;
    if (options.swarmDelivery && (!swarmResultSucceeded || lane.currentAbortController?.signal.aborted)) {
      throw new Error('Agregação Swarm terminou sem resultado final bem-sucedido.');
    }
    turnOk = true;

    if (pendingSeed) {
      clearSessionPendingSeed(sessionId);
      logger.info({ sessionId, sdkThreadId }, 'pending_seed consumido no sucesso do turno (SPEC 4.3)');
    }

    accumulateTurnUsage();

    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      const totalCost = calculateCost(
        model,
        totalInputTokens,
        totalOutputTokens,
        totalCacheReadTokens,
        totalCacheCreationTokens,
      );
      updateSessionTokens(sessionId, totalInputTokens, totalOutputTokens, totalCost, {
        costStatus: 'known',
        tokenStatus: 'reported',
        runtime: 'cloud',
      });
    }
    const combinedInputTokens = totalInputTokens + sidechainInputTokens;
    const combinedOutputTokens = totalOutputTokens + sidechainOutputTokens;
    if (combinedInputTokens > 0 || combinedOutputTokens > 0) {
      if (options.driveProjectId && !isDynamicWorkflowDriveSessionId(sessionId)) {
        reportDriveTurnUsage({
          sessionId,
          projectId: options.driveProjectId,
          ...(options.driveTurnId ? { driveTurnId: options.driveTurnId } : {}),
          tokens: combinedInputTokens + combinedOutputTokens,
        });
      }
      sendSessionStream({
        type: 'usage',
        usage: {
          inputTokens: combinedInputTokens,
          outputTokens: combinedOutputTokens,
          cacheReadTokens: totalCacheReadTokens + sidechainCacheReadTokens,
          cacheCreationTokens: totalCacheCreationTokens + sidechainCacheCreationTokens,
        },
      });
    }

    if (lastMainContextInput >= 0) {
      setSessionActiveContextTokens(sessionId, lastMainContextInput + lastMainOutput);
      const contextUsage = buildChatContextUsage({
        model,
        provider: selection?.provider,
        contextTokens: lastMainContextInput + lastMainOutput,
        source: 'provider',
      });
      if (contextUsage) {
        sendSessionStream({ type: 'context_usage', contextUsage });
      }
    }

    if (assistantContent) {
      const contentBeforeCleanup = assistantContent;
      const cleaned = options.swarmDelivery
        ? null
        : extractAndProcessOnboardingData(assistantContent, {
            sendStream: sendSessionStream,
            onAudit: ({ toolName, input, output }) => {
              insertAuditEntry({ sessionId, eventType: 'tool_call', toolName, input, output });
              sendLogEntry(getWindow, { sessionId, eventType: 'tool_call', toolName, input, output });
            },
          });
      if (cleaned !== null) {
        assistantContent = cleaned;
        remapPersistedToolOffsets(contentBeforeCleanup, assistantContent, persistedTimelineToolCalls);
      }

      for (const toolCall of persistedTimelineToolCalls) {
        if (toolCall.status === 'running') toolCall.status = 'incomplete';
      }
      const messageMetadata =
        collectedArtifacts.length > 0 || persistedTimelineToolCalls.length > 0
          ? JSON.stringify({
              ...(collectedArtifacts.length > 0 ? { artifacts: collectedArtifacts } : {}),
              ...(persistedTimelineToolCalls.length > 0 ? { toolCalls: persistedTimelineToolCalls } : {}),
            })
          : undefined;
      if (!persistSwarmResponse(options, sessionId, assistantContent, messageMetadata)) {
        insertMessage(sessionId, 'assistant', assistantContent, options.agentId, messageMetadata);
      }
      recordCompletedMainChatTurn(sessionId, getWindow);
    } else if (
      isEmptyFailedTurn({
        assistantContent,
        outputTokens: totalOutputTokens,
        artifactCount: collectedArtifacts.length,
      })
    ) {
      const emptyTurnError = buildExecutionError('LLM-EMPTY', `model=${model}`);
      logger.warn(
        { sessionId, model, lane: lane.name },
        'turno terminou vazio sem output tokens e sem artifacts — emitindo LLM-EMPTY (AC-B4b)',
      );
      sendSessionStream({ type: 'error', code: emptyTurnError.code, error: emptyTurnError.userMessage });
    }

    if (sessionId) {
      const session = getSession(sessionId);
      if (session && session.type !== 'scheduled' && session.type !== 'telegram') {
        const msgs = getSessionMessages(session.id);
        const assistantCount = msgs.filter((msg) => msg.role === 'assistant').length;
        const shouldGenerateTitle = !session.title || assistantCount === 1;

        if (shouldGenerateTitle && msgs.length >= 2) {
          generateSessionTitle(session.id).catch((err) => {
            logger.error({ err, sessionId }, 'Title generation failed');
          });
        }
      }
    }

    await maybeCompactChatSession(
      sessionId,
      sendSessionStream,
      selection ? { model: selection.model, provider: selection.provider } : undefined,
    );
  } catch (error) {
    const controlledError = pendingSubagentProviderAuthError(subagentDispatchContext) ?? error;
    if (isSubagentProviderAuthError(controlledError)) {
      const failure = subagentAuthFailure(controlledError);
      sendSessionStream({ type: 'error', sessionId, ...failure });
      const authEntry: Omit<AuditEntry, 'id' | 'createdAt'> = {
        sessionId,
        eventType: 'error',
        output: failure.error,
      };
      insertAuditEntry(authEntry);
      sendLogEntry(getWindow, authEntry);
      if (lane.kind !== 'desktop') throw controlledError;
      return;
    }
    if ((error as Error).name === 'AbortError') {
      sendSessionStream({ type: 'done', content: sessionId });
      return;
    }
    const errorMsg = error instanceof Error ? error.message : 'Erro desconhecido';
    logger.error(
      { error, shouldContinueSession, sdkActiveSessionId: lane.sdkActiveSessionId, lane: lane.name },
      'Orchestrator query failed',
    );

    if (shouldContinueSession && lane.sdkActiveSessionId !== sdkThreadId) {
      lane.sdkActiveSessionId = null;
      logger.warn({ sessionId }, 'Resume failed — retrying with fresh SDK session');
      try {
        lane.currentAbortController = null;
        markChatTurnDelegated(turnStreamFlags);
        await executeQuery(
          message,
          { ...options, sessionId, _forceNewSession: true, answeredUserMessageId: currentUserMessageId },
          getWindow,
          lane,
        );
        return;
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : 'Erro desconhecido';
        logger.error({ retryErr }, 'Retry with fresh session also failed');
        sendSessionStream({ type: 'error', error: retryMsg });
        const errorEntry: Omit<AuditEntry, 'id' | 'createdAt'> = {
          sessionId,
          eventType: 'error',
          output: `Resume failed, retry failed: ${retryMsg}`,
        };
        insertAuditEntry(errorEntry);
        sendLogEntry(getWindow, errorEntry);
        if (lane.kind !== 'desktop') {
          throw retryErr;
        }
        return;
      }
    }

    if (shouldContinueSession) {
      lane.sdkActiveSessionId = null;
    }

    sendSessionStream({ type: 'error', error: errorMsg });
    const errorEntry: Omit<AuditEntry, 'id' | 'createdAt'> = {
      sessionId,
      eventType: 'error',
      output: errorMsg,
    };
    insertAuditEntry(errorEntry);
    sendLogEntry(getWindow, errorEntry);
    if (lane.kind !== 'desktop') {
      throw error;
    }
  } finally {
    try {
      finalizeRunningTaskExecutionTree(
        nativeTaskRootExecutionId,
        turnOk ? 'completed' : 'cancelled',
        turnOk
          ? 'Turno owner encerrado; Task nativa nao enviou notificacao terminal.'
          : 'Turno owner cancelado/falhou antes da notificacao terminal da Task nativa.',
      );
    } catch (err) {
      logger.error({ err, nativeTaskRootExecutionId }, 'Failed to finalize native task execution tree');
    }
    if (
      shouldEmitChatTurnFallbackError(turnStreamFlags, {
        isDesktopLane: lane.kind === 'desktop',
        silent: options.silent === true,
      })
    ) {
      const fallback = chatTurnFallbackError(`lane=${lane.name}`);
      logger.warn(
        { sessionId, lane: lane.name },
        'turno terminou sem chunk de erro, sem conteudo e sem done — emitindo LLM-EMPTY de fallback (AC-B26)',
      );
      sendSessionStream({ type: 'error', code: fallback.code, error: fallback.userMessage });
    }
    smokeAudit('turn_done', { lane: lane.name, sessionId, ok: turnOk });
    lane.currentAbortController = null;
    resolveEngineExit();
  }
}

function remapPersistedToolOffsets(
  previousContent: string,
  nextContent: string,
  tools: PersistedTimelineToolCall[],
): void {
  if (previousContent === nextContent) return;
  let prefix = 0;
  const prefixLimit = Math.min(previousContent.length, nextContent.length);
  while (prefix < prefixLimit && previousContent[prefix] === nextContent[prefix]) prefix += 1;
  let suffix = 0;
  const suffixLimit = Math.min(previousContent.length - prefix, nextContent.length - prefix);
  while (
    suffix < suffixLimit &&
    previousContent[previousContent.length - 1 - suffix] === nextContent[nextContent.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const previousChangedEnd = previousContent.length - suffix;
  const delta = nextContent.length - previousContent.length;
  for (const tool of tools) {
    if (!Number.isInteger(tool.textOffset) || (tool.textOffset ?? -1) < 0) continue;
    const offset = tool.textOffset ?? 0;
    const remapped = offset <= prefix ? offset : offset >= previousChangedEnd ? offset + delta : prefix;
    tool.textOffset = Math.max(0, Math.min(nextContent.length, remapped));
  }
}

export function stopCurrentQuery(sessionId?: string): void {
  if (sessionId) {
    stopDesktopSessionQuery(sessionId);
    return;
  }
  logger.warn('chat:stop sem sessionId: parando TODAS as lanes desktop (caminho antigo)');
  smokeAudit('stop', { lane: 'desktop' });
  for (const lane of listDesktopLanes()) {
    stopDesktopSessionQuery(lane.sessionId);
  }
  pruneIdleDesktopLanes();
}

export function stopDesktopSessionQuery(sessionId: string): void {
  smokeAudit('stop', { lane: 'desktop', sessionId });
  const lane = peekDesktopLane(sessionId);
  if (!lane) {
    logger.info({ sessionId }, 'chat:stop por sessao: lane inexistente, nada a parar');
    return;
  }
  const drained = lane.queue.drain();
  const signaled = signalDiscardedDriveTurns(drained);
  const inFlight = isDesktopSessionInFlight(sessionId) || isLaneRuntimeQueryActive(lane);
  stopLaneRuntimes(lane);
  logger.info(
    { sessionId, drained: drained.length, signaled, abortedInFlight: inFlight },
    'chat:stop por sessao: fila da sessao esvaziada e turno em voo abortado se era dela',
  );
}

function sendStream(
  getWindow: () => BrowserWindow | null,
  silent: boolean | undefined,
  chunk: StreamChunk,
  authorizationGeneration?: number,
): void {
  if (silent) return;
  if (authorizationGeneration !== undefined && !privilegedAccessGate.isGenerationCurrent(authorizationGeneration))
    return;
  const laneQueueLength =
    chunk.type === 'done' && typeof chunk.sessionId === 'string'
      ? (peekDesktopLane(chunk.sessionId)?.queue.length ?? 0)
      : 0;
  const finalChunk = laneQueueLength > 0 ? { ...chunk, queueRemaining: laneQueueLength } : chunk;
  try {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('chat:stream', finalChunk);
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
  } catch {
    // Render frame disposed (e.g. GPU crash, window reload)
  }
}

export function executeTelegramLaneQuery(
  message: string,
  options: QueryOptions,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  if (!options.sessionId) {
    const error = 'telegramLane exige options.sessionId explicito (guard de sessao, SPEC 1.4)';
    logger.error({ lane: telegramLane.name }, error);
    return Promise.reject(new Error(error));
  }
  const releaseUpdateLease = tryBeginBackgroundWorkStart('telegram-turn');
  if (releaseUpdateLease === null) {
    return Promise.reject(new UpdateMaintenanceBarrierClosedError());
  }
  try {
    telegramLanePendingJobs += 1;
    const job = telegramQueueChain.then(() => executeQuery(message, options, getWindow, telegramLane));
    void job.then(
      () => {
        telegramLanePendingJobs -= 1;
      },
      () => {
        telegramLanePendingJobs -= 1;
      },
    );
    telegramQueueChain = job.catch(() => {});
    return job;
  } finally {
    releaseUpdateLease();
  }
}

export function enqueueTelegramLaneTask<T>(task: () => Promise<T>): Promise<T> {
  const releaseUpdateLease = tryBeginBackgroundWorkStart('telegram-task');
  if (releaseUpdateLease === null) {
    return Promise.reject(new UpdateMaintenanceBarrierClosedError());
  }
  try {
    telegramLanePendingJobs += 1;
    const job = telegramQueueChain.then(() => task());
    void job.then(
      () => {
        telegramLanePendingJobs -= 1;
      },
      () => {
        telegramLanePendingJobs -= 1;
      },
    );
    telegramQueueChain = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  } finally {
    releaseUpdateLease();
  }
}

export function stopTelegramQuery(): void {
  smokeAudit('stop', { lane: 'telegram' });
  if (telegramLane.currentAbortController) {
    telegramLane.currentAbortController.abort();
    telegramLane.currentAbortController = null;
  }
  stopClaudeCompatQuery(telegramLane);
  stopCodexSdkQuery(telegramLane);
  stopKimiSdkQuery(telegramLane);
  stopGrokSdkQuery(telegramLane);
  stopCursorSdkQuery(telegramLane);
  stopLionSdkQuery(telegramLane);
}

export function resetTelegramSessionState(): void {
  telegramLane.sdkActiveSessionId = null;
}

export function executeCronQuery(
  message: string,
  options: QueryOptions,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  const cronSessionId = options.sessionId;
  if (!cronSessionId) {
    const error = 'cronLane exige options.sessionId explicito (guard de sessao, SPEC 1.4)';
    logger.error({ lane: cronLane.name }, error);
    return Promise.reject(new Error(error));
  }
  const releaseUpdateLease = tryBeginBackgroundWorkStart('cron-turn');
  if (releaseUpdateLease === null) {
    return Promise.reject(new UpdateMaintenanceBarrierClosedError());
  }
  const job = cronQueueChain.then(async () => {
    const existingMessages = getSessionMessages(cronSessionId);
    if (existingMessages.length > 0) {
      const error = `cronLane exige sessao efemera SEM mensagens (SPEC 7.1); sessao ${cronSessionId} tem ${existingMessages.length}`;
      logger.error({ sessionId: cronSessionId, messages: existingMessages.length }, error);
      throw new Error(error);
    }
    try {
      await executeQuery(message, options, getWindow, cronLane);
    } finally {
      resetCronSessionState();
    }
  });
  cronLanePendingJobs += 1;
  void job.then(
    () => {
      cronLanePendingJobs -= 1;
    },
    () => {
      cronLanePendingJobs -= 1;
    },
  );
  cronQueueChain = job.catch(() => {});
  releaseUpdateLease();
  return job;
}

export function stopCronQuery(): void {
  smokeAudit('stop', { lane: 'cron' });
  if (cronLane.currentAbortController) {
    cronLane.currentAbortController.abort();
    cronLane.currentAbortController = null;
  }
  stopClaudeCompatQuery(cronLane);
  stopCodexSdkQuery(cronLane);
  stopKimiSdkQuery(cronLane);
  stopGrokSdkQuery(cronLane);
  stopCursorSdkQuery(cronLane);
  stopLionSdkQuery(cronLane);
}

export function resetCronSessionState(): void {
  cronLane.sdkActiveSessionId = null;
}

export function hasActiveOrchestratorWork(): boolean {
  return (
    listDesktopLanes().some((lane) => lane.queue.isProcessing || lane.queue.length > 0) ||
    hasActiveDesktopRuntimeQuery() ||
    telegramLane.currentAbortController !== null ||
    cronLane.currentAbortController !== null ||
    telegramLanePendingJobs > 0 ||
    cronLanePendingJobs > 0
  );
}
