import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const getActiveChatSessionMock = vi.fn((): { id: string } | null => null);

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
  getActiveChatSession: () => getActiveChatSessionMock(),
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
  resolveOnboardingCompletedFromState: vi.fn(() => false),
  completeOnboardingFromPersistedProfile: vi.fn(() => false),
}));
vi.mock('../pricing', () => ({ calculateCost: () => 0 }));

const getApiKey = vi.fn(async () => null as string | null);
vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async () => 'fake-api-key'),
  getApiKey: () => getApiKey(),
}));

vi.mock('../permission-guard', () => ({ createPermissionGuard: () => vi.fn(), GUARD_GATED_TOOLS: [] }));
vi.mock('../mcp-manager', () => ({ getMCPConfigForAgent: vi.fn(async () => ({})) }));
vi.mock('../agent-config-resolver', () => ({
  resolveAgentQueryConfig: vi.fn(async () => ({ allowedTools: [], systemPrompt: '', mcpServers: [], maxTurns: 0 })),
}));
vi.mock('../mcp-discovery', () => ({ getDisabledSDKMcps: () => [], getCachedSDKMcpServers: () => [] }));
vi.mock('../artifact-detector', () => ({
  captureToolUse: vi.fn(),
  captureToolResult: vi.fn(),
  resetArtifactDetector: vi.fn(),
}));
vi.mock('../prompt-builder', () => ({ buildSystemPrompt: () => '', loadGeneratedAgentContext: () => '' }));
vi.mock('../paths', () => ({
  getAgentCwd: () => '/tmp',
  getBackgroundCwd: () => '/tmp',
  getCronCwd: () => '/tmp',
  getLionClawHome: () => '/tmp',
}));
vi.mock('../codex-agents-mcp', () => ({ getCodexAgentsServer: () => undefined }));
vi.mock('../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
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

import type { OrchestratorSelection } from '../orchestrator-selection';
const COMPAT_SELECTION: OrchestratorSelection = {
  runtime: 'claude-compat-sdk',
  provider: 'zai',
  model: 'model-b',
  source: 'settings',
};
vi.mock('../orchestrator-selection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestrator-selection')>();
  return {
    ...actual,
    resolveOrchestratorSelection: vi.fn(async () => COMPAT_SELECTION),
  };
});

const compatExec = vi.fn(async () => undefined);
vi.mock('../claude-compat-sdk', () => ({
  executeClaudeCompatSdkQuery: (...a: unknown[]) => compatExec(...(a as [])),
  isClaudeCompatQueryActive: vi.fn(() => false),
  resetClaudeCompatSdkSessionState: vi.fn(),
  stopClaudeCompatQuery: vi.fn(),
  buildCompatEnv: vi.fn(() => ({})),
}));
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
import { telegramLane, cronLane } from '../sdk-lane';
import { getDesktopLane } from '../desktop-lanes';

const desktopLane = getDesktopLane('sess-int');
import {
  getActiveChatTurnByLane,
  listActiveDesktopTurns,
  getChatCapabilityTurn,
  __resetChatCapabilityContextForTests,
  type ChatCapabilityTurnContext,
} from '../chat-capability-context';

const noopGetWindow = () => null;

interface CapturedTurnState {
  laneTurn: { sessionId: string; turnId: string } | undefined;
  ctx: ChatCapabilityTurnContext | undefined;
}

let captured: CapturedTurnState | undefined;

function captureLane(lane: 'desktop' | 'telegram' | 'cron'): void {
  compatExec.mockImplementation(async () => {
    const laneTurn = lane === 'desktop' ? listActiveDesktopTurns()[0] : getActiveChatTurnByLane(lane);
    captured = {
      laneTurn,
      ctx: laneTurn !== undefined ? getChatCapabilityTurn(laneTurn) : undefined,
    };
  });
}

function options(overrides: Partial<QueryOptions> = {}): QueryOptions {
  return { sessionId: 'sess-int', silent: true, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetChatCapabilityContextForTests();
  captured = undefined;
  getActiveChatSessionMock.mockReturnValue(null);
  captureLane('desktop');
});

