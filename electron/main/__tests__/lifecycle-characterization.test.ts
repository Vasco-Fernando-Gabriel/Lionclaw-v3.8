
import { describe, it, expect, vi, beforeEach } from 'vitest';


const capturedEvents: Array<{ channel: string; data: unknown }> = [];

interface CapturedSql {
  sql: string;
  args: unknown[];
}
const capturedUpdates: CapturedSql[] = [];

const capturedSetStatus: Array<{ projectId: string; status: string }> = [];

const capturedLock: Array<{ op: string; projectId: string; owner?: string }> = [];

const capturedCodex: string[] = [];

const recoverState: {
  runningProjects: Array<{ id: string }>;
  staleMetrics: Array<{ id: number; project_id: string; phase_number: number }>;
} = { runningProjects: [], staleMetrics: [] };

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{
      isDestroyed: () => false,
      webContents: { send: (channel: string, data: unknown) => capturedEvents.push({ channel, data }) },
    }]),
  },
  app: { on: vi.fn() },
}));
vi.mock('fs', () => {
  const existsSync = (): boolean => false;
  const rmSync = (): void => {};
  const readFileSync = (): string => '';
  const writeFileSync = (): void => {};
  const mkdirSync = (): void => {};
  const readdirSync = (): string[] => [];
  return {
    default: { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync },
    existsSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync,
  };
});
vi.mock('path', () => ({
  default: { join: (...a: string[]) => a.join('/') },
  join: (...a: string[]) => a.join('/'),
}));
vi.mock('os', () => ({
  default: { homedir: () => '/home/user', tmpdir: () => '/tmp' },
  homedir: () => '/home/user',
  tmpdir: () => '/tmp',
}));

vi.mock('../db', () => ({
  getHarnessProject: vi.fn(),
  getAgent: vi.fn(),
  getDb: vi.fn(() => ({
    prepare: (sql: string) => ({
      all: vi.fn(() => {
        if (/FROM\s+harness_projects\s+WHERE\s+status\s*=\s*'running'/i.test(sql)) {
          return recoverState.runningProjects;
        }
        if (/FROM\s+pipeline_phase_metrics/i.test(sql)) {
          return recoverState.staleMetrics;
        }
        return [];
      }),
      run: (...args: unknown[]) => {
        if (/UPDATE\s+harness_projects/i.test(sql)) {
          capturedUpdates.push({ sql: norm(sql), args });
        }
        if (/UPDATE\s+pipeline_phase_metrics/i.test(sql)) {
          capturedUpdates.push({ sql: norm(sql), args });
        }
      },
      get: vi.fn(() => undefined),
    }),
  })),
  getPipelinePhaseMessagesAsChatHistory: vi.fn().mockReturnValue([]),
  savePipelinePhaseMetrics: vi.fn(),
  getHarnessSprints: vi.fn().mockReturnValue([]),
  getPipelineMetrics: vi.fn().mockReturnValue({ phases: [] }),
  updateHarnessProject: vi.fn(),
  updateHarnessSprint: vi.fn(),
  getHarnessSprintByIndex: vi.fn(),
  patchSecuritySummaryJson: vi.fn(),
  getSecuritySummaryJson: vi.fn(),
  updateHarnessProjectPipelineColumns: (
    projectId: string,
    columns: {
      pipelineCurrentPhase?: number | null;
      pipelineStartPhase?: number | null;
      discoveryNotesPath?: string | null;
      prdPath?: string | null;
      status?: string;
      pipelineSprintIndex?: number;
      pipelineDiscoveryBlock?: number;
    },
  ) => {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (columns.pipelineCurrentPhase !== undefined) { fields.push('pipeline_current_phase = ?'); values.push(columns.pipelineCurrentPhase); }
    if (columns.pipelineStartPhase !== undefined) { fields.push('pipeline_start_phase = ?'); values.push(columns.pipelineStartPhase); }
    if (columns.discoveryNotesPath !== undefined) { fields.push('discovery_notes_path = ?'); values.push(columns.discoveryNotesPath); }
    if (columns.prdPath !== undefined) { fields.push('prd_path = ?'); values.push(columns.prdPath); }
    if (columns.status !== undefined) { fields.push('status = ?'); values.push(columns.status); }
    if (columns.pipelineSprintIndex !== undefined) { fields.push('pipeline_sprint_index = ?'); values.push(columns.pipelineSprintIndex); }
    if (columns.pipelineDiscoveryBlock !== undefined) { fields.push('pipeline_discovery_block = ?'); values.push(columns.pipelineDiscoveryBlock); }
    if (fields.length > 0) {
      fields.push(`updated_at = datetime('now')`);
      values.push(projectId);
      capturedUpdates.push({ sql: norm(`UPDATE harness_projects SET ${fields.join(', ')} WHERE id = ?`), args: values });
    }
  },
  getMostRecentInProgressRoundId: vi.fn(() => undefined),
  getRunningPipelineProjectIds: vi.fn(() => recoverState.runningProjects.map((r) => r.id)),
  getStaleRunningPhaseMetrics: vi.fn(() =>
    recoverState.staleMetrics.map((m) => ({ id: m.id, projectId: m.project_id, phaseNumber: m.phase_number })),
  ),
  markPhaseMetricInterrupted: vi.fn((id: number) => {
    capturedUpdates.push({
      sql: norm(`UPDATE pipeline_phase_metrics SET status = 'interrupted', completed_at = datetime('now') WHERE id = ?`),
      args: [id],
    });
  }),
}));

vi.mock('../pipeline-shared/status', () => ({
  setProjectStatus: (projectId: string, status: string) => {
    capturedSetStatus.push({ projectId, status });
  },
  deriveUIStatus: (domain: string) => domain,
}));

vi.mock('../pipeline-shared/lock', () => ({
  ensureProjectLock: (projectId: string, owner: string) => {
    capturedLock.push({ op: 'ensure', projectId, owner });
  },
  releaseProjectLock: (projectId: string) => {
    capturedLock.push({ op: 'release', projectId });
  },
  acquireProjectLock: (projectId: string, owner: string) => {
    capturedLock.push({ op: 'acquire', projectId, owner });
  },
  isProjectLocked: vi.fn(() => false),
}));

