
import { createLogger } from './logger';
import { verifyInternalCapabilityLease } from './chat-capability-lease';
import type { AgentPermissionProfile } from './agent-runtime/types';
import type { ChatFeatureToggles } from '../../src/types';

const logger = createLogger('chat-capability-context');


export const CHAT_TURN_CONTEXT_TTL_SETTING_KEY = 'chat_turn_context_ttl_ms';

export const DEFAULT_CHAT_TURN_CONTEXT_TTL_MS = 1_800_000;


export type ChatLane = 'desktop' | 'telegram' | 'cron';

export function toChatLane(name: string): ChatLane | undefined {
  return name === 'desktop' || name === 'telegram' || name === 'cron'
    ? name
    : undefined;
}

export type ChatTurnOrigin = 'user' | 'system-event';

export type ChatCapabilityName = 'pipelineControl' | 'dynamicWorkflows';

export interface ChatCapabilityTurnContext {
  surface: 'chat';
  sessionId: string;
  turnId: string;
  origin: ChatTurnOrigin;
  capabilities: ChatFeatureToggles;
  cwd?: string;
  permissionProfile?: AgentPermissionProfile;
  allowedTools?: string[];
  allowedServerIds?: string[];
  readRoots?: string[];
  writeRoots?: string[];
  createdAt: number;
  expiresAt: number;
  internalLeaseToken?: string;
  driveProjectId?: string;
  driveTurnId?: string;
  leaseCoordinator?: string;
  leaseCapability?: ChatCapabilityName;
}

export type ChatCapabilityTurnContextInput = Omit<
  ChatCapabilityTurnContext,
  'createdAt' | 'expiresAt' | 'origin'
> & { origin?: ChatTurnOrigin };

interface TurnContextEntry {
  ctx: ChatCapabilityTurnContext;
  ttlMs: number;
  expiresAt: number;
}


const turnContexts = new Map<string, TurnContextEntry>();

const activeTurns = new Map<string, string>();

