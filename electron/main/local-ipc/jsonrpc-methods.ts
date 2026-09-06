
import crypto from 'crypto';
import type { BrowserWindow } from 'electron';
import {
  getAllAgents,
  insertAuditEntry,
  getAgent,
  getActiveChatSession,
  getPermissionBypass,
  getCompletedDocsCount,
  getLatestUserTurnIndex,
  type TaskExecutionRollup,
} from '../db';
import { recordActivity } from '../activity-log';
import { getAllMCPServers } from '../mcp-manager';
import { getSecret } from '../secrets-vault';
import { listSkills, getSkill } from '../skills';
import { sendAskQuestion } from '../ask-question';
import { createPermissionGuard } from '../permission-guard';
import {
  isPipelineWriteAction,
  pipelineListCore,
  pipelineInspectCore,
  pipelineCreateCore,
  pipelineDriveCore,
  pipelineReplyCore,
  pipelineApproveCore,
  pipelineEscalateCore,
  pipelineAbortCore,
  pipelinePauseCore,
  designSessionConfigCore,
  normalizeApproveMetadata,
  type ControlResult,
  type PipelineControlType,
  type DriveMode,
} from '../pipeline-control-core';
import { previewCaptureCore, previewOpenCore } from '../preview-open';
import { createSubagentDispatchContext } from '../agent-runtime/subagent-dispatch';
import type { SubagentDispatchContext } from '../agent-runtime/types';
import { resolveChatInheritedEffort } from '../agent-runtime/chat-effort-inheritance';
const tryBeginBackgroundWorkStart = (_lane: string): (() => void) | null => () => {};
const UPDATE_MAINTENANCE_START_REFUSED_MESSAGE =
  'Manutencao de atualizacao em andamento.';

import {
  isDynamicWorkflowWriteAction,
  dynamicWorkflowStartCore,
  dynamicWorkflowAuthorCore,
  dynamicWorkflowInspectCore,
  dynamicWorkflowReplyCore,
  dynamicWorkflowApproveCore,
  dynamicWorkflowInterveneCore,
  dynamicWorkflowAbortCore,
  dynamicWorkflowEditCoordinatorCore,
  type WorkflowControlResult,
} from '../dynamic-workflows/workflow-control-core';
import type { DynamicWorkflowIntervention } from '../dynamic-workflows/types';
import {
  consumeDriveCapability,
  isReadOnlyDriveTurn,
  type DriveCapabilityAction,
} from '../dynamic-workflows/drive-capability';
import {
  resolveRepoGraphSessionId,
  getRepoGraphTurnSession,
  getRepoGraphTurnRuntime,
} from '../repo-graph/turn-context';
import {
  getActiveChatTurnByLane,
  getChatCapabilityTurn,
  type ChatLane,
} from '../chat-capability-context';
import {
  assertChatCapability,
  failClosedChatCapability,
  getChatCapabilityGateMode,
} from '../chat-capability-gate';
import type { McpInvocationContext } from '../mcp-invocation-context';
import {
  mintHelperToken,
  gatedServerIdForMethod as gatedServerIdForMethodCanonical,
  PROCESS_IDENTITY_HELPER_IDS,
  IDENTITY_METHOD_OWNERS,
} from '../helper-identity';
import { cronLane, desktopLane, telegramLane } from '../sdk-lane';
import { resolveKanbanActor } from '../kanban-actor';
import type { KanbanCardPatch } from '../../../src/types/kanban';
import type { RepoGraphReader } from '../repo-graph/types';
import { createLogger } from '../logger';
import type {
  AskQuestionRequest,
  AskQuestionResponse,
  LiveActivityEvent,
  RepoGraphChunkPayload,
  StreamChunk,
} from '../../../src/types';

const logger = createLogger('local-ipc:jsonrpc');


const HIDDEN_SQUADS = new Set(['harness', 'pipeline', 'security', 'feature', 'enrich']);

export interface ListAgentsEntry {
  id: string;
  name: string;
  runtime: string;
  model: string;
  description: string;
  tools: string[];
  skills: string[];
}

export interface LocalIpcConnectionIdentity {
  authenticatedHelper: boolean;
  serverId?: string;
  connectionId?: string;
}

export interface JsonRpcContext {
  getWindow: () => BrowserWindow | null;
  connection?: LocalIpcConnectionIdentity;
}


export function handleListAgents(): ListAgentsEntry[] {
  const agents = getAllAgents();
  return agents
    .filter((a) => a.isActive)
    .filter((a) => !a.squad || !HIDDEN_SQUADS.has(a.squad))
    .map((a) => ({
      id: a.id,
      name: a.name,
      runtime: a.runtime || 'cloud',
      model: a.model,
      description: a.description,
      tools: Array.isArray(a.allowedTools) ? a.allowedTools : [],
      skills: Array.isArray(a.skills) ? a.skills : [],
    }));
}


export interface AgentDetailsParams {
  agent_id: string;
}

export interface AgentDetailsResult {
  id: string;
  name: string;
  description: string;
  runtime: string;
  model: string;
  allowedTools: string[];
  skills: string[];
  kbDocs: number;
  squad: string | null;
  chatEligible: boolean;
}

export function handleAgentDetails(
  params: AgentDetailsParams,
): AgentDetailsResult | { error: string } {
  if (!params || typeof params.agent_id !== 'string' || !params.agent_id.trim()) {
    return { error: 'agent_id e obrigatorio' };
  }
  const agent = getAgent(params.agent_id);
  if (!agent || !agent.isActive) {
    return { error: `Agente nao encontrado ou inativo: ${params.agent_id}` };
  }
  const agentRec = agent as unknown as Record<string, unknown>;
  const kbDocs = agentRec['kb_enabled'] !== 0 ? getCompletedDocsCount(agent.id) : 0;
  const squad = (agent.squad ?? '').trim().toLowerCase() || null;
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    runtime: agent.runtime || 'cloud',
    model: agent.model,
    allowedTools: Array.isArray(agent.allowedTools) ? agent.allowedTools : [],
    skills: Array.isArray(agent.skills) ? agent.skills : [],
    kbDocs,
    squad,
    chatEligible: !squad || !HIDDEN_SQUADS.has(squad),
  };
}


export interface CallAgentParams {
  agent_id: string;
  task: string;
  context?: Record<string, unknown>;
  expected_output?: string;
}

let subagentDispatchDepth = 0;

export function isSubagentDispatchInFlight(): boolean {
  return subagentDispatchDepth > 0;
}

const callAgentTurnContexts = new Map<string, SubagentDispatchContext>();

function resolveCallAgentDispatchContext(ctx: JsonRpcContext): SubagentDispatchContext {
  const connection = ctx.connection;
  if (
    !connection?.authenticatedHelper
    || connection.serverId?.trim().toLowerCase() !== 'lionclaw-agents'
    || !connection.connectionId
  ) {
    throw new Error('call_agent exige conexao autenticada como lionclaw-agents.');
  }
  const lanes = [
    { name: 'desktop' as const, state: desktopLane },
    { name: 'telegram' as const, state: telegramLane },
    { name: 'cron' as const, state: cronLane },
  ];
  const active = lanes.flatMap(({ name, state }) => {
    const turn = getActiveChatTurnByLane(name);
    return turn ? [{ name, state, turn }] : [];
  });
  if (active.length !== 1) {
    throw new Error(
      active.length === 0
        ? 'call_agent exige um turno host ativo.'
        : 'call_agent recusado: mais de uma lane ativa e o helper nao trouxe binding de turno.',
    );
  }
  const [{ name, state, turn }] = active;
  const turnContext = getChatCapabilityTurn(turn);
  if (
    !turnContext?.cwd
    || !turnContext.permissionProfile?.canUseTool
    || !Array.isArray(turnContext.allowedTools)
    || !Array.isArray(turnContext.allowedServerIds)
    || !Array.isArray(turnContext.readRoots)
    || !Array.isArray(turnContext.writeRoots)
  ) {
    throw new Error('call_agent sem capabilities/roots/permission guard cunhados pelo turno host.');
  }
  const parentAbort = state.currentAbortController;
  if (!parentAbort) throw new Error('call_agent sem AbortController do turno host.');
  const key = `${connection.connectionId}:${name}:${turn.sessionId}:${turn.turnId}`;
  for (const [candidate, context] of callAgentTurnContexts) {
    if (
      candidate !== key
      || context.parentAbortSignal !== parentAbort.signal
      || context.parentAbortSignal.aborted
    ) {
      callAgentTurnContexts.delete(candidate);
    }
  }
  const existing = callAgentTurnContexts.get(key);
  if (existing) return existing;
  const created = createSubagentDispatchContext({
    ownerKind: 'chat',
    ownerId: turn.sessionId,
    sessionId: turn.sessionId,
    lane: name,
    surface: 'local-ipc',
    cwd: turnContext.cwd,
    readRoots: turnContext.readRoots,
    writeRoots: turnContext.writeRoots,
    allowedTools: turnContext.allowedTools,
    allowedMcpServerIds: turnContext.allowedServerIds,
    permission: turnContext.permissionProfile,
    parentAbortSignal: parentAbort.signal,
    abortOwner: (reason) => parentAbort.abort(reason),
    inheritedEffort: resolveChatInheritedEffort(),
  });
  callAgentTurnContexts.set(key, created);
  return created;
}


