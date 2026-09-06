
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const capturedEvents: Array<{ channel: string; data: unknown }> = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{
      isDestroyed: () => false,
      webContents: { send: (channel: string, data: unknown) => capturedEvents.push({ channel, data }) },
    }]),
  },
  app: { on: vi.fn() },
}));

const fsState = {
  validationReportContent: '',
  specContent: 'SPEC body',
};
function fsReadFileSync(p: string): string {
  if (typeof p === 'string' && p.includes('spec-validation')) return fsState.validationReportContent;
  return fsState.specContent;
}
vi.mock('fs', () => ({
  default: { existsSync: vi.fn().mockReturnValue(true), readFileSync: vi.fn((p: string) => fsReadFileSync(p)), writeFileSync: vi.fn() },
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn((p: string) => fsReadFileSync(p)),
  writeFileSync: vi.fn(),
}));
vi.mock('path', () => ({ default: { join: (...args: string[]) => args.join('/') }, join: (...args: string[]) => args.join('/') }));
vi.mock('os', () => ({ default: { homedir: () => '/home/user', tmpdir: () => '/tmp' }, homedir: () => '/home/user', tmpdir: () => '/tmp' }));

vi.mock('../db', () => ({
  getHarnessProject: vi.fn(),
  getAgent: vi.fn(),
  getDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: vi.fn(() => []), run: vi.fn(), get: vi.fn() })) })),
  savePipelinePhaseMetrics: vi.fn(),
  savePipelineMessage: vi.fn(),
  getPipelinePhaseMessages: vi.fn().mockReturnValue([]),
  getPipelinePhaseMessagesAsChatHistory: vi.fn().mockReturnValue([]),
  getPipelineMetrics: vi.fn().mockReturnValue({ phases: [] }),
  getHarnessSprints: vi.fn().mockReturnValue([]),
  updateHarnessProject: vi.fn(),
  updateHarnessSprint: vi.fn(),
  insertHarnessRound: vi.fn(),
  updateHarnessRound: vi.fn(),
  deletePipelineMessagesFromPhase: vi.fn(),
  deletePipelinePhaseMetricsFromPhase: vi.fn(),
  deletePipelineMessagesForSprint: vi.fn(),
  deletePipelinePhaseMetricsForSprint: vi.fn(),
  deleteHarnessRoundsForSprint: vi.fn(),
  resetHarnessSprintStatus: vi.fn(),
  deleteHarnessSprintsForProject: vi.fn(),
  getHarnessSprintByIndex: vi.fn(),
  patchSecuritySummaryJson: vi.fn(),
  getSecuritySummaryJson: vi.fn(),
  getSecurityAgentStatuses: vi.fn().mockReturnValue([]),
  setProjectStatus: vi.fn(),
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
  generatePipelineDocsId: vi.fn(() => 'docs-id'),
  getPipelineDocsContext: vi.fn(() => null),
  migrateLegacyDocsToFolder: vi.fn(),
  findConsolidatedSecurityReport: vi.fn(),
}));
vi.mock('../pipeline-report', () => ({ generatePipelineReport: vi.fn(), exportPipelineReport: vi.fn() }));
vi.mock('../pipeline-metrics-report', () => ({}));

import { PipelineEngine } from '../pipeline-engine';
import { HarnessEngine } from '../harness-engine';
import { getHarnessProject } from '../db';
import { PIPE2_SPEC_BUILDER_ID } from '../seed-agents/pipe2-spec-builder';
import { PIPE2_SPEC_VALIDATOR_ID } from '../seed-agents/pipe2-spec-validator';

interface SpawnCall {
  agentId: string;
  prompt: string;
}
interface PhaseStateLike {
  projectId: string;
  currentPhase: number;
  status: string;
  abortController: AbortController;
  discoveryBlock: number;
  continueSessions: Map<string, { alive: boolean }>;
  codexSessions: Map<string, unknown>;
  phaseMetricAccum: Map<number, unknown>;
  currentSprintIndex: number;
}


function makeEngine() {
  const harnessInstance = new HarnessEngine({} as never);
  return new PipelineEngine(() => null, harnessInstance as never);
}

function makeSpawnResult() {
  return {
    output: 'ok',
    metrics: {
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0,
      toolUses: 0, apiRequests: 1, costUsd: 0.0001, durationMs: 10,
    },
    model: 'claude-sonnet-4-6',
    runtime: 'cloud' as const,
    provider: 'anthropic',
  };
}

function makeLockedDevV2Project(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-12',
    name: 'Gate Test Project',
    projectPath: '/tmp/project',
    pipelineType: 'development-v2',
    pipelineDocsId: null,
    pipelineCurrentPhase: 12,
    status: 'running',
    specPath: '/tmp/project/SPEC.md',
    config: {
      openDesign: {
        locked: true,
        snapshotDir: '/tmp/project/.od/snapshots/latest',
        contractPath: '/tmp/project/.od/snapshots/latest/design-contract.json',
        briefPath: '/tmp/project/.od/snapshots/latest/design-brief.md',
        lockReportPath: '/tmp/project/.od/snapshots/latest/design-lock-report.md',
        artifactHtmlPath: '/tmp/project/.od/snapshots/latest/artifact/index.html',
        manifestPath: '/tmp/project/.od/snapshots/latest/manifest.json',
        openDesignProjectId: 'od-proj-1',
        conversationId: 'conv-1',
      },
    },
    ...overrides,
  };
}

