
import { describe, it, expect, beforeEach, vi } from 'vitest';


vi.mock('../logger', () => ({
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

vi.mock('../orchestrator-selection', () => ({
  resolveOrchestratorSelection: vi.fn(),
  InvalidOrchestratorSelectionError: class extends Error {},
}));

vi.mock('../claude-compat-sdk', () => ({
  executeClaudeCompatSdkQuery: vi.fn(async () => undefined),
  isClaudeCompatQueryActive: vi.fn(() => false),
  resetClaudeCompatSdkSessionState: vi.fn(),
  stopClaudeCompatQuery: vi.fn(),
}));

vi.mock('../codex-sdk', () => ({
  executeCodexSdkQuery: vi.fn(async () => undefined),
  isCodexSdkQueryActive: vi.fn(() => false),
  resetCodexSdkSessionState: vi.fn(),
  stopCodexSdkQuery: vi.fn(),
}));

vi.mock('../lion-sdk', () => ({
  executeLionSdkQuery: vi.fn(async () => undefined),
  isLionSdkQueryActive: vi.fn(() => false),
  resetLionSdkSessionState: vi.fn(),
  stopLionSdkQuery: vi.fn(),
}));


vi.mock('../db', () => ({
  getAllAgents: () => [],
  getAgent: () => undefined,
  insertMessage: vi.fn(),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(() => 'session-1'),
  getSetting: vi.fn(),
  updateSessionTokens: vi.fn(),
  getActiveSession: vi.fn(),
  getActiveChatSession: vi.fn(),
  getSession: vi.fn(),
  getEnabledTools: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  insertTaskExecution: vi.fn(),
}));

vi.mock('../knowledge-state', () => ({
  setActiveAgentId: vi.fn(),
}));

vi.mock('../onboarding', () => ({
  extractAndProcessOnboardingData: vi.fn(),
}));

vi.mock('../pricing', () => ({
  calculateCost: () => 0,
}));

vi.mock('../secrets-vault', () => ({
  getApiKey: async () => null,
  getSecret: async () => null,
}));

vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => vi.fn(),
}));

vi.mock('../mcp-manager', () => ({
  getMCPConfigForAgent: async () => ({}),
}));

vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: async () => ({
    allowedTools: [],
    systemPrompt: '',
    mcpServers: [],
    maxTurns: 0,
  }),
}));

vi.mock('../mcp-discovery', () => ({
  getDisabledSDKMcps: () => [],
}));

vi.mock('../artifact-detector', () => ({
  captureToolUse: vi.fn(),
  captureToolResult: vi.fn(),
  resetArtifactDetector: vi.fn(),
}));

vi.mock('../prompt-builder', () => ({
  buildSystemPrompt: async () => '',
}));

vi.mock('../paths', () => ({
  getAgentCwd: () => '/tmp',
  getBackgroundCwd: () => '/tmp',
  getLionClawHome: () => '/tmp',
}));

vi.mock('../codex-agents-mcp', () => ({
  getCodexAgentsServer: () => undefined,
}));

vi.mock('../title-generator', () => ({
  ensureInitialSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(),
}));

vi.mock('../message-queue', () => ({
  messageQueue: {
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    clear: vi.fn(),
    isProcessing: false,
    length: 0,
    processingDurationMs: 0,
  },
}));

import { resolveOrchestratorSelection } from '../orchestrator-selection';
import * as orchestrator from '../orchestrator';
import {
  executeClaudeCompatSdkQuery as compatExecutor,
  resetClaudeCompatSdkSessionState as resetCompat,
  stopClaudeCompatQuery as stopCompat,
} from '../claude-compat-sdk';
import {
  executeCodexSdkQuery as codexExecutor,
  resetCodexSdkSessionState as resetCodex,
  stopCodexSdkQuery as stopCodex,
} from '../codex-sdk';
import {
  executeLionSdkQuery as lionExecutor,
  resetLionSdkSessionState as resetLion,
  stopLionSdkQuery as stopLion,
} from '../lion-sdk';
import { messageQueue } from '../message-queue';

const mockResolve = vi.mocked(resolveOrchestratorSelection);
const executeClaudeCompatSdkQuery = vi.mocked(compatExecutor);
const executeCodexSdkQuery = vi.mocked(codexExecutor);
const executeLionSdkQuery = vi.mocked(lionExecutor);
const resetClaudeCompatSdkSessionState = vi.mocked(resetCompat);
const resetCodexSdkSessionState = vi.mocked(resetCodex);
const resetLionSdkSessionState = vi.mocked(resetLion);
const stopClaudeCompatQuery = vi.mocked(stopCompat);
const stopCodexSdkQuery = vi.mocked(stopCodex);
const stopLionSdkQuery = vi.mocked(stopLion);
const clearMessageQueue = vi.mocked(messageQueue.clear);

const fakeGetWindow = () => null;

beforeEach(() => {
  vi.clearAllMocks();
  executeClaudeCompatSdkQuery.mockClear();
  executeCodexSdkQuery.mockClear();
  executeLionSdkQuery.mockClear();
  resetClaudeCompatSdkSessionState.mockClear();
  resetCodexSdkSessionState.mockClear();
  resetLionSdkSessionState.mockClear();
  stopClaudeCompatQuery.mockClear();
  stopCodexSdkQuery.mockClear();
  stopLionSdkQuery.mockClear();
  clearMessageQueue.mockClear();
});

