import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { MessageQueue, type QueuedMessage } from '../message-queue';

function item(message: string, sessionId?: string, extra?: Partial<QueuedMessage['options']>): QueuedMessage {
  return { message, options: { sessionId, ...extra }, enqueuedAt: Date.now() };
}

describe('5.4: MessageQueue.drain(predicate) remove SO os itens da sessao alvo', () => {
  it('sem predicado = drena tudo (comportamento antigo)', () => {
    const q = new MessageQueue();
    q.enqueue(item('a', 'A'));
    q.enqueue(item('b', 'B'));
    const drained = q.drain();
    expect(drained.map((i) => i.message)).toEqual(['a', 'b']);
    expect(q.length).toBe(0);
  });

  it('com predicado = drena os que casam e preserva a ordem dos demais', () => {
    const q = new MessageQueue();
    q.enqueue(item('a1', 'A'));
    q.enqueue(item('b1', 'B'));
    q.enqueue(item('a2', 'A'));
    q.enqueue(item('c1', 'C'));
    const drained = q.drain((i) => i.options.sessionId === 'A');
    expect(drained.map((i) => i.message)).toEqual(['a1', 'a2']);
    expect(q.length).toBe(2);
    expect(q.dequeue()?.message).toBe('b1');
    expect(q.dequeue()?.message).toBe('c1');
  });

  it('predicado sem casamento nao altera a fila', () => {
    const q = new MessageQueue();
    q.enqueue(item('a1', 'A'));
    expect(q.drain((i) => i.options.sessionId === 'Z')).toEqual([]);
    expect(q.length).toBe(1);
  });

  it('some(predicate) reporta item na fila por sessao (estado queued do 5.7)', () => {
    const q = new MessageQueue();
    q.enqueue(item('a1', 'A'));
    expect(q.some((i) => i.options.sessionId === 'A')).toBe(true);
    expect(q.some((i) => i.options.sessionId === 'B')).toBe(false);
  });

  it('itens de drive drenados carregam driveProjectId/driveTurnId para o sinal discarded', () => {
    const q = new MessageQueue();
    q.enqueue(item('drive', 'A', { origin: 'system-event', driveProjectId: 'p1', driveTurnId: 't1' }));
    q.enqueue(item('human', 'B', { origin: 'user' }));
    const drained = q.drain((i) => i.options.sessionId === 'A');
    expect(drained).toHaveLength(1);
    expect(drained[0]?.options.driveProjectId).toBe('p1');
    expect(drained[0]?.options.driveTurnId).toBe('t1');
    expect(q.length).toBe(1);
  });
});
