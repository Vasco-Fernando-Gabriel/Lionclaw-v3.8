import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  executeAgent: vi.fn(),
  isGrokAvailable: vi.fn(),
  isKimiAvailable: vi.fn(),
  setProjectStatus: vi.fn(),
  updateHarnessProject: vi.fn(),
  updateHarnessSprint: vi.fn(),
  roundInsert: vi.fn(),
  roundUpdate: vi.fn(),
  persistMessage: vi.fn(),
  persistEvaluatorCompletion: vi.fn(),
  updateEnrichSession: vi.fn(),
  accumulateEnrichMetrics: vi.fn(),
  persistAuthCheckpoint: vi.fn(),
  claimAuthCheckpoint: vi.fn(),
  advanceAuthCheckpoint: vi.fn(),
  completeAuthCheckpoint: vi.fn(),
  getAuthCheckpoint: vi.fn(),
  authCheckpoint: null as Record<string, unknown> | null,
  events: [] as Array<{ channel: string; data: unknown }>,
  project: null as Record<string, unknown> | null,
  sprints: [] as Array<Record<string, unknown>>,
  sprintsJson: null as Record<string, unknown> | null,
}));

vi.mock('electron', () => ({ BrowserWindow: class BrowserWindow {} }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../agent-runtime', () => ({ executeAgent: state.executeAgent }));
vi.mock('../agent-runtime/grok-availability', async () => {
  const actual = await vi.importActual<typeof import('../agent-runtime/grok-availability')>(
    '../agent-runtime/grok-availability',
  );
  return { ...actual, isGrokAvailable: state.isGrokAvailable };
});
vi.mock('../agent-runtime/kimi-availability', async () => {
  const actual = await vi.importActual<typeof import('../agent-runtime/kimi-availability')>(
    '../agent-runtime/kimi-availability',
  );
  return { ...actual, isKimiAvailable: state.isKimiAvailable };
});
vi.mock('../pipeline-shared/status', () => ({ setProjectStatus: state.setProjectStatus }));
vi.mock('../pipeline-shared/ipc-emitter', () => ({
  emitIPC: (channel: string, data: unknown) => state.events.push({ channel, data }),
}));
vi.mock('../pipeline-shared/persist', () => ({
  persistMessage: state.persistMessage,
  persistHarnessRound: { insert: state.roundInsert, update: state.roundUpdate },
  persistClaimedHarnessEvaluatorCompletion: state.persistEvaluatorCompletion,
}));
vi.mock('../pipeline-shared/sdk-bootstrap', () => ({ ensureNodeInPath: vi.fn() }));
vi.mock('../db', () => ({
  getHarnessProject: () => state.project,
  updateHarnessProject: state.updateHarnessProject,
  getHarnessSprints: vi.fn(() => state.sprints),
  updateHarnessSprint: state.updateHarnessSprint,
  getAgent: vi.fn((id: string) => ({
    id,
    name: id,
    model: 'grok-4.5',
    runtime: 'grok',
    isActive: true,
  })),
  getAllAgents: vi.fn(() => []),
  getEnrichSession: vi.fn(),
  updateEnrichSession: state.updateEnrichSession,
  accumulateEnrichMetrics: state.accumulateEnrichMetrics,
  persistHarnessProviderAuthCheckpoint: state.persistAuthCheckpoint,
  claimHarnessProviderAuthCheckpoint: state.claimAuthCheckpoint,
  advanceClaimedHarnessProviderAuthCheckpoint: state.advanceAuthCheckpoint,
  completeHarnessProviderAuthCheckpoint: state.completeAuthCheckpoint,
  getHarnessProviderAuthCheckpoint: state.getAuthCheckpoint,
  startTaskExecution: vi.fn(),
  finalizeTaskExecutionOnce: vi.fn(),
}));
vi.mock('../harness-planner', () => ({
  buildPlannerPrompt: vi.fn(() => 'planner prompt'),
  buildPlannerMarkdownPrompt: vi.fn(() => 'planner prompt'),
  buildRegenerationPrompt: vi.fn(() => 'regen prompt'),
  parsePlannerOutput: vi.fn(),
  parsePlannerMarkdown: vi.fn(),
  saveSprintsJson: vi.fn(),
  readHarnessSprintsJson: vi.fn(() => state.sprintsJson),
  reseedHarnessSprintsFromFile: vi.fn(),
  checkHarnessSprintQueueIntegrity: vi.fn(() => ({ ok: true })),
}));
vi.mock('../harness-evaluator', () => ({
  buildEvaluatorPrompt: vi.fn(),
  parseEvaluationOutput: vi.fn(),
  validateCriteria: vi.fn((evaluation: unknown) => evaluation),
  updateSpecProgress: vi.fn(),
  buildFeedbackFromEvaluation: vi.fn(() => 'feedback'),
}));
vi.mock('../pipeline-paths', () => ({
  resolveSpecPath: (project: { specPath: string }) => project.specPath,
  resolveSpecProgressPath: vi.fn(),
  resolveHarnessSprintsPath: vi.fn(),
  getPipelineDocsContext: vi.fn(() => null),
}));
vi.mock('../architecture-review-paths', () => ({ getArchitectureReviewContext: vi.fn() }));
vi.mock('../permission-guard', () => ({
  setActiveEnrichSpecPath: vi.fn(),
  createEnrichPermissionGuard: vi.fn(),
}));
vi.mock('../ollama-client', () => ({ ollamaChatWithTools: vi.fn() }));
vi.mock('../vault-registry', () => ({ getSecret: vi.fn() }));
vi.mock('../smoke-test-runner', () => ({
  runSmokeTest: vi.fn(async () => ({
    typecheck: { ok: true },
    lint: { available: false },
    tests: { available: false },
    brokenImports: [],
    missingFiles: [],
  })),
  writeSmokeTestReport: vi.fn(),
}));

import { HarnessEngine } from '../harness-engine';
import { GrokAuthError } from '../agent-runtime/grok-availability';
import { KimiAuthError } from '../agent-runtime/kimi-availability';
import { PipelinePausedError } from '../agent-runtime/types';

function configureSingleSprintRun(): void {
  state.sprints = [{
    id: 'sprint-db-1',
    projectId: 'project-1',
    sprintIndex: 0,
    sprintJsonId: 'sprint-1',
    name: 'Sprint 1',
    status: 'pending',
    coderAgentId: 'harness-coder',
    evaluatorAgentId: 'harness-evaluator',
    roundsUsed: 0,
    maxRounds: 1,
  }];
  state.sprintsJson = {
    metadata: { version: 1, total_sprints: 1, total_features: 1 },
    sprints: [{
      id: 'sprint-1',
      index: 0,
      name: 'Sprint 1',
      description: 'Implementar',
      coder_agent_id: 'harness-coder',
      stack: [],
      features: [{
        id: 'feature-1',
        name: 'Feature',
        description: 'Feature',
        acceptance_criteria: ['feito'],
      }],
      hints: { existing_files: [], key_interfaces: [], architecture_notes: '' },
      dependencies: [],
      complexity: 'low',
      estimated_rounds: 1,
    }],
  };
}

const coderMetrics = {
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 3,
  cacheCreationTokens: 2,
  cacheTokens: 5,
  costUsd: 1.25,
  durationMs: 100,
  toolUses: 1,
  apiRequests: 1,
  output: 'codigo pronto',
  toolCallsAccum: [],
  promptUsed: 'coder prompt',
  costSource: 'reported',
  runtimeUsed: 'grok',
  providerUsed: 'grok',
  modelUsed: 'grok-4.5',
  codexPatchFailures: 0,
} as const;

const evaluatorMetrics = {
  inputTokens: 5,
  outputTokens: 6,
  cacheReadTokens: 4,
  cacheCreationTokens: 1,
  cacheTokens: 5,
  costUsd: 0.5,
  durationMs: 50,
  toolUses: 0,
  apiRequests: 1,
  evaluation: {
    round: 1,
    verdict: 'pass',
    summary: 'aprovado',
    criteria: [],
  },
  output: 'aprovado',
  toolCallsAccum: [],
  costSource: 'reported',
  runtimeUsed: 'grok',
  providerUsed: 'grok',
  modelUsed: 'grok-4.5',
  parseTier: 'result',
} as const;

function persistedCheckpointStage(): unknown {
  const resume = state.authCheckpoint?.resume as Record<string, unknown> | undefined;
  const checkpoint = resume?.checkpoint as Record<string, unknown> | undefined;
  return checkpoint?.stage;
}

function seedClaimedEvaluatorCheckpoint(kind: 'run' | 'pipeline-run'): void {
  const baseCheckpoint = {
    stage: 'evaluator',
    sprintId: 'sprint-db-1',
    sprintIndex: 0,
    roundNumber: 1,
    roundId: 'round-1',
    coderMetrics,
  } as const;
  const emptyMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    durationMs: 0,
    toolUses: 0,
    apiRequests: 0,
  };
  state.authCheckpoint = {
    checkpointId: 'checkpoint-evaluator',
    pauseReason: 'provider-auth',
    provider: 'grok',
    ownerKind: kind === 'run' ? 'harness' : 'pipeline',
    phaseNumber: 14,
    agentId: 'harness-evaluator',
    roundId: 'round-1',
    claimState: 'claimed',
    resume: {
      kind,
      provider: 'grok',
      checkpoint: kind === 'run'
        ? baseCheckpoint
        : {
            ...baseCheckpoint,
            totalRounds: 1,
            aggCoder: { ...emptyMetrics },
            aggEvaluator: { ...emptyMetrics },
          },
    },
  };
  if (state.project) state.project.status = 'running';
}

describe('HarnessEngine Grok auth e contexto estrutural', () => {
  let root: string;

  beforeEach(() => {
    vi.clearAllMocks();
    state.events.length = 0;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lion-harness-grok-'));
    const specPath = path.join(root, 'SPEC.md');
    fs.writeFileSync(specPath, '# spec');
    state.project = {
      id: 'project-1',
      name: 'Project',
      projectPath: root,
      specPath,
      status: 'ready',
      pipelineType: 'development',
      config: {
        plannerAgentId: 'harness-planner',
        evaluatorAgentId: 'harness-evaluator',
        plannerOutputFormat: 'json',
        maxRoundsPerSprint: 1,
        usePlaywright: false,
        stack: [],
      },
    };
    state.sprints = [];
    state.sprintsJson = null;
    state.authCheckpoint = null;
    state.getAuthCheckpoint.mockImplementation(() => state.authCheckpoint);
    state.persistAuthCheckpoint.mockImplementation((_projectId: string, checkpoint: Record<string, unknown>) => {
      state.authCheckpoint = { ...structuredClone(checkpoint), claimState: 'pending' };
      if (state.project) state.project.status = 'paused';
      return true;
    });
    state.claimAuthCheckpoint.mockImplementation((_projectId: string, checkpointId: string) => {
      if (state.authCheckpoint?.checkpointId !== checkpointId) return undefined;
      state.authCheckpoint = { ...state.authCheckpoint, claimState: 'claimed' };
      return structuredClone(state.authCheckpoint);
    });
    state.advanceAuthCheckpoint.mockImplementation((
      _projectId: string,
      checkpointId: string,
      resume: unknown,
    ) => {
      if (state.authCheckpoint?.checkpointId !== checkpointId
        || state.authCheckpoint?.claimState !== 'claimed') return undefined;
      state.authCheckpoint = { ...state.authCheckpoint, resume: structuredClone(resume) };
      return structuredClone(state.authCheckpoint);
    });
    state.persistEvaluatorCompletion.mockImplementation((data: {
      checkpointId: string;
      roundId: string;
      resume: unknown;
      round: Record<string, unknown>;
      pipelineMessage?: Record<string, unknown>;
    }) => {
      if (state.authCheckpoint?.checkpointId !== data.checkpointId
        || state.authCheckpoint?.claimState !== 'claimed') return undefined;
      const currentStage = persistedCheckpointStage();
      if (currentStage === 'evaluator-completed') return structuredClone(state.authCheckpoint);
      state.roundUpdate(data.roundId, data.round);
      if (data.pipelineMessage) state.persistMessage(data.pipelineMessage);
      state.authCheckpoint = { ...state.authCheckpoint, resume: structuredClone(data.resume) };
      return structuredClone(state.authCheckpoint);
    });
    state.completeAuthCheckpoint.mockImplementation((_projectId: string, checkpointId: string) => {
      if (state.authCheckpoint?.checkpointId !== checkpointId
        || state.authCheckpoint?.claimState !== 'claimed') return false;
      state.authCheckpoint = null;
      return true;
    });
    state.setProjectStatus.mockImplementation((_projectId: string, status: string) => {
      if (state.project) state.project.status = status;
    });
    state.updateHarnessProject.mockImplementation((_projectId: string, patch: Record<string, unknown>) => {
      if (state.project) Object.assign(state.project, patch);
    });
    state.updateHarnessSprint.mockImplementation((sprintId: string, patch: Record<string, unknown>) => {
      const sprint = state.sprints.find(({ id }) => id === sprintId);
      if (sprint) Object.assign(sprint, patch);
    });
    state.roundInsert.mockReturnValue({ id: 'round-1' });
    state.executeAgent.mockRejectedValue(new GrokAuthError('login Grok necessario'));
    state.isGrokAvailable.mockResolvedValue({ usable: true });
    state.isKimiAvailable.mockResolvedValue({ usable: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('planner standalone pausa sem marcar failed e emite provider grok', async () => {
    const engine = new HarnessEngine(() => null);

    await expect(engine.plan('project-1')).resolves.toBeUndefined();

    expect(state.persistAuthCheckpoint).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ pauseReason: 'provider-auth', provider: 'grok' }),
    );
    expect(state.project?.status).toBe('paused');
    expect(state.setProjectStatus).not.toHaveBeenCalledWith('project-1', 'failed');
    expect(state.events).toContainEqual({
      channel: 'pipeline:auth-required',
      data: expect.objectContaining({ provider: 'grok', projectId: 'project-1', agentId: 'harness-planner' }),
    });
    expect(state.events.some(({ channel }) => channel === 'harness:error')).toBe(false);
    const request = state.executeAgent.mock.calls[0][0];
    expect(request.executionContext).toMatchObject({
      ownerKind: 'harness',
      ownerId: 'project-1',
      workspace: { cwd: root, projectId: 'project-1', readRoots: [root], writeRoots: [root] },
    });
    expect(request.executionContext.rootExecutionId).toBe(request.executionContext.parentExecutionId);
  });

  it('planner usado pelo pipeline converte auth em PipelinePausedError grok-auth', async () => {
    const engine = new HarnessEngine(() => null);

    await expect(engine.plan('project-1', undefined, 'pipeline')).rejects.toMatchObject({
      name: 'PipelinePausedError',
      reason: 'grok-auth',
    } satisfies Partial<PipelinePausedError>);

    const request = state.executeAgent.mock.calls[0][0];
    expect(request.executionContext).toMatchObject({
      ownerKind: 'pipeline',
      ownerId: 'project-1',
      lane: 'pipeline',
    });
    expect(state.setProjectStatus).not.toHaveBeenCalledWith('project-1', 'failed');
  });

  it('planner Kimi pausa provider-aware e valida Kimi no resume', async () => {
    const engine = new HarnessEngine(() => null);
    state.executeAgent.mockRejectedValueOnce(new KimiAuthError('login Kimi necessario'));

    await expect(engine.plan('project-1')).resolves.toBeUndefined();

    expect(state.events).toContainEqual({
      channel: 'pipeline:auth-required',
      data: expect.objectContaining({ provider: 'kimi', runtime: 'kimi', projectId: 'project-1' }),
    });
    state.isKimiAvailable.mockResolvedValueOnce({ usable: false, reason: 'login Kimi pendente' });
    await expect(engine.resumeAfterAuth('project-1', 'kimi')).resolves.toEqual({
      ok: false,
      message: 'login Kimi pendente',
    });
  });

  it('resume auth valida o mesmo provider antes de limpar o checkpoint', async () => {
    const engine = new HarnessEngine(() => null);
    await engine.plan('project-1');
    const callsBeforeResume = state.executeAgent.mock.calls.length;

    expect(engine.resume('project-1')).toEqual({
      ok: false,
      message: 'Retomada bloqueada: reconecte o grok no aviso de autenticacao, verifique o login e tente novamente.',
    });
    expect(state.executeAgent).toHaveBeenCalledTimes(callsBeforeResume);
    expect(state.project?.status).toBe('paused');

    state.isGrokAvailable.mockResolvedValueOnce({ usable: false, reason: 'login pendente' });

    await expect(engine.resumeAfterAuth('project-1', 'grok')).resolves.toEqual({
      ok: false,
      message: 'login pendente',
    });
    expect(state.project?.status).toBe('paused');
    await expect(engine.resumeAfterAuth('project-1', 'codex')).resolves.toMatchObject({ ok: false });
  });

  it('reidrata claim do evaluator apos restart sem repetir coder, round ou custo', async () => {
    configureSingleSprintRun();
    const engine = new HarnessEngine(() => null);
    const spawnCoder = vi.fn().mockResolvedValue(coderMetrics);
    const spawnEvaluator = vi.fn()
      .mockRejectedValueOnce(new GrokAuthError('login Grok necessario'))
      .mockResolvedValueOnce(evaluatorMetrics);
    Object.assign(engine, { spawnCoder, spawnEvaluator });

    await expect(engine.run('project-1')).resolves.toBeUndefined();

    expect(state.project?.status).toBe('paused');
    expect(spawnCoder).toHaveBeenCalledTimes(1);
    expect(spawnEvaluator).toHaveBeenCalledTimes(1);
    expect(state.roundInsert).toHaveBeenCalledTimes(1);

    const checkpointId = String(state.authCheckpoint?.checkpointId);
    expect(state.claimAuthCheckpoint('project-1', checkpointId)).toEqual(expect.objectContaining({
      checkpointId,
      claimState: 'claimed',
    }));

    const restartedEngine = new HarnessEngine(() => null);
    Object.assign(restartedEngine, { spawnCoder, spawnEvaluator });
    expect(restartedEngine.resume('project-1')).toMatchObject({ ok: false });
    await expect(restartedEngine.resumeAfterAuth('project-1', 'grok')).resolves.toEqual({ ok: true });

    await vi.waitFor(() => {
      expect(state.setProjectStatus).toHaveBeenCalledWith('project-1', 'done');
    });
    expect(spawnCoder).toHaveBeenCalledTimes(1);
    expect(spawnEvaluator).toHaveBeenCalledTimes(2);
    expect(state.roundInsert).toHaveBeenCalledTimes(1);
    expect(state.roundUpdate.mock.calls.filter(([, patch]) => (
      patch as Record<string, unknown>
    ).coderCostUsd === coderMetrics.costUsd)).toHaveLength(1);
    expect(state.roundUpdate.mock.calls.filter(([, patch]) => (
      patch as Record<string, unknown>
    ).evaluatorCostUsd === evaluatorMetrics.costUsd)).toHaveLength(1);
    await vi.waitFor(() => expect(state.authCheckpoint).toBeNull());
  });

  it('standalone reidrata evaluator concluido apos crash sem repetir inferencia ou custo', async () => {
    configureSingleSprintRun();
    seedClaimedEvaluatorCheckpoint('run');
    const engine = new HarnessEngine(() => null);
    const spawnCoder = vi.fn();
    const spawnEvaluator = vi.fn().mockResolvedValue(evaluatorMetrics);
    Object.assign(engine, { spawnCoder, spawnEvaluator });
    const commit = state.persistEvaluatorCompletion.getMockImplementation()!;
    state.persistEvaluatorCompletion.mockImplementationOnce((data) => {
      commit(data);
      throw new Error('crash imediatamente apos commit do evaluator');
    });

    await expect(engine.resumeAfterAuth('project-1', 'grok')).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(persistedCheckpointStage()).toBe('evaluator-completed'));
    expect(state.authCheckpoint).toMatchObject({ claimState: 'claimed' });
    expect(state.project?.status).toBe('running');

    const restartedEngine = new HarnessEngine(() => null);
    Object.assign(restartedEngine, { spawnCoder, spawnEvaluator });
    await expect(restartedEngine.resumeAfterAuth('project-1', 'grok')).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(state.project?.status).toBe('done'));

    expect(spawnCoder).not.toHaveBeenCalled();
    expect(spawnEvaluator).toHaveBeenCalledTimes(1);
    expect(state.roundInsert).not.toHaveBeenCalled();
    expect(state.roundUpdate.mock.calls.filter(([, patch]) => (
      patch as Record<string, unknown>
    ).evaluatorCostUsd === evaluatorMetrics.costUsd)).toHaveLength(1);
    await vi.waitFor(() => expect(state.authCheckpoint).toBeNull());
  });

  it('retoma no mesmo round do coder sem repetir evaluator nem custo concluido', async () => {
    configureSingleSprintRun();
    const engine = new HarnessEngine(() => null);
    const spawnCoder = vi.fn()
      .mockRejectedValueOnce(new GrokAuthError('login Grok necessario'))
      .mockResolvedValueOnce(coderMetrics);
    const spawnEvaluator = vi.fn().mockResolvedValue(evaluatorMetrics);
    Object.assign(engine, { spawnCoder, spawnEvaluator });

    await expect(engine.run('project-1')).resolves.toBeUndefined();

    expect(state.project?.status).toBe('paused');
    expect(spawnCoder).toHaveBeenCalledTimes(1);
    expect(spawnEvaluator).not.toHaveBeenCalled();
    expect(state.roundInsert).toHaveBeenCalledTimes(1);

    expect(engine.resume('project-1')).toMatchObject({ ok: false });
    expect(spawnCoder).toHaveBeenCalledTimes(1);

    await expect(engine.resumeAfterAuth('project-1', 'grok')).resolves.toEqual({ ok: true });

    await vi.waitFor(() => {
      expect(state.setProjectStatus).toHaveBeenCalledWith('project-1', 'done');
    });
    expect(spawnCoder).toHaveBeenCalledTimes(2);
    expect(spawnEvaluator).toHaveBeenCalledTimes(1);
    expect(state.roundInsert).toHaveBeenCalledTimes(1);
    expect(state.roundUpdate.mock.calls.filter(([, patch]) => (
      patch as Record<string, unknown>
    ).coderCostUsd === coderMetrics.costUsd)).toHaveLength(1);
    expect(state.roundUpdate.mock.calls.filter(([, patch]) => (
      patch as Record<string, unknown>
    ).evaluatorCostUsd === evaluatorMetrics.costUsd)).toHaveLength(1);
  });

  it('pipeline retoma checkpoint do coder no mesmo round sem duplicar round ou custo', async () => {
    configureSingleSprintRun();
    const engine = new HarnessEngine(() => null);
    const spawnCoder = vi.fn()
      .mockRejectedValueOnce(new GrokAuthError('login Grok necessario'))
      .mockResolvedValueOnce(coderMetrics);
    const spawnEvaluator = vi.fn().mockResolvedValue(evaluatorMetrics);
    Object.assign(engine, { spawnCoder, spawnEvaluator });

    await expect(engine.runSingleSprint('project-1', 0)).rejects.toMatchObject({
      name: 'PipelinePausedError',
      reason: 'grok-auth',
    });
    expect(state.roundInsert).toHaveBeenCalledTimes(1);
    expect(spawnEvaluator).not.toHaveBeenCalled();

    expect(engine.preparePipelineResumeAfterAuth('project-1', 'grok')).toEqual({ ok: true });
    expect(engine.preparePipelineResumeAfterAuth('project-1', 'grok')).toEqual({
      ok: false,
      message: 'Retomada do checkpoint de autenticacao ja esta em andamento.',
    });
    const restartedEngine = new HarnessEngine(() => null);
    Object.assign(restartedEngine, { spawnCoder, spawnEvaluator });
    await expect(restartedEngine.runSingleSprint('project-1', 0)).rejects.toMatchObject({
      name: 'PipelinePausedError',
      reason: 'grok-auth',
    });
    expect(spawnCoder).toHaveBeenCalledTimes(1);
    expect(restartedEngine.preparePipelineResumeAfterAuth('project-1', 'grok')).toEqual({ ok: true });
    const result = await restartedEngine.runSingleSprint('project-1', 0);
    expect(restartedEngine.completePipelineResumeAfterAuth('project-1', 'grok')).toBe(true);

    expect(result.verdict).toBe('pass');
    expect(spawnCoder).toHaveBeenCalledTimes(2);
    expect(spawnEvaluator).toHaveBeenCalledTimes(1);
    expect(state.roundInsert).toHaveBeenCalledTimes(1);
    expect(state.roundUpdate.mock.calls.filter(([, patch]) => (
      patch as Record<string, unknown>
    ).coderCostUsd === coderMetrics.costUsd)).toHaveLength(1);
    expect(result.coderMetrics.costUsd).toBe(coderMetrics.costUsd);
    expect(state.authCheckpoint).toBeNull();
  });

  it('pipeline reidrata checkpoint do evaluator apos restart sem repetir coder, mensagens ou custo', async () => {
    configureSingleSprintRun();
    const engine = new HarnessEngine(() => null);
    const spawnCoder = vi.fn().mockResolvedValue(coderMetrics);
    const spawnEvaluator = vi.fn()
      .mockRejectedValueOnce(new GrokAuthError('login Grok necessario'))
      .mockResolvedValueOnce(evaluatorMetrics);
    Object.assign(engine, { spawnCoder, spawnEvaluator });

    await expect(engine.runSingleSprint('project-1', 0)).rejects.toMatchObject({
      name: 'PipelinePausedError',
      reason: 'grok-auth',
    });
    expect(spawnCoder).toHaveBeenCalledTimes(1);
    expect(state.persistMessage).toHaveBeenCalledTimes(2);

    const restartedEngine = new HarnessEngine(() => null);
    Object.assign(restartedEngine, { spawnCoder, spawnEvaluator });
    expect(restartedEngine.resume('project-1')).toMatchObject({ ok: false });
    expect(restartedEngine.preparePipelineResumeAfterAuth('project-1', 'grok')).toEqual({ ok: true });
    const result = await restartedEngine.runSingleSprint('project-1', 0);
    expect(restartedEngine.completePipelineResumeAfterAuth('project-1', 'grok')).toBe(true);

    expect(result.verdict).toBe('pass');
    expect(spawnCoder).toHaveBeenCalledTimes(1);
    expect(spawnEvaluator).toHaveBeenCalledTimes(2);
    expect(state.roundInsert).toHaveBeenCalledTimes(1);
    expect(state.persistMessage).toHaveBeenCalledTimes(3);
    expect(state.roundUpdate.mock.calls.filter(([, patch]) => (
      patch as Record<string, unknown>
    ).coderCostUsd === coderMetrics.costUsd)).toHaveLength(1);
    expect(result.coderMetrics.costUsd).toBe(coderMetrics.costUsd);
  });

  it('pipeline reidrata evaluator concluido apos crash sem repetir inferencia, mensagem ou custo', async () => {
    configureSingleSprintRun();
    seedClaimedEvaluatorCheckpoint('pipeline-run');
    const engine = new HarnessEngine(() => null);
    const spawnCoder = vi.fn();
    const spawnEvaluator = vi.fn().mockResolvedValue(evaluatorMetrics);
    Object.assign(engine, { spawnCoder, spawnEvaluator });
    expect(engine.preparePipelineResumeAfterAuth('project-1', 'grok')).toEqual({ ok: true });
    const commit = state.persistEvaluatorCompletion.getMockImplementation()!;
    state.persistEvaluatorCompletion.mockImplementationOnce((data) => {
      commit(data);
      throw new Error('crash imediatamente apos commit do evaluator');
    });

    await expect(engine.runSingleSprint('project-1', 0)).rejects.toThrow('crash imediatamente apos commit do evaluator');
    expect(persistedCheckpointStage()).toBe('evaluator-completed');
    expect(state.authCheckpoint).toMatchObject({ claimState: 'claimed' });

    const restartedEngine = new HarnessEngine(() => null);
    Object.assign(restartedEngine, { spawnCoder, spawnEvaluator });
    await expect(restartedEngine.runSingleSprint('project-1', 0)).rejects.toMatchObject({
      name: 'PipelinePausedError',
      reason: 'grok-auth',
    });
    expect(restartedEngine.preparePipelineResumeAfterAuth('project-1', 'grok')).toEqual({ ok: true });
    const result = await restartedEngine.runSingleSprint('project-1', 0);
    expect(restartedEngine.completePipelineResumeAfterAuth('project-1', 'grok')).toBe(true);

    expect(result.verdict).toBe('pass');
    expect(spawnCoder).not.toHaveBeenCalled();
    expect(spawnEvaluator).toHaveBeenCalledTimes(1);
    expect(state.persistMessage).toHaveBeenCalledTimes(1);
    expect(state.roundUpdate.mock.calls.filter(([, patch]) => (
      patch as Record<string, unknown>
    ).evaluatorCostUsd === evaluatorMetrics.costUsd)).toHaveLength(1);
    expect(result.evaluatorMetrics.costUsd).toBe(evaluatorMetrics.costUsd);
    expect(state.authCheckpoint).toBeNull();
  });

  it('pausa e retoma enrich no checkpoint Grok sem duplicar mensagem ou metricas', async () => {
    const engine = new HarnessEngine(() => null);
    state.executeAgent
      .mockRejectedValueOnce(new GrokAuthError('login Grok necessario'))
      .mockResolvedValueOnce({
        output: 'validacao concluida',
        runtime: 'grok',
        metrics: {
          inputTokens: 3,
          outputTokens: 4,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.25,
          durationMs: 10,
          toolUses: 0,
          apiRequests: 1,
        },
      });

    await engine.startEnrichSession({
      sessionId: 'enrich-1',
      name: 'Enrich',
      specPath: String(state.project?.specPath),
      projectPath: root,
      validatorAgentId: 'spec-validator-enrich',
    });

    expect(engine.hasActiveEnrichSession()).toBe(true);
    expect(state.events).toContainEqual({
      channel: 'pipeline:auth-required',
      data: expect.objectContaining({
        provider: 'grok',
        projectId: 'enrich-1',
        ownerKind: 'enrich',
      }),
    });
    expect(state.persistMessage).toHaveBeenCalledTimes(1);
    expect(state.accumulateEnrichMetrics).not.toHaveBeenCalled();

    await engine.resumeEnrichAfterAuth('enrich-1', 'grok');

    expect(state.executeAgent).toHaveBeenCalledTimes(2);
    expect(state.persistMessage).toHaveBeenCalledTimes(1);
    expect(state.accumulateEnrichMetrics).toHaveBeenCalledTimes(1);
    expect(state.updateEnrichSession).toHaveBeenLastCalledWith('enrich-1', { status: 'waiting' });
  });
});
