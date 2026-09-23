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
    getAllWindows: vi.fn(() => [
      {
        isDestroyed: () => false,
        webContents: { send: (channel: string, data: unknown) => capturedEvents.push({ channel, data }) },
      },
    ]),
  },
  app: { on: vi.fn() },
}));

const fsState = {
  validationReportContent: '',
  specContent: 'SPEC body',
};
function fsReadFileSync(p: string): string {
  if (typeof p === 'string' && p.includes('security-spec-validation')) return fsState.validationReportContent;
  return fsState.specContent;
}
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn((p: string) => fsReadFileSync(p)),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  },
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn((p: string) => fsReadFileSync(p)),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));
vi.mock('path', () => ({
  default: { join: (...args: string[]) => args.join('/'), basename: (p: string) => p.split('/').pop() ?? p },
  join: (...args: string[]) => args.join('/'),
  basename: (p: string) => p.split('/').pop() ?? p,
}));
vi.mock('os', () => ({
  default: { homedir: () => '/home/user', tmpdir: () => '/tmp' },
  homedir: () => '/home/user',
  tmpdir: () => '/tmp',
}));

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
  findConsolidatedSecurityReport: vi.fn(() => '/tmp/project/.lionclaw/Security/Security-20260101-1200.md'),
}));
vi.mock('../pipeline-report', () => ({ generatePipelineReport: vi.fn(), exportPipelineReport: vi.fn() }));
vi.mock('../pipeline-metrics-report', () => ({}));

import { PipelineEngine } from '../pipeline-engine';
import { HarnessEngine } from '../harness-engine';
import { getHarnessProject } from '../db';
import { SPEC_BUILDER_ID } from '../seed-agents/spec-builder';
import { SECURITY_SPEC_VALIDATOR_ID } from '../seed-agents/security-spec-validator';

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
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: 0,
      apiRequests: 1,
      costUsd: 0.0001,
      durationMs: 10,
    },
    model: 'claude-sonnet-4-6',
    runtime: 'cloud' as const,
    provider: 'anthropic',
  };
}

function makeSecurityProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-sec',
    name: 'Security Test Project',
    projectPath: '/tmp/project',
    pipelineType: 'security',
    pipelineDocsId: null,
    pipelineCurrentPhase: 6,
    status: 'running',
    specPath: null,
    config: {},
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

const LOOP_BUILDER_MARKERS = ['Gere um SPEC completo', 'Corrija o SPEC de correcoes de seguranca'];
const LOOP_VALIDATOR_MARKER = 'Valide o SPEC de correcoes de seguranca contra o relatorio';

function loopBuilderCalls(calls: SpawnCall[]): SpawnCall[] {
  return calls.filter((c) => c.agentId === SPEC_BUILDER_ID && LOOP_BUILDER_MARKERS.some((m) => c.prompt.includes(m)));
}
function loopValidatorCalls(calls: SpawnCall[]): SpawnCall[] {
  return calls.filter((c) => c.agentId === SECURITY_SPEC_VALIDATOR_ID && c.prompt.includes(LOOP_VALIDATOR_MARKER));
}

async function runPhase6(engine: PipelineEngine, project: unknown, state: PhaseStateLike) {
  await (
    engine as unknown as {
      runSecurityPhase6: (id: string, p: unknown, s: unknown) => Promise<void>;
    }
  ).runSecurityPhase6('proj-sec', project, state);
}

