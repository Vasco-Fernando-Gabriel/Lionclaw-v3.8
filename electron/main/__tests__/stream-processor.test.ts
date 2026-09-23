import { describe, it, expect } from 'vitest';
import { processAgentStream } from '../stream-processor';
import type { StreamCallbacks } from '../stream-processor';

async function* toAsync(events: Array<Record<string, unknown>>) {
  for (const e of events) yield e;
}

function textDelta(text: string): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  };
}

function blockStop(): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: { type: 'content_block_stop' },
  };
}

function blockStartToolUse(name: string): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      content_block: { type: 'tool_use', name },
    },
  };
}

function messageStart(inputTokens = 0, cacheRead = 0, cacheCreation = 0): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: inputTokens,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreation,
        },
      },
    },
  };
}

function messageDelta(outputTokens: number): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: {
      type: 'message_delta',
      usage: { output_tokens: outputTokens },
    },
  };
}

function resultEvent(text: string): Record<string, unknown> {
  return { type: 'result', result: text };
}

const noCallbacks: StreamCallbacks = {};

describe('processAgentStream: accumulatedText and textBlocks', () => {
  it('accumulates text in a single block correctly', async () => {
    const events = [textDelta('hello '), textDelta('world'), blockStop()];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.accumulatedText).toBe('hello world');
    expect(result.textBlocks).toHaveLength(1);
    expect(result.textBlocks[0]).toBe('hello world');
    expect(result.output).toBe('hello world');
  });

  it('separates text blocks correctly when interleaved with tool_use', async () => {
    const events = [textDelta('A'), blockStop(), blockStartToolUse('MyTool'), blockStop(), textDelta('B'), blockStop()];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.textBlocks).toHaveLength(2);
    expect(result.textBlocks[0]).toBe('A');
    expect(result.textBlocks[1]).toBe('B');
    expect(result.accumulatedText).toBe('AB');
  });

  it('returns empty values for empty stream', async () => {
    const result = await processAgentStream(toAsync([]), noCallbacks);

    expect(result.textBlocks).toEqual([]);
    expect(result.accumulatedText).toBe('');
    expect(result.output).toBe('');
    expect(result.metrics.apiRequests).toBe(0);
    expect(result.metrics.inputTokens).toBe(0);
  });

  it('uses result event as output and still tracks accumulatedText', async () => {
    const events = [textDelta('some text'), blockStop(), resultEvent('final answer')];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.output).toBe('final answer');
    expect(result.accumulatedText).toBe('some text');
    expect(result.textBlocks).toHaveLength(1);
    expect(result.textBlocks[0]).toBe('some text');
  });

  it('flushes an unclosed text block into textBlocks after stream ends', async () => {
    const events = [textDelta('unclosed block content')];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.textBlocks).toHaveLength(1);
    expect(result.textBlocks[0]).toBe('unclosed block content');
    expect(result.accumulatedText).toBe('unclosed block content');
  });

  it('handles JSON block + tool_use + comment block with empty result event', async () => {
    const jsonPayload = '{"plans":[{"id":1}]}';
    const commentText = 'Planning complete.';

    const events = [
      textDelta(jsonPayload),
      blockStop(),
      blockStartToolUse('save_plan'),
      blockStop(),
      textDelta(commentText),
      blockStop(),
      resultEvent(''),
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.textBlocks).toHaveLength(2);
    expect(result.textBlocks[0]).toBe(jsonPayload);
    expect(result.textBlocks[1]).toBe(commentText);
    expect(result.accumulatedText).toBe(jsonPayload + commentText);
    expect(result.output).toBe(jsonPayload + commentText);
  });

  it('tracks metrics correctly while collecting text blocks', async () => {
    const events = [messageStart(10, 2, 3), textDelta('hello'), blockStop(), messageDelta(5)];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.metrics.apiRequests).toBe(1);
    expect(result.metrics.inputTokens).toBe(15);
    expect(result.metrics.cacheReadTokens).toBe(2);
    expect(result.metrics.cacheCreationTokens).toBe(3);
    expect(result.metrics.outputTokens).toBe(5);
    expect(result.accumulatedText).toBe('hello');
    expect(result.textBlocks).toHaveLength(1);
  });

  it('does not add empty tool_use blocks to textBlocks', async () => {
    const events = [blockStartToolUse('ToolA'), blockStop(), blockStartToolUse('ToolB'), blockStop()];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.textBlocks).toHaveLength(0);
    expect(result.accumulatedText).toBe('');
    expect(result.metrics.toolUses).toBe(2);
  });
});

