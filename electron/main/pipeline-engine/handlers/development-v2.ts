/**
 * Development-v2 pipeline handlers (SPEC §3 / Sprint 8A.4).
 *
 * Houses the per-phase runners + conversational handlers that were inline in
 * `PipelineEngine` (index.ts) for the `development-v2` pipelineType. Moved
 * VERBATIM (mechanical move, not a rewrite) and reparameterized from `this.X` to
 * an injected `ctx: PipelineEngineContext` — the same late-bound `buildXEngine`
 * pattern as reset.ts / message-router.ts / lifecycle.ts and the 8A.1-8A.3
 * extractions. index.ts keeps a thin delegator method for each (so the existing
 * runAutoPhase / sendMessage / approvePhase dispatch via `this.runDevV2*` /
 * `this.handleDevV2*` is unchanged) and builds the ctx per call with bound
 * delegates.
 *
 * Methods housed here (bodies):
 *   - runPhase2WithBriefing          (phase 2, auto — User Stories with optional briefing)
 *   - runDevV2Phase4DesignPlan       (phase 4, auto — Design Plan -> open-design-prompt.md)
 *   - runDevV2Phase6DesignLock       (phase 6, auto — Design Lock gate + auto-correct loop)
 *   - runDevV2Phase7PrdCompleto      (phase 7, auto — PRD Completo, pipe2-prd-completo)
 *   - runDevV2Phase12SpecGeneration  (phase 12, auto loop — builder<->validator + spec-review entry)
 *   - runDevV2Phase14Planner         (phase 14, auto — Planner with design-contract IDs briefing)
 *   - handleDevV2Phase12SpecReview   (phase 12, conversation — pipe2-spec-validator review)
 *   - handlePhase1MessageDevV2       (phase 1, conversation — Discovery)
 *   - handlePhase3MessageDevV2       (phase 3, conversation — PRD Validator)
 *   - handleDevV2Phase13SpecEnricher (phase 13, conversation — pipe2-spec-enricher)
 *   - finalizeDevV2ConversationPhase (approval tail — flush metrics + advance/gate)
 *
 * `runDevV2AutoPhase` (pure if/else dispatch to the runners above) STAYS in
 * index.ts so every per-phase call remains late-bound through `this.runDevV2*`
 * (the dev-v2-phase12-gate + lifecycle characterization spy
 * `engine.runDevV2Phase6DesignLock` / `engine.runDevV2Phase12SpecGeneration`
 * directly on the instance).
 *
 * INVARIANTS PRESERVED
 *  - INV-2 (R8): every agent run goes through `ctx.spawnAgent` — the single
 *    executeAgent entry point in index.ts. No executeAgent here, no second copy.
 *  - INV-13 (SQL only in db.ts): the handlers route through updateHarnessProject /
 *    savePipelinePhaseMetrics / persistMessage / ctx.updateProjectColumns /
 *    ctx.flushAccumulatedMetrics exactly as they did inline; no new SQL.
 *  - INV-14 (loop delegates to HarnessEngine): runDevV2Phase14Planner delegates to
 *    ctx.runPhase11WithBriefing (the shared Planner runner), NOT spawnAgent.
 *  - INV-16 (spies): handleDevV2Phase12SpecReview / flushAccumulatedMetrics /
 *    advanceToNextPhase are reached via ctx (late-bound) so instance spies fire.
 *  - INV-1 (IPC): all pipeline:* emits are on the same channels with the same
 *    payloads, unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../logger';
import { emitIPC } from '../../pipeline-shared/ipc-emitter';
import { emitPipelineStream } from '../stream';
import { persistMessage } from '../../pipeline-shared/persist';
import { buildCodexResumePrompt } from '../codex-sessions';
import { rethrowPipelinePause } from '../provider-auth';
import {
  getHarnessProject,
  savePipelinePhaseMetrics,
  updateHarnessProject,
} from '../../db';
import { getPipelineDocsContext } from '../../pipeline-paths';
import {
  DISCOVERY_AGENT_ID,
  PRD_GENERATOR_ID,
  PRD_VALIDATOR_ID,
  PIPE2_PRD_COMPLETO_ID,
  PIPE2_SPEC_BUILDER_ID,
  PIPE2_SPEC_VALIDATOR_ID,
  PIPE2_SPEC_ENRICHER_ID,
} from '../../seed-agents/index';
import { getPhaseName, getPhaseAgentId, getPhaseNumberForAgent } from '../registry';
import { getDevV2Briefing, type DevV2BriefingCtx } from '../dev-v2-briefings';
import { buildDevV2StoryCoverageMap } from '../dev-v2-story-coverage';
import type { PipelineEngineContext, HandlerPhaseState, ResolvedHarnessProject } from './context';

const logger = createLogger('pipeline-engine');

/**
 * Runs Phase 2 of development-v2 (User Stories/PRD) with an optional briefing.
 * Reuses the standard prd-generator agent.
 */
