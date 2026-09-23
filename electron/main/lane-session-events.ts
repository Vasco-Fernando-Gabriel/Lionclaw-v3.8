import { createLogger } from './logger';

const logger = createLogger('lane-session-events');

export type LaneSessionUpdatedListener = (sessionId: string) => void;

let listener: LaneSessionUpdatedListener | null = null;

export function setLaneSessionUpdatedListener(next: LaneSessionUpdatedListener | null): void {
  listener = next;
}

export function notifyLaneSessionUpdated(sessionId: string): void {
  if (!listener) return;
  try {
    listener(sessionId);
  } catch (err) {
    logger.warn(
      { sessionId, err: err instanceof Error ? err.message : String(err) },
      'listener de chat:session-updated falhou (turno segue)',
    );
  }
}
