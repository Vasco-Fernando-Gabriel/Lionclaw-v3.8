import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../db', () => ({
  getAgent: vi.fn(),
  getAllAgents: vi.fn(),
  getSetting: vi.fn(() => undefined),
  insertAuditEntry: vi.fn(),
  startTaskExecution: vi.fn(),
  finalizeTaskExecutionOnce: vi.fn(),
  finalizeTaskExecutionRootIfIdle: vi.fn(),
}));

vi.mock('../agent-runtime/execute', () => ({
  executeAgent: vi.fn(),
}));

const isAvailableMock = vi.fn();
vi.mock('../codex-runtime/factory', () => ({
  createCodexDriver: () => ({ isAvailable: isAvailableMock }),
}));

const capturedTools: Array<{
  name: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>;
}> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (opts: { name: string; version?: string; tools?: unknown[] }) => {
    return { type: 'sdk', name: opts.name, instance: {} };
  },
  tool: (
    name: string,
    _description: string,
    schema: Record<string, unknown>,
    handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>,
  ) => {
    capturedTools.push({ name, schema, handler });
    return { name, handler };
  },
}));

import {
  finalizeTaskExecutionOnce,
  finalizeTaskExecutionRootIfIdle,
  getAgent,
  getAllAgents,
  startTaskExecution,
} from '../db';
import { executeAgent } from '../agent-runtime/execute';
import { CodexAuthError } from '../codex-runtime/errors';

import { getCodexAgentsServer } from '../codex-agents-mcp';
import { getCodexAgentsDescription } from '../codex-agent-tools';

const hostDispatchContext = {
  ownerKind: 'chat' as const,
  ownerId: 'session-host',
  sessionId: 'session-host',
  lane: 'desktop' as const,
  surface: 'test',
  workspace: { cwd: '/workspace/host', readRoots: ['/workspace/host'], writeRoots: [] },
  permission: { mode: 'default' as const, dangerouslySkipPermissions: false },
  parentAbortSignal: new AbortController().signal,
  rootExecutionId: 'root-host',
  parentExecutionId: 'root-host',
  depth: 0,
  remainingBudget: 16,
  budgetState: { remaining: 16 },
  controlState: {} as { providerAuthError?: Error },
  abortOwner: vi.fn(),
  capabilityCeiling: { allowedTools: ['Agent'], allowedMcpServerIds: [] },
  inheritedEffort: { claude: 'max' as const, codex: 'max' as const },
};
await getCodexAgentsServer(hostDispatchContext);

function getToolHandler(toolName: string) {
  const entry = capturedTools.find((t) => t.name === toolName);
  if (!entry) throw new Error(`Tool "${toolName}" not captured -- check mock setup`);
  return entry.handler;
}

function makeSyntheticResult() {
  return {
    output: 'Feature implemented successfully.',
    model: 'gpt-5.5',
    runtime: 'codex' as const,
    provider: 'openai-codex',
    metrics: {
      inputTokens: 500,
      outputTokens: 300,
      cacheReadTokens: 100,
      cacheCreationTokens: 0,
      toolUses: 3,
      apiRequests: 1,
      durationMs: 1500,
      costUsd: 0.0042,
    },
  };
}

function makeCodexAgent(id = 'coder-codex') {
  return {
    id,
    name: 'Codex Coder',
    description: 'Agente coder usando OpenAI Codex',
    model: 'gpt-5.5',
    runtime: 'codex' as const,
    isActive: true,
    codexConfig: { model: 'gpt-5.5', sandbox: 'workspace-write', reasoningEffort: 'high' },
  };
}

