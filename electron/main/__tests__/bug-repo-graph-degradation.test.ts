
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: vi.fn() }));

const graphMock = vi.hoisted(() => ({
  addRepositoryCalls: [] as string[],
  minimalContextCalls: [] as Array<{ rootPath: string; repositoryId: string; task: string }>,
  addRepositoryResult: null as unknown,
  renderedMarkdown: '### GRAFO\n- arquivo relevante: src/foo.ts',
}));

vi.mock('../ipc/repo-graph', () => ({
  getRepoGraphEngine: () => ({
    addRepository: async (rawPath: string) => {
      graphMock.addRepositoryCalls.push(rawPath);
      return graphMock.addRepositoryResult ?? { error: 'nao registrado' };
    },
    asReader: () => ({
      minimalContext: async (input: { rootPath: string; repositoryId: string; task: string }) => {
        graphMock.minimalContextCalls.push(input);
        return {
          repositoryId: input.repositoryId,
          rootPath: input.rootPath,
          files: [],
          symbols: [],
          renderedMarkdown: graphMock.renderedMarkdown,
        };
      },
    }),
  }),
}));

import {
  initDatabase,
  getDb,
  insertHarnessProject,
  getHarnessProject,
  getPipelinePhaseMessages,
  upsertLocalRepository,
  updateLocalRepositoryGraphState,
} from '../db';
import { getBugContext, readBugManifest } from '../bug-paths';
import { validateRepoRootPath } from '../repo-graph/validate-root';
import {
  buildBugGraphBlock,
  handleBugPhase1DiscoveryMessage,
} from '../pipeline-engine/handlers/bug';
import type { PipelineEngineContext, HandlerPhaseState, SpawnAgentResult } from '../pipeline-engine/handlers/context';
import type { HarnessProject } from '../../../src/types';


const BASE_CONFIG: HarnessProject['config'] = {
  maxRoundsPerSprint: 5,
  usePlaywright: false,
  evaluatorAgentId: 'harness-evaluator',
  plannerAgentId: 'harness-planner',
  stack: [],
};

function makeState(): HandlerPhaseState {
  return {
    abortController: new AbortController(),
    continueSessions: new Map(),
    currentPhase: 1,
    status: 'running',
  };
}

function spawnResult(): SpawnAgentResult {
  return {
    output: 'ok',
    metrics: {
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
      toolUses: 0, apiRequests: 1, costUsd: 0, durationMs: 1,
    },
    model: 'claude-opus-5',
    runtime: 'cloud',
    provider: 'anthropic',
  };
}

function makeCtx(): { ctx: PipelineEngineContext; prompts: string[] } {
  const prompts: string[] = [];
  const ctx = {
    spawnAgent: async (_agentId: string, prompt: string, opts: Record<string, unknown>) => {
      prompts.push(prompt);
      (opts.onText as (c: string) => void)('resposta do discovery');
      return spawnResult();
    },
    accumulateMetrics: () => { /* noop */ },
    buildPriorMessagesForPhase: () => undefined,
    makeConversationOnText:
      (_p: string, _ph: number, acc: { text: string; completed: boolean }) =>
        (chunk: string) => { acc.text += chunk; },
    PHASE_COMPLETE_MARKER: '[PHASE_COMPLETE]',
  } as unknown as PipelineEngineContext;
  return { ctx, prompts };
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

function registerReadyRepo(canonicalRootPath: string, gitRoot: string | null): string {
  const repo = upsertLocalRepository({
    id: crypto.randomUUID(),
    name: path.basename(canonicalRootPath),
    rootPath: canonicalRootPath,
    canonicalRootPath,
    gitRoot,
  });
  updateLocalRepositoryGraphState(repo.id, {
    status: 'ready',
    graphPath: `${canonicalRootPath}/.codegraph/codegraph.db`,
  });
  return repo.id;
}

let projectPath = '';

beforeAll(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-bug-graph-home-'));
  initDatabase();
});

afterAll(() => {
  try { getDb().close(); } catch { /* handle ja invalido */ }
  fs.rmSync(state.home, { recursive: true, force: true });
});

beforeEach(() => {
  graphMock.addRepositoryCalls.length = 0;
  graphMock.minimalContextCalls.length = 0;
  graphMock.addRepositoryResult = null;
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-bug-graph-proj-'));
  initGitRepo(projectPath);
});


