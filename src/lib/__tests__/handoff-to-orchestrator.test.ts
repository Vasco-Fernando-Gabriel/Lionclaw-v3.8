import { describe, it, expect, vi } from 'vitest';
import {
  buildHandoffPrompt,
  handoffToOrchestrator,
  type GraphHint,
  type HandoffDeps,
  type HandoffRequest,
  type PipelineHandoffRequest,
  type WorkflowHandoffRequest,
} from '../handoff-to-orchestrator';
import type { LocalRepositoryRecord, LocalRepositoryStatus } from '../../types/repo-graph';

const EM_DASH = '—';

function pipelineReq(overrides: Partial<PipelineHandoffRequest> = {}): PipelineHandoffRequest {
  return {
    source: 'pipeline',
    pipelineType: 'development',
    projectId: 'proj-1',
    projectName: 'MeuProjeto',
    projectPath: '/Users/dono/code/meu-projeto',
    specPath: null,
    ...overrides,
  };
}

function workflowReq(overrides: Partial<WorkflowHandoffRequest> = {}): WorkflowHandoffRequest {
  return {
    source: 'workflow',
    projectId: 'run-1',
    projectName: 'MeuWorkflow',
    projectPath: '/Users/dono/code/meu-projeto',
    branch: 'main',
    workflowSummary: 'Entreguei a feature X com testes.',
    ...overrides,
  };
}