vi.mock('../pipeline-shared/persist', () => ({
  persistMessage: vi.fn(),
  persistHarnessRound: { insert: vi.fn(), update: vi.fn() },
}));

vi.mock('../agent-runtime/codex-session-factory', () => ({
  resetOfficialProjectRunsNow: (projectId: string) => {
    capturedCodex.push(`reset:${projectId}`);
  },
  hasActiveOfficialRun: vi.fn(() => false),
}));

vi.mock('../agent-runtime', () => ({ executeAgent: vi.fn() }));
vi.mock('../agent-runtime/types', () => ({
  PipelinePausedError: class PipelinePausedError extends Error {},
}));
vi.mock('../agent-runtime/permission-profiles', () => ({
  PERM_BYPASS_NO_GUARD: { mode: 'bypass' },
}));
vi.mock('../harness-engine', () => {
  const HarnessEngine = vi.fn();
  HarnessEngine.prototype.abort = vi.fn();
  HarnessEngine.prototype.runSingleSprint = vi.fn();
  HarnessEngine.prototype.setStreamBridge = vi.fn();
  HarnessEngine.prototype.clearStreamBridge = vi.fn();
  return { HarnessEngine };
});
vi.mock('../harness-planner', () => ({
  reseedHarnessSprintsFromFile: vi.fn(() => ({ action: 'noop', totalSprints: 1, totalFeatures: 1 })),
  checkHarnessSprintQueueIntegrity: vi.fn(() => ({ ok: true })),
  readHarnessSprintsJson: vi.fn(() => null),
}));
vi.mock('../security-audit-runner', () => ({ SecurityAuditRunner: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../repo-profiler', () => ({ runRepoProfiler: vi.fn() }));
vi.mock('../security-findings-parser', () => ({ parseSecurityFindings: vi.fn() }));
vi.mock('../pipeline-paths', () => ({
  generatePipelineDocsId: vi.fn(() => 'NEW-DOCS-ID'),
  getPipelineDocsContext: vi.fn(() => null),
  migrateLegacyDocsToFolder: vi.fn(),
  findConsolidatedSecurityReport: vi.fn(),
  findHarnessSprintsReadPath: vi.fn(() => null),
  migrateHarnessSprintsToPipelineDocs: vi.fn(),
  resolveHarnessSprintsPath: vi.fn(() => null),
  resolvePrdPath: vi.fn(() => null),
}));
vi.mock('../pipeline-report', () => ({ generatePipelineReport: vi.fn(), exportPipelineReport: vi.fn() }));
vi.mock('../pipeline-metrics-report', () => ({}));
vi.mock('../architecture-review-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../architecture-review-paths')>();
  return { ...actual, getArchitectureReviewContext: () => null };
});
vi.mock('../open-design/full-wipe', () => ({ wipeOpenDesign: vi.fn().mockResolvedValue({ ok: true }) }));
const lockState: { result: unknown } = { result: { error: 'snapshot failed' } };
vi.mock('../open-design/lock', () => ({
  lock: () => Promise.resolve(lockState.result),
}));
vi.mock('../open-design/auto-correct', () => ({
  requestAgentCorrection: vi.fn().mockResolvedValue({ runId: 'r1' }),
  waitForAgentCorrection: vi.fn().mockResolvedValue(true),
}));

import { PipelineEngine } from '../pipeline-engine';
import { HarnessEngine } from '../harness-engine';
import * as db from '../db';

function makeEngine(): PipelineEngine {
  const harnessInstance = new HarnessEngine({} as never);
  return new PipelineEngine(() => null, harnessInstance as never);
}

interface ProjectLike {
  id: string;
  name: string;
  projectPath: string;
  pipelineType: string;
  pipelineDocsId: string | null;
  pipelineCurrentPhase: number | null;
  pipelineSprintIndex?: number;
  status: string;
  specPath?: string | null;
  config?: Record<string, unknown>;
}

function makeProject(type: string, overrides: Partial<ProjectLike> = {}): ProjectLike {
  return {
    id: 'proj-1',
    name: 'Lifecycle Test',
    projectPath: '/tmp/project',
    pipelineType: type,
    pipelineDocsId: 'DOCS-ID',
    pipelineCurrentPhase: 1,
    status: 'running',
    specPath: '/tmp/project/SPEC.md',
    config: {},
    ...overrides,
  };
}

function primeState(
  engine: PipelineEngine,
  projectId: string,
  fields: { currentPhase: number; status?: string; currentSprintIndex?: number },
): { currentPhase: number; status: string; currentSprintIndex?: number; abortController: AbortController } {
  const state = (engine as unknown as {
    getState(id: string): {
      currentPhase: number;
      status: string;
      currentSprintIndex?: number;
      abortController: AbortController;
    };
  }).getState(projectId);
  state.currentPhase = fields.currentPhase;
  state.status = fields.status ?? 'running';
  if (fields.currentSprintIndex !== undefined) state.currentSprintIndex = fields.currentSprintIndex;
  state.abortController = new AbortController();
  return state;
}

function phaseChangedEvents(): Array<Record<string, unknown>> {
  return capturedEvents
    .filter((e) => e.channel === 'pipeline:phase-changed')
    .map((e) => e.data as Record<string, unknown>);
}

function channelsInOrder(): string[] {
  return capturedEvents.map((e) => e.channel);
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedEvents.length = 0;
  capturedUpdates.length = 0;
  capturedSetStatus.length = 0;
  capturedLock.length = 0;
  capturedCodex.length = 0;
  recoverState.runningProjects = [];
  recoverState.staleMetrics = [];
});

