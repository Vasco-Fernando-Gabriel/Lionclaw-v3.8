/**
 * Dev + Feature pipeline handlers (SPEC §3 / Sprint 8A.3).
 *
 * dev and feature are GÊMEOS: they share the SAME handlers, parameterized by
 * `isFeature`/agentId (e.g. handlePhase1Message picks DISCOVERY_AGENT_ID vs
 * FEAT_DISCOVERY_ID from project.pipelineType; handleTechPhaseMessage receives
 * the resolved agentId). Creating handlers/development.ts + handlers/feature.ts
 * separately would force DUPLICATION (against the current code) or artificial
 * unification (against R6). So this is ONE shared module (§3); the
 * isFeature/agentId branching stays EXACTLY as it was inline.
 *
 * Houses the 10 shared methods previously inline in index.ts:
 *   - runPhase2                (phase 2, auto — PRD Generator: stories-requisitos.md)
 *   - runPhase4                (phase 4, auto — PRD Generator: PRD.md)
 *   - runPhase9                (phase 9, auto LOOP — Spec Generation builder↔validator)
 *   - runPhase11               (phase 11/security-8 — Planner, delegates to HarnessEngine)
 *   - handlePhase1Message      (phase 1, conversation — Discovery; feature uses FEAT_DISCOVERY_ID)
 *   - handlePhase3Message      (phase 3, conversation — PRD Validator; feature uses FEAT_PRD_VALIDATOR_ID)
 *   - handleTechPhaseMessage   (phases 5-8, conversation — Tech; agentId passed by caller)
 *   - handlePhase10Message     (phase 10, conversation — Spec Enricher)
 *   - handlePhase12Message     (phase 12 / arch-9 / dev-v2-14, conversation — Sprint Validator)
 *   - handlePhase9Message      (phase 9, conversation — Spec Validator review, post auto-loop)
 *
 * They were moved VERBATIM (mechanical move, not a rewrite) and reparameterized
 * from `this.X` to an injected `ctx: PipelineEngineContext` — the same late-bound
 * `buildXEngine` pattern as reset.ts / message-router.ts / lifecycle.ts and the
 * 8A.1 / 8A.2 extractions. index.ts keeps a thin delegator method for each (so the
 * existing sendMessage / runAutoPhase dispatch via `this.handlePhaseX` /
 * `this.runPhaseX` is unchanged) and builds the ctx per call with bound delegates.
 *
 * INVARIANTS PRESERVED
 *  - INV-2 (R8): every agent run goes through `ctx.spawnAgent` — the single
 *    executeAgent entry point in index.ts. No executeAgent here, no second copy.
 *  - INV-13 (SQL only in db.ts): the handlers route through updateHarnessProject /
 *    savePipelinePhaseMetrics / persistMessage / ctx.updateProjectColumns exactly
 *    as they did inline; no new SQL.
 *  - INV-14 (loop delegates to HarnessEngine): runPhase11 drives ctx.harnessEngine
 *    (setStreamBridge / plan / clearStreamBridge), NOT spawnAgent.
 *  - INV-18 (R6 ADR): handlePhase12Message resolves phaseNumber/agentId by
 *    parameter EXACTLY as before — dev/feature default phase 12, arch-review passes
 *    9, dev-v2 passes 14 + briefing; SPRINT_VALIDATOR_ID unchanged.
 *  - INV-1 (IPC): all pipeline:* emits are on the same channels with the same
 *    payloads, unchanged.
 */

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
import {
  getPhaseName,
  getPhaseAgentId,
  getPhaseNumberForAgent,
  PHASE_NAMES,
  PHASE_AGENT_IDS,
} from '../registry';
import type { PipelineEngineContext, HandlerPhaseState } from './context';

const logger = createLogger('pipeline-engine');

/**
 * Garante que o discovery foi REALMENTE preenchido pela fase 1, nao apenas
 * semeado como template. Antes, o PRD (fases 2 e 4) so checava `fs.existsSync`:
 * um template vazio (`# Discovery Notes` com `<!-- ... -->` ou `(a definir
 * conforme a conversa...)`) passava e era alimentado ao PRD, que gerava
 * "feature nao definida no discovery". Aqui falhamos ALTO e de forma acionavel.
 */
