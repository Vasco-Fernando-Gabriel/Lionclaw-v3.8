
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

vi.mock('../db', () => {
  const getDriveState = vi.fn((_id?: string) => null as unknown);
  return {
    getHarnessProject: vi.fn(),
    listHarnessProjects: vi.fn(() => []),
    getPipelinePhaseMessagesAsChatHistory: vi.fn(() => []),
    getActiveChatSession: vi.fn(),
    getDriveState,
    isDriveEngaged: vi.fn((id: string) => {
      const d = getDriveState(id) as { driver?: string; status?: string } | null;
      return !!d && d.driver === 'orchestrator' && d.status !== 'stopped';
    }),
  };
});

vi.mock('../pipeline-create', () => ({
  createPipelineProject: vi.fn(),
}));

vi.mock('../pipeline-drive-coordinator', () => ({
  getPipelineDriveCoordinator: vi.fn(),
}));

import {
  getHarnessProject,
  getPipelinePhaseMessagesAsChatHistory,
  getDriveState,
} from '../db';
import { pipelineEventBus } from '../pipeline-event-bus';
import {
  registerPipelineEngineRef,
  _resetPipelineEngineRefForTesting,
} from '../pipeline-engine-ref';
import {
  pipelineApproveCore,
  startPipelineControlPhaseCache,
  getCachedPhaseChanged,
  _resetPipelineControlPhaseCacheForTesting,
  APPROVE_EARLY_ACK_GRACE_MS,
} from '../pipeline-control-core';

interface FakeEngine {
  getCurrentPhase: Mock;
  approvePhase: Mock;
  confirmStartDevelopment: Mock;
}

function installEngine(engine: Partial<FakeEngine>): FakeEngine {
  const full: FakeEngine = {
    getCurrentPhase: vi.fn(() => ({ phase: 1, status: 'paused' })),
    approvePhase: vi.fn(async () => undefined),
    confirmStartDevelopment: vi.fn(async () => undefined),
    ...engine,
  };
  registerPipelineEngineRef((() => full) as never);
  return full;
}

function project(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'proj_a',
    name: 'Demo',
    pipelineType: 'development',
    status: 'running',
    pipelineCurrentPhase: 1,
    pipelineStartPhase: 1,
    projectPath: '/tmp/demo',
    specPath: null,
    ...overrides,
  };
}

function historyWithQuestion(): Array<{ role: string; content: string }> {
  return [
    { role: 'user', content: 'contexto' },
    { role: 'assistant', content: 'Sprints validados. Posso aprovar e seguir?' },
  ];
}

function emitPhaseChanged(payload: {
  projectId: string;
  phase: number | null;
  status?: string;
  awaitingUser?: boolean;
}): void {
  pipelineEventBus.emit('pipeline:phase-changed', payload);
}

beforeEach(() => {
  vi.clearAllMocks();
  pipelineEventBus._resetForTesting();
  _resetPipelineEngineRefForTesting();
  _resetPipelineControlPhaseCacheForTesting();
  startPipelineControlPhaseCache();
  (getPipelinePhaseMessagesAsChatHistory as Mock).mockReturnValue([]);
  (getDriveState as Mock).mockReturnValue(null);
});


describe('F4: cache de pipeline:phase-changed (mecanismo)', () => {
  it('guarda o ultimo phase-changed por projectId e sobrescreve no seguinte', () => {
    emitPhaseChanged({ projectId: 'p1', phase: 3, status: 'started', awaitingUser: false });
    expect(getCachedPhaseChanged('p1')).toEqual({ phase: 3, status: 'started', awaitingUser: false });

    emitPhaseChanged({ projectId: 'p1', phase: 3, status: 'awaiting-input', awaitingUser: true });
    expect(getCachedPhaseChanged('p1')).toEqual({
      phase: 3,
      status: 'awaiting-input',
      awaitingUser: true,
    });
  });

  it('limpa a entrada nos status terminais (done/failed/aborted/pipeline-completed)', () => {
    for (const terminal of ['done', 'failed', 'aborted', 'pipeline-completed']) {
      emitPhaseChanged({ projectId: 'p1', phase: 5, status: 'awaiting-dev-confirmation', awaitingUser: true });
      expect(getCachedPhaseChanged('p1')).not.toBeNull();
      emitPhaseChanged({ projectId: 'p1', phase: null, status: terminal });
      expect(getCachedPhaseChanged('p1')).toBeNull();
    }
  });

  it('limpa a entrada em pipeline:reset-complete', () => {
    emitPhaseChanged({ projectId: 'p1', phase: 5, status: 'awaiting-dev-confirmation', awaitingUser: true });
    pipelineEventBus.emit('pipeline:reset-complete', { projectId: 'p1', phase: 1 });
    expect(getCachedPhaseChanged('p1')).toBeNull();
  });

  it('assinatura e idempotente (startPipelineControlPhaseCache 2x nao duplica)', () => {
    startPipelineControlPhaseCache();
    emitPhaseChanged({ projectId: 'p1', phase: 2, status: 'started', awaitingUser: false });
    expect(getCachedPhaseChanged('p1')).toEqual({ phase: 2, status: 'started', awaitingUser: false });
  });
});


