import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { createLogger } from '../logger';
import { resolveDesignSnapshotPaths } from '../pipeline-paths';

const logger = createLogger('open-design-design-plan');

const DESIGN_PLAN_VERSION = '1.0';
const DESIGN_PLAN_SCHEMA_VERSION = 4;
const STORY_ID_RE = /\b(?:US|UC)-?\d{1,3}\b/gi;

export interface DesignPlanAction {
  id: string;
  label: string;
  type: string;
  userStoryIds: string[];
}

export interface DesignPlanScreen {
  id: string;
  title: string;
  route: string;
  purpose: string;
  userStoryIds: string[];
  primaryActions: DesignPlanAction[];
  states: string[];
  components: string[];
  dataShownOrEdited: string[];
  apiExpectations: string[];
}

export interface DesignPlanNavigationItem {
  id: string;
  label: string;
  targetScreenId: string;
  userStoryIds: string[];
}

export interface DesignPlanCoverageItem {
  userStoryId: string;
  screenIds: string[];
  notes: string;
}

export interface DesignPlanDelta {
  id: string;
  type: string;
  description: string;
  impact: 'low' | 'medium' | 'high' | string;
  relatedUserStoryIds: string[];
  requiresRequirementsChange: boolean;
}

export interface DesignPlanSampleData {
  label: string;
  value: string;
  userStoryIds: string[];
}

export interface DesignPlan {
  version: '1.0';
  product: {
    name: string;
    oneLine: string;
    primaryUser: string;
    domainTerms: string[];
    forbiddenCopy: string[];
  };
  screens: DesignPlanScreen[];
  navigation: DesignPlanNavigationItem[];
  sampleData: DesignPlanSampleData[];
  coverage: DesignPlanCoverageItem[];
  deltas: DesignPlanDelta[];
  openDesignInstructions: string[];
}

export interface DesignPlanValidatorIssue {
  id: string;
  severity: 'info' | 'minor' | 'major' | 'blocker' | string;
  category: string;
  message: string;
  relatedUserStoryIds: string[];
  suggestedFix: string;
}

export interface DesignPlanValidatorReport {
  approved: boolean;
  issues: DesignPlanValidatorIssue[];
  strengths: string[];
  summary: string;
}

export interface DesignPlanValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  knownStoryIds: string[];
}

export interface EnsureDesignPlanInputs {
  projectId: string;
  projectName: string;
  projectPath: string;
  pipelineDocsId: string | null;
  discovery: string | null;
  stories: string | null;
  prdValidatorNotes: string | null;
  storyCoverageMap: string;
  onText?: (chunk: string) => void;
  onProgress?: (event: {
    stage: 'planner' | 'validator';
    status: 'running' | 'done' | 'warning';
    detail?: string;
  }) => void;
}

export interface EnsureDesignPlanResult {
  ok: boolean;
  plan: DesignPlan;
  validation: DesignPlanValidationResult;
  validatorReport: DesignPlanValidatorReport | null;
  planPath: string;
  validationPath: string;
  promptBlock: string;
  reused: boolean;
  fallback: boolean;
}

function normalizeStoryId(raw: string): string {
  const match = raw.toUpperCase().match(/^([A-Z]+)-?(\d{1,3})$/);
  if (!match) return raw.toUpperCase();
  return `${match[1]}-${match[2].padStart(2, '0')}`;
}

function extractStoryIds(text: string | null): string[] {
  if (!text?.trim()) return [];
  return Array.from(new Set(Array.from(text.matchAll(STORY_ID_RE)).map((m) => normalizeStoryId(m[0])))).sort();
}

interface StoryRef {
  id: string;
  title: string;
  text: string;
  lower: string;
}

function idPattern(id: string): string {
  const [prefix, num] = id.split('-');
  return `${prefix}[- ]?${num}`;
}

