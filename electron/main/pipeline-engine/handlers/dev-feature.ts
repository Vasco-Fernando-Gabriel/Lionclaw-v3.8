import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../logger';
import { emitIPC } from '../../pipeline-shared/ipc-emitter';
import { emitPipelineSprintsLoaded, emitPipelineStream } from '../stream';
import { mergeUsageMetadata, type AccumulatedMetrics } from '../metrics';
import { persistMessage } from '../../pipeline-shared/persist';
import { buildCodexResumePrompt } from '../codex-sessions';
import { rethrowPipelinePause } from '../provider-auth';
import type { AgentConfig } from '../../../../src/types';
import {
  getHarnessProject,
  getAgent,
  getPipelinePhaseMessagesAsChatHistory,
  savePipelinePhaseMetrics,
  updateHarnessProject,
} from '../../db';
import {
  getPipelineDocsContext,
  findHarnessSprintsReadPath,
  resolveHarnessSprintsPath,
  resolvePrdPath,
} from '../../pipeline-paths';
import {
  DISCOVERY_AGENT_ID,
  PRD_GENERATOR_ID,
  PRD_VALIDATOR_ID,
  SPRINT_VALIDATOR_ID,
  SPEC_ENRICHER_ID,
  SPEC_BUILDER_ID,
  SPEC_VALIDATOR_ID,
  FEAT_DISCOVERY_ID,
  FEAT_PRD_VALIDATOR_ID,
  FEAT_PRD_GENERATOR_ID,
  FEAT_PRD_COMPLETO_ID,
} from '../../seed-agents/index';
import { getPhaseName, getPhaseAgentId, getPhaseNumberForAgent, PHASE_NAMES, PHASE_AGENT_IDS } from '../registry';
import type { PipelineEngineContext, HandlerPhaseState } from './context';

const logger = createLogger('pipeline-engine');

function assertDiscoveryReady(discoveryNotesPath: string): void {
  if (!fs.existsSync(discoveryNotesPath)) {
    throw new Error(
      `Discovery nao encontrado em ${discoveryNotesPath}. A fase 1 (Discovery) ` +
        `precisa gerar o documento de discovery nesse caminho exato antes do PRD rodar.`,
    );
  }
  const content = fs.readFileSync(discoveryNotesPath, 'utf-8');
  const substantive = content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\(a definir[^)]*\)/gi, '')
    .trim();
  const stillTemplate = /\(a definir conforme a conversa/i.test(content);
  if (stillTemplate || substantive.length < 300) {
    throw new Error(
      `Discovery em ${discoveryNotesPath} esta vazio ou ainda e um template ` +
        `(feature nao definida): ${substantive.length} chars uteis` +
        `${stillTemplate ? ', marcador "(a definir...)" presente' : ''}. ` +
        `A fase 1 nao populou o documento canonico. Confirme que o agente de discovery ` +
        `escreveu NESSE caminho e re-rode a fase 1 antes do PRD.`,
    );
  }
}

export async function runPhase2(
  ctx: PipelineEngineContext,
  projectId: string,
  projectPath: string,
  state: HandlerPhaseState,
): Promise<void> {
  const project2 = getHarnessProject(projectId);
  const docsCtx = getPipelineDocsContext(projectPath, project2?.pipelineDocsId ?? null);
  const discoveryNotesPath = docsCtx
    ? docsCtx.resolveDocPath('discovery.md')
    : path.join(projectPath, 'discovery-notes.md');
  const storiesPath = docsCtx
    ? docsCtx.resolveDocPath('stories-requisitos.md')
    : path.join(projectPath, 'stories-requisitos.md');

  assertDiscoveryReady(discoveryNotesPath);

  const prompt =
    `Leia ${discoveryNotesPath}. ` +
    `Gere user stories, requisitos funcionais (RF) e requisitos nao-funcionais (RNF) detalhados a partir das notas de discovery. ` +
    `Salve o resultado em ${storiesPath}.`;

  let phase2Output = '';
  const result = await ctx.spawnAgent(PRD_GENERATOR_ID, prompt, {
    projectId,
    phaseNumber: 2,
    cwd: projectPath,
    abortController: state.abortController,
    docsDir: docsCtx?.docsDir,
    onText: (chunk) => {
      phase2Output += chunk;
      emitPipelineStream({ projectId, phase: 2, type: 'text', content: chunk });
    },
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 2, type: 'tool_call', tool: toolName });
    },
  });

  if (phase2Output) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 2 }, 'assistant', phase2Output);
  }

  ctx.collectMetrics(projectId, 2, PRD_GENERATOR_ID, result, 'completed');

  logger.info({ projectId, storiesPath }, 'Phase 2 completed — stories-requisitos.md generated');

  if (fs.existsSync(storiesPath)) {
    emitIPC('pipeline:document-updated', {
      projectId,
      path: storiesPath,
      content: fs.readFileSync(storiesPath, 'utf-8'),
    });
  }

  emitPipelineStream({ projectId, phase: 2, type: 'done' });
  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 2,
    phaseName: PHASE_NAMES[2],
    status: 'completed',
    awaitingUser: false,
  });

  await ctx.advanceToNextPhase(projectId, state);
}

