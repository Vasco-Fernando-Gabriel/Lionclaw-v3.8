
import { getActiveChatTurnByLane, type ChatLane } from './chat-capability-context';
import { createLogger } from './logger';
import type { KanbanActor } from '../../src/types/kanban';

const logger = createLogger('kanban-mcp');

const CHAT_LANES: readonly ChatLane[] = ['desktop', 'telegram', 'cron'];

export function actorForActiveLanes(activeLanes: readonly ChatLane[]): {
  actor: KanbanActor;
  ambiguous: boolean;
} {
  if (activeLanes.length === 1) {
    return {
      actor: activeLanes[0] === 'cron' ? 'scheduler' : 'orchestrator',
      ambiguous: false,
    };
  }
  return { actor: 'orchestrator', ambiguous: true };
}

export function resolveKanbanActor(
  getTurnByLane: (
    lane: ChatLane,
  ) => { sessionId: string; turnId: string } | undefined = getActiveChatTurnByLane,
): KanbanActor {
  const activeLanes = CHAT_LANES.filter((lane) => getTurnByLane(lane) !== undefined);
  const { actor, ambiguous } = actorForActiveLanes(activeLanes);
  if (ambiguous) {
    logger.warn(
      { activeLanes, actor, ambiguous: true },
      'actor kanban ambiguo (nenhuma ou mais de uma lane com turno ativo); fallback orchestrator',
    );
  }
  return actor;
}
