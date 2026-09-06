import { describe, expect, it } from 'vitest';
import {
  buildGrokHistoryPreamble,
  GROK_HISTORY_MAX_CHARS,
  GROK_HISTORY_MAX_TURNS,
} from '../grok-sdk/history';
import type { ChatMessage } from '../../../src/types';

function message(id: number, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, sessionId: 's', role, content, createdAt: new Date(0).toISOString() };
}

describe('Grok history preamble', () => {
  it('excludes the current message and caps prior user/assistant turns', () => {
    const messages = Array.from({ length: 12 }, (_, index) =>
      message(index + 1, index % 2 === 0 ? 'user' : 'assistant', `m${index + 1}`),
    );
    const result = buildGrokHistoryPreamble(messages);
    expect(result).not.toContain('m12');
    expect(result.split('\n\n')).toHaveLength(GROK_HISTORY_MAX_TURNS);
    expect(result).toContain('m11');
  });

  it('never exceeds the total character budget', () => {
    const messages = [
      message(1, 'user', 'a'.repeat(20_000)),
      message(2, 'assistant', 'b'.repeat(20_000)),
      message(3, 'user', 'current'),
    ];
    expect(buildGrokHistoryPreamble(messages).length).toBeLessThanOrEqual(GROK_HISTORY_MAX_CHARS);
  });

  it('preserva a ultima mensagem real quando o turno atual nao foi persistido', () => {
    const messages = [message(1, 'user', 'anterior'), message(2, 'assistant', 'ultima-real')];
    expect(buildGrokHistoryPreamble(messages, { dropLast: false })).toContain('ultima-real');
  });
});