export async function runPhase4(
  ctx: PipelineEngineContext,
  projectId: string,
  projectPath: string,
  state: HandlerPhaseState,
): Promise<void> {
  const project4 = getHarnessProject(projectId);
  const docsCtx = getPipelineDocsContext(projectPath, project4?.pipelineDocsId ?? null);
  const discoveryNotesPath = docsCtx
    ? docsCtx.resolveDocPath('discovery.md')
    : path.join(projectPath, 'discovery-notes.md');
  const storiesPath = docsCtx
    ? docsCtx.resolveDocPath('stories-requisitos.md')
    : path.join(projectPath, 'stories-requisitos.md');
  const prdPath = docsCtx ? docsCtx.resolveDocPath('PRD.md') : path.join(projectPath, 'PRD.md');

  assertDiscoveryReady(discoveryNotesPath);

  const prompt =
    `Leia ${discoveryNotesPath} para contexto do discovery e ${storiesPath} para as user stories e requisitos aprovados. ` +
    `Gere o documento PRD completo com resumo executivo, personas, user stories, requisitos funcionais, ` +
    `requisitos nao-funcionais, metricas de sucesso, escopo negativo e dependencias/riscos. ` +
    `Salve em ${prdPath}.`;

  let phase4Output = '';
  const result = await ctx.spawnAgent(PRD_GENERATOR_ID, prompt, {
    projectId,
    phaseNumber: 4,
    cwd: projectPath,
    abortController: state.abortController,
    docsDir: docsCtx?.docsDir,
    onText: (chunk) => {
      phase4Output += chunk;
      emitPipelineStream({ projectId, phase: 4, type: 'text', content: chunk });
    },
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 4, type: 'tool_call', tool: toolName });
    },
  });

  if (phase4Output) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 4 }, 'assistant', phase4Output);
  }

  ctx.collectMetrics(projectId, 4, PRD_GENERATOR_ID, result, 'completed');

  ctx.updateProjectColumns(projectId, { prdPath });

  logger.info({ projectId, prdPath }, 'Phase 4 completed — PRD.md generated');

  if (fs.existsSync(prdPath)) {
    emitIPC('pipeline:document-updated', {
      projectId,
      path: prdPath,
      content: fs.readFileSync(prdPath, 'utf-8'),
    });
  }

  emitPipelineStream({ projectId, phase: 4, type: 'done' });
  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 4,
    phaseName: PHASE_NAMES[4],
    status: 'completed',
    awaitingUser: false,
  });

  await ctx.advanceToNextPhase(projectId, state);
}

export async function runPhase11(
  ctx: PipelineEngineContext,
  projectId: string,
  state: HandlerPhaseState,
  briefingPrefix?: string,
): Promise<void> {
  const startedAt = Date.now();

  const projectBeforePlan = getHarnessProject(projectId);
  if (projectBeforePlan) {
    const cfg = projectBeforePlan.config;
    let needsPatch = false;
    if (!cfg.plannerAgentId) {
      cfg.plannerAgentId = 'harness-planner';
      needsPatch = true;
    }
    if (!cfg.evaluatorAgentId) {
      cfg.evaluatorAgentId = 'harness-evaluator';
      needsPatch = true;
    }
    if (needsPatch) {
      logger.warn({ projectId }, 'Patching empty planner/evaluator agent IDs on existing project');
      updateHarnessProject(projectId, { config: cfg });
    }
  }

  const bridgeProject = getHarnessProject(projectId);
  const bridgePhase = (bridgeProject ? getPhaseNumberForAgent(bridgeProject, 'harness-planner') : undefined) ?? 11;
  ctx.harnessEngine.setStreamBridge((channel, data) => {
    if (channel === 'harness:agent-stream') {
      const d = data as { projectId?: string; event?: { type?: string; content?: string; tool?: string } };
      if (d.projectId !== projectId || !d.event?.type) return;
      if (d.event.type === 'text' && d.event.content) {
        emitPipelineStream({ projectId, phase: bridgePhase, type: 'text', content: d.event.content });
      } else if ((d.event.type === 'tool_use' || d.event.type === 'tool_call') && d.event.tool) {
        emitPipelineStream({ projectId, phase: bridgePhase, type: 'tool_call', tool: d.event.tool });
      } else if (d.event.type === 'thinking') {
        emitPipelineStream({ projectId, phase: bridgePhase, type: 'thinking' });
      }
    }
  });

  let plannerResult: Awaited<ReturnType<typeof ctx.harnessEngine.plan>>;
  try {
    plannerResult = await ctx.harnessEngine.plan(projectId, briefingPrefix, 'pipeline');
  } finally {
    ctx.harnessEngine.clearStreamBridge();
  }

  if (state.abortController.signal.aborted) {
    return;
  }

  const durationMs = Date.now() - startedAt;

  const project = getHarnessProject(projectId);
  const plannerPhaseNumber = (project ? getPhaseNumberForAgent(project, 'harness-planner') : undefined) ?? 11;
  const plannerPhaseName =
    (project ? getPhaseName(plannerPhaseNumber, project) : PHASE_NAMES[11]) ?? `Phase ${plannerPhaseNumber}`;
  const plannerMetrics = plannerResult?.metrics ?? {
    inputTokens: project?.plannerInputTokens ?? 0,
    outputTokens: project?.plannerOutputTokens ?? 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolUses: 0,
    apiRequests: 1,
    costUsd: project?.plannerCostUsd ?? 0,
    durationMs: project?.plannerDurationMs ?? durationMs,
  };

  const plannerAgentId =
    (project ? getPhaseAgentId(plannerPhaseNumber, project) : PHASE_AGENT_IDS[11]) ?? 'harness-planner';
  const plannerAgentRecord = getAgent(plannerAgentId);
  savePipelinePhaseMetrics({
    projectId,
    phaseNumber: plannerPhaseNumber,
    phaseName: plannerPhaseName,
    agentId: plannerAgentId,
    status: 'completed',
    inputTokens: plannerMetrics.inputTokens,
    outputTokens: plannerMetrics.outputTokens,
    cacheReadTokens: plannerMetrics.cacheReadTokens,
    cacheCreationTokens: plannerMetrics.cacheCreationTokens,
    costUsd: plannerMetrics.costUsd,
    durationMs: plannerMetrics.durationMs,
    toolUses: plannerMetrics.toolUses,
    apiRequests: plannerMetrics.apiRequests,
    model: plannerResult?.model ?? plannerAgentRecord?.model ?? undefined,
    runtime: plannerResult?.runtime ?? plannerAgentRecord?.runtime ?? 'cloud',
    completedAt: new Date().toISOString(),
    metadata: plannerResult ? { provider: plannerResult.provider, ...plannerResult.metadata } : undefined,
    unknownCostCount: project?.plannerUnknownCostCount ?? 0,
  });

  emitIPC('pipeline:metrics', {
    projectId,
    phaseNumber: plannerPhaseNumber,
    metrics: plannerMetrics,
  });

  logger.info({ projectId, plannerPhaseNumber }, 'Planner phase completed');

  emitPipelineSprintsLoaded(projectId);

  const projectAfterPlan = getHarnessProject(projectId);
  if (projectAfterPlan) {
    const sprintsJsonPath = findHarnessSprintsReadPath(projectAfterPlan);
    if (sprintsJsonPath) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: sprintsJsonPath,
        content: fs.readFileSync(sprintsJsonPath, 'utf-8'),
      });
    }
  }

  emitPipelineStream({ projectId, phase: plannerPhaseNumber, type: 'done' });
  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: plannerPhaseNumber,
    phaseName: plannerPhaseName,
    status: 'completed',
    awaitingUser: false,
  });

  await ctx.advanceToNextPhase(projectId, state);
}

