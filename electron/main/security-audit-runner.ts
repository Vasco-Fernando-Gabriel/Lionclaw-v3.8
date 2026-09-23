import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { emitIPC } from './pipeline-shared/ipc-emitter';
import {
  insertSecurityAgentStatus,
  updateSecurityAgentStatus,
  getSecurityAgentStatuses,
  savePipelinePhaseMetrics,
} from './db';
import { resolveAgentQueryConfig } from './agent-config-resolver';
import type { PhaseCallbacks, RepoManifest } from './repo-profiler';
import { EXCLUDED_FROM_AUDIT_PATTERNS } from './repo-profiler';
import type { AgentConfig } from '../../src/types';
import type { AgentExecutionResult } from './agent-runtime/types';
import type { SecurityAgentStatusRow } from './db';
import type { PipelineProject } from '../../src/types/pipeline';
import { getPipelineDocsContext } from './pipeline-paths';
import type { PipelineEngine } from './pipeline-engine';
import { setActiveSecurityAuditPhase } from './permission-guard';
import { rethrowPipelinePause } from './pipeline-engine/provider-auth';
import { PipelinePausedError } from './agent-runtime/types';
import {
  SECRETS_SCANNER_ID,
  AUTH_AUDITOR_ID,
  ISOLATION_INSPECTOR_ID,
  DUPLICATION_DETECTOR_ID,
  LOGIC_ANALYZER_ID,
  STANDARDS_CHECKER_ID,
  OWASP_SCANNER_ID,
} from './seed-agents/index';

const logger = createLogger('security-audit-runner');

const SECURITY_AUDIT_PHASE = 2;

const FINDING_REGEX = /^### [A-Z_]+-\d{3}:/gm;

export interface SecurityAuditAgentDef {
  agentId: string;
  name: string;
  tags: string[];
  order: number;
  slug: string;
}

export const SECURITY_AUDIT_AGENTS: SecurityAuditAgentDef[] = [
  { agentId: SECRETS_SCANNER_ID, name: 'Secrets Scanner', tags: ['config', 'migration'], order: 1, slug: 'secrets' },
  { agentId: AUTH_AUDITOR_ID, name: 'Auth Auditor', tags: ['auth', 'route', 'middleware'], order: 2, slug: 'auth' },
  {
    agentId: ISOLATION_INSPECTOR_ID,
    name: 'Isolation Inspector',
    tags: ['query', 'migration', 'middleware'],
    order: 3,
    slug: 'isolation',
  },
  {
    agentId: DUPLICATION_DETECTOR_ID,
    name: 'Duplication Detector',
    tags: ['route', 'query', 'auth', 'middleware', 'async', 'error-handling', 'template'],
    order: 4,
    slug: 'duplication',
  },
  {
    agentId: LOGIC_ANALYZER_ID,
    name: 'Logic Analyzer',
    tags: ['async', 'query', 'error-handling'],
    order: 5,
    slug: 'logic',
  },
  {
    agentId: STANDARDS_CHECKER_ID,
    name: 'Standards Checker',
    tags: ['route', 'query', 'auth', 'middleware', 'async', 'error-handling', 'template'],
    order: 6,
    slug: 'standards',
  },
  {
    agentId: OWASP_SCANNER_ID,
    name: 'OWASP Scanner',
    tags: ['route', 'query', 'auth', 'template'],
    order: 7,
    slug: 'owasp',
  },
];

