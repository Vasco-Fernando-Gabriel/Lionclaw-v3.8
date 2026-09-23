import { describe, it, expect, vi, beforeEach } from 'vitest';

interface CapturedCount {
  fn: string;
  args: unknown[];
}
const capturedCounts: CapturedCount[] = [];

interface CapturedSql {
  sql: string;
  args: unknown[];
}
const capturedUpdates: CapturedSql[] = [];

let countQueue: number[] = [];

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

const capturedEvents: Array<{ channel: string; data: unknown }> = [];

const fsState: { existsReturn: boolean; rmSyncCalls: string[] } = {
  existsReturn: true,
  rmSyncCalls: [],
};

const archState: { context: unknown } = { context: null };
const wipeState: { result: unknown; calls: string[] } = { result: { ok: true }, calls: [] };
const bugState: { context: unknown } = { context: null };

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      {
        isDestroyed: () => false,
        webContents: { send: (channel: string, data: unknown) => capturedEvents.push({ channel, data }) },
      },
    ]),
  },
  app: { on: vi.fn() },
}));

vi.mock('fs', () => {
  const existsSync = (): boolean => fsState.existsReturn;
  const rmSync = (p: string): void => {
    fsState.rmSyncCalls.push(p);
  };
  const readFileSync = (): string => '';
  const writeFileSync = (): void => {};
  return {
    default: { existsSync, rmSync, readFileSync, writeFileSync },
    existsSync,
    rmSync,
    readFileSync,
    writeFileSync,
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

function nextCount(fn: string, args: unknown[]): number {
  capturedCounts.push({ fn, args });
  return countQueue.shift() ?? 0;
}

vi.mock('../db', () => ({
  getHarnessProject: vi.fn(),
  getAgent: vi.fn(),
  getDb: vi.fn(() => ({
    prepare: (sql: string) => ({
      all: vi.fn(() => []),
      run: (...args: unknown[]) => {
        if (/UPDATE\s+harness_projects/i.test(sql)) {
          capturedUpdates.push({ sql: norm(sql), args });
        }
      },
      get: vi.fn(() => undefined),
    }),
  })),
  countPipelineMessagesFromPhase: (projectId: string, fromPhase: number) =>
    nextCount('countPipelineMessagesFromPhase', [projectId, fromPhase]),
  countPipelinePhaseMetricsFromPhase: (projectId: string, fromPhase: number) =>
    nextCount('countPipelinePhaseMetricsFromPhase', [projectId, fromPhase]),
  countPipelineMessagesForSprint: (projectId: string, sprintIndex: number) =>
    nextCount('countPipelineMessagesForSprint', [projectId, sprintIndex]),
  countPipelinePhaseMetricsForSprint: (projectId: string, sprintIndex: number) =>
    nextCount('countPipelinePhaseMetricsForSprint', [projectId, sprintIndex]),
  savePipelinePhaseMetrics: vi.fn(),
  savePipelineMessage: vi.fn(),
  getPipelinePhaseMessages: vi.fn().mockReturnValue([]),
  getPipelinePhaseMessagesAsChatHistory: vi.fn().mockReturnValue([]),
  getPipelineMetrics: vi.fn().mockReturnValue({ phases: [] }),
  getHarnessSprints: vi.fn().mockReturnValue([]),
  updateHarnessProject: vi.fn(),
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
    if (columns.pipelineCurrentPhase !== undefined) {
      fields.push('pipeline_current_phase = ?');
      values.push(columns.pipelineCurrentPhase);
    }
    if (columns.pipelineStartPhase !== undefined) {
      fields.push('pipeline_start_phase = ?');
      values.push(columns.pipelineStartPhase);
    }
    if (columns.discoveryNotesPath !== undefined) {
      fields.push('discovery_notes_path = ?');
      values.push(columns.discoveryNotesPath);
    }
    if (columns.prdPath !== undefined) {
      fields.push('prd_path = ?');
      values.push(columns.prdPath);
    }
    if (columns.status !== undefined) {
      fields.push('status = ?');
      values.push(columns.status);
    }
    if (columns.pipelineSprintIndex !== undefined) {
      fields.push('pipeline_sprint_index = ?');
      values.push(columns.pipelineSprintIndex);
    }
    if (columns.pipelineDiscoveryBlock !== undefined) {
      fields.push('pipeline_discovery_block = ?');
      values.push(columns.pipelineDiscoveryBlock);
    }
    if (fields.length > 0) {
      fields.push(`updated_at = datetime('now')`);
      values.push(projectId);
      capturedUpdates.push({
        sql: norm(`UPDATE harness_projects SET ${fields.join(', ')} WHERE id = ?`),
        args: values,
      });
    }
  },
  updateHarnessSprint: vi.fn(),
  insertHarnessRound: vi.fn(),
  updateHarnessRound: vi.fn(),
  deletePipelineMessagesFromPhase: vi.fn(),
  deletePipelinePhaseMetricsFromPhase: vi.fn(),
  deletePipelineMessagesForSprint: vi.fn(),
  deletePipelinePhaseMetricsForSprint: vi.fn(),
  deleteHarnessRoundsForSprint: vi.fn(),
  carryHarnessRoundSessionIdsForSprint: vi.fn(),
  resetHarnessSprintStatus: vi.fn(),
  deleteHarnessSprintsForProject: vi.fn(),
  getHarnessSprintByIndex: vi.fn(),
  patchSecuritySummaryJson: vi.fn(),
  getSecuritySummaryJson: vi.fn(),
  getSecurityAgentStatuses: vi.fn().mockReturnValue([]),
  setProjectStatus: vi.fn(),
  deleteBugAnalysisAgentStatuses: vi.fn(),
}));
vi.mock('../agent-runtime', () => ({ executeAgent: vi.fn() }));
vi.mock('../harness-engine', () => {
  const HarnessEngine = vi.fn();
  HarnessEngine.prototype.abort = vi.fn();
  HarnessEngine.prototype.runSingleSprint = vi.fn();
  return { HarnessEngine };
});
vi.mock('../security-audit-runner', () => ({ SecurityAuditRunner: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../repo-profiler', () => ({ runRepoProfiler: vi.fn() }));
vi.mock('../security-findings-parser', () => ({ parseSecurityFindings: vi.fn() }));
vi.mock('../pipeline-paths', () => ({
  generatePipelineDocsId: vi.fn(() => 'NEW-DOCS-ID'),
  getPipelineDocsContext: vi.fn(() => null),
  migrateLegacyDocsToFolder: vi.fn(),
  findConsolidatedSecurityReport: vi.fn(),
}));
vi.mock('../pipeline-report', () => ({ generatePipelineReport: vi.fn(), exportPipelineReport: vi.fn() }));
vi.mock('../pipeline-metrics-report', () => ({}));
vi.mock('../architecture-review-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../architecture-review-paths')>();
  return { ...actual, getArchitectureReviewContext: () => archState.context };
});
vi.mock('../open-design/full-wipe', () => ({
  wipeOpenDesign: async (projectId: string) => {
    wipeState.calls.push(projectId);
    return wipeState.result;
  },
}));
vi.mock('../bug-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bug-paths')>();
  return { ...actual, getBugContext: () => bugState.context };
});

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
  pipelineCurrentPhase: number;
  status: string;
  specPath?: string | null;
  config?: Record<string, unknown>;
}

