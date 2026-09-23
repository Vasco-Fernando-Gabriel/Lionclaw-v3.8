import { listHarnessProjectsBySession, isDriveEngaged } from './db';
import { createLogger } from './logger';

const logger = createLogger('session-drive');

export function listActiveDriveProjectIdsForSession(sessionId: string): string[] {
  let ids: string[] = [];
  try {
    ids = listHarnessProjectsBySession(sessionId)
      .filter((project) => isDriveEngaged(project.id))
      .map((project) => project.id);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), sessionId },
      'leitura do drive da sessao falhou (estado segue sem drive)',
    );
  }
  return ids;
}

export function sessionHasActiveDrive(sessionId: string): boolean {
  return listActiveDriveProjectIdsForSession(sessionId).length > 0;
}
