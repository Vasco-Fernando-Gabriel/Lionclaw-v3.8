import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  buildSystemPromptMock: vi.fn((_agentId?: string, _opts?: Record<string, unknown>) => ''),
  getMCPConfigForAgentMock: vi.fn(
    async (_agentId?: string, _opts?: Record<string, unknown>) => ({}) as Record<string, unknown>,
  ),
  getActiveChatSessionMock: vi.fn((): { id: string } | null => null),
  selection: {
    runtime: 'claude-sdk',
    provider: 'anthropic',
    model: 'model-a',
    source: 'settings',
  } as Record<string, unknown>,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const iter = (async function* () {})();
    return Object.assign(iter, { toggleMcpServer: vi.fn(async () => undefined) });
  },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

vi.mock('../db', () => ({
  threadIdOf: (s: { id: string; sdkSessionId?: string | null }) => s.sdkSessionId ?? s.id,
  getSessionOrchestrator: () => null,
  getAllAgents: vi.fn(() => [] as unknown[]),
  getAgent: vi.fn(() => undefined),
  insertMessage: vi.fn(() => 1),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(),
  getSetting: vi.fn(() => undefined),
  updateSessionTokens: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
  setSessionAgenticContextTokens: vi.fn(),
  resetSessionAgenticContext: vi.fn(),
  getSessionMessagesAfterFence: vi.fn(() => []),
  getActiveChatSession: () => h.getActiveChatSessionMock(),
  getSession: vi.fn(() => null),
  getEnabledTools: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  insertTaskExecution: vi.fn(),
  getTurnIndexForUserMessage: vi.fn(() => 0),
  getLatestUserTurnIndex: vi.fn(() => 0),
  getHarnessProject: vi.fn(() => null),
  getAllMCPServers: vi.fn(() => []),
  getPermissionBypass: () => false,
  insertRepoGraphTurnUsage: vi.fn(),
  clearSessionPendingSeed: vi.fn(),
}));

vi.mock('../knowledge-state', () => ({ setActiveAgentId: vi.fn() }));
vi.mock('../onboarding', () => ({
  extractAndProcessOnboardingData: vi.fn(() => null),
  completeOnboardingFromUserProfileMessage: vi.fn(() => false),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
  completeOnboardingFromPersistedProfile: vi.fn(() => false),
}));
vi.mock('../pricing', () => ({ calculateCost: () => 0 }));
vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async () => 'fake-api-key'),
  getApiKey: vi.fn(async () => 'fake-api-key'),
}));
vi.mock('../permission-guard', () => ({ createPermissionGuard: () => vi.fn(), GUARD_GATED_TOOLS: [] }));
vi.mock('../activity-log', () => ({
  recordActivity: vi.fn(),
  isWriteTool: vi.fn(() => false),
  deriveToolDetail: vi.fn(() => ''),
}));

vi.mock('../mcp-manager', () => ({
  getMCPConfigForAgent: (...a: unknown[]) => h.getMCPConfigForAgentMock(...(a as [])),
  getMcpToolRegistryEntries: vi.fn(() => []),
}));
vi.mock('../prompt-builder', () => ({
  buildSystemPrompt: (...a: unknown[]) => h.buildSystemPromptMock(...(a as [])),
  loadGeneratedAgentContext: () => '',
}));

vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: vi.fn(async () => ({
    allowedTools: [],
    systemPrompt: '',
    mcpServers: [],
    maxTurns: 0,
  })),
  mergeRepoGraphAllowlist: (tools: string[]) => tools,
  buildRepoGraphMcpSpec: () => ({}),
  REPO_GRAPH_MCP_SERVER_ID: 'repo-graph',
}));
vi.mock('../mcp-discovery', () => ({ getDisabledSDKMcps: () => [], getCachedSDKMcpServers: () => [] }));
vi.mock('../artifact-detector', () => ({
  captureToolUse: vi.fn(),
  captureToolResult: vi.fn(),
  resetArtifactDetector: vi.fn(),
}));
vi.mock('../paths', () => ({
  getAgentCwd: () => '/tmp',
  getBackgroundCwd: () => '/tmp',
  getCronCwd: () => '/tmp',
  getLionClawHome: () => '/tmp',
}));
vi.mock('../codex-agents-mcp', () => ({ getCodexAgentsServer: () => undefined }));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../drive-usage-sink', () => ({
  reportDriveTurnUsage: vi.fn(),
  reportDriveTurnComplete: vi.fn(),
}));
vi.mock('../pipeline-shared/sdk-bootstrap', () => ({
  ensureNodeInPath: vi.fn(),
  getClaudeCodeExecutablePath: () => '/tmp/claude-cli.js',
  getClaudeSdkProcessOptions: () => ({
    pathToClaudeCodeExecutable: '/tmp/claude-cli.js',
    executable: 'node',
  }),
}));
vi.mock('../title-generator', () => ({ ensureInitialSessionTitle: vi.fn(), generateSessionTitle: vi.fn() }));
vi.mock('../repo-graph/turn-context', () => ({
  getRepoGraphTurnContext: vi.fn(() => null),
  setRepoGraphTurnSession: vi.fn(),
  clearRepoGraphTurnSession: vi.fn(),
  setRepoGraphTurnContext: vi.fn(),
}));
vi.mock('../prompt-builder-repo-graph', () => ({
  appendRepoGraphSection: (p: string) => p,
  buildRepoGraphSection: () => '',
  buildRepoGraphSubagentSection: () => '',
  summarizeRepoGraphStats: () => '',
}));
vi.mock('../sdk-session-id', () => ({
  makeScopedSdkSessionId: (scope: string, sessionId: string) => `${scope}:${sessionId}`,
}));

