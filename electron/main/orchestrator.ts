import { BrowserWindow } from 'electron';
import { createLogger } from './logger';
import { getAllAgents, getAgent, insertMessage, insertAuditEntry, createSession, getSetting, updateSessionTokens, setSessionActiveContextTokens, getActiveChatSession, getSession, getEnabledTools, getSessionMessages, insertTaskExecution, startTaskExecution, finalizeTaskExecutionOnce, finalizeRunningTaskExecutionTree, getTurnIndexForUserMessage, getLatestUserTurnIndex, getHarnessProject, clearSessionPendingSeed } from './db';
import { recordActivity, isWriteTool, deriveToolDetail } from './activity-log';
import { setActiveAgentId } from './knowledge-state';
import { extractAndProcessOnboardingData } from './onboarding';
import { calculateCost, hasKnownPricing } from './pricing';
import { getApiKey, getSecret } from './secrets-vault';
import { createPermissionGuard, GUARD_GATED_TOOLS, ASK_USER_ANSWERS_MARKER } from './permission-guard';

/**
 * True quando o tool_result "com erro" e na verdade o deny-com-respostas do
 * AskUserQuestion interceptado (permission-guard): o humano RESPONDEU e o
 * is_error e artefato tecnico do canal de interceptacao. A UI deve mostrar
 * sucesso, nao "falhou".
 */
function isAskUserAnswersResult(toolName: string | undefined, content: string): boolean {
  return toolName === 'AskUserQuestion' && content.includes(ASK_USER_ANSWERS_MARKER);
}
import { getMCPConfigForAgent } from './mcp-manager';
import {
  resolveAgentQueryConfig,
  // (A3, F12/11.1) merge repo-aware das definitions de subagents cloud
  mergeRepoGraphAllowlist,
  buildRepoGraphMcpSpec,
  REPO_GRAPH_MCP_SERVER_ID,
  type McpServerEntry,
} from './agent-config-resolver';
import { getDisabledSDKMcps } from './mcp-discovery';
import { resolveMcpServerRuntime } from './mcp-path-resolver';
import { captureToolUse, captureToolResult, resetArtifactDetector } from './artifact-detector';
import { buildSystemPrompt } from './prompt-builder';
import { getAgentCwd, getCronCwd, getLionClawHome } from './paths';
import { getClaudeSdkProcessOptions } from './pipeline-shared/sdk-bootstrap';
import { SDK_DISALLOWED_TOOLS, toSdkToolNames } from './agent-runtime/sdk-tool-names';
// codex-agents-mcp uses lazy initialization via dynamic import (the SDK is ESM-only).
// We import the factory function statically but the server itself is built on first use.
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
// SPEC robustez-chat SB-10 (V8, AC-B26): rede de seguranca do turno de chat:send
// — helpers puros; a fiacao vive no wrapper de stream + finally do turno.
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
import type { StreamChunk, AuditEntry, AgentConfig, ArtifactData, LiveActivityEvent, OrchestratorRuntime, ChatAttachmentMeta, ChatFeatureToggles, PersistedTimelineToolCall } from '../../src/types';
import { buildUserAttachmentsMeta, persistUserChatMessage } from './user-attachments-meta';
import { ensureInitialSessionTitle, generateSessionTitle } from './title-generator';
import { messageQueue } from './message-queue';

type AgentDefinitionCompat = Omit<AgentDefinition, 'prompt'> & {
  prompt?: string;
};
import { resolveOrchestratorSelection, InvalidOrchestratorSelectionError, type OrchestratorSelection } from './orchestrator-selection';
import { type SdkLane, desktopLane, telegramLane, cronLane } from './sdk-lane';
import { runtimeSupportsImageInput, runtimeSupportsEffort } from './agent-runtime/runtime-capabilities';
import { describeImage, buildTranscriptionBlock, visionUnavailableNotice } from './vision-engine';
import {
  executeClaudeCompatSdkQuery,
  isClaudeCompatQueryActive,
  resetClaudeCompatSdkSessionState,
  stopClaudeCompatQuery,
} from './claude-compat-sdk';
import {
  executeCodexSdkQuery,
  isCodexSdkQueryActive,
  resetCodexSdkSessionState,
  stopCodexSdkQuery,
} from './codex-sdk';
import {
  executeKimiSdkQuery,
  isKimiSdkQueryActive,
  resetKimiSdkSessionState,
  stopKimiSdkQuery,
} from './kimi-sdk';
import {
  executeGrokSdkQuery,
  isGrokSdkQueryActive,
  resetGrokSdkSessionState,
  stopGrokSdkQuery,
} from './grok-sdk';
import {
  executeCursorSdkQuery,
  isCursorSdkQueryActive,
  resetCursorSdkSessionState,
  stopCursorSdkQuery,
} from './cursor-sdk';
import {
  executeLionSdkQuery,
  isLionSdkQueryActive,
  resetLionSdkSessionState,
  stopLionSdkQuery,
} from './lion-sdk';
// TEMPORARIO - smoke-audit do build fonte-unica; REMOVER apos validacao.
import { smokeAudit } from './smoke-audit';
import { recordCompletedMainChatTurn } from './dreaming-turn-engine';
import { reportDriveTurnUsage, reportDriveTurnComplete } from './drive-usage-sink';
// (A2) repo mode com CodeGraph: hook ADITIVO F6 (turn-context) + secao
// condicional de prompt. Arquivo NOVO prompt-builder-repo-graph.ts — a Parte A
// nao toca prompt-builder.ts (SPEC spec-chat-repo-codegraph.md, secao 18).
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
// (S3a) SPEC chat-context-reduction 0.2 + 0.7 itens 1/2: identidade canonica do
// turno de chat (turnId cunhado pelo host) + turn-context em RAM + active-turn
// registry por lane. Hook ADITIVO analogo ao F6 do repo-graph acima; SHADOW —
// nenhum gate consome ainda (gate = S4).
import {
  registerChatCapabilityTurn,
  clearChatCapabilityTurn,
  setActiveChatTurn,
  clearActiveChatTurn,
  toChatLane,
  CHAT_TURN_CONTEXT_TTL_SETTING_KEY,
  // (S5b) leitura do turn-context DENTRO do executor claude-sdk (espelho do
  // padrao repo-graph getRepoGraphTurnContext) para as capabilities EFETIVAS.
  getActiveChatTurnByLane,
  getChatCapabilityTurn,
  computeEffectiveCapabilitiesForTurn,
  DEFAULT_CHAT_TURN_CONTEXT_TTL_MS,
  type ChatCapabilityName,
} from './chat-capability-context';
// Type-only (S6a): a enum fechada de coordenadores da lease (0.5) tipa o campo
// das options; nenhum valor deste modulo e usado aqui (sem ciclo em runtime).
import type { InternalCapabilityCoordinator } from './chat-capability-lease';
import { CHAT_CAPABILITIES_DEFAULT_OFF } from '../../src/types';
// Edicao comunidade: o gate de acesso privilegiado e a barreira de manutencao
// de update da edicao build nao existem aqui. Shims locais no-op preservam o
// fluxo de controle original byte-identico (nenhum caminho e negado).
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
const tryBeginBackgroundWorkStart = (_lane: string): (() => void) | null => () => {};
class UpdateMaintenanceBarrierClosedError extends Error {
  constructor() {
    super('barreira de manutencao de update ausente na edicao comunidade');
    this.name = 'UpdateMaintenanceBarrierClosedError';
  }
}

const logger = createLogger('orchestrator');

// Contadores autoritativos de jobs pendentes/em voo nas lanes seriais, usados
// pelo adapter de blockers do update (D14). Enqueue incrementa ANTES de liberar
// a lease compartilhada; o fim do job decrementa.
let telegramLanePendingJobs = 0;
let cronLanePendingJobs = 0;

// ---- SDK Lanes: independent subprocess state ----
// Desktop lane:  serves the main chat UI
// Telegram lane: serves the Telegram bridge (persona principal, ~/.lionclaw)
// Cron lane:     serves the Scheduler (worker efemero, ~/.lionclaw/cron)
// (SPEC telegram-cron-compaction 1.2: backgroundLane aposentada)

// SPEC orquestrador-fonte-unica 3: SdkLane e as 3 instancias (desktop/telegram/
// cron) vivem em sdk-lane.ts, modulo sem dependencias, para serem compartilhadas
// com os sub-SDKs sem ciclo de import em runtime. Ate a S2 eram privados daqui e
// o compat mantinha uma compatLane paralela; agora e a mesma instancia.

// Filas seriais INDEPENDENTES por lane (SPEC 1.2): um cron longo nao atrasa a
// resposta do Telegram e vice-versa; ambas sao independentes do desktop.
let telegramQueueChain: Promise<void> = Promise.resolve();
let cronQueueChain: Promise<void> = Promise.resolve();
let desktopQueueProcessorId = 0;
const STALE_QUEUE_GRACE_MS = 30_000;

function hasActiveDesktopRuntimeQuery(): boolean {
  // SPEC orquestrador-fonte-unica 3.1: com abort POR LANE, todo runtime que roda
  // na desktop lane seta desktopLane.currentAbortController (claude-sdk direto;
  // compat/codex/kimi/lion via lane.currentAbortController). Consultar cada
  // sub-SDK pela desktop lane e equivalente; mantido explicito para clareza.
  return (
    desktopLane.currentAbortController !== null ||
    isClaudeCompatQueryActive(desktopLane) ||
    isCodexSdkQueryActive(desktopLane) ||
    isKimiSdkQueryActive(desktopLane) ||
    isGrokSdkQueryActive(desktopLane) ||
    isCursorSdkQueryActive(desktopLane) ||
    isLionSdkQueryActive(desktopLane)
  );
}

function abandonDesktopQueueProcessor(reason: string): void {
  desktopQueueProcessorId++;
  messageQueue.isProcessing = false;
  logger.warn({ reason }, 'Desktop message queue processor abandoned');
}

/**
 * (Passo 0 do plano de drive) Esvazia a fila do desktop EMITINDO o sinal
 * universal de fim de turno para cada turno de drive/workflow descartado.
 *
 * O gate one-in-flight do coordenador fecha no ENQUEUE, mas os tres emissores
 * de `reportDriveTurnComplete` vivem dentro do `processQueue` (:346, :356,
 * :399) e so alcancam item efetivamente desenfileirado. Um `clear()` seco
 * (chat:stop, compactacao, troca de orquestrador, clear-session) matava o turno
 * silenciosamente e o gate so era destravado por acidente, pelo proximo evento
 * de fase. Mesmo tratamento do descarte F7: o coordenador ignora o complete que
 * nao bater com o turno corrente, entao emitir a mais e inofensivo.
 */
function drainDesktopQueueSignalingDriveTurns(reason: string): void {
  const drained = messageQueue.drain();
  let signaled = 0;
  for (const item of drained) {
    if (item.options?.origin === 'system-event' && item.options?.driveProjectId) {
      reportDriveTurnComplete(item.options.driveProjectId, item.options.driveTurnId, 'discarded');
      signaled++;
    }
  }
  if (signaled > 0) {
    logger.info(
      { reason, drained: drained.length, signaled },
      'fila do desktop esvaziada: fim de turno emitido para os turnos de drive descartados',
    );
  }
}

/** Reset SDK session state for desktop lane. Called by ipc-handlers after clearing session files. */
export function resetSdkSessionState(): void {
  desktopLane.sdkActiveSessionId = null;
  resetClaudeCompatSdkSessionState();
  resetCodexSdkSessionState();
  resetKimiSdkSessionState();
  resetGrokSdkSessionState();
  resetCursorSdkSessionState();
  resetLionSdkSessionState();
  drainDesktopQueueSignalingDriveTurns('reset-sdk-session-state');
  if (messageQueue.isProcessing) {
    abandonDesktopQueueProcessor('reset-sdk-session-state');
  }
}

// ---- Message Queue Integration ----

/**
 * Public entry point: enqueues a message and starts processing if idle.
 * Returns immediately - the queue processes in the background.
 */