export type GatedCallTurnResolutionReason =
  | 'ok'
  | 'unauthenticated-connection'
  | 'helper-server-mismatch'
  | 'no-active-desktop-turn'
  | 'turn-context-missing';

export interface GatedCallTurnResolution {
  ok: boolean;
  reason: GatedCallTurnResolutionReason;
  sessionId?: string;
  turnId?: string;
  turnContext?: ReturnType<typeof getChatCapabilityTurn>;
}

export function resolveGatedCallTurnContext(
  ctx: JsonRpcContext,
  expectedServerId?: string,
): GatedCallTurnResolution {
  if (ctx.connection?.authenticatedHelper !== true) {
    return { ok: false, reason: 'unauthenticated-connection' };
  }
  if (expectedServerId && ctx.connection.serverId !== expectedServerId) {
    return { ok: false, reason: 'helper-server-mismatch' };
  }
  const active = getActiveChatTurnByLane('desktop');
  if (!active) {
    return { ok: false, reason: 'no-active-desktop-turn' };
  }
  const turnContext = getChatCapabilityTurn(active);
  if (!turnContext) {
    return {
      ok: false,
      reason: 'turn-context-missing',
      sessionId: active.sessionId,
      turnId: active.turnId,
    };
  }
  return {
    ok: true,
    reason: 'ok',
    sessionId: active.sessionId,
    turnId: active.turnId,
    turnContext,
  };
}

function logGatedCallShadowResolution(ctx: JsonRpcContext, action: string): void {
  try {
    const resolution = resolveGatedCallTurnContext(ctx);
    if (resolution.ok && resolution.turnContext) {
      logger.info(
        {
          shadow: true,
          action,
          resolved: true,
          sessionId: resolution.sessionId,
          turnId: resolution.turnId,
          origin: resolution.turnContext.origin,
          capabilities: resolution.turnContext.capabilities,
          subagentInFlight: isSubagentDispatchInFlight(),
        },
        'S3b shadow: chamada gated resolveu turno ativo da lane desktop',
      );
    } else {
      logger.info(
        {
          shadow: true,
          action,
          resolved: false,
          reason: resolution.reason,
          sessionId: resolution.sessionId,
          turnId: resolution.turnId,
          authenticatedHelper: ctx.connection?.authenticatedHelper === true,
          subagentInFlight: isSubagentDispatchInFlight(),
        },
        'S3b shadow: chamada gated seria FAIL-CLOSED (nao negada em shadow)',
      );
    }
  } catch (err) {
    logger.warn({ err, action }, 'S3b shadow: erro na resolucao de identidade (ignorado)');
  }
}


const gatedServerIdForMethod = gatedServerIdForMethodCanonical;

function enforceGatedCallCapability(
  ctx: JsonRpcContext,
  serverId: string,
  method: string,
): { error: string; code: string; capability: string } | null {
  const resolution = resolveGatedCallTurnContext(ctx, serverId);
  const turnContext = resolution.ok ? resolution.turnContext : undefined;
  const verdict = turnContext
    ? assertChatCapability({
        serverId,
        toolName: method,
        context: {
          surface: turnContext.origin === 'system-event' ? 'system-event' : 'chat',
          sessionId: turnContext.sessionId,
          turnId: turnContext.turnId,
          ...(turnContext.internalLeaseToken !== undefined
            ? { internalLeaseToken: turnContext.internalLeaseToken }
            : {}),
          ...(turnContext.driveProjectId !== undefined
            ? { driveProjectId: turnContext.driveProjectId }
            : {}),
          ...(turnContext.driveTurnId !== undefined
            ? { driveTurnId: turnContext.driveTurnId }
            : {}),
        } satisfies McpInvocationContext,
      })
    : failClosedChatCapability({ serverId, toolName: method, reason: resolution.reason });
  if (verdict.ok) return null;
  return { error: verdict.message, code: verdict.code, capability: verdict.capability };
}

function observeGatedCallCapabilityShadow(
  ctx: JsonRpcContext,
  serverId: string,
  method: string,
): void {
  try {
    enforceGatedCallCapability(ctx, serverId, method);
  } catch (err) {
    logger.warn(
      { err, method },
      'S6b shadow: erro ao exercitar o gate de capability (ignorado)',
    );
  }
}

export async function handleCallAgent(
  ctx: JsonRpcContext,
  params: CallAgentParams,
  transportCorrelation?: {
    kind: 'mcp-request-id' | 'local-ipc-request-id';
    value: string;
  },
): Promise<unknown> {
  const releaseUpdateLease = tryBeginBackgroundWorkStart('local-agent-dispatch');
  if (releaseUpdateLease === null) {
    throw new Error(UPDATE_MAINTENANCE_START_REFUSED_MESSAGE);
  }
  try {
    return await handleCallAgentWithLease(ctx, params, transportCorrelation);
  } finally {
    releaseUpdateLease();
  }
}

async function handleCallAgentWithLease(
  ctx: JsonRpcContext,
  params: CallAgentParams,
  transportCorrelation?: {
    kind: 'mcp-request-id' | 'local-ipc-request-id';
    value: string;
  },
): Promise<unknown> {
  logger.info(
    {
      agent_id: params.agent_id,
      hasContext: !!params.context,
      hasExpectedOutput: !!params.expected_output,
    },
    'call_agent invoked',
  );

  const agent = getAgent(params.agent_id);
  const label = agent?.name ?? params.agent_id;
  const configuredModel = agent?.model;
  const dispatchContext = resolveCallAgentDispatchContext(ctx);
  const activityId = transportCorrelation
    ? `mcp:${transportCorrelation.value}`
    : `call_agent-${params.agent_id}-${crypto.randomUUID()}`;
  const sessionId = dispatchContext.sessionId;
  const startMs = Date.now();

  const emitActivity = (activity: LiveActivityEvent): void => {
    try {
      ctx.getWindow()?.webContents.send('chat:stream', {
        type: 'activity',
        activity,
        sessionId,
      });
    } catch (err) {
      logger.warn({ err }, 'falha ao emitir atividade call_agent');
    }
  };

  emitActivity({
    id: activityId,
    kind: 'subagent',
    phase: 'start',
    label,
    status: 'running',
    agentId: params.agent_id,
    model: configuredModel,
    startedAt: new Date().toISOString(),
  });

  const { lionAgentDispatch } = await import('../lion-sdk/tools/agent');
  subagentDispatchDepth += 1;
  try {
    if (!sessionId) throw new Error('call_agent exige uma sessao de chat ativa.');
    const result = await lionAgentDispatch(params, {
      dispatchContext,
      ...(transportCorrelation ? { transportCorrelation } : {}),
    });
    let ledgerRollup: TaskExecutionRollup | null = null;
    if (result.executionId) {
      try {
        const { getTaskExecutionRollup } = await import('../db');
        ledgerRollup = getTaskExecutionRollup({ executionId: result.executionId });
      } catch (err) {
        logger.warn({ err, executionId: result.executionId }, 'falha ao ler metricas do ledger de subagente');
      }
    }
    const reportedMetrics = ledgerRollup?.tokenStatus === 'reported'
      ? ledgerRollup.metrics
      : null;
    emitActivity({
      id: activityId,
      kind: 'subagent',
      phase: 'end',
      label,
      status: result.ok ? 'done' : 'error',
      agentId: params.agent_id,
      model: result.model ?? configuredModel,
      tokens: reportedMetrics
        ? {
            input: reportedMetrics.inputTokens,
            output: reportedMetrics.outputTokens,
            cacheRead: reportedMetrics.cacheReadTokens,
            cacheCreation: reportedMetrics.cacheCreationTokens,
          }
        : undefined,
      costUsd: ledgerRollup?.costStatus === 'known'
        ? ledgerRollup.metrics.costUsd
        : undefined,
      durationMs: ledgerRollup?.metrics.durationMs ?? Date.now() - startMs,
      summary: result.ok ? result.summary : result.error,
      endedAt: new Date().toISOString(),
    });
    return result;
  } catch (err) {
    emitActivity({
      id: activityId,
      kind: 'subagent',
      phase: 'end',
      label,
      status: 'error',
      agentId: params.agent_id,
      model: configuredModel,
      durationMs: Date.now() - startMs,
      summary: err instanceof Error ? err.message : String(err),
      endedAt: new Date().toISOString(),
    });
    throw err;
  } finally {
    subagentDispatchDepth = Math.max(0, subagentDispatchDepth - 1);
  }
}


