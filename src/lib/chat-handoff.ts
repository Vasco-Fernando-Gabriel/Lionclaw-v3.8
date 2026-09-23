import type { OpenChatSession } from '../types';

export type PendingChatTargetDecision =
  | { kind: 'no-lane' }
  | { kind: 'reload-lanes'; targetSessionId: string }
  | { kind: 'closed'; targetSessionId: string }
  | { kind: 'target'; sessionId: string };

export function resolvePendingChatTarget(input: {
  targetSessionId: string | null;
  currentSessionId: string | null;
  openLanes: readonly Pick<OpenChatSession, 'id'>[];
  lanesRecheckedFor: string | null;
}): PendingChatTargetDecision {
  const { targetSessionId, currentSessionId, openLanes, lanesRecheckedFor } = input;
  if (targetSessionId === null) {
    return currentSessionId ? { kind: 'target', sessionId: currentSessionId } : { kind: 'no-lane' };
  }
  if (openLanes.some((lane) => lane.id === targetSessionId)) {
    return { kind: 'target', sessionId: targetSessionId };
  }
  if (lanesRecheckedFor !== targetSessionId) {
    return { kind: 'reload-lanes', targetSessionId };
  }
  return { kind: 'closed', targetSessionId };
}

export const PENDING_CHAT_TARGET_CLOSED_TITLE = 'Conversa encerrada';
export const PENDING_CHAT_TARGET_CLOSED_BODY =
  'A conversa alvo do handoff foi encerrada; escolha uma lane e envie de novo.';
