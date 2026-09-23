import { createLogger } from './logger';

const logger = createLogger('drive-usage-sink');

export interface DriveTurnUsage {
  sessionId: string;
  projectId: string;
  driveTurnId?: string;
  tokens: number;
}

type Listener = (usage: DriveTurnUsage) => void;

const listeners = new Set<Listener>();

export interface DriveTurnComplete {
  projectId: string;
  driveTurnId?: string;
  outcome?: DriveTurnOutcome;
}

export type DriveTurnOutcome = 'executed' | 'discarded' | 'failed-before-execution';

type CompleteListener = (complete: DriveTurnComplete) => void;

const completeListeners = new Set<CompleteListener>();

export function onDriveTurnUsage(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function reportDriveTurnUsage(usage: DriveTurnUsage): void {
  const { sessionId, projectId, tokens } = usage;
  if (!sessionId || !projectId || tokens <= 0 || listeners.size === 0) return;
  for (const listener of Array.from(listeners)) {
    try {
      listener(usage);
    } catch (err) {
      logger.warn(
        { sessionId, projectId, error: (err as Error).message },
        'drive-usage listener falhou (turno nao afetado)',
      );
    }
  }
}

export function onDriveTurnComplete(listener: CompleteListener): () => void {
  completeListeners.add(listener);
  return () => {
    completeListeners.delete(listener);
  };
}

export function reportDriveTurnComplete(projectId: string, driveTurnId?: string, outcome?: DriveTurnOutcome): void {
  if (!projectId || completeListeners.size === 0) return;
  const complete: DriveTurnComplete = { projectId, driveTurnId, ...(outcome ? { outcome } : {}) };
  for (const listener of Array.from(completeListeners)) {
    try {
      listener(complete);
    } catch (err) {
      logger.warn(
        { projectId, driveTurnId, error: (err as Error).message },
        'drive-turn-complete listener falhou (turno nao afetado)',
      );
    }
  }
}

export function _resetDriveUsageSinkForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error('_resetDriveUsageSinkForTesting can only be called in test environment');
  }
  listeners.clear();
  completeListeners.clear();
}