describe('codex-agents-mcp: run_codex_agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostDispatchContext.remainingBudget = 16;
    hostDispatchContext.budgetState.remaining = 16;
    hostDispatchContext.controlState = {};
  });

  it('1. Happy path: response preserva status/ID sem devolver metricas do ledger', async () => {
    const agent = makeCodexAgent();
    (getAgent as Mock).mockReturnValue(agent);
    (executeAgent as Mock).mockResolvedValue(makeSyntheticResult());

    const handler = getToolHandler('run_codex_agent');
    const result = (await handler({ agentId: 'coder-codex', prompt: 'Implement feature X' })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toBe('Feature implemented successfully.');
    expect(result.content[1].text).toContain('[codex-agent-metadata]');
    expect(result.content[1].text).toMatch(/"executionId":"[^"]+"/);
    expect(result.content[1].text).toContain('"status":"completed"');
    expect(result.content[1].text).not.toMatch(/inputTokens|outputTokens|totalTokens|costUsd|toolUses|durationMs/);

    expect(executeAgent).toHaveBeenCalledOnce();
    expect(executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'coder-codex',
        prompt: 'Implement feature X',
        cwd: '/workspace/host',
        abortController: expect.any(AbortController),
        inheritedEffort: hostDispatchContext.inheritedEffort,
        executionContext: expect.objectContaining({
          ownerId: 'session-host',
          rootExecutionId: 'root-host',
          depth: 1,
        }),
      }),
    );
    expect(startTaskExecution).toHaveBeenCalledTimes(2);
    expect(finalizeTaskExecutionOnce).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'completed', inputTokens: 500, costUsd: 0.0042 }),
    );
    expect(finalizeTaskExecutionRootIfIdle).toHaveBeenCalledWith('root-host');
  });

  it('1b. Context is prepended to prompt when provided', async () => {
    const agent = makeCodexAgent();
    (getAgent as Mock).mockReturnValue(agent);
    (executeAgent as Mock).mockResolvedValue(makeSyntheticResult());

    const handler = getToolHandler('run_codex_agent');
    await handler({ agentId: 'coder-codex', prompt: 'Do the task', context: 'File content: ...' });

    expect(executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'coder-codex',
        prompt: 'File content: ...\n\nDo the task',
        cwd: '/workspace/host',
      }),
    );
  });

  it('1c. MCP request id fica em metadata de transporte, sem fingir tool_use_id do modelo', async () => {
    (getAgent as Mock).mockReturnValue(makeCodexAgent());
    (executeAgent as Mock).mockResolvedValue(makeSyntheticResult());

    const handler = getToolHandler('run_codex_agent');
    await handler({ agentId: 'coder-codex', prompt: 'Do the task' }, { requestId: 73 });

    expect(startTaskExecution).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        toolUseId: null,
        metadata: expect.objectContaining({
          transportCorrelation: { kind: 'mcp-request-id', value: '73' },
        }),
      }),
    );
    expect(finalizeTaskExecutionOnce).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        metadata: expect.objectContaining({
          transportCorrelation: { kind: 'mcp-request-id', value: '73' },
        }),
      }),
    );
  });

  it('1d. Schema nao aceita cwd, session ou ancestry fornecidos pelo modelo', () => {
    const entry = capturedTools.find((tool) => tool.name === 'run_codex_agent');
    expect(Object.keys(entry?.schema ?? {}).sort()).toEqual(['agentId', 'context', 'prompt']);
  });

  it('1e. Falha estruturada do executor preserva status/ID sem devolver metricas', async () => {
    (getAgent as Mock).mockReturnValue(makeCodexAgent());
    (executeAgent as Mock).mockResolvedValue({
      ...makeSyntheticResult(),
      error: { code: 'LLM-PROVIDER', userMessage: 'provider indisponivel', retryable: true },
    });

    const handler = getToolHandler('run_codex_agent');
    const result = (await handler({ agentId: 'coder-codex', prompt: 'Do something' })) as {
      content: Array<{ text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).toMatch(/"executionId":"[^"]+"/);
    expect(result.content[1].text).toContain('"status":"failed"');
    expect(result.content[1].text).not.toMatch(/inputTokens|outputTokens|costUsd/);
  });

  it('2. Agent not found: isError true and message mentions agent id', async () => {
    (getAgent as Mock).mockReturnValue(undefined);

    const handler = getToolHandler('run_codex_agent');
    const result = (await handler({ agentId: 'missing-agent', prompt: 'Do something' })) as {
      content: Array<{ text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('missing-agent');
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('3. Wrong runtime: isError true and message mentions runtime mismatch', async () => {
    (getAgent as Mock).mockReturnValue({
      id: 'cloud-agent',
      runtime: 'cloud',
      isActive: true,
    });

    const handler = getToolHandler('run_codex_agent');
    const result = (await handler({ agentId: 'cloud-agent', prompt: 'Do something' })) as {
      content: Array<{ text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cloud');
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('4. executor throws: isError true with error message and ledger failure', async () => {
    const agent = makeCodexAgent();
    (getAgent as Mock).mockReturnValue(agent);
    (executeAgent as Mock).mockRejectedValue(new Error('bridge timeout'));

    const handler = getToolHandler('run_codex_agent');
    const result = (await handler({ agentId: 'coder-codex', prompt: 'Do something' })) as {
      content: Array<{ text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('bridge timeout');
    expect(finalizeTaskExecutionOnce).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'failed', costStatus: 'unknown' }),
    );
  });

  it('4b. auth Codex aborta o owner e nao e convertida em erro MCP comum', async () => {
    const authError = new CodexAuthError('login necessario');
    (getAgent as Mock).mockReturnValue(makeCodexAgent());
    (executeAgent as Mock).mockRejectedValue(authError);

    const handler = getToolHandler('run_codex_agent');
    await expect(handler({ agentId: 'coder-codex', prompt: 'Do something' })).rejects.toBe(authError);

    expect(hostDispatchContext.controlState.providerAuthError).toBe(authError);
    expect(hostDispatchContext.abortOwner).toHaveBeenCalledWith(authError);
  });
});

describe('codex-agents-mcp: codex_agents_health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('5. Returns JSON string with installed, version, authenticated, implementation fields', async () => {
    isAvailableMock.mockResolvedValue({
      installed: true,
      version: '1.0.0',
      authenticated: true,
      appServerSupported: true,
      implementation: 'official-app-server',
    });

    const handler = getToolHandler('codex_agents_health');
    const result = (await handler({})) as { content: Array<{ text: string }> };

    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.installed).toBe(true);
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.authenticated).toBe(true);
    expect(parsed.appServerSupported).toBe(true);
    expect(parsed.implementation).toBe('official-app-server');
  });

  it('5b. version defaults to null when the driver omits it', async () => {
    isAvailableMock.mockResolvedValue({
      installed: false,
      authenticated: false,
      appServerSupported: false,
      implementation: 'official-app-server',
    });

    const handler = getToolHandler('codex_agents_health');
    const result = (await handler({})) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.installed).toBe(false);
    expect(parsed.version).toBe(null);
    expect(parsed.authenticated).toBe(false);
    expect(parsed.implementation).toBe('official-app-server');
  });
});

