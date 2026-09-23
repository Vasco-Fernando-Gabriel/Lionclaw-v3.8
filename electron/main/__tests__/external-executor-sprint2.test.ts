import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig, ExternalConfig } from '../../../src/types';

const mockOllamaResult = {
  content: 'ok',
  promptTokens: 100,
  tokensUsed: 50,
  cacheHitTokens: 0,
  reportedCostUsd: undefined as number | undefined,
  toolCalls: [] as Array<{ tool: string; input: unknown }>,
  apiRequests: 1,
  usageReported: true as boolean,
};

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../ollama-client', () => ({
  ollamaChatWithTools: vi.fn().mockImplementation(async () => ({ ...mockOllamaResult })),
}));

vi.mock('../vault-registry', () => ({
  getSecret: vi.fn().mockResolvedValue('test-api-key'),
}));

const mockAgent: AgentConfig = {
  id: 'test-agent',
  name: 'Test Agent',
  description: 'Test external agent',
  systemPrompt: 'You are a helpful assistant.',
  runtime: 'external' as const,
  model: 'deepseek-chat',
  effort: 'medium' as const,
  thinking: 'disabled',
  thinkingBudget: undefined,
  allowedTools: ['bash', 'read'],
  mcpServers: [],
  isActive: true,
  sortOrder: 0,
  skills: [],
  maxToolRounds: 50,
  externalConfig: {
    provider: 'deepseek',
    model: 'deepseek-chat',
    apiKeyRef: 'HARNESS_DEEPSEEK_KEY',
    baseUrl: 'https://api.deepseek.com/v1',
  },
};

vi.mock('../db', () => ({
  getAgent: vi.fn().mockImplementation(() => ({ ...mockAgent })),
  getDb: vi.fn(),
}));

vi.mock('../pricing', () => ({
  calculateCost: vi.fn().mockReturnValue(0.002),
}));

vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: vi.fn().mockResolvedValue({
    systemPrompt: 'You are a helpful assistant.',
    allowedTools: ['bash', 'read'],
    effort: 'medium',
    thinking: 'disabled',
    thinkingBudget: undefined,
    mcpServers: [],
  }),
}));

import { externalExecutor } from '../agent-runtime/external-executor';
import { __resetWarnedAgentsForTests } from '../agent-runtime/mcp-warning';
import { getAgent } from '../db';
import { ollamaChatWithTools } from '../ollama-client';
import { calculateCost } from '../pricing';
import type { AgentExecutionRequest } from '../agent-runtime/types';
import type { AgentQueryConfig } from '../agent-config-resolver';

function makeReq(overrides?: Partial<AgentExecutionRequest>): AgentExecutionRequest {
  return {
    agentId: 'test-agent',
    prompt: 'Do something',
    cwd: '/tmp/test',
    abortController: new AbortController(),
    permission: {
      mode: 'bypassPermissions',
      dangerouslySkipPermissions: true,
    },
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<AgentQueryConfig>): AgentQueryConfig {
  return {
    model: 'deepseek-chat',
    systemPrompt: 'You are a helpful assistant.',
    allowedTools: ['bash', 'read'],
    effort: 'medium',
    thinking: 'disabled',
    thinkingBudget: undefined,
    mcpServers: [],
    maxTurns: undefined,
    runtime: 'external',
    ...overrides,
  };
}

function setAgent(ext: ExternalConfig) {
  vi.mocked(getAgent).mockReturnValue({
    ...mockAgent,
    model: ext.model,
    externalConfig: ext,
  });
}

function setOllamaResult(overrides: Partial<typeof mockOllamaResult>) {
  vi.mocked(ollamaChatWithTools).mockResolvedValue({
    ...mockOllamaResult,
    ...overrides,
  } as Awaited<ReturnType<typeof ollamaChatWithTools>>);
}

beforeEach(() => {
  __resetWarnedAgentsForTests();
  vi.mocked(ollamaChatWithTools).mockReset();
  vi.mocked(ollamaChatWithTools).mockResolvedValue({
    ...mockOllamaResult,
  } as Awaited<ReturnType<typeof ollamaChatWithTools>>);
  vi.mocked(calculateCost).mockReset();
  vi.mocked(calculateCost).mockReturnValue(0.002);
  vi.mocked(getAgent).mockReturnValue({
    ...mockAgent,
    externalConfig: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKeyRef: 'HARNESS_DEEPSEEK_KEY',
      baseUrl: 'https://api.deepseek.com/v1',
    },
  });
});

