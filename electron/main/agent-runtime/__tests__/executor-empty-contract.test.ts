import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const getAgentMock = vi.fn();
vi.mock('../../db', () => ({ getAgent: (...a: unknown[]) => getAgentMock(...a) }));
vi.mock('../../pricing', () => ({ calculateCost: () => 0 }));

const ollamaChatWithToolsMock = vi.fn();
vi.mock('../../ollama-client', () => ({
  ollamaChatWithTools: (...a: unknown[]) => ollamaChatWithToolsMock(...a),
}));

const ollamaChatWithRetryMock = vi.fn();
vi.mock('../external-http', () => ({
  resolveExternalAuth: vi.fn(async () => ({})),
  ollamaChatWithRetry: (...a: unknown[]) => ollamaChatWithRetryMock(...a),
  computePricingKey: vi.fn(() => 'k'),
  mapReasoningParams: vi.fn(() => ({})),
  isContextLengthError: vi.fn(() => false),
  resolveExternalPricing: vi.fn(() => ({ status: 'known', pricingKey: 'k' })),
}));
vi.mock('../mcp-warning', () => ({
  warnMcpToolsDroppedOnce: vi.fn(),
  warnOncePerAgent: vi.fn(),
}));
vi.mock('../google-genai-executor', () => ({ googleGenAiExecutor: { run: vi.fn() } }));

import { processAgentStream } from '../../stream-processor';
import { localExecutor } from '../local-executor';
import { externalExecutor } from '../external-executor';
import type { AgentExecutionRequest } from '../types';
import type { AgentQueryConfig } from '../../agent-config-resolver';

function makeReq(): AgentExecutionRequest {
  return {
    agentId: 'agent-x',
    prompt: 'oi',
    cwd: '/tmp',
    abortController: new AbortController(),
    permission: { mode: 'default', dangerouslySkipPermissions: false },
  };
}

const baseConfig = {
  runtime: 'local',
  model: 'm',
  systemPrompt: '',
  allowedTools: [],
  mcpServers: [],
} as unknown as AgentQueryConfig;

async function* streamOf(msgs: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  for (const m of msgs) yield m;
}

describe('AC-B6b — processAgentStream (ponto comum de cloud/zai/minimax-tp)', () => {
  it('AC-B6b: stream que termina sem texto e sem tool-use preenche resultError LLM-EMPTY', async () => {
    const r = await processAgentStream(streamOf([{ type: 'result', result: '' }]), {});
    expect(r.output).toBe('');
    expect(r.resultError?.code).toBe('LLM-EMPTY');
  });

  it('AC-B6b: stream com texto NAO preenche resultError', async () => {
    const r = await processAgentStream(streamOf([{ type: 'result', result: 'resposta' }]), {});
    expect(r.output).toBe('resposta');
    expect(r.resultError).toBeUndefined();
  });

  it('AC-B6b: turno so-tool (empty-ok) NAO preenche resultError', async () => {
    const r = await processAgentStream(
      streamOf([
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } },
          },
        },
        { type: 'stream_event', event: { type: 'content_block_stop' } },
        { type: 'result', result: '' },
      ]),
      {},
    );
    expect(r.output).toBe('');
    expect(r.metrics.toolUses).toBe(1);
    expect(r.resultError).toBeUndefined();
  });

  it('AC-B6b: abort do caller (empty-ok) NAO preenche resultError', async () => {
    const r = await processAgentStream(streamOf([{ type: 'result', result: '' }]), {
      shouldAbort: () => true,
    });
    expect(r.resultError).toBeUndefined();
  });
});

