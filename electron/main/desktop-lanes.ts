import { MessageQueue } from './message-queue';
import { SessionRequiredError } from './lanes';
import { isDesktopSessionInFlight } from './in-flight-desktop-session';
import type { SdkLane } from './sdk-lane';

export interface DesktopLane extends SdkLane {
  kind: 'desktop';
  sessionId: string;
  queue: MessageQueue;
  processorId: number;
}

const desktopLanes = new Map<string, DesktopLane>();

export function getDesktopLane(sessionId: string): DesktopLane {
  const existing = desktopLanes.get(sessionId);
  if (existing) return existing;
  const lane: DesktopLane = {
    name: 'desktop',
    kind: 'desktop',
    sessionId,
    queue: new MessageQueue(),
    processorId: 0,
    sdkActiveSessionId: null,
    currentAbortController: null,
  };
  desktopLanes.set(sessionId, lane);
  return lane;
}

export function peekDesktopLane(sessionId: string): DesktopLane | undefined {
  return desktopLanes.get(sessionId);
}

export function listDesktopLanes(): DesktopLane[] {
  return [...desktopLanes.values()];
}

export function isDesktopLane(lane: SdkLane): lane is DesktopLane {
  return lane.kind === 'desktop';
}

function isDesktopLaneIdle(lane: DesktopLane): boolean {
  return (
    lane.queue.length === 0 &&
    !lane.queue.isProcessing &&
    lane.currentAbortController === null &&
    !isDesktopSessionInFlight(lane.sessionId)
  );
}

export function pruneIdleDesktopLane(sessionId: string): boolean {
  const lane = desktopLanes.get(sessionId);
  if (!lane || !isDesktopLaneIdle(lane)) return false;
  desktopLanes.delete(sessionId);
  return true;
}

export function pruneIdleDesktopLanes(): string[] {
  const pruned: string[] = [];
  for (const sessionId of Array.from(desktopLanes.keys())) {
    if (pruneIdleDesktopLane(sessionId)) pruned.push(sessionId);
  }
  return pruned;
}

export function resolveLaneForOptions(options: { sessionId?: string }, source: string): SdkLane {
  if (!options.sessionId) throw new SessionRequiredError('desktop', source);
  return getDesktopLane(options.sessionId);
}

export function lanesOrAllDesktop(lane: SdkLane | undefined): SdkLane[] {
  return lane ? [lane] : listDesktopLanes();
}

export function clearDesktopQueuesForTests(): void {
  for (const lane of desktopLanes.values()) lane.queue.clear();
}

export function resetDesktopLanesForTests(): void {
  desktopLanes.clear();
}