vi.mock('../orchestrator-selection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestrator-selection')>();
  return {
    ...actual,
    resolveOrchestratorSelection: vi.fn(async () => h.selection),
  };
});

vi.mock('../codex-sdk', () => ({
  executeCodexSdkQuery: vi.fn(async () => undefined),
  isCodexSdkQueryActive: vi.fn(() => false),
  resetCodexSdkSessionState: vi.fn(),
  stopCodexSdkQuery: vi.fn(),
}));
vi.mock('../kimi-sdk', () => ({
  executeKimiSdkQuery: vi.fn(async () => undefined),
  isKimiSdkQueryActive: vi.fn(() => false),
  resetKimiSdkSessionState: vi.fn(),
  stopKimiSdkQuery: vi.fn(),
}));
vi.mock('../lion-sdk', () => ({
  executeLionSdkQuery: vi.fn(async () => undefined),
  isLionSdkQueryActive: vi.fn(() => false),
  resetLionSdkSessionState: vi.fn(),
  stopLionSdkQuery: vi.fn(),
}));

import { executeQuery, type QueryOptions } from '../orchestrator';
import { telegramLane } from '../sdk-lane';
import { getDesktopLane } from '../desktop-lanes';

const desktopLane = getDesktopLane('sess-wiring');
import {
  computeEffectiveCapabilitiesForTurn,
  __resetChatCapabilityContextForTests,
  type ChatCapabilityTurnContext,
} from '../chat-capability-context';
import type { ChatFeatureToggles } from '../../../src/types';

const noopGetWindow = () => null;

const CLAUDE_SELECTION = {
  runtime: 'claude-sdk',
  provider: 'anthropic',
  model: 'model-a',
  source: 'settings',
};
const COMPAT_SELECTION = {
  runtime: 'claude-compat-sdk',
  provider: 'zai',
  model: 'glm-4.7',
  source: 'settings',
  apiKey: 'fake-api-key',
};

function useSelection(sel: Record<string, unknown>): void {
  h.selection = sel;
}

function options(overrides: Partial<QueryOptions> = {}): QueryOptions {
  return { sessionId: 'sess-wiring', silent: true, ...overrides };
}

function promptCapabilities(): unknown {
  expect(h.buildSystemPromptMock).toHaveBeenCalledTimes(1);
  const opts = h.buildSystemPromptMock.mock.calls[0][1] as Record<string, unknown>;
  return opts.capabilities;
}

function mcpConfigOpts(): { surface: unknown; capabilities: unknown } {
  const wiringCalls = h.getMCPConfigForAgentMock.mock.calls.filter(
    (c) => (c[1] as Record<string, unknown> | undefined)?.fullCatalog !== true,
  );
  expect(wiringCalls).toHaveLength(1);
  const opts = wiringCalls[0][1] as Record<string, unknown>;
  return { surface: opts.surface, capabilities: opts.capabilities };
}

const OFF: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: false };
const ON: ChatFeatureToggles = { pipelineControl: true, dynamicWorkflows: true };
const MIXED: ChatFeatureToggles = { pipelineControl: true, dynamicWorkflows: false };
const EFFECTIVE_OFF = { ...OFF, swarm: false };
const EFFECTIVE_ON = { ...ON, swarm: false };
const EFFECTIVE_MIXED = { ...MIXED, swarm: false };

beforeEach(() => {
  vi.clearAllMocks();
  __resetChatCapabilityContextForTests();
  h.getActiveChatSessionMock.mockReturnValue(null);
  h.buildSystemPromptMock.mockReturnValue('');
  h.getMCPConfigForAgentMock.mockResolvedValue({});
  useSelection(CLAUDE_SELECTION);
});