function assertDiscoveryReady(discoveryNotesPath: string): void {
  if (!fs.existsSync(discoveryNotesPath)) {
    throw new Error(
      `Discovery nao encontrado em ${discoveryNotesPath}. A fase 1 (Discovery) ` +
        `precisa gerar o documento de discovery nesse caminho exato antes do PRD rodar.`,
    );
  }
  const content = fs.readFileSync(discoveryNotesPath, 'utf-8');
  // Conteudo "util" = sem comentarios-template <!-- ... --> e sem marcadores "(a definir ...)".
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

// =========================================================================
// Auto phases (dev/feature shared)
// =========================================================================

// -------------------------------------------------------------------------
// Phase 2: PRD Generator mode 1 — user stories and requirements
// -------------------------------------------------------------------------

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

  // Save complete assistant message (not per-chunk)
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

  // Auto-advance to phase 3 (conversation)
  await ctx.advanceToNextPhase(projectId, state);
}

// -------------------------------------------------------------------------
// Phase 4: PRD Generator mode 2 — full PRD document
// -------------------------------------------------------------------------

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
  const prdPath = docsCtx
    ? docsCtx.resolveDocPath('PRD.md')
    : path.join(projectPath, 'PRD.md');

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

  // Save complete assistant message (not per-chunk)
  if (phase4Output) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 4 }, 'assistant', phase4Output);
  }

  ctx.collectMetrics(projectId, 4, PRD_GENERATOR_ID, result, 'completed');

  // Persist PRD path in DB
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

  // Auto-advance to phase 5 (conversation)
  await ctx.advanceToNextPhase(projectId, state);
}

// -------------------------------------------------------------------------
// Phase 11: Planner — delegates to HarnessEngine.plan()
// -------------------------------------------------------------------------

export async function runPhase11(
  ctx: PipelineEngineContext,
  projectId: string,
  state: HandlerPhaseState,
  briefingPrefix?: string,
): Promise<void> {
  const startedAt = Date.now();

  // Fallback: patch empty agent IDs on existing projects created before the fix
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

  // Bridge: use HarnessEngine's stream bridge API to forward events as pipeline:stream.
  // Phase number resolved via PIPELINE_PHASES (security=8, dev/feature=11) — nao hardcodar.
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

  // Collect basic metrics for Planner phase (works for both dev phase 11 and security phase 8)
  const project = getHarnessProject(projectId);
  const plannerPhaseNumber = (project ? getPhaseNumberForAgent(project, 'harness-planner') : undefined) ?? 11;
  const plannerPhaseName = (project ? getPhaseName(plannerPhaseNumber, project) : PHASE_NAMES[11]) ?? `Phase ${plannerPhaseNumber}`;
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

  const plannerAgentId = (project ? getPhaseAgentId(plannerPhaseNumber, project) : PHASE_AGENT_IDS[11]) ?? 'harness-planner';
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
    // SPEC-005: propagate planner unknown-cost count from project record.
    unknownCostCount: project?.plannerUnknownCostCount ?? 0,
  });

  emitIPC('pipeline:metrics', {
    projectId,
    phaseNumber: plannerPhaseNumber,
    metrics: plannerMetrics,
  });

  logger.info({ projectId, plannerPhaseNumber }, 'Planner phase completed');

  // Emit sprints data so UI can populate the sprint list when entering the Sprint Validator phase
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

  // Auto-advance to next phase (Sprint Validator conversation)
  await ctx.advanceToNextPhase(projectId, state);
}

// -------------------------------------------------------------------------
// Phase 9: Spec Generation — auto loop spec-builder -> spec-validator
// -------------------------------------------------------------------------

