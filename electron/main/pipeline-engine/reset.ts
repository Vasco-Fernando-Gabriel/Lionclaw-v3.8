
import * as fs from 'fs';
import { createLogger } from '../logger';
import { emitIPC } from '../pipeline-shared/ipc-emitter';
import { releaseProjectLock } from '../pipeline-shared/lock';
import {
  getHarnessProject,
  updateHarnessProject,
  getHarnessSprints,
  getHarnessSprintByIndex,
  deletePipelineMessagesFromPhase,
  deletePipelinePhaseMetricsFromPhase,
  deletePipelineMessagesForSprint,
  deletePipelinePhaseMetricsForSprint,
  deleteHarnessRoundsForSprint,
  carryHarnessRoundSessionIdsForSprint,
  resetHarnessSprintStatus,
  deleteHarnessSprintsForProject,
  countPipelineMessagesFromPhase,
  countPipelinePhaseMetricsFromPhase,
  countPipelineMessagesForSprint,
  countPipelinePhaseMetricsForSprint,
  deleteBugAnalysisAgentStatuses,
} from '../db';
import { generatePipelineDocsId } from '../pipeline-paths';
import { getArchitectureReviewContext } from '../architecture-review-paths';
import { getBugContext } from '../bug-paths';
import { wipeOpenDesign } from '../open-design/full-wipe';
import {
  getResetablePhases,
  getPhaseArtifactMap,
  getAutoPhases,
  getPhaseNumberForAgent,
} from './registry';
import { resolveExecutorFiles, resolvePreviewFiles } from './artifact-resolver';

const logger = createLogger('pipeline-engine');

export interface ResetEngineContext {
  getState(projectId: string): ResetPhaseState;
  updateProjectColumns(
    projectId: string,
    columns: {
      pipelineCurrentPhase?: number | null;
      status?: string;
      pipelineSprintIndex?: number;
    },
  ): void;
  runAutoPhase(projectId: string, phase: number): Promise<void>;
  runSprint(projectId: string, sprintIndex: number): Promise<void>;
}

export interface ResetPhaseState {
  abortController: AbortController;
  status: string;
  currentPhase: number;
  currentSprintIndex: number;
  continueSessions: Map<string, unknown>;
  codexSessions: Map<string, unknown>;
  phaseMetricAccum: Map<number, unknown>;
}

export interface ResetPreview {
  filesToDelete: string[];
  messagesToDelete: number;
  metricsToDelete: number;
  sprintsAffected: number[];
}