describe('pipelineApproveCore F3 (pre-check por allowlist)', () => {
  it('F3-AC1: live "running" sem pergunta pendente nem gate cached -> { error } instrutivo, engine NAO chamado', async () => {
    (getHarnessProject as Mock).mockReturnValue(project({ pipelineCurrentPhase: 3 }));
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 3, status: 'running' })),
    });

    const res = await pipelineApproveCore('proj_a');

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('running');
      expect(res.error).toContain('pipeline_inspect');
    }
    expect(engine.approvePhase).not.toHaveBeenCalled();
    expect(engine.confirmStartDevelopment).not.toHaveBeenCalled();
  });

  it('F3-AC2: approve valido -> advanced:true + fase nova correta', async () => {
    (getHarnessProject as Mock).mockReturnValue(project({ pipelineCurrentPhase: 3 }));
    (getPipelinePhaseMessagesAsChatHistory as Mock).mockReturnValue(historyWithQuestion());
    let phase = 3;
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase, status: 'running' })),
      approvePhase: vi.fn(async () => {
        phase = 4;
      }),
    });

    const res = await pipelineApproveCore('proj_a');

    expect(engine.approvePhase).toHaveBeenCalledWith('proj_a', undefined);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const v = res.value as { approved: boolean; advanced: boolean; phase: number };
      expect(v.approved).toBe(true);
      expect(v.advanced).toBe(true);
      expect(v.phase).toBe(4);
    }
  });

  it('F3 (pos-check): aceite SEM avanco -> advanced:false + warning explicito (nunca approved:true mudo)', async () => {
    (getHarnessProject as Mock).mockReturnValue(project({ pipelineCurrentPhase: 3 }));
    (getPipelinePhaseMessagesAsChatHistory as Mock).mockReturnValue(historyWithQuestion());
    installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 3, status: 'running' })),
      approvePhase: vi.fn(async () => undefined), // no-op: fase nao move
    });

    const res = await pipelineApproveCore('proj_a');

    expect(res.ok).toBe(true);
    if (res.ok) {
      const v = res.value as { advanced: boolean; warning?: string };
      expect(v.advanced).toBe(false);
      expect(v.warning).toMatch(/nao avancou|pipeline_inspect/i);
    }
  });

  it('F3-AC4: dev-v2 fase 14 (Planner, auto) -> { error } instrutivo SEM chamar engine.approvePhase', async () => {
    (getHarnessProject as Mock).mockReturnValue(
      project({ id: 'proj_v2', pipelineType: 'development-v2', pipelineCurrentPhase: 14 }),
    );
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 14, status: 'running' })),
    });

    const res = await pipelineApproveCore('proj_v2');

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('14 (Planner)');
      expect(res.error).toContain('nao aceita aprovacao');
      expect(res.error).toContain('auto');
      expect(res.error).toContain('pipeline_inspect');
    }
    expect(engine.approvePhase).not.toHaveBeenCalled();
    expect(engine.confirmStartDevelopment).not.toHaveBeenCalled();
  });

  it('F3-AC4: fase loop (dev-v2 fase 16 Coder) tambem rejeitada pela allowlist', async () => {
    (getHarnessProject as Mock).mockReturnValue(
      project({ id: 'proj_v2', pipelineType: 'development-v2', pipelineCurrentPhase: 16 }),
    );
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 16, status: 'running' })),
    });

    const res = await pipelineApproveCore('proj_v2');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('loop');
    expect(engine.approvePhase).not.toHaveBeenCalled();
  });

  it('F3-AC3: sequencia guiada — erro instrutivo na fase auto, aceite na conversacional seguinte', async () => {
    const proj = project({ id: 'proj_v2', pipelineType: 'development-v2', pipelineCurrentPhase: 14 });
    (getHarnessProject as Mock).mockReturnValue(proj);
    let phase = 14;
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase, status: 'running' })),
      approvePhase: vi.fn(async () => undefined),
    });

    const res1 = await pipelineApproveCore('proj_v2');
    expect(res1.ok).toBe(false);
    expect(engine.approvePhase).not.toHaveBeenCalled();

    phase = 15;
    (getPipelinePhaseMessagesAsChatHistory as Mock).mockReturnValue(historyWithQuestion());

    const res2 = await pipelineApproveCore('proj_v2');
    expect(res2.ok).toBe(true);
    expect(engine.approvePhase).toHaveBeenCalledTimes(1);
  });
});

