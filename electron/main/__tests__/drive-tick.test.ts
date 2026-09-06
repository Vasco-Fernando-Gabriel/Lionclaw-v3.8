
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
  config: {
    drive?: DriveState;
    openDesign?: { conversationId?: string; initialPromptSentAt?: string };
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

vi.mock('../db', () => ({
  getHarnessProject: vi.fn((id: string) => fakeGetHarnessProject(id)),
  listHarnessProjects: vi.fn(() => fakeListHarnessProjects()),
  getDriveState: vi.fn((id: string) => fakeGetDriveState(id)),
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
  const actual = await vi.importActual<typeof import('../pipeline-control-core')>(
    '../pipeline-control-core',
  );
  return {
    ...actual,
    resolvePendingQuestion: vi.fn(() => 'O agente da fase perguntou algo.'),
  };
});

import { submitMessage } from '../orchestrator';
import { pipelineEventBus } from '../pipeline-event-bus';
import { _resetDriveLockForTesting } from '../drive-lock';
import {
  PipelineDriveCoordinator,
  DRIVE_TICK_INTERVAL_MS,
  DRIVE_TICK_MAX_IDLE,
  MAX_ORCHESTRATOR_TURNS_PER_PHASE,
} from '../pipeline-drive-coordinator';
import {
  startPipelineControlPhaseCache,
  _resetPipelineControlPhaseCacheForTesting,
} from '../pipeline-control-core';
import {
  reportDriveTurnComplete,
  reportDriveTurnUsage,
  _resetDriveUsageSinkForTesting,
} from '../drive-usage-sink';


function seedProject(over: Partial<FakeProject> = {}): FakeProject {
  const p: FakeProject = {
    id: over.id ?? 'proj_a',
    name: over.name ?? 'Demo',
    pipelineType: over.pipelineType ?? 'development',
    status: over.status ?? 'running',
    pipelineCurrentPhase: over.pipelineCurrentPhase ?? 1,
    pipelineStartPhase: over.pipelineStartPhase ?? 1,
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

function latestTurnId(): string {
  const calls = submitMock.mock.calls;
  if (calls.length === 0) return '';
  return (calls[calls.length - 1][1] as { driveTurnId?: string }).driveTurnId ?? '';
}

function latestPrompt(): string {
  const calls = submitMock.mock.calls;
  if (calls.length === 0) return '';
  return calls[calls.length - 1][0] as string;
}

function drainInFlight(projectId: string): void {
  let prev = -1;
  while (submitMock.mock.calls.length !== prev) {
    prev = submitMock.mock.calls.length;
    reportDriveTurnComplete(projectId, latestTurnId());
    vi.advanceTimersByTime(1);
  }
}

function emitPhaseChanged(
  projectId: string,
  phase: number | null,
  status: string,
  awaitingUser?: boolean,
): void {
  pipelineEventBus.emit('pipeline:phase-changed', {
    projectId,
    phase,
    status,
    ...(awaitingUser !== undefined ? { awaitingUser } : {}),
  });
}

function engageDriveOnAutoPhase(
  coord: PipelineDriveCoordinator,
  projectId: string,
  autoPhase: number,
): void {
  const project = projects.get(projectId)!;
  project.pipelineCurrentPhase = autoPhase;
  coord.startDrive(projectId, 'sess_1', 'semi');
  vi.advanceTimersByTime(1);
  drainInFlight(projectId);
  submitMock.mockClear();
}

function advanceOneTick(): void {
  vi.advanceTimersByTime(DRIVE_TICK_INTERVAL_MS);
  vi.advanceTimersByTime(1); // libera o setTimeout(0) do reacting
}

describe('drive tick (SPRINT-D / Parte D)', () => {
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


  it('D-AC1: com drive engajado, tick dispara turno de verificacao (prompt distinto) a cada 10min ate o Iniciar desenvolvimento', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 3); // PRD Validator (conversation), gate one-in-flight aberto

    const project = projects.get('proj_a')!;

    advanceOneTick();
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(latestPrompt()).toContain('RONDA PERIODICA');
    expect(latestPrompt()).not.toContain('Decida UMA acao usando as tools pipeline_*');
    drainInFlight('proj_a');

    project.pipelineCurrentPhase = 4;
    emitPhaseChanged('proj_a', 4, 'started', false);
    drainInFlight('proj_a');
    submitMock.mockClear();

    advanceOneTick();
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(latestPrompt()).toContain('RONDA PERIODICA');
  });


  it('D-AC2: transicao para fase tipo loop (Iniciar desenvolvimento) desliga o tick (resolvido por PhaseDefinition.type, nunca numero)', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 12 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 12); // Sprint Validator (conversation)

    const project = projects.get('proj_a')!;

    project.pipelineCurrentPhase = 13;
    emitPhaseChanged('proj_a', 13, 'loop-ready', false);
    drainInFlight('proj_a');
    submitMock.mockClear();

    advanceOneTick();
    advanceOneTick();
    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('D-AC2b: transicao para fase NAO-loop nao desliga o tick (continua disparando)', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 3);

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 4;
    emitPhaseChanged('proj_a', 4, 'started', false);
    drainInFlight('proj_a');
    submitMock.mockClear();

    advanceOneTick();
    expect(submitMock).toHaveBeenCalledTimes(1);
  });


  it('D-AC3: 3 ticks ociosos consecutivos desligam o tick; turn-complete/usage dos PROPRIOS ticks nao impedem o desligamento (N ticks ociosos com sinais proprios ignorados); um evento real reseta o contador', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 3); // estado estatico (nada muda entre ticks)

    advanceOneTick();
    expect(submitMock).toHaveBeenCalledTimes(1);
    const tickTurnId1 = latestTurnId();
    reportDriveTurnUsage('sess_1', 1234);
    reportDriveTurnComplete('proj_a', tickTurnId1);
    vi.advanceTimersByTime(1);
    submitMock.mockClear();

    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled(); // ocioso: nao dispara ronda

    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled();

    expect(DRIVE_TICK_MAX_IDLE).toBe(3);
    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled();

    advanceOneTick();
    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('D-AC3c: sinal do PROPRIO tick (usage) NAO reseta o contador - desligamento ocorre no 3o ocioso (exclusao load-bearing)', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 3); // estado estatico

    advanceOneTick();
    expect(submitMock).toHaveBeenCalledTimes(1);
    reportDriveTurnUsage('sess_1', 4321);
    submitMock.mockClear();

    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled();

    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled();

    expect(DRIVE_TICK_MAX_IDLE).toBe(3);
    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled();

    advanceOneTick();
    advanceOneTick();
    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('D-AC3d: contraste - sinal de turno REAL (nao-tick) RESETA o contador de ociosos', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 3);

    const project = projects.get('proj_a')!;

    advanceOneTick();
    expect(submitMock).toHaveBeenCalledTimes(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    advanceOneTick();
    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled();

    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 3, type: 'done' });
    expect(submitMock).toHaveBeenCalledTimes(1);
    const realTurnId = latestTurnId();
    reportDriveTurnComplete('proj_a', realTurnId);
    vi.advanceTimersByTime(1);
    submitMock.mockClear();

    project.pipelineCurrentPhase = 4;
    emitPhaseChanged('proj_a', 4, 'started', false);
    drainInFlight('proj_a');
    submitMock.mockClear();
    advanceOneTick(); // estado novo -> dispara (1o snapshot pos-reset)
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('D-AC3b: um EVENTO REAL (transicao de fase) reseta o contador de ociosos antes do desligamento', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 3);

    const project = projects.get('proj_a')!;

    advanceOneTick();
    expect(submitMock).toHaveBeenCalledTimes(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    advanceOneTick();
    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled();

    project.pipelineCurrentPhase = 4;
    emitPhaseChanged('proj_a', 4, 'started', false);
    drainInFlight('proj_a');
    submitMock.mockClear();

    advanceOneTick();
    expect(submitMock).toHaveBeenCalledTimes(1);
  });


  it('D-AC4: turno em voo -> tick pula (no-op, sem pendingFollowup); respeita one-in-flight', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 3); // tick armado em t=0; gate one-in-flight aberto

    vi.advanceTimersByTime(DRIVE_TICK_INTERVAL_MS - 1000);

    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 3, type: 'done' });
    expect(submitMock).toHaveBeenCalledTimes(1);
    submitMock.mockClear();

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1);
    expect(submitMock).not.toHaveBeenCalled();

    drainInFlight('proj_a');
    expect(submitMock).not.toHaveBeenCalled();
  });


  it('D-AC-anti-runaway: fase no teto de turnos -> o tick ESCALA+PARA (nao dispara turno), herdando o anti-runaway do evaluate', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 3 }); // PRD Validator (conversation)
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 3);

    for (let i = 0; i < MAX_ORCHESTRATOR_TURNS_PER_PHASE - 1; i++) {
      pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 3, type: 'done' });
      drainInFlight('proj_a');
    }
    expect(submitMock.mock.calls.length).toBeGreaterThanOrEqual(MAX_ORCHESTRATOR_TURNS_PER_PHASE - 1);

    pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 3, type: 'done' });
    drainInFlight('proj_a');
    submitMock.mockClear();

    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled();
    expect(fakeGetDriveState('proj_a')?.status).toBe('stopped');
  });


  it('D-AC5: fase OD -> tick e no-op total (nao dispara, nao conta ocioso, nao reseta), com GO ja dado', () => {
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
    submitMock.mockClear();

    advanceOneTick();
    advanceOneTick();
    advanceOneTick();
    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('D-AC5b: fase OD sem config OD (sem GO) -> o tick TAMBEM e no-op total (C-03, faixa silenciosa)', () => {
    seedProject({
      pipelineType: 'development-v2',
      pipelineCurrentPhase: 5, // OD (open-design-studio), sem config OD
      config: {},
    });
    const coord = makeCoordinator();
    const res = coord.startDrive('proj_a', 'sess_1', 'semi');
    expect(res.ok).toBe(true);
    vi.advanceTimersByTime(1);
    expect(submitMock).not.toHaveBeenCalled();
    submitMock.mockClear();

    advanceOneTick();
    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled();
  });


  it('borda: stopDrive cancela o tick (nenhum disparo apos parar)', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 3);

    coord.stopDrive('proj_a', 'teste');
    submitMock.mockClear();

    advanceOneTick();
    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('borda (finding zumbi): tick que cede ao humano via requiresHuman (handoffTemporary) NAO deixa timer zumbi armado', () => {
    seedProject({
      pipelineType: 'development-v2',
      pipelineCurrentPhase: 4, // engata numa fase auto (NAO OD, NAO requiresHuman)
    });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 4);

    expect(vi.getTimerCount()).toBe(1);

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 6;
    submitMock.mockClear();
    advanceOneTick();

    expect(submitMock).not.toHaveBeenCalled();
    expect(fakeGetDriveState('proj_a')?.status).toBe('awaiting-human');
    expect(vi.getTimerCount()).toBe(0);

    advanceOneTick();
    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('borda: greeting que nunca fecha escala (3 min) e cancela o tick (sem rondas apos a escala)', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 2 }); // PRD Generator (auto)
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 2);

    const project = projects.get('proj_a')!;
    project.pipelineCurrentPhase = 3;
    emitPhaseChanged('proj_a', 3, 'started', true);
    submitMock.mockClear();

    advanceOneTick();
    advanceOneTick();
    expect(submitMock).not.toHaveBeenCalled();
    expect(fakeGetDriveState('proj_a')?.status).toBe('awaiting-human');
  });

  it('borda: resumeDrive re-arma o tick (mesmo apos a rede final ter desligado)', () => {
    seedProject({ pipelineType: 'development', pipelineCurrentPhase: 3 });
    const coord = makeCoordinator();
    engageDriveOnAutoPhase(coord, 'proj_a', 3);

    advanceOneTick();
    drainInFlight('proj_a');
    submitMock.mockClear();
    advanceOneTick(); // ocioso 1
    advanceOneTick(); // ocioso 2
    advanceOneTick(); // ocioso 3 -> desliga
    expect(submitMock).not.toHaveBeenCalled();

    const project = projects.get('proj_a')!;
    project.config.drive = fakeSetDriveState('proj_a', { status: 'awaiting-human' });
    coord.resumeDrive('proj_a', { fromHuman: true });
    vi.advanceTimersByTime(1);
    drainInFlight('proj_a');
    submitMock.mockClear();

    advanceOneTick();
    expect(submitMock).toHaveBeenCalledTimes(1);
  });
});