export async function runPhase2WithBriefing(
  ctx: PipelineEngineContext,
  projectId: string,
  projectPath: string,
  state: HandlerPhaseState,
  briefing: string | null,
): Promise<void> {
  const project = getHarnessProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const docsCtx = getPipelineDocsContext(projectPath, project.pipelineDocsId ?? null);
  const notesPath = project.discoveryNotesPath
    || (docsCtx ? docsCtx.resolveDocPath('discovery.md') : path.join(projectPath, 'discovery-notes.md'));
  const storiesPath = docsCtx
    ? docsCtx.resolveDocPath('stories-requisitos.md')
    : path.join(projectPath, 'stories-requisitos.md');

  let prompt = `Arquivo de discovery: ${notesPath}\n` +
    `Gere o arquivo de user stories e requisitos em: ${storiesPath}\n\n` +
    `Leia o discovery, gere as user stories, requisitos funcionais e nao-funcionais. ` +
    `Salve o resultado em ${storiesPath}.`;

  if (briefing) {
    prompt = `${briefing}\n\n${prompt}`;
  }

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

  ctx.accumulateMetrics(state, 2, result);
  const output = phase2Output || result.output;
  if (output) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 2 }, 'assistant', output);
  }
  if (fs.existsSync(storiesPath)) {
    emitIPC('pipeline:document-updated', {
      projectId,
      path: storiesPath,
      content: fs.readFileSync(storiesPath, 'utf-8'),
    });
  }

  emitPipelineStream({ projectId, phase: 2, type: 'done' });
  await ctx.advanceToNextPhase(projectId, state);
}

/**
 * Phase 4 of development-v2: explicit Design Plan.
 *
 * Produces the official `open-design-prompt.md` consumed by phase 5. This is
 * intentionally not hidden inside the Open Design bootstrap.
 */
export async function runDevV2Phase4DesignPlan(
  ctx: PipelineEngineContext,
  projectId: string,
  project: ResolvedHarnessProject,
  state: HandlerPhaseState,
): Promise<void> {
  const docsCtx = getPipelineDocsContext(project.projectPath, project.pipelineDocsId ?? null);
  const discoveryPath = project.discoveryNotesPath
    || (docsCtx ? docsCtx.resolveDocPath('discovery.md') : path.join(project.projectPath, 'discovery-notes.md'));
  const storiesPath = docsCtx
    ? docsCtx.resolveDocPath('stories-requisitos.md')
    : path.join(project.projectPath, 'stories-requisitos.md');
  const prdValidatorPath = docsCtx?.resolveDocPath('prd-validator.md') ?? null;

  const safeRead = (filePath: string | null): string | null => {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  };

  const discovery = safeRead(discoveryPath);
  const stories = safeRead(storiesPath);
  const prdValidatorNotes = safeRead(prdValidatorPath);
  const storyCoverageMap = buildDevV2StoryCoverageMap(stories);

  emitPipelineStream({
    projectId,
    phase: 4,
    type: 'text',
    content: '[Design Plan] Gerando blueprint de telas e prompt oficial do Open Design...\n',
  });

  const { ensureDesignPlan } = await import('../../open-design/design-plan');
  const {
    buildInitialPrompt,
    persistOpenDesignPromptMessage,
    persistOpenDesignPromptOutput,
  } = await import('../../open-design/bootstrap');
  const { getSessionConfig } = await import('../../open-design/session-config');

  const planResult = await ensureDesignPlan({
    projectId,
    projectName: project.name,
    projectPath: project.projectPath,
    pipelineDocsId: project.pipelineDocsId ?? null,
    discovery,
    stories,
    prdValidatorNotes,
    storyCoverageMap,
    onText: (chunk) => {
      emitPipelineStream({ projectId, phase: 4, type: 'text', content: chunk });
    },
    onProgress: (event) => {
      const label = event.stage === 'planner' ? 'planner' : 'validator';
      emitPipelineStream({
        projectId,
        phase: 4,
        type: 'text',
        content: `[Design Plan] ${label}: ${event.status}${event.detail ? ` — ${event.detail}` : ''}\n`,
      });
    },
  });

  if (!planResult.ok) {
    throw new Error(`Design Plan rejeitado: ${planResult.validation.errors.join('; ')}`);
  }

  const sessionConfig = getSessionConfig(projectId) ?? null;
  const promptText = await buildInitialPrompt(projectId, sessionConfig, planResult.promptBlock);
  const promptPath = persistOpenDesignPromptOutput(projectId, project, promptText);
  persistOpenDesignPromptMessage(projectId, promptText, promptPath);

  emitPipelineStream({
    projectId,
    phase: 4,
    type: 'text',
    content: `[Design Plan] Prompt oficial do Open Design salvo em ${promptPath}\n`,
  });
  emitIPC('pipeline:document-updated', {
    projectId,
    path: promptPath,
    content: promptText,
  });

  savePipelinePhaseMetrics({
    projectId,
    phaseNumber: 4,
    phaseName: 'Design Plan',
    status: 'completed',
    completedAt: new Date().toISOString(),
  });

  emitPipelineStream({ projectId, phase: 4, type: 'done' });
  await ctx.advanceToNextPhase(projectId, state);
}

/**
 * Phase 6 of development-v2: Design Lock gate (Sprint 5).
 */