describe('pipelineApproveCore F3 (2) — requisitos de metadata por fase', () => {
  it('arch-review Triagem (fase 2) sem selectedCandidateId -> erro instrutivo ANTES do engine', async () => {
    (getHarnessProject as Mock).mockReturnValue(
      project({ id: 'proj_ar', pipelineType: 'architecture-review', pipelineCurrentPhase: 2 }),
    );
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 2, status: 'paused' })),
    });

    const res = await pipelineApproveCore('proj_ar');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('selectedCandidateId');
    expect(engine.approvePhase).not.toHaveBeenCalled();
  });

  it('arch-review Triagem com selectedCandidateId valido -> repassa metadata ao engine', async () => {
    (getHarnessProject as Mock).mockReturnValue(
      project({ id: 'proj_ar', pipelineType: 'architecture-review', pipelineCurrentPhase: 2 }),
    );
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 2, status: 'paused' })),
    });

    const res = await pipelineApproveCore('proj_ar', { selectedCandidateId: 'C2' });

    expect(res.ok).toBe(true);
    expect(engine.approvePhase).toHaveBeenCalledWith('proj_ar', { selectedCandidateId: 'C2' });
  });

  it('dev-v2 Open Design Studio (fase 5) sem action lock-and-continue -> erro instrutivo ANTES do engine', async () => {
    (getHarnessProject as Mock).mockReturnValue(
      project({ id: 'proj_v2', pipelineType: 'development-v2', pipelineCurrentPhase: 5 }),
    );
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 5, status: 'paused' })),
    });

    const res = await pipelineApproveCore('proj_v2', { action: 'continue' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('lock-and-continue');
    expect(engine.approvePhase).not.toHaveBeenCalled();
  });

  it('dev-v2 Open Design Studio com lock-and-continue (SEM drive engajado) -> repassa ao engine', async () => {
    (getHarnessProject as Mock).mockReturnValue(
      project({ id: 'proj_v2', pipelineType: 'development-v2', pipelineCurrentPhase: 5 }),
    );
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 5, status: 'paused' })),
    });

    const res = await pipelineApproveCore('proj_v2', { action: 'lock-and-continue' });

    expect(res.ok).toBe(true);
    expect(engine.approvePhase).toHaveBeenCalledWith('proj_v2', { action: 'lock-and-continue' });
  });
});


