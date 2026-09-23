import { createLogger } from '../logger';
import {
  getDynamicWorkflowRun,
  getDynamicWorkflowDefinition,
  listDynamicWorkflowRunsByStatus,
  listDynamicWorkflowRuns,
  listDynamicWorkflowEvents,
  insertDynamicWorkflowEvent,
  updateDynamicWorkflowRun,
  createSession,
} from '../db';
import { readDefaultOrchestratorColumns } from '../orchestrator-selection';
import { submitMessage } from '../orchestrator';
const tryBeginBackgroundWorkStart =
  (_lane: string): (() => void) | null =>
  () => {};
import { workflowEventBus, DYNAMIC_WORKFLOW_STREAM_CHANNEL, type WorkflowEventListener } from './workflow-events';
import {
  mintDriveCapability,
  registerReadOnlyDriveTurn,
  WAKE_CAPABILITY_ACTIONS,
  WAKE_CAPABILITY_MAX_USES,
  type DriveCapability,
} from './drive-capability';
import { createInternalCapabilityLease } from '../chat-capability-lease';
import { mintDriveTurnId as mintDriveTurnIdCore, decideOneInFlight, type DriveTurnSeq } from '../drive-turn-core';
import { hasAnyActiveDrive } from '../drive-lock';
import { onDriveTurnComplete, type DriveTurnComplete } from '../drive-usage-sink';
import type { DynamicWorkflowEvent, DynamicWorkflowEventInsertInput } from './types';
import { CC_DELIVERY_GATE_ID, isBoundaryGateId, isFailureGateId } from './types';
import {
  assessBoundary,
  computeSinceStats,
  deriveOutcome,
  deriveWakeSignal,
  eventsSince,
  findWindowStartSeq,
  buildWakePrompt,
  checkWakeRunaway,
  worstWakeReason,
  BOUNDARY_EVENT_TYPES,
  type BoundarySemaphore,
  type OutcomeDigest,
  type WakeReason,
  type WakeSignal,
} from './workflow-outcome';
import { derivePendingDecision } from './workflow-snapshot';
import type {
  DynamicWorkflowRun,
  DynamicWorkflowDefinition,
  DynamicWorkflowManifest,
  DynamicWorkflowStreamChunk,
} from '../../../src/types/dynamic-workflow';
import type { BrowserWindow } from 'electron';

const logger = createLogger('dynamic-workflow-ignition');

export type { WakeReason, WakeSignal };

interface GateBlockedPayload {
  gateId?: unknown;
  mode?: unknown;
}

interface OrchestratorGateBlock {
  runId: string;
  gateId: string;
}

export function parseOrchestratorGateBlock(event: DynamicWorkflowEvent): OrchestratorGateBlock | null {
  if (event.type !== 'gate-blocked') return null;
  let payload: GateBlockedPayload;
  try {
    payload = JSON.parse(event.payloadJson) as GateBlockedPayload;
  } catch {
    return null;
  }
  if (payload.mode !== 'orchestrator') return null;
  const gateId = typeof payload.gateId === 'string' ? payload.gateId : '';
  if (!gateId) return null;
  return { runId: event.runId, gateId };
}

export function parseWakeSignal(event: DynamicWorkflowEvent): WakeSignal | null {
  return deriveWakeSignal(event);
}

