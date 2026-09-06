import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger';
import { getHarnessProject } from '../db';
import { getOpenDesignConfig, setOpenDesignConfig } from './config';
import { assertValidSessionConfig, getSessionConfig } from './session-config';
import { getBootInstallStatus } from './boot-installer';
import * as manager from './manager';
import { createAdapter } from './adapter-http';
import {
  getPipelineDocsContext,
  resolveOpenDesignPromptPath,
} from '../pipeline-paths';
import type { Adapter } from './adapter-http';
import { emitIPC } from '../pipeline-shared/ipc-emitter';
import { persistMessage } from '../pipeline-shared/persist';
import type {
  BootstrapResult,
  OpenDesignBootstrapProgressEvent,
  OpenDesignBootstrapProgressStatus,
  OpenDesignBootstrapStage,
  OpenDesignConfig,
  OpenDesignSessionConfig,
} from '../../../src/types/open-design';


const logger = createLogger('open-design-bootstrap');

const inFlightByProject = new Map<string, Promise<BootstrapResult | { error: string }>>();


function emitBootstrapProgress(
  projectId: string,
  stage: OpenDesignBootstrapStage,
  status: OpenDesignBootstrapProgressStatus,
  label: string,
  detail?: string,
): void {
  const event: OpenDesignBootstrapProgressEvent = {
    projectId,
    stage,
    status,
    label,
    ...(detail ? { detail } : {}),
    at: new Date().toISOString(),
  };
  emitIPC('open-design:bootstrap-progress', event);
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function sanitizeId(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function shortUuid(): string {
  return crypto.randomBytes(4).toString('hex');
}

function hashSessionConfig(cfg: OpenDesignSessionConfig): string {
  const stable = JSON.stringify(cfg, Object.keys(cfg).sort());
  return sha256(stable);
}

export function persistOpenDesignPromptOutput(
  projectId: string,
  project: { projectPath: string; pipelineDocsId?: string | null },
  promptText: string,
): string {
  const promptPath = resolveOpenDesignPromptPath(
    project.projectPath,
    project.pipelineDocsId ?? null,
  );
  fs.writeFileSync(promptPath, promptText, 'utf8');
  emitIPC('pipeline:document-updated', {
    projectId,
    path: promptPath,
    content: promptText,
  });
  emitIPC('pipeline:stream', {
    projectId,
    phase: 4,
    type: 'text',
    content: `\n[LionDesign Prompt] Output da fase 4 salvo em ${promptPath}\n`,
  });
  return promptPath;
}

export function persistOpenDesignPromptMessage(
  projectId: string,
  promptText: string,
  promptPath: string,
): void {
  const content = [
    '# Prompt enviado ao LionDesign',
    '',
    `Arquivo oficial da fase 4: \`${promptPath}\``,
    '',
    promptText,
  ].join('\n');
  persistMessage(
    { kind: 'pipeline', projectId, phaseNumber: 4 },
    'assistant',
    content,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasActiveRun(raw: unknown): boolean {
  if (!isRecord(raw) || !Array.isArray(raw['runs'])) return false;
  return raw['runs'].some((run) => {
    if (!isRecord(run)) return false;
    const status = run['status'];
    return status === 'queued' || status === 'running';
  });
}

export const BRIEFING_LABEL_PREFIX = '[Briefing automatico do LionClaw - pipeline';

export function prependBriefingLabel(promptText: string, projectName: string): string {
  return `${BRIEFING_LABEL_PREFIX} ${projectName}]\n${promptText}`;
}

async function hasDeliveredPromptMessage(
  adapter: Adapter,
  openDesignProjectId: string,
  conversationId: string,
  promptHash: string,
): Promise<boolean> {
  const messages = await adapter.listMessages(openDesignProjectId, conversationId);
  return messages.some((message) => {
    if (message.role !== 'user') return false;
    return sha256(message.content ?? '') === promptHash;
  });
}

async function shouldResendSamePrompt(
  adapter: Adapter,
  openDesignProjectId: string,
  conversationId: string,
  projectId: string,
  promptHash: string,
): Promise<boolean> {
  try {
    if (await hasDeliveredPromptMessage(adapter, openDesignProjectId, conversationId, promptHash)) {
      return false;
    }

    logger.warn(
      { projectId, openDesignProjectId, conversationId },
      'bootstrap: initial prompt hash unchanged but OD conversation has no matching user prompt; resending prompt',
    );
    return true;
  } catch (err) {
    if (isConversationNotFoundError(err)) {
      logger.warn(
        { err, projectId, openDesignProjectId, conversationId },
        'bootstrap: OD conversation missing while verifying cached prompt; resending prompt',
      );
      return true;
    }
    logger.warn(
      { err, projectId, openDesignProjectId, conversationId },
      'bootstrap: could not verify OD prompt message state; keeping idempotent skip',
    );
    return false;
  }
}

async function assertPromptDelivered(
  adapter: Adapter,
  openDesignProjectId: string,
  conversationId: string,
  promptHash: string,
): Promise<void> {
  if (await hasDeliveredPromptMessage(adapter, openDesignProjectId, conversationId, promptHash)) {
    return;
  }

  const runs = await adapter.callRaw(
    'GET',
    `/api/runs?projectId=${encodeURIComponent(openDesignProjectId)}&conversationId=${encodeURIComponent(conversationId)}`,
  ).catch(() => null);
  const active = hasActiveRun(runs);
  throw new Error(
    active
      ? 'Prompt inicial ainda nao apareceu na conversa do LionDesign, embora exista run ativo.'
      : 'Prompt inicial nao foi encontrado na conversa do LionDesign apos envio.',
  );
}

function generateRunId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const hex = crypto.randomBytes(3).toString('hex');
  return `${ts}-${hex}`;
}

function ensureRunDir(
  projectId: string,
  projectPath: string,
  cfg: { runDir?: string; runId?: string } | null,
): { runDir: string; runId: string } {
  if (cfg?.runDir && cfg.runId && fs.existsSync(cfg.runDir)) {
    return { runDir: cfg.runDir, runId: cfg.runId };
  }

  const runId = cfg?.runId ?? generateRunId();
  const runDir = path.join(projectPath, '.lionclaw', 'pipelines', 'development-v2', runId);

  fs.mkdirSync(runDir, { recursive: true });
  setOpenDesignConfig(projectId, { runDir, runId });

  logger.info({ projectId, runId, runDir }, 'bootstrap: initialized runDir for development-v2');
  return { runDir, runId };
}

function buildStudioUrl(webUrl: string, openDesignProjectId: string): string {
  const base = webUrl.endsWith('/') ? webUrl.slice(0, -1) : webUrl;
  return `${base}/projects/${encodeURIComponent(openDesignProjectId)}?host=lionclaw&locale=pt-BR`;
}

async function syncSidecarAppConfig(
  adapter: Adapter,
  sessionConfig: OpenDesignSessionConfig,
  projectId: string,
): Promise<void> {
  try {
    const current = await adapter.getAppConfig();
    const nextAgentModels = {
      ...(current.config.agentModels ?? {}),
      [sessionConfig.agentId]: {
        model: sessionConfig.model,
        ...(sessionConfig.reasoning ? { reasoning: sessionConfig.reasoning } : {}),
      },
    };
    await adapter.updateAppConfig({
      agentId: sessionConfig.agentId,
      agentModels: nextAgentModels,
      designSystemId: sessionConfig.designSystemId ?? null,
    });
    logger.info(
      { projectId, agentId: sessionConfig.agentId, model: sessionConfig.model },
      'bootstrap: synced OD app-config with LionClaw sessionConfig',
    );
  } catch (err) {
    logger.warn(
      { projectId, agentId: sessionConfig.agentId, model: sessionConfig.model, err },
      'bootstrap: failed to sync OD app-config; initial run still uses explicit sessionConfig',
    );
  }
}

function isConversationNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /404\b/i.test(message) && /conversation not found/i.test(message);
}


function tryReadFile(p: string | null | undefined): string | null {
  if (!p) return null;
  try {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

const MAX_SOURCE_EXCERPT_CHARS = 3200;
const MAX_STORY_SUMMARIES = 36;
const MAX_STORY_SNIPPET_CHARS = 380;

const STORY_ID_RE = /\b(?:US|UC)-?\d{1,3}\b/gi;
const STORY_HEADING_RE = /^#{2,6}\s*((?:US|UC)-?\d{1,3})\s*(?:[-–—:]\s*|\s+)(.+?)\s*$/gim;

interface StorySummaryBlock {
  id: string;
  title: string;
  body: string;
}

function normalizeStoryId(raw: string): string {
  const match = raw.toUpperCase().match(/^([A-Z]+)-?(\d{1,3})$/);
  if (!match) return raw.toUpperCase();
  return `${match[1]}-${match[2].padStart(2, '0')}`;
}

function compactInline(text: string, maxChars: number): string {
  const compacted = text
    .replace(/\s+/g, ' ')
    .replace(/[`*_>#-]+/g, '')
    .trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, maxChars - 1).trim()}…`;
}

function firstLineMatching(block: string, pattern: RegExp): string | null {
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(pattern);
    if (match) return (match[1] ?? match[0]).trim();
  }
  return null;
}

function collectStorySummaryBlocks(stories: string): StorySummaryBlock[] {
  const matches = Array.from(stories.matchAll(STORY_HEADING_RE));
  if (matches.length === 0) return [];

  return matches.map((match, index) => {
    const id = normalizeStoryId(match[1] ?? '');
    const title = compactInline(match[2] ?? '', 120);
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? stories.length;
    return {
      id,
      title,
      body: stories.slice(start, end),
    };
  });
}

function renderStorySummaryLine(story: StorySummaryBlock): string {
  const persona = firstLineMatching(story.body, /^Como\b(.+)$/i);
  const interfaceExpected = firstLineMatching(story.body, /^Interface esperada:\s*(.+)$/i);
  const criteriaCount = (story.body.match(/^\s*\d+\.\s+/gm) ?? []).length;
  const parts = [
    story.title,
    persona ? `Como${persona}` : null,
    interfaceExpected ? `Interface: ${interfaceExpected}` : null,
    criteriaCount > 0 ? `${criteriaCount} criterios de aceite` : null,
  ].filter(Boolean);
  return compactInline(parts.join(' | '), MAX_STORY_SNIPPET_CHARS);
}

function truncateSourceExcerpt(content: string | null, label: string): string {
  if (!content?.trim()) return `(${label} ausente)`;
  if (content.length <= MAX_SOURCE_EXCERPT_CHARS) return content.trim();
  const head = content.slice(0, Math.floor(MAX_SOURCE_EXCERPT_CHARS * 0.58));
  const tail = content.slice(content.length - Math.floor(MAX_SOURCE_EXCERPT_CHARS * 0.32));
  return `${head.trim()}\n\n... (${label} compactado — ${content.length - head.length - tail.length} chars omitidos; use como fonte de conferencia, nao como copy literal) ...\n\n${tail.trim()}`;
}

function buildStoryCoverageMap(stories: string | null): string {
  if (!stories?.trim()) {
    return '(stories-requisitos.md ausente — nao inventar escopo; pedir esclarecimentos antes de criar telas novas)';
  }

  const found = new Map<string, { index: number; raw: string }>();
  for (const match of stories.matchAll(STORY_ID_RE)) {
    const raw = match[0];
    const id = normalizeStoryId(raw);
    if (!found.has(id)) {
      found.set(id, { index: match.index ?? 0, raw });
    }
  }

  if (found.size === 0) {
    return (
      'Nenhum ID de story no padrao US-01/UC-01 foi detectado. ' +
      'Use o trecho abaixo apenas como fonte de escopo e crie IDs rastreaveis no contract se necessario.\n\n' +
      truncateSourceExcerpt(stories, 'stories-requisitos')
    );
  }

  const storyBlocks = collectStorySummaryBlocks(stories);
  if (storyBlocks.length > 0) {
    const lines = storyBlocks.slice(0, MAX_STORY_SUMMARIES).map((story) => {
      return `- ${story.id}: ${renderStorySummaryLine(story)}`;
    });
    if (storyBlocks.length > MAX_STORY_SUMMARIES) {
      lines.push(`- (${storyBlocks.length - MAX_STORY_SUMMARIES} stories adicionais omitidas do mapa compacto; ainda devem ser cobertas se aparecerem nas fontes.)`);
    }
    return lines.join('\n');
  }

  const lines: string[] = [];
  let count = 0;
  const foundEntries = Array.from(found.entries());
  for (const [entryIndex, [id, info]] of foundEntries.entries()) {
    if (count >= MAX_STORY_SUMMARIES) {
      lines.push(`- (${found.size - MAX_STORY_SUMMARIES} stories adicionais omitidas do mapa compacto; ainda devem ser cobertas ou registradas como delta se aparecerem nas fontes.)`);
      break;
    }
    const start = info.index;
    const nextIndex = foundEntries[entryIndex + 1]?.[1].index;
    const end = Math.min(nextIndex ?? stories.length, info.index + MAX_STORY_SNIPPET_CHARS);
    const snippet = compactInline(stories.slice(start, end), MAX_STORY_SNIPPET_CHARS);
    lines.push(`- ${id}: ${snippet}`);
    count += 1;
  }
  return lines.join('\n');
}

function buildOpenDesignFrontendSkillBlock(): string {
  return `## Skill aplicada: Frontend de Alto Nivel (adaptada para LionDesign)

Esta skill e uma camada de craft visual. Ela NUNCA substitui escopo, contrato ou rastreabilidade por user stories.

Baseline ativo:
- DESIGN_VARIANCE: 8 — layouts assimetricos e memoraveis em desktop; mobile sempre colapsa para coluna unica sem scroll horizontal.
- MOTION_INTENSITY: 6 — microinteracoes e movimento fluido, mas sem comprometer performance.
- VISUAL_DENSITY: 4 — app web claro, arejado e usavel no dia a dia.

Regras de hierarquia:
1. Contract + Design Lock vencem qualquer decisao estetica.
2. Cobertura de user stories vence qualquer ideia visual.
3. Cada tela, navegacao, acao, dado e API precisa declarar userStoryIds reais.
4. Elementos sem rastreio entram em deltas[]; nao viram escopo final escondido.

Direcao de frontend:
- Evite UI generica de IA: nada de roxo/azul neon, blobs decorativos, H1 central gigante, 3 cards iguais, nomes falsos tipo Joao da Silva/Maria Santos, numeros redondos tipo 99,99%.
- Para software/dashboard, use sans-serif premium e limpa; nao use serif; nao use preto puro; use off-black/zinc ou base clara refinada.
- Maximo 1 cor de acento, dessaturada e consistente.
- Priorize telas funcionais sobre landing page. O produto deve parecer utilizavel, nao uma peca de marketing.
- Formulario: label acima, helper text na marcacao, erro abaixo do input, estados loading/empty/error/success/disabled quando aplicavel.
- Use grid e agrupamento logico; cards so quando comunicam hierarquia real.
- Motion apenas com transform/opacity; nada de animar top/left/width/height; loops ou efeitos pesados devem ser isolados.

Adaptacao ao artifact HTML do LionDesign:
- Gere HTML standalone clicavel. Nao importe React/Next/Tailwind/Framer a menos que o runtime do OD ja esteja explicitamente usando isso.
- Se precisar de icones, use SVG limpo inline. Emojis sao proibidos no HTML, labels e alt text.
- Aplique o espirito da skill no HTML/CSS/JS final: assimetria controlada, composicao premium, estados completos e interacoes reais.`;
}

function buildProductInterfaceBlueprint(inputs: {
  projectName: string;
  discovery: string | null;
  stories: string | null;
  storyCoverageMap: string;
}): string {
  const haystack = [
    inputs.projectName,
    inputs.discovery ?? '',
    inputs.stories ?? '',
    inputs.storyCoverageMap,
  ].join('\n').toLowerCase();

  if (
    haystack.includes('cron') &&
    haystack.includes('github') &&
    (haystack.includes('anthropic') || haystack.includes('claude')) &&
    (haystack.includes('run') || haystack.includes('execucao'))
  ) {
    return `## Blueprint obrigatorio de produto: LionCron

O artifact deve parecer uma ferramenta SaaS operacional de automacao de PRs com agentes, nao uma pagina de apresentacao.

Vocabulário obrigatorio de UI:
- Use termos de dominio: crons, runs, validacao de PR, repositorio GitHub, GitHub PAT, Anthropic API key, BYOK, logs, tokens, custo estimado, retry, notificacao de falha, Stripe Link.
- Evite abstrações vagas como "tenant operacional", "area autenticada", "controle de acesso" como headline principal. Tenant pode aparecer apenas como detalhe tecnico discreto, chip de conta ou nota de isolamento.

Telas obrigatorias sugeridas:
- \`login\` — acesso compacto ao LionCron. Sem hero gigante. Form real de email/senha e feedback de bloqueio para area protegida. Cobre US-01.
- \`painel\` — dashboard operacional pos-login com proximas execucoes, ultimas runs, status por run, tokens, custo estimado e falhas recentes. Cobre US-07, US-08, US-10.
- \`crons\` — lista e formulario/drawer para criar, editar, deletar e rodar manualmente crons. Campos visiveis: owner/repo, schedule/preset, prompt do agente, status ativo, ultima run. Cobre US-04, US-05, US-06, US-07.
- \`integracoes\` — formularios reais para Anthropic API key e GitHub PAT, valores mascarados, estado conectado/pendente/erro, nota de BYOK e redacao de segredo em logs. Cobre US-02, US-03.
- \`runs\` — tabela de runs com filtros de status e painel de detalhe/logs completos; logs precisam parecer tecnicos e redigidos quando houver segredo. Cobre US-08, US-09.
- \`cobranca\` — plano unico R$49/mes com CTA Stripe Link e status de assinatura. Cobre US-11.

Navegacao primaria obrigatoria:
- Painel -> \`#painel\`
- Crons -> \`#crons\`
- Integracoes -> \`#integracoes\`
- Runs -> \`#runs\`
- Cobranca -> \`#cobranca\`

Padrao visual esperado:
- App shell real: sidebar/topbar compacta, conteudo denso o suficiente para operacao, tabelas, formularios, drawers/modais e estados.
- Nao use headline de landing page como "Acesse seu tenant operacional". Login deve ser simples; o valor do produto aparece pelas telas funcionais.
- Nao use cards decorativos mostrando "como seria". Use componentes acionaveis: botoes, forms, tabs, filtros, menu de linha, detalhe de run, toggle ativo/inativo.
- Dados fake devem ser especificos do dominio: repos como \`lionlabs/lioncron\`, schedules como \`0 */6 * * *\`, runs com status \`concluida\`, \`falha\`, \`em retry\`, tokens e custo estimado irregulares.`;
  }

  return `## Blueprint obrigatorio de produto

O artifact deve parecer o produto real em uso, nao uma landing page, galeria de telas ou apresentacao visual.

Regras de produto:
- Extraia entidades, objetos, acoes e estados diretamente das user stories e use esses nomes na UI.
- Headlines devem nomear tarefas do produto, nao conceitos abstratos. Ex: "Crons", "Runs", "Integracoes", "Logs", "Cobranca", "Clientes", "Pedidos", conforme o dominio.
- A primeira tela pode ser login/onboarding, mas depois dela deve existir um app shell funcional com navegacao, listas, formularios, estados e detalhes.
- Evite frases genericas como "acesse seu ambiente", "painel operacional", "area autenticada" quando houver termos de dominio mais concretos nas stories.
- Dados fake precisam ser verossimeis e especificos do dominio, nunca placeholder generico.`;
}

interface InitialPromptInputs {
  projectName: string;
  discovery: string | null;
  stories: string | null;
  prdValidatorNotes: string | null;
  sessionConfig: OpenDesignSessionConfig | null;
  designSystemId: string | null;
  designPlanPromptBlock: string | null;
}

function renderInitialPrompt(inputs: InitialPromptInputs): string {
  const { projectName, discovery, stories, prdValidatorNotes, sessionConfig, designSystemId, designPlanPromptBlock } = inputs;
  const locale = sessionConfig?.locale ?? 'pt-BR';
  const storyCoverageMap = buildStoryCoverageMap(stories);
  const discoveryExcerpt = truncateSourceExcerpt(discovery, 'discovery');
  const storiesExcerpt = truncateSourceExcerpt(stories, 'stories-requisitos');
  const validatorExcerpt = truncateSourceExcerpt(prdValidatorNotes, 'prd-validator');
  const frontendSkillBlock = buildOpenDesignFrontendSkillBlock();
  const productInterfaceBlueprint = designPlanPromptBlock
    ? null
    : buildProductInterfaceBlueprint({
      projectName,
      discovery,
      stories,
      storyCoverageMap,
    });

  const safeSessionConfig = {
    agentId: sessionConfig?.agentId ?? 'configured-in-open-design-studio',
    model: sessionConfig?.model ?? 'configured-in-open-design-studio',
    reasoning: sessionConfig?.reasoning ?? null,
    designSystemId: sessionConfig?.designSystemId ?? null,
    memoryEnabled: sessionConfig?.memoryEnabled ?? false,
    mcpServerIds: sessionConfig?.mcpServerIds ?? [],
    locale,
  };

  return `# Briefing inicial — ${projectName}

Voce esta iniciando uma sessao no LionDesign embarcada no LionClaw (pipeline Development V2).

## Hierarquia de prioridade

Siga esta ordem quando houver conflito:

1. **Schema do \`lionclaw-design-contract\` e Design Lock** — campos obrigatorios, JSON valido e rastreabilidade vencem tudo.
2. **Cobertura das user stories aprovadas** — nenhuma tela, menu, entidade, permissao ou acao pode existir sem userStoryIds ou delta explicito.
3. **Briefing de produto e mapa de telas** — organize o produto em telas reais e estados funcionais.
4. **Skill de Frontend de Alto Nivel** — melhora a qualidade visual, mas nao pode ampliar escopo nem quebrar contrato.

## Exigencias obrigatorias

- Gerar design **high-fidelity**, nao wireframe.
- Nao inventar telas, fluxos, permissoes ou entidades fora das user stories listadas abaixo.
- Gerar artifact HTML standalone (single file ou exportavel por este OD), clicavel localmente.
- Embutir o bloco \`<script type="application/json" id="lionclaw-design-contract">{...}</script>\` no artifact final.
- Responda e nomeie artefatos em portugues brasileiro (locale=${locale}), salvo se o projeto configurar outro idioma.
- **Use \`save_artifact\` APENAS para HTML.** Markdown, prose, racional de design, decisoes ou explicacoes vao no chat — nao tente salvar como artifact (sera rejeitado pelo validator do OD).
- **NAO abra questionario, formulario de briefing, question-form ou discovery form.** Voce ja tem material suficiente. Se algo visual faltar, assuma defaults coerentes e continue.

## Defaults quando o briefing visual estiver incompleto

- Superficie principal: desktop web responsivo.
- Avaliador do prototipo: fundador tecnico / dev solo que precisa validar se o produto e implementavel.
- Tom visual: modern minimal + tech utilitario, com acabamento refinado e sem cara de landing page.
- Contexto de marca: escolha uma direcao propria, coerente com o produto e com a skill; nao peça brand spec, referencia visual ou screenshot.
- Escopo desejado: cobrir as user stories aprovadas no menor conjunto de telas funcionais.
- Restricoes adicionais: se algo estiver incerto, registre em \`deltas[]\` no contract e siga. So pare para perguntar se for impossivel gerar HTML valido.

## Formato OBRIGATORIO do artifact: SPA multi-tela navegavel

**Este e o ponto mais importante do briefing. Leia duas vezes.**

O artifact entregue NAO eh uma "gallery de telas", showcase, landing page, case-study, pitch deck, scroll-narrative, "design portfolio" ou pagina unica com sections empilhadas mostrando como cada tela ficaria. Esses formatos sao **proibidos**.

O artifact eh uma **Single Page Application clicavel** onde:

1. **Cada tela do contract (\`screens[]\`) = uma \`<section>\` HTML separada** com \`id\` igual ao \`screens[].id\` e atributo \`hidden\` por padrao.
2. **Apenas uma tela fica visivel por vez.** A troca de tela acontece por mudanca de \`location.hash\` (router minimo em JS inline) ou toggling de \`hidden\` em resposta a eventos reais (submit de \`<form>\`, click em botao de nav, etc.).
3. **Login com \`<form>\` real** (\`<input type="password">\`, etc.) que ao submit muda pra tela principal. Nada de "mockup decorativo" de login na mesma viewport da tela principal.
4. **Estados visuais** (idle / escutando / processando / falando, ou equivalente) sao **estados da mesma tela** alternados por interacao real (click no botao do microfone, etc.) — NAO sao 5 cards lado-a-lado mostrando "como ficaria cada estado".
5. **\`navigation.primary[]\` do contract precisa estar funcional**: os items listados ali precisam existir como elementos clicaveis no DOM que mudam de tela quando clicados.
6. Copy editorial / parrafos descritivos / "pitch" do produto / explicacoes sobre o design **NAO entram no HTML** — vao na resposta do chat.

### Regra anti-tela-empilhada [CRITICO]

Um \`index.html\` unico esta correto. O que e proibido e renderizar as telas uma abaixo da outra como uma pagina longa.

- Inclua CSS obrigatorio: \`[hidden] { display: none !important; }\`.
- No DOM inicial, as \`section\` de telas podem existir, mas **somente uma** pode estar visivel.
- A tela de login nao pode ficar acima do app shell nem aparecer junto com telas internas ao rolar a pagina.
- Telas internas como dashboard, crons, integracoes, runs, logs, cobranca e auditoria devem iniciar com \`hidden\`.
- O submit do login deve esconder \`#login\` e mostrar a primeira tela interna via JS real.
- Cliques na navegacao devem alternar \`hidden\` entre as sections, nao apenas rolar para anchors empilhadas.
- Se uma pessoa conseguir rolar e ver login + outra tela sem submeter login ou clicar na navegacao, o artifact esta invalido. Corrija antes de usar \`save_artifact\`.

Teste mental antes de salvar: "Um usuario abre o HTML, ve a tela 1 sozinha (login). Submete o form. Some a tela 1, aparece a tela 2 (principal). Clica no botao do mic. A orb muda de estado. Para de aparecer a tela 1 mesmo se rolar a pagina." Se qualquer parte desse teste falha (ex: ver login e main ao mesmo tempo ao rolar), o artifact esta errado.

## Briefing de produto e cobertura

Use o mapa abaixo para planejar telas antes de desenhar. Ele existe para evitar que o HTML vire uma copia literal das user stories.

### Mapa compacto de user stories

${storyCoverageMap}

${designPlanPromptBlock ?? '(designPlan pre-LionDesign indisponivel — usar blueprint deterministico abaixo como fallback)'}

${productInterfaceBlueprint ?? ''}

### Como transformar stories em telas

- Agrupe stories por tarefa do usuario, entidade de dados e momento do fluxo.
- Crie o menor conjunto de telas necessario para cobrir as stories, mas inclua estados internos ricos dentro de cada tela.
- Para cada tela planejada, defina antes de codar: objetivo, stories cobertas, acoes primarias, estados, dados exibidos/editados e destino de navegacao.
- Telas comuns esperadas quando fizer sentido: autenticacao, dashboard/listagem principal, detalhe/edicao, criacao/configuracao, revisao/resultado, estado vazio/erro.
- Nao transforme cada user story em uma tela separada se elas pertencem ao mesmo fluxo.
- Nao esconda fluxos importantes em texto estatico. Use botoes, formularios, filtros, tabs ou navegacao real.
- Antes de salvar, faça uma autocritica severa: se a tela principal pudesse servir para qualquer SaaS trocando palavras, esta ruim. Reescreva para o dominio do projeto.

${frontendSkillBlock}

## Fontes originais para conferencia

As fontes abaixo sao referencia de escopo. Nao copie blocos inteiros para a UI; extraia telas, estados, dados e acoes.

### Discovery

${discoveryExcerpt}

### User Stories e Requisitos aprovados

${storiesExcerpt}

## Notas adicionais do PRD Validator

${validatorExcerpt}

## Design System

${designSystemId ? `- designSystemId: \`${designSystemId}\`` : '- (nenhum design system selecionado — usar default coerente com o briefing)'}

## Configuracao da sessao (somente metadados — nao contem credenciais)

\`\`\`json
${JSON.stringify(safeSessionConfig, null, 2)}
\`\`\`

## Entrega esperada

- **SPA multi-tela** seguindo o "Formato OBRIGATORIO" acima — um \`<section>\` por screen, um visivel por vez, transicoes por interacao real.
- \`index.html\` standalone unico e permitido; telas empilhadas no scroll sao proibidas.
- Bloco \`lionclaw-design-contract\` embutido no HTML EXATAMENTE no shape definido abaixo.
- Texto e copy em ${locale} **dentro das telas funcionais** — sem prose marketing, sem hero copy editorial, sem "## Sobre o produto", sem pitch.

Se uma user story exigir interpretacao, use o contexto disponivel, registre a decisao em \`deltas[]\` quando necessario e continue. Nao bloqueie a entrega com perguntas de briefing visual.

## Schema OBRIGATORIO do bloco \`lionclaw-design-contract\`

Este JSON eh consumido pelo validator do LionClaw. **Qualquer campo extra eh permitido, mas TODOS os campos abaixo sao obrigatorios** — sem isso o Design Lock rejeita.

\`\`\`html
<script type="application/json" id="lionclaw-design-contract">
{
  "version": "1.0",
  "visual": {
    "direction": "string descritiva da direcao visual (ex: 'software dark utilitario com acento amber')",
    "density": "dense | balanced | editorial | mobile-first | unknown",
    "tokens": {
      "colors": { "bg": "#09090b", "accent": "#d97706", "...": "..." },
      "typography": { "display": "Geist", "body": "Satoshi", "...": "..." },
      "spacing": { "xs": "4px", "sm": "8px", "...": "..." },
      "radii": { "sm": "4px", "md": "8px", "...": "..." }
    }
  },
  "navigation": {
    "primary": [
      { "id": "nav-play", "label": "Jogar", "targetScreenId": "play", "userStoryIds": ["US-02"] }
    ],
    "secondary": []
  },
  "screens": [
    {
      "id": "login",
      "userStoryIds": ["US-01"],
      "title": "Login",
      "route": "#login",
      "purpose": "Autenticar usuario",
      "states": ["loading", "error", "success"],
      "actions": [
        { "id": "action-login", "label": "Entrar", "type": "submit", "userStoryIds": ["US-01"], "apiExpectationIds": ["api-login"] }
      ],
      "dataRequirementIds": ["data-user-login"]
    }
  ],
  "components": [
    { "id": "btn-primary", "name": "Botao primario", "type": "form", "usedInScreenIds": ["login"], "props": {}, "states": [] }
  ],
  "dataRequirements": [
    {
      "id": "data-user-login",
      "name": "Credenciais de login",
      "description": "Dados informados pelo usuario para autenticacao",
      "fields": [
        { "name": "email", "typeHint": "string", "required": true },
        { "name": "password", "typeHint": "string", "required": true }
      ],
      "sourceScreenIds": ["login"],
      "userStoryIds": ["US-01"]
    }
  ],
  "apiExpectations": [
    {
      "id": "api-login",
      "operation": "POST /auth/login",
      "screenIds": ["login"],
      "actionIds": ["action-login"],
      "methodHint": "POST",
      "requestShape": { "email": "string", "password": "string" },
      "responseShape": { "token": "string" },
      "userStoryIds": ["US-01"]
    }
  ],
  "deltas": [
    {
      "id": "delta-001",
      "type": "unclear",
      "description": "explicacao do delta",
      "impact": "low",
      "relatedUserStoryIds": [],
      "requiresRequirementsChange": false
    }
  ]
}
</script>
\`\`\`

**Regras criticas:**
- \`version\` deve ser literalmente \`"1.0"\`.
- Cada \`screens[]\`, \`navigation.primary[]\` e \`dataRequirements[]\`/\`apiExpectations[]\` referencia user stories por \`userStoryIds: string[]\` (use os IDs reais do briefing, ex: \`"US-01"\`).
- Cada \`apiExpectations[]\` precisa declarar \`screenIds: string[]\`, \`actionIds: string[]\` e \`userStoryIds: string[]\`, mesmo que algum deles seja \`[]\`.
- Cada \`dataRequirements[]\` precisa declarar \`fields[]\`, \`sourceScreenIds: string[]\` e \`userStoryIds: string[]\`.
- Telas/componentes/dados/APIs SEM user story listada → registrar como \`deltas[]\` com \`description\` explicando por que existe.
- \`components[]\`, \`apiExpectations[]\`, \`dataRequirements[]\` e \`deltas[]\` exigem \`id: string\` unico.
- \`deltas[]\` exige \`type\`, \`description\`, \`impact\`, \`relatedUserStoryIds\` e \`requiresRequirementsChange\`.
- Use os 4 grupos de tokens (\`colors\`, \`typography\`, \`spacing\`, \`radii\`) mesmo que parcialmente vazios — eles sao obrigatorios na estrutura.

Campos adicionais ao schema (ex: \`project\`, \`design_system\`, \`acceptance_criteria_visualized\`) sao tolerados, mas os campos acima nao podem faltar.
`;
}

export async function buildInitialPrompt(
  projectId: string,
  sessionConfig: OpenDesignSessionConfig | null,
  designPlanPromptBlock: string | null,
): Promise<string> {
  const project = getHarnessProject(projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);

  const pipelineDocsId = project.pipelineDocsId ?? null;
  const docsCtx = pipelineDocsId ? getPipelineDocsContext(project.projectPath, pipelineDocsId) : null;

  const discoveryPath = project.discoveryNotesPath ?? docsCtx?.resolveDocPath('discovery.md') ?? null;
  const storiesPath = docsCtx?.resolveDocPath('stories-requisitos.md') ?? null;
  const prdValidatorPath = docsCtx?.resolveDocPath('prd-validator.md') ?? null;
  const discovery = tryReadFile(discoveryPath);
  const stories = tryReadFile(storiesPath);
  const prdValidatorNotes = tryReadFile(prdValidatorPath);

  emitBootstrapProgress(projectId, 'prompt', 'running', 'Montando prompt final do LionDesign');
  const prompt = renderInitialPrompt({
    projectName: project.name,
    discovery,
    stories,
    prdValidatorNotes,
    sessionConfig,
    designSystemId: sessionConfig?.designSystemId ?? null,
    designPlanPromptBlock,
  });
  emitBootstrapProgress(projectId, 'prompt', 'done', 'Prompt final montado');
  return prompt;
}


async function doEnsureSession(projectId: string): Promise<BootstrapResult | { error: string }> {
  const bootStatus = getBootInstallStatus();
  if (bootStatus.kind !== 'ready') {
    return {
      error: `boot install not ready (kind=${bootStatus.kind}); aguarde o motor de design concluir a preparacao`,
    };
  }

  const project = getHarnessProject(projectId);
  if (!project) return { error: `project not found: ${projectId}` };

  if (!getOpenDesignConfig(projectId)) {
    setOpenDesignConfig(projectId, {});
  }
  let cfg: OpenDesignConfig = getOpenDesignConfig(projectId) as OpenDesignConfig;

  const sessionConfig = getSessionConfig(projectId);
  if (!sessionConfig) {
    return { error: 'sessionConfig nao configurada; preencha o formulario antes de iniciar a sessao' };
  }
  try {
    assertValidSessionConfig(sessionConfig);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  if (!project.projectPath) {
    return { error: 'project sem projectPath; impossivel inicializar runDir do LionDesign' };
  }
  emitBootstrapProgress(projectId, 'run-dir', 'running', 'Preparando pasta da sessao');
  ensureRunDir(projectId, project.projectPath, cfg);
  cfg = getOpenDesignConfig(projectId) as OpenDesignConfig;
  emitBootstrapProgress(projectId, 'run-dir', 'done', 'Pasta da sessao pronta', cfg.runDir);

  emitBootstrapProgress(projectId, 'prompt', 'running', 'Lendo prompt LionDesign da fase 4');
  const promptOutputPath = resolveOpenDesignPromptPath(
    project.projectPath,
    project.pipelineDocsId ?? null,
  );
  if (!fs.existsSync(promptOutputPath)) {
    return {
      error:
        `Prompt do LionDesign nao encontrado: ${promptOutputPath}. ` +
        'Execute a fase 4 (Design Plan) antes de abrir o LionDesign Studio.',
    };
  }
  const fileText = fs.readFileSync(promptOutputPath, 'utf8');
  const promptText = prependBriefingLabel(fileText, project.name);
  const currentHash = sha256(promptText);
  emitBootstrapProgress(projectId, 'prompt', 'done', 'Prompt LionDesign carregado', promptOutputPath);

  emitBootstrapProgress(projectId, 'sidecar', 'running', 'Iniciando sidecar LionDesign');
  const startRes = await manager.start(projectId);
  if ('error' in startRes) return { error: startRes.error };
  const { daemonUrl, webUrl } = startRes;
  emitBootstrapProgress(projectId, 'sidecar', 'done', 'Sidecar LionDesign iniciado', daemonUrl);

  cfg = getOpenDesignConfig(projectId) ?? cfg;

  const adapter = createAdapter({ baseUrl: daemonUrl });
  emitBootstrapProgress(projectId, 'od-config', 'running', 'Sincronizando agente e modelo');
  await syncSidecarAppConfig(adapter, sessionConfig, projectId);
  emitBootstrapProgress(projectId, 'od-config', 'done', 'Agente e modelo sincronizados');

  const currentSessionHash = hashSessionConfig(sessionConfig);
  const sessionChanged =
    cfg.sessionConfigHash !== undefined && cfg.sessionConfigHash !== currentSessionHash;

  let openDesignProjectId = cfg.openDesignProjectId;
  let conversationFromCreate: string | null = null;

  if (!openDesignProjectId) {
    const runIdRaw =
      project.config?.openDesign?.runId ??
      cfg.runId ??
      `${Date.now().toString(36)}-${shortUuid()}`;
    const runIdSanitized = sanitizeId(runIdRaw);
    openDesignProjectId = `lionclaw-${runIdSanitized}`;
    emitBootstrapProgress(projectId, 'od-project', 'running', 'Criando projeto no LionDesign', openDesignProjectId);

    const createRes = await adapter.createProject({
      id: openDesignProjectId,
      name: project.name,
      skillId: null,
      designSystemId: sessionConfig.designSystemId ?? null,
      pendingPrompt: null,
      metadata: {
        kind: 'prototype',
        fidelity: 'high-fidelity',
        source: 'lionclaw-development-v2',
        lionclawProjectId: project.id,
        lionclawRunId: runIdRaw,
        sessionConfigVersion: 1,
      },
    });
    openDesignProjectId = createRes.projectId;
    conversationFromCreate = createRes.conversationId;

    setOpenDesignConfig(projectId, {
      openDesignProjectId,
      conversationId: createRes.conversationId,
    });
    cfg = getOpenDesignConfig(projectId) ?? cfg;
    logger.info({ projectId, openDesignProjectId, runIdRaw }, 'bootstrap: created OD project');
    emitBootstrapProgress(projectId, 'od-project', 'done', 'Projeto LionDesign criado', openDesignProjectId);
  } else {
    emitBootstrapProgress(projectId, 'od-project', 'done', 'Projeto LionDesign reutilizado', openDesignProjectId);
  }

  let conversationId = conversationFromCreate ?? cfg.conversationId;
  if (!conversationId || sessionChanged) {
    emitBootstrapProgress(projectId, 'conversation', 'running', 'Criando conversa no LionDesign');
    const convRes = await adapter.createConversation(openDesignProjectId);
    conversationId = convRes.conversationId;
    setOpenDesignConfig(projectId, { conversationId });
    cfg = getOpenDesignConfig(projectId) ?? cfg;
    logger.info({ projectId, conversationId, sessionChanged }, 'bootstrap: created new OD conversation');
    emitBootstrapProgress(projectId, 'conversation', 'done', 'Conversa LionDesign criada', conversationId);
  } else {
    emitBootstrapProgress(projectId, 'conversation', 'done', 'Conversa LionDesign reutilizada', conversationId);
  }

  let initialPromptSentAt = cfg.initialPromptSentAt ?? '';
  const hashChanged = cfg.initialPromptHash !== currentHash;
  const resendSamePrompt = !hashChanged
    ? await shouldResendSamePrompt(adapter, openDesignProjectId, conversationId, projectId, currentHash)
    : false;
  if (hashChanged || resendSamePrompt) {
    emitBootstrapProgress(projectId, 'prompt-injection', 'running', 'Injetando prompt inicial no LionDesign');
    const promptStamp = currentHash.slice(0, 16);
    const promptIdSuffix = resendSamePrompt ? `-${Date.now().toString(36)}` : '';
    const startArgs = {
      projectId: openDesignProjectId,
      conversationId,
      prompt: promptText,
      sessionConfig,
      userMessageId: `lionclaw-user-${promptStamp}${promptIdSuffix}`,
      assistantMessageId: `lionclaw-assistant-${promptStamp}${promptIdSuffix}`,
      clientRequestId: `lionclaw-bootstrap-${promptStamp}${promptIdSuffix}`,
    };
    try {
      await adapter.startInitialRun(startArgs);
    } catch (err) {
      if (!isConversationNotFoundError(err)) throw err;

      logger.warn(
        { projectId, openDesignProjectId, staleConversationId: conversationId, err },
        'bootstrap: OD conversation missing; creating replacement conversation and retrying initial run once',
      );
      const convRes = await adapter.createConversation(openDesignProjectId);
      conversationId = convRes.conversationId;
      emitBootstrapProgress(projectId, 'conversation', 'done', 'Conversa LionDesign recriada', conversationId);
      setOpenDesignConfig(projectId, {
        conversationId,
        initialPromptHash: undefined,
        initialPromptSentAt: undefined,
      });
      cfg = getOpenDesignConfig(projectId) ?? cfg;
      await adapter.startInitialRun({
        ...startArgs,
        conversationId,
      });
    }
    initialPromptSentAt = new Date().toISOString();
    emitBootstrapProgress(projectId, 'prompt-injection', 'done', 'Prompt inicial enviado ao LionDesign');
    setOpenDesignConfig(projectId, {
      conversationId,
      initialPromptHash: currentHash,
      initialPromptSentAt,
    });
    logger.info({ projectId, hashShort: currentHash.slice(0, 12) }, 'bootstrap: initial prompt sent');
  } else {
    emitBootstrapProgress(projectId, 'prompt-injection', 'done', 'Prompt inicial ja estava na conversa');
    logger.info({ projectId }, 'bootstrap: initial prompt hash unchanged, skipping send');
  }

  emitBootstrapProgress(projectId, 'prompt-verification', 'running', 'Confirmando entrega do prompt');
  await assertPromptDelivered(adapter, openDesignProjectId, conversationId, currentHash);
  emitBootstrapProgress(projectId, 'prompt-verification', 'done', 'Prompt confirmado no chat do LionDesign');

  const bootstrappedAt = cfg.bootstrappedAt ?? new Date().toISOString();
  setOpenDesignConfig(projectId, {
    sessionConfigHash: currentSessionHash,
    bootstrappedAt,
  });
  emitBootstrapProgress(projectId, 'studio', 'done', 'LionDesign pronto para abrir');

  return {
    openDesignProjectId,
    conversationId,
    webUrl: buildStudioUrl(webUrl, openDesignProjectId),
    initialPromptHash: currentHash,
    initialPromptSentAt,
    bootstrappedAt,
  };
}

export async function ensureSession(projectId: string): Promise<BootstrapResult | { error: string }> {
  const existing = inFlightByProject.get(projectId);
  if (existing) return existing;

  const promise = doEnsureSession(projectId).finally(() => {
    inFlightByProject.delete(projectId);
  });
  inFlightByProject.set(projectId, promise);
  return promise;
}

export async function hasActiveDesignRun(projectId: string): Promise<boolean> {
  try {
    const cfg = getOpenDesignConfig(projectId);
    const openDesignProjectId = cfg?.openDesignProjectId;
    const conversationId = cfg?.conversationId;
    if (!openDesignProjectId || !conversationId) return false;

    const bootStatus = getBootInstallStatus();
    if (bootStatus.kind !== 'ready') return false;

    const startRes = await manager.start(projectId);
    if ('error' in startRes) return false;

    const adapter = createAdapter({ baseUrl: startRes.daemonUrl });
    const runs = await adapter
      .callRaw(
        'GET',
        `/api/runs?projectId=${encodeURIComponent(openDesignProjectId)}` +
          `&conversationId=${encodeURIComponent(conversationId)}`,
      )
      .catch(() => null);
    return hasActiveRun(runs);
  } catch (err) {
    logger.warn(
      { projectId, error: err instanceof Error ? err.message : String(err) },
      'hasActiveDesignRun: falha ao consultar runs (assumindo sem run ativo)',
    );
    return false;
  }
}

export function __resetBootstrapForTests(): void {
  inFlightByProject.clear();
}
