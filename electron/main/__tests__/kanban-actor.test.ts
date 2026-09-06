
import { describe, it, expect, vi, afterEach } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../logger', () => ({ createLogger: () => loggerMock }));

import { actorForActiveLanes, resolveKanbanActor } from '../kanban-actor';
import {
  setActiveChatTurn,
  clearActiveChatTurn,
  type ChatLane,
} from '../chat-capability-context';


describe('actorForActiveLanes', () => {
  it('desktop unica lane ativa -> orchestrator sem ambiguidade', () => {
    expect(actorForActiveLanes(['desktop'])).toEqual({
      actor: 'orchestrator',
      ambiguous: false,
    });
  });

  it('telegram unica lane ativa -> orchestrator sem ambiguidade', () => {
    expect(actorForActiveLanes(['telegram'])).toEqual({
      actor: 'orchestrator',
      ambiguous: false,
    });
  });

  it('cron unica lane ativa -> scheduler sem ambiguidade', () => {
    expect(actorForActiveLanes(['cron'])).toEqual({
      actor: 'scheduler',
      ambiguous: false,
    });
  });

  it('nenhuma lane ativa -> fallback orchestrator COM ambiguidade', () => {
    expect(actorForActiveLanes([])).toEqual({ actor: 'orchestrator', ambiguous: true });
  });

  it('mais de uma lane ativa (desktop + cron) -> fallback orchestrator COM ambiguidade', () => {
    expect(actorForActiveLanes(['desktop', 'cron'])).toEqual({
      actor: 'orchestrator',
      ambiguous: true,
    });
    expect(actorForActiveLanes(['desktop', 'telegram', 'cron'])).toEqual({
      actor: 'orchestrator',
      ambiguous: true,
    });
  });
});


function turnGetterFor(lanes: ChatLane[]) {
  return (lane: ChatLane) =>
    lanes.includes(lane) ? { sessionId: `s-${lane}`, turnId: `t-${lane}` } : undefined;
}

describe('resolveKanbanActor (getter injetado)', () => {
  afterEach(() => {
    loggerMock.warn.mockClear();
  });

  it('cron-only -> scheduler, sem warn', () => {
    expect(resolveKanbanActor(turnGetterFor(['cron']))).toBe('scheduler');
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('desktop-only -> orchestrator, sem warn', () => {
    expect(resolveKanbanActor(turnGetterFor(['desktop']))).toBe('orchestrator');
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('nenhuma lane -> orchestrator + warn com flag de ambiguidade', () => {
    expect(resolveKanbanActor(turnGetterFor([]))).toBe('orchestrator');
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn.mock.calls[0][0]).toMatchObject({
      ambiguous: true,
      activeLanes: [],
    });
  });

  it('desktop + cron simultaneos -> orchestrator + warn (limite documentado 4.1)', () => {
    expect(resolveKanbanActor(turnGetterFor(['desktop', 'cron']))).toBe('orchestrator');
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn.mock.calls[0][0]).toMatchObject({
      ambiguous: true,
      activeLanes: ['desktop', 'cron'],
    });
  });
});


describe('resolveKanbanActor (registry real por lane)', () => {
  const LANES: ChatLane[] = ['desktop', 'telegram', 'cron'];

  afterEach(() => {
    for (const lane of LANES) {
      clearActiveChatTurn({ sessionId: `sess-${lane}`, lane });
    }
    loggerMock.warn.mockClear();
  });

  it('turno ativo so na lane cron -> scheduler (independe do processo pooled)', () => {
    setActiveChatTurn({ sessionId: 'sess-cron', lane: 'cron', turnId: 'turn-1' });
    expect(resolveKanbanActor()).toBe('scheduler');
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('turno ativo so na lane desktop -> orchestrator', () => {
    setActiveChatTurn({ sessionId: 'sess-desktop', lane: 'desktop', turnId: 'turn-1' });
    expect(resolveKanbanActor()).toBe('orchestrator');
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('desktop + cron ativos -> fallback orchestrator + warn', () => {
    setActiveChatTurn({ sessionId: 'sess-desktop', lane: 'desktop', turnId: 'turn-1' });
    setActiveChatTurn({ sessionId: 'sess-cron', lane: 'cron', turnId: 'turn-2' });
    expect(resolveKanbanActor()).toBe('orchestrator');
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it('nenhum turno ativo -> fallback orchestrator + warn', () => {
    expect(resolveKanbanActor()).toBe('orchestrator');
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it('a resolucao e POR CHAMADA: o actor muda quando a lane ativa muda', () => {
    setActiveChatTurn({ sessionId: 'sess-cron', lane: 'cron', turnId: 'turn-1' });
    expect(resolveKanbanActor()).toBe('scheduler');
    clearActiveChatTurn({ sessionId: 'sess-cron', lane: 'cron', turnId: 'turn-1' });
    setActiveChatTurn({ sessionId: 'sess-desktop', lane: 'desktop', turnId: 'turn-2' });
    expect(resolveKanbanActor()).toBe('orchestrator');
  });
});