export async function runPhase9(ctx: PipelineEngineContext, projectId: string): Promise<void> {
  const project = getHarnessProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const state = ctx.getState(projectId);
  const projectPath = project.projectPath;
  const docsCtxP9 = getPipelineDocsContext(projectPath, project.pipelineDocsId ?? null);
  const prdPath =
    (project ? resolvePrdPath(project) : null) ||
    (docsCtxP9 ? docsCtxP9.resolveDocPath('PRD.md') : path.join(projectPath, 'PRD.md'));
  const storiesPath = docsCtxP9
    ? docsCtxP9.resolveDocPath('stories-requisitos.md')
    : path.join(projectPath, 'stories-requisitos.md');
  const specPath =
    project.specPath || (docsCtxP9 ? docsCtxP9.resolveDocPath('SPEC.md') : path.join(projectPath, 'SPEC.md'));
  const validationReportPath = docsCtxP9
    ? docsCtxP9.resolveDocPath('spec-validation.md')
    : path.join(projectPath, '.spec-validation-report.md');

  const phaseName = PHASE_NAMES[9];

  logger.info({ projectId, prdPath, storiesPath, specPath }, 'Phase 9: Spec Generation starting');

  savePipelinePhaseMetrics({
    projectId,
    phaseNumber: 9,
    phaseName,
    agentId: SPEC_BUILDER_ID,
    status: 'running',
    startedAt: new Date().toISOString(),
  });

  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 9,
    phaseName,
    status: 'running',
    awaitingUser: false,
  });

  const MAX_ROUNDS = 3;
  let passed = false;
  let lastError: string | undefined;

  const builderAgg = ctx.createEmptyMetrics();
  const validatorAgg = ctx.createEmptyMetrics();
  const builderUsage: Pick<
    AccumulatedMetrics,
    'sessionIds' | 'costSource' | 'pricingSnapshot' | 'modelUsage' | 'grok'
  > = {};
  const validatorUsage: Pick<
    AccumulatedMetrics,
    'sessionIds' | 'costSource' | 'pricingSnapshot' | 'modelUsage' | 'grok'
  > = {};
  let builderModel = SPEC_BUILDER_ID;
  let builderRuntime: AgentConfig['runtime'] = 'cloud';
  let validatorModel = SPEC_VALIDATOR_ID;
  let validatorRuntime: AgentConfig['runtime'] = 'cloud';
  const startedAt = Date.now();

  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (state.abortController.signal.aborted) break;

      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: 9,
        phaseName,
        status: 'spec-builder-running',
        awaitingUser: false,
        metadata: { round, maxRounds: MAX_ROUNDS },
      });

      let builderPrompt: string;
      if (round === 1) {
        builderPrompt =
          `Gere o SPEC.md completo a partir do PRD.md e stories-requisitos.md.\n\n` +
          `PRD: ${prdPath}\n` +
          `User Stories: ${storiesPath}\n` +
          `Salve em: ${specPath}`;
      } else {
        const validationContent = fs.existsSync(validationReportPath)
          ? fs.readFileSync(validationReportPath, 'utf-8')
          : '';
        builderPrompt =
          `Corrija o SPEC.md com base no relatorio de validacao abaixo.\n\n` +
          `Salve o resultado corrigido em: ${specPath}\n\n` +
          `SPEC atual: ${specPath}\n` +
          `Validation Report:\n${validationContent}`;
      }

      let builderOutput = '';
      const builderResult = await ctx.spawnAgent(SPEC_BUILDER_ID, builderPrompt, {
        projectId,
        phaseNumber: 9,
        cwd: projectPath,
        abortController: state.abortController,
        docsDir: docsCtxP9?.docsDir,
        onText: (chunk) => {
          builderOutput += chunk;
          emitPipelineStream({
            projectId,
            phase: 9,
            type: 'text',
            content: chunk,
            metadata: { agent: 'spec-builder', round },
          });
        },
        onToolUse: (toolName) => {
          emitPipelineStream({ projectId, phase: 9, type: 'tool_call', tool: toolName });
        },
      });

      if (builderOutput) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 9 }, 'assistant', builderOutput);
      }

      ctx.mergeMetrics(builderAgg, builderResult.metrics);
      mergeUsageMetadata(builderUsage, builderResult.metadata);
      builderModel = builderResult.model;
      builderRuntime = builderResult.runtime;

      if (fs.existsSync(specPath)) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: specPath,
          content: fs.readFileSync(specPath, 'utf-8'),
        });
      }

      if (state.abortController.signal.aborted) break;

      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: 9,
        phaseName,
        status: 'spec-validator-running',
        awaitingUser: false,
        metadata: { round, maxRounds: MAX_ROUNDS },
      });

      const validatorPrompt =
        `Valide o SPEC.md contra o PRD.md e stories-requisitos.md.\n\n` +
        `SPEC: ${specPath}\n` +
        `PRD: ${prdPath}\n` +
        `User Stories: ${storiesPath}\n` +
        `Salve o relatorio de validacao em: ${validationReportPath}`;

      let validatorOutput = '';
      const validatorResult = await ctx.spawnAgent(SPEC_VALIDATOR_ID, validatorPrompt, {
        projectId,
        phaseNumber: 9,
        cwd: projectPath,
        abortController: state.abortController,
        docsDir: docsCtxP9?.docsDir,
        onText: (chunk) => {
          validatorOutput += chunk;
          emitPipelineStream({
            projectId,
            phase: 9,
            type: 'text',
            content: chunk,
            metadata: { agent: 'spec-validator', round },
          });
        },
        onToolUse: (toolName) => {
          emitPipelineStream({ projectId, phase: 9, type: 'tool_call', tool: toolName });
        },
      });

      if (validatorOutput) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 9 }, 'assistant', validatorOutput);
      }

      ctx.mergeMetrics(validatorAgg, validatorResult.metrics);
      mergeUsageMetadata(validatorUsage, validatorResult.metadata);
      validatorModel = validatorResult.model;
      validatorRuntime = validatorResult.runtime;

      const validationReport = fs.existsSync(validationReportPath)
        ? fs.readFileSync(validationReportPath, 'utf-8')
        : '';

      if (validationReport.includes('## Status: PASS')) {
        passed = true;
        logger.info({ projectId, round }, 'Phase 9: Spec validation PASSED');
        break;
      }

      logger.info({ projectId, round }, 'Phase 9: Spec validation FAILED — continuing');
    }
  } catch (err) {
    rethrowPipelinePause(err);
    if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
      logger.info({ projectId }, 'Phase 9 aborted');
      return;
    }
    lastError = (err as Error).message;
    logger.error({ err, projectId }, 'Phase 9 error');
  }

  const durationMs = Date.now() - startedAt;

  savePipelinePhaseMetrics({
    projectId,
    phaseNumber: 9,
    phaseName: `${phaseName} (Builder)`,
    agentId: SPEC_BUILDER_ID,
    status: lastError ? 'failed' : 'completed',
    inputTokens: builderAgg.inputTokens,
    outputTokens: builderAgg.outputTokens,
    cacheReadTokens: builderAgg.cacheReadTokens,
    cacheCreationTokens: builderAgg.cacheCreationTokens,
    costUsd: builderAgg.costUsd,
    durationMs,
    toolUses: builderAgg.toolUses,
    apiRequests: builderAgg.apiRequests,
    model: builderModel,
    runtime: builderRuntime,
    completedAt: new Date().toISOString(),
    metadata: builderUsage,
  });

  savePipelinePhaseMetrics({
    projectId,
    phaseNumber: 91, // sub-row for validator within phase 9
    phaseName: `${phaseName} (Validator)`,
    agentId: SPEC_VALIDATOR_ID,
    status: lastError ? 'failed' : 'completed',
    inputTokens: validatorAgg.inputTokens,
    outputTokens: validatorAgg.outputTokens,
    cacheReadTokens: validatorAgg.cacheReadTokens,
    cacheCreationTokens: validatorAgg.cacheCreationTokens,
    costUsd: validatorAgg.costUsd,
    durationMs,
    toolUses: validatorAgg.toolUses,
    apiRequests: validatorAgg.apiRequests,
    model: validatorModel,
    runtime: validatorRuntime,
    completedAt: new Date().toISOString(),
    metadata: validatorUsage,
  });

  emitIPC('pipeline:metrics', {
    projectId,
    phaseNumber: 9,
    metrics: { builder: builderAgg, validator: validatorAgg },
    passed,
  });

  if (lastError) {
    logger.error({ projectId, error: lastError }, 'Phase 9 failed — marking pipeline as failed');
    ctx.failPhase(projectId, state, {
      phase: 9,
      phaseName,
      errorMessage: lastError,
      statusUpdate: 'pure-paused',
      emitError: true,
      emitPhaseChanged: true,
      emitStreamDone: false,
      setStateStatusPaused: true,
    });
    return;
  }

  updateHarnessProject(projectId, { specPath });

  emitPipelineStream({ projectId, phase: 9, type: 'done' });

  logger.info({ projectId, passed }, 'Phase 9 auto loop complete — entering spec review conversation');

  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 9,
    phaseName,
    status: 'awaiting-spec-review',
    awaitingUser: true,
    metadata: { passed },
  });

  const greetingProject = getHarnessProject(projectId);
  const greetingMsg =
    `Projeto "${greetingProject?.name ?? projectId}". ` +
    `O loop de geracao automatica foi concluido${passed ? ' e a SPEC passou na validacao automatica' : ' (com alertas de validacao)'}. ` +
    `Apresente um resumo da SPEC.md gerada, destaque pontos fortes e eventuais ressalvas, e pergunte ao usuario se deseja ajustes antes de avancar.`;

  try {
    await ctx.sendMessage(projectId, greetingMsg, { isGreeting: true, rethrowPause: true });
  } catch (greetErr) {
    rethrowPipelinePause(greetErr);
    logger.error({ err: greetErr, projectId }, 'Phase 9: failed to start spec review conversation');
    // Non-fatal: the conversational state is already emitted; user can still type
  }
}

