import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { emitIPC } from './pipeline-shared/ipc-emitter';
import { insertBugAnalysisAgentStatus, updateBugAnalysisAgentStatus, savePipelinePhaseMetrics } from './db';
import { resolveAgentQueryConfig } from './agent-config-resolver';
import { runWithConcurrencyLimit } from './security-audit-runner';
import { rethrowPipelinePause } from './pipeline-engine/provider-auth';
import { PipelinePausedError } from './agent-runtime/types';
import type { AgentConfig } from '../../src/types';
import type { AgentExecutionResult } from './agent-runtime/types';
import type { PipelineEngine } from './pipeline-engine';
import type { BugContext } from './bug-paths';
import { BUG_ROOT_CAUSE_ANALYST_ID, BUG_CONTEXT_HISTORIAN_ID, BUG_HYPOTHESIS_REFUTER_ID } from './seed-agents/index';

const logger = createLogger('bug-analysis-runner');

export const BUG_ANALYSIS_PHASE = 2;

export const BUG_ANALYSIS_PHASE_NAME = 'Analise Paralela';

export const BUG_ANALYSIS_AGGREGATE_AGENT_ID = 'bug-analysis-multi';

export interface BugAnalysisAgentDef {
  agentId: string;
  name: string;
  slug: string;
  order: 1 | 2 | 3;
}

export const BUG_ANALYSIS_AGENTS: BugAnalysisAgentDef[] = [
  { agentId: BUG_ROOT_CAUSE_ANALYST_ID, name: 'Root Cause Analyst', slug: 'root-cause', order: 1 },
  { agentId: BUG_CONTEXT_HISTORIAN_ID, name: 'Context Historian', slug: 'historian', order: 2 },
  { agentId: BUG_HYPOTHESIS_REFUTER_ID, name: 'Hypothesis Refuter', slug: 'refuter', order: 3 },
];

export function resolveBugAnalysisOutputPath(
  ctx: Pick<BugContext, 'analise01Path' | 'analise02Path' | 'analise03Path'>,
  order: BugAnalysisAgentDef['order'],
): string {
  switch (order) {
    case 1:
      return ctx.analise01Path;
    case 2:
      return ctx.analise02Path;
    case 3:
      return ctx.analise03Path;
  }
}

export interface BuildBugAnalysisPromptArgs {
  projectPath: string;
  diagnosticoPath: string;
  diagnosticoContent: string;
  graphBlock: string;
}

