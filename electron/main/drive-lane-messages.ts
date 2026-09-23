import { getDriveState, getHarnessProject, getOpenLaneSessionById, getSession } from './db';
import { resolveLaneLabel, type ResolveLaneLabelDeps } from './lanes';

export interface LaneMessagesDeps extends ResolveLaneLabelDeps {
  getHarnessProject: (projectId: string) => { name?: string } | undefined | null;
  getDriveState: (projectId: string) => { status?: string } | null;
}

function projectName(projectId: string, deps: LaneMessagesDeps): string {
  return deps.getHarnessProject(projectId)?.name ?? projectId;
}

export function buildLaneBusyMessage(holderProjectId: string, sessionId: string, deps: LaneMessagesDeps): string {
  const name = projectName(holderProjectId, deps);
  const label = resolveLaneLabel(sessionId, deps);
  const awaitingHuman = deps.getDriveState(holderProjectId)?.status === 'awaiting-human';
  const holder = awaitingHuman ? `aguardando a sua resposta na ${label}` : `dirigido pela ${label}`;
  return (
    `ja existe um drive ativo no projeto "${name}" (${holderProjectId}), ${holder}. ` +
    'Pare-o ou Assuma pelo Pipeline antes de iniciar outro nesta lane, ou use outra lane.'
  );
}

export function buildDriveOwnedByOtherLaneMessage(
  projectId: string,
  sessionId: string,
  deps: LaneMessagesDeps,
): string {
  const name = projectName(projectId, deps);
  const label = resolveLaneLabel(sessionId, deps);
  return (
    `o projeto "${name}" e dirigido pela ${label} e nao esta disponivel nesta lane. ` +
    'Para mover o drive, retome-o pelo Pipeline escolhendo esta lane.'
  );
}

export const dbLaneMessagesDeps: LaneMessagesDeps = {
  getOpenLaneSessionById: (sessionId) => getOpenLaneSessionById(sessionId),
  getSession: (sessionId) => getSession(sessionId),
  getHarnessProject: (projectId) => getHarnessProject(projectId),
  getDriveState: (projectId) => getDriveState(projectId),
};

export const laneMessagesWithDb = {
  laneBusy: (holderProjectId: string, sessionId: string): string =>
    buildLaneBusyMessage(holderProjectId, sessionId, dbLaneMessagesDeps),
  driveOwnedByOtherLane: (projectId: string, sessionId: string): string =>
    buildDriveOwnedByOtherLaneMessage(projectId, sessionId, dbLaneMessagesDeps),
};