export async function handlePhase1Message(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
): Promise<void> {
  const project = getHarnessProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const sessionKey = 'phase1';
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  const docsCtxP1 = getPipelineDocsContext(project.projectPath, project.pipelineDocsId ?? null);
  const notesPath =
    project.discoveryNotesPath ||
    (docsCtxP1 ? docsCtxP1.resolveDocPath('discovery.md') : path.join(project.projectPath, 'discovery-notes.md'));
  const isFirstTurn = !sessionEntry.alive;

  const prompt = isFirstTurn
    ? `Arquivo de notas do discovery: ${notesPath}\n\nMensagem do usuario: ${message}`
    : message;

  const previousNotesContent = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf-8') : '';

  const phase1Acc = { text: '', completed: false };
  const phase1AgentId = project.pipelineType === 'feature' ? FEAT_DISCOVERY_ID : DISCOVERY_AGENT_ID;
  const phase1Prior = sessionEntry.alive
    ? getPipelinePhaseMessagesAsChatHistory(projectId, 1).map((m) => ({
        ...m,
        tool_calls: m.tool_calls?.map((tc) => ({
          id: tc.id,
          function: {
            name: tc.function.name,
            arguments: (() => {
              try {
                return JSON.parse(tc.function.arguments) as Record<string, unknown>;
              } catch {
                return {};
              }
            })(),
          },
        })),
      }))
    : undefined;
  const result = await ctx.spawnAgent(phase1AgentId, prompt, {
    projectId,
    phaseNumber: 1,
    cwd: project.projectPath,
    abortController: state.abortController,
    continueSession: sessionEntry.alive,
    priorMessages: phase1Prior,
    docsDir: docsCtxP1?.docsDir,
    rebuildPromptOnRetry: () =>
      buildCodexResumePrompt({
        projectId,
        phaseNumber: 1,
        preamble: `Arquivo de notas do discovery: ${notesPath}`,
        userMessage: message,
      }),
    onText: ctx.makeConversationOnText(projectId, 1, phase1Acc),
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 1, type: 'tool_call', tool: toolName });
    },
  });

  sessionEntry.alive = true;

  ctx.accumulateMetrics(state, 1, result);

  if (fs.existsSync(notesPath)) {
    const currentNotesContent = fs.readFileSync(notesPath, 'utf-8');
    if (currentNotesContent !== previousNotesContent) {
      emitIPC('pipeline:notes-updated', {
        projectId,
        path: notesPath,
        content: currentNotesContent,
      });
    }
  }

  const phase1CleanedText = phase1Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  const phase1ToolCalls = result.toolCalls;
  if (phase1CleanedText || (phase1ToolCalls && phase1ToolCalls.length > 0)) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 1 }, 'assistant', phase1CleanedText, {
      toolCalls: phase1ToolCalls,
    });
  }

  emitPipelineStream({ projectId, phase: 1, type: 'done' });
}

