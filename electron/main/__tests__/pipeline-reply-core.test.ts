
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  getDriveState: vi.fn(() => null),
}));

vi.mock('../pipeline-create', () => ({
  createPipelineProject: vi.fn(),
}));

import { getHarnessProject } from '../db';
import { releaseProjectLock, isProjectLocked } from '../pipeline-shared/lock';
import type { Mock } from 'vitest';
import { pipelineEventBus } from '../pipeline-event-bus';
import {
  registerPipelineEngineRef,
  _resetPipelineEngineRefForTesting,
} from '../pipeline-engine-ref';
import { pipelineReplyCore } from '../pipeline-control-core';

interface FakeEngine {
  getCurrentPhase: Mock;
  sendMessage: Mock;
}

function installEngine(engine: Partial<FakeEngine>): FakeEngine {
  const full: FakeEngine = {
    getCurrentPhase: vi.fn(() => ({ phase: 1, status: 'running' })),
    sendMessage: vi.fn(() => undefined),
    ...engine,
  };
  registerPipelineEngineRef((() => full) as never);
  return full;
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

describe('pipelineReplyCore (SPEC 4.3 / A6 / AC-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pipelineEventBus._resetForTesting();
    _resetPipelineEngineRefForTesting();
    (getHarnessProject as Mock).mockReturnValue({ ...PROJECT });
  });


  it('resolve no 1o pipeline:stream {type:"done"} correlacionado (fim do turno)', async () => {
    installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 1, status: 'running' })),
      sendMessage: vi.fn(() => {
        queueMicrotask(() => {
          pipelineEventBus.emit('pipeline:stream', {
            projectId: 'proj_a',
            phase: 1,
            type: 'done',
          });
        });
        return undefined;
      }),
    });

    const res = await pipelineReplyCore('proj_a', 'minha resposta');

    expect(res.ok).toBe(true);
    if (res.ok) {
      const value = res.value as { id: string; status: string; phase: number };
      expect(value.id).toBe('proj_a');
      expect(value.status).toBe('completed');
    }
  });

  it('ignora done de OUTRO projeto (correlacao por projectId)', async () => {
    let resolved = false;
    installEngine({
      sendMessage: vi.fn(() => {
        pipelineEventBus.emit('pipeline:stream', { projectId: 'outro', phase: 1, type: 'done' });
        queueMicrotask(() => {
          pipelineEventBus.emit('pipeline:stream', { projectId: 'proj_a', phase: 1, type: 'done' });
        });
        return undefined;
      }),
    });

    const p = pipelineReplyCore('proj_a', 'oi').then((r) => {
      resolved = true;
      return r;
    });
    const res = await p;
    expect(resolved).toBe(true);
    expect(res.ok).toBe(true);
  });


  it('falha IMEDIATA quando sendMessage retorna { error } (auto-phase)', async () => {
    installEngine({
      sendMessage: vi.fn(() => ({ error: 'fase auto nao aceita mensagem' })),
    });

    const res = await pipelineReplyCore('proj_a', 'oi');

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('fase auto nao aceita mensagem');
    }
  });


  it('falha em pipeline:stream {type:"error"} sem esperar timeout', async () => {
    installEngine({
      sendMessage: vi.fn(() => {
        queueMicrotask(() => {
          pipelineEventBus.emit('pipeline:stream', {
            projectId: 'proj_a',
            phase: 1,
            type: 'error',
            message: 'o agente da fase explodiu',
          });
        });
        return undefined;
      }),
    });

    const start = Date.now();
    const res = await pipelineReplyCore('proj_a', 'oi');
    const elapsed = Date.now() - start;

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('o agente da fase explodiu');
    }
    expect(elapsed).toBeLessThan(2000);
  });

  it('falha em pipeline:error correlacionado', async () => {
    installEngine({
      sendMessage: vi.fn(() => {
        queueMicrotask(() => {
          pipelineEventBus.emit('pipeline:error', {
            projectId: 'proj_a',
            phase: 1,
            error: 'erro fatal na fase',
          });
        });
        return undefined;
      }),
    });

    const res = await pipelineReplyCore('proj_a', 'oi');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('erro fatal na fase');
    }
  });


  it('fail-fast se o engine LIVE esta "aborted" (nao despacha sendMessage)', async () => {
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => ({ phase: 1, status: 'aborted' })),
    });

    const res = await pipelineReplyCore('proj_a', 'oi');

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('aborted');
    }
    expect(engine.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['done', 'failed', 'aborted'] as const)(
    'fail-fast se o status persistido (DB) e terminal (%s)',
    async (status) => {
      (getHarnessProject as Mock).mockReturnValue({ ...PROJECT, status });
      const engine = installEngine({
        getCurrentPhase: vi.fn(() => ({ phase: 1, status: 'running' })),
      });

      const res = await pipelineReplyCore('proj_a', 'oi');

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain(status);
      }
      expect(engine.sendMessage).not.toHaveBeenCalled();
    },
  );


  it('F5-AC1 (caminho central): DB "interrupted" em fase CONVERSACIONAL -> reply despacha e completa', async () => {
    (getHarnessProject as Mock).mockReturnValue({ ...PROJECT, status: 'interrupted' });
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => null),
      sendMessage: vi.fn(() => {
        queueMicrotask(() => {
          pipelineEventBus.emit('pipeline:stream', {
            projectId: 'proj_a',
            phase: 1,
            type: 'done',
          });
        });
        return undefined;
      }),
    });

    const res = await pipelineReplyCore('proj_a', 'minha resposta a pergunta pendente');

    expect(res.ok).toBe(true);
    if (res.ok) {
      const value = res.value as { id: string; status: string };
      expect(value.id).toBe('proj_a');
      expect(value.status).toBe('completed');
    }
    expect(engine.sendMessage).toHaveBeenCalledWith(
      'proj_a',
      'minha resposta a pergunta pendente',
      [],
    );
    expect(isProjectLocked('proj_a')).toBe(true);
    releaseProjectLock('proj_a');
  });

  it('DB "interrupted" em fase AUTO -> erro instrutivo (pipeline_drive) SEM despachar sendMessage', async () => {
    (getHarnessProject as Mock).mockReturnValue({
      ...PROJECT,
      status: 'interrupted',
      pipelineCurrentPhase: 2,
    });
    const engine = installEngine({
      getCurrentPhase: vi.fn(() => null),
    });

    const res = await pipelineReplyCore('proj_a', 'oi');

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('interrupted');
      expect(res.error).toContain('pipeline_drive');
    }
    expect(engine.sendMessage).not.toHaveBeenCalled();
  });


  it('erro quando o pipeline nao existe', async () => {
    (getHarnessProject as Mock).mockReturnValue(undefined);
    installEngine({});

    const res = await pipelineReplyCore('inexistente', 'oi');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('nao encontrado');
  });

  it('erro quando o engine nao esta inicializado', async () => {
    const res = await pipelineReplyCore('proj_a', 'oi');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('nao inicializado');
  });
});