describe('DONE-site #1 — advancePhase (status string "completed")', () => {
  it('dev pipeline: last phase -> done; emits phase-changed status="completed", phase=null, awaitingUser=false', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('development', { pipelineCurrentPhase: 14 }) as never);
    const engine = makeEngine();
    const state = primeState(engine, 'proj-1', { currentPhase: 14, status: 'running' });
    capturedEvents.length = 0;
    capturedUpdates.length = 0;
    capturedLock.length = 0;
    capturedCodex.length = 0;

    await engine.advancePhase('proj-1');

    const pc = phaseChangedEvents();
    expect(pc).toEqual([
      { projectId: 'proj-1', phase: null, status: 'completed', awaitingUser: false },
    ]);

    expect(capturedUpdates).toHaveLength(1);
    expect(capturedUpdates[0].sql).toBe(
      "UPDATE harness_projects SET pipeline_current_phase = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
    );
    expect(capturedUpdates[0].args).toEqual([null, 'done', 'proj-1']);

    expect(capturedLock).toEqual([{ op: 'release', projectId: 'proj-1' }]);

    expect(state.status).not.toBe('idle');

    expect(capturedCodex).toEqual(['reset:proj-1']);

    expect(channelsInOrder()).toEqual([
      'pipeline:project-updated',
      'pipeline:phase-changed',
    ]);
  });

  it('advancePhase done path emits "completed" — NOT "pipeline-completed" (the divergence vs the other 3 done-sites)', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('development', { pipelineCurrentPhase: 14 }) as never);
    const engine = makeEngine();
    primeState(engine, 'proj-1', { currentPhase: 14 });
    capturedEvents.length = 0;

    await engine.advancePhase('proj-1');

    const pc = phaseChangedEvents();
    expect(pc[0].status).toBe('completed');
    expect(pc[0].status).not.toBe('pipeline-completed');
  });
});

describe('DONE-site #2 — advanceToNextPhase (status string "pipeline-completed")', () => {
  it('security pipeline: last phase -> done; emits phase-changed status="pipeline-completed", phase=null', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('security', { pipelineCurrentPhase: 11 }) as never);
    const engine = makeEngine();
    const state = primeState(engine, 'proj-1', { currentPhase: 11, status: 'running' });
    capturedEvents.length = 0;
    capturedUpdates.length = 0;
    capturedLock.length = 0;
    capturedCodex.length = 0;

    await (engine as unknown as {
      advanceToNextPhase(id: string, st: unknown): Promise<void>;
    }).advanceToNextPhase('proj-1', state);

    const pc = phaseChangedEvents();
    expect(pc).toEqual([
      { projectId: 'proj-1', phase: null, status: 'pipeline-completed', awaitingUser: false },
    ]);
    expect(pc[0].status).toBe('pipeline-completed');

    expect(capturedUpdates).toHaveLength(1);
    expect(capturedUpdates[0].args).toEqual([null, 'done', 'proj-1']);

    expect(capturedLock).toEqual([{ op: 'release', projectId: 'proj-1' }]);
    expect(capturedCodex).toEqual(['reset:proj-1']);

    expect(state.status).not.toBe('idle');
  });

  it('advanceToNextPhase done path does NOT invoke runResolutionTracker', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('security', { pipelineCurrentPhase: 11 }) as never);
    const engine = makeEngine();
    const state = primeState(engine, 'proj-1', { currentPhase: 11 });
    const rtSpy = vi.spyOn(engine as unknown as { runResolutionTracker(...a: unknown[]): Promise<void> }, 'runResolutionTracker')
      .mockResolvedValue(undefined);
    capturedEvents.length = 0;

    await (engine as unknown as { advanceToNextPhase(id: string, st: unknown): Promise<void> })
      .advanceToNextPhase('proj-1', state);

    expect(rtSpy).not.toHaveBeenCalled();
  });
});

describe('DONE-site #3 — runSprint (idle-BEFORE + pipeline-completed + Resolution Tracker)', () => {
  it('security last sprint: state.status="idle" set BEFORE columns; phase-changed "pipeline-completed" with totalSprints; runResolutionTracker fired POST-emit', async () => {
    const project = makeProject('security', { pipelineCurrentPhase: 10 });
    vi.mocked(db.getHarnessProject).mockReturnValue(project as never);
    vi.mocked(db.getHarnessSprints).mockReturnValue([
      { id: 's0', name: 'Sprint 1', coderAgentId: 'harness-coder', evaluatorAgentId: 'harness-evaluator' },
    ] as never);

    const engine = makeEngine();
    const harness = (engine as unknown as { harnessEngine: { runSingleSprint: ReturnType<typeof vi.fn> } }).harnessEngine;
    harness.runSingleSprint = vi.fn().mockResolvedValue({
      verdict: 'pass',
      rounds: 1,
      metrics: {},
      coderMetrics: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUsd: 0, durationMs: 0, toolUses: 0, apiRequests: 0 },
      evaluatorMetrics: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUsd: 0, durationMs: 0, toolUses: 0, apiRequests: 0 },
    });
    const rtSpy = vi.spyOn(engine as unknown as { runResolutionTracker(...a: unknown[]): Promise<void> }, 'runResolutionTracker')
      .mockResolvedValue(undefined);

    const state = primeState(engine, 'proj-1', { currentPhase: 10, status: 'running', currentSprintIndex: 0 });
    capturedEvents.length = 0;
    capturedUpdates.length = 0;
    capturedLock.length = 0;
    capturedCodex.length = 0;

    await engine.runSprint('proj-1', 0);

    const pc = phaseChangedEvents();
    const terminal = pc[pc.length - 1];
    expect(terminal).toEqual({
      projectId: 'proj-1',
      phase: null,
      status: 'pipeline-completed',
      awaitingUser: false,
      metadata: { totalSprints: 1 },
    });
    expect(terminal.status).toBe('pipeline-completed');

    expect(state.status).toBe('idle');

    const doneUpdate = capturedUpdates.find((u) => Array.isArray(u.args) && u.args.includes('done') && (u.args as unknown[]).includes(null));
    expect(doneUpdate).toBeDefined();
    expect(doneUpdate!.args).toEqual([null, 'done', 'proj-1']);

    expect(capturedLock.some((l) => l.op === 'release' && l.projectId === 'proj-1')).toBe(true);
    expect(capturedCodex).toContain('reset:proj-1');

    expect(rtSpy).toHaveBeenCalledTimes(1);
    expect(rtSpy).toHaveBeenCalledWith('proj-1', project);
    const completedIdx = capturedEvents.findIndex(
      (e) => e.channel === 'pipeline:phase-changed' && (e.data as Record<string, unknown>).status === 'pipeline-completed',
    );
    expect(completedIdx).toBeGreaterThanOrEqual(0);
  });

  it('runSprint done path on NON-security pipeline does NOT invoke runResolutionTracker', async () => {
    const project = makeProject('development', { pipelineCurrentPhase: 13 });
    vi.mocked(db.getHarnessProject).mockReturnValue(project as never);
    vi.mocked(db.getHarnessSprints).mockReturnValue([
      { id: 's0', name: 'Sprint 1', coderAgentId: 'harness-coder', evaluatorAgentId: 'harness-evaluator' },
    ] as never);

    const engine = makeEngine();
    const harness = (engine as unknown as { harnessEngine: { runSingleSprint: ReturnType<typeof vi.fn> } }).harnessEngine;
    harness.runSingleSprint = vi.fn().mockResolvedValue({
      verdict: 'pass', rounds: 1, metrics: {},
      coderMetrics: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUsd: 0, durationMs: 0, toolUses: 0, apiRequests: 0 },
      evaluatorMetrics: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUsd: 0, durationMs: 0, toolUses: 0, apiRequests: 0 },
    });
    const rtSpy = vi.spyOn(engine as unknown as { runResolutionTracker(...a: unknown[]): Promise<void> }, 'runResolutionTracker')
      .mockResolvedValue(undefined);

    primeState(engine, 'proj-1', { currentPhase: 13, status: 'running', currentSprintIndex: 0 });
    capturedEvents.length = 0;

    await engine.runSprint('proj-1', 0);

    const pc = phaseChangedEvents();
    expect(pc[pc.length - 1].status).toBe('pipeline-completed');
    expect(rtSpy).not.toHaveBeenCalled();
  });
});

