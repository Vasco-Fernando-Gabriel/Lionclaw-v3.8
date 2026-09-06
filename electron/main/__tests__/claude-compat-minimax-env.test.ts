
import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedQueryArgs: Array<{
  prompt: string;
  options: Record<string, unknown>;
}> = [];
const queuedSdkMessages: Array<Record<string, unknown>> = [];
const ledgerMocks = vi.hoisted(() => ({
  insertLegacy: vi.fn(),
  start: vi.fn(),
  finalize: vi.fn(),
  finalizeTree: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    capturedQueryArgs.push({ prompt: args.prompt, options: args.options });
    const iter = (async function* () {
      for (const message of queuedSdkMessages) yield message;
    })();
    return Object.assign(iter, {
      toggleMcpServer: vi.fn(async () => undefined),
    });
  },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => [] as unknown[]),
  getAgent: vi.fn(() => undefined),
  insertMessage: vi.fn(),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(),
  getSetting: vi.fn((key: string) => {
    if (key === 'onboarding_completed') return 'true';
    return undefined;
  }),
  updateSessionTokens: ledgerMocks.updateSession,
  setSessionActiveContextTokens: vi.fn(),
  setSessionAgenticContextTokens: vi.fn(),
  resetSessionAgenticContext: vi.fn(),
  getSessionMessagesAfterFence: vi.fn(() => []),
  getActiveChatSession: vi.fn(() => null),
  getSession: vi.fn(() => null),
  getEnabledTools: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  insertTaskExecution: ledgerMocks.insertLegacy,
  startTaskExecution: ledgerMocks.start,
  finalizeTaskExecutionOnce: ledgerMocks.finalize,
  finalizeRunningTaskExecutionTree: ledgerMocks.finalizeTree,
  getTurnIndexForUserMessage: vi.fn(() => 0),
  getLatestUserTurnIndex: vi.fn(() => 0),
}));

vi.mock('../knowledge-state', () => ({
  setActiveAgentId: vi.fn(),
}));

vi.mock('../onboarding', () => ({
  extractAndProcessOnboardingData: vi.fn(),
}));

vi.mock('../pricing', () => ({
  calculateCost: () => 0,
  hasKnownPricing: () => true,
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async () => 'fake-api-key'),
  getApiKey: vi.fn(async () => null),
}));

vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => vi.fn(),
}));

vi.mock('../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async () => ({})),
  getMcpToolRegistryEntries: vi.fn(() => []),
}));

vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: vi.fn(async () => ({
    allowedTools: [],
    systemPrompt: '',
    mcpServers: [],
    maxTurns: 0,
  })),
}));

vi.mock('../mcp-discovery', () => ({
  getDisabledSDKMcps: () => [],
  getCachedSDKMcpServers: () => [],
}));

vi.mock('../artifact-detector', () => ({
  captureToolUse: vi.fn(),
  captureToolResult: vi.fn(),
  resetArtifactDetector: vi.fn(),
}));

vi.mock('../prompt-builder', () => ({
  buildSystemPrompt: () => '',
}));

vi.mock('../paths', () => ({
  getAgentCwd: () => '/tmp',
  getBackgroundCwd: () => '/tmp',
  getLionClawHome: () => '/tmp',
}));

vi.mock('../codex-agents-mcp', () => ({
  getCodexAgentsServer: () => undefined,
}));

vi.mock('../dreaming-turn-engine', () => ({
  recordCompletedMainChatTurn: vi.fn(),
}));

vi.mock('../pipeline-shared/sdk-bootstrap', () => ({
  ensureNodeInPath: vi.fn(),
  getClaudeCodeExecutablePath: () => '/tmp/claude-cli.js',
  getClaudeSdkProcessOptions: vi.fn(() => ({
    pathToClaudeCodeExecutable: '/tmp/claude-cli.js',
    executable: 'node',
  })),
}));

vi.mock('../title-generator', () => ({
  ensureInitialSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(),
}));

vi.mock('../sdk-session-id', () => ({
  makeScopedSdkSessionId: (scope: string, sessionId: string) =>
    `${scope}:${sessionId}`,
}));

import {
  buildAgentDefinitions,
  buildCompatEnv,
  executeClaudeCompatSdkQuery,
} from '../claude-compat-sdk';
import { getAllAgents } from '../db';
import type { OrchestratorSelection } from '../orchestrator-selection';
import type { QueryOptions } from '../orchestrator';
import type { AgentConfig } from '../../../src/types';

const noopGetWindow = () => null;