export function resolveFilesForAgent(manifest: RepoManifest, tags: string[], maxFiles = 300): string[] {
  const seen = new Set<string>();
  const collect: string[] = [];

  const allFiles = (): string[] => {
    const acc: string[] = [];
    for (const files of Object.values(manifest.filesByRole)) {
      for (const f of files) {
        if (!seen.has(f)) {
          seen.add(f);
          acc.push(f);
        }
      }
    }
    return acc;
  };

  if (tags.includes('*')) {
    collect.push(...allFiles());
  } else {
    for (const tag of tags) {
      const files = manifest.filesByRole[tag] ?? [];
      for (const f of files) {
        if (!seen.has(f)) {
          seen.add(f);
          collect.push(f);
        }
      }
    }
  }

  const filtered = collect.filter((relPath) => {
    const basename = path.basename(relPath);
    return !EXCLUDED_FROM_AUDIT_PATTERNS.some((re) => re.test(basename));
  });

  if (filtered.length <= maxFiles) {
    return filtered;
  }

  const projectPath = manifest.projectPath;
  interface FileMeta {
    relPath: string;
    size: number;
    mtime: number;
  }
  const withMeta: FileMeta[] = filtered.map((relPath) => {
    try {
      const stat = fs.statSync(path.join(projectPath, relPath));
      return { relPath, size: stat.size, mtime: stat.mtimeMs };
    } catch {
      return { relPath, size: 0, mtime: 0 };
    }
  });

  withMeta.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    return b.mtime - a.mtime;
  });

  logger.info(
    { totalResolved: filtered.length, maxFiles, tagsUsed: tags },
    'resolveFilesForAgent: capping file list (prioritising by size+mtime)',
  );

  return withMeta.slice(0, maxFiles).map((m) => m.relPath);
}

export function formatScanId(date: Date): string {
  const y = date.getFullYear().toString();
  const mo = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  const h = date.getHours().toString().padStart(2, '0');
  const mi = date.getMinutes().toString().padStart(2, '0');
  return `${y}${mo}${d}-${h}${mi}`;
}

export function partitionSecurityAuditResume(
  agents: SecurityAuditAgentDef[],
  statuses: Array<Pick<SecurityAgentStatusRow, 'agentId' | 'status' | 'errorMessage'>>,
): {
  queue: SecurityAuditAgentDef[];
  interruptedAgentIds: string[];
  failed: Array<{ agentId: string; name: string; error: string }>;
} {
  const checkpoint = new Map(statuses.map((status) => [status.agentId, status]));
  const queue: SecurityAuditAgentDef[] = [];
  const interruptedAgentIds: string[] = [];
  const failed: Array<{ agentId: string; name: string; error: string }> = [];

  for (const agent of [...agents].sort((a, b) => a.order - b.order)) {
    const status = checkpoint.get(agent.agentId);
    if (!status || status.status === 'pending') {
      queue.push(agent);
    } else if (status.status === 'running') {
      interruptedAgentIds.push(agent.agentId);
      queue.push(agent);
    } else if (status.status === 'failed') {
      failed.push({
        agentId: agent.agentId,
        name: agent.name,
        error: status.errorMessage || 'Falha persistida em execucao anterior',
      });
    }
  }

  return { queue, interruptedAgentIds, failed };
}

interface AgentRunResult {
  output: string;
  metrics: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    toolUses: number;
    apiRequests: number;
    costUsd: number;
    durationMs: number;
    costStatus?: 'known' | 'unknown' | 'estimated-partial';
    tokenStatus?: 'reported' | 'not_reported';
    costUnknownReason?: 'unknown-pricing' | 'no-usage-reported';
  };
  model: string;
  runtime: AgentConfig['runtime'];
  provider: string;
  metadata?: AgentExecutionResult['metadata'];
}

export class SecurityAuditRunner {
  private currentProjectId: string | null = null;

  private readonly maxConcurrent = 3;

  constructor(private readonly pipelineEngine: PipelineEngine) {}

  async run(
    project: PipelineProject & { projectPath: string },
    abortController: AbortController,
    callbacks: PhaseCallbacks,
    pipelineDocsId: string | null = null,
  ): Promise<string | null> {
    this.currentProjectId = project.id;
    setActiveSecurityAuditPhase(true);
    try {
      return await this.runInternal(project, abortController, callbacks, pipelineDocsId);
    } finally {
      this.currentProjectId = null;
      setActiveSecurityAuditPhase(false);
    }
  }

  private async runInternal(
    project: PipelineProject & { projectPath: string },
    abortController: AbortController,
    callbacks: PhaseCallbacks,
    pipelineDocsId: string | null,
  ): Promise<string | null> {
    const projectId = project.id;
    const projectPath = project.projectPath;

    const manifestPath = path.join(projectPath, '.lionclaw', 'manifest.json');
    let manifest: RepoManifest;
    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      manifest = JSON.parse(raw) as RepoManifest;
    } catch (err) {
      const msg = `Falha ao ler manifest.json: ${String(err)}`;
      logger.error({ err, manifestPath }, 'Cannot read manifest.json');
      callbacks.onText?.(msg);
      throw new Error(msg);
    }

