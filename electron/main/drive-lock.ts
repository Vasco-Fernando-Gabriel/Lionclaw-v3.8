export interface DriveLockEntry {
  projectId: string;
  sessionId: string;
  since: number;
}

export type AcquireDriveLockResult =
  | { ok: true; projectId: string; sessionId: string }
  | { ok: false; reason: 'lane_busy'; holderProjectId: string; sessionId: string }
  | { ok: false; reason: 'drive_owned_by_other_lane'; sessionId: string }
  | { ok: false; reason: 'drive_turn_in_flight' };

const locks = new Map<string, { sessionId: string; since: number }>();

export function acquireDriveLock(
  projectId: string,
  sessionId: string,
  opts?: { allowRebind?: boolean; turnInFlight?: boolean },
): AcquireDriveLockResult {
  const owned = locks.get(projectId);
  if (owned && owned.sessionId !== sessionId) {
    if (!opts?.allowRebind) {
      return { ok: false, reason: 'drive_owned_by_other_lane', sessionId: owned.sessionId };
    }
    if (opts.turnInFlight) {
      return { ok: false, reason: 'drive_turn_in_flight' };
    }
  }

  const holder = driveHolderOfSession(sessionId);
  if (holder !== null && holder !== projectId) {
    return { ok: false, reason: 'lane_busy', holderProjectId: holder, sessionId };
  }

  if (!owned || owned.sessionId !== sessionId) {
    locks.set(projectId, { sessionId, since: Date.now() });
  }
  return { ok: true, projectId, sessionId };
}

export function releaseDriveLock(projectId: string): void {
  locks.delete(projectId);
}

export function driveHolderOfSession(sessionId: string): string | null {
  for (const [projectId, entry] of locks) {
    if (entry.sessionId === sessionId) return projectId;
  }
  return null;
}

export function driveOwnerOfProject(projectId: string): string | null {
  return locks.get(projectId)?.sessionId ?? null;
}

export function hasAnyActiveDrive(): boolean {
  return locks.size > 0;
}

export function listDriveLocks(): DriveLockEntry[] {
  return [...locks.entries()].map(([projectId, entry]) => ({
    projectId,
    sessionId: entry.sessionId,
    since: entry.since,
  }));
}

export function _resetDriveLockForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error('_resetDriveLockForTesting can only be called in test environment');
  }
  locks.clear();
}