describe('pipelineApproveCore W4.1 (Design Lock e gate humano: drive nao locka)', () => {
  it('W4-AC1: drive engajado + dev-v2 fase ODS + lock-and-continue -> erro instrutivo, engine NAO chamado', async () => {
    (getHarnessProject as Mock).mockReturnValue(
      project({ id: 'proj_v2', pipelineType: 'development-v2', pipelineCurrentPhase: 5 }),
    );
    (getDriveState as Mock).mockReturnValue({
      driver: 'orchestrator',
      mode: 'full',
      status: 'driving',
    });
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 5, status: 'paused' })),
    });

    const res = await pipelineApproveCore('proj_v2', { action: 'lock-and-continue' });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('Design Lock e gate humano');
      expect(res.error).toContain('trava na UI');
    }
    expect(engine.approvePhase).not.toHaveBeenCalled();
    expect(engine.confirmStartDevelopment).not.toHaveBeenCalled();
  });

  it('W4.1: modo semi tambem bloqueia (validacao visual e do dono em QUALQUER modo)', async () => {
    (getHarnessProject as Mock).mockReturnValue(
      project({ id: 'proj_v2', pipelineType: 'development-v2', pipelineCurrentPhase: 5 }),
    );
    (getDriveState as Mock).mockReturnValue({
      driver: 'orchestrator',
      mode: 'semi',
      status: 'driving',
    });
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 5, status: 'paused' })),
    });

    const res = await pipelineApproveCore('proj_v2', { action: 'lock-and-continue' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Design Lock e gate humano');
    expect(engine.approvePhase).not.toHaveBeenCalled();
  });

  it('W4.1 (NAO pega o humano): SEM drive engajado, lock-and-continue na fase ODS prossegue ao engine', async () => {
    (getHarnessProject as Mock).mockReturnValue(
      project({ id: 'proj_v2', pipelineType: 'development-v2', pipelineCurrentPhase: 5 }),
    );
    (getDriveState as Mock).mockReturnValue(null);
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 5, status: 'paused' })),
    });

    const res = await pipelineApproveCore('proj_v2', { action: 'lock-and-continue' });

    expect(res.ok).toBe(true);
    expect(engine.approvePhase).toHaveBeenCalledWith('proj_v2', { action: 'lock-and-continue' });
  });

  it('W4-AC4 (CRITICO - prova da distincao de caller): o MESMO approve vindo do HUMANO/UI na fase ODS PASSA', async () => {
    const HUMAN_METADATA = { action: 'lock-and-continue' } as const;

    (getHarnessProject as Mock).mockReturnValue(
      project({ id: 'proj_v2', pipelineType: 'development-v2', pipelineCurrentPhase: 5 }),
    );
    (getDriveState as Mock).mockReturnValue({
      driver: 'orchestrator',
      mode: 'full',
      status: 'driving',
    });
    let phase = 5;
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase, status: 'paused' })),
      approvePhase: vi.fn(async () => {
        phase = 6; // lock avanca para a fase 6 (Design Lock, auto)
      }),
    });

    const driverRes = await pipelineApproveCore('proj_v2', HUMAN_METADATA);
    expect(driverRes.ok).toBe(false); // motorista barrado pelo gate W4.1
    if (!driverRes.ok) expect(driverRes.error).toContain('Design Lock e gate humano');
    expect(engine.approvePhase).not.toHaveBeenCalled(); // lock NAO aconteceu pelo drive
    expect(phase).toBe(5); // fase intacta

    await engine.approvePhase('proj_v2', HUMAN_METADATA);

    expect(engine.approvePhase).toHaveBeenCalledTimes(1);
    expect(engine.approvePhase).toHaveBeenCalledWith('proj_v2', HUMAN_METADATA);
    expect(phase).toBe(6); // o dono travou: a fase AVANCOU (lock aconteceu)
  });

  it('W4.1 (escopo): drive engajado mas FORA da fase ODS (dev-v2 fase 3) NAO e bloqueado pelo gate do lock', async () => {
    (getHarnessProject as Mock).mockReturnValue(
      project({ id: 'proj_v2', pipelineType: 'development-v2', pipelineCurrentPhase: 3 }),
    );
    (getDriveState as Mock).mockReturnValue({
      driver: 'orchestrator',
      mode: 'full',
      status: 'driving',
    });
    (getPipelinePhaseMessagesAsChatHistory as Mock).mockReturnValue(historyWithQuestion());
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 3, status: 'running' })),
    });

    const res = await pipelineApproveCore('proj_v2');

    expect(res.ok).toBe(true);
    expect(engine.approvePhase).toHaveBeenCalled();
  });
});

