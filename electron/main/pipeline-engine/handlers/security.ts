/**
 * Security pipeline handlers (SPEC §4 / Sprint 8A.2).
 *
 * Houses the 9 per-phase methods previously inline in index.ts:
 *   - runSecurityPhase1                 (phase 1, auto — Repo Profiler)
 *   - runSecurityPhase2                 (phase 2, auto — multi-agent SecurityAuditRunner)
 *   - runSecurityPhase3                 (phase 3, auto — Deduplicador)
 *   - handleSecurityPhase4Message       (phase 4, conversation — Skeptic Security)
 *   - handleSecurityPhase5Message       (phase 5, conversation — Skeptic Quality)
 *   - runSecurityPhase6                 (phase 6, auto — SPEC Generator)
 *   - handleSecurityPhase7Message       (phase 7, conversation — SPEC Enricher)
 *   - handleSecurityPhase9Message       (phase 9, conversation — Sprint Validator)
 *
 * They were moved VERBATIM (mechanical move, not a rewrite) and reparameterized
 * from `this.X` to an injected `ctx: PipelineEngineContext` — the same late-bound
 * `buildXEngine` pattern as reset.ts / message-router.ts / lifecycle.ts and the
 * 8A.1 architecture-review extraction. index.ts keeps a thin delegator method for
 * each (so the existing sendMessage / runAutoPhase dispatch via
 * `this.handleSecurityX` / `this.runSecurityX` is unchanged) and builds the ctx
 * per call with bound delegates.
 *
 * INVARIANTS PRESERVED
 *  - INV-2 (R8): every agent run goes through `ctx.spawnAgent` — the single
 *    executeAgent entry point in index.ts. Phase 2's multi-agent fan-out goes
 *    through `ctx.createSecurityAuditRunner()`, which constructs a
 *    SecurityAuditRunner bound to the live engine; the runner reuses the SAME
 *    spawnAgent for its 7 specialists. No executeAgent here, no second copy.
 *  - INV-13 (SQL only in db.ts): phase 6's inline
 *    `getDb().prepare('UPDATE harness_projects SET spec_path = ?, updated_at = ...')`
 *    is replaced by `updateHarnessProject(projectId, { specPath })`, which runs the
 *    byte-identical SQL (`spec_path = ?, updated_at = datetime('now')`) — same
 *    behavior, no SQL outside db.ts (mirrors the 8A.1 / reset.ts Sprint 6 treatment).
 *  - INV-1 (IPC): all pipeline:* emits are on the same channels with the same
 *    payloads, unchanged.
 *  - Security phase 2 persistence rule: the 7 specialists' individual streams are
 *    NOT persisted — only the consolidated MD is emitted/persisted by the runner.
 *    Unchanged (the runner is untouched; this module only constructs it).
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
  updateHarnessProject,
  savePipelinePhaseMetrics,
  patchSecuritySummaryJson,
} from '../../db';
import { runRepoProfiler } from '../../repo-profiler';
import type { PhaseCallbacks } from '../../repo-profiler';
import { parseSecurityFindings } from '../../security-findings-parser';
import {
  getPipelineDocsContext,
  findConsolidatedSecurityReport,
  findHarnessSprintsReadPath,
  resolveHarnessSprintsPath,
} from '../../pipeline-paths';
import {
  SPEC_BUILDER_ID,
  SPEC_ENRICHER_ID,
  SPRINT_VALIDATOR_ID,
  RESOLUTION_TRACKER_ID,
  SECURITY_SPEC_VALIDATOR_ID,
} from '../../seed-agents/index';
import { SECURITY_PHASE_NAMES } from '../registry';
import type { AgentConfig } from '../../../../src/types';
import type { PipelineEngineContext, HandlerPhaseState, ResolvedHarnessProject } from './context';

const logger = createLogger('pipeline-engine');

// -------------------------------------------------------------------------
// Security Phase 1: Repo Profiler (auto)
// -------------------------------------------------------------------------

export async function runSecurityPhase1(
  ctx: PipelineEngineContext,
  projectId: string,
  projectPath: string,
  state: HandlerPhaseState,
): Promise<void> {
  logger.info({ projectId, projectPath }, 'Security Phase 1: Repo Profiler starting');

  const startedAt = Date.now();

  const callbacks: PhaseCallbacks = {
    onText: (chunk) => {
      emitPipelineStream({ projectId, phase: 1, type: 'text', content: chunk });
    },
    onDone: () => {
      emitPipelineStream({ projectId, phase: 1, type: 'done' });
    },
  };

  const manifest = await runRepoProfiler(projectPath, callbacks);

  logger.info(
    { projectId, totalFiles: manifest.totalFiles, classifiedFiles: manifest.classifiedFiles },
    'Security Phase 1: Repo Profiler completed',
  );

  // Persist completion metrics so the UI stops showing phase 1 as "running".
  // runAutoPhase created a 'running' row at entry; this call upserts it to 'completed'.
  savePipelinePhaseMetrics({
    projectId,
    phaseNumber: 1,
    phaseName: SECURITY_PHASE_NAMES[1] ?? 'Repo Profiler',
    agentId: 'repo-profiler',
    status: 'completed',
    durationMs: Date.now() - startedAt,
    runtime: 'local',
    completedAt: new Date().toISOString(),
    metadata: {
      totalFiles: manifest.totalFiles,
      classifiedFiles: manifest.classifiedFiles,
      language: manifest.language,
      framework: manifest.framework,
    },
  });

  emitIPC('pipeline:manifest', { projectId, manifest });

  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 1,
    phaseName: SECURITY_PHASE_NAMES[1],
    status: 'completed',
    awaitingUser: false,
  });

  // Auto-advance to Phase 2 (Security Audit)
  await ctx.advanceToNextPhase(projectId, state);
}

// -------------------------------------------------------------------------
// Security Phase 2: Security Audit (parallel multi-agent via SecurityAuditRunner)
// -------------------------------------------------------------------------

export async function runSecurityPhase2(
  ctx: PipelineEngineContext,
  projectId: string,
  project: ReturnType<typeof getHarnessProject> & object,
  state: HandlerPhaseState,
): Promise<void> {
  logger.info({ projectId }, 'Security Phase 2: Security Audit starting');

  const startedAt = Date.now();
  const runner = ctx.createSecurityAuditRunner();

  const callbacks: PhaseCallbacks = {
    onText: (chunk) => {
      emitPipelineStream({ projectId, phase: 2, type: 'text', content: chunk });
    },
    onDone: () => {
      emitPipelineStream({ projectId, phase: 2, type: 'done' });
    },
  };

  const consolidatedPath = await runner.run(
    // HarnessProject e superset de PipelineProject pros campos usados pelo runner.
    // Cast via unknown porque os types tem signatures de sobreposicao parcial.
    project as unknown as Parameters<typeof runner.run>[0],
    state.abortController,
    callbacks,
    (project as { pipelineDocsId?: string | null }).pipelineDocsId ?? null,
  );

  // Bug #12: emit document-updated with the raw consolidated report from phase 2
  if (consolidatedPath && fs.existsSync(consolidatedPath)) {
    try {
      const content = fs.readFileSync(consolidatedPath, 'utf-8');
      emitIPC('pipeline:document-updated', {
        projectId,
        path: consolidatedPath,
        content,
      });
    } catch (err) {
      logger.warn({ err, consolidatedPath }, 'Failed to emit consolidated document for phase 2');
    }
  }

  if (state.abortController.signal.aborted) return;

  logger.info({ projectId }, 'Security Phase 2: Security Audit completed');

  // Mark the phase-level metrics row (sprint_index=-1) as completed. The runner
  // writes per-agent rows (sprint_index=1..7); without this upsert the phase
  // aggregate stays stuck on 'running' from runAutoPhase's initial insert.
  savePipelinePhaseMetrics({
    projectId,
    phaseNumber: 2,
    phaseName: SECURITY_PHASE_NAMES[2] ?? 'Security Audit',
    agentId: 'multi-agent',
    status: 'completed',
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
    metadata: { aggregateOnly: true },
  });

  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 2,
    phaseName: SECURITY_PHASE_NAMES[2],
    status: 'completed',
    awaitingUser: false,
  });

  // Auto-advance to Phase 3 (Deduplicador)
  await ctx.advanceToNextPhase(projectId, state);
}

// -------------------------------------------------------------------------
// Security Phase 3: Deduplicador (auto, single agent)
// -------------------------------------------------------------------------

export async function runSecurityPhase3(
  ctx: PipelineEngineContext,
  projectId: string,
  projectPath: string,
  state: HandlerPhaseState,
): Promise<void> {
  logger.info({ projectId }, 'Security Phase 3: Deduplicador starting');

  // Resolve consolidated security report path via canonical helper.
  const project3 = getHarnessProject(projectId);
  const consolidatedPath = findConsolidatedSecurityReport(
    projectPath,
    project3?.pipelineDocsId ?? null,
  );
  const securityDir = path.join(projectPath, '.lionclaw', 'Security');

  const prompt = consolidatedPath
    ? `Leia o relatorio de seguranca consolidado em: ${consolidatedPath}\n` +
      `Deduplique os findings: remova entradas identicas ou muito similares, mantendo a mais detalhada.\n` +
      `Renumere os findings deduplicados sequencialmente por severidade.\n` +
      `Salve o resultado deduplicado sobrescrevendo o arquivo: ${consolidatedPath}`
    : `Nao foi encontrado relatorio de seguranca consolidado em ${securityDir}. Por favor verifique a execucao da fase anterior.`;

  let phase3Output = '';
  const result = await ctx.spawnAgent('security-deduplicator', prompt, {
    projectId,
    phaseNumber: 3,
    cwd: projectPath,
    abortController: state.abortController,
    onText: (chunk) => {
      phase3Output += chunk;
      emitPipelineStream({ projectId, phase: 3, type: 'text', content: chunk });
    },
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 3, type: 'tool_call', tool: toolName });
    },
  });

  if (phase3Output) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 3 }, 'assistant', phase3Output);
  }

  ctx.collectMetrics(projectId, 3, 'security-deduplicator', result, 'completed', { pipelineType: 'security' });

  logger.info({ projectId }, 'Security Phase 3: Deduplicador completed');

  // Write Site 1: populate totalFindings + bySeverity after deduplication.
  if (consolidatedPath) {
    try {
      const parsed = parseSecurityFindings(consolidatedPath);
      patchSecuritySummaryJson(projectId, {
        totalFindings: parsed.total,
        bySeverity: parsed.bySeverity,
      });
      logger.info({ projectId, total: parsed.total }, 'SecuritySummary: totalFindings written after phase 3');
    } catch (err) {
      logger.warn({ err, projectId }, 'SecuritySummary: failed to parse findings after phase 3, skipping');
    }
  }

  emitPipelineStream({ projectId, phase: 3, type: 'done' });

  // Bug #12: emit document-updated with the dedup output so the viewer
  // reflects the post-deduplication state immediately.
  if (consolidatedPath && fs.existsSync(consolidatedPath)) {
    try {
      const content = fs.readFileSync(consolidatedPath, 'utf-8');
      emitIPC('pipeline:document-updated', {
        projectId,
        path: consolidatedPath,
        content,
      });
    } catch (err) {
      logger.warn({ err, consolidatedPath }, 'Failed to emit dedup document for phase 3');
    }
  }

  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 3,
    phaseName: SECURITY_PHASE_NAMES[3],
    status: 'completed',
    awaitingUser: false,
  });

  // Auto-advance to Phase 4 (Validador Cetico — conversation)
  await ctx.advanceToNextPhase(projectId, state);
}

// -------------------------------------------------------------------------
// Security Phase 6: SPEC Generator (auto builder<->validator loop + review gate)
//
// SPEC-loop-fix §3: rewritten from a single spec-builder run into a builder<->
// validator loop mirroring feature runPhase9. Up to 3 rounds, SPEC_BUILDER_ID ->
// SECURITY_SPEC_VALIDATOR_ID; break when the validation report FILE contains the
// literal '## Status: PASS'. On success, pauses at status 'awaiting-spec-review'
// (awaitingUser:true) instead of auto-advancing, and auto-triggers the validator
// greeting via handleSecurityPhase6SpecReviewMessage. Approval (index.ts approve
// route + finalizeConversationPhase) advances to phase 7. Uses the split-aggregate
// createEmptyMetrics/mergeMetrics style (NOT dev-v2's accumulate).
// -------------------------------------------------------------------------

export async function runSecurityPhase6(
  ctx: PipelineEngineContext,
  projectId: string,
  project: ReturnType<typeof getHarnessProject> & object,
  state: HandlerPhaseState,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  logger.info({ projectId }, 'Security Phase 6: SPEC Generator (builder<->validator loop) starting');

  // Find consolidated Security report via canonical helper (preserved logic)
  const securityDir = path.join(projectPath, '.lionclaw', 'Security');
  const securityReportPath = findConsolidatedSecurityReport(
    projectPath,
    (project as unknown as { pipelineDocsId?: string | null }).pipelineDocsId ?? null,
  );

  // Derive scan ID from the file name for the SPEC output path (legacy basename pattern only)
  const scanIdMatch = securityReportPath
    ? path.basename(securityReportPath).match(/Security[-_]?(\d{8}[-_]\d{4,6})\.md/)
    : null;
  const scanId = scanIdMatch ? scanIdMatch[1] : 'unknown';
  const specOutputPath = path.join(securityDir, `SPECsecurity-${scanId}.md`);

  // Mirrors feature's validationReportPath (dev-feature.ts:447).
  const validationReportPath = path.join(securityDir, 'security-spec-validation.md');

  const securityContextPrompt = securityReportPath
    ? `\n\nINFORMACAO IMPORTANTE: Este projeto e um security audit pipeline.\n` +
      `O INPUT para voce NAO e um PRD, mas um relatorio de auditoria de seguranca consolidado.\n` +
      `Leia o relatorio em: ${securityReportPath}\n` +
      `Gere um SPEC tecnico que descreva como corrigir cada finding listado no relatorio.\n` +
      `Cada finding deve se tornar uma feature na SPEC com criterios de aceite claros e passos de implementacao.\n` +
      `Salve o SPEC em: ${specOutputPath}`
    : `\n\nINFORMACAO IMPORTANTE: Este projeto e um security audit pipeline.\n` +
      `Nenhum relatorio de seguranca foi encontrado em ${securityDir}. Verifique a fase anterior.\n` +
      `Salve o SPEC em: ${specOutputPath}`;

  const phaseName = SECURITY_PHASE_NAMES[6];

  savePipelinePhaseMetrics({
    projectId,
    phaseNumber: 6,
    phaseName,
    agentId: SPEC_BUILDER_ID,
    status: 'running',
    startedAt: new Date().toISOString(),
  });

  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 6,
    phaseName,
    status: 'running',
    awaitingUser: false,
  });

  const MAX_ROUNDS = 3;
  let passed = false;
  let lastError: string | undefined;

  // Aggregate metrics separately for builder and validator across rounds.
  const builderAgg = ctx.createEmptyMetrics();
  const validatorAgg = ctx.createEmptyMetrics();
  let builderModel = SPEC_BUILDER_ID;
  let builderRuntime: AgentConfig['runtime'] = 'cloud';
  let validatorModel = SECURITY_SPEC_VALIDATOR_ID;
  let validatorRuntime: AgentConfig['runtime'] = 'cloud';
  const startedAt = Date.now();

  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (state.abortController.signal.aborted) break;

      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: 6,
        phaseName,
        status: 'spec-builder-running',
        awaitingUser: false,
        metadata: { round, maxRounds: MAX_ROUNDS },
      });

      // --- Spec Builder ---
      let builderPrompt: string;
      if (round === 1) {
        builderPrompt =
          `Gere um SPEC completo a partir do relatorio de auditoria de seguranca.${securityContextPrompt}`;
      } else {
        const validationContent = fs.existsSync(validationReportPath)
          ? fs.readFileSync(validationReportPath, 'utf-8')
          : '';
        builderPrompt =
          `Corrija o SPEC de correcoes de seguranca com base no relatorio de validacao abaixo.\n\n` +
          `SPEC: ${specOutputPath}\n` +
          `Relatorio consolidado: ${securityReportPath}\n\n` +
          `Salve o resultado corrigido em: ${specOutputPath}\n\n` +
          `Validation Report:\n${validationContent}`;
      }

      let builderOutput = '';
      const builderResult = await ctx.spawnAgent(SPEC_BUILDER_ID, builderPrompt, {
        projectId,
        phaseNumber: 6,
        cwd: projectPath,
        abortController: state.abortController,
        onText: (chunk) => {
          builderOutput += chunk;
          emitPipelineStream({
            projectId, phase: 6, type: 'text', content: chunk, metadata: { agent: 'spec-builder', round },
          });
        },
        onToolUse: (toolName) => {
          emitPipelineStream({ projectId, phase: 6, type: 'tool_call', tool: toolName, metadata: { agent: 'spec-builder', round } });
        },
      });

      if (builderOutput) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 6 }, 'assistant', builderOutput);
      }

      ctx.mergeMetrics(builderAgg, builderResult.metrics);
      builderModel = builderResult.model;
      builderRuntime = builderResult.runtime;

      if (fs.existsSync(specOutputPath)) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: specOutputPath,
          content: fs.readFileSync(specOutputPath, 'utf-8'),
        });
      }

      if (state.abortController.signal.aborted) break;

      // --- Spec Validator ---
      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: 6,
        phaseName,
        status: 'spec-validator-running',
        awaitingUser: false,
        metadata: { round, maxRounds: MAX_ROUNDS },
      });

      const validatorPrompt =
        `Valide o SPEC de correcoes de seguranca contra o relatorio de auditoria de seguranca CONSOLIDADO (NAO um PRD). ` +
        `Cada finding confirmado no relatorio deve virar uma feature na SPEC com criterio de aceite verificavel e passos de implementacao.\n\n` +
        `SPEC: ${specOutputPath}\n` +
        `Relatorio consolidado: ${securityReportPath}\n` +
        `Salve o relatorio de validacao em: ${validationReportPath}`;

      let validatorOutput = '';
      const validatorResult = await ctx.spawnAgent(SECURITY_SPEC_VALIDATOR_ID, validatorPrompt, {
        projectId,
        phaseNumber: 6,
        cwd: projectPath,
        abortController: state.abortController,
        onText: (chunk) => {
          validatorOutput += chunk;
          emitPipelineStream({
            projectId, phase: 6, type: 'text', content: chunk, metadata: { agent: 'security-spec-validator', round },
          });
        },
        onToolUse: (toolName) => {
          emitPipelineStream({ projectId, phase: 6, type: 'tool_call', tool: toolName, metadata: { agent: 'security-spec-validator', round } });
        },
      });

      if (validatorOutput) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 6 }, 'assistant', validatorOutput);
      }

      ctx.mergeMetrics(validatorAgg, validatorResult.metrics);
      validatorModel = validatorResult.model;
      validatorRuntime = validatorResult.runtime;

      // Check validation result against the FILE content (not the agent stdout).
      const validationReport = fs.existsSync(validationReportPath)
        ? fs.readFileSync(validationReportPath, 'utf-8')
        : '';

      if (validationReport.includes('## Status: PASS')) {
        passed = true;
        logger.info({ projectId, round }, 'Security Phase 6: Spec validation PASSED');
        break;
      }

      logger.info({ projectId, round }, 'Security Phase 6: Spec validation FAILED — continuing');
    }
  } catch (err) {
    rethrowPipelinePause(err);
    if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
      logger.info({ projectId }, 'Security Phase 6 aborted');
      return;
    }
    lastError = (err as Error).message;
    logger.error({ err, projectId }, 'Security Phase 6 error');
  }

  const durationMs = Date.now() - startedAt;

  // Save 2 aggregated metric rows: builder (phase 6) + validator (sub-row 61).
  savePipelinePhaseMetrics({
    projectId,
    phaseNumber: 6,
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
  });

  savePipelinePhaseMetrics({
    projectId,
    phaseNumber: 61, // sub-row for validator within phase 6
    phaseName: `${phaseName} (Validator)`,
    agentId: SECURITY_SPEC_VALIDATOR_ID,
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
  });

  emitIPC('pipeline:metrics', {
    projectId,
    phaseNumber: 6,
    metrics: { builder: builderAgg, validator: validatorAgg },
    passed,
  });

  if (lastError) {
    logger.error({ projectId, error: lastError }, 'Security Phase 6 failed — marking pipeline as failed');
    ctx.failPhase(projectId, state, {
      phase: 6,
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

  // Update project's specPath to point to the security SPEC.
  // INV-13: routed through updateHarnessProject (byte-identical SQL:
  // `spec_path = ?, updated_at = datetime('now')`) instead of inline getDb().prepare.
  updateHarnessProject(projectId, { specPath: specOutputPath });

  emitPipelineStream({ projectId, phase: 6, type: 'done' });

  logger.info({ projectId, specOutputPath, passed }, 'Security Phase 6: auto loop complete — entering spec review conversation');

  // Pause at the review gate (no auto-advance). Approval advances to phase 7.
  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: 6,
    phaseName,
    status: 'awaiting-spec-review',
    awaitingUser: true,
    metadata: { passed },
  });

  // Auto-trigger the Security Spec Validator greeting so it presents its analysis.
  // Called directly in-file (both handlers live here); project passed as the 5th arg.
  const greetingProject = getHarnessProject(projectId);
  const greetingMsg =
    `Projeto "${greetingProject?.name ?? projectId}". ` +
    `O loop de geracao da SPEC de correcoes foi concluido` +
    `${passed ? ' e a validacao PASSOU' : ' (a validacao atingiu o limite de rodadas, ha ressalvas)'}. ` +
    `Apresente um resumo da SPEC de correcoes, destaque os findings cobertos e as ressalvas, ` +
    `e pergunte se o usuario deseja ajustes antes de avancar para o Enricher.`;

  try {
    await ctx.sendMessage(projectId, greetingMsg, { isGreeting: true, rethrowPause: true });
  } catch (err) {
    rethrowPipelinePause(err);
    logger.warn({ err, projectId }, 'Security Phase 6: greeting failed (non-fatal)');
  }
}

// -------------------------------------------------------------------------
// Security Phase 6 (review gate): conversational SPEC review with the Security
// Spec Validator. Mirrors feature handlePhase9Message + the security greeting
// pattern of handleSecurityPhase7Message. Conversation-turn metrics under
// sub-key 61 (like feature's 91). Approval advances to phase 7.
// -------------------------------------------------------------------------

export async function handleSecurityPhase6SpecReviewMessage(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  project: ReturnType<typeof getHarnessProject> & object,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const sessionKey = 'security-phase6-validator';
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  // Re-resolve the security SPEC + report + validation report paths.
  const securityDir = path.join(projectPath, '.lionclaw', 'Security');
  const securityReportPath = findConsolidatedSecurityReport(
    projectPath,
    (project as unknown as { pipelineDocsId?: string | null }).pipelineDocsId ?? null,
  );
  const scanIdMatch = securityReportPath
    ? path.basename(securityReportPath).match(/Security[-_]?(\d{8}[-_]\d{4,6})\.md/)
    : null;
  const scanId = scanIdMatch ? scanIdMatch[1] : 'unknown';
  const specOutputPath = (project as { specPath?: string }).specPath
    || path.join(securityDir, `SPECsecurity-${scanId}.md`);
  const validationReportPath = path.join(securityDir, 'security-spec-validation.md');

  const isFirstTurn = !sessionEntry.alive;
  const previousSpecContent = fs.existsSync(specOutputPath)
    ? fs.readFileSync(specOutputPath, 'utf-8')
    : '';

  const prompt = isFirstTurn
    ? `## SPEC de correcoes de seguranca\nCaminho: ${specOutputPath}\n\n` +
      `## Relatorio de auditoria consolidado\nCaminho: ${securityReportPath}\n\n` +
      (fs.existsSync(validationReportPath) ? `## Relatorio de validacao\nCaminho: ${validationReportPath}\n\n` : '') +
      `## Instrucao importante\n` +
      `Voce e o Security Spec Validator. Leia os arquivos acima, apresente um resumo da SPEC de correcoes, ` +
      `destaque os findings cobertos e as ressalvas. Se o usuario pedir ajustes, edite o SPEC em ${specOutputPath} via Edit. ` +
      `Ao final, ele clicara em Aprovar para avancar para o Enricher.\n\n` +
      `## Mensagem do usuario\n${message}`
    : message;

  const acc = { text: '', completed: false };
  const result = await ctx.spawnAgent(SECURITY_SPEC_VALIDATOR_ID, prompt, {
    projectId,
    phaseNumber: 6,
    cwd: projectPath,
    abortController: state.abortController,
    continueSession: sessionEntry.alive,
    // SC-1 (Pilar C): prompt de retomada para retry de sessao Codex ceifada.
    rebuildPromptOnRetry: () =>
      buildCodexResumePrompt({
        projectId,
        phaseNumber: 6,
        preamble:
          `## SPEC de correcoes de seguranca\nCaminho: ${specOutputPath}\n\n` +
          `## Relatorio de auditoria consolidado\nCaminho: ${securityReportPath}\n\n` +
          (fs.existsSync(validationReportPath) ? `## Relatorio de validacao\nCaminho: ${validationReportPath}\n\n` : '') +
          `## Instrucao importante\n` +
          `Voce e o Security Spec Validator. Se o usuario pedir ajustes, edite o SPEC em ${specOutputPath} via Edit. ` +
          `Ao final, ele clicara em Aprovar para avancar para o Enricher.`,
        userMessage: message,
      }),
    onText: ctx.makeConversationOnText(projectId, 6, acc),
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 6, type: 'tool_call', tool: toolName });
    },
  });

  sessionEntry.alive = true;
  ctx.accumulateMetrics(state, 61, result);

  if (fs.existsSync(specOutputPath)) {
    const currentSpecContent = fs.readFileSync(specOutputPath, 'utf-8');
    if (currentSpecContent !== previousSpecContent) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: specOutputPath,
        content: currentSpecContent,
      });
    }
  }

  const cleanedText = acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (cleanedText) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 6 }, 'assistant', cleanedText);
  }

  emitIPC('pipeline:agent-completed', { projectId });
  emitPipelineStream({ projectId, phase: 6, type: 'done' });
}

// =========================================================================
// Security Pipeline Conversation Phases
// =========================================================================

// -------------------------------------------------------------------------
// Security Phase 4: Validador Cetico
// First runs security-skeptic-security then security-skeptic-quality automatically,
// then opens human chat (awaitingUser=true).
// -------------------------------------------------------------------------

export async function handleSecurityPhase4Message(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  project: ReturnType<typeof getHarnessProject> & object,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const sessionKey = 'security-phase4';
  let sessionEntry = state.continueSessions.get(sessionKey);

  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  // First message (greeting): run security skeptic once, then wait for user.
  if (!sessionEntry.alive) {
    const securityDir = path.join(projectPath, '.lionclaw', 'Security');
    const securityReportPath = findConsolidatedSecurityReport(
      projectPath,
      (project as unknown as { pipelineDocsId?: string | null }).pipelineDocsId ?? null,
    );

    const reportContext = securityReportPath
      ? `Relatorio de seguranca consolidado: ${securityReportPath}`
      : `Nenhum relatorio consolidado encontrado em ${securityDir}.`;

    if (securityReportPath && fs.existsSync(securityReportPath)) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: securityReportPath,
        content: fs.readFileSync(securityReportPath, 'utf-8'),
      });
    } else {
      logger.warn({ projectId, securityDir }, 'Security Phase 4: consolidated report not found, skipping document-updated emit');
    }

    logger.info({ projectId }, 'Security Phase 4: running security-skeptic-security');
    const secPrompt = `Voce e o Validador Cetico de Seguranca nesta fase de VALIDACAO.\n\n` +
      `## Entrada\n` +
      `${reportContext}\n\n` +
      `## Seu escopo\n` +
      `- Para cada finding das secoes 01 (Secrets), 02 (Auth), 03 (Isolation), 07 (OWASP):\n` +
      `  marcar como CONFIRMADO, REMOVIDO ou REBAIXADO (com justificativa curta).\n` +
      `- Atualizar o proprio Security-*.md removendo falsos positivos das suas secoes\n` +
      `  e adicionando "Validacao Cetica de Seguranca - Sumario Parcial" ao final.\n\n` +
      `## Fora do escopo (NAO faca)\n` +
      `- Nao discuta geracao de SPEC. Outro agente cuida disso em fase posterior.\n` +
      `- Nao enriqueca solucoes sugeridas. Nao proponha estrategias de implementacao.\n` +
      `- Nao decida prioridades de negocio, timing ("imediato vs deferido") nem roadmap.\n` +
      `- Nao pergunte "prefere X ou Y" sobre proximas fases.\n\n` +
      `## Como terminar\n` +
      `Quando concluir a validacao, apresente:\n` +
      `1. Totais: X confirmados, Y removidos, Z rebaixados\n` +
      `2. Resumo curto das mudancas feitas no Security-*.md\n` +
      `3. UMA UNICA mensagem final ao usuario: "Se quiser ajustar algum finding especifico, me diga. Senao, clique em APROVAR para passar ao Skeptic Quality."\n\n` +
      `Se o usuario pedir ajustes em findings especificos, faca as alteracoes e atualize o sumario. ` +
      `Nunca abra discussao sobre SPEC, implementacao, priorizacao de negocio ou proximas fases.\n\n` +
      `Mensagem do usuario: ${message}`;

    let secOutput = '';
    const secResult = await ctx.spawnAgent('security-skeptic-security', secPrompt, {
      projectId,
      phaseNumber: 4,
      cwd: projectPath,
      abortController: state.abortController,
      onText: (chunk) => {
        secOutput += chunk;
        emitPipelineStream({ projectId, phase: 4, type: 'text', content: chunk });
      },
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 4, type: 'tool_call', tool: toolName });
      },
    });

    if (secOutput) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 4 }, 'assistant', secOutput);
    }
    ctx.accumulateMetrics(state, 4, secResult);

    sessionEntry.alive = true;

    logger.info({ projectId }, 'Security Phase 4: skeptic-security done, entering human chat');

    // agent-completed signals the UI to surface the Aprovar button
    emitIPC('pipeline:agent-completed', { projectId });
    emitPipelineStream({ projectId, phase: 4, type: 'done' });
  } else {
    // Follow-up turns: continue conversation with skeptic-security
    const phase4Acc = { text: '', completed: false };
    const followupResult = await ctx.spawnAgent('security-skeptic-security', message, {
      projectId,
      phaseNumber: 4,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: true,
      // SC-1 (Pilar C): prompt de retomada para retry de sessao Codex ceifada.
      rebuildPromptOnRetry: () => {
        const resumeReportPath = findConsolidatedSecurityReport(
          projectPath,
          (project as unknown as { pipelineDocsId?: string | null }).pipelineDocsId ?? null,
        );
        return buildCodexResumePrompt({
          projectId,
          phaseNumber: 4,
          preamble:
            `Voce e o Validador Cetico de Seguranca nesta fase de VALIDACAO.\n\n` +
            `## Entrada\n` +
            (resumeReportPath
              ? `Relatorio de seguranca consolidado: ${resumeReportPath}`
              : `Nenhum relatorio consolidado encontrado em ${path.join(projectPath, '.lionclaw', 'Security')}.`) +
            `\n\n## Seu escopo\n` +
            `Continue a validacao dos findings das secoes 01 (Secrets), 02 (Auth), 03 (Isolation), 07 (OWASP) ` +
            `(CONFIRMADO / REMOVIDO / REBAIXADO), atualizando o proprio Security-*.md. ` +
            `Nunca abra discussao sobre SPEC, implementacao, priorizacao de negocio ou proximas fases.`,
          userMessage: message,
        });
      },
      onText: ctx.makeConversationOnText(projectId, 4, phase4Acc),
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 4, type: 'tool_call', tool: toolName });
      },
    });

    ctx.accumulateMetrics(state, 4, followupResult);

    const cleanedText = phase4Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 4 }, 'assistant', cleanedText);
    }
    emitIPC('pipeline:agent-completed', { projectId });
    emitPipelineStream({ projectId, phase: 4, type: 'done' });
  }
}

// -------------------------------------------------------------------------
// Security Phase 5: Skeptic Quality conversation
// Runs the quality-focused skeptic once on first turn, then opens human chat.
// -------------------------------------------------------------------------

export async function handleSecurityPhase5Message(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  project: ReturnType<typeof getHarnessProject> & object,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const sessionKey = 'security-phase5';
  let sessionEntry = state.continueSessions.get(sessionKey);

  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  if (!sessionEntry.alive) {
    const securityDir = path.join(projectPath, '.lionclaw', 'Security');
    const securityReportPath = findConsolidatedSecurityReport(
      projectPath,
      (project as unknown as { pipelineDocsId?: string | null }).pipelineDocsId ?? null,
    );

    const reportContext = securityReportPath
      ? `Relatorio de seguranca consolidado (ja revisado pelo Skeptic Security): ${securityReportPath}`
      : `Nenhum relatorio consolidado encontrado em ${securityDir}.`;

    if (securityReportPath && fs.existsSync(securityReportPath)) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: securityReportPath,
        content: fs.readFileSync(securityReportPath, 'utf-8'),
      });
    }

    logger.info({ projectId }, 'Security Phase 5: running security-skeptic-quality');
    const qualPrompt = `Voce e o Validador Cetico de Qualidade nesta fase de VALIDACAO. O Skeptic Security ja revisou as secoes 01, 02, 03, 07; voce agora valida as secoes de QUALIDADE.\n\n` +
      `## Entrada\n` +
      `${reportContext}\n\n` +
      `## Seu escopo\n` +
      `- Para cada finding das secoes 04 (Duplication), 05 (Logic), 06 (Standards):\n` +
      `  marcar como CONFIRMADO, REMOVIDO ou REBAIXADO (com justificativa curta).\n` +
      `- Atualizar o proprio Security-*.md removendo falsos positivos das suas secoes\n` +
      `  e adicionando "Validacao Cetica de Qualidade - Sumario Parcial" ao final.\n\n` +
      `## Fora do escopo (NAO faca)\n` +
      `- Nao discuta geracao de SPEC. Outro agente cuida disso em fase posterior.\n` +
      `- Nao enriqueca solucoes sugeridas. Nao proponha estrategias de implementacao.\n` +
      `- Nao inclua gaps de cobertura como novos findings. Apenas registre observacoes no sumario se for relevante.\n` +
      `- Nao pergunte "prefere X ou Y" sobre proximas fases nem sobre como implementar.\n\n` +
      `## Como terminar\n` +
      `Quando concluir a validacao, apresente:\n` +
      `1. Totais: X confirmados, Y removidos, Z rebaixados\n` +
      `2. Resumo curto das mudancas feitas no Security-*.md\n` +
      `3. UMA UNICA mensagem final ao usuario: "Se quiser ajustar algum finding especifico, me diga. Senao, clique em APROVAR para o gerador de SPEC continuar."\n\n` +
      `Se o usuario pedir ajustes em findings especificos, faca as alteracoes e atualize o sumario. ` +
      `Nunca abra discussao sobre SPEC, implementacao, decisoes tecnicas ou proximas fases.\n\n` +
      `Mensagem do usuario: ${message}`;

    let qualOutput = '';
    const qualResult = await ctx.spawnAgent('security-skeptic-quality', qualPrompt, {
      projectId,
      phaseNumber: 5,
      cwd: projectPath,
      abortController: state.abortController,
      onText: (chunk) => {
        qualOutput += chunk;
        emitPipelineStream({ projectId, phase: 5, type: 'text', content: chunk });
      },
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 5, type: 'tool_call', tool: toolName });
      },
    });

    if (qualOutput) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 5 }, 'assistant', qualOutput);
    }
    ctx.accumulateMetrics(state, 5, qualResult);

    sessionEntry.alive = true;

    logger.info({ projectId }, 'Security Phase 5: skeptic-quality done, entering human chat');

    emitIPC('pipeline:agent-completed', { projectId });
    emitPipelineStream({ projectId, phase: 5, type: 'done' });
  } else {
    const phase5Acc = { text: '', completed: false };
    const followupResult = await ctx.spawnAgent('security-skeptic-quality', message, {
      projectId,
      phaseNumber: 5,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: true,
      // SC-1 (Pilar C): prompt de retomada para retry de sessao Codex ceifada.
      rebuildPromptOnRetry: () => {
        const resumeReportPath = findConsolidatedSecurityReport(
          projectPath,
          (project as unknown as { pipelineDocsId?: string | null }).pipelineDocsId ?? null,
        );
        return buildCodexResumePrompt({
          projectId,
          phaseNumber: 5,
          preamble:
            `Voce e o Validador Cetico de Qualidade nesta fase de VALIDACAO.\n\n` +
            `## Entrada\n` +
            (resumeReportPath
              ? `Relatorio de seguranca consolidado (ja revisado pelo Skeptic Security): ${resumeReportPath}`
              : `Nenhum relatorio consolidado encontrado em ${path.join(projectPath, '.lionclaw', 'Security')}.`) +
            `\n\n## Seu escopo\n` +
            `Continue a validacao dos findings das secoes 04 (Duplication), 05 (Logic), 06 (Standards) ` +
            `(CONFIRMADO / REMOVIDO / REBAIXADO), atualizando o proprio Security-*.md. ` +
            `Nunca abra discussao sobre SPEC, implementacao, decisoes tecnicas ou proximas fases.`,
          userMessage: message,
        });
      },
      onText: ctx.makeConversationOnText(projectId, 5, phase5Acc),
      onToolUse: (toolName) => {
        emitPipelineStream({ projectId, phase: 5, type: 'tool_call', tool: toolName });
      },
    });

    ctx.accumulateMetrics(state, 5, followupResult);

    const cleanedText = phase5Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 5 }, 'assistant', cleanedText);
    }
    emitIPC('pipeline:agent-completed', { projectId });
    emitPipelineStream({ projectId, phase: 5, type: 'done' });
  }
}

// -------------------------------------------------------------------------
// Security Phase 7: SPEC Enricher conversation
// -------------------------------------------------------------------------

export async function handleSecurityPhase7Message(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  project: ReturnType<typeof getHarnessProject> & object,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const sessionKey = 'security-phase7';
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  const docsCtxSec7 = getPipelineDocsContext(projectPath, (project as { pipelineDocsId?: string | null }).pipelineDocsId ?? null);

  // Resolve specPath (the SPECsecurity-*.md generated in Phase 5)
  const specPath = (project as { specPath?: string }).specPath
    || (docsCtxSec7 ? docsCtxSec7.resolveDocPath('SPEC.md') : path.join(projectPath, '.lionclaw', 'Security', 'SPECsecurity-unknown.md'));

  const isFirstTurn = !sessionEntry.alive;
  const previousSpecContent = fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf-8') : '';

  const prompt = isFirstTurn
    ? `## Arquivo da SPEC de seguranca\nCaminho: ${specPath}\n\n` +
      `## Instrucao importante\n` +
      `Compare a SPEC de correcoes de seguranca. Identifique lacunas, inconsistencias e oportunidades de enriquecimento. ` +
      `Verifique se cada finding tem criterios de aceite claros e implementaveis. ` +
      `Apresente sugestoes, discuta com o usuario e edite ${specPath} diretamente usando Write ou Edit apos aprovacao.\n\n` +
      `## Mensagem do usuario\n${message}`
    : message;

  const phase7Acc = { text: '', completed: false };
  const result = await ctx.spawnAgent(SPEC_ENRICHER_ID, prompt, {
    projectId,
    phaseNumber: 7,
    cwd: projectPath,
    docsDir: docsCtxSec7?.docsDir,
    abortController: state.abortController,
    continueSession: sessionEntry.alive,
    // SC-1 (Pilar C): prompt de retomada para retry de sessao Codex ceifada.
    rebuildPromptOnRetry: () =>
      buildCodexResumePrompt({
        projectId,
        phaseNumber: 7,
        preamble:
          `## Arquivo da SPEC de seguranca\nCaminho: ${specPath}\n\n` +
          `## Instrucao importante\n` +
          `Compare a SPEC de correcoes de seguranca. Identifique lacunas, inconsistencias e oportunidades de enriquecimento. ` +
          `Apresente sugestoes, discuta com o usuario e edite ${specPath} diretamente usando Write ou Edit apos aprovacao.`,
        userMessage: message,
      }),
    onText: ctx.makeConversationOnText(projectId, 7, phase7Acc),
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 7, type: 'tool_call', tool: toolName });
    },
  });

  sessionEntry.alive = true;
  ctx.accumulateMetrics(state, 7, result);

  if (fs.existsSync(specPath)) {
    const currentContent = fs.readFileSync(specPath, 'utf-8');
    if (currentContent !== previousSpecContent) {
      emitIPC('pipeline:document-updated', { projectId, path: specPath, content: currentContent });
    }
  }

  const cleanedText = phase7Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (cleanedText) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 7 }, 'assistant', cleanedText);
  }

  emitIPC('pipeline:agent-completed', { projectId });
  emitPipelineStream({ projectId, phase: 7, type: 'done' });
}

// -------------------------------------------------------------------------
// Security Phase 9: Sprint Validator conversation
// -------------------------------------------------------------------------

export async function handleSecurityPhase9Message(
  ctx: PipelineEngineContext,
  projectId: string,
  message: string,
  state: HandlerPhaseState,
  project: ReturnType<typeof getHarnessProject> & object,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  const sessionKey = 'security-phase9';
  let sessionEntry = state.continueSessions.get(sessionKey);
  if (!sessionEntry) {
    sessionEntry = { alive: false };
    state.continueSessions.set(sessionKey, sessionEntry);
  }

  const docsCtxSec9 = getPipelineDocsContext(projectPath, (project as { pipelineDocsId?: string | null }).pipelineDocsId ?? null);
  const specPath = (project as { specPath?: string }).specPath || (docsCtxSec9
    ? docsCtxSec9.resolveDocPath('SPEC.md')
    : path.join(projectPath, 'SPEC.md'));
  const sprintsPath = findHarnessSprintsReadPath({
    id: (project as { id: string }).id,
    projectPath,
    pipelineDocsId: (project as { pipelineDocsId?: string | null }).pipelineDocsId ?? null,
    sprintsJsonPath: (project as { sprintsJsonPath?: string }).sprintsJsonPath,
  }) ?? resolveHarnessSprintsPath({
    id: (project as { id: string }).id,
    projectPath,
    pipelineDocsId: (project as { pipelineDocsId?: string | null }).pipelineDocsId ?? null,
  });
  const reportPath = docsCtxSec9
    ? docsCtxSec9.resolveDocPath('sprint-validation.md')
    : path.join(projectPath, '.sprint-validation-report.md');

  const isFirstTurn = !sessionEntry.alive;
  const previousSprintsContent = fs.existsSync(sprintsPath) ? fs.readFileSync(sprintsPath, 'utf-8') : '';

  const prompt = isFirstTurn
    ? `## Arquivo de relatorio persistente\nCaminho: ${reportPath}\n\n` +
      `## SPEC de correcoes de seguranca\nCaminho: ${specPath}\n\n` +
      `## Plano de Sprints\nCaminho: ${sprintsPath}\n\n` +
      `## Instrucao principal\n` +
      `Compare a SPEC com as sprints geradas. Verifique se cada finding de seguranca esta coberto por ao menos uma sprint. ` +
      `Sugira ajustes. Apos concordancia com o usuario, edite o arquivo de sprints diretamente em ${sprintsPath}.\n\n` +
      `## Mensagem do usuario\n${message}`
    : message;

  const phase9Acc = { text: '', completed: false };
  const result = await ctx.spawnAgent(SPRINT_VALIDATOR_ID, prompt, {
    projectId,
    phaseNumber: 9,
    cwd: projectPath,
    abortController: state.abortController,
    continueSession: sessionEntry.alive,
    docsDir: docsCtxSec9?.docsDir,
    // SC-1 (Pilar C): prompt de retomada para retry de sessao Codex ceifada.
    rebuildPromptOnRetry: () =>
      buildCodexResumePrompt({
        projectId,
        phaseNumber: 9,
        preamble:
          `## Arquivo de relatorio persistente\nCaminho: ${reportPath}\n\n` +
          `## SPEC de correcoes de seguranca\nCaminho: ${specPath}\n\n` +
          `## Plano de Sprints\nCaminho: ${sprintsPath}\n\n` +
          `## Instrucao principal\n` +
          `Compare a SPEC com as sprints geradas. Verifique se cada finding de seguranca esta coberto por ao menos uma sprint. ` +
          `Sugira ajustes. Apos concordancia com o usuario, edite o arquivo de sprints diretamente em ${sprintsPath}.`,
        userMessage: message,
      }),
    onText: ctx.makeConversationOnText(projectId, 9, phase9Acc),
    onToolUse: (toolName) => {
      emitPipelineStream({ projectId, phase: 9, type: 'tool_call', tool: toolName });
    },
  });

  sessionEntry.alive = true;
  ctx.accumulateMetrics(state, 9, result);

  if (fs.existsSync(sprintsPath)) {
    const currentContent = fs.readFileSync(sprintsPath, 'utf-8');
    if (currentContent !== previousSprintsContent) {
      emitIPC('pipeline:document-updated', { projectId, path: sprintsPath, content: currentContent });
    }
  }

  const cleanedText = phase9Acc.text.replace(ctx.PHASE_COMPLETE_MARKER, '').trim();
  if (cleanedText) {
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: 9 }, 'assistant', cleanedText);
  }

  emitIPC('pipeline:agent-completed', { projectId });
  emitPipelineStream({ projectId, phase: 9, type: 'done' });
}

// -------------------------------------------------------------------------
// Resolution Tracker (security post-pipeline): re-scan the consolidated
// Security report after sprints land and classify each finding as resolved /
// partially_resolved / unresolved. Fire-and-forget from acceptSprint /
// rejectSprint (8A.5: body moved here verbatim, this.X -> ctx.X).
// -------------------------------------------------------------------------

export async function runResolutionTracker(
  ctx: PipelineEngineContext,
  projectId: string,
  project: ResolvedHarnessProject,
): Promise<void> {
  const projectPath = (project as { projectPath: string }).projectPath;
  logger.info({ projectId }, 'Resolution Tracker: starting post-pipeline scan');

  // Find the original Security-*.md consolidated report
  const securityDir = path.join(projectPath, '.lionclaw', 'Security');
  const consolidatedFiles = fs.existsSync(securityDir)
    ? fs.readdirSync(securityDir).filter((f) => /^Security-\d{8}-\d{4}\.md$/.test(f)).sort()
    : [];
  const securityReportPath = consolidatedFiles.length > 0
    ? path.join(securityDir, consolidatedFiles[consolidatedFiles.length - 1]!)
    : null;

  if (!securityReportPath) {
    logger.warn({ projectId }, 'Resolution Tracker: no Security report found — skipping');
    return;
  }

  const scanIdMatch = securityReportPath.match(/Security-(\d{8}-\d{4})\.md$/);
  const scanId = scanIdMatch ? scanIdMatch[1] : 'unknown';
  const outputPath = path.join(securityDir, `SecurityScan-${scanId}.json`);

  const prompt =
    `Voce e o Resolution Tracker de seguranca. Seu trabalho e verificar se os findings do relatorio de seguranca foram corrigidos.\n\n` +
    `Relatorio original: ${securityReportPath}\n` +
    `Diretorio do projeto: ${projectPath}\n\n` +
    `Para cada finding no relatorio:\n` +
    `1. Leia o(s) arquivo(s) mencionados no finding\n` +
    `2. Verifique se o problema foi corrigido\n` +
    `3. Classifique como: resolved, partially_resolved, ou unresolved\n\n` +
    `Gere um arquivo JSON em: ${outputPath}\n` +
    `Formato do JSON:\n` +
    `{\n` +
    `  "id": "${scanId}",\n` +
    `  "project": "${projectPath}",\n` +
    `  "date": "<ISO timestamp>",\n` +
    `  "totalFindings": <number>,\n` +
    `  "resolved": <number>,\n` +
    `  "partiallyResolved": <number>,\n` +
    `  "unresolved": <number>,\n` +
    `  "findings": [\n` +
    `    { "findingId": "CRITICO-001", "title": "...", "severity": "CRITICO", "files": ["..."], "status": "resolved", "resolution": "..." },\n` +
    `    ...\n` +
    `  ]\n` +
    `}`;

  const trackerAbort = new AbortController();
  let trackerOutput = '';

  try {
    await ctx.spawnAgent(RESOLUTION_TRACKER_ID, prompt, {
      projectId,
      phaseNumber: 0, // Not a formal phase
      cwd: projectPath,
      abortController: trackerAbort,
      onText: (chunk) => {
        trackerOutput += chunk;
      },
    });
  } catch (err) {
    rethrowPipelinePause(err);
    logger.error({ err, projectId }, 'Resolution Tracker: agent failed');
    emitIPC('pipeline:resolution-tracker-complete', {
      projectId,
      success: false,
      error: (err as Error).message,
    });
    return;
  }

  // Parse summary from generated JSON
  let summary: { resolved: number; partiallyResolved: number; unresolved: number } = {
    resolved: 0,
    partiallyResolved: 0,
    unresolved: 0,
  };

  try {
    if (fs.existsSync(outputPath)) {
      const jsonContent = JSON.parse(fs.readFileSync(outputPath, 'utf-8')) as {
        resolved?: number;
        partiallyResolved?: number;
        unresolved?: number;
      };
      summary = {
        resolved: jsonContent.resolved ?? 0,
        partiallyResolved: jsonContent.partiallyResolved ?? 0,
        unresolved: jsonContent.unresolved ?? 0,
      };
    }
  } catch {
    logger.warn({ projectId, outputPath }, 'Resolution Tracker: failed to parse JSON output');
  }

  // Write Site 3: persist resolved / partiallyResolved / unresolved in metadata.
  try {
    patchSecuritySummaryJson(projectId, {
      resolved: summary.resolved,
      partiallyResolved: summary.partiallyResolved,
      unresolved: summary.unresolved,
    });
    logger.info({ projectId, summary }, 'SecuritySummary: resolution fields written after tracker');
  } catch (err) {
    logger.warn({ err, projectId }, 'SecuritySummary: failed to write resolution fields, skipping');
  }

  // The authoritative record is the SecurityScan-{id}.json on disk.
  // Emit the summary in the IPC event so the frontend can update its store.
  logger.info({ projectId, summary, outputPath }, 'Resolution Tracker: completed');

  emitIPC('pipeline:resolution-tracker-complete', {
    projectId,
    success: true,
    outputPath,
    summary,
  });
}
