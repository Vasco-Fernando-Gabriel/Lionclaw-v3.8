export interface DriveRebindRuntimeSync {
  isTurnInFlight: (projectId: string) => boolean;
  onRebound: (projectId: string, oldSessionId: string, newSessionId: string) => void;
  onRollback: (projectId: string, oldSessionId: string, newSessionId: string) => void;
}

let registered: DriveRebindRuntimeSync | null = null;

export function registerDriveRebindRuntimeSync(sync: DriveRebindRuntimeSync | null): void {
  registered = sync;
}

export function getDriveRebindRuntimeSync(): DriveRebindRuntimeSync | null {
  return registered;
}

export class DriveRebindRefusedError extends Error {
  readonly code = 'drive_turn_in_flight';

  constructor(readonly projectId: string) {
    super(
      `drive_turn_in_flight: ha um turno de drive em voo no projeto "${projectId}"; ` +
        're-bind da lane recusado (nada foi migrado)',
    );
    this.name = 'DriveRebindRefusedError';
  }
}
