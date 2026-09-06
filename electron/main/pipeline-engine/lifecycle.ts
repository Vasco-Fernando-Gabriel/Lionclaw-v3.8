
import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger';
import { emitIPC } from '../pipeline-shared/ipc-emitter';
import { emitPipelineStream } from './stream';
import { setProjectStatus } from '../pipeline-shared/status';
import { persistHarnessRound } from '../pipeline-shared/persist';
import { ensureProjectLock, releaseProjectLock } from '../pipeline-shared/lock';
import {
  getHarnessProject,
  savePipelinePhaseMetrics,
  getHarnessSprints,
  getMostRecentInProgressRoundId,
  getRunningPipelineProjectIds,
  getStaleRunningPhaseMetrics,
  markPhaseMetricInterrupted,
} from '../db';
import { getPipelineDocsContext } from '../pipeline-paths';
import { runUsageSanityCheck } from './usage-sanity';
import {
  getAutoPhases,
  getLoopPhases,
  getPhaseName,
  getMaxPhase,
  PHASE_NAMES,
} from './registry';

const logger = createLogger('pipeline-engine');

export interface LifecyclePhaseState {
  abortController: AbortController;
  status: 'idle' | 'running' | 'paused' | 'aborted';
  currentPhase: number;
  currentSprintIndex: number;
  discoveryBlock: number;
}

export interface LifecycleEngineContext {
  getState(projectId: string): LifecyclePhaseState;
  updateProjectColumns(
    projectId: string,
    columns: {
      pipelineCurrentPhase?: number | null;
      status?: string;
      pipelineSprintIndex?: number;
      discoveryNotesPath?: string | null;
    },
  ): void;
  closeCodexSessions(state: LifecyclePhaseState): void;
  isConversationPhase(phase: number, project?: { pipelineType?: string }): boolean;
  resolveCurrentModelForPhase(
    project: { pipelineType?: string; id: string } & object,
    phaseNumber: number,
    sprintIndex?: number,
  ): string | null;
  getConversationGreeting(phase: number, projectName: string, project?: { pipelineType?: string; projectPath?: string; pipelineDocsId?: string | null }): string;
  runAutoPhase(projectId: string, phase: number): Promise<void>;
  runSprint(projectId: string, sprintIndex: number): Promise<void>;
  sendMessage(
    projectId: string,
    message: string,
    opts?: { isGreeting?: boolean },
  ): Promise<{ error: string } | void>;
  abortHarness(projectId: string): void;
}


export interface CompletePipelineOptions {
  terminalStatusString: 'completed' | 'pipeline-completed';
  setStateIdle: boolean;
  metadata?: Record<string, unknown>;
  onCompleted?: () => void;
}

export function completePipeline(
  ctx: LifecycleEngineContext,
  projectId: string,
  state: LifecyclePhaseState,
  opts: CompletePipelineOptions,
): void {
  ctx.closeCodexSessions(state);
  if (opts.setStateIdle) {
    state.status = 'idle';
  }
  ctx.updateProjectColumns(projectId, { status: 'done', pipelineCurrentPhase: null });
  releaseProjectLock(projectId);
  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: null,
    status: opts.terminalStatusString,
    awaitingUser: false,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  });

  if (opts.onCompleted) {
    opts.onCompleted();
  }

  try {
    void runUsageSanityCheck(projectId).catch((err) => {
      logger.warn({ err, projectId }, 'usage-sanity: check pos-pipeline falhou (ignorado)');
    });
  } catch (err) {
    logger.warn({ err, projectId }, 'usage-sanity: check pos-pipeline falhou (ignorado)');
  }
}


export type FailStatusUpdate =
  | 'pure-paused'
  | { columns: { status: string; pipelineCurrentPhase: number } };

export interface FailPhaseOptions {
  phase: number;
  phaseName?: string;
  errorMessage?: string;
  statusUpdate: FailStatusUpdate;
  emitError: boolean;
  emitPhaseChanged: boolean;
  emitStreamDone: boolean;
  setStateStatusPaused: boolean;
  errorFirst?: boolean;
}

