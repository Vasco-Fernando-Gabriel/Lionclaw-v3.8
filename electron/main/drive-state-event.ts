import { getDriveSessionId, getOpenLaneSessionById } from './db';
import type { DriveState, DriveStateChangedEvent } from '../../src/types';

export function buildDriveStateChangedEvent(projectId: string, drive: DriveState | null): DriveStateChangedEvent {
  if (!drive) {
    return { projectId, drive: null, sessionId: null, laneBadge: null };
  }
  const sessionId = getDriveSessionId(projectId);
  const laneBadge = sessionId ? (getOpenLaneSessionById(sessionId)?.laneBadge ?? null) : null;
  return { projectId, drive, sessionId, laneBadge };
}
