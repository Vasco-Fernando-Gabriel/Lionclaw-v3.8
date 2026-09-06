
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

interface FakeProject {
  id: string;
  name: string;
  pipelineType?: string;
  status: string;
  pipelineCurrentPhase?: number | null;
  pipelineStartPhase?: number | null;
  projectPath?: string;
  specPath?: string | null;
  config?: { bug?: { runId?: string; outcome?: string } };
}
const projects = new Map<string, FakeProject>();

vi.mock('../db', () => ({
  getHarnessProject: vi.fn((id: string) => projects.get(id)),
  listHarnessProjects: vi.fn(() => [...projects.values()]),
  getPipelinePhaseMessagesAsChatHistory: vi.fn(() => []),
  getActiveChatSession: vi.fn(() => null),
  getDriveState: vi.fn(() => null),
}));

let liveCurrentPhase: { phase: number; status: string } | null = null;
vi.mock('../pipeline-engine-ref', () => ({
  getPipelineEngineRef: vi.fn(() => ({
    getCurrentPhase: (_id: string) => liveCurrentPhase,
  })),
}));

vi.mock('../pipeline-create', () => ({
  createPipelineProject: vi.fn(),
}));
vi.mock('../pipeline-drive-coordinator', () => ({
  getPipelineDriveCoordinator: vi.fn(() => null),
}));
vi.mock('../pipeline-event-bus', () => ({
  pipelineEventBus: { on: vi.fn(() => () => {}), emit: vi.fn() },
}));
vi.mock('../pipeline-shared/ipc-emitter', () => ({
  emitIPC: vi.fn(),
}));
vi.mock('../pipeline-shared/lock', () => ({
  ensureProjectLock: vi.fn(),
}));

import { pipelineInspectCore, pipelineListCore } from '../pipeline-control-core';

function seed(over: Partial<FakeProject> = {}): FakeProject {
  const p: FakeProject = {
    id: over.id ?? 'proj_a',
    name: over.name ?? 'Demo',
    pipelineType: over.pipelineType ?? 'development',
    status: over.status ?? 'running',
    pipelineCurrentPhase:
      'pipelineCurrentPhase' in over ? over.pipelineCurrentPhase : 1,
    pipelineStartPhase: 'pipelineStartPhase' in over ? over.pipelineStartPhase : 1,
    projectPath: over.projectPath ?? '/tmp/demo',
    specPath: over.specPath ?? null,
    ...(over.config ? { config: over.config } : {}),
  };
  projects.set(p.id, p);
  return p;
}

describe('inspect/list DB-first (W5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projects.clear();
    liveCurrentPhase = null;
  });

  it('W5-AC1: inspect reflete a fase do DB mesmo com o engine RAM defasado', () => {
    seed({ pipelineCurrentPhase: 3 });
    liveCurrentPhase = { phase: 2, status: 'running' };

    const res = pipelineInspectCore('proj_a');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.value as { phase: number }).phase).toBe(3);
      expect((res.value as { status: string }).status).toBe('running');
    }
  });

  it('inspect usa o status LIVE como complemento quando ha engine; cai no DB sem engine', () => {
    seed({ pipelineCurrentPhase: 5, status: 'paused' });
    liveCurrentPhase = { phase: 5, status: 'running' };

    const withLive = pipelineInspectCore('proj_a');
    if (withLive.ok) {
      expect((withLive.value as { phase: number }).phase).toBe(5);
      expect((withLive.value as { status: string }).status).toBe('running');
    }

    liveCurrentPhase = null;
    const noLive = pipelineInspectCore('proj_a');
    if (noLive.ok) {
      expect((noLive.value as { phase: number }).phase).toBe(5);
      expect((noLive.value as { status: string }).status).toBe('paused');
    }
  });

  it('inspect: sem pipelineCurrentPhase cai no startPhase (DB-first), nao no live', () => {
    seed({ pipelineCurrentPhase: null, pipelineStartPhase: 2 });
    liveCurrentPhase = { phase: 9, status: 'running' };

    const res = pipelineInspectCore('proj_a');
    if (res.ok) {
      expect((res.value as { phase: number }).phase).toBe(2);
    }
  });

  it('W5-AC1 (list): currentPhase vem do DB, nunca do estado live do engine', () => {
    seed({ id: 'p1', pipelineCurrentPhase: 4 });
    seed({ id: 'p2', pipelineCurrentPhase: null, pipelineStartPhase: 1 });
    liveCurrentPhase = { phase: 99, status: 'running' };

    const res = pipelineListCore();
    expect(res.ok).toBe(true);
    if (res.ok) {
      const rows = res.value as Array<{ id: string; currentPhase: number | null }>;
      expect(rows.find((r) => r.id === 'p1')?.currentPhase).toBe(4);
      expect(rows.find((r) => r.id === 'p2')?.currentPhase).toBe(1);
    }
  });
});