export async function runPhase9(
  ctx: PipelineEngineContext,
  projectId: string,
): Promise<void> {
  const project = getHarnessProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const state = ctx.getState(projectId);
  const projectPath = project.projectPath;
  const docsCtxP9 = getPipelineDocsContext(projectPath, project.pipelineDocsId ?? null);
  const prdPath = ((project ? resolvePrdPath(project) : null) || (docsCtxP9
    ? docsCtxP9.resolveDocPath('PRD.md')
    : path.join(projectPath, 'PRD.md')));
  const storiesPath = docsCtxP9
    ? docsCtxP9.resolveDocPath('stories-requisitos.md')
    : path.join(projectPath, 'stories-requisitos.md');
  const specPath = (project.specPath || (docsCtxP9
    ? docsCtxP9.resolveDocPath('SPEC.md')
    : path.join(projectPath, 'SPEC.md')));
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

  // Aggregate metrics separately for builder and validator across rounds
  const builderAgg = ctx.createEmptyMetrics();
  const validatorAgg = ctx.createEmptyMetrics();
  const builderUsage: Pick<AccumulatedMetrics, 'sessionIds' | 'costSource' | 'pricingSnapshot' | 'modelUsage' | 'grok'> = {};
  const validatorUsage: Pick<AccumulatedMetrics, 'sessionIds' | 'costSource' | 'pricingSnapshot' | 'modelUsage' | 'grok'> = {};
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

      // --- Spec Builder ---
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
            projectId, phase: 9, type: 'text', content: chunk, metadata: { agent: 'spec-builder', round },
          });
        },
        onToolUse: (toolName) => {
          emitPipelineStream({ projectId, phase: 9, type: 'tool_call', tool: toolName });
        },
      });

      // Save complete builder message (not per-chunk)
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

      // --- Spec Validator ---
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
            projectId, phase: 9, type: 'text', content: chunk, metadata: { agent: 'spec-validator', round },
          });
        },
        onToolUse: (toolName) => {
          emitPipelineStream({ projectId, phase: 9, type: 'tool_call', tool: toolName });
        },
      });

      // Save complete validator message (not per-chunk)
      if (validatorOutput) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 9 }, 'assistant', validatorOutput);
      }

      ctx.mergeMetrics(validatorAgg, validatorResult.metrics);
      mergeUsageMetadata(validatorUsage, validatorResult.metadata);
      validatorModel = validatorResult.model;
      validatorRuntime = validatorResult.runtime;

      // Check validation result
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

  // Save 2 aggregated metric rows: builder + validator
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
    // Sprint 7 (SPEC §4.5 / LC-1): FAIL-site #2 (Spec Generation). Pure-paused +
    // error + phase-changed:failed; no stream done; sets state.status.
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

  // Persist specPath in DB now that the builder has written it.
  // Use updateHarnessProject directly because updateProjectColumns is scoped to
  // pipeline_* columns; specPath lives in the base harness_projects schema.
  updateHarnessProject(projectId, { specPath });

  emitPipelineStream({ projectId, phase: 9, type: 'done' });

  // After the auto loop, enter a conversational review state with the Spec Validator.
  // The user can discuss the SPEC.md with the validator and only DECIDIDO advances to phase 10.
  logger.info({ projectId, passed }, 'Phase 9 auto loop complete — entering spec review conversation');

  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 9,
    phaseName,
    status: 'awaiting-spec-review',
    awaitingUser: true,
    metadata: { passed },
  });

  // Auto-trigger the Spec Validator greeting so it presents its analysis
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

// =========================================================================
// Conversation phases (dev/feature shared)
// =========================================================================