function makeSelection(
  overrides: Partial<OrchestratorSelection> = {},
): OrchestratorSelection {
  return {
    runtime: 'claude-compat-sdk',
    provider: 'zai',
    model: 'glm-4.7',
    source: 'settings',
    apiKey: 'fake-api-key',
    ...overrides,
  };
}

function makeQueryOptions(
  overrides: Partial<QueryOptions> = {},
): QueryOptions {
  return {
    sessionId: 'test-session-1',
    silent: true,
    _forceNewSession: false,
    ...overrides,
  };
}

beforeEach(() => {
  capturedQueryArgs.length = 0;
  queuedSdkMessages.length = 0;
  vi.clearAllMocks();
});

describe('ledger V138 para Task nativa compat', () => {
  it('faz start/finalize provider-aware e mantem o insert legado', async () => {
    queuedSdkMessages.push(
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-compat-1',
        tool_use_id: 'tool-compat-1',
        description: 'delegar compat',
        task_type: 'researcher',
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-compat-1',
        tool_use_id: 'tool-compat-1',
        status: 'completed',
        summary: 'feito',
      },
    );

    await executeClaudeCompatSdkQuery(
      'hello',
      makeQueryOptions({ sessionId: 'compat-native-1' }),
      noopGetWindow,
      undefined,
      makeSelection({ provider: 'zai', model: 'glm-4.7' }),
    );

    expect(ledgerMocks.start).toHaveBeenCalledTimes(2);
    const child = ledgerMocks.start.mock.calls[1][0] as Record<string, unknown>;
    expect(child).toEqual(expect.objectContaining({
      executionKind: 'native-task',
      ownerKind: 'chat',
      ownerId: 'compat-native-1',
      sessionId: 'compat-native-1',
      toolUseId: 'tool-compat-1',
      taskId: 'task-compat-1',
      runtime: 'zai',
      provider: 'zai',
    }));
    expect(ledgerMocks.finalize).toHaveBeenCalledWith(
      child.executionId,
      expect.objectContaining({
        status: 'completed',
        runtime: 'zai',
        provider: 'zai',
        tokenStatus: 'not_reported',
        costStatus: 'unknown',
      }),
    );
    expect(ledgerMocks.insertLegacy).not.toHaveBeenCalled();
  });

  it('nao atribui usage de sidechain nem result agregado ao pai', async () => {
    queuedSdkMessages.push(
      {
        type: 'stream_event',
        event: { type: 'message_start', message: { model: 'glm-4.7', usage: { input_tokens: 10 } } },
      },
      { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 5 } } },
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-compat-usage',
        tool_use_id: 'tool-compat-usage',
        description: 'delegar compat',
        task_type: 'researcher',
      },
      {
        type: 'stream_event',
        parent_tool_use_id: 'tool-compat-usage',
        event: { type: 'message_start', message: { model: 'glm-4.7', usage: { input_tokens: 100 } } },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: 'tool-compat-usage',
        event: { type: 'message_delta', usage: { output_tokens: 20 } },
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-compat-usage',
        tool_use_id: 'tool-compat-usage',
        status: 'completed',
        summary: 'feito',
      },
      {
        type: 'result',
        usage: { input_tokens: 110, output_tokens: 25 },
      },
    );

    await executeClaudeCompatSdkQuery(
      'hello',
      makeQueryOptions({ sessionId: 'compat-native-usage' }),
      noopGetWindow,
      undefined,
      makeSelection({ provider: 'zai', model: 'glm-4.7' }),
    );

    expect(ledgerMocks.updateSession).toHaveBeenCalledWith('compat-native-usage', 10, 5, 0, {
      costStatus: 'known',
      tokenStatus: 'reported',
      runtime: 'zai',
    });
    const child = ledgerMocks.start.mock.calls[1][0] as Record<string, unknown>;
    expect(ledgerMocks.finalize).toHaveBeenCalledWith(
      child.executionId,
      expect.objectContaining({ inputTokens: 100, outputTokens: 20 }),
    );
  });

  it('degrada pai e native-task quando o agregado inseparavel e o stream omite input', async () => {
    queuedSdkMessages.push(
      {
        type: 'stream_event',
        event: { type: 'message_start', message: { model: 'glm-4.7', usage: {} } },
      },
      { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 5 } } },
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-compat-inseparable',
        tool_use_id: 'tool-compat-inseparable',
        description: 'delegar compat sem input no stream',
        task_type: 'researcher',
      },
      {
        type: 'stream_event',
        parent_tool_use_id: 'tool-compat-inseparable',
        event: { type: 'message_start', message: { model: 'glm-4.7', usage: {} } },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: 'tool-compat-inseparable',
        event: { type: 'message_delta', usage: { output_tokens: 20 } },
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-compat-inseparable',
        tool_use_id: 'tool-compat-inseparable',
        status: 'completed',
        summary: 'feito',
      },
      { type: 'result', usage: { input_tokens: 110, output_tokens: 25 } },
    );

    await executeClaudeCompatSdkQuery(
      'hello',
      makeQueryOptions({ sessionId: 'compat-native-inseparable' }),
      noopGetWindow,
      undefined,
      makeSelection({ provider: 'zai', model: 'glm-4.7' }),
    );

    expect(ledgerMocks.updateSession).toHaveBeenCalledWith(
      'compat-native-inseparable',
      0,
      5,
      0,
      {
        costStatus: 'unknown',
        tokenStatus: 'not_reported',
        costUnknownReason: 'no-usage-reported',
        runtime: 'zai',
      },
    );
    const child = ledgerMocks.start.mock.calls[1][0] as Record<string, unknown>;
    expect(ledgerMocks.finalize).toHaveBeenCalledWith(
      child.executionId,
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 20,
        costStatus: 'unknown',
        tokenStatus: 'not_reported',
        costUnknownReason: 'no-usage-reported',
      }),
    );
  });

  it('persiste MiniMax TokenPlan como equivalente de assinatura', async () => {
    queuedSdkMessages.push({
      type: 'result',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await executeClaudeCompatSdkQuery(
      'hello',
      makeQueryOptions({ sessionId: 'compat-minimax-usage' }),
      noopGetWindow,
      undefined,
      makeSelection({ provider: 'minimax', model: 'MiniMax-M2.7' }),
    );

    expect(ledgerMocks.updateSession).toHaveBeenCalledWith('compat-minimax-usage', 10, 5, 0, {
      costStatus: 'known',
      tokenStatus: 'reported',
      runtime: 'minimax-tp',
      costEstimationKind: 'subscription-equivalent-payg',
    });
  });
});

