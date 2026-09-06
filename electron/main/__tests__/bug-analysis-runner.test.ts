
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';


vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const emitted: Array<{ channel: string; payload: Record<string, unknown> }> = [];
vi.mock('../pipeline-shared/ipc-emitter', () => ({
  emitIPC: (channel: string, payload: unknown) => {
    emitted.push({ channel, payload: payload as Record<string, unknown> });
  },
}));

const dbCalls = {
  insertBug: [] as unknown[][],
  updateBug: [] as unknown[][],
  metrics: [] as Array<Record<string, unknown>>,
};
vi.mock('../db', () => ({
  insertSecurityAgentStatus: vi.fn(),
  updateSecurityAgentStatus: vi.fn(),
  getSecurityAgentStatuses: vi.fn(() => []),
  insertBugAnalysisAgentStatus: (...args: unknown[]) => { dbCalls.insertBug.push(args); },
  updateBugAnalysisAgentStatus: (...args: unknown[]) => { dbCalls.updateBug.push(args); },
  savePipelinePhaseMetrics: (row: Record<string, unknown>) => { dbCalls.metrics.push(row); },
}));

vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: vi.fn(async () => ({ model: 'claude-opus-5', runtime: 'cloud' })),
}));
vi.mock('../repo-profiler', () => ({ EXCLUDED_FROM_AUDIT_PATTERNS: [] }));
vi.mock('../pipeline-paths', () => ({ getPipelineDocsContext: vi.fn() }));
vi.mock('../permission-guard', () => ({ setActiveSecurityAuditPhase: vi.fn() }));
vi.mock('../pipeline-engine/provider-auth', () => ({ rethrowPipelinePause: vi.fn() }));
const persistMessageSpy = vi.fn();
vi.mock('../pipeline-shared/persist', () => ({ persistMessage: persistMessageSpy }));
vi.mock('../seed-agents/index', () => ({
  SECRETS_SCANNER_ID: 'security-secrets-scanner',
  AUTH_AUDITOR_ID: 'security-auth-auditor',
  ISOLATION_INSPECTOR_ID: 'security-isolation-inspector',
  DUPLICATION_DETECTOR_ID: 'security-duplication-detector',
  LOGIC_ANALYZER_ID: 'security-logic-analyzer',
  STANDARDS_CHECKER_ID: 'security-standards-checker',
  OWASP_SCANNER_ID: 'security-owasp-scanner',
  BUG_ROOT_CAUSE_ANALYST_ID: 'bug-root-cause-analyst',
  BUG_CONTEXT_HISTORIAN_ID: 'bug-context-historian',
  BUG_HYPOTHESIS_REFUTER_ID: 'bug-hypothesis-refuter',
}));

import { PipelinePausedError } from '../agent-runtime/types';
import {
  BugAnalysisRunner,
  BUG_ANALYSIS_AGENTS,
  buildBugAnalysisPrompt,
  resolveBugAnalysisOutputPath,
} from '../bug-analysis-runner';
import type { PipelineEngine } from '../pipeline-engine';
import type { BugContext } from '../bug-paths';


let tmpRoot = '';
let runDir = '';
let bugCtx: BugContext;

const RUN_ID = '20260727_101010-abc123';

function makeBugContext(root: string): BugContext {
  const dir = path.join(root, '.lionclaw', 'pipelines', 'bug', RUN_ID);
  fs.mkdirSync(dir, { recursive: true });
  const doc = (stem: string, ext: string) => path.join(dir, `${stem}-${RUN_ID}.${ext}`);
  return {
    runId: RUN_ID,
    runDir: dir,
    manifestPath: path.join(dir, 'manifest.json'),
    diagnosticoPath: doc('diagnostico', 'md'),
    analise01Path: doc('analise-01-root-cause', 'md'),
    analise02Path: doc('analise-02-historian', 'md'),
    analise03Path: doc('analise-03-refuter', 'md'),
    planoPath: doc('plano-de-correcao', 'md'),
    specPath: doc('SPEC', 'md'),
    sprintsPath: doc('sprints', 'json'),
  };
}

interface SpawnCall { agentId: string; prompt: string }

function makeEngine(
  impl: (agentId: string, prompt: string, opts: Record<string, unknown>) => Promise<unknown>,
): { engine: PipelineEngine; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const engine = {
    spawnAgent: vi.fn(async (agentId: string, prompt: string, opts: Record<string, unknown>) => {
      calls.push({ agentId, prompt });
      return impl(agentId, prompt, opts);
    }),
  } as unknown as PipelineEngine;
  return { engine, calls };
}

