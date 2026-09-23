import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureDesignPlan, validateDesignPlan, type DesignPlan } from '../open-design/design-plan';

function makePlan(overrides: Partial<DesignPlan> = {}): DesignPlan {
  return {
    version: '1.0',
    product: {
      name: 'LionCron',
      oneLine: 'Agendamento de validacao de PR com agentes Claude.',
      primaryUser: 'dev solo',
      domainTerms: ['crons', 'runs', 'GitHub PAT', 'Anthropic API key'],
      forbiddenCopy: ['Acesse seu tenant operacional'],
    },
    screens: [
      {
        id: 'login',
        title: 'Login',
        route: '#login',
        purpose: 'Autenticar usuario.',
        userStoryIds: ['US-01'],
        primaryActions: [{ id: 'action-login', label: 'Entrar', type: 'submit', userStoryIds: ['US-01'] }],
        states: ['idle', 'loading', 'error', 'success'],
        components: ['login-form'],
        dataShownOrEdited: ['email', 'password'],
        apiExpectations: ['POST /auth/login'],
      },
      {
        id: 'integracoes',
        title: 'Integracoes',
        route: '#integracoes',
        purpose: 'Conectar chaves BYOK.',
        userStoryIds: ['US-02'],
        primaryActions: [
          { id: 'action-save-key', label: 'Salvar Anthropic API key', type: 'submit', userStoryIds: ['US-02'] },
        ],
        states: ['connected', 'disconnected', 'saving', 'error'],
        components: ['anthropic-key-form'],
        dataShownOrEdited: ['anthropic_api_key'],
        apiExpectations: ['PUT /integrations/anthropic'],
      },
    ],
    navigation: [
      { id: 'nav-integracoes', label: 'Integracoes', targetScreenId: 'integracoes', userStoryIds: ['US-02'] },
    ],
    sampleData: [{ label: 'Repositorio', value: 'lionlabs/lioncron', userStoryIds: ['US-02'] }],
    coverage: [
      { userStoryId: 'US-01', screenIds: ['login'], notes: 'Acesso.' },
      { userStoryId: 'US-02', screenIds: ['integracoes'], notes: 'BYOK.' },
    ],
    deltas: [],
    openDesignInstructions: ['Use app shell real, nao landing page.'],
    ...overrides,
  };
}