    const runStartedAt = new Date();
    const scanId = formatScanId(runStartedAt);
    const securityDir = path.join(projectPath, '.lionclaw', 'Security');

    try {
      fs.mkdirSync(securityDir, { recursive: true });
    } catch (err) {
      logger.warn({ err, securityDir }, 'Could not create Security dir');
    }

    logger.info({ projectId, scanId, securityDir }, 'Starting SecurityAuditRunner');
    callbacks.onText?.(`Iniciando auditoria de seguranca (scan ${scanId})...`);

    insertSecurityAgentStatus(
      projectId,
      SECURITY_AUDIT_AGENTS.map((a) => ({ agentId: a.agentId, agentName: a.name })),
    );

    const resume = partitionSecurityAuditResume(SECURITY_AUDIT_AGENTS, getSecurityAgentStatuses(projectId));
    const queue = resume.queue;
    for (const agentId of resume.interruptedAgentIds) {
      updateSecurityAgentStatus(projectId, agentId, {
        status: 'pending',
        errorMessage: 'Retomada apos interrupcao de autenticacao',
      });
    }

    const failed = resume.failed;

    const runAgent = async (agentDef: SecurityAuditAgentDef): Promise<void> => {
      let initialModel: string | null = null;
      let initialRuntime:
        'cloud' | 'local' | 'external' | 'codex' | 'zai' | 'minimax-tp' | 'kimi' | 'grok' | 'cursor' | null = null;
      try {
        const cfg = await resolveAgentQueryConfig(agentDef.agentId);
        initialModel = cfg.model ?? null;
        initialRuntime = cfg.runtime ?? null;
      } catch (err) {
        logger.warn({ err, agentId: agentDef.agentId }, 'Could not resolve initial model/runtime for audit agent');
      }

      if (abortController.signal.aborted) {
        updateSecurityAgentStatus(projectId, agentDef.agentId, {
          status: 'failed',
          errorMessage: 'Abortado antes de iniciar',
          completedAt: new Date().toISOString(),
        });
        emitIPC('pipeline:security-agent-status', {
          projectId,
          agentId: agentDef.agentId,
          agentName: agentDef.name,
          status: 'failed',
          error: 'Abortado antes de iniciar',
        });
        failed.push({ agentId: agentDef.agentId, name: agentDef.name, error: 'Abortado' });
        return;
      }

      const agentStartedAt = new Date();

      const initialFilesForTracker = resolveFilesForAgent(manifest, agentDef.tags, 300);
      const initialFilesSet = new Set(initialFilesForTracker);

      const tracker = {
        initialFilesCount: initialFilesForTracker.length,
        initialFilesSet,
        filesRead: new Set<string>(),
        toolCallsCount: 0,
        model: initialModel,
        runtime: initialRuntime,
      };

      const getAdditionalFilesAfterStart = (): number => {
        let count = 0;
        for (const fp of tracker.filesRead) {
          const relative = fp.startsWith(projectPath + path.sep) ? fp.slice(projectPath.length + 1) : fp;
          if (!tracker.initialFilesSet.has(relative)) {
            count += 1;
          }
        }
        return count;
      };

      const emitProgress = (
        status: 'queued' | 'running' | 'completed' | 'failed',
        extras?: Partial<{ findingsCount: number; costUsd: number; durationMs: number; model: string | null }>,
      ): void => {
        const extrasCount = getAdditionalFilesAfterStart();

        emitIPC('pipeline:audit-agent-progress', {
          projectId,
          agentId: agentDef.agentId,
          slug: agentDef.slug,
          agentName: agentDef.name,
          status,
          filesAnalyzed: tracker.initialFilesCount,
          additionalFilesAfterStart: extrasCount,
          toolCallsCount: tracker.toolCallsCount,
          costUsd: extras?.costUsd ?? 0,
          durationMs: extras?.durationMs ?? Date.now() - agentStartedAt.getTime(),
          findingsCount: extras?.findingsCount,
          model: extras?.model ?? tracker.model,
          runtime: tracker.runtime,
        });
      };

      updateSecurityAgentStatus(projectId, agentDef.agentId, {
        status: 'running',
        startedAt: agentStartedAt.toISOString(),
      });
      emitIPC('pipeline:security-agent-status', {
        projectId,
        agentId: agentDef.agentId,
        agentName: agentDef.name,
        status: 'running',
      });
      emitProgress('running');

      callbacks.onText?.(`[${agentDef.name}] iniciando...`);
      logger.info({ projectId, agentId: agentDef.agentId, order: agentDef.order }, 'Starting audit agent');

      const files = initialFilesForTracker;
      const partialFilename = `Security-${scanId}-${agentDef.order.toString().padStart(2, '0')}-${agentDef.slug}.md`;
      const partialPath = path.join(securityDir, partialFilename);

      const previousScanNote = manifest.previousScan ? `\n\nScan anterior disponivel em: ${manifest.previousScan}` : '';

      const fileList =
        files.length > 0 ? files.map((f) => `- ${f}`).join('\n') : '(nenhum arquivo classificado para suas tags)';

      const userPrompt = buildAuditPrompt({
        agentDef,
        manifest,
        files,
        fileList,
        partialPath,
        previousScanNote,
        projectPath,
      });

      let result!: AgentRunResult;
      const MAX_ATTEMPTS = 2;
      let lastErr: Error | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          result = await this.spawnAuditAgent(
            agentDef.agentId,
            userPrompt,
            projectPath,
            abortController,
            pipelineDocsId,
            agentDef,
            tracker,
            emitProgress,
          );
          lastErr = null;
          break;
        } catch (err) {
          if (err instanceof PipelinePausedError) {
            updateSecurityAgentStatus(projectId, agentDef.agentId, {
              status: 'pending',
              errorMessage: err.message.substring(0, 500),
            });
            throw err;
          }
          if (abortController.signal.reason instanceof PipelinePausedError) {
            updateSecurityAgentStatus(projectId, agentDef.agentId, {
              status: 'pending',
              errorMessage: abortController.signal.reason.message.substring(0, 500),
            });
            throw abortController.signal.reason;
          }
          rethrowPipelinePause(err);
          lastErr = err instanceof Error ? err : new Error(String(err));
          const isTransient = /Claude Code process exited with code 1/.test(lastErr.message);
          if (attempt < MAX_ATTEMPTS && isTransient) {
            logger.warn(
              { agentId: agentDef.agentId, attempt, errorMsg: lastErr.message },
              'Audit agent transient failure (exit code 1) - retrying after 5s',
            );
            callbacks.onText?.(`[${agentDef.name}] Falha transiente, tentando novamente em 5s...`);
            await new Promise((resolve) => setTimeout(resolve, 5000));
            continue;
          }
          break;
        }
      }

      if (lastErr) {
        const errorMsg = lastErr.message;
        logger.error({ err: lastErr, agentId: agentDef.agentId }, 'Audit agent failed');
        callbacks.onText?.(`[${agentDef.name}] ERRO: ${errorMsg}`);

        const completedAt = new Date().toISOString();
        updateSecurityAgentStatus(projectId, agentDef.agentId, {
          status: 'failed',
          errorMessage: errorMsg.substring(0, 500),
          completedAt,
        });
        emitIPC('pipeline:security-agent-status', {
          projectId,
          agentId: agentDef.agentId,
          agentName: agentDef.name,
          status: 'failed',
          error: errorMsg.substring(0, 200),
        });
        emitProgress('failed', { durationMs: Date.now() - agentStartedAt.getTime() });
        failed.push({ agentId: agentDef.agentId, name: agentDef.name, error: errorMsg });

        savePipelinePhaseMetrics({
          projectId,
          phaseNumber: SECURITY_AUDIT_PHASE,
          phaseName: 'Security Audit',
          agentId: agentDef.agentId,
          status: 'failed',
          durationMs: Date.now() - agentStartedAt.getTime(),
          toolUses: tracker.toolCallsCount,
          model: tracker.model ?? undefined,
          runtime: tracker.runtime ?? undefined,
          startedAt: agentStartedAt.toISOString(),
          completedAt,
          metadata: {
            auditAgent: true,
            findingsCount: 0,
            agentSlug: agentDef.slug,
            filesAnalyzed: tracker.initialFilesCount,
            additionalFilesAfterStart: getAdditionalFilesAfterStart(),
          },
          sprintIndex: agentDef.order,
        });

        return;
      }

      tracker.model = result.model ?? tracker.model;
      tracker.runtime = result.runtime ?? tracker.runtime;

      try {
        fs.writeFileSync(partialPath, result.output, 'utf-8');
      } catch (err) {
        logger.warn({ err, partialPath }, 'Could not write partial output file');
      }

      let findingsCount = (result.output.match(FINDING_REGEX) ?? []).length;
      if (findingsCount === 0 && result.output.length > 200) {
        const normalised = result.output
          .toLowerCase()
          .normalize('NFD')
          .replace(/\p{Diacritic}/gu, '');
        const hasFindingKeywords =
          normalised.includes('finding') ||
          normalised.includes('vulnerab') ||
          normalised.includes('critico') ||
          normalised.includes('exposta') ||
          normalised.includes('exposed') ||
          normalised.includes('hardcod') ||
          normalised.includes('injection');
        if (hasFindingKeywords) {
          const boldFindingMatches = result.output.match(/\*\*Finding[^*]*\*\*/gi) ?? [];
          const headerFindingMatches = result.output.match(/^### Finding [^\n]+/gm) ?? [];
          const fallbackCount = boldFindingMatches.length + headerFindingMatches.length;
          if (fallbackCount > 0) {
            logger.warn(
              {
                projectId,
                agentId: agentDef.agentId,
                primaryRegexCount: 0,
                fallbackCount,
                outputLen: result.output.length,
              },
              'Audit agent: fallback finding parser activated (canonical regex matched 0 but output has finding keywords)',
            );
            findingsCount = fallbackCount;
          }
        }
      }

      const isTruncated = ((): boolean => {
        if (findingsCount > 0) return false;
        const lower = result.output.toLowerCase();
        const explicitNoFindings =
          lower.includes('nenhum finding') ||
          lower.includes('no findings') ||
          lower.includes('sem findings') ||
          lower.includes('0 findings');
        if (explicitNoFindings) return false;
        const looksLikeMidStream =
          result.output.length < 200 ||
          /continuarei|continuando|vou prosseguir|vou analisar mais|let me continue|continuing/i.test(result.output);
        return looksLikeMidStream;
      })();

      if (isTruncated) {
        logger.warn(
          {
            projectId,
            agentId: agentDef.agentId,
            outputLen: result.output.length,
            outputPreview: result.output.slice(0, 200),
          },
          'Audit agent output appears truncated (incomplete reasoning, no findings, no explicit zero-findings statement)',
        );
        callbacks.onText?.(
          `[${agentDef.name}] AVISO: output incompleto detectado. Pode ter sido cortado prematuramente.`,
        );
      }

      const completedAt = new Date().toISOString();

      updateSecurityAgentStatus(projectId, agentDef.agentId, {
        status: 'completed',
        findingsCount,
        outputFile: partialFilename,
        completedAt,
      });

      emitIPC('pipeline:security-agent-status', {
        projectId,
        agentId: agentDef.agentId,
        agentName: agentDef.name,
        status: 'completed',
        findingsCount,
        outputFile: partialFilename,
      });

      callbacks.onText?.(`[${agentDef.name}] concluido. ${findingsCount} finding(s) encontrado(s).`);
      logger.info({ projectId, agentId: agentDef.agentId, findingsCount }, 'Audit agent completed');

      const durationMs = Date.now() - agentStartedAt.getTime();
      savePipelinePhaseMetrics({
        projectId,
        phaseNumber: SECURITY_AUDIT_PHASE,
        phaseName: 'Security Audit',
        agentId: agentDef.agentId,
        status: 'completed',
        inputTokens: result.metrics.inputTokens,
        outputTokens: result.metrics.outputTokens,
        cacheReadTokens: result.metrics.cacheReadTokens,
        cacheCreationTokens: result.metrics.cacheCreationTokens,
        costUsd: result.metrics.costUsd,
        durationMs,
        toolUses: result.metrics.toolUses,
        apiRequests: result.metrics.apiRequests,
        model: result.model,
        runtime: result.runtime,
        startedAt: agentStartedAt.toISOString(),
        completedAt,
        metadata: {
          auditAgent: true,
          findingsCount,
          agentSlug: agentDef.slug,
          truncated: isTruncated,
          provider: result.provider,
          filesAnalyzed: tracker.initialFilesCount,
          additionalFilesAfterStart: getAdditionalFilesAfterStart(),
          ...(result.metrics.tokenStatus !== undefined && { tokenStatus: result.metrics.tokenStatus }),
          ...(result.metrics.costStatus !== undefined && { costStatus: result.metrics.costStatus }),
          ...(result.metrics.costUnknownReason !== undefined && {
            costUnknownReason: result.metrics.costUnknownReason,
          }),
          ...(result.metadata?.costSource !== undefined && { costSource: result.metadata.costSource }),
          ...(result.metadata?.costEstimationKind !== undefined && {
            costEstimationKind: result.metadata.costEstimationKind,
          }),
          ...(result.metadata?.pricingSnapshot !== undefined && {
            pricingSnapshot: result.metadata.pricingSnapshot,
          }),
          ...(result.metadata?.modelUsage !== undefined && { modelUsage: result.metadata.modelUsage }),
          ...(result.metadata?.grok !== undefined && { grok: result.metadata.grok }),
        },
        unknownCostCount: result.metrics.costStatus === 'unknown' ? 1 : 0,
        sprintIndex: agentDef.order,
      });

      emitProgress('completed', {
        findingsCount,
        costUsd: result.metrics.costUsd,
        durationMs,
        model: result.model,
      });

      emitIPC('pipeline:usage', {
        projectId,
        phase: SECURITY_AUDIT_PHASE,
        agentId: agentDef.agentId,
        inputTokens: result.metrics.inputTokens,
        outputTokens: result.metrics.outputTokens,
        cacheReadTokens: result.metrics.cacheReadTokens,
        cacheCreationTokens: result.metrics.cacheCreationTokens,
        costUsd: result.metrics.costUsd,
        durationMs,
        model: result.model,
      });
    };

    await runWithConcurrencyLimit(queue, this.maxConcurrent, runAgent, abortController);

    callbacks.onText?.('Consolidando relatorio de seguranca...');
    const docsCtxMerge = getPipelineDocsContext(projectPath, pipelineDocsId);
    const consolidatedPath = await mergeAuditFiles({
      securityDir,
      scanId,
      agents: SECURITY_AUDIT_AGENTS,
      failed,
      partialFilesByAgent: new Map(
        getSecurityAgentStatuses(projectId)
          .filter((status) => status.outputFile)
          .map((status) => [status.agentId, status.outputFile!]),
      ),
      overridePath: docsCtxMerge ? docsCtxMerge.resolveDocPath('Security.md') : undefined,
    });

    logger.info({ projectId, consolidatedPath }, 'Security audit merge complete');
    callbacks.onText?.(`Relatorio consolidado: ${path.basename(consolidatedPath)}`);

    callbacks.onDone?.();
    emitIPC('pipeline:stream', {
      projectId,
      phase: SECURITY_AUDIT_PHASE,
      type: 'done',
    });

    logger.info({ projectId, scanId, consolidatedPath }, 'SecurityAuditRunner finished');
    return consolidatedPath;
  }

  private async spawnAuditAgent(
    agentId: string,
    prompt: string,
    cwd: string,
    abortController: AbortController,
    pipelineDocsId: string | null,
    agentDef: SecurityAuditAgentDef,
    tracker: {
      initialFilesCount: number;
      initialFilesSet: Set<string>;
      filesRead: Set<string>;
      toolCallsCount: number;
      model: string | null;
    },
    emitProgress: (
      status: 'queued' | 'running' | 'completed' | 'failed',
      extras?: Partial<{ findingsCount: number; costUsd: number; durationMs: number; model: string | null }>,
    ) => void,
  ): Promise<AgentRunResult> {
    const docsCtx = getPipelineDocsContext(cwd, pipelineDocsId);
    const projectId = this.currentProjectId;
    if (!projectId) {
      throw new Error('SecurityAuditRunner.spawnAuditAgent called without active projectId context');
    }

    const phase = SECURITY_AUDIT_PHASE;
    let lastProgressAt = Date.now();

    const result = await this.pipelineEngine.spawnAgent(agentId, prompt, {
      projectId,
      phaseNumber: phase,
      cwd,
      docsDir: docsCtx?.docsDir,
      abortController,
      skipProjectRootInjection: true,
      onText: (chunk) => {
        emitIPC('pipeline:stream', {
          type: 'text',
          projectId,
          phase,
          content: chunk,
          auditAgentId: agentDef.agentId,
          auditAgentSlug: agentDef.slug,
        });
      },
      onToolUse: (toolName: string) => {
        tracker.toolCallsCount += 1;
        emitIPC('pipeline:stream', {
          type: 'tool_call',
          projectId,
          phase,
          tool: toolName,
          auditAgentId: agentDef.agentId,
          auditAgentSlug: agentDef.slug,
        });
        const now = Date.now();
        if (now - lastProgressAt > 1500) {
          lastProgressAt = now;
          emitProgress('running');
        }
      },
      onToolUseComplete: (toolName: string, input: unknown) => {
        if (toolName === 'Read' && input !== null && typeof input === 'object') {
          const fp = (input as Record<string, unknown>).file_path;
          if (typeof fp === 'string' && fp.length > 0) {
            tracker.filesRead.add(fp);
          }
        }
      },
    });

    logger.info(
      {
        agentId,
        runtime: result.runtime,
        model: result.model,
        provider: result.provider,
        durationMs: result.metrics.durationMs,
        outputLen: result.output.length,
        toolUses: result.metrics.toolUses,
        apiRequests: result.metrics.apiRequests,
      },
      'Security audit agent finished',
    );

    return {
      output: result.output,
      metrics: result.metrics,
      model: result.model,
      runtime: result.runtime,
      provider: result.provider,
      metadata: result.metadata,
    };
  }
}

