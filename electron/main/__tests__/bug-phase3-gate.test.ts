
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

const state = vi.hoisted(() => ({ home: '' }));

vi.mock('../paths', () => ({ getLionClawHome: () => state.home }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const capturedEvents: Array<{ channel: string; data: Record<string, unknown> }> = [];
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: {},
  app: { on: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, data: unknown) =>
            capturedEvents.push({ channel, data: (data ?? {}) as Record<string, unknown> }),
        },
      },
    ],
  },
}));
vi.mock('../harness-engine', () => {
  const HarnessEngine = vi.fn();
  HarnessEngine.prototype.abort = vi.fn();
  HarnessEngine.prototype.runSingleSprint = vi.fn();
  return { HarnessEngine };
});

import {
  initDatabase,
  getDb,
  insertHarnessProject,
  getHarnessProject,
  updateHarnessProject,
  getPipelinePhaseMetricsRows,
} from '../db';
import {
  acquireProjectLock,
  releaseProjectLock,
  isProjectLocked,
} from '../pipeline-shared/lock';
import { PipelineEngine } from '../pipeline-engine';
import { HarnessEngine } from '../harness-engine';
import { ensureBugContext, readBugManifest } from '../bug-paths';
import * as bugPaths from '../bug-paths';
import { BUG_SOLUTION_CONSOLIDATOR_ID } from '../seed-agents';
import type { HarnessProject } from '../../../src/types';
import type { SpawnAgentResult } from '../pipeline-engine/handlers/context';


interface EnginePrivate {
  approvePhase: (projectId: string, metadata?: Record<string, unknown>) => Promise<void>;
  getState: (projectId: string) => {
    currentPhase: number;
    status: string;
    abortController: AbortController;
    phaseMetricAccum: Map<number, unknown>;
    continueSessions: Map<string, unknown>;
    codexSessions: Map<string, unknown>;
    currentSprintIndex: number;
  };
  accumulateMetrics: (state: unknown, phase: number, result: SpawnAgentResult) => void;
  flushAccumulatedMetrics: (...args: unknown[]) => void;
  completePipeline: (...args: unknown[]) => void;
  runFinalizeInBackground: (...args: unknown[]) => void;
  finalizeConversationPhase: (...args: unknown[]) => Promise<void>;
  advanceToNextPhase: (...args: unknown[]) => Promise<void>;
  runAutoPhase: (projectId: string, phase: number) => Promise<void>;
  runPhase11: (...args: unknown[]) => Promise<void>;
  runBugPhase2ParallelAnalysis: (...args: unknown[]) => Promise<void>;
  runBugPhase4Spec: (...args: unknown[]) => Promise<void>;
}

let projectPath = '';

const BASE_CONFIG: HarnessProject['config'] = {
  maxRoundsPerSprint: 3,
  usePlaywright: false,
  evaluatorAgentId: 'harness-evaluator',
  plannerAgentId: 'harness-planner',
  stack: [],
};

function spawnResult(): SpawnAgentResult {
  return {
    output: 'ok',
    metrics: {
      inputTokens: 120,
      outputTokens: 60,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: 2,
      apiRequests: 1,
      costUsd: 0.42,
      durationMs: 3210,
    },
    model: 'claude-opus-5',
    runtime: 'cloud',
    provider: 'anthropic',
  };
}

function makeEngine(): EnginePrivate {
  const harness = new HarnessEngine({} as never);
  return new PipelineEngine(() => null, harness as never) as unknown as EnginePrivate;
}

function createBugProjectWithRun(): HarnessProject {
  const project = insertHarnessProject({
    name: 'Bug gate',
    description: '',
    projectPath,
    specPath: '',
    config: { ...BASE_CONFIG },
    pipelineType: 'bug',
  });
  const { context } = ensureBugContext(project);
  updateHarnessProject(project.id, {
    config: { ...project.config, bug: { runId: context.runId, outcome: 'pending' } },
  });
  fs.writeFileSync(context.planoPath, '# Plano de correcao\n\n## Desfecho\nfix\n', 'utf-8');
  return getHarnessProject(project.id)!;
}

function phaseChangedEvents(): Array<Record<string, unknown>> {
  return capturedEvents
    .filter((e) => e.channel === 'pipeline:phase-changed')
    .map((e) => e.data);
}

function errorEvents(): Array<Record<string, unknown>> {
  return capturedEvents.filter((e) => e.channel === 'pipeline:error').map((e) => e.data);
}