export async function handlePhase3Message(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
): Promise<void> {
  const project = getHarnessProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const sessionKey = 'phase3';
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  const projectPath = project.projectPath;
  const docsCtxP3 = getPipelineDocsContext(projectPath, project.pipelineDocsId ?? null);
  const discoveryNotesPath = docsCtxP3
    ? docsCtxP3.resolveDocPath('discovery.md')
    : path.join(projectPath, 'discovery-notes.md');
  const storiesPath = docsCtxP3
    ? docsCtxP3.resolveDocPath('stories-requisitos.md')
    : path.join(projectPath, 'stories-requisitos.md');
  const reportPath = docsCtxP3
    ? docsCtxP3.resolveDocPath('prd-validation.md')
    : path.join(projectPath, '.prd-validation-report.md');

  const isFirstTurn = !sessionEntry.alive;

  const previousStoriesContent = fs.existsSync(storiesPath) ? fs.readFileSync(storiesPath, 'utf-8') : '';

  let prompt: string;
  if (isFirstTurn) {
    const prdPath = project ? resolvePrdPath(project) : null;
    prompt =
      `## Arquivo de relatorio persistente\nCaminho: ${reportPath}\n\n` +
      `## Discovery Notes\nCaminho: ${discoveryNotesPath}\n\n` +
      `## User Stories e Requisitos\nCaminho: ${storiesPath}\n\n` +
      (prdPath && fs.existsSync(prdPath) ? `## PRD\nCaminho: ${prdPath}\n\n` : '') +
      `## Instrucao importante\n` +
      `Apos identificar problemas e discutir com o usuario, edite ${storiesPath} diretamente ` +
      `usando Write ou Edit quando o usuario aprovar uma correcao. Nao peca permissao para editar: edite imediatamente apos o usuario concordar.\n\n` +
      `## Mensagem do usuario\n${message}`;
  } else {
    prompt = message;
  }

  const phase3Acc = { text: '', completed: false };
  const phase3AgentId = project.pipelineType === 'feature' ? FEAT_PRD_VALIDATOR_ID : PRD_VALIDATOR_ID;
  const result = await ctx.spawnAgent(phase3AgentId, prompt, {
    projectId,
    phaseNumber: 3,
    cwd: projectPath,
    abortController: state.abortController,
    continueSession: sessionEntry.alive,
    docsDir: docsCtxP3?.docsDir,
    rebuildPromptOnRetry: () =>
      buildCodexResumePrompt({
        projectId,
        phaseNumber: 3,
        preamble:
          `## Arquivo de relatorio persistente\nCaminho: ${reportPath}\n\n` +
          `## Discovery Notes\nCaminho: ${discoveryNotesPath}\n\n` +
          `## User Stories e Requisitos\nCaminho: ${storiesPath}\n\n` +
          `## Instrucao importante\n` +
          `Apos identificar problemas e discutir com o usuario, edite ${storiesPath} diretamente ` +
          `usando Write ou Edit quando o usuario aprovar uma correcao.`,
        userMessage: message,
      }),
    onText: ctx.makeConversationOnText(projectId, 3, phase3Acc),
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 3, type: 'tool_call', tool: toolName });
    },
  });

  sessionEntry.alive = true;
  ctx.accumulateMetrics(state, 3, result);

  if (fs.existsSync(storiesPath)) {
    const currentStoriesContent = fs.readFileSync(storiesPath, 'utf-8');
    if (currentStoriesContent !== previousStoriesContent) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: storiesPath,
        content: currentStoriesContent,
      });
    }
  }

  const phase3CleanedText = phase3Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (phase3CleanedText) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 3 }, 'assistant', phase3CleanedText);
  }

  emitPipelineStream({ projectId, phase: 3, type: 'done' });
}