export function runWithConcurrencyLimit<T>(
  queue: T[],
  maxConcurrent: number,
  worker: (item: T) => Promise<void>,
  abortController: AbortController,
): Promise<void> {
  if (queue.length === 0) return Promise.resolve();

  const abortSignal = abortController.signal;

  return new Promise<void>((resolve, reject) => {
    let nextIndex = 0;
    let activeWorkers = 0;
    let pauseError: PipelinePausedError | null = null;

    const finishIfSettled = (): boolean => {
      if (activeWorkers !== 0) return false;
      if (pauseError) {
        reject(pauseError);
        return true;
      }
      if (nextIndex >= queue.length || abortSignal.aborted) {
        resolve();
        return true;
      }
      return false;
    };

    const launchNext = (): void => {
      while (!abortSignal.aborted && activeWorkers < maxConcurrent && nextIndex < queue.length) {
        const item = queue[nextIndex++];
        activeWorkers++;

        Promise.resolve()
          .then(() => worker(item))
          .catch((err: unknown) => {
            if (err instanceof PipelinePausedError) {
              if (!pauseError) {
                pauseError = err;
                abortController.abort(err);
              }
              return;
            }
            logger.error({ err }, 'runWithConcurrencyLimit: unexpected worker rejection');
          })
          .finally(() => {
            activeWorkers--;
            if (finishIfSettled()) return;
            launchNext();
          });
      }

      finishIfSettled();
    };

    launchNext();
  });
}

