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

const SESSION_ID = 'test-session-failure';

function makeMessages(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    sessionId: SESSION_ID,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: 'C'.repeat(2000 * 4),
    createdAt: new Date().toISOString(),
  }));
}

function makeFailingAdapter(errorMsg = 'LM Studio offline'): LionAdapter {
  return {
    name: 'lmstudio',
    streamCompletion: vi.fn().mockImplementation(async function* () {
      yield { type: 'error' as const, error: errorMsg };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getCachedSummary as ReturnType<typeof vi.fn>).mockReturnValue(null);
});

describe('compactIfNeeded - falha propaga', () => {
  it('lanca erro quando compactViaProvider falha (sem trunc)', async () => {
    const msgs = makeMessages(15);
    (getSessionMessages as ReturnType<typeof vi.fn>).mockReturnValue(msgs);

    const adapter = makeFailingAdapter('provider timeout');
    const emitChunk = vi.fn();

    await expect(
      compactIfNeeded({
        sessionId: SESSION_ID,
        newUserMsg: 'mensagem que vai falhar',
        systemPrompt: 'system',
        primaryAdapter: adapter,
        primaryModel: 'unknown-model',
        primaryProvider: 'lmstudio',
        emitChunk,
      }),
    ).rejects.toThrow('provider timeout');
  });

  it('nao chama saveCachedSummary quando compactacao falha', async () => {
    const msgs = makeMessages(15);
    (getSessionMessages as ReturnType<typeof vi.fn>).mockReturnValue(msgs);

    const adapter = makeFailingAdapter('connection refused');
    const emitChunk = vi.fn();

    await expect(
      compactIfNeeded({
        sessionId: SESSION_ID,
        newUserMsg: 'msg',
        systemPrompt: 'system',
        primaryAdapter: adapter,
        primaryModel: 'unknown-model',
        primaryProvider: 'lmstudio',
        emitChunk,
      }),
    ).rejects.toThrow();

    expect(saveCachedSummary).not.toHaveBeenCalled();
  });

  it('emite isCompacting:false antes de relancar o erro', async () => {
    const msgs = makeMessages(15);
    (getSessionMessages as ReturnType<typeof vi.fn>).mockReturnValue(msgs);

    const adapter = makeFailingAdapter('connection refused');
    const emitChunk = vi.fn();

    await expect(
      compactIfNeeded({
        sessionId: SESSION_ID,
        newUserMsg: 'msg',
        systemPrompt: 'system',
        primaryAdapter: adapter,
        primaryModel: 'unknown-model',
        primaryProvider: 'lmstudio',
        emitChunk,
      }),
    ).rejects.toThrow();

    expect(emitChunk).toHaveBeenCalledWith(expect.objectContaining({ type: 'compacting', isCompacting: true }));
    expect(emitChunk).toHaveBeenCalledWith(expect.objectContaining({ type: 'compacting', isCompacting: false }));
  });

  it('nao trunca: o erro propaga diretamente ao caller', async () => {
    const msgs = makeMessages(15);
    (getSessionMessages as ReturnType<typeof vi.fn>).mockReturnValue(msgs);

    const adapter: LionAdapter = {
      name: 'ollama',
      streamCompletion: vi.fn().mockImplementation(async function* () {
        throw new TypeError('fetch failed');
        // eslint-disable-next-line no-unreachable
        yield { type: 'done' as const };
      }),
    };

    const emitChunk = vi.fn();

    await expect(
      compactIfNeeded({
        sessionId: SESSION_ID,
        newUserMsg: 'msg',
        systemPrompt: 'system',
        primaryAdapter: adapter,
        primaryModel: 'unknown-model',
        primaryProvider: 'ollama',
        emitChunk,
      }),
    ).rejects.toThrow('fetch failed');
  });
});
