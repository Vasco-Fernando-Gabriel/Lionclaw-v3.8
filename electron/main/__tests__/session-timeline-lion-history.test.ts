import { describe, it, expect, vi } from 'vitest';
import type { Content, GenerateContentParameters } from '@google/genai';
vi.mock('../db', () => ({ getSessionMessages: vi.fn() }));
vi.mock('../chat-compaction-trigger', () => ({ isChatTimelineReinjectEnabled: () => false }));
vi.mock('../lion-sdk/compaction/db', () => ({ getCachedSummary: vi.fn(), saveCachedSummary: vi.fn() }));
vi.mock('../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
}));
const transport = vi.hoisted(() => vi.fn(async function* (_req: GenerateContentParameters) {}));
vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/genai')>()),
  GoogleGenAI: class {
    models = { generateContentStream: transport };
  },
}));
import { compactIfNeeded } from '../lion-sdk/compaction';
import { getSessionMessages } from '../db';
import { buildLionTimelineHistory } from '../lion-sdk/history';
import { groupRunsByAnchor, resolveTimelineAnchor } from '../session-timeline';
import { createGoogleGenAiAdapter } from '../lion-sdk/adapters/google-genai';
import { calls, message, run } from './session-timeline-lion-fixtures';
import type { ChatMessage, TimelineTurnWithEvents } from '../../../src/types';
const build = (
  messages: ChatMessage[],
  runs: TimelineTurnWithEvents[] = [],
  excludeUserMessageId: number | null = null,
  seededUserMsg = 'next',
) => buildLionTimelineHistory({ messages, runsByAnchor: groupRunsByAnchor(runs), excludeUserMessageId, seededUserMsg });
describe('lion history', () => {
  it('T-01 setting off preserves textual history even when timeline runs exist', async () => {
    vi.mocked(getSessionMessages).mockReturnValue([message(1, 'user'), message(2, 'assistant'), message(3, 'user')]);
    const result = await compactIfNeeded({
      sessionId: 's',
      newUserMsg: 'seed',
      systemPrompt: '',
      primaryAdapter: {
        name: 'ollama',
        async *streamCompletion() {
          throw new Error('unexpected compaction');
        },
      },
      primaryModel: 'test',
      primaryProvider: 'ollama',
      timeline: { runs: [run()], excludeUserMessageId: 3, fence: null },
      emitChunk: vi.fn(),
    });
    expect(result.messages).toStrictEqual([
      { role: 'user', content: 'message-1' },
      { role: 'assistant', content: 'message-2' },
      { role: 'user', content: 'seed' },
    ]);
  });
  it('T-05 preserves the transcript byte for byte without extra keys', () => {
    const recorded = run();
    recorded.events[3].reasoningContent = '';
    recorded.events.reverse();
    expect(build([message(1, 'user'), message(2, 'assistant')], [recorded])).toStrictEqual([
      { role: 'user', content: 'effective' },
      { role: 'assistant', content: 'step', reasoning_content: 'thinking', tool_calls: calls },
      { role: 'tool', content: 'result', tool_call_id: 'call', name: 'Bash' },
      { role: 'assistant', content: 'final', reasoning_content: '' },
      { role: 'user', content: 'next' },
    ]);
  });
  it('T-05b uses the effective seed and excludes the first persisted display user', () => {
    expect(build([message(1, 'user', 'display')], [], 1, 'seed\n\nactual')).toStrictEqual([
      { role: 'user', content: 'seed\n\nactual' },
    ]);
    expect(build([message(1, 'user', 'display')], [run(1, { assistantMessageId: null })])[0].content).toBe('effective');
  });
  it.each([
    ['retry X', 'retry', null, 1, false, []],
    ['retry after another user', 'retry', null, 1, true, ['other']],
    ['retry without id', 'retry', null, null, false, ['same']],
    ['system-event', 'system-event', null, null, false, ['same']],
    ['persistence failure', 'turn', null, null, false, ['same']],
  ] as const)('T-05c %s', (_label, origin, persistedUserMessageId, answeredUserMessageId, other, expected) => {
    const anchor = resolveTimelineAnchor({ origin, persistedUserMessageId, answeredUserMessageId });
    const messages = [message(1, 'user', 'same'), ...(other ? [message(3, 'user', 'other')] : [])];
    expect(
      build(messages, [run(1, { status: 'interrupted' })], anchor.excludeUserMessageId, 'same').map((m) => m.content),
    ).toEqual([...expected, 'same']);
  });
  it('T-05d preserves system-event assistants and falls back for an unbound run', () => {
    const messages = [message(1, 'user'), message(2, 'assistant'), message(3, 'assistant', 'system response')];
    expect(build(messages, [run()]).slice(-2)).toEqual([
      { role: 'assistant', content: 'system response' },
      { role: 'user', content: 'next' },
    ]);
    for (const assistantMessageId of [null, 99])
      expect(build(messages, [run(1, { assistantMessageId })])).toEqual(build(messages));
  });
  it('T-06 mixes legacy, complete and interrupted intervals', () => {
    const messages = Array.from({ length: 6 }, (_, i) => message(i + 1, i % 2 ? 'assistant' : 'user'));
    const result = build(messages, [run(3), run(5, { status: 'interrupted' })]);
    expect(result.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(result.slice(-3).map((m) => m.content)).toEqual(['message-5', 'message-6', 'next']);
  });
  it('T-06b orders irregular legacy by timestamp and id', () => {
    const messages = [
      message(1, 'user'),
      message(2, 'user'),
      message(3, 'assistant'),
      message(4, 'user'),
      message(5, 'assistant'),
      message(6, 'assistant'),
    ];
    expect(build(messages.slice().reverse()).map((m) => m.content)).toEqual([
      ...messages.map((m) => m.content),
      'next',
    ]);
  });
  it('T-37 sends reconstructed Bash failure as the real Gemini error response', async () => {
    const recorded = run();
    const content =
      'exit=1 duration=1ms\n<persisted-output>\nOutput too large (39.1KB). Full output saved to: /spill.txt\n</persisted-output>';
    recorded.events[2].content = content;
    recorded.events[2].isError = true;
    const adapter = createGoogleGenAiAdapter({ apiKey: 'test' });
    for await (const _event of adapter.streamCompletion({
      model: 'test',
      messages: build([message(1, 'user'), message(2, 'assistant')], [recorded]),
    })) {
    }
    const contents = transport.mock.calls[0][0].contents as Content[];
    const response = contents.flatMap((item) => item.parts ?? []).find((part) => part.functionResponse)
      ?.functionResponse?.response;
    expect(response).toStrictEqual({ error: content });
  });
});
