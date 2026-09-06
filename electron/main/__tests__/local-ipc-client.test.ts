
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';


const sandboxState = vi.hoisted(() => ({
  path: '/tmp/lionclaw-ipc-client-uninitialized',
}));
const agentDispatchMock = vi.hoisted(() => vi.fn());
const taskExecutionRollupMock = vi.hoisted(() => vi.fn());

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../paths', () => ({
  getLionClawHome: () => sandboxState.path,
  getAgentCwd: () => sandboxState.path,
  getBackgroundCwd: () => path.join(sandboxState.path, 'background'),
}));

const auditEntries: Array<Record<string, unknown>> = [];
const agents: Array<Record<string, unknown>> = [];

vi.mock('../db', () => ({
  getAllAgents: () => agents,
  getAgent: (id: string) => agents.find((a) => a.id === id),
  getActiveChatSession: () => ({ id: 'test-chat-session' }),
  getSetting: () => undefined,
  getTaskExecutionRollup: taskExecutionRollupMock,
  insertAuditEntry: (entry: Record<string, unknown>) => {
    auditEntries.push({ ...entry, createdAt: new Date().toISOString() });
  },
}));

const mcpServers: Array<Record<string, unknown>> = [];

vi.mock('../mcp-manager', () => ({
  getAllMCPServers: () => mcpServers,
}));

const secrets = new Map<string, string>();

vi.mock('../secrets-vault', () => ({
  getSecret: async (key: string) => secrets.get(key) ?? null,
}));

vi.mock('../ask-question', () => ({
  sendAskQuestion: async () => ({ id: 'unused', answers: [] }),
}));

vi.mock('../lion-sdk/tools/agent', () => ({
  lionAgentDispatch: agentDispatchMock,
}));

const skillEntries: Array<{
  name: string;
  description: string;
  category?: string;
  content: string;
  allowedTools?: string[];
}> = [];

vi.mock('../skills', () => ({
  buildAgentSkillsPromptSection: () => '',
  listSkills: () =>
    skillEntries.map((s) => ({
      name: s.name,
      description: s.description,
      category: s.category,
      allowedTools: s.allowedTools,
      disableModelInvocation: false,
      userInvocable: true,
      content: s.content,
      rawContent: s.content,
      path: '/fake/' + s.name,
      hasAuxFiles: false,
    })),
  getSkill: (name: string) => {
    const s = skillEntries.find((x) => x.name === name);
    if (!s) return null;
    return {
      name: s.name,
      description: s.description,
      category: s.category,
      allowedTools: s.allowedTools,
      disableModelInvocation: false,
      userInvocable: true,
      content: s.content,
      rawContent: s.content,
      path: '/fake/' + s.name,
      hasAuxFiles: false,
    };
  },
}));


import {
  startLocalIpcServer,
  stopLocalIpcServer,
  getCurrentEndpoint,
} from '../local-ipc';
import {
  LocalIpcClient,
  readEndpoint,
  endpointFileExists,
} from '../../../mcp-servers/_shared/local-ipc-client';
import {
  clearActiveChatTurn,
  clearChatCapabilityTurn,
  registerChatCapabilityTurn,
  setActiveChatTurn,
} from '../chat-capability-context';
import { cronLane, desktopLane, telegramLane } from '../sdk-lane';
import {
  LIONCLAW_HELPER_TOKEN_ENV,
  mintHelperToken,
} from '../helper-identity';

const IS_POSIX = process.platform !== 'win32';
const TEST_SESSION_ID = 'test-chat-session';
const TEST_TURN_ID = 'test-turn-1';
let previousHelperToken: string | undefined;

beforeEach(async () => {
  const shortRoot = IS_POSIX ? '/tmp' : os.tmpdir();
  sandboxState.path = await fs.promises.mkdtemp(path.join(shortRoot, 'lc-mcp-'));
  auditEntries.length = 0;
  agents.length = 0;
  mcpServers.length = 0;
  skillEntries.length = 0;
  secrets.clear();
  agentDispatchMock.mockReset();
  taskExecutionRollupMock.mockReset();
  desktopLane.currentAbortController = null;
  telegramLane.currentAbortController = null;
  cronLane.currentAbortController = null;
  previousHelperToken = process.env[LIONCLAW_HELPER_TOKEN_ENV];
  process.env[LIONCLAW_HELPER_TOKEN_ENV] = mintHelperToken('lionclaw-agents');
});

