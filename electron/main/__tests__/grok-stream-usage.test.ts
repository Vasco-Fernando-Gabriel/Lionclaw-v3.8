import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ insertAuditEntry: vi.fn() }));
import {
  createGrokAccumulator,
  translateGrokSessionUpdate,
  type GrokAcpResponse,
} from '../grok-acp/acp-translator';
import { buildGrokUsageSnapshot, createGrokStreamTranslator } from '../grok-sdk/stream-translator';
import type { AuditEntry, StreamChunk } from '../../../src/types';

function response(overrides: Partial<GrokAcpResponse> = {}): GrokAcpResponse {
  return {
    content: 'ok',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    toolUses: 0,
    status: 'finished',
    ...overrides,
  };
}

describe('Grok authoritative stream usage', () => {
  it('emite e audita o output real da tool, nao o input legado', () => {
    const chunks: StreamChunk[] = [];
    const audits: Array<Omit<AuditEntry, 'id' | 'createdAt'>> = [];
    const translator = createGrokStreamTranslator({
      sessionId: 'session-1',
      model: 'grok-4.5',
      emit: (chunk) => chunks.push(chunk),
      onAuditEntry: (entry) => audits.push(entry),
    });
    const accumulator = createGrokAccumulator();
    translateGrokSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Read',
      rawInput: { file_path: '/repo/a.ts' },
    }, accumulator, translator.callbacks);
    translateGrokSessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'completed',
      rawOutput: 'conteudo real',
    }, accumulator, translator.callbacks);

    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_result', tool: 'Read', result: 'conteudo real' }),
    ]));
    expect(chunks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_result', result: '{"file_path":"/repo/a.ts"}' }),
    ]));
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'tool_result', toolName: 'Read', output: 'conteudo real' }),
    ]));
  });

  it('emits one honest estimated snapshot when provider usage is absent', () => {
    expect(buildGrokUsageSnapshot(response(), 'grok-4.5', { inputTokens: 12, outputTokens: 3 }))
      .toMatchObject({
        inputTokens: 12,
        outputTokens: 3,
        estimated: true,
        costUsd: null,
        costStatus: 'unknown',
        tokenStatus: 'not_reported',
      });
  });

  it('mantem usage unilateral como estimado e custo desconhecido', () => {
    expect(buildGrokUsageSnapshot(response({
      usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 10, cacheCreationTokens: 0 },
      metadata: { costUsdTicks: 1_250_000_000 },
    }), 'grok-4.5', { inputTokens: 12, outputTokens: 3 })).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      estimated: true,
      costUsd: null,
      costStatus: 'unknown',
      tokenStatus: 'not_reported',
    });
  });

  it('uses provider ticks as the authoritative PAYG-equivalent cost', () => {
    expect(buildGrokUsageSnapshot(response({
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheCreationTokens: 0 },
      metadata: { costUsdTicks: 1_250_000_000 },
    }), 'grok-4.5', { inputTokens: 1, outputTokens: 1 })).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.125,
      costStatus: 'known',
      tokenStatus: 'reported',
    });
  });

  it('nao usa ticks como custo conhecido quando tokens nao foram reportados', () => {
    expect(buildGrokUsageSnapshot(response({
      metadata: { costUsdTicks: 1_250_000_000 },
    }), 'grok-4.5', { inputTokens: 12, outputTokens: 3 })).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      estimated: true,
      costUsd: null,
      costStatus: 'unknown',
      tokenStatus: 'not_reported',
      costUnknownReason: 'no-usage-reported',
    });
  });

  it('keeps aggregate cost unknown without per-call breakdown', () => {
    expect(buildGrokUsageSnapshot(response({
      usage: { inputTokens: 300_000, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
      metadata: { modelCalls: 2 },
    }), 'grok-4.5', { inputTokens: 1, outputTokens: 1 })).toMatchObject({
      costUsd: null,
      costStatus: 'unknown',
      costUnknownReason: 'insufficient-per-call-pricing-breakdown',
    });
  });

  it('keeps cost unknown when modelUsage covers fewer calls than the aggregate', () => {
    expect(buildGrokUsageSnapshot(response({
      usage: { inputTokens: 200_000, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      metadata: {
        modelCalls: 3,
        modelUsage: {
          'grok-4.5': {
            inputTokens: 100_000,
            outputTokens: 10,
            cachedReadTokens: 0,
            reasoningTokens: 0,
            modelCalls: 1,
          },
          'grok-4.5-fast': {
            inputTokens: 100_000,
            outputTokens: 10,
            cachedReadTokens: 0,
            reasoningTokens: 0,
            modelCalls: 1,
          },
        },
      },
    }), 'grok-4.5', { inputTokens: 1, outputTokens: 1 })).toMatchObject({
      costUsd: null,
      costStatus: 'unknown',
    });
  });

  it('keeps cost unknown when a detailed model has no known pricing', () => {
    expect(buildGrokUsageSnapshot(response({
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      metadata: {
        modelCalls: 1,
        modelUsage: {
          'grok-internal-unknown': {
            inputTokens: 100,
            outputTokens: 20,
            cachedReadTokens: 0,
            reasoningTokens: 0,
            modelCalls: 1,
          },
        },
      },
    }), 'grok-4.5', { inputTokens: 1, outputTokens: 1 })).toMatchObject({
      costUsd: null,
      costStatus: 'unknown',
    });
  });
});