export function parsePendingGateId(run: DynamicWorkflowRun): string | null {
  try {
    const input = JSON.parse(run.inputJson || '{}') as {
      pendingDecision?: { type?: unknown; id?: unknown; gateId?: unknown };
    };
    const pd = input.pendingDecision;
    if (pd && pd.type === 'gate' && typeof pd.id === 'string' && pd.id.length > 0) {
      return pd.id;
    }
    if (pd && pd.type === 'provider' && typeof pd.gateId === 'string' && isFailureGateId(pd.gateId)) {
      return pd.gateId;
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveGateModeFromManifest(
  definition: DynamicWorkflowDefinition | null,
  gateId: string,
): DynamicWorkflowManifest['gates'][number]['mode'] | undefined {
  if (gateId === CC_DELIVERY_GATE_ID || isBoundaryGateId(gateId) || isFailureGateId(gateId)) {
    return 'orchestrator';
  }
  if (!definition) return undefined;
  try {
    const manifest = JSON.parse(definition.manifestJson) as DynamicWorkflowManifest;
    const gates = Array.isArray(manifest.gates) ? manifest.gates : [];
    return gates.find((g) => g.id === gateId)?.mode;
  } catch {
    return undefined;
  }
}

export function buildIgnitionPrompt(runId: string, gateId: string): string {
  return [
    `O workflow dinamico \`${runId}\` parou num gate tecnico que VOCE conduz como driver (mode: orchestrator).`,
    `Gate bloqueado: \`${gateId}\`.`,
    '',
    `ANTES de qualquer acao, chame \`dynamic_workflow_inspect("${runId}")\` para ler o estado FRESCO do run (gate corrente, plano, sprints, ultimo erro).`,
    'So depois de inspecionar, decida: aprovar o gate corrente, responder/intervir, ou (se for bloqueio real de NEGOCIO) escalar ao humano.',
    `Aprove apenas o gate que for o \`pendingDecision\` corrente do run \`${runId}\`. Nao da push - a entrega e merge LOCAL e reversivel.`,
  ].join('\n');
}

const driveTurnSeq: DriveTurnSeq = { value: 0 };

export function mintDriveTurnId(runId: string): string {
  return mintDriveTurnIdCore(runId, driveTurnSeq);
}

export interface WakeRequest {
  reason: WakeReason;
  gateId?: string;
  nodeId?: string;
}

export function mergeWakeRequests(a: WakeRequest | null, b: WakeRequest): WakeRequest {
  if (!a) return b;
  const worst = worstWakeReason(a.reason, b.reason);
  const winner = worst === b.reason ? b : a;
  return { ...winner };
}

interface WorkflowDriveTurnState {
  turnInFlightSince: number | null;
  currentDriveTurnId: string | null;
  currentWake: WakeRequest | null;
  pendingWake: WakeRequest | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  wakesTotal: number;
  wakesSinceProgress: number;
  lastWakeThroughSeq: number;
  runawayTriggered: boolean;
}

const workflowTurnStates = new Map<string, WorkflowDriveTurnState>();

function stateOf(runId: string): WorkflowDriveTurnState {
  let state = workflowTurnStates.get(runId);
  if (!state) {
    state = {
      turnInFlightSince: null,
      currentDriveTurnId: null,
      currentWake: null,
      pendingWake: null,
      debounceTimer: null,
      wakesTotal: 0,
      wakesSinceProgress: 0,
      lastWakeThroughSeq: 0,
      runawayTriggered: false,
    };
    workflowTurnStates.set(runId, state);
  }
  return state;
}

export const WORKFLOW_TURN_INFLIGHT_TIMEOUT_MS = 10 * 60_000;

export const WAKE_BOUNDARY_DEBOUNCE_MS = 3_000;

export function isHarnessProjectId(id: string): boolean {
  return /^\d+$/.test(id);
}

export function decideWorkflowDriveTurn(runId: string, now: number): 'fire' | 'coalesce' {
  const state = workflowTurnStates.get(runId);
  return decideOneInFlight({
    turnInFlightSince: state?.turnInFlightSince ?? null,
    now,
    hasPendingFollowup: !!state?.pendingWake,
    inflightTimeoutMs: WORKFLOW_TURN_INFLIGHT_TIMEOUT_MS,
  });
}

export function _pendingWakeForTesting(runId: string): WakeRequest | null {
  return workflowTurnStates.get(runId)?.pendingWake ?? null;
}

export function _wakeCountersForTesting(runId: string): { wakesTotal: number; wakesSinceProgress: number } {
  const s = workflowTurnStates.get(runId);
  return { wakesTotal: s?.wakesTotal ?? 0, wakesSinceProgress: s?.wakesSinceProgress ?? 0 };
}

export const DRIVE_CAPABILITY_TTL_MS = 10 * 60 * 1000;

export const WORKFLOW_LEASE_TTL_MS = 30 * 60_000;

export const WORKFLOW_LEASE_MAX_USES = 64;

export function _resetIgnitionForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error('_resetIgnitionForTesting so pode ser chamado em ambiente de teste');
  }
  driveTurnSeq.value = 0;
  for (const s of workflowTurnStates.values()) {
    if (s.debounceTimer) clearTimeout(s.debounceTimer);
  }
  workflowTurnStates.clear();
}

export interface WorkflowIgnitionDeps {
  getRun: (runId: string) => DynamicWorkflowRun | null;
  getDefinition: (definitionId: string) => DynamicWorkflowDefinition | null;
  listBlockedRuns: () => DynamicWorkflowRun[];
  listRuns?: () => DynamicWorkflowRun[];
  listEventsSince?: (runId: string, afterSeq: number) => DynamicWorkflowEvent[];
  insertEvent?: (input: DynamicWorkflowEventInsertInput) => DynamicWorkflowEvent;
  emitIPC?: (channel: string, payload: unknown) => void;
  pause?: (runId: string) => Promise<void>;
  registerReadOnlyTurn?: (driveTurnId: string) => void;
  now?: () => number;
  createDedicatedSession: (runId: string) => string;
  linkSession: (runId: string, sessionId: string) => void;
  submit: (
    prompt: string,
    options: {
      sessionId: string;
      origin: 'system-event';
      driveProjectId: string;
      driveTurnId: string;
      internalLeaseToken: string;
      leaseCoordinator: 'dynamic-workflow-ignition';
      leaseCapability: 'dynamicWorkflows';
    },
    getWindow: () => BrowserWindow | null,
  ) => void;
  getWindow: () => BrowserWindow | null;
  mintCapability: (cap: DriveCapability) => void;
  bus?: {
    subscribe: (l: WorkflowEventListener) => () => void;
    publish?: (event: DynamicWorkflowEvent) => void;
  };
  onDriveTurnComplete?: (l: (complete: DriveTurnComplete) => void) => () => void;
}

export function resolveDriveSession(
  deps: Pick<WorkflowIgnitionDeps, 'getRun' | 'createDedicatedSession' | 'linkSession'>,
  runId: string,
): string | null {
  const run = deps.getRun(runId);
  if (!run) return null;
  if (run.chatSessionId) return run.chatSessionId;
  const sessionId = deps.createDedicatedSession(runId);
  deps.linkSession(runId, sessionId);
  return sessionId;
}

function readRunEvents(deps: WorkflowIgnitionDeps, runId: string): DynamicWorkflowEvent[] {
  try {
    const reader =
      deps.listEventsSince ??
      ((id: string, afterSeq: number) => listDynamicWorkflowEvents(id, { afterSeq, limit: 100_000 }));
    return reader(runId, 0);
  } catch (err) {
    logger.warn({ err, runId }, 'ignicao: leitura de eventos falhou (janela vazia)');
    return [];
  }
}

interface RunWindow {
  all: DynamicWorkflowEvent[];
  startSeq: number;
  events: DynamicWorkflowEvent[];
  throughSeq: number;
}

function windowOf(all: DynamicWorkflowEvent[]): RunWindow {
  const startSeq = findWindowStartSeq(all);
  const events = eventsSince(all, startSeq);
  const throughSeq = all.reduce((max, e) => (e.seq > max ? e.seq : max), 0);
  return { all, startSeq, events, throughSeq };
}

function persistWakeEvent(
  deps: WorkflowIgnitionDeps,
  runId: string,
  type: 'wake-planned' | 'wake-completed' | 'wake-runaway',
  payload: Record<string, unknown>,
): void {
  try {
    const insert = deps.insertEvent ?? insertDynamicWorkflowEvent;
    const event = insert({ runId, type, payloadJson: JSON.stringify(payload) });
    const bus = deps.bus ?? workflowEventBus;
    try {
      bus.publish?.(event);
    } catch (err) {
      logger.warn({ err, runId, type }, 'ignicao: publish do evento de wake falhou (ignorado)');
    }
    if (deps.emitIPC) {
      const chunk: DynamicWorkflowStreamChunk = {
        kind: 'runner',
        runId,
        type: 'event',
        eventType: type,
        payload,
      };
      try {
        deps.emitIPC(DYNAMIC_WORKFLOW_STREAM_CHANNEL, chunk);
      } catch (err) {
        logger.warn({ err, runId, type }, 'ignicao: broadcast do evento de wake falhou (ignorado)');
      }
    }
  } catch (err) {
    logger.warn({ err, runId, type }, 'ignicao: persistencia do evento de wake falhou (ignorado)');
  }
}

type IgnitionOrigin = 'event' | 'boot-scan' | 'followup' | 'debounce';

function scheduleDebouncedWake(deps: WorkflowIgnitionDeps, runId: string, state: WorkflowDriveTurnState): void {
  if (state.debounceTimer) return;
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    const pending = state.pendingWake;
    state.pendingWake = null;
    if (pending) fireIgnition(deps, runId, pending, 'debounce');
  }, WAKE_BOUNDARY_DEBOUNCE_MS);
}

