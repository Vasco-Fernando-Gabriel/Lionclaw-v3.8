
import { describe, it, expect, beforeEach, vi } from 'vitest';


const capturedQueryCalls: Array<{
  prompt: string;
  options: Record<string, unknown>;
}> = [];
const capturedToggleCalls: Array<{ name: string; enabled: boolean }> = [];
let nextIteratorError: Error | null = null;
let nextIteratorMessages: Array<Record<string, unknown>> | null = null;

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: vi.fn(
      (args: { prompt: string; options: Record<string, unknown> }) => {
        capturedQueryCalls.push({ prompt: args.prompt, options: args.options });
        const iterator = {
          [Symbol.asyncIterator]() {
            const messages = nextIteratorMessages ?? [{ type: 'result' }];
            let index = 0;
            return {
              async next() {
                if (nextIteratorError) {
                  const err = nextIteratorError;
                  nextIteratorError = null;
                  throw err;
                }
                if (index >= messages.length)
                  return { value: undefined, done: true };
                const value = messages[index];
                index += 1;
                return { value, done: false };
              },
            };
          },
          toggleMcpServer: vi.fn(async (name: string, enabled: boolean) => {
            capturedToggleCalls.push({ name, enabled });
          }),
        };
        return iterator;
      },
    ),
  };
});

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  rootLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('../../db', () => ({
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(() => undefined),
  insertMessage: vi.fn(),
  getTurnIndexForUserMessage: vi.fn(() => 1),
  getLatestUserTurnIndex: vi.fn(() => 1),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(),
  getSetting: vi.fn((key: string) => {
    if (key === 'onboarding_completed') return 'true';
    if (key === 'default_model') return undefined;
    return undefined;
  }),
  updateSessionTokens: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
  setSessionAgenticContextTokens: vi.fn(),
  resetSessionAgenticContext: vi.fn(),
  getSessionMessagesAfterFence: vi.fn(() => []),
  getActiveChatSession: vi.fn(() => undefined),
  getSession: vi.fn(() => undefined),
  getEnabledTools: vi.fn(() => ['Read', 'Edit', 'Bash']),
  getSessionMessages: vi.fn(() => []),
  insertTaskExecution: vi.fn(),
}));

vi.mock('../../knowledge-state', () => ({
  setActiveAgentId: vi.fn(),
}));

vi.mock('../../onboarding', () => ({
  extractAndProcessOnboardingData: vi.fn(() => null),
}));

vi.mock('../../pricing', () => ({
  calculateCost: vi.fn(() => 0),
}));

vi.mock('../../secrets-vault', () => ({
  getSecret: vi.fn(async (key: string) => {
    if (key === 'orchestratorZaiApiKeyRef') return 'sk-zai-vault-stored-token';
    return null;
  }),
}));

vi.mock('../../permission-guard', () => ({
  createPermissionGuard: vi.fn(() => () => ({ behavior: 'allow' })),
  GUARD_GATED_TOOLS: ['Bash', 'Write', 'Edit'],
}));

vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async () => null),
  getMcpToolRegistryEntries: vi.fn(() => []),
}));

vi.mock('../../agent-config-resolver', () => ({
  resolveAgentQueryConfig: vi.fn(async () => ({
    allowedTools: [],
    systemPrompt: '',
    maxTurns: 0,
    mcpServers: [],
  })),
}));

vi.mock('../../mcp-discovery', () => ({
  getDisabledSDKMcps: vi.fn(() => []),
  getCachedSDKMcpServers: vi.fn(() => []),
}));

vi.mock('../../artifact-detector', () => ({
  captureToolUse: vi.fn(() => null),
  captureToolResult: vi.fn(() => null),
  resetArtifactDetector: vi.fn(),
}));

vi.mock('../../prompt-builder', () => ({
  buildSystemPrompt: vi.fn(() => 'TEST SYSTEM PROMPT'),
}));

vi.mock('../../pipeline-shared/sdk-bootstrap', () => ({
  ensureNodeInPath: vi.fn(),
  getClaudeCodeExecutablePath: vi.fn(() => '/tmp/claude-agent-sdk-cli.js'),
  getClaudeSdkProcessOptions: vi.fn(() => ({
    pathToClaudeCodeExecutable: '/tmp/claude-agent-sdk-cli.js',
    executable: 'node',
  })),
}));