describe('S5b: wiring claude-sdk (executeClaudeSdkQuery le o turn-context da lane desktop)', () => {
  it('turno desktop com toggles OFF -> buildSystemPrompt E getMCPConfigForAgent recebem OFF', async () => {
    await executeQuery('oi', options({ featureToggles: { ...OFF } }), noopGetWindow, desktopLane);

    expect(promptCapabilities()).toEqual(EFFECTIVE_OFF);
    expect(mcpConfigOpts()).toEqual({ surface: 'claude-sdk', capabilities: EFFECTIVE_OFF });
  });

  it('turno desktop com toggles ON -> os 2 calls recebem ON (secao completa + helper presente)', async () => {
    await executeQuery('oi', options({ featureToggles: { ...ON } }), noopGetWindow, desktopLane);

    expect(promptCapabilities()).toEqual(EFFECTIVE_ON);
    expect(mcpConfigOpts()).toEqual({ surface: 'claude-sdk', capabilities: EFFECTIVE_ON });
  });

  it('toggles mistos passam intactos (pipeline ON, workflows OFF)', async () => {
    await executeQuery('oi', options({ featureToggles: { ...MIXED } }), noopGetWindow, desktopLane);

    expect(promptCapabilities()).toEqual(EFFECTIVE_MIXED);
    expect(mcpConfigOpts()).toEqual({ surface: 'claude-sdk', capabilities: EFFECTIVE_MIXED });
  });

  it('sem featureToggles nas options: hook S3a registra default OFF (A.4) e o wiring o entrega', async () => {
    await executeQuery('oi', options(), noopGetWindow, desktopLane);

    expect(promptCapabilities()).toEqual(EFFECTIVE_OFF);
    expect(mcpConfigOpts()).toEqual({ surface: 'claude-sdk', capabilities: EFFECTIVE_OFF });
  });

  it('desktop SEM sessionId (lanes 5.3, RM7): session_required tipado, nada composto', async () => {
    await expect(
      executeQuery('oi', { silent: true, featureToggles: { ...ON } }, noopGetWindow, desktopLane),
    ).rejects.toThrow(/session_required/);

    expect(h.buildSystemPromptMock).not.toHaveBeenCalled();
    expect(h.getMCPConfigForAgentMock).not.toHaveBeenCalled();
  });

  it('lane telegram (nao-desktop, A.9): capabilities undefined mesmo com toggles ON no turno', async () => {
    await executeQuery(
      'oi tg',
      options({ sessionId: 'sess-tg', featureToggles: { ...ON } }),
      noopGetWindow,
      telegramLane,
    );

    expect(promptCapabilities()).toBeUndefined();
    expect(mcpConfigOpts()).toEqual({ surface: 'claude-sdk', capabilities: undefined });
  });
});

describe('S5b: wiring claude-compat-sdk (executor real, espelho do claude-sdk)', () => {
  beforeEach(() => {
    useSelection(COMPAT_SELECTION);
  });

  it('turno desktop com toggles OFF -> os 2 calls recebem OFF (surface claude-compat-sdk)', async () => {
    await executeQuery('oi', options({ featureToggles: { ...OFF } }), noopGetWindow, desktopLane);

    expect(promptCapabilities()).toEqual(EFFECTIVE_OFF);
    expect(mcpConfigOpts()).toEqual({ surface: 'claude-compat-sdk', capabilities: EFFECTIVE_OFF });
  });

  it('turno desktop com toggles ON -> os 2 calls recebem ON', async () => {
    await executeQuery('oi', options({ featureToggles: { ...ON } }), noopGetWindow, desktopLane);

    expect(promptCapabilities()).toEqual(EFFECTIVE_ON);
    expect(mcpConfigOpts()).toEqual({ surface: 'claude-compat-sdk', capabilities: EFFECTIVE_ON });
  });

  it('lane telegram: capabilities undefined (byte-identico) mesmo com toggles ON', async () => {
    await executeQuery(
      'oi tg',
      options({ sessionId: 'sess-tg-compat', featureToggles: { ...ON } }),
      noopGetWindow,
      telegramLane,
    );

    expect(promptCapabilities()).toBeUndefined();
    expect(mcpConfigOpts()).toEqual({ surface: 'claude-compat-sdk', capabilities: undefined });
  });
});

describe('computeEffectiveCapabilitiesForTurn (helper compartilhado, 0.5.2)', () => {
  function ctx(overrides: Partial<ChatCapabilityTurnContext> = {}): ChatCapabilityTurnContext {
    return {
      surface: 'chat',
      sessionId: 's',
      turnId: 't',
      origin: 'user',
      capabilities: { ...MIXED },
      createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
      ...overrides,
    };
  }

  it('turno user: efetivas = toggles do turno (identidade)', () => {
    expect(computeEffectiveCapabilitiesForTurn(ctx())).toEqual(EFFECTIVE_MIXED);
  });

  it('turno system-event com token que NAO e lease valida: efetivas = toggles (fail-closed do deriveLease, S6a)', () => {
    const effective = computeEffectiveCapabilitiesForTurn(
      ctx({
        origin: 'system-event',
        internalLeaseToken: 'token-opaco',
        driveProjectId: 'proj-1',
        driveTurnId: 'drive-turn-1',
        capabilities: { ...OFF },
      }),
    );
    expect(effective).toEqual(EFFECTIVE_OFF);
  });

  it('puro: retorna objeto NOVO (mutar o retorno nao envenena o turn-context)', () => {
    const turnCtx = ctx();
    const effective = computeEffectiveCapabilitiesForTurn(turnCtx);
    effective.pipelineControl = !effective.pipelineControl;
    expect(turnCtx.capabilities).toEqual(MIXED);
  });
});
