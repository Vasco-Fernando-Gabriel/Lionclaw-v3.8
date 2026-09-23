import { describe, it, expect, afterEach } from 'vitest';

import { actorForLane, resolveKanbanActor, resolveKanbanActorRef, KanbanTurnBindingError } from '../kanban-actor';
import {
  setActiveChatTurn,
  clearActiveChatTurn,
  __resetChatCapabilityContextForTests,
} from '../chat-capability-context';

describe('actorForLane', () => {
  it('cron -> scheduler; desktop e telegram -> orchestrator', () => {
    expect(actorForLane('cron')).toBe('scheduler');
    expect(actorForLane('desktop')).toBe('orchestrator');
    expect(actorForLane('telegram')).toBe('orchestrator');
  });
});

describe('resolveKanbanActor (binding por chamada, 9.3)', () => {
  afterEach(() => {
    __resetChatCapabilityContextForTests();
  });

  it('desktop com binding valido -> orchestrator', () => {
    setActiveChatTurn({ sessionId: 'sess-a', lane: 'desktop', turnId: 'turn-1' });
    expect(resolveKanbanActor({ lane: 'desktop', sessionId: 'sess-a', turnId: 'turn-1' })).toBe('orchestrator');
    expect(resolveKanbanActor({ lane: 'desktop', sessionId: 'sess-a' })).toBe('orchestrator');
  });

  it('desktop sem sessionId -> turn_binding_required, mesmo com turno ativo em alguma lane', () => {
    setActiveChatTurn({ sessionId: 'sess-a', lane: 'desktop', turnId: 'turn-1' });
    expect(() => resolveKanbanActor({ lane: 'desktop' })).toThrow(KanbanTurnBindingError);
    expect(() => resolveKanbanActor({ lane: 'desktop' })).toThrow(/turn_binding_required/);
  });

  it('desktop com sessionId sem turno ativo ou turnId defasado -> turn_binding_required', () => {
    expect(() => resolveKanbanActor({ lane: 'desktop', sessionId: 'sess-x' })).toThrow(/turn_binding_required/);
    setActiveChatTurn({ sessionId: 'sess-a', lane: 'desktop', turnId: 'turn-2' });
    expect(() => resolveKanbanActor({ lane: 'desktop', sessionId: 'sess-a', turnId: 'turn-1' })).toThrow(
      /turn_binding_required/,
    );
  });

  it('duas lanes desktop em voo: cada binding resolve a sua, sem ambiguidade', () => {
    setActiveChatTurn({ sessionId: 'sess-a', lane: 'desktop', turnId: 'turn-a' });
    setActiveChatTurn({ sessionId: 'sess-b', lane: 'desktop', turnId: 'turn-b' });
    expect(resolveKanbanActor({ lane: 'desktop', sessionId: 'sess-a', turnId: 'turn-a' })).toBe('orchestrator');
    expect(resolveKanbanActor({ lane: 'desktop', sessionId: 'sess-b', turnId: 'turn-b' })).toBe('orchestrator');
    expect(() => resolveKanbanActor({ lane: 'desktop', sessionId: 'sess-a', turnId: 'turn-b' })).toThrow(
      /turn_binding_required/,
    );
  });

  it('lane cron com turno ativo -> scheduler; sem turno -> turn_binding_required', () => {
    expect(() => resolveKanbanActor({ lane: 'cron' })).toThrow(/turn_binding_required/);
    setActiveChatTurn({ sessionId: 'sess-cron', lane: 'cron', turnId: 'turn-c' });
    expect(resolveKanbanActor({ lane: 'cron' })).toBe('scheduler');
    clearActiveChatTurn({ sessionId: 'sess-cron', lane: 'cron', turnId: 'turn-c' });
    expect(() => resolveKanbanActor({ lane: 'cron' })).toThrow(/turn_binding_required/);
  });

  it('a resolucao e POR CHAMADA: o actor muda com a lane do binding', () => {
    setActiveChatTurn({ sessionId: 'sess-cron', lane: 'cron', turnId: 'turn-c' });
    setActiveChatTurn({ sessionId: 'sess-d', lane: 'desktop', turnId: 'turn-d' });
    expect(resolveKanbanActor({ lane: 'cron' })).toBe('scheduler');
    expect(resolveKanbanActor({ lane: 'desktop', sessionId: 'sess-d' })).toBe('orchestrator');
  });
});

describe('resolveKanbanActorRef (cliente externo, ex. LionCode)', () => {
  afterEach(() => {
    __resetChatCapabilityContextForTests();
  });

  it('cliente externo lioncode -> actor lioncode com o detalhe, SEM exigir turno de chat', () => {
    expect(resolveKanbanActorRef({ lane: 'desktop' }, { id: 'lioncode', detail: 'Claude Opus 5' })).toEqual({
      actor: 'lioncode',
      detail: 'Claude Opus 5',
    });
    expect(resolveKanbanActorRef({ lane: 'desktop' }, { id: 'lioncode', detail: null })).toEqual({
      actor: 'lioncode',
      detail: null,
    });
  });

  it('sem cliente externo segue a regra do turno: binding valido -> orchestrator; sem turno -> turn_binding_required', () => {
    setActiveChatTurn({ sessionId: 'sess-a', lane: 'desktop', turnId: 'turn-1' });
    expect(resolveKanbanActorRef({ lane: 'desktop', sessionId: 'sess-a', turnId: 'turn-1' }, null)).toEqual({
      actor: 'orchestrator',
      detail: null,
    });
    expect(() => resolveKanbanActorRef({ lane: 'desktop' }, undefined)).toThrow(KanbanTurnBindingError);
  });
});