function makeProject(type: string, overrides: Partial<ProjectLike> = {}): ProjectLike {
  return {
    id: 'proj-1',
    name: 'Reset Test',
    projectPath: '/tmp/project',
    pipelineType: type,
    pipelineDocsId: 'OLD-DOCS-ID',
    pipelineCurrentPhase: 1,
    status: 'running',
    specPath: '/tmp/project/SPEC.md',
    config: {},
    ...overrides,
  };
}

function bugContext() {
  const runDir = '/tmp/project/.lionclaw/pipelines/bug/RUNBUG';
  return {
    runId: 'RUNBUG',
    runDir,
    manifestPath: `${runDir}/manifest.json`,
    diagnosticoPath: `${runDir}/diagnostico-RUNBUG.md`,
    analise01Path: `${runDir}/analise-01-root-cause-RUNBUG.md`,
    analise02Path: `${runDir}/analise-02-historian-RUNBUG.md`,
    analise03Path: `${runDir}/analise-03-refuter-RUNBUG.md`,
    planoPath: `${runDir}/plano-de-correcao-RUNBUG.md`,
    specPath: `${runDir}/SPEC-RUNBUG.md`,
    sprintsPath: `${runDir}/sprints-RUNBUG.json`,
  };
}

function bugExpectedFiles(phase: number): string[] {
  const c = bugContext();
  switch (phase) {
    case 1:
      return [c.runDir];
    case 2:
      return [c.analise01Path, c.analise02Path, c.analise03Path, c.planoPath, c.specPath, c.sprintsPath];
    case 3:
      return [c.planoPath, c.specPath, c.sprintsPath];
    case 4:
      return [c.specPath, c.sprintsPath];
    case 6:
      return [c.sprintsPath];
    case 7:
      return [];
    default:
      throw new Error(`fase ${phase} nao e resetavel no Bug Pipe`);
  }
}