export async function runDevV2Phase6DesignLock(
  ctx: PipelineEngineContext,
  projectId: string,
  state: HandlerPhaseState,
): Promise<void> {
  // import lazily to avoid potential circular dependency in tests
  const { lock } = await import('../../open-design/lock');
  const { requestAgentCorrection, waitForAgentCorrection } = await import(
    '../../open-design/auto-correct'
  );

  // Quantas tentativas de auto-correcao antes de mostrar o banner ambar
  // ao usuario. 3 cobre os erros mais comuns sem segurar a UI indefinidamente
  // (cada tentativa eh ~30-90s do agente regenerando + lock revalidando).
  const MAX_ATTEMPTS = 3;

  let lastResult: Awaited<ReturnType<typeof lock>> | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    emitPipelineStream({
      projectId,
      phase: 6,
      type: 'text',
      content:
        attempt === 1
          ? '[Design Lock] Iniciando gate de validacao...'
          : `[Design Lock] Tentativa ${attempt}/${MAX_ATTEMPTS} apos auto-correcao do agente...`,
    });

    const result = await lock(projectId);
    lastResult = result;

    // Hard error (ex: snapshot falhou, runDir ausente) — nao tenta corrigir
    // via agente; sai pro caminho de falha permanente.
    if ('error' in result) {
      logger.error(
        { projectId, error: result.error, attempt },
        'runDevV2Phase6DesignLock: lock() returned hard error — aborting auto-correct loop',
      );
      savePipelinePhaseMetrics({
        projectId,
        phaseNumber: 6,
        phaseName: 'Design Lock',
        status: 'failed',
        completedAt: new Date().toISOString(),
      });
      // Sprint 7 (SPEC §4.5 / LC-1 / D3 / INV-5): FAIL-site #4 (dev-v2 Design
      // Lock hard error). The ONLY fail-site with a COMPOSITE statusUpdate
      // (updateProjectColumns({status:'paused', pipelineCurrentPhase:6}) — D3),
      // the ONLY one that emits stream {done}, the ONLY one that omits
      // pipeline:error, and the ONLY one that does NOT set state.status.
      ctx.failPhase(projectId, state, {
        phase: 6,
        phaseName: 'Design Lock',
        statusUpdate: { columns: { status: 'paused', pipelineCurrentPhase: 6 } },
        emitError: false,
        emitPhaseChanged: true,
        emitStreamDone: true,
        setStateStatusPaused: false,
      });
      return;
    }

    // Aprovado — sai do loop e segue pro caminho de sucesso abaixo.
    if (result.ok) break;

    // Rejeitado pelo validator. Tenta auto-correcao via agente OD.
    const reportProblems = result.report.problems;
    logger.info(
      { projectId, attempt, problemCount: reportProblems.length },
      'runDevV2Phase6DesignLock: lock rejected — requesting agent correction',
    );
    emitPipelineStream({
      projectId,
      phase: 6,
      type: 'text',
      content: `[Design Lock] Rejeitado (${reportProblems.length} pendencia${reportProblems.length === 1 ? '' : 's'}). Pedindo correcao automatica ao agente do Open Design...`,
    });

    // Ultima tentativa: nao despacha mais correcao — deixa o erro escalar
    // pro banner ambar (que vem do emit do proprio lock.ts).
    if (attempt === MAX_ATTEMPTS) {
      logger.warn(
        { projectId, attempt },
        'runDevV2Phase6DesignLock: max attempts reached — surrendering to user',
      );
      emitPipelineStream({ projectId, phase: 6, type: 'done' });
      state.currentPhase = 5;
      state.status = 'running';
      return;
    }

    try {
      const { runId } = await requestAgentCorrection(projectId, result.report, attempt);
      const completedOk = await waitForAgentCorrection(projectId, runId, { timeoutMs: 180_000 });
      if (!completedOk) {
        logger.warn(
          { projectId, attempt, runId },
          'runDevV2Phase6DesignLock: agent correction did not complete cleanly — tentando lock mesmo assim',
        );
      }
    } catch (err) {
      rethrowPipelinePause(err);
      logger.error(
        { projectId, attempt, err },
        'runDevV2Phase6DesignLock: requestAgentCorrection failed — escalando para banner ambar',
      );
      emitPipelineStream({ projectId, phase: 6, type: 'done' });
      state.currentPhase = 5;
      state.status = 'running';
      return;
    }
    // Volta pro topo do loop e tenta novo `lock(projectId)`.
  }

  // Sucesso: precisa ser LockResult (ok: true).
  if (!lastResult || !('ok' in lastResult) || lastResult.ok !== true) {
    // Defensive — chegamos aqui sem aprovacao mas tambem sem erro. Trata como rejection final.
    state.currentPhase = 5;
    state.status = 'running';
    return;
  }

  // Lock approved — record metrics and advance to phase 7
  logger.info({ projectId }, 'runDevV2Phase6DesignLock: lock approved, advancing to phase 7');

  savePipelinePhaseMetrics({
    projectId,
    phaseNumber: 6,
    phaseName: 'Design Lock',
    status: 'completed',
    completedAt: new Date().toISOString(),
  });

  emitPipelineStream({ projectId, phase: 6, type: 'done' });
  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 6,
    phaseName: 'Design Lock',
    status: 'completed',
    awaitingUser: false,
  });

  await ctx.advanceToNextPhase(projectId, state);
}

/**
 * Phase 7 of development-v2: PRD Completo using pipe2-prd-completo agent.
 */