describe('SPEC-004 §5.6.1 — env override is scoped to MiniMax', () => {
  it('applies the MiniMax env block when selection.provider === "minimax"', async () => {
    await executeClaudeCompatSdkQuery(
      'hello',
      makeQueryOptions({ sessionId: 'minimax-env-1' }),
      noopGetWindow,
      undefined,
      makeSelection({ provider: 'minimax', model: 'MiniMax-M2.7' }),
    );

    expect(capturedQueryArgs).toHaveLength(1);
    const env = capturedQueryArgs[0].options.env as Record<string, string>;
    expect(env.ANTHROPIC_MODEL).toBe('MiniMax-M2.7');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('MiniMax-M2.7');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('MiniMax-M2.7');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M2.7');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('fake-api-key');
    expect(env.API_TIMEOUT_MS).toBe('3000000');
  });

  it('does NOT apply the MiniMax env block when selection.provider === "zai"', async () => {
    await executeClaudeCompatSdkQuery(
      'hello',
      makeQueryOptions({ sessionId: 'zai-env-1' }),
      noopGetWindow,
      undefined,
      makeSelection({ provider: 'zai', model: 'glm-4.7' }),
    );

    expect(capturedQueryArgs).toHaveLength(1);
    const env = capturedQueryArgs[0].options.env as Record<string, string>;
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('fake-api-key');
    expect(env.API_TIMEOUT_MS).toBe('3000000');
  });
});

describe('SPEC-004 §5.6.4 — buildAgentDefinitions subagent model override', () => {
  function mockOneCloudAgent(agentModel: string) {
    const seed: Partial<AgentConfig> = {
      id: 'subagent-1',
      name: 'Subagent 1',
      description: 'fixture',
      model: agentModel,
      isActive: true,
      runtime: 'cloud',
    };
    vi.mocked(getAllAgents).mockReturnValue([seed as AgentConfig]);
  }

  it('forces model: undefined for ALL subagents when provider === "minimax"', async () => {
    mockOneCloudAgent('claude-sonnet-4-6');

    const defs = await buildAgentDefinitions('minimax');

    expect(Object.keys(defs)).toEqual(['subagent-1']);
    expect(defs['subagent-1'].model).toBeUndefined();
  });

  it('preserves the seed agent.model when provider === "zai"', async () => {
    mockOneCloudAgent('claude-sonnet-4-6');

    const defs = await buildAgentDefinitions('zai');

    expect(Object.keys(defs)).toEqual(['subagent-1']);
    expect(defs['subagent-1'].model).toBe('claude-sonnet-4-6');
  });
});