function archContext() {
  return {
    runId: 'RUN1',
    runDir: '/tmp/project/.lionclaw/pipelines/architecture-review/RUN1',
    candidatesMdPath: '/tmp/project/.lionclaw/pipelines/architecture-review/RUN1/ArchitectureCandidates-RUN1.md',
    candidatesJsonPath: '/tmp/project/.lionclaw/pipelines/architecture-review/RUN1/ArchitectureCandidates-RUN1.json',
    diagnosisMdPath: '/tmp/project/.lionclaw/pipelines/architecture-review/RUN1/ArchitectureDiagnosis-RUN1.md',
    diagnosisJsonPath: '/tmp/project/.lionclaw/pipelines/architecture-review/RUN1/ArchitectureDiagnosis-RUN1.json',
    decisionsMdPath: '/tmp/project/.lionclaw/pipelines/architecture-review/RUN1/ArchitectureDecisions-RUN1.md',
    decisionsJsonPath: '/tmp/project/.lionclaw/pipelines/architecture-review/RUN1/ArchitectureDecisions-RUN1.json',
    specPath: '/tmp/project/.lionclaw/pipelines/architecture-review/RUN1/SPEC-RUN1.md',
    specSourcePath: '/tmp/project/.lionclaw/pipelines/architecture-review/RUN1/SPEC-RUN1.source.md',
    sprintsPath: '/tmp/project/.lionclaw/pipelines/architecture-review/RUN1/sprints-RUN1.json',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedCounts.length = 0;
  capturedUpdates.length = 0;
  fsState.rmSyncCalls.length = 0;
  fsState.existsReturn = true;
  countQueue = [];
  capturedEvents.length = 0;
  archState.context = null;
  bugState.context = null;
  wipeState.result = { ok: true };
  wipeState.calls.length = 0;
});