export async function resetPhase(
  ctx: ResetEngineContext,
  projectId: string,
  phase: number,
): Promise<{ ok: boolean; error?: string }> {
  const project = getHarnessProject(projectId);
  if (!project) return { ok: false, error: 'Project not found' };

  const resetablePhases = getResetablePhases(project);
  if (!resetablePhases.has(phase)) {
    return { ok: false, error: `Phase ${phase} is not resetable` };
  }

  const state = ctx.getState(projectId);

  if (state.abortController && !state.abortController.signal.aborted) {
    state.abortController.abort();
  }

  state.continueSessions.clear();

  state.codexSessions.clear();

  for (const [phaseNum] of state.phaseMetricAccum) {
    if (phaseNum >= phase) {
      state.phaseMetricAccum.delete(phaseNum);
    }
  }

  state.abortController = new AbortController();
  state.status = 'idle';
  state.currentPhase = phase;

  if (
    phase === 1 &&
    (project.pipelineType === 'feature' || project.pipelineType === 'security') &&
    project.pipelineDocsId
  ) {
    const oldDocsId = project.pipelineDocsId;
    const newDocsId = generatePipelineDocsId();
    updateHarnessProject(projectId, {
      pipelineDocsId: newDocsId,
      specPath: null,
      prdPath: null,
      sprintsJsonPath: null,
    } as never);
    logger.info(
      { projectId, oldDocsId, newDocsId, pipelineType: project.pipelineType },
      'Total pipeline reset: rotated pipelineDocsId, old docs folder preserved',
    );
  }

  const mapping = getPhaseArtifactMap(phase, project);
  if (!mapping) {
    return { ok: false, error: `No artifact map for phase ${phase}` };
  }

  if (project.pipelineType === 'architecture-review') {
    const ctxArch = getArchitectureReviewContext(project);
    if (ctxArch) {
      if (mapping.files.includes('*')) {
        try {
          fs.rmSync(ctxArch.runDir, { recursive: true, force: true });
          logger.info({ projectId, runDir: ctxArch.runDir }, 'Architecture reset phase 1: deleted runDir');
        } catch (err) {
          logger.warn({ err, projectId, runDir: ctxArch.runDir }, 'Failed to delete architecture runDir');
        }
        updateHarnessProject(projectId, {
          specPath: '',
          sprintsJsonPath: null,
          config: {
            ...project.config,
            architectureReview: {
              selectedCandidateId: null,
            },
          },
        });
      } else {
        const filesToDelete = resolveExecutorFiles(
          { projectPath: project.projectPath, pipelineType: project.pipelineType },
          mapping,
          ctxArch,
        );
        for (const p of filesToDelete) {
          try {
            fs.rmSync(p, { force: true });
          } catch {
          }
        }
        if (mapping.files.includes('SPEC')) {
          updateHarnessProject(projectId, { specPath: '' });
        }
      }
    }
  } else if (project.pipelineType === 'bug') {
    const ctxBug = getBugContext(project);
    if (ctxBug) {
      if (mapping.files.includes('*')) {
        try {
          fs.rmSync(ctxBug.runDir, { recursive: true, force: true });
          logger.info({ projectId, runDir: ctxBug.runDir }, 'Bug reset phase 1: deleted runDir');
        } catch (err) {
          logger.warn({ err, projectId, runDir: ctxBug.runDir }, 'Failed to delete bug runDir');
        }
        updateHarnessProject(projectId, {
          specPath: '',
          sprintsJsonPath: null,
          config: {
            ...project.config,
            bug: {
              outcome: 'pending',
            },
          },
        });
      } else {
        const filesToDelete = resolveExecutorFiles(
          { projectPath: project.projectPath, pipelineType: project.pipelineType },
          mapping,
          ctxBug,
        );
        for (const p of filesToDelete) {
          try {
            fs.rmSync(p, { force: true });
          } catch {
          }
        }
        if (mapping.files.includes('SPEC')) {
          updateHarnessProject(projectId, { specPath: '' });
        }
      }
    }
    if (phase === 1 || phase === 2) {
      deleteBugAnalysisAgentStatuses(projectId);
    }
  } else {
    const filesToDelete = resolveExecutorFiles(
      { projectPath: project.projectPath, pipelineType: project.pipelineType },
      mapping,
      null,
    );
    for (const fullPath of filesToDelete) {
      try {
        fs.rmSync(fullPath, { force: true });
      } catch {
      }
    }
  }

  if (project.pipelineType === 'development-v2' && phase === 5) {
    const wipe = await wipeOpenDesign(projectId);
    if ('error' in wipe) {
      logger.error({ projectId, error: wipe.error }, '[dev-v2] reset fase 5: wipeOpenDesign falhou (continuando o reset do DB)');
    }
  }

  deletePipelineMessagesFromPhase(projectId, mapping.fromPhase);
  deletePipelinePhaseMetricsFromPhase(projectId, mapping.fromPhase);
  if (mapping.wipeSprints) {
    deleteHarnessSprintsForProject(projectId);
  }

  ctx.updateProjectColumns(projectId, {
    pipelineCurrentPhase: phase,
    status: 'idle',
  });

  logger.info({ projectId, phase, pipelineType: project.pipelineType }, 'Pipeline reset to phase');

  emitIPC('pipeline:reset-complete', { projectId, phase });

  const autoPhases = getAutoPhases(project);
  if (autoPhases.has(phase)) {
    void ctx.runAutoPhase(projectId, phase).catch((err) => {
      logger.error(
        { err, projectId, phase },
        'Background runAutoPhase after resetPhase failed',
      );
      releaseProjectLock(projectId);
      emitIPC('pipeline:error', {
        projectId,
        phase,
        error: (err as Error).message,
      });
    });
  }

  return { ok: true };
}