function stubEngine(
  engine: EnginePrivate,
  opts: { keepAdvance?: boolean } = {},
): { advance: Mock; sharedBackground: Mock; sharedFinalize: Mock } {
  const advance = vi.fn(async () => {});
  const sharedBackground = vi.fn();
  const sharedFinalize = vi.fn(async () => {});
  if (!opts.keepAdvance) {
    engine.advanceToNextPhase = advance as unknown as EnginePrivate['advanceToNextPhase'];
  }
  engine.runFinalizeInBackground = sharedBackground as unknown as EnginePrivate['runFinalizeInBackground'];
  engine.finalizeConversationPhase = sharedFinalize as unknown as EnginePrivate['finalizeConversationPhase'];
  return { advance, sharedBackground, sharedFinalize };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-bug-gate-home-'));
  initDatabase();
});

afterAll(() => {
  try {
    getDb().close();
  } catch {
  }
  try {
    fs.rmSync(state.home, { recursive: true, force: true });
  } catch {
  }
});

beforeEach(() => {
  vi.restoreAllMocks();
  capturedEvents.length = 0;
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-bug-gate-proj-'));
});


describe('TB-12: gate da fase 3, desfecho approve-plan', () => {
  it('grava outcome "fix" no config E no manifest e avanca para a fase 4', async () => {
    const project = createBugProjectWithRun();
    const engine = makeEngine();
    const runAuto = vi.fn(async () => {});
    engine.runAutoPhase = runAuto as unknown as EnginePrivate['runAutoPhase'];
    const { sharedBackground, sharedFinalize } = stubEngine(engine, { keepAdvance: true });

    const st = engine.getState(project.id);
    st.currentPhase = 3;
    st.status = 'running';

    await engine.approvePhase(project.id, { action: 'approve-plan' });
    await settle();

    const after = getHarnessProject(project.id)!;
    expect(after.config.bug?.outcome).toBe('fix');
    expect(readBugManifest(after)?.outcome).toBe('fix');

    expect(runAuto).toHaveBeenCalledWith(project.id, 4);
    expect(st.currentPhase).toBe(4);

    expect(sharedBackground).not.toHaveBeenCalled();
    expect(sharedFinalize).not.toHaveBeenCalled();
  });
});


describe('TB-13: gate da fase 3, desfecho close-pipeline', () => {
  it('encerra com status done, phase null, lock liberado e outcome no-bug', async () => {
    const project = createBugProjectWithRun();
    const engine = makeEngine();
    stubEngine(engine);

    const st = engine.getState(project.id);
    st.currentPhase = 3;
    st.status = 'running';
    acquireProjectLock(project.id, 'pipeline-engine');
    expect(isProjectLocked(project.id)).toBe(true);

    capturedEvents.length = 0;

    await engine.approvePhase(project.id, { action: 'close-pipeline' });
    await settle();

    const after = getHarnessProject(project.id)!;
    expect(after.config.bug?.outcome).toBe('no-bug');
    expect(readBugManifest(after)?.outcome).toBe('no-bug');
    expect(after.status).toBe('done');
    expect(after.pipelineCurrentPhase).toBeNull();
    expect(isProjectLocked(project.id)).toBe(false);

    const terminal = phaseChangedEvents().find((e) => e['phase'] === null);
    expect(terminal).toBeDefined();
    expect(terminal!['status']).toBe('pipeline-completed');
  });

  it('B-AC33 (b): flushAccumulatedMetrics(3, bug-solution-consolidator) roda ANTES de completePipeline e persiste UMA linha com custo e duracao > 0', async () => {
    const project = createBugProjectWithRun();
    const engine = makeEngine();
    stubEngine(engine);

    const st = engine.getState(project.id);
    st.currentPhase = 3;
    st.status = 'running';
    engine.accumulateMetrics(st, 3, spawnResult());

    const order: string[] = [];
    const flushArgs: unknown[][] = [];
    const realFlush = engine.flushAccumulatedMetrics.bind(engine);
    engine.flushAccumulatedMetrics = ((...args: unknown[]) => {
      order.push('flushAccumulatedMetrics');
      flushArgs.push(args);
      return realFlush(...args);
    }) as unknown as EnginePrivate['flushAccumulatedMetrics'];
    const realComplete = engine.completePipeline.bind(engine);
    engine.completePipeline = ((...args: unknown[]) => {
      order.push('completePipeline');
      return realComplete(...args);
    }) as unknown as EnginePrivate['completePipeline'];

    await engine.approvePhase(project.id, { action: 'close-pipeline' });
    await settle();

    expect(order).toEqual(['flushAccumulatedMetrics', 'completePipeline']);
    expect(flushArgs[0]![0]).toBe(project.id);
    expect(flushArgs[0]![1]).toBe(3);
    expect(flushArgs[0]![2]).toBe(BUG_SOLUTION_CONSOLIDATOR_ID);
    expect(flushArgs[0]![2]).toBe('bug-solution-consolidator');
    expect(flushArgs[0]![4]).toBe('completed');

    const rows = getPipelinePhaseMetricsRows(project.id).filter((r) => r.phaseNumber === 3);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentId).toBe('bug-solution-consolidator');
    expect(rows[0]!.costUsd).toBeGreaterThan(0);
    expect(rows[0]!.durationMs).toBeGreaterThan(0);
  });

  it('patchBugManifest LANCANDO nao impede o outcome de chegar ao DB (ordem DB-antes-de-manifest)', async () => {
    const project = createBugProjectWithRun();
    const engine = makeEngine();
    stubEngine(engine);

    vi.spyOn(bugPaths, 'patchBugManifest').mockImplementation(() => {
      throw new Error('disco cheio');
    });

    const st = engine.getState(project.id);
    st.currentPhase = 3;
    st.status = 'running';

    await expect(engine.approvePhase(project.id, { action: 'close-pipeline' })).rejects.toThrow(
      /disco cheio/,
    );
    await settle();

    const after = getHarnessProject(project.id)!;
    expect(after.config.bug?.outcome).toBe('no-bug');
  });
});