export async function runDevV2Phase7PrdCompleto(
  ctx: PipelineEngineContext,
  projectId: string,
  project: ResolvedHarnessProject,
  state: HandlerPhaseState,
): Promise<void> {
  const docsCtx = getPipelineDocsContext(project.projectPath, project.pipelineDocsId ?? null);
  const storiesPath = docsCtx
    ? docsCtx.resolveDocPath('stories-requisitos.md')
    : path.join(project.projectPath, 'stories-requisitos.md');
  const prdPath = docsCtx
    ? docsCtx.resolveDocPath('PRD.md')
    : path.join(project.projectPath, 'PRD.md');

  const basePrompt =
    `Stories/Requisitos: ${storiesPath}\n` +
    `Gere o PRD Completo em: ${prdPath}\n\n` +
    `Leia as user stories e requisitos aprovados e gere o PRD.md com resumo executivo, ` +
    `personas, user stories, requisitos, metricas de sucesso, escopo negativo e riscos. ` +
    `Considere o design lock aprovado nas fases anteriores.`;
  const lockBlock = ctx.buildDesignLockPathsBlock(project);
  const prompt = lockBlock ? `${lockBlock}\n\n${basePrompt}` : basePrompt;

  let phase7Output = '';
  const result = await ctx.spawnAgent(PIPE2_PRD_COMPLETO_ID, prompt, {
    projectId,
    phaseNumber: 7,
    cwd: project.projectPath,
    abortController: state.abortController,
    docsDir: docsCtx?.docsDir,
    onText: (chunk) => {
      phase7Output += chunk;
      emitPipelineStream({ projectId, phase: 7, type: 'text', content: chunk });
    },
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 7, type: 'tool_call', tool: toolName });
    },
  });

  ctx.accumulateMetrics(state, 7, result);
  const output = phase7Output || result.output;
  if (output) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 7 }, 'assistant', output);
  }
  if (prdPath) {
    ctx.updateProjectColumns(projectId, { prdPath });
  }
  if (fs.existsSync(prdPath)) {
    emitIPC('pipeline:document-updated', {
      projectId,
      path: prdPath,
      content: fs.readFileSync(prdPath, 'utf-8'),
    });
  }

  emitPipelineStream({ projectId, phase: 7, type: 'done' });
  await ctx.advanceToNextPhase(projectId, state);
}

/**
 * Phase 12 of development-v2: SPEC Generation.
 *
 * Espelha runPhase9 (dev/feature): loop builder -> validator (max 3 rounds)
 * e, ao terminar, entra em revisao conversacional (status awaiting-spec-review)
 * na MESMA fase 12, com o pipe2-spec-validator. Sem renumeracao e sem fase nova.
 *
 * INVARIANTE (R6 ADR / SPEC-007 2.1.1): usa PIPE2_SPEC_VALIDATOR_ID (validator
 * DEDICADO do dev-v2 que valida a SPEC contra o contrato de design/frontend) —
 * NUNCA o SPEC_VALIDATOR_ID compartilhado.
 */
