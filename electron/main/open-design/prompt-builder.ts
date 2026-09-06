import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger';
import { getHarnessProject } from '../db';
import { getOpenDesignConfig } from './config';
import { getPipelineDocsContext } from '../pipeline-paths';

const logger = createLogger('open-design-prompt-builder');

const MAX_CONTENT_CHARS = 12000;
const KEEP_HEAD = 4000;
const KEEP_TAIL = 4000;

function truncateContent(content: string, label: string): string {
  if (content.length <= MAX_CONTENT_CHARS) return content;
  const head = content.slice(0, KEEP_HEAD);
  const tail = content.slice(content.length - KEEP_TAIL);
  logger.info({ label, originalLength: content.length }, 'Content truncated for prompt');
  return `${head}\n\n... (truncado — ${content.length - KEEP_HEAD - KEEP_TAIL} chars omitidos) ...\n\n${tail}`;
}

function extractKnownConstraints(discoveryContent: string): string {
  const patterns = [
    /#+\s*(restri[cç][oõ]es?|constraints?|limita[cç][oõ]es?|restricoes)[^\n]*\n([\s\S]*?)(?=\n#+|\s*$)/i,
    /#+\s*(prefer[eê]ncias?\s+t[eé]cnicas?|tech(?:nical)?\s+prefer)[^\n]*\n([\s\S]*?)(?=\n#+|\s*$)/i,
  ];
  for (const pattern of patterns) {
    const match = discoveryContent.match(pattern);
    if (match && match[2]?.trim()) {
      return match[2].trim();
    }
  }
  return '';
}

function renderPromptTemplate(vars: {
  projectName: string;
  discoveryContentOrSummary: string;
  storiesContentOrSummary: string;
  knownConstraints: string;
  visualReferences: string;
}): string {
  return `Voce esta criando o primeiro design aprovado do produto dentro do pipeline LionClaw Development 2.0.

Seu objetivo e transformar Discovery Notes e User Stories aprovadas em um prototipo HTML clicavel, com navegacao, menus, telas, estados de UI e componentes coerentes.

IMPORTANTE
- As user stories aprovadas sao a fonte de verdade de escopo.
- Nao crie feature, menu, tela, permissao ou entidade de dados que nao esteja rastreavel para uma user story.
- Se perceber que uma nova tela ou fluxo seria necessario, registre como Design Delta e nao implemente como escopo final.
- O resultado sera travado por Design Lock. Depois disso, Database, Backend, Frontend tecnico e SPEC seguirao este design.

CONTEXTO

Projeto: ${vars.projectName}

Discovery Notes:
${vars.discoveryContentOrSummary}

User Stories e Requisitos aprovados:
${vars.storiesContentOrSummary}

Preferencias tecnicas ou restricoes ja conhecidas:
${vars.knownConstraints || '(nenhuma registrada)'}

REFERENCIAS VISUAIS
${vars.visualReferences || '(nenhuma referencia visual fornecida)'}

ANTES DE GERAR
Se faltarem decisoes visuais importantes, pergunte apenas lacunas objetivas em formato de escolhas curtas:
1. Direcao visual: Modern Minimal, Tech Utility, Editorial, Brutalist Experimental ou Soft Warm.
2. Paleta/marca: usar default, cores fornecidas ou pedir cores principais.
3. Densidade: dashboard operacional denso, SaaS limpo, painel executivo ou app editorial.
4. Plataforma prioritaria: desktop, mobile ou responsivo completo.
5. Tipo de componentes: tabelas densas, cards, kanban, calendario, chat, formularios, charts.

REQUISITOS DO PROTOTIPO
- Gere HTML single-file ou artifact exportavel pelo LionDesign.
- O prototipo deve ser clicavel localmente usando JS no proprio HTML.
- Deve suportar navegacao entre telas.
- Deve ter estados: loading, empty, error, success e disabled quando aplicavel.
- Deve representar menus e rotas principais.
- Deve representar formularios, filtros, detalhes e acoes importantes.
- Deve ser responsivo quando a user story exigir ou quando o produto for web.

CONTRATO DE DESIGN
Inclua no HTML um bloco JSON valido:

<script type="application/json" id="lionclaw-design-contract">
{
  "version": "1.0",
  "visual": {
    "direction": "string",
    "density": "dense | balanced | editorial | mobile-first | unknown",
    "tokens": {
      "colors": {},
      "typography": {},
      "spacing": {},
      "radii": {}
    }
  },
  "navigation": {
    "primary": [
      { "id": "nav-home", "label": "Inicio", "targetScreenId": "home", "userStoryIds": ["US-01"] }
    ],
    "secondary": []
  },
  "screens": [
    {
      "id": "home",
      "title": "Inicio",
      "route": "#home",
      "purpose": "string",
      "userStoryIds": ["US-01"],
      "states": ["loading", "success"],
      "actions": [
        { "id": "action-save", "label": "Salvar", "type": "submit", "userStoryIds": ["US-01"], "apiExpectationIds": ["api-save"] }
      ],
      "dataRequirementIds": ["data-main"]
    }
  ],
  "components": [
    { "id": "comp-form", "name": "Formulario", "type": "form", "usedInScreenIds": ["home"], "props": {}, "states": [] }
  ],
  "dataRequirements": [
    {
      "id": "data-main",
      "name": "Entidade principal",
      "description": "string",
      "fields": [{ "name": "name", "typeHint": "string", "required": true }],
      "sourceScreenIds": ["home"],
      "userStoryIds": ["US-01"]
    }
  ],
  "apiExpectations": [
    {
      "id": "api-save",
      "operation": "POST /api/example",
      "screenIds": ["home"],
      "actionIds": ["action-save"],
      "methodHint": "POST",
      "requestShape": { "name": "string" },
      "responseShape": { "ok": "boolean" },
      "userStoryIds": ["US-01"]
    }
  ],
  "deltas": [
    {
      "id": "delta-001",
      "type": "unclear",
      "description": "string",
      "impact": "low",
      "relatedUserStoryIds": [],
      "requiresRequirementsChange": false
    }
  ]
}
</script>

Cada screen, menu item, action, dataRequirement e apiExpectation deve declarar os userStoryIds relacionados.
Cada apiExpectation deve declarar screenIds e actionIds, mesmo quando um deles for [].
Cada dataRequirement deve declarar fields, sourceScreenIds e userStoryIds.

Se algum item visual nao tiver userStoryIds, coloque em deltas e marque requiresRequirementsChange=true.

ENTREGA
- Prototipo HTML clicavel.
- Design contract embutido no HTML.
- Brief visual resumido.
- Deltas, se houver.`;
}

