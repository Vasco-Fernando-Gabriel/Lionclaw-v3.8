
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


const SESSION_ID = 'test-session-001';

function makeMessages(n: number, tokenSize: number = 10): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    sessionId: SESSION_ID,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: 'X'.repeat(tokenSize * 4), // tokenSize tokens each (chars/4)
    createdAt: new Date().toISOString(),
  }));
}

function makeAdapter(responseText = 'summary text'): LionAdapter {
  return {
    name: 'ollama',
    streamCompletion: vi.fn().mockImplementation(async function* () {
      yield { type: 'text' as const, delta: responseText };
      yield { type: 'usage' as const, usage: { inputTokens: 100, outputTokens: 50 } };
      yield { type: 'done' as const };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getCachedSummary as ReturnType<typeof vi.fn>).mockReturnValue(null);
});


describe('compactIfNeeded - abaixo do threshold', () => {
  it('nao compacta quando historico curto (< KEEP_RECENT_TURNS)', async () => {
    const msgs = makeMessages(5, 10);
    (getSessionMessages as ReturnType<typeof vi.fn>).mockReturnValue(msgs);

    const adapter = makeAdapter();
    const emitChunk = vi.fn();

    const result = await compactIfNeeded({
      sessionId: SESSION_ID,
      newUserMsg: 'nova pergunta',
      systemPrompt: 'system',
      primaryAdapter: adapter,
      primaryModel: 'qwen2.5:27b', // maxContext = 130000
      primaryProvider: 'ollama',
      emitChunk,
    });

    expect(result.compacted).toBe(false);
    expect(adapter.streamCompletion).not.toHaveBeenCalled();
    expect(emitChunk).not.toHaveBeenCalled();
    expect(result.messages).toHaveLength(msgs.slice(0, -1).length + 1);
  });

  it('nao compacta quando tokens abaixo do threshold', async () => {
    const msgs = makeMessages(15, 5); // 5 tokens cada = 75 total
    (getSessionMessages as ReturnType<typeof vi.fn>).mockReturnValue(msgs);

    const adapter = makeAdapter();
    const emitChunk = vi.fn();

    const result = await compactIfNeeded({
      sessionId: SESSION_ID,
      newUserMsg: 'x'.repeat(10), // ~3 tokens
      systemPrompt: 'sys',         // ~1 token
      primaryAdapter: adapter,
      primaryModel: 'qwen2.5:27b', // maxContext = 130000, threshold = 91000
      primaryProvider: 'ollama',
      emitChunk,
    });

    expect(result.compacted).toBe(false);
    expect(adapter.streamCompletion).not.toHaveBeenCalled();
  });

  it('remove assistant vazio do historico antes de montar mensagens do Lion-SDK', async () => {
    const msgs: ChatMessage[] = [
      {
        id: 1,
        sessionId: SESSION_ID,
        role: 'user',
        content: 'primeira pergunta',
        createdAt: new Date().toISOString(),
      },
      {
        id: 2,
        sessionId: SESSION_ID,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
      },
      {
        id: 3,
        sessionId: SESSION_ID,
        role: 'user',
        content: 'ultima user persistida',
        createdAt: new Date().toISOString(),
      },
    ];
    (getSessionMessages as ReturnType<typeof vi.fn>).mockReturnValue(msgs);

    const adapter = makeAdapter();
    const emitChunk = vi.fn();

    const result = await compactIfNeeded({
      sessionId: SESSION_ID,
      newUserMsg: 'nova pergunta',
      systemPrompt: 'system',
      primaryAdapter: adapter,
      primaryModel: 'qwen2.5:27b',
      primaryProvider: 'ollama',
      emitChunk,
    });

    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual([
      { role: 'user', content: 'primeira pergunta' },
      { role: 'user', content: 'nova pergunta' },
    ]);
  });
});

describe('compactIfNeeded - acima do threshold', () => {
  it('dispara compactacao quando tokens > 70% do maxContext', async () => {
    const msgs = makeMessages(14, 2000);
    msgs.push({
      id: 15,
      sessionId: SESSION_ID,
      role: 'user',
      content: 'ultima user',
      createdAt: new Date().toISOString(),
    });
    (getSessionMessages as ReturnType<typeof vi.fn>).mockReturnValue(msgs);

    const adapter = makeAdapter('resumo compactado aqui');
    const emitChunk = vi.fn();

    const result = await compactIfNeeded({
      sessionId: SESSION_ID,
      newUserMsg: 'nova pergunta',
      systemPrompt: 'system prompt',
      primaryAdapter: adapter,
      primaryModel: 'unknown-model', // fallback 32768
      primaryProvider: 'lmstudio',
      emitChunk,
    });

    expect(result.compacted).toBe(true);
    expect(emitChunk).toHaveBeenCalledWith(expect.objectContaining({ type: 'compacting', isCompacting: true }));
    expect(emitChunk).toHaveBeenCalledWith(expect.objectContaining({ type: 'compacting', isCompacting: false }));
    expect(adapter.streamCompletion).toHaveBeenCalled();
    expect(saveCachedSummary).toHaveBeenCalled();

    const systemMessages = result.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toContain('[Resumo das mensagens anteriores]');
    expect(systemMessages[0].content).toContain('resumo compactado aqui');
  });

  it('usa context window e percentual configurados quando informados', async () => {
    const msgs = makeMessages(14, 60);
    msgs.push({
      id: 15,
      sessionId: SESSION_ID,
      role: 'user',
      content: 'ultima user',
      createdAt: new Date().toISOString(),
    });
    (getSessionMessages as ReturnType<typeof vi.fn>).mockReturnValue(msgs);

    const adapter = makeAdapter('summary custom threshold');
    const emitChunk = vi.fn();

    const result = await compactIfNeeded({
      sessionId: SESSION_ID,
      newUserMsg: 'nova pergunta',
      systemPrompt: 'system prompt',
      primaryAdapter: adapter,
      primaryModel: 'unknown-model',
      primaryProvider: 'lmstudio',
      maxContextTokens: 1000,
      thresholdRatio: 0.80,
      emitChunk,
    });

    expect(result.compacted).toBe(true);
    expect(adapter.streamCompletion).toHaveBeenCalled();
  });
});