export async function runDevV2Phase12SpecGeneration(
  ctx: PipelineEngineContext,
  projectId: string,
  project: ResolvedHarnessProject,
  state: HandlerPhaseState,
): Promise<void> {
  const docsCtx = getPipelineDocsContext(project.projectPath, project.pipelineDocsId ?? null);
  const prdPath = docsCtx
    ? docsCtx.resolveDocPath('PRD.md')
    : path.join(project.projectPath, 'PRD.md');
  const storiesPath = docsCtx
    ? docsCtx.resolveDocPath('stories-requisitos.md')
    : path.join(project.projectPath, 'stories-requisitos.md');
  const specPath = project.specPath
    || (docsCtx ? docsCtx.resolveDocPath('SPEC.md') : path.join(project.projectPath, 'SPEC.md'));
  const validationReportPath = docsCtx
    ? docsCtx.resolveDocPath('spec-validation.md')
    : path.join(project.projectPath, '.spec-validation-report.md');

  const phaseName = getPhaseName(12, project) ?? 'Spec Generation';

  // Bloco de paths do design lock — prefixa builder E validator (SPEC-007 5.3,
  // Correcao #1). Computado UMA vez. Sem ele, o validator do loop nao valida a
  // SPEC contra o contrato de design (criterio de aceite #3).
  const lockBlock = ctx.buildDesignLockPathsBlock(project);
  const withLock = (p: string): string => (lockBlock ? `${lockBlock}\n\n${p}` : p);

  logger.info({ projectId, prdPath, storiesPath, specPath }, '[dev-v2] Phase 12: Spec Generation starting');

  savePipelinePhaseMetrics({
    projectId,
    phaseNumber: 12,
    phaseName,
    agentId: PIPE2_SPEC_BUILDER_ID,
    status: 'running',
    startedAt: new Date().toISOString(),
  });

  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 12,
    phaseName,
    status: 'running',
    awaitingUser: false,
  });

  const MAX_ROUNDS = 3;
  let passed = false;
  let lastError: string | undefined;

  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (state.abortController.signal.aborted) break;

      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: 12,
        phaseName,
        status: 'spec-builder-running',
        awaitingUser: false,
        metadata: { round, maxRounds: MAX_ROUNDS },
      });

      // --- Spec Builder ---
      let builderPrompt: string;
      if (round === 1) {
        builderPrompt =
          `Gere a SPEC.md completa a partir do PRD.md, stories-requisitos.md e do design lock.\n\n` +
          `PRD: ${prdPath}\n` +
          `User Stories: ${storiesPath}\n` +
          `Salve em: ${specPath}\n\n` +
          `Inclua rotas, telas, componentes, tokens de design e o path do artifact HTML do ` +
          `design lock. A SPEC deve ser implementavel pelo Coder.`;
      } else {
        const validationContent = fs.existsSync(validationReportPath)
          ? fs.readFileSync(validationReportPath, 'utf-8')
          : '';
        builderPrompt =
          `Corrija a SPEC.md com base no relatorio de validacao abaixo. Corrija apenas os ` +
          `itens [MISS] e [CONFLICT] reportados.\n\n` +
          `Salve o resultado corrigido em: ${specPath}\n\n` +
          `SPEC atual: ${specPath}\n` +
          `PRD: ${prdPath}\n` +
          `User Stories: ${storiesPath}\n` +
          `Relatorio de validacao:\n${validationContent}`;
      }

      let builderOutput = '';
      const builderResult = await ctx.spawnAgent(PIPE2_SPEC_BUILDER_ID, withLock(builderPrompt), {
        projectId,
        phaseNumber: 12,
        cwd: project.projectPath,
        abortController: state.abortController,
        docsDir: docsCtx?.docsDir,
        onText: (chunk) => {
          builderOutput += chunk;
          emitPipelineStream({
            projectId, phase: 12, type: 'text', content: chunk, metadata: { agent: 'pipe2-spec-builder', round },
          });
        },
        onToolUse: (toolName) => {
          emitPipelineStream({ projectId, phase: 12, type: 'tool_call', tool: toolName });
        },
      });

      if (builderOutput) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 12 }, 'assistant', builderOutput);
      }

      ctx.accumulateMetrics(state, 12, builderResult);

      if (fs.existsSync(specPath)) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: specPath,
          content: fs.readFileSync(specPath, 'utf-8'),
        });
      }

      if (state.abortController.signal.aborted) break;

      // --- Spec Validator (DEDICADO: PIPE2_SPEC_VALIDATOR_ID) ---
      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: 12,
        phaseName,
        status: 'spec-validator-running',
        awaitingUser: false,
        metadata: { round, maxRounds: MAX_ROUNDS },
      });

      const validatorPrompt =
        `Valide a SPEC.md contra o PRD.md, stories-requisitos.md e o contrato de design ` +
        `(design lock) acima.\n\n` +
        `SPEC: ${specPath}\n` +
        `PRD: ${prdPath}\n` +
        `User Stories: ${storiesPath}\n\n` +
        `Salve o relatorio de validacao em: ${validationReportPath}`;

      let validatorOutput = '';
      const validatorResult = await ctx.spawnAgent(PIPE2_SPEC_VALIDATOR_ID, withLock(validatorPrompt), {
        projectId,
        phaseNumber: 12,
        cwd: project.projectPath,
        abortController: state.abortController,
        docsDir: docsCtx?.docsDir,
        onText: (chunk) => {
          validatorOutput += chunk;
          emitPipelineStream({
            projectId, phase: 12, type: 'text', content: chunk, metadata: { agent: 'pipe2-spec-validator', round },
          });
        },
        onToolUse: (toolName) => {
          emitPipelineStream({ projectId, phase: 12, type: 'tool_call', tool: toolName });
        },
      });

      if (validatorOutput) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 12 }, 'assistant', validatorOutput);
      }

      ctx.accumulateMetrics(state, 121, validatorResult);

      // Check validation result
      const validationReport = fs.existsSync(validationReportPath)
        ? fs.readFileSync(validationReportPath, 'utf-8')
        : '';

      if (validationReport.includes('## Status: PASS')) {
        passed = true;
        logger.info({ projectId, round }, '[dev-v2] Phase 12: Spec validation PASSED');
        break;
      }

      logger.info({ projectId, round }, '[dev-v2] Phase 12: Spec validation FAILED — continuing');
    }
  } catch (err) {
    rethrowPipelinePause(err);
    if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
      logger.info({ projectId }, '[dev-v2] Phase 12 aborted');
      return;
    }
    lastError = (err as Error).message;
    logger.error({ err, projectId }, '[dev-v2] Phase 12 error');
  }

  if (lastError) {
    logger.error({ projectId, error: lastError }, '[dev-v2] Phase 12 failed — pausing pipeline');
    ctx.flushAccumulatedMetrics(projectId, 12, PIPE2_SPEC_BUILDER_ID, state, 'failed', project);
    ctx.flushAccumulatedMetrics(projectId, 121, PIPE2_SPEC_VALIDATOR_ID, state, 'failed', project);
    // Sprint 7 (SPEC §4.5 / LC-1): FAIL-site #5 (dev-v2 Phase 12). Pure-paused +
    // error + phase-changed:failed; no stream done; sets state.status.
    ctx.failPhase(projectId, state, {
      phase: 12,
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
  updateHarnessProject(projectId, { specPath });

  emitPipelineStream({ projectId, phase: 12, type: 'done' });

  // After the auto loop, enter conversational review (MESMA fase 12) with the
  // dedicated validator. Metrics for builder (12) and validator (121) stay in
  // the accumulator and are flushed on approval by finalizeDevV2ConversationPhase.
  logger.info({ projectId, passed }, '[dev-v2] Phase 12 auto loop complete — entering spec review conversation');

  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 12,
    phaseName,
    status: 'awaiting-spec-review',
    awaitingUser: true,
    metadata: { passed },
  });

  // Auto-trigger the validator greeting so it presents its analysis.
  const greetingProject = getHarnessProject(projectId);
  const greetingMsg =
    `Projeto "${greetingProject?.name ?? projectId}". ` +
    `O loop de geracao automatica foi concluido${passed ? ' e a SPEC passou na validacao automatica' : ' (com alertas de validacao)'}. ` +
    `Apresente um resumo da SPEC.md gerada, destaque pontos fortes e eventuais ressalvas do ` +
    `relatorio de validacao (especialmente [MISS] e [CONFLICT]), aponte riscos de implementar ` +
    `sem ajuste e pergunte ao usuario se deseja ajustes antes de avancar para o enriquecimento.`;

  try {
    await ctx.sendMessage(projectId, greetingMsg, { isGreeting: true, rethrowPause: true });
  } catch (greetErr) {
    rethrowPipelinePause(greetErr);
    logger.error({ err: greetErr, projectId }, '[dev-v2] Phase 12: failed to start spec review conversation');
    // Non-fatal: the conversational state is already emitted; user can still type.
  }
}

