import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

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

import { initDatabase, getDb, insertHarnessProject, updateHarnessProject } from '../db';
import { registerPipelineHandlers } from '../ipc/pipeline';
import type { HarnessProject } from '../../../src/types';

const BASE_CONFIG: HarnessProject['config'] = {
  maxRoundsPerSprint: 3,
  usePlaywright: false,
  evaluatorAgentId: 'harness-evaluator',
  plannerAgentId: 'harness-planner',
  stack: [],
};

let projectPath = '';

function createProject(
  pipelineType: HarnessProject['pipelineType'],
  config: HarnessProject['config'] = { ...BASE_CONFIG },
): HarnessProject {
  return insertHarnessProject({
    name: `transport-${pipelineType}-${Math.random().toString(16).slice(2, 8)}`,
    description: '',
    projectPath,
    specPath: '',
    config,
    pipelineType,
  });
}

function getProject(projectId: string): Record<string, unknown> {
  const handler = handlers.get('pipeline:get-project');
  if (!handler) throw new Error('handler pipeline:get-project nao registrado');
  return handler({}, projectId) as Record<string, unknown>;
}

function listProjects(): Array<Record<string, unknown>> {
  const handler = handlers.get('pipeline:list-projects');
  if (!handler) throw new Error('handler pipeline:list-projects nao registrado');
  return handler({}) as Array<Record<string, unknown>>;
}

function metadataOf(payload: Record<string, unknown>): Record<string, unknown> {
  return (payload.metadata ?? {}) as Record<string, unknown>;
}

beforeAll(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-bug-transport-home-'));
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-bug-transport-proj-'));
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
  for (const dir of [state.home, projectPath]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe('pipeline:get-project transporta metadata.bugOutcome', () => {
  it("desfecho 'no-bug' chega no metadata", () => {
    const project = createProject('bug');
    updateHarnessProject(project.id, {
      config: { ...BASE_CONFIG, bug: { runId: '20260727_101010-a1b2c3', outcome: 'no-bug' } },
    });

    expect(metadataOf(getProject(project.id)).bugOutcome).toBe('no-bug');
  });

  it("desfecho 'fix' chega no metadata", () => {
    const project = createProject('bug');
    updateHarnessProject(project.id, {
      config: { ...BASE_CONFIG, bug: { runId: 'r2', outcome: 'fix' } },
    });

    expect(metadataOf(getProject(project.id)).bugOutcome).toBe('fix');
  });

  it('projeto bug SEM desfecho gravado nao ganha a chave', () => {
    const project = createProject('bug');
    updateHarnessProject(project.id, {
      config: { ...BASE_CONFIG, bug: { runId: 'r3' } },
    });

    expect(metadataOf(getProject(project.id)).bugOutcome).toBeUndefined();
  });

  it('projeto security nao ganha bugOutcome mesmo com config.bug plantado', () => {
    const project = createProject('security');
    updateHarnessProject(project.id, {
      config: { ...BASE_CONFIG, bug: { runId: 'r4', outcome: 'no-bug' } },
    });

    expect(metadataOf(getProject(project.id)).bugOutcome).toBeUndefined();
  });

  it('projeto development nao ganha bugOutcome', () => {
    const project = createProject('development');
    expect(metadataOf(getProject(project.id)).bugOutcome).toBeUndefined();
  });
});

describe('pipeline:list-projects transporta metadata.bugOutcome', () => {
  it('so o projeto bug com desfecho carrega a chave', () => {
    const bugWithOutcome = createProject('bug');
    updateHarnessProject(bugWithOutcome.id, {
      config: { ...BASE_CONFIG, bug: { runId: 'r5', outcome: 'no-bug' } },
    });
    const bugWithoutOutcome = createProject('bug');
    const feature = createProject('feature');

    const rows = listProjects();
    const byId = new Map(rows.map((r) => [r.id as string, r]));

    expect(metadataOf(byId.get(bugWithOutcome.id)!).bugOutcome).toBe('no-bug');
    expect(metadataOf(byId.get(bugWithoutOutcome.id)!).bugOutcome).toBeUndefined();
    expect(metadataOf(byId.get(feature.id)!).bugOutcome).toBeUndefined();

    expect(metadataOf(byId.get(bugWithOutcome.id)!).startPhase).toBe(1);
  });
});