describe('AC-B6b — local-executor', () => {
  it('AC-B6b: resposta vazia do ollama preenche error LLM-EMPTY', async () => {
    getAgentMock.mockReturnValue({
      localConfig: { provider: 'ollama', model: 'llama3', baseUrl: 'http://localhost:11434' },
    });
    ollamaChatWithToolsMock.mockResolvedValue({
      content: '',
      toolCalls: [],
      promptTokens: 10,
      tokensUsed: 0,
      model: 'llama3',
    });
    const r = await localExecutor.run(makeReq(), baseConfig);
    expect(r.error?.code).toBe('LLM-EMPTY');
    expect(r.error?.raw).toContain('provider=ollama');
  });

  it('AC-B6b: resposta com texto NAO preenche error', async () => {
    getAgentMock.mockReturnValue({
      localConfig: { provider: 'ollama', model: 'llama3', baseUrl: 'http://localhost:11434' },
    });
    ollamaChatWithToolsMock.mockResolvedValue({
      content: 'oi',
      toolCalls: [],
      promptTokens: 10,
      tokensUsed: 5,
      model: 'llama3',
    });
    const r = await localExecutor.run(makeReq(), baseConfig);
    expect(r.error).toBeUndefined();
  });

  it('AC-B6b: turno so-tool (empty-ok) NAO preenche error', async () => {
    getAgentMock.mockReturnValue({
      localConfig: { provider: 'ollama', model: 'llama3', baseUrl: 'http://localhost:11434' },
    });
    ollamaChatWithToolsMock.mockResolvedValue({
      content: '',
      toolCalls: [{ tool: 'Bash', input: '{}' }],
      promptTokens: 10,
      tokensUsed: 5,
      model: 'llama3',
    });
    const r = await localExecutor.run(makeReq(), baseConfig);
    expect(r.error).toBeUndefined();
  });
});

describe('AC-B6b — external-executor', () => {
  it('AC-B6b: resposta vazia do endpoint externo preenche error LLM-EMPTY', async () => {
    getAgentMock.mockReturnValue({
      externalConfig: { provider: 'openrouter', model: 'x/y', baseUrl: 'https://openrouter.ai/api/v1' },
      maxToolRounds: 5,
    });
    ollamaChatWithRetryMock.mockResolvedValue({
      content: '',
      toolCalls: [],
      promptTokens: 10,
      tokensUsed: 0,
      cacheHitTokens: 0,
      reportedCostUsd: undefined,
      apiRequests: 1,
      usageReported: true,
    });
    const r = await externalExecutor.run(makeReq(), baseConfig);
    expect(r.error?.code).toBe('LLM-EMPTY');
    expect(r.error?.raw).toContain('provider=openrouter');
  });

  it('AC-B6b: resposta com texto NAO preenche error', async () => {
    getAgentMock.mockReturnValue({
      externalConfig: { provider: 'openrouter', model: 'x/y', baseUrl: 'https://openrouter.ai/api/v1' },
      maxToolRounds: 5,
    });
    ollamaChatWithRetryMock.mockResolvedValue({
      content: 'resposta',
      toolCalls: [],
      promptTokens: 10,
      tokensUsed: 5,
      cacheHitTokens: 0,
      reportedCostUsd: undefined,
      apiRequests: 1,
      usageReported: true,
    });
    const r = await externalExecutor.run(makeReq(), baseConfig);
    expect(r.error).toBeUndefined();
  });
});

describe('AC-B6b — caracterizacao: cada runtime propaga o vazio-falho', () => {
  const read = (f: string): string => fs.readFileSync(path.join(__dirname, '..', f), 'utf-8');

  it.each(['cloud-executor.ts', 'zai-executor.ts', 'minimax-tokenplan-executor.ts'])(
    'AC-B6b: %s propaga resultError do processAgentStream para o contrato error?',
    (file) => {
      const src = read(file);
      expect(src).toContain('resultError = result.resultError;');
      expect(src).toContain('...(resultError !== undefined ? { error: resultError } : {})');
    },
  );

  it.each(['kimi-executor.ts', 'local-executor.ts', 'external-executor.ts', 'google-genai-executor.ts'])(
    'AC-B6b: %s tem ramo proprio de vazio via emptyResponseExecutionError',
    (file) => {
      const src = read(file);
      expect(src).toContain('emptyResponseExecutionError({');
      expect(src).toContain('...(resultError !== undefined ? { error: resultError } : {})');
    },
  );
});
