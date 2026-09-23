import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { getPipelineMetrics, getHarnessProject, getHarnessSprints, getHarnessRounds } from './db';
import type { PipelinePhaseMetricsRow } from './db';

const logger = createLogger('pipeline-report');

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}

const RUNTIME_LABELS: Record<string, string> = {
  cloud: 'Cloud (Anthropic)',
  local: 'Local (Ollama)',
  external: 'External (API)',
  codex: 'Codex (OpenAI/OAuth)',
  zai: 'Z.ai (GLM)',
  'minimax-tp': 'MiniMax TokenPlan',
  kimi: 'Kimi (assinatura)',
  grok: 'Grok Build (assinatura)',
};

const RUNTIME_REPORT_ORDER = ['cloud', 'local', 'external', 'codex', 'zai', 'minimax-tp', 'kimi', 'grok'];

const PAYG_EQUIVALENT_RUNTIMES = new Set(['minimax-tp', 'kimi', 'grok']);
const SUBSCRIPTION_RUNTIMES = new Set(['zai', 'minimax-tp', 'kimi', 'grok']);

function formatRuntime(runtime: string | null | undefined): string {
  const normalized = runtime ?? 'cloud';
  return RUNTIME_LABELS[normalized] ?? normalized;
}

function statusEmoji(status: string): string {
  switch (status) {
    case 'completed':
      return 'OK';
    case 'failed':
      return 'FAIL';
    case 'running':
      return 'RUN';
    case 'interrupted':
      return 'INT';
    case 'skipped':
      return 'SKIP';
    default:
      return status.toUpperCase();
  }
}

function hrLine(): string {
  return '\n---\n';
}

function buildSummarySection(metrics: ReturnType<typeof getPipelineMetrics>): string {
  const { totals, costByRuntime, costStatusByRuntime, subscriptionEquivalentCost } = metrics;
  const hasCloud = Object.hasOwn(costByRuntime, 'cloud');
  const hasLocal = Object.hasOwn(costByRuntime, 'local');

  let section = '## Resumo Geral\n\n';
  section += `| Metrica | Valor |\n`;
  section += `|---|---|\n`;
  section += `| Tokens de entrada | ${formatTokens(totals.inputTokens)} |\n`;
  section += `| Tokens de saida | ${formatTokens(totals.outputTokens)} |\n`;
  section += `| Tokens de cache | ${formatTokens(totals.cacheTokens)} |\n`;
  section += `| Custo total | ${formatTotalCost(totals.costUsd, subscriptionEquivalentCost, totals.costStatus)} |\n`;
  if (hasLocal) {
    if (hasCloud) {
      section += `| Custo cloud | ${formatRuntimeBreakdownCost(
        'cloud',
        costByRuntime['cloud'] ?? 0,
        costStatusByRuntime['cloud'],
      )} |\n`;
    }
    section += `| Custo local (Ollama) | ${formatRuntimeBreakdownCost(
      'local',
      costByRuntime['local'] ?? 0,
      costStatusByRuntime['local'],
    )} |\n`;
  }
  section += `| Duracao total | ${formatMs(totals.durationMs)} |\n`;
  section += `| Chamadas de ferramenta | ${totals.toolUses} |\n`;
  section += `| Requisicoes de API | ${totals.apiRequests} |\n`;

  return section;
}

function formatTotalCost(
  total: number,
  subscriptionEquivalent: number,
  costStatus: 'known' | 'unknown' | 'estimated-partial' | undefined,
): string {
  const equivalent = Math.min(total, Math.max(0, subscriptionEquivalent));
  const known =
    equivalent <= 0
      ? formatCost(total)
      : total - equivalent <= 1e-9
        ? `~${formatCost(total)}`
        : `${formatCost(total)} (incl. ~${formatCost(equivalent)})`;
  if (costStatus === 'unknown') return total > 0 ? `${known} + nao estim.` : 'nao estimado';
  if (costStatus === 'estimated-partial' && equivalent <= 0) return `~${formatCost(total)}`;
  return known;
}

function formatRuntimeBreakdownCost(
  runtime: string,
  cost: number,
  costStatus: 'known' | 'unknown' | 'estimated-partial' | undefined,
): string {
  const equivalentPayg = PAYG_EQUIVALENT_RUNTIMES.has(runtime);
  if (costStatus === 'unknown') {
    if (cost <= 0) return 'nao estimado';
    const known = equivalentPayg ? `~${formatCost(cost)} (est. PAYG)` : formatCost(cost);
    return `${known} + nao estim.`;
  }
  if (equivalentPayg) return `~${formatCost(cost)} (est. PAYG)`;
  if (costStatus === 'estimated-partial') return `~${formatCost(cost)}`;
  return formatCost(cost);
}