describe('DONE-site #4 — acceptSprint (idle-BEFORE + pipeline-completed + Resolution Tracker)', () => {
  it('security last sprint accepted: state.status="idle" BEFORE columns; pipeline-completed with totalSprints; runResolutionTracker fired', async () => {
    const project = makeProject('security', { pipelineCurrentPhase: 11 });
    vi.mocked(db.getHarnessProject).mockReturnValue(project as never);
    vi.mocked(db.getHarnessSprints).mockReturnValue([
      { id: 's0', name: 'Sprint 1', roundsUsed: 3 },
    ] as never);

    const engine = makeEngine();
    const rtSpy = vi.spyOn(engine as unknown as { runResolutionTracker(...a: unknown[]): Promise<void> }, 'runResolutionTracker')
      .mockResolvedValue(undefined);

    const state = primeState(engine, 'proj-1', { currentPhase: 11, status: 'running', currentSprintIndex: 0 });
    capturedEvents.length = 0;
    capturedUpdates.length = 0;
    capturedLock.length = 0;
    capturedCodex.length = 0;

    await engine.acceptSprint('proj-1', 0);

    const pc = phaseChangedEvents();
    const terminal = pc[pc.length - 1];
    expect(terminal).toEqual({
      projectId: 'proj-1',
      phase: null,
      status: 'pipeline-completed',
      awaitingUser: false,
      metadata: { totalSprints: 1 },
    });

    expect(state.status).toBe('idle');

    const doneUpdate = capturedUpdates.find((u) => (u.args as unknown[]).includes('done') && (u.args as unknown[]).includes(null));
    expect(doneUpdate!.args).toEqual([null, 'done', 'proj-1']);
    expect(capturedLock.some((l) => l.op === 'release')).toBe(true);
    expect(capturedCodex).toContain('reset:proj-1');

    expect(rtSpy).toHaveBeenCalledTimes(1);
    expect(rtSpy).toHaveBeenCalledWith('proj-1', project);

    const completedIdx = capturedEvents.findIndex(
      (e) => e.channel === 'pipeline:phase-changed' && (e.data as Record<string, unknown>).status === 'pipeline-completed',
    );
    expect(completedIdx).toBeGreaterThanOrEqual(0);
  });

  it('acceptSprint done path on NON-security pipeline does NOT invoke runResolutionTracker; still emits pipeline-completed', async () => {
    const project = makeProject('feature', { pipelineCurrentPhase: 14 });
    vi.mocked(db.getHarnessProject).mockReturnValue(project as never);
    vi.mocked(db.getHarnessSprints).mockReturnValue([{ id: 's0', name: 'Sprint 1', roundsUsed: 1 }] as never);

    const engine = makeEngine();
    const rtSpy = vi.spyOn(engine as unknown as { runResolutionTracker(...a: unknown[]): Promise<void> }, 'runResolutionTracker')
      .mockResolvedValue(undefined);
    primeState(engine, 'proj-1', { currentPhase: 14, status: 'running', currentSprintIndex: 0 });
    capturedEvents.length = 0;

    await engine.acceptSprint('proj-1', 0);

    const pc = phaseChangedEvents();
    expect(pc[pc.length - 1].status).toBe('pipeline-completed');
    expect(rtSpy).not.toHaveBeenCalled();
  });
});

