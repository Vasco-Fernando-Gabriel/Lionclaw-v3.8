import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger';
import { getOpenDesignConfig } from './config';
import { extractContractFromHtml } from './contract';
import { resolveDesignSnapshotPaths } from '../pipeline-paths';
import { getHarnessProject } from '../db';
import type { DesignContract } from '../../../src/types/open-design';

const logger = createLogger('open-design-validator');


export type LockRuleId =
  | '10.2.1'
  | '10.2.2'
  | '10.2.3'
  | '10.2.4'
  | '10.2.5'
  | '10.2.6'
  | '10.2.7'
  | '10.2.8'
  | '10.2.9'
  | '10.2.10'
  | '10.2.11'
  | '10.2.12'
  | '10.2.13';

export interface LockProblem {
  rule: LockRuleId;
  item: string;
  hint: string;
}

export interface LockValidationResult {
  ok: boolean;
  problems: LockProblem[];
}


const DENY_LIST_ITEMS = [
  'novo menu',
  'nova tela',
  'novo fluxo',
  'nova entidade de dados',
  'nova permissao',
  'novo requisito',
  'mudanca de navegacao principal',
  'remocao de tela necessaria para uma user story aprovada',
] as const;

type DenyListItem = (typeof DENY_LIST_ITEMS)[number];

function denyMsg(item: DenyListItem): string {
  return `O design tentou criar/exigir "${item}", que viola a regra pos-lock. Remova no LionDesign ou cancele este run.`;
}


const UI_KEYWORDS: string[] = [
  'tela',
  'screen',
  'menu',
  'dashboard',
  'lista',
  'list',
  'form',
  'formulario',
  'formulário',
  'calendario',
  'calendário',
  'calendar',
  'kanban',
  'chat',
  'modal',
  'drawer',
  'painel',
  'panel',
  'view',
  'page',
  'pagina',
  'página',
  'area',
  'área',
  'botao',
  'botão',
  'button',
  'click',
  'clicar',
  'ver',
  'exibir',
  'mostrar',
  'visualizar',
  'navegar',
  'navigation',
  'navegacao',
  'navegação',
  'fluxo de UI',
  'ui flow',
  'tabela',
  'table',
  'card',
  'grafico',
  'gráfico',
  'chart',
];

const MULTI_WORD_KWS = UI_KEYWORDS.filter((kw) => kw.includes(' '));
const SINGLE_WORD_KWS = UI_KEYWORDS.filter((kw) => !kw.includes(' '));