describe('external-executor: protocol dispatch', () => {
  it('google-genai protocol: dispatches to google-genai-executor (Sprint 3 implemented)', async () => {
    setAgent({
      provider: 'gemini-agent-platform',
      model: 'gemini-2.5-pro-preview-05-06',
      apiKeyRef: '', // Empty ref -> throws before any SDK call
      baseUrl: '',
      protocol: 'google-genai',
    });

    const err: unknown = await externalExecutor.run(makeReq(), makeConfig()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof Error)) throw new Error('Expected external executor error');
    expect(err.message).not.toMatch(/google-genai protocol nao implementado/i);
    expect(err.message).toMatch(/sem apiKeyRef configurado/i);
  });

  it('missing protocol defaults to openai-compatible and proceeds normally', async () => {
    setAgent({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKeyRef: 'HARNESS_DEEPSEEK_KEY',
      baseUrl: 'https://api.deepseek.com/v1',
    });

    setOllamaResult({ usageReported: true });

    const result = await externalExecutor.run(makeReq(), makeConfig());
    expect(result.output).toBe('ok');
  });
});

describe('external-executor: baseUrl guard', () => {
  it('throws when baseUrl is missing (undefined)', async () => {
    setAgent({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKeyRef: 'HARNESS_DEEPSEEK_KEY',
      baseUrl: undefined as unknown as string,
    });

    await expect(externalExecutor.run(makeReq(), makeConfig())).rejects.toThrow(/sem baseUrl/);
  });

  it('throws when baseUrl is empty string', async () => {
    setAgent({
      provider: 'kimi',
      model: 'kimi-k2-turbo-preview',
      apiKeyRef: 'HARNESS_KIMI_KEY',
      baseUrl: '',
    });

    await expect(externalExecutor.run(makeReq(), makeConfig())).rejects.toThrow(/sem baseUrl/);
  });

  it('throws when baseUrl is whitespace-only', async () => {
    setAgent({
      provider: 'qwen',
      model: 'qwen3-max',
      apiKeyRef: 'HARNESS_QWEN_KEY',
      baseUrl: '   ',
    });

    await expect(externalExecutor.run(makeReq(), makeConfig())).rejects.toThrow(/sem baseUrl/);
  });
});

describe('external-executor: pricing combo A (no usage reported)', () => {
  it('kimi + no usage -> tokenStatus=not_reported, costStatus=unknown, reason=no-usage-reported', async () => {
    setAgent({
      provider: 'kimi',
      model: 'kimi-k2-turbo-preview',
      apiKeyRef: 'HARNESS_KIMI_KEY',
      baseUrl: 'https://api.moonshot.ai/v1',
    });
    setOllamaResult({ usageReported: false });

    const result = await externalExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.tokenStatus).toBe('not_reported');
    expect(result.metrics.costStatus).toBe('unknown');
    expect(result.metrics.costUnknownReason).toBe('no-usage-reported');
    expect(result.metrics.costUsd).toBe(0);
  });

  it('deepseek + no usage -> combo A', async () => {
    setAgent({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      apiKeyRef: 'HARNESS_DEEPSEEK_KEY',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    setOllamaResult({ usageReported: false });

    const result = await externalExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.tokenStatus).toBe('not_reported');
    expect(result.metrics.costStatus).toBe('unknown');
    expect(result.metrics.costUnknownReason).toBe('no-usage-reported');
    expect(result.metrics.costUsd).toBe(0);
  });

  it('minimax-payg + no usage -> combo A', async () => {
    setAgent({
      provider: 'minimax-payg',
      model: 'MiniMax-M2.7',
      apiKeyRef: 'HARNESS_MINIMAX_PAYG_KEY',
      baseUrl: 'https://api.minimax.io/v1',
    });
    setOllamaResult({ usageReported: false });

    const result = await externalExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.tokenStatus).toBe('not_reported');
    expect(result.metrics.costStatus).toBe('unknown');
    expect(result.metrics.costUnknownReason).toBe('no-usage-reported');
  });
});

describe('external-executor: pricing combo B (usage reported, pricing unknown)', () => {
  it('kimi + usage reported + pricingKey=null -> tokenStatus=reported, costStatus=unknown, reason=unknown-pricing', async () => {
    setAgent({
      provider: 'kimi',
      model: 'kimi-k2-turbo-preview',
      apiKeyRef: 'HARNESS_KIMI_KEY',
      baseUrl: 'https://api.moonshot.ai/v1',
    });
    setOllamaResult({ usageReported: true });

    const result = await externalExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.tokenStatus).toBe('reported');
    expect(result.metrics.costStatus).toBe('unknown');
    expect(result.metrics.costUnknownReason).toBe('unknown-pricing');
    expect(result.metrics.costUsd).toBe(0);
  });

  it('minimax-payg + MiniMax-Text-01 + usage reported -> combo B (pricingKey=null)', async () => {
    setAgent({
      provider: 'minimax-payg',
      model: 'MiniMax-Text-01',
      apiKeyRef: 'HARNESS_MINIMAX_PAYG_KEY',
      baseUrl: 'https://api.minimax.io/v1',
    });
    setOllamaResult({ usageReported: true });

    const result = await externalExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.tokenStatus).toBe('reported');
    expect(result.metrics.costStatus).toBe('unknown');
    expect(result.metrics.costUnknownReason).toBe('unknown-pricing');
    expect(result.metrics.costUsd).toBe(0);
  });

  it('qwen + qwen3-coder + usage reported -> combo B (pricingKey=null)', async () => {
    setAgent({
      provider: 'qwen',
      model: 'qwen3-coder',
      apiKeyRef: 'HARNESS_QWEN_KEY',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    });
    setOllamaResult({ usageReported: true });

    const result = await externalExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.tokenStatus).toBe('reported');
    expect(result.metrics.costStatus).toBe('unknown');
    expect(result.metrics.costUnknownReason).toBe('unknown-pricing');
  });
});

