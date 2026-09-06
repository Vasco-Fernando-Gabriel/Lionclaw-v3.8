import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../../src/types';
import {
  buildCodexHistoryPreamble,
  CODEX_HISTORY_MAX_CHARS,
  CODEX_HISTORY_MAX_TURNS,
} from '../history';

function message(id: number, role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id,
    sessionId: 'session-1',
    role,
    content,
    createdAt: '2026-05-15T00:00:00.000Z',
  };
}

describe('buildCodexHistoryPreamble', () => {
  it('keeps only recent prior user and assistant turns', () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 12; i += 1) {
      messages.push(message(i, i % 2 === 0 ? 'user' : 'assistant', `turn-${i}`));
    }
    messages.push(message(99, 'user', 'current message'));

    const preamble = buildCodexHistoryPreamble(messages);

    expect(preamble).not.toContain('current message');
    expect(preamble).not.toContain('turn-3');
    expect(preamble).toContain('turn-4');
    expect(preamble).toContain('turn-11');
    expect(preamble.split('\n\n')).toHaveLength(CODEX_HISTORY_MAX_TURNS);
  });

  it('caps long history before sending it to Codex', () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 10; i += 1) {
      messages.push(message(i, i % 2 === 0 ? 'user' : 'assistant', `turn-${i} ${'x'.repeat(5000)}`));
    }
    messages.push(message(99, 'user', 'current message'));

    const preamble = buildCodexHistoryPreamble(messages);

    expect(preamble.length).toBeLessThanOrEqual(CODEX_HISTORY_MAX_CHARS);
    expect(preamble).toContain('[...message truncated...]');
    expect(preamble).not.toContain('current message');
  });

  it('ignores system messages in Codex chat history preamble', () => {
    const preamble = buildCodexHistoryPreamble([
      message(1, 'system', 'hidden system instruction'),
      message(2, 'user', 'previous user'),
      message(3, 'assistant', 'previous assistant'),
      message(4, 'user', 'current message'),
    ]);

    expect(preamble).toContain('User: previous user');
    expect(preamble).toContain('Assistant: previous assistant');
    expect(preamble).not.toContain('hidden system instruction');
  });
});
