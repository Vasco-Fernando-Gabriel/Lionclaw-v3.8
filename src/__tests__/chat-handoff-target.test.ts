import { describe, it, expect } from 'vitest';
import { resolvePendingChatTarget } from '@/lib/chat-handoff';

const lanes = [{ id: 'a' }, { id: 'b' }];

describe('10.1: handoff pipeline -> chat mira a lane alvo', () => {
  it('targetSessionId aberto = envia para ele mesmo que outra lane esteja visivel', () => {
    expect(
      resolvePendingChatTarget({
        targetSessionId: 'b',
        currentSessionId: 'a',
        openLanes: lanes,
        lanesRecheckedFor: null,
      }),
    ).toEqual({ kind: 'target', sessionId: 'b' });
  });

  it('sem targetSessionId = lane visivel; sem lane visivel = espera', () => {
    expect(
      resolvePendingChatTarget({
        targetSessionId: null,
        currentSessionId: 'a',
        openLanes: lanes,
        lanesRecheckedFor: null,
      }),
    ).toEqual({ kind: 'target', sessionId: 'a' });
    expect(
      resolvePendingChatTarget({
        targetSessionId: null,
        currentSessionId: null,
        openLanes: lanes,
        lanesRecheckedFor: null,
      }),
    ).toEqual({ kind: 'no-lane' });
  });

  it('alvo fora das lanes abertas: recarrega as lanes uma vez e, se continuar ausente, e "encerrada"', () => {
    expect(
      resolvePendingChatTarget({
        targetSessionId: 'z',
        currentSessionId: 'a',
        openLanes: lanes,
        lanesRecheckedFor: null,
      }),
    ).toEqual({ kind: 'reload-lanes', targetSessionId: 'z' });
    expect(
      resolvePendingChatTarget({
        targetSessionId: 'z',
        currentSessionId: 'a',
        openLanes: lanes,
        lanesRecheckedFor: 'z',
      }),
    ).toEqual({ kind: 'closed', targetSessionId: 'z' });
    expect(
      resolvePendingChatTarget({
        targetSessionId: 'z',
        currentSessionId: 'a',
        openLanes: [...lanes, { id: 'z' }],
        lanesRecheckedFor: 'z',
      }),
    ).toEqual({ kind: 'target', sessionId: 'z' });
  });
});