describe('getResetPreview — phase branch (RP-1 query shape + filesToDelete golden)', () => {
  it('dev legacy phase 1: joins artifact files to projectPath; both COUNTs filter phase_number >= fromPhase', () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('development') as never);
    vi.mocked(db.getHarnessSprints).mockReturnValue([{ sprintIndex: 0 }, { sprintIndex: 1 }] as never);
    const engine = makeEngine();
    countQueue = [7, 3];

    const preview = engine.getResetPreview('proj-1', { phase: 1 });

    expect(preview.filesToDelete).toEqual([
      '/tmp/project/discovery-notes.md',
      '/tmp/project/stories-requisitos.md',
      '/tmp/project/PRD.md',
      '/tmp/project/SPEC.md',
    ]);
    expect(preview.messagesToDelete).toBe(7);
    expect(preview.metricsToDelete).toBe(3);
    expect(preview.sprintsAffected).toEqual([0, 1]);

    expect(capturedCounts).toEqual([
      { fn: 'countPipelineMessagesFromPhase', args: ['proj-1', 1] },
      { fn: 'countPipelinePhaseMetricsFromPhase', args: ['proj-1', 1] },
    ]);
  });

  it('feature phase 9: filesToDelete=[SPEC.md], fromPhase=9, wipeSprints=true', () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('feature') as never);
    vi.mocked(db.getHarnessSprints).mockReturnValue([{ sprintIndex: 0 }] as never);
    const engine = makeEngine();
    countQueue = [4, 2];

    const preview = engine.getResetPreview('proj-1', { phase: 9 });

    expect(preview.filesToDelete).toEqual(['/tmp/project/SPEC.md']);
    expect(preview.messagesToDelete).toBe(4);
    expect(preview.metricsToDelete).toBe(2);
    expect(preview.sprintsAffected).toEqual([0]);
    expect(capturedCounts[0].args).toEqual(['proj-1', 9]);
    expect(capturedCounts[1].args).toEqual(['proj-1', 9]);
  });

  it('security phase 1: only .lionclaw/manifest.json joined; wipeSprints=true', () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('security') as never);
    vi.mocked(db.getHarnessSprints).mockReturnValue([] as never);
    const engine = makeEngine();
    countQueue = [0, 0];

    const preview = engine.getResetPreview('proj-1', { phase: 1 });

    expect(preview.filesToDelete).toEqual(['/tmp/project/.lionclaw/manifest.json']);
    expect(preview.sprintsAffected).toEqual([]);
    expect(capturedCounts[0].args).toEqual(['proj-1', 1]);
  });

  it('SPRINT 6b (RK-11, DELIBERATE FIX): architecture-review phase 2 reports the REAL run-dir stem paths — preview === resetPhase deletion plan', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('architecture-review') as never);
    vi.mocked(db.getHarnessSprints).mockReturnValue([{ sprintIndex: 0 }] as never);
    archState.context = archContext();
    fsState.existsReturn = true;
    const engine = makeEngine();
    countQueue = [11, 5];

    const preview = engine.getResetPreview('proj-1', { phase: 2 });

    const c = archContext();
    const expectedFiles = [
      c.candidatesMdPath,
      c.candidatesJsonPath,
      c.diagnosisMdPath,
      c.diagnosisJsonPath,
      c.decisionsMdPath,
      c.decisionsJsonPath,
      c.specPath,
      c.specSourcePath,
      c.sprintsPath,
    ];
    expect(preview.filesToDelete).toEqual(expectedFiles);
    expect(preview.messagesToDelete).toBe(11);
    expect(preview.metricsToDelete).toBe(5);
    expect(preview.sprintsAffected).toEqual([0]);

    fsState.rmSyncCalls.length = 0;
    vi.spyOn(
      engine as unknown as { runAutoPhase: (...a: unknown[]) => Promise<void> },
      'runAutoPhase',
    ).mockResolvedValue(undefined);
    await engine.resetPhase('proj-1', 2);
    expect(fsState.rmSyncCalls).toEqual(preview.filesToDelete);
  });

  it('SPRINT 6b (RK-11, DELIBERATE FIX): architecture-review phase 1 ("*" map) reports the whole runDir — preview === resetPhase deletion plan', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('architecture-review') as never);
    vi.mocked(db.getHarnessSprints).mockReturnValue([] as never);
    archState.context = archContext();
    fsState.existsReturn = true;
    const engine = makeEngine();
    countQueue = [0, 0];

    const preview = engine.getResetPreview('proj-1', { phase: 1 });

    const c = archContext();
    expect(preview.filesToDelete).toEqual([c.runDir]);

    fsState.rmSyncCalls.length = 0;
    vi.spyOn(
      engine as unknown as { runAutoPhase: (...a: unknown[]) => Promise<void> },
      'runAutoPhase',
    ).mockResolvedValue(undefined);
    await engine.resetPhase('proj-1', 1);
    expect(fsState.rmSyncCalls).toEqual(preview.filesToDelete);
  });

  it('dev-v2 phase 12: empty artifact files -> filesToDelete=[]; fromPhase=12, wipeSprints=true', () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('development-v2') as never);
    vi.mocked(db.getHarnessSprints).mockReturnValue([{ sprintIndex: 0 }] as never);
    const engine = makeEngine();
    countQueue = [9, 6];

    const preview = engine.getResetPreview('proj-1', { phase: 12 });

    expect(preview.filesToDelete).toEqual([]);
    expect(preview.messagesToDelete).toBe(9);
    expect(preview.metricsToDelete).toBe(6);
    expect(preview.sprintsAffected).toEqual([0]);
    expect(capturedCounts[0].args).toEqual(['proj-1', 12]);
    expect(capturedCounts[1].args).toEqual(['proj-1', 12]);
  });

  it('unknown phase (no artifact map) returns the empty preview and runs NO COUNT', () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('development') as never);
    const engine = makeEngine();
    countQueue = [99, 99];

    const preview = engine.getResetPreview('proj-1', { phase: 7 });

    expect(preview).toEqual({
      filesToDelete: [],
      messagesToDelete: 0,
      metricsToDelete: 0,
      sprintsAffected: [],
    });
    expect(capturedCounts).toEqual([]);
  });
});