describe('DONE-sites cross-invariant (the consolidation contract)', () => {
  it('completed=>advancePhase; pipeline-completed=>{advanceToNextPhase, runSprint, acceptSprint}', () => {
    const matrix = {
      advancePhase: { statusString: 'completed', setStateIdleBefore: false, resolutionTracker: false },
      advanceToNextPhase: { statusString: 'pipeline-completed', setStateIdleBefore: false, resolutionTracker: false },
      runSprint: { statusString: 'pipeline-completed', setStateIdleBefore: true, resolutionTracker: 'security-only' },
      acceptSprint: { statusString: 'pipeline-completed', setStateIdleBefore: true, resolutionTracker: 'security-only' },
    };
    expect(matrix.advancePhase.statusString).toBe('completed');
    expect(matrix.advanceToNextPhase.statusString).toBe('pipeline-completed');
    expect(matrix.runSprint.statusString).toBe('pipeline-completed');
    expect(matrix.acceptSprint.statusString).toBe('pipeline-completed');
    expect(matrix.runSprint.setStateIdleBefore).toBe(true);
    expect(matrix.acceptSprint.setStateIdleBefore).toBe(true);
    expect(matrix.advancePhase.setStateIdleBefore).toBe(false);
    expect(matrix.advanceToNextPhase.setStateIdleBefore).toBe(false);
  });
});


describe('FAIL-site #1 — runAutoPhase (pure-paused; error + phase-changed:failed; NO stream done)', () => {
  it('auto phase throws: setProjectStatus("paused") + state.status="paused"; emits pipeline:error THEN phase-changed status="failed" awaitingUser=true; NO stream done', async () => {
    const project = makeProject('development', { pipelineCurrentPhase: 2 });
    vi.mocked(db.getHarnessProject).mockReturnValue(project as never);

    const engine = makeEngine();
    vi.spyOn(engine as unknown as { spawnAgent(...a: unknown[]): Promise<unknown> }, 'spawnAgent')
      .mockRejectedValue(new Error('boom'));

    const state = primeState(engine, 'proj-1', { currentPhase: 2, status: 'running' });
    capturedEvents.length = 0;
    capturedSetStatus.length = 0;
    capturedUpdates.length = 0;

    await (engine as unknown as { runAutoPhase(id: string, phase: number): Promise<void> }).runAutoPhase('proj-1', 2);

    expect(capturedSetStatus).toEqual([{ projectId: 'proj-1', status: 'paused' }]);
    expect(capturedUpdates.some((u) => (u.args as unknown[]).includes('paused'))).toBe(false);
    expect(capturedUpdates.some((u) => (u.args as unknown[]).includes('done'))).toBe(false);

    expect(state.status).toBe('paused');

    const errIdx = capturedEvents.findIndex((e) => e.channel === 'pipeline:error');
    const pcIdx = capturedEvents.findIndex(
      (e) => e.channel === 'pipeline:phase-changed' && (e.data as Record<string, unknown>).status === 'failed',
    );
    expect(errIdx).toBeGreaterThanOrEqual(0);
    expect(pcIdx).toBeGreaterThan(errIdx);

    const failPc = (capturedEvents[pcIdx].data as Record<string, unknown>);
    expect(failPc.status).toBe('failed');
    expect(failPc.awaitingUser).toBe(true);
    expect(failPc.phase).toBe(2);

    const streamDone = capturedEvents.filter(
      (e) => e.channel === 'pipeline:stream' && (e.data as Record<string, unknown>).type === 'done',
    );
    expect(streamDone).toHaveLength(0);

    expect(capturedSetStatus.some((s) => s.status === 'failed')).toBe(false);
  });
});

describe('FAIL-site #2 — runPhase9 / Spec Generation (pure-paused; error + phase-changed:failed; NO stream done on fail path)', () => {
  it('phase 9 builder loop exhausts with lastError: pure setProjectStatus("paused"); error + phase-changed "failed"; state.status="paused"; INV-6 no failed persisted', async () => {
    const project = makeProject('development', { pipelineCurrentPhase: 9 });
    vi.mocked(db.getHarnessProject).mockReturnValue(project as never);

    const engine = makeEngine();
    vi.spyOn(engine as unknown as { spawnAgent(...a: unknown[]): Promise<unknown> }, 'spawnAgent')
      .mockRejectedValue(new Error('spec gen failed'));

    const state = primeState(engine, 'proj-1', { currentPhase: 9, status: 'running' });
    capturedEvents.length = 0;
    capturedSetStatus.length = 0;
    capturedUpdates.length = 0;

    void state;
    await (engine as unknown as {
      runPhase9(id: string): Promise<void>;
    }).runPhase9('proj-1');

    expect(capturedSetStatus).toEqual([{ projectId: 'proj-1', status: 'paused' }]);
    expect(state.status).toBe('paused');

    expect(capturedEvents.some((e) => e.channel === 'pipeline:error')).toBe(true);
    const failPc = phaseChangedEvents().find((p) => p.status === 'failed');
    expect(failPc).toBeDefined();
    expect(failPc!.phase).toBe(9);
    expect(failPc!.awaitingUser).toBe(true);

    const streamDone = capturedEvents.filter(
      (e) => e.channel === 'pipeline:stream' && (e.data as Record<string, unknown>).type === 'done',
    );
    expect(streamDone).toHaveLength(0);

    expect(capturedSetStatus.some((s) => s.status === 'failed')).toBe(false);
  });
});

describe('FAIL-site #3 — runSprint (pure-paused; pipeline:error; NO phase-changed; NO stream done)', () => {
  it('runSingleSprint throws non-abort: emits pipeline:error; sets state.status="paused" + setProjectStatus("paused"); does NOT emit phase-changed; lock NOT released', async () => {
    const project = makeProject('development', { pipelineCurrentPhase: 13 });
    vi.mocked(db.getHarnessProject).mockReturnValue(project as never);
    vi.mocked(db.getHarnessSprints).mockReturnValue([
      { id: 's0', name: 'Sprint 1', coderAgentId: 'harness-coder', evaluatorAgentId: 'harness-evaluator' },
    ] as never);

    const engine = makeEngine();
    const harness = (engine as unknown as { harnessEngine: { runSingleSprint: ReturnType<typeof vi.fn> } }).harnessEngine;
    harness.runSingleSprint = vi.fn().mockRejectedValue(new Error('coder crashed'));

    const state = primeState(engine, 'proj-1', { currentPhase: 13, status: 'running', currentSprintIndex: 0 });
    capturedEvents.length = 0;
    capturedSetStatus.length = 0;
    capturedLock.length = 0;

    await engine.runSprint('proj-1', 0);

    expect(capturedSetStatus).toEqual([{ projectId: 'proj-1', status: 'paused' }]);
    expect(state.status).toBe('paused');

    const errEvent = capturedEvents.find((e) => e.channel === 'pipeline:error');
    expect(errEvent).toBeDefined();
    expect((errEvent!.data as Record<string, unknown>).phase).toBe(13);
    expect((errEvent!.data as Record<string, unknown>).error).toBe('coder crashed');

    expect(phaseChangedEvents().some((p) => p.status === 'failed')).toBe(false);

    expect(capturedEvents.filter((e) => e.channel === 'pipeline:stream' && (e.data as Record<string, unknown>).type === 'done')).toHaveLength(0);

    expect(capturedLock.some((l) => l.op === 'release')).toBe(false);

    expect(capturedSetStatus.some((s) => s.status === 'failed')).toBe(false);
  });
});