describe('TB-18 (a) — sem grafo, o bloco e o de degradacao com instrucao de grep', () => {
  it('buildBugGraphBlock devolve NAO DISPONIVEL + instrucao de Grep/Glob/Read', async () => {
    const graph = await buildBugGraphBlock(projectPath, 'botao trava');
    expect(graph.available).toBe(false);
    expect(graph.block).toContain('## Contexto do grafo de codigo (CodeGraph)');
    expect(graph.block).toContain('NAO DISPONIVEL');
    expect(graph.block).toContain('Investigue com Grep, Glob e Read');
    expect(graph.reason).toBe('sem repositorio registrado');
    expect(graphMock.minimalContextCalls).toHaveLength(0);
  });

  it('o user message da fase 1 carrega o bloco de degradacao', async () => {
    const project = insertHarnessProject({
      name: 'bug sem grafo', projectPath, specPath: '', config: { ...BASE_CONFIG }, pipelineType: 'bug',
    });
    const { ctx, prompts } = makeCtx();
    await handleBugPhase1DiscoveryMessage(ctx, project.id, 'o botao trava', makeState(), project);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('NAO DISPONIVEL');
    expect(prompts[0]).toContain('Investigue com Grep, Glob e Read');
  });
});

describe('TB-18 (b) — com grafo ready, o bloco e o do minimalContext', () => {
  it('injeta o markdown do reader e chama minimalContext com o canonical root', async () => {
    const canonical = validateRepoRootPath(projectPath);
    if ('error' in canonical) throw new Error(canonical.error);
    const repoId = registerReadyRepo(canonical.canonicalRootPath, canonical.gitRoot);

    const graph = await buildBugGraphBlock(projectPath, 'botao trava');
    expect(graph.available).toBe(true);
    expect(graph.reason).toBeUndefined();
    expect(graph.block).toContain('Status do grafo: ready');
    expect(graph.block).toContain('### GRAFO');
    expect(graph.block).not.toContain('NAO DISPONIVEL');

    expect(graphMock.minimalContextCalls).toHaveLength(1);
    expect(graphMock.minimalContextCalls[0].rootPath).toBe(canonical.canonicalRootPath);
    expect(graphMock.minimalContextCalls[0].repositoryId).toBe(repoId);
    expect(graphMock.minimalContextCalls[0].task).toBe('botao trava');
    expect(graphMock.addRepositoryCalls).toHaveLength(0);
  });

  it('grafo `building` degrada com o motivo "indexacao em curso"', async () => {
    const canonical = validateRepoRootPath(projectPath);
    if ('error' in canonical) throw new Error(canonical.error);
    const repo = upsertLocalRepository({
      id: crypto.randomUUID(),
      name: 'x',
      rootPath: projectPath,
      canonicalRootPath: canonical.canonicalRootPath,
      gitRoot: canonical.gitRoot,
    });
    updateLocalRepositoryGraphState(repo.id, { status: 'building' });

    const graph = await buildBugGraphBlock(projectPath, 'tarefa');
    expect(graph.available).toBe(false);
    expect(graph.reason).toBe('indexacao em curso');
    expect(graphMock.minimalContextCalls).toHaveLength(0);
  });

  it('repo registrado sem grafo (`absent`) degrada com o motivo "grafo nao criado"', async () => {
    const canonical = validateRepoRootPath(projectPath);
    if ('error' in canonical) throw new Error(canonical.error);
    upsertLocalRepository({
      id: crypto.randomUUID(),
      name: 'x',
      rootPath: projectPath,
      canonicalRootPath: canonical.canonicalRootPath,
      gitRoot: canonical.gitRoot,
    });

    const graph = await buildBugGraphBlock(projectPath, 'tarefa');
    expect(graph.available).toBe(false);
    expect(graph.reason).toBe('grafo nao criado');
  });
});


describe('TB-18 (c) — aviso duravel em pipeline_messages e estado no manifest', () => {
  it('sem grafo: o aviso sobrevive a um refetch do historico e o manifest marca graphAvailable false', async () => {
    const project = insertHarnessProject({
      name: 'bug aviso', projectPath, specPath: '', config: { ...BASE_CONFIG }, pipelineType: 'bug',
    });
    const { ctx } = makeCtx();
    await handleBugPhase1DiscoveryMessage(ctx, project.id, 'bug com aviso', makeState(), project);

    const history = getPipelinePhaseMessages(project.id, 1);
    const notice = history.find((m) => m.content.includes('NAO DISPONIVEL neste run'));
    expect(notice).toBeDefined();
    expect(notice!.role).toBe('assistant');
    expect(notice!.content).toContain('modo grep');
    expect(notice!.content).toContain('resposta do discovery');

    const rows = getDb().prepare(
      `SELECT role, content FROM pipeline_messages
       WHERE project_id = ? AND phase_number = 1 ORDER BY id ASC`,
    ).all(project.id) as Array<{ role: string; content: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].content).toContain('NAO DISPONIVEL neste run');
    expect(rows[0].content).not.toContain('resposta do discovery');
    expect(rows[1].content).toBe('resposta do discovery');

    const after = getHarnessProject(project.id)!;
    const manifest = readBugManifest(after)!;
    expect(manifest.graphAvailable).toBe(false);
    expect(manifest.graphUnavailableReason).toBe('sem repositorio registrado');
  });

  it('com grafo ready: nenhum aviso e emitido e o manifest marca graphAvailable true', async () => {
    const canonical = validateRepoRootPath(projectPath);
    if ('error' in canonical) throw new Error(canonical.error);
    registerReadyRepo(canonical.canonicalRootPath, canonical.gitRoot);

    const project = insertHarnessProject({
      name: 'bug com grafo', projectPath, specPath: '', config: { ...BASE_CONFIG }, pipelineType: 'bug',
    });
    const { ctx, prompts } = makeCtx();
    await handleBugPhase1DiscoveryMessage(ctx, project.id, 'bug com grafo', makeState(), project);

    const history = getPipelinePhaseMessages(project.id, 1);
    expect(history.some((m) => m.content.includes('NAO DISPONIVEL'))).toBe(false);
    expect(prompts[0]).toContain('Status do grafo: ready');

    const after = getHarnessProject(project.id)!;
    const manifest = readBugManifest(after)!;
    expect(manifest.graphAvailable).toBe(true);
    expect(manifest.graphUnavailableReason).toBeUndefined();
  });
});


