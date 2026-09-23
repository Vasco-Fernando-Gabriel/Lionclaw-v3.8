import { describe, it, expect } from 'vitest';
import { cronLane, telegramLane } from '../sdk-lane';
import { getDesktopLane, listDesktopLanes, peekDesktopLane, resetDesktopLanesForTests } from '../desktop-lanes';

describe('8.1: lane.kind nas constantes e nas lanes desktop por sessao', () => {
  it('telegram/cron carregam kind igual ao name', () => {
    expect(telegramLane.kind).toBe('telegram');
    expect(cronLane.kind).toBe('cron');
  });

  it('getDesktopLane cria sob demanda uma lane por sessao com fila propria', () => {
    resetDesktopLanesForTests();
    const a = getDesktopLane('sess-a');
    const b = getDesktopLane('sess-b');
    expect(a.kind).toBe('desktop');
    expect(a.sessionId).toBe('sess-a');
    expect(a).not.toBe(b);
    expect(a.queue).not.toBe(b.queue);
    expect(getDesktopLane('sess-a')).toBe(a);
    expect(peekDesktopLane('sess-c')).toBeUndefined();
    expect(
      listDesktopLanes()
        .map((l) => l.sessionId)
        .sort(),
    ).toEqual(['sess-a', 'sess-b']);
  });
});