export async function resetSprint(
  ctx: ResetEngineContext,
  projectId: string,
  sprintIndex: number,
): Promise<{ ok: boolean; error?: string }> {
  const sprint = getHarnessSprintByIndex(projectId, sprintIndex);
  if (!sprint) {
    return { ok: false, error: `Sprint ${sprintIndex} not found` };
  }

  const state = ctx.getState(projectId);

  if (state.currentSprintIndex === sprintIndex && !state.abortController.signal.aborted) {
    state.abortController.abort();
  }

  const carryProject = getHarnessProject(projectId);
  const carryCoderPhase = (carryProject ? getPhaseNumberForAgent(carryProject, 'harness-coder') : undefined)
    ?? (carryProject?.pipelineType === 'security' || carryProject?.pipelineType === 'architecture-review' ? 10 : 13);
  const carryEvaluatorPhase = (carryProject ? getPhaseNumberForAgent(carryProject, 'harness-evaluator') : undefined)
    ?? (carryProject?.pipelineType === 'security' || carryProject?.pipelineType === 'architecture-review' ? 11 : 14);
  carryHarnessRoundSessionIdsForSprint(projectId, sprintIndex, carryCoderPhase, carryEvaluatorPhase);

  deleteHarnessRoundsForSprint(projectId, sprintIndex);
  deletePipelineMessagesForSprint(projectId, sprintIndex);
  deletePipelinePhaseMetricsForSprint(projectId, sprintIndex);

  resetHarnessSprintStatus(projectId, sprintIndex);

  logger.info({ projectId, sprintIndex }, 'Sprint reset to pending');

  emitIPC('pipeline:sprint-reset', { projectId, sprintIndex });

  state.abortController = new AbortController();
  state.status = 'running';

  const resetSprintProject = getHarnessProject(projectId);
  const resetCoderPhase = (resetSprintProject ? getPhaseNumberForAgent(resetSprintProject, 'harness-coder') : undefined) ?? 13;

  ctx.updateProjectColumns(projectId, {
    pipelineCurrentPhase: resetCoderPhase,
    pipelineSprintIndex: sprintIndex,
    status: 'running',
  });

  const allSprints = getHarnessSprints(projectId);
  const nextPending = allSprints.find((s) => s.status === 'pending');
  if (nextPending) {
    void ctx.runSprint(projectId, nextPending.sprintIndex).catch((err) => {
      logger.error(
        { err, projectId, sprintIndex: nextPending.sprintIndex },
        'Background runSprint after resetSprint failed',
      );
      emitIPC('pipeline:error', {
        projectId,
        phase: resetCoderPhase,
        error: (err as Error).message,
      });
    });
  }

  return { ok: true };
}


export function getResetPreview(
  _ctx: ResetEngineContext,
  projectId: string,
  target: { phase?: number; sprintIndex?: number },
): ResetPreview {
  const empty: ResetPreview = {
    filesToDelete: [],
    messagesToDelete: 0,
    metricsToDelete: 0,
    sprintsAffected: [],
  };

  const project = getHarnessProject(projectId);
  if (!project) return empty;

  if (target.phase !== undefined) {
    const mapping = getPhaseArtifactMap(target.phase, project);
    if (!mapping) return empty;

    const typeCtx =
      project.pipelineType === 'architecture-review'
        ? getArchitectureReviewContext(project)
        : project.pipelineType === 'bug'
          ? getBugContext(project)
          : null;
    const filesToDelete = resolvePreviewFiles(
      { projectPath: project.projectPath, pipelineType: project.pipelineType },
      mapping,
      typeCtx,
    ).filter((f) => fs.existsSync(f));

    const messagesToDelete = countPipelineMessagesFromPhase(projectId, mapping.fromPhase);
    const metricsToDelete = countPipelinePhaseMetricsFromPhase(projectId, mapping.fromPhase);

    const sprintsAffected = mapping.wipeSprints
      ? getHarnessSprints(projectId).map((s) => s.sprintIndex)
      : [];

    return {
      filesToDelete,
      messagesToDelete,
      metricsToDelete,
      sprintsAffected,
    };
  }

  if (target.sprintIndex !== undefined) {
    const si = target.sprintIndex;

    const messagesToDelete = countPipelineMessagesForSprint(projectId, si);
    const metricsToDelete = countPipelinePhaseMetricsForSprint(projectId, si);

    return {
      filesToDelete: [],
      messagesToDelete,
      metricsToDelete,
      sprintsAffected: [si],
    };
  }

  return empty;
}