describe('SPEC-loop-fix security phase 6: runSecurityPhase6 (auto loop)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEvents.length = 0;
    fsState.validationReportContent = '';
    fsState.specContent = 'SPEC body';
  });

  it('1. calls spec-builder then security-spec-validator in round 1 (PASS)', async () => {
    fsState.validationReportContent = '# Validation\n\n## Status: PASS\n';
    (getHarnessProject as Mock).mockReturnValue(makeSecurityProject());

    const engine = makeEngine();
    const calls: SpawnCall[] = [];
    spySpawnAgent(engine, calls);
    const state = getState(engine, 'proj-sec');

    await runPhase6(engine, makeSecurityProject(), state);

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].agentId).toBe(SPEC_BUILDER_ID);
    expect(calls[1].agentId).toBe(SECURITY_SPEC_VALIDATOR_ID);
    expect(calls.some((c) => c.agentId === 'spec-validator')).toBe(false);
    expect(calls.some((c) => c.agentId === 'pipe2-spec-validator')).toBe(false);
    expect(calls.some((c) => c.agentId === 'arch-spec-validator')).toBe(false);
  });

  it('2. the validator prompt references the CONSOLIDATED security report and does NOT anchor to a PRD', async () => {
    fsState.validationReportContent = '# Validation\n\n## Status: PASS\n';
    (getHarnessProject as Mock).mockReturnValue(makeSecurityProject());

    const engine = makeEngine();
    const calls: SpawnCall[] = [];
    spySpawnAgent(engine, calls);
    const state = getState(engine, 'proj-sec');

    await runPhase6(engine, makeSecurityProject(), state);

    const validatorCall = loopValidatorCalls(calls)[0];
    expect(validatorCall).toBeDefined();
    expect(validatorCall!.prompt).toContain('Relatorio consolidado:');
    expect(validatorCall!.prompt).toContain('Security-20260101-1200.md');
    expect(validatorCall!.prompt).not.toContain('PRD.md');
    expect(validatorCall!.prompt).not.toContain('stories-requisitos');
    expect(validatorCall!.prompt).not.toContain('design-contract.json');
    expect(validatorCall!.prompt).toContain('NAO um PRD');
  });

  it('3. on FAIL, round 2 builder receives the security-spec-validation.md content', async () => {
    fsState.validationReportContent =
      '# Validation\n\n## Status: FAIL\n\n[MISS] finding SQLi nao virou feature na SPEC\n';
    (getHarnessProject as Mock).mockReturnValue(makeSecurityProject());

    const engine = makeEngine();
    const calls: SpawnCall[] = [];
    spySpawnAgent(engine, calls);
    const state = getState(engine, 'proj-sec');

    await runPhase6(engine, makeSecurityProject(), state);

    const builderCalls = loopBuilderCalls(calls);
    expect(builderCalls.length).toBeGreaterThanOrEqual(2);

    const round2Builder = builderCalls[1];
    expect(round2Builder.prompt).toContain('[MISS] finding SQLi nao virou feature na SPEC');
    expect(round2Builder.prompt).toContain('## Status: FAIL');
  });

  it('4. on PASS in round 2, the loop stops (exactly 2 builder + 2 validator spawns)', async () => {
    (getHarnessProject as Mock).mockReturnValue(makeSecurityProject());

    const engine = makeEngine();
    const calls: SpawnCall[] = [];
    let loopValidatorSpawns = 0;
    const spy = vi.fn(async (agentId: string, prompt: string) => {
      calls.push({ agentId, prompt });
      if (agentId === SECURITY_SPEC_VALIDATOR_ID && prompt.includes(LOOP_VALIDATOR_MARKER)) {
        loopValidatorSpawns += 1;
        fsState.validationReportContent = loopValidatorSpawns >= 2 ? '## Status: PASS\n' : '## Status: FAIL\n';
      }
      return makeSpawnResult();
    });
    (engine as unknown as { spawnAgent: Mock }).spawnAgent = spy as unknown as Mock;
    const state = getState(engine, 'proj-sec');

    await runPhase6(engine, makeSecurityProject(), state);

    expect(loopBuilderCalls(calls)).toHaveLength(2);
    expect(loopValidatorCalls(calls)).toHaveLength(2);
  });

  it('5. never-PASS -> exactly 3 builder + 3 validator spawns (MAX_ROUNDS) then proceeds', async () => {
    fsState.validationReportContent = '## Status: FAIL\n';
    (getHarnessProject as Mock).mockReturnValue(makeSecurityProject());

    const engine = makeEngine();
    const calls: SpawnCall[] = [];
    spySpawnAgent(engine, calls);
    const state = getState(engine, 'proj-sec');

    await runPhase6(engine, makeSecurityProject(), state);

    expect(loopBuilderCalls(calls)).toHaveLength(3);
    expect(loopValidatorCalls(calls)).toHaveLength(3);

    const reviews = findPhaseChanged('awaiting-spec-review');
    expect(reviews.length).toBeGreaterThanOrEqual(1);
  });

  it('6. after the loop, state is awaiting-spec-review on phase 6 (does NOT advance to 7); validator writes security-spec-validation.md', async () => {
    fsState.validationReportContent = '## Status: PASS\n';
    (getHarnessProject as Mock).mockReturnValue(makeSecurityProject());

    const engine = makeEngine();
    const calls: SpawnCall[] = [];
    spySpawnAgent(engine, calls);
    const advanceSpy = vi.fn(async () => {});
    (engine as unknown as { advanceToNextPhase: Mock }).advanceToNextPhase = advanceSpy as unknown as Mock;
    const state = getState(engine, 'proj-sec');

    await runPhase6(engine, makeSecurityProject(), state);

    const reviews = findPhaseChanged('awaiting-spec-review');
    expect(reviews.length).toBeGreaterThanOrEqual(1);
    expect(reviews[0]['phase']).toBe(6);
    expect(reviews[0]['awaitingUser']).toBe(true);

    expect(advanceSpy).not.toHaveBeenCalled();
    const anyPhase7 = capturedEvents
      .filter((e) => e.channel === 'pipeline:phase-changed')
      .some((e) => (e.data as Record<string, unknown>)['phase'] === 7);
    expect(anyPhase7).toBe(false);

    const validatorCall = loopValidatorCalls(calls)[0];
    expect(validatorCall!.prompt).toContain('security-spec-validation.md');
  });

  it('8. uses the DEDICATED security-spec-validator id — never spec-validator/pipe2-spec-validator/arch-spec-validator', async () => {
    fsState.validationReportContent = '## Status: PASS\n';
    (getHarnessProject as Mock).mockReturnValue(makeSecurityProject());

    const engine = makeEngine();
    const calls: SpawnCall[] = [];
    spySpawnAgent(engine, calls);
    const state = getState(engine, 'proj-sec');

    await runPhase6(engine, makeSecurityProject(), state);

    expect(SECURITY_SPEC_VALIDATOR_ID).toBe('security-spec-validator');
    const validatorIds = calls.map((c) => c.agentId).filter((id) => id.includes('validator'));
    expect(validatorIds.length).toBeGreaterThanOrEqual(1);
    for (const id of validatorIds) {
      expect(id).toBe(SECURITY_SPEC_VALIDATOR_ID);
    }
  });
});

describe('SPEC-loop-fix security phase 6: approval advances to phase 7', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEvents.length = 0;
  });

  it('7. approvePhase on phase 6 (security) calls advanceToNextPhase (-> 7)', async () => {
    (getHarnessProject as Mock).mockReturnValue(makeSecurityProject());

    const engine = makeEngine();
    const advanceSpy = vi.fn(async (_id: string, s: PhaseStateLike) => {
      s.currentPhase = s.currentPhase + 1;
    });
    (engine as unknown as { advanceToNextPhase: Mock }).advanceToNextPhase = advanceSpy as unknown as Mock;

    const state = getState(engine, 'proj-sec');
    state.currentPhase = 6;
    state.status = 'running';

    await engine.approvePhase('proj-sec');

    expect(advanceSpy).toHaveBeenCalledOnce();
    expect(state.currentPhase).toBe(7);

    const devConfirm = findPhaseChanged('awaiting-dev-confirmation');
    expect(devConfirm.length).toBe(0);
  });
});