describe('pipelineApproveCore F3 (3) — precedencia do sinal de turno (rev3)', () => {
  it('pendingQuestion != null GANHA de live.status === "running" (approve prossegue)', async () => {
    (getHarnessProject as Mock).mockReturnValue(project({ pipelineCurrentPhase: 3 }));
    (getPipelinePhaseMessagesAsChatHistory as Mock).mockReturnValue(historyWithQuestion());
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 3, status: 'running' })),
    });

    const res = await pipelineApproveCore('proj_a');

    expect(res.ok).toBe(true);
    expect(engine.approvePhase).toHaveBeenCalled();
  });

  it('cache awaitingUser GANHA de live.status === "running" (sem pergunta no historico)', async () => {
    (getHarnessProject as Mock).mockReturnValue(project({ pipelineCurrentPhase: 3 }));
    emitPhaseChanged({ projectId: 'proj_a', phase: 3, status: 'awaiting-input', awaitingUser: true });
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 3, status: 'running' })),
    });

    const res = await pipelineApproveCore('proj_a');

    expect(res.ok).toBe(true);
    expect(engine.approvePhase).toHaveBeenCalled();
  });
});


describe('pipelineApproveCore F4 (gate pre-codigo Sprint Validator -> Coder)', () => {
  it('F4-AC1: dev-v2 fase 15 com awaiting-dev-confirmation -> confirmStartDevelopment, Coder (16) inicia; NUNCA approvePhase', async () => {
    (getHarnessProject as Mock).mockReturnValue(
      project({ id: 'proj_v2', pipelineType: 'development-v2', pipelineCurrentPhase: 15 }),
    );
    emitPhaseChanged({
      projectId: 'proj_v2',
      phase: 15,
      status: 'awaiting-dev-confirmation',
      awaitingUser: true,
    });
    let phase = 15;
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase, status: 'running' })),
      confirmStartDevelopment: vi.fn(async () => {
        phase = 16;
      }),
    });

    const res = await pipelineApproveCore('proj_v2');

    expect(engine.confirmStartDevelopment).toHaveBeenCalledWith('proj_v2');
    expect(engine.approvePhase).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    if (res.ok) {
      const v = res.value as { approved: boolean; advanced: boolean; phase: number; action: string };
      expect(v.approved).toBe(true);
      expect(v.advanced).toBe(true);
      expect(v.phase).toBe(16);
      expect(v.action).toBe('confirm-start-development');
    }
  });

  it('F4-AC1 (resolucao dinamica): security fase 9 com awaiting-dev-confirmation tambem mapeia', async () => {
    (getHarnessProject as Mock).mockReturnValue(
      project({ id: 'proj_sec', pipelineType: 'security', pipelineCurrentPhase: 9 }),
    );
    emitPhaseChanged({
      projectId: 'proj_sec',
      phase: 9,
      status: 'awaiting-dev-confirmation',
      awaitingUser: true,
    });
    let phase = 9;
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase, status: 'running' })),
      confirmStartDevelopment: vi.fn(async () => {
        phase = 10;
      }),
    });

    const res = await pipelineApproveCore('proj_sec');

    expect(engine.confirmStartDevelopment).toHaveBeenCalledWith('proj_sec');
    expect(engine.approvePhase).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it('INVARIANTE F4: approve em awaiting-dev-confirmation nunca recebe o erro generico de gate fechado', async () => {
    (getHarnessProject as Mock).mockReturnValue(
      project({ id: 'proj_v2', pipelineType: 'development-v2', pipelineCurrentPhase: 15 }),
    );
    (getPipelinePhaseMessagesAsChatHistory as Mock).mockReturnValue([]);
    emitPhaseChanged({
      projectId: 'proj_v2',
      phase: 15,
      status: 'awaiting-dev-confirmation',
      awaitingUser: true,
    });
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 15, status: 'running' })),
    });

    const res = await pipelineApproveCore('proj_v2');

    expect(res.ok).toBe(true);
    expect(engine.confirmStartDevelopment).toHaveBeenCalled();
    expect(engine.approvePhase).not.toHaveBeenCalled();
  });

  it('F4-AC3: dois approves consecutivos no Sprint Validator -> Coder inicia; nenhum approved:true sem aviso', async () => {
    (getHarnessProject as Mock).mockReturnValue(
      project({ id: 'proj_v2', pipelineType: 'development-v2', pipelineCurrentPhase: 15 }),
    );
    (getPipelinePhaseMessagesAsChatHistory as Mock).mockReturnValue(historyWithQuestion());
    let phase = 15;
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase, status: 'running' })),
      approvePhase: vi.fn(async () => {
        emitPhaseChanged({
          projectId: 'proj_v2',
          phase: 15,
          status: 'awaiting-dev-confirmation',
          awaitingUser: true,
        });
      }),
      confirmStartDevelopment: vi.fn(async () => {
        phase = 16;
        emitPhaseChanged({ projectId: 'proj_v2', phase: 15, status: 'completed', awaitingUser: false });
      }),
    });

    const res1 = await pipelineApproveCore('proj_v2');
    expect(res1.ok).toBe(true);
    if (res1.ok) {
      const v1 = res1.value as { advanced: boolean; warning?: string };
      expect(v1.advanced).toBe(false);
      expect(v1.warning).toContain('awaiting-dev-confirmation');
      expect(v1.warning).toContain('pipeline_approve');
    }
    expect(engine.approvePhase).toHaveBeenCalledTimes(1);
    expect(engine.confirmStartDevelopment).not.toHaveBeenCalled();

    const res2 = await pipelineApproveCore('proj_v2');
    expect(res2.ok).toBe(true);
    if (res2.ok) {
      const v2 = res2.value as { advanced: boolean; phase: number; action: string };
      expect(v2.advanced).toBe(true);
      expect(v2.phase).toBe(16);
      expect(v2.action).toBe('confirm-start-development');
    }
    expect(engine.approvePhase).toHaveBeenCalledTimes(1); // NUNCA repassado no 2o
    expect(engine.confirmStartDevelopment).toHaveBeenCalledTimes(1);
  });
});