describe('open-design design-plan', () => {
  it('valida cobertura, rotas e navegacao do designPlan', () => {
    const valid = validateDesignPlan(makePlan(), ['US-01', 'US-02']);
    expect(valid.ok).toBe(true);

    const invalid = validateDesignPlan(
      makePlan({
        navigation: [{ id: 'nav-missing', label: 'Missing', targetScreenId: 'missing', userStoryIds: ['US-02'] }],
        coverage: [{ userStoryId: 'US-01', screenIds: ['login'], notes: 'Acesso.' }],
      }),
      ['US-01', 'US-02'],
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join('\n')).toContain('screen inexistente');
  });

  it('gera plano deterministico, salva arquivos e retorna bloco para o prompt do Open Design', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-design-plan-'));
    const chunks: string[] = [];
    const result = await ensureDesignPlan({
      projectId: 'p1',
      projectName: 'LionCron',
      projectPath: tmp,
      pipelineDocsId: null,
      discovery: 'LionCron roda crons de validacao de PR no GitHub com Claude.',
      stories: [
        '#### US-01 - Acesso autenticado',
        'Como dev solo, quero acessar com sessao.',
        '#### US-02 - Conectar API key da Anthropic',
        'Como dev solo, quero conectar BYOK.',
      ].join('\n'),
      prdValidatorNotes: null,
      storyCoverageMap: '- US-01: Acesso autenticado\n- US-02: Conectar API key da Anthropic',
      onText: (chunk) => chunks.push(chunk),
    });

    expect(result.ok).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.validatorReport).toBeNull();
    expect(result.promptBlock).toContain('Design Plan aprovado antes do LionDesign');
    expect(result.promptBlock).toContain('Plano deterministico gerado pelo LionClaw');
    expect(result.promptBlock).toContain('GitHub PAT');
    expect(result.promptBlock).toContain('Nao gere landing page');
    expect(result.promptBlock).toContain('telas empilhadas no scroll sao proibidas');
    expect(result.promptBlock).toContain('[hidden] { display: none !important; }');
    expect(fs.existsSync(result.planPath)).toBe(true);
    expect(fs.existsSync(result.validationPath)).toBe(true);
    expect(chunks.join('')).toContain('Gerando plano deterministico');
    expect(chunks.join('')).toContain('Plano deterministico aprovado');
  });

  it('plano deterministico LionCron mapeia stories operacionais sem jogar tudo no login', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-design-plan-deterministic-lioncron-'));
    const result = await ensureDesignPlan({
      projectId: 'p-lioncron-deterministic',
      projectName: 'Newpipe',
      projectPath: tmp,
      pipelineDocsId: null,
      discovery: 'O produto LionCron agenda validacoes de PR no GitHub com BYOK.',
      stories: [
        '#### US-01 - Acessar o LionCron com email e senha',
        '#### US-02 - Conectar credencial do GitHub via PAT',
        '#### US-03 - Conectar API key da Anthropic em modelo BYOK',
        '#### US-04 - Acessar assinatura mensal via Stripe Link',
        '#### US-05 - Criar cron de validação de PR no GitHub',
        '#### US-06 - Editar cron de validação de PR',
        '#### US-07 - Deletar cron de validação de PR',
        '#### US-08 - Executar cron manualmente',
        '#### US-09 - Escolher comentário opcional no PR',
        '#### US-10 - Disparar cron no horário configurado',
        '#### US-11 - Revisar PRs abertos do repositório configurado',
        '#### US-12 - Isolar ambiente de execução por run',
        '#### US-13 - Acompanhar runs em dashboard',
        '#### US-14 - Ver logs completos de uma run',
        '#### US-15 - Receber email em caso de falha de run',
        '#### US-16 - Manter isolamento entre tenants',
        '#### US-17 - Auditar operações de escrita',
      ].join('\n'),
      prdValidatorNotes: null,
      storyCoverageMap: [
        '- US-01: Acessar o LionCron com email e senha',
        '- US-02: Conectar credencial do GitHub via PAT',
        '- US-03: Conectar API key da Anthropic em modelo BYOK',
        '- US-04: Acessar assinatura mensal via Stripe Link',
        '- US-05: Criar cron de validação de PR no GitHub',
        '- US-06: Editar cron de validação de PR',
        '- US-07: Deletar cron de validação de PR',
        '- US-08: Executar cron manualmente',
        '- US-09: Escolher comentário opcional no PR',
        '- US-10: Disparar cron no horário configurado',
        '- US-11: Revisar PRs abertos do repositório configurado',
        '- US-12: Isolar ambiente de execução por run',
        '- US-13: Acompanhar runs em dashboard',
        '- US-14: Ver logs completos de uma run',
        '- US-15: Receber email em caso de falha de run',
        '- US-16: Manter isolamento entre tenants',
        '- US-17: Auditar operações de escrita',
      ].join('\n'),
    });

    expect(result.ok).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.plan.product.name).toBe('LionCron');
    expect(result.plan.screens.map((screen) => screen.id)).toEqual(
      expect.arrayContaining(['crons', 'integracoes', 'runs', 'cobranca', 'auditoria']),
    );
    expect(result.plan.coverage.find((item) => item.userStoryId === 'US-12')?.screenIds).toContain('runs');
    expect(result.plan.coverage.find((item) => item.userStoryId === 'US-16')?.screenIds).toContain('auditoria');
    expect(result.plan.coverage.find((item) => item.userStoryId === 'US-17')?.screenIds).toContain('auditoria');
    expect(result.promptBlock).toContain('Nao gere landing page');
    expect(result.promptBlock).toContain('Login e app shell nunca podem coexistir visualmente');
    expect(result.promptBlock).not.toContain('"screens"');
  });
});