const laneActiveTurns = new Map<ChatLane, { sessionId: string; turnId: string }>();

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}::${turnId}`;
}

function laneKey(sessionId: string, lane: ChatLane): string {
  return `${lane}::${sessionId}`;
}

function sweepExpiredTurnContexts(now: number): void {
  for (const [key, entry] of turnContexts) {
    if (now >= entry.expiresAt) {
      turnContexts.delete(key);
      logger.debug(
        { sessionId: entry.ctx.sessionId, turnId: entry.ctx.turnId },
        'turn-context expirado removido na varredura',
      );
    }
  }
}


export function registerChatCapabilityTurn(
  ctx: ChatCapabilityTurnContextInput,
  ttlMs?: number,
): void {
  const effectiveTtl =
    typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0
      ? ttlMs
      : DEFAULT_CHAT_TURN_CONTEXT_TTL_MS;
  const now = Date.now();
  sweepExpiredTurnContexts(now);

  const key = turnKey(ctx.sessionId, ctx.turnId);
  const existing = turnContexts.get(key);
  if (existing && now < existing.expiresAt) {
    logger.warn(
      { sessionId: ctx.sessionId, turnId: ctx.turnId },
      'registerChatCapabilityTurn sobrescrevendo registro vivo do mesmo turno',
    );
  }

  const expiresAt = now + effectiveTtl;
  const stored: ChatCapabilityTurnContext = {
    ...ctx,
    capabilities: { ...ctx.capabilities },
    allowedTools: ctx.allowedTools === undefined ? undefined : [...ctx.allowedTools],
    allowedServerIds:
      ctx.allowedServerIds === undefined ? undefined : [...ctx.allowedServerIds],
    readRoots: ctx.readRoots === undefined ? undefined : [...ctx.readRoots],
    writeRoots: ctx.writeRoots === undefined ? undefined : [...ctx.writeRoots],
    origin: ctx.origin ?? 'user',
    createdAt: now,
    expiresAt,
  };
  turnContexts.set(key, { ctx: stored, ttlMs: effectiveTtl, expiresAt });
  logger.debug(
    {
      sessionId: stored.sessionId,
      turnId: stored.turnId,
      origin: stored.origin,
      hasLease: stored.internalLeaseToken !== undefined,
      ttlMs: effectiveTtl,
    },
    'turn-context registrado',
  );
}

export function getChatCapabilityTurn(input: {
  sessionId: string;
  turnId: string;
}): ChatCapabilityTurnContext | undefined {
  const key = turnKey(input.sessionId, input.turnId);
  const entry = turnContexts.get(key);
  if (!entry) return undefined;

  const now = Date.now();
  if (now >= entry.expiresAt) {
    turnContexts.delete(key);
    logger.debug(
      { sessionId: input.sessionId, turnId: input.turnId },
      'turn-context expirado (TTL backstop) — removido no get',
    );
    return undefined;
  }

  entry.expiresAt = now + entry.ttlMs;
  return {
    ...entry.ctx,
    capabilities: { ...entry.ctx.capabilities },
    allowedTools:
      entry.ctx.allowedTools === undefined ? undefined : [...entry.ctx.allowedTools],
    allowedServerIds:
      entry.ctx.allowedServerIds === undefined
        ? undefined
        : [...entry.ctx.allowedServerIds],
    readRoots: entry.ctx.readRoots === undefined ? undefined : [...entry.ctx.readRoots],
    writeRoots: entry.ctx.writeRoots === undefined ? undefined : [...entry.ctx.writeRoots],
    expiresAt: entry.expiresAt,
  };
}

export function clearChatCapabilityTurn(input: {
  sessionId: string;
  turnId: string;
}): void {
  turnContexts.delete(turnKey(input.sessionId, input.turnId));
}


export function setActiveChatTurn(input: {
  sessionId: string;
  lane: ChatLane;
  turnId: string;
}): void {
  activeTurns.set(laneKey(input.sessionId, input.lane), input.turnId);
  laneActiveTurns.set(input.lane, {
    sessionId: input.sessionId,
    turnId: input.turnId,
  });
}

export function getActiveChatTurn(input: {
  sessionId: string;
  lane: ChatLane;
}): string | undefined {
  return activeTurns.get(laneKey(input.sessionId, input.lane));
}

export function getActiveChatTurnByLane(
  lane: ChatLane,
): { sessionId: string; turnId: string } | undefined {
  const entry = laneActiveTurns.get(lane);
  return entry === undefined ? undefined : { ...entry };
}

export function clearActiveChatTurn(input: {
  sessionId: string;
  lane: ChatLane;
  turnId?: string;
}): void {
  const key = laneKey(input.sessionId, input.lane);
  if (input.turnId !== undefined) {
    const current = activeTurns.get(key);
    if (current !== undefined && current !== input.turnId) {
      logger.warn(
        { sessionId: input.sessionId, lane: input.lane, staleTurnId: input.turnId },
        'clearActiveChatTurn ignorado: turno informado nao e mais o ativo da lane',
      );
      return;
    }
  }
  activeTurns.delete(key);
  const laneEntry = laneActiveTurns.get(input.lane);
  if (
    laneEntry !== undefined &&
    laneEntry.sessionId === input.sessionId &&
    (input.turnId === undefined || laneEntry.turnId === input.turnId)
  ) {
    laneActiveTurns.delete(input.lane);
  }
}


export interface ResolveEffectiveCapabilitiesInput {
  sessionToggles: ChatFeatureToggles;
  origin?: ChatTurnOrigin;
  lease?: { valid: boolean; capability: ChatCapabilityName };
}

export function resolveEffectiveCapabilities(
  input: ResolveEffectiveCapabilitiesInput,
): ChatFeatureToggles {
  const effective: ChatFeatureToggles = {
    pipelineControl: input.sessionToggles.pipelineControl,
    dynamicWorkflows: input.sessionToggles.dynamicWorkflows,
  };
  if (input.origin === 'system-event' && input.lease?.valid === true) {
    effective[input.lease.capability] = true;
  }
  return effective;
}

const CAPABILITY_LEASE_PROBES: Readonly<
  Record<ChatCapabilityName, { serverId: string; toolName: string }>
> = {
  pipelineControl: {
    serverId: 'lionclaw-pipeline-control',
    toolName: 'pipeline_reply',
  },
  dynamicWorkflows: {
    serverId: 'lionclaw-dynamic-workflows',
    toolName: 'dynamic_workflow_inspect',
  },
};

function deriveLease(
  turnCtx: ChatCapabilityTurnContext,
): { valid: boolean; capability: ChatCapabilityName } | undefined {
  if (turnCtx.origin !== 'system-event') return undefined;
  const {
    internalLeaseToken,
    leaseCapability,
    leaseCoordinator,
    driveProjectId,
    driveTurnId,
  } = turnCtx;
  if (
    internalLeaseToken === undefined ||
    internalLeaseToken.length === 0 ||
    leaseCapability === undefined ||
    leaseCoordinator === undefined ||
    driveProjectId === undefined ||
    driveTurnId === undefined
  ) {
    return undefined;
  }
  const probe = CAPABILITY_LEASE_PROBES[leaseCapability] as
    | { serverId: string; toolName: string }
    | undefined;
  if (probe === undefined) return undefined;
  const valid = verifyInternalCapabilityLease({
    token: internalLeaseToken,
    coordinator: leaseCoordinator,
    driveProjectId,
    driveTurnId,
    serverId: probe.serverId,
    toolName: probe.toolName,
    dryRun: true,
  });
  return valid ? { valid: true, capability: leaseCapability } : undefined;
}

export function computeEffectiveCapabilitiesForTurn(
  turnCtx: ChatCapabilityTurnContext,
): ChatFeatureToggles {
  return resolveEffectiveCapabilities({
    sessionToggles: turnCtx.capabilities,
    origin: turnCtx.origin,
    lease: deriveLease(turnCtx),
  });
}


const CHAT_CAPABILITY_SERVER_ALIASES: Readonly<Record<string, string>> = {
  'pipeline-control': 'lionclaw-pipeline-control',
};

export function normalizeChatCapabilityServerId(serverId: string): string {
  const normalized = serverId.trim().toLowerCase();
  return CHAT_CAPABILITY_SERVER_ALIASES[normalized] ?? normalized;
}


export function __resetChatCapabilityContextForTests(): void {
  turnContexts.clear();
  activeTurns.clear();
  laneActiveTurns.clear();
}
