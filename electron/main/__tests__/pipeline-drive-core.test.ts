
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

vi.mock('../db', () => ({
  getHarnessProject: vi.fn(),
  listHarnessProjects: vi.fn(() => []),
  getPipelinePhaseMessagesAsChatHistory: vi.fn(() => []),
  getActiveChatSession: vi.fn(),
}));

vi.mock('../pipeline-create', () => ({
  createPipelineProject: vi.fn(),
}));

vi.mock('../pipeline-drive-coordinator', () => ({
  getPipelineDriveCoordinator: vi.fn(),
}));

import { getHarnessProject, getActiveChatSession } from '../db';
import { releaseProjectLock, isProjectLocked } from '../pipeline-shared/lock';
import { createPipelineProject } from '../pipeline-create';
import { getPipelineDriveCoordinator } from '../pipeline-drive-coordinator';
import {
  registerPipelineEngineRef,
  _resetPipelineEngineRefForTesting,
} from '../pipeline-engine-ref';
import {
  pipelineDriveCore,
  pipelineCreateCore,
  isPipelineWriteAction,
} from '../pipeline-control-core';

function installEngine(startPipeline: Mock): void {
  registerPipelineEngineRef((() => ({ startPipeline })) as never);
}

function installCoordinator(startDrive: Mock): void {
  (getPipelineDriveCoordinator as Mock).mockReturnValue({ startDrive });
}

const PROJECT = {
  id: 'proj_a',
  name: 'Demo',
  pipelineType: 'development',
  status: 'running',
  pipelineCurrentPhase: 1,
  pipelineStartPhase: 1,
  projectPath: '/tmp/demo',
  specPath: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetPipelineEngineRefForTesting();
});

describe('pipelineDriveCore (FX1 bootstrap seam)', () => {
  it('resolve o sessionId do chat ativo e engata o coordenador (driving)', () => {
    (getHarnessProject as Mock).mockReturnValue({ ...PROJECT });
    (getActiveChatSession as Mock).mockReturnValue({ id: 'sess_1' });
    const startDrive = vi.fn(() => ({ ok: true, drive: { status: 'driving' } }));
    installCoordinator(startDrive);

    const res = pipelineDriveCore('proj_a', 'semi');

    expect(res.ok).toBe(true);
    expect(startDrive).toHaveBeenCalledWith('proj_a', 'sess_1', 'semi');
    if (res.ok) {
      const v = res.value as { driving: boolean; mode: string; sessionId: string };
      expect(v.driving).toBe(true);
      expect(v.mode).toBe('semi');
      expect(v.sessionId).toBe('sess_1');
    }
  });

  it('falha claro quando NAO ha sessao de chat ativa', () => {
    (getHarnessProject as Mock).mockReturnValue({ ...PROJECT });
    (getActiveChatSession as Mock).mockReturnValue(null);
    const startDrive = vi.fn();
    installCoordinator(startDrive);

    const res = pipelineDriveCore('proj_a', 'full');

    expect(res.ok).toBe(false);
    expect(startDrive).not.toHaveBeenCalled();
    if (!res.ok) expect(res.error).toMatch(/sessao de chat ativa/i);
  });

  it('propaga o erro do lock global (1 drive por vez)', () => {
    (getHarnessProject as Mock).mockReturnValue({ ...PROJECT });
    (getActiveChatSession as Mock).mockReturnValue({ id: 'sess_1' });
    installCoordinator(vi.fn(() => ({ ok: false, error: 'ja existe um drive ativo' })));

    const res = pipelineDriveCore('proj_a', 'semi');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/ja existe um drive ativo/);
  });

  it('rejeita mode invalido e pipeline inexistente', () => {
    (getActiveChatSession as Mock).mockReturnValue({ id: 'sess_1' });
    installCoordinator(vi.fn());

    (getHarnessProject as Mock).mockReturnValue({ ...PROJECT });
    expect(pipelineDriveCore('proj_a', 'turbo' as never).ok).toBe(false);

    (getHarnessProject as Mock).mockReturnValue(undefined);
    expect(pipelineDriveCore('ghost', 'semi').ok).toBe(false);
  });
});