export interface ListSkillsEntry {
  name: string;
  description: string;
  category?: string;
}

export function handleListSkills(): ListSkillsEntry[] {
  const skills = listSkills();
  return skills.map((s) => ({
    name: s.name,
    description: s.description,
    category: s.category,
  }));
}


export interface LoadSkillParams {
  skill_name: string;
}

export interface LoadSkillResult {
  body: string;
  frontmatter: Record<string, unknown>;
}

export function handleLoadSkill(params: LoadSkillParams): LoadSkillResult {
  if (!params || typeof params.skill_name !== 'string' || !params.skill_name.trim()) {
    throw new Error('skill_name is required');
  }
  const skill = getSkill(params.skill_name);
  if (!skill) {
    throw new Error(`Skill not found: ${params.skill_name}`);
  }
  const frontmatter: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  };
  if (skill.category) frontmatter['category'] = skill.category;
  if (skill.allowedTools) frontmatter['allowed-tools'] = skill.allowedTools;
  if (skill.model) frontmatter['model'] = skill.model;
  if (skill.disableModelInvocation) frontmatter['disable-model-invocation'] = true;
  if (skill.userInvocable === false) frontmatter['user-invocable'] = false;
  if (skill.argumentHint) frontmatter['argument-hint'] = skill.argumentHint;
  if (skill.context) frontmatter['context'] = skill.context;
  if (skill.agent) frontmatter['agent'] = skill.agent;
  return { body: skill.content, frontmatter };
}


export interface AskUserQuestionParams {
  questions: AskQuestionRequest['questions'];
}

export async function handleAskUserQuestion(
  ctx: JsonRpcContext,
  params: AskUserQuestionParams,
): Promise<AskQuestionResponse> {
  if (!params || !Array.isArray(params.questions) || params.questions.length === 0) {
    throw new Error('questions array is required and must be non-empty');
  }
  return sendAskQuestion(ctx.getWindow, params.questions);
}


export interface GetMcpEnvParams {
  server_id: string;
  caller_pid?: number;
}

export interface GetMcpEnvResult {
  env: Record<string, string>;
}

export async function handleGetMcpEnv(params: GetMcpEnvParams): Promise<GetMcpEnvResult> {
  if (!params || typeof params.server_id !== 'string' || !params.server_id.trim()) {
    throw new Error('server_id is required');
  }
  const serverId = params.server_id;
  const callerPid = typeof params.caller_pid === 'number' ? params.caller_pid : undefined;

  const all = getAllMCPServers();
  const server = all.find((s) => s.id === serverId);

  if (!server) {
    throw new Error(`Unknown MCP server_id: ${serverId}`);
  }
  if (!server.isActive) {
    throw new Error(`MCP server is not active: ${serverId}`);
  }

  const envKeys: string[] = Array.isArray(server.envKeys) ? server.envKeys : [];
  const env: Record<string, string> = {};
  for (const key of envKeys) {
    const value = await getSecret(key);
    if (value !== null && value !== undefined) {
      env[key] = value;
    }
  }

  insertAuditEntry({
    eventType: 'tool_call',
    toolName: 'get_mcp_env',
    input: JSON.stringify({
      server_id: serverId,
      env_key_names: envKeys,
      caller_pid: callerPid,
    }),
  });

  return { env };
}


function assertOrchestratorCaller(action: string): void {
  if (isSubagentDispatchInFlight()) {
    throw new Error(
      `Acao ${action} indisponivel para subagentes: as tools pipeline_* sao exclusivas do orquestrador (sessao de chat).`,
    );
  }
  if (!getActiveChatSession()) {
    throw new Error(
      `Acao ${action} indisponivel: nenhuma sessao de chat de orquestrador ativa.`,
    );
  }
}

function assertAuthenticatedMethodOwner(ctx: JsonRpcContext, method: string): void {
  const expectedServerId = IDENTITY_METHOD_OWNERS[method];
  if (!expectedServerId) throw new Error(`Metodo ${method} sem owner de identidade configurado.`);
  if (
    ctx.connection?.authenticatedHelper !== true ||
    ctx.connection.serverId !== expectedServerId
  ) {
    throw new Error(
      `Acao ${method} recusada: conexao nao autenticada como ${expectedServerId}.`,
    );
  }
}

function isOrchestratorCaller(): boolean {
  return !isSubagentDispatchInFlight() && !!getActiveChatSession();
}

async function gatePipelineWrite(
  ctx: JsonRpcContext,
  action: string,
  input: Record<string, unknown>,
): Promise<void> {
  if (!isPipelineWriteAction(action)) return;
  const guard = createPermissionGuard(ctx.getWindow);
  const decision = await guard(`mcp__pipeline-control__${action}`, input);
  if (decision.behavior === 'deny') {
    throw new Error(
      `Acao ${action} negada pelo gate de permissao do drive: ${decision.message ?? 'sem detalhes'}`,
    );
  }
}

async function gatePreviewOpen(
  ctx: JsonRpcContext,
  input: Record<string, unknown>,
): Promise<void> {
  const guard = createPermissionGuard(ctx.getWindow);
  const decision = await guard('mcp__lionclaw-preview__preview_open', input);
  if (decision.behavior === 'deny') {
    throw new Error(
      `Acao preview_open negada pelo gate de permissao: ${decision.message ?? 'sem detalhes'}`,
    );
  }
}

function unwrap(result: ControlResult): unknown {
  if (result.ok) return result.value;
  throw new Error(result.error);
}

async function gateDynamicWorkflowWrite(
  ctx: JsonRpcContext,
  action: string,
  input: Record<string, unknown>,
): Promise<void> {
  if (!isDynamicWorkflowWriteAction(action)) return;

  if (isReadOnlyDriveTurn(resolveActiveDesktopDriveTurnId())) {
    throw new Error(
      `Acao ${action} negada: este turno de drive e SOMENTE-LEITURA (wake needs-human, ` +
        'anti-runaway). Use dynamic_workflow_inspect, resuma a situacao ao dono e pare; ' +
        'a decisao e humana.',
    );
  }

  const driveTurnId = resolveDriveTurnIdFromConnection(ctx);

  const guard = createPermissionGuard(ctx.getWindow);
  const decision = await guard(`mcp__dynamic-workflows__${action}`, input);
  if (decision.behavior === 'deny') {
    throw new Error(
      `Acao ${action} negada pelo gate de permissao do workflow: ${decision.message ?? 'sem detalhes'}`,
    );
  }

  try {
    if (isOrchestratorCaller() && driveTurnId) {
      const req = resolveDriveCapabilityRequest(action, input);
      const runId =
        typeof input['runId'] === 'string' ? (input['runId'] as string) : '';
      if (
        req &&
        runId &&
        consumeDriveCapability({
          runId,
          driveTurnId,
          action: req.action,
          ...(req.gateId ? { gateId: req.gateId } : {}),
        })
      ) {
        return;
      }
    }
  } catch {
  }

  if (getPermissionBypass()) return;
  await confirmDynamicWorkflowWriteOrThrow(ctx, action, input);
}