/**
 * Phase 12 of development-v2 (conversational review): continues the
 * pipe2-spec-validator session opened after the auto loop. Espelha
 * handlePhase9Message adaptado para o validator DEDICADO do dev-v2.
 */
export async function handleDevV2Phase12SpecReview(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
): Promise<void> {
  const project = getHarnessProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const sessionKey = 'phase12-validator';
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  const docsCtx = getPipelineDocsContext(project.projectPath, project.pipelineDocsId ?? null);
  const specPath = project.specPath
    || (docsCtx ? docsCtx.resolveDocPath('SPEC.md') : path.join(project.projectPath, 'SPEC.md'));
  const prdPath = docsCtx
    ? docsCtx.resolveDocPath('PRD.md')
    : path.join(project.projectPath, 'PRD.md');
  const storiesPath = docsCtx
    ? docsCtx.resolveDocPath('stories-requisitos.md')
    : path.join(project.projectPath, 'stories-requisitos.md');
  const validationReportPath = docsCtx
    ? docsCtx.resolveDocPath('spec-validation.md')
    : path.join(project.projectPath, '.spec-validation-report.md');

  const isFirstTurn = !sessionEntry.alive;

  const previousSpecContent = fs.existsSync(specPath)
    ? fs.readFileSync(specPath, 'utf-8')
    : '';

  let prompt: string;
  if (isFirstTurn) {
    const lockBlock = ctx.buildDesignLockPathsBlock(project);
    prompt =
      (lockBlock ? `${lockBlock}\n\n` : '') +
      `## SPEC.md\nCaminho: ${specPath}\n\n` +
      `## PRD de referencia\nCaminho: ${prdPath}\n\n` +
      (fs.existsSync(storiesPath) ? `## User Stories de referencia\nCaminho: ${storiesPath}\n\n` : '') +
      (fs.existsSync(validationReportPath) ? `## Relatorio de validacao automatica\nCaminho: ${validationReportPath}\n\n` : '') +
      `## Instrucao importante\n` +
      `Voce e o Spec Validator. Leia os arquivos acima (incluindo o contrato de design), ` +
      `apresente um resumo da SPEC.md e aponte pontos fortes e ressalvas do relatorio de validacao. ` +
      `Se o usuario pedir ajustes, edite ${specPath} diretamente usando Edit. ` +
      `Quando o usuario estiver satisfeito ele clicara em Aprovar para avancar.\n\n` +
      `## Mensagem do usuario\n${message}`;
  } else {
    // Follow-up turns: just the user message (agent has full context from session)
    prompt = message;
  }

  const acc = { text: '', completed: false };
  const result = await ctx.spawnAgent(PIPE2_SPEC_VALIDATOR_ID, prompt, {
    projectId,
    phaseNumber: 12,
    cwd: project.projectPath,
    abortController: state.abortController,
    continueSession: sessionEntry.alive,
    docsDir: docsCtx?.docsDir,
    // SC-1 (Pilar C): prompt de retomada para retry de sessao Codex ceifada.
    rebuildPromptOnRetry: () => {
      const lockBlock = ctx.buildDesignLockPathsBlock(project);
      return buildCodexResumePrompt({
        projectId,
        phaseNumber: 12,
        preamble:
          (lockBlock ? `${lockBlock}\n\n` : '') +
          `## SPEC.md\nCaminho: ${specPath}\n\n` +
          `## PRD de referencia\nCaminho: ${prdPath}\n\n` +
          (fs.existsSync(validationReportPath) ? `## Relatorio de validacao automatica\nCaminho: ${validationReportPath}\n\n` : '') +
          `## Instrucao importante\n` +
          `Voce e o Spec Validator. Se o usuario pedir ajustes, edite ${specPath} diretamente usando Edit. ` +
          `Quando o usuario estiver satisfeito ele clicara em Aprovar para avancar.`,
        userMessage: message,
      });
    },
    onText: ctx.makeConversationOnText(projectId, 12, acc),
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 12, type: 'tool_call', tool: toolName });
    },
  });

  sessionEntry.alive = true;
  ctx.accumulateMetrics(state, 121, result);

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

  const cleaned = acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (cleaned) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 12 }, 'assistant', cleaned);
  }

  emitPipelineStream({ projectId, phase: 12, type: 'done' });
}

