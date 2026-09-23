import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { DriveState } from '../../../src/types';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

interface FakeProject {
  id: string;
  name: string;
  pipelineType?: string;
  status: string;
  pipelineCurrentPhase?: number | null;
  pipelineStartPhase?: number | null;
  projectPath?: string;
  config: {
    drive?: DriveState;
    openDesign?: { conversationId?: string; initialPromptSentAt?: string };
    bug?: { runId?: string; outcome?: 'pending' | 'fix' | 'no-bug' };
  };
}

const projects = new Map<string, FakeProject>();

function fakeGetHarnessProject(id: string): FakeProject | undefined {
  return projects.get(id);
}
function fakeListHarnessProjects(): FakeProject[] {
  return [...projects.values()];
}
function fakeGetDriveState(projectId: string): DriveState | null {
  return projects.get(projectId)?.config.drive ?? null;
}
function fakeSetDriveState(projectId: string, patch: Partial<DriveState>): DriveState {
  const project = projects.get(projectId);
  if (!project) throw new Error(`setDriveState: project not found: ${projectId}`);
  const existing = project.config.drive;
  const merged: DriveState = {
    driver: patch.driver ?? existing?.driver ?? 'orchestrator',
    status: patch.status ?? existing?.status ?? 'driving',
    handoff: patch.handoff ?? existing?.handoff ?? 'none',
    mode: patch.mode ?? existing?.mode ?? 'semi',
    sessionId: patch.sessionId !== undefined ? patch.sessionId : existing?.sessionId,
    requiresHumanPhases: patch.requiresHumanPhases ?? existing?.requiresHumanPhases ?? [],
  };
  project.config.drive = merged;
  return merged;
}

function fakeGetDriveSessionId(projectId: string): string | null {
  return projects.get(projectId)?.config.drive?.sessionId ?? null;
}
function fakeIsDriveEngaged(projectId: string): boolean {
  const drive = fakeGetDriveState(projectId);
  return !!drive && drive.driver === 'orchestrator' && drive.status !== 'stopped';
}
function fakeListHarnessProjectsBySession(sessionId: string): FakeProject[] {
  return [...projects.values()].filter((p) => p.config.drive?.sessionId === sessionId);
}
function fakeFindEngagedDriveBySession(sessionId: string): FakeProject | null {
  return fakeListHarnessProjectsBySession(sessionId).find((p) => fakeIsDriveEngaged(p.id)) ?? null;
}
function fakeGetOpenLaneSessionById(id: string): { id: string; laneBadge: number; title: string } | null {
  if (!id || closedLanes.has(id)) return null;
  return { id, laneBadge: Number(id.replace(/\D/g, '')) || 1, title: id };
}
const closedLanes = new Set<string>();

vi.mock('../db', () => ({
  getHarnessProject: vi.fn((id: string) => fakeGetHarnessProject(id)),
  listHarnessProjects: vi.fn(() => fakeListHarnessProjects()),
  listHarnessProjectsBySession: vi.fn((id: string) => fakeListHarnessProjectsBySession(id)),
  findEngagedDriveBySession: vi.fn((id: string) => fakeFindEngagedDriveBySession(id)),
  getDriveState: vi.fn((id: string) => fakeGetDriveState(id)),
  getDriveSessionId: vi.fn((id: string) => fakeGetDriveSessionId(id)),
  isDriveEngaged: vi.fn((id: string) => fakeIsDriveEngaged(id)),
  getOpenLaneSessionById: vi.fn((id: string) => fakeGetOpenLaneSessionById(id)),
  getSession: vi.fn((id: string) => ({ id })),
  setDriveState: vi.fn((id: string, patch: Partial<DriveState>) => fakeSetDriveState(id, patch)),
  getLatestUserTurnIndex: vi.fn(() => 0),
}));

vi.mock('../chat-push', () => ({
  pushAssistantMessage: vi.fn(() => 1),
  pushDrivePaused: vi.fn(),
}));

vi.mock('../telegram-bridge', () => ({
  notifyDriveHandoff: vi.fn(async () => {}),
}));

vi.mock('../activity-log', () => ({
  recordActivity: vi.fn(),
}));

vi.mock('../orchestrator', () => ({
  submitMessage: vi.fn(),
}));