export function submitMessage(
  message: string,
  options: QueryOptions,
  getWindow: () => BrowserWindow | null,
): void {
  // SPEC update R2 D14: lease compartilhada ate a mensagem estar REGISTRADA na
  // fila (estado autoritativo consultado pelos blockers). Barreira fechada =
  // instalacao de update em curso; o turno novo e recusado, nunca enfileirado.
  const releaseUpdateLease = tryBeginBackgroundWorkStart('chat-turn');
  if (releaseUpdateLease === null) {
    logger.warn('submitMessage recusado: manutencao de update em andamento (D14)');
    return;
  }
  try {
    const authorizationGeneration = privilegedAccessGate.captureGenerationIfBound();
    messageQueue.enqueue({
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

  if (!messageQueue.isProcessing) {
    processQueue(getWindow);
    return;
  }

  if (
    messageQueue.processingDurationMs > STALE_QUEUE_GRACE_MS &&
    !hasActiveDesktopRuntimeQuery()
  ) {
    logger.warn(
      { queueLength: messageQueue.length, processingDurationMs: messageQueue.processingDurationMs },
      'Recovering stale desktop message queue processor',
    );
    abandonDesktopQueueProcessor('stale-without-active-runtime');
    processQueue(getWindow);
  }
}

/**
 * (F7 - SPEC estrada-fixes) Guard de DEQUEUE dos turnos de drive defasados.
 *
 * O prompt do turno de drive e montado no ENQUEUE (fireOrchestratorTurn le
 * fase/pendingQuestion frescos) mas EXECUTADO minutos depois pela fila FIFO do
 * chat — quando executa, a fase real pode ja ter avancado (header defasado,
 * eco de pergunta resolvida, risco de re-aprovar gate vencido). O turno viaja
 * com identidade ESTRUTURADA ({ driveProjectId, drivePhase }, setada SO pelo
 * pipeline-drive-coordinator junto com origin:'system-event'); aqui comparamos
 * com a fase real do DB e descartamos o turno se `drivePhase` ficou para tras.
 *
 * FAIL-OPEN (nunca bloqueia o chat): mensagens sem origin/driveProjectId nao
 * entram no guard; projeto inexistente ou fase null deixam passar; erro de DB
 * e logado (WARN) e deixa passar.
 *
 * Nota de borda (reset): apos um RESET de pipeline a fase real pode RECUAR; a
 * comparacao so descarta `drivePhase < fase real`, entao um turno antigo com
 * fase MAIOR que a real pos-reset passa — aceitavel: o re-engage pos-reset
 * gera turno novo (fix estrutural = spec-drive-condutor, executeAgent imediato
 * sem fila, que elimina a classe inteira).
 *
 * Fix TATICO, descartavel quando o Condutor chegar. Exportado para unit test.
 */
export function shouldDiscardStaleDriveTurn(options: QueryOptions): boolean {
  if (options.origin !== 'system-event' || !options.driveProjectId) return false;
  // NAO mover nada acima desta linha: turno SEM `drivePhase` e o wake dos
  // Dynamic Workflows (workflow-ignition.ts), cujo `driveProjectId` e um runId
  // de workflow, nao um projeto de pipeline. Qualquer checagem de drive antes
  // daqui nao acha projeto, conclui "nao engajado" e mata TODO despertar de
  // workflow em silencio.
  if (typeof options.drivePhase !== 'number') return false;
  try {
    const project = getHarnessProject(options.driveProjectId);
    const realPhase = project?.pipelineCurrentPhase;

    // (Passo 1) Turno de EPOCA MORTA. Roda ANTES do fail-open de fase abaixo,
    // porque o caso que motivou o fix e justamente o de fase nula: pipeline
    // concluido zera `pipelineCurrentPhase` e a comparacao de fase desliga,
    // deixando passar a fila inteira de turnos velhos. `drivePhase >= 1`
    // preserva o turno de resumo de entrega (onPipelineCompleted usa fase 0, e
    // nasce DEPOIS do stopDrive de proposito).
    if (options.drivePhase >= 1) {
      const drive = project?.config?.drive;
      if (
        typeof options.driveEpoch === 'string' &&
        drive?.startedAt &&
        drive.startedAt !== options.driveEpoch
      ) {
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

    if (typeof realPhase !== 'number') return false; // fail-open: projeto/fase desconhecidos
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

async function processQueue(getWindow: () => BrowserWindow | null): Promise<void> {
  if (messageQueue.isProcessing) return;
  const processorId = ++desktopQueueProcessorId;
  messageQueue.isProcessing = true;

  try {
    while (desktopQueueProcessorId === processorId && messageQueue.length > 0) {
      const item = messageQueue.dequeue()!;
      try {
        if (item.options.authorizationGeneration !== undefined) {
          privilegedAccessGate.assertAllowed(item.options.authorizationGeneration);
        }
      } catch (error) {
        if (!(error instanceof PrivilegedAccessDeniedError)) throw error;
        logger.warn('Queued message discarded because its authorization lease is no longer valid');
        if (item.options.origin === 'system-event' && item.options.driveProjectId) {
          reportDriveTurnComplete(item.options.driveProjectId, item.options.driveTurnId, 'discarded');
        }
        continue;
      }
      // (F7) Turno de drive defasado: descarta SEM executeQuery (log no guard).
      if (shouldDiscardStaleDriveTurn(item.options)) {
        // (W2.3) Turno descartado = turno CONCLUIDO para o gate one-in-flight:
        // emite o sinal de fim de turno com o driveTurnId do item descartado
        // (ignorado pelo coordinator se nao for o turno corrente).
        if (item.options?.origin === 'system-event' && item.options?.driveProjectId) {
          reportDriveTurnComplete(item.options.driveProjectId, item.options.driveTurnId, 'discarded');
        }
        continue;
      }
      logger.info(
        { queueLength: messageQueue.length, message: item.message.substring(0, 80) },
        'Processing queued message',
      );
      // (W2.3) try/finally ADITIVO: TODO turno origin:'system-event' (drive)
      // emite o sinal universal de fim de turno no fechamento - runtime-agnostico,
      // cobrindo sucesso, erro e abort. Libera o gate one-in-flight do coordinator
      // sem depender de tokens (Claude SDK) nem de phase-changed.
      // SPEC orquestrador-driver D5: `outcome` do turno para o sink. `executed`
      // so quando o executeQuery concluiu; se lancou antes de qualquer decisao,
      // `failed-before-execution` (a ignicao de workflow NAO reconhece o digest
      // e rearma o wake). Campo aditivo; o coordinator de pipeline o ignora.
      let driveTurnOutcome: 'executed' | 'failed-before-execution' = 'failed-before-execution';
      try {
        await executeQuery(item.message, item.options, getWindow, desktopLane);
        driveTurnOutcome = 'executed';
      } catch (err) {
        // SPEC orquestrador-fonte-unica 2.2: o resolver agora PROPAGA o erro
        // tipado. No desktop o tratamento vive AQUI (o turno passa pela fila):
        // emite o chunk `{ type:'error', code, error }` e SEGUE processando a
        // fila (nunca derruba o queue processor). Outros erros continuam subindo
        // como antes (o executeClaudeSdkQuery ja trata os proprios internamente).
        if (err instanceof InvalidOrchestratorSelectionError) {
          // TEMPORARIO - smoke-audit: erro tipado do resolver na desktop lane.
          smokeAudit('orchestrator_error', {
            lane: 'desktop',
            code: err.code,
            missingField: err.missingField ?? null,
          });
          logger.error(
            { code: err.code, missingField: err.missingField },
            'Orchestrator selection failed (desktop lane); turno pulado, fila segue',
          );
          sendStream(getWindow, item.options?.silent, {
            type: 'error',
            code: err.code,
            error: err.message,
          }, item.options.authorizationGeneration);
        } else if (err instanceof PrivilegedAccessDeniedError) {
          logger.warn('Turno descartado porque a autorizacao expirou durante a execucao');
        } else {
          throw err;
        }
      } finally {
        if (item.options?.origin === 'system-event' && item.options?.driveProjectId) {
          reportDriveTurnComplete(
            item.options.driveProjectId,
            item.options.driveTurnId,
            driveTurnOutcome,
          );
        }
      }
    }
  } finally {
    if (desktopQueueProcessorId === processorId) {
      messageQueue.isProcessing = false;
    }
  }
}

/**
 * (A3, SPEC spec-chat-repo-codegraph.md 11.1/F1) `repoChatContext` OPCIONAL:
 * com repo ativo + graph pronto (ready/stale), cada subagent CLOUD ganha
 *  - prompt curto repo-aware (buildRepoGraphSubagentSection);
 *  - o subprocess MCP repo-graph na definition;
 *  - MERGE da allowlist via agent-config-resolver (F12): toolSet.add das 7
 *    tools mcp__repo-graph__* SEM sobrescrever a allowlist existente. Allowlist
 *    VAZIA (= herda todas as tools) fica vazia — restringir seria regressao.
 * Subagent NUNCA ganha tool de build/update (inexistente no reader, 5.2).
 * SEM ctx, retorno byte-identico ao anterior (regressao item 3 da secao 15).
 * Exportada para os testes de definition (repo-graph-subagent-defs.test.ts).
 */
export async function buildAgentDefinitions(
  repoChatContext?: RepoChatContext,
  dispatchContext?: SubagentDispatchContext,
): Promise<Record<string, AgentDefinitionCompat>> {
  // Only CLOUD agents become SDK subagents.
  // Local agents → run_local_agent MCP tool. External agents → run_external_agent MCP tool.
  const agents = getAllAgents().filter(
    (a: AgentConfig) => a.isActive && a.runtime === 'cloud',
  );
  const definitions: Record<string, AgentDefinitionCompat> = {};

  // Bloco repo-aware computado UMA vez (mesma secao/spec para todos os subagents)
  const repoGraphSpec = repoChatContext ? buildRepoGraphMcpSpec() : null;
  const repoGraphSection = repoChatContext
    ? buildRepoGraphSubagentSection(repoChatContext)
    : null;

  for (const agent of agents) {
    const resolved = dispatchContext
      ? await resolveSubagentConfigWithinCeiling(agent.id, dispatchContext)
      : { config: await resolveAgentQueryConfig(agent.id) };
    if (!resolved.config) continue;
    let config = resolved.config;

    let tools: string[] | undefined =
      config.allowedTools.length > 0 ? config.allowedTools : undefined;
    let prompt: string | undefined = config.systemPrompt || undefined;
    let mcpServers: McpServerEntry[] =
      config.mcpServers.length > 0 ? config.mcpServers : [];

    if (repoChatContext && repoGraphSection) {
      // F12: merge SO quando ha allowlist explicita; vazia = herda tudo.
      if (tools) tools = mergeRepoGraphAllowlist(tools);
      prompt = prompt ? `${prompt}\n\n${repoGraphSection}` : repoGraphSection;
      if (
        repoGraphSpec &&
        !mcpServers.some((spec) => REPO_GRAPH_MCP_SERVER_ID in spec)
      ) {
        mcpServers = [...mcpServers, repoGraphSpec];
      }
    }

    if (dispatchContext) {
      const restricted = applySubagentCapabilityCeiling({
        ...config,
        allowedTools: tools ?? [],
        systemPrompt: prompt ?? '',
        mcpServers,
      }, dispatchContext);
      if (!restricted.config) continue;
      config = restricted.config;
      tools = config.allowedTools;
      prompt = config.systemPrompt || undefined;
      mcpServers = config.mcpServers;
    }

    definitions[agent.id] = {
      description: agent.description,
      // D8 (SPEC agent-sdk-0.3): traducao de nome SO na fronteira do SDK
      // (TodoWrite -> Task tools); lista vazia continua undefined (= herda).
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
  sessionId?: string;
  agentId?: string;
  model?: string;
  silent?: boolean;
  /** When set, this text is saved to the DB instead of the full message.
   *  Useful for Telegram where system context is prepended but should not be visible. */
  displayMessage?: string;
  /** Force a fresh SDK session (skip resume). Used internally for retry after EPIPE. */
  _forceNewSession?: boolean;
  /** K1/R3 (pipe-control): origem do turno. `'system-event'` = turno semeado pelo
   *  coordenador de drive (NAO uma mensagem digitada pelo humano). Honrado nos 4
   *  executores: NAO persiste o prompt como user message (so a resposta do assistant
   *  streama). `'user'` (default) preserva o comportamento atual. */
  origin?: 'user' | 'system-event';
  /** Atalho equivalente a `origin:'system-event'` no ponto de persistencia da user
   *  message. Quando true (ou origin==='system-event'), o prompt NAO vira bolha de user. */
  skipUserMessagePersistence?: boolean;
  /** (F7 - SPEC estrada-fixes) Identidade ESTRUTURADA do turno de DRIVE na fila
   *  (so o pipeline-drive-coordinator seta, junto com origin:'system-event').
   *  Projeto que o turno semeado dirige; usado pelo guard de dequeue do
   *  processQueue para descartar turnos defasados. Executores IGNORAM. */
  driveProjectId?: string;
  /** (F7) Fase do pipeline no momento do ENQUEUE — o MESMO valor fresco do DB
   *  que entrou no header do prompt semeado. Executores IGNORAM. */
  drivePhase?: number;
  /** (W2.3) Identidade UNICA do turno de DRIVE em voo (gerada pelo coordinator
   *  no enqueue via contador incremental deterministico do projeto). Guardada no
   *  runtime do projeto como o turno-em-voo CORRENTE; o sinal universal de fim de
   *  turno (reportDriveTurnComplete) so limpa o gate one-in-flight se o id bater
   *  com o turno corrente - assim o complete de um turno DEFASADO descartado pelo
   *  guard F7 nao libera o gate de um turno mais novo. Executores IGNORAM. */
  driveTurnId?: string;
  /** (Passo 1) EPOCA do drive no ENQUEUE: copia de `DriveState.startedAt`, que e
   *  re-ancorado atomicamente em todo engate (startDrive) e retomada
   *  (resumeDrive). O guard de dequeue descarta o turno quando a epoca corrente
   *  do projeto diverge desta — sinal INEQUIVOCO de que o drive foi parado e
   *  religado depois deste turno entrar na fila. Nao pode ser substituido por
   *  "o drive esta engajado agora?": esse predicado e estado VIVO e volta a ser
   *  verdadeiro no Retomar, ressuscitando a fila inteira. Executores IGNORAM. */
  driveEpoch?: string;
  /** SPEC chat-context-reduction 0.5/0.5.1 (S3a/S6a): token OPACO da lease
   *  interna do turno de drive (system-event). Criado pelo coordenador que
   *  semeia o turno (fireOrchestratorTurn do pipeline-drive-coordinator /
   *  fireIgnition do workflow-ignition — call sites encanados na S6a) e
   *  anexado as options junto de driveProjectId/driveTurnId. O executeQuery o
   *  registra no turn-context (variante system-event) para deriveLease (0.5.2)
   *  e gate (S4) verificarem via lease. Executores IGNORAM. NUNCA logado. */
  internalLeaseToken?: string;
  /** (S6a, 0.5.1) Coordenador da enum FECHADA que criou a lease acima. Viaja
   *  junto do token para o turn-context — permite o verify EXATO no
   *  deriveLease/gate (sem iterar a enum; achado S4-i). Executores IGNORAM. */
  leaseCoordinator?: InternalCapabilityCoordinator;
  /** (S6a, 0.5.2) Capability CONCEDIDA pela lease (`pipelineControl` no drive
   *  de pipeline, `dynamicWorkflows` no wake de workflow) — a que as efetivas
   *  do turno system-event forcam ON. Executores IGNORAM. */
  leaseCapability?: ChatCapabilityName;
  /** SPEC chat-context-reduction A.3/A.4 (S2): snapshot FINAL dos capability
   *  toggles do turno, resolvido no handler `chat:send`
   *  (resolveChatCapabilitiesForTurn: options -> persistido -> default OFF)
   *  ANTES de submitMessage. Mensagem enfileirada usa o snapshot do momento do
   *  envio (decisao A.1-6); processQueue/executores NUNCA releem DB. Consumo
   *  real (prompt/composicao/turn-context) entra em S3/S5/S6 — nesta sprint o
   *  campo so viaja. */
  featureToggles?: ChatFeatureToggles;
  /** Fence Auth v4 capturada no enqueue/entrada da lane. */
  authorizationGeneration?: number;
  attachments?: Array<{
    id: string;
    type: string;
    filename: string;
    mimeType: string;
    data: string;
    size: number;
    /** fix(vision-ux): thumbnail em data URL gerado pelo renderer no envio
     *  (imagens do desktop). Opcional; Telegram/cron nao enviam. */
    preview?: string;
  }>;
  /** SPEC vision-transcricao-imagens 3.1: quando true, o desktop NAO transcreve a
   *  imagem (o canal ja transcreveu canal-side, ex.: Telegram, que injeta o bloco
   *  no proprio texto/displayMessage antes de chamar a lane). Evita transcricao
   *  dupla. Desktop puro deixa undefined => o orquestrador transcreve. */
  skipVisionTranscription?: boolean;
  /** fix(vision-ux): metadata LEVE dos anexos de imagem (id/filename/mimeType +
   *  preview), capturada no executeQuery ANTES do strip P4 do vision e persistida
   *  pelos executores em messages.metadata junto da user message - a miniatura
   *  volta a aparecer na bolha apos rehidratacao. Executores so LEEM. */
  attachmentsMeta?: ChatAttachmentMeta[];
  /** SPEC robustez-chat SB-10 (AC-B26): hook ADITIVO de observacao dos chunks
   *  do turno. Injetado por `executeQuery` (rede de seguranca do completion:
   *  cobre os 5 runtimes despachados) e chamado pelos executores em TODO send
   *  de chunk do turno (wrapper de sessao + sends diretos de erro/session).
   *  Executores que nao o chamam ficam cobertos de forma conservadora (a rede
   *  emitiria o fallback). Nunca altera o envio: rastreio puro. */
  onStreamChunk?: (chunk: StreamChunk) => void;
}

/** media types de imagem aceitos pela API (Base64ImageSource do @anthropic-ai/sdk). */
const SDK_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type SdkImageMediaType = (typeof SDK_IMAGE_MEDIA_TYPES)[number];

/**
 * SPEC telegram-cron-compaction 8.2 (E4b, gate de spike APROVADO em
 * scratch/spike-async-iterable.mjs): imagem como content block NATIVO.
 *
 * - SEM anexo de imagem: retorna a PROPRIA string `finalMessage` (caminho
 *   byte-identico ao legado para todo fluxo texto; AC-25).
 * - COM anexo(s) de imagem: retorna um async-generator que YIELDA UM unico
 *   `SDKUserMessage` com `content: [text, image...]` e RETORNA imediatamente
 *   (iterador fechado; o SDK encerra o stdin ao fim do input, sem modo
 *   streaming pendurado - o spike provou a continuidade nos tres estados
 *   {sessionId|resume|continue} E a conclusao do turno nos tres).
 * - O `SDKUserMessage` NAO carrega identidade de sessao propria: o tipo do
 *   SDK 0.2.74 exigia `session_id` (no 0.3.257 a chave e opcional); ele segue
 *   preenchido com o MESMO `sdkThreadId` ja resolvido pela secao 4 (nunca um
 *   valor novo, payload byte-identico); a decisao de thread continua
 *   exclusivamente nas options {continue|resume|sessionId}.
 * - Elimina o mecanismo legado temp-file + tool Read: nenhum arquivo
 *   temporario de imagem e escrito no tmpdir do OS (AC-24, sem leak).
 *
 * Anexos nao-imagem sao ignorados aqui (mesmo comportamento do mecanismo
 * legado, que so processava `att.type === 'image'`).
 */
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
      text:
        finalMessage || 'O usuario enviou estas imagens. Analise cada uma e responda sobre elas.',
    },
  ];
  for (const att of images) {
    // Normaliza media types fora do dominio da API para image/png (o legado
    // gravava qualquer coisa em disco; aqui o contrato da API e explicito).
    const mediaType: SdkImageMediaType = (SDK_IMAGE_MEDIA_TYPES as readonly string[]).includes(
      att.mimeType,
    )
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
  /** message enriquecida com o bloco de transcricao (ou original em falha). */
  message: string;
  /** options ajustadas: displayMessage enriquecida + anexo de imagem removido
   *  quando o runtime nao suporta imagem nativa. */
  options: QueryOptions;
  /** aviso ao canal (P5) quando o vision falha/nao esta configurado; senao null. */
  notice: string | null;
}

/**
 * SPEC vision-transcricao-imagens 3.2: resolve a transcricao de imagens do turno
 * de DESKTOP (helper puro, testavel isolado). Independente do orquestrador (P1):
 *  - N imagens = N transcricoes concatenadas (SPEC 5: loop sequencial simples).
 *  - injeta o bloco de transcricao (VISION_TRANSCRIPTION_MARKER, via
 *    buildTranscriptionBlock) em `message` E em `displayMessage` (a mensagem
 *    PERSISTIDA e a enriquecida: sobrevive a compactacao e entra na historia dos
 *    runtimes sem visao nativa).
 *  - anexo NATIVO de imagem so segue quando o runtime suporta imagem (P4); runtime
 *    sem visao nativa recebe so o texto (anexos de imagem sao removidos).
 *  - falha/unconfig do vision (P5): retorna `notice` (o caller emite ao canal) e o
 *    turno segue com o texto ORIGINAL. NUNCA troca de provider.
 *  - `skipVisionTranscription` (Telegram, que ja transcreveu canal-side): pula a
 *    transcricao mas ainda aplica a regra P4 do anexo nativo.
 */
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

    // TEMPORARIO - smoke-audit (AC-V8): visionUsed distingue transcrito de falha.
    smokeAudit('attachment_capability', {
      lane: laneName,
      runtime,
      supported: supportsNativeImage,
      noticeSent: !visionUsed,
      visionUsed,
    });
  }

  // P4: anexo NATIVO de imagem so segue quando o runtime suporta.
  if (imageAttachments.length > 0 && !supportsNativeImage) {
    outOptions = {
      ...outOptions,
      attachments: (outOptions.attachments ?? []).filter((att) => att.type !== 'image'),
    };
  }

  return { message: outMessage, options: outOptions, notice };
}

/**
 * SPEC-001 §8 router. Dispatches EVERY lane (desktop + telegram + cron) through
 * resolveOrchestratorSelection to one of the runtime executors:
 *   - claude-sdk        -> executeClaudeSdkQuery (preserved verbatim from the
 *                          pre-SPEC executeQuery body; see Rule #1 in §2).
 *   - claude-compat-sdk -> executeClaudeCompatSdkQuery (S10).
 *   - codex-sdk         -> executeCodexSdkQuery (S9).
 *   - kimi-sdk          -> executeKimiSdkQuery.
 *   - lion-sdk          -> executeLionSdkQuery (S11).
 *
 * SPEC orquestrador-fonte-unica 2.1: o bypass `if (lane !== desktopLane)` (Rule
 * #7 legada) morreu; TODA lane resolve a fonte unica e passa pelo MESMO switch.
 *
 * SPEC orquestrador-fonte-unica 2.2: o resolver NAO e mais engolido aqui - o
 * erro tipado (InvalidOrchestratorSelectionError) PROPAGA (throw) ao caller. O
 * tratamento por lane e do caller: desktop (processQueue) emite chunk tipado e
 * segue a fila; telegram-bridge captura por instanceof; scheduler marca failed.
 *
 * SPEC orquestrador-fonte-unica 3 (S3): TODA lane despacha QUALQUER runtime. O
 * gate temporario S2->S3 (que barrava lane nao-desktop em runtime != claude-sdk)
 * foi REMOVIDO: os sub-SDKs agora recebem a lane e mantem abort/thread NELA, sem
 * global de modulo disputado entre desktop/telegram/cron.
 */
/**
 * Carimbo de data/hora prepended a mensagem de CADA turno (prompt-cache).
 *
 * A hora saiu do system prompt (buildRuntimeSection): la ela mudava a cada
 * minuto e, como claude/compat remontam o system prompt POR TURNO, invalidava
 * o prefixo do cache Anthropic (system + historico inteiro) em praticamente
 * todo turno; nos runtimes por-thread (codex/kimi) ela congelava errada na
 * criacao. Aqui ela viaja na MENSAGEM nova - que nunca esta cacheada de
 * qualquer forma (~15 tokens) - e de quebra da ao modelo a linha do tempo da
 * conversa (cada mensagem carimbada com o momento em que foi enviada).
 */
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
  lane: SdkLane = desktopLane,
): Promise<void> {
  if (privilegedAccessGate.isBound) {
    const generation =
      options.authorizationGeneration ?? privilegedAccessGate.captureGenerationIfBound();
    if (generation === null) throw new PrivilegedAccessDeniedError();
    privilegedAccessGate.assertAllowed(generation);
    options = { ...options, authorizationGeneration: generation };
  }
  // SPEC orquestrador-fonte-unica 2.1/2.2: sem bypass e sem engolir o erro. O
  // throw sobe ao caller; as filas telegram/cron ja seguram unhandled rejection
  // (chain = job.catch(() => {}) + return job), entao o erro chega ao
  // bridge/scheduler intacto.
  const selection = await resolveOrchestratorSelection({
    surface: 'main-chat',
    requestedModel: options.model,
    agentModel: options.agentId ? getAgent(options.agentId)?.model : undefined,
  });

  // TEMPORARIO - smoke-audit: selection resolvida do turno (fonte unica).
  smokeAudit('turn_selection', {
    lane: lane.name,
    runtime: selection.runtime,
    provider: selection.provider,
    model: selection.model,
    source: selection.source,
    sessionId: options.sessionId ?? null,
  });

  // fix(vision-ux): captura a metadata LEVE dos anexos de imagem ANTES do strip
  // P4 do vision (que remove anexos para runtime sem visao nativa). A miniatura
  // e APRESENTACAO, nao capability: precisa sobreviver em qualquer runtime. Os
  // executores persistem options.attachmentsMeta junto da user message. Sem
  // anexo com preview (Telegram/cron/turno so-texto) e undefined => caminho
  // atual byte-identico.
  {
    const attachmentsMeta = buildUserAttachmentsMeta(options.attachments);
    if (attachmentsMeta) options = { ...options, attachmentsMeta };
  }

  // ---- SPEC vision-transcricao-imagens 3.2: transcricao padrao de imagens ----
  // Contrato do desktop, espelho do Telegram (3.1). Toda a logica vive no helper
  // puro resolveDesktopVisionTurn (testavel sem drenar o executor); aqui so a
  // chamada + o emit de aviso reutilizando o chunk `text` existente (golden IPC
  // intacto, ZERO canal novo). NAO toca o switch de runtimes nem o protocolo de
  // stream (zona sagrada). O Telegram transcreve canal-side e passa
  // skipVisionTranscription=true para nao duplicar.
  {
    const resolved = await resolveDesktopVisionTurn(message, options, selection.runtime, lane.name);
    message = resolved.message;
    options = resolved.options;
    if (resolved.notice) {
      // P5: nunca silencio. Avisa no canal e segue so com o texto.
      sendStream(
        getWindow,
        options.silent,
        { type: 'text', content: resolved.notice },
        options.authorizationGeneration,
      );
      logger.warn(
        { runtime: selection.runtime, lane: lane.name },
        'Vision indisponivel no desktop; turno segue so com texto (P5)',
      );
    }
  }

  // ---- SPEC orquestrador-fonte-unica 3.6: effort por capability ----
  // Quando o runtime configurado NAO suporta effort mas ha um effort setado, o
  // executor IGNORA (o effort so e lido no executor claude-sdk, que suporta). Aqui
  // so um LOG DEBUG (sem warning por turno): a nota visivel ao usuario vive na UI
  // de Settings (controle desabilitado com "nao suportado pelo runtime X").
  if (!runtimeSupportsEffort(selection.runtime)) {
    const configuredEffort = (getSetting('orchestrator_effort') || '').trim();
    if (configuredEffort) {
      logger.debug(
        { runtime: selection.runtime, effort: configuredEffort },
        'Effort ignorado: runtime configurado nao suporta o controle (3.6)',
      );
    }
  }

  // ---- Hook ADITIVO F6 (A2, SPEC spec-chat-repo-codegraph.md secao 9 / Z2) ----
  // Seta o contexto de TURNO do repo-graph (sessionId REAL + runtime) e resolve
  // o repo ativo ANTES do despacho; o clear roda no finally, DEPOIS do dispatch
  // do runtime retornar (Z2). ZERO mudanca no control-flow do query() (D6): o
  // switch e os executores ficam identicos; sem repo/onboarding o fluxo atual
  // segue INTOCADO (prepareRepoGraphTurn nao seta contexto e nunca lanca).
  const repoTurnSessionId = options.sessionId ?? getActiveChatSession()?.id ?? null;
  // ---- Hook ADITIVO S3a (SPEC chat-context-reduction 0.2 + 0.7 itens 1/2) ----
  // Identidade CANONICA do turno de chat: turnId cunhado por crypto (1 por
  // turno), turn-context registrado em RAM e turno marcado ATIVO na lane; o
  // clear roda no finally, DEPOIS do dispatch retornar (mesmo padrao do hook
  // F6 acima). SHADOW: nenhum gate le isso ainda (gate = S4); ZERO mudanca no
  // control-flow do query() — switch e executores identicos. Miss TOLERADO:
  // sessionId nao resolvido (1a mensagem de sessao NOVA) → pula o registro
  // (sessao nova nasce off/off e helpers gated nem sao compostos — decisao do
  // ponto do hook sancionada no plano S3).
  const capabilityLane = toChatLane(lane.name);
  const capabilityTurnId = crypto.randomUUID();
  // ---- SPEC robustez-chat SB-10 (V8, AC-B26): rede de seguranca do turno ----
  // Armada AQUI, no despacho de executeQuery, para cobrir os 5 RUNTIMES (nao so
  // o claude-sdk): cada executor notifica os chunks do turno via
  // options.onStreamChunk (hook aditivo); o completion (finally abaixo) decide
  // se o turno "morreu mudo" e emite o {type:'error', code:'LLM-EMPTY'} de
  // fallback. Armada DEPOIS do resolver (selection ja resolvida): o erro tipado
  // do resolver segue o contrato existente do processQueue, sem chunk duplo.
  // O hook pre-existente do caller (se houver) e encadeado, nunca substituido.
  const chatTurnFlags = createChatTurnStreamFlags();
  let chatTurnSessionId: string | null = repoTurnSessionId;
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
      // Campos de Fase B (cwd/permissionProfile/allowedServerIds) preenchidos
      // AQUI (S3a da Fase B): o motor do sandbox deriva TUDO do turn-context —
      // sem eles, todo script morre fail-closed. Lease/drive IDs so
      // viajam em turno system-event (0.5.1) — na S6a incluindo coordinator +
      // capability concedida (verify EXATO no deriveLease/gate); capabilities
      // = snapshot do turno (S2) ou default OFF (A.4).
      //
      // Fail-safe do TTL (S6a, achado S4-iv): getSetting LANCANDO nao pode
      // matar o turno (um DB quebrado derrubaria drive/workflow — regra
      // maxima). Erro -> TTL default e o turno segue.
      let capabilityTurnTtlMs: number = DEFAULT_CHAT_TURN_CONTEXT_TTL_MS;
      try {
        capabilityTurnTtlMs = Number(getSetting(CHAT_TURN_CONTEXT_TTL_SETTING_KEY));
      } catch (err) {
        logger.warn(
          { err },
          'getSetting(chat_turn_context_ttl_ms) falhou; usando TTL default do turn-context (fail-safe S6a)',
        );
      }
      // Fase B (0.2/B.2): cwd = repo ativo do turno (setado por
      // prepareRepoGraphTurn acima) OU o default seguro do chat; profile do
      // chat = guard (o SETTING permission:bypass governa no dispatcher, igual
      // ao Bash — bypass NUNCA e gravado aqui); allowedServerIds = escopo MCP
      // da sessao pela MESMA composicao dos executores (fullCatalog cobre
      // index E full; capabilities = snapshot do turno). Falha na composicao
      // NAO derruba o turno (regra maxima): escopo vazio = mcp_invoke do
      // script nega tudo por escopo, file ops seguem.
      const isRemoteCapabilityLane = capabilityLane === 'telegram' || capabilityLane === 'cron';
      const capabilityTurnCwd = capabilityLane === 'cron'
        ? getCronCwd()
        : getRepoGraphTurnContext()?.canonicalRootPath ?? getAgentCwd(false);
      let capabilityTurnAllowedTools = isRemoteCapabilityLane ? [] : getEnabledTools();
      const capabilityTurnReadRoots = isRemoteCapabilityLane ? [] : [capabilityTurnCwd];
      const capabilityTurnWriteRoots = isRemoteCapabilityLane
        ? []
        : (getSetting('onboarding_completed') === 'true' ? [capabilityTurnCwd] : []);
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
          logger.warn(
            { err },
            'composicao do escopo MCP do turno falhou; allowedServerIds vazio (fail-safe Fase B)',
          );
        }
      }
      const capabilityPermissionGuard = createPermissionGuard(getWindow, {
        isOnboarding: getSetting('onboarding_completed') !== 'true',
      });
      registerChatCapabilityTurn(
        {
          surface: 'chat',
          sessionId: repoTurnSessionId,
          turnId: capabilityTurnId,
          origin: options.origin ?? 'user',
          capabilities: options.featureToggles ?? CHAT_CAPABILITIES_DEFAULT_OFF,
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
    // ---- Preambulo [Contexto: data hora] do turno (prompt-cache) ----
    // Ultima transformacao antes do dispatch: vale para TODO runtime e toda
    // lane. displayMessage preserva o texto original ANTES do carimbo - o
    // preambulo nao aparece na UI (executores persistem displayMessage ??
    // message) e NUNCA reescreve mensagens antigas (o historico persistido/
    // cacheado segue byte-identico; so a mensagem nova carrega o carimbo).
    if (options.displayMessage === undefined) {
      options = { ...options, displayMessage: message };
    }
    message = `${buildTurnTimestampPreamble()}\n\n${message}`;

    // SPEC orquestrador-fonte-unica 3: todos os executores recebem a lane
    // (assinatura (message, options, getWindow, lane, selection)) e mantem
    // abort/thread nela.
    switch (selection.runtime) {
      case 'claude-sdk':        return await executeClaudeSdkQuery(message, options, getWindow, lane, selection);
      case 'claude-compat-sdk': return await executeClaudeCompatSdkQuery(message, options, getWindow, lane, selection);
      case 'codex-sdk':         return await executeCodexSdkQuery(message, options, getWindow, lane, selection);
      case 'kimi-sdk':          return await executeKimiSdkQuery(message, options, getWindow, lane, selection);
      case 'grok-sdk':          return await executeGrokSdkQuery(message, options, getWindow, lane, selection);
      // SPEC cursor-runtime F2 (E9): driver de chat do runtime Cursor
      // (sidecar @cursor/sdk + ponte de customTools + rules materializadas).
      case 'cursor-sdk':        return await executeCursorSdkQuery(message, options, getWindow, lane, selection);
      case 'lion-sdk':          return await executeLionSdkQuery(message, options, getWindow, lane, selection);
    }
  } finally {
    clearRepoGraphTurnSession();
    // S3a: clear da identidade do turno (o clear do active-turn e guardado por
    // turnId — um finally atrasado de turno antigo NAO derruba o turno novo).
    if (repoTurnSessionId && capabilityLane) {
      clearChatCapabilityTurn({ sessionId: repoTurnSessionId, turnId: capabilityTurnId });
      clearActiveChatTurn({
        sessionId: repoTurnSessionId,
        lane: capabilityLane,
        turnId: capabilityTurnId,
      });
    }
    // SPEC robustez-chat SB-10 (V8, AC-B26): rede de seguranca no COMPLETION
    // de executeQuery — SO na lane DESKTOP (telegram/cron tem contrato proprio
    // via reject do Promise do job) e nao-silent. Se o turno terminou (retorno
    // OU throw do executor) sem chunk de erro, sem conteudo e sem `done`
    // (morreu mudo — o renderer ficaria preso em streaming), emite o
    // `{type:'error', code:'LLM-EMPTY'}` de fallback, cobrindo os 5 runtimes.
    // `sawErrorChunk` evita emitir 2x (a rede interna do claude-sdk / o AC-B4b
    // / o catch dos executores notificam o hook). Best-effort: nunca lanca.
    if (
      shouldEmitChatTurnFallbackError(chatTurnFlags, {
        isDesktopLane: lane === desktopLane,
        silent: options.silent === true,
      })
    ) {
      const fallback = chatTurnFallbackError(`lane=${lane.name} runtime=${selection.runtime}`);
      logger.warn(
        { sessionId: chatTurnSessionId, lane: lane.name, runtime: selection.runtime },
        'turno terminou sem chunk de erro, sem conteudo e sem done — emitindo LLM-EMPTY de fallback (AC-B26)',
      );
      sendStream(getWindow, options.silent, {
        type: 'error',
        code: fallback.code,
        error: fallback.userMessage,
        ...(chatTurnSessionId ? { sessionId: chatTurnSessionId } : {}),
      }, options.authorizationGeneration);
    }
  }
}

/**
 * (A2) Resolucao do repo ativo do turno (hook F6): session_active_repository ->
 * repo -> status com check BARATO de staleness (3.5, throttle 5min via
 * engine.getSessionState). Graph ready/stale -> monta o RepoChatContext e
 * deixa no turn-context para a secao condicional de prompt do runtime da vez.
 * Sem repo ativo / onboarding / graph nao consultavel -> nao seta nada (AC-1:
 * prompt sem secao, zero chunk, turn_usage vazia). NUNCA lanca (best-effort).
 */
async function prepareRepoGraphTurn(sessionId: string): Promise<void> {
  try {
    if (getSetting('onboarding_completed') !== 'true') return;
    // Dynamic import: ipc/repo-graph puxa electron + CRUD de db.ts; o import
    // lazy mantem testes existentes do orchestrator (mocks parciais) intactos.
    const { getRepoGraphEngine } = await import('./ipc/repo-graph');
    const state = getRepoGraphEngine().getSessionState(sessionId);
    const repo = state.repository;
    if (!repo) return;
    if (repo.status !== 'ready' && repo.status !== 'stale') return;
    setRepoGraphTurnContext({
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
  lane: SdkLane = desktopLane,
  selection?: OrchestratorSelection,
): Promise<void> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    const missingKeyChunk: StreamChunk = { type: 'error', error: 'API key nao configurada. Va em Settings.' };
    // SB-10 (AC-B26): notifica a rede de seguranca do executeQuery (erro ja
    // surfacado — o completion nao deve emitir o fallback por cima).
    options.onStreamChunk?.(missingKeyChunk);
    sendStream(getWindow, options.silent, missingKeyChunk, options.authorizationGeneration);
    return;
  }

  // ---- Session management ----
  let sessionId = options.sessionId;
  let shouldContinueSession = false;

  if (!sessionId) {
    // SPEC telegram-cron-compaction 1.4 (guard de sessao explicita): telegram e
    // cron EXIGEM options.sessionId. Sem fallback para getActiveSession() (que
    // casa sessoes chat/manual/telegram e vazaria a sessao do desktop para
    // outra lane). O lookup abaixo so e alcancavel pela desktopLane.
    if (lane !== desktopLane) {
      const error = `Lane '${lane.name}' exige options.sessionId explicito (guard de sessao, SPEC 1.4)`;
      logger.error({ lane: lane.name }, error);
      throw new Error(error);
    }
    const activeSession = getActiveChatSession();

    if (activeSession) {
      sessionId = activeSession.id;
      // Existing active session: continue the SDK conversation
      shouldContinueSession = true;
    } else {
      sessionId = crypto.randomUUID();
      createSession(sessionId, '');
      // Brand new session: don't continue
      shouldContinueSession = false;
    }
  } else {
    // SessionId was passed explicitly (follow-up message)
    // Only continue if session already has messages (not freshly created after compaction/clear)
    const existingMessages = getSessionMessages(sessionId);
    shouldContinueSession = existingMessages.length > 0;
    if (options._forceNewSession) {
      shouldContinueSession = false;
      logger.info({ sessionId }, 'Forced fresh SDK session (retry after resume failure)');
    } else if (!shouldContinueSession) {
      logger.info({ sessionId }, 'Session has no messages, starting fresh SDK session (post-compaction)');
    }
  }

  // SPEC telegram-cron-compaction 4.1 (resolver UNICO de thread SDK): o id da
  // thread do SDK desacopla do sessionId do DB. Carrega a sessao UMA vez e
  // resolve `sdkThreadId = session?.sdkSessionId ?? sessionId`. Com
  // sdk_session_id NULL (todo desktop, todo cron, telegram nao-compactado) o
  // valor e o proprio sessionId e as decisoes {continue|resume|sessionId}
  // ficam byte-identicas as anteriores (SPEC 4.2 / AC-12). O sessionId do DB
  // permanece a chave de TODO o resto: insertMessage, tokens, stream de UI,
  // artifacts, title. Aplicacao parcial e proibida (o fast-path continue:true
  // nunca casaria): os TRES pontos de thread (seletor abaixo, escrita da lane
  // no sucesso, retry pos-falha-de-resume) usam sdkThreadId.
  const sessionRow = getSession(sessionId);
  const sdkThreadId = sessionRow?.sdkSessionId ?? sessionId;

  // SPEC 4.3 (primeiro turno pos-seed): pending_seed nao-nulo (setado pela
  // compactacao in-place, SPEC 5) forca thread SDK NOVA - sobrepoe o gate de
  // getSessionMessages().length acima (as mensagens do DB nao sao apagadas).
  // O seed e injetado como preambulo do prompt (abaixo) e consumido
  // atomicamente no sucesso do turno; falha preserva o seed para o proximo.
  const pendingSeed = sessionRow?.pendingSeed ?? null;
  if (pendingSeed) {
    shouldContinueSession = false;
    logger.info(
      { sessionId, sdkThreadId },
      'pending_seed presente: thread SDK nova com seed de compactacao (SPEC 4.3)',
    );
  }

  // Inform renderer which session is active
  options.onStreamChunk?.({ type: 'session', content: sessionId });
  sendStream(
    getWindow,
    options.silent,
    { type: 'session', content: sessionId },
    options.authorizationGeneration,
  );

  // Wrapper que inclui sessionId em todos os chunks
  // SPEC robustez-chat SB-10 (AC-B26): o wrapper tambem RASTREIA os chunks do
  // turno (error/done/conteudo) para a rede de seguranca do completion —
  // rastreio puro, aditivo; o envio segue byte-identico. Alem das flags locais
  // (rede interna deste executor), notifica o hook do executeQuery
  // (options.onStreamChunk) para a rede de completion que cobre os 5 runtimes.
  const turnStreamFlags = createChatTurnStreamFlags();
  const sendSessionStream = (chunk: StreamChunk) => {
    trackChatTurnChunk(turnStreamFlags, chunk.type);
    options.onStreamChunk?.({ ...chunk, sessionId });
    sendStream(
      getWindow,
      options.silent,
      { ...chunk, sessionId },
      options.authorizationGeneration,
    );
  };

  // SPEC K2 v2 (secao 5.2): turnIndex DERIVADO DO DB. No insert da user message
  // usamos getTurnIndexForUserMessage (posicao 1-based da mensagem); no retry /
  // _forceNewSession reutilizamos o ultimo turno (getLatestUserTurnIndex), sem
  // incrementar — e a mesma pergunta sendo refeita. O backend e a fonte unica.
  let currentTurnIndex = 0;

  // SPEC K2: emit aditivo de atividade ao vivo no canal chat:stream existente
  // (sendSessionStream ja injeta sessionId). v2 (secao 5.1): o corpo passa a
  // DELEGAR ao sink recordActivity (stream + persistencia); os sites de chamada
  // ficam inalterados. Control-flow do query() intacto.
  const emitActivity = (a: LiveActivityEvent) =>
    recordActivity(sessionId, currentTurnIndex, a, sendSessionStream);

  // K1/R3 (pipe-control): turno semeado pelo drive do orquestrador NAO vira bolha de
  // user; so a resposta do assistant streama. Reutiliza o ultimo turno (NAO incrementa).
  const skipUserPersistence =
    options.origin === 'system-event' || options.skipUserMessagePersistence === true;

  // Skip inserting user message on retry (already inserted in the first attempt)
  if (skipUserPersistence) {
    currentTurnIndex = getLatestUserTurnIndex(sessionId);
  } else if (!options._forceNewSession) {
    const visibleUserMessage = options.displayMessage ?? message;
    // fix(vision-ux): metadata leve dos anexos junto da user message (miniatura
    // sobrevive a rehidratacao). Sem attachmentsMeta = insertMessage identico.
    const userMessageId = persistUserChatMessage(sessionId, visibleUserMessage, options.attachmentsMeta);
    currentTurnIndex = getTurnIndexForUserMessage(sessionId, userMessageId);
    ensureInitialSessionTitle(sessionId, visibleUserMessage);
  } else {
    // Retry / _forceNewSession: reutiliza o ultimo turno (NAO incrementa).
    currentTurnIndex = getLatestUserTurnIndex(sessionId);
  }

  const agent = options.agentId ? getAllAgents().find((a) => a.id === options.agentId) : undefined;
  // SPEC orquestrador-fonte-unica 2.3/2.4: cadeia = SO `selection.model`. O
  // override por agente (`agent?.model || ...`) que vencia por fora foi
  // oficializado dentro do resolver (Rule #3 nova, source:'agent'): quando o
  // agente tem modelo, o resolver ja o colocou em selection.model. `selection`
  // e obrigatorio quando vem do router (o resolver garante ou lanca). O `?.`
  // cobre so o caller direto de teste que passa selection=undefined (nunca a
  // producao, que sempre vem por executeQuery). `agent` segue lido abaixo apenas
  // para o campo `agentModel` do log (auditoria), NAO para escolher o modelo.
  const selectedModel = selection?.model ?? options.model;
  const model = selectedModel ?? 'unknown';

  // Reasoning effort do orquestrador. Escopo: SOMENTE esta funcao (runtime
  // claude-sdk) -- compat/codex/lion sao funcoes separadas e nao recebem.
  // 'high' e o default documentado do SDK (behavior-preserving). 'max' era o
  // tier mais alto do 0.2.74; o 0.3.257 aceita tambem 'xhigh', mas a setting
  // segue nos 4 tiers de hoje (sem mudanca de comportamento).
  const orchestratorEffort =
    (getSetting('orchestrator_effort') as 'low' | 'medium' | 'high' | 'max' | undefined) ||
    'high';

  // SPEC orquestrador-fonte-unica 2.1: o log reporta o `source` REAL da selection
  // em qualquer lane; o rotulo de fallback 'background-lane' (marcador do bypass
  // legado) saiu. O '?? unknown' cobre so o caller direto de teste (selection
  // ausente); a producao sempre chega aqui via executeQuery com selection.
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

  // Track which agent is active so the knowledge-base MCP subprocess can resolve the agent scope
  if (options.agentId) {
    setActiveAgentId(options.agentId);
  }

  // Build system prompt with modular architecture
  const isOnboarding = getSetting('onboarding_completed') !== 'true';
  // (S5b, SPEC chat-context-reduction A.6) Capabilities EFETIVAS do turno de
  // chat, lidas do turn-context registrado pelo hook S3a — MESMO padrao do
  // repo-graph (getRepoGraphTurnContext abaixo): leitura aditiva dentro do
  // executor, zero mudanca de control-flow. SO na lane desktop (A.9);
  // telegram/cron ou turno sem turn-context -> undefined = default S5a
  // byte-identico (prompt legado + composicao sem filtro).
  const chatCaps =
    lane.name === 'desktop'
      ? (() => {
          const t = getActiveChatTurnByLane('desktop');
          const ctx = t ? getChatCapabilityTurn(t) : undefined;
          return ctx ? computeEffectiveCapabilitiesForTurn(ctx) : undefined;
        })()
      : undefined;
  // (A2) appendRepoGraphSection: secao condicional do repo ativo do turno —
  // '' sem repo (prompt byte-identico, AC-1); setada pelo hook F6.
  const fullSystemPrompt = appendRepoGraphSection(
    buildSystemPrompt(options.agentId, {
      mode: 'full',
      isOnboarding,
      model,
      capabilities: chatCaps,
    }),
  );

  const permissionGuard = createPermissionGuard(getWindow, { isOnboarding });
  lane.currentAbortController = new AbortController();

  // SPEC telegram-cron-compaction 8.2 (E4b): anexos de imagem NAO viram mais
  // temp file + instrucao de Read; entram como content blocks nativos via
  // buildSdkPrompt no site do query() abaixo. finalMessage segue sendo o
  // texto puro (mensagem do usuario + preambulos).
  let finalMessage = message;

  // SPEC telegram-cron-compaction 4.3: injeta o pending_seed como PREAMBULO do
  // texto enviado ao SDK, ANTES da mensagem do usuario (mesmo padrao do
  // TELEGRAM_CONTEXT). displayMessage/persistencia NAO incluem o seed (a user
  // message ja foi persistida acima a partir de options.displayMessage ??
  // message). O seed entra exatamente uma vez: clearSessionPendingSeed roda no
  // sucesso do turno; falha preserva para a proxima tentativa.
  if (pendingSeed) {
    finalMessage = `${pendingSeed}\n\n${finalMessage}`;
  }

  if (isOnboarding) {
    logger.info({ promptLength: fullSystemPrompt.length, hasTools: false }, 'Onboarding: text-only prompt, no tools');
  }

  // Resolve MCP server config for this agent (or all active servers if no agentId)
  let mcpServers: Record<string, McpServerConfig> | undefined =
    await getMCPConfigForAgent(options.agentId, {
      surface: 'claude-sdk',
      capabilities: chatCaps,
    });

  // Auto-inject local-agents MCP server when any agent uses local or external runtime
  const allAgents = getAllAgents();
  const hasLocalAgent = allAgents.some((a: AgentConfig) => a.isActive && a.runtime === 'local');
  const hasExternalAgent = allAgents.some((a: AgentConfig) => a.isActive && a.runtime === 'external');

  if (hasLocalAgent || hasExternalAgent) {
    const resolvedRuntime = resolveMcpServerRuntime(
      'local-agents',
      'dist/index.js',
      { cwd: process.cwd() },
    );
    const resolvedPath = resolvedRuntime.entryPath ?? resolvedRuntime.candidates[0];
    if (!resolvedRuntime.command) {
      throw new Error('Runtime Node do MCP local-agents não foi resolvido');
    }

    const lionclawHome = getLionClawHome();

    // Resolve API keys for external agents and pass as env vars
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

  // Auto-inject codex-agents in-process MCP server when any codex agent is active.
  // Built lazily on first use because the SDK is ESM-only.
  const hasCodexAgent = allAgents.some((a: AgentConfig) => a.isActive && a.runtime === 'codex');
  const repoChatContext =
    lane.name === 'desktop' ? getRepoGraphTurnContext() ?? undefined : undefined;
  const subagentCwd = lane === cronLane
    ? getCronCwd()
    : repoChatContext?.canonicalRootPath ?? getAgentCwd(isOnboarding);
  const subagentAbortController = lane.currentAbortController;
  if (!subagentAbortController) throw new Error('Turno sem AbortController para subagentes.');
  const subagentDispatchContext = createSubagentDispatchContext({
    ownerKind: 'chat',
    ownerId: sessionId,
    sessionId,
    lane: lane.name === 'telegram' || lane.name === 'cron' ? lane.name : 'desktop',
    surface: 'claude-sdk',
    cwd: subagentCwd,
    readRoots: [subagentCwd],
    writeRoots: isOnboarding ? [] : [subagentCwd],
    allowedTools: await resolveSubagentHostAllowedTools(
      getEnabledTools(),
      Object.keys(mcpServers ?? {}),
    ),
    allowedMcpServerIds: Object.keys(mcpServers ?? {}),
    permission: PERM_DEFAULT_WITH_GUARD(permissionGuard),
    parentAbortSignal: subagentAbortController.signal,
    abortOwner: (reason) => subagentAbortController.abort(reason),
    inheritedEffort: resolveChatInheritedEffort(),
  });
  if (hasCodexAgent) {
    const codexServerConfig: McpSdkServerConfigWithInstance = await getCodexAgentsServer(
      subagentDispatchContext,
    );
    if (mcpServers) {
      if (!mcpServers['codex-agents']) {
        mcpServers['codex-agents'] = codexServerConfig;
      }
    } else {
      mcpServers = { 'codex-agents': codexServerConfig };
    }
  }

  // pipeline-control (I6, cleanup "um MCP so"): a porta in-process foi removida.
  // As tools pipeline_* chegam ao orquestrador via o subprocess MCP
  // `lionclaw-pipeline-control` (visibleTo 'all', seam unico para todos os
  // runtimes); o gate de WRITE/caller vive em local-ipc/jsonrpc-methods.ts.

  // Pre-compute subagent definitions before entering the SDK query (async-safe).
  // (A3, 11.1) RepoChatContext do turno (setado pelo hook F6) SO na lane
  // desktop: o turn-context e estado do turno do chat; as lanes telegram/cron
  // seguem com definitions identicas as atuais.
  const agentDefinitions = isOnboarding
    ? {}
    : await buildAgentDefinitions(repoChatContext, subagentDispatchContext);

  // TEMPORARIO - smoke-audit: par turn_start/turn_done do turno claude-sdk.
  // turnOk vira true no ponto de sucesso (thread SDK viva) e e reportado no
  // finally, cobrindo sucesso, erro e abort.
  let turnOk = false;
  const nativeTaskRootExecutionId = subagentDispatchContext.rootExecutionId;
  smokeAudit('turn_start', { lane: lane.name, sessionId });

  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    resetArtifactDetector();

    let assistantContent = '';
    // Ordem canonica do turno para reidratacao: o offset e medido AQUI, antes
    // do tool_call, sobre o mesmo assistantContent que sera persistido.
    const persistedTimelineToolCalls: PersistedTimelineToolCall[] = [];
    let inTool = false;
    let currentToolName: string | null = null;
    // SPEC K2: bookkeeping da arvore de atividade (tools + aninhamento sob o subagente ativo).
    let currentParentToolUseId: string | null = null;
    let currentToolActivityId: string | null = null;
    let toolActivitySeq = 0;
    // SPEC K2 v2 (secao 5.3): mapa tool_use_id -> toolName. O resultado da tool
    // (captureToolResult sites) chega sem o nome; este mapa, preenchido no
    // assistant-block onde o nome+input existem, permite derivar `changed`.
    const toolNameById = new Map<string, string>();
    // Collect artifacts so they can be persisted alongside the message in SQLite
    const collectedArtifacts: ArtifactData[] = [];
    // Token tracking (input includes cache_read + cache_creation)
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
    // Contexto VIVO da thread do orquestrador (contador ativo, SET absoluto no
    // sucesso do turno). Captura o usage da ULTIMA request do agente PRINCIPAL
    // (parent_tool_use_id ausente): input real + cache lido + cache criado da
    // ultima message_start, mais o output da ultima message_delta. As requests
    // de subagente (parent_tool_use_id setado) rodam em threads separadas e NAO
    // representam o contexto vivo desta sessao. -1 = nenhum usage capturado
    // (edge): nesse caso NAO seta e o valor anterior fica preservado.
    let lastMainContextInput = -1;
    let lastMainOutput = 0;

    // Subagent token tracking: tool_use_id -> accumulated tokens
    const subagentTokens = new Map<string, {
      agentId: string | null;
      agentName: string | null;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      requestCount: number;
    }>();

    // Task lifecycle: tool_use_id -> task metadata
    const taskMap = new Map<string, {
      taskId: string;
      description: string;
      agentId: string | null;
      executionId?: string;
    }>();
    // Bridge variable between SubagentStart hook and task_started event
    let pendingAgentId: string | null = null;

    /**
     * EXCECAO D6 (SPEC-refactor-pipelines.md linhas 241-257):
     * Chat orchestrator usa query() direto em vez de executeAgent porque tem
     * necessidades próprias: fila de mensagens, subagent definitions, artifact
     * detector, canUseTool customizado, calculateCost próprio.
     *
     * NÃO migrar para executeAgent.
     */
    const q = query({
      // SPEC 8.2 (E4b): texto puro = a PROPRIA string finalMessage (byte-identico,
      // AC-25); com imagem = async-generator de 1 SDKUserMessage com content
      // blocks nativos, session_id = sdkThreadId resolvido (AC-24).
      prompt: buildSdkPrompt(finalMessage, options.attachments, sdkThreadId),
      options: {
        // No app empacotado, o engine Claude Code (binario nativo do pacote
        // claude-agent-sdk-<plat>-<arch>) fica fora do ASAR (asarUnpack) e o
        // path chega explicito aqui: o SDK usa spawn, que nao abre arquivo
        // dentro do asar. Mesma resolucao dos executores cloud/pipeline.
        ...getClaudeSdkProcessOptions(),
        // SPEC telegram-cron-compaction 1.5 (seletor de CWD 3-vias): cron roda
        // em ~/.lionclaw/cron (persona de worker); desktop E telegram rodam em
        // ~/.lionclaw (mesma persona principal, zero drift por construcao).
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
              // Tools come from user settings (configurable in Settings > Ferramentas).
              // GUARD_GATED_TOOLS (Bash/Write/Edit) ficam FORA de allowedTools
              // para serem roteadas ao canUseTool/guard (estar em allowedTools
              // auto-aprovaria sem consultar o guard). Continuam disponiveis.
              // D7/D8 (SPEC agent-sdk-0.3): mesma expressao de hoje, so o nome
              // TodoWrite traduzido para as Task tools do engine; o que o
              // engine 2.1.257 passou a expor alem do 2.1.74 e bloqueado por
              // disallowedTools (lista fechada), nunca por lista positiva.
              allowedTools: toSdkToolNames(getEnabledTools().filter((t) => !GUARD_GATED_TOOLS.includes(t))),
              disallowedTools: [...SDK_DISALLOWED_TOOLS],
              // permissionMode 'default' (nao bypass): o SDK consulta o
              // canUseTool/guard para cada tool. O bypass total agora vive
              // DENTRO do guard (setting permission:bypass), fonte unica de
              // verdade compartilhada com compat e lion-sdk. Assim o toggle no
              // menu Permissoes controla a confirmacao de acoes destrutivas
              // sem precisar pular o guard no nivel do SDK.
              permissionMode: 'default' as const,
              settingSources: ['project', 'user'],
              canUseTool: (tool: string, input: Record<string, unknown>) => permissionGuard(tool, input),
              // Desde o SDK 0.2.74 (mantido no 0.3.257) `prompt` e obrigatorio
              // no tipo AgentDefinition, embora o engine continue aceitando a
              // chave ausente para herdar o prompt pai. Preservamos o payload
              // historico e estreitamos so na fronteira.
              agents: agentDefinitions as Record<string, AgentDefinition>,
              hooks: {
                SubagentStart: [{
                  hooks: [async (input: Record<string, unknown>) => {
                    const agentId = typeof input['agent_type'] === 'string'
                      ? input['agent_type']
                      : String(input['agent_id'] ?? '');
                    const reservationContext = typeof input['agent_id'] === 'string'
                      ? { ...subagentDispatchContext, depth: MAX_SUBAGENT_DEPTH }
                      : subagentDispatchContext;
                    const refusal = reserveSubagentInvocation(reservationContext, agentId);
                    if (refusal) return { continue: false, stopReason: refusal };
                    pendingAgentId = agentId;
                    return { continue: true };
                  }],
                }],
              },
            }
        ),
        // SPEC telegram-cron-compaction 4.1: as TRES decisoes de thread usam o
        // sdkThreadId resolvido (sdk_session_id NULL => proprio sessionId,
        // byte-identico ao legado). pending_seed forca o braco { sessionId }
        // (thread nova, sem resume) via shouldContinueSession=false acima.
        ...(shouldContinueSession && lane.sdkActiveSessionId === sdkThreadId
          ? { continue: true }
          : shouldContinueSession
            ? { resume: sdkThreadId }
            : { sessionId: sdkThreadId }),
        abortController: lane.currentAbortController,
        ...(!isOnboarding && mcpServers ? { mcpServers } : {}),
      },
    });

    // Toggle off SDK MCPs that the user disabled locally
    // Also disable Claude SDK Excalidraw when our own MCP is active
    if (!isOnboarding) {
      const disabledSdkMcps = getDisabledSDKMcps();

      // Auto-disable Claude SDK Excalidraw if our builtin Excalidraw MCP is registered
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
            // SPEC K2: tool START. O 'Task' e o dispatcher de subagente e compartilha o
            // tool_use_id com o no 'subagent' (task_started, mesmo id) -> NAO emitir 'tool'
            // aqui evita colisao de id / no duplicado; o subagente ja representa esse trabalho.
            if (currentToolName === 'Task') {
              currentToolActivityId = null;
            } else {
              // parentId = subagente ativo (best-effort, AC-2): se o parent_tool_use_id casar
              // com o id do subagente, aninha; senao vira no de topo.
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
            // content_block_stop encerra apenas a GERACAO do input da tool.
            // O lifecycle terminal chega no tool_result real abaixo.
            currentToolActivityId = null;
          }
        } else if (event.type === 'message_start') {
          // Check if this message belongs to a subagent
          const parentToolUseId = (sdkMessage as Record<string, unknown>).parent_tool_use_id as string | null | undefined;
          // SPEC K2: rastreia o subagente ativo p/ aninhar as tools que vierem nesta message.
          currentParentToolUseId = parentToolUseId ?? null;

          // Native Task requests keep their own ledger entry; never fold them
          // into the parent session counters.
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

            // Contador ativo: so o agente PRINCIPAL forma o contexto vivo desta
            // sessao. A ultima request principal vence (SET absoluto no sucesso).
            if (!parentToolUseId) {
              lastMainContextInput = turnInputTokens;
              lastMainOutput = 0;
            }

            // Track subagent tokens separately when parent_tool_use_id is set
            if (parentToolUseId) {
              const msgModel = (msg?.model as string) || model;
              logger.debug({ parentToolUseId, msgModel, inputBase, cacheRead, cacheCreation }, 'Subagent stream_event message_start');
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
          const parentToolUseId = (sdkMessage as Record<string, unknown>).parent_tool_use_id as string | null | undefined;
          const usage = event.usage as Record<string, number> | undefined;
          if (usage) {
            turnOutputTokens = usage.output_tokens || 0;

            // Contador ativo: output da ultima request do agente principal.
            if (!parentToolUseId) {
              lastMainOutput = turnOutputTokens;
            }

            // Accumulate subagent output tokens
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
        // Complete assistant message - use for audit log and tool call details
        // Log all block types for debugging
        const blockTypes = sdkMessage.message.content.map((b) => b.type);
        logger.info({ blockTypes }, 'Assistant message block types');

        for (const block of sdkMessage.message.content) {
          const blockAny = block as unknown as Record<string, unknown>;

          // Capture both tool_use and mcp_tool_use for artifact detection
          if (block.type === 'tool_use' || blockAny.type === 'mcp_tool_use') {
            const toolName = (blockAny.name as string) || '';
            const toolInput = (blockAny.input as Record<string, unknown>) || {};
            const toolId = (blockAny.id as string) || crypto.randomUUID();

            const persistedTool = persistedTimelineToolCalls.find(
              (entry) => entry.toolCallId === toolId,
            );
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

            // SPEC K2 v2 (secao 5.3): detalhe de tool. O input COMPLETO so existe
            // neste assistant-block; enriquece o item ja criado no start (mesmo id)
            // via phase:'update'. O 'Task' (dispatcher de subagente) nao tem no de
            // tool proprio (ver content_block_start) -> nao emitir update p/ ele.
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

            // Detect artifact from tool input
            const artifact = captureToolUse(toolId, toolName, toolInput);
            if (artifact) {
              collectedArtifacts.push(artifact);
              sendSessionStream({ type: 'artifact', artifact });
            }
          }

          // Capture MCP tool results for pending artifacts
          if (blockAny.type === 'mcp_tool_result' || blockAny.type === 'tool_result') {
            const resultContent = typeof blockAny.content === 'string'
              ? blockAny.content
              : Array.isArray(blockAny.content)
                ? (blockAny.content as Array<{ text?: string }>).map((b) => b.text || '').join('')
                : '';
            logger.info(
              { toolUseId: blockAny.tool_use_id, isError: blockAny.is_error, contentLength: resultContent.length, contentSnippet: resultContent.substring(0, 200) },
              'Captured mcp_tool_result block',
            );
            // SPEC K2 v2 (secao 5.3): resultado da tool -> marca changed/status no
            // item ja existente (phase:'update'). changed = !isError && isWriteTool;
            // status = error quando falhou. name resolvido via toolNameById.
            const resultToolUseId = blockAny.tool_use_id as string | undefined;
            if (resultToolUseId) {
              const resultToolName = toolNameById.get(resultToolUseId);
              // AskUserQuestion interceptado: o deny-com-respostas do
              // permission-guard chega como is_error=true (artefato tecnico),
              // mas o fluxo FUNCIONOU (humano respondeu). Re-rotula como
              // sucesso para a UI nao mostrar "falhou" num fluxo saudavel.
              const isError =
                blockAny.is_error === true &&
                !isAskUserAnswersResult(resultToolName, resultContent);
              const persistedTool = persistedTimelineToolCalls.find(
                (entry) => entry.toolCallId === resultToolUseId,
              );
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
            }

            const artifact = captureToolResult(
              blockAny.tool_use_id as string,
              resultContent,
              blockAny.is_error as boolean,
            );
            if (artifact) {
              logger.info({ artifactType: artifact.type, artifactTitle: artifact.title }, 'Artifact created, sending to renderer');
              collectedArtifacts.push(artifact);
              sendSessionStream({ type: 'artifact', artifact });
            }
          }
        }
        // Fallback: if we missed any text deltas, send what's missing
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
        // Tool results arrive in user-role messages, not assistant messages.
        // This is where mcp_tool_result and tool_result blocks actually live.
        // The SDK shape mirrors the assistant message: sdkMessage.message.content[].
        const userContent = Array.isArray(sdkMessage.message.content)
          ? sdkMessage.message.content
          : [];
        for (const contentBlock of userContent) {
          const block = contentBlock as unknown as Record<string, unknown>;
          if (block.type === 'mcp_tool_result' || block.type === 'tool_result') {
            const resultContent = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? (block.content as Array<{ text?: string }>).map((b) => b.text || '').join('')
                : '';
            logger.info(
              { toolUseId: block.tool_use_id, isError: block.is_error, contentLength: resultContent.length, contentSnippet: resultContent.substring(0, 200) },
              'Captured tool_result from user message',
            );
            // SPEC K2 v2 (secao 5.3): resultado da tool (chega na message user) ->
            // marca changed/status no item ja existente (phase:'update').
            const resultToolUseId = block.tool_use_id as string | undefined;
            if (resultToolUseId) {
              const resultToolName = toolNameById.get(resultToolUseId);
              // Mesmo re-rotulo do bloco assistant: deny-com-respostas do
              // AskUserQuestion nao e falha (ver isAskUserAnswersResult).
              const isError =
                block.is_error === true &&
                !isAskUserAnswersResult(resultToolName, resultContent);
              const persistedTool = persistedTimelineToolCalls.find(
                (entry) => entry.toolCallId === resultToolUseId,
              );
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
            }

            const artifact = captureToolResult(
              block.tool_use_id as string,
              resultContent,
              block.is_error as boolean,
            );
            if (artifact) {
              logger.info({ artifactType: artifact.type, artifactTitle: artifact.title }, 'Artifact created from user tool_result, sending to renderer');
              collectedArtifacts.push(artifact);
              sendSessionStream({ type: 'artifact', artifact });
            }
          }
        }

      } else if (sdkMessage.type === 'result') {
        // Detect ARQUIVO_AUDIO in assistant text (fallback for MCP tool results
        // that don't appear as mcp_tool_result blocks in assistant messages)
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
        // Detectar eventos de sistema do SDK (compactacao, status, task lifecycle)
        const msgAny = sdkMessage as Record<string, unknown>;
        if (msgAny.type === 'system') {
          const subtype = msgAny.subtype as string;

          // D17 (SPEC agent-sdk-0.3): ferramentas REAIS expostas pelo engine
          // neste turno. VA-4 compara o conjunto com init_tools(2.1.74).
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

            // Resolve agent_id with multiple strategies:
            // 1. pendingAgentId from SubagentStart hook
            // 2. task_type field (SDK may pass agent key here)
            // 3. Validate against agents table to avoid storing SDK internal IDs
            const capturedAgentId = pendingAgentId;
            pendingAgentId = null;

            let resolvedId: string | null = null;
            let resolvedName: string | null = null;

            // Try pendingAgentId first (from hook)
            if (capturedAgentId) {
              const agentRecord = getAgent(capturedAgentId);
              if (agentRecord) {
                resolvedId = capturedAgentId;
                resolvedName = agentRecord.name;
              }
            }

            // Try task_type as agent key
            if (!resolvedId && taskType) {
              const agentRecord = getAgent(taskType);
              if (agentRecord) {
                resolvedId = taskType;
                resolvedName = agentRecord.name;
              }
            }

            // If no real agent found, use description as display name
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

            // Link the agentId to any subagent token entry already started for this toolUseId
            const tokenEntry = subagentTokens.get(toolUseId);
            if (tokenEntry) {
              tokenEntry.agentId = resolvedId;
              tokenEntry.agentName = resolvedName;
            }

            logger.info({ taskId, toolUseId, agentId: resolvedId, agentName: resolvedName, taskType, description, capturedHookAgentId: capturedAgentId }, 'Task started');

            // SPEC K2 (a): subagente START. Dados ja prontos (resolvedName/resolvedId/toolUseId).
            // v2 S2(d): acrescenta description (a TAREFA, ja no taskMap).
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

            // Try multiple keys to find token entry:
            // The parent_tool_use_id on stream_events may differ from the tool_use_id on task events.
            // SDK may use toolUseId, taskId, or taskMeta.taskId as the parent_tool_use_id.
            const tokenEntry = subagentTokens.get(toolUseId)
              || (taskId ? subagentTokens.get(taskId) : undefined)
              || (taskMeta?.taskId ? subagentTokens.get(taskMeta.taskId) : undefined);

            const effectiveTokens = tokenEntry;

            // Resolve agent info
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

            const costUsd = calculateCost(resolvedModel, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens);

            // SPEC K2 (b): subagente END. CRITICO (AC-11): emitir ANTES do try/catch de
            // persistencia, para o fim sempre chegar ao renderer mesmo se o DB/audit falhar.
            // Nenhum subagente fica "running" eterno por falha de insertTaskExecution.
            emitActivity({
              id: toolUseId,
              kind: 'subagent',
              phase: 'end',
              label: resolvedAgentName,
              status: taskStatus === 'completed' ? 'done' : 'error',
              agentId: resolvedAgentId,
              model: resolvedModel,
              tokens: { input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheCreation: cacheCreationTokens },
              costUsd,
              durationMs,
              summary,
              // v2 S2(d): nº de tools que o subagente usou (ja calculado de notifUsage.tool_uses)
              // + description preservada (a TAREFA).
              toolUses: toolUsesCount,
              description: taskMeta?.description || undefined,
              endedAt: new Date().toISOString(),
            });

            if (taskMeta?.executionId) {
              const hasReportedUsage = Boolean(effectiveTokens && (
                apiRequests > 0
                && inputTokens > 0
                && outputTokens > 0
              ));
              try {
                finalizeTaskExecutionOnce(taskMeta.executionId, {
                  status: taskStatus === 'completed'
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
                  costStatus: !hasReportedUsage
                    ? 'unknown'
                    : hasKnownPricing(resolvedModel) ? 'known' : 'unknown',
                  tokenStatus: hasReportedUsage ? 'reported' : 'not_reported',
                  costUnknownReason: !hasReportedUsage
                    ? 'no-usage-reported'
                    : hasKnownPricing(resolvedModel) ? null : 'unknown-pricing',
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
                { taskId: taskMeta?.taskId, toolUseId, agentId: resolvedAgentId, agentName: resolvedAgentName, inputTokens, outputTokens, costUsd, taskStatus },
                'Task execution recorded',
              );
            } catch (err) {
              logger.error({ err, toolUseId }, 'Failed to insert task execution');
            }

            // Cleanup tracking maps for this task
            taskMap.delete(toolUseId);
            subagentTokens.delete(toolUseId);
            if (taskId) subagentTokens.delete(taskId);
            if (taskMeta?.taskId) subagentTokens.delete(taskMeta.taskId);
          }
        }
      }
    }

    // SDK session is now alive in this process: future messages can use continue: true
    // (SPEC 4.1: a lane guarda o id da THREAD do SDK, nao o sessionId do DB)
    lane.sdkActiveSessionId = sdkThreadId;
    // TEMPORARIO - smoke-audit: marca sucesso do turno (reportado no finally).
    turnOk = true;

    // SPEC 4.3: consumo ATOMICO do seed no sucesso do turno (mesmo ponto da
    // escrita da lane). O preambulo entrou exatamente uma vez nesta thread;
    // uma falha do turno teria pulado este ponto e preservado o pending_seed.
    if (pendingSeed) {
      clearSessionPendingSeed(sessionId);
      logger.info({ sessionId, sdkThreadId }, 'pending_seed consumido no sucesso do turno (SPEC 4.3)');
    }

    // Persist only the main thread here. Child execution IDs are rolled up by
    // mapSession(), keeping their model and quality metadata intact.
    accumulateTurnUsage();

    // Update session-level token totals (drives the chat sidebar counter).
    // token_usage table foi removida na V57; CodeBurn embed cobre o dashboard agora.
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      const totalCost = calculateCost(model, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens);
      updateSessionTokens(sessionId, totalInputTokens, totalOutputTokens, totalCost, {
        costStatus: 'known',
        tokenStatus: 'reported',
        runtime: 'cloud',
      });
    }
    const combinedInputTokens = totalInputTokens + sidechainInputTokens;
    const combinedOutputTokens = totalOutputTokens + sidechainOutputTokens;
    if (combinedInputTokens > 0 || combinedOutputTokens > 0) {
      // FX2-b (AC-12): turno semeado pelo drive (origin:'system-event') publica o
      // delta de tokens para o budget anti-runaway AGREGADO do coordenador, que
      // antes so somava tokens das fases loop. Best-effort, ADITIVO. No-op se nao
      // for drive (skipUserPersistence false) ou se ninguem assinou o sink.
      if (skipUserPersistence) {
        reportDriveTurnUsage(
          sessionId,
          combinedInputTokens + combinedOutputTokens,
        );
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

    // Contador ativo (SET absoluto, gatilho da compactacao in-place do Telegram):
    // o CONTEXTO VIVO da thread e o usage da ULTIMA request do agente principal
    // (input real + cache + output), nao o acumulado do turno. So seta no sucesso
    // do turno e so quando houve pelo menos uma request principal com usage; edge
    // sem captura preserva o valor anterior.
    if (lastMainContextInput >= 0) {
      setSessionActiveContextTokens(sessionId, lastMainContextInput + lastMainOutput);
      // SPEC robustez-chat SA-2 (AC-A3/AC-A4): barrinha model-aware no path
      // cloud (query() direto, D6). contextTokens = o MESMO contexto vivo do
      // contador ativo (usage REAL da ultima request principal); janela do
      // resolver SA-1 (D4). Janela desconhecida -> sem chunk (D5), sem crash.
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
      // Process onboarding data if present, strip marker before saving
      const contentBeforeCleanup = assistantContent;
      const cleaned = extractAndProcessOnboardingData(assistantContent, {
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
      const messageMetadata = collectedArtifacts.length > 0 || persistedTimelineToolCalls.length > 0
        ? JSON.stringify({
            ...(collectedArtifacts.length > 0 ? { artifacts: collectedArtifacts } : {}),
            ...(persistedTimelineToolCalls.length > 0 ? { toolCalls: persistedTimelineToolCalls } : {}),
          })
        : undefined;
      insertMessage(sessionId, 'assistant', assistantContent, options.agentId, messageMetadata);
      recordCompletedMainChatTurn(sessionId, getWindow);
    } else if (
      // SPEC robustez-chat SB-2 (V5, AC-B4b) [INV]: path D6 (chat usa query()
      // direto, nao passa por execute.ts). Turno que terminou VAZIO por falha
      // de provider (sem texto, sem output tokens, sem artifacts) emite um
      // chunk `{type:'error', code:'LLM-EMPTY'}` pelo canal de erro EXISTENTE
      // do chat-store e MANTEM o ciclo de vida normal do turno (done/reconcile
      // seguem; nada e abortado). Turno vazio LEGITIMO (so tool-use tem output
      // tokens > 0; abort do user cai no catch de AbortError) NAO emite.
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

    // Auto-generate session title (fire and forget)
    // Must run AFTER insertMessage so getSessionMessages finds both user + assistant messages
    if (sessionId) {
      const session = getSession(sessionId);
      if (session
        && session.type !== 'scheduled'
        && session.type !== 'telegram'
      ) {
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

    // SPEC robustez-chat SA-3 (AC-A5 [INV], decisao V3): gatilho pos-turno da
    // compactacao automatica leve — hook ADITIVO no fim do SUCESSO do turno
    // (depois do `done`; o catch/retry abaixo nunca passa por aqui), SINCRONO
    // (awaited) ANTES de retornar ao processQueue: a fila do desktop aguarda
    // executeQuery serialmente, entao o proximo dequeue so roda apos a
    // compactacao, ja lendo sdk_session_id/pending_seed novos (AC-A6, exclusao
    // mutua sem lock). Nao toca a chamada query() do SDK nem o fluxo do turno;
    // janela desconhecida / sessao nao-chat / abaixo do threshold = no-op.
    // NUNCA lanca (best-effort — falha nao bloqueia o proximo turno).
    await maybeCompactChatSession(sessionId, sendSessionStream);
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
      if (lane !== desktopLane) throw controlledError;
      return;
    }
    if ((error as Error).name === 'AbortError') {
      sendSessionStream({ type: 'done', content: sessionId });
      return;
    }
    const errorMsg = error instanceof Error ? error.message : 'Erro desconhecido';
    logger.error({ error, shouldContinueSession, sdkActiveSessionId: lane.sdkActiveSessionId, lane: lane.name }, 'Orchestrator query failed');

    // If we were trying to resume/continue a session and it failed (EPIPE, subprocess crash),
    // retry once with a fresh SDK session. This preserves the resume feature for the main chat
    // while preventing infinite EPIPE loops when session files are missing/corrupted.
    // (SPEC 4.1: comparacao pelo sdkThreadId, o mesmo id usado no seletor e na lane)
    if (shouldContinueSession && lane.sdkActiveSessionId !== sdkThreadId) {
      lane.sdkActiveSessionId = null;
      logger.warn({ sessionId }, 'Resume failed — retrying with fresh SDK session');
      try {
        lane.currentAbortController = null;
        // SB-10 (AC-B26): o retry interno tem a PROPRIA rede de seguranca;
        // suprime a externa para nao emitir erro falso apos retry ok.
        markChatTurnDelegated(turnStreamFlags);
        await executeQuery(message, { ...options, sessionId, _forceNewSession: true }, getWindow, lane);
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
        // SPEC telegram-cron-compaction 1.3: nas lanes de fila (telegram/cron)
        // a falha do turno REJEITA o Promise do job para o caller.
        if (lane !== desktopLane) {
          throw retryErr;
        }
        return;
      }
    }

    // Reset session state on any failure to avoid stale continue attempts
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
    // SPEC telegram-cron-compaction 1.3 (contrato de erro das filas): nas lanes
    // de fila (telegram/cron) a falha REAL do turno precisa rejeitar o Promise
    // do JOB para o caller (o scheduler marca task_run 'error' com a mensagem
    // real; o bridge ve a falha do turno). O desktop mantem o contrato atual
    // (erro via stream, Promise resolve).
    if (lane !== desktopLane) {
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
    // SPEC robustez-chat SB-10 (V8, AC-B26): rede de seguranca no COMPLETION
    // do turno — SO na lane DESKTOP (telegram/cron tem contrato proprio via
    // reject do job) e nao-silent. Se o turno terminou sem chunk de erro, sem
    // conteudo e sem `done` (morreu mudo — o renderer ficaria preso em
    // streaming), emite o `{type:'error', code:'LLM-EMPTY'}` de fallback
    // (mesmo mecanismo do AC-B4b; `sawErrorChunk` evita emitir 2x quando o
    // AC-B4b ou o catch ja emitiram). Best-effort: nunca lanca.
    if (
      shouldEmitChatTurnFallbackError(turnStreamFlags, {
        isDesktopLane: lane === desktopLane,
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
    // TEMPORARIO - smoke-audit: fim do turno claude-sdk (ok=sucesso/falha).
    smokeAudit('turn_done', { lane: lane.name, sessionId, ok: turnOk });
    lane.currentAbortController = null;
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
  const suffixLimit = Math.min(
    previousContent.length - prefix,
    nextContent.length - prefix,
  );
  while (
    suffix < suffixLimit &&
    previousContent[previousContent.length - 1 - suffix] ===
      nextContent[nextContent.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const previousChangedEnd = previousContent.length - suffix;
  const delta = nextContent.length - previousContent.length;
  for (const tool of tools) {
    if (!Number.isInteger(tool.textOffset) || (tool.textOffset ?? -1) < 0) continue;
    const offset = tool.textOffset ?? 0;
    const remapped = offset <= prefix
      ? offset
      : offset >= previousChangedEnd
        ? offset + delta
        : prefix;
    tool.textOffset = Math.max(0, Math.min(nextContent.length, remapped));
  }
}

// SPEC orquestrador-fonte-unica 3.1: stop POR LANE. O IPC chat:stop chama
// stopCurrentQuery() sem argumento = para APENAS a desktop lane (limpa a fila do
// desktop + aborta o turno do desktop, em QUALQUER runtime, pela lane). Nunca
// mais mata turno do Telegram/cron rodando em codex/kimi/lion: antes da S3 os 4
// stops GLOBAIS de modulo derrubavam qualquer lane; agora o abort e por lane.
export function stopCurrentQuery(): void {
  // TEMPORARIO - smoke-audit: stop da desktop lane.
  smokeAudit('stop', { lane: 'desktop' });
  // Clear the queue first so no pending messages are processed after abort
  drainDesktopQueueSignalingDriveTurns('stop-current-query');
  // Aborta o turno em voo na desktop lane. Como todo runtime na desktop lane
  // seta desktopLane.currentAbortController (claude-sdk direto; sub-SDKs via
  // lane.currentAbortController), este unico abort cobre todos os runtimes.
  if (desktopLane.currentAbortController) {
    desktopLane.currentAbortController.abort();
    desktopLane.currentAbortController = null;
  }
  // Redundante com o abort acima (a lane e a mesma instancia), mas mantem os
  // sub-SDKs cientes do stop da lane sem tocar telegram/cron (parametro de lane).
  stopClaudeCompatQuery(desktopLane);
  stopCodexSdkQuery(desktopLane);
  stopKimiSdkQuery(desktopLane);
  stopGrokSdkQuery(desktopLane);
  stopCursorSdkQuery(desktopLane);
  stopLionSdkQuery(desktopLane);
  abandonDesktopQueueProcessor('stop-current-query');
}

function sendStream(
  getWindow: () => BrowserWindow | null,
  silent: boolean | undefined,
  chunk: StreamChunk,
  authorizationGeneration?: number,
): void {
  if (silent) return;
  if (
    authorizationGeneration !== undefined &&
    !privilegedAccessGate.isGenerationCurrent(authorizationGeneration)
  ) return;
  // Inject queueRemaining into 'done' chunks so the renderer knows
  // whether more queued messages are about to be processed
  const finalChunk = chunk.type === 'done' && messageQueue.length > 0
    ? { ...chunk, queueRemaining: messageQueue.length }
    : chunk;
  try {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('chat:stream', finalChunk);
    }
  } catch {
    // Render frame disposed (e.g. GPU crash, window reload)
  }
}

function sendLogEntry(
  getWindow: () => BrowserWindow | null,
  entry: Omit<AuditEntry, 'id' | 'createdAt'>,
): void {
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

// ---- Telegram lane API (SPEC telegram-cron-compaction 1.2/1.3/1.4) ----

/**
 * Executa uma query na telegramLane, serializada pela telegramQueueChain.
 *
 * Contrato de erro das filas (SPEC 1.3, correcao deliberada sobre o padrao do
 * antigo executeBackgroundQuery): o Promise retornado ao caller e o do JOB
 * (rejeita em falha real do turno); o chain absorve o erro internamente APENAS
 * para continuar vivo para o proximo job.
 *
 * Nome escolhido para nao colidir com o executeTelegramQuery do bridge (que
 * mantem o nome e passa a chamar esta funcao).
 */
export function executeTelegramLaneQuery(
  message: string,
  options: QueryOptions,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  if (!options.sessionId) {
    const error = "telegramLane exige options.sessionId explicito (guard de sessao, SPEC 1.4)";
    logger.error({ lane: telegramLane.name }, error);
    return Promise.reject(new Error(error));
  }
  // SPEC update R2 D14: chokepoint de dispatch do Telegram. Lease compartilhada
  // ate o job estar registrado na fila serial + contador autoritativo.
  const releaseUpdateLease = tryBeginBackgroundWorkStart('telegram-turn');
  if (releaseUpdateLease === null) {
    return Promise.reject(new UpdateMaintenanceBarrierClosedError());
  }
  try {
    telegramLanePendingJobs += 1;
    const job = telegramQueueChain.then(() =>
      executeQuery(message, options, getWindow, telegramLane),
    );
    void job.then(
      () => {
        telegramLanePendingJobs -= 1;
      },
      () => {
        telegramLanePendingJobs -= 1;
      },
    );
    // Erro ja propagado ao caller via `job`; o catch aqui SO mantem a fila viva.
    telegramQueueChain = job.catch(() => {});
    return job;
  } finally {
    releaseUpdateLease();
  }
}

/**
 * Enfileira uma tarefa arbitraria na telegramQueueChain (SPEC 5.3): a
 * compactacao in-place do Telegram roda DENTRO da fila dos turnos, nunca
 * fire-and-forget — nenhum turno executa concorrente com o re-seed; mensagem
 * que chega durante a compactacao espera na fila e ja nasce na thread nova.
 * Mesmo contrato de erro dos jobs de query (SPEC 1.3): o Promise retornado
 * ao caller rejeita em falha; o chain absorve internamente APENAS para
 * continuar vivo para o proximo job.
 */
export function enqueueTelegramLaneTask<T>(task: () => Promise<T>): Promise<T> {
  // SPEC update R2 D14: mesmo chokepoint de admissao da lane serial.
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
    telegramQueueChain = job.then(() => undefined, () => undefined);
    return job;
  } finally {
    releaseUpdateLease();
  }
}

// SPEC orquestrador-fonte-unica 3.1: para APENAS a telegram lane (o reset/clear
// do Telegram). Aborta o turno em voo na lane (qualquer runtime) sem tocar
// desktop/cron.
export function stopTelegramQuery(): void {
  // TEMPORARIO - smoke-audit: stop da telegram lane.
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

/** Zera APENAS o sdkActiveSessionId da telegramLane (nao toca desktop/cron/sub-SDKs). */
export function resetTelegramSessionState(): void {
  telegramLane.sdkActiveSessionId = null;
}

// ---- Cron lane API (SPEC telegram-cron-compaction 1.2/1.3/1.4/7.1) ----

/**
 * Executa uma query na cronLane, serializada pela cronQueueChain.
 *
 * Contrato de efemeridade (SPEC 7.1): exige sessao explicita e SEM mensagens
 * (abre-roda-encerra; sessao vazia faz shouldContinueSession=false decorrer
 * naturalmente, sem _forceNewSession — que pularia a persistencia da user
 * message). No finally da execucao a lane e resetada: nenhum estado atravessa
 * para o proximo run. Contrato de erro identico ao da telegramQueueChain
 * (job rejeita em falha; chain sobrevive para o proximo job).
 */
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
  // SPEC update R2 D14: chokepoint de admissao da cron lane.
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
  // Erro ja propagado ao caller via `job`; o catch aqui SO mantem a fila viva.
  cronQueueChain = job.catch(() => {});
  releaseUpdateLease();
  return job;
}

// SPEC orquestrador-fonte-unica 3.1: para APENAS a cron lane. Aborta o turno em
// voo na lane (qualquer runtime) sem tocar desktop/telegram.
export function stopCronQuery(): void {
  // TEMPORARIO - smoke-audit: stop da cron lane.
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

/** Zera APENAS o sdkActiveSessionId da cronLane (nao toca desktop/telegram/sub-SDKs). */
export function resetCronSessionState(): void {
  cronLane.sdkActiveSessionId = null;
}

/**
 * SPEC update R2 D14: estado autoritativo consultado pelo adapter de blockers
 * do UpdateInstallGuard. Cobre turno de chat (fila desktop + runtime em voo) e
 * os dispatches de Telegram/cron (jobs pendentes + turno em voo por lane).
 */
export function hasActiveOrchestratorWork(): boolean {
  return (
    messageQueue.isProcessing ||
    messageQueue.length > 0 ||
    hasActiveDesktopRuntimeQuery() ||
    telegramLane.currentAbortController !== null ||
    cronLane.currentAbortController !== null ||
    telegramLanePendingJobs > 0 ||
    cronLanePendingJobs > 0
  );
}