/**
 * Phase 14 of development-v2: Planner with DevelopmentV2SprintMetadata briefing.
 *
 * Reads the locked design-contract.json (if available) to extract screenIds and
 * componentIds, builds the dev-v2 planner briefing, then delegates to runPhase11
 * (which calls harnessEngine.plan with the briefing).
 *
 * Per Sprint 6 task 6.4 and SPEC L946-974.
 */
export async function runDevV2Phase14Planner(
  ctx: PipelineEngineContext,
  projectId: string,
  project: ResolvedHarnessProject,
  state: HandlerPhaseState,
): Promise<void> {
  let screenIds: string[] = [];
  let componentIds: string[] = [];

  // Try to read the locked design contract to extract IDs for the planner briefing.
  const contractPath = project.config?.openDesign?.contractPath;
  if (contractPath) {
    try {
      const { isValidDesignContract } = await import('../../../../src/types/open-design');
      const contractRaw = fs.readFileSync(contractPath, 'utf-8');
      const contractParsed = JSON.parse(contractRaw) as unknown;
      if (isValidDesignContract(contractParsed)) {
        screenIds = contractParsed.screens.map((s) => s.id);
        componentIds = contractParsed.components.map((c) => c.id);
      } else {
        logger.warn({ projectId, contractPath }, 'runDevV2Phase14Planner: design contract failed validation, proceeding without IDs');
      }
    } catch (err) {
      logger.warn({ projectId, contractPath, err }, 'runDevV2Phase14Planner: could not read design contract, proceeding without IDs');
    }
  } else {
    logger.info({ projectId }, 'runDevV2Phase14Planner: no contractPath in openDesign config, proceeding without IDs');
  }

  const briefingCtx: DevV2BriefingCtx = { screenIds, componentIds };
  const plannerBriefing = getDevV2Briefing('harness-planner', briefingCtx);

  // Delegate to the shared planner runner with the briefing.
  await ctx.runPhase11WithBriefing(projectId, state, plannerBriefing);
}

/**
 * Phase 1 of development-v2: Discovery conversation (reuses discovery-agent with optional briefing).
 */
export async function handlePhase1MessageDevV2(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  briefing: string | null,
): Promise<void> {
  const project = getHarnessProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const sessionKey = 'phase1-devv2';
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  const docsCtx = getPipelineDocsContext(project.projectPath, project.pipelineDocsId ?? null);
  const notesPath = project.discoveryNotesPath
    || (docsCtx ? docsCtx.resolveDocPath('discovery.md') : path.join(project.projectPath, 'discovery-notes.md'));
  const isFirstTurn = !sessionEntry.alive;

  let prompt = isFirstTurn
    ? `Arquivo de notas do discovery: ${notesPath}\n\nMensagem do usuario: ${message}`
    : message;
  if (briefing && isFirstTurn) {
    prompt = `${briefing}\n\n${prompt}`;
  }

  const acc = { text: '', completed: false };
  const result = await ctx.spawnAgent(DISCOVERY_AGENT_ID, prompt, {
    projectId,
    phaseNumber: 1,
    cwd: project.projectPath,
    abortController: state.abortController,
    continueSession: sessionEntry.alive,
    docsDir: docsCtx?.docsDir,
    // SC-1 (Pilar C): prompt de retomada para retry de sessao Codex ceifada.
    rebuildPromptOnRetry: () =>
      buildCodexResumePrompt({
        projectId,
        phaseNumber: 1,
        preamble:
          (briefing ? `${briefing}\n\n` : '') +
          `Arquivo de notas do discovery: ${notesPath}`,
        userMessage: message,
      }),
    onText: ctx.makeConversationOnText(projectId, 1, acc),
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 1, type: 'tool_call', tool: toolName });
    },
  });

  sessionEntry.alive = true;
  ctx.accumulateMetrics(state, 1, result);

  const cleaned = acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (cleaned) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 1 }, 'assistant', cleaned);
  }

  emitPipelineStream({ projectId, phase: 1, type: 'done' });
}

/**
 * Phase 3 of development-v2: PRD Validator conversation (reuses prd-validator with optional briefing).
 */
export async function handlePhase3MessageDevV2(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  briefing: string | null,
): Promise<void> {
  const project = getHarnessProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const sessionKey = 'phase3-devv2';
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  const docsCtx = getPipelineDocsContext(project.projectPath, project.pipelineDocsId ?? null);
  const storiesPath = docsCtx
    ? docsCtx.resolveDocPath('stories-requisitos.md')
    : path.join(project.projectPath, 'stories-requisitos.md');
  const isFirstTurn = !sessionEntry.alive;

  let prompt = isFirstTurn
    ? `User stories e requisitos: ${storiesPath}\n\nMensagem do usuario: ${message}`
    : message;
  if (briefing && isFirstTurn) {
    prompt = `${briefing}\n\n${prompt}`;
  }

  const acc = { text: '', completed: false };
  const result = await ctx.spawnAgent(PRD_VALIDATOR_ID, prompt, {
    projectId,
    phaseNumber: 3,
    cwd: project.projectPath,
    abortController: state.abortController,
    continueSession: sessionEntry.alive,
    docsDir: docsCtx?.docsDir,
    // SC-1 (Pilar C): prompt de retomada para retry de sessao Codex ceifada.
    rebuildPromptOnRetry: () =>
      buildCodexResumePrompt({
        projectId,
        phaseNumber: 3,
        preamble:
          (briefing ? `${briefing}\n\n` : '') +
          `User stories e requisitos: ${storiesPath}`,
        userMessage: message,
      }),
    onText: ctx.makeConversationOnText(projectId, 3, acc),
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 3, type: 'tool_call', tool: toolName });
    },
  });

  sessionEntry.alive = true;
  ctx.accumulateMetrics(state, 3, result);

  const cleaned = acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (cleaned) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 3 }, 'assistant', cleaned);
  }

  emitPipelineStream({ projectId, phase: 3, type: 'done' });
}