describe('pipelineApproveCore F1 (early-ack: cascata auto nao segura o retorno)', () => {
  it('F1-AC3: approve aceito com cascata PENDURADA retorna apos a janela de graca (advanced:false + warning)', async () => {
    vi.useFakeTimers();
    try {
      (getHarnessProject as Mock).mockReturnValue(project({ pipelineCurrentPhase: 3 }));
      (getPipelinePhaseMessagesAsChatHistory as Mock).mockReturnValue(historyWithQuestion());
      let resolveCascade: (() => void) | null = null;
      const engine = installEngine({
        getCurrentPhase: vi.fn(() => ({ phase: 3, status: 'running' })),
        approvePhase: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolveCascade = resolve;
            }),
        ),
      });

      const pending = pipelineApproveCore('proj_a');
      await vi.advanceTimersByTimeAsync(APPROVE_EARLY_ACK_GRACE_MS + 50);
      const res = await pending;

      expect(engine.approvePhase).toHaveBeenCalledTimes(1);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const v = res.value as { approved: boolean; advanced: boolean; warning?: string };
        expect(v.approved).toBe(true);
        expect(v.advanced).toBe(false);
        expect(v.warning).toMatch(/background|pipeline_inspect/i);
      }

      expect(resolveCascade).not.toBeNull();
      resolveCascade!();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('F1: cascata que ja AVANCOU a fase dentro da janela mas segue rodando -> advanced:true no early-ack', async () => {
    vi.useFakeTimers();
    try {
      (getHarnessProject as Mock).mockReturnValue(project({ pipelineCurrentPhase: 3 }));
      (getPipelinePhaseMessagesAsChatHistory as Mock).mockReturnValue(historyWithQuestion());
      let phase = 3;
      installEngine({
        getCurrentPhase: vi.fn(() => ({ phase, status: 'running' })),
        approvePhase: vi.fn(() => {
          phase = 4;
          return new Promise<void>(() => undefined);
        }),
      });

      const pending = pipelineApproveCore('proj_a');
      await vi.advanceTimersByTimeAsync(APPROVE_EARLY_ACK_GRACE_MS + 50);
      const res = await pending;

      expect(res.ok).toBe(true);
      if (res.ok) {
        const v = res.value as { advanced: boolean; phase: number };
        expect(v.advanced).toBe(true);
        expect(v.phase).toBe(4);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('F1: rejeicao em BACKGROUND (apos o ack) e absorvida/logada - nunca unhandled rejection', async () => {
    vi.useFakeTimers();
    try {
      (getHarnessProject as Mock).mockReturnValue(project({ pipelineCurrentPhase: 3 }));
      (getPipelinePhaseMessagesAsChatHistory as Mock).mockReturnValue(historyWithQuestion());
      let rejectCascade: ((err: Error) => void) | null = null;
      installEngine({
        getCurrentPhase: vi.fn(() => ({ phase: 3, status: 'running' })),
        approvePhase: vi.fn(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectCascade = reject;
            }),
        ),
      });

      const pending = pipelineApproveCore('proj_a');
      await vi.advanceTimersByTimeAsync(APPROVE_EARLY_ACK_GRACE_MS + 50);
      const res = await pending;
      expect(res.ok).toBe(true); // ack ja saiu

      rejectCascade!(new Error('boom em background'));
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('F1 + F4: confirmStartDevelopment PENDURADO (loop do Coder) tambem retorna cedo', async () => {
    vi.useFakeTimers();
    try {
      (getHarnessProject as Mock).mockReturnValue(
        project({ id: 'proj_v2', pipelineType: 'development-v2', pipelineCurrentPhase: 15 }),
      );
      emitPhaseChanged({
        projectId: 'proj_v2',
        phase: 15,
        status: 'awaiting-dev-confirmation',
        awaitingUser: true,
      });
      const engine = installEngine({
        getCurrentPhase: vi.fn(() => ({ phase: 15, status: 'running' })),
        confirmStartDevelopment: vi.fn(() => new Promise<void>(() => undefined)),
      });

      const pending = pipelineApproveCore('proj_v2');
      await vi.advanceTimersByTimeAsync(APPROVE_EARLY_ACK_GRACE_MS + 50);
      const res = await pending;

      expect(engine.confirmStartDevelopment).toHaveBeenCalledWith('proj_v2');
      expect(engine.approvePhase).not.toHaveBeenCalled();
      expect(res.ok).toBe(true);
      if (res.ok) {
        const v = res.value as { action: string; warning?: string };
        expect(v.action).toBe('confirm-start-development');
        expect(v.warning).toMatch(/pipeline_inspect|background/i);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('F1: erro DENTRO da janela de graca continua virando { error } (pre/pos-checks da S1 preservados)', async () => {
    (getHarnessProject as Mock).mockReturnValue(project({ pipelineCurrentPhase: 3 }));
    (getPipelinePhaseMessagesAsChatHistory as Mock).mockReturnValue(historyWithQuestion());
    installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 3, status: 'running' })),
      approvePhase: vi.fn(async () => {
        throw new Error('validacao rapida do engine falhou');
      }),
    });

    const res = await pipelineApproveCore('proj_a');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('validacao rapida do engine falhou');
  });
});


describe('pipelineApproveCore — guardas basicas', () => {
  it('erro quando o pipeline nao existe', async () => {
    (getHarnessProject as Mock).mockReturnValue(undefined);
    installEngine({});

    const res = await pipelineApproveCore('ghost');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('nao encontrado');
  });

  it('erro quando o engine nao esta inicializado', async () => {
    const res = await pipelineApproveCore('proj_a');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('nao inicializado');
  });

  it('erro thrown pelo engine.approvePhase vira { error } (propagacao instrutiva)', async () => {
    (getHarnessProject as Mock).mockReturnValue(
      project({ id: 'proj_ar', pipelineType: 'architecture-review', pipelineCurrentPhase: 4 }),
    );
    installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 4, status: 'paused' })),
      approvePhase: vi.fn(async () => {
        throw new Error('A entrevista ainda nao tem decisoes suficientes');
      }),
    });

    const res = await pipelineApproveCore('proj_ar');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('decisoes suficientes');
  });
});