vi.mock('../pipeline-control-core', async () => {
  const actual = await vi.importActual<typeof import('../pipeline-control-core')>('../pipeline-control-core');
  return {
    ...actual,
    resolvePendingQuestion: vi.fn(() => 'O agente da fase perguntou algo.'),
  };
});

import { submitMessage } from '../orchestrator';
import { notifyDriveHandoff } from '../telegram-bridge';
import { pipelineEventBus } from '../pipeline-event-bus';
import { _resetDriveLockForTesting } from '../drive-lock';
import { PipelineDriveCoordinator, isControlGate, isHumanGate } from '../pipeline-drive-coordinator';
import { startPipelineControlPhaseCache, _resetPipelineControlPhaseCacheForTesting } from '../pipeline-control-core';
import { reportDriveTurnComplete, _resetDriveUsageSinkForTesting } from '../drive-usage-sink';

function seedProject(over: Partial<FakeProject> = {}): FakeProject {
  const p: FakeProject = {
    id: over.id ?? 'proj_a',
    name: over.name ?? 'Demo',
    pipelineType: over.pipelineType ?? 'development',
    status: over.status ?? 'running',
    pipelineCurrentPhase: over.pipelineCurrentPhase ?? 1,
    pipelineStartPhase: over.pipelineStartPhase ?? 1,
    projectPath: over.projectPath ?? '/tmp/demo-project',
    config: over.config ?? {},
  };
  projects.set(p.id, p);
  return p;
}

function makeCoordinator(): PipelineDriveCoordinator {
  const coord = new PipelineDriveCoordinator(() => null);
  coord.start();
  return coord;
}

const submitMock = submitMessage as Mock;

function engageDriveOnAutoPhase(coord: PipelineDriveCoordinator, projectId: string, autoPhase: number): void {
  const project = projects.get(projectId)!;
  project.pipelineCurrentPhase = autoPhase;
  coord.startDrive(projectId, 'sess_1', 'semi');
  vi.advanceTimersByTime(1);
  drainInFlight(projectId);
  submitMock.mockClear();
}

function latestTurnId(): string {
  const calls = submitMock.mock.calls;
  if (calls.length === 0) return '';
  return (calls[calls.length - 1][1] as { driveTurnId?: string }).driveTurnId ?? '';
}

function drainInFlight(projectId: string): void {
  let prev = -1;
  while (submitMock.mock.calls.length !== prev) {
    prev = submitMock.mock.calls.length;
    reportDriveTurnComplete(projectId, latestTurnId());
    vi.advanceTimersByTime(1);
  }
}

function emitPhaseChanged(projectId: string, phase: number | null, status: string, awaitingUser?: boolean): void {
  pipelineEventBus.emit('pipeline:phase-changed', {
    projectId,
    phase,
    status,
    ...(awaitingUser !== undefined ? { awaitingUser } : {}),
  });
}

function enterConversationPhaseAndCloseGreeting(projectId: string, phase: number): void {
  const project = projects.get(projectId)!;
  project.pipelineCurrentPhase = phase;
  emitPhaseChanged(projectId, phase, 'started', true);
  pipelineEventBus.emit('pipeline:stream', { projectId, phase, type: 'done' });
}

