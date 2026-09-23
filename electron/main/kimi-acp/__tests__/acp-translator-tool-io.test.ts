import { describe, it, expect, vi } from 'vitest';

import { createAccumulator, translateSessionUpdate } from '../acp-translator';
import type { AcpSessionUpdate } from '../types';

describe('contexto-vivo §4 — onToolUseIO (input E output separados)', () => {
  it('input stashado no in_progress + rawOutput do completed chegam SEPARADOS', () => {
    const acc = createAccumulator('sess');
    const onToolUseComplete = vi.fn();
    const onToolUseIO = vi.fn();
    const cb = { onToolUseComplete, onToolUseIO };

    const toolCall: AcpSessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc1',
      title: 'read_file',
      rawInput: { path: '/tmp/a.txt' },
    };
    const completed: AcpSessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: 'completed',
      rawOutput: { text: 'conteudo do arquivo' },
    };

    translateSessionUpdate(toolCall, acc, { callbacks: cb });
    translateSessionUpdate(completed, acc, { callbacks: cb });

    expect(onToolUseIO).toHaveBeenCalledTimes(1);
    expect(onToolUseIO.mock.calls[0]).toHaveLength(4);
    expect(onToolUseIO).toHaveBeenCalledWith(
      'read_file',
      { path: '/tmp/a.txt' },
      { text: 'conteudo do arquivo' },
      'tc1',
    );
    expect(onToolUseComplete).toHaveBeenCalledTimes(1);
    expect(onToolUseComplete).toHaveBeenCalledWith('read_file', { path: '/tmp/a.txt' }, 'tc1');
  });

  it('rawInput que chega no proprio in_progress (nao no tool_call) tambem e separado', () => {
    const acc = createAccumulator('sess');
    const onToolUseIO = vi.fn();

    translateSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc2', title: 'bash' }, acc, {
      callbacks: { onToolUseIO },
    });
    translateSessionUpdate(
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc2', status: 'in_progress', rawInput: { cmd: 'ls' } },
      acc,
      { callbacks: { onToolUseIO } },
    );
    translateSessionUpdate(
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc2', status: 'completed', rawOutput: 'a b c' },
      acc,
      { callbacks: { onToolUseIO } },
    );

    expect(onToolUseIO.mock.calls[0]).toHaveLength(4);
    expect(onToolUseIO).toHaveBeenCalledWith('bash', { cmd: 'ls' }, 'a b c', 'tc2');
  });

  it('sem rawInput stashado: input fica undefined e o output NAO colapsa pro lado do input', () => {
    const acc = createAccumulator('sess');
    const onToolUseComplete = vi.fn();
    const onToolUseIO = vi.fn();

    translateSessionUpdate(
      { sessionUpdate: 'tool_call_update', toolCallId: 'orfao', status: 'completed', rawOutput: { r: 1 } },
      acc,
      { callbacks: { onToolUseComplete, onToolUseIO } },
    );

    expect(onToolUseComplete).toHaveBeenCalledWith('tool', { r: 1 }, 'orfao');
    expect(onToolUseIO.mock.calls[0]).toHaveLength(4);
    expect(onToolUseIO).toHaveBeenCalledWith('tool', undefined, { r: 1 }, 'orfao');
  });

  it('callback ausente = no-op (callers antigos byte-identicos)', () => {
    const acc = createAccumulator('sess');
    const onToolUseComplete = vi.fn();
    expect(() => {
      translateSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'x', rawInput: 1 }, acc, {
        callbacks: { onToolUseComplete },
      });
      translateSessionUpdate(
        { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', rawOutput: 2 },
        acc,
        { callbacks: { onToolUseComplete } },
      );
    }).not.toThrow();
    expect(onToolUseComplete).toHaveBeenCalledWith('x', 1, 't');
  });
});