async function flushBackground(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('pipelineCreateCore com drive (FX1 "cria e dirige" + F1 early-ack)', () => {
  it('early-ack: retorna { started:false, driveEngaging:true } e engata o coordenador em BACKGROUND', async () => {
    (createPipelineProject as Mock).mockReturnValue({
      id: 'proj_new',
      name: 'Novo',
      pipelineType: 'development',
    });
    const startPipeline = vi.fn(async () => undefined);
    installEngine(startPipeline);
    (getHarnessProject as Mock).mockReturnValue({ ...PROJECT, id: 'proj_new' });
    (getActiveChatSession as Mock).mockReturnValue({ id: 'sess_9' });
    const startDrive = vi.fn(() => ({ ok: true, drive: { status: 'driving' } }));
    installCoordinator(startDrive);

    const res = await pipelineCreateCore({
      projectPath: '/tmp/x',
      pipelineType: 'development',
      name: 'Novo',
      brief: 'algo',
      drive: 'full',
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const v = res.value as { id: string; started: boolean; driveEngaging: boolean };
      expect(v.id).toBe('proj_new');
      expect(v.started).toBe(false); // (F1) early-ack: start roda em background
      expect(v.driveEngaging).toBe(true);
    }

    await flushBackground();
    expect(startPipeline).toHaveBeenCalledWith('proj_new', 1);
    expect(startDrive).toHaveBeenCalledWith('proj_new', 'sess_9', 'full');
  });

  it('F1-AC1: create retorna < 2s com id valido mesmo com startPipeline PENDURADO (fase 1 longa)', async () => {
    (createPipelineProject as Mock).mockReturnValue({
      id: 'proj_new',
      name: 'Novo',
      pipelineType: 'development',
    });
    installEngine(vi.fn(() => new Promise<undefined>(() => undefined)));
    installCoordinator(vi.fn());

    const t0 = Date.now();
    const res = await pipelineCreateCore({
      projectPath: '/tmp/x',
      pipelineType: 'development',
      name: 'Novo',
      brief: 'algo',
    });
    const elapsed = Date.now() - t0;

    expect(res.ok).toBe(true);
    expect(elapsed).toBeLessThan(2000);
    if (res.ok) {
      const v = res.value as { id: string; started: boolean; note?: string };
      expect(v.id).toBe('proj_new');
      expect(v.started).toBe(false);
      expect(v.note).toMatch(/pipeline_inspect/);
    }
  });

  it('falha de engate em background NAO derruba o create (ack ja saiu; erro so logado)', async () => {
    (createPipelineProject as Mock).mockReturnValue({
      id: 'proj_new',
      name: 'Novo',
      pipelineType: 'development',
    });
    installEngine(vi.fn(async () => undefined));
    (getHarnessProject as Mock).mockReturnValue({ ...PROJECT, id: 'proj_new' });
    (getActiveChatSession as Mock).mockReturnValue(null); // sem sessao ativa
    const startDrive = vi.fn();
    installCoordinator(startDrive);

    const res = await pipelineCreateCore({
      projectPath: '/tmp/x',
      pipelineType: 'development',
      name: 'Novo',
      brief: 'algo',
      drive: 'semi',
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const v = res.value as { started: boolean; driveEngaging: boolean };
      expect(v.started).toBe(false);
      expect(v.driveEngaging).toBe(true); // o engate AINDA vai tentar em background
    }
    await flushBackground();
    expect(startDrive).not.toHaveBeenCalled();
  });

  it('startPipeline com { error } em background: nao engata o drive (so loga)', async () => {
    (createPipelineProject as Mock).mockReturnValue({
      id: 'proj_new',
      name: 'Novo',
      pipelineType: 'development',
    });
    installEngine(vi.fn(async () => ({ error: 'boom no start' })));
    (getHarnessProject as Mock).mockReturnValue({ ...PROJECT, id: 'proj_new' });
    (getActiveChatSession as Mock).mockReturnValue({ id: 'sess_9' });
    const startDrive = vi.fn();
    installCoordinator(startDrive);

    const res = await pipelineCreateCore({
      projectPath: '/tmp/x',
      pipelineType: 'development',
      name: 'Novo',
      brief: 'algo',
      drive: 'full',
    });

    expect(res.ok).toBe(true);
    await flushBackground();
    expect(startDrive).not.toHaveBeenCalled();
  });

  it('sem drive: cria com driveEngaging:false e inicia em background sem coordenador', async () => {
    (createPipelineProject as Mock).mockReturnValue({
      id: 'proj_new',
      name: 'Novo',
      pipelineType: 'development',
    });
    const startPipeline = vi.fn(async () => undefined);
    installEngine(startPipeline);
    const startDrive = vi.fn();
    installCoordinator(startDrive);

    const res = await pipelineCreateCore({
      projectPath: '/tmp/x',
      pipelineType: 'development',
      name: 'Novo',
      brief: 'algo',
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect((res.value as { driveEngaging: boolean }).driveEngaging).toBe(false);
    await flushBackground();
    expect(startPipeline).toHaveBeenCalledWith('proj_new', 1);
    expect(startDrive).not.toHaveBeenCalled();
  });
});

describe('F5 (SPEC estrada-fixes): resumePipeline no re-engage do drive', () => {
  function installEngineWithResume(opts: {
    liveStatus?: string;
    resumePipeline?: Mock;
  }): { resumePipeline: Mock; getCurrentPhase: Mock } {
    const resumePipeline = opts.resumePipeline ?? vi.fn(async () => undefined);
    const getCurrentPhase = vi.fn(() => ({ phase: 3, status: opts.liveStatus ?? 'idle' }));
    registerPipelineEngineRef((() => ({ resumePipeline, getCurrentPhase })) as never);
    return { resumePipeline, getCurrentPhase };
  }

  it('F5 (engage): pipeline "interrupted" -> resumePipeline (API do botao Retomar) ANTES do startDrive', () => {
    (getHarnessProject as Mock).mockReturnValue({ ...PROJECT, status: 'interrupted' });
    (getActiveChatSession as Mock).mockReturnValue({ id: 'sess_1' });
    const { resumePipeline } = installEngineWithResume({});
    const startDrive = vi.fn(() => ({ ok: true, drive: { status: 'driving' } }));
    installCoordinator(startDrive);

    const res = pipelineDriveCore('proj_a', 'semi');

    expect(res.ok).toBe(true);
    expect(resumePipeline).toHaveBeenCalledWith('proj_a');
    expect(startDrive).toHaveBeenCalled();
    expect(resumePipeline.mock.invocationCallOrder[0]!).toBeLessThan(
      startDrive.mock.invocationCallOrder[0]!,
    );
  });

  it('pipeline "paused" no DB (ou live) tambem retoma no re-engage', () => {
    (getHarnessProject as Mock).mockReturnValue({ ...PROJECT, status: 'paused' });
    (getActiveChatSession as Mock).mockReturnValue({ id: 'sess_1' });
    const { resumePipeline } = installEngineWithResume({});
    installCoordinator(vi.fn(() => ({ ok: true, drive: { status: 'driving' } })));

    expect(pipelineDriveCore('proj_a', 'full').ok).toBe(true);
    expect(resumePipeline).toHaveBeenCalledWith('proj_a');

    resumePipeline.mockClear();
    (getHarnessProject as Mock).mockReturnValue({ ...PROJECT, status: 'running' });
    const live = installEngineWithResume({ liveStatus: 'paused' });
    expect(pipelineDriveCore('proj_a', 'full').ok).toBe(true);
    expect(live.resumePipeline).toHaveBeenCalledWith('proj_a');
  });

  it('pipeline "running" NAO chama resumePipeline (engage normal intocado)', () => {
    (getHarnessProject as Mock).mockReturnValue({ ...PROJECT, status: 'running' });
    (getActiveChatSession as Mock).mockReturnValue({ id: 'sess_1' });
    const { resumePipeline } = installEngineWithResume({ liveStatus: 'running' });
    installCoordinator(vi.fn(() => ({ ok: true, drive: { status: 'driving' } })));

    expect(pipelineDriveCore('proj_a', 'semi').ok).toBe(true);
    expect(resumePipeline).not.toHaveBeenCalled();
  });

  it('falha do resumePipeline NAO derruba o engage (fire-and-forget logado)', async () => {
    (getHarnessProject as Mock).mockReturnValue({ ...PROJECT, status: 'interrupted' });
    (getActiveChatSession as Mock).mockReturnValue({ id: 'sess_1' });
    const resumePipeline = vi.fn(() => Promise.reject(new Error('boom')));
    installEngineWithResume({ resumePipeline });
    installCoordinator(vi.fn(() => ({ ok: true, drive: { status: 'driving' } })));

    const res = pipelineDriveCore('proj_a', 'semi');
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(resumePipeline).toHaveBeenCalled();
  });

  it('(paridade S4.1) re-engage com "interrupted" readquire o lock per-project antes do resume', () => {
    (getHarnessProject as Mock).mockReturnValue({ ...PROJECT, status: 'interrupted' });
    (getActiveChatSession as Mock).mockReturnValue({ id: 'sess_1' });
    const { resumePipeline } = installEngineWithResume({});
    installCoordinator(vi.fn(() => ({ ok: true, drive: { status: 'driving' } })));

    releaseProjectLock('proj_lock_resume');
    expect(isProjectLocked('proj_lock_resume')).toBe(false);
    expect(pipelineDriveCore('proj_lock_resume', 'semi').ok).toBe(true);
    expect(isProjectLocked('proj_lock_resume')).toBe(true);
    expect(resumePipeline).toHaveBeenCalledWith('proj_lock_resume');
    releaseProjectLock('proj_lock_resume');
  });
});

describe('isPipelineWriteAction inclui pipeline_drive (gate de permissao)', () => {
  it('pipeline_drive e WRITE', () => {
    expect(isPipelineWriteAction('pipeline_drive')).toBe(true);
  });
  it('read tools nao sao WRITE', () => {
    expect(isPipelineWriteAction('pipeline_list')).toBe(false);
    expect(isPipelineWriteAction('pipeline_inspect')).toBe(false);
  });
});
