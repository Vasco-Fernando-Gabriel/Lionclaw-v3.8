export type Phase4StartAction = 'auto-ensure' | 'show-cta' | 'wait';

export interface Phase4StartGateInput {
  driveEngaged: boolean;
  startPending: boolean;
  startStatusLoaded: boolean;
  bootInstallReady: boolean;
  sessionConfigPresent: boolean;
  bootstrapIdle: boolean;
}

export function resolvePhase4StartAction(input: Phase4StartGateInput): Phase4StartAction {
  const { driveEngaged, startPending, startStatusLoaded, bootInstallReady, sessionConfigPresent, bootstrapIdle } =
    input;

  if (!bootInstallReady || !sessionConfigPresent || !bootstrapIdle) {
    return 'wait';
  }

  if (!startStatusLoaded) {
    return 'wait';
  }

  if (driveEngaged && startPending) {
    return 'show-cta';
  }

  return 'auto-ensure';
}