describe('getResetPreview — sprint branch (RP-1 contract for countPipeline*ForSprint)', () => {
  it('sprintIndex=2: filesToDelete=[], counts go through the ForSprint helpers with sprint_index=2', () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('development') as never);
    const engine = makeEngine();
    countQueue = [5, 2];

    const preview = engine.getResetPreview('proj-1', { sprintIndex: 2 });

    expect(preview.filesToDelete).toEqual([]);
    expect(preview.messagesToDelete).toBe(5);
    expect(preview.metricsToDelete).toBe(2);
    expect(preview.sprintsAffected).toEqual([2]);

    expect(capturedCounts).toEqual([
      { fn: 'countPipelineMessagesForSprint', args: ['proj-1', 2] },
      { fn: 'countPipelinePhaseMetricsForSprint', args: ['proj-1', 2] },
    ]);
  });

  it('missing project returns the empty preview', () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(undefined as never);
    const engine = makeEngine();
    countQueue = [1, 1];

    const preview = engine.getResetPreview('proj-1', { phase: 1 });

    expect(preview).toEqual({
      filesToDelete: [],
      messagesToDelete: 0,
      metricsToDelete: 0,
      sprintsAffected: [],
    });
    expect(capturedCounts).toEqual([]);
  });
});

describe('resetPhase — deletion plan (executor side effects)', () => {
  it('dev legacy phase 1: rmSync each artifact (projectPath-relative); deletes from phase 1; wipes sprints; rotates docs only for feature/security (NOT dev)', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('development') as never);
    const engine = makeEngine();
    const runAuto = vi
      .spyOn(engine as unknown as { runAutoPhase: (...a: unknown[]) => Promise<void> }, 'runAutoPhase')
      .mockResolvedValue(undefined);

    const res = await engine.resetPhase('proj-1', 1);

    expect(res).toEqual({ ok: true });
    expect(fsState.rmSyncCalls).toEqual([
      '/tmp/project/discovery-notes.md',
      '/tmp/project/stories-requisitos.md',
      '/tmp/project/PRD.md',
      '/tmp/project/SPEC.md',
    ]);
    expect(db.deletePipelineMessagesFromPhase).toHaveBeenCalledWith('proj-1', 1);
    expect(db.deletePipelinePhaseMetricsFromPhase).toHaveBeenCalledWith('proj-1', 1);
    expect(db.deleteHarnessSprintsForProject).toHaveBeenCalledWith('proj-1');
    expect(db.updateHarnessProject).not.toHaveBeenCalled();
    expect(capturedUpdates).toEqual([
      {
        sql: "UPDATE harness_projects SET pipeline_current_phase = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
        args: [1, 'idle', 'proj-1'],
      },
    ]);
    expect(capturedEvents.filter((e) => e.channel === 'pipeline:reset-complete')).toEqual([
      { channel: 'pipeline:reset-complete', data: { projectId: 'proj-1', phase: 1 } },
    ]);
    expect(runAuto).not.toHaveBeenCalled();
  });

  it('feature phase 1: rotates pipelineDocsId (feature/security only) and clears spec/prd/sprints paths', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('feature') as never);
    const engine = makeEngine();
    vi.spyOn(
      engine as unknown as { runAutoPhase: (...a: unknown[]) => Promise<void> },
      'runAutoPhase',
    ).mockResolvedValue(undefined);

    await engine.resetPhase('proj-1', 1);

    expect(db.updateHarnessProject).toHaveBeenCalledWith('proj-1', {
      pipelineDocsId: 'NEW-DOCS-ID',
      specPath: null,
      prdPath: null,
      sprintsJsonPath: null,
    });
    expect(db.deleteHarnessSprintsForProject).toHaveBeenCalledWith('proj-1');
  });

  it('feature phase 9 (Spec Generation, type:auto): deletes from phase 9, wipes sprints, AND kicks the background auto-phase (R-1: 9 is in getAutoPhases for feature)', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('feature') as never);
    const engine = makeEngine();
    const runAuto = vi
      .spyOn(engine as unknown as { runAutoPhase: (...a: unknown[]) => Promise<void> }, 'runAutoPhase')
      .mockResolvedValue(undefined);

    const res = await engine.resetPhase('proj-1', 9);

    expect(res).toEqual({ ok: true });
    expect(fsState.rmSyncCalls).toEqual(['/tmp/project/SPEC.md']);
    expect(db.deletePipelineMessagesFromPhase).toHaveBeenCalledWith('proj-1', 9);
    expect(db.deleteHarnessSprintsForProject).toHaveBeenCalledWith('proj-1');
    expect(runAuto).toHaveBeenCalledWith('proj-1', 9);
  });

  it('architecture-review phase 1 ("*" map): nukes the entire runDir and clears arch config (runId omitted)', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('architecture-review') as never);
    archState.context = archContext();
    const engine = makeEngine();
    vi.spyOn(
      engine as unknown as { runAutoPhase: (...a: unknown[]) => Promise<void> },
      'runAutoPhase',
    ).mockResolvedValue(undefined);

    const res = await engine.resetPhase('proj-1', 1);

    expect(res).toEqual({ ok: true });
    expect(fsState.rmSyncCalls).toEqual(['/tmp/project/.lionclaw/pipelines/architecture-review/RUN1']);
    expect(db.updateHarnessProject).toHaveBeenCalledWith('proj-1', {
      specPath: '',
      sprintsJsonPath: null,
      config: {
        architectureReview: {
          selectedCandidateId: null,
        },
      },
    });
    expect(db.deletePipelineMessagesFromPhase).toHaveBeenCalledWith('proj-1', 1);
  });

  it('architecture-review phase 2 (stem map): rmSync each resolved stem path under runDir; clears spec_path because SPEC stem present', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('architecture-review') as never);
    archState.context = archContext();
    const engine = makeEngine();
    vi.spyOn(
      engine as unknown as { runAutoPhase: (...a: unknown[]) => Promise<void> },
      'runAutoPhase',
    ).mockResolvedValue(undefined);

    await engine.resetPhase('proj-1', 2);

    const c = archContext();
    expect(fsState.rmSyncCalls).toEqual([
      c.candidatesMdPath,
      c.candidatesJsonPath,
      c.diagnosisMdPath,
      c.diagnosisJsonPath,
      c.decisionsMdPath,
      c.decisionsJsonPath,
      c.specPath,
      c.specSourcePath,
      c.sprintsPath,
    ]);
    expect(db.updateHarnessProject).toHaveBeenCalledWith('proj-1', { specPath: '' });
    expect(db.deletePipelineMessagesFromPhase).toHaveBeenCalledWith('proj-1', 2);
  });

  it('dev-v2 phase 5 (Open Design Studio): runs wipeOpenDesign BEFORE the DB delete; deletes from phase 5; wipes sprints', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('development-v2') as never);
    const engine = makeEngine();
    const runAuto = vi
      .spyOn(engine as unknown as { runAutoPhase: (...a: unknown[]) => Promise<void> }, 'runAutoPhase')
      .mockResolvedValue(undefined);

    const res = await engine.resetPhase('proj-1', 5);

    expect(res).toEqual({ ok: true });
    expect(wipeState.calls).toEqual(['proj-1']);
    expect(db.deletePipelineMessagesFromPhase).toHaveBeenCalledWith('proj-1', 5);
    expect(db.deletePipelinePhaseMetricsFromPhase).toHaveBeenCalledWith('proj-1', 5);
    expect(db.deleteHarnessSprintsForProject).toHaveBeenCalledWith('proj-1');
    expect(runAuto).not.toHaveBeenCalled();
  });

  it('non-resetable phase returns an error and performs NO deletion', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('development') as never);
    const engine = makeEngine();

    const res = await engine.resetPhase('proj-1', 5);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not resetable/i);
    expect(fsState.rmSyncCalls).toEqual([]);
    expect(db.deletePipelineMessagesFromPhase).not.toHaveBeenCalled();
  });

  it('missing project returns an error', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(undefined as never);
    const engine = makeEngine();

    const res = await engine.resetPhase('proj-1', 1);

    expect(res).toEqual({ ok: false, error: 'Project not found' });
  });
});

