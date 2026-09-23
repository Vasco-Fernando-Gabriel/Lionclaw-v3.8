import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db', () => ({
  getSessionMessages: vi.fn(),
}));

vi.mock('../db', () => ({
  getCachedSummary: vi.fn(),
  saveCachedSummary: vi.fn(),
}));

import { getSessionMessages } from '../../../db';
import { getCachedSummary, saveCachedSummary } from '../db';
import { compactIfNeeded } from '../index';
import type { LionAdapter } from '../../adapters/types';
import type { ChatMessage } from '../../../../../src/types';

const SESSION_ID = 'test-session-cache';

function makeMessages(n: number, tokenSize: number = 2000): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    sessionId: SESSION_ID,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: 'A'.repeat(tokenSize * 4),
    createdAt: new Date().toISOString(),
  }));
}

function makeAdapter(): LionAdapter {
  return {
    name: 'ollama',
    streamCompletion: vi.fn().mockImplementation(async function* () {
      yield { type: 'text' as const, delta: 'summary from adapter' };
      yield { type: 'done' as const };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('compactIfNeeded - cache hit', () => {
  it('nao chama o adapter quando cache hit existe', async () => {
    const msgs = makeMessages(15, 2000);
    (getSessionMessages as ReturnType<typeof vi.fn>).mockReturnValue(msgs);

    const cachedRow = {
      session_id: SESSION_ID,
      summary_text: 'resumo em cache do turno anterior',
      covers_until_message_id: msgs[2].id, // id do ultimo older
      model_used: 'qwen',
      provider_used: 'ollama',
      input_tokens: 500,
      output_tokens: 100,
      created_at: Date.now(),
    };
    (getCachedSummary as ReturnType<typeof vi.fn>).mockReturnValue(cachedRow);

    const adapter = makeAdapter();
    const emitChunk = vi.fn();

    const result = await compactIfNeeded({
      sessionId: SESSION_ID,
      newUserMsg: 'segunda pergunta',
      systemPrompt: 'system',
      primaryAdapter: adapter,
      primaryModel: 'unknown-model', // fallback 32768
      primaryProvider: 'ollama',
      emitChunk,
    });

    expect(result.compacted).toBe(true);
    expect(adapter.streamCompletion).not.toHaveBeenCalled();
    expect(saveCachedSummary).not.toHaveBeenCalled();
    expect(emitChunk).not.toHaveBeenCalled();
    const systemBlock = result.messages.find((m) => m.role === 'system');
    expect(systemBlock?.content).toContain('resumo em cache do turno anterior');
  });
});