function bugProject(phase: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return project({
    id: 'proj_bug',
    pipelineType: 'bug',
    pipelineCurrentPhase: phase,
    projectPath: '/tmp/bugrepo',
    config: { bug: { runId: '20260727_101010-a1b2c3', outcome: 'pending' } },
    ...over,
  });
}

describe('TB-26: pipelineApproveCore no Bug Pipe (fase 3 exige action)', () => {
  it('fase 3 SEM metadata -> { error } instrutivo, engine NAO chamado', async () => {
    (getHarnessProject as Mock).mockReturnValue(bugProject(3));
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 3, status: 'paused' })),
    });

    const res = await pipelineApproveCore('proj_bug');

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('approve-plan');
      expect(res.error).toContain('close-pipeline');
      expect(res.error).toContain(
        '/tmp/bugrepo/.lionclaw/pipelines/bug/20260727_101010-a1b2c3/plano-de-correcao-20260727_101010-a1b2c3.md',
      );
    }
    expect(engine.approvePhase).not.toHaveBeenCalled();
  });

  it('fase 3 com action INVALIDA -> { error }, engine NAO chamado', async () => {
    (getHarnessProject as Mock).mockReturnValue(bugProject(3));
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 3, status: 'paused' })),
    });

    const res = await pipelineApproveCore('proj_bug', { action: 'lock-and-continue' });

    expect(res.ok).toBe(false);
    expect(engine.approvePhase).not.toHaveBeenCalled();
  });

  it('fase 3 sem runId -> mensagem cai no pipeline_inspect, NUNCA no basename', async () => {
    (getHarnessProject as Mock).mockReturnValue(bugProject(3, { config: {} }));
    installEngine({ getCurrentPhase: vi.fn(() => ({ phase: 3, status: 'paused' })) });

    const res = await pipelineApproveCore('proj_bug');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('pipeline_inspect');
      expect(res.error).not.toContain('plano-de-correcao-<runId>.md');
    }
  });

  it('fase 3 com action approve-plan -> passa ao engine com a metadata intacta', async () => {
    (getHarnessProject as Mock).mockReturnValue(bugProject(3));
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 3, status: 'paused' })),
    });

    const res = await pipelineApproveCore('proj_bug', { action: 'approve-plan' });

    expect(res.ok).toBe(true);
    expect(engine.approvePhase).toHaveBeenCalledWith('proj_bug', { action: 'approve-plan' });
  });

  it('allowlist do bug: fases 1/3/5/7 aceitam approve; 2/4/6/8/9 recusam', async () => {
    for (const phase of [1, 5, 7]) {
      (getHarnessProject as Mock).mockReturnValue(bugProject(phase));
      const engine = installEngine({
        getCurrentPhase: vi.fn(() => ({ phase, status: 'paused' })),
      });
      const res = await pipelineApproveCore('proj_bug');
      expect(res.ok, `fase ${phase} deveria aceitar`).toBe(true);
      expect(engine.approvePhase).toHaveBeenCalled();
    }
    for (const phase of [2, 4, 6, 8, 9]) {
      (getHarnessProject as Mock).mockReturnValue(bugProject(phase));
      const engine = installEngine({
        getCurrentPhase: vi.fn(() => ({ phase, status: 'paused' })),
      });
      const res = await pipelineApproveCore('proj_bug');
      expect(res.ok, `fase ${phase} deveria recusar`).toBe(false);
      expect(engine.approvePhase).not.toHaveBeenCalled();
    }
  });
});