// -------------------------------------------------------------------------
// Phase 1: Discovery (conversation; feature uses FEAT_DISCOVERY_ID)
// -------------------------------------------------------------------------

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
  const notesPath = (project.discoveryNotesPath || (docsCtxP1
    ? docsCtxP1.resolveDocPath('discovery.md')
    : path.join(project.projectPath, 'discovery-notes.md')));
  const isFirstTurn = !sessionEntry.alive;

  // On first turn, include the notes path context
  const prompt = isFirstTurn
    ? `Arquivo de notas do discovery: ${notesPath}\n\nMensagem do usuario: ${message}`
    : message;

  const previousNotesContent = fs.existsSync(notesPath)
    ? fs.readFileSync(notesPath, 'utf-8')
    : '';

  const phase1Acc = { text: '', completed: false };
  const phase1AgentId = project.pipelineType === 'feature' ? FEAT_DISCOVERY_ID : DISCOVERY_AGENT_ID;
  // External runtime is stateless HTTP: pass prior turns (OpenAI multi-turn format
  // with tool_calls and tool results) so the agent does not re-invoke tools it already
  // executed. Cloud SDK uses continueSession instead and ignores priorMessages.
  const phase1Prior = sessionEntry.alive
    ? getPipelinePhaseMessagesAsChatHistory(projectId, 1).map((m) => ({
        ...m,
        tool_calls: m.tool_calls?.map((tc) => ({
          id: tc.id,
          function: {
            name: tc.function.name,
            // OllamaChatMessage espera arguments como objeto; o DB persiste como string JSON.
            arguments: (() => {
              try { return JSON.parse(tc.function.arguments) as Record<string, unknown>; }
              catch { return {}; }
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
    // SC-1 (Pilar C): prompt de retomada para retry de sessao Codex ceifada.
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

  // Accumulate metrics
  ctx.accumulateMetrics(state, 1, result);

  // Check if notes were updated
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

  // Save complete assistant message (not per-chunk)
  const phase1CleanedText = phase1Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  const phase1ToolCalls = result.toolCalls;
  if (phase1CleanedText || (phase1ToolCalls && phase1ToolCalls.length > 0)) {
    persistMessage(
      { kind: 'pipeline', projectId, phaseNumber: 1 },
      'assistant',
      phase1CleanedText,
      { toolCalls: phase1ToolCalls },
    );
  }

  emitPipelineStream({ projectId, phase: 1, type: 'done' });
}

// -------------------------------------------------------------------------
// Phase 3: PRD Validator (persistent file memory, fresh query each turn)
// -------------------------------------------------------------------------

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

  const previousStoriesContent = fs.existsSync(storiesPath)
    ? fs.readFileSync(storiesPath, 'utf-8')
    : '';

  let prompt: string;
  if (isFirstTurn) {
    // First turn: full analysis with instruction to edit stories-requisitos.md directly
    const prdPath = (project ? resolvePrdPath(project) : null);
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
    // Follow-up turns: just the user message (agent already has full context from the session)
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
    // SC-1 (Pilar C): prompt de retomada para retry de sessao Codex ceifada.
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

  // Save complete assistant message (not per-chunk)
  const phase3CleanedText = phase3Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (phase3CleanedText) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 3 }, 'assistant', phase3CleanedText);
  }

  emitPipelineStream({ projectId, phase: 3, type: 'done' });
}

// -------------------------------------------------------------------------
// Phases 5-8: Tech conversation phases (Database, Backend, Frontend, Security)
// Each phase uses its own dedicated agent and session key.
// -------------------------------------------------------------------------

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
  const notesPath = (project.discoveryNotesPath || (docsCtxTech
    ? docsCtxTech.resolveDocPath('discovery.md')
    : path.join(projectPath, 'discovery-notes.md')));
  const prdPath = ((project ? resolvePrdPath(project) : null) || (docsCtxTech
    ? docsCtxTech.resolveDocPath('PRD.md')
    : path.join(projectPath, 'PRD.md')));
  const isFirstTurn = !sessionEntry.alive;

  const prompt = isFirstTurn
    ? `Discovery Notes: ${notesPath}\n` +
      `PRD: ${prdPath}\n\n` +
      `Leia os documentos acima para entender o contexto do projeto antes de iniciar a discussao. ` +
      `Conduza a discussao tecnica com o usuario, proponha abordagens e registre as decisoes aprovadas no PRD.md. ` +
      `IMPORTANTE: NAO altere o discovery-notes.md em hipotese alguma, ele e somente leitura para contexto.\n\n` +
      `Mensagem do usuario: ${message}`
    : message;

  const previousPrdContent = fs.existsSync(prdPath)
    ? fs.readFileSync(prdPath, 'utf-8')
    : '';

  const techAcc = { text: '', completed: false };
  const result = await ctx.spawnAgent(agentId, prompt, {
    projectId,
    phaseNumber,
    cwd: projectPath,
    abortController: state.abortController,
    continueSession: sessionEntry.alive,
    docsDir: docsCtxTech?.docsDir,
    // SC-1 (Pilar C): prompt de retomada para retry de sessao Codex ceifada.
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

  // Save complete assistant message (not per-chunk)
  const techCleanedText = techAcc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (techCleanedText) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber }, 'assistant', techCleanedText);
  }

  emitPipelineStream({ projectId, phase: phaseNumber, type: 'done' });
}

// -------------------------------------------------------------------------
// Phase 10: Spec Enricher (session persists across turns for context)
// -------------------------------------------------------------------------

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
  const specPath = (project.specPath || (docsCtxP10
    ? docsCtxP10.resolveDocPath('SPEC.md')
    : path.join(projectPath, 'SPEC.md')));
  const prdPath = ((project ? resolvePrdPath(project) : null) || (docsCtxP10
    ? docsCtxP10.resolveDocPath('PRD.md')
    : path.join(projectPath, 'PRD.md')));
  const storiesPath = docsCtxP10
    ? docsCtxP10.resolveDocPath('stories-requisitos.md')
    : path.join(projectPath, 'stories-requisitos.md');
  const suggestionsPath = docsCtxP10
    ? docsCtxP10.resolveDocPath('enrich-suggestions.md')
    : path.join(projectPath, '.spec-enricher-suggestions.md');

  const isFirstTurn = !sessionEntry.alive;

  const previousSpecContent = fs.existsSync(specPath)
    ? fs.readFileSync(specPath, 'utf-8')
    : '';

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
    // Follow-up turns: just the user message (agent has full context from session)
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
    // SC-1 (Pilar C): prompt de retomada para retry de sessao Codex ceifada.
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

  // Save complete assistant message (not per-chunk)
  const phase10CleanedText = phase10Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (phase10CleanedText) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 10 }, 'assistant', phase10CleanedText);
  }

  emitPipelineStream({ projectId, phase: 10, type: 'done' });
}

