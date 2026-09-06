
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ home: '' }));

vi.mock('../paths', () => ({ getLionClawHome: () => state.home }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: {},
  app: { on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

const emitted: Array<{ channel: string; payload: Record<string, unknown> }> = [];
vi.mock('../pipeline-shared/ipc-emitter', () => ({
  emitIPC: (channel: string, payload: unknown) => {
    emitted.push({ channel, payload: payload as Record<string, unknown> });
  },
}));

vi.mock('../ipc/repo-graph', () => ({
  getRepoGraphEngine: () => ({
    addRepository: vi.fn(async () => ({ error: 'sem repositorio' })),
    asReader: () => ({ minimalContext: vi.fn() }),
  }),
}));

import {
  initDatabase,
  getDb,
  insertHarnessProject,
  getHarnessProject,
  getBugAnalysisAgentsState,
  getPipelinePhaseMessages,
} from '../db';
import { resolveSpecPath } from '../pipeline-paths';
import { getBugContext } from '../bug-paths';
import { BugAnalysisRunner } from '../bug-analysis-runner';
import {
  handleBugPhase1DiscoveryMessage,
  runBugPhase2ParallelAnalysis,
  handleBugPhase3ConsolidationMessage,
  runBugPhase4Spec,
  handleBugPhase5SpecValidatorMessage,
} from '../pipeline-engine/handlers/bug';
import type { PipelineEngineContext, HandlerPhaseState, SpawnAgentResult } from '../pipeline-engine/handlers/context';
import type { PipelineEngine } from '../pipeline-engine';
import type { HarnessProject } from '../../../src/types';

const repoRoot = path.resolve(__dirname, '../../..');


let projectPath = '';

function makeState(): HandlerPhaseState {
  return {
    abortController: new AbortController(),
    continueSessions: new Map(),
    currentPhase: 1,
    status: 'running',
  };
}

function spawnResult(output: string): SpawnAgentResult {
  return {
    output,
    metrics: {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: 3,
      apiRequests: 1,
      costUsd: 1.25,
      durationMs: 4321,
    },
    model: 'claude-opus-5',
    runtime: 'cloud',
    provider: 'anthropic',
  };
}

interface CtxRecord {
  ctx: PipelineEngineContext;
  spawns: Array<{ agentId: string; prompt: string; opts: Record<string, unknown> }>;
  collected: Array<{ phase: number; agentId: string }>;
  accumulated: Array<{ phase: number }>;
  advanced: number[];
  engineSpawns: Array<{ agentId: string; prompt: string }>;
}

function makeCtx(
  onSpawn: (agentId: string, prompt: string, opts: Record<string, unknown>) => SpawnAgentResult | Promise<SpawnAgentResult>,
  analysisOutputs?: Record<string, string>,
): CtxRecord {
  const spawns: CtxRecord['spawns'] = [];
  const collected: CtxRecord['collected'] = [];
  const accumulated: CtxRecord['accumulated'] = [];
  const advanced: number[] = [];
  const engineSpawns: CtxRecord['engineSpawns'] = [];

  const fakeEngine = {
    spawnAgent: vi.fn(async (agentId: string, prompt: string) => {
      engineSpawns.push({ agentId, prompt });
      await new Promise((resolve) => setTimeout(resolve, 3));
      return spawnResult(analysisOutputs?.[agentId] ?? `saida de ${agentId}`);
    }),
  } as unknown as PipelineEngine;

  const ctx = {
    spawnAgent: async (agentId: string, prompt: string, opts: Record<string, unknown>) => {
      spawns.push({ agentId, prompt, opts });
      return onSpawn(agentId, prompt, opts);
    },
    collectMetrics: (_projectId: string, phaseNumber: number, agentId: string) => {
      collected.push({ phase: phaseNumber, agentId });
    },
    accumulateMetrics: (_state: unknown, phaseNumber: number) => {
      accumulated.push({ phase: phaseNumber });
    },
    advanceToNextPhase: async (_projectId: string, s: HandlerPhaseState) => {
      advanced.push(s.currentPhase);
    },
    buildPriorMessagesForPhase: () => undefined,
    makeConversationOnText:
      (_projectId: string, _phase: number, acc: { text: string; completed: boolean }) =>
        (chunk: string) => { acc.text += chunk; },
    createBugAnalysisRunner: () => new BugAnalysisRunner(fakeEngine),
    PHASE_COMPLETE_MARKER: '[PHASE_COMPLETE]',
  } as unknown as PipelineEngineContext;

  return { ctx, spawns, collected, accumulated, advanced, engineSpawns };
}

function createBugProject(config: HarnessProject['config']): HarnessProject {
  return insertHarnessProject({
    name: 'Bug run',
    projectPath,
    specPath: '',
    config,
    pipelineType: 'bug',
  });
}

const BASE_CONFIG: HarnessProject['config'] = {
  maxRoundsPerSprint: 7,
  usePlaywright: false,
  evaluatorAgentId: 'harness-evaluator',
  plannerAgentId: 'harness-planner',
  stack: ['typescript', 'electron'],
};

beforeAll(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-bug-handler-home-'));
  initDatabase();
});

afterAll(() => {
  try { getDb().close(); } catch { /* handle ja invalido */ }
  fs.rmSync(state.home, { recursive: true, force: true });
});

beforeEach(() => {
  emitted.length = 0;
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-bug-proj-'));
  execFileSync('git', ['init', '-q'], { cwd: projectPath, stdio: 'ignore' });
});


describe('Fase 1 — gating write do runId (TB-7)', () => {
  it('grava config.bug.runId preservando o resto de config E o resto de config.bug', async () => {
    const project = createBugProject({ ...BASE_CONFIG, bug: { outcome: 'pending' } });
    const rec = makeCtx((_agentId, _prompt, opts) => {
      (opts.onText as (c: string) => void)('Ola, vamos diagnosticar. [PHASE_COMPLETE]');
      return spawnResult('ok');
    });

    await handleBugPhase1DiscoveryMessage(rec.ctx, project.id, 'o botao trava', makeState(), project);

    const after = getHarnessProject(project.id)!;
    expect(after.config.bug?.runId).toMatch(/^\d{8}_\d{6}-[0-9a-f]{6}$/);
    expect(after.config.bug?.outcome).toBe('pending');
    expect(after.config.maxRoundsPerSprint).toBe(7);
    expect(after.config.plannerAgentId).toBe('harness-planner');
    expect(after.config.stack).toEqual(['typescript', 'electron']);
    expect(after.config.usePlaywright).toBe(false);

    const bugCtx = getBugContext(after)!;
    expect(fs.existsSync(bugCtx.runDir)).toBe(true);
    expect(fs.existsSync(bugCtx.manifestPath)).toBe(true);

    expect(rec.spawns).toHaveLength(1);
    expect(rec.spawns[0].agentId).toBe('bug-discovery');
    expect(rec.spawns[0].prompt).toContain(bugCtx.diagnosticoPath);
    expect(rec.spawns[0].prompt).toContain('Fase 1 de 9');
    const messages = getPipelinePhaseMessages(project.id, 1);
    expect(messages.some((m) => m.content.includes('[PHASE_COMPLETE]'))).toBe(false);
  });

  it('nao regenera o runId em turnos seguintes (idempotente)', async () => {
    const project = createBugProject({ ...BASE_CONFIG });
    const st = makeState();
    const rec = makeCtx((_a, _p, opts) => {
      (opts.onText as (c: string) => void)('turno');
      return spawnResult('ok');
    });

    await handleBugPhase1DiscoveryMessage(rec.ctx, project.id, 'primeiro', st, project);
    const runId1 = getHarnessProject(project.id)!.config.bug?.runId;

    const reloaded = getHarnessProject(project.id)!;
    await handleBugPhase1DiscoveryMessage(rec.ctx, project.id, 'segundo', st, reloaded);
    const runId2 = getHarnessProject(project.id)!.config.bug?.runId;

    expect(runId1).toBeTruthy();
    expect(runId2).toBe(runId1);
    expect(rec.spawns).toHaveLength(2);
    expect(rec.spawns[1].opts.continueSession).toBe(true);
    expect(typeof rec.spawns[1].opts.rebuildPromptOnRetry).toBe('function');
  });
});


describe('Fase 2 — metricas e estado dos agentes (secao 4.7.2)', () => {
  it('3 linhas por agente (sprint_index 1/2/3) + 1 agregada (sprint_index -1, aggregateOnly)', async () => {
    const project = createBugProject({ ...BASE_CONFIG });
    const st = makeState();
    const rec1 = makeCtx((_a, _p, opts) => {
      (opts.onText as (c: string) => void)('diagnostico feito');
      return spawnResult('ok');
    });
    await handleBugPhase1DiscoveryMessage(rec1.ctx, project.id, 'bug X', st, project);

    const withRun = getHarnessProject(project.id)!;
    const bugCtx = getBugContext(withRun)!;
    fs.writeFileSync(bugCtx.diagnosticoPath, '# Diagnostico\n\nO botao trava ao clicar.', 'utf-8');

    const rec2 = makeCtx(() => spawnResult('nao usado na fase 2'), {
      'bug-root-cause-analyst': '# Causa raiz',
      'bug-context-historian': '# Historico',
      'bug-hypothesis-refuter': '# Refutacao',
    });
    await runBugPhase2ParallelAnalysis(rec2.ctx, project.id, withRun, st);

    expect(fs.readFileSync(bugCtx.analise01Path, 'utf-8')).toBe('# Causa raiz');
    expect(fs.readFileSync(bugCtx.analise02Path, 'utf-8')).toBe('# Historico');
    expect(fs.readFileSync(bugCtx.analise03Path, 'utf-8')).toBe('# Refutacao');

    const rows = getDb().prepare(
      `SELECT agent_id, sprint_index, metadata, cost_usd, duration_ms, model, runtime
       FROM pipeline_phase_metrics
       WHERE project_id = ? AND phase_number = 2
       ORDER BY sprint_index ASC`,
    ).all(project.id) as Array<{
      agent_id: string;
      sprint_index: number;
      metadata: string | null;
      cost_usd: number;
      duration_ms: number;
      model: string | null;
      runtime: string | null;
    }>;

    expect(rows).toHaveLength(4);

    const aggregate = rows.filter((r) => r.sprint_index === -1);
    expect(aggregate).toHaveLength(1);
    expect(aggregate[0].agent_id).toBe('bug-analysis-multi');
    expect(JSON.parse(aggregate[0].metadata ?? '{}').aggregateOnly).toBe(true);

    const perAgent = rows.filter((r) => r.sprint_index !== -1);
    expect(perAgent.map((r) => r.sprint_index)).toEqual([1, 2, 3]);
    expect(perAgent.map((r) => r.agent_id)).toEqual([
      'bug-root-cause-analyst',
      'bug-context-historian',
      'bug-hypothesis-refuter',
    ]);

    const agents = getBugAnalysisAgentsState(project.id, bugCtx.runId);
    expect(agents).toHaveLength(3);
    expect(agents.map((a) => a.agentSlug)).toEqual(['root-cause', 'historian', 'refuter']);
    for (const a of agents) {
      expect(a.status).toBe('completed');
      expect(a.costUsd).toBe(1.25);
      expect(a.durationMs).toBeGreaterThan(0);
      expect(a.model).toBe('claude-opus-5');
      expect(a.runtime).toBe('cloud');
    }

    expect(getBugAnalysisAgentsState(project.id, 'outro-run')).toEqual([]);

    expect(rec2.advanced).toHaveLength(1);
  });

  it('hard fail do diagnostico borbulha pelo handler sem spawn nenhum', async () => {
    const project = createBugProject({ ...BASE_CONFIG });
    const st = makeState();
    const rec1 = makeCtx((_a, _p, opts) => {
      (opts.onText as (c: string) => void)('sem diagnostico escrito');
      return spawnResult('ok');
    });
    await handleBugPhase1DiscoveryMessage(rec1.ctx, project.id, 'bug Y', st, project);

    const withRun = getHarnessProject(project.id)!;
    const bugCtx = getBugContext(withRun)!;
    const rec2 = makeCtx(() => spawnResult('x'));

    await expect(
      runBugPhase2ParallelAnalysis(rec2.ctx, project.id, withRun, st),
    ).rejects.toThrow(bugCtx.diagnosticoPath);
    expect(rec2.engineSpawns).toHaveLength(0);
    expect(fs.existsSync(bugCtx.analise01Path)).toBe(false);
  });
});


describe('Fase 3 — consolidacao', () => {
  it('usa o bug-solution-consolidator com os 4 paths absolutos e o gate de 2 saidas', async () => {
    const project = createBugProject({ ...BASE_CONFIG });
    const st = makeState();
    const rec1 = makeCtx((_a, _p, opts) => {
      (opts.onText as (c: string) => void)('ok');
      return spawnResult('ok');
    });
    await handleBugPhase1DiscoveryMessage(rec1.ctx, project.id, 'bug Z', st, project);
    const withRun = getHarnessProject(project.id)!;
    const bugCtx = getBugContext(withRun)!;

    const rec = makeCtx((_a, _p, opts) => {
      (opts.onText as (c: string) => void)('consolidando');
      fs.writeFileSync(bugCtx.planoPath, '# Plano\n\n## Desfecho\nCORRIGIR', 'utf-8');
      return spawnResult('ok');
    });
    await handleBugPhase3ConsolidationMessage(rec.ctx, project.id, 'e ai?', st, withRun);

    expect(rec.spawns).toHaveLength(1);
    expect(rec.spawns[0].agentId).toBe('bug-solution-consolidator');
    const prompt = rec.spawns[0].prompt;
    for (const p of [bugCtx.analise01Path, bugCtx.analise02Path, bugCtx.analise03Path, bugCtx.diagnosticoPath, bugCtx.planoPath]) {
      expect(prompt).toContain(p);
    }
    expect(prompt).toContain('Aprovar');
    expect(prompt).toContain('Encerrar Pipeline');
    expect(prompt).not.toContain('bug-root-cause-analyst');
    expect(prompt).not.toContain('bug-hypothesis-refuter');

    const docEvents = emitted.filter((e) => e.channel === 'pipeline:document-updated');
    expect(docEvents.some((e) => e.payload.path === bugCtx.planoPath)).toBe(true);
    expect(rec.accumulated).toEqual([{ phase: 3 }]);
  });
});


describe('Fase 4 — spec-builder reusado (TB-15, TB-16, TB-33b)', () => {
  async function setupUpToPhase4() {
    const project = createBugProject({ ...BASE_CONFIG });
    const st = makeState();
    const rec1 = makeCtx((_a, _p, opts) => {
      (opts.onText as (c: string) => void)('ok');
      return spawnResult('ok');
    });
    await handleBugPhase1DiscoveryMessage(rec1.ctx, project.id, 'bug W', st, project);
    const withRun = getHarnessProject(project.id)!;
    const bugCtx = getBugContext(withRun)!;
    fs.writeFileSync(bugCtx.diagnosticoPath, '# Diagnostico', 'utf-8');
    fs.writeFileSync(bugCtx.planoPath, '# Plano de correcao\n\n### C1 - fix', 'utf-8');
    return { project: withRun, bugCtx, st };
  }

  it('TB-15: spawna spec-builder com o path absoluto do plano e a instrucao de output', async () => {
    const { project, bugCtx, st } = await setupUpToPhase4();
    const rec = makeCtx((_a, _p, _opts) => {
      fs.writeFileSync(bugCtx.specPath, '# SPEC do bug', 'utf-8');
      return spawnResult('SPEC gerada');
    });

    await runBugPhase4Spec(rec.ctx, project.id, project, st);

    expect(rec.spawns).toHaveLength(1);
    expect(rec.spawns[0].agentId).toBe('spec-builder');
    const prompt = rec.spawns[0].prompt;
    expect(prompt).toContain(bugCtx.planoPath);
    expect(path.isAbsolute(bugCtx.planoPath)).toBe(true);
    expect(prompt).toContain(bugCtx.diagnosticoPath);
    expect(prompt).toContain(`Salve o SPEC em: ${bugCtx.specPath}`);
    expect(prompt).toContain('FONTE PRIMARIA');
    expect(rec.collected).toEqual([{ phase: 4, agentId: 'spec-builder' }]);
    expect(rec.advanced).toHaveLength(1);
  });

  it('TB-33b (a): persiste specPath no DB apos a fase 4', async () => {
    const { project, bugCtx, st } = await setupUpToPhase4();
    const rec = makeCtx(() => {
      fs.writeFileSync(bugCtx.specPath, '# SPEC do bug', 'utf-8');
      return spawnResult('SPEC gerada');
    });

    await runBugPhase4Spec(rec.ctx, project.id, project, st);

    const after = getHarnessProject(project.id)!;
    expect(after.specPath).toBe(bugCtx.specPath);
    expect(after.specPath).toBe(path.join(bugCtx.runDir, `SPEC-${bugCtx.runId}.md`));
  });

  it('TB-33b (b): com SPEC.md na raiz do projeto, a leitura NAO cai no fallback', async () => {
    const { project, bugCtx, st } = await setupUpToPhase4();
    const legacySpec = path.join(projectPath, 'SPEC.md');
    fs.writeFileSync(legacySpec, '# SPEC DE UMA FEATURE ANTIGA', 'utf-8');

    const rec = makeCtx(() => {
      fs.writeFileSync(bugCtx.specPath, '# SPEC do bug', 'utf-8');
      return spawnResult('SPEC gerada');
    });
    await runBugPhase4Spec(rec.ctx, project.id, project, st);

    const after = getHarnessProject(project.id)!;
    const resolved = resolveSpecPath(after);
    expect(resolved).toBe(bugCtx.specPath);
    expect(resolved).not.toBe(legacySpec);
    expect(fs.readFileSync(resolved, 'utf-8')).toBe('# SPEC do bug');
  });

  it('TB-16: hard fail acionavel quando o SPEC nao e escrito no path esperado', async () => {
    const { project, bugCtx, st } = await setupUpToPhase4();
    const rec = makeCtx(() => spawnResult('nao escrevi nada'));

    await expect(runBugPhase4Spec(rec.ctx, project.id, project, st)).rejects.toThrow(bugCtx.specPath);
    await expect(runBugPhase4Spec(rec.ctx, project.id, project, st)).rejects.toThrow(/Reset phase 4/);

    expect(getHarnessProject(project.id)!.specPath).toBe('');
    expect(rec.advanced).toHaveLength(0);
  });
});


describe('Fase 5 — bug-spec-validator', () => {
  it('audita a SPEC do runDir e emite document-updated so quando o arquivo muda', async () => {
    const project = createBugProject({ ...BASE_CONFIG });
    const st = makeState();
    const rec1 = makeCtx((_a, _p, opts) => {
      (opts.onText as (c: string) => void)('ok');
      return spawnResult('ok');
    });
    await handleBugPhase1DiscoveryMessage(rec1.ctx, project.id, 'bug V', st, project);
    const withRun = getHarnessProject(project.id)!;
    const bugCtx = getBugContext(withRun)!;
    fs.writeFileSync(bugCtx.specPath, '# SPEC v1', 'utf-8');
    fs.writeFileSync(bugCtx.planoPath, '# Plano', 'utf-8');

    emitted.length = 0;
    const recNoEdit = makeCtx((_a, _p, opts) => {
      (opts.onText as (c: string) => void)('SPEC esta ok');
      return spawnResult('ok');
    });
    await handleBugPhase5SpecValidatorMessage(recNoEdit.ctx, project.id, 'valida ai', st, withRun);
    expect(recNoEdit.spawns[0].agentId).toBe('bug-spec-validator');
    expect(recNoEdit.spawns[0].prompt).toContain(bugCtx.specPath);
    expect(recNoEdit.spawns[0].prompt).toContain(bugCtx.planoPath);
    expect(
      emitted.filter((e) => e.channel === 'pipeline:document-updated'),
    ).toHaveLength(0);

    emitted.length = 0;
    const stEdit = makeState();
    const recEdit = makeCtx((_a, _p, opts) => {
      fs.writeFileSync(bugCtx.specPath, '# SPEC v2 corrigida', 'utf-8');
      (opts.onText as (c: string) => void)('corrigi a SPEC');
      return spawnResult('ok');
    });
    await handleBugPhase5SpecValidatorMessage(recEdit.ctx, project.id, 'corrige', stEdit, withRun);
    const docEvents = emitted.filter((e) => e.channel === 'pipeline:document-updated');
    expect(docEvents).toHaveLength(1);
    expect(docEvents[0].payload.path).toBe(bugCtx.specPath);
  });
});


describe('TB-22 / B-AC9 — permission profile e ausencia do spec builder proprio', () => {
  const handlerSrc = fs.readFileSync(
    path.join(repoRoot, 'electron/main/pipeline-engine/handlers/bug.ts'),
    'utf-8',
  );
  const runnerSrc = fs.readFileSync(
    path.join(repoRoot, 'electron/main/bug-analysis-runner.ts'),
    'utf-8',
  );

  it('TB-22: nenhum dos dois arquivos chama executeAgent nem passa `permission`', () => {
    for (const [label, src] of [['handlers/bug.ts', handlerSrc], ['bug-analysis-runner.ts', runnerSrc]] as const) {
      expect(src, label).not.toContain('executeAgent(');
      expect(src, label).not.toContain('permission:');
      expect(src, label).not.toContain('permissionMode');
      expect(src, label).not.toContain('bypassPermissions');
      expect(src, label).not.toContain('PERM_DEFAULT_WITH_GUARD');
    }
  });

  it('TB-22: todo spawn do Bug Pipe passa pelo spawnAgent do engine (PERM_BYPASS_NO_GUARD)', () => {
    expect(handlerSrc).toContain('ctx.spawnAgent(');
    expect(runnerSrc).toContain('this.pipelineEngine.spawnAgent(');
    const engineSrc = fs.readFileSync(
      path.join(repoRoot, 'electron/main/pipeline-engine/index.ts'),
      'utf-8',
    );
    expect(engineSrc.split('executeAgent({').length - 1).toBe(1);
    expect(engineSrc).toContain('permission: PERM_BYPASS_NO_GUARD');
  });

  it('B-AC9: o spec builder proprio do bug nao existe em electron/ nem src/', () => {
    const forbiddenId = ['bug', 'spec', 'builder'].join('-');
    const grep = (dir: string): string => {
      try {
        return execFileSync('grep', ['-rn', forbiddenId, dir], {
          cwd: repoRoot,
          encoding: 'utf-8',
        });
      } catch (err) {
        const code = (err as { status?: number }).status;
        if (code === 1) return '';
        throw err;
      }
    };
    expect(grep('electron/')).toBe('');
    expect(grep('src/')).toBe('');
  });

  it('DECISAO 8: a interface do ctx declara createBugAnalysisRunner e o builder implementa', () => {
    const ctxSrc = fs.readFileSync(
      path.join(repoRoot, 'electron/main/pipeline-engine/handlers/context.ts'),
      'utf-8',
    );
    const engineSrc = fs.readFileSync(
      path.join(repoRoot, 'electron/main/pipeline-engine/index.ts'),
      'utf-8',
    );
    expect(ctxSrc).toContain('createBugAnalysisRunner(): BugAnalysisRunner;');
    expect(engineSrc).toContain('createBugAnalysisRunner: () => new BugAnalysisRunner(this),');
  });
});