describe('TB-14: payload invalido no gate da fase 3', () => {
  it('sem metadata: emite pipeline:error e LANCA (nunca { ok: true } silencioso)', async () => {
    const project = createBugProjectWithRun();
    const engine = makeEngine();
    stubEngine(engine);

    const st = engine.getState(project.id);
    st.currentPhase = 3;
    st.status = 'running';

    await expect(engine.approvePhase(project.id)).rejects.toThrow(/requer \{ action/);

    const errors = errorEvents();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!['phase']).toBe(3);
    expect(getHarnessProject(project.id)!.config.bug?.outcome).toBe('pending');
  });

  it('action invalida: emite pipeline:error e LANCA', async () => {
    const project = createBugProjectWithRun();
    const engine = makeEngine();
    stubEngine(engine);

    const st = engine.getState(project.id);
    st.currentPhase = 3;
    st.status = 'running';

    await expect(
      engine.approvePhase(project.id, { action: 'lock-and-continue' }),
    ).rejects.toThrow(/action invalida/);

    expect(errorEvents().length).toBeGreaterThanOrEqual(1);
    expect(getHarnessProject(project.id)!.config.bug?.outcome).toBe('pending');
    expect(getHarnessProject(project.id)!.status).not.toBe('done');
  });
});


describe('TB-40 / B-AC22: approve das fases conversacionais do bug', () => {
  const cases: Array<{ phase: number; agentId: string; forbidden: string }> = [
    { phase: 1, agentId: 'bug-discovery', forbidden: 'discovery-agent' },
    { phase: 5, agentId: 'bug-spec-validator', forbidden: 'tech-database' },
    { phase: 7, agentId: 'sprint-validator', forbidden: 'tech-frontend' },
  ];

  it.each(cases)(
    'fase $phase grava metrica com $agentId e nunca com $forbidden',
    async ({ phase, agentId, forbidden }) => {
      const project = createBugProjectWithRun();
      const engine = makeEngine();
      const { sharedBackground, sharedFinalize } = stubEngine(engine);

      const st = engine.getState(project.id);
      st.currentPhase = phase;
      st.status = 'running';
      engine.accumulateMetrics(st, phase, spawnResult());

      await engine.approvePhase(project.id, {});
      await settle();

      const rows = getPipelinePhaseMetricsRows(project.id).filter((r) => r.phaseNumber === phase);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.agentId).toBe(agentId);
      expect(rows[0]!.agentId).not.toBe(forbidden);

      expect(sharedBackground).not.toHaveBeenCalled();
      expect(sharedFinalize).not.toHaveBeenCalled();
    },
  );

  it('a assercao NEGATIVA cobre as QUATRO fases conversacionais (1, 3, 5, 7)', async () => {
    for (const phase of [1, 3, 5, 7]) {
      const project = createBugProjectWithRun();
      const engine = makeEngine();
      const { sharedBackground, sharedFinalize } = stubEngine(engine);

      const st = engine.getState(project.id);
      st.currentPhase = phase;
      st.status = 'running';

      await engine.approvePhase(
        project.id,
        phase === 3 ? { action: 'approve-plan' } : {},
      );
      await settle();

      expect(sharedBackground, `fase ${phase}`).not.toHaveBeenCalled();
      expect(sharedFinalize, `fase ${phase}`).not.toHaveBeenCalled();
    }
  });

  it('TB-17 (i): a fase 7 emite awaiting-dev-confirmation; as fases 1 e 5 emitem completed e avancam', async () => {
    {
      const project = createBugProjectWithRun();
      const engine = makeEngine();
      const { advance } = stubEngine(engine);
      const st = engine.getState(project.id);
      st.currentPhase = 7;
      st.status = 'running';

      await engine.approvePhase(project.id, {});
      await settle();

      const gate = phaseChangedEvents().find(
        (e) => e['status'] === 'awaiting-dev-confirmation',
      );
      expect(gate).toBeDefined();
      expect(gate!['phase']).toBe(7);
      expect(gate!['awaitingUser']).toBe(true);
      expect(advance).not.toHaveBeenCalled();
    }

    for (const phase of [1, 5]) {
      capturedEvents.length = 0;
      const project = createBugProjectWithRun();
      const engine = makeEngine();
      const { advance } = stubEngine(engine);
      const st = engine.getState(project.id);
      st.currentPhase = phase;
      st.status = 'running';

      await engine.approvePhase(project.id, {});
      await settle();

      const completed = phaseChangedEvents().find(
        (e) => e['status'] === 'completed' && e['phase'] === phase,
      );
      expect(completed, `fase ${phase}`).toBeDefined();
      expect(completed!['awaitingUser']).toBe(false);
      expect(advance, `fase ${phase}`).toHaveBeenCalledTimes(1);
      expect(
        phaseChangedEvents().some((e) => e['status'] === 'awaiting-dev-confirmation'),
        `fase ${phase}`,
      ).toBe(false);
    }
  });
});