describe('S3a: identidade do turno viva DURANTE o despacho, limpa no finally', () => {
  it('cunha turnId canonico + registra turn-context + marca turno ativo da lane desktop', async () => {
    await executeQuery(
      'turno',
      options({ featureToggles: { pipelineControl: true, dynamicWorkflows: false } }),
      noopGetWindow,
      desktopLane,
    );

    expect(compatExec).toHaveBeenCalledTimes(1);
    expect(captured?.laneTurn?.sessionId).toBe('sess-int');
    expect(captured?.laneTurn?.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(captured?.ctx).toBeDefined();
    expect(captured?.ctx?.surface).toBe('chat');
    expect(captured?.ctx?.origin).toBe('user');
    expect(captured?.ctx?.capabilities).toEqual({
      pipelineControl: true,
      dynamicWorkflows: false,
    });
    expect(captured?.ctx?.cwd).toBe('/tmp');
    expect(captured?.ctx?.permissionProfile).toEqual({
      mode: 'default',
      dangerouslySkipPermissions: false,
      canUseTool: expect.any(Function),
    });
    expect(captured?.ctx?.allowedTools).toEqual([]);
    expect(captured?.ctx?.allowedServerIds).toEqual([]);
    expect(captured?.ctx?.readRoots).toEqual(['/tmp']);
    expect(captured?.ctx?.writeRoots).toEqual([]);

    expect(listActiveDesktopTurns()).toEqual([]);
    expect(
      getChatCapabilityTurn({
        sessionId: 'sess-int',
        turnId: captured!.laneTurn!.turnId,
      }),
    ).toBeUndefined();
  });

  it('sem featureToggles nas options: capabilities = default OFF (A.4)', async () => {
    await executeQuery('turno', options(), noopGetWindow, desktopLane);
    expect(captured?.ctx?.capabilities).toEqual({
      pipelineControl: false,
      dynamicWorkflows: false,
      swarm: false,
    });
  });

  it('turno system-event: lease/drive IDs (+ coordinator/capability, S6a) viajam no VALOR do turn-context (0.5.1)', async () => {
    await executeQuery(
      'turno de drive',
      options({
        origin: 'system-event',
        internalLeaseToken: 'token-opaco',
        driveProjectId: 'proj-42',
        driveTurnId: 'drive-turn-7',
        leaseCoordinator: 'pipeline-drive-coordinator',
        leaseCapability: 'pipelineControl',
      }),
      noopGetWindow,
      desktopLane,
    );

    expect(captured?.ctx?.origin).toBe('system-event');
    expect(captured?.ctx?.internalLeaseToken).toBe('token-opaco');
    expect(captured?.ctx?.driveProjectId).toBe('proj-42');
    expect(captured?.ctx?.driveTurnId).toBe('drive-turn-7');
    expect(captured?.ctx?.leaseCoordinator).toBe('pipeline-drive-coordinator');
    expect(captured?.ctx?.leaseCapability).toBe('pipelineControl');
  });

  it('turno user NAO carrega lease/drive IDs mesmo se presentes nas options', async () => {
    await executeQuery(
      'turno',
      options({
        internalLeaseToken: 'nao-deveria-viajar',
        driveProjectId: 'p',
        driveTurnId: 't',
        leaseCoordinator: 'pipeline-drive-coordinator',
        leaseCapability: 'pipelineControl',
      }),
      noopGetWindow,
      desktopLane,
    );
    expect(captured?.ctx?.origin).toBe('user');
    expect(captured?.ctx?.internalLeaseToken).toBeUndefined();
    expect(captured?.ctx?.driveProjectId).toBeUndefined();
    expect(captured?.ctx?.driveTurnId).toBeUndefined();
    expect(captured?.ctx?.leaseCoordinator).toBeUndefined();
    expect(captured?.ctx?.leaseCapability).toBeUndefined();
  });

  it('cada turno cunha um turnId NOVO', async () => {
    const turnIds: string[] = [];
    compatExec.mockImplementation(async () => {
      turnIds.push(listActiveDesktopTurns()[0]!.turnId);
    });

    await executeQuery('turno 1', options(), noopGetWindow, desktopLane);
    await executeQuery('turno 2', options(), noopGetWindow, desktopLane);

    expect(turnIds).toHaveLength(2);
    expect(turnIds[0]).not.toBe(turnIds[1]);
  });

  it('clear roda no finally mesmo quando o executor LANCA', async () => {
    compatExec.mockRejectedValueOnce(new Error('boom do executor'));

    await expect(executeQuery('turno', options(), noopGetWindow, desktopLane)).rejects.toThrow('boom do executor');

    expect(listActiveDesktopTurns()).toEqual([]);
  });

  it('sem sessionId (RM7): executeQuery recusa session_required antes de despachar e nada e registrado', async () => {
    await expect(executeQuery('turno', { silent: true }, noopGetWindow, desktopLane)).rejects.toThrow(
      /session_required/,
    );

    expect(compatExec).not.toHaveBeenCalled();
    expect(captured?.laneTurn).toBeUndefined();
    expect(captured?.ctx).toBeUndefined();
  });

  it('sem options.sessionId no desktop: NUNCA cai na heuristica global (RM2), nada registrado', async () => {
    getActiveChatSessionMock.mockReturnValue({ id: 'sess-ativa' });

    await expect(executeQuery('turno', { silent: true }, noopGetWindow, desktopLane)).rejects.toThrow(
      /session_required/,
    );

    expect(getActiveChatSessionMock).not.toHaveBeenCalled();
    expect(captured?.laneTurn).toBeUndefined();
    expect(captured?.ctx).toBeUndefined();
    expect(listActiveDesktopTurns()).toEqual([]);
  });

  it('lane telegram registra sob a lane telegram (chave por lane, 0.7 item 1)', async () => {
    captureLane('telegram');

    await executeQuery('turno tg', options({ sessionId: 'sess-tg' }), noopGetWindow, telegramLane);

    expect(captured?.laneTurn?.sessionId).toBe('sess-tg');
    expect(captured?.ctx).toBeDefined();
    expect(getActiveChatTurnByLane('telegram')).toBeUndefined();
  });
});

describe('A.16: telegram/cron false/false sem herdar desktop', () => {
  it('telegram sem featureToggles -> capabilities default OFF', async () => {
    captureLane('telegram');
    await executeQuery('tg', options({ sessionId: 'sess-tg' }), noopGetWindow, telegramLane);
    expect(captured?.ctx?.capabilities).toEqual({
      pipelineControl: false,
      dynamicWorkflows: false,
      swarm: false,
    });
    expect(captured?.ctx?.origin).toBe('user');
  });

  it('cron sem featureToggles -> capabilities default OFF', async () => {
    captureLane('cron');
    await executeQuery('cron', options({ sessionId: 'sess-cron' }), noopGetWindow, cronLane);
    expect(captured?.ctx?.capabilities).toEqual({
      pipelineControl: false,
      dynamicWorkflows: false,
      swarm: false,
    });
  });

  it('turno desktop ON antes NAO contamina o turno telegram seguinte (sem heranca)', async () => {
    captureLane('desktop');
    await executeQuery(
      'desktop on',
      options({ sessionId: 'sess-desk', featureToggles: { pipelineControl: true, dynamicWorkflows: true } }),
      noopGetWindow,
      desktopLane,
    );
    expect(captured?.ctx?.capabilities).toEqual({
      pipelineControl: true,
      dynamicWorkflows: true,
    });

    captureLane('telegram');
    await executeQuery('tg depois', options({ sessionId: 'sess-tg' }), noopGetWindow, telegramLane);
    expect(captured?.ctx?.capabilities).toEqual({
      pipelineControl: false,
      dynamicWorkflows: false,
      swarm: false,
    });

    captureLane('cron');
    await executeQuery('cron depois', options({ sessionId: 'sess-cron' }), noopGetWindow, cronLane);
    expect(captured?.ctx?.capabilities).toEqual({
      pipelineControl: false,
      dynamicWorkflows: false,
      swarm: false,
    });
  });
});
