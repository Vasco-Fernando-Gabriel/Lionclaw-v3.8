export type ClearingPhase = 'settling' | 'queued' | 'running' | 'interrupted';

export interface ClearingSessionEntry {
  phase: ClearingPhase;
  laneBadge: number | null;
}

export const clearingSessions = new Map<string, ClearingSessionEntry>();

export function isSessionClearing(sessionId: string): boolean {
  return clearingSessions.has(sessionId);
}

export function getClearingPhase(sessionId: string): ClearingPhase | null {
  return clearingSessions.get(sessionId)?.phase ?? null;
}

export function markSessionClearing(sessionId: string, phase: ClearingPhase, laneBadge: number | null): void {
  clearingSessions.set(sessionId, { phase, laneBadge });
}

export function setClearingPhase(sessionId: string, phase: ClearingPhase): void {
  const entry = clearingSessions.get(sessionId);
  if (!entry) return;
  clearingSessions.set(sessionId, { ...entry, phase });
}

export function unmarkSessionClearing(sessionId: string): void {
  clearingSessions.delete(sessionId);
}

export function listReservedClearingBadges(): number[] {
  const badges: number[] = [];
  for (const entry of clearingSessions.values()) {
    if (entry.laneBadge !== null) badges.push(entry.laneBadge);
  }
  return badges;
}