describe('FAIL-site #4 — dev-v2 Design Lock hard error (COMPOSITE statusUpdate; stream done; NO pipeline:error; NO state.status)', () => {
  it('lock() returns {error}: composite updateProjectColumns({status:"paused", pipelineCurrentPhase:6}); stream {done}; phase-changed "failed"; NO pipeline:error; does NOT set state.status', async () => {
    const project = makeProject('development-v2', { pipelineCurrentPhase: 6 });
    vi.mocked(db.getHarnessProject).mockReturnValue(project as never);
    lockState.result = { error: 'snapshot failed' };

    const engine = makeEngine();
    const state = primeState(engine, 'proj-1', { currentPhase: 6, status: 'running' });
    capturedEvents.length = 0;
    capturedSetStatus.length = 0;
    capturedUpdates.length = 0;

    await (engine as unknown as {
      runDevV2Phase6DesignLock(id: string, st: unknown): Promise<void>;
    }).runDevV2Phase6DesignLock('proj-1', state);

    const composite = capturedUpdates.find(
      (u) => (u.args as unknown[]).includes('paused') && (u.args as unknown[]).includes(6),
    );
    expect(composite).toBeDefined();
    expect(composite!.sql).toBe(
      "UPDATE harness_projects SET pipeline_current_phase = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
    );
    expect(composite!.args).toEqual([6, 'paused', 'proj-1']);

    expect(capturedSetStatus).toHaveLength(0);

    expect(capturedEvents.some((e) => e.channel === 'pipeline:error')).toBe(false);

    expect(
      capturedEvents.some((e) => e.channel === 'pipeline:stream' && (e.data as Record<string, unknown>).type === 'done'),
    ).toBe(true);

    const failPc = phaseChangedEvents().find((p) => p.status === 'failed' && p.phase === 6);
    expect(failPc).toBeDefined();
    expect(failPc!.awaitingUser).toBe(true);

    expect(state.status).toBe('running');

    expect(capturedSetStatus.some((s) => s.status === 'failed')).toBe(false);
  });
});

describe('FAIL-site #5 — dev-v2 Phase 12 (pure-paused; error + phase-changed:failed; NO stream done on fail path)', () => {
  it('phase 12 loop with lastError: pure setProjectStatus("paused"); error + phase-changed "failed"; state.status="paused"; INV-6 no failed persisted', async () => {
    const project = makeProject('development-v2', { pipelineCurrentPhase: 12 });
    vi.mocked(db.getHarnessProject).mockReturnValue(project as never);

    const engine = makeEngine();
    vi.spyOn(engine as unknown as { spawnAgent(...a: unknown[]): Promise<unknown> }, 'spawnAgent')
      .mockRejectedValue(new Error('phase12 boom'));
    vi.spyOn(engine as unknown as { flushAccumulatedMetrics(...a: unknown[]): void }, 'flushAccumulatedMetrics')
      .mockImplementation(() => {});

    const state = primeState(engine, 'proj-1', { currentPhase: 12, status: 'running' });
    capturedEvents.length = 0;
    capturedSetStatus.length = 0;
    capturedUpdates.length = 0;

    await (engine as unknown as {
      runDevV2Phase12SpecGeneration(id: string, projectPath: string, st: unknown): Promise<void>;
    }).runDevV2Phase12SpecGeneration('proj-1', '/tmp/project', state);

    expect(capturedSetStatus).toEqual([{ projectId: 'proj-1', status: 'paused' }]);
    expect(state.status).toBe('paused');

    expect(capturedEvents.some((e) => e.channel === 'pipeline:error')).toBe(true);
    const failPc = phaseChangedEvents().find((p) => p.status === 'failed');
    expect(failPc).toBeDefined();
    expect(failPc!.phase).toBe(12);
    expect(failPc!.awaitingUser).toBe(true);

    expect(
      capturedEvents.filter((e) => e.channel === 'pipeline:stream' && (e.data as Record<string, unknown>).type === 'done'),
    ).toHaveLength(0);

    expect(capturedSetStatus.some((s) => s.status === 'failed')).toBe(false);
  });
});

