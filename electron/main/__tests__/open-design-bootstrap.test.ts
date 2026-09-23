import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/lionclaw-test-approot',
    getPath: (_name: string) => '/tmp/lionclaw-test-userdata',
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

vi.mock('../db', () => ({
  getHarnessProject: vi.fn(),
  insertEnrichMessage: vi.fn(),
  insertHarnessRound: vi.fn(),
  updateHarnessProject: vi.fn(),
  updateHarnessRound: vi.fn(),
  savePipelineMessage: vi.fn(),
}));

vi.mock('../open-design/manager', () => ({
  start: vi.fn(),
}));

vi.mock('../open-design/boot-installer', () => ({
  getBootInstallStatus: vi.fn(),
}));

vi.mock('../open-design/adapter-http', () => {
  return {
    createAdapter: vi.fn(),
  };
});

vi.mock('../open-design/design-plan', () => ({
  ensureDesignPlan: vi.fn(async () => ({
    ok: true,
    promptBlock: [
      '## Design Plan aprovado antes do Open Design',
      '- login (Login) — Autenticar usuario — stories: US-01',
      '- painel (Painel) — Acompanhar runs — stories: US-08',
    ].join('\n'),
    plan: {},
    validation: { ok: true, errors: [], warnings: [], knownStoryIds: ['US-01', 'US-08'] },
    validatorReport: { approved: true, issues: [], strengths: [], summary: 'ok' },
    planPath: '/tmp/design-plan.json',
    validationPath: '/tmp/design-plan-validation.json',
    reused: false,
    fallback: false,
  })),
}));

vi.mock('../pipeline-paths', () => ({
  getPipelineDocsContext: vi.fn(() => null),
  resolveOpenDesignPromptPath: vi.fn(() => '/tmp/lionclaw-open-design-prompt.md'),
}));

import { getHarnessProject, savePipelineMessage, updateHarnessProject } from '../db';
import { getBootInstallStatus } from '../open-design/boot-installer';
import * as manager from '../open-design/manager';
import { createAdapter } from '../open-design/adapter-http';
import { getPipelineDocsContext } from '../pipeline-paths';
import { buildInitialPrompt, ensureSession, __resetBootstrapForTests } from '../open-design/bootstrap';
import type { OpenDesignConfig, OpenDesignSessionConfig } from '../../../src/types/open-design';

const mockGetHarnessProject = vi.mocked(getHarnessProject);
const mockUpdateHarnessProject = vi.mocked(updateHarnessProject);
const mockSavePipelineMessage = vi.mocked(savePipelineMessage);
const mockGetBootInstallStatus = vi.mocked(getBootInstallStatus);
const mockManagerStart = vi.mocked(manager.start);
const mockCreateAdapter = vi.mocked(createAdapter);
const mockGetPipelineDocsContext = vi.mocked(getPipelineDocsContext);
const PROMPT_PATH = '/tmp/lionclaw-open-design-prompt.md';
const DEFAULT_OPEN_DESIGN_PROMPT = [
  '# Briefing inicial — Demo project',
  '',
  'Responda em portugues brasileiro.',
  'Gere design high-fidelity.',
  'Hierarquia de prioridade',
  'Skill de Frontend de Alto Nivel',
  'Esta skill NUNCA substitui escopo.',
  'Mapa compacto de user stories',
  'Design Plan aprovado antes do Open Design',
  'Regra anti-tela-empilhada',
  '[hidden] { display: none !important; }',
  'lionclaw-design-contract',
  '"actionIds"',
  '"screenIds"',
  '"sourceScreenIds"',
  '"relatedUserStoryIds"',
].join('\n');

interface FakeAdapter {
  health: ReturnType<typeof vi.fn>;
  createProject: ReturnType<typeof vi.fn>;
  createConversation: ReturnType<typeof vi.fn>;
  putMessage: ReturnType<typeof vi.fn>;
  startRun: ReturnType<typeof vi.fn>;
  getAppConfig: ReturnType<typeof vi.fn>;
  updateAppConfig: ReturnType<typeof vi.fn>;
  startInitialRun: ReturnType<typeof vi.fn>;
  listMessages: ReturnType<typeof vi.fn>;
  listFiles: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  fetchFinalArtifact: ReturnType<typeof vi.fn>;
  callRaw: ReturnType<typeof vi.fn>;
}

