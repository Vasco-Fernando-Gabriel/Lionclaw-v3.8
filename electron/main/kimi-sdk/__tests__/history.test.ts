import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../../src/types';
import { buildKimiHistoryPreamble } from '../history';

function message(id: number, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, sessionId: 's', role, content, createdAt: new Date(0).toISOString() };
}

describe('Kimi history preamble', () => {
  it('descarta a user message atual quando ela foi persistida', () => {
    const messages = [message(1, 'assistant', 'anterior'), message(2, 'user', 'atual')];
    expect(buildKimiHistoryPreamble(messages)).not.toContain('atual');
  });

  it('preserva a ultima mensagem real em turnos system-event', () => {
    const messages = [message(1, 'user', 'anterior'), message(2, 'assistant', 'ultima-real')];
    expect(buildKimiHistoryPreamble(messages, { dropLast: false })).toContain('ultima-real');
  });
});