vi.mock('../../paths', () => ({
  getAgentCwd: vi.fn(() => '/tmp/lionclaw-test-cwd'),
  getLionClawHome: vi.fn(() => '/tmp/lionclaw-test-home'),
}));

vi.mock('../../codex-agents-mcp', () => ({
  getCodexAgentsServer: vi.fn(async () => ({
    type: 'sdk',
    name: 'codex-agents',
    instance: {},
  })),
}));

vi.mock('../../title-generator', () => ({
  ensureInitialSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(async () => {}),
}));


import { executeClaudeCompatSdkQuery } from '../index';
import type { OrchestratorSelection } from '../../orchestrator-selection';
import { makeScopedSdkSessionId } from '../../sdk-session-id';
import {
  estimateStrongFloor,
  CLI_PRESET_TOKENS,
  CLI_BUILTIN_SCHEMAS_TOKENS,
  __clearCompositionCacheForTests,
} from '../../agent-runtime/context-measure';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

beforeEach(() => {
  capturedQueryCalls.length = 0;
  capturedToggleCalls.length = 0;
  nextIteratorError = null;
  nextIteratorMessages = null;
  vi.clearAllMocks();
});

function makeSelection(
  overrides: Partial<OrchestratorSelection> = {},
): OrchestratorSelection {
  return {
    runtime: 'claude-compat-sdk',
    provider: 'zai',
    model: 'glm-4.7',
    baseUrl: 'https://api.z.ai/api/anthropic',
    apiKey: undefined,
    source: 'settings',
    ...overrides,
  };
}

function makeGetWindow() {
  const win = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  };
  return () => win as unknown as Electron.BrowserWindow;
}