describe('TB-18 (d) — projeto em SUBDIRETORIO de repo git', () => {
  it('resolve o repositorio pelo canonical root (git toplevel), nao por path.resolve', async () => {
    const subdir = path.join(projectPath, 'packages', 'app');
    fs.mkdirSync(subdir, { recursive: true });

    const canonicalOfSub = validateRepoRootPath(subdir);
    if ('error' in canonicalOfSub) throw new Error(canonicalOfSub.error);
    expect(canonicalOfSub.canonicalRootPath).not.toBe(path.resolve(subdir));
    expect(canonicalOfSub.canonicalRootPath).toBe(fs.realpathSync(projectPath));

    const repoId = registerReadyRepo(canonicalOfSub.canonicalRootPath, canonicalOfSub.gitRoot);

    const graph = await buildBugGraphBlock(subdir, 'bug no subdiretorio');
    expect(graph.available).toBe(true);
    expect(graph.block).toContain('### GRAFO');
    expect(graphMock.minimalContextCalls).toHaveLength(1);
    expect(graphMock.minimalContextCalls[0].repositoryId).toBe(repoId);
    expect(graphMock.minimalContextCalls[0].rootPath).toBe(canonicalOfSub.canonicalRootPath);
    expect(graphMock.addRepositoryCalls).toHaveLength(0);
  });
});


describe('TB-18 (e) — run dirigido pelo orquestrador com a PipelinePage fechada', () => {
  it('o handler registra o repositorio, degrada para grep e o aviso manda abrir a pagina', async () => {
    const project = insertHarnessProject({
      name: 'bug dirigido', projectPath, specPath: '', config: { ...BASE_CONFIG }, pipelineType: 'bug',
    });
    const { ctx, prompts } = makeCtx();
    await handleBugPhase1DiscoveryMessage(ctx, project.id, 'bug dirigido pelo orquestrador', makeState(), project);

    expect(graphMock.addRepositoryCalls).toEqual([projectPath]);
    expect(prompts[0]).toContain('NAO DISPONIVEL');
    const history = getPipelinePhaseMessages(project.id, 1);
    const notice = history.find((m) => m.content.includes('NAO DISPONIVEL neste run'));
    expect(notice).toBeDefined();
    expect(notice!.content).toContain('abra a pagina do pipeline');
  });

  it('quando o addRepository do handler resolve um repo ready, o grafo entra sem modal', async () => {
    const canonical = validateRepoRootPath(projectPath);
    if ('error' in canonical) throw new Error(canonical.error);
    graphMock.addRepositoryResult = {
      id: 'repo-do-handler',
      name: 'proj',
      rootPath: projectPath,
      canonicalRootPath: canonical.canonicalRootPath,
      gitRoot: canonical.gitRoot,
      provider: 'codegraph',
      graphPath: `${canonical.canonicalRootPath}/.codegraph/codegraph.db`,
      status: 'ready',
      indexedCommit: null,
      indexedWorktreeHash: null,
      lastIndexedAt: null,
      statsJson: null,
      graphPromptSuppressedGlobal: false,
      settingsJson: '{}',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    };

    const project = insertHarnessProject({
      name: 'bug dirigido com grafo', projectPath, specPath: '', config: { ...BASE_CONFIG }, pipelineType: 'bug',
    });
    const { ctx, prompts } = makeCtx();
    await handleBugPhase1DiscoveryMessage(ctx, project.id, 'bug', makeState(), project);

    expect(graphMock.addRepositoryCalls).toEqual([projectPath]);
    expect(prompts[0]).toContain('Status do grafo: ready');
    expect(getPipelinePhaseMessages(project.id, 1).some((m) => m.content.includes('NAO DISPONIVEL'))).toBe(false);

    const bugCtx = getBugContext(getHarnessProject(project.id)!)!;
    expect(fs.existsSync(bugCtx.manifestPath)).toBe(true);
    expect(readBugManifest(getHarnessProject(project.id)!)!.graphAvailable).toBe(true);
  });
});