function extractStoryRefs(storiesText: string | null, storyCoverageMap: string, knownStoryIds: string[]): StoryRef[] {
  const source = storiesText ?? '';
  return knownStoryIds.map((id) => {
    const heading = new RegExp(`(?:^|\\n)\\s*#{0,6}\\s*${idPattern(id)}\\s*(?:[-—:]+\\s*)?([^\\n]*)`, 'i').exec(source);
    const start = heading?.index ?? source.search(new RegExp(idPattern(id), 'i'));
    const nextMatch = start >= 0
      ? source.slice(start + 1).search(new RegExp(`\\n\\s*#{0,6}\\s*(?:US|UC)[- ]?\\d{1,3}\\b`, 'i'))
      : -1;
    const segment = start >= 0
      ? source.slice(start, nextMatch >= 0 ? start + 1 + nextMatch : start + 2200)
      : '';
    const compactLine = storyCoverageMap
      .split('\n')
      .find((line) => new RegExp(`\\b${idPattern(id)}\\b`, 'i').test(line)) ?? '';
    const title = (heading?.[1]?.trim() || compactLine.replace(/^[-*\s]*/, '').trim() || id)
      .replace(new RegExp(`^${idPattern(id)}\\s*[-—:]*\\s*`, 'i'), '')
      .trim();
    const text = [title, segment, compactLine].filter(Boolean).join('\n');
    return { id, title, text, lower: text.toLowerCase() };
  });
}

function storyIdsMatching(refs: StoryRef[], patterns: RegExp[]): string[] {
  return refs
    .filter((ref) => patterns.some((pattern) => pattern.test(ref.lower)))
    .map((ref) => ref.id);
}

function uniqueStoryIds(...groups: string[][]): string[] {
  return Array.from(new Set(groups.flat()));
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function isDesignPlan(value: unknown): value is DesignPlan {
  const obj = asRecord(value);
  if (!obj) return false;
  const product = asRecord(obj.product);
  return (
    obj.version === DESIGN_PLAN_VERSION &&
    product !== null &&
    typeof product.name === 'string' &&
    Array.isArray(obj.screens) &&
    Array.isArray(obj.navigation) &&
    Array.isArray(obj.coverage) &&
    Array.isArray(obj.deltas) &&
    Array.isArray(obj.openDesignInstructions)
  );
}

export function validateDesignPlan(plan: DesignPlan, knownStoryIds: string[]): DesignPlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const known = new Set(knownStoryIds);
  const hasKnownStories = known.size > 0;

  const screenIds = new Set<string>();
  for (const screen of plan.screens) {
    if (!screen.id) errors.push('screen sem id');
    if (screen.id && screenIds.has(screen.id)) errors.push(`screen duplicada: ${screen.id}`);
    if (screen.id) screenIds.add(screen.id);
    if (!screen.title?.trim()) errors.push(`screen ${screen.id || '(sem id)'} sem title`);
    if (!screen.purpose?.trim()) errors.push(`screen ${screen.id || '(sem id)'} sem purpose`);
    if (!screen.route || screen.route !== `#${screen.id}`) {
      errors.push(`screen ${screen.id || '(sem id)'} precisa ter route "#${screen.id}"`);
    }
    if (!Array.isArray(screen.userStoryIds) || screen.userStoryIds.length === 0) {
      errors.push(`screen ${screen.id || '(sem id)'} sem userStoryIds`);
    }
    for (const us of screen.userStoryIds ?? []) {
      if (hasKnownStories && !known.has(us)) errors.push(`screen ${screen.id} referencia story inexistente: ${us}`);
    }
    for (const action of screen.primaryActions ?? []) {
      if (!action.id) errors.push(`acao sem id na screen ${screen.id}`);
      if (!Array.isArray(action.userStoryIds) || action.userStoryIds.length === 0) {
        errors.push(`acao ${action.id || '(sem id)'} na screen ${screen.id} sem userStoryIds`);
      }
    }
  }

  if (plan.screens.length === 0) errors.push('designPlan precisa ter pelo menos uma screen');

  const navIds = new Set<string>();
  for (const nav of plan.navigation ?? []) {
    if (!nav.id) errors.push('navigation sem id');
    if (nav.id && navIds.has(nav.id)) errors.push(`navigation duplicada: ${nav.id}`);
    if (nav.id) navIds.add(nav.id);
    if (!screenIds.has(nav.targetScreenId)) {
      errors.push(`navigation ${nav.id || '(sem id)'} aponta para screen inexistente: ${nav.targetScreenId}`);
    }
    if (!Array.isArray(nav.userStoryIds) || nav.userStoryIds.length === 0) {
      errors.push(`navigation ${nav.id || '(sem id)'} sem userStoryIds`);
    }
  }

  const covered = new Set<string>();
  for (const screen of plan.screens) {
    for (const us of screen.userStoryIds ?? []) covered.add(us);
  }
  for (const item of plan.coverage ?? []) {
    if (item.userStoryId) covered.add(item.userStoryId);
    for (const sid of item.screenIds ?? []) {
      if (!screenIds.has(sid)) errors.push(`coverage ${item.userStoryId || '(sem story)'} referencia screen inexistente: ${sid}`);
    }
  }
  for (const delta of plan.deltas ?? []) {
    for (const us of delta.relatedUserStoryIds ?? []) covered.add(us);
  }

  if (hasKnownStories) {
    for (const us of knownStoryIds) {
      if (!covered.has(us)) errors.push(`user story sem cobertura no designPlan: ${us}`);
    }
  }

  const domainTerms = asStringArray(plan.product.domainTerms);
  if (domainTerms.length < 3) {
    warnings.push('product.domainTerms tem poucos termos; plano pode ficar generico');
  }
  const forbiddenCopy = asStringArray(plan.product.forbiddenCopy);
  if (forbiddenCopy.length === 0) {
    warnings.push('product.forbiddenCopy vazio; validator qualitativo pode perder copy generica');
  }

  return { ok: errors.length === 0, errors, warnings, knownStoryIds };
}