export async function handleTechPhaseMessage(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  phaseNumber: number,
  agentId: string,
): Promise<void> {
  const project = getHarnessProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const sessionKey = `phase${phaseNumber}`;
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  const projectPath = project.projectPath;
  const docsCtxTech = getPipelineDocsContext(projectPath, project.pipelineDocsId ?? null);
  const notesPath =
    project.discoveryNotesPath ||
    (docsCtxTech ? docsCtxTech.resolveDocPath('discovery.md') : path.join(projectPath, 'discovery-notes.md'));
  const prdPath =
    (project ? resolvePrdPath(project) : null) ||
    (docsCtxTech ? docsCtxTech.resolveDocPath('PRD.md') : path.join(projectPath, 'PRD.md'));
  const isFirstTurn = !sessionEntry.alive;

  const prompt = isFirstTurn
    ? `Discovery Notes: ${notesPath}\n` +
      `PRD: ${prdPath}\n\n` +
      `Leia os documentos acima para entender o contexto do projeto antes de iniciar a discussao. ` +
      `Conduza a discussao tecnica com o usuario, proponha abordagens e registre as decisoes aprovadas no PRD.md. ` +
      `IMPORTANTE: NAO altere o discovery-notes.md em hipotese alguma, ele e somente leitura para contexto.\n\n` +
      `Mensagem do usuario: ${message}`
    : message;

  const previousPrdContent = fs.existsSync(prdPath) ? fs.readFileSync(prdPath, 'utf-8') : '';

  const techAcc = { text: '', completed: false };
  const result = await ctx.spawnAgent(agentId, prompt, {
    projectId,
    phaseNumber,
    cwd: projectPath,
    abortController: state.abortController,
    continueSession: sessionEntry.alive,
    docsDir: docsCtxTech?.docsDir,
    rebuildPromptOnRetry: () =>
      buildCodexResumePrompt({
        projectId,
        phaseNumber,
        preamble:
          `Discovery Notes: ${notesPath}\n` +
          `PRD: ${prdPath}\n\n` +
          `Conduza a discussao tecnica com o usuario, proponha abordagens e registre as decisoes aprovadas no PRD.md. ` +
          `IMPORTANTE: NAO altere o discovery-notes.md em hipotese alguma, ele e somente leitura para contexto.`,
        userMessage: message,
      }),
    onText: ctx.makeConversationOnText(projectId, phaseNumber, techAcc),
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: phaseNumber, type: 'tool_call', tool: toolName });
    },
  });

  sessionEntry.alive = true;
  ctx.accumulateMetrics(state, phaseNumber, result);

  if (fs.existsSync(prdPath)) {
    const currentPrdContent = fs.readFileSync(prdPath, 'utf-8');
    if (currentPrdContent !== previousPrdContent) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: prdPath,
        content: currentPrdContent,
      });
    }
  }

  const techCleanedText = techAcc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (techCleanedText) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber }, 'assistant', techCleanedText);
  }

  emitPipelineStream({ projectId, phase: phaseNumber, type: 'done' });
}

export async function handlePhase10Message(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
): Promise<void> {
  const project = getHarnessProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const sessionKey = 'phase10';
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  const projectPath = project.projectPath;
  const docsCtxP10 = getPipelineDocsContext(projectPath, project.pipelineDocsId ?? null);
  const specPath =
    project.specPath || (docsCtxP10 ? docsCtxP10.resolveDocPath('SPEC.md') : path.join(projectPath, 'SPEC.md'));
  const prdPath =
    (project ? resolvePrdPath(project) : null) ||
    (docsCtxP10 ? docsCtxP10.resolveDocPath('PRD.md') : path.join(projectPath, 'PRD.md'));
  const storiesPath = docsCtxP10
    ? docsCtxP10.resolveDocPath('stories-requisitos.md')
    : path.join(projectPath, 'stories-requisitos.md');
  const suggestionsPath = docsCtxP10
    ? docsCtxP10.resolveDocPath('enrich-suggestions.md')
    : path.join(projectPath, '.spec-enricher-suggestions.md');

  const isFirstTurn = !sessionEntry.alive;

  const previousSpecContent = fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf-8') : '';

  let prompt: string;
  if (isFirstTurn) {
    prompt =
      `## Arquivo da SPEC\nCaminho: ${specPath}\n\n` +
      `## PRD de referencia\nCaminho: ${prdPath}\n\n` +
      (fs.existsSync(storiesPath) ? `## User Stories de referencia\nCaminho: ${storiesPath}\n\n` : '') +
      `## Arquivo de sugestoes persistente\nCaminho: ${suggestionsPath}\n\n` +
      `## Instrucao importante\n` +
      `Compare a SPEC.md contra o PRD.md. Identifique lacunas, inconsistencias e oportunidades de enriquecimento. ` +
      `Apresente suas sugestoes, discuta com o usuario e edite ${specPath} diretamente usando Write ou Edit apos aprovacao.\n\n` +
      `## Mensagem do usuario\n${message}`;
  } else {
    prompt = message;
  }

  const phase10Acc = { text: '', completed: false };
  const result = await ctx.spawnAgent(SPEC_ENRICHER_ID, prompt, {
    projectId,
    phaseNumber: 10,
    cwd: projectPath,
    abortController: state.abortController,
    continueSession: sessionEntry.alive,
    docsDir: docsCtxP10?.docsDir,
    rebuildPromptOnRetry: () =>
      buildCodexResumePrompt({
        projectId,
        phaseNumber: 10,
        preamble:
          `## Arquivo da SPEC\nCaminho: ${specPath}\n\n` +
          `## PRD de referencia\nCaminho: ${prdPath}\n\n` +
          `## Arquivo de sugestoes persistente\nCaminho: ${suggestionsPath}\n\n` +
          `## Instrucao importante\n` +
          `Compare a SPEC.md contra o PRD.md. Identifique lacunas, inconsistencias e oportunidades de enriquecimento. ` +
          `Apresente suas sugestoes, discuta com o usuario e edite ${specPath} diretamente usando Write ou Edit apos aprovacao.`,
        userMessage: message,
      }),
    onText: ctx.makeConversationOnText(projectId, 10, phase10Acc),
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 10, type: 'tool_call', tool: toolName });
    },
  });

  sessionEntry.alive = true;
  ctx.accumulateMetrics(state, 10, result);

  if (fs.existsSync(specPath)) {
    const currentSpecContent = fs.readFileSync(specPath, 'utf-8');
    if (currentSpecContent !== previousSpecContent) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: specPath,
        content: currentSpecContent,
      });
    }
  }

  const phase10CleanedText = phase10Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (phase10CleanedText) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 10 }, 'assistant', phase10CleanedText);
  }

  emitPipelineStream({ projectId, phase: 10, type: 'done' });
}