describe('SPEC-008 §13.2 — buildCompatEnv sanitizes inherited Anthropic env', () => {
  it('strips inherited ANTHROPIC_* and API_TIMEOUT_MS, re-injecting the subscription token', () => {
    const selection = makeSelection({
      provider: 'zai',
      apiKey: 'subscription-token',
    });

    const env = buildCompatEnv(selection, {
      ANTHROPIC_API_KEY: 'leak',
      ANTHROPIC_AUTH_TOKEN: 'stale',
      ANTHROPIC_BASE_URL: 'https://leak.example/anthropic',
      API_TIMEOUT_MS: '999',
      PATH: '/usr/bin',
    } as NodeJS.ProcessEnv);

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('subscription-token');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env.API_TIMEOUT_MS).toBe('3000000');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('strips a leaked ANTHROPIC_API_KEY even for MiniMax (regression guard)', () => {
    const selection = makeSelection({
      provider: 'minimax',
      model: 'MiniMax-M2.7',
      apiKey: 'minimax-subscription',
    });

    const env = buildCompatEnv(selection, {
      ANTHROPIC_API_KEY: 'leak',
      ANTHROPIC_MODEL: 'inherited-should-be-dropped',
      PATH: '/usr/bin',
    } as NodeJS.ProcessEnv);

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('minimax-subscription');
    expect(env.ANTHROPIC_MODEL).toBe('MiniMax-M2.7');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic');
  });
});

describe('SPEC agent-sdk-0.3 D9 — buildCompatEnv injeta CLAUDE_CODE_MAX_CONTEXT_TOKENS', () => {
  it('Z.ai glm-5.2 (janela 1M conhecida) -> "1000000"', () => {
    const env = buildCompatEnv(
      makeSelection({ provider: 'zai', model: 'glm-5.2' }),
      { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
    );
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
  });

  it('MiniMax MiniMax-M3 (janela 1M conhecida) -> "1000000"', () => {
    const env = buildCompatEnv(
      makeSelection({ provider: 'minimax', model: 'MiniMax-M3' }),
      { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
    );
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
    expect(env.ANTHROPIC_MODEL).toBe('MiniMax-M3');
  });

  it('janela conhecida < 1M -> valor real (glm-5.1 -> "200000", MiniMax-M2.7 -> "204800")', () => {
    const zai = buildCompatEnv(
      makeSelection({ provider: 'zai', model: 'glm-5.1' }),
      {} as NodeJS.ProcessEnv,
    );
    expect(zai.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('200000');

    const minimax = buildCompatEnv(
      makeSelection({ provider: 'minimax', model: 'MiniMax-M2.7' }),
      {} as NodeJS.ProcessEnv,
    );
    expect(minimax.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('204800');
  });

  it('modelo desconhecido -> chave AUSENTE mesmo com override/compact knobs no baseEnv', () => {
    const env = buildCompatEnv(
      makeSelection({ provider: 'zai', model: 'totally-unknown-model-x' }),
      {
        PATH: '/usr/bin',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '999999',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000',
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50',
        DISABLE_AUTO_COMPACT: '1',
        DISABLE_COMPACT: '1',
      } as NodeJS.ProcessEnv,
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
    expect(env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    expect(env).not.toHaveProperty('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE');
    expect(env).not.toHaveProperty('DISABLE_AUTO_COMPACT');
    expect(env).not.toHaveProperty('DISABLE_COMPACT');
  });

  it('modelo conhecido: o valor do LionClaw vence o override herdado', () => {
    const env = buildCompatEnv(
      makeSelection({ provider: 'zai', model: 'glm-5.2' }),
      { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '123' } as NodeJS.ProcessEnv,
    );
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
  });

  it('executeClaudeCompatSdkQuery: options.model e o slug limpo (sem [1m]) e a env leva a janela', async () => {
    await executeClaudeCompatSdkQuery(
      'hello',
      makeQueryOptions({ sessionId: 'minimax-1m-env-1' }),
      noopGetWindow,
      undefined,
      makeSelection({ provider: 'minimax', model: 'MiniMax-M3' }),
    );

    expect(capturedQueryArgs).toHaveLength(1);
    expect(capturedQueryArgs[0].options.model).toBe('MiniMax-M3');
    const env = capturedQueryArgs[0].options.env as Record<string, string>;
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
    expect(env.ANTHROPIC_MODEL).toBe('MiniMax-M3');
  });
});
