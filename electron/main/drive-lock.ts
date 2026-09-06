
let _activeDriveProjectId: string | null = null;

export type AcquireDriveLockResult =
  | { ok: true; projectId: string }
  | { ok: false; activeProjectId: string };

export function acquireDriveLock(projectId: string): AcquireDriveLockResult {
  if (_activeDriveProjectId !== null && _activeDriveProjectId !== projectId) {
    return { ok: false, activeProjectId: _activeDriveProjectId };
  }
  _activeDriveProjectId = projectId;
  return { ok: true, projectId };
}

export function releaseDriveLock(): void {
  _activeDriveProjectId = null;
}

export function activeDriveProjectId(): string | null {
  return _activeDriveProjectId;
}

export function _resetDriveLockForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error(
      '_resetDriveLockForTesting can only be called in test environment',
    );
  }
  _activeDriveProjectId = null;
}
