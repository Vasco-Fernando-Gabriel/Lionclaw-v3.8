import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStreamResult = {
  output: 'Hello from MiniMax',
  accumulatedText: 'Hello from MiniMax',
  textBlocks: ['Hello from MiniMax'],
  metrics: {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolUses: 0,
    apiRequests: 1,
  },
};

const capturedQueryOptions: Array<Record<string, unknown>> = [];

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: Record<string, unknown>) => {
    capturedQueryOptions.push(opts);
    return (async function* () {})();
  },
}));

vi.mock('../stream-processor', () => ({
  processAgentStream: vi.fn().mockImplementation(async () => ({ ...mockStreamResult })),
}));

let mockGetSettingValue: string | undefined = 'minimax-key-ref';
vi.mock('../db', () => ({
  getSetting: vi.fn().mockImplementation((key: string) => {
    if (key === 'orchestrator_minimax_api_key_ref') return mockGetSettingValue;
    return undefined;
  }),
}));

let mockGetSecretValue: string | null = 'sk-minimax-test';
vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn().mockImplementation(async () => mockGetSecretValue),
}));

vi.mock('../pricing', () => ({
  calculateCost: vi.fn().mockReturnValue(0.005),
  getPricingSnapshot: vi.fn().mockReturnValue({
    pricingVersion: 'test',
    model: 'MiniMax-M2.7',
    entry: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheCreation: 0.375 },
  }),
}));

vi.mock('../pipeline-shared/sdk-bootstrap', () => ({
  ensureNodeInPath: vi.fn(),
  getClaudeCodeExecutablePath: () => '/tmp/claude-cli.js',
  getClaudeSdkProcessOptions: vi.fn(() => ({
    pathToClaudeCodeExecutable: '/tmp/claude-cli.js',
    executable: 'node',
  })),
}));

vi.mock('../claude-compat-sdk/provider-presets', () => ({
  getClaudeCompatPreset: vi.fn().mockReturnValue({
    id: 'minimax',
    displayName: 'Minimax TokenPlan',
    baseUrl: 'https://api.minimax.io/anthropic',
    apiKeyVaultRef: 'orchestratorMinimaxApiKeyRef',
    models: [{ id: 'MiniMax-M2.7', displayName: 'MiniMax M2.7', supportTier: 'official' }],
  }),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
  },
  existsSync: vi.fn().mockReturnValue(true),
}));

import {
  buildMinimaxTpEnv,
  buildMinimaxTpQueryOptions,
  minimaxTokenplanExecutor,
} from '../agent-runtime/minimax-tokenplan-executor';
import { PERM_BYPASS_NO_GUARD } from '../agent-runtime/permission-profiles';
import type { AgentExecutionRequest } from '../agent-runtime/types';
import type { AgentQueryConfig } from '../agent-config-resolver';
import { processAgentStream } from '../stream-processor';

function makeReq(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    agentId: 'minimax-tp-agent',
    prompt: 'Do the thing',
    cwd: '/tmp/project',
    abortController: new AbortController(),
    permission: PERM_BYPASS_NO_GUARD,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
  return {
    model: 'MiniMax-M2.7',
    systemPrompt: 'You are a MiniMax harness agent.',
    allowedTools: ['Read', 'Edit'],
    mcpServers: [],
    maxTurns: undefined,
    effort: 'medium',
    thinking: 'adaptive',
    thinkingBudget: undefined,
    runtime: 'minimax-tp',
    ...overrides,
  };
}

beforeEach(() => {
  capturedQueryOptions.length = 0;
  vi.clearAllMocks();
  mockGetSettingValue = 'minimax-key-ref';
  mockGetSecretValue = 'sk-minimax-test';

  vi.mocked(processAgentStream).mockImplementation(async () => ({ ...mockStreamResult }));
});

describe('buildMinimaxTpEnv', () => {
  it('strips ANTHROPIC_* env vars and replaces them with MiniMax values', () => {
    const env = buildMinimaxTpEnv('sk-minimax', 'MiniMax-M2.7', 'https://api.minimax.io/anthropic', {
      PATH: '/bin:/usr/bin',
      HOME: '/home/me',
      ANTHROPIC_API_KEY: 'sk-anthropic-old',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_AUTH_TOKEN: 'old-token',
      ANTHROPIC_MODEL: 'claude-old',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0',
      API_TIMEOUT_MS: '1000',
    });

    expect(env.PATH).toBe('/bin:/usr/bin');
    expect(env.HOME).toBe('/home/me');

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();

    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-minimax');
    expect(env.ANTHROPIC_MODEL).toBe('MiniMax-M2.7');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.API_TIMEOUT_MS).toBe('3000000');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('MiniMax-M2.7');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('MiniMax-M2.7');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M2.7');
  });

  it('uses process.env as default base when no baseEnv provided', () => {
    const saved = process.env.PATH;
    process.env.PATH = '/test-path';
    const env = buildMinimaxTpEnv('sk-test', 'MiniMax-M2.7', 'https://api.minimax.io/anthropic');
    expect(env.PATH).toBe('/test-path');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic');
    process.env.PATH = saved;
  });
});