afterEach(async () => {
  try {
    await stopLocalIpcServer();
  } catch {
  }
  for (const lane of ['desktop', 'telegram', 'cron'] as const) {
    clearActiveChatTurn({ sessionId: TEST_SESSION_ID, lane, turnId: TEST_TURN_ID });
  }
  clearChatCapabilityTurn({ sessionId: TEST_SESSION_ID, turnId: TEST_TURN_ID });
  desktopLane.currentAbortController = null;
  telegramLane.currentAbortController = null;
  cronLane.currentAbortController = null;
  if (previousHelperToken === undefined) delete process.env[LIONCLAW_HELPER_TOKEN_ENV];
  else process.env[LIONCLAW_HELPER_TOKEN_ENV] = previousHelperToken;
  try {
    await fs.promises.rm(sandboxState.path, { recursive: true, force: true });
  } catch {
  }
});

describe('local-ipc-client (SP-7.6 E2E)', () => {
  it('reads the endpoint config and round-trips list_skills via callMethod', async () => {
    skillEntries.push({
      name: 'pdf',
      description: 'PDF skill',
      category: 'document',
      content: '# PDF body',
    });
    skillEntries.push({
      name: 'xlsx',
      description: 'Spreadsheet skill',
      category: 'document',
      content: '# XLSX body',
    });

    await startLocalIpcServer();
    const endpoint = getCurrentEndpoint();
    expect(endpoint).not.toBeNull();
    if (!endpoint) return;

    expect(endpointFileExists(sandboxState.path)).toBe(true);
    const parsed = readEndpoint(sandboxState.path);
    expect(parsed.address).toBe(endpoint.address);
    expect(parsed.transport).toBe(IS_POSIX ? 'unix' : 'pipe');

    const client = new LocalIpcClient({
      lionclawHome: sandboxState.path,
      maxRetries: 2,
      baseBackoffMs: 50,
      maxBackoffMs: 500,
      callTimeoutMs: 5000,
    });

    try {
      const result = (await client.callMethod('list_skills', {})) as Array<{
        name: string;
        description: string;
        category?: string;
      }>;
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      const names = result.map((r) => r.name).sort();
      expect(names).toEqual(['pdf', 'xlsx']);
      const pdf = result.find((r) => r.name === 'pdf');
      expect(pdf?.description).toBe('PDF skill');
      expect(pdf?.category).toBe('document');
    } finally {
      client.close();
    }
  });

  it('round-trips load_skill (returns body + frontmatter)', async () => {
    skillEntries.push({
      name: 'pdf',
      description: 'PDF skill',
      category: 'document',
      content: '# PDF body content',
      allowedTools: ['Read', 'Bash'],
    });

    await startLocalIpcServer();

    const client = new LocalIpcClient({
      lionclawHome: sandboxState.path,
      maxRetries: 2,
      baseBackoffMs: 50,
      maxBackoffMs: 500,
      callTimeoutMs: 5000,
    });

    try {
      const result = (await client.callMethod('load_skill', {
        skill_name: 'pdf',
      })) as { body: string; frontmatter: Record<string, unknown> };
      expect(typeof result.body).toBe('string');
      expect(result.body).toContain('PDF body');
      expect(result.frontmatter).toBeDefined();
      expect(result.frontmatter['name']).toBe('pdf');
      expect(result.frontmatter['description']).toBe('PDF skill');
      expect(result.frontmatter['category']).toBe('document');
    } finally {
      client.close();
    }
  });

  it('round-trips call_agent to the shared Lion-SDK agent dispatcher', async () => {
    const parentGuard = vi.fn(async () => ({ behavior: 'allow' as const }));
    agentDispatchMock.mockResolvedValueOnce({
      ok: true,
      status: 'completed',
      executionId: 'execution-researcher-1',
      summary: 'agent=researcher status=completed execution=execution-researcher-1',
      output: 'LangGraph e um runtime para workflows com estado em grafo.',
    });
    taskExecutionRollupMock.mockReturnValueOnce({
      executionCount: 1,
      executionIds: ['execution-researcher-1'],
      statusCounts: { running: 0, completed: 1, failed: 0, cancelled: 0 },
      metrics: {
        inputTokens: 30,
        outputTokens: 12,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.001,
        apiRequests: 1,
        toolUses: 0,
        durationMs: 50,
      },
      costStatus: 'known',
      tokenStatus: 'reported',
      costUnknownReasons: [],
    });
    registerChatCapabilityTurn({
      surface: 'chat',
      sessionId: TEST_SESSION_ID,
      turnId: TEST_TURN_ID,
      capabilities: { pipelineControl: false, dynamicWorkflows: false },
      cwd: sandboxState.path,
      permissionProfile: {
        mode: 'default',
        dangerouslySkipPermissions: false,
        canUseTool: parentGuard,
      },
      allowedTools: ['Read', 'mcp__skills__get_skill'],
      allowedServerIds: ['skills'],
      readRoots: [sandboxState.path],
      writeRoots: [],
    });
    setActiveChatTurn({
      sessionId: TEST_SESSION_ID,
      lane: 'desktop',
      turnId: TEST_TURN_ID,
    });
    desktopLane.currentAbortController = new AbortController();

    await startLocalIpcServer();

    const client = new LocalIpcClient({
      lionclawHome: sandboxState.path,
      maxRetries: 2,
      baseBackoffMs: 50,
      maxBackoffMs: 500,
      callTimeoutMs: 5000,
    });

    try {
      const params = {
        agent_id: 'researcher',
        task: 'Explique LangGraph em PT-BR.',
        context: { source: 'chat' },
        expected_output: 'resumo curto',
      };
      const result = await client.callMethod('call_agent', params);

      expect(agentDispatchMock).toHaveBeenCalledWith(
        params,
        expect.objectContaining({
          dispatchContext: expect.objectContaining({
            ownerKind: 'chat',
            ownerId: 'test-chat-session',
            sessionId: 'test-chat-session',
            surface: 'local-ipc',
            workspace: {
              cwd: sandboxState.path,
              readRoots: [sandboxState.path],
              writeRoots: [],
            },
            permission: expect.objectContaining({ canUseTool: parentGuard }),
            capabilityCeiling: expect.objectContaining({
              allowedTools: ['Read', 'mcp__skills__get_skill'],
              allowedMcpServerIds: ['skills'],
            }),
          }),
          transportCorrelation: {
            kind: 'local-ipc-request-id',
            value: expect.any(String),
          },
        }),
      );
      expect(result).toEqual({
        ok: true,
        status: 'completed',
        executionId: 'execution-researcher-1',
        summary: 'agent=researcher status=completed execution=execution-researcher-1',
        output: 'LangGraph e um runtime para workflows com estado em grafo.',
      });
      expect(taskExecutionRollupMock).toHaveBeenCalledWith({ executionId: 'execution-researcher-1' });
    } finally {
      client.close();
    }
  });

  it.each([
    ['telegram', telegramLane],
    ['cron', cronLane],
  ] as const)('mantem call_agent %s text-only com roots/tools/MCP vazios', async (laneName, laneState) => {
    const parentGuard = vi.fn(async () => ({ behavior: 'allow' as const }));
    agentDispatchMock.mockResolvedValueOnce({
      ok: true,
      status: 'completed',
      executionId: `execution-${laneName}`,
      summary: `${laneName} completed`,
      output: 'ok',
    });
    taskExecutionRollupMock.mockReturnValueOnce({
      executionCount: 1,
      executionIds: [`execution-${laneName}`],
      statusCounts: { running: 0, completed: 1, failed: 0, cancelled: 0 },
      metrics: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        apiRequests: 0,
        toolUses: 0,
        durationMs: 0,
      },
      costStatus: 'unknown',
      tokenStatus: 'not_reported',
      costUnknownReasons: ['no-usage-reported'],
    });
    registerChatCapabilityTurn({
      surface: 'chat',
      sessionId: TEST_SESSION_ID,
      turnId: TEST_TURN_ID,
      capabilities: { pipelineControl: false, dynamicWorkflows: false },
      cwd: sandboxState.path,
      permissionProfile: {
        mode: 'default',
        dangerouslySkipPermissions: false,
        canUseTool: parentGuard,
      },
      allowedTools: [],
      allowedServerIds: [],
      readRoots: [],
      writeRoots: [],
    });
    setActiveChatTurn({ sessionId: TEST_SESSION_ID, lane: laneName, turnId: TEST_TURN_ID });
    laneState.currentAbortController = new AbortController();
    await startLocalIpcServer();
    const client = new LocalIpcClient({ lionclawHome: sandboxState.path, callTimeoutMs: 5000 });
    try {
      await client.callMethod('call_agent', { agent_id: 'researcher', task: 'resuma' });
      expect(agentDispatchMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          dispatchContext: expect.objectContaining({
            lane: laneName,
            workspace: { cwd: sandboxState.path, readRoots: [], writeRoots: [] },
            permission: expect.objectContaining({ canUseTool: parentGuard }),
            capabilityCeiling: expect.objectContaining({
              allowedTools: [],
              allowedMcpServerIds: [],
            }),
          }),
        }),
      );
    } finally {
      client.close();
    }
  });

  it('recusa call_agent quando o turno host nao cunhou teto, roots e guard', async () => {
    registerChatCapabilityTurn({
      surface: 'chat',
      sessionId: TEST_SESSION_ID,
      turnId: TEST_TURN_ID,
      capabilities: { pipelineControl: false, dynamicWorkflows: false },
      cwd: sandboxState.path,
      permissionProfile: { mode: 'default', dangerouslySkipPermissions: false },
      allowedServerIds: [],
    });
    setActiveChatTurn({ sessionId: TEST_SESSION_ID, lane: 'desktop', turnId: TEST_TURN_ID });
    desktopLane.currentAbortController = new AbortController();
    await startLocalIpcServer();
    const client = new LocalIpcClient({ lionclawHome: sandboxState.path, callTimeoutMs: 5000 });
    try {
      await expect(client.callMethod('call_agent', {
        agent_id: 'researcher',
        task: 'nao deve executar',
      })).rejects.toThrow(/sem capabilities\/roots\/permission guard/i);
      expect(agentDispatchMock).not.toHaveBeenCalled();
    } finally {
      client.close();
    }
  });

  it('recusa call_agent em conexao anonima mesmo com turno host unico ativo', async () => {
    delete process.env[LIONCLAW_HELPER_TOKEN_ENV];
    registerChatCapabilityTurn({
      surface: 'chat',
      sessionId: TEST_SESSION_ID,
      turnId: TEST_TURN_ID,
      capabilities: { pipelineControl: false, dynamicWorkflows: false },
      cwd: sandboxState.path,
      permissionProfile: {
        mode: 'default',
        dangerouslySkipPermissions: false,
        canUseTool: async () => ({ behavior: 'allow' }),
      },
      allowedTools: [],
      allowedServerIds: [],
      readRoots: [],
      writeRoots: [],
    });
    setActiveChatTurn({ sessionId: TEST_SESSION_ID, lane: 'desktop', turnId: TEST_TURN_ID });
    desktopLane.currentAbortController = new AbortController();
    await startLocalIpcServer();
    const client = new LocalIpcClient({ lionclawHome: sandboxState.path, callTimeoutMs: 5000 });
    try {
      await expect(client.callMethod('call_agent', {
        agent_id: 'researcher',
        task: 'nao deve executar',
      })).rejects.toThrow(/autenticada como lionclaw-agents/i);
      expect(agentDispatchMock).not.toHaveBeenCalled();
    } finally {
      client.close();
    }
  });

  it('liga auth do call_agent ao abort do turno owner', async () => {
    const { CodexAuthError } = await import('../codex-runtime/errors');
    const authError = new CodexAuthError('login Codex necessario');
    const ownerAbort = new AbortController();
    agentDispatchMock.mockImplementationOnce(async (
      _params: unknown,
      deps: { dispatchContext: { abortOwner?: (reason: Error) => void } },
    ) => {
      deps.dispatchContext.abortOwner?.(authError);
      throw authError;
    });
    registerChatCapabilityTurn({
      surface: 'chat',
      sessionId: TEST_SESSION_ID,
      turnId: TEST_TURN_ID,
      capabilities: { pipelineControl: false, dynamicWorkflows: false },
      cwd: sandboxState.path,
      permissionProfile: {
        mode: 'default',
        dangerouslySkipPermissions: false,
        canUseTool: async () => ({ behavior: 'allow' }),
      },
      allowedTools: [],
      allowedServerIds: [],
      readRoots: [],
      writeRoots: [],
    });
    setActiveChatTurn({
      sessionId: TEST_SESSION_ID,
      lane: 'desktop',
      turnId: TEST_TURN_ID,
    });
    desktopLane.currentAbortController = ownerAbort;

    await startLocalIpcServer();
    const client = new LocalIpcClient({
      lionclawHome: sandboxState.path,
      maxRetries: 1,
      baseBackoffMs: 50,
      maxBackoffMs: 200,
      callTimeoutMs: 3000,
    });

    try {
      await expect(client.callMethod('call_agent', {
        agent_id: 'researcher',
        task: 'analise',
      })).rejects.toThrow('login Codex necessario');
      expect(ownerAbort.signal.aborted).toBe(true);
      expect(ownerAbort.signal.reason).toBe(authError);
    } finally {
      client.close();
    }
  });

  it('surfaces JSON-RPC errors as rejected promises', async () => {
    await startLocalIpcServer();

    const client = new LocalIpcClient({
      lionclawHome: sandboxState.path,
      maxRetries: 1,
      baseBackoffMs: 50,
      maxBackoffMs: 200,
      callTimeoutMs: 3000,
    });

    try {
      await expect(
        client.callMethod('load_skill', { skill_name: 'does-not-exist' }),
      ).rejects.toThrow(/Skill not found/);
    } finally {
      client.close();
    }
  });

  it('rejects unknown methods with -32601 Method not found', async () => {
    await startLocalIpcServer();
    const client = new LocalIpcClient({
      lionclawHome: sandboxState.path,
      maxRetries: 1,
      baseBackoffMs: 50,
      maxBackoffMs: 200,
      callTimeoutMs: 3000,
    });

    try {
      await expect(
        client.callMethod('not_a_real_method', {}),
      ).rejects.toThrow(/Method not found/);
    } finally {
      client.close();
    }
  });

  it('throws a descriptive error when the endpoint file is missing', async () => {
    expect(endpointFileExists(sandboxState.path)).toBe(false);
    expect(() => readEndpoint(sandboxState.path)).toThrow(/Failed to read IPC endpoint config/);
  });
});