describe('FAIL-sites cross-invariant matrix (failPhase parametrization contract — LC-1 / RK-8)', () => {
  it('all 5 persist paused; only Design Lock is composite + has streamDone + no pipeline:error', () => {
    const matrix = {
      runAutoPhase: { statusUpdate: 'pure-paused', emitsError: true, emitsPhaseChangedFailed: true, emitsStreamDone: false, setsStateStatus: true },
      runPhase9: { statusUpdate: 'pure-paused', emitsError: true, emitsPhaseChangedFailed: true, emitsStreamDone: false, setsStateStatus: true },
      runSprint: { statusUpdate: 'pure-paused', emitsError: true, emitsPhaseChangedFailed: false, emitsStreamDone: false, setsStateStatus: true },
      devV2DesignLock: { statusUpdate: 'composite:{status:paused,pipelineCurrentPhase:6}', emitsError: false, emitsPhaseChangedFailed: true, emitsStreamDone: true, setsStateStatus: false },
      devV2Phase12: { statusUpdate: 'pure-paused', emitsError: true, emitsPhaseChangedFailed: true, emitsStreamDone: false, setsStateStatus: true },
    };
    for (const site of Object.values(matrix)) {
      expect(site.statusUpdate.startsWith('pure-paused') || site.statusUpdate.startsWith('composite')).toBe(true);
    }
    expect(matrix.devV2DesignLock.statusUpdate).toContain('composite');
    expect(matrix.devV2DesignLock.emitsError).toBe(false);
    expect(matrix.devV2DesignLock.emitsStreamDone).toBe(true);
    expect(matrix.devV2DesignLock.setsStateStatus).toBe(false);
    expect(matrix.runSprint.emitsPhaseChangedFailed).toBe(false);
    expect(matrix.runAutoPhase.emitsPhaseChangedFailed).toBe(true);
    expect(matrix.runPhase9.emitsPhaseChangedFailed).toBe(true);
    expect(matrix.devV2Phase12.emitsPhaseChangedFailed).toBe(true);
  });
});

describe(': 14 getMaxPhase fallback — DEAD (only with null project)', () => {
  it('advancePhase: with a real project, getMaxPhase(project) drives the bound, NOT 14 (proven by security max=11 completing at phase 11)', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('security', { pipelineCurrentPhase: 11 }) as never);
    const engine = makeEngine();
    primeState(engine, 'proj-1', { currentPhase: 11 });
    capturedEvents.length = 0;

    await engine.advancePhase('proj-1');

    const pc = phaseChangedEvents();
    expect(pc).toEqual([
      { projectId: 'proj-1', phase: null, status: 'completed', awaitingUser: false },
    ]);
  });

  it('advancePhase: null project + currentPhase=14 hits the dead `: 14` branch and completes (the ONLY way the fallback fires)', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(null as never);
    const engine = makeEngine();
    primeState(engine, 'proj-1', { currentPhase: 14 });
    capturedEvents.length = 0;

    await engine.advancePhase('proj-1');

    const pc = phaseChangedEvents();
    expect(pc).toEqual([
      { projectId: 'proj-1', phase: null, status: 'completed', awaitingUser: false },
    ]);
  });

  it('advancePhase: null project + currentPhase=13 does NOT complete (nextPhase 14 <= fallback 14) — confirms the literal is exactly 14', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(null as never);
    const engine = makeEngine();
    primeState(engine, 'proj-1', { currentPhase: 13 });
    capturedEvents.length = 0;

    await engine.advancePhase('proj-1');

    const terminal = phaseChangedEvents().find((p) => p.phase === null && p.status === 'completed');
    expect(terminal).toBeUndefined();
    expect(phaseChangedEvents().some((p) => p.phase === 14 && p.status === 'started')).toBe(true);
  });

  it('advanceToNextPhase: null project uses the same `: 14` literal (currentPhase=14 completes with pipeline-completed)', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(null as never);
    const engine = makeEngine();
    const state = primeState(engine, 'proj-1', { currentPhase: 14 });
    capturedEvents.length = 0;

    await (engine as unknown as { advanceToNextPhase(id: string, st: unknown): Promise<void> })
      .advanceToNextPhase('proj-1', state);

    const pc = phaseChangedEvents();
    expect(pc).toEqual([
      { projectId: 'proj-1', phase: null, status: 'pipeline-completed', awaitingUser: false },
    ]);
  });
});

describe('recoverInterruptedPipelines (boot recovery)', () => {
  it('for each DB project with status="running" AND phase NOT NULL: releaseProjectLock + setProjectStatus("interrupted") + phase-changed{status:"interrupted", phase:null, awaitingUser:true}', () => {
    recoverState.runningProjects = [{ id: 'p1' }, { id: 'p2' }];
    recoverState.staleMetrics = [];

    makeEngine();

    const releases = capturedLock.filter((l) => l.op === 'release').map((l) => l.projectId);
    expect(releases).toEqual(['p1', 'p2']);

    expect(capturedSetStatus).toEqual([
      { projectId: 'p1', status: 'interrupted' },
      { projectId: 'p2', status: 'interrupted' },
    ]);

    const pc = phaseChangedEvents();
    expect(pc).toEqual([
      { projectId: 'p1', phase: null, status: 'interrupted', awaitingUser: true },
      { projectId: 'p2', phase: null, status: 'interrupted', awaitingUser: true },
    ]);
  });

  it('stale running pipeline_phase_metrics (project not running) are UPDATEd to interrupted', () => {
    recoverState.runningProjects = [];
    recoverState.staleMetrics = [
      { id: 101, project_id: 'pX', phase_number: 6 },
      { id: 102, project_id: 'pY', phase_number: 11 },
    ];

    makeEngine();

    const metricUpdates = capturedUpdates.filter((u) => /UPDATE pipeline_phase_metrics/i.test(u.sql));
    expect(metricUpdates).toHaveLength(2);
    expect(metricUpdates[0].args).toEqual([101]);
    expect(metricUpdates[1].args).toEqual([102]);

    expect(phaseChangedEvents()).toHaveLength(0);
    expect(capturedSetStatus).toHaveLength(0);
  });

  it('no running projects + no stale metrics: recovery is a clean no-op (no emits, no status writes, no lock ops)', () => {
    recoverState.runningProjects = [];
    recoverState.staleMetrics = [];

    makeEngine();

    expect(capturedEvents).toHaveLength(0);
    expect(capturedSetStatus).toHaveLength(0);
    expect(capturedLock).toHaveLength(0);
    expect(capturedUpdates).toHaveLength(0);
  });
});