export function failPhase(
  ctx: LifecycleEngineContext,
  projectId: string,
  state: LifecyclePhaseState,
  opts: FailPhaseOptions,
): void {
  const applyStatus = (): void => {
    if (opts.statusUpdate === 'pure-paused') {
      setProjectStatus(projectId, 'paused');
    } else {
      ctx.updateProjectColumns(projectId, {
        status: opts.statusUpdate.columns.status,
        pipelineCurrentPhase: opts.statusUpdate.columns.pipelineCurrentPhase,
      });
    }
  };

  if (opts.errorFirst) {
    if (opts.emitError) {
      emitIPC('pipeline:error', { projectId, phase: opts.phase, error: opts.errorMessage });
    }
    if (opts.setStateStatusPaused) {
      state.status = 'paused';
    }
    applyStatus();
  } else {
    applyStatus();
    if (opts.setStateStatusPaused) {
      state.status = 'paused';
    }
    if (opts.emitStreamDone) {
      emitPipelineStream({ projectId, phase: opts.phase, type: 'done' });
    }
    if (opts.emitError) {
      emitIPC('pipeline:error', { projectId, phase: opts.phase, error: opts.errorMessage });
    }
  }

  if (opts.emitPhaseChanged) {
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: opts.phase,
      ...(opts.phaseName !== undefined ? { phaseName: opts.phaseName } : {}),
      status: 'failed',
      awaitingUser: true,
    });
  }
}


export async function advanceToNextPhase(
  ctx: LifecycleEngineContext,
  projectId: string,
  state: LifecyclePhaseState,
): Promise<void> {
  if (state.abortController.signal.aborted || state.status === 'aborted') {
    return;
  }

  const advProject = getHarnessProject(projectId);
  const maxPhase = advProject ? getMaxPhase(advProject) : maxPhaseFallback();

  const nextPhase = state.currentPhase + 1;
  if (nextPhase > maxPhase) {
    completePipeline(ctx, projectId, state, {
      terminalStatusString: 'pipeline-completed',
      setStateIdle: false,
    });
    return;
  }


  state.currentPhase = nextPhase;
  state.status = 'running';
  ctx.updateProjectColumns(projectId, {
    pipelineCurrentPhase: nextPhase,
    status: 'running',
  });

  const isConversation = ctx.isConversationPhase(nextPhase, advProject ?? undefined);
  const nextPhaseName = (advProject ? getPhaseName(nextPhase, advProject) : PHASE_NAMES[nextPhase]) ?? `Phase ${nextPhase}`;

  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: nextPhase,
    phaseName: nextPhaseName,
    status: 'started',
    awaitingUser: isConversation,
    currentModel: advProject
      ? ctx.resolveCurrentModelForPhase(advProject, nextPhase, state.currentSprintIndex)
      : null,
  });

  const advAutoSet = getAutoPhases(advProject ?? {});
  const advLoopSet = getLoopPhases(advProject ?? {});

  if (advAutoSet.has(nextPhase)) {
    await ctx.runAutoPhase(projectId, nextPhase);
  } else if (advLoopSet.has(nextPhase)) {
    const sprintIndex = state.currentSprintIndex ?? 0;
    logger.info({ projectId, nextPhase, sprintIndex }, 'Auto-starting loop phase via runSprint');
    await ctx.runSprint(projectId, sprintIndex);
  } else if (isConversation) {
    const isDevV2OpenDesignPhase = advProject?.pipelineType === 'development-v2' && nextPhase === 5;
    if (isDevV2OpenDesignPhase) {
      logger.info({ projectId, nextPhase }, 'advanceToNextPhase: skipping greeting for dev-v2 phase 5 (UI dedicada)');
    } else {
      const greetingMsg = ctx.getConversationGreeting(nextPhase, advProject?.name ?? projectId, advProject ?? undefined);
      await ctx.sendMessage(projectId, greetingMsg, { isGreeting: true });
    }
  }
}


