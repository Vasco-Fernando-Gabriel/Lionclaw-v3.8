import type { HarnessProject } from '../../../src/types';
import type { PipelineType } from '../../../src/types/pipeline';

export interface PipelineProjectBase {
  id: string;
  name: string;
  projectPath: string;
  specPath: string;
  status: 'idle' | 'running' | 'paused' | 'done' | 'failed' | 'aborted' | 'interrupted';
  currentPhase: number | null;
  pipelineType: PipelineType;
  createdAt: string;
  updatedAt: string;
}

type HarnessProjectRow = HarnessProject & {
  pipelineCurrentPhase?: number | null;
};

export function mapPipelineProject(p: HarnessProjectRow): PipelineProjectBase {
  return {
    id: p.id,
    name: p.name,
    projectPath: p.projectPath,
    specPath: p.specPath,
    status: p.status as PipelineProjectBase['status'],
    currentPhase: (p.pipelineCurrentPhase ?? null) as number | null,
    pipelineType: (p.pipelineType ?? 'development') as PipelineProjectBase['pipelineType'],
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