describe('TB-42: retorno do close-pipeline (desfecho terminal)', () => {
  it('close-pipeline -> closed:true + outcome, SEM o warning de no-op', async () => {
    (getHarnessProject as Mock)
      .mockReturnValueOnce(bugProject(3))
      .mockReturnValue(
        bugProject(3, {
          status: 'done',
          pipelineCurrentPhase: null,
          config: { bug: { runId: '20260727_101010-a1b2c3', outcome: 'no-bug' } },
        }),
      );
    installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 3, status: 'paused' })),
    });

    const res = await pipelineApproveCore('proj_bug', { action: 'close-pipeline' });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const value = res.value as Record<string, unknown>;
      expect(value.closed).toBe(true);
      expect(value.outcome).toBe('no-bug');
      expect(value.phase).toBeNull();
      expect(value.liveStatus).toBe('done');
      expect(value.advanced).toBe(false);
      expect(value.warning).toBeUndefined();
      expect(JSON.stringify(value)).not.toContain('pode ter sido no-op');
      expect(JSON.stringify(value)).not.toContain('antes de repetir');
    }
  });

  it('NAO-REGRESSAO: approve normal (nao terminal) mantem o payload atual, warning incluso', async () => {
    (getHarnessProject as Mock).mockReturnValue(project({ pipelineCurrentPhase: 3 }));
    installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 3, status: 'paused' })),
    });

    const res = await pipelineApproveCore('proj_a');

    expect(res.ok).toBe(true);
    if (res.ok) {
      const value = res.value as Record<string, unknown>;
      expect(value.closed).toBeUndefined();
      expect(value.outcome).toBeUndefined();
      expect(value.advanced).toBe(false);
      expect(String(value.warning)).toContain('pode estar finalizando em background');
    }
  });
});