function inputJsonDelta(partialJson: string): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: partialJson },
    },
  };
}

describe('processAgentStream: onToolUseComplete', () => {
  it('assembles input_json_delta fragments and calls onToolUseComplete', async () => {
    const calls: Array<{ name: string; input: unknown }> = [];

    const events = [blockStartToolUse('Read'), inputJsonDelta('{"file_pa'), inputJsonDelta('th":"a.ts"}'), blockStop()];

    await processAgentStream(toAsync(events), {
      onToolUseComplete: (name, input) => calls.push({ name, input }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('Read');
    expect(calls[0].input).toEqual({ file_path: 'a.ts' });
  });

  it('fires onToolUse (legacy) in addition to onToolUseComplete', async () => {
    const legacyCalls: string[] = [];
    const completeCalls: Array<{ name: string; input: unknown }> = [];

    const events = [blockStartToolUse('Read'), inputJsonDelta('{"file_path":"b.ts"}'), blockStop()];

    await processAgentStream(toAsync(events), {
      onToolUse: (name) => legacyCalls.push(name),
      onToolUseComplete: (name, input) => completeCalls.push({ name, input }),
    });

    expect(legacyCalls).toEqual(['Read']);
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0].input).toEqual({ file_path: 'b.ts' });
  });

  it('works correctly when onToolUseComplete is not provided', async () => {
    const events = [blockStartToolUse('Read'), inputJsonDelta('{"file_path":"c.ts"}'), blockStop()];

    const result = await processAgentStream(toAsync(events), {});

    expect(result.metrics.toolUses).toBe(1);
  });

  it('passes null input when accumulated JSON is malformed', async () => {
    const calls: Array<{ name: string; input: unknown }> = [];

    const events = [blockStartToolUse('Read'), inputJsonDelta('{bad json'), blockStop()];

    await processAgentStream(toAsync(events), {
      onToolUseComplete: (name, input) => calls.push({ name, input }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('Read');
    expect(calls[0].input).toBeNull();
  });

  it('fires onToolUseComplete separately for each sequential tool_use block', async () => {
    const calls: Array<{ name: string; input: unknown }> = [];

    const events = [
      blockStartToolUse('Read'),
      inputJsonDelta('{"file_path":"x.ts"}'),
      blockStop(),
      blockStartToolUse('Glob'),
      inputJsonDelta('{"pattern":"**/*.ts"}'),
      blockStop(),
    ];

    await processAgentStream(toAsync(events), {
      onToolUseComplete: (name, input) => calls.push({ name, input }),
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ name: 'Read', input: { file_path: 'x.ts' } });
    expect(calls[1]).toEqual({ name: 'Glob', input: { pattern: '**/*.ts' } });
  });

  it('handles empty initial block.input followed by input_json_delta without corruption', async () => {
    const events = [
      {
        type: 'stream_event' as const,
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', name: 'Read', input: {} },
        },
      },
      {
        type: 'stream_event' as const,
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{"file_pa' },
        },
      },
      {
        type: 'stream_event' as const,
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: 'th":"foo.ts"}' },
        },
      },
      {
        type: 'stream_event' as const,
        event: { type: 'content_block_stop' },
      },
    ];

    const completes: Array<{ name: string; input: unknown }> = [];
    await processAgentStream(toAsync(events), {
      onToolUseComplete: (name, input) => {
        completes.push({ name, input });
      },
    });

    expect(completes).toEqual([{ name: 'Read', input: { file_path: 'foo.ts' } }]);
  });
});

describe('processAgentStream: reconciliacao de usage com o result final', () => {
  function messageStartSemUsage(): Record<string, unknown> {
    return {
      type: 'stream_event',
      event: { type: 'message_start', message: {} },
    };
  }

  function resultEventComUsage(text: string, usage: Record<string, number>): Record<string, unknown> {
    return { type: 'result', result: text, usage };
  }

  it('compat sem usage no message_start: input vem do result final', async () => {
    const events = [
      messageStartSemUsage(),
      textDelta('oi'),
      blockStop(),
      messageDelta(500),
      resultEventComUsage('oi', {
        input_tokens: 1_000,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 2_000,
        output_tokens: 500,
      }),
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.metrics.inputTokens).toBe(43_000);
    expect(result.metrics.cacheReadTokens).toBe(40_000);
    expect(result.metrics.cacheCreationTokens).toBe(2_000);
    expect(result.metrics.outputTokens).toBe(500);
  });

  it('cloud com usage no stream: result final nao infla o acumulado', async () => {
    const events = [
      messageStart(100, 30_000, 1_000),
      textDelta('a'),
      blockStop(),
      messageDelta(200),
      messageStart(150, 31_000, 0),
      textDelta('b'),
      blockStop(),
      messageDelta(300),
      resultEventComUsage('ab', {
        input_tokens: 250,
        cache_read_input_tokens: 61_000,
        cache_creation_input_tokens: 1_000,
        output_tokens: 500,
      }),
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.metrics.inputTokens).toBe(62_250);
    expect(result.metrics.outputTokens).toBe(500);
    expect(result.metrics.cacheReadTokens).toBe(61_000);
    expect(result.metrics.cacheCreationTokens).toBe(1_000);
  });

  it('result sem usage: metricas do stream ficam intactas', async () => {
    const events = [messageStart(100, 0, 0), messageDelta(50), resultEvent('x')];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.metrics.inputTokens).toBe(100);
    expect(result.metrics.outputTokens).toBe(50);
  });
});

