
import { createLogger } from './logger';
import type { HarnessConfig, HarnessProject } from '../../src/types';
import {
  insertHarnessProject,
  updateHarnessProject,
  updateHarnessProjectPipelineMeta,
} from './db';
import {
  generatePipelineDocsId,
  getPipelineDocsContext,
  migrateHarnessSprintsToPipelineDocs,
} from './pipeline-paths';

const logger = createLogger('pipeline-create');

export type CreatablePipelineType =
  | 'development'
  | 'development-v2'
  | 'security'
  | 'feature'
  | 'architecture-review'
  | 'bug';

export interface CreatePipelineProjectParams {
  name: string;
  description?: string;
  projectPath: string;
  startPhase: number;
  specPath?: string;
  prdPath?: string;
  pipelineType?: CreatablePipelineType;
}

export function createPipelineProject(
  params: CreatePipelineProjectParams,
): HarnessProject {
  const resolvedType = params.pipelineType ?? 'development';
  const needsDocsId =
    resolvedType === 'feature' ||
    resolvedType === 'security' ||
    resolvedType === 'development-v2';
  const pipelineDocsId = needsDocsId ? generatePipelineDocsId() : null;

  const baseConfig: HarnessConfig = {
    maxRoundsPerSprint: 3,
    usePlaywright: false,
    evaluatorAgentId: 'harness-evaluator',
    plannerAgentId: 'harness-planner',
    stack: [],
  };

  if (resolvedType === 'development-v2' && pipelineDocsId) {
    baseConfig.openDesign = {
      enabled: true,
      runId: pipelineDocsId,
      pipelineDocsId,
    };
  }

  const project = insertHarnessProject({
    name: params.name,
    description: params.description ?? '',
    projectPath: params.projectPath,
    specPath: params.specPath ?? '',
    config: baseConfig,
    pipelineType: resolvedType,
    pipelineDocsId,
  });

  if (pipelineDocsId) {
    const sprintsMigration = migrateHarnessSprintsToPipelineDocs(
      project,
      pipelineDocsId,
    );
    if (sprintsMigration.status !== 'source-missing') {
      updateHarnessProject(project.id, {
        sprintsJsonPath: sprintsMigration.pathToPersist,
      });
    }
    logger.info(
      { projectId: project.id, pipelineDocsId, sprintsMigration },
      'createPipelineProject applied sprints path migration/registration',
    );
  }

  updateHarnessProjectPipelineMeta(project.id, {
    pipelineStartPhase: params.startPhase,
    pipelineCurrentPhase: params.startPhase,
    prdPath: params.prdPath ?? null,
    status: 'idle',
  });

  getPipelineDocsContext(params.projectPath, pipelineDocsId);

  return project;
}
