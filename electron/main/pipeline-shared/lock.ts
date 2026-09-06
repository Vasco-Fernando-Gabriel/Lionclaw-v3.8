
export interface ProjectLock {
  projectId: string;
  pipelineKind: 'pipeline-engine';
  acquiredAt: Date;
}

const activeLocks = new Map<string, ProjectLock>();

export type AcquireLockResult =
  | { ok: true; lock: ProjectLock }
  | { ok: false; runningPipeline: ProjectLock };

export function acquireProjectLock(
  projectId: string,
  kind: 'pipeline-engine' = 'pipeline-engine',
): AcquireLockResult {
  const existing = activeLocks.get(projectId);
  if (existing) return { ok: false, runningPipeline: existing };
  const lock: ProjectLock = { projectId, pipelineKind: kind, acquiredAt: new Date() };
  activeLocks.set(projectId, lock);
  return { ok: true, lock };
}

export function ensureProjectLock(
  projectId: string,
  kind: 'pipeline-engine' = 'pipeline-engine',
): { ok: true; lock: ProjectLock } {
  const existing = activeLocks.get(projectId);
  if (existing) return { ok: true, lock: existing };
  const lock: ProjectLock = { projectId, pipelineKind: kind, acquiredAt: new Date() };
  activeLocks.set(projectId, lock);
  return { ok: true, lock };
}

export function releaseProjectLock(projectId: string): void {
  activeLocks.delete(projectId);
}

export function isProjectLocked(projectId: string): boolean {
  return activeLocks.has(projectId);
}

export function listActiveProjectLocks(): ProjectLock[] {
  return [...activeLocks.values()];
}

export function _resetLocksForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error('_resetLocksForTesting can only be called in test environment');
  }
  activeLocks.clear();
}