function makeFakeAdapter(): FakeAdapter {
  const messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    runId?: string;
    runStatus?: string;
  }> = [];
  return {
    health: vi.fn(async () => true),
    createProject: vi.fn(async () => ({ projectId: 'lionclaw-runabc', conversationId: 'conv_init' })),
    createConversation: vi.fn(async () => ({ conversationId: 'conv_new' })),
    putMessage: vi.fn(async () => undefined),
    startRun: vi.fn(async () => ({ runId: 'run_1' })),
    getAppConfig: vi.fn(async () => ({ config: {} })),
    updateAppConfig: vi.fn(async (payload) => ({ config: payload })),
    startInitialRun: vi.fn(async (args: { userMessageId: string; assistantMessageId: string; prompt: string }) => {
      messages.push({ id: args.userMessageId, role: 'user', content: args.prompt });
      messages.push({
        id: args.assistantMessageId,
        role: 'assistant',
        content: '',
        runId: 'run_1',
        runStatus: 'running',
      });
      return { runId: 'run_1' };
    }),
    listMessages: vi.fn(async () => messages),
    listFiles: vi.fn(async () => [{ path: 'index.html' }]),
    readFile: vi.fn(async () => ''),
    fetchFinalArtifact: vi.fn(async () => ({ html: '', fileName: 'index.html', hash: '0' })),
    callRaw: vi.fn(async () => undefined),
  };
}

function sessionConfig(overrides: Partial<OpenDesignSessionConfig> = {}): OpenDesignSessionConfig {
  return {
    agentId: 'claude',
    model: 'claude-opus-4-7',
    reasoning: 'high',
    designSystemId: 'lc-default',
    memoryEnabled: false,
    mcpServerIds: [],
    locale: 'pt-BR',
    configuredAt: '2026-05-11T00:00:00.000Z',
    ...overrides,
  };
}

function buildMutableProject(initialOd: Partial<OpenDesignConfig>): {
  project: {
    id: string;
    name: string;
    projectPath: string;
    pipelineDocsId: string | null;
    discoveryNotesPath: string | null;
    config: { openDesign: Record<string, unknown>; runId?: string };
  };
} {
  const project = {
    id: 'p_abc',
    name: 'Demo project',
    projectPath: '/tmp/demo',
    pipelineDocsId: null,
    discoveryNotesPath: null,
    config: {
      openDesign: { ...initialOd, runId: 'runabc' } as Record<string, unknown>,
    },
  };
  mockGetHarnessProject.mockImplementation((id: string) => {
    if (id !== project.id) return undefined as never;
    return project as never;
  });
  mockUpdateHarnessProject.mockImplementation((_id: string, updates) => {
    if ((updates as Record<string, unknown>).config) {
      const nextConfig = (updates as unknown as { config: { openDesign: Record<string, unknown> } }).config;
      project.config = { ...project.config, ...nextConfig };
    }
    return project as never;
  });
  return { project };
}

