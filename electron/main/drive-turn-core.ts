

export interface AntiRunawayCounters {
  tokensSpent: number;
  turnsThisDrive: number;
  turnsThisPhase: number;
}

export interface AntiRunawayLimits {
  tokenBudget: number;
  maxTurnsPerDrive: number;
  maxTurnsPerPhase: number;
}

export type AntiRunawayBreach = 'budget' | 'max-turns-drive' | 'max-turns-phase' | null;

export function checkAntiRunaway(
  counters: AntiRunawayCounters,
  limits: AntiRunawayLimits,
): AntiRunawayBreach {
  if (counters.tokensSpent >= limits.tokenBudget) return 'budget';
  if (counters.turnsThisDrive >= limits.maxTurnsPerDrive) return 'max-turns-drive';
  if (counters.turnsThisPhase >= limits.maxTurnsPerPhase) return 'max-turns-phase';
  return null;
}


export interface DriveTurnSeq {
  value: number;
}

export function mintDriveTurnId(key: string, seq: DriveTurnSeq): string {
  seq.value += 1;
  return `${key}:${seq.value}`;
}


export interface OneInFlightSnapshot {
  turnInFlightSince: number | null;
  now: number;
  hasPendingFollowup: boolean;
  inflightTimeoutMs: number;
}

export type OneInFlightAction = 'fire' | 'coalesce';

export function decideOneInFlight(snap: OneInFlightSnapshot): OneInFlightAction {
  if (
    snap.turnInFlightSince !== null &&
    snap.now - snap.turnInFlightSince < snap.inflightTimeoutMs
  ) {
    return 'coalesce';
  }
  return 'fire';
}