interface BuildAuditPromptArgs {
  agentDef: SecurityAuditAgentDef;
  manifest: RepoManifest;
  files: string[];
  fileList: string;
  partialPath: string;
  previousScanNote: string;
  projectPath: string;
}

const AGENT_PREFIX_MAP: Record<string, string> = {
  secrets: 'SECRETS',
  auth: 'AUTH',
  isolation: 'ISOLATION',
  duplication: 'DUPLICATION',
  logic: 'LOGIC',
  standards: 'STANDARDS',
  owasp: 'OWASP',
};

function buildAuditPrompt(args: BuildAuditPromptArgs): string {
  const { agentDef, manifest, files, fileList, previousScanNote, projectPath } = args;

  const prefix = AGENT_PREFIX_MAP[agentDef.slug] ?? agentDef.slug.toUpperCase();

  return `# Auditoria de Seguranca - ${agentDef.name}

## Projeto
- **Path:** ${projectPath}
- **Linguagem:** ${manifest.language}
- **Framework:** ${manifest.framework}
- **Total de arquivos classificados:** ${manifest.classifiedFiles}${previousScanNote}

## Arquivos sob sua responsabilidade (${files.length} arquivos)

${fileList}

---

## FASE 1 - INVESTIGACAO (ate 10 rounds de ferramentas)

Leia os arquivos listados acima usando Read, Grep e Glob. Identifique vulnerabilidades,
problemas de seguranca e riscos dentro do escopo do seu papel.

Conforme voce identifica vulnerabilidades durante a investigacao, EMITA imediatamente o
finding completo no formato abaixo, sem esperar o final da analise. NAO acumule findings
para o final.

## FASE 2 - RELATORIO (obrigatorio, mesmo que parcial)

Ao concluir a investigacao (ou ao atingir o limite de rounds), escreva TODOS os findings
encontrados usando EXATAMENTE o template abaixo:

### ${prefix}-{NNN}: {Titulo curto da vulnerabilidade}
- **Severidade:** CRITICO | ALTO | MEDIO | BAIXO
- **Arquivo(s):** caminho/do/arquivo.ts:linha
- **Trecho:**
  \`\`\`linguagem
  codigo relevante aqui
  \`\`\`
- **Impacto:** Descricao do risco concreto
- **Recomendacao:** Como corrigir de forma segura

Onde {NNN} e um numero sequencial de 3 digitos (001, 002, etc).
Use o prefixo ${prefix} em todos os findings.

Se nao encontrar nenhum problema, escreva apenas: "Nenhum finding encontrado para os arquivos analisados."

**OBRIGATORIO:** A ultima linha da sua resposta final DEVE ser exatamente:
\`RELATORIO COMPLETO\`

O runner salvara automaticamente o conteudo da sua resposta. Voce nao precisa e nao deve escrever arquivos.

Comece a FASE 1 agora.`;
}