describe('bootstrap.ensureSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBootstrapForTests();
    fs.rmSync(PROMPT_PATH, { force: true });
    fs.writeFileSync(PROMPT_PATH, DEFAULT_OPEN_DESIGN_PROMPT, 'utf8');
    mockGetBootInstallStatus.mockReturnValue({ kind: 'ready', finishedAt: '2026-05-11T00:00:00.000Z' });
    mockManagerStart.mockResolvedValue({
      ok: true,
      daemonUrl: 'http://127.0.0.1:7457',
      webUrl: 'http://127.0.0.1:5175',
    } as never);
    mockGetPipelineDocsContext.mockReturnValue(null);
  });

  it('exige bootInstallStatus.kind === "ready" (SPEC L1068)', async () => {
    mockGetBootInstallStatus.mockReturnValue({ kind: 'installing', runner: 'pnpm', startedAt: '...' });
    buildMutableProject({ sessionConfig: sessionConfig() });
    const res = await ensureSession('p_abc');
    expect(res).toEqual({ error: expect.stringMatching(/boot install not ready/i) });
  });

  it('exige sessionConfig presente', async () => {
    buildMutableProject({});
    const res = await ensureSession('p_abc');
    expect(res).toEqual({ error: expect.stringMatching(/sessionConfig nao configurada/i) });
  });

  it('rejeita sessionConfig antiga com agente/modelo incompatíveis antes de chamar o sidecar', async () => {
    buildMutableProject({ sessionConfig: sessionConfig({ agentId: 'claude', model: 'gpt-5.5' }) });

    const res = await ensureSession('p_abc');

    expect(res).toEqual({ error: expect.stringMatching(/nao pertence ao agente Claude/i) });
    expect(mockManagerStart).not.toHaveBeenCalled();
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });

  it('1a chamada: createProject 1x, createConversation 0x (usa conv inicial), sendInitialRun 1x; 2a chamada: 0/0/0', async () => {
    const fake = makeFakeAdapter();
    mockCreateAdapter.mockReturnValue(fake as never);
    buildMutableProject({ sessionConfig: sessionConfig() });

    const res1 = await ensureSession('p_abc');
    expect('error' in res1).toBe(false);
    if ('error' in res1) return;

    expect(fake.createProject).toHaveBeenCalledTimes(1);
    expect(fake.createConversation).toHaveBeenCalledTimes(0);
    expect(fake.startInitialRun).toHaveBeenCalledTimes(1);

    const res2 = await ensureSession('p_abc');
    if ('error' in res2) throw new Error('expected ok');
    expect(fake.createProject).toHaveBeenCalledTimes(1);
    expect(fake.createConversation).toHaveBeenCalledTimes(0);
    expect(fake.startInitialRun).toHaveBeenCalledTimes(1);

    expect(res2.openDesignProjectId).toBe(res1.openDesignProjectId);
    expect(res2.conversationId).toBe(res1.conversationId);
    expect(res2.initialPromptHash).toBe(res1.initialPromptHash);
  });

  it('reenviar prompt quando hash igual mas OD nao tem mensagem inicial', async () => {
    const fake = makeFakeAdapter();
    mockCreateAdapter.mockReturnValue(fake as never);
    buildMutableProject({ sessionConfig: sessionConfig() });

    const res1 = await ensureSession('p_abc');
    expect('error' in res1).toBe(false);
    if ('error' in res1) throw new Error('expected ok');
    expect(fake.startInitialRun).toHaveBeenCalledTimes(1);

    fake.listMessages.mockResolvedValueOnce([]);

    const res2 = await ensureSession('p_abc');
    expect('error' in res2).toBe(false);
    if ('error' in res2) throw new Error('expected ok');
    expect(fake.startInitialRun).toHaveBeenCalledTimes(2);

    const secondArgs = fake.startInitialRun.mock.calls[1]![0];
    expect(secondArgs.conversationId).toBe(res1.conversationId);
    expect(secondArgs.userMessageId).toMatch(/^lionclaw-user-[a-f0-9]{16}-/);
  });

  it('sincroniza app-config interno do OD com agent/model da sessionConfig', async () => {
    const fake = makeFakeAdapter();
    fake.getAppConfig.mockResolvedValueOnce({
      config: {
        agentId: 'claude',
        agentModels: { claude: { model: 'sonnet' } },
      },
    });
    mockCreateAdapter.mockReturnValue(fake as never);
    buildMutableProject({
      sessionConfig: sessionConfig({ agentId: 'codex', model: 'default', reasoning: undefined }),
    });

    const res = await ensureSession('p_abc');
    if ('error' in res) throw new Error('expected ok');

    expect(fake.updateAppConfig).toHaveBeenCalledWith({
      agentId: 'codex',
      agentModels: {
        claude: { model: 'sonnet' },
        codex: { model: 'default' },
      },
      designSystemId: 'lc-default',
    });
  });

  it('forca fidelity:"high-fidelity" e metadata correta no createProject (SPEC L1067)', async () => {
    const fake = makeFakeAdapter();
    mockCreateAdapter.mockReturnValue(fake as never);
    buildMutableProject({ sessionConfig: sessionConfig() });

    await ensureSession('p_abc');

    expect(fake.createProject).toHaveBeenCalledTimes(1);
    const payload = fake.createProject.mock.calls[0]![0];
    expect(payload.metadata.fidelity).toBe('high-fidelity');
    expect(payload.metadata.kind).toBe('prototype');
    expect(payload.metadata.source).toBe('lionclaw-development-v2');
    expect(payload.metadata.sessionConfigVersion).toBe(1);
    expect(payload.pendingPrompt).toBeNull();
    expect(payload.id).toMatch(/^lionclaw-[a-z0-9-]+$/);
  });

  it('sessionConfig mudada -> conversa nova + prompt novo (SPEC L1066)', async () => {
    const fake = makeFakeAdapter();
    mockCreateAdapter.mockReturnValue(fake as never);
    buildMutableProject({ sessionConfig: sessionConfig() });

    const res1 = await ensureSession('p_abc');
    if ('error' in res1) throw new Error('expected ok');

    const { project } = buildMutableProject({
      sessionConfig: sessionConfig({ model: 'claude-opus-4-8' }),
      openDesignProjectId: res1.openDesignProjectId,
      conversationId: undefined,
      initialPromptHash: undefined,
      sessionConfigHash: undefined,
    });
    project.config.runId = 'runabc';

    const res2 = await ensureSession('p_abc');
    if ('error' in res2) throw new Error('expected ok');

    expect(fake.createProject).toHaveBeenCalledTimes(1);
    expect(fake.createConversation).toHaveBeenCalledTimes(1);
    expect(fake.startInitialRun).toHaveBeenCalledTimes(2);

    expect(res2.conversationId).toBe('conv_new');
    expect(res2.initialPromptHash).toBe(res1.initialPromptHash);
  });

  it('recupera conversationId orfao do OD criando conversa nova e reenviando prompt', async () => {
    const fake = makeFakeAdapter();
    const deliveredMessages: Array<{ id: string; role: 'user'; content: string }> = [];
    fake.startInitialRun.mockReset();
    fake.startInitialRun
      .mockRejectedValueOnce(
        new Error(
          'Adapter HTTP PUT /api/projects/lionclaw-runabc/conversations/conv_stale/messages/lionclaw-user-abc -> 404 Not Found: {"error":"conversation not found"}',
        ),
      )
      .mockImplementationOnce(async (args: { userMessageId: string; prompt: string }) => {
        deliveredMessages.push({ id: args.userMessageId, role: 'user', content: args.prompt });
        return { runId: 'run_retry' };
      });
    fake.listMessages.mockImplementation(async () => deliveredMessages);
    mockCreateAdapter.mockReturnValue(fake as never);
    buildMutableProject({
      sessionConfig: sessionConfig(),
      openDesignProjectId: 'lionclaw-runabc',
      conversationId: 'conv_stale',
      initialPromptHash: 'old-hash',
      initialPromptSentAt: '2026-05-10T00:00:00.000Z',
    });

    const res = await ensureSession('p_abc');
    if ('error' in res) throw new Error('expected ok');

    expect(fake.createProject).toHaveBeenCalledTimes(0);
    expect(fake.createConversation).toHaveBeenCalledTimes(1);
    expect(fake.startInitialRun).toHaveBeenCalledTimes(2);
    expect(fake.startInitialRun.mock.calls[0]![0].conversationId).toBe('conv_stale');
    expect(fake.startInitialRun.mock.calls[1]![0].conversationId).toBe('conv_new');
    expect(res.conversationId).toBe('conv_new');
  });

  it('propaga pt-BR no prompt + URL (SPEC L1069)', async () => {
    const fake = makeFakeAdapter();
    mockCreateAdapter.mockReturnValue(fake as never);
    buildMutableProject({ sessionConfig: sessionConfig() });

    const res = await ensureSession('p_abc');
    if ('error' in res) throw new Error('expected ok');

    expect(res.webUrl).toContain('host=lionclaw');
    expect(res.webUrl).toContain('locale=pt-BR');
    expect(res.webUrl).toMatch(/\/projects\/lionclaw-/);

    expect(fake.startInitialRun).toHaveBeenCalledTimes(1);
    const promptArg = fake.startInitialRun.mock.calls[0]![0].prompt as string;
    const fileText = fs.readFileSync(PROMPT_PATH, 'utf8');
    expect(promptArg).toBe(`[Briefing automatico do LionClaw - pipeline Demo project]\n${fileText}`);
    expect(fileText).not.toContain('[Briefing automatico do LionClaw');
    expect(mockSavePipelineMessage).not.toHaveBeenCalled();
    expect(promptArg).toMatch(/portugues brasileiro/i);
    expect(promptArg).toMatch(/high-fidelity/i);
    expect(promptArg).toMatch(/lionclaw-design-contract/);
    expect(promptArg).toMatch(/Hierarquia de prioridade/i);
    expect(promptArg).toMatch(/Skill de Frontend de Alto Nivel/i);
    expect(promptArg).toMatch(/NUNCA substitui escopo/i);
    expect(promptArg).toMatch(/Mapa compacto de user stories/i);
    expect(promptArg).toMatch(/Design Plan aprovado antes do Open Design/i);
    expect(promptArg).toContain('"actionIds"');
    expect(promptArg).toContain('"screenIds"');
    expect(promptArg).toContain('"sourceScreenIds"');
    expect(promptArg).toContain('"relatedUserStoryIds"');
  });

  it('usa exatamente o prompt pre-gerado pela fase Design Plan', async () => {
    const customPrompt = [
      '# Prompt OD pre-gerado',
      '',
      'NAO abra questionario',
      'Superficie principal: desktop web responsivo',
      '- US-01: Criar conta e acessar ambiente autenticado',
      'Sem pedir clarificacao visual neste ponto.',
    ].join('\n');
    fs.writeFileSync(PROMPT_PATH, customPrompt, 'utf8');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-od-prompt-'));
    const storiesPath = path.join(tmp, 'stories-requisitos.md');
    fs.writeFileSync(
      storiesPath,
      [
        '# User Stories e Requisitos',
        '',
        '## Premissas',
        '- Nao fazem parte do MVP: billing automatico, webhooks customizados e OAuth GitHub.',
        '',
        '#### US-01 - Criar conta e acessar ambiente autenticado',
        '',
        'Como dev solo, quero criar minha conta para acessar o produto.',
        '',
        'Interface esperada: fluxo de criação de conta, autenticação e sessão web.',
        '',
        '1. Dado um visitante sem conta, quando concluir cadastro, então cria usuario e tenant.',
        '',
        '#### US-02 - Auditar operações de escrita',
        '',
        'Como fundador técnico, quero audit log para rastrear mudanças.',
        '',
        'Interface esperada: estados de ação em cadastro, edição e exclusão.',
        '',
        '1. Dado um cadastro concluído, quando persistir, então registra operação.',
      ].join('\n'),
      'utf8',
    );
    mockGetPipelineDocsContext.mockReturnValue({
      resolveDocPath: (name: string) => (name === 'stories-requisitos.md' ? storiesPath : null),
    } as never);
    const fake = makeFakeAdapter();
    mockCreateAdapter.mockReturnValue(fake as never);
    const { project } = buildMutableProject({ sessionConfig: sessionConfig() });
    project.pipelineDocsId = 'Docs-test';

    const res = await ensureSession('p_abc');
    if ('error' in res) throw new Error('expected ok');

    const promptArg = fake.startInitialRun.mock.calls[0]![0].prompt as string;
    expect(promptArg).toBe(`[Briefing automatico do LionClaw - pipeline Demo project]\n${customPrompt}`);
    expect(promptArg).not.toContain('- US-01: billing automatico');
  });

  it('envia blueprint operacional quando a fase Design Plan salvou esse prompt', async () => {
    const customPrompt = [
      'Blueprint obrigatorio de produto: LionCron',
      'Vocabulário obrigatorio de UI',
      'GitHub PAT',
      'Anthropic API key',
      'Painel -> `#painel`',
      'Crons -> `#crons`',
      'Runs -> `#runs`',
      'Nao use headline de landing page como "Acesse seu tenant operacional"',
    ].join('\n');
    fs.writeFileSync(PROMPT_PATH, customPrompt, 'utf8');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-od-lioncron-prompt-'));
    const storiesPath = path.join(tmp, 'stories-requisitos.md');
    fs.writeFileSync(
      storiesPath,
      [
        '# User Stories e Requisitos',
        '',
        '#### US-01 - Acesso autenticado e dados isolados',
        'Como dev solo, quero acessar o LionCron em uma sessão autenticada.',
        '',
        '#### US-02 - Conectar API key da Anthropic',
        'Como dev solo, quero conectar minha própria API key da Anthropic.',
        '',
        '#### US-03 - Conectar GitHub PAT',
        'Como dev solo, quero conectar meu GitHub PAT.',
        '',
        '#### US-04 - Criar cron de validação de PR',
        'Como dev solo, quero criar um cron para validar PRs em um repositorio GitHub.',
        '',
        '#### US-08 - Visualizar dashboard de runs',
        'Como dev solo, quero visualizar runs com tokens e custo estimado.',
      ].join('\n'),
      'utf8',
    );
    mockGetPipelineDocsContext.mockReturnValue({
      resolveDocPath: (name: string) => (name === 'stories-requisitos.md' ? storiesPath : null),
    } as never);
    const fake = makeFakeAdapter();
    mockCreateAdapter.mockReturnValue(fake as never);
    const { project } = buildMutableProject({ sessionConfig: sessionConfig() });
    project.name = 'LionCron';
    project.pipelineDocsId = 'Docs-lioncron';

    const res = await ensureSession('p_abc');
    if ('error' in res) throw new Error('expected ok');

    const promptArg = fake.startInitialRun.mock.calls[0]![0].prompt as string;
    expect(promptArg).toBe(`[Briefing automatico do LionClaw - pipeline LionCron]\n${customPrompt}`);
    expect(promptArg).toContain('Blueprint obrigatorio de produto: LionCron');
    expect(promptArg).toContain('Vocabulário obrigatorio de UI');
    expect(promptArg).toContain('GitHub PAT');
    expect(promptArg).toContain('Anthropic API key');
    expect(promptArg).toContain('Painel -> `#painel`');
    expect(promptArg).toContain('Crons -> `#crons`');
    expect(promptArg).toContain('Runs -> `#runs`');
    expect(promptArg).toContain('Nao use headline de landing page como "Acesse seu tenant operacional"');
  });

  it('nao mistura blueprint legado quando existe Design Plan aprovado', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-od-design-plan-prompt-'));
    const discoveryPath = path.join(tmp, 'discovery.md');
    const storiesPath = path.join(tmp, 'stories-requisitos.md');
    fs.writeFileSync(discoveryPath, 'LionCron usa cron, GitHub, Claude e runs para validar PRs.', 'utf8');
    fs.writeFileSync(storiesPath, '#### US-01 - Login\n#### US-05 - Visualizar crons cadastrados', 'utf8');
    mockGetPipelineDocsContext.mockReturnValue({
      resolveDocPath: (name: string) => {
        if (name === 'discovery.md') return discoveryPath;
        if (name === 'stories-requisitos.md') return storiesPath;
        return null;
      },
    } as never);
    const { project } = buildMutableProject({ sessionConfig: sessionConfig() });
    project.name = 'LionCron';
    project.pipelineDocsId = 'Docs-lioncron';
    const designPlanBlock = [
      '## Design Plan aprovado antes do Open Design',
      '- tela-crons (Crons) — Lista crons — stories: US-05',
      'Navegacao planejada:',
      '- Crons -> tela-crons — stories: US-05',
    ].join('\n');

    const prompt = await buildInitialPrompt('p_abc', sessionConfig(), designPlanBlock);

    expect(prompt).toContain(designPlanBlock);
    expect(prompt).not.toContain('Blueprint obrigatorio de produto: LionCron');
    expect(prompt).not.toContain('Painel -> `#painel`');
    expect(prompt).not.toContain('Cobranca -> `#cobranca`');
  });

  it('trava por projectId — chamadas concorrentes convergem na mesma promise (SPEC L1167)', async () => {
    const fake = makeFakeAdapter();
    mockCreateAdapter.mockReturnValue(fake as never);
    buildMutableProject({ sessionConfig: sessionConfig() });

    const [a, b] = await Promise.all([ensureSession('p_abc'), ensureSession('p_abc')]);
    expect('error' in a).toBe(false);
    expect('error' in b).toBe(false);
    expect(fake.createProject).toHaveBeenCalledTimes(1);
    expect(fake.startInitialRun).toHaveBeenCalledTimes(1);
  });

  it('webUrl segue rota canonica /projects/<id>?host=lionclaw (SPEC L144, L953-955)', async () => {
    const fake = makeFakeAdapter();
    mockCreateAdapter.mockReturnValue(fake as never);
    buildMutableProject({ sessionConfig: sessionConfig() });

    const res = await ensureSession('p_abc');
    if ('error' in res) throw new Error('expected ok');

    expect(res.webUrl).not.toMatch(/\/conversations\//);
    expect(res.webUrl).toMatch(/http:\/\/127\.0\.0\.1:5175\/projects\/lionclaw-[a-z0-9-]+\?host=lionclaw&locale=pt-BR/);
  });

  it('A-AC1: prompt entregue NAO carrega heading de orientacoes do orquestrador (amarra revertida)', async () => {
    const fake = makeFakeAdapter();
    mockCreateAdapter.mockReturnValue(fake as never);
    const fileBefore = fs.readFileSync(PROMPT_PATH, 'utf8');
    buildMutableProject({ sessionConfig: sessionConfig() });

    const res = await ensureSession('p_abc');
    if ('error' in res) throw new Error('expected ok');

    const delivered = fake.startInitialRun.mock.calls[0]![0].prompt as string;
    expect(delivered).not.toContain('## Orientacoes do orquestrador');
    expect(delivered).not.toContain('Orientacoes do orquestrador');
    expect(fs.readFileSync(PROMPT_PATH, 'utf8')).toBe(fileBefore);
  });

  it('A-AC1: re-ensureSession recompoe o MESMO texto (hash identico, ZERO reenvio)', async () => {
    const fake = makeFakeAdapter();
    mockCreateAdapter.mockReturnValue(fake as never);
    buildMutableProject({ sessionConfig: sessionConfig() });

    const res1 = await ensureSession('p_abc');
    if ('error' in res1) throw new Error('expected ok');
    expect(fake.startInitialRun).toHaveBeenCalledTimes(1);

    const res2 = await ensureSession('p_abc');
    if ('error' in res2) throw new Error('expected ok');
    expect(res2.initialPromptHash).toBe(res1.initialPromptHash);
    expect(fake.startInitialRun).toHaveBeenCalledTimes(1);
  });

  it('W3-AC5: a primeira linha do prompt entregue tem o rotulo [Briefing automatico do LionClaw - pipeline <nome>]', async () => {
    const fake = makeFakeAdapter();
    mockCreateAdapter.mockReturnValue(fake as never);
    const fileBefore = fs.readFileSync(PROMPT_PATH, 'utf8');
    buildMutableProject({ sessionConfig: sessionConfig() });

    const res = await ensureSession('p_abc');
    if ('error' in res) throw new Error('expected ok');

    const delivered = fake.startInitialRun.mock.calls[0]![0].prompt as string;
    const firstLine = delivered.split('\n')[0]!;
    expect(firstLine).toBe('[Briefing automatico do LionClaw - pipeline Demo project]');
    expect(firstLine).not.toContain('\u2014');
    expect(fs.readFileSync(PROMPT_PATH, 'utf8')).toBe(fileBefore);
    expect(fileBefore).not.toContain('[Briefing automatico do LionClaw');
  });

  it('W3-AC5: rotulo na 1a linha mesmo sem amarra de briefing (revert A1)', async () => {
    const fake = makeFakeAdapter();
    mockCreateAdapter.mockReturnValue(fake as never);
    buildMutableProject({ sessionConfig: sessionConfig() });

    const res = await ensureSession('p_abc');
    if ('error' in res) throw new Error('expected ok');

    const delivered = fake.startInitialRun.mock.calls[0]![0].prompt as string;
    expect(delivered.split('\n')[0]).toBe('[Briefing automatico do LionClaw - pipeline Demo project]');
    expect(delivered).not.toContain('## Orientacoes do orquestrador');
  });

  it('W3-AC5: rotulo e determinista -> re-ensureSession recompoe o MESMO texto (hash identico, zero reenvio)', async () => {
    const fake = makeFakeAdapter();
    mockCreateAdapter.mockReturnValue(fake as never);
    buildMutableProject({ sessionConfig: sessionConfig() });

    const res1 = await ensureSession('p_abc');
    if ('error' in res1) throw new Error('expected ok');
    expect(fake.startInitialRun).toHaveBeenCalledTimes(1);

    const res2 = await ensureSession('p_abc');
    if ('error' in res2) throw new Error('expected ok');
    expect(res2.initialPromptHash).toBe(res1.initialPromptHash);
    expect(fake.startInitialRun).toHaveBeenCalledTimes(1);
  });
});