describe('resetSprint — deletion plan', () => {
  it('deletes rounds/messages/metrics for the sprint, resets status, emits sprint-reset, kicks the next pending sprint', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('development') as never);
    vi.mocked(db.getHarnessSprintByIndex).mockReturnValue({ sprintIndex: 1, status: 'done' } as never);
    vi.mocked(db.getHarnessSprints).mockReturnValue([{ sprintIndex: 1, status: 'pending' }] as never);
    const engine = makeEngine();
    const runSprint = vi
      .spyOn(engine as unknown as { runSprint: (...a: unknown[]) => Promise<void> }, 'runSprint')
      .mockResolvedValue(undefined);

    const res = await engine.resetSprint('proj-1', 1);

    expect(res).toEqual({ ok: true });
    expect(db.deleteHarnessRoundsForSprint).toHaveBeenCalledWith('proj-1', 1);
    expect(db.deletePipelineMessagesForSprint).toHaveBeenCalledWith('proj-1', 1);
    expect(db.deletePipelinePhaseMetricsForSprint).toHaveBeenCalledWith('proj-1', 1);
    expect(db.resetHarnessSprintStatus).toHaveBeenCalledWith('proj-1', 1);
    expect(capturedEvents.filter((e) => e.channel === 'pipeline:sprint-reset')).toEqual([
      { channel: 'pipeline:sprint-reset', data: { projectId: 'proj-1', sprintIndex: 1 } },
    ]);
    expect(runSprint).toHaveBeenCalledWith('proj-1', 1);
  });

  it('missing sprint returns an error and performs NO deletion', async () => {
    vi.mocked(db.getHarnessSprintByIndex).mockReturnValue(undefined as never);
    const engine = makeEngine();

    const res = await engine.resetSprint('proj-1', 9);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
    expect(db.deleteHarnessRoundsForSprint).not.toHaveBeenCalled();
  });

  it('carries harness_rounds session ids into phase metrics BEFORE deleting rounds/metrics', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('development') as never);
    vi.mocked(db.getHarnessSprintByIndex).mockReturnValue({ sprintIndex: 1, status: 'done' } as never);
    vi.mocked(db.getHarnessSprints).mockReturnValue([{ sprintIndex: 1, status: 'pending' }] as never);
    const engine = makeEngine();
    vi.spyOn(engine as unknown as { runSprint: (...a: unknown[]) => Promise<void> }, 'runSprint').mockResolvedValue(
      undefined,
    );

    const res = await engine.resetSprint('proj-1', 1);

    expect(res).toEqual({ ok: true });
    expect(db.carryHarnessRoundSessionIdsForSprint).toHaveBeenCalledWith('proj-1', 1, 13, 14);
    const carryOrder = vi.mocked(db.carryHarnessRoundSessionIdsForSprint).mock.invocationCallOrder[0]!;
    const roundsDeleteOrder = vi.mocked(db.deleteHarnessRoundsForSprint).mock.invocationCallOrder[0]!;
    const metricsDeleteOrder = vi.mocked(db.deletePipelinePhaseMetricsForSprint).mock.invocationCallOrder[0]!;
    expect(carryOrder).toBeLessThan(roundsDeleteOrder);
    expect(carryOrder).toBeLessThan(metricsDeleteOrder);
  });
});

