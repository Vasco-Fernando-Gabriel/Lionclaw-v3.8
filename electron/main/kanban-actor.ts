import { resolveTurnBinding, type ChatLane, type TurnBindingResolution } from './chat-capability-context';
import type { KanbanActor, KanbanActorRef } from '../../src/types/kanban';
import type { KanbanExternalClientId } from '../../mcp-servers/_shared/kanban-protocol';

export interface KanbanExternalClient {
  id: KanbanExternalClientId;
  detail: string | null;
}

export class KanbanTurnBindingError extends Error {
  readonly code = 'turn_binding_required' as const;

  constructor(reason: string) {
    super(
      `turn_binding_required: acao do Kanban sem binding de turno valido (${reason}); ` +
        'a chamada precisa trazer sessionId (e turnId) de um turno de chat ativo ' +
        '(clientes externos, como o LionCode, precisam do handshake com `client`).',
    );
    this.name = 'KanbanTurnBindingError';
  }
}

export function actorForLane(lane: ChatLane): KanbanActor {
  return lane === 'cron' ? 'scheduler' : 'orchestrator';
}

export function resolveKanbanActor(
  binding: { lane: ChatLane; sessionId?: string; turnId?: string },
  resolve: typeof resolveTurnBinding = resolveTurnBinding,
): KanbanActor {
  const resolution: TurnBindingResolution = resolve(binding);
  if (!resolution.ok) throw new KanbanTurnBindingError(resolution.reason);
  return actorForLane(binding.lane);
}

export function resolveKanbanActorRef(
  binding: { lane: ChatLane; sessionId?: string; turnId?: string },
  externalClient: KanbanExternalClient | null | undefined,
  resolve: typeof resolveTurnBinding = resolveTurnBinding,
): KanbanActorRef {
  if (externalClient) return { actor: externalClient.id, detail: externalClient.detail };
  return { actor: resolveKanbanActor(binding, resolve), detail: null };
}