function requestWake(deps: WorkflowIgnitionDeps, runId: string, wake: WakeRequest, origin: IgnitionOrigin): void {
  const state = stateOf(runId);
  const now = (deps.now ?? Date.now)();
  if (decideWorkflowDriveTurn(runId, now) === 'coalesce') {
    state.pendingWake = mergeWakeRequests(state.pendingWake, wake);
    logger.info(
      { runId, reason: wake.reason, origin, pending: state.pendingWake.reason },
      'ignicao: turno de drive em voo - wake COALESCIDO (pendingWake)',
    );
    return;
  }
  if (wake.reason === 'boundary' && origin === 'event') {
    state.pendingWake = mergeWakeRequests(state.pendingWake, wake);
    scheduleDebouncedWake(deps, runId, state);
    return;
  }
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  }
  const merged = mergeWakeRequests(state.pendingWake, wake);
  state.pendingWake = null;
  fireIgnition(deps, runId, merged, origin);
}

function fireIgnition(deps: WorkflowIgnitionDeps, runId: string, wake: WakeRequest, origin: IgnitionOrigin): void {
  const releaseUpdateLease = tryBeginBackgroundWorkStart('dynamic-workflow-ignition');
  if (releaseUpdateLease === null) {
    stateOf(runId).pendingWake = mergeWakeRequests(stateOf(runId).pendingWake, wake);
    logger.info({ runId, reason: wake.reason, origin }, 'ignicao adiada: manutencao de update em andamento (D14)');
    return;
  }
  try {
    fireIgnitionWithLease(deps, runId, wake, origin);
  } finally {
    releaseUpdateLease();
  }
}