describe('Bug Pipe — TB-23: preview === executor nas 6 fases resetaveis', () => {
  const RESETABLE = [1, 2, 3, 4, 6, 7] as const;

  it.each(RESETABLE)('fase %i: o preview lista exatamente os paths que o executor apaga', async (phase) => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('bug') as never);
    vi.mocked(db.getHarnessSprints).mockReturnValue([{ sprintIndex: 0 }] as never);
    bugState.context = bugContext();
    fsState.existsReturn = true;
    const engine = makeEngine();
    countQueue = [7, 4];

    const preview = engine.getResetPreview('proj-1', { phase });

    expect(preview.filesToDelete).toEqual(bugExpectedFiles(phase));

    fsState.rmSyncCalls.length = 0;
    vi.spyOn(
      engine as unknown as { runAutoPhase: (...a: unknown[]) => Promise<void> },
      'runAutoPhase',
    ).mockResolvedValue(undefined);
    await engine.resetPhase('proj-1', phase);
    expect(fsState.rmSyncCalls).toEqual(preview.filesToDelete);
  });

  it('sem BugContext o preview e o executor concordam em NADA (nao inventam paths do projectPath)', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('bug') as never);
    vi.mocked(db.getHarnessSprints).mockReturnValue([] as never);
    bugState.context = null;
    const engine = makeEngine();
    countQueue = [0, 0];

    const preview = engine.getResetPreview('proj-1', { phase: 2 });
    expect(preview.filesToDelete).toEqual([]);

    vi.spyOn(
      engine as unknown as { runAutoPhase: (...a: unknown[]) => Promise<void> },
      'runAutoPhase',
    ).mockResolvedValue(undefined);
    await engine.resetPhase('proj-1', 2);
    expect(fsState.rmSyncCalls).toEqual([]);
  });
});

