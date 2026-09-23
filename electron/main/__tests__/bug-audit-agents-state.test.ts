import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ home: '' }));
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('../paths', () => ({ getLionClawHome: () => state.home }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  app: { on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: vi.fn() }));
vi.mock('../ipc/repo-graph', () => ({
  getRepoGraphEngine: () => ({
    addRepository: vi.fn(async () => ({ error: 'sem repositorio' })),
    asReader: () => ({ minimalContext: vi.fn() }),
  }),
}));

import { initDatabase, getDb, insertHarnessProject, getHarnessProject, getBugAnalysisAgentStatuses } from '../db';
import { registerPipelineHandlers } from '../ipc/pipeline';
import { resetPhase, type ResetEngineContext } from '../pipeline-engine/reset';
import { runBugPhase2ParallelAnalysis } from '../pipeline-engine/handlers/bug';
import { handleBugPhase1DiscoveryMessage } from '../pipeline-engine/handlers/bug';
import { BugAnalysisRunner } from '../bug-analysis-runner';
import { getBugContext } from '../bug-paths';
import type { PipelineEngine } from '../pipeline-engine';
import type { PipelineEngineContext, HandlerPhaseState, SpawnAgentResult } from '../pipeline-engine/handlers/context';
import type { HarnessProject } from '../../../src/types';

let projectPath = '';

const BASE_CONFIG: HarnessProject['config'] = {
  maxRoundsPerSprint: 3,
  usePlaywright: false,
  evaluatorAgentId: 'harness-evaluator',
  plannerAgentId: 'harness-planner',
  stack: [],
};

function spawnResult(output: string): SpawnAgentResult {
  return {
    output,
    metrics: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: 1,
      apiRequests: 1,
      costUsd: 0.5,
      durationMs: 1234,
    },
    model: 'claude-opus-5',
    runtime: 'cloud',
    provider: 'anthropic',
  };
}

function makeState(): HandlerPhaseState {
  return {
    abortController: new AbortController(),
    continueSessions: new Map(),
    currentPhase: 1,
    status: 'running',
  };
}

function makeCtx(): PipelineEngineContext {
  const fakeEngine = {
    spawnAgent: vi.fn(async (agentId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return spawnResult(`saida de ${agentId}`);
    }),
  } as unknown as PipelineEngine;

  return {
    spawnAgent: async (_agentId: string, _prompt: string, opts: Record<string, unknown>) => {
      (opts.onText as ((c: string) => void) | undefined)?.('ok [PHASE_COMPLETE]');
      return spawnResult('ok');
    },
    collectMetrics: vi.fn(),
    accumulateMetrics: vi.fn(),
    advanceToNextPhase: vi.fn(async () => {}),
    buildPriorMessagesForPhase: () => undefined,
    makeConversationOnText:
      (_projectId: string, _phase: number, acc: { text: string; completed: boolean }) => (chunk: string) => {
        acc.text += chunk;
      },
    createBugAnalysisRunner: () => new BugAnalysisRunner(fakeEngine),
    PHASE_COMPLETE_MARKER: '[PHASE_COMPLETE]',
  } as unknown as PipelineEngineContext;
}

function makeResetCtx(): ResetEngineContext {
  const states = new Map<string, ReturnType<ResetEngineContext['getState']>>();
  return {
    getState: (projectId: string) => {
      let s = states.get(projectId);
      if (!s) {
        s = {
          abortController: new AbortController(),
          status: 'idle',
          currentPhase: 1,
          currentSprintIndex: 0,
          continueSessions: new Map(),
          codexSessions: new Map(),
          phaseMetricAccum: new Map(),
        };
        states.set(projectId, s);
      }
      return s;
    },
    updateProjectColumns: vi.fn(),
    runAutoPhase: vi.fn(async () => {}),
    runSprint: vi.fn(async () => {}),
  };
}

function createBugProject(): HarnessProject {
  return insertHarnessProject({
    name: 'TB-38',
    description: '',
    projectPath,
    specPath: '',
    config: { ...BASE_CONFIG },
    pipelineType: 'bug',
  });
}

async function runPhase1And2(project: HarnessProject): Promise<void> {
  const ctx = makeCtx();
  await handleBugPhase1DiscoveryMessage(ctx, project.id, 'o botao trava', makeState(), project);
  const afterPhase1 = getHarnessProject(project.id)!;
  writeDiagnostico(afterPhase1);
  await runBugPhase2ParallelAnalysis(ctx, project.id, afterPhase1, makeState());
}

function writeDiagnostico(project: HarnessProject): void {
  const bugCtx = getBugContext(project)!;
  fs.mkdirSync(bugCtx.runDir, { recursive: true });
  fs.writeFileSync(bugCtx.diagnosticoPath, '# Diagnostico\n\n## Resumo\nO botao trava ao salvar.\n', 'utf-8');
}