function buildDeterministicDesignPlan(inputs: EnsureDesignPlanInputs, knownStoryIds: string[]): DesignPlan {
  const isLionCron = [inputs.projectName, inputs.discovery ?? '', inputs.stories ?? '']
    .join('\n')
    .toLowerCase()
    .includes('lioncron');
  const stories = knownStoryIds.length > 0 ? knownStoryIds : ['US-01'];

  if (isLionCron) {
    const refs = extractStoryRefs(inputs.stories, inputs.storyCoverageMap, stories);
    const authIds = storyIdsMatching(refs, [/login|senha|autentic|acessar|sess[aã]o/]);
    const githubIds = storyIdsMatching(refs, [/github|pat\b/]);
    const anthropicIds = storyIdsMatching(refs, [/anthropic|byok|api key|claude/]);
    const billingIds = storyIdsMatching(refs, [/stripe|assinatura|assinar|plano|cobran[cç]a|mensal|r\$\s*49/]);
    const cronCreateIds = storyIdsMatching(refs, [/criar.*cron|novo cron|cadastrar.*cron/]);
    const cronEditIds = storyIdsMatching(refs, [/editar.*cron|alterar.*cron|ajustar.*cron/]);
    const cronDeleteIds = storyIdsMatching(refs, [/deletar.*cron|excluir.*cron|remover.*cron/]);
    const manualRunIds = storyIdsMatching(refs, [/manual|rodar.*cron|executar.*cron/]);
    const prCommentIds = storyIdsMatching(refs, [/coment[aá]rio.*pr|comentar.*pr/]);
    const scheduleIds = storyIdsMatching(refs, [/hor[aá]rio|agend|schedule|cron.*configurad|disparar.*cron/]);
    const reviewPrIds = storyIdsMatching(refs, [/revisar.*pr|validar.*pr|prs? abertos|pull request/]);
    const runIsolationIds = storyIdsMatching(refs, [/ambiente.*run|isol(ar|amento).*run|workdir|execu[cç][aã]o.*isolad/]);
    const dashboardRunIds = storyIdsMatching(refs, [/dashboard|acompanhar.*runs?|runs? em dashboard|status.*runs?/]);
    const logsIds = storyIdsMatching(refs, [/logs? completos?|stdout|tool calls?/]);
    const emailFailureIds = storyIdsMatching(refs, [/email|e-mail|notifica|falha de run|run falhar/]);
    const tenantIsolationIds = storyIdsMatching(refs, [/tenant|tenants|isolamento entre|dados associados/]);
    const auditIds = storyIdsMatching(refs, [/audit|opera[cç][oõ]es de escrita|rastrear|registro de escrita/]);

    const loginStories = authIds.length > 0 ? authIds : [stories[0] ?? 'US-01'];
    const painelStories = uniqueStoryIds(scheduleIds, reviewPrIds, dashboardRunIds);
    const cronsStories = uniqueStoryIds(cronCreateIds, cronEditIds, cronDeleteIds, manualRunIds, prCommentIds, scheduleIds);
    const integracoesStories = uniqueStoryIds(githubIds, anthropicIds, emailFailureIds);
    const runsStories = uniqueStoryIds(dashboardRunIds, logsIds, reviewPrIds, runIsolationIds, emailFailureIds);
    const cobrancaStories = billingIds;
    const auditoriaStories = uniqueStoryIds(tenantIsolationIds, auditIds, runIsolationIds);

    const fallbackScreen = painelStories.length > 0 ? 'painel' : 'crons';
    const actionStories = (ids: string[], screenIds: string[]) => ids.length > 0 ? ids : screenIds;

    const screens: DesignPlanScreen[] = [
      {
        id: 'login',
        title: 'Login',
        route: '#login',
        purpose: 'Autenticar usuario com email e senha antes de acessar crons, credenciais, runs e logs do tenant.',
        userStoryIds: loginStories,
        primaryActions: [
          { id: 'action-login', label: 'Entrar no LionCron', type: 'submit', userStoryIds: loginStories },
        ],
        states: ['idle', 'loading', 'error', 'success'],
        components: ['login-form'],
        dataShownOrEdited: ['email', 'password', 'session_cookie_status'],
        apiExpectations: ['POST /auth/login'],
      },
      {
        id: 'painel',
        title: 'Painel',
        route: '#painel',
        purpose: 'Acompanhar proximas execucoes, runs recentes, falhas, tokens usados e custo estimado.',
        userStoryIds: painelStories,
        primaryActions: [
          { id: 'action-run-selected-cron', label: 'Rodar cron agora', type: 'button', userStoryIds: actionStories(manualRunIds, painelStories) },
        ],
        states: ['loading', 'empty', 'success', 'error'],
        components: ['run-status-strip', 'upcoming-crons', 'runs-table', 'failure-alerts'],
        dataShownOrEdited: ['next_run_at', 'run_status', 'duration', 'tokens', 'estimated_cost', 'failure_reason'],
        apiExpectations: ['GET /runs/summary', 'GET /crons/upcoming', 'POST /crons/{id}/run'],
      },
      {
        id: 'crons',
        title: 'Crons',
        route: '#crons',
        purpose: 'Criar, editar, deletar, disparar manualmente e configurar comentario opcional em PRs.',
        userStoryIds: cronsStories,
        primaryActions: [
          { id: 'action-create-cron', label: 'Novo cron de PR', type: 'button', userStoryIds: actionStories(cronCreateIds, cronsStories) },
          { id: 'action-run-cron-now', label: 'Executar agora', type: 'button', userStoryIds: actionStories(manualRunIds, cronsStories) },
        ],
        states: ['empty', 'editing', 'saving', 'running', 'error', 'success'],
        components: ['cron-list', 'cron-form-drawer', 'pr-comment-toggle', 'delete-confirm-dialog'],
        dataShownOrEdited: ['owner_repo', 'cron_expression', 'agent_prompt', 'comment_on_pr', 'active', 'last_run_status'],
        apiExpectations: ['GET /crons', 'POST /crons', 'PATCH /crons/{id}', 'DELETE /crons/{id}', 'POST /crons/{id}/run'],
      },
      {
        id: 'integracoes',
        title: 'Integracoes',
        route: '#integracoes',
        purpose: 'Conectar GitHub PAT, Anthropic API key BYOK e email de alerta com segredos mascarados.',
        userStoryIds: integracoesStories,
        primaryActions: [
          { id: 'action-save-github-pat', label: 'Salvar GitHub PAT', type: 'submit', userStoryIds: actionStories(githubIds, integracoesStories) },
          { id: 'action-save-anthropic-key', label: 'Salvar Anthropic API key', type: 'submit', userStoryIds: actionStories(anthropicIds, integracoesStories) },
          { id: 'action-save-alert-email', label: 'Salvar email de falha', type: 'submit', userStoryIds: actionStories(emailFailureIds, integracoesStories) },
        ],
        states: ['disconnected', 'connected', 'saving', 'masked', 'error'],
        components: ['github-pat-form', 'anthropic-key-form', 'failure-email-form', 'secret-redaction-note'],
        dataShownOrEdited: ['github_pat_masked', 'anthropic_api_key_masked', 'failure_email', 'connected_at'],
        apiExpectations: ['PUT /integrations/github', 'PUT /integrations/anthropic', 'PUT /notification-email'],
      },
      {
        id: 'runs',
        title: 'Runs e Logs',
        route: '#runs',
        purpose: 'Consultar runs, revisar PRs processados e abrir logs completos com stdout e tool calls redigidos.',
        userStoryIds: runsStories,
        primaryActions: [
          { id: 'action-open-run-log', label: 'Abrir logs', type: 'button', userStoryIds: actionStories(logsIds, runsStories) },
        ],
        states: ['loading', 'empty', 'queued', 'running', 'retrying', 'success', 'failed'],
        components: ['runs-filter-bar', 'runs-table', 'run-log-panel', 'redacted-secret-badge'],
        dataShownOrEdited: ['run_status', 'repository', 'pull_requests', 'stdout', 'tool_calls', 'tokens', 'estimated_cost', 'workdir_id'],
        apiExpectations: ['GET /runs', 'GET /runs/{id}', 'GET /runs/{id}/logs'],
      },
      {
        id: 'cobranca',
        title: 'Cobranca',
        route: '#cobranca',
        purpose: 'Exibir plano unico mensal, status da assinatura e acao via Stripe Link.',
        userStoryIds: cobrancaStories,
        primaryActions: [
          { id: 'action-open-stripe-link', label: 'Assinar por R$49/mes', type: 'link', userStoryIds: actionStories(billingIds, cobrancaStories) },
        ],
        states: ['active', 'inactive', 'loading', 'error'],
        components: ['billing-plan', 'stripe-link-action', 'subscription-status'],
        dataShownOrEdited: ['plan_price', 'subscription_status', 'stripe_link_url'],
        apiExpectations: ['GET /billing/status'],
      },
      {
        id: 'auditoria',
        title: 'Auditoria',
        route: '#auditoria',
        purpose: 'Mostrar isolamento por tenant, trilha de auditoria das escritas e rastreabilidade de execucoes.',
        userStoryIds: auditoriaStories,
        primaryActions: [
          { id: 'action-filter-audit-log', label: 'Filtrar eventos', type: 'button', userStoryIds: auditoriaStories },
        ],
        states: ['loading', 'empty', 'success', 'error'],
        components: ['tenant-scope-banner', 'audit-log-table', 'run-isolation-panel'],
        dataShownOrEdited: ['tenant_id_masked', 'operation', 'actor_email', 'created_at', 'run_workdir', 'resource_id'],
        apiExpectations: ['GET /audit-log', 'GET /tenant/scope'],
      },
    ].filter((screen) => screen.userStoryIds.length > 0);

    const keptScreenIds = new Set(screens.map((screen) => screen.id));
    const navigation: DesignPlanNavigationItem[] = [
      { id: 'nav-painel', label: 'Painel', targetScreenId: 'painel', userStoryIds: painelStories },
      { id: 'nav-crons', label: 'Crons', targetScreenId: 'crons', userStoryIds: cronsStories },
      { id: 'nav-integracoes', label: 'Integracoes', targetScreenId: 'integracoes', userStoryIds: integracoesStories },
      { id: 'nav-runs', label: 'Runs e Logs', targetScreenId: 'runs', userStoryIds: runsStories },
      { id: 'nav-cobranca', label: 'Cobranca', targetScreenId: 'cobranca', userStoryIds: cobrancaStories },
      { id: 'nav-auditoria', label: 'Auditoria', targetScreenId: 'auditoria', userStoryIds: auditoriaStories },
    ].filter((nav) => keptScreenIds.has(nav.targetScreenId) && nav.userStoryIds.length > 0);

    const screenIdsForStory = (userStoryId: string) => {
      const direct = screens
        .filter((screen) => screen.userStoryIds.includes(userStoryId))
        .map((screen) => screen.id);
      return direct.length > 0 ? direct : [keptScreenIds.has(fallbackScreen) ? fallbackScreen : screens[0]?.id ?? 'login'];
    };

    const productName = [inputs.discovery ?? '', inputs.stories ?? ''].join('\n').toLowerCase().includes('lioncron')
      ? 'LionCron'
      : inputs.projectName;

    const plan: DesignPlan = {
      version: '1.0',
      product: {
        name: productName,
        oneLine: 'SaaS operacional para agendar validacoes de PR com agentes Claude usando BYOK.',
        primaryUser: 'dev solo, fundador tecnico ou squad pequeno',
        domainTerms: [
          'crons',
          'runs',
          'validacao de PR',
          'repositorio GitHub',
          'GitHub PAT',
          'Anthropic API key',
          'BYOK',
          'logs',
          'tokens',
          'custo estimado',
          'audit log',
          'Stripe Link',
        ],
        forbiddenCopy: [
          'Acesse seu tenant operacional',
          'controle de acesso',
          'area autenticada',
          'eleve sua produtividade',
          'plataforma completa para seu negocio',
        ],
      },
      screens,
      navigation,
      sampleData: [
        { label: 'Repositorio', value: 'lionlabs/lioncron', userStoryIds: uniqueStoryIds(githubIds, cronCreateIds, reviewPrIds).filter((us) => stories.includes(us)) },
        { label: 'Schedule', value: '0 */6 * * *', userStoryIds: uniqueStoryIds(cronCreateIds, scheduleIds).filter((us) => stories.includes(us)) },
        { label: 'Run falha', value: 'falha - 18.742 tokens - US$0,37', userStoryIds: uniqueStoryIds(dashboardRunIds, logsIds, emailFailureIds).filter((us) => stories.includes(us)) },
        { label: 'Audit log', value: 'cron.updated por admin@exemplo.dev - tenant lc_4827', userStoryIds: uniqueStoryIds(tenantIsolationIds, auditIds).filter((us) => stories.includes(us)) },
      ].filter((item) => item.userStoryIds.length > 0),
      coverage: stories.map((userStoryId) => ({ userStoryId, screenIds: screenIdsForStory(userStoryId), notes: 'Cobertura deterministica por semantica da user story.' })),
      deltas: [],
      openDesignInstructions: [
        'Trate este plano como blueprint obrigatorio de produto e gere uma SPA operacional, nao uma landing page.',
        'Nao crie hero, pitch, secao "sobre o produto", card promocional, bloco de explicacao conceitual ou texto de marketing.',
        'A tela de login deve ser compacta: formulario direto, sem demo card abaixo, sem split vazio e sem explicar regras de negocio na tela.',
        'Depois do submit do login, o usuario deve cair no app shell interno com sidebar e conteudo funcional; o produto real aparece nas telas internas.',
        'Arquivo unico index.html e correto, mas telas empilhadas no scroll sao proibidas. Apenas uma section de screen pode ficar visivel por vez.',
        'Inclua CSS [hidden] { display: none !important; } e use JS real para alternar hidden entre login e telas internas.',
        'Nunca deixe login acima do app shell ou visivel junto com integracoes, crons, runs, cobranca ou auditoria ao rolar a pagina.',
        'Gere os fluxos clicaveis de todas as telas planejadas: navegacao primaria, formulario de cron, edicao, delete com confirmacao, integracoes, runs/logs e cobranca quando existirem no plano.',
        'Nao escreva regra de negocio, contrato, criterio de aceite ou racional tecnico como copy visivel. Regras ficam no contract/deltas; a UI mostra labels, dados, estados, feedback e acoes.',
        'Cada tela interna precisa ter densidade operacional: tabelas, formularios, filtros, detalhes, estados vazios/erro/loading e botoes reais. Nao use cards decorativos mostrando "como seria".',
        'Nao deixe metade da viewport vazia em desktop. Use app shell de largura total com sidebar/topbar e area principal preenchida.',
        'Nao agrupe auditoria, isolamento, logs e cobranca dentro do login.',
      ],
    };
    return plan;
  }

  return {
    version: '1.0',
    product: {
      name: inputs.projectName,
      oneLine: 'Aplicacao baseada nas user stories aprovadas.',
      primaryUser: 'usuario principal definido no discovery',
      domainTerms: ['dashboard', 'registros', 'configuracao'],
      forbiddenCopy: ['acesse seu ambiente', 'painel operacional', 'eleve sua produtividade'],
    },
    screens: [
      {
        id: 'login',
        title: 'Login',
        route: '#login',
        purpose: 'Autenticar usuario antes de acessar dados protegidos.',
        userStoryIds: [stories[0]],
        primaryActions: [{ id: 'action-login', label: 'Entrar', type: 'submit', userStoryIds: [stories[0]] }],
        states: ['idle', 'loading', 'error', 'success'],
        components: ['login-form'],
        dataShownOrEdited: ['email', 'password'],
        apiExpectations: ['POST /auth/login'],
      },
      {
        id: 'principal',
        title: 'Principal',
        route: '#principal',
        purpose: 'Executar as principais tarefas do produto usando dados das stories aprovadas.',
        userStoryIds: stories,
        primaryActions: [{ id: 'action-primary', label: 'Executar acao principal', type: 'button', userStoryIds: stories }],
        states: ['loading', 'empty', 'success', 'error'],
        components: ['primary-list', 'detail-panel', 'form-drawer'],
        dataShownOrEdited: ['entidade_principal'],
        apiExpectations: ['GET /resources', 'POST /resources'],
      },
    ],
    navigation: [{ id: 'nav-principal', label: 'Principal', targetScreenId: 'principal', userStoryIds: stories }],
    sampleData: [],
    coverage: stories.map((userStoryId) => ({ userStoryId, screenIds: ['principal'], notes: 'Cobertura deterministica.' })),
    deltas: [],
    openDesignInstructions: [
      'Gere uma SPA operacional, nao uma landing page.',
      'Use entidades concretas das user stories e evite copy generica.',
      'Nao escreva regras de negocio na tela; mostre apenas dados, estados, formularios e acoes.',
      'Gere os fluxos de todas as telas necessarias com navegacao clicavel.',
      'Arquivo unico index.html e permitido, mas telas empilhadas no scroll sao proibidas. Use [hidden] e JS real para mostrar apenas uma section por vez.',
    ],
  };
}