const BOUNDARY_SEMAPHORES: ReadonlySet<string> = new Set<string>([
  'VERDE',
  'ATENCAO',
  'SEM VEREDITO',
  'DECISAO NECESSARIA',
  'DECISAO HUMANA',
]);

function readBoundaryGateSemaphore(events: DynamicWorkflowEvent[], gateId: string): BoundarySemaphore | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type !== 'gate-blocked') continue;
    const p = parsePayload(ev);
    if (p.gateId !== gateId) continue;
    return typeof p.semaphore === 'string' && BOUNDARY_SEMAPHORES.has(p.semaphore)
      ? (p.semaphore as BoundarySemaphore)
      : null;
  }
  return null;
}

function semaphoreForWake(reason: WakeReason, boundary: BoundarySemaphore): BoundarySemaphore {
  if (reason === 'needs-human') return 'DECISAO HUMANA';
  if (reason === 'boundary') return boundary;
  return boundary === 'VERDE' ? 'DECISAO NECESSARIA' : boundary;
}

export function fireIgnitionWithLease(
  deps: WorkflowIgnitionDeps,
  runId: string,
  wake: WakeRequest,
  origin: IgnitionOrigin,
): void {
  const state = stateOf(runId);
  const now = (deps.now ?? Date.now)();

  const activeDrive = hasAnyActiveDrive();
  if (activeDrive) {
    state.pendingWake = mergeWakeRequests(state.pendingWake, wake);
    logger.info(
      { runId, reason: wake.reason, origin, activeDrive },
      'ignicao: outro drive ja ativo (lock global) - ignicao adiada (pendingWake)',
    );
    return;
  }

  if (decideWorkflowDriveTurn(runId, now) === 'coalesce') {
    state.pendingWake = mergeWakeRequests(state.pendingWake, wake);
    logger.info(
      { runId, reason: wake.reason, origin },
      'ignicao: turno de drive de workflow ja em voo para este run - COALESCE (one-in-flight)',
    );
    return;
  }

  const sessionId = resolveDriveSession(deps, runId);
  if (!sessionId) {
    logger.warn({ runId, reason: wake.reason, origin }, 'wake mas run ausente; ignicao pulada');
    return;
  }

  const all = readRunEvents(deps, runId);
  const win = windowOf(all);

  const progressed = all.some((e) => e.type === 'node-completed' && e.seq > state.lastWakeThroughSeq);
  state.wakesTotal += 1;
  state.wakesSinceProgress = progressed ? 1 : state.wakesSinceProgress + 1;
  const runaway = checkWakeRunaway({
    wakesTotal: state.wakesTotal,
    wakesSinceProgress: state.wakesSinceProgress,
  });
  let effectiveWake = wake;
  let readOnly = false;
  const durableNeedsHuman = wake.reason === 'needs-human';
  if (durableNeedsHuman && !state.runawayTriggered && !runaway.runaway) {
    state.runawayTriggered = true;
    logger.info(
      { runId, origin },
      'ignicao: needs-human recebido do duravel - regime somente-leitura ate resume/start',
    );
  }
  if (runaway.runaway || state.runawayTriggered) {
    readOnly = true;
    effectiveWake = { reason: 'needs-human' };
    if (!state.runawayTriggered) {
      state.runawayTriggered = true;
      logger.warn(
        {
          runId,
          reason: runaway.runaway ? runaway.reason : 'ja-disparado',
          wakesTotal: state.wakesTotal,
          wakesSinceProgress: state.wakesSinceProgress,
        },
        'ignicao: anti-runaway de wakes estourou - pausando o run (D6)',
      );
      if (deps.pause) {
        deps.pause(runId).catch((err) => logger.warn({ err, runId }, 'ignicao: pause por runaway falhou (ignorado)'));
      } else {
        logger.warn({ runId }, 'ignicao: runaway sem dep pause (run NAO pausado)');
      }
      persistWakeEvent(deps, runId, 'wake-runaway', {
        wakesTotal: state.wakesTotal,
        wakesSinceProgress: state.wakesSinceProgress,
        reason: runaway.runaway ? runaway.reason : null,
      });
    }
  }

  const digestAll = readOnly ? readRunEvents(deps, runId) : all;
  const digestWin = readOnly ? windowOf(digestAll) : win;
  const assessment = assessBoundary(digestWin.events, { history: digestWin.all });
  const outcomes: OutcomeDigest[] = assessment.outcomes;
  const since = computeSinceStats(outcomes);
  const boundaryGateSemaphore =
    effectiveWake.reason === 'blocked' && effectiveWake.gateId && isBoundaryGateId(effectiveWake.gateId)
      ? readBoundaryGateSemaphore(digestAll, effectiveWake.gateId)
      : null;
  const semaphore = boundaryGateSemaphore ?? semaphoreForWake(effectiveWake.reason, assessment.semaphore);
  const run = deps.getRun(runId);
  const pendingDecision = run ? (derivePendingDecision(run) ?? null) : null;
  const prompt = buildWakePrompt({
    runId,
    reason: effectiveWake.reason,
    semaphore,
    since,
    outcomes,
    pendingDecision,
    gateId: effectiveWake.gateId,
    detail: readOnly ? `wakes=${state.wakesTotal}, sem progresso=${state.wakesSinceProgress}` : undefined,
  });

  const driveTurnId = mintDriveTurnId(runId);

  state.turnInFlightSince = now;
  state.currentDriveTurnId = driveTurnId;
  state.currentWake = effectiveWake;
  state.lastWakeThroughSeq = digestWin.throughSeq;

  persistWakeEvent(deps, runId, 'wake-planned', {
    reason: effectiveWake.reason,
    fromSeq: digestWin.startSeq,
    throughSeq: digestWin.throughSeq,
    driveTurnId,
    semaphore,
    ...(effectiveWake.gateId ? { gateId: effectiveWake.gateId } : {}),
    readOnly,
  });

  if (!readOnly) {
    const expiresAt = (deps.now ?? Date.now)() + DRIVE_CAPABILITY_TTL_MS;
    if (effectiveWake.reason === 'blocked' && effectiveWake.gateId) {
      deps.mintCapability({
        runId,
        scope: 'gate',
        gateId: effectiveWake.gateId,
        driveTurnId,
        expiresAt,
      });
    }
    if (
      effectiveWake.reason === 'blocked' ||
      effectiveWake.reason === 'needs-decision' ||
      effectiveWake.reason === 'boundary'
    ) {
      deps.mintCapability({
        runId,
        scope: 'wake',
        driveTurnId,
        expiresAt,
        maxUses: WAKE_CAPABILITY_MAX_USES,
        actions: WAKE_CAPABILITY_ACTIONS,
      });
    }
  }

  if (readOnly) {
    (deps.registerReadOnlyTurn ?? registerReadOnlyDriveTurn)(driveTurnId);
  }

  logger.info(
    {
      runId,
      reason: effectiveWake.reason,
      gateId: effectiveWake.gateId,
      semaphore,
      sessionId,
      driveTurnId,
      origin,
      readOnly,
      sinceNodes: since.nodes,
    },
    'ignicao: acordando o orquestrador',
  );

  const lease = createInternalCapabilityLease({
    coordinator: 'dynamic-workflow-ignition',
    driveProjectId: runId,
    driveTurnId,
    allowedServerIds: ['lionclaw-dynamic-workflows'],
    allowedToolPrefixes: readOnly ? ['dynamic_workflow_inspect'] : ['dynamic_workflow_'],
    ttlMs: WORKFLOW_LEASE_TTL_MS,
    maxUses: WORKFLOW_LEASE_MAX_USES,
  });

  deps.submit(
    prompt,
    {
      sessionId,
      origin: 'system-event',
      driveProjectId: runId,
      driveTurnId,
      internalLeaseToken: lease.token,
      leaseCoordinator: 'dynamic-workflow-ignition',
      leaseCapability: 'dynamicWorkflows',
    },
    deps.getWindow,
  );
}