describe('Bug Pipe — TB-23 (executor): DB, config e status dos 3 analistas', () => {
  async function reset(phase: number): Promise<void> {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('bug') as never);
    bugState.context = bugContext();
    const engine = makeEngine();
    vi.spyOn(
      engine as unknown as { runAutoPhase: (...a: unknown[]) => Promise<void> },
      'runAutoPhase',
    ).mockResolvedValue(undefined);
    await engine.resetPhase('proj-1', phase);
  }

  it('fase 1 ("*"): nuke do runDir + config.bug limpo OMITINDO runId + specPath e sprintsJsonPath zerados (B-AC27 / TB-33b (c))', async () => {
    await reset(1);

    expect(fsState.rmSyncCalls).toEqual(['/tmp/project/.lionclaw/pipelines/bug/RUNBUG']);
    expect(db.updateHarnessProject).toHaveBeenCalledWith('proj-1', {
      specPath: '',
      sprintsJsonPath: null,
      config: {
        bug: {
          outcome: 'pending',
        },
      },
    });
    const configArg = vi.mocked(db.updateHarnessProject).mock.calls[0]![1] as {
      config: { bug: Record<string, unknown> };
    };
    expect('runId' in configArg.config.bug).toBe(false);
    expect(db.deletePipelineMessagesFromPhase).toHaveBeenCalledWith('proj-1', 1);
    expect(db.deleteHarnessSprintsForProject).toHaveBeenCalledWith('proj-1');
  });

  it.each([2, 3, 4])('fase %i (stem SPEC presente): limpa specPath no DB (espelho de reset.ts:228)', async (phase) => {
    await reset(phase);
    expect(db.updateHarnessProject).toHaveBeenCalledWith('proj-1', { specPath: '' });
  });

  it.each([6, 7])('fase %i (sem stem SPEC): NAO mexe em specPath', async (phase) => {
    await reset(phase);
    expect(db.updateHarnessProject).not.toHaveBeenCalledWith('proj-1', { specPath: '' });
  });

  it('deleteBugAnalysisAgentStatuses roda nas fases 1 E 2, e SO nelas', async () => {
    for (const phase of [1, 2]) {
      vi.clearAllMocks();
      await reset(phase);
      expect(db.deleteBugAnalysisAgentStatuses, `fase ${phase}`).toHaveBeenCalledWith('proj-1');
    }
    for (const phase of [3, 4, 6, 7]) {
      vi.clearAllMocks();
      await reset(phase);
      expect(db.deleteBugAnalysisAgentStatuses, `fase ${phase}`).not.toHaveBeenCalled();
    }
  });

  it('fase 5 do bug NAO e resetavel (SPEC secao 4.1)', async () => {
    vi.mocked(db.getHarnessProject).mockReturnValue(makeProject('bug') as never);
    bugState.context = bugContext();
    const engine = makeEngine();

    const res = await engine.resetPhase('proj-1', 5);

    expect(res).toEqual({ ok: false, error: 'Phase 5 is not resetable' });
    expect(fsState.rmSyncCalls).toEqual([]);
    expect(db.deleteBugAnalysisAgentStatuses).not.toHaveBeenCalled();
  });
});