export async function advancePhase(
  ctx: LifecycleEngineContext,
  projectId: string,
): Promise<void> {
  const state = ctx.getState(projectId);

  if (state.status === 'aborted') {
    logger.warn({ projectId }, 'Cannot advance aborted pipeline');
    return;
  }

  const advancingProject = getHarnessProject(projectId);
  if (advancingProject?.pipelineType === 'feature' && state.currentPhase === 1) {
    try {
      const projectPath = advancingProject.projectPath;
      if (projectPath && fs.existsSync(projectPath)) {
        const docsCtx = getPipelineDocsContext(projectPath, advancingProject.pipelineDocsId ?? null);
        const searchDir = docsCtx ? docsCtx.docsDir : projectPath;
        const matches = fs.existsSync(searchDir)
          ? fs
              .readdirSync(searchDir)
              .filter((f) => f.startsWith('feature-discovery-notes-') && f.endsWith('.md'))
              .sort()
              .reverse()
          : [];
        if (matches.length > 0) {
          const notesPath = path.join(searchDir, matches[0]);
          ctx.updateProjectColumns(projectId, { discoveryNotesPath: notesPath });
          logger.info({ projectId, notesPath }, 'Detected feature-discovery-notes path');
        } else {
          if (docsCtx) {
            const canonicalPath = docsCtx.resolveDocPath('discovery.md');
            if (fs.existsSync(canonicalPath)) {
              ctx.updateProjectColumns(projectId, { discoveryNotesPath: canonicalPath });
              logger.info({ projectId, notesPath: canonicalPath }, 'Detected feature-discovery-notes path (canonical)');
            } else {
              logger.warn({ projectId, projectPath }, 'No feature-discovery-notes-*.md file found after phase 1');
            }
          } else {
            logger.warn({ projectId, projectPath }, 'No feature-discovery-notes-*.md file found in projectPath after phase 1');
          }
        }
      }
    } catch (err) {
      logger.warn({ err, projectId }, 'Failed to detect feature-discovery-notes path');
    }
  }

  const project = getHarnessProject(projectId);
  const maxPhase = project ? getMaxPhase(project) : maxPhaseFallback();

  const nextPhase = state.currentPhase + 1;
  if (nextPhase > maxPhase) {
    logger.info({ projectId }, 'Pipeline complete — no more phases');
    completePipeline(ctx, projectId, state, {
      terminalStatusString: 'completed',
      setStateIdle: false,
    });
    return;
  }

  logger.info({ projectId, nextPhase }, 'Advancing pipeline to next phase');


  state.currentPhase = nextPhase;
  ctx.updateProjectColumns(projectId, {
    pipelineCurrentPhase: nextPhase,
    status: 'running',
  });

  const isConversation = ctx.isConversationPhase(nextPhase, project ?? undefined);
  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: nextPhase,
    phaseName: (project ? getPhaseName(nextPhase, project) : PHASE_NAMES[nextPhase]) ?? `Phase ${nextPhase}`,
    status: 'started',
    awaitingUser: isConversation,
    currentModel: project ? ctx.resolveCurrentModelForPhase(project, nextPhase) : null,
  });

  const autoPhases = getAutoPhases(project ?? {});
  const loopPhases = getLoopPhases(project ?? {});

  if (autoPhases.has(nextPhase)) {
    await ctx.runAutoPhase(projectId, nextPhase);
  } else if (loopPhases.has(nextPhase)) {
    ensureProjectLock(projectId, 'pipeline-engine');
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: nextPhase,
      phaseName: (project ? getPhaseName(nextPhase, project) : PHASE_NAMES[nextPhase]) ?? `Phase ${nextPhase}`,
      status: 'loop-ready',
      awaitingUser: false,
      currentModel: project ? ctx.resolveCurrentModelForPhase(project, nextPhase) : null,
    });
  }
}


export function abortPipeline(ctx: LifecycleEngineContext, projectId: string): void {
  const state = ctx.getState(projectId);
  logger.info({ projectId, currentPhase: state.currentPhase }, 'Aborting pipeline');

  state.abortController.abort();
  state.status = 'aborted';

  {
    const abortProject = getHarnessProject(projectId);
    const loopSet = getLoopPhases(abortProject ?? {});
    if (state.currentPhase !== null && loopSet.has(state.currentPhase)) {
      try {
        ctx.abortHarness(projectId);
      } catch (err) {
        logger.warn({ err, projectId }, 'harnessEngine.abort during abort failed (non-fatal)');
      }
    }
  }

  releaseProjectLock(projectId);

  ctx.closeCodexSessions(state);

  setProjectStatus(projectId, 'aborted');

  emitIPC('pipeline:phase-changed', {
    projectId,
    phase: state.currentPhase,
    status: 'aborted',
    awaitingUser: false,
  });
}


export function pausePipeline(ctx: LifecycleEngineContext, projectId: string): void {
  const state = ctx.getState(projectId);
  logger.info({ projectId, currentPhase: state.currentPhase }, 'Pausing pipeline');

  if (!state.abortController.signal.aborted) {
    state.abortController.abort();
  }

  const phase = state.currentPhase;

  const pauseProject = getHarnessProject(projectId);
  const pauseLoopSet = getLoopPhases(pauseProject ?? {});
  const pauseAutoSet = getAutoPhases(pauseProject ?? {});

  if (phase !== null && pauseLoopSet.has(phase)) {
    try {
      ctx.abortHarness(projectId);
    } catch (err) {
      logger.warn({ err, projectId }, 'harnessEngine.abort during pause failed (non-fatal)');
    }
  }

  if (phase !== null && pauseAutoSet.has(phase)) {
    const phaseName = (pauseProject ? getPhaseName(phase, pauseProject) : PHASE_NAMES[phase]) ?? `Phase ${phase}`;
    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: phase,
      phaseName,
      status: 'interrupted',
      completedAt: new Date().toISOString(),
    });
  }

  if (phase !== null && pauseLoopSet.has(phase)) {
    const sprintIndex = state.currentSprintIndex ?? 0;
    const sprints = getHarnessSprints(projectId);
    const sprint = sprints[sprintIndex];
    if (sprint) {
      const roundId = getMostRecentInProgressRoundId(sprint.id);
      if (roundId) {
        persistHarnessRound.update(roundId, {
          completedAt: new Date().toISOString(),
        });
        logger.info({ projectId, sprintIndex, roundId }, 'Marked in-progress round as interrupted');
      }
    }
  }

  state.status = 'paused';
  setProjectStatus(projectId, 'paused');


  emitIPC('pipeline:phase-changed', {
    projectId,
    phase,
    status: 'paused',
    awaitingUser: false,
  });
}