function messageStartComId(id: string, usage?: Record<string, number>): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { id, ...(usage ? { usage } : {}) },
    },
  };
}

function assistantMessage(
  id: string | undefined,
  usage: Record<string, number>,
  parentToolUseId?: string,
): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { ...(id !== undefined ? { id } : {}), usage },
    ...(parentToolUseId !== undefined ? { parent_tool_use_id: parentToolUseId } : {}),
  };
}

function systemInit(sessionId: string): Record<string, unknown> {
  return { type: 'system', subtype: 'init', session_id: sessionId };
}

describe('processAgentStream: BUG 3 F1 — usage por request (mapa por message.id)', () => {
  it('assistant messages duplicadas por content block (mesmo id) contam UMA vez (MAX, nao soma)', async () => {
    const usage = {
      input_tokens: 100,
      cache_read_input_tokens: 1_000,
      cache_creation_input_tokens: 200,
      output_tokens: 50,
    };
    const events = [
      assistantMessage('msg_1', usage),
      assistantMessage('msg_1', usage),
      assistantMessage('msg_1', { input_tokens: 0, output_tokens: 0 }), // dupe zerada (padrao GLM)
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.metrics.inputTokens).toBe(1_300);
    expect(result.metrics.cacheReadTokens).toBe(1_000);
    expect(result.metrics.cacheCreationTokens).toBe(200);
    expect(result.metrics.outputTokens).toBe(50);
    expect(result.metrics.apiRequests).toBe(0);
  });

  it('arbitragem message_start x assistant do mesmo id: MAX por campo, nunca soma dos dois acumuladores', async () => {
    const usage = {
      input_tokens: 100,
      cache_read_input_tokens: 2_000,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
    };
    const events = [messageStartComId('msg_1', usage), assistantMessage('msg_1', { ...usage, output_tokens: 80 })];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.metrics.inputTokens).toBe(2_100);
    expect(result.metrics.outputTokens).toBe(80);
    expect(result.metrics.apiRequests).toBe(1);
  });

  it('sidechain (parent_tool_use_id) com id proprio conta como request separada', async () => {
    const events = [
      messageStartComId('msg_main', { input_tokens: 100, output_tokens: 0 }),
      messageDelta(10),
      assistantMessage('msg_side', { input_tokens: 500, output_tokens: 40 }, 'toolu_01'),
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.metrics.inputTokens).toBe(600);
    expect(result.metrics.outputTokens).toBe(50);
  });

  it('message_delta cumulativo dentro do mesmo id: MAX, nunca +=', async () => {
    const events = [
      messageStartComId('msg_1', { input_tokens: 100 }),
      messageDelta(100),
      messageDelta(150), // cumulativo da mesma request
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.metrics.outputTokens).toBe(150);
  });

  it('id constante/repetido no compat: fallback sintetico por message_start (nao colapsa requests)', async () => {
    const events = [
      messageStartComId('const-id', { input_tokens: 100 }),
      messageStartComId('const-id', { input_tokens: 120 }),
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.metrics.inputTokens).toBe(220);
    expect(result.metrics.apiRequests).toBe(2);
  });

  it('id ausente no compat: cada message_start ganha chave sintetica propria', async () => {
    const events = [messageStart(100, 0, 0), messageStart(150, 0, 0)];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.metrics.inputTokens).toBe(250);
  });

  it('assistant sem id herda a request corrente (MAX), sem dupla contagem', async () => {
    const usage = { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 30 };
    const events = [messageStartComId('msg_1', usage), assistantMessage(undefined, usage)];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.metrics.inputTokens).toBe(100);
    expect(result.metrics.outputTokens).toBe(30);
  });
});