describe('getCodexAgentsDescription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('6. Returns empty string when no codex agents exist', () => {
    (getAllAgents as Mock).mockReturnValue([
      { id: 'cloud-1', runtime: 'cloud', isActive: true },
      { id: 'local-1', runtime: 'local', isActive: true, localConfig: { model: 'llama3' } },
    ]);

    const result = getCodexAgentsDescription();
    expect(result).toBe('');
  });

  it('7. Returns description string with both codex agents listed', () => {
    (getAllAgents as Mock).mockReturnValue([
      {
        id: 'codex-coder',
        name: 'Codex Coder',
        description: 'Implementa codigo com Codex',
        runtime: 'codex',
        isActive: true,
        codexConfig: { model: 'gpt-5.5' },
      },
      {
        id: 'codex-reviewer',
        name: 'Codex Reviewer',
        description: 'Revisa pull requests',
        runtime: 'codex',
        isActive: true,
        codexConfig: { model: 'gpt-5.4-mini' },
      },
      {
        id: 'codex-inactive',
        name: 'Codex Inactive',
        description: 'Inativo',
        runtime: 'codex',
        isActive: false,
        codexConfig: { model: 'gpt-5.5' },
      },
      {
        id: 'cloud-1',
        name: 'Cloud Agent',
        description: 'Cloud',
        runtime: 'cloud',
        isActive: true,
      },
    ]);

    const result = getCodexAgentsDescription();

    expect(result).not.toBe('');
    expect(result).toContain('Agentes Codex Disponiveis');
    expect(result).toContain('run_codex_agent');
    expect(result).toContain('"codex-coder"');
    expect(result).toContain('gpt-5.5');
    expect(result).toContain('"codex-reviewer"');
    expect(result).toContain('gpt-5.4-mini');
    expect(result).not.toContain('"codex-inactive"');
    expect(result).not.toContain('"cloud-1"');
  });
});