describe('coordinator filtering (SPRINT-C / Parte C / BUG-3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    projects.clear();
    pipelineEventBus._resetForTesting();
    _resetDriveLockForTesting();
    _resetDriveUsageSinkForTesting();
    _resetPipelineControlPhaseCacheForTesting();
    startPipelineControlPhaseCache();
  });

  afterEach(() => {
    _resetPipelineControlPhaseCacheForTesting();
    vi.useRealTimers();
  });

  it('C-AC1 dev/conversation: started awaitingUser:true (greeting fresco) -> semeia', () => {
    seedProject({ pipelineType: 'development' });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 2);

    enterConversationPhaseAndCloseGreeting('proj_a', 3);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-AC1 dev/conversation: started sem awaitingUser (isConversationPhase basta) -> semeia', () => {
    seedProject({ pipelineType: 'development' });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 2);

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 3;
    emitPhaseChanged('proj_a', 3, 'started');
    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 3, type: 'done' });
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-AC1 feature/conversation: started awaitingUser:true -> semeia', () => {
    seedProject({ pipelineType: 'feature' });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 2);

    enterConversationPhaseAndCloseGreeting('proj_a', 3);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-AC1 security/conversation: started awaitingUser:true (Skeptic Security fase 4) -> semeia', () => {
    seedProject({ pipelineType: 'security' });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 3);

    enterConversationPhaseAndCloseGreeting('proj_a', 4);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-AC1 architecture-review/conversation: started awaitingUser:true (Triagem fase 2) -> semeia', () => {
    seedProject({ pipelineType: 'architecture-review' });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 1);

    enterConversationPhaseAndCloseGreeting('proj_a', 2);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-AC1 development-v2/conversation: started awaitingUser:true (Database fase 8) -> semeia', () => {
    seedProject({ pipelineType: 'development-v2' });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 7);

    enterConversationPhaseAndCloseGreeting('proj_a', 8);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-AC1 dev/conversation: pergunta REABERTA na fase JA corrente (awaitingUser:true sem started) -> semeia', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    emitPhaseChanged('proj_a', 3, 'started', true);
    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 3, type: 'done' });
    vi.advanceTimersByTime(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    emitPhaseChanged('proj_a', 3, 'running', true);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-AC1 dev/conversation: stream done (nova pergunta no mesmo turno) -> semeia', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    emitPhaseChanged('proj_a', 3, 'started', true);
    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 3, type: 'done' });
    vi.advanceTimersByTime(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 3, type: 'done' });
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-AC1 dev/auto: started !awaitingUser (PRD Generator fase 2) -> nao semeia', () => {
    seedProject({ pipelineType: 'development' });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 1);
    const project = projects.get('proj_a')!;

    project.pipelineCurrentPhase = 2;
    emitPhaseChanged('proj_a', 2, 'started', false);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('C-AC1 security/auto: started !awaitingUser (Repo Profiler fase 1) -> nao semeia', () => {
    seedProject({ pipelineType: 'security', pipelineCurrentPhase: 1 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    submitMock.mockClear();

    emitPhaseChanged('proj_a', 1, 'started', false);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('C-AC1 dev/loop: loop-ready !awaitingUser (Coder fase 13) -> nao semeia', () => {
    seedProject({ pipelineType: 'development' });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 11);
    const project = projects.get('proj_a')!;

    project.pipelineCurrentPhase = 13;
    emitPhaseChanged('proj_a', 13, 'loop-ready', false);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('C-AC1 dev/loop: transicao PARA fase tipo loop (Iniciar desenvolvimento) -> nao semeia', () => {
    seedProject({ pipelineType: 'development' });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 12);
    const project = projects.get('proj_a')!;

    project.pipelineCurrentPhase = 13;
    emitPhaseChanged('proj_a', 13, 'loop-ready', false);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('C-AC1 dev/conversation: awaiting-dev-confirmation (gate de approve do harness) -> semeia', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 12 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    emitPhaseChanged('proj_a', 12, 'started', true);
    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 12, type: 'done' });
    vi.advanceTimersByTime(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    emitPhaseChanged('proj_a', 12, 'awaiting-dev-confirmation', true);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-AC1 development-v2/conversation: awaiting-spec-review (Spec gate fase 12) -> semeia', () => {
    seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 12 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    emitPhaseChanged('proj_a', 12, 'awaiting-spec-review', true);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-05 development-v2/auto-loop: started (awaitingUser:false, como o lifecycle emite) na fase 12 -> NAO semeia (loop, nao review)', () => {
    seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 7 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 7);

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 12;
    emitPhaseChanged('proj_a', 12, 'started', false);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('C-05 development-v2/auto-loop: spec-builder-running na fase 12 -> NAO semeia (loop)', () => {
    seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 7 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 7);

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 12;
    emitPhaseChanged('proj_a', 12, 'spec-builder-running', false);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('C-05 development-v2/auto-loop: spec-validator-running na fase 12 -> NAO semeia (loop)', () => {
    seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 7 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 7);

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 12;
    emitPhaseChanged('proj_a', 12, 'spec-validator-running', false);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('C-05 development-v2/auto-loop: stream done do loop (development-v2.ts:667) na fase 12 -> NAO semeia (precede o gate awaiting-spec-review)', () => {
    seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 7 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 7);

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 12;
    emitPhaseChanged('proj_a', 12, 'spec-validator-running', false);
    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 12, type: 'done' });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('C-05 development-v2: maquina de estados completa - loop silencioso e SO o awaiting-spec-review dispara (exatamente 1 turno)', () => {
    seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 7 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 7);

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 12;

    emitPhaseChanged('proj_a', 12, 'started', false);
    emitPhaseChanged('proj_a', 12, 'spec-builder-running', false);
    emitPhaseChanged('proj_a', 12, 'spec-validator-running', false);
    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 12, type: 'done' });
    expect(submitMock).not.toHaveBeenCalled();

    emitPhaseChanged('proj_a', 12, 'awaiting-spec-review', true);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-05 feature/auto-loop fase 9 (spec-builder): loop silencioso e SO o awaiting-spec-review dispara (exatamente 1 turno)', () => {
    seedProject({ pipelineType: 'feature', pipelineCurrentPhase: 2 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 2);

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 9;

    emitPhaseChanged('proj_a', 9, 'started', false);
    emitPhaseChanged('proj_a', 9, 'spec-builder-running', false);
    emitPhaseChanged('proj_a', 9, 'spec-validator-running', false);
    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 9, type: 'done' });
    expect(submitMock).not.toHaveBeenCalled();

    emitPhaseChanged('proj_a', 9, 'awaiting-spec-review', true);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-05 security/auto-loop fase 6 (spec-builder): loop silencioso e SO o awaiting-spec-review dispara (exatamente 1 turno)', () => {
    seedProject({ pipelineType: 'security', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 3);

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 6;

    emitPhaseChanged('proj_a', 6, 'started', false);
    emitPhaseChanged('proj_a', 6, 'spec-builder-running', false);
    emitPhaseChanged('proj_a', 6, 'spec-validator-running', false);
    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 6, type: 'done' });
    expect(submitMock).not.toHaveBeenCalled();

    emitPhaseChanged('proj_a', 6, 'awaiting-spec-review', true);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-AC1 qualquer/sprint-complete: sprint do loop concluida -> nao semeia turno (notifica + budget)', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 13 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    pipelineEventBus.emit('pipeline:sprint-complete', {
      projectId: 'proj_a',
      sprintIndex: 0,
      sprintName: 'Sprint 1',
      verdict: 'aprovado',
    });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('C-AC1 qualquer/error: erro/stall de fase -> nao semeia turno (escala + pausa)', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    pipelineEventBus.emit('pipeline:error', {
      projectId: 'proj_a',
      phase: 3,
      error: 'fase falhou',
    });
    expect(submitMock).not.toHaveBeenCalled();
    expect(fakeGetDriveState('proj_a')?.status).toBe('awaiting-human');
  });

  it('C-AC1 development-v2/conversation: entrada na fase OD (fase 5) -> NAO semeia (C-03, faixa silenciosa)', () => {
    seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 5 });
    const coord = makeCoordinator();
    const res = coord.startDrive('proj_a', 'sess_1', 'semi');
    expect(res.ok).toBe(true);
    vi.advanceTimersByTime(1);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('C-AC1 development-v2/conversation: re-evento na fase OD (fase 5) -> NAO semeia (C-03, faixa silenciosa)', () => {
    seedProject({
      pipelineType: 'development-v2',
      pipelineCurrentPhase: 4, // engata na fase 4 (Design Plan, auto)
      config: { openDesign: { conversationId: 'conv_od_1' } },
    });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 4);

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 5;
    emitPhaseChanged('proj_a', 5, 'started', true);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('C-AC2: agente concluiu apos trabalho interno e fase aguarda approve -> reconciliacao DB-first semeia turno (evento processado com DB divergente do live)', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 11 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 12;
    emitPhaseChanged('proj_a', 12, 'started', true);
    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 12, type: 'done' });
    vi.advanceTimersByTime(1);
    drainInFlight('proj_a');
    emitPhaseChanged('proj_a', 12, 'awaiting-dev-confirmation', true);
    vi.advanceTimersByTime(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 11, type: 'done' });
    expect(submitMock).toHaveBeenCalledTimes(1);
    const seededPhase = (submitMock.mock.calls[0][1] as { drivePhase?: number }).drivePhase;
    expect(seededPhase).toBe(12);
  });

  it('C-AC2b: reconciliacao respeita o greeting-gate de B (divergencia durante greeting in-flight NAO fura o gate)', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 2 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    vi.advanceTimersByTime(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 3;
    emitPhaseChanged('proj_a', 3, 'started', true);
    submitMock.mockClear();

    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 2, type: 'done' });
    expect(submitMock).not.toHaveBeenCalled();

    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 3, type: 'done' });
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-AC2c: sem divergencia live vs DB (live ja semeou a fase fresca) -> reconciliacao nao duplica turno', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    emitPhaseChanged('proj_a', 3, 'started', true);
    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 3, type: 'done' });
    vi.advanceTimersByTime(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 3, type: 'done' });
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-AC3: fase OD e faixa silenciosa (reconciliacao DB-first NAO semeia turno na fase do design)', () => {
    seedProject({
      pipelineType: 'development-v2',
      pipelineCurrentPhase: 4, // engata na fase 4 (Design Plan, auto)
      config: { openDesign: { conversationId: 'conv_od_1' } },
    });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 4);

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 5;

    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 4, type: 'done' });
    expect(submitMock).not.toHaveBeenCalled();

    emitPhaseChanged('proj_a', 5, 'started', true);
    expect(submitMock).not.toHaveBeenCalled();
  });
});

