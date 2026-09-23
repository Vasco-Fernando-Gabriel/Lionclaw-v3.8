import { emitIPC } from './ipc-emitter';
import { updateHarnessProject } from '../db';
import { createLogger } from '../logger';

const logger = createLogger('status-helper');

export type { HarnessProjectStatus } from '../../../src/types';
import type { HarnessProjectStatus } from '../../../src/types';

export type UIStatus = HarnessProjectStatus | 'streaming' | 'awaiting-user' | 'pipeline-completed';

export function deriveUIStatus(
  domain: HarnessProjectStatus,
  flags: {
    isStreaming?: boolean;
    awaitingUser?: boolean;
    pipelineComplete?: boolean;
  },
): UIStatus {
  if (flags.pipelineComplete) return 'pipeline-completed';
  if (flags.isStreaming) return 'streaming';
  if (flags.awaitingUser) return 'awaiting-user';
  return domain;
}

export function setProjectStatus(projectId: string, status: HarnessProjectStatus, opts?: { reason?: string }): void {
  updateHarnessProject(projectId, { status });
  emitIPC('pipeline:project-updated', {
    projectId,
    patch: { status },
  });
  logger.info({ projectId, status, ...(opts?.reason ? { reason: opts.reason } : {}) }, 'Project status changed');
}
