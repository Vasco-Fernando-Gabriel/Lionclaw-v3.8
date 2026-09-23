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

const SESSION_ID = 'test-session-iterative';

function makeMessages(n: number, idOffset = 0): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: idOffset + i + 1,
    sessionId: SESSION_ID,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: 'B'.repeat(2000 * 4),
    createdAt: new Date().toISOString(),
  }));
}

function makeAdapter(responseText = 'novo summary iterativo'): LionAdapter {
  return {
    name: 'lmstudio',
    streamCompletion: vi.fn().mockImplementation(async function* () {
      yield { type: 'text' as const, delta: responseText };
      yield { type: 'usage' as const, usage: { inputTokens: 200, outputTokens: 80 } };
      yield { type: 'done' as const };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('compactIfNeeded - iterative recompact', () => {
  it('faz nova compactacao quando older mudou (cache miss no novo ponto de corte)', async () => {
    const msgs = makeMessages(16);
    (getSessionMessages as ReturnType<typeof vi.fn>).mockReturnValue(msgs);
    (getCachedSummary as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const adapter = makeAdapter('novo summary iterativo');
    const emitChunk = vi.fn();

    const result = await compactIfNeeded({
      sessionId: SESSION_ID,
      newUserMsg: 'nova msg iterativa',
      systemPrompt: 'system',
      primaryAdapter: adapter,
      primaryModel: 'unknown-model',
      primaryProvider: 'lmstudio',
      emitChunk,
    });

    expect(result.compacted).toBe(true);
    expect(adapter.streamCompletion).toHaveBeenCalledOnce();
    expect(saveCachedSummary).toHaveBeenCalledOnce();

    const systemBlock = result.messages.find((m) => m.role === 'system');
    expect(systemBlock?.content).toContain('novo summary iterativo');
  });

  it('reutiliza cache antigo quando older nao mudou entre turnos', async () => {
    const msgs = makeMessages(14);
    (getSessionMessages as ReturnType<typeof vi.fn>).mockReturnValue(msgs);

    const olderLastId = msgs[14 - 12 - 1].id;
    (getCachedSummary as ReturnType<typeof vi.fn>).mockReturnValue({
      session_id: SESSION_ID,
      summary_text: 'summary antigo reusado',
      covers_until_message_id: olderLastId,
      model_used: 'qwen',
      provider_used: 'lmstudio',
      input_tokens: 100,
      output_tokens: 40,
      created_at: Date.now(),
    });

    const adapter = makeAdapter();
    const emitChunk = vi.fn();

    const result = await compactIfNeeded({
      sessionId: SESSION_ID,
      newUserMsg: 'msg reusando cache',
      systemPrompt: 'system',
      primaryAdapter: adapter,
      primaryModel: 'unknown-model',
      primaryProvider: 'lmstudio',
      emitChunk,
    });

    expect(result.compacted).toBe(true);
    expect(adapter.streamCompletion).not.toHaveBeenCalled();
    const systemBlock = result.messages.find((m) => m.role === 'system');
    expect(systemBlock?.content).toContain('summary antigo reusado');
  });
});