function buildPlanPromptBlock(
  plan: DesignPlan,
  validation: DesignPlanValidationResult,
  validatorReport: DesignPlanValidatorReport | null,
  fallback: boolean,
): string {
  const statusLine = fallback
    ? `Plano operacional validado pelo codigo; validacao deterministica: ${validation.ok ? 'aprovada' : 'rejeitada'}.`
    : `Plano deterministico gerado pelo LionClaw; validacao deterministica: ${validation.ok ? 'aprovada' : 'rejeitada'}.`;
  const validatorLine = validatorReport?.approved === false
    ? `Riscos do validator: ${validatorReport.summary}`
    : null;
  return `## Design Plan aprovado antes do LionDesign

Este e o blueprint de produto para o artifact visual. O schema do design-contract e o Design Lock continuam tendo prioridade maxima.
${statusLine}
${validatorLine ? `${validatorLine}\n` : ''}

Telas planejadas:
${plan.screens.map((screen) => `- ${screen.id} (${screen.title}) — ${screen.purpose} — stories: ${screen.userStoryIds.join(', ')}`).join('\n')}

Navegacao planejada:
${plan.navigation.map((nav) => `- ${nav.label} -> ${nav.targetScreenId} — stories: ${nav.userStoryIds.join(', ')}`).join('\n') || '(sem navegacao primaria)'}

Vocabulario obrigatorio de dominio:
${plan.product.domainTerms.map((term) => `- ${term}`).join('\n') || '(nao declarado)'}

Copy proibida ou arriscada:
${plan.product.forbiddenCopy.map((copy) => `- ${copy}`).join('\n') || '(nao declarado)'}

Dados fake recomendados:
${plan.sampleData.map((item) => `- ${item.label}: ${item.value} — stories: ${item.userStoryIds.join(', ')}`).join('\n') || '(nao declarado)'}

Instrucoes especificas para LionDesign:
${plan.openDesignInstructions.map((item) => `- ${item}`).join('\n') || '(nenhuma)'}

Cobertura planejada:
${plan.coverage.map((item) => `- ${item.userStoryId}: ${item.screenIds.join(', ')} — ${item.notes}`).join('\n')}

Regras para usar este plano:
- Use este plano como mapa operacional, nao como copy literal.
- Nao mostre este plano, JSON, criterios internos ou racional no HTML.
- O HTML final deve mostrar apenas a SPA funcional do produto.
- Nao gere landing page, hero, pitch comercial, galeria de telas ou secoes explicativas.
- Um index.html unico e permitido; telas empilhadas no scroll sao proibidas.
- Inclua CSS \`[hidden] { display: none !important; }\` e JS real para alternar qual \`section\` esta visivel.
- Login e app shell nunca podem coexistir visualmente. Ao submeter login, esconda login e mostre a primeira tela interna.
- Gere os fluxos de todas as telas necessarias com navegacao clicavel.
- Nao escreva regra de negocio, criterio de aceite ou contrato como texto visivel na UI.`;
}