describe('familia bug: tabela evento->semeia (TB-28) e politica de gate (TB-34)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    projects.clear();
    pipelineEventBus._resetForTesting();
    _resetDriveLockForTesting();
    _resetDriveUsageSinkForTesting();
    _resetPipelineControlPhaseCacheForTesting();
    startPipelineControlPhaseCache();
  });

  afterEach(() => {
    _resetPipelineControlPhaseCacheForTesting();
    vi.useRealTimers();
  });

  it('C-AC1 bug/conversation: fase 1 (Bug Discovery) started awaitingUser:true -> semeia', () => {
    seedProject({ pipelineType: 'bug', pipelineCurrentPhase: 2 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 2);

    enterConversationPhaseAndCloseGreeting('proj_a', 1);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-AC1 bug/auto: fase 2 (Analise Paralela) started !awaitingUser -> nao semeia', () => {
    seedProject({ pipelineType: 'bug', pipelineCurrentPhase: 1 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 1);
    const project = projects.get('proj_a')!;

    project.pipelineCurrentPhase = 2;
    emitPhaseChanged('proj_a', 2, 'started', false);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('C-AC1 bug/conversation: fase 3 (Consolidacao) awaiting-input awaitingUser:true -> semeia', () => {
    seedProject({ pipelineType: 'bug', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    emitPhaseChanged('proj_a', 3, 'started', true);
    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 3, type: 'done' });
    vi.advanceTimersByTime(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    emitPhaseChanged('proj_a', 3, 'awaiting-input', true);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-AC1 bug/auto: fase 4 (Spec Generation) started -> nao semeia', () => {
    seedProject({ pipelineType: 'bug', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 4);
    const project = projects.get('proj_a')!;

    project.pipelineCurrentPhase = 4;
    emitPhaseChanged('proj_a', 4, 'started', false);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('C-AC1 bug/conversation: fase 5 (Spec Validator) awaiting-input awaitingUser:true -> semeia', () => {
    seedProject({ pipelineType: 'bug', pipelineCurrentPhase: 5 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    emitPhaseChanged('proj_a', 5, 'started', true);
    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 5, type: 'done' });
    vi.advanceTimersByTime(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    emitPhaseChanged('proj_a', 5, 'awaiting-input', true);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-AC1 bug/auto: fase 6 (Planner) started -> nao semeia', () => {
    seedProject({ pipelineType: 'bug', pipelineCurrentPhase: 5 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 6);
    const project = projects.get('proj_a')!;

    project.pipelineCurrentPhase = 6;
    emitPhaseChanged('proj_a', 6, 'started', false);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('C-AC1 bug/conversation: fase 7 (Sprint Validator) awaiting-dev-confirmation -> semeia', () => {
    seedProject({ pipelineType: 'bug', pipelineCurrentPhase: 7 });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'semi');
    emitPhaseChanged('proj_a', 7, 'started', true);
    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 7, type: 'done' });
    vi.advanceTimersByTime(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    emitPhaseChanged('proj_a', 7, 'awaiting-dev-confirmation', true);
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('C-AC1 bug/loop: fase 8 (Coder) loop-ready -> nao semeia', () => {
    seedProject({ pipelineType: 'bug', pipelineCurrentPhase: 7 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 6);
    const project = projects.get('proj_a')!;

    project.pipelineCurrentPhase = 8;
    emitPhaseChanged('proj_a', 8, 'loop-ready', false);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('C-AC1 bug/loop: fase 9 (Evaluator) loop-ready -> nao semeia', () => {
    seedProject({ pipelineType: 'bug', pipelineCurrentPhase: 8 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 6);
    const project = projects.get('proj_a')!;

    project.pipelineCurrentPhase = 9;
    emitPhaseChanged('proj_a', 9, 'loop-ready', false);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('TB-34: isControlGate("bug", 3) === true e isHumanGate("bug", 3) === false', () => {
    expect(isControlGate('bug', 3)).toBe(true);
    expect(isHumanGate('bug', 3)).toBe(false);
  });

  it('TB-34: os outros control gates do bug (5 Spec Validator, 7 Sprint Validator)', () => {
    expect(isControlGate('bug', 5)).toBe(true);
    expect(isControlGate('bug', 7)).toBe(true);
    expect(isControlGate('bug', 1)).toBe(false);
    expect(isControlGate('bug', 2)).toBe(false);
    expect(isControlGate('bug', 8)).toBe(false);
    for (const phase of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(isHumanGate('bug', phase)).toBe(false);
    }
  });
});

describe('TB-41 / O12: onPipelineCompleted por desfecho do Bug Pipe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    projects.clear();
    pipelineEventBus._resetForTesting();
    _resetDriveLockForTesting();
    _resetDriveUsageSinkForTesting();
    _resetPipelineControlPhaseCacheForTesting();
    startPipelineControlPhaseCache();
  });

  afterEach(() => {
    _resetPipelineControlPhaseCacheForTesting();
    vi.useRealTimers();
  });

  function completeAndCapturePrompt(over: Partial<FakeProject>): string {
    seedProject({ pipelineCurrentPhase: 3, projectPath: '/tmp/bugrepo', ...over });
    const coord = makeCoordinator();
    coord.startDrive('proj_a', 'sess_1', 'full');
    vi.advanceTimersByTime(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    emitPhaseChanged('proj_a', null, 'pipeline-completed');
    expect(submitMock).toHaveBeenCalledTimes(1);
    return submitMock.mock.calls[0][0] as string;
  }

  it('desfecho no-bug: turno de ENCERRAMENTO SEM CORRECAO, sem a palavra entrega', () => {
    const prompt = completeAndCapturePrompt({
      pipelineType: 'bug',
      config: { bug: { runId: '20260727_101010-a1b2c3', outcome: 'no-bug' } },
    });
    expect(prompt).toContain('ENCERRADO SEM');
    expect(prompt).toContain('Nao ha entrega');
    expect(prompt).not.toContain('a entrega esta pronta');
    expect(prompt).toContain('plano-de-correcao-20260727_101010-a1b2c3.md');
  });

  it('desfecho no-bug: Telegram recebe o texto de encerramento, nao o de entrega', async () => {
    completeAndCapturePrompt({
      pipelineType: 'bug',
      config: { bug: { runId: '20260727_101010-a1b2c3', outcome: 'no-bug' } },
    });
    await vi.waitFor(() => expect(notifyDriveHandoff).toHaveBeenCalled());
    const text = (notifyDriveHandoff as Mock).mock.calls[0][0] as string;
    expect(text).toContain('encerrado sem correcao');
    expect(text).not.toContain('A entrega esta pronta');
  });

  it('desfecho fix: texto de CONCLUSAO normal (byte a byte o atual)', () => {
    const prompt = completeAndCapturePrompt({
      pipelineType: 'bug',
      config: { bug: { runId: '20260727_101010-a1b2c3', outcome: 'fix' } },
    });
    expect(prompt).toContain('acabou de CONCLUIR');
    expect(prompt).toContain('a entrega esta pronta');
    expect(prompt).not.toContain('ENCERRADO SEM');
  });

  it('NAO-REGRESSAO: os 5 tipos existentes (sem config.bug) mantem o texto atual', () => {
    for (const pipelineType of ['development', 'feature', 'security', 'architecture-review', 'development-v2']) {
      projects.clear();
      pipelineEventBus._resetForTesting();
      _resetDriveLockForTesting();
      submitMock.mockClear();
      const prompt = completeAndCapturePrompt({ pipelineType });
      expect(prompt).toContain('acabou de CONCLUIR');
      expect(prompt).toContain('a entrega esta pronta');
      expect(prompt).not.toContain('ENCERRADO SEM');
    }
  });
});
