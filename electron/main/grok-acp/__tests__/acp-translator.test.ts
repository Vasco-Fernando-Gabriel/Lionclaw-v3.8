import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  createGrokAccumulator,
  finalizeGrokResponse,
  grokStopReasonOutcome,
  parseGrokUsage,
  translateGrokSessionUpdate,
} from '../acp-translator';

describe('Grok ACP translator', () => {
  it('consome a fixture real redigida do wire 0.2.103 e mantém F1-F10 explícitos', () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'grok-0.2.103-linux-redacted.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
      cli: { version: string; defaultModel: string };
      cases: Record<string, { status: string; pending?: string[] }>;
      wire: {
        initializeResult: { authMethods: Array<{ id: string }> };
        authenticateRequest: { methodId: string };
        sessionNewResult: { models: { currentModelId: string } };
        updates: Array<Record<string, unknown>>;
        terminalResult: Record<string, unknown>;
      };
    };

    expect(fixture.cli).toMatchObject({ version: '0.2.103', defaultModel: 'grok-4.5' });
    expect(Object.keys(fixture.cases)).toEqual(Array.from({ length: 10 }, (_, index) => `F${index + 1}`));
    expect(fixture.cases.F9).toMatchObject({ status: 'partially-observed', pending: ['macos', 'windows'] });
    expect(fixture.wire.initializeResult.authMethods.map(({ id }) => id)).toContain('cached_token');
    expect(fixture.wire.authenticateRequest.methodId).toBe('cached_token');
    expect(fixture.wire.sessionNewResult.models.currentModelId).toBe('grok-4.5');

    const accumulator = createGrokAccumulator();
    for (const raw of fixture.wire.updates) {
      translateGrokSessionUpdate(raw as never, accumulator);
    }
    expect(accumulator).toMatchObject({ content: '<redacted-response>', toolUses: 1 });
    expect(finalizeGrokResponse(accumulator, 'completed', fixture.wire.terminalResult)).toMatchObject({
      status: 'finished',
      usage: {
        reported: true,
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 7,
        costUsdTicks: 270800000,
      },
      metadata: { modelId: 'grok-4.5' },
    });
  });

  it('separa texto, reasoning e IO de tool', () => {
    const acc = createGrokAccumulator();
    const onText = vi.fn();
    const onThinking = vi.fn();
    const onToolUseIO = vi.fn();
    translateGrokSessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { text: 'pensando' } }, acc, { onThinking });
    translateGrokSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'feito' } }, acc, { onText });
    translateGrokSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write', rawInput: { file_path: 'a' } }, acc);
    translateGrokSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: 'ok' }, acc, { onToolUseIO });
    expect(acc.content).toBe('feito');
    expect(acc.toolUses).toBe(1);
    expect(onText).toHaveBeenCalledWith('feito');
    expect(onThinking).toHaveBeenCalledWith('pensando');
    expect(onToolUseIO).toHaveBeenCalledWith('Write', { file_path: 'a' }, 'ok', 't1');
  });

  it('normaliza usage real e costUsdTicks sem requestId', () => {
    const terminal = {
      stopReason: 'end_turn',
      _meta: {
        modelId: 'grok-4.5',
        requestId: 'redact-me',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedReadTokens: 30,
          reasoningTokens: 7,
          modelCalls: 2,
          apiDurationMs: 42,
          costUsdTicks: 270_800_000,
          numTurns: 3,
        },
      },
    };
    expect(parseGrokUsage(terminal)).toMatchObject({
      reported: true,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      reasoningTokens: 7,
      modelCalls: 2,
      apiDurationMs: 42,
      costUsdTicks: 270_800_000,
      numTurns: 3,
    });
    const response = finalizeGrokResponse(createGrokAccumulator(), 'completed', terminal);
    expect(response.metadata).not.toHaveProperty('requestId');
  });

  it('nao trata envelope zerado como token usage reportado', () => {
    expect(parseGrokUsage({ _meta: { usage: { inputTokens: 0, outputTokens: 0 } } }).reported).toBe(false);
    expect(parseGrokUsage({ _meta: {} }).reported).toBe(false);
  });

  it('mantem envelopes unilaterais como usage nao reportado', () => {
    expect(parseGrokUsage({ _meta: { usage: { inputTokens: 10, outputTokens: 0 } } }).reported).toBe(false);
    expect(parseGrokUsage({ _meta: { usage: { inputTokens: 0, outputTokens: 5 } } }).reported).toBe(false);
    expect(parseGrokUsage({ _meta: { usage: { cacheCreationTokens: 9 } } }).reported).toBe(false);
  });

  it('aceita zero legitimo somente com atestado explicito de completude', () => {
    expect(parseGrokUsage({
      _meta: { usage: { reported: true, inputTokens: 10, outputTokens: 0 } },
    }).reported).toBe(true);
  });

  it('trata reported:false explicito como veto mesmo com dimensoes positivas', () => {
    const terminal = {
      _meta: {
        requestId: 'nao-persistir',
        usage: {
          reported: false,
          inputTokens: 100,
          outputTokens: 20,
          cachedReadTokens: 10,
          reasoningTokens: 7,
          costUsdTicks: 270_800_000,
        },
      },
    };

    expect(parseGrokUsage(terminal)).toEqual({
      reported: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(finalizeGrokResponse(createGrokAccumulator(), 'completed', terminal).metadata).toEqual({
      rawUsage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 10,
        reasoningTokens: 7,
        costUsdTicks: 270_800_000,
      },
    });
  });

  it('invalida o envelope inteiro quando cache creation e reportado', () => {
    const terminal = {
      _meta: {
        usage: {
          reported: true,
          inputTokens: 100,
          outputTokens: 20,
          cachedReadTokens: 10,
          cacheCreationTokens: 9,
          reasoningTokens: 7,
          modelCalls: 1,
          costUsdTicks: 270_800_000,
        },
      },
    };

    expect(parseGrokUsage(terminal)).toEqual({
      reported: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(finalizeGrokResponse(createGrokAccumulator(), 'completed', terminal).metadata)
      .not.toHaveProperty('costUsdTicks');
  });

  it.each([
    ['inputTokens', 10.5],
    ['outputTokens', 20.5],
    ['cachedReadTokens', 3.5],
    ['inputTokens', Number.MAX_SAFE_INTEGER + 1],
  ])('invalida o envelope inteiro para dimensao canonica invalida: %s', (field, value) => {
    const terminal = {
      _meta: {
        usage: {
          reported: true,
          inputTokens: 100,
          outputTokens: 20,
          cachedReadTokens: 10,
          [field]: value,
          costUsdTicks: 270_800_000,
        },
      },
    };

    expect(parseGrokUsage(terminal)).toEqual({
      reported: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    const metadata = finalizeGrokResponse(createGrokAccumulator(), 'completed', terminal).metadata;
    expect(metadata).not.toHaveProperty('costUsdTicks');
    expect(metadata?.rawUsage).toMatchObject({
      [field === 'cachedReadTokens' ? 'cacheReadTokens' : field]: value,
      costUsdTicks: 270_800_000,
    });
  });

  it('invalida o envelope inteiro quando cache read excede o input inclusivo', () => {
    const terminal = {
      _meta: {
        usage: {
          reported: true,
          inputTokens: 10,
          outputTokens: 2,
          cachedReadTokens: 11,
          costUsdTicks: 270_800_000,
        },
      },
    };

    expect(parseGrokUsage(terminal).reported).toBe(false);
    expect(finalizeGrokResponse(createGrokAccumulator(), 'completed', terminal).metadata)
      .toEqual({
        rawUsage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 11,
          costUsdTicks: 270_800_000,
        },
      });
  });

  it('aceita safe integer no boundary inclusivo de cache igual ao input', () => {
    const terminal = {
      _meta: {
        usage: {
          reported: true,
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: 0,
          cachedReadTokens: Number.MAX_SAFE_INTEGER,
          cacheCreationTokens: 0,
          costUsdTicks: 270_800_000,
        },
      },
    };

    expect(parseGrokUsage(terminal)).toMatchObject({
      reported: true,
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 0,
      cacheReadTokens: Number.MAX_SAFE_INTEGER,
      cacheCreationTokens: 0,
      costUsdTicks: 270_800_000,
    });
  });

  it('rejeita modelUsage incompleto em vez de fabricar zeros', () => {
    expect(parseGrokUsage({
      _meta: {
        usage: {
          inputTokens: 10,
          modelCalls: 1,
          modelUsage: { 'grok-4.5': { modelCalls: 1 } },
        },
      },
    }).modelUsage).toBeUndefined();
  });

  it('falha fechado para stopReason desconhecido', () => {
    expect(grokStopReasonOutcome('brand_new_failure')).toBe('failed');
  });
});