function getPlanPaths(projectPath: string, pipelineDocsId: string | null): {
  planPath: string;
  validationPath: string;
  promptBlockPath: string;
} {
  const snapshot = resolveDesignSnapshotPaths(projectPath, pipelineDocsId);
  const dir = snapshot?.snapshotDir ?? path.join(projectPath, '.lionclaw', 'open-design');
  fs.mkdirSync(dir, { recursive: true });
  return {
    planPath: path.join(dir, 'design-plan.json'),
    validationPath: path.join(dir, 'design-plan-validation.json'),
    promptBlockPath: path.join(dir, 'design-plan-prompt.md'),
  };
}

function readReusablePlan(
  paths: ReturnType<typeof getPlanPaths>,
  inputHash: string,
): { plan: DesignPlan; validation: DesignPlanValidationResult; validatorReport: DesignPlanValidatorReport | null; fallback: boolean } | null {
  if (!fs.existsSync(paths.planPath) || !fs.existsSync(paths.validationPath)) return null;
  try {
    const planRaw = JSON.parse(fs.readFileSync(paths.planPath, 'utf-8')) as { inputHash?: string; plan?: unknown };
    const validationRaw = JSON.parse(fs.readFileSync(paths.validationPath, 'utf-8')) as {
      inputHash?: string;
      validation?: DesignPlanValidationResult;
      validatorReport?: DesignPlanValidatorReport | null;
    };
    if (planRaw.inputHash !== inputHash || validationRaw.inputHash !== inputHash) return null;
    const isLegacyFallback = Boolean((planRaw as { fallback?: unknown }).fallback || (validationRaw as { fallback?: unknown }).fallback);
    if (isLegacyFallback) return null;
    if (!isDesignPlan(planRaw.plan)) return null;
    const validation = validateDesignPlan(planRaw.plan, validationRaw.validation?.knownStoryIds ?? []);
    if (!validation.ok) return null;
    return {
      plan: planRaw.plan,
      validation,
      validatorReport: validationRaw.validatorReport ?? null,
      fallback: false,
    };
  } catch {
    return null;
  }
}