export async function handlePhase12Message(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  phaseNumber: number = 12,
  briefing?: string | null,
): Promise<void> {
  const project = getHarnessProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const sessionKey = `sprint-validator-phase${phaseNumber}`;
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  const projectPath = project.projectPath;
  const docsCtxP12 = getPipelineDocsContext(projectPath, project.pipelineDocsId ?? null);
  const specPath =
    project.specPath || (docsCtxP12 ? docsCtxP12.resolveDocPath('SPEC.md') : path.join(projectPath, 'SPEC.md'));
  const sprintsPath = findHarnessSprintsReadPath(project) ?? resolveHarnessSprintsPath(project);
  const reportPath = docsCtxP12
    ? docsCtxP12.resolveDocPath('sprint-validation.md')
    : path.join(projectPath, '.sprint-validation-report.md');

  const isFirstTurn = !sessionEntry.alive;

  const previousSprintsContent = fs.existsSync(sprintsPath) ? fs.readFileSync(sprintsPath, 'utf-8') : '';

  let prompt: string;
  if (isFirstTurn) {
    const baseTurnPrompt =
      `## Arquivo de relatorio persistente\nCaminho: ${reportPath}\n\n` +
      `## SPEC\nCaminho: ${specPath}\n\n` +
      `## Plano de Sprints\nCaminho: ${sprintsPath}\n\n` +
      `## Instrucao principal\n` +
      `Compare a SPEC.md com as sprints geradas. Identifique features da SPEC nao cobertas nas sprints. ` +
      `Sugira ajustes. Apos concordancia com o usuario, edite o arquivo de sprints diretamente em ${sprintsPath}.\n\n` +
      `## Mensagem do usuario\n${message}`;
    prompt = briefing ? `${briefing}\n\n${baseTurnPrompt}` : baseTurnPrompt;
  } else {
    prompt = message;
  }

  const phase12Acc = { text: '', completed: false };
  const result = await ctx.spawnAgent(SPRINT_VALIDATOR_ID, prompt, {
    projectId,
    phaseNumber,
    cwd: projectPath,
    abortController: state.abortController,
    continueSession: sessionEntry.alive,
    docsDir: docsCtxP12?.docsDir,
    rebuildPromptOnRetry: () =>
      buildCodexResumePrompt({
        projectId,
        phaseNumber,
        preamble:
          (briefing ? `${briefing}\n\n` : '') +
          `## Arquivo de relatorio persistente\nCaminho: ${reportPath}\n\n` +
          `## SPEC\nCaminho: ${specPath}\n\n` +
          `## Plano de Sprints\nCaminho: ${sprintsPath}\n\n` +
          `## Instrucao principal\n` +
          `Compare a SPEC.md com as sprints geradas. Identifique features da SPEC nao cobertas nas sprints. ` +
          `Sugira ajustes. Apos concordancia com o usuario, edite o arquivo de sprints diretamente em ${sprintsPath}.`,
        userMessage: message,
      }),
    onText: ctx.makeConversationOnText(projectId, phaseNumber, phase12Acc),
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: phaseNumber, type: 'tool_call', tool: toolName });
    },
  });

  sessionEntry.alive = true;
  ctx.accumulateMetrics(state, phaseNumber, result);

  if (fs.existsSync(sprintsPath)) {
    const currentSprintsContent = fs.readFileSync(sprintsPath, 'utf-8');
    if (currentSprintsContent !== previousSprintsContent) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: sprintsPath,
        content: currentSprintsContent,
      });
    }
  }

  const phase12CleanedText = phase12Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (phase12CleanedText) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber }, 'assistant', phase12CleanedText);
  }

  emitPipelineStream({ projectId, phase: phaseNumber, type: 'done' });
}

export async function handlePhase9Message(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
): Promise<void> {
  const project = getHarnessProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const sessionKey = 'phase9-validator';
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  const projectPath = project.projectPath;
  const docsCtxP9Conv = getPipelineDocsContext(projectPath, project.pipelineDocsId ?? null);
  const specPath =
    project.specPath || (docsCtxP9Conv ? docsCtxP9Conv.resolveDocPath('SPEC.md') : path.join(projectPath, 'SPEC.md'));
  const prdPath =
    (project ? resolvePrdPath(project) : null) ||
    (docsCtxP9Conv ? docsCtxP9Conv.resolveDocPath('PRD.md') : path.join(projectPath, 'PRD.md'));
  const storiesPath = docsCtxP9Conv
    ? docsCtxP9Conv.resolveDocPath('stories-requisitos.md')
    : path.join(projectPath, 'stories-requisitos.md');
  const validationReportPath = docsCtxP9Conv
    ? docsCtxP9Conv.resolveDocPath('spec-validation.md')
    : path.join(projectPath, '.spec-validation-report.md');

  const isFirstTurn = !sessionEntry.alive;

  const previousSpecContent = fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf-8') : '';

  let prompt: string;
  if (isFirstTurn) {
    prompt =
      `## SPEC.md\nCaminho: ${specPath}\n\n` +
      `## PRD de referencia\nCaminho: ${prdPath}\n\n` +
      (fs.existsSync(storiesPath) ? `## User Stories de referencia\nCaminho: ${storiesPath}\n\n` : '') +
      (fs.existsSync(validationReportPath)
        ? `## Relatorio de validacao automatica\nCaminho: ${validationReportPath}\n\n`
        : '') +
      `## Instrucao importante\n` +
      `Voce e o Spec Validator. Leia os arquivos acima, apresente um resumo da SPEC.md, aponte pontos fortes e ressalvas do relatorio de validacao. ` +
      `Se o usuario pedir ajustes, edite ${specPath} diretamente usando Write ou Edit. ` +
      `Quando o usuario estiver satisfeito ele clicara em Aprovar para avancar.\n\n` +
      `## Mensagem do usuario\n${message}`;
  } else {
    prompt = message;
  }

  const phase9Acc = { text: '', completed: false };
  const result = await ctx.spawnAgent(SPEC_VALIDATOR_ID, prompt, {
    projectId,
    phaseNumber: 9,
    cwd: projectPath,
    abortController: state.abortController,
    continueSession: sessionEntry.alive,
    docsDir: docsCtxP9Conv?.docsDir,
    rebuildPromptOnRetry: () =>
      buildCodexResumePrompt({
        projectId,
        phaseNumber: 9,
        preamble:
          `## SPEC.md\nCaminho: ${specPath}\n\n` +
          `## PRD de referencia\nCaminho: ${prdPath}\n\n` +
          (fs.existsSync(validationReportPath)
            ? `## Relatorio de validacao automatica\nCaminho: ${validationReportPath}\n\n`
            : '') +
          `## Instrucao importante\n` +
          `Voce e o Spec Validator. Se o usuario pedir ajustes, edite ${specPath} diretamente usando Write ou Edit. ` +
          `Quando o usuario estiver satisfeito ele clicara em Aprovar para avancar.`,
        userMessage: message,
      }),
    onText: ctx.makeConversationOnText(projectId, 9, phase9Acc),
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 9, type: 'tool_call', tool: toolName });
    },
  });

  sessionEntry.alive = true;
  ctx.accumulateMetrics(state, 91, result);

  if (fs.existsSync(specPath)) {
    const currentSpecContent = fs.readFileSync(specPath, 'utf-8');
    if (currentSpecContent !== previousSpecContent) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: specPath,
        content: currentSpecContent,
      });
    }
  }

  const phase9CleanedText = phase9Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (phase9CleanedText) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 9 }, 'assistant', phase9CleanedText);
  }

  emitPipelineStream({ projectId, phase: 9, type: 'done' });
}