describe('SPEC-001 §8 router dispatch (SP-13.3)', () => {
  it('dispatches runtime=claude-sdk to executeClaudeSdkQuery (none of the other three executors run)', async () => {
    mockResolve.mockResolvedValueOnce({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      source: 'settings',
    } as never);

    await expect(orchestrator.executeQuery('hi', {}, fakeGetWindow)).resolves.toBeUndefined();

    expect(executeClaudeCompatSdkQuery).not.toHaveBeenCalled();
    expect(executeCodexSdkQuery).not.toHaveBeenCalled();
    expect(executeLionSdkQuery).not.toHaveBeenCalled();
  });

  it('dispatches runtime=claude-compat-sdk to executeClaudeCompatSdkQuery', async () => {
    mockResolve.mockResolvedValueOnce({
      runtime: 'claude-compat-sdk',
      provider: 'zai',
      model: 'glm-4.7',
      apiKey: 'sk-zai-test',
      baseUrl: 'https://api.z.ai/api/anthropic',
      source: 'settings',
    } as never);

    await orchestrator.executeQuery('hi', {}, fakeGetWindow);

    expect(executeClaudeCompatSdkQuery).toHaveBeenCalledTimes(1);
    expect(executeCodexSdkQuery).not.toHaveBeenCalled();
    expect(executeLionSdkQuery).not.toHaveBeenCalled();

    const callArgs = executeClaudeCompatSdkQuery.mock.calls[0]!;
    expect(callArgs[3]).toMatchObject({ name: 'desktop' });
    expect(callArgs[4]).toMatchObject({
      runtime: 'claude-compat-sdk',
      provider: 'zai',
      apiKey: 'sk-zai-test',
    });
  });

  it('dispatches runtime=codex-sdk to executeCodexSdkQuery', async () => {
    mockResolve.mockResolvedValueOnce({
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-5.5',
      source: 'settings',
    } as never);

    await orchestrator.executeQuery('hi', {}, fakeGetWindow);

    expect(executeCodexSdkQuery).toHaveBeenCalledTimes(1);
    expect(executeClaudeCompatSdkQuery).not.toHaveBeenCalled();
    expect(executeLionSdkQuery).not.toHaveBeenCalled();
  });

  it('dispatches runtime=lion-sdk (ollama) to executeLionSdkQuery', async () => {
    mockResolve.mockResolvedValueOnce({
      runtime: 'lion-sdk',
      provider: 'ollama',
      model: 'llama3.1:8b',
      baseUrl: 'http://localhost:11434',
      source: 'settings',
    } as never);

    await orchestrator.executeQuery('hi', {}, fakeGetWindow);

    expect(executeLionSdkQuery).toHaveBeenCalledTimes(1);
    expect(executeClaudeCompatSdkQuery).not.toHaveBeenCalled();
    expect(executeCodexSdkQuery).not.toHaveBeenCalled();

    const callArgs = executeLionSdkQuery.mock.calls[0]!;
    expect(callArgs[3]).toMatchObject({ name: 'desktop' });
    expect(callArgs[4]).toMatchObject({
      runtime: 'lion-sdk',
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
    });
  });

  it('dispatches runtime=lion-sdk (lmstudio) to executeLionSdkQuery', async () => {
    mockResolve.mockResolvedValueOnce({
      runtime: 'lion-sdk',
      provider: 'lmstudio',
      model: 'qwen2.5-coder',
      baseUrl: 'http://localhost:1234',
      source: 'settings',
    } as never);

    await orchestrator.executeQuery('hi', {}, fakeGetWindow);

    expect(executeLionSdkQuery).toHaveBeenCalledTimes(1);
    const callArgs = executeLionSdkQuery.mock.calls[0]!;
    expect(callArgs[3]).toMatchObject({ name: 'desktop' });
    expect(callArgs[4]).toMatchObject({ provider: 'lmstudio' });
  });

  it('dispatches runtime=lion-sdk (openai-compatible) to executeLionSdkQuery', async () => {
    mockResolve.mockResolvedValueOnce({
      runtime: 'lion-sdk',
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-deepseek-test',
      source: 'settings',
    } as never);

    await orchestrator.executeQuery('hi', {}, fakeGetWindow);

    expect(executeLionSdkQuery).toHaveBeenCalledTimes(1);
    const callArgs = executeLionSdkQuery.mock.calls[0]!;
    expect(callArgs[3]).toMatchObject({ name: 'desktop' });
    expect(callArgs[4]).toMatchObject({
      provider: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-deepseek-test',
    });
  });

  it('resets session state for every desktop runtime', () => {
    orchestrator.resetSdkSessionState();

    expect(resetClaudeCompatSdkSessionState).toHaveBeenCalledTimes(1);
    expect(resetCodexSdkSessionState).toHaveBeenCalledTimes(1);
    expect(resetLionSdkSessionState).toHaveBeenCalledTimes(1);
    expect(clearMessageQueue).toHaveBeenCalledTimes(1);
  });

  it('stops only the desktop lane (stop por lane, nunca telegram/cron)', () => {
    orchestrator.stopCurrentQuery();

    expect(stopClaudeCompatQuery).toHaveBeenCalledTimes(1);
    expect(stopCodexSdkQuery).toHaveBeenCalledTimes(1);
    expect(stopLionSdkQuery).toHaveBeenCalledTimes(1);
    expect(stopClaudeCompatQuery.mock.calls[0]![0]).toMatchObject({ name: 'desktop' });
    expect(stopCodexSdkQuery.mock.calls[0]![0]).toMatchObject({ name: 'desktop' });
    expect(stopLionSdkQuery.mock.calls[0]![0]).toMatchObject({ name: 'desktop' });
    expect(clearMessageQueue).toHaveBeenCalledTimes(1);
  });
});