describe('executeClaudeCompatSdkQuery: env injection (SP-10.4)', () => {
  it('passes env.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and API_TIMEOUT_MS to query()', async () => {
    const previousPath = process.env.PATH;
    process.env.PATH = previousPath || '/usr/bin';
    try {
      const selection = makeSelection();
      await executeClaudeCompatSdkQuery(
        'oi',
        { sessionId: 'test-session-001' },
        makeGetWindow(),
        undefined,
        selection,
      );

      expect(capturedQueryCalls.length).toBe(1);
      const env = (
        capturedQueryCalls[0].options as { env?: Record<string, string> }
      ).env;

      expect(env).toBeDefined();
      expect(env!.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
      expect(env!.ANTHROPIC_AUTH_TOKEN).toBe('sk-zai-vault-stored-token');
      expect(env!.API_TIMEOUT_MS).toBe('3000000');
      expect(env!.PATH).toBe(process.env.PATH);
      expect(capturedQueryCalls[0].options.pathToClaudeCodeExecutable).toBe(
        '/tmp/claude-agent-sdk-cli.js',
      );
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it('forwards selection.model (e.g. "glm-4.7") to query() options.model as-is', async () => {
    const selection = makeSelection({ model: 'glm-4.7' });
    await executeClaudeCompatSdkQuery(
      'oi',
      { sessionId: 'test-session-002' },
      makeGetWindow(),
      undefined,
      selection,
    );

    expect(capturedQueryCalls[0].options.model).toBe('glm-4.7');
  });

  it('sets a compat maxTurns guardrail on the SDK query', async () => {
    const selection = makeSelection({ model: 'glm-5-turbo' });
    await executeClaudeCompatSdkQuery(
      'oi',
      { sessionId: 'test-session-max-turns' },
      makeGetWindow(),
      undefined,
      selection,
    );

    expect(capturedQueryCalls[0].options.maxTurns).toBe(30);
  });

  it('scopes the SDK transcript session id away from the LionClaw DB session id', async () => {
    const selection = makeSelection({ provider: 'zai' });
    await executeClaudeCompatSdkQuery(
      'oi',
      { sessionId: 'test-session-scoped-sdk-id' },
      makeGetWindow(),
      undefined,
      selection,
    );

    expect(capturedQueryCalls[0].options.sessionId).toBe(
      makeScopedSdkSessionId(
        'claude-compat-sdk:zai:desktop',
        'test-session-scoped-sdk-id',
      ),
    );
  });

  it('appends the active compat runtime and selected GLM model to the system prompt', async () => {
    const selection = makeSelection({ model: 'glm-5-turbo' });
    await executeClaudeCompatSdkQuery(
      'oi',
      { sessionId: 'test-session-runtime-section' },
      makeGetWindow(),
      undefined,
      selection,
    );

    const systemPrompt = capturedQueryCalls[0].options.systemPrompt as {
      type: 'preset';
      append: string;
    };

    expect(systemPrompt.append).toContain('# Runtime ativo do orquestrador');
    expect(systemPrompt.append).toContain('- Runtime: claude-compat-sdk');
    expect(systemPrompt.append).toContain('- Provider: Z.ai (zai)');
    expect(systemPrompt.append).toContain('- Modelo selecionado: glm-5-turbo');
    expect(systemPrompt.append).toContain('Nao use ferramentas server-side');
  });

  it('disables cached claude.ai SDK MCPs for Z.ai compat only', async () => {
    const { getCachedSDKMcpServers } = await import('../../mcp-discovery');
    (
      getCachedSDKMcpServers as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValueOnce([
      { name: 'claude.ai Notion', status: 'connected' },
      { name: 'claude.ai Excalidraw', status: 'connected' },
      { name: 'local-other', status: 'connected' },
    ]);

    await executeClaudeCompatSdkQuery(
      'oi',
      { sessionId: 'test-session-sdk-mcp-disable' },
      makeGetWindow(),
      undefined,
      makeSelection(),
    );

    expect(capturedToggleCalls).toEqual(
      expect.arrayContaining([
        { name: 'claude.ai Notion', enabled: false },
        { name: 'claude_ai_Notion', enabled: false },
        { name: 'claude.ai Excalidraw', enabled: false },
        { name: 'claude_ai_Excalidraw', enabled: false },
      ]),
    );
    expect(capturedToggleCalls).not.toContainEqual({
      name: 'local-other',
      enabled: false,
    });
  });

  it('uses the apiKey from selection when present and skips the vault read', async () => {
    const { getSecret } = await import('../../secrets-vault');
    const selection = makeSelection({ apiKey: 'sk-from-selection' });
    await executeClaudeCompatSdkQuery(
      'oi',
      { sessionId: 'test-session-003' },
      makeGetWindow(),
      undefined,
      selection,
    );

    const env = (
      capturedQueryCalls[0].options as { env?: Record<string, string> }
    ).env;
    expect(env!.ANTHROPIC_AUTH_TOKEN).toBe('sk-from-selection');
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('passes a different GLM slug through unchanged (no model rewriting)', async () => {
    const selection = makeSelection({ model: 'glm-5.1' });
    await executeClaudeCompatSdkQuery(
      'oi',
      { sessionId: 'test-session-004' },
      makeGetWindow(),
      undefined,
      selection,
    );

    expect(capturedQueryCalls[0].options.model).toBe('glm-5.1');
  });

  it('D9: glm-5.2 (janela 1M) -> options.model sem sufixo e CLAUDE_CODE_MAX_CONTEXT_TOKENS = "1000000"', async () => {
    const previous = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '123';
    try {
      const selection = makeSelection({ model: 'glm-5.2' });
      await executeClaudeCompatSdkQuery(
        'oi',
        { sessionId: 'test-session-d9-1m' },
        makeGetWindow(),
        undefined,
        selection,
      );

      expect(capturedQueryCalls.length).toBe(1);
      expect(capturedQueryCalls[0].options.model).toBe('glm-5.2');
      const env = (
        capturedQueryCalls[0].options as { env?: Record<string, string> }
      ).env;
      expect(env!.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
      else process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = previous;
    }
  });

  it('D9: glm-5.1 (janela 200K) -> CLAUDE_CODE_MAX_CONTEXT_TOKENS = "200000"', async () => {
    const selection = makeSelection({ model: 'glm-5.1' });
    await executeClaudeCompatSdkQuery(
      'oi',
      { sessionId: 'test-session-d9-200k' },
      makeGetWindow(),
      undefined,
      selection,
    );

    const env = (
      capturedQueryCalls[0].options as { env?: Record<string, string> }
    ).env;
    expect(env!.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('200000');
  });

  it('D9: modelo desconhecido -> CLAUDE_CODE_MAX_CONTEXT_TOKENS AUSENTE mesmo com override no host', async () => {
    const previousMax = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    const previousDisable = process.env.DISABLE_AUTO_COMPACT;
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '999999';
    process.env.DISABLE_AUTO_COMPACT = '1';
    try {
      const selection = makeSelection({ model: 'totally-unknown-model-x' });
      await executeClaudeCompatSdkQuery(
        'oi',
        { sessionId: 'test-session-d9-unknown' },
        makeGetWindow(),
        undefined,
        selection,
      );

      expect(capturedQueryCalls.length).toBe(1);
      expect(capturedQueryCalls[0].options.model).toBe('totally-unknown-model-x');
      const env = (
        capturedQueryCalls[0].options as { env?: Record<string, string> }
      ).env;
      expect(env).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
      expect(env).not.toHaveProperty('DISABLE_AUTO_COMPACT');
    } finally {
      if (previousMax === undefined) delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
      else process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = previousMax;
      if (previousDisable === undefined) delete process.env.DISABLE_AUTO_COMPACT;
      else process.env.DISABLE_AUTO_COMPACT = previousDisable;
    }
  });

  it('retries once with a fresh SDK session when resume fails', async () => {
    const { getSessionMessages } = await import('../../db');
    (
      getSessionMessages as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValueOnce([
      { id: 1, role: 'user', content: 'mensagem anterior' },
    ]);
    nextIteratorError = Object.assign(
      new Error('resume subprocess pipe closed'),
      {
        code: 'EPIPE',
      },
    );

    const selection = makeSelection();
    await executeClaudeCompatSdkQuery(
      'oi',
      { sessionId: 'test-session-006' },
      makeGetWindow(),
      undefined,
      selection,
    );

    expect(capturedQueryCalls.length).toBe(2);
    const scopedSessionId = makeScopedSdkSessionId(
      'claude-compat-sdk:zai:desktop',
      'test-session-006',
    );

    expect(capturedQueryCalls[0].options.resume).toBe(scopedSessionId);
    expect(capturedQueryCalls[0].options.sessionId).toBeUndefined();
    expect(capturedQueryCalls[1].options.sessionId).toBe(scopedSessionId);
    expect(capturedQueryCalls[1].options.resume).toBeUndefined();
    expect(capturedQueryCalls[1].options.continue).toBeUndefined();
  });

  it('audits server_tool_use blocks with tool name and compact input', async () => {
    const { insertAuditEntry } = await import('../../db');
    nextIteratorMessages = [
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'server_tool_use',
            id: 'srv-web-1',
            name: 'web_search',
            input: { query: 'noticia IA hoje' },
          },
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'server_tool_use',
              id: 'srv-web-1',
              name: 'web_search',
              input: { query: 'noticia IA hoje' },
            },
            { type: 'text', text: 'resultado' },
          ],
        },
      },
      { type: 'result' },
    ];

    await executeClaudeCompatSdkQuery(
      'oi',
      { sessionId: 'test-session-server-tool' },
      makeGetWindow(),
      undefined,
      makeSelection(),
    );

    expect(insertAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'test-session-server-tool',
        eventType: 'tool_call',
        toolName: 'server:web_search',
        input: JSON.stringify({ query: 'noticia IA hoje' }),
      }),
    );
  });

  it('aborts repeated Z.ai webReader server-tool loops with a clear error', async () => {
    const sentChunks: unknown[] = [];
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((_channel: string, chunk: unknown) =>
          sentChunks.push(chunk),
        ),
      },
    };
    nextIteratorMessages = [
      ...Array.from({ length: 4 }, (_, index) => ({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'server_tool_use',
              id: `srv-web-${index}`,
              name: 'webReader',
              input: { url: `https://example.com/${index}` },
            },
          ],
        },
      })),
      { type: 'result' },
    ];

    await executeClaudeCompatSdkQuery(
      'oi',
      { sessionId: 'test-session-webreader-loop' },
      () => win as unknown as Electron.BrowserWindow,
      undefined,
      makeSelection(),
    );

    expect(sentChunks).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.stringContaining('webReader'),
      }),
    );
  });

  it('does NOT inject env when no apiKey is resolvable (early error path)', async () => {
    const { getSecret } = await import('../../secrets-vault');
    (getSecret as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      null,
    );

    const selection = makeSelection({ apiKey: undefined });
    await executeClaudeCompatSdkQuery(
      'oi',
      { sessionId: 'test-session-005' },
      makeGetWindow(),
      undefined,
      selection,
    );

    expect(capturedQueryCalls.length).toBe(0);
  });


  it('contador ativo: sucesso do turno SETA = PISO FORTE do payload (todos os buckets)', async () => {
    const {
      setSessionActiveContextTokens,
      setSessionAgenticContextTokens,
      resetSessionAgenticContext,
      getSessionMessagesAfterFence,
    } = await import('../../db');
    (getSessionMessagesAfterFence as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      { id: 1, content: 'pergunta viva' },
    ]);
    __clearCompositionCacheForTests();
    nextIteratorMessages = [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'resposta viva do compat' }] },
      },
      { type: 'result' },
    ];

    await executeClaudeCompatSdkQuery(
      'pergunta viva',
      { sessionId: 'test-session-active-set' },
      makeGetWindow(),
      undefined,
      makeSelection(),
    );

    const opts = capturedQueryCalls[capturedQueryCalls.length - 1].options as {
      systemPrompt: string | { append?: string };
    };
    const fullSystemPrompt =
      typeof opts.systemPrompt === 'string'
        ? opts.systemPrompt
        : opts.systemPrompt.append ?? '';
    let settingsFilesTokens = 0;
    for (const p of [
      join('/tmp/lionclaw-test-cwd', 'CLAUDE.md'),
      join(os.homedir(), '.claude', 'CLAUDE.md'),
    ]) {
      try {
        settingsFilesTokens += Math.ceil(readFileSync(p, 'utf-8').length / 4);
      } catch {
      }
    }
    const esperado = estimateStrongFloor({
      systemPrompt: fullSystemPrompt,
      presetTokens: CLI_PRESET_TOKENS,
      builtinSchemasTokens: CLI_BUILTIN_SCHEMAS_TOKENS,
      settingsFilesTokens,
      mcpSchemasTokens: 0, // registry vazio no harness
      agentDefsTokens: 0, // nenhum agent cloud ativo no harness
      messageTexts: ['pergunta viva', 'resposta viva do compat'],
      agenticTokens: 0, // turno sem tools
      imageCount: 0,
    });
    expect(setSessionActiveContextTokens).toHaveBeenCalledWith(
      'test-session-active-set',
      esperado,
    );
    expect(esperado).toBeGreaterThan(CLI_PRESET_TOKENS + CLI_BUILTIN_SCHEMAS_TOKENS);
    expect(resetSessionAgenticContext).toHaveBeenCalledWith(
      'test-session-active-set',
      { threadResetMessageId: null },
    );
    expect(setSessionAgenticContextTokens).toHaveBeenCalledWith(
      'test-session-active-set',
      0,
      undefined,
    );
  });

  it('contador ativo: turno que FALHA NAO seta (valor anterior preservado)', async () => {
    const { setSessionActiveContextTokens, setSessionAgenticContextTokens } =
      await import('../../db');
    nextIteratorError = Object.assign(new Error('provider caiu'), { code: 'BOOM' });

    await executeClaudeCompatSdkQuery(
      'oi',
      { sessionId: 'test-session-active-fail' },
      makeGetWindow(),
      undefined,
      makeSelection(),
    );

    expect(setSessionActiveContextTokens).not.toHaveBeenCalled();
    expect(setSessionAgenticContextTokens).not.toHaveBeenCalled();
  });
});