function spySpawnAgent(engine: PipelineEngine, calls: SpawnCall[]): Mock {
  const spy = vi.fn(async (agentId: string, prompt: string) => {
    calls.push({ agentId, prompt });
    return makeSpawnResult();
  });
  (engine as unknown as { spawnAgent: Mock }).spawnAgent = spy as unknown as Mock;
  return spy;
}

function getState(engine: PipelineEngine, projectId: string): PhaseStateLike {
  return (engine as unknown as { getState: (id: string) => PhaseStateLike }).getState(projectId);
}

function findPhaseChanged(status: string): Array<Record<string, unknown>> {
  return capturedEvents
    .filter((e) => e.channel === 'pipeline:phase-changed')
    .map((e) => e.data as Record<string, unknown>)
    .filter((d) => d['status'] === status);
}


describe('SPEC-007 phase 12: runDevV2Phase12SpecGeneration (auto loop)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEvents.length = 0;
    fsState.validationReportContent = '';
    fsState.specContent = 'SPEC body';
  });

  it('4. calls pipe2-spec-builder then pipe2-spec-validator in round 1 (PASS)', async () => {
    fsState.validationReportContent = '# Validation\n\n## Status: PASS\n';
    (getHarnessProject as Mock).mockReturnValue(makeLockedDevV2Project());

    const engine = makeEngine();
    const calls: SpawnCall[] = [];
    spySpawnAgent(engine, calls);
    const state = getState(engine, 'proj-12');

    await (engine as unknown as {
      runDevV2Phase12SpecGeneration: (id: string, p: unknown, s: unknown) => Promise<void>;
    }).runDevV2Phase12SpecGeneration('proj-12', makeLockedDevV2Project(), state);

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].agentId).toBe(PIPE2_SPEC_BUILDER_ID);
    expect(calls[1].agentId).toBe(PIPE2_SPEC_VALIDATOR_ID);
    expect(calls.some((c) => c.agentId === 'spec-validator')).toBe(false);
  });

  it('5. the loop validatorPrompt includes the design-lock block (PRD + design contract), not just PRD+stories', async () => {
    fsState.validationReportContent = '# Validation\n\n## Status: PASS\n';
    (getHarnessProject as Mock).mockReturnValue(makeLockedDevV2Project());

    const engine = makeEngine();
    const calls: SpawnCall[] = [];
    spySpawnAgent(engine, calls);
    const state = getState(engine, 'proj-12');

    await (engine as unknown as {
      runDevV2Phase12SpecGeneration: (id: string, p: unknown, s: unknown) => Promise<void>;
    }).runDevV2Phase12SpecGeneration('proj-12', makeLockedDevV2Project(), state);

    const validatorCall = calls.find((c) => c.agentId === PIPE2_SPEC_VALIDATOR_ID);
    expect(validatorCall).toBeDefined();
    expect(validatorCall!.prompt).toContain('Inputs explicitos do design lock');
    expect(validatorCall!.prompt).toContain('Design Contract');
    expect(validatorCall!.prompt).toContain('design-contract.json');
    expect(validatorCall!.prompt).toContain('PRD');
    expect(validatorCall!.prompt).toContain('stories-requisitos.md');

    const builderCall = calls.find((c) => c.agentId === PIPE2_SPEC_BUILDER_ID);
    expect(builderCall!.prompt).toContain('Inputs explicitos do design lock');
  });

  it('6. on FAIL, round 2 builder receives the spec-validation.md content', async () => {
    fsState.validationReportContent =
      '# Validation\n\n## Status: FAIL\n\n[MISS] tela de login ausente na SPEC\n';
    (getHarnessProject as Mock).mockReturnValue(makeLockedDevV2Project());

    const engine = makeEngine();
    const calls: SpawnCall[] = [];
    spySpawnAgent(engine, calls);
    const state = getState(engine, 'proj-12');

    await (engine as unknown as {
      runDevV2Phase12SpecGeneration: (id: string, p: unknown, s: unknown) => Promise<void>;
    }).runDevV2Phase12SpecGeneration('proj-12', makeLockedDevV2Project(), state);

    const builderCalls = calls.filter((c) => c.agentId === PIPE2_SPEC_BUILDER_ID);
    expect(builderCalls.length).toBeGreaterThanOrEqual(2);

    const round2Builder = builderCalls[1];
    expect(round2Builder.prompt).toContain('[MISS] tela de login ausente na SPEC');
    expect(round2Builder.prompt).toContain('## Status: FAIL');
  });

  it('7. on PASS in round 1, the loop stops (single builder + single validator)', async () => {
    fsState.validationReportContent = '# Validation\n\n## Status: PASS\n';
    (getHarnessProject as Mock).mockReturnValue(makeLockedDevV2Project());

    const engine = makeEngine();
    const calls: SpawnCall[] = [];
    spySpawnAgent(engine, calls);
    (engine as unknown as { handleDevV2Phase12SpecReview: Mock }).handleDevV2Phase12SpecReview =
      vi.fn(async () => {}) as unknown as Mock;
    const state = getState(engine, 'proj-12');

    await (engine as unknown as {
      runDevV2Phase12SpecGeneration: (id: string, p: unknown, s: unknown) => Promise<void>;
    }).runDevV2Phase12SpecGeneration('proj-12', makeLockedDevV2Project(), state);

    const builderCalls = calls.filter((c) => c.agentId === PIPE2_SPEC_BUILDER_ID);
    const loopValidatorCalls = calls.filter((c) => c.agentId === PIPE2_SPEC_VALIDATOR_ID);
    expect(builderCalls).toHaveLength(1);
    expect(loopValidatorCalls).toHaveLength(1);
  });

  it('8. after the loop, state is awaiting-spec-review on phase 12 (does NOT advance to 13)', async () => {
    fsState.validationReportContent = '# Validation\n\n## Status: PASS\n';
    (getHarnessProject as Mock).mockReturnValue(makeLockedDevV2Project());

    const engine = makeEngine();
    spySpawnAgent(engine, []);
    const advanceSpy = vi.fn(async () => {});
    (engine as unknown as { advanceToNextPhase: Mock }).advanceToNextPhase = advanceSpy as unknown as Mock;
    const state = getState(engine, 'proj-12');

    await (engine as unknown as {
      runDevV2Phase12SpecGeneration: (id: string, p: unknown, s: unknown) => Promise<void>;
    }).runDevV2Phase12SpecGeneration('proj-12', makeLockedDevV2Project(), state);

    const reviews = findPhaseChanged('awaiting-spec-review');
    expect(reviews.length).toBeGreaterThanOrEqual(1);
    expect(reviews[0]['phase']).toBe(12);
    expect(reviews[0]['awaitingUser']).toBe(true);

    expect(advanceSpy).not.toHaveBeenCalled();
    const anyPhase13 = capturedEvents
      .filter((e) => e.channel === 'pipeline:phase-changed')
      .some((e) => (e.data as Record<string, unknown>)['phase'] === 13);
    expect(anyPhase13).toBe(false);
  });
});