async function runPhase2Again(projectId: string): Promise<void> {
  const ctx = makeCtx();
  const project = getHarnessProject(projectId)!;
  writeDiagnostico(project);
  await runBugPhase2ParallelAnalysis(ctx, projectId, project, makeState());
}

function auditAgentsState(projectId: string): unknown {
  const handler = handlers.get('pipeline:get-audit-agents-state');
  if (!handler) throw new Error('handler pipeline:get-audit-agents-state nao registrado');
  return handler({}, projectId);
}

beforeAll(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-bug-audit-home-'));
  initDatabase();
  registerPipelineHandlers({
    getMainWindow: () => null,
    getHarnessEngine: () => null,
    getPipelineEngine: () => null,
  });
});

afterAll(() => {
  try {
    getDb().close();
  } catch {}
  try {
    fs.rmSync(state.home, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-bug-audit-proj-'));
  execFileSync('git', ['init', '-q'], { cwd: projectPath, stdio: 'ignore' });
});

describe('TB-38 (i): duas execucoes da fase 2 devolvem sempre 3 linhas', () => {
  it('SEM reset entre as duas execucoes: 3 linhas (UNIQUE (project_id, run_id, agent_id) da V143)', async () => {
    const project = createBugProject();
    await runPhase1And2(project);

    const first = auditAgentsState(project.id) as { agents: unknown[] };
    expect(first.agents).toHaveLength(3);

    await runPhase2Again(project.id);

    const second = auditAgentsState(project.id) as { agents: unknown[] };
    expect(second.agents).toHaveLength(3);
  });

  it('COM reset da fase 2 entre as duas execucoes: 3 linhas (runId preservado, linhas apagadas)', async () => {
    const project = createBugProject();
    await runPhase1And2(project);
    expect((auditAgentsState(project.id) as { agents: unknown[] }).agents).toHaveLength(3);

    const runIdBefore = getBugContext(getHarnessProject(project.id)!)!.runId;

    await resetPhase(makeResetCtx(), project.id, 2);

    expect(getBugAnalysisAgentStatuses(project.id, runIdBefore)).toHaveLength(0);
    expect((auditAgentsState(project.id) as { agents: unknown[] }).agents).toHaveLength(0);

    await runPhase2Again(project.id);

    const after = auditAgentsState(project.id) as { agents: unknown[] };
    expect(after.agents).toHaveLength(3);
  });
});

describe('TB-23: bug_analysis_agent_status fica VAZIA apos o reset das fases 1 e 2', () => {
  it('reset da fase 2 esvazia a tabela', async () => {
    const project = createBugProject();
    await runPhase1And2(project);
    const runId = getBugContext(getHarnessProject(project.id)!)!.runId;
    expect(getBugAnalysisAgentStatuses(project.id, runId)).toHaveLength(3);

    await resetPhase(makeResetCtx(), project.id, 2);

    expect(getBugAnalysisAgentStatuses(project.id, runId)).toHaveLength(0);
  });

  it('reset da fase 1 esvazia a tabela E limpa o runId (proximo run gera outro)', async () => {
    const project = createBugProject();
    await runPhase1And2(project);
    const runId = getBugContext(getHarnessProject(project.id)!)!.runId;
    expect(getBugAnalysisAgentStatuses(project.id, runId)).toHaveLength(3);

    await resetPhase(makeResetCtx(), project.id, 1);

    expect(getBugAnalysisAgentStatuses(project.id, runId)).toHaveLength(0);
    const after = getHarnessProject(project.id)!;
    expect(after.config.bug?.runId).toBeUndefined();
    expect(after.specPath ?? '').toBe('');
    expect(after.sprintsJsonPath ?? null).toBeNull();
  });
});

describe('TB-38 (iii): projeto bug sem config.bug.runId', () => {
  it('devolve { agents: [] } sem lancar', () => {
    const project = createBugProject();
    expect(getHarnessProject(project.id)!.config.bug?.runId).toBeUndefined();

    const result = auditAgentsState(project.id) as { agents: unknown[] };
    expect(result).toEqual({ agents: [] });
  });

  it('projeto security continua indo pelo caminho de getAuditAgentsState', () => {
    const security = insertHarnessProject({
      name: 'TB-38 security',
      description: '',
      projectPath,
      specPath: '',
      config: { ...BASE_CONFIG },
      pipelineType: 'security',
    });

    const result = auditAgentsState(security.id) as { agents: unknown[] };
    expect(Array.isArray(result.agents)).toBe(true);
  });
});