function resolveDriveTurnIdFromConnection(ctx: JsonRpcContext): string | undefined {
  try {
    const resolution = resolveGatedCallTurnContext(ctx);
    if (!resolution.ok || !resolution.turnContext) return undefined;
    const id = resolution.turnContext.driveTurnId;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function resolveActiveDesktopDriveTurnId(): string | undefined {
  try {
    const active = getActiveChatTurnByLane('desktop');
    if (!active) return undefined;
    const id = getChatCapabilityTurn(active)?.driveTurnId;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function resolveDriveCapabilityRequest(
  action: string,
  input: Record<string, unknown>,
): { action: DriveCapabilityAction; gateId?: string } | null {
  if (action === 'dynamic_workflow_approve') {
    const gateId = typeof input['gateId'] === 'string' ? (input['gateId'] as string) : '';
    return gateId ? { action: 'approve', gateId } : { action: 'approve' };
  }
  if (action === 'dynamic_workflow_abort') return { action: 'abort' };
  if (action === 'dynamic_workflow_intervene') {
    const intervention = input['intervention'];
    if (!intervention || typeof intervention !== 'object') return null;
    const type = (intervention as { type?: unknown }).type;
    if (type === 'approve-gate') {
      const gateId = (intervention as { gateId?: unknown }).gateId;
      return typeof gateId === 'string' && gateId ? { action: 'approve', gateId } : { action: 'approve' };
    }
    if (
      type === 'pause' ||
      type === 'resume' ||
      type === 'switch-agent' ||
      type === 'adjust-next-node' ||
      type === 'rerun-node'
    ) {
      return { action: `intervene:${type}` as DriveCapabilityAction };
    }
    return null;
  }
  return null;
}

async function confirmDynamicWorkflowWriteOrThrow(
  ctx: JsonRpcContext,
  action: string,
  input: Record<string, unknown>,
): Promise<void> {
  const runId = typeof input['runId'] === 'string' ? (input['runId'] as string) : undefined;
  const alvo = runId ? `o run "${runId}"` : 'um novo workflow';
  const APPROVE = 'Aprovar';
  const DENY = 'Recusar';
  const header = 'Workflow dinamico (modo semi)';
  const question = `O orquestrador quer executar "${action}" sobre ${alvo}. Aprovar esta acao?`;

  let response: AskQuestionResponse;
  try {
    response = await sendAskQuestion(ctx.getWindow, [
      {
        question,
        header,
        options: [
          { label: APPROVE, description: `Executa ${action} agora.` },
          { label: DENY, description: 'Cancela a acao; nada e despachado.' },
        ],
      },
    ]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    insertAuditEntry({
      eventType: 'confirm_response',
      toolName: `mcp__dynamic-workflows__${action}`,
      input: JSON.stringify(input).substring(0, 500),
      approved: false,
    });
    throw new Error(
      `Acao ${action} recusada: confirmacao do modo semi nao foi concluida (${reason}).`,
    );
  }

  const answers = Object.values(response.answers).flat();
  const approved = answers.includes(APPROVE);
  insertAuditEntry({
    eventType: 'confirm_response',
    toolName: `mcp__dynamic-workflows__${action}`,
    input: JSON.stringify(input).substring(0, 500),
    approved,
  });
  if (!approved) {
    throw new Error(`Acao ${action} negada pelo humano no modo semi (confirmacao recusada).`);
  }
}

function unwrapWorkflow(result: WorkflowControlResult): unknown {
  if (result.ok) return result.value;
  throw new Error(result.error);
}

export interface PipelineInspectParams {
  id: string;
}
export interface PipelineCreateParams {
  projectPath: string;
  pipelineType: PipelineControlType;
  name: string;
  brief: string;
  drive?: DriveMode;
}
export interface PipelineDriveParams {
  id: string;
  mode: DriveMode;
}
export interface PipelineReplyParams {
  id: string;
  message: string;
}
export interface PipelineEscalateParams {
  id: string;
  message: string;
}
export interface PipelineApproveParams {
  id: string;
  metadata?: Record<string, unknown> | string;
}
export interface PipelineIdParams {
  id: string;
}
export interface PreviewOpenParams {
  target: string;
}
export interface PreviewCaptureParams extends PreviewOpenParams {
  width?: number;
  height?: number;
}
export interface DesignSessionConfigParams {
  id: string;
  agentId?: string;
  model?: string;
  reasoning?: 'low' | 'medium' | 'high';
  designSystemId?: string;
}


export interface DynamicWorkflowRunIdParams {
  runId: string;
}
export interface DynamicWorkflowAuthorRpcParams {
  projectPath: string;
  name?: string;
  workflowJsSource: string;
  start?: boolean;
}
export interface DynamicWorkflowReplyRpcParams {
  runId: string;
  message: string;
  targetNodeId?: string;
}
export interface DynamicWorkflowApproveRpcParams {
  runId: string;
  gateId: string;
  decision: 'approve' | 'reject';
  reason?: string;
  payload?: Record<string, unknown>;
}
export interface DynamicWorkflowInterveneRpcParams {
  runId: string;
  intervention: DynamicWorkflowIntervention;
}
export interface DynamicWorkflowEditCoordinatorRpcParams {
  runId: string;
  workflowJsSource: string;
  reason: string;
  resume?: boolean;
}


const REPO_GRAPH_NO_REPO_ERROR =
  'nenhum repositorio ativo nesta conversa. Peca ao usuario para vincular uma pasta pelo seletor de repositorio do chat.';

export interface RepoGraphSearchParams {
  term: string;
  kind?: string;
  limit?: number;
}
export interface RepoGraphMinimalContextParams {
  task: string;
}
export interface RepoGraphImpactParams {
  symbol: string;
  depth?: number;
}
export interface RepoGraphNodeParams {
  name: string;
}
export interface RepoGraphCallParams {
  symbol: string;
  limit?: number;
}

interface RepoGraphUsageInput {
  sessionId: string;
  repositoryId: string;
  graphStatus: RepoGraphChunkPayload['status'];
  toolName: string;
  used: boolean;
  reason?: string;
  resultCount: number;
  bytesReturned: number;
  durationMs: number;
}

async function recordRepoGraphUsage(
  ctx: JsonRpcContext,
  input: RepoGraphUsageInput,
): Promise<void> {
  const db = await import('../db');
  const source: RepoGraphChunkPayload['source'] = isSubagentDispatchInFlight()
    ? 'subagent-mcp'
    : 'orchestrator-mcp';
  const runtime = getRepoGraphTurnRuntime();
  let turnIndex = 0;
  try {
    turnIndex = db.getLatestUserTurnIndex(input.sessionId);
  } catch (err) {
    logger.warn({ err, sessionId: input.sessionId }, 'getLatestUserTurnIndex falhou (turnIndex=0)');
  }
  try {
    db.insertRepoGraphTurnUsage({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      turnIndex,
      repositoryId: input.repositoryId,
      source,
      runtime,
      toolName: input.toolName,
      used: input.used,
      reason: input.reason ?? null,
      resultCount: input.resultCount,
      bytesReturned: input.bytesReturned,
      durationMs: input.durationMs,
    });
  } catch (err) {
    logger.warn({ err, toolName: input.toolName }, 'persistencia de repo_graph_turn_usage falhou');
  }
  if (!input.used) return;
  try {
    const repoGraph: RepoGraphChunkPayload = {
      sessionId: input.sessionId,
      turnIndex: getRepoGraphTurnSession() ? turnIndex : undefined,
      repositoryId: input.repositoryId,
      status: input.graphStatus,
      used: true,
      source,
      runtime,
      toolName: input.toolName,
      resultCount: input.resultCount,
      bytesReturned: input.bytesReturned,
      durationMs: input.durationMs,
    };
    ctx.getWindow()?.webContents.send('chat:stream', {
      type: 'repo_graph',
      sessionId: input.sessionId,
      repoGraph,
    });
  } catch (err) {
    logger.warn({ err, toolName: input.toolName }, 'emissao de chunk repo_graph falhou');
  }
}

function repoGraphResultCount(toolName: string, result: unknown): number {
  const r = result as Record<string, unknown>;
  switch (toolName) {
    case 'repo_graph_search':
      return Array.isArray(r['symbols']) ? r['symbols'].length : 0;
    case 'repo_graph_minimal_context': {
      const files = Array.isArray(r['files']) ? r['files'].length : 0;
      const symbols = Array.isArray(r['symbols']) ? r['symbols'].length : 0;
      return files + symbols;
    }
    case 'repo_graph_impact':
      return Array.isArray(r['affected']) ? r['affected'].length : 0;
    case 'repo_graph_node':
      return r['node'] ? 1 : 0;
    case 'repo_graph_callers':
    case 'repo_graph_callees':
      return Array.isArray(r['related']) ? r['related'].length : 0;
    default:
      return 1;
  }
}

export async function handleRepoGraphRead(
  ctx: JsonRpcContext,
  toolName: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const sessionId = resolveRepoGraphSessionId();
  if (!sessionId) return { error: REPO_GRAPH_NO_REPO_ERROR };
  const db = await import('../db');
  const attach = db.getSessionActiveRepository(sessionId);
  if (!attach) return { error: REPO_GRAPH_NO_REPO_ERROR };
  const repo = db.getLocalRepository(attach.repositoryId);
  if (!repo) return { error: REPO_GRAPH_NO_REPO_ERROR };

  const { getRepoGraphEngine } = await import('../ipc/repo-graph');
  const reader: RepoGraphReader = getRepoGraphEngine().asReader();
  const rootPath = repo.canonicalRootPath;

  if (toolName !== 'repo_graph_status' && repo.status !== 'ready' && repo.status !== 'stale') {
    const motivo =
      repo.status === 'building'
        ? 'o graph deste repositorio esta sendo indexado; tente novamente quando o build concluir.'
        : 'o graph deste repositorio ainda nao foi criado; o usuario precisa criar pela badge CodeGraph do chat.';
    return { error: motivo };
  }

  const startedMs = Date.now();
  try {
    let result: unknown;
    switch (toolName) {
      case 'repo_graph_status': {
        const detect = await reader.detect(rootPath);
        result = {
          repository: {
            id: repo.id,
            name: repo.name,
            rootPath,
            status: repo.status,
            indexedCommit: repo.indexedCommit,
            lastIndexedAt: repo.lastIndexedAt,
          },
          graphExists: detect.exists,
          stats: detect.stats ?? null,
          ...(detect.error ? { providerError: detect.error } : {}),
        };
        break;
      }
      case 'repo_graph_search': {
        const p = params as unknown as RepoGraphSearchParams;
        if (typeof p.term !== 'string' || !p.term.trim()) throw new Error('term is required');
        result = await reader.search({ rootPath, term: p.term, kind: p.kind, limit: p.limit });
        break;
      }
      case 'repo_graph_minimal_context': {
        const p = params as unknown as RepoGraphMinimalContextParams;
        if (typeof p.task !== 'string' || !p.task.trim()) throw new Error('task is required');
        result = await reader.minimalContext({ rootPath, repositoryId: repo.id, task: p.task });
        break;
      }
      case 'repo_graph_impact': {
        const p = params as unknown as RepoGraphImpactParams;
        if (typeof p.symbol !== 'string' || !p.symbol.trim()) throw new Error('symbol is required');
        result = await reader.impact({ rootPath, symbol: p.symbol, depth: p.depth });
        break;
      }
      case 'repo_graph_node': {
        const p = params as unknown as RepoGraphNodeParams;
        if (typeof p.name !== 'string' || !p.name.trim()) throw new Error('name is required');
        result = await reader.node({ rootPath, name: p.name });
        break;
      }
      case 'repo_graph_callers': {
        const p = params as unknown as RepoGraphCallParams;
        if (typeof p.symbol !== 'string' || !p.symbol.trim()) throw new Error('symbol is required');
        result = await reader.callers({ rootPath, symbol: p.symbol, limit: p.limit });
        break;
      }
      case 'repo_graph_callees': {
        const p = params as unknown as RepoGraphCallParams;
        if (typeof p.symbol !== 'string' || !p.symbol.trim()) throw new Error('symbol is required');
        result = await reader.callees({ rootPath, symbol: p.symbol, limit: p.limit });
        break;
      }
      default:
        throw new Error(`unknown repo_graph tool: ${toolName}`);
    }

    await recordRepoGraphUsage(ctx, {
      sessionId,
      repositoryId: repo.id,
      graphStatus: repo.status,
      toolName,
      used: true,
      resultCount: repoGraphResultCount(toolName, result),
      bytesReturned: Buffer.byteLength(JSON.stringify(result) ?? '', 'utf8'),
      durationMs: Date.now() - startedMs,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordRepoGraphUsage(ctx, {
      sessionId,
      repositoryId: repo.id,
      graphStatus: repo.status,
      toolName,
      used: false,
      reason: message,
      resultCount: 0,
      bytesReturned: 0,
      durationMs: Date.now() - startedMs,
    });
    return { error: message };
  }
}


interface McpGatewayParams {
  server?: unknown;
  tool?: unknown;
  args?: unknown;
  surface?: unknown;
  sessionId?: unknown;
  turnId?: unknown;
  lane?: unknown;
}

type GatewaySurface = 'claude-sdk' | 'claude-compat-sdk' | 'codex-sdk';

function normalizeGatewaySurface(raw: unknown): GatewaySurface {
  if (raw === 'claude-compat-sdk' || raw === 'codex-sdk') return raw;
  return 'claude-sdk';
}

function normalizeGatewayLane(raw: unknown): ChatLane {
  return raw === 'telegram' || raw === 'cron' ? raw : 'desktop';
}

function requireGatewayString(value: unknown, field: string, method: string): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) {
    throw new Error(`${method}: parametro obrigatorio "${field}" ausente ou vazio`);
  }
  return s;
}

function normalizeGatewayArgs(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error('mcp_invoke: parametro "args" deve ser um objeto JSON valido');
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('mcp_invoke: parametro "args" deve ser um objeto JSON');
  }
  return parsed as Record<string, unknown>;
}

async function resolveGatewayAllowedServerIds(surface: GatewaySurface): Promise<string[]> {
  const { getMCPConfigForAgent } = await import('../mcp-manager');
  const { isDirectMcpHelper } = await import('../mcp-risk-patterns');
  const config = await getMCPConfigForAgent(undefined, { surface, fullCatalog: true });
  if (!config) return [];
  return Object.keys(config).filter((id) => !isDirectMcpHelper(id));
}

async function handleGatewayMcpInvoke(
  params: McpGatewayParams,
): Promise<{ content: string; isError?: boolean; displayName: string }> {
  const server = requireGatewayString(params.server, 'server', 'mcp_invoke');
  const tool = requireGatewayString(params.tool, 'tool', 'mcp_invoke');
  const surface = normalizeGatewaySurface(params.surface);
  const activeTurn = getActiveChatTurnByLane(normalizeGatewayLane(params.lane));
  const sessionId =
    activeTurn?.sessionId ??
    (typeof params.sessionId === 'string' && params.sessionId.trim()
      ? params.sessionId
      : 'gateway-session');
  const turnId =
    activeTurn?.turnId ??
    (typeof params.turnId === 'string' && params.turnId.trim() ? params.turnId : '1');

  const allowedServerIds = await resolveGatewayAllowedServerIds(surface);
  const { invokeMcpTool } = await import('../mcp-invoke');
  const gateContext: McpInvocationContext = {
    surface: 'chat',
    ...(activeTurn ? { sessionId: activeTurn.sessionId, turnId: activeTurn.turnId } : {}),
  };
  return invokeMcpTool({
    serverId: server,
    toolName: tool,
    args: normalizeGatewayArgs(params.args),
    surface,
    sessionId,
    turnId,
    allowedServerIds,
    context: gateContext,
  });
}

async function handleGatewayMcpGetSchema(
  params: McpGatewayParams,
): Promise<{ content: string; isError?: boolean }> {
  const server = requireGatewayString(params.server, 'server', 'mcp_get_schema');
  const tool = requireGatewayString(params.tool, 'tool', 'mcp_get_schema');
  const surface = normalizeGatewaySurface(params.surface);
  const allowedServerIds = await resolveGatewayAllowedServerIds(surface);
  if (!allowedServerIds.includes(server)) {
    return {
      content:
        `Servidor MCP "${server}" nao esta no catalogo desta sessao. Servidores permitidos: ${
          allowedServerIds.length > 0 ? allowedServerIds.join(', ') : '(nenhum)'
        }.`,
      isError: true,
    };
  }
  const { getMcpToolSchema } = await import('../mcp-invoke');
  return getMcpToolSchema(server, tool);
}


interface MintHelperTokenParams {
  server_id?: unknown;
  caller_pid?: unknown;
}

function handleMintHelperToken(params: MintHelperTokenParams): { token: string } {
  const serverId =
    typeof params.server_id === 'string' ? params.server_id.trim().toLowerCase() : '';
  const identityScoped = PROCESS_IDENTITY_HELPER_IDS.has(serverId);
  if (!serverId || !identityScoped) {
    throw new Error(
      `mint_helper_token: server_id "${serverId || '(vazio)'}" nao e um helper gated nem helper com identidade de processo conhecida`,
    );
  }
  const callerPid = typeof params.caller_pid === 'number' ? params.caller_pid : null;
  insertAuditEntry({
    eventType: 'tool_call',
    toolName: 'mint_helper_token',
    input: JSON.stringify({ server_id: serverId, caller_pid: callerPid }),
  });
  return { token: mintHelperToken(serverId) };
}


export interface RunToolScriptParams {
  code?: unknown;
}

export interface RunToolScriptRpcResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  toolCallCount: number;
  timedOut: boolean;
  aborted: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  toolCallLimitExceeded: boolean;
  persistedPath?: string;
}

export async function handleRunToolScript(
  ctx: JsonRpcContext,
  params: RunToolScriptParams,
): Promise<RunToolScriptRpcResult | { error: string; code?: string }> {
  const resolution = resolveGatedCallTurnContext(ctx, 'lionclaw-toolscript');
  if (!resolution.ok || resolution.sessionId === undefined || resolution.turnId === undefined) {
    return {
      error:
        'run_tool_script fail-closed: identidade do turno nao resolvida ' +
        `(${resolution.reason}); o helper precisa de handshake valido e de um turno desktop ativo com turn-context`,
      code: resolution.reason,
    };
  }
  const code = typeof params?.code === 'string' ? params.code : '';
  if (code.trim().length === 0) {
    return { error: 'run_tool_script: "code" (string nao-vazia) e obrigatorio' };
  }

  const signal = desktopLane.currentAbortController?.signal;
  if (signal === undefined || signal.aborted) {
    return {
      error:
        'run_tool_script: turno desktop sem execucao ativa (stop em curso ou corrida); nada foi executado',
      code: 'turn-aborted',
    };
  }

  const sessionId = resolution.sessionId;
  const turnId = resolution.turnId;

  const runActivityId = `toolscript:${turnId}:${crypto.randomBytes(3).toString('hex')}`;
  let rpcActivitySeq = 0;
  const emitToolScriptActivity = (ev: LiveActivityEvent): void => {
    try {
      const turnIndex = getLatestUserTurnIndex(sessionId);
      const win = ctx.getWindow();
      const send = (chunk: StreamChunk): void => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('chat:stream', { ...chunk, sessionId });
        }
      };
      recordActivity(sessionId, turnIndex, ev, send);
    } catch (err) {
      logger.warn(
        { err, sessionId, turnId, activityId: ev.id },
        'Activity Log do tool-script falhou (script nao afetado)',
      );
    }
  };

  const runStartedAtMs = Date.now();
  const runStartedAtIso = new Date(runStartedAtMs).toISOString();

  try {
    const [
      { runToolScript },
      { createToolScriptDispatcher },
      { buildToolScriptEnv },
      { readToolScriptSettings },
    ] = await Promise.all([
      import('../tool-script/tool-script-engine'),
      import('../tool-script/tool-script-dispatch'),
      import('../tool-script/tool-script-env'),
      import('../tool-script/tool-script-settings'),
    ]);

    const settings = readToolScriptSettings();
    if (!settings.enabled) {
      return {
        error:
          'run_tool_script desabilitado (tool_script_enabled=false); reative na pagina de Settings',
        code: 'tool-script-disabled',
      };
    }

    emitToolScriptActivity({
      id: runActivityId,
      kind: 'tool',
      phase: 'start',
      label: 'run_tool_script',
      toolName: 'run_tool_script',
      status: 'running',
      startedAt: runStartedAtIso,
      description: codePreviewForActivity(code),
    });

    const dispatchRpc = createToolScriptDispatcher({
      code,
      getWindow: ctx.getWindow,
      abortSignal: signal,
      enabledTools: settings.enabledTools,
      onToolCall: (entry) => {
        logger.info(
          {
            sessionId: entry.sessionId,
            turnId: entry.turnId,
            tool: entry.tool,
            displayName: entry.displayName,
            ok: entry.ok,
            durationMs: entry.durationMs,
            ...(entry.error !== undefined ? { rpcError: entry.error } : {}),
          },
          'tool-script RPC despachada',
        );
        rpcActivitySeq++;
        emitToolScriptActivity({
          id: `${runActivityId}:rpc:${rpcActivitySeq}`,
          parentId: runActivityId,
          kind: 'tool',
          phase: 'end',
          label: entry.displayName,
          toolName: entry.tool,
          status: entry.ok ? 'done' : 'error',
          durationMs: entry.durationMs,
          ...(entry.error !== undefined ? { description: entry.error } : {}),
        });
      },
    });

    const result = await runToolScript(
      {
        code,
        sessionId,
        turnId,
        abortSignal: signal,
      },
      {
        dispatchRpc,
        buildEnv: buildToolScriptEnv,
        enabledTools: settings.enabledTools,
        timeoutMs: settings.timeoutMs,
        maxStdoutBytes: settings.maxStdoutBytes,
        maxStderrBytes: settings.maxStderrBytes,
        maxToolCalls: settings.maxToolCalls,
      },
    );

    emitToolScriptActivity({
      id: runActivityId,
      kind: 'tool',
      phase: 'end',
      label: 'run_tool_script',
      toolName: 'run_tool_script',
      status: result.aborted ? 'stopped' : result.exitCode === 0 ? 'done' : 'error',
      startedAt: runStartedAtIso,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - runStartedAtMs,
      summary: `exit ${result.exitCode}, ${result.toolCallCount} tool call(s)${
        result.timedOut ? ', timeout' : ''
      }${result.aborted ? ', abortado' : ''}`,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      toolCallCount: result.toolCallCount,
      timedOut: result.timedOut,
      aborted: result.aborted,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      toolCallLimitExceeded: result.toolCallLimitExceeded,
      ...(result.persistedPath !== undefined ? { persistedPath: result.persistedPath } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, sessionId, turnId },
      'run_tool_script falhou',
    );
    emitToolScriptActivity({
      id: runActivityId,
      kind: 'tool',
      phase: 'end',
      label: 'run_tool_script',
      toolName: 'run_tool_script',
      status: 'error',
      startedAt: runStartedAtIso,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - runStartedAtMs,
      description: message,
    });
    const errCode = (err as { code?: unknown })?.code;
    return typeof errCode === 'string' ? { error: message, code: errCode } : { error: message };
  }
}

function codePreviewForActivity(code: string): string {
  const firstLine = code.split('\n').find((line) => line.trim().length > 0) ?? '';
  const trimmed = firstLine.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}...` : trimmed;
}


const KANBAN_METHODS = new Set([
  'kanban_board_create',
  'kanban_board_list',
  'kanban_card_create',
  'kanban_card_get',
  'kanban_card_query',
  'kanban_card_update',
  'kanban_card_move',
  'kanban_card_deliver',
  'kanban_card_delete',
  'kanban_card_attach',
]);

export function isKanbanMethod(method: string): boolean {
  return KANBAN_METHODS.has(method);
}

function kanbanStr(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' ? value : undefined;
}

function kanbanNullableStr(
  params: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in params)) return undefined;
  const value = params[key];
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function kanbanLocalId(params: Record<string, unknown>): number {
  const value = params['local_id'];
  return typeof value === 'number' ? value : Number(value);
}

async function handleKanbanMethod(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const { getKanbanEngine } = await import('../kanban-engine');
  const engine = getKanbanEngine();
  const actor = resolveKanbanActor();
  const board = kanbanStr(params, 'board') ?? '';
  switch (method) {
    case 'kanban_board_create':
      return engine.createBoard({
        name: kanbanStr(params, 'name'),
        prefix: kanbanStr(params, 'prefix'),
        repositoryId: kanbanStr(params, 'repository_id'),
        repoPath: kanbanStr(params, 'repo_path'),
      });
    case 'kanban_board_list':
      return engine.listBoards();
    case 'kanban_card_create':
      return engine.createCard(
        {
          board,
          title: kanbanStr(params, 'title'),
          column: kanbanStr(params, 'column'),
          type: kanbanNullableStr(params, 'type'),
          priority: kanbanNullableStr(params, 'priority'),
          complexity: kanbanNullableStr(params, 'complexity'),
          severity: kanbanNullableStr(params, 'severity'),
          problem: kanbanNullableStr(params, 'problem'),
          acceptanceCriteria: kanbanNullableStr(params, 'acceptance_criteria'),
          reproduction: kanbanNullableStr(params, 'reproduction'),
          acceptanceTests: kanbanNullableStr(params, 'acceptance_tests'),
          commitUrl: kanbanNullableStr(params, 'commit_url'),
          docRef: kanbanNullableStr(params, 'doc_ref'),
          startDate: kanbanNullableStr(params, 'start_date'),
          dueDate: kanbanNullableStr(params, 'due_date'),
          body: kanbanNullableStr(params, 'body'),
        },
        actor,
      );
    case 'kanban_card_get':
      return engine.getCard(board, kanbanLocalId(params));
    case 'kanban_card_query': {
      const stalledDays = params['stalled_days'];
      return engine.queryCards({
        board: kanbanStr(params, 'board'),
        column: kanbanStr(params, 'column'),
        type: kanbanStr(params, 'type'),
        priority: kanbanStr(params, 'priority'),
        severity: kanbanStr(params, 'severity'),
        text: kanbanStr(params, 'text'),
        dueBefore: kanbanStr(params, 'due_before'),
        stalledDays: typeof stalledDays === 'number' ? stalledDays : undefined,
        archived: params['archived'] === true,
      });
    }
    case 'kanban_card_update': {
      const patch: KanbanCardPatch = {
        type: kanbanNullableStr(params, 'type'),
        priority: kanbanNullableStr(params, 'priority'),
        complexity: kanbanNullableStr(params, 'complexity'),
        severity: kanbanNullableStr(params, 'severity'),
        problem: kanbanNullableStr(params, 'problem'),
        acceptanceCriteria: kanbanNullableStr(params, 'acceptance_criteria'),
        reproduction: kanbanNullableStr(params, 'reproduction'),
        acceptanceTests: kanbanNullableStr(params, 'acceptance_tests'),
        commitUrl: kanbanNullableStr(params, 'commit_url'),
        docRef: kanbanNullableStr(params, 'doc_ref'),
        startDate: kanbanNullableStr(params, 'start_date'),
        dueDate: kanbanNullableStr(params, 'due_date'),
        body: kanbanNullableStr(params, 'body'),
      };
      if (typeof params['title'] === 'string') patch.title = params['title'];
      if (typeof params['archived'] === 'boolean') patch.archived = params['archived'];
      return engine.updateCard(board, kanbanLocalId(params), patch, actor);
    }
    case 'kanban_card_move':
      return engine.moveCard(
        board,
        kanbanLocalId(params),
        kanbanStr(params, 'to_column') ?? '',
        kanbanNullableStr(params, 'reason'),
        actor,
      );
    case 'kanban_card_deliver':
      return engine.deliverCard(
        board,
        kanbanLocalId(params),
        kanbanNullableStr(params, 'commit'),
        kanbanNullableStr(params, 'to_column'),
        actor,
      );
    case 'kanban_card_delete':
      return engine.deleteCard(board, kanbanLocalId(params), params['hard'] === true, actor);
    case 'kanban_card_attach':
      return engine.attachFile(
        board,
        kanbanLocalId(params),
        kanbanStr(params, 'file_path') ?? '',
        actor,
      );
    default:
      return { error: `metodo kanban desconhecido: ${method}` };
  }
}


export interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export async function dispatch(
  ctx: JsonRpcContext,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const id = req.id ?? null;
  try {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const gatedServerId = gatedServerIdForMethod(req.method);
    if (gatedServerId !== null) {
      if (getChatCapabilityGateMode() === 'enforce') {
        const denial = enforceGatedCallCapability(ctx, gatedServerId, req.method);
        if (denial !== null) {
          return { jsonrpc: '2.0', id, result: denial };
        }
      } else {
        logGatedCallShadowResolution(ctx, req.method);
        observeGatedCallCapabilityShadow(ctx, gatedServerId, req.method);
      }
    }
    switch (req.method) {
      case 'list_agents': {
        return { jsonrpc: '2.0', id, result: handleListAgents() };
      }
      case 'agent_details': {
        return {
          jsonrpc: '2.0',
          id,
          result: handleAgentDetails(params as unknown as AgentDetailsParams),
        };
      }
      case 'call_agent': {
        const result = await handleCallAgent(
          ctx,
          params as unknown as CallAgentParams,
          { kind: 'local-ipc-request-id', value: String(id) },
        );
        return { jsonrpc: '2.0', id, result };
      }
      case 'list_skills': {
        return { jsonrpc: '2.0', id, result: handleListSkills() };
      }
      case 'load_skill': {
        return {
          jsonrpc: '2.0',
          id,
          result: handleLoadSkill(params as unknown as LoadSkillParams),
        };
      }
      case 'ask_user_question': {
        const result = await handleAskUserQuestion(
          ctx,
          params as unknown as AskUserQuestionParams,
        );
        return { jsonrpc: '2.0', id, result };
      }
      case 'get_mcp_env': {
        const result = await handleGetMcpEnv(params as unknown as GetMcpEnvParams);
        return { jsonrpc: '2.0', id, result };
      }
      case 'mint_helper_token': {
        const result = handleMintHelperToken(params as MintHelperTokenParams);
        return { jsonrpc: '2.0', id, result };
      }
      case 'run_tool_script': {
        const result = await handleRunToolScript(ctx, params as RunToolScriptParams);
        return { jsonrpc: '2.0', id, result };
      }
      case 'pipeline_list': {
        assertOrchestratorCaller('pipeline_list');
        return { jsonrpc: '2.0', id, result: unwrap(pipelineListCore()) };
      }
      case 'pipeline_inspect': {
        assertOrchestratorCaller('pipeline_inspect');
        const p = params as unknown as PipelineInspectParams;
        return { jsonrpc: '2.0', id, result: unwrap(pipelineInspectCore(p.id)) };
      }
      case 'pipeline_create': {
        assertOrchestratorCaller('pipeline_create');
        const p = params as unknown as PipelineCreateParams;
        await gatePipelineWrite(ctx, 'pipeline_create', params);
        return {
          jsonrpc: '2.0',
          id,
          result: unwrap(
            await pipelineCreateCore({
              projectPath: p.projectPath,
              pipelineType: p.pipelineType,
              name: p.name,
              brief: p.brief,
              drive: p.drive,
            }),
          ),
        };
      }
      case 'pipeline_drive': {
        assertOrchestratorCaller('pipeline_drive');
        const p = params as unknown as PipelineDriveParams;
        await gatePipelineWrite(ctx, 'pipeline_drive', params);
        return { jsonrpc: '2.0', id, result: unwrap(pipelineDriveCore(p.id, p.mode)) };
      }
      case 'pipeline_reply': {
        assertOrchestratorCaller('pipeline_reply');
        const p = params as unknown as PipelineReplyParams;
        await gatePipelineWrite(ctx, 'pipeline_reply', params);
        return { jsonrpc: '2.0', id, result: unwrap(await pipelineReplyCore(p.id, p.message)) };
      }
      case 'pipeline_approve': {
        assertOrchestratorCaller('pipeline_approve');
        const p = params as unknown as PipelineApproveParams;
        await gatePipelineWrite(ctx, 'pipeline_approve', params);
        const metadata = normalizeApproveMetadata(p.metadata);
        return { jsonrpc: '2.0', id, result: unwrap(await pipelineApproveCore(p.id, metadata)) };
      }
      case 'pipeline_escalate': {
        assertOrchestratorCaller('pipeline_escalate');
        const p = params as unknown as PipelineEscalateParams;
        await gatePipelineWrite(ctx, 'pipeline_escalate', params);
        return { jsonrpc: '2.0', id, result: unwrap(pipelineEscalateCore(p.id, p.message)) };
      }
      case 'pipeline_abort': {
        assertOrchestratorCaller('pipeline_abort');
        const p = params as unknown as PipelineIdParams;
        await gatePipelineWrite(ctx, 'pipeline_abort', params);
        return { jsonrpc: '2.0', id, result: unwrap(pipelineAbortCore(p.id)) };
      }
      case 'pipeline_pause': {
        assertOrchestratorCaller('pipeline_pause');
        const p = params as unknown as PipelineIdParams;
        await gatePipelineWrite(ctx, 'pipeline_pause', params);
        return { jsonrpc: '2.0', id, result: unwrap(pipelinePauseCore(p.id)) };
      }
      case 'dynamic_workflow_author': {
        assertOrchestratorCaller('dynamic_workflow_author');
        const p = params as unknown as DynamicWorkflowAuthorRpcParams;
        await gateDynamicWorkflowWrite(ctx, 'dynamic_workflow_author', params);
        return {
          jsonrpc: '2.0',
          id,
          result: unwrapWorkflow(
            await dynamicWorkflowAuthorCore({
              projectPath: p.projectPath,
              ...(p.name !== undefined ? { name: p.name } : {}),
              workflowJsSource: p.workflowJsSource,
              ...(p.start !== undefined ? { start: p.start } : {}),
            }),
          ),
        };
      }
      case 'dynamic_workflow_start': {
        assertOrchestratorCaller('dynamic_workflow_start');
        const p = params as unknown as DynamicWorkflowRunIdParams;
        await gateDynamicWorkflowWrite(ctx, 'dynamic_workflow_start', params);
        return {
          jsonrpc: '2.0',
          id,
          result: unwrapWorkflow(await dynamicWorkflowStartCore(p.runId)),
        };
      }
      case 'dynamic_workflow_inspect': {
        assertOrchestratorCaller('dynamic_workflow_inspect');
        const p = params as unknown as DynamicWorkflowRunIdParams;
        return {
          jsonrpc: '2.0',
          id,
          result: unwrapWorkflow(await dynamicWorkflowInspectCore(p.runId)),
        };
      }
      case 'dynamic_workflow_reply': {
        assertOrchestratorCaller('dynamic_workflow_reply');
        const p = params as unknown as DynamicWorkflowReplyRpcParams;
        await gateDynamicWorkflowWrite(ctx, 'dynamic_workflow_reply', params);
        return {
          jsonrpc: '2.0',
          id,
          result: unwrapWorkflow(
            await dynamicWorkflowReplyCore(p.runId, p.message, p.targetNodeId),
          ),
        };
      }
      case 'dynamic_workflow_approve': {
        assertOrchestratorCaller('dynamic_workflow_approve');
        const p = params as unknown as DynamicWorkflowApproveRpcParams;
        await gateDynamicWorkflowWrite(ctx, 'dynamic_workflow_approve', params);
        return {
          jsonrpc: '2.0',
          id,
          result: unwrapWorkflow(
            await dynamicWorkflowApproveCore(p.runId, p.gateId, {
              decision: p.decision,
              reason: p.reason,
              ...(p.payload ? { payload: p.payload } : {}),
            }),
          ),
        };
      }
      case 'dynamic_workflow_intervene': {
        assertOrchestratorCaller('dynamic_workflow_intervene');
        const p = params as unknown as DynamicWorkflowInterveneRpcParams;
        await gateDynamicWorkflowWrite(ctx, 'dynamic_workflow_intervene', params);
        return {
          jsonrpc: '2.0',
          id,
          result: unwrapWorkflow(
            await dynamicWorkflowInterveneCore(p.runId, p.intervention),
          ),
        };
      }
      case 'dynamic_workflow_abort': {
        assertOrchestratorCaller('dynamic_workflow_abort');
        const p = params as unknown as DynamicWorkflowRunIdParams;
        await gateDynamicWorkflowWrite(ctx, 'dynamic_workflow_abort', params);
        return {
          jsonrpc: '2.0',
          id,
          result: unwrapWorkflow(await dynamicWorkflowAbortCore(p.runId)),
        };
      }
      case 'dynamic_workflow_edit_coordinator': {
        assertOrchestratorCaller('dynamic_workflow_edit_coordinator');
        const p = params as unknown as DynamicWorkflowEditCoordinatorRpcParams;
        await gateDynamicWorkflowWrite(ctx, 'dynamic_workflow_edit_coordinator', params);
        return {
          jsonrpc: '2.0',
          id,
          result: unwrapWorkflow(
            await dynamicWorkflowEditCoordinatorCore({
              runId: p.runId,
              workflowJsSource: p.workflowJsSource,
              reason: p.reason,
              ...(p.resume !== undefined ? { resume: p.resume } : {}),
            }),
          ),
        };
      }
      case 'preview_open': {
        assertAuthenticatedMethodOwner(ctx, 'preview_open');
        assertOrchestratorCaller('preview_open');
        const p = params as unknown as PreviewOpenParams;
        await gatePreviewOpen(ctx, params);
        return { jsonrpc: '2.0', id, result: unwrap(await previewOpenCore(p.target)) };
      }
      case 'preview_capture': {
        assertAuthenticatedMethodOwner(ctx, 'preview_capture');
        assertOrchestratorCaller('preview_capture');
        const p = params as unknown as PreviewCaptureParams;
        return {
          jsonrpc: '2.0',
          id,
          result: unwrap(await previewCaptureCore(p.target, { width: p.width, height: p.height })),
        };
      }
      case 'design_session_config': {
        assertOrchestratorCaller('design_session_config');
        const p = params as unknown as DesignSessionConfigParams;
        await gatePipelineWrite(ctx, 'design_session_config', params);
        return { jsonrpc: '2.0', id, result: unwrap(await designSessionConfigCore(p)) };
      }
      case 'telegram_notify': {
        assertAuthenticatedMethodOwner(ctx, 'telegram_notify');
        assertOrchestratorCaller('telegram_notify');
        const message = typeof params['message'] === 'string' ? (params['message'] as string) : '';
        const { getTelegramArmed } = await import('../db');
        if (!getTelegramArmed()) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              sent: false,
              disarmed: true,
              message:
                'O envio para o Telegram esta DESARMADO. Peca ao usuario para acender o icone do Telegram ao lado do chip Repo no chat para habilitar o envio.',
            },
          };
        }
        const { isTelegramRunning, sendTelegramNotification } = await import('../telegram-bridge');
        if (!isTelegramRunning()) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              sent: false,
              reason: 'bot-offline',
              message: 'O bot do Telegram esta offline ou sem destinatario configurado.',
            },
          };
        }
        try {
          await sendTelegramNotification(message);
          return { jsonrpc: '2.0', id, result: { sent: true } };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              sent: false,
              reason: 'send-failed',
              message: `Falha ao enviar para o Telegram: ${error instanceof Error ? error.message : String(error)}`,
            },
          };
        }
      }
      case 'mcp_invoke': {
        const result = await handleGatewayMcpInvoke(params as McpGatewayParams);
        return { jsonrpc: '2.0', id, result };
      }
      case 'mcp_get_schema': {
        const result = await handleGatewayMcpGetSchema(params as McpGatewayParams);
        return { jsonrpc: '2.0', id, result };
      }
      case 'repo_graph_status':
      case 'repo_graph_search':
      case 'repo_graph_minimal_context':
      case 'repo_graph_impact':
      case 'repo_graph_node':
      case 'repo_graph_callers':
      case 'repo_graph_callees': {
        const result = await handleRepoGraphRead(ctx, req.method, params);
        return { jsonrpc: '2.0', id, result };
      }
      case 'kanban_board_create':
      case 'kanban_board_list':
      case 'kanban_card_create':
      case 'kanban_card_get':
      case 'kanban_card_query':
      case 'kanban_card_update':
      case 'kanban_card_move':
      case 'kanban_card_deliver':
      case 'kanban_card_delete':
      case 'kanban_card_attach': {
        const result = await handleKanbanMethod(req.method, params);
        return { jsonrpc: '2.0', id, result };
      }
      default: {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { jsonrpc: '2.0', id, error: { code: -32000, message } };
  }
}
