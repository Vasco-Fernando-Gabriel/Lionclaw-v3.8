import { describe, it, expect, vi } from 'vitest';

import { createAccumulator, translateSessionUpdate, finalizeResponse, stopReasonToOutcome } from '../acp-translator';
import type { AcpSessionUpdate } from '../types';

const GOLDEN_UPDATES: AcpSessionUpdate[] = [
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Analyzing ' } },
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'I should read the file first.' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the request.' } },
  { sessionUpdate: 'tool_call', toolCallId: 'tc_1', title: 'Bash', kind: 'execute', status: 'pending' },
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc_1',
    status: 'in_progress',
    rawInput: { command: 'echo hi' },
    title: 'Bash',
  },
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc_1',
    status: 'completed',
    rawOutput: { stdout: 'hi\n', exitCode: 0 },
    content: [{ type: 'text', text: 'hi' }] as unknown as AcpSessionUpdate['content'],
    title: 'Bash',
  },
  { sessionUpdate: 'available_commands_update' },
  { sessionUpdate: 'totally_unknown_update_kind' },
];

describe('acp-translator golden (D1) - OBSERVED ACP session/update mapping', () => {
  it('maps the observed session/update stream onto callbacks + a finished CliAgenticResponse', () => {
    const onText = vi.fn();
    const onThinking = vi.fn();
    const onToolUse = vi.fn();
    const onToolUseComplete = vi.fn();
    const onActivity = vi.fn();
    const onUnknownUpdate = vi.fn();

    const acc = createAccumulator('sess_golden');

    for (const update of GOLDEN_UPDATES) {
      translateSessionUpdate(update, acc, {
        callbacks: { onText, onThinking, onToolUse, onToolUseComplete, onActivity },
        onUnknownUpdate,
      });
    }

    expect(onText.mock.calls).toEqual([['Analyzing '], ['the request.']]);
    expect(onThinking.mock.calls).toEqual([['I should read the file first.']]);
    expect(onToolUse.mock.calls).toEqual([['Bash', 'tc_1']]);
    expect(onToolUseComplete).toHaveBeenCalledTimes(1);
    expect(onToolUseComplete).toHaveBeenCalledWith('Bash', { command: 'echo hi' }, 'tc_1');

    expect(onActivity).not.toHaveBeenCalled();

    expect(onUnknownUpdate).toHaveBeenCalledTimes(1);
    expect(onUnknownUpdate).toHaveBeenCalledWith({ sessionUpdate: 'totally_unknown_update_kind' });

    const response = finalizeResponse(acc, stopReasonToOutcome('end_turn'));
    expect(response).toEqual({
      content: 'Analyzing the request.',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      toolUses: 1,
      status: 'finished',
    });
  });

  it('resolves the tool NAME via toolCallId and passes the stashed in_progress rawInput (NOT undefined)', () => {
    const onToolUse = vi.fn();
    const onToolUseComplete = vi.fn();
    const acc = createAccumulator(null);

    translateSessionUpdate(
      { sessionUpdate: 'tool_call', toolCallId: 'tc_x', title: 'Read', kind: 'read', status: 'pending' },
      acc,
      { callbacks: { onToolUse, onToolUseComplete } },
    );
    translateSessionUpdate(
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc_x', status: 'in_progress', rawInput: { path: 'a.ts' } },
      acc,
      { callbacks: { onToolUse, onToolUseComplete } },
    );
    translateSessionUpdate(
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc_x', status: 'completed', rawOutput: 'export const x = 1;' },
      acc,
      { callbacks: { onToolUse, onToolUseComplete } },
    );

    expect(onToolUse.mock.calls).toEqual([['Read', 'tc_x']]);
    expect(onToolUseComplete).toHaveBeenCalledTimes(1);
    expect(onToolUseComplete).toHaveBeenCalledWith('Read', { path: 'a.ts' }, 'tc_x');
    expect(acc.toolUses).toBe(1);
  });

  it('falls back to rawOutput when no in_progress rawInput was stashed (never passes undefined off a completed-only update)', () => {
    const onToolUseComplete = vi.fn();
    const acc = createAccumulator(null);

    translateSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc_y', title: 'Grep', status: 'pending' }, acc, {
      callbacks: { onToolUseComplete },
    });
    translateSessionUpdate(
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc_y', status: 'completed', rawOutput: { matches: 3 } },
      acc,
      { callbacks: { onToolUseComplete } },
    );

    expect(onToolUseComplete).toHaveBeenCalledWith('Grep', { matches: 3 }, 'tc_y');
  });

  it('an agent_thought_chunk never lands in content; an unknown update has no content impact', () => {
    const acc = createAccumulator(null);
    const onUnknownUpdate = vi.fn();

    translateSessionUpdate(
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'reasoning only' } },
      acc,
    );
    translateSessionUpdate({ sessionUpdate: 'mystery' }, acc, { onUnknownUpdate });

    expect(acc.content).toBe('');
    expect(onUnknownUpdate).toHaveBeenCalledWith({ sessionUpdate: 'mystery' });
  });

  it('finalizeResponse maps cancelled and failed outcomes onto the contract status union', () => {
    const acc = createAccumulator(null);

    expect(finalizeResponse(acc, 'cancelled').status).toBe('cancelled');
    expect(finalizeResponse(acc, 'failed').status).toBe('max_steps_reached');
    expect(finalizeResponse(acc, 'completed').status).toBe('finished');

    const cancelledAcc = { ...createAccumulator(null), cancelled: true };
    expect(finalizeResponse(cancelledAcc, 'completed').status).toBe('cancelled');
    const failedAcc = { ...createAccumulator(null), failed: true };
    expect(finalizeResponse(failedAcc, 'completed').status).toBe('max_steps_reached');
  });
});

describe('stopReasonToOutcome - observed + defensive mapping table', () => {
  it.each([
    ['end_turn', 'completed'],
    ['stop', 'completed'],
    ['completed', 'completed'],
    ['cancelled', 'cancelled'],
    ['interrupted', 'cancelled'],
    ['max_tokens', 'failed'],
    ['max_steps', 'failed'],
    ['refusal', 'failed'],
    ['some_unrecognized_reason', 'completed'],
    [undefined, 'completed'],
  ])('maps stopReason %s -> %s', (stopReason, expected) => {
    expect(stopReasonToOutcome(stopReason as string | undefined)).toBe(expected);
  });
});