describe('TB-17 (iii) — gate do Sprint Validator: baseline dos 5 tipos + bug', () => {
  interface AccumState {
    phaseMetricAccum: Map<number, unknown>;
  }

  function seedAccum(engine: PipelineEngine, projectId: string, phase: number): void {
    (engine as unknown as {
      accumulateMetrics: (s: unknown, p: number, r: unknown) => void;
    }).accumulateMetrics(
      (engine as unknown as { getState: (id: string) => AccumState }).getState(projectId),
      phase,
      {
        output: 'ok',
        metrics: {
          inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0,
          toolUses: 0, apiRequests: 1, costUsd: 0.01, durationMs: 100,
        },
        model: 'claude-opus-5',
        runtime: 'cloud',
        provider: 'anthropic',
      },
    );
  }

  const GATE_CASES: Array<{ type: string; gatePhase: number }> = [
    { type: 'security', gatePhase: 9 },
    { type: 'architecture-review', gatePhase: 9 },
    { type: 'development', gatePhase: 12 },
    { type: 'feature', gatePhase: 12 },
    { type: 'development-v2', gatePhase: 15 },
    { type: 'bug', gatePhase: 7 },
  ];

  it.each(GATE_CASES)(
    '$type: o gate awaiting-dev-confirmation abre na fase $gatePhase',
    async ({ type, gatePhase }) => {
      vi.mocked(db.getHarnessProject).mockReturnValue(
        makeProject(type, { pipelineCurrentPhase: gatePhase }) as never,
      );
      const engine = makeEngine();
      const advance = vi.fn(async () => {});
      (engine as unknown as { advanceToNextPhase: unknown }).advanceToNextPhase = advance;
      primeState(engine, 'proj-1', { currentPhase: gatePhase });
      capturedEvents.length = 0;

      await engine.approvePhase('proj-1');

      const gate = phaseChangedEvents().find((e) => e['status'] === 'awaiting-dev-confirmation');
      expect(gate, `${type} fase ${gatePhase}`).toBeDefined();
      expect(gate!['phase']).toBe(gatePhase);
      expect(gate!['awaitingUser']).toBe(true);
      expect(advance).not.toHaveBeenCalled();
    },
  );

  it('feature fase 1: agent_id continua vindo do FALLBACK LEGADO (discovery-agent), nunca feat-discovery', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(
      makeProject('feature', { pipelineCurrentPhase: 1 }) as never,
    );
    const engine = makeEngine();
    (engine as unknown as { advanceToNextPhase: unknown }).advanceToNextPhase = vi.fn(async () => {});
    primeState(engine, 'proj-1', { currentPhase: 1 });
    seedAccum(engine, 'proj-1', 1);

    await engine.approvePhase('proj-1');

    const saved = vi.mocked(db.savePipelinePhaseMetrics).mock.calls.map(
      (c) => c[0] as { phaseNumber: number; agentId?: string },
    );
    const row = saved.find((s) => s.phaseNumber === 1);
    expect(row).toBeDefined();
    expect(row!.agentId).toBe('discovery-agent');
    expect(row!.agentId).not.toBe('feat-discovery');
  });

  it('development fase 1: agent_id continua discovery-agent (mesmo switch, mesmo fallback)', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(
      makeProject('development', { pipelineCurrentPhase: 1 }) as never,
    );
    const engine = makeEngine();
    (engine as unknown as { advanceToNextPhase: unknown }).advanceToNextPhase = vi.fn(async () => {});
    primeState(engine, 'proj-1', { currentPhase: 1 });
    seedAccum(engine, 'proj-1', 1);

    await engine.approvePhase('proj-1');

    const row = vi.mocked(db.savePipelinePhaseMetrics).mock.calls
      .map((c) => c[0] as { phaseNumber: number; agentId?: string })
      .find((s) => s.phaseNumber === 1);
    expect(row!.agentId).toBe('discovery-agent');
  });

  it('bug fase 7: gate pelo finalizer LOCAL — finalizeConversationPhase NAO e chamado', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(
      makeProject('bug', { pipelineCurrentPhase: 7 }) as never,
    );
    const engine = makeEngine();
    const sharedFinalize = vi.fn(async () => {});
    const sharedBackground = vi.fn();
    (engine as unknown as { finalizeConversationPhase: unknown }).finalizeConversationPhase = sharedFinalize;
    (engine as unknown as { runFinalizeInBackground: unknown }).runFinalizeInBackground = sharedBackground;
    primeState(engine, 'proj-1', { currentPhase: 7 });
    seedAccum(engine, 'proj-1', 7);
    capturedEvents.length = 0;

    await engine.approvePhase('proj-1');

    expect(sharedFinalize).not.toHaveBeenCalled();
    expect(sharedBackground).not.toHaveBeenCalled();
    const gate = phaseChangedEvents().find((e) => e['status'] === 'awaiting-dev-confirmation');
    expect(gate!['phase']).toBe(7);
    const row = vi.mocked(db.savePipelinePhaseMetrics).mock.calls
      .map((c) => c[0] as { phaseNumber: number; agentId?: string })
      .find((s) => s.phaseNumber === 7);
    expect(row!.agentId).toBe('sprint-validator');
  });

  it('os 5 tipos existentes NUNCA entram no finalizer do bug (delta ZERO)', async () => {
    for (const { type, gatePhase } of GATE_CASES.filter((c) => c.type !== 'bug')) {
      vi.clearAllMocks();
      vi.mocked(db.getHarnessProject).mockReturnValue(
        makeProject(type, { pipelineCurrentPhase: gatePhase }) as never,
      );
      const engine = makeEngine();
      const bugFinalize = vi.fn(async () => {});
      const bugBackground = vi.fn();
      (engine as unknown as { finalizeBugConversationPhase: unknown }).finalizeBugConversationPhase = bugFinalize;
      (engine as unknown as { runBugFinalizeInBackground: unknown }).runBugFinalizeInBackground = bugBackground;
      (engine as unknown as { advanceToNextPhase: unknown }).advanceToNextPhase = vi.fn(async () => {});
      primeState(engine, 'proj-1', { currentPhase: gatePhase });

      await engine.approvePhase('proj-1');

      expect(bugFinalize, type).not.toHaveBeenCalled();
      expect(bugBackground, type).not.toHaveBeenCalled();
    }
  });
});
