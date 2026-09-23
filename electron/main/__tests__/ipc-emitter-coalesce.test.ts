import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sends: Array<{ channel: string; payload: unknown }> = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            sends.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

import { emitIPC, flushCoalescedStreams } from '../pipeline-shared/ipc-emitter';

function textChunk(content: string, extra: Record<string, unknown> = {}) {
  return { projectId: 'p1', phase: 11, type: 'text', content, ...extra };
}

describe('emitIPC: coalescing de texto de stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sends.length = 0;
  });

  afterEach(() => {
    flushCoalescedStreams();
    sends.length = 0;
    vi.useRealTimers();
  });

  it('concatena deltas consecutivos da mesma origem em um send no timer', () => {
    emitIPC('pipeline:stream', textChunk('a'));
    emitIPC('pipeline:stream', textChunk('b'));
    emitIPC('pipeline:stream', textChunk('c'));
    expect(sends).toHaveLength(0);

    vi.advanceTimersByTime(100);

    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual({
      channel: 'pipeline:stream',
      payload: { projectId: 'p1', phase: 11, type: 'text', content: 'abc' },
    });
  });

  it('evento de controle da flush no texto bufferizado antes de sair (ordem preservada)', () => {
    emitIPC('pipeline:stream', textChunk('hello '));
    emitIPC('pipeline:stream', textChunk('world'));
    emitIPC('pipeline:stream', { projectId: 'p1', phase: 11, type: 'done' });

    expect(sends).toHaveLength(2);
    expect(sends[0].payload).toMatchObject({ type: 'text', content: 'hello world' });
    expect(sends[1].payload).toMatchObject({ type: 'done' });
  });

  it('emit em canal qualquer da flush em todos os buffers pendentes', () => {
    emitIPC('pipeline:stream', textChunk('x'));
    emitIPC('harness:agent-stream', { projectId: 'p1', agent: 'coder', type: 'text', content: 'y' });
    emitIPC('pipeline:phase-changed', { projectId: 'p1', phase: 12 });

    expect(sends).toHaveLength(3);
    expect(sends[0].payload).toMatchObject({ type: 'text', content: 'x' });
    expect(sends[1].payload).toMatchObject({ agent: 'coder', content: 'y' });
    expect(sends[2].channel).toBe('pipeline:phase-changed');
  });

  it('origens diferentes (metadata/agent) nao se misturam', () => {
    emitIPC('pipeline:stream', textChunk('a', { metadata: { agent: 'coder', round: 1 } }));
    emitIPC('pipeline:stream', textChunk('b', { metadata: { agent: 'evaluator', round: 1 } }));

    vi.advanceTimersByTime(100);

    expect(sends).toHaveLength(2);
    expect(sends[0].payload).toMatchObject({ content: 'a', metadata: { agent: 'coder', round: 1 } });
    expect(sends[1].payload).toMatchObject({ content: 'b', metadata: { agent: 'evaluator', round: 1 } });
  });

  it('flush por tamanho quando o buffer passa do limite', () => {
    const big = 'x'.repeat(16_500);
    emitIPC('pipeline:stream', textChunk('start-'));
    emitIPC('pipeline:stream', textChunk(big));

    expect(sends).toHaveLength(1);
    expect((sends[0].payload as { content: string }).content).toBe(`start-${big}`);
  });

  it('canais fora da allowlist passam direto, shape intacto', () => {
    const payload = { sessionId: 's1', type: 'text', content: 'chat' };
    emitIPC('enrich:stream', payload);

    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual({ channel: 'enrich:stream', payload });
  });

  it('tool_call no canal coalescivel nao e bufferizado e da flush no texto', () => {
    emitIPC('pipeline:stream', textChunk('before'));
    emitIPC('pipeline:stream', { projectId: 'p1', phase: 11, type: 'tool_call', tool: 'Bash' });

    expect(sends).toHaveLength(2);
    expect(sends[0].payload).toMatchObject({ type: 'text', content: 'before' });
    expect(sends[1].payload).toMatchObject({ type: 'tool_call', tool: 'Bash' });
  });
});