function handleDriveTurnComplete(deps: WorkflowIgnitionDeps, complete: DriveTurnComplete): void {
  const runId = complete.projectId;
  if (isHarnessProjectId(runId)) return;
  const state = workflowTurnStates.get(runId);
  if (!state) return;
  if (complete.driveTurnId === undefined || complete.driveTurnId !== state.currentDriveTurnId) {
    return;
  }
  const outcome = complete.outcome ?? 'failed-before-execution';
  persistWakeEvent(deps, runId, 'wake-completed', { driveTurnId: complete.driveTurnId, outcome });

  const finished = state.currentWake;
  state.turnInFlightSince = null;
  state.currentDriveTurnId = null;
  state.currentWake = null;
  if (outcome !== 'executed') {
    if (finished) state.pendingWake = mergeWakeRequests(state.pendingWake, finished);
    if (state.runawayTriggered) {
      logger.info({ runId, outcome }, 'ignicao: turno nao executado apos runaway - sem rearm automatico');
      return;
    }
    if (state.pendingWake) {
      logger.info(
        { runId, outcome, reason: state.pendingWake.reason },
        'ignicao: turno nao executado - wake REARMADO (debounce)',
      );
      scheduleDebouncedWake(deps, runId, state);
    }
    return;
  }
  const pending = state.pendingWake;
  if (pending) {
    state.pendingWake = null;
    fireIgnition(deps, runId, pending, 'followup');
  }
}