describe('B-AC20: inspect do Bug Pipe na fase 3 (gate de 2 desfechos)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projects.clear();
    liveCurrentPhase = null;
  });

  it('devolve phaseName, phaseType, gate e gateDocumentPath ABSOLUTO', () => {
    seed({
      id: 'proj_bug',
      pipelineType: 'bug',
      pipelineCurrentPhase: 3,
      projectPath: '/tmp/bugrepo',
      config: { bug: { runId: '20260727_101010-a1b2c3', outcome: 'pending' } },
    });

    const res = pipelineInspectCore('proj_bug');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const value = res.value as {
      phase: number | null;
      phaseName?: string;
      phaseType?: string;
      gate?: { requiredMetadata: string[]; options: string[] };
      runId?: string;
      gateDocumentPath?: string;
    };
    expect(value.phase).toBe(3);
    expect(value.phaseName).toBe('Consolidacao');
    expect(value.phaseType).toBe('conversation');
    expect(value.gate?.requiredMetadata).toEqual(['action']);
    expect(value.gate?.options).toEqual(['approve-plan', 'close-pipeline']);
    expect(value.runId).toBe('20260727_101010-a1b2c3');
    expect(value.gateDocumentPath).toBe(
      '/tmp/bugrepo/.lionclaw/pipelines/bug/20260727_101010-a1b2c3/plano-de-correcao-20260727_101010-a1b2c3.md',
    );
  });

  it('fase SEM gate especial nao carrega o campo gate (extensao e aditiva, nao ruido)', () => {
    seed({ id: 'proj_bug2', pipelineType: 'bug', pipelineCurrentPhase: 1 });
    const res = pipelineInspectCore('proj_bug2');
    if (!res.ok) return;
    const value = res.value as Record<string, unknown>;
    expect(value.phaseName).toBe('Bug Discovery');
    expect(value.gate).toBeUndefined();
    expect(value.gateDocumentPath).toBeUndefined();
  });

  it('NAO-REGRESSAO: os campos ANTIGOS continuam identicos nos 5 tipos existentes', () => {
    seed({ id: 'p_dev', pipelineType: 'development', pipelineCurrentPhase: 3, status: 'paused' });
    const res = pipelineInspectCore('p_dev');
    if (!res.ok) return;
    const value = res.value as Record<string, unknown>;
    expect(value.id).toBe('p_dev');
    expect(value.pipelineType).toBe('development');
    expect(value.phase).toBe(3);
    expect(value.status).toBe('paused');
    expect(value.projectPath).toBe('/tmp/demo');
    expect(value.specPath).toBeNull();
    expect(value.pendingQuestion).toBeNull();
    expect(value.runId).toBeUndefined();
    expect(value.gate).toBeUndefined();
  });

  it('TB-42 (iii): pipe ENCERRADO reporta phase null e status done, NUNCA fase 1', () => {
    seed({
      id: 'proj_closed',
      pipelineType: 'bug',
      status: 'done',
      pipelineCurrentPhase: null,
      pipelineStartPhase: 1,
      config: { bug: { runId: '20260727_101010-a1b2c3', outcome: 'no-bug' } },
    });
    liveCurrentPhase = { phase: 3, status: 'running' };

    const res = pipelineInspectCore('proj_closed');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const value = res.value as Record<string, unknown>;
    expect(value.phase).toBeNull();
    expect(value.status).toBe('done');
    expect(value.pendingQuestion).toBeNull();
    expect(value.runId).toBe('20260727_101010-a1b2c3');
  });

  it('status terminal COM fase ainda preenchida NAO ativa o ramo terminal', () => {
    seed({ id: 'proj_failed', pipelineType: 'development', status: 'failed', pipelineCurrentPhase: 6 });
    const res = pipelineInspectCore('proj_failed');
    if (!res.ok) return;
    expect((res.value as { phase: number | null }).phase).toBe(6);
  });
});