/**
 * Phase 13 of development-v2: Spec Enricher conversation using pipe2-spec-enricher.
 */
export async function handleDevV2Phase13SpecEnricher(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
): Promise<void> {
  const project = getHarnessProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const sessionKey = 'phase13-devv2';
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  const docsCtx = getPipelineDocsContext(project.projectPath, project.pipelineDocsId ?? null);
  const specPath = project.specPath
    || (docsCtx ? docsCtx.resolveDocPath('SPEC.md') : path.join(project.projectPath, 'SPEC.md'));
  const isFirstTurn = !sessionEntry.alive;

  const prompt = isFirstTurn
    ? `SPEC: ${specPath}\n\nMensagem do usuario: ${message}`
    : message;

  const acc = { text: '', completed: false };
  const result = await ctx.spawnAgent(PIPE2_SPEC_ENRICHER_ID, prompt, {
    projectId,
    phaseNumber: 13,
    cwd: project.projectPath,
    abortController: state.abortController,
    continueSession: sessionEntry.alive,
    docsDir: docsCtx?.docsDir,
    // SC-1 (Pilar C): prompt de retomada para retry de sessao Codex ceifada.
    rebuildPromptOnRetry: () =>
      buildCodexResumePrompt({
        projectId,
        phaseNumber: 13,
        preamble: `SPEC: ${specPath}`,
        userMessage: message,
      }),
    onText: ctx.makeConversationOnText(projectId, 13, acc),
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 13, type: 'tool_call', tool: toolName });
    },
  });

  sessionEntry.alive = true;
  ctx.accumulateMetrics(state, 13, result);

  const cleaned = acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (cleaned) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 13 }, 'assistant', cleaned);
  }

  emitPipelineStream({ projectId, phase: 13, type: 'done' });
}

/**
 * Finalizes a development-v2 conversation phase approval and advances.
 */
export async function finalizeDevV2ConversationPhase(
  ctx: PipelineEngineContext,
  projectId: string,
  phase: number,
  state: HandlerPhaseState,
  project: ResolvedHarnessProject,
): Promise<void> {
  const phaseName = getPhaseName(phase, project) ?? `Phase ${phase}`;
  // Gate humano "Iniciar Desenvolvimento" antes do loop Coder: resolve a fase
  // do Sprint Validator DINAMICAMENTE (nao hardcodar numero). A renumeracao
  // +1 (insercao do Design Plan na fase 4) moveu o Sprint Validator de 14->15;
  // hardcodar `phase === 14` apontava para o Planner (auto) e pulava o gate.
  // Mesmo helper/padrao usado em confirmStartDevelopment.
  const sprintValidatorPhase = getPhaseNumberForAgent(project, 'sprint-validator');
  const isSprintValidatorPhase =
    sprintValidatorPhase !== undefined && phase === sprintValidatorPhase;

  // Salva metrica acumulada da fase conversation no DB. Sem isso, as fases
  // conversacionais do dev-v2 (1, 3, 5, 8, 9, 10, 11, 13, 15) nunca apareciam
  // como `completed` na tabela `pipeline_phase_metrics`, e o UI mostrava as
  // fases sem historico (cinza pendente) ao reabrir o projeto. Equivalente ao
  // que `finalizeConversationPhase` faz para os outros pipelines.
  const agentId = getPhaseAgentId(phase, project) ?? 'unknown';
  ctx.flushAccumulatedMetrics(projectId, phase, agentId, state, 'completed', project);

  // Fase 12 (Spec Generation) acumula metricas do validator sob a sub-linha
  // 121 (analogo ao 91 da fase 9 em finalizeConversationPhase). Sem este flush
  // adicional as metricas do pipe2-spec-validator seriam perdidas (SPEC-007 5.6).
  if (phase === 12) {
    ctx.flushAccumulatedMetrics(projectId, 121, PIPE2_SPEC_VALIDATOR_ID, state, 'completed', project, true);
  }

  logger.info({ projectId, phase }, '[dev-v2] Conversation phase finalized by user approval');

  if (isSprintValidatorPhase) {
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase,
      phaseName,
      status: 'awaiting-dev-confirmation',
      awaitingUser: true,
    });
    return;
  }

  emitIPC('pipeline:phase-changed', {
    projectId,
    phase,
    phaseName,
    status: 'completed',
    awaitingUser: false,
  });

  await ctx.advanceToNextPhase(projectId, state);
}