export async function resumePipeline(ctx: LifecycleEngineContext, projectId: string): Promise<void> {
  const state = ctx.getState(projectId);

  if (state.status === 'aborted') {
    logger.warn({ projectId }, 'Cannot resume aborted pipeline');
    return;
  }

  if (state.status === 'running') {
    logger.warn({ projectId }, 'Pipeline already running, ignoring duplicate resume');
    return;
  }

  if (state.currentPhase === 0) {
    const project = getHarnessProject(projectId);
    if (project?.pipelineCurrentPhase && project.pipelineCurrentPhase > 0) {
      state.currentPhase = project.pipelineCurrentPhase;
      state.currentSprintIndex = project.pipelineSprintIndex ?? 0;
      state.discoveryBlock = project.pipelineDiscoveryBlock ?? 1;
      logger.info(
        {
          projectId,
          restoredPhase: state.currentPhase,
          sprintIndex: state.currentSprintIndex,
        },
        'Restored pipeline state from DB after app restart',
      );
    } else {
      logger.warn({ projectId }, 'Cannot resume pipeline: no phase found in DB');
      return;
    }
  }

  logger.info({ projectId, currentPhase: state.currentPhase }, 'Resuming pipeline');

  const phase = state.currentPhase;
  const resumeProject = getHarnessProject(projectId);
  const isConversation = ctx.isConversationPhase(phase, resumeProject ?? undefined);

  if (isConversation) {
    logger.info(
      { projectId, phase },
      'Resume no-op on conversation phase: awaiting user input (BUG-20)',
    );
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase,
      phaseName: (resumeProject ? getPhaseName(phase, resumeProject) : PHASE_NAMES[phase]) ?? `Phase ${phase}`,
      status: 'awaiting-input',
      awaitingUser: true,
    });
    return;
  }

  state.status = 'running';
  state.abortController = new AbortController();
  setProjectStatus(projectId, 'running');

  emitIPC('pipeline:phase-changed', {
    projectId,
    phase,
    phaseName: (resumeProject ? getPhaseName(phase, resumeProject) : PHASE_NAMES[phase]) ?? `Phase ${phase}`,
    status: 'resumed',
    awaitingUser: false,
  });

  const resumeAutoSet = getAutoPhases(resumeProject ?? {});
  const resumeLoopSet = getLoopPhases(resumeProject ?? {});

  if (resumeAutoSet.has(phase)) {
    await ctx.runAutoPhase(projectId, phase);
  } else if (resumeLoopSet.has(phase)) {
    const sprintIndex = state.currentSprintIndex ?? 0;
    logger.info({ projectId, phase, sprintIndex }, 'Resuming loop phase via runSprint');
    await ctx.runSprint(projectId, sprintIndex);
  }
}


export function recoverInterruptedPipelines(): void {
  try {
    const rows = getRunningPipelineProjectIds().map((id) => ({ id }));

    for (const row of rows) {
      logger.warn({ projectId: row.id }, 'Recovering interrupted pipeline — marking as interrupted');
      releaseProjectLock(row.id);
      setProjectStatus(row.id, 'interrupted');
      emitIPC('pipeline:phase-changed', {
        projectId: row.id,
        phase: null,
        status: 'interrupted',
        awaitingUser: true,
      });
    }

    const staleMetrics = getStaleRunningPhaseMetrics();

    for (const m of staleMetrics) {
      markPhaseMetricInterrupted(m.id);
      logger.warn(
        { projectId: m.projectId, phase: m.phaseNumber },
        'Recovering stale running phase metric — marking as interrupted',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Failed to recover interrupted pipelines');
  }
}

function maxPhaseFallback(): number {
  return getMaxPhase({ pipelineType: undefined });
}