export function buildBugAnalysisPrompt(args: BuildBugAnalysisPromptArgs): string {
  const { projectPath, diagnosticoPath, diagnosticoContent, graphBlock } = args;
  return `Analise o bug diagnosticado abaixo pela SUA lente, definida no seu systemPrompt.

## Entrada
- PROJECT ROOT: ${projectPath}

## Diagnostico (conteudo integral, lido de ${diagnosticoPath})

${diagnosticoContent}

${graphBlock}

## Regras desta execucao
- Voce NAO escreve arquivo nenhum. O runner salva sua resposta no arquivo do
  pipeline automaticamente. Voce nao tem Write nem Edit.
- Voce NAO modifica codigo do projeto. Bash so em modo leitura.
- Responda EXATAMENTE nas secoes definidas no seu systemPrompt, em markdown.
- TODA afirmacao sobre o codigo tem file:line.`;
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

export interface BugAnalysisCallbacks {
  onText?: (chunk: string) => void;
  onDone?: () => void;
}

export interface BugAnalysisRunInput {
  project: { id: string; projectPath: string };
  bugCtx: BugContext;
  graphBlock: string;
  abortController: AbortController;
  callbacks?: BugAnalysisCallbacks;
}

export interface BugAnalysisRunResult {
  writtenPaths: string[];
  failed: Array<{ agentId: string; name: string; error: string }>;
}

export class BugAnalysisRunner {
  private readonly maxConcurrent = 3;

  constructor(private readonly pipelineEngine: PipelineEngine) {}

  async run(input: BugAnalysisRunInput): Promise<BugAnalysisRunResult> {
    const { project, bugCtx, graphBlock, abortController, callbacks } = input;
    const projectId = project.id;
    const projectPath = project.projectPath;
    const runId = bugCtx.runId;

    let diagnosticoContent = '';
    if (fs.existsSync(bugCtx.diagnosticoPath)) {
      try {
        diagnosticoContent = fs.readFileSync(bugCtx.diagnosticoPath, 'utf-8');
      } catch (err) {
        logger.error({ err, path: bugCtx.diagnosticoPath }, 'Failed to read bug diagnostico');
        diagnosticoContent = '';
      }
    }
    if (diagnosticoContent.trim().length === 0) {
      throw new Error(
        `Diagnostico do bug ausente ou vazio em ${bugCtx.diagnosticoPath}. ` +
          `A fase 2 nao roda sem o diagnostico da fase 1. ` +
          `Resete a fase 1 e conclua o Bug Discovery antes de seguir.`,
      );
    }

    insertBugAnalysisAgentStatus(
      projectId,
      runId,
      BUG_ANALYSIS_AGENTS.map((a) => ({
        agentId: a.agentId,
        agentName: a.name,
        agentSlug: a.slug,
      })),
    );

    logger.info({ projectId, runId, runDir: bugCtx.runDir }, 'Starting BugAnalysisRunner');
    callbacks?.onText?.('Iniciando analise paralela do bug (3 lentes)...');

    const failed: BugAnalysisRunResult['failed'] = [];
    const writtenByOrder = new Map<number, string>();

    const runAgent = async (agentDef: BugAnalysisAgentDef): Promise<void> => {
      let initialModel: string | null = null;
      let initialRuntime: AgentConfig['runtime'] | null = null;
      try {
        const cfg = await resolveAgentQueryConfig(agentDef.agentId);
        initialModel = cfg.model ?? null;
        initialRuntime = cfg.runtime ?? null;
      } catch (err) {
        logger.warn(
          { err, agentId: agentDef.agentId },
          'Could not resolve initial model/runtime for bug analysis agent',
        );
      }

      const agentStartedAt = new Date();

      if (abortController.signal.aborted) {
        updateBugAnalysisAgentStatus(projectId, runId, agentDef.agentId, {
          status: 'failed',
          errorMessage: 'Abortado antes de iniciar',
          completedAt: new Date().toISOString(),
        });
        failed.push({ agentId: agentDef.agentId, name: agentDef.name, error: 'Abortado' });
        return;
      }

      const tracker = {
        filesRead: new Set<string>(),
        toolCallsCount: 0,
        model: initialModel,
        runtime: initialRuntime,
      };

      const emitProgress = (
        status: 'queued' | 'running' | 'completed' | 'failed',
        extras?: Partial<{ costUsd: number; durationMs: number; model: string | null }>,
      ): void => {
        emitIPC('pipeline:audit-agent-progress', {
          projectId,
          agentId: agentDef.agentId,
          slug: agentDef.slug,
          agentName: agentDef.name,
          status,
          filesAnalyzed: 0,
          additionalFilesAfterStart: tracker.filesRead.size,
          toolCallsCount: tracker.toolCallsCount,
          costUsd: extras?.costUsd ?? 0,
          durationMs: extras?.durationMs ?? Date.now() - agentStartedAt.getTime(),
          findingsCount: undefined,
          model: extras?.model ?? tracker.model,
          runtime: tracker.runtime,
        });
      };

      updateBugAnalysisAgentStatus(projectId, runId, agentDef.agentId, {
        status: 'running',
        startedAt: agentStartedAt.toISOString(),
      });
      emitProgress('running');

      callbacks?.onText?.(`[${agentDef.name}] iniciando...`);
      logger.info(
        { projectId, runId, agentId: agentDef.agentId, order: agentDef.order },
        'Starting bug analysis agent',
      );

      const outputPath = resolveBugAnalysisOutputPath(bugCtx, agentDef.order);
      const userPrompt = buildBugAnalysisPrompt({
        projectPath,
        diagnosticoPath: bugCtx.diagnosticoPath,
        diagnosticoContent,
        graphBlock,
      });

      let result!: AgentRunResult;
      const MAX_ATTEMPTS = 2;
      let lastErr: Error | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          result = await this.spawnAnalysisAgent(
            agentDef,
            userPrompt,
            projectId,
            projectPath,
            abortController,
            tracker,
            emitProgress,
          );
          lastErr = null;
          break;
        } catch (err) {
          if (err instanceof PipelinePausedError) {
            updateBugAnalysisAgentStatus(projectId, runId, agentDef.agentId, {
              status: 'pending',
              errorMessage: err.message.substring(0, 500),
            });
            throw err;
          }
          if (abortController.signal.reason instanceof PipelinePausedError) {
            updateBugAnalysisAgentStatus(projectId, runId, agentDef.agentId, {
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
              'Bug analysis agent transient failure (exit code 1) - retrying after 5s',
            );
            callbacks?.onText?.(`[${agentDef.name}] Falha transiente, tentando novamente em 5s...`);
            await new Promise((resolve) => setTimeout(resolve, 5000));
            continue;
          }
          break;
        }
      }

      if (lastErr) {
        const errorMsg = lastErr.message;
        const completedAt = new Date().toISOString();
        logger.error({ err: lastErr, agentId: agentDef.agentId }, 'Bug analysis agent failed');
        callbacks?.onText?.(`[${agentDef.name}] ERRO: ${errorMsg}`);

        updateBugAnalysisAgentStatus(projectId, runId, agentDef.agentId, {
          status: 'failed',
          errorMessage: errorMsg.substring(0, 500),
          completedAt,
        });
        emitProgress('failed', { durationMs: Date.now() - agentStartedAt.getTime() });
        failed.push({ agentId: agentDef.agentId, name: agentDef.name, error: errorMsg });

        savePipelinePhaseMetrics({
          projectId,
          phaseNumber: BUG_ANALYSIS_PHASE,
          phaseName: BUG_ANALYSIS_PHASE_NAME,
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
            agentSlug: agentDef.slug,
            additionalFilesAfterStart: tracker.filesRead.size,
          },
          sprintIndex: agentDef.order,
        });
        return;
      }

      tracker.model = result.model ?? tracker.model;
      tracker.runtime = result.runtime ?? tracker.runtime;

      try {
        fs.writeFileSync(outputPath, result.output, 'utf-8');
        writtenByOrder.set(agentDef.order, outputPath);
      } catch (err) {
        logger.error({ err, outputPath }, 'Could not write bug analysis output file');
        throw err instanceof Error ? err : new Error(String(err));
      }

      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - agentStartedAt.getTime();

      updateBugAnalysisAgentStatus(projectId, runId, agentDef.agentId, {
        status: 'completed',
        outputFile: path.basename(outputPath),
        completedAt,
      });

      callbacks?.onText?.(`[${agentDef.name}] concluido.`);
      logger.info({ projectId, runId, agentId: agentDef.agentId, outputPath }, 'Bug analysis agent completed');

      savePipelinePhaseMetrics({
        projectId,
        phaseNumber: BUG_ANALYSIS_PHASE,
        phaseName: BUG_ANALYSIS_PHASE_NAME,
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
          agentSlug: agentDef.slug,
          provider: result.provider,
          outputFile: path.basename(outputPath),
          additionalFilesAfterStart: tracker.filesRead.size,
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
        },
        unknownCostCount: result.metrics.costStatus === 'unknown' ? 1 : 0,
        sprintIndex: agentDef.order,
      });

      emitProgress('completed', {
        costUsd: result.metrics.costUsd,
        durationMs,
        model: result.model,
      });

      emitIPC('pipeline:usage', {
        projectId,
        phase: BUG_ANALYSIS_PHASE,
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

    await runWithConcurrencyLimit(BUG_ANALYSIS_AGENTS, this.maxConcurrent, runAgent, abortController);

    callbacks?.onDone?.();
    emitIPC('pipeline:stream', {
      projectId,
      phase: BUG_ANALYSIS_PHASE,
      type: 'done',
    });

    const writtenPaths = [...writtenByOrder.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);

    logger.info(
      { projectId, runId, written: writtenPaths.length, failed: failed.length },
      'BugAnalysisRunner finished',
    );

    return { writtenPaths, failed };
  }

  private async spawnAnalysisAgent(
    agentDef: BugAnalysisAgentDef,
    prompt: string,
    projectId: string,
    cwd: string,
    abortController: AbortController,
    tracker: { filesRead: Set<string>; toolCallsCount: number; model: string | null },
    emitProgress: (
      status: 'queued' | 'running' | 'completed' | 'failed',
      extras?: Partial<{ costUsd: number; durationMs: number; model: string | null }>,
    ) => void,
  ): Promise<AgentRunResult> {
    const phase = BUG_ANALYSIS_PHASE;
    let lastProgressAt = Date.now();

    const result = await this.pipelineEngine.spawnAgent(agentDef.agentId, prompt, {
      projectId,
      phaseNumber: phase,
      cwd,
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
        agentId: agentDef.agentId,
        runtime: result.runtime,
        model: result.model,
        provider: result.provider,
        durationMs: result.metrics.durationMs,
        outputLen: result.output.length,
        toolUses: result.metrics.toolUses,
      },
      'Bug analysis agent finished',
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