describe('external-executor: pricing combo C (usage reported, pricing known)', () => {
  it('deepseek + deepseek-chat + usage reported -> tokenStatus=reported, costStatus=known, costUsd via calculateCost', async () => {
    setAgent({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKeyRef: 'HARNESS_DEEPSEEK_KEY',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    setOllamaResult({ usageReported: true, reportedCostUsd: undefined });
    vi.mocked(calculateCost).mockReturnValue(0.005);

    const result = await externalExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.tokenStatus).toBe('reported');
    expect(result.metrics.costStatus).toBe('known');
    expect(result.metrics.costUnknownReason).toBeUndefined();
    expect(result.metrics.costUsd).toBe(0.005);
  });

  it('deepseek + deepseek-chat + reportedCostUsd present -> uses reportedCostUsd', async () => {
    setAgent({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKeyRef: 'HARNESS_DEEPSEEK_KEY',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    setOllamaResult({ usageReported: true, reportedCostUsd: 0.0123 });

    const result = await externalExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.costStatus).toBe('known');
    expect(result.metrics.costUsd).toBe(0.0123);
    expect(vi.mocked(calculateCost)).not.toHaveBeenCalled();
  });

  it('minimax-payg + MiniMax-M2.7 + usage reported -> combo C (pricingKey known)', async () => {
    setAgent({
      provider: 'minimax-payg',
      model: 'MiniMax-M2.7',
      apiKeyRef: 'HARNESS_MINIMAX_PAYG_KEY',
      baseUrl: 'https://api.minimax.io/v1',
    });
    setOllamaResult({ usageReported: true, reportedCostUsd: undefined });
    vi.mocked(calculateCost).mockReturnValue(0.003);

    const result = await externalExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.tokenStatus).toBe('reported');
    expect(result.metrics.costStatus).toBe('known');
    expect(result.metrics.costUsd).toBe(0.003);
  });

  it('qwen + qwen3-max + usage reported -> combo C (pricingKey known)', async () => {
    setAgent({
      provider: 'qwen',
      model: 'qwen3-max',
      apiKeyRef: 'HARNESS_QWEN_KEY',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    });
    setOllamaResult({ usageReported: true, reportedCostUsd: undefined });
    vi.mocked(calculateCost).mockReturnValue(0.004);

    const result = await externalExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.costStatus).toBe('known');
    expect(result.metrics.costUsd).toBe(0.004);
  });
});

describe('external-executor: legacy providers (openrouter/openai/openai-compatible) byte-identical', () => {
  it('openrouter: costStatus=known regardless of usageReported (pricing always known)', async () => {
    setAgent({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-pro',
      apiKeyRef: 'HARNESS_OPENROUTER_KEY',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    setOllamaResult({ usageReported: true });
    vi.mocked(calculateCost).mockReturnValue(0.001);

    const result = await externalExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.costStatus).toBe('known');
    expect(result.metrics.tokenStatus).toBe('reported');
    expect(result.metrics.costUnknownReason).toBeUndefined();
  });

  it('openai direct: costStatus=known', async () => {
    setAgent({
      provider: 'openai',
      model: 'gpt-5.5-turbo',
      apiKeyRef: 'HARNESS_OPENAI_KEY',
      baseUrl: 'https://api.openai.com/v1',
    });
    setOllamaResult({ usageReported: true });

    const result = await externalExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.costStatus).toBe('known');
    expect(result.metrics.tokenStatus).toBe('reported');
  });

  it('openai-compatible (Custom): costStatus=known', async () => {
    setAgent({
      provider: 'openai-compatible',
      model: 'my-custom-model',
      apiKeyRef: 'MY_CUSTOM_KEY',
      baseUrl: 'https://my-endpoint.example.com/v1',
    });
    setOllamaResult({ usageReported: true });

    const result = await externalExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.costStatus).toBe('known');
    expect(result.metrics.tokenStatus).toBe('reported');
  });

  it('openrouter: provider field is passed through in result', async () => {
    setAgent({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2.6',
      apiKeyRef: 'HARNESS_OPENROUTER_KEY',
      baseUrl: 'https://openrouter.ai/api/v1',
    });

    const result = await externalExecutor.run(makeReq(), makeConfig());
    expect(result.provider).toBe('openrouter');
    expect(result.runtime).toBe('external');
  });
});