export async function buildInitialPrompt(
  projectId: string,
): Promise<{ ok: true; promptPath: string; prompt: string } | { error: string }> {
  try {
    const project = getHarnessProject(projectId);
    if (!project) return { error: `Project not found: ${projectId}` };

    const cfg = getOpenDesignConfig(projectId);
    if (!cfg?.runDir) return { error: 'runDir not configured for project' };

    const pipelineDocsId = project.pipelineDocsId ?? cfg.pipelineDocsId;
    if (!pipelineDocsId) return { error: 'pipelineDocsId not set on project' };

    const docsCtx = getPipelineDocsContext(project.projectPath, pipelineDocsId);
    if (!docsCtx) return { error: 'Could not resolve docs context' };

    const discoveryPath = project.discoveryNotesPath || docsCtx.resolveDocPath('discovery.md');
    const storiesPath = docsCtx.resolveDocPath('stories-requisitos.md');

    if (!fs.existsSync(discoveryPath)) {
      return { error: `Discovery file not found: ${discoveryPath}` };
    }
    if (!fs.existsSync(storiesPath)) {
      return { error: `Stories file not found: ${storiesPath}` };
    }

    const discoveryRaw = fs.readFileSync(discoveryPath, 'utf-8');
    const storiesRaw = fs.readFileSync(storiesPath, 'utf-8');

    const discoverySummary = truncateContent(discoveryRaw, 'discovery');
    const storiesSummary = truncateContent(storiesRaw, 'stories-requisitos');
    const knownConstraints = extractKnownConstraints(discoveryRaw);

    const prompt = renderPromptTemplate({
      projectName: project.name,
      discoveryContentOrSummary: discoverySummary,
      storiesContentOrSummary: storiesSummary,
      knownConstraints,
      visualReferences: '',
    });

    const inputDir = path.join(cfg.runDir, 'open-design', 'input');
    fs.mkdirSync(inputDir, { recursive: true });

    const promptPath = path.join(inputDir, 'open-design-initial-prompt.md');
    const discoverySummaryPath = path.join(inputDir, 'discovery-summary.md');
    const storiesSummaryPath = path.join(inputDir, 'stories-summary.md');

    fs.writeFileSync(promptPath, prompt, 'utf-8');
    fs.writeFileSync(discoverySummaryPath, discoverySummary, 'utf-8');
    fs.writeFileSync(storiesSummaryPath, storiesSummary, 'utf-8');

    logger.info({ projectId, promptPath }, 'Initial prompt generated');

    return { ok: true, promptPath, prompt };
  } catch (err) {
    logger.error({ err, projectId }, 'buildInitialPrompt failed');
    return { error: (err as Error).message };
  }
}
