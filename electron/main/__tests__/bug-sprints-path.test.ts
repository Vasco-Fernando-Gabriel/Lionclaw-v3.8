
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

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
vi.mock('../pipeline-shared/sdk-bootstrap', () => ({ ensureNodeInPath: vi.fn() }));

import {
  initDatabase,
  insertHarnessProject,
  getHarnessProject,
  updateHarnessProject,
  reconcileSeedAgent,
} from '../db';
import { HarnessEngine } from '../harness-engine';
import { harnessPlanner } from '../seed-agents';
import { ensureBugContext, getBugContext } from '../bug-paths';
import { ensureArchitectureReviewContext } from '../architecture-review-paths';
import { resolveHarnessSprintsPath } from '../pipeline-paths';
import type { HarnessProject, PipelineType } from '../../../src/types';


let tmpHome = '';
const projectDirs: string[] = [];

const PLANNER_JSON = JSON.stringify({
  project: {
    name: 'Bug Fix',
    config: { max_rounds_per_sprint: 3, evaluator_agent_id: 'harness-evaluator' },
  },
  sprints: [
    {
      index: 0,
      id: 'S1',
      name: 'Corrigir o bug',
      coder_agent_id: 'harness-coder',
      features: [{ id: 'F1', name: 'fix', acceptance_criteria: ['passa o teste de regressao'] }],
    },
  ],
  metadata: { version: 1, created_at: '2026-07-27T00:00:00Z', total_sprints: 1, total_features: 1 },
});

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-bug-sprints-home-'));
  state.home = tmpHome;
  initDatabase();
  reconcileSeedAgent(harnessPlanner, harnessPlanner.squad ?? 'harness');
});

afterAll(() => {
  for (const dir of [tmpHome, ...projectDirs]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
});

function makeProjectDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-bug-sprints-proj-'));
  projectDirs.push(dir);
  return dir;
}

function insertProject(pipelineType: PipelineType, projectPath: string): HarnessProject {
  const specPath = path.join(projectPath, 'SPEC.md');
  fs.writeFileSync(specPath, '# SPEC de correcao\n\nCorrigir o bug.\n', 'utf-8');
  return insertHarnessProject({
    name: `TB-33 ${pipelineType}`,
    description: '',
    projectPath,
    specPath,
    config: {
      maxRoundsPerSprint: 3,
      usePlaywright: false,
      evaluatorAgentId: 'harness-evaluator',
      plannerAgentId: harnessPlanner.id,
      stack: [],
    },
    pipelineType,
    pipelineDocsId: null,
  });
}

function makeEngine(): HarnessEngine {
  const engine = new HarnessEngine(() => null);
  (engine as unknown as { executeAgentWithSubagentControl: unknown }).executeAgentWithSubagentControl =
    vi.fn(async () => ({
      output: PLANNER_JSON,
      metrics: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        toolUses: 0,
        apiRequests: 1,
        costUsd: 0.01,
        durationMs: 42,
      },
      model: 'claude-opus-5',
      runtime: 'cloud',
      provider: 'anthropic',
    }));
  return engine;
}


describe('TB-33 (a): sprints do Bug Pipe caem no runDir, nao em docs/', () => {
  it('sprints_json_path === <runDir>/sprints-<runId>.json e o arquivo existe la', async () => {
    const projectPath = makeProjectDir();
    const project = insertProject('bug', projectPath);

    const { context } = ensureBugContext(project);
    updateHarnessProject(project.id, {
      config: { ...project.config, bug: { runId: context.runId } },
    });

    const engine = makeEngine();
    await engine.plan(project.id);

    const after = getHarnessProject(project.id)!;
    const bugCtx = getBugContext(after)!;

    expect(after.sprintsJsonPath).toBe(bugCtx.sprintsPath);
    expect(bugCtx.sprintsPath).toBe(
      path.join(bugCtx.runDir, `sprints-${bugCtx.runId}.json`),
    );
    expect(fs.existsSync(bugCtx.sprintsPath)).toBe(true);

    const legacy = resolveHarnessSprintsPath(after);
    expect(after.sprintsJsonPath).not.toBe(legacy);
    expect(fs.existsSync(legacy)).toBe(false);
  });
});


describe('TB-33 (b): bug sem config.bug.runId falha com erro acionavel', () => {
  it('plan() lanca citando a fase 1 / config.bug.runId, e nao grava sprints_json_path', async () => {
    const projectPath = makeProjectDir();
    const project = insertProject('bug', projectPath);

    const engine = makeEngine();
    await expect(engine.plan(project.id)).rejects.toThrow(/bug run context missing/i);

    await expect(engine.plan(project.id)).rejects.toThrow(/config\.bug\.runId/);

    const after = getHarnessProject(project.id)!;
    expect(after.sprintsJsonPath ?? '').toBe('');
  });
});


describe('TB-33 (c): os outros 5 tipos nao regridem', () => {
  it.each(['development', 'feature', 'security', 'development-v2'] as const)(
    '%s continua em resolveHarnessSprintsPath',
    async (pipelineType) => {
      const projectPath = makeProjectDir();
      const project = insertProject(pipelineType, projectPath);

      const engine = makeEngine();
      await engine.plan(project.id);

      const after = getHarnessProject(project.id)!;
      expect(after.sprintsJsonPath).toBe(resolveHarnessSprintsPath(after));
      expect(after.sprintsJsonPath).not.toContain(`${path.sep}pipelines${path.sep}bug${path.sep}`);
    },
  );

  it('architecture-review continua em ctx.sprintsPath (runDir do arch-review)', async () => {
    const projectPath = makeProjectDir();
    const project = insertProject('architecture-review', projectPath);
    const { context } = ensureArchitectureReviewContext(project);
    updateHarnessProject(project.id, {
      config: { ...project.config, architectureReview: { runId: context.runId } },
    });

    const engine = makeEngine();
    await engine.plan(project.id);

    const after = getHarnessProject(project.id)!;
    expect(after.sprintsJsonPath).toBe(context.sprintsPath);
    expect(after.sprintsJsonPath).toContain(
      `${path.sep}pipelines${path.sep}architecture-review${path.sep}`,
    );
  });
});