const PHASE_LABELS: Record<number, string> = {
  1: 'Discovery',
  2: 'PRD Generator (Modo 1)',
  3: 'PRD Validator',
  4: 'PRD Generator (Modo 2)',
  5: 'Technical Decisions',
  6: 'Spec Generation (Builder)',
  61: 'Spec Generation (Validator)',
  7: 'Spec Enricher',
  8: 'Planner',
  9: 'Sprint Validator',
  10: 'Coder',
  11: 'Evaluator',
  12: 'Acceptance Reviewer',
};

function resolveProviderForReport(
  metadata: Record<string, unknown> | null | undefined,
  runtime: string | null | undefined,
): string {
  const meta = metadata ?? {};
  return (meta.provider as string | undefined) ?? runtime ?? 'cloud';
}

function formatCostWithMeta(usd: number, metadata: Record<string, unknown> | null | undefined): string {
  const meta = metadata ?? {};
  if ((meta.costStatus as string | undefined) === 'unknown') return 'nao estimado';
  if ((meta.costEstimationKind as string | undefined) === 'subscription-equivalent-payg') {
    return `~${formatCost(usd)} (est. PAYG)`;
  }
  return formatCost(usd);
}

function buildPhasesSection(phases: PipelinePhaseMetricsRow[]): string {
  if (phases.length === 0) return '';

  let section = '## Detalhe por Fase\n\n';
  section += `| Fase | Nome | Status | Agente | Modelo | Runtime | Provider | Entrada | Saida | Cache | Custo | Duracao | Tools | API Reqs |\n`;
  section += `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;

  for (const p of phases) {
    const phaseLabel = PHASE_LABELS[p.phaseNumber] ?? p.phaseName;
    const agentId = p.agentId ?? '-';
    const model = p.model ?? '-';
    const runtime = formatRuntime(p.runtime);
    const metadata = p.metadata ? (p.metadata as Record<string, unknown>) : undefined;
    const provider = resolveProviderForReport(metadata, p.runtime);
    const cost = formatCostWithMeta(p.costUsd, metadata);
    section += `| ${p.phaseNumber} | ${phaseLabel} | ${statusEmoji(p.status)} | ${agentId} | ${model} | ${runtime} | ${provider} | ${formatTokens(p.inputTokens)} | ${formatTokens(p.outputTokens)} | ${formatTokens(p.cacheReadTokens + p.cacheCreationTokens)} | ${cost} | ${formatMs(p.durationMs)} | ${p.toolUses} | ${p.apiRequests} |\n`;
  }

  return section;
}

function buildSprintsSection(projectId: string): string {
  const sprints = getHarnessSprints(projectId);
  if (sprints.length === 0) return '';

  let section = '## Detalhe por Sprint\n\n';

  for (const sprint of sprints) {
    section += `### Sprint: ${sprint.name}\n\n`;
    section += `- **Status:** ${sprint.status}\n`;
    section += `- **ID:** ${sprint.id}\n\n`;

    let rounds: ReturnType<typeof getHarnessRounds> = [];
    try {
      rounds = getHarnessRounds(sprint.id);
    } catch {
      rounds = [];
    }

    if (rounds.length > 0) {
      section += `| Round | Status | Entrada | Saida | Cache | Custo | Duracao | Tools | API Reqs |\n`;
      section += `|---|---|---|---|---|---|---|---|---|\n`;

      for (const r of rounds) {
        const status = r.verdict ?? (r.completedAt ? 'completed' : 'running');
        const inputTokens = r.coderInputTokens + r.evaluatorInputTokens;
        const outputTokens = r.coderOutputTokens + r.evaluatorOutputTokens;
        const cacheTokens = r.coderCacheTokens + r.evaluatorCacheTokens;
        const costUsd = r.coderCostUsd + r.evaluatorCostUsd;
        const durationMs = r.coderDurationMs + r.evaluatorDurationMs;
        const toolUses = r.coderToolUses + r.evaluatorToolUses;
        const apiRequests = r.coderApiRequests + r.evaluatorApiRequests;
        section += `| ${r.roundNumber} | ${statusEmoji(status)} | ${formatTokens(inputTokens)} | ${formatTokens(outputTokens)} | ${formatTokens(cacheTokens)} | ${formatTotalCost(costUsd, r.subscriptionEquivalentCost ?? 0, r.costStatus)} | ${formatMs(durationMs)} | ${toolUses} | ${apiRequests} |\n`;
      }
      section += '\n';
    } else {
      section += '_Nenhum round registrado para este sprint._\n\n';
    }
  }

  return section;
}