function okResult(output: string) {
  return {
    output,
    metrics: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: 2,
      apiRequests: 1,
      costUsd: 0.5,
      durationMs: 1234,
    },
    model: 'claude-opus-5',
    runtime: 'cloud' as const,
    provider: 'anthropic',
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-bug-runner-'));
  bugCtx = makeBugContext(tmpRoot);
  runDir = bugCtx.runDir;
  emitted.length = 0;
  dbCalls.insertBug.length = 0;
  dbCalls.updateBug.length = 0;
  dbCalls.metrics.length = 0;
  persistMessageSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function analiseFilesInRunDir(): string[] {
  return fs.readdirSync(runDir).filter((f) => f.startsWith('analise-0')).sort();
}


describe('BugAnalysisRunner — caminho feliz (TB-8, TB-9, TB-10, 4.7.2)', () => {
  async function runHappyPath() {
    fs.writeFileSync(bugCtx.diagnosticoPath, '# Diagnostico\n\nBotao trava.', 'utf-8');
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const { engine, calls } = makeEngine(async (agentId, _prompt, opts) => {
      (opts.onText as (c: string) => void)(`texto de ${agentId}`);
      (opts.onToolUse as (t: string) => void)('Read');
      return okResult(`saida de ${agentId}`);
    });
    const runner = new BugAnalysisRunner(engine);
    const result = await runner.run({
      project: { id: 'p-bug', projectPath: tmpRoot },
      bugCtx,
      graphBlock: '## Contexto do grafo de codigo (CodeGraph)\n\nNAO DISPONIVEL.',
      abortController: new AbortController(),
    });
    return { calls, result, writeSpy };
  }

  it('TB-8: dispara 3 spawnAgent com 3 agentIds distintos', async () => {
    const { calls } = await runHappyPath();
    expect(calls).toHaveLength(3);
    const ids = calls.map((c) => c.agentId).sort();
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual([
      'bug-context-historian',
      'bug-hypothesis-refuter',
      'bug-root-cause-analyst',
    ]);
  });

  it('TB-9: pipeline:stream sai com 3 pares auditAgentId/auditAgentSlug distintos', async () => {
    await runHappyPath();
    const streamChunks = emitted
      .filter((e) => e.channel === 'pipeline:stream' && e.payload.auditAgentId !== undefined);
    expect(streamChunks.length).toBeGreaterThanOrEqual(3);

    const pairs = new Set(
      streamChunks.map((e) => `${String(e.payload.auditAgentId)}::${String(e.payload.auditAgentSlug)}`),
    );
    expect(pairs.size).toBe(3);
    expect([...pairs].sort()).toEqual([
      'bug-context-historian::historian',
      'bug-hypothesis-refuter::refuter',
      'bug-root-cause-analyst::root-cause',
    ]);
    expect(streamChunks.every((e) => e.payload.phase === 2)).toBe(true);
  });

  it('TB-10: exatamente 3 writeFileSync no runDir, com os paths do BugContext', async () => {
    const { writeSpy } = await runHappyPath();

    const writtenPaths = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(writtenPaths).toHaveLength(3);
    expect(writtenPaths.sort()).toEqual(
      [bugCtx.analise01Path, bugCtx.analise02Path, bugCtx.analise03Path].sort(),
    );
    for (const p of writtenPaths) {
      expect(path.dirname(p)).toBe(runDir);
      expect(path.basename(p)).toContain(RUN_ID);
    }
    expect(analiseFilesInRunDir()).toHaveLength(3);
    expect(fs.readFileSync(bugCtx.analise01Path, 'utf-8')).toBe('saida de bug-root-cause-analyst');
    expect(fs.readFileSync(bugCtx.analise02Path, 'utf-8')).toBe('saida de bug-context-historian');
    expect(fs.readFileSync(bugCtx.analise03Path, 'utf-8')).toBe('saida de bug-hypothesis-refuter');
  });

  it('TB-10: o runner NAO chama persistMessage (nem em runtime, nem no fonte)', async () => {
    await runHappyPath();
    expect(persistMessageSpy).not.toHaveBeenCalled();

    const source = fs.readFileSync(
      path.join(__dirname, '..', 'bug-analysis-runner.ts'),
      'utf-8',
    );
    const mentions = source.split('\n').filter((l) => l.includes('persistMessage'));
    expect(mentions.every((l) => l.trim().startsWith('*') || l.trim().startsWith('//'))).toBe(true);
    expect(source.includes('persistMessage(')).toBe(false);
  });

  it('4.7.2: grava UMA linha de metrica por agente, phase 2, sprintIndex = order', async () => {
    await runHappyPath();
    const perAgent = dbCalls.metrics.filter((m) => m.phaseNumber === 2);
    expect(perAgent).toHaveLength(3);
    expect(perAgent.map((m) => m.sprintIndex).sort()).toEqual([1, 2, 3]);
    expect(
      perAgent.map((m) => `${String(m.agentId)}:${String(m.sprintIndex)}`).sort(),
    ).toEqual([
      'bug-context-historian:2',
      'bug-hypothesis-refuter:3',
      'bug-root-cause-analyst:1',
    ]);
    expect(perAgent.some((m) => m.sprintIndex === -1)).toBe(false);
    expect(perAgent.some((m) => m.agentId === 'bug-analysis-multi')).toBe(false);
    for (const m of perAgent) {
      expect(m.status).toBe('completed');
      expect(m.model).toBe('claude-opus-5');
      expect(m.runtime).toBe('cloud');
      expect(m.costUsd).toBe(0.5);
    }
  });

  it('telemetria (4.7): 3 emissoes de pipeline:audit-agent-progress completed, uma por agente', async () => {
    await runHappyPath();
    const progress = emitted.filter((e) => e.channel === 'pipeline:audit-agent-progress');
    const completed = progress.filter((e) => e.payload.status === 'completed');
    expect(completed).toHaveLength(3);
    expect(new Set(completed.map((e) => String(e.payload.agentId))).size).toBe(3);
    expect(new Set(completed.map((e) => String(e.payload.slug))).size).toBe(3);

    const SECURITY_PAYLOAD_KEYS = [
      'projectId', 'agentId', 'slug', 'agentName', 'status', 'filesAnalyzed',
      'additionalFilesAfterStart', 'toolCallsCount', 'costUsd', 'durationMs',
      'findingsCount', 'model', 'runtime',
    ].sort();
    for (const e of completed) {
      expect(Object.keys(e.payload).sort()).toEqual(SECURITY_PAYLOAD_KEYS);
      expect(e.payload.runtime).toBe('cloud');
    }
  });

  it('status por agente: insert dos 3 com runId + update running/completed com runId', async () => {
    await runHappyPath();
    expect(dbCalls.insertBug).toHaveLength(1);
    const [projectId, runId, agents] = dbCalls.insertBug[0] as [string, string, Array<Record<string, string>>];
    expect(projectId).toBe('p-bug');
    expect(runId).toBe(RUN_ID);
    expect(agents.map((a) => a.agentSlug).sort()).toEqual(['historian', 'refuter', 'root-cause']);

    const completedUpdates = dbCalls.updateBug.filter(
      (args) => (args[3] as { status?: string }).status === 'completed',
    );
    expect(completedUpdates).toHaveLength(3);
    for (const args of completedUpdates) {
      expect(args[1]).toBe(RUN_ID);
      expect(String((args[3] as { outputFile?: string }).outputFile)).toContain(RUN_ID);
    }
  });
});


describe('BugAnalysisRunner — pool, abort e pausa (TB-11)', () => {
  it('roda os 3 em ONDA UNICA (pico de concorrencia = 3)', async () => {
    fs.writeFileSync(bugCtx.diagnosticoPath, 'conteudo', 'utf-8');
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const started: string[] = [];

    const { engine } = makeEngine(async (agentId) => {
      started.push(agentId);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return okResult(`saida ${agentId}`);
    });

    const runner = new BugAnalysisRunner(engine);
    const promise = runner.run({
      project: { id: 'p-bug', projectPath: tmpRoot },
      bugCtx,
      graphBlock: 'bloco',
      abortController: new AbortController(),
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(started).toHaveLength(3);
    expect(peak).toBe(3);

    releases.forEach((r) => r());
    await promise;
    expect(peak).toBe(3);
  });

  it('controller ja abortado: nenhum spawn e nenhum arquivo escrito', async () => {
    fs.writeFileSync(bugCtx.diagnosticoPath, 'conteudo', 'utf-8');
    const { engine, calls } = makeEngine(async () => okResult('nunca'));
    const controller = new AbortController();
    controller.abort();

    const runner = new BugAnalysisRunner(engine);
    const result = await runner.run({
      project: { id: 'p-bug', projectPath: tmpRoot },
      bugCtx,
      graphBlock: 'bloco',
      abortController: controller,
    });

    expect(calls).toHaveLength(0);
    expect(result.writtenPaths).toEqual([]);
    expect(analiseFilesInRunDir()).toEqual([]);
  });

  it('PipelinePausedError propaga e o agente volta para pending', async () => {
    fs.writeFileSync(bugCtx.diagnosticoPath, 'conteudo', 'utf-8');
    const pause = new PipelinePausedError('auth necessaria', 'grok-auth');
    const { engine } = makeEngine(async (agentId) => {
      if (agentId === 'bug-root-cause-analyst') throw pause;
      return okResult(`saida ${agentId}`);
    });

    const runner = new BugAnalysisRunner(engine);
    await expect(
      runner.run({
        project: { id: 'p-bug', projectPath: tmpRoot },
        bugCtx,
        graphBlock: 'bloco',
        abortController: new AbortController(),
      }),
    ).rejects.toBe(pause);

    const pendingBack = dbCalls.updateBug.filter(
      (args) => args[2] === 'bug-root-cause-analyst'
        && (args[3] as { status?: string }).status === 'pending',
    );
    expect(pendingBack).toHaveLength(1);
  });
});


describe('BugAnalysisRunner — hard fail do diagnostico (TB-11b / B-AC23)', () => {
  for (const scenario of ['ausente', 'vazio apos trim'] as const) {
    it(`diagnostico ${scenario}: falha com path absoluto, ZERO spawns, ZERO arquivos`, async () => {
      if (scenario === 'vazio apos trim') {
        fs.writeFileSync(bugCtx.diagnosticoPath, '   \n\t\n  ', 'utf-8');
      }
      const spawnSpy = vi.fn();
      const engine = { spawnAgent: spawnSpy } as unknown as PipelineEngine;
      const runner = new BugAnalysisRunner(engine);

      await expect(
        runner.run({
          project: { id: 'p-bug', projectPath: tmpRoot },
          bugCtx,
          graphBlock: 'bloco',
          abortController: new AbortController(),
        }),
      ).rejects.toThrow(bugCtx.diagnosticoPath);

      await expect(
        runner.run({
          project: { id: 'p-bug', projectPath: tmpRoot },
          bugCtx,
          graphBlock: 'bloco',
          abortController: new AbortController(),
        }),
      ).rejects.toThrow(/Resete a fase 1/);

      expect(spawnSpy).not.toHaveBeenCalled();
      expect(analiseFilesInRunDir()).toEqual([]);
      expect(dbCalls.insertBug).toHaveLength(0);
      expect(path.isAbsolute(bugCtx.diagnosticoPath)).toBe(true);
    });
  }
});


describe('buildBugAnalysisPrompt / resolveBugAnalysisOutputPath', () => {
  it('injeta o conteudo integral do diagnostico, o path absoluto e o bloco do grafo', () => {
    const prompt = buildBugAnalysisPrompt({
      projectPath: '/tmp/projeto',
      diagnosticoPath: '/tmp/projeto/.lionclaw/pipelines/bug/RID/diagnostico-RID.md',
      diagnosticoContent: 'CONTEUDO INTEGRAL DO DIAGNOSTICO',
      graphBlock: '## Contexto do grafo de codigo (CodeGraph)\n\nNAO DISPONIVEL.',
    });
    expect(prompt).toContain('/tmp/projeto/.lionclaw/pipelines/bug/RID/diagnostico-RID.md');
    expect(prompt).toContain('CONTEUDO INTEGRAL DO DIAGNOSTICO');
    expect(prompt).toContain('NAO DISPONIVEL');
    expect(prompt).toContain('Voce NAO escreve arquivo nenhum');
    expect(prompt).not.toContain('root-cause');
    expect(prompt).not.toContain('historian');
    expect(prompt).not.toContain('refuter');
  });

  it('mapeia order 1/2/3 para os paths do BugContext', () => {
    expect(resolveBugAnalysisOutputPath(bugCtx, 1)).toBe(bugCtx.analise01Path);
    expect(resolveBugAnalysisOutputPath(bugCtx, 2)).toBe(bugCtx.analise02Path);
    expect(resolveBugAnalysisOutputPath(bugCtx, 3)).toBe(bugCtx.analise03Path);
    expect(BUG_ANALYSIS_AGENTS.map((a) => a.order)).toEqual([1, 2, 3]);
  });
});