interface MergeArgs {
  securityDir: string;
  scanId: string;
  agents: SecurityAuditAgentDef[];
  failed: Array<{ agentId: string; name: string; error: string }>;
  partialFilesByAgent?: Map<string, string>;
  overridePath?: string;
}

async function mergeAuditFiles(args: MergeArgs): Promise<string> {
  const { securityDir, scanId, agents, failed, partialFilesByAgent, overridePath } = args;
  const sortedAgents = [...agents].sort((a, b) => a.order - b.order);

  const sections: string[] = [];

  if (failed.length > 0) {
    const failedList = failed.map((f) => `- ${f.name} (${f.agentId}): ${f.error.substring(0, 100)}`).join('\n');
    sections.push(
      `# Aviso: Agentes com falha\n\nOs seguintes agentes nao concluiram a auditoria:\n\n${failedList}\n\nOs resultados abaixo sao parciais.`,
    );
  }

  for (const agentDef of sortedAgents) {
    const partialFilename =
      partialFilesByAgent?.get(agentDef.agentId) ??
      `Security-${scanId}-${agentDef.order.toString().padStart(2, '0')}-${agentDef.slug}.md`;
    const partialPath = path.join(securityDir, partialFilename);

    if (!fs.existsSync(partialPath)) {
      logger.warn({ partialPath }, 'Partial file not found during merge; skipping');
      continue;
    }

    try {
      const content = fs.readFileSync(partialPath, 'utf-8').trim();
      const header = `## ${agentDef.order.toString().padStart(2, '0')}. ${agentDef.name}`;
      sections.push(`${header}\n\n${content}`);
    } catch (err) {
      logger.warn({ err, partialPath }, 'Could not read partial file during merge; skipping');
    }
  }

  const consolidated = sections.join('\n\n---\n\n');
  const consolidatedFilename = `Security-${scanId}.md`;
  const consolidatedPath = overridePath ?? path.join(securityDir, consolidatedFilename);

  try {
    fs.writeFileSync(consolidatedPath, consolidated, 'utf-8');
    logger.info({ consolidatedPath }, 'Consolidated security report written');
  } catch (err) {
    logger.error({ err, consolidatedPath }, 'Failed to write consolidated report');
    throw err;
  }

  return consolidatedPath;
}