function makeRecord(
  status: LocalRepositoryStatus,
  overrides: Partial<LocalRepositoryRecord> = {},
): LocalRepositoryRecord {
  return {
    id: 'repo-1',
    name: 'meu-projeto',
    rootPath: '/Users/dono/code/meu-projeto',
    canonicalRootPath: '/Users/dono/code/meu-projeto',
    gitRoot: '/Users/dono/code/meu-projeto',
    provider: 'codegraph',
    graphPath: null,
    status,
    indexedCommit: null,
    indexedWorktreeHash: null,
    lastIndexedAt: null,
    statsJson: null,
    graphPromptSuppressedGlobal: false,
    settingsJson: '{}',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const READY: GraphHint = { state: 'ready' };

describe('buildHandoffPrompt - cabecalho comum', () => {
  it('inclui projectName, projectId, rotulo e projectPath no cabecalho', () => {
    const out = buildHandoffPrompt(pipelineReq(), READY);
    expect(out).toContain('MeuProjeto');
    expect(out).toContain('id proj-1');
    expect(out).toContain('pipeline development');
    expect(out).toContain('Pasta do projeto: /Users/dono/code/meu-projeto.');
  });

  it('usa o rotulo "workflow" para requests de workflow', () => {
    const out = buildHandoffPrompt(workflowReq(), READY);
    expect(out).toContain('pipeline workflow');
  });
});

describe('buildHandoffPrompt - (a) development/feature/dev-v2', () => {
  it('chave canonica pipeline:development resolve runProjectPrompt (texto "como rodar")', () => {
    const out = buildHandoffPrompt(pipelineReq({ pipelineType: 'development' }), READY);
    expect(out).toContain('Quero rodar o projeto localmente.');
    expect(out).toContain('Inspecione a pasta e descubra como rodar este projeto');
  });

  it('feature e development-v2 tambem resolvem runProjectPrompt', () => {
    const feat = buildHandoffPrompt(pipelineReq({ pipelineType: 'feature' }), READY);
    const v2 = buildHandoffPrompt(pipelineReq({ pipelineType: 'development-v2' }), READY);
    expect(feat).toContain('Quero rodar o projeto localmente.');
    expect(v2).toContain('Quero rodar o projeto localmente.');
  });

  it('omite a linha de SPEC quando specPath e null/ausente', () => {
    const out = buildHandoffPrompt(pipelineReq({ specPath: null }), READY);
    expect(out).not.toContain('SPEC');
    expect(out).not.toContain('documento de SPEC');
  });

  it('inclui a linha de SPEC apenas quando specPath existe', () => {
    const out = buildHandoffPrompt(pipelineReq({ specPath: '/Users/dono/code/meu-projeto/spec.md' }), READY);
    expect(out).toContain('leia o documento de SPEC em /Users/dono/code/meu-projeto/spec.md');
  });
});

describe('buildHandoffPrompt - (b) security', () => {
  it('linha 1 sempre "Localize..." (nao cita path fantasma)', () => {
    const out = buildHandoffPrompt(pipelineReq({ pipelineType: 'security' }), READY);
    expect(out).toContain('pipeline de SEGURANCA');
    expect(out).toContain('1. Localize o relatorio consolidado de seguranca');
    expect(out).toContain('VALIDE a mudanca');
  });

  it('linha de SPEC condicional ao specPath', () => {
    const semSpec = buildHandoffPrompt(pipelineReq({ pipelineType: 'security', specPath: null }), READY);
    const comSpec = buildHandoffPrompt(pipelineReq({ pipelineType: 'security', specPath: '/repo/SPEC.md' }), READY);
    expect(semSpec).not.toContain('leia a SPEC em');
    expect(comSpec).toContain('leia a SPEC em /repo/SPEC.md');
  });
});

describe('buildHandoffPrompt - (c) architecture-review', () => {
  it('linha 1 sempre "Localize..." e fala em refactor estrutural', () => {
    const out = buildHandoffPrompt(pipelineReq({ pipelineType: 'architecture-review' }), READY);
    expect(out).toContain('pipeline de REVISAO ARQUITETURAL');
    expect(out).toContain('1. Localize as decisoes arquiteturais e o diagnostico');
    expect(out).toContain('VALIDE a mudanca');
  });

  it('linha de SPEC condicional ao specPath', () => {
    const semSpec = buildHandoffPrompt(pipelineReq({ pipelineType: 'architecture-review', specPath: null }), READY);
    const comSpec = buildHandoffPrompt(
      pipelineReq({ pipelineType: 'architecture-review', specPath: '/repo/SPEC.md' }),
      READY,
    );
    expect(semSpec).not.toContain('leia a SPEC em');
    expect(comSpec).toContain('leia a SPEC em /repo/SPEC.md');
  });
});

describe('buildHandoffPrompt - (d) workflow', () => {
  it('inclui branch e resumo da entrega quando presentes', () => {
    const out = buildHandoffPrompt(workflowReq(), READY);
    expect(out).toContain('Branch da entrega: main.');
    expect(out).toContain('Resumo da entrega: Entreguei a feature X com testes.');
    expect(out).toContain('Acabei de concluir um workflow neste repositorio.');
  });

  it('omite branch/resumo quando ausentes', () => {
    const out = buildHandoffPrompt(workflowReq({ branch: null, workflowSummary: undefined }), READY);
    expect(out).not.toContain('Branch da entrega:');
    expect(out).not.toContain('Resumo da entrega:');
  });

  it('trunca o resumo da entrega em 1200 chars', () => {
    const huge = 'x'.repeat(2000);
    const out = buildHandoffPrompt(workflowReq({ workflowSummary: huge }), READY);
    const marker = 'Resumo da entrega: ';
    const idx = out.indexOf(marker);
    const tail = out.slice(idx + marker.length).split('\n')[0];
    expect(tail.length).toBe(1200);
  });
});

describe('buildHandoffPrompt - bloco de grafo (NEUTRO vs unavailable)', () => {
  it('caminho COM pasta -> bloco NEUTRO (nao afirma "ja indexado/disponivel")', () => {
    for (const state of ['ready', 'stale'] as const) {
      const out = buildHandoffPrompt(pipelineReq(), { state });
      expect(out).toContain('O CodeGraph foi solicitado para este repositorio');
      expect(out).toContain('se estiver disponivel no contexto');
      expect(out).not.toContain('ja foi indexado');
    }
  });

  it('fallback SEM pasta -> texto que pede a pasta + bloco unavailable', () => {
    const out = buildHandoffPrompt(pipelineReq({ projectPath: null }), READY);
    expect(out).toContain('ainda nao foi indexado pelo CodeGraph');
    expect(out).toContain('Me informe a pasta do projeto antes de mexer em arquivos.');
  });

  it('workflow SEM pasta tambem cai no fallback unavailable', () => {
    const out = buildHandoffPrompt(workflowReq({ projectPath: null }), READY);
    expect(out).toContain('ainda nao foi indexado pelo CodeGraph');
    expect(out).toContain('Me informe a pasta do projeto');
  });
});

describe('buildHandoffPrompt - variante desconhecida -> fallback default', () => {
  it('pipelineType fora do registry resolve runProjectPrompt', () => {
    const weird = {
      source: 'pipeline',
      pipelineType: 'pipeline-que-nao-existe',
      projectId: 'proj-x',
      projectName: 'X',
      projectPath: '/repo/x',
      specPath: null,
    } as unknown as HandoffRequest;
    const out = buildHandoffPrompt(weird, READY);
    expect(out).toContain('Quero rodar o projeto localmente.');
  });
});

describe('buildHandoffPrompt - ausencia de em-dash em todas as saidas', () => {
  const cases: Array<[string, HandoffRequest]> = [
    ['development', pipelineReq({ pipelineType: 'development', specPath: '/repo/SPEC.md' })],
    ['feature', pipelineReq({ pipelineType: 'feature' })],
    ['development-v2', pipelineReq({ pipelineType: 'development-v2' })],
    ['security', pipelineReq({ pipelineType: 'security', specPath: '/repo/SPEC.md' })],
    ['architecture-review', pipelineReq({ pipelineType: 'architecture-review' })],
    ['workflow', workflowReq()],
    ['fallback sem pasta', pipelineReq({ projectPath: null })],
  ];

  for (const [name, req] of cases) {
    it(`nao contem em-dash na variante ${name}`, () => {
      const ready = buildHandoffPrompt(req, READY);
      const unavailable = buildHandoffPrompt(req, { state: 'unavailable' });
      expect(ready).not.toContain(EM_DASH);
      expect(unavailable).not.toContain(EM_DASH);
    });
  }
});

interface DepsSpy {
  deps: HandoffDeps;
  ensureSession: ReturnType<typeof vi.fn>;
  selectSession: ReturnType<typeof vi.fn>;
  addRepository: ReturnType<typeof vi.fn>;
  attachSession: ReturnType<typeof vi.fn>;
  build: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  setPendingChat: ReturnType<typeof vi.fn>;
  setPage: ReturnType<typeof vi.fn>;
  currentSessionId: ReturnType<typeof vi.fn>;
  order: string[];
}

function makeDeps(
  opts: {
    ensure?: { sessionId: string } | { error: string };
    current?: string | null;
    record?: LocalRepositoryRecord | { error: string };
    build?: { runId: string } | { error: string };
  } = {},
): DepsSpy {
  const order: string[] = [];
  const ensure = opts.ensure ?? { sessionId: 'sid-new' };
  const record = opts.record ?? makeRecord('ready');
  const buildResult = opts.build ?? { runId: 'run-build-1' };

  const ensureSession = vi.fn(async (_preferred?: string) => {
    order.push('ensureSession');
    return ensure;
  });
  const selectSession = vi.fn(async (_sid: string) => {
    order.push('selectSession');
  });
  const addRepository = vi.fn(async (_path: string) => {
    order.push('addRepository');
    return record;
  });
  const attachSession = vi.fn(async (_sid: string, _repoId: string) => {
    order.push('attachSession');
    return { ok: true as const };
  });
  const build = vi.fn(async (_repoId: string, _sid: string) => {
    order.push('build');
    return buildResult;
  });
  const update = vi.fn(async (_repoId: string, _sid: string) => {
    order.push('update');
    return { runId: 'run-update-1' };
  });
  const setPendingChat = vi.fn(() => {
    order.push('setPendingChat');
  });
  const setPage = vi.fn(() => {
    order.push('setPage');
  });
  const currentSessionId = vi.fn(() => opts.current ?? null);

  const deps: HandoffDeps = {
    ensureSession,
    selectSession,
    addRepository,
    attachSession,
    build,
    update,
    setPendingChat,
    setPage,
    currentSessionId,
  };

  return {
    deps,
    ensureSession,
    selectSession,
    addRepository,
    attachSession,
    build,
    update,
    setPendingChat,
    setPage,
    currentSessionId,
    order,
  };
}

describe('handoffToOrchestrator - ensure-session', () => {
  it('repassa o currentSessionId como preferredSessionId e reusa o id retornado', async () => {
    const spy = makeDeps({ current: 'sid-corrente', ensure: { sessionId: 'sid-corrente' } });
    const res = await handoffToOrchestrator(pipelineReq(), undefined, spy.deps);

    expect(res).toEqual({ ok: true });
    expect(spy.ensureSession).toHaveBeenCalledWith('sid-corrente');
    expect(spy.selectSession).toHaveBeenCalledWith('sid-corrente');
    expect(spy.attachSession).toHaveBeenCalledWith('sid-corrente', 'repo-1');
    const handoff = spy.setPendingChat.mock.calls[0][2];
    expect(handoff.targetSessionId).toBe('sid-corrente');
  });

  it('cria sessao nova quando nao ha corrente e usa o id novo em toda a cadeia', async () => {
    const spy = makeDeps({ current: null, ensure: { sessionId: 'sid-new' } });
    await handoffToOrchestrator(pipelineReq(), undefined, spy.deps);

    expect(spy.ensureSession).toHaveBeenCalledWith(undefined);
    expect(spy.selectSession).toHaveBeenCalledWith('sid-new');
    expect(spy.attachSession).toHaveBeenCalledWith('sid-new', 'repo-1');
    expect(spy.setPendingChat.mock.calls[0][2].targetSessionId).toBe('sid-new');
  });

  it('{error} no ensure-session aborta sem navegar nem vincular', async () => {
    const spy = makeDeps({ ensure: { error: 'sem sessao' } });
    const res = await handoffToOrchestrator(pipelineReq(), undefined, spy.deps);

    expect(res).toEqual({ error: 'sem sessao' });
    expect(spy.selectSession).not.toHaveBeenCalled();
    expect(spy.addRepository).not.toHaveBeenCalled();
    expect(spy.attachSession).not.toHaveBeenCalled();
    expect(spy.build).not.toHaveBeenCalled();
    expect(spy.setPage).not.toHaveBeenCalled();
    expect(spy.setPendingChat).not.toHaveBeenCalled();
  });
});

describe('handoffToOrchestrator - ordem da sequencia', () => {
  it('selectSession apos ensureSession e antes do attach', async () => {
    const spy = makeDeps();
    await handoffToOrchestrator(pipelineReq(), undefined, spy.deps);
    expect(spy.order.indexOf('ensureSession')).toBeLessThan(spy.order.indexOf('selectSession'));
    expect(spy.order.indexOf('selectSession')).toBeLessThan(spy.order.indexOf('attachSession'));
  });

  it('add+attach antes do build, e build antes do setPage', async () => {
    const spy = makeDeps({ record: makeRecord('absent') });
    await handoffToOrchestrator(pipelineReq(), undefined, spy.deps);
    const { order } = spy;
    expect(order.indexOf('addRepository')).toBeLessThan(order.indexOf('build'));
    expect(order.indexOf('attachSession')).toBeLessThan(order.indexOf('build'));
    expect(order.indexOf('build')).toBeLessThan(order.indexOf('setPage'));
  });
});

describe('handoffToOrchestrator - indexacao condicional pelo status', () => {
  it('ready -> nem build nem update', async () => {
    const spy = makeDeps({ record: makeRecord('ready') });
    await handoffToOrchestrator(pipelineReq(), undefined, spy.deps);
    expect(spy.build).not.toHaveBeenCalled();
    expect(spy.update).not.toHaveBeenCalled();
  });

  it('stale -> update(record.id, X) e NAO build', async () => {
    const spy = makeDeps({ current: 'sid-x', ensure: { sessionId: 'sid-x' }, record: makeRecord('stale') });
    await handoffToOrchestrator(pipelineReq(), undefined, spy.deps);
    expect(spy.update).toHaveBeenCalledWith('repo-1', 'sid-x');
    expect(spy.build).not.toHaveBeenCalled();
  });

  it('absent -> build(record.id, X) e NAO update', async () => {
    const spy = makeDeps({ current: 'sid-x', ensure: { sessionId: 'sid-x' }, record: makeRecord('absent') });
    await handoffToOrchestrator(pipelineReq(), undefined, spy.deps);
    expect(spy.build).toHaveBeenCalledWith('repo-1', 'sid-x');
    expect(spy.update).not.toHaveBeenCalled();
  });

  it('error -> build(record.id, X)', async () => {
    const spy = makeDeps({ current: 'sid-x', ensure: { sessionId: 'sid-x' }, record: makeRecord('error') });
    await handoffToOrchestrator(pipelineReq(), undefined, spy.deps);
    expect(spy.build).toHaveBeenCalledWith('repo-1', 'sid-x');
    expect(spy.update).not.toHaveBeenCalled();
  });
});

describe('handoffToOrchestrator - setPendingChat (handoff)', () => {
  it('caminho com repo -> { awaitRepoReady = record.id, targetSessionId = X }', async () => {
    const spy = makeDeps({ current: 'sid-x', ensure: { sessionId: 'sid-x' }, record: makeRecord('ready') });
    await handoffToOrchestrator(pipelineReq(), undefined, spy.deps);
    const [message, agentId, handoff] = spy.setPendingChat.mock.calls[0];
    expect(typeof message).toBe('string');
    expect(agentId).toBeUndefined();
    expect(handoff).toEqual({ awaitRepoReady: 'repo-1', targetSessionId: 'sid-x' });
    expect(spy.setPage).toHaveBeenCalledWith('chat');
  });

  it('fallback sem pasta -> setPendingChat SEM handoff e sem bind', async () => {
    const spy = makeDeps();
    const res = await handoffToOrchestrator(pipelineReq({ projectPath: null }), undefined, spy.deps);
    expect(res).toEqual({ ok: true });
    expect(spy.addRepository).not.toHaveBeenCalled();
    expect(spy.attachSession).not.toHaveBeenCalled();
    expect(spy.build).not.toHaveBeenCalled();
    expect(spy.update).not.toHaveBeenCalled();
    const [, agentId, handoff] = spy.setPendingChat.mock.calls[0];
    expect(agentId).toBeUndefined();
    expect(handoff).toBeUndefined();
    expect(spy.setPage).toHaveBeenCalledWith('chat');
  });
});

describe('handoffToOrchestrator - addRepository {error} degrada', () => {
  it('erro de PATH -> fallback sem-pasta (navega, sem handoff, sem attach/build)', async () => {
    const spy = makeDeps({ record: { error: 'caminho invalido' } });
    const res = await handoffToOrchestrator(pipelineReq(), undefined, spy.deps);

    expect(res).toEqual({ ok: true });
    expect(spy.attachSession).not.toHaveBeenCalled();
    expect(spy.build).not.toHaveBeenCalled();
    expect(spy.update).not.toHaveBeenCalled();
    const [message, agentId, handoff] = spy.setPendingChat.mock.calls[0];
    expect(message).toContain('ainda nao foi indexado pelo CodeGraph');
    expect(agentId).toBeUndefined();
    expect(handoff).toBeUndefined();
    expect(spy.setPage).toHaveBeenCalledWith('chat');
  });
});

describe('handoffToOrchestrator - beforeHandoff', () => {
  it('roda PRIMEIRO, antes de qualquer ensure/attach/build/navegar', async () => {
    const spy = makeDeps();
    const calls: string[] = [];
    const beforeHandoff = vi.fn(async () => {
      calls.push('beforeHandoff');
      expect(spy.ensureSession).not.toHaveBeenCalled();
      return { ok: true as const };
    });
    await handoffToOrchestrator(workflowReq(), beforeHandoff, spy.deps);
    expect(beforeHandoff).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['beforeHandoff']);
    expect(spy.ensureSession).toHaveBeenCalled();
  });

  it('{error} no beforeHandoff aborta sem ensure/attach/build/navegar', async () => {
    const spy = makeDeps();
    const beforeHandoff = vi.fn(async () => ({ error: 'finalize falhou' }));
    const res = await handoffToOrchestrator(workflowReq(), beforeHandoff, spy.deps);

    expect(res).toEqual({ error: 'finalize falhou' });
    expect(spy.ensureSession).not.toHaveBeenCalled();
    expect(spy.selectSession).not.toHaveBeenCalled();
    expect(spy.addRepository).not.toHaveBeenCalled();
    expect(spy.attachSession).not.toHaveBeenCalled();
    expect(spy.build).not.toHaveBeenCalled();
    expect(spy.setPage).not.toHaveBeenCalled();
    expect(spy.setPendingChat).not.toHaveBeenCalled();
  });
});

describe('handoffToOrchestrator - build "ja existe" segue', () => {
  it('rejeicao benigna do build nao quebra: navega + setPendingChat com handoff', async () => {
    const spy = makeDeps({
      record: makeRecord('absent'),
      build: { error: 'ja existe um run em andamento para este repositorio' },
    });
    const res = await handoffToOrchestrator(pipelineReq(), undefined, spy.deps);

    expect(res).toEqual({ ok: true });
    expect(spy.build).toHaveBeenCalled();
    expect(spy.setPendingChat).toHaveBeenCalledTimes(1);
    const handoff = spy.setPendingChat.mock.calls[0][2];
    expect(handoff).toEqual({ awaitRepoReady: 'repo-1', targetSessionId: 'sid-new' });
    expect(spy.setPage).toHaveBeenCalledWith('chat');
  });
});