const RUNAWAY_RESET_EVENT_TYPES: ReadonlySet<string> = new Set<string>(['resume-requested', 'run-started']);

function handleEvent(deps: WorkflowIgnitionDeps, event: DynamicWorkflowEvent): void {
  try {
    if (RUNAWAY_RESET_EVENT_TYPES.has(event.type)) {
      const s = workflowTurnStates.get(event.runId);
      if (s) {
        s.wakesSinceProgress = 0;
        s.runawayTriggered = false;
      }
    }
    if (event.type === 'wake-runaway') return;

    const signal = parseWakeSignal(event);
    if (!signal) return;

    if (signal.reason === 'boundary') {
      const win = windowOf(readRunEvents(deps, event.runId));
      const assessment = assessBoundary(win.events, { history: win.all });
      if (assessment.since.nodes === 0) return;
      if (assessment.semaphore !== 'VERDE') return;
      requestWake(deps, event.runId, { reason: 'boundary' }, 'event');
      return;
    }
    requestWake(
      deps,
      event.runId,
      {
        reason: signal.reason,
        ...(signal.gateId ? { gateId: signal.gateId } : {}),
        ...(signal.nodeId ? { nodeId: signal.nodeId } : {}),
      },
      'event',
    );
  } catch (err) {
    logger.warn({ err, runId: event.runId, type: event.type }, 'falha ao acordar o orquestrador no evento (ignorado)');
  }
}

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set<string>(['completed', 'aborted']);