export async function ensureDesignPlan(inputs: EnsureDesignPlanInputs): Promise<EnsureDesignPlanResult> {
  const knownStoryIds = extractStoryIds(inputs.stories);
  const inputHash = sha256(JSON.stringify({
    schema: DESIGN_PLAN_SCHEMA_VERSION,
    projectName: inputs.projectName,
    discovery: inputs.discovery ?? '',
    stories: inputs.stories ?? '',
    prdValidatorNotes: inputs.prdValidatorNotes ?? '',
    storyCoverageMap: inputs.storyCoverageMap,
  }));
  const paths = getPlanPaths(inputs.projectPath, inputs.pipelineDocsId);

  const reusable = readReusablePlan(paths, inputHash);
  if (reusable) {
    const promptBlock = buildPlanPromptBlock(reusable.plan, reusable.validation, reusable.validatorReport, reusable.fallback);
    fs.writeFileSync(paths.promptBlockPath, promptBlock, 'utf-8');
    inputs.onText?.('[Design Plan] Reutilizando plano de telas ja validado.\n');
    inputs.onProgress?.({ stage: 'planner', status: 'done', detail: 'Plano de telas ja validado foi reutilizado.' });
    inputs.onProgress?.({ stage: 'validator', status: 'done', detail: 'Validacao do plano reutilizada.' });
    return {
      ok: true,
      ...reusable,
      planPath: paths.planPath,
      validationPath: paths.validationPath,
      promptBlock,
      reused: true,
      fallback: reusable.fallback,
    };
  }

  inputs.onText?.('[Design Plan] Gerando plano deterministico de telas e prompt oficial do LionDesign...\n');
  inputs.onProgress?.({ stage: 'planner', status: 'running', detail: 'planner deterministico' });
  const plan = buildDeterministicDesignPlan(inputs, knownStoryIds);
  const validation = validateDesignPlan(plan, knownStoryIds);
  if (!validation.ok) {
    const message = validation.errors.join('; ');
    logger.warn({ projectId: inputs.projectId, errors: validation.errors }, 'deterministic design plan failed validation');
    inputs.onText?.(`[Design Plan] Plano deterministico rejeitado: ${message}\n`);
    inputs.onProgress?.({ stage: 'planner', status: 'warning', detail: message });
    throw new Error(`Design Plan deterministico invalido: ${message}`);
  }

  const promptBlock = buildPlanPromptBlock(plan, validation, null, false);
  fs.writeFileSync(paths.planPath, JSON.stringify({ inputHash, plan, fallback: false, source: 'deterministic' }, null, 2), 'utf-8');
  fs.writeFileSync(paths.validationPath, JSON.stringify({ inputHash, validation, validatorReport: null, fallback: false, source: 'deterministic' }, null, 2), 'utf-8');
  fs.writeFileSync(paths.promptBlockPath, promptBlock, 'utf-8');
  inputs.onText?.('[Design Plan] Plano deterministico aprovado e salvo.\n');
  inputs.onProgress?.({ stage: 'planner', status: 'done', detail: 'Plano deterministico aprovado.' });
  inputs.onProgress?.({ stage: 'validator', status: 'done', detail: 'Validacao deterministica aprovada.' });
  return {
    ok: true,
    plan,
    validation,
    validatorReport: null,
    planPath: paths.planPath,
    validationPath: paths.validationPath,
    promptBlock,
    reused: false,
    fallback: false,
  };
}