describe('buildMinimaxTpEnv: CLAUDE_CODE_MAX_CONTEXT_TOKENS (D9)', () => {
  const MINIMAX_URL = 'https://api.minimax.io/anthropic';

  it('injeta 1000000 para modelo de janela 1M conhecida (MiniMax-M3)', () => {
    const env = buildMinimaxTpEnv('sk-minimax', 'MiniMax-M3', MINIMAX_URL, { PATH: '/bin' });
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
  });

  it('injeta a janela real para modelo conhecido < 1M (MiniMax-M2.7 -> 204800)', () => {
    const env = buildMinimaxTpEnv('sk-minimax', 'MiniMax-M2.7', MINIMAX_URL, { PATH: '/bin' });
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('204800');
  });

  it('modelo desconhecido: chave AUSENTE mesmo com override no baseEnv (saneamento)', () => {
    const env = buildMinimaxTpEnv('sk-minimax', 'totally-unknown-model-x', MINIMAX_URL, {
      PATH: '/bin',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '999999',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50',
      DISABLE_AUTO_COMPACT: '1',
      DISABLE_COMPACT: '1',
    });
    expect(env.PATH).toBe('/bin');
    expect(env).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
    expect(env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    expect(env).not.toHaveProperty('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE');
    expect(env).not.toHaveProperty('DISABLE_AUTO_COMPACT');
    expect(env).not.toHaveProperty('DISABLE_COMPACT');
  });

  it('modelo conhecido: o valor do LionClaw vence o override herdado', () => {
    const env = buildMinimaxTpEnv('sk-minimax', 'MiniMax-M3', MINIMAX_URL, {
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '123',
    });
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
  });

  it('buildMinimaxTpQueryOptions passa options.model IGUAL ao slug (sem sufixo [1m]) e a env da janela', () => {
    const opts = buildMinimaxTpQueryOptions(
      makeReq(),
      makeConfig({ model: 'MiniMax-M3' }),
      '/tmp/claude-cli.js',
      new AbortController(),
      'sk-minimax',
    );
    expect(opts.model).toBe('MiniMax-M3');
    expect((opts.env as Record<string, string>).CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
  });
});

describe('buildMinimaxTpQueryOptions', () => {
  it('wires SDK options correctly without touching cloud-executor', () => {
    const childAbort = new AbortController();
    const opts = buildMinimaxTpQueryOptions(
      makeReq(),
      makeConfig({
        mcpServers: [
          {
            'knowledge-base': {
              command: 'node',
              args: ['/tmp/kb.js'],
              env: { KB_AGENT_ID: 'minimax-agent' },
            },
          },
        ],
      }),
      '/tmp/claude-cli.js',
      childAbort,
      'sk-minimax',
    );

    expect(opts.pathToClaudeCodeExecutable).toBe('/tmp/claude-cli.js');
    expect(opts.cwd).toBe('/tmp/project');
    expect(opts.model).toBe('MiniMax-M2.7');
    expect(opts.allowedTools).toEqual(['Read', 'Edit']);
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
    expect(opts.abortController).toBe(childAbort);
    expect(opts.mcpServers).toEqual({
      'knowledge-base': {
        command: 'node',
        args: ['/tmp/kb.js'],
        env: { KB_AGENT_ID: 'minimax-agent' },
      },
    });
    expect(String(opts.systemPrompt)).toContain('Runtime: minimax-tp');
    expect(String(opts.systemPrompt)).toContain('MiniMax TokenPlan');
    expect(String(opts.systemPrompt)).toContain('Modelo selecionado: MiniMax-M2.7');
    expect((opts.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toBe('sk-minimax');
    expect((opts.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic');
    expect((opts.env as Record<string, string>).ANTHROPIC_MODEL).toBe('MiniMax-M2.7');
    expect((opts.env as Record<string, string>).CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });
});

describe('minimaxTokenplanExecutor.run — error paths', () => {
  it('throws "MiniMax TokenPlan nao esta conectado" when setting is absent', async () => {
    mockGetSettingValue = undefined;

    await expect(minimaxTokenplanExecutor.run(makeReq(), makeConfig())).rejects.toThrow(
      'MiniMax TokenPlan nao esta conectado',
    );
  });

  it('throws "MiniMax TokenPlan nao esta conectado" when setting is empty string', async () => {
    mockGetSettingValue = '';

    await expect(minimaxTokenplanExecutor.run(makeReq(), makeConfig())).rejects.toThrow(
      'MiniMax TokenPlan nao esta conectado',
    );
  });

  it('throws "Chave MiniMax foi removida do Vault" when secret is null', async () => {
    mockGetSettingValue = 'minimax-key-ref';
    mockGetSecretValue = null;

    await expect(minimaxTokenplanExecutor.run(makeReq(), makeConfig())).rejects.toThrow(
      'Chave MiniMax foi removida do Vault',
    );
  });

  it('error message for missing secret includes the vault ref', async () => {
    mockGetSettingValue = 'my-vault-ref-123';
    mockGetSecretValue = null;

    await expect(minimaxTokenplanExecutor.run(makeReq(), makeConfig())).rejects.toThrow('ref=my-vault-ref-123');
  });
});

describe('minimaxTokenplanExecutor.run — normal case', () => {
  it('returns runtime:minimax-tp, provider:minimax, costUsd numeric', async () => {
    const result = await minimaxTokenplanExecutor.run(makeReq(), makeConfig());

    expect(result.runtime).toBe('minimax-tp');
    expect(result.provider).toBe('minimax');
    expect(result.model).toBe('MiniMax-M2.7');
    expect(typeof result.metrics.costUsd).toBe('number');
    expect(result.metrics.costUsd).toBeGreaterThan(0);
  });

  it('returns metadata.costEstimationKind = subscription-equivalent-payg', async () => {
    const result = await minimaxTokenplanExecutor.run(makeReq(), makeConfig());

    expect(result.metadata).toBeDefined();
    expect(result.metadata?.costEstimationKind).toBe('subscription-equivalent-payg');
  });

  it('returns tokens from processAgentStream', async () => {
    const result = await minimaxTokenplanExecutor.run(makeReq(), makeConfig());

    expect(result.metrics.inputTokens).toBe(100);
    expect(result.metrics.outputTokens).toBe(50);
  });

  it('calls query with ANTHROPIC_BASE_URL pointing to MiniMax', async () => {
    await minimaxTokenplanExecutor.run(makeReq(), makeConfig());

    expect(capturedQueryOptions).toHaveLength(1);
    const opts = capturedQueryOptions[0].options as Record<string, unknown>;
    const env = opts.env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-minimax-test');
  });
});

describe('minimaxTokenplanExecutor.run — defensive usage zero (SPEC-006 §11.4)', () => {
  it('marks not_reported when output present but tokens are zero', async () => {
    vi.mocked(processAgentStream).mockResolvedValueOnce({
      output: 'Some text output',
      accumulatedText: 'Some text output',
      textBlocks: ['Some text output'],
      metrics: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        toolUses: 0,
        apiRequests: 1,
      },
    });

    const result = await minimaxTokenplanExecutor.run(makeReq(), makeConfig());

    expect(result.metrics.costStatus).toBe('unknown');
    expect(result.metrics.tokenStatus).toBe('not_reported');
    expect(result.metrics.costUnknownReason).toBe('no-usage-reported');
    expect(result.metrics.costUsd).toBe(0);
    expect(result.metadata?.costEstimationKind).toBe('subscription-equivalent-payg');
  });

  it('does NOT mark not_reported when output is empty AND tokens are zero (noop/empty response)', async () => {
    vi.mocked(processAgentStream).mockResolvedValueOnce({
      output: '',
      accumulatedText: '',
      textBlocks: [],
      metrics: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        toolUses: 0,
        apiRequests: 1,
      },
    });

    const result = await minimaxTokenplanExecutor.run(makeReq(), makeConfig());

    expect(result.metrics.tokenStatus).toBeUndefined();
    expect(result.metrics.costStatus).toBeUndefined();
    expect(result.metrics.costUnknownReason).toBeUndefined();
  });

  it('marks not_reported when accumulatedText is present but tokens are zero', async () => {
    vi.mocked(processAgentStream).mockResolvedValueOnce({
      output: '',
      accumulatedText: 'Some accumulated text',
      textBlocks: ['Some accumulated text'],
      metrics: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        toolUses: 0,
        apiRequests: 1,
      },
    });

    const result = await minimaxTokenplanExecutor.run(makeReq(), makeConfig());

    expect(result.metrics.tokenStatus).toBe('not_reported');
    expect(result.metrics.costStatus).toBe('unknown');
  });
});