function buildArtifactsSection(projectPath: string): string {
  const ARTIFACT_FILES = [
    'discovery-notes.md',
    'stories-requisitos.md',
    'PRD.md',
    'SPEC.md',
    'sprints.json',
    'pipeline-report.md',
    '.prd-validation-report.md',
    '.spec-validation-report.md',
    '.spec-enricher-suggestions.md',
    '.sprint-validation-report.md',
  ];

  const found: Array<{ name: string; sizeBytes: number }> = [];

  for (const filename of ARTIFACT_FILES) {
    const fullPath = path.join(projectPath, filename);
    if (fs.existsSync(fullPath)) {
      try {
        const stat = fs.statSync(fullPath);
        found.push({ name: filename, sizeBytes: stat.size });
      } catch {}
    }
  }

  if (found.length === 0) return '';

  let section = '## Artefatos Gerados\n\n';
  section += `| Arquivo | Tamanho |\n`;
  section += `|---|---|\n`;

  for (const f of found) {
    const sizeKb = (f.sizeBytes / 1024).toFixed(1);
    section += `| \`${f.name}\` | ${sizeKb} KB |\n`;
  }

  return section;
}

function buildRuntimeSection(metrics: ReturnType<typeof getPipelineMetrics>): string {
  const { costByRuntime, costStatusByRuntime, phases } = metrics;
  const presentRuntimes = Object.keys(costByRuntime);
  if (!presentRuntimes.some((runtime) => runtime !== 'cloud')) return '';

  const orderedRuntimes = [
    ...RUNTIME_REPORT_ORDER.filter((runtime) => Object.hasOwn(costByRuntime, runtime)),
    ...presentRuntimes.filter((runtime) => !RUNTIME_REPORT_ORDER.includes(runtime)).sort(),
  ];

  let section = '## Custo por Runtime\n\n';
  section += `| Runtime | Custo |\n`;
  section += `|---|---|\n`;
  for (const runtime of orderedRuntimes) {
    const displayCost = formatRuntimeBreakdownCost(runtime, costByRuntime[runtime] ?? 0, costStatusByRuntime[runtime]);
    section += `| ${formatRuntime(runtime)} | ${displayCost} |\n`;
  }
  section += '\n';

  for (const runtime of orderedRuntimes.filter((value) => value !== 'cloud')) {
    const runtimePhases = phases.filter((phase) => phase.runtime === runtime);
    if (runtimePhases.length > 0) {
      section += `**Fases executadas via ${formatRuntime(runtime)}:** ${runtimePhases.map((phase) => phase.phaseName).join(', ')}\n`;
    }
  }

  const subscriptions = orderedRuntimes.filter((runtime) => SUBSCRIPTION_RUNTIMES.has(runtime));
  if (subscriptions.length > 0) {
    section += `\n> **Nota:** Custos de runtimes em assinatura (${subscriptions.map(formatRuntime).join(', ')}) sao estimativas equivalentes pay-as-you-go, nao gasto real cobrado por este relatorio.\n`;
  }

  return section;
}

export function generatePipelineReport(projectId: string): string {
  const project = getHarnessProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const metrics = getPipelineMetrics(projectId);

  const now = new Date().toISOString();

  let report = `# Pipeline Report — ${project.name}\n\n`;
  report += `**Projeto:** ${project.name}\n`;
  report += `**ID:** ${projectId}\n`;
  report += `**Caminho:** ${project.projectPath}\n`;
  report += `**Gerado em:** ${now}\n`;

  if (project.pipelineCurrentPhase !== null && project.pipelineCurrentPhase !== undefined) {
    report += `**Fase atual:** ${project.pipelineCurrentPhase}\n`;
  }

  report += '\n';
  report += hrLine();
  report += '\n';

  report += buildSummarySection(metrics);
  report += '\n';
  report += hrLine();
  report += '\n';

  const phasesSection = buildPhasesSection(metrics.phases);
  if (phasesSection) {
    report += phasesSection;
    report += '\n';
    report += hrLine();
    report += '\n';
  }

  const sprintsSection = buildSprintsSection(projectId);
  if (sprintsSection) {
    report += sprintsSection;
    report += hrLine();
    report += '\n';
  }

  const artifactsSection = buildArtifactsSection(project.projectPath);
  if (artifactsSection) {
    report += artifactsSection;
    report += '\n';
    report += hrLine();
    report += '\n';
  }

  const runtimeSection = buildRuntimeSection(metrics);
  if (runtimeSection) {
    report += runtimeSection;
    report += '\n';
    report += hrLine();
    report += '\n';
  }

  report += `_Relatorio gerado automaticamente pelo LionClaw Pipeline Engine._\n`;

  return report;
}

export function exportReport(projectId: string, format: 'md'): string {
  const project = getHarnessProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  if (format !== 'md') {
    throw new Error(`Unsupported format: ${format}. Only 'md' is supported.`);
  }

  const report = generatePipelineReport(projectId);
  const reportPath = path.join(project.projectPath, 'pipeline-report.md');

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report, 'utf-8');

  logger.info({ projectId, reportPath }, 'Pipeline report exported');

  return reportPath;
}