// -------------------------------------------------------------------------
// Phase 12: Sprint Validator (session persists across turns for context)
// -------------------------------------------------------------------------

export async function handlePhase12Message(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  phaseNumber: number = 12,
  briefing?: string | null,
): Promise<void> {
  // Sprint Validator handler. Used by both:
  //   - dev/feature pipelines on phase 12 (default)
  //   - architecture-review pipeline on phase 9 (passed by caller)
  //   - development-v2 pipeline on phase 14 (with optional briefing)
  // The phaseNumber parameter is propagated to spawnAgent / persistMessage /
  // emit IPC so the UI sees messages on the correct channel.
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
  const specPath = (project.specPath || (docsCtxP12
    ? docsCtxP12.resolveDocPath('SPEC.md')
    : path.join(projectPath, 'SPEC.md')));
  const sprintsPath = findHarnessSprintsReadPath(project) ?? resolveHarnessSprintsPath(project);
  const reportPath = docsCtxP12
    ? docsCtxP12.resolveDocPath('sprint-validation.md')
    : path.join(projectPath, '.sprint-validation-report.md');

  const isFirstTurn = !sessionEntry.alive;

  const previousSprintsContent = fs.existsSync(sprintsPath)
    ? fs.readFileSync(sprintsPath, 'utf-8')
    : '';

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
    // Follow-up turns: just the user message (agent has full context from session)
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
    // SC-1 (Pilar C): prompt de retomada para retry de sessao Codex ceifada.
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

  // Save complete assistant message (not per-chunk)
  const phase12CleanedText = phase12Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (phase12CleanedText) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber }, 'assistant', phase12CleanedText);
  }

  emitPipelineStream({ projectId, phase: phaseNumber, type: 'done' });
}

// -------------------------------------------------------------------------
// Phase 9: Spec Validator conversation (post auto-loop review)
// -------------------------------------------------------------------------

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
  const specPath = (project.specPath || (docsCtxP9Conv
    ? docsCtxP9Conv.resolveDocPath('SPEC.md')
    : path.join(projectPath, 'SPEC.md')));
  const prdPath = ((project ? resolvePrdPath(project) : null) || (docsCtxP9Conv
    ? docsCtxP9Conv.resolveDocPath('PRD.md')
    : path.join(projectPath, 'PRD.md')));
  const storiesPath = docsCtxP9Conv
    ? docsCtxP9Conv.resolveDocPath('stories-requisitos.md')
    : path.join(projectPath, 'stories-requisitos.md');
  const validationReportPath = docsCtxP9Conv
    ? docsCtxP9Conv.resolveDocPath('spec-validation.md')
    : path.join(projectPath, '.spec-validation-report.md');

  const isFirstTurn = !sessionEntry.alive;

  const previousSpecContent = fs.existsSync(specPath)
    ? fs.readFileSync(specPath, 'utf-8')
    : '';

  let prompt: string;
  if (isFirstTurn) {
    prompt =
      `## SPEC.md\nCaminho: ${specPath}\n\n` +
      `## PRD de referencia\nCaminho: ${prdPath}\n\n` +
      (fs.existsSync(storiesPath) ? `## User Stories de referencia\nCaminho: ${storiesPath}\n\n` : '') +
      (fs.existsSync(validationReportPath) ? `## Relatorio de validacao automatica\nCaminho: ${validationReportPath}\n\n` : '') +
      `## Instrucao importante\n` +
      `Voce e o Spec Validator. Leia os arquivos acima, apresente um resumo da SPEC.md, aponte pontos fortes e ressalvas do relatorio de validacao. ` +
      `Se o usuario pedir ajustes, edite ${specPath} diretamente usando Write ou Edit. ` +
      `Quando o usuario estiver satisfeito ele clicara em Aprovar para avancar.\n\n` +
      `## Mensagem do usuario\n${message}`;
  } else {
    // Follow-up turns: just the user message (agent has full context from session)
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
    // SC-1 (Pilar C): prompt de retomada para retry de sessao Codex ceifada.
    rebuildPromptOnRetry: () =>
      buildCodexResumePrompt({
        projectId,
        phaseNumber: 9,
        preamble:
          `## SPEC.md\nCaminho: ${specPath}\n\n` +
          `## PRD de referencia\nCaminho: ${prdPath}\n\n` +
          (fs.existsSync(validationReportPath) ? `## Relatorio de validacao automatica\nCaminho: ${validationReportPath}\n\n` : '') +
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

  // Save complete assistant message (not per-chunk)
  const phase9CleanedText = phase9Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (phase9CleanedText) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 9 }, 'assistant', phase9CleanedText);
  }

  emitPipelineStream({ projectId, phase: 9, type: 'done' });
}

