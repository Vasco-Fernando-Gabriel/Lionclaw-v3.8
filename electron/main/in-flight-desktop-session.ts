const inFlightDesktopSessions = new Set<string>();

const inFlightDesktopTurns = new Map<string, Promise<void>>();

export function markDesktopSessionInFlight(sessionId: string, inFlight: boolean): void {
  if (inFlight) inFlightDesktopSessions.add(sessionId);
  else inFlightDesktopSessions.delete(sessionId);
}

export function getInFlightDesktopSessions(): string[] {
  return [...inFlightDesktopSessions];
}

export function isDesktopSessionInFlight(sessionId: string): boolean {
  return inFlightDesktopSessions.has(sessionId);
}

export function setInFlightDesktopTurn(sessionId: string, turn: Promise<unknown>): void {
  inFlightDesktopTurns.set(
    sessionId,
    turn.then(
      () => undefined,
      () => undefined,
    ),
  );
}

export function clearInFlightDesktopTurn(sessionId: string): void {
  inFlightDesktopTurns.delete(sessionId);
}

export function getInFlightDesktopTurn(sessionId: string): Promise<void> | null {
  return inFlightDesktopTurns.get(sessionId) ?? null;
}

export function resetInFlightDesktopSessionsForTests(): void {
  inFlightDesktopSessions.clear();
  inFlightDesktopTurns.clear();
}