function parsePayload(event: DynamicWorkflowEvent): Record<string, unknown> {
  try {
    const p: unknown = JSON.parse(event.payloadJson || '{}');
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function findUnacknowledgedWake(events: DynamicWorkflowEvent[]): WakeRequest | null {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let candidate: { seq: number; driveTurnId: string; wake: WakeRequest } | null = null;
  for (const ev of sorted) {
    if (ev.type === 'wake-planned') {
      const p = parsePayload(ev);
      const reason = p.reason;
      const driveTurnId = typeof p.driveTurnId === 'string' ? p.driveTurnId : '';
      if (!isWakeReason(reason) || !driveTurnId) continue;
      candidate = {
        seq: ev.seq,
        driveTurnId,
        wake: { reason, ...(typeof p.gateId === 'string' ? { gateId: p.gateId } : {}) },
      };
    } else if (ev.type === 'wake-completed' && candidate) {
      const p = parsePayload(ev);
      if (p.driveTurnId === candidate.driveTurnId && p.outcome === 'executed') candidate = null;
    }
  }
  return candidate?.wake ?? null;
}

function isWakeReason(value: unknown): value is WakeReason {
  return value === 'needs-decision' || value === 'blocked' || value === 'needs-human' || value === 'boundary';
}

export function findUnacknowledgedOutcome(events: DynamicWorkflowEvent[]): WakeRequest | null {
  const win = windowOf(events);
  const assessment = assessBoundary(win.events, { history: win.all });
  if (assessment.semaphore === 'DECISAO HUMANA') return { reason: 'needs-human' };
  if (assessment.unresolvedDecisions.length > 0) {
    const worst = [...assessment.unresolvedDecisions].sort((a, b) => b.seq - a.seq)[0]!;
    if (worst.verdict === 'blocked' && worst.gateId) return { reason: 'blocked', gateId: worst.gateId };
    return { reason: 'needs-decision', ...(worst.nodeId ? { nodeId: worst.nodeId } : {}) };
  }
  const hasBoundary = win.events.some((e) => BOUNDARY_EVENT_TYPES.has(e.type));
  if (hasBoundary && assessment.since.nodes > 0) return { reason: 'boundary' };
  return null;
}

export function scanBlockedRunsForIgnition(deps: WorkflowIgnitionDeps): number {
  let reignited = 0;
  const fired = new Set<string>();

  let blocked: DynamicWorkflowRun[];
  try {
    blocked = deps.listBlockedRuns();
  } catch (err) {
    logger.warn({ err }, 'boot re-ignition: falha ao listar runs blocked (varredura de gate pulada)');
    blocked = [];
  }
  for (const run of blocked) {
    try {
      const gateId = parsePendingGateId(run);
      if (!gateId) continue;
      const definition = deps.getDefinition(run.definitionId);
      const mode = resolveGateModeFromManifest(definition, gateId);
      if (mode !== 'orchestrator') continue;
      fireIgnition(deps, run.id, { reason: 'blocked', gateId }, 'boot-scan');
      fired.add(run.id);
      reignited += 1;
    } catch (err) {
      logger.warn({ err, runId: run.id }, 'boot re-ignition: falha ao re-disparar um run blocked (ignorado)');
    }
  }

  let runs: DynamicWorkflowRun[] = [];
  try {
    runs = deps.listRuns ? deps.listRuns() : [];
  } catch (err) {
    logger.warn({ err }, 'boot re-ignition: falha ao listar runs (varredura generalizada pulada)');
    runs = [];
  }
  for (const run of runs) {
    if (fired.has(run.id)) continue;
    try {
      const events = readRunEvents(deps, run.id);
      if (events.length === 0) continue;
      const unacked = findUnacknowledgedWake(events);
      if (unacked) {
        fireIgnition(deps, run.id, unacked, 'boot-scan');
        fired.add(run.id);
        reignited += 1;
        continue;
      }
      if (TERMINAL_RUN_STATUSES.has(run.status)) continue;
      const outcome = findUnacknowledgedOutcome(events);
      if (!outcome) continue;
      fireIgnition(deps, run.id, outcome, 'boot-scan');
      fired.add(run.id);
      reignited += 1;
    } catch (err) {
      logger.warn({ err, runId: run.id }, 'boot re-ignition: falha na varredura generalizada de um run (ignorado)');
    }
  }

  if (reignited > 0) {
    logger.info({ reignited }, 'boot re-ignition: runs re-disparados');
  }
  return reignited;
}

let activeUnsubscribe: (() => void) | null = null;

export function initWorkflowIgnitionBridge(
  getWindow: () => BrowserWindow | null,
  overrides?: Partial<WorkflowIgnitionDeps>,
  options?: { skipBootScan?: boolean },
): () => void {
  const deps: WorkflowIgnitionDeps = {
    getRun: overrides?.getRun ?? getDynamicWorkflowRun,
    getDefinition: overrides?.getDefinition ?? getDynamicWorkflowDefinition,
    listBlockedRuns: overrides?.listBlockedRuns ?? (() => listDynamicWorkflowRunsByStatus('blocked')),
    listRuns: overrides?.listRuns ?? (() => listDynamicWorkflowRuns()),
    listEventsSince:
      overrides?.listEventsSince ??
      ((runId, afterSeq) => listDynamicWorkflowEvents(runId, { afterSeq, limit: 100_000 })),
    insertEvent: overrides?.insertEvent ?? insertDynamicWorkflowEvent,
    emitIPC: overrides?.emitIPC,
    pause: overrides?.pause,
    registerReadOnlyTurn: overrides?.registerReadOnlyTurn ?? registerReadOnlyDriveTurn,
    now: overrides?.now,
    createDedicatedSession: overrides?.createDedicatedSession ?? defaultCreateDedicatedSession,
    linkSession: overrides?.linkSession ?? defaultLinkSession,
    submit: overrides?.submit ?? submitMessage,
    getWindow: overrides?.getWindow ?? getWindow,
    mintCapability: overrides?.mintCapability ?? mintDriveCapability,
    bus: overrides?.bus,
    onDriveTurnComplete: overrides?.onDriveTurnComplete ?? onDriveTurnComplete,
  };

  if (activeUnsubscribe) {
    activeUnsubscribe();
    activeUnsubscribe = null;
  }

  const bus = deps.bus ?? workflowEventBus;
  const unsubscribeBus = bus.subscribe((event) => handleEvent(deps, event));

  const unsubscribeComplete = (deps.onDriveTurnComplete ?? onDriveTurnComplete)((complete) =>
    handleDriveTurnComplete(deps, complete),
  );

  activeUnsubscribe = () => {
    unsubscribeBus();
    unsubscribeComplete();
  };

  if (!options?.skipBootScan) {
    scanBlockedRunsForIgnition(deps);
  }

  return activeUnsubscribe;
}

export function defaultCreateDedicatedSession(runId: string): string {
  const sessionId = `dw-drive-${runId}-${Math.random().toString(36).slice(2, 10)}`;
  createSession(sessionId, `Workflow ${runId}`, undefined, {
    type: 'chat',
    orchestrator: readDefaultOrchestratorColumns(),
  });
  return sessionId;
}

function defaultLinkSession(runId: string, sessionId: string): void {
  updateDynamicWorkflowRun(runId, { chatSessionId: sessionId });
}

export { deriveOutcome };