describe('SPEC-007 phase 12: approval advances to phase 13', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEvents.length = 0;
  });

  it('9. approvePhase on phase 12 (development-v2) calls advanceToNextPhase (-> 13)', async () => {
    (getHarnessProject as Mock).mockReturnValue(makeLockedDevV2Project());

    const engine = makeEngine();
    const advanceSpy = vi.fn(async (_id: string, s: PhaseStateLike) => {
      s.currentPhase = s.currentPhase + 1; // mirror the real +1 to assert -> 13
    });
    (engine as unknown as { advanceToNextPhase: Mock }).advanceToNextPhase = advanceSpy as unknown as Mock;

    const state = getState(engine, 'proj-12');
    state.currentPhase = 12;
    state.status = 'running';

    await engine.approvePhase('proj-12');

    expect(advanceSpy).toHaveBeenCalledOnce();
    expect(state.currentPhase).toBe(13);

    const devConfirm = findPhaseChanged('awaiting-dev-confirmation');
    expect(devConfirm.length).toBe(0);
  });
});


describe('SPEC-007 phase 12: manual message routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEvents.length = 0;
  });

  it('10. a manual message on phase 12 is routed to handleDevV2Phase12SpecReview (not rejected as auto-phase)', async () => {
    (getHarnessProject as Mock).mockReturnValue(makeLockedDevV2Project());

    const engine = makeEngine();
    const reviewSpy = vi.fn(
      async (_projectId: string, _message: string): Promise<void> => {},
    );
    (engine as unknown as { handleDevV2Phase12SpecReview: Mock }).handleDevV2Phase12SpecReview =
      reviewSpy as unknown as Mock;

    const state = getState(engine, 'proj-12');
    state.currentPhase = 12;
    state.status = 'running';

    const result = await engine.sendMessage('proj-12', 'pode ajustar a tela de login?');

    expect(result).toBeUndefined();
    const autoPhaseRejection = capturedEvents.find(
      (e) =>
        e.channel === 'pipeline:stream' &&
        (e.data as Record<string, unknown>)['type'] === 'error' &&
        typeof (e.data as Record<string, unknown>)['message'] === 'string' &&
        ((e.data as Record<string, unknown>)['message'] as string).includes('auto-phase'),
    );
    expect(autoPhaseRejection).toBeUndefined();

    expect(reviewSpy).toHaveBeenCalledOnce();
    expect(reviewSpy.mock.calls[0][0]).toBe('proj-12');
    expect(reviewSpy.mock.calls[0][1]).toBe('pode ajustar a tela de login?');
  });
});
