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

vi.mock('../pipeline-control-core', () => ({
  resolvePendingQuestion: vi.fn(() => 'O agente da fase perguntou algo.'),
  getCachedPhaseChanged: vi.fn(() => null),
}));

import { pushAssistantMessage, pushDrivePaused } from '../chat-push';
import { notifyDriveHandoff } from '../telegram-bridge';
import { submitMessage } from '../orchestrator';
import { pipelineEventBus } from '../pipeline-event-bus';
import { _resetDriveLockForTesting, driveOwnerOfProject } from '../drive-lock';
import {
  PipelineDriveCoordinator,
  MAX_ORCHESTRATOR_TURNS_PER_PHASE,
  MAX_TURNS_PER_DRIVE,
  DRIVE_TOKEN_BUDGET,
  DRIVE_TICK_INTERVAL_MS,
} from '../pipeline-drive-coordinator';
import { reportDriveTurnUsage, reportDriveTurnComplete, _resetDriveUsageSinkForTesting } from '../drive-usage-sink';

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
const pushMock = pushAssistantMessage as Mock;
const pausedMock = pushDrivePaused as Mock;
const tgHandoffMock = notifyDriveHandoff as Mock;

describe('PipelineDriveCoordinator (SPEC 4.4/4.5/4.6, S9-b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projects.clear();
    pipelineEventBus._resetForTesting();
    _resetDriveLockForTesting();
    _resetDriveUsageSinkForTesting();
  });

  describe('startDrive', () => {
    it('inicia o drive, grava DriveState e dispara o 1o turno', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();

      const res = coord.startDrive('proj_a', 'sess_1', 'semi');

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.drive.driver).toBe('orchestrator');
        expect(res.drive.status).toBe('driving');
        expect(res.drive.mode).toBe('semi');
        expect(res.drive.sessionId).toBe('sess_1');
      }
      expect(driveOwnerOfProject('proj_a')).toBe('sess_1');
      expect(submitMock).toHaveBeenCalledTimes(1);
      const [prompt, opts] = submitMock.mock.calls[0];
      expect(prompt).toContain('[DRIVE DE PIPELINE]');
      expect(opts).toMatchObject({ sessionId: 'sess_1', origin: 'system-event' });
    });

    it('erro quando o projeto nao existe', () => {
      const coord = makeCoordinator();
      const res = coord.startDrive('inexistente', 'sess_1', 'semi');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('nao encontrado');
    });

    it('lock por lane: 2o drive (outro projeto) na MESMA lane retorna erro (AC-16)', () => {
      seedProject({ id: 'proj_a' });
      seedProject({ id: 'proj_b' });
      const coord = makeCoordinator();

      const first = coord.startDrive('proj_a', 'sess_1', 'semi');
      expect(first.ok).toBe(true);

      const second = coord.startDrive('proj_b', 'sess_1', 'semi');
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.code).toBe('lane_busy');
        expect(second.error).toContain('ja existe um drive ativo no projeto "Demo" (proj_a)');
        expect(second.error).toContain('dirigido pela Lane 1: "sess_1"');
        expect(second.error).toContain('ou use outra lane.');
      }
      expect(driveOwnerOfProject('proj_a')).toBe('sess_1');
      expect(driveOwnerOfProject('proj_b')).toBeNull();
    });

    it('lane_busy com detentor awaiting-human usa a variante "aguardando a sua resposta" (5.4)', () => {
      seedProject({ id: 'proj_a' });
      seedProject({ id: 'proj_b' });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      fakeSetDriveState('proj_a', { status: 'awaiting-human' });

      const second = coord.startDrive('proj_b', 'sess_1', 'semi');

      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.code).toBe('lane_busy');
        expect(second.error).toContain('aguardando a sua resposta na Lane 1: "sess_1"');
      }
    });

    it('projeto ENGAJADO na MESMA lane e ok idempotente e nao remexe o startedAt (5.2)', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      const first = coord.startDrive('proj_a', 'sess_1', 'semi');
      expect(first.ok).toBe(true);
      const startedAt = fakeGetDriveState('proj_a')?.startedAt;

      const again = coord.startDrive('proj_a', 'sess_1', 'full');

      expect(again.ok).toBe(true);
      expect(fakeGetDriveState('proj_a')?.startedAt).toBe(startedAt);
      expect(fakeGetDriveState('proj_a')?.mode).toBe('semi');
      expect(fakeGetDriveSessionId('proj_a')).toBe('sess_1');
    });

    it('projeto ENGAJADO em OUTRA lane recusa drive_owned_by_other_lane e nao migra a coluna (5.2)', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');

      const other = coord.startDrive('proj_a', 'sess_2', 'semi');

      expect(other.ok).toBe(false);
      if (!other.ok) {
        expect(other.code).toBe('drive_owned_by_other_lane');
        expect(other.error).toBe(
          'o projeto "Demo" e dirigido pela Lane 1: "sess_1" e nao esta disponivel nesta lane. ' +
            'Para mover o drive, retome-o pelo Pipeline escolhendo esta lane.',
        );
      }
      expect(fakeGetDriveSessionId('proj_a')).toBe('sess_1');
      expect(driveOwnerOfProject('proj_a')).toBe('sess_1');
    });

    it('projeto ENGAJADO em awaiting-human em outra lane tambem recusa (F3/F16)', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      fakeSetDriveState('proj_a', { status: 'awaiting-human' });

      const other = coord.startDrive('proj_a', 'sess_2', 'semi');

      expect(other.ok).toBe(false);
      if (!other.ok) expect(other.code).toBe('drive_owned_by_other_lane');
      expect(fakeGetDriveSessionId('proj_a')).toBe('sess_1');
    });

    it('projeto parado (nao engajado) inicia numa lane nova e sobrescreve a coluna', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      coord.stopDrive('proj_a', 'ui-stop');

      const again = coord.startDrive('proj_a', 'sess_2', 'semi');

      expect(again.ok).toBe(true);
      expect(fakeGetDriveSessionId('proj_a')).toBe('sess_2');
      expect(driveOwnerOfProject('proj_a')).toBe('sess_2');
    });
  });

  describe('recoverInterruptedDrives (AC-20)', () => {
    it('drive "driving" no boot vira awaiting-human e posta no chat (nao retoma sozinho)', () => {
      seedProject({
        config: {
          drive: {
            driver: 'orchestrator',
            status: 'driving',
            handoff: 'none',
            mode: 'full',
            sessionId: 'sess_1',
            requiresHumanPhases: [],
          },
        },
      });
      const coord = new PipelineDriveCoordinator(() => null);
      coord.start();

      coord.recoverInterruptedDrives();

      const drive = fakeGetDriveState('proj_a');
      expect(drive?.status).toBe('awaiting-human');
      expect(pushMock).toHaveBeenCalledTimes(1);
      expect(pushMock.mock.calls[0][1]).toContain('interrompido pelo restart');
      expect(submitMock).not.toHaveBeenCalled();
    });

    it('drive ja stopped/human NAO e tocado pelo recovery', () => {
      seedProject({
        id: 'proj_human',
        config: {
          drive: {
            driver: 'human',
            status: 'stopped',
            handoff: 'permanent',
            mode: 'semi',
            sessionId: 'sess_1',
            requiresHumanPhases: [],
          },
        },
      });
      const coord = new PipelineDriveCoordinator(() => null);
      coord.start();
      coord.recoverInterruptedDrives();

      expect(fakeGetDriveState('proj_human')?.status).toBe('stopped');
      expect(pushMock).not.toHaveBeenCalled();
    });
  });

  describe('semi vs full + control gate (C-02)', () => {
    it('SEMI: dispara turno em fase conversacional com prompt mandando escalar control gate via pipeline_escalate', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');

      expect(submitMock).toHaveBeenCalledTimes(1);
      const prompt = submitMock.mock.calls[0][0] as string;
      expect(prompt).toContain('Modo SEMI');
      expect(prompt).toContain('CONTROL GATES');
      expect(prompt).toContain('pipeline_escalate');
    });

    it('FULL em fase que NAO e control gate: prompt permite aprovar baixo risco sozinho', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'full');

      const prompt = submitMock.mock.calls[0][0] as string;
      expect(prompt).toContain('Modo FULL');
      expect(prompt).toContain('gates de BAIXO risco voce aprova sozinho');
      expect(prompt).not.toContain('a fase atual e um CONTROL GATE');
    });

    it('FULL em CONTROL GATE (PRD Validator) manda LER+AVALIAR+DECIDIR, nao "sempre escale"', () => {
      seedProject({ pipelineCurrentPhase: 3 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'full');

      const prompt = submitMock.mock.calls[0][0] as string;
      expect(prompt).toContain('Modo FULL');
      expect(prompt).toContain('a fase atual e um CONTROL GATE');
      expect(prompt).toContain('LEIA o artefato');
      expect(prompt).toContain('justificativa');
      expect(prompt).toContain('pipeline_escalate');
      expect(prompt).not.toContain('GATE DE ALTO RISCO');
    });

    it('SEMI em CONTROL GATE (PRD Validator): escala via pipeline_escalate', () => {
      seedProject({ pipelineCurrentPhase: 3 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');

      const prompt = submitMock.mock.calls[0][0] as string;
      expect(prompt).toContain('Modo SEMI');
      expect(prompt).toContain('a fase atual e um CONTROL GATE');
      expect(prompt).toContain('pipeline_escalate');
    });
  });

  describe('fase OD (C-03): faixa silenciosa, zero turno, sem handoffTemporary', () => {
    it('entrada na fase OD NAO dispara turno (faixa silenciosa, drive segue driving)', () => {
      seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 5 });
      const coord = makeCoordinator();

      const res = coord.startDrive('proj_a', 'sess_1', 'semi');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.drive.requiresHumanPhases).not.toContain(5);
        expect(res.drive.requiresHumanPhases).toContain(6);
      }

      const drive = fakeGetDriveState('proj_a');
      expect(drive?.status).toBe('driving');
      expect(drive?.handoff).toBe('none');
      expect(submitMock).not.toHaveBeenCalled();
    });

    it('retoma no primeiro ponto acionavel pos-lock com o drive ainda driving', () => {
      vi.useFakeTimers();
      try {
        const project = seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 5 });
        const coord = makeCoordinator();
        coord.startDrive('proj_a', 'sess_1', 'semi');

        expect(fakeGetDriveState('proj_a')?.status).toBe('driving');
        expect(submitMock).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        submitMock.mockClear();

        project.pipelineCurrentPhase = 8;
        pipelineEventBus.emit('pipeline:phase-changed', {
          projectId: 'proj_a',
          phase: 8,
          status: 'started',
          awaitingUser: true,
        });
        pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 8, type: 'done' });

        const drive = fakeGetDriveState('proj_a');
        expect(drive?.status).toBe('driving');
        expect(drive?.handoff).toBe('none');
        expect(driveOwnerOfProject('proj_a')).toBe('sess_1');
        expect(submitMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-entrada na fase OD (qualquer status) NAO dispara turno (faixa silenciosa)', () => {
      vi.useFakeTimers();
      try {
        seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 5 });
        const coord = makeCoordinator();
        coord.startDrive('proj_a', 'sess_1', 'semi');
        expect(submitMock).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        submitMock.mockClear();

        pipelineEventBus.emit('pipeline:phase-changed', {
          projectId: 'proj_a',
          phase: 5,
          status: 'running',
          awaitingUser: true,
        });

        expect(submitMock).not.toHaveBeenCalled();
        expect(fakeGetDriveState('proj_a')?.status).toBe('driving');
      } finally {
        vi.useRealTimers();
      }
    });

    it('fase auto pos-lock (Design Lock) nao dispara turno do drive', () => {
      const project = seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 5 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      submitMock.mockClear();

      project.pipelineCurrentPhase = 6;
      pipelineEventBus.emit('pipeline:phase-changed', {
        projectId: 'proj_a',
        phase: 6,
        status: 'started',
        awaitingUser: false,
      });
      expect(submitMock).not.toHaveBeenCalled();
    });
  });

  describe('stopDrive ao soltar o Coder (C-02)', () => {
    it('transicao para fase de tipo loop (Coder) para o drive e libera o lock', () => {
      vi.useFakeTimers();
      try {
        const project = seedProject({ pipelineType: 'development', pipelineCurrentPhase: 1 });
        const coord = makeCoordinator();
        coord.startDrive('proj_a', 'sess_1', 'full');
        expect(fakeGetDriveState('proj_a')?.status).toBe('driving');
        expect(driveOwnerOfProject('proj_a')).toBe('sess_1');
        vi.advanceTimersByTime(1);
        submitMock.mockClear();

        project.pipelineCurrentPhase = 13;
        pipelineEventBus.emit('pipeline:phase-changed', {
          projectId: 'proj_a',
          phase: 13,
          status: 'started',
          awaitingUser: false,
        });

        expect(fakeGetDriveState('proj_a')?.status).toBe('stopped');
        expect(driveOwnerOfProject('proj_a')).toBeNull();
        expect(submitMock).not.toHaveBeenCalled();

        vi.advanceTimersByTime(DRIVE_TICK_INTERVAL_MS * 2);
        expect(submitMock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('anti-runaway (AC-12)', () => {
    it('max-turns por fase: apos o teto, escala + para o drive (lock liberado)', () => {
      vi.useFakeTimers();
      try {
        seedProject({ pipelineCurrentPhase: 1 });
        const coord = makeCoordinator();
        coord.startDrive('proj_a', 'sess_1', 'semi');
        vi.advanceTimersByTime(1);

        for (let i = 0; i < MAX_ORCHESTRATOR_TURNS_PER_PHASE + 2; i++) {
          const currentTurnId = (submitMock.mock.calls.at(-1)?.[1] as { driveTurnId?: string } | undefined)
            ?.driveTurnId;
          reportDriveTurnComplete('proj_a', currentTurnId);
          pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 1, type: 'done' });
          vi.advanceTimersByTime(1);
        }
      } finally {
        vi.useRealTimers();
      }

      const drive = fakeGetDriveState('proj_a');
      expect(drive?.status).toBe('stopped');
      expect(driveOwnerOfProject('proj_a')).toBeNull();
      const lastPush = pushMock.mock.calls.at(-1)?.[1] as string;
      expect(lastPush).toContain('anti-loop');
    });

    it('budget de tokens: sprint-complete acima do budget escala + para o drive', () => {
      seedProject({ pipelineType: 'development', pipelineCurrentPhase: 13 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'full');
      submitMock.mockClear();
      pushMock.mockClear();

      pipelineEventBus.emit('pipeline:sprint-complete', {
        projectId: 'proj_a',
        sprintIndex: 0,
        sprintName: 'S0',
        verdict: 'passed',
        metrics: { totalTokens: DRIVE_TOKEN_BUDGET + 1 },
      });

      const drive = fakeGetDriveState('proj_a');
      expect(drive?.status).toBe('stopped');
      expect(driveOwnerOfProject('proj_a')).toBeNull();
      const messages = pushMock.mock.calls.map((c) => c[1] as string);
      expect(messages.some((m) => m.includes('budget de tokens'))).toBe(true);
    });

    it('teto global de turnos por drive: estourar MAX_TURNS_PER_DRIVE escala + para', () => {
      vi.useFakeTimers();
      try {
        const project = seedProject({ pipelineType: 'development', pipelineCurrentPhase: 1 });
        const coord = makeCoordinator();
        coord.startDrive('proj_a', 'sess_1', 'semi');
        vi.advanceTimersByTime(1);

        for (let i = 0; i < MAX_TURNS_PER_DRIVE + 2; i++) {
          const phase = i % 2 === 0 ? 3 : 1;
          project.pipelineCurrentPhase = phase;
          pipelineEventBus.emit('pipeline:phase-changed', {
            projectId: 'proj_a',
            phase,
            status: 'started',
            awaitingUser: true,
          });
          pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase, type: 'done' });
          vi.advanceTimersByTime(1);
          if (fakeGetDriveState('proj_a')?.status === 'stopped') break;
        }
      } finally {
        vi.useRealTimers();
      }

      const drive = fakeGetDriveState('proj_a');
      expect(drive?.status).toBe('stopped');
      expect(driveOwnerOfProject('proj_a')).toBeNull();
      const lastPush = pushMock.mock.calls.at(-1)?.[1] as string;
      expect(lastPush).toContain('neste drive');
    });

    it('drive-turn usage: tokens de turno de drive somam no budget e estouram', () => {
      seedProject({ pipelineType: 'development', pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'full');
      submitMock.mockClear();
      pushMock.mockClear();

      reportDriveTurnUsage({
        sessionId: 'sess_1',
        projectId: 'proj_a',
        tokens: DRIVE_TOKEN_BUDGET + 1,
      });

      const drive = fakeGetDriveState('proj_a');
      expect(drive?.status).toBe('stopped');
      expect(driveOwnerOfProject('proj_a')).toBeNull();
      const messages = pushMock.mock.calls.map((c) => c[1] as string);
      expect(messages.some((m) => m.includes('budget de tokens'))).toBe(true);
    });

    it('drive-turn usage: report de projeto diferente do drive e ignorado (casa por projectId)', () => {
      seedProject({ pipelineType: 'development', pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'full');

      reportDriveTurnUsage({
        sessionId: 'sess_1',
        projectId: 'proj_OUTRO',
        tokens: DRIVE_TOKEN_BUDGET + 1,
      });

      expect(fakeGetDriveState('proj_a')?.status).toBe('driving');
      expect(driveOwnerOfProject('proj_a')).toBe('sess_1');
    });
  });

  describe('escalateFromOrchestrator (C-02/C-04, awaiting-human)', () => {
    it('com drive ativo: escala -> getDriveState fica awaiting-human (pausa, sem stop)', () => {
      seedProject({ pipelineCurrentPhase: 3 });
      const coord = makeCoordinator();
      const started = coord.startDrive('proj_a', 'sess_1', 'semi');
      expect(started.ok).toBe(true);
      expect(fakeGetDriveState('proj_a')?.status).toBe('driving');
      pushMock.mockClear();

      const res = coord.escalateFromOrchestrator('proj_a', 'PRD pronto, cedo a decisao a voce.');

      expect(res.ok).toBe(true);
      expect(fakeGetDriveState('proj_a')?.status).toBe('awaiting-human');
      expect(driveOwnerOfProject('proj_a')).toBe('sess_1');
      expect(pushMock).toHaveBeenCalledTimes(1);
      expect(pushMock.mock.calls[0][1]).toContain('cedo a decisao');
    });

    it('sem drive ativo: escalateFromOrchestrator retorna {ok:false} (nada a pausar)', () => {
      seedProject({ pipelineCurrentPhase: 3 });
      const coord = makeCoordinator();
      const res = coord.escalateFromOrchestrator('proj_a', 'msg');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('nenhum drive ativo');
    });
  });

  describe('isolamento', () => {
    it('eventos de um projeto SEM drive ativo sao ignorados', () => {
      seedProject({ id: 'proj_sem_drive', pipelineCurrentPhase: 1 });
      makeCoordinator();

      pipelineEventBus.emit('pipeline:stream', {
        projectId: 'proj_sem_drive',
        phase: 1,
        type: 'done',
      });

      expect(submitMock).not.toHaveBeenCalled();
      expect(pushMock).not.toHaveBeenCalled();
    });
  });

  function driveTurnIdOfCall(n: number): string {
    const opts = submitMock.mock.calls[n]?.[1] as { driveTurnId?: string } | undefined;
    return opts?.driveTurnId ?? '';
  }

  function flushReacting(): void {
    vi.advanceTimersByTime(1);
  }

  describe('coalescing + turn-complete (W2.2/W2.3)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('W2-AC1: evento durante turno em voo -> UM follow-up apos o turno encerrar', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      flushReacting();
      expect(submitMock).toHaveBeenCalledTimes(1);
      const turn1 = driveTurnIdOfCall(0);

      pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 1, type: 'done' });
      pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 1, type: 'done' });
      expect(submitMock).toHaveBeenCalledTimes(1);

      reportDriveTurnComplete('proj_a', turn1);
      expect(submitMock).toHaveBeenCalledTimes(2);
    });

    it('W2-AC8: turn-complete de turno DEFASADO nao limpa o gate do turno novo', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      flushReacting();
      const turn1 = driveTurnIdOfCall(0);

      reportDriveTurnComplete('proj_a', 'proj_a:999');
      pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 1, type: 'done' });
      expect(submitMock).toHaveBeenCalledTimes(1);

      reportDriveTurnComplete('proj_a', turn1);
      expect(submitMock).toHaveBeenCalledTimes(2);
    });

    it('driveTurnId NUNCA recicla apos stop -> re-engage (contador global, gate intacto)', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();

      coord.startDrive('proj_a', 'sess_1', 'semi');
      flushReacting();
      const turnA = driveTurnIdOfCall(0);
      expect(turnA).not.toBe('');

      coord.stopDrive('proj_a', 'teste');
      submitMock.mockClear();

      coord.startDrive('proj_a', 'sess_1', 'semi');
      flushReacting();
      const turnB = driveTurnIdOfCall(0);
      expect(turnB).not.toBe('');

      expect(turnB).not.toBe(turnA);

      pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 1, type: 'done' });
      expect(submitMock).toHaveBeenCalledTimes(1);
      reportDriveTurnComplete('proj_a', turnA);
      expect(submitMock).toHaveBeenCalledTimes(1);
      reportDriveTurnComplete('proj_a', turnB);
      expect(submitMock).toHaveBeenCalledTimes(2);
    });

    it('W2-AC7: turn-complete + usage + phase-changed do mesmo turno = UM follow-up', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      flushReacting();
      const turn1 = driveTurnIdOfCall(0);

      pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 1, type: 'done' });
      expect(submitMock).toHaveBeenCalledTimes(1);

      reportDriveTurnComplete('proj_a', turn1);
      reportDriveTurnUsage({
        sessionId: 'sess_1',
        projectId: 'proj_a',
        driveTurnId: turn1,
        tokens: 10,
      });
      pipelineEventBus.emit('pipeline:phase-changed', {
        projectId: 'proj_a',
        phase: 1,
        status: 'started',
        awaitingUser: true,
      });
      expect(submitMock).toHaveBeenCalledTimes(2);
    });

    it('W2-AC4: turno sem usage (codex/lion) libera o gate no turn-complete (sem timeout)', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'full');
      flushReacting();
      const turn1 = driveTurnIdOfCall(0);

      pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 1, type: 'done' });
      expect(submitMock).toHaveBeenCalledTimes(1);

      reportDriveTurnComplete('proj_a', turn1);
      expect(submitMock).toHaveBeenCalledTimes(2);
    });

    it('W2-AC5: turno abortado/com erro libera o gate pelo caminho finally', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      flushReacting();
      const turn1 = driveTurnIdOfCall(0);

      pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 1, type: 'done' });
      expect(submitMock).toHaveBeenCalledTimes(1);

      reportDriveTurnComplete('proj_a', turn1);
      expect(submitMock).toHaveBeenCalledTimes(2);
    });

    it('sem follow-up pendente: turn-complete so libera o gate (nenhum turno extra)', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      flushReacting();
      const turn1 = driveTurnIdOfCall(0);

      reportDriveTurnComplete('proj_a', turn1);
      expect(submitMock).toHaveBeenCalledTimes(1);
    });

    it('W2-AC6: turno descartado pelo guard F7 emite turn-complete', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      flushReacting();
      const turn1 = driveTurnIdOfCall(0);
      pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 1, type: 'done' });

      reportDriveTurnComplete('proj_a', turn1);
      expect(submitMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('tryInterceptChatForDrive (C-07)', () => {
    it('drive awaiting-human na sessao ativa: intercepta -> resumeDrive (driving) e retorna true', () => {
      seedProject({ pipelineCurrentPhase: 3 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      coord.escalateFromOrchestrator('proj_a', 'cedo a voce');
      expect(fakeGetDriveState('proj_a')?.status).toBe('awaiting-human');
      submitMock.mockClear();

      const intercepted = coord.tryInterceptChatForDrive('sess_1', 'pode tocar');

      expect(intercepted).toBe(true);
      expect(fakeGetDriveState('proj_a')?.status).toBe('driving');
      expect(submitMock).toHaveBeenCalledTimes(1);
    });

    it('sessao DIFERENTE da do drive: NAO intercepta (retorna false)', () => {
      seedProject({ pipelineCurrentPhase: 3 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      coord.escalateFromOrchestrator('proj_a', 'cedo a voce');
      expect(fakeGetDriveState('proj_a')?.status).toBe('awaiting-human');

      expect(coord.tryInterceptChatForDrive('sess_OUTRA', 'oi')).toBe(false);
      expect(fakeGetDriveState('proj_a')?.status).toBe('awaiting-human');
    });

    it('drive DRIVING (nao awaiting-human): NAO intercepta (so awaiting-human retoma)', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      expect(fakeGetDriveState('proj_a')?.status).toBe('driving');

      expect(coord.tryInterceptChatForDrive('sess_1', 'oi')).toBe(false);
    });

    it('drive STOPPED/encerrado: NUNCA reengaja (retorna false)', () => {
      seedProject({ pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      coord.stopDrive('proj_a', 'teste');
      expect(fakeGetDriveState('proj_a')?.status).toBe('stopped');

      expect(coord.tryInterceptChatForDrive('sess_1', 'oi')).toBe(false);
      expect(fakeGetDriveState('proj_a')?.status).toBe('stopped');
    });
  });

  describe('pushDrivePaused no escalate (C-08)', () => {
    it('escalateFromOrchestrator emite pushDrivePaused (limpa o relogio do chat)', () => {
      seedProject({ pipelineCurrentPhase: 3 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      pausedMock.mockClear();

      coord.escalateFromOrchestrator('proj_a', 'cedo a voce');

      expect(pausedMock).toHaveBeenCalledTimes(1);
      expect(pausedMock.mock.calls[0][0]).toBe('sess_1');
    });
  });

  describe('aviso da faixa de design (C-12 sidecar)', () => {
    it('entrar na fase open-design-studio sob drive dev-v2 avisa UMA vez (chat + Telegram)', async () => {
      seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 4 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      pushMock.mockClear();
      tgHandoffMock.mockClear();

      pipelineEventBus.emit('pipeline:phase-changed', {
        projectId: 'proj_a',
        phase: 5,
        status: 'started',
        awaitingUser: true,
      });
      expect(pushMock).toHaveBeenCalledTimes(1);
      expect(pushMock.mock.calls[0][1]).toContain('design');
      await vi.waitFor(() => expect(tgHandoffMock).toHaveBeenCalledTimes(1));

      pushMock.mockClear();
      tgHandoffMock.mockClear();
      pipelineEventBus.emit('pipeline:phase-changed', {
        projectId: 'proj_a',
        phase: 5,
        status: 'started',
        awaitingUser: true,
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(pushMock).not.toHaveBeenCalled();
      expect(tgHandoffMock).not.toHaveBeenCalled();
    });

    it('NAO inicia o Open Design (nenhum turno de orquestrador na faixa de design)', () => {
      seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 4 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      submitMock.mockClear();

      pipelineEventBus.emit('pipeline:phase-changed', {
        projectId: 'proj_a',
        phase: 5,
        status: 'started',
        awaitingUser: true,
      });

      expect(submitMock).not.toHaveBeenCalled();
    });
  });

  describe('turno de conclusao (C-13)', () => {
    it('pipeline-completed (phase null) apos stopDrive: enfileira UM turno de resumo via sessionId persistida + dispara Telegram (C-13)', async () => {
      seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 16 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      coord.stopDrive('proj_a', 'desenvolvimento-iniciado');
      expect(fakeGetDriveState('proj_a')?.status).toBe('stopped');
      expect(fakeGetDriveState('proj_a')?.sessionId).toBe('sess_1');
      submitMock.mockClear();
      tgHandoffMock.mockClear();

      pipelineEventBus.emit('pipeline:phase-changed', {
        projectId: 'proj_a',
        phase: null,
        status: 'pipeline-completed',
        awaitingUser: false,
      });

      expect(submitMock).toHaveBeenCalledTimes(1);
      const seeded = submitMock.mock.calls[0][0] as string;
      expect(seeded).toContain('CONCLUIR');
      const opts = submitMock.mock.calls[0][1] as { sessionId?: string; origin?: string };
      expect(opts.sessionId).toBe('sess_1');
      expect(opts.origin).toBe('system-event');

      await vi.waitFor(() => expect(tgHandoffMock).toHaveBeenCalledTimes(1));
      expect(tgHandoffMock.mock.calls[0][0]).toContain('concluiu');
    });

    it("status 'completed' (advancePhase, phase null) tambem enfileira o turno de conclusao", () => {
      seedProject({ pipelineType: 'development', pipelineCurrentPhase: 1 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      coord.stopDrive('proj_a', 'teste');
      submitMock.mockClear();

      pipelineEventBus.emit('pipeline:phase-changed', {
        projectId: 'proj_a',
        phase: null,
        status: 'completed',
        awaitingUser: false,
      });

      expect(submitMock).toHaveBeenCalledTimes(1);
    });

    it("'completed' com phase != null (efeito colateral do Design Lock no OD) NAO enfileira", () => {
      seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 5 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      submitMock.mockClear();

      pipelineEventBus.emit('pipeline:phase-changed', {
        projectId: 'proj_a',
        phase: 5,
        status: 'completed',
        awaitingUser: false,
      });

      const completionTurns = submitMock.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('CONCLUIR'),
      );
      expect(completionTurns.length).toBe(0);
    });

    it('conclusao reentrante: o turno de resumo e enfileirado UMA vez por projeto', () => {
      seedProject({ pipelineType: 'development-v2', pipelineCurrentPhase: 16 });
      const coord = makeCoordinator();
      coord.startDrive('proj_a', 'sess_1', 'semi');
      coord.stopDrive('proj_a', 'desenvolvimento-iniciado');
      submitMock.mockClear();

      const completion = {
        projectId: 'proj_a',
        phase: null,
        status: 'pipeline-completed' as const,
        awaitingUser: false,
      };
      pipelineEventBus.emit('pipeline:phase-changed', completion);
      pipelineEventBus.emit('pipeline:phase-changed', completion);

      const completionTurns = submitMock.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('CONCLUIR'),
      );
      expect(completionTurns.length).toBe(1);
    });

    it('projeto SEM drive de orquestrador (sem sessionId persistida): NAO enfileira turno nem dispara Telegram', async () => {
      seedProject({ id: 'proj_sem_drive', pipelineType: 'development', pipelineCurrentPhase: 1 });
      makeCoordinator();
      submitMock.mockClear();
      tgHandoffMock.mockClear();

      pipelineEventBus.emit('pipeline:phase-changed', {
        projectId: 'proj_sem_drive',
        phase: null,
        status: 'pipeline-completed',
        awaitingUser: false,
      });

      expect(submitMock).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 0));
      expect(tgHandoffMock).not.toHaveBeenCalled();
    });
  });
});