const SINGLE_WORD_RE = new RegExp(
  SINGLE_WORD_KWS.map((kw) => `\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).join('|'),
  'i',
);

const MULTI_WORD_RES = MULTI_WORD_KWS.map(
  (kw) => new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
);

export function storyRequiresUI(storyText: string): boolean {
  if (SINGLE_WORD_RE.test(storyText)) return true;
  for (const re of MULTI_WORD_RES) {
    if (re.test(storyText)) return true;
  }
  return false;
}


interface ParsedStory {
  id: string;
  text: string;
}

function parseUserStories(md: string): ParsedStory[] {
  const stories: ParsedStory[] = [];
  const headingRe = /^#{1,4}\s+(US-\d+[^\n]*)/gm;
  const boldRe = /\*\*(US-\d+)\*\*/g;

  let match: RegExpExecArray | null;
  const headingMatches: Array<{ id: string; start: number; end: number }> = [];

  headingRe.lastIndex = 0;
  while ((match = headingRe.exec(md)) !== null) {
    const line = match[1].trim();
    const idMatch = /^(US-\d+)/i.exec(line);
    if (idMatch) {
      headingMatches.push({ id: idMatch[1].toUpperCase(), start: match.index, end: match.index + match[0].length });
    }
  }

  if (headingMatches.length > 0) {
    for (let i = 0; i < headingMatches.length; i++) {
      const current = headingMatches[i];
      const nextStart = i + 1 < headingMatches.length ? headingMatches[i + 1].start : md.length;
      const storyBody = md.slice(current.end, nextStart);
      stories.push({ id: current.id, text: current.id + ' ' + storyBody });
    }
    return stories;
  }

  boldRe.lastIndex = 0;
  while ((match = boldRe.exec(md)) !== null) {
    const id = match[1].toUpperCase();
    const start = match.index;
    const end = Math.min(start + 800, md.length);
    stories.push({ id, text: md.slice(start, end) });
  }

  return stories;
}

function normalizeContract(c: DesignContract): DesignContract {
  for (const s of c.screens ?? []) {
    if (!Array.isArray(s.actions)) s.actions = [];
    if (!Array.isArray(s.states)) s.states = [];
    if (!Array.isArray(s.userStoryIds)) s.userStoryIds = [];
    if (!Array.isArray(s.dataRequirementIds)) s.dataRequirementIds = [];
    for (const action of s.actions) {
      if (!Array.isArray(action.userStoryIds)) action.userStoryIds = [];
      if (action.apiExpectationIds !== undefined && !Array.isArray(action.apiExpectationIds)) {
        action.apiExpectationIds = [];
      }
    }
  }
  if (!c.navigation) c.navigation = { primary: [] };
  if (!Array.isArray(c.navigation.primary)) c.navigation.primary = [];
  if (c.navigation.secondary && !Array.isArray(c.navigation.secondary)) {
    c.navigation.secondary = [];
  }
  for (const nav of c.navigation.primary) {
    if (!Array.isArray(nav.userStoryIds)) nav.userStoryIds = [];
  }
  for (const nav of c.navigation.secondary ?? []) {
    if (!Array.isArray(nav.userStoryIds)) nav.userStoryIds = [];
  }
  if (!Array.isArray(c.components)) c.components = [];
  for (const component of c.components) {
    if (!Array.isArray(component.usedInScreenIds)) component.usedInScreenIds = [];
    if (component.states !== undefined && !Array.isArray(component.states)) component.states = [];
  }
  if (!Array.isArray(c.dataRequirements)) c.dataRequirements = [];
  for (const dr of c.dataRequirements) {
    if (!Array.isArray(dr.fields)) dr.fields = [];
    if (!Array.isArray(dr.sourceScreenIds)) dr.sourceScreenIds = [];
    if (!Array.isArray(dr.userStoryIds)) dr.userStoryIds = [];
  }
  if (!Array.isArray(c.apiExpectations)) c.apiExpectations = [];
  for (const api of c.apiExpectations) {
    if (!Array.isArray(api.actionIds)) api.actionIds = [];
    if (!Array.isArray(api.screenIds)) api.screenIds = [];
    if (!Array.isArray(api.userStoryIds)) api.userStoryIds = [];
  }
  if (!Array.isArray(c.deltas)) c.deltas = [];
  for (const delta of c.deltas) {
    if (!Array.isArray(delta.relatedUserStoryIds)) delta.relatedUserStoryIds = [];
  }
  return c;
}


function collectAllIds(contract: DesignContract): Array<{ id: string; kind: string }> {
  const all: Array<{ id: string; kind: string }> = [];

  for (const s of contract.screens) {
    all.push({ id: s.id, kind: 'screen' });
    for (const a of s.actions) all.push({ id: a.id, kind: 'action' });
  }
  for (const n of contract.navigation.primary) all.push({ id: n.id, kind: 'navigation' });
  if (contract.navigation.secondary) {
    for (const n of contract.navigation.secondary) all.push({ id: n.id, kind: 'navigation-secondary' });
  }
  for (const c of contract.components) all.push({ id: c.id, kind: 'component' });
  for (const d of contract.dataRequirements) all.push({ id: d.id, kind: 'dataRequirement' });
  for (const e of contract.apiExpectations) all.push({ id: e.id, kind: 'apiExpectation' });
  for (const delta of contract.deltas) all.push({ id: delta.id, kind: 'delta' });

  return all;
}


export async function validateLock(projectId: string): Promise<LockValidationResult> {
  const problems: LockProblem[] = [];

  try {
    const cfg = getOpenDesignConfig(projectId);
    if (!cfg?.runDir) {
      return {
        ok: false,
        problems: [
          {
            rule: '10.2.1',
            item: 'runDir',
            hint: 'Project run directory not configured. Cannot locate snapshot.',
          },
        ],
      };
    }

    const project = getHarnessProject(projectId);
    const designPaths = project?.projectPath
      ? resolveDesignSnapshotPaths(project.projectPath, project.pipelineDocsId ?? null)
      : null;
    const snapshotDir = designPaths?.snapshotDir
      ?? path.join(cfg.runDir, 'open-design', 'snapshots', 'latest');
    const htmlPath = designPaths?.artifactHtmlPath
      ?? path.join(snapshotDir, 'artifact', 'index.html');
    const contractPath = designPaths?.contractPath
      ?? path.join(snapshotDir, 'design-contract.json');
    const reportPath = designPaths?.lockReportPath
      ?? path.join(snapshotDir, 'design-lock-report.md');

    if (!fs.existsSync(htmlPath)) {
      problems.push({
        rule: '10.2.1',
        item: htmlPath,
        hint: `Arquivo HTML do snapshot nao encontrado em ${htmlPath}. Execute "Ver Snapshot" antes de travar.`,
      });
      writeReport(reportPath, problems);
      return { ok: false, problems };
    }

    let contract: DesignContract | null = null;

    if (fs.existsSync(contractPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(contractPath, 'utf-8')) as unknown;
        const { isValidDesignContract } = await import('../../../src/types/open-design');
        if (isValidDesignContract(raw)) {
          contract = raw;
        }
      } catch {
      }
    }

    if (!contract) {
      contract = await extractContractFromHtml(htmlPath);
      if (contract) {
        fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2), 'utf-8');
      }
    }

    if (contract) {
      contract = normalizeContract(contract);
    }

    if (!contract) {
      const { getLastContractIssues } = await import('./contract');
      const issues = getLastContractIssues(htmlPath);

      if (issues.length === 0) {
        problems.push({
          rule: '10.2.2',
          item: htmlPath,
          hint:
            'O HTML existe mas o JSON em <script id="lionclaw-design-contract"> nao bate com o schema do LionClaw ' +
            'ou nao pode ser parseado. Confirme que o <script> contem JSON valido e que os campos obrigatorios ' +
            '(version="1.0", visual.tokens.{colors,typography,spacing,radii}, navigation.primary[], screens[], ' +
            'components[], dataRequirements[], apiExpectations[], deltas[]) estao presentes.',
        });
      } else {
        for (const issue of issues) {
          problems.push({
            rule: '10.2.2',
            item: htmlPath,
            hint: issue,
          });
        }
      }
      writeReport(reportPath, problems);
      return { ok: false, problems };
    }

    for (const screen of contract.screens) {
      if (!screen.userStoryIds || screen.userStoryIds.length === 0) {
        problems.push({
          rule: '10.2.3',
          item: `Tela "${screen.title}" (${screen.id})`,
          hint: denyMsg('nova tela'),
        });
      }
    }

    const allNavItems = [
      ...contract.navigation.primary,
      ...(contract.navigation.secondary ?? []),
    ];
    for (const nav of allNavItems) {
      if (!nav.userStoryIds || nav.userStoryIds.length === 0) {
        problems.push({
          rule: '10.2.4',
          item: `Menu/Navegacao "${nav.label}" (${nav.id})`,
          hint: denyMsg('novo menu'),
        });
      }
    }

    for (const screen of contract.screens) {
      for (const action of screen.actions) {
        const isPrimary =
          action.type === 'submit' || action.type === 'navigate' || action.type === 'filter';
        if (isPrimary && (!action.userStoryIds || action.userStoryIds.length === 0)) {
          problems.push({
            rule: '10.2.5',
            item: `Acao "${action.label}" (${action.id}) na tela "${screen.title}"`,
            hint: denyMsg('novo fluxo'),
          });
        }
      }
    }

    for (const delta of contract.deltas) {
      if (delta.requiresRequirementsChange) {
        problems.push({
          rule: '10.2.6',
          item: `Delta "${delta.type}" (${delta.id}): ${delta.description}`,
          hint: denyMsg('novo requisito'),
        });
      }
    }

    for (const delta of contract.deltas) {
      if (
        (delta.type === 'new-screen' || delta.type === 'new-feature') &&
        (!delta.relatedUserStoryIds || delta.relatedUserStoryIds.length === 0) &&
        !delta.requiresRequirementsChange // already caught by 10.2.6
      ) {
        const denyItem: DenyListItem =
          delta.type === 'new-screen' ? 'nova tela' : 'novo fluxo';
        problems.push({
          rule: '10.2.7',
          item: `Delta "${delta.type}" (${delta.id}): ${delta.description}`,
          hint: denyMsg(denyItem),
        });
      }
    }

    for (const dr of contract.dataRequirements) {
      if (!dr.userStoryIds || dr.userStoryIds.length === 0) {
        problems.push({
          rule: '10.2.8',
          item: `DataRequirement "${dr.name}" (${dr.id})`,
          hint: denyMsg('nova entidade de dados'),
        });
      }
    }

    for (const api of contract.apiExpectations) {
      const hasAction = api.actionIds && api.actionIds.length > 0;
      const hasScreen = api.screenIds && api.screenIds.length > 0;
      if (!hasAction && !hasScreen) {
        problems.push({
          rule: '10.2.9',
          item: `ApiExpectation "${api.operation}" (${api.id})`,
          hint: 'Esta expectativa de API nao esta vinculada a nenhuma action ou tela. Adicione o link no LionDesign.',
        });
      }
    }

    const coveredStoryIds = new Set<string>();
    for (const screen of contract.screens) {
      for (const id of screen.userStoryIds) coveredStoryIds.add(id);
      for (const action of screen.actions) {
        for (const id of action.userStoryIds) coveredStoryIds.add(id);
      }
    }
    for (const nav of allNavItems) {
      for (const id of nav.userStoryIds) coveredStoryIds.add(id);
    }
    for (const dr of contract.dataRequirements) {
      for (const id of dr.userStoryIds) coveredStoryIds.add(id);
    }
    for (const api of contract.apiExpectations) {
      for (const id of api.userStoryIds) coveredStoryIds.add(id);
    }

    const docsId = cfg.pipelineDocsId ?? cfg.runId ?? '';
    const runDir = cfg.runDir;
    const projectPathGuess = path.resolve(runDir, '../../../../');
    const storiesCandidates = [
      path.join(projectPathGuess, 'docs', `Docs${docsId}`, `stories-requisitos${docsId}.md`),
      path.join(projectPathGuess, `stories-requisitos${docsId}.md`),
      path.join(projectPathGuess, `stories-requisitos.md`),
    ];

    let storiesContent: string | null = null;
    for (const candidate of storiesCandidates) {
      if (fs.existsSync(candidate)) {
        storiesContent = fs.readFileSync(candidate, 'utf-8');
        break;
      }
    }

    if (storiesContent) {
      const parsedStories = parseUserStories(storiesContent);
      for (const story of parsedStories) {
        if (storyRequiresUI(story.text) && !coveredStoryIds.has(story.id)) {
          problems.push({
            rule: '10.2.10',
            item: `User Story ${story.id}`,
            hint: `A story "${story.id}" exige UI (menciona tela/menu/fluxo) mas nao tem nenhuma tela, acao ou item de navegacao associado no design contract.`,
          });
        }
      }
    } else {
      logger.warn({ projectId, docsId }, 'Rule 10.2.10: stories file not found — skipping reverse validation');
    }

    const apiActionIds = new Set<string>();
    for (const api of contract.apiExpectations) {
      for (const id of api.actionIds) apiActionIds.add(id);
    }

    const dataTypes: Array<'submit' | 'upload' | 'download'> = ['submit', 'upload', 'download'];
    for (const screen of contract.screens) {
      for (const action of screen.actions) {
        if (dataTypes.includes(action.type as 'submit' | 'upload' | 'download')) {
          if (!apiActionIds.has(action.id)) {
            problems.push({
              rule: '10.2.11',
              item: `Acao "${action.label}" (${action.id}) — tipo: ${action.type}`,
              hint: 'Esta acao manipula dados mas nao tem uma ApiExpectation associada. Adicione no contract.',
            });
          }
        }
      }
    }

    const screenDataReqIds = new Set<string>();
    for (const screen of contract.screens) {
      for (const id of screen.dataRequirementIds) screenDataReqIds.add(id);
    }

    for (const dr of contract.dataRequirements) {
      if (!screenDataReqIds.has(dr.id)) {
        problems.push({
          rule: '10.2.12',
          item: `DataRequirement "${dr.name}" (${dr.id})`,
          hint: 'Este requisito de dados nao e consumido por nenhuma tela. Adicione o link em screen.dataRequirementIds ou remova o requisito.',
        });
      }
    }

    const allIds = collectAllIds(contract);
    const seen = new Map<string, string>(); // id -> first kind
    for (const entry of allIds) {
      if (seen.has(entry.id)) {
        problems.push({
          rule: '10.2.13',
          item: `ID duplicado: "${entry.id}" (${seen.get(entry.id)} e ${entry.kind})`,
          hint: 'IDs devem ser unicos dentro do design contract. Corrija no LionDesign.',
        });
      } else {
        seen.set(entry.id, entry.kind);
      }
    }

    writeReport(reportPath, problems);

    logger.info({ projectId, ok: problems.length === 0, problemCount: problems.length }, 'validateLock complete');

    return { ok: problems.length === 0, problems };
  } catch (err) {
    logger.error({ err, projectId }, 'validateLock threw unexpected error');
    return {
      ok: false,
      problems: [
        {
          rule: '10.2.1',
          item: 'validator internal error',
          hint: `Erro interno do validator: ${(err as Error).message}`,
        },
      ],
    };
  }
}


function writeReport(reportPath: string, problems: LockProblem[]): void {
  const lines: string[] = [];

  if (problems.length === 0) {
    lines.push('# Design Lock Report');
    lines.push('');
    lines.push('Status: **APROVADO**');
    lines.push('');
    lines.push('Todas as 13 regras de validacao passaram. O design pode ser travado.');
  } else {
    lines.push('# Design Lock Report');
    lines.push('');
    lines.push('O design ainda nao pode ser travado.');
    lines.push('');
    lines.push('## Itens bloqueantes');
    lines.push('');

    for (const p of problems) {
      lines.push(`### Regra ${p.rule}`);
      lines.push('');
      lines.push(`**Item:** ${p.item}`);
      lines.push('');
      lines.push(`**Hint:** ${p.hint}`);
      lines.push('');
    }

    lines.push('## Escolha');
    lines.push('');
    lines.push('1. Corrija os itens acima no LionDesign e tente travar novamente.');
    lines.push('2. Cancele este run e inicie um novo com escopo ajustado.');
  }

  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, lines.join('\n'), 'utf-8');
  } catch (err) {
    logger.warn({ err, reportPath }, 'Failed to write design-lock-report.md');
  }
}