describe('TB-32 / B-AC19: dispatch de runAutoPhase para pipelineType bug', () => {
  it('fase 2 -> runner, fase 4 -> spec, fase 6 -> runPhase11 (Planner)', async () => {
    const project = createBugProjectWithRun();
    const engine = makeEngine();

    const phase2 = vi.fn(async () => {});
    const phase4 = vi.fn(async () => {});
    const planner = vi.fn(async () => {});
    engine.runBugPhase2ParallelAnalysis = phase2 as unknown as EnginePrivate['runBugPhase2ParallelAnalysis'];
    engine.runBugPhase4Spec = phase4 as unknown as EnginePrivate['runBugPhase4Spec'];
    engine.runPhase11 = planner as unknown as EnginePrivate['runPhase11'];

    await engine.runAutoPhase(project.id, 2);
    await engine.runAutoPhase(project.id, 4);
    await engine.runAutoPhase(project.id, 6);

    expect(phase2).toHaveBeenCalledTimes(1);
    expect(phase4).toHaveBeenCalledTimes(1);
    expect(planner).toHaveBeenCalledTimes(1);
  });

  it('fases nao-auto falham com `Unknown bug auto phase: N` (nunca `Unknown auto phase`, do dev)', async () => {
    for (const phase of [1, 3, 5, 7, 8, 9]) {
      const project = createBugProjectWithRun();
      const engine = makeEngine();
      capturedEvents.length = 0;

      await engine.runAutoPhase(project.id, phase);

      const messages = errorEvents().map((e) => String(e['error'] ?? ''));
      expect(messages, `fase ${phase}`).toContain(`Unknown bug auto phase: ${phase}`);
      expect(
        messages.some((m) => m === `Unknown auto phase: ${phase}`),
        `fase ${phase}`,
      ).toBe(false);

      const rows = getPipelinePhaseMetricsRows(project.id).filter((r) => r.phaseNumber === phase);
      expect(rows[0]!.status).toBe('failed');
    }
  });

  it('B-AC19: o avanco 5 -> 6 -> 7 acontece sem `Unknown auto phase`', async () => {
    const project = createBugProjectWithRun();
    const engine = makeEngine();

    const planner = vi.fn(async () => {});
    engine.runPhase11 = planner as unknown as EnginePrivate['runPhase11'];
    engine.runFinalizeInBackground = vi.fn() as unknown as EnginePrivate['runFinalizeInBackground'];
    engine.finalizeConversationPhase = vi.fn(async () => {}) as unknown as EnginePrivate['finalizeConversationPhase'];

    const st = engine.getState(project.id);
    st.currentPhase = 5;
    st.status = 'running';

    await engine.approvePhase(project.id, {});
    await settle();

    expect(planner).toHaveBeenCalledTimes(1);
    const errors = errorEvents().map((e) => String(e['error'] ?? ''));
    expect(errors.some((m) => m.includes('Unknown auto phase'))).toBe(false);
    expect(errors.some((m) => m.includes('Unknown bug auto phase'))).toBe(false);
  });
});


describe('TB-21: lock por projeto no Bug Pipe', () => {
  it('a pausa conversacional NAO libera o lock; o close-pipeline libera', async () => {
    const project = createBugProjectWithRun();
    const engine = makeEngine();
    stubEngine(engine);

    acquireProjectLock(project.id, 'pipeline-engine');

    const st = engine.getState(project.id);
    st.currentPhase = 1;
    st.status = 'running';
    await engine.approvePhase(project.id, {});
    await settle();
    expect(isProjectLocked(project.id)).toBe(true);

    st.currentPhase = 3;
    st.status = 'running';
    await engine.approvePhase(project.id, { action: 'close-pipeline' });
    await settle();
    expect(isProjectLocked(project.id)).toBe(false);

    releaseProjectLock(project.id);
  });
});