// =========================================================================
// Feature-only auto phases (8A.5: moved verbatim, this.X -> ctx.X)
//
// dev uses runPhase2 / runPhase4 above; the feature pipeline has its OWN
// phase 2/4 runners using FEAT_PRD_GENERATOR_ID / FEAT_PRD_COMPLETO_ID and the
// feature discovery notes. They live in this shared module (§3) so the
// dev+feature pair stays in one place; not unified with the dev variants (R6).
// =========================================================================

// -------------------------------------------------------------------------
// Phase 2 (FEATURE pipeline only): User stories from existing repo + notes.
// Agent analyses the existing repo + the feature-discovery notes and writes
// stories-requisitos.md.
// -------------------------------------------------------------------------

export async function runPhase2Feature(
  ctx: PipelineEngineContext,
  projectId: string,
  projectPath: string,
  state: HandlerPhaseState,
): Promise<void> {
  const project = getHarnessProject(projectId);
  const docsCtxF2 = getPipelineDocsContext(projectPath, project?.pipelineDocsId ?? null);
  const notesPath = (project?.discoveryNotesPath || (docsCtxF2
    ? docsCtxF2.resolveDocPath('discovery.md')
    : path.join(projectPath, 'discovery-notes.md')));
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
    persistMessage(
      { kind: 'pipeline', projectId, phaseNumber: 2 },
      'assistant',
      phase2Output,
      { toolCalls: result.toolCalls },
    );
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

// -------------------------------------------------------------------------
// Phase 4 (FEATURE pipeline only): PRD Completo via FEAT_PRD_COMPLETO_ID.
//
// Mirrors runPhase4 but uses the feature-specific agent and the feature
// discovery notes file (feature-discovery-notes-{timestamp}.md) detected
// and persisted by the feature pipeline at the end of phase 1.
// -------------------------------------------------------------------------

export async function runPhase4Feature(
  ctx: PipelineEngineContext,
  projectId: string,
  projectPath: string,
  state: HandlerPhaseState,
): Promise<void> {
  const project = getHarnessProject(projectId);
  const docsCtxF4 = getPipelineDocsContext(projectPath, project?.pipelineDocsId ?? null);
  const notesPath = (project?.discoveryNotesPath || (docsCtxF4
    ? docsCtxF4.resolveDocPath('discovery.md')
    : path.join(projectPath, 'discovery-notes.md')));
  const storiesPath = docsCtxF4
    ? docsCtxF4.resolveDocPath('stories-requisitos.md')
    : path.join(projectPath, 'stories-requisitos.md');
  const prdPath = docsCtxF4
    ? docsCtxF4.resolveDocPath('PRD.md')
    : path.join(projectPath, 'PRD.md');

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
    persistMessage(
      { kind: 'pipeline', projectId, phaseNumber: 4 },
      'assistant',
      phase4Output,
      { toolCalls: result.toolCalls },
    );
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