export async function runPhase2Feature(
  ctx: PipelineEngineContext,
  projectId: string,
  projectPath: string,
  state: HandlerPhaseState,
): Promise<void> {
  const project = getHarnessProject(projectId);
  const docsCtxF2 = getPipelineDocsContext(projectPath, project?.pipelineDocsId ?? null);
  const notesPath =
    project?.discoveryNotesPath ||
    (docsCtxF2 ? docsCtxF2.resolveDocPath('discovery.md') : path.join(projectPath, 'discovery-notes.md'));
  const storiesPath = docsCtxF2
    ? docsCtxF2.resolveDocPath('stories-requisitos.md')
    : path.join(projectPath, 'stories-requisitos.md');

  if (!fs.existsSync(notesPath)) {
    throw new Error(`Feature notes not found at ${notesPath}`);
  }

  const prompt =
    `Leia ${notesPath}. ` +
    `Analise o codigo existente do projeto (cwd: ${projectPath}) usando Glob, Grep e Read para entender ` +
    `componentes, modulos e patterns relevantes para a feature. ` +
    `Gere user stories, requisitos funcionais (RF) e requisitos nao-funcionais (RNF) detalhados, ` +
    `referenciando arquivos e modulos existentes quando aplicavel. ` +
    `Salve o resultado em ${storiesPath}.`;

  let phase2Output = '';
  const result = await ctx.spawnAgent(FEAT_PRD_GENERATOR_ID, prompt, {
    projectId,
    phaseNumber: 2,
    cwd: projectPath,
    abortController: state.abortController,
    docsDir: docsCtxF2?.docsDir,
    onText: (chunk) => {
      phase2Output += chunk;
      emitPipelineStream({ projectId, phase: 2, type: 'text', content: chunk });
    },
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 2, type: 'tool_call', tool: toolName });
    },
  });

  if (phase2Output || (result.toolCalls && result.toolCalls.length > 0)) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 2 }, 'assistant', phase2Output, {
      toolCalls: result.toolCalls,
    });
  }

  ctx.collectMetrics(projectId, 2, FEAT_PRD_GENERATOR_ID, result, 'completed');

  logger.info({ projectId, storiesPath }, 'Phase 2 (feature) completed — stories-requisitos.md generated');

  if (fs.existsSync(storiesPath)) {
    emitIPC('pipeline:document-updated', {
      projectId,
      path: storiesPath,
      content: fs.readFileSync(storiesPath, 'utf-8'),
    });
  }

  emitPipelineStream({ projectId, phase: 2, type: 'done' });
  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 2,
    phaseName: getPhaseName(2, project ?? undefined) ?? 'PRD Generator',
    status: 'completed',
    awaitingUser: false,
  });

  await ctx.advanceToNextPhase(projectId, state);
}

export async function runPhase4Feature(
  ctx: PipelineEngineContext,
  projectId: string,
  projectPath: string,
  state: HandlerPhaseState,
): Promise<void> {
  const project = getHarnessProject(projectId);
  const docsCtxF4 = getPipelineDocsContext(projectPath, project?.pipelineDocsId ?? null);
  const notesPath =
    project?.discoveryNotesPath ||
    (docsCtxF4 ? docsCtxF4.resolveDocPath('discovery.md') : path.join(projectPath, 'discovery-notes.md'));
  const storiesPath = docsCtxF4
    ? docsCtxF4.resolveDocPath('stories-requisitos.md')
    : path.join(projectPath, 'stories-requisitos.md');
  const prdPath = docsCtxF4 ? docsCtxF4.resolveDocPath('PRD.md') : path.join(projectPath, 'PRD.md');

  if (!fs.existsSync(notesPath)) {
    throw new Error(`Feature notes not found at ${notesPath}`);
  }

  const prompt =
    `Leia ${notesPath} para contexto da feature e ${storiesPath} para as user stories e requisitos aprovados. ` +
    `Gere o documento PRD completo da feature com resumo executivo, integracao com codigo existente, ` +
    `user stories, requisitos funcionais, requisitos nao-funcionais, metricas de sucesso, escopo negativo, ` +
    `dependencias e riscos. Salve em ${prdPath}.`;

  let phase4Output = '';
  const result = await ctx.spawnAgent(FEAT_PRD_COMPLETO_ID, prompt, {
    projectId,
    phaseNumber: 4,
    cwd: projectPath,
    abortController: state.abortController,
    docsDir: docsCtxF4?.docsDir,
    onText: (chunk) => {
      phase4Output += chunk;
      emitPipelineStream({ projectId, phase: 4, type: 'text', content: chunk });
    },
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 4, type: 'tool_call', tool: toolName });
    },
  });

  if (phase4Output || (result.toolCalls && result.toolCalls.length > 0)) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 4 }, 'assistant', phase4Output, {
      toolCalls: result.toolCalls,
    });
  }

  ctx.collectMetrics(projectId, 4, FEAT_PRD_COMPLETO_ID, result, 'completed');

  ctx.updateProjectColumns(projectId, { prdPath });

  logger.info({ projectId, prdPath }, 'Phase 4 (feature) completed — PRD.md generated');

  if (fs.existsSync(prdPath)) {
    emitIPC('pipeline:document-updated', {
      projectId,
      path: prdPath,
      content: fs.readFileSync(prdPath, 'utf-8'),
    });
  }

  emitPipelineStream({ projectId, phase: 4, type: 'done' });
  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 4,
    phaseName: getPhaseName(4, project ?? undefined) ?? 'PRD Completo',
    status: 'completed',
    awaitingUser: false,
  });

  await ctx.advanceToNextPhase(projectId, state);
}