describe('processAgentStream: BUG 3 F1 — captura do result (custo/modelUsage/sessionIds)', () => {
  it('result com total_cost_usd, modelUsage e session_id expostos no StreamProcessorResult', async () => {
    const events = [
      systemInit('sess-init'),
      messageStartComId('msg_1', { input_tokens: 100 }),
      textDelta('oi'),
      blockStop(),
      {
        type: 'result',
        result: 'oi',
        usage: { input_tokens: 100, output_tokens: 5 },
        total_cost_usd: 1.23,
        session_id: 'sess-result',
        modelUsage: {
          'claude-opus-4-8': {
            inputTokens: 80,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 1.0,
          },
          'claude-haiku-4-5-20251001': {
            inputTokens: 20,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.23,
          },
        },
      },
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.totalCostUsd).toBe(1.23);
    expect(result.modelUsage).toBeDefined();
    expect(Object.keys(result.modelUsage!)).toHaveLength(2);
    expect(result.modelUsage!['claude-opus-4-8'].costUSD).toBe(1.0);
    expect(result.sessionIds).toEqual(expect.arrayContaining(['sess-init', 'sess-result']));
    expect(result.sessionIds).toHaveLength(2);
  });

  it('SDKResultError (sem `result`) ainda entrega usage/total_cost_usd/session_id', async () => {
    const events = [
      systemInit('sess-1'),
      messageStartComId('msg_1', { input_tokens: 50 }),
      textDelta('parcial'),
      blockStop(),
      {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        usage: { input_tokens: 900, cache_read_input_tokens: 100, output_tokens: 70 },
        total_cost_usd: 0.5,
        session_id: 'sess-1',
      },
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.metrics.inputTokens).toBe(1_000);
    expect(result.metrics.outputTokens).toBe(70);
    expect(result.totalCostUsd).toBe(0.5);
    expect(result.sessionIds).toEqual(['sess-1']);
    expect(result.output).toBe('parcial');
  });

  it('abort/crash sem result: sem totalCostUsd, mapa e a unica fonte, session do init sobrevive', async () => {
    const events = [systemInit('sess-abortada'), messageStartComId('msg_1', { input_tokens: 300 }), messageDelta(20)];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.totalCostUsd).toBeUndefined();
    expect(result.metrics.inputTokens).toBe(300);
    expect(result.metrics.outputTokens).toBe(20);
    expect(result.sessionIds).toEqual(['sess-abortada']);
  });

  it('piso do result nao e teto: mapa acima do result prevalece (objecao iv)', async () => {
    const events = [
      messageStartComId('msg_1', { input_tokens: 1_000 }),
      messageStartComId('msg_2', { input_tokens: 1_000 }), // retry billing-visivel
      { type: 'result', result: 'x', usage: { input_tokens: 1_200, output_tokens: 0 } },
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.metrics.inputTokens).toBe(2_000);
  });
});
