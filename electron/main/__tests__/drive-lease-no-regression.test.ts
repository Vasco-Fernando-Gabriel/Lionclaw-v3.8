
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DriveState } from '../../../src/types';


const h = vi.hoisted(() => ({
  buildSystemPromptMock: vi.fn((_agentId?: string, _opts?: Record<string, unknown>) => ''),
  getMCPConfigForAgentMock: vi.fn(
    async (_agentId?: string, _opts?: Record<string, unknown>) => ({}) as Record<string, unknown>,
  ),
  getSettingMock: vi.fn((_key: string): string | undefined => undefined),
}));


vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
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

interface FakeProject {
  id: string;
  name: string;
  pipelineType?: string;
  status: string;
  pipelineCurrentPhase?: number | null;
  pipelineStartPhase?: number | null;
  config: { drive?: DriveState };
}

const projects = new Map<string, FakeProject>();

function fakeSetDriveState(projectId: string, patch: Partial<DriveState>): DriveState {
  const project = projects.get(projectId);
  if (!project) throw new Error(`setDriveState: project not found: ${projectId}`);
  const existing = project.config.drive;
  const merged: DriveState = {
    driver: patch.driver ?? existing?.driver ?? 'orchestrator',
    status: patch.status ?? existing?.status ?? 'driving',
    handoff: patch.handoff ?? existing?.handoff ?? 'none',
    mode: patch.mode ?? existing?.mode ?? 'semi',
    sessionId: patch.sessionId !== undefined ? patch.sessionId : existing?.sessionId,
    requiresHumanPhases: patch.requiresHumanPhases ?? existing?.requiresHumanPhases ?? [],
  };
  project.config.drive = merged;
  return merged;
}

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => [] as unknown[]),
  getAgent: vi.fn(() => undefined),
  insertMessage: vi.fn(() => 1),
  insertAuditEntry: vi.fn(),
  createSession: vi.fn(),
  getSetting: (key: string) => h.getSettingMock(key),
  updateSessionTokens: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getSession: vi.fn(() => null),
  getEnabledTools: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  insertTaskExecution: vi.fn(),
  getTurnIndexForUserMessage: vi.fn(() => 0),
  getLatestUserTurnIndex: vi.fn(() => 0),
  getHarnessProject: vi.fn((id: string) => projects.get(id)),
  getAllMCPServers: vi.fn(() => []),
  getPermissionBypass: () => false,
  insertRepoGraphTurnUsage: vi.fn(),
  clearSessionPendingSeed: vi.fn(),
  listHarnessProjects: vi.fn(() => [...projects.values()]),
  getDriveState: vi.fn((id: string) => projects.get(id)?.config.drive ?? null),
  setDriveState: vi.fn((id: string, patch: Partial<DriveState>) => fakeSetDriveState(id, patch)),
  getDynamicWorkflowRun: vi.fn(() => null),
  getDynamicWorkflowDefinition: vi.fn(() => null),
  listDynamicWorkflowRunsByStatus: vi.fn(() => []),
  updateDynamicWorkflowRun: vi.fn(),
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
    resolveOrchestratorSelection: vi.fn(async () => ({
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'model-a',
      source: 'settings',
    })),
  };
});

vi.mock('../claude-compat-sdk', () => ({
  executeClaudeCompatSdkQuery: vi.fn(async () => undefined),
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

vi.mock('../chat-push', () => ({
  pushAssistantMessage: vi.fn(() => 1),
  pushDrivePaused: vi.fn(),
}));
vi.mock('../telegram-bridge', () => ({
  notifyDriveHandoff: vi.fn(async () => {}),
}));
vi.mock('../pipeline-control-core', async () => {
  const actual = await vi.importActual<typeof import('../pipeline-control-core')>(
    '../pipeline-control-core',
  );
  return {
    ...actual,
    resolvePendingQuestion: vi.fn(() => null),
  };
});


import { submitMessage, type QueryOptions } from '../orchestrator';
import { messageQueue } from '../message-queue';
import { PipelineDriveCoordinator } from '../pipeline-drive-coordinator';
import {
  scanBlockedRunsForIgnition,
  _resetIgnitionForTesting,
  type WorkflowIgnitionDeps,
} from '../dynamic-workflows/workflow-ignition';
import { _resetDriveLockForTesting } from '../drive-lock';
import {
  getActiveChatTurnByLane,
  getChatCapabilityTurn,
  computeEffectiveCapabilitiesForTurn,
  CHAT_TURN_CONTEXT_TTL_SETTING_KEY,
  __resetChatCapabilityContextForTests,
  type ChatCapabilityTurnContext,
} from '../chat-capability-context';
import { __resetInternalCapabilityLeasesForTests } from '../chat-capability-lease';
import {
  assertChatCapability,
  CHAT_CAPABILITY_GATE_MODE_SETTING_KEY,
  type ChatCapabilityGateResult,
} from '../chat-capability-gate';
import type {
  DynamicWorkflowRun,
  DynamicWorkflowDefinition,
} from '../../../src/types/dynamic-workflow';
import type { ChatFeatureToggles } from '../../../src/types';

const OFF: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: false };


interface TurnCapture {
  ctx: ChatCapabilityTurnContext | undefined;
  effective: ChatFeatureToggles | undefined;
  gateChatPipeline: ChatCapabilityGateResult;
  gateChatWorkflow: ChatCapabilityGateResult;
  gateSystemEventPipeline: ChatCapabilityGateResult;
  gateSystemEventWorkflow: ChatCapabilityGateResult;
}

let captured: TurnCapture | undefined;

function armCapture(): void {
  captured = undefined;
  h.getMCPConfigForAgentMock.mockImplementation(async () => {
    const active = getActiveChatTurnByLane('desktop');
    const ctx = active ? getChatCapabilityTurn(active) : undefined;
    captured = {
      ctx,
      effective: ctx ? computeEffectiveCapabilitiesForTurn(ctx) : undefined,
      gateChatPipeline: assertChatCapability({
        serverId: 'lionclaw-pipeline-control',
        toolName: 'pipeline_reply',
        context: { surface: 'chat' },
      }),
      gateChatWorkflow: assertChatCapability({
        serverId: 'lionclaw-dynamic-workflows',
        toolName: 'dynamic_workflow_inspect',
        context: { surface: 'chat' },
      }),
      gateSystemEventPipeline: assertChatCapability({
        serverId: 'lionclaw-pipeline-control',
        toolName: 'pipeline_approve',
        context: { surface: 'system-event' },
      }),
      gateSystemEventWorkflow: assertChatCapability({
        serverId: 'lionclaw-dynamic-workflows',
        toolName: 'dynamic_workflow_approve_gate',
        context: { surface: 'system-event' },
      }),
    };
    return {};
  });
}

function promptCapabilities(): unknown {
  expect(h.buildSystemPromptMock).toHaveBeenCalledTimes(1);
  const opts = h.buildSystemPromptMock.mock.calls[0][1] as Record<string, unknown>;
  return opts.capabilities;
}

function mcpCapabilities(): unknown {
  const wiringCalls = h.getMCPConfigForAgentMock.mock.calls.filter(
    (c) => (c[1] as Record<string, unknown> | undefined)?.fullCatalog !== true,
  );
  expect(wiringCalls).toHaveLength(1);
  const opts = wiringCalls[0][1] as Record<string, unknown>;
  return opts.capabilities;
}

async function waitTurnDone(): Promise<void> {
  await vi.waitFor(() => {
    expect(h.buildSystemPromptMock).toHaveBeenCalled();
  });
  await vi.waitFor(() => {
    expect(messageQueue.isProcessing).toBe(false);
  });
}


function seedProject(over: Partial<FakeProject> = {}): FakeProject {
  const p: FakeProject = {
    id: over.id ?? 'proj_a',
    name: over.name ?? 'Demo',
    pipelineType: over.pipelineType ?? 'development',
    status: over.status ?? 'running',
    pipelineCurrentPhase: over.pipelineCurrentPhase ?? 2, // fase AUTO (PRD Generator)
    pipelineStartPhase: over.pipelineStartPhase ?? 1,
    config: over.config ?? {},
  };
  projects.set(p.id, p);
  return p;
}

const WF_RUN_ID = '20260703_120000-abc123';

function makeRun(patch?: Partial<DynamicWorkflowRun>): DynamicWorkflowRun {
  return {
    id: WF_RUN_ID,
    definitionId: 'def-1',
    chatSessionId: 'sess-wf',
    status: 'blocked',
    currentPhaseId: 'implement',
    currentNodeId: 'coder',
    workspaceMode: 'run-worktree',
    baseBranch: 'main',
    baseCommitSha: 'abc',
    baseWorktreeHash: null,
    worktreePath: '/tmp/wt',
    worktreeBranch: `dynworkflow/${WF_RUN_ID}`,
    deliveredAt: null,
    finalizedAt: null,
    closerSessionId: null,
    closerStatus: null,
    inputJson: JSON.stringify({ pendingDecision: { type: 'gate', id: 'gate-plan-review' } }),
    outputJson: null,
    checkpointJson: '{}',
    error: null,
    totalCostUsd: 0,
    totalDurationMs: 0,
    createdBy: 'human',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:10.000Z',
    ...patch,
  } as DynamicWorkflowRun;
}

function makeIgnitionDeps(run: DynamicWorkflowRun): WorkflowIgnitionDeps {
  const definition = {
    id: 'def-1',
    manifestJson: JSON.stringify({
      gates: [{ id: 'gate-plan-review', mode: 'orchestrator' }],
    }),
  } as unknown as DynamicWorkflowDefinition;
  return {
    getRun: () => run,
    getDefinition: () => definition,
    listBlockedRuns: () => [run],
    createDedicatedSession: vi.fn(() => 'sess-dedicada'),
    linkSession: vi.fn(),
    submit: submitMessage,
    getWindow: () => null,
    mintCapability: vi.fn(),
  };
}

let coordinators: PipelineDriveCoordinator[] = [];

function makeCoordinator(): PipelineDriveCoordinator {
  const coord = new PipelineDriveCoordinator(() => null);
  coordinators.push(coord);
  return coord;
}

const noopGetWindow = () => null;

beforeEach(() => {
  vi.clearAllMocks();
  projects.clear();
  messageQueue.clear();
  __resetChatCapabilityContextForTests();
  __resetInternalCapabilityLeasesForTests();
  _resetIgnitionForTesting();
  _resetDriveLockForTesting();
  coordinators = [];
  h.getSettingMock.mockImplementation((key: string) =>
    key === CHAT_CAPABILITY_GATE_MODE_SETTING_KEY ? 'enforce' : undefined,
  );
  h.buildSystemPromptMock.mockReturnValue('');
  armCapture();
});

afterEach(() => {
  for (const coord of coordinators) {
    for (const id of projects.keys()) {
      try {
        coord.stopDrive(id);
      } catch {
      }
    }
  }
  messageQueue.clear();
});


describe('AC-A22 (a): turno de drive de pipeline com sessao OFF/OFF sobrevive via lease', () => {
  it('fireOrchestratorTurn cria a lease; turn-context system-event carrega token+coordinator+capability; prompt+composicao recebem pipelineControl ON; gate ENFORCE passa', async () => {
    seedProject();
    const coord = makeCoordinator();

    const res = coord.startDrive('proj_a', 'sess-drive', 'semi');
    expect(res.ok).toBe(true);

    await waitTurnDone();

    expect(captured?.ctx).toBeDefined();
    const ctx = captured!.ctx!;
    expect(ctx.origin).toBe('system-event');
    expect(ctx.sessionId).toBe('sess-drive');
    expect(ctx.driveProjectId).toBe('proj_a');
    expect(typeof ctx.driveTurnId).toBe('string');
    expect(ctx.driveTurnId!.length).toBeGreaterThan(0);
    expect(typeof ctx.internalLeaseToken).toBe('string');
    expect(ctx.internalLeaseToken!.length).toBeGreaterThan(0);
    expect(ctx.leaseCoordinator).toBe('pipeline-drive-coordinator');
    expect(ctx.leaseCapability).toBe('pipelineControl');
    expect(ctx.capabilities).toEqual(OFF);

    expect(captured?.effective).toEqual({ pipelineControl: true, dynamicWorkflows: false });

    expect(promptCapabilities()).toEqual({ pipelineControl: true, dynamicWorkflows: false });
    expect(mcpCapabilities()).toEqual({ pipelineControl: true, dynamicWorkflows: false });

    expect(captured?.gateChatPipeline).toEqual({ ok: true });
    expect(captured?.gateSystemEventPipeline).toEqual({ ok: true });
    expect(captured?.gateChatWorkflow.ok).toBe(false);
    expect(captured?.gateSystemEventWorkflow.ok).toBe(false);
  });
});


describe('AC-A22 (b): wake de workflow blocked com sessao OFF/OFF sobrevive via lease dynamic-workflow-ignition', () => {
  it('fireIgnition (boot re-ignition, mesmo seam do wake por gate-blocked) cria a lease; dynamicWorkflows forcado ON; pipelineControl continua OFF; gate ENFORCE passa', async () => {
    const deps = makeIgnitionDeps(makeRun());

    const reignited = scanBlockedRunsForIgnition(deps);
    expect(reignited).toBe(1);

    await waitTurnDone();

    expect(captured?.ctx).toBeDefined();
    const ctx = captured!.ctx!;
    expect(ctx.origin).toBe('system-event');
    expect(ctx.sessionId).toBe('sess-wf');
    expect(ctx.driveProjectId).toBe(WF_RUN_ID);
    expect(typeof ctx.internalLeaseToken).toBe('string');
    expect(ctx.leaseCoordinator).toBe('dynamic-workflow-ignition');
    expect(ctx.leaseCapability).toBe('dynamicWorkflows');
    expect(ctx.capabilities).toEqual(OFF);

    expect(captured?.effective).toEqual({ pipelineControl: false, dynamicWorkflows: true });
    expect(promptCapabilities()).toEqual({ pipelineControl: false, dynamicWorkflows: true });
    expect(mcpCapabilities()).toEqual({ pipelineControl: false, dynamicWorkflows: true });

    expect(captured?.gateChatWorkflow).toEqual({ ok: true });
    expect(captured?.gateSystemEventWorkflow).toEqual({ ok: true });
    expect(captured?.gateChatPipeline.ok).toBe(false);
    expect(captured?.gateSystemEventPipeline.ok).toBe(false);
  });
});


describe('AC-A22 (c): system-event sem lease valida NAO forca capability (fail-closed)', () => {
  it('token FORJADO (nao emitido pelo create): efetivas ficam OFF e o gate em enforce NEGA', async () => {
    submitMessage(
      'turno system-event forjado',
      {
        sessionId: 'sess-spoof',
        origin: 'system-event',
        driveProjectId: 'proj_x',
        driveTurnId: 'proj_x:1',
        internalLeaseToken: 'token-forjado-fora-do-registro',
        leaseCoordinator: 'pipeline-drive-coordinator',
        leaseCapability: 'pipelineControl',
      } as QueryOptions,
      noopGetWindow,
    );

    await waitTurnDone();

    expect(captured?.ctx?.origin).toBe('system-event');
    expect(captured?.effective).toEqual(OFF);
    expect(promptCapabilities()).toEqual(OFF);
    expect(mcpCapabilities()).toEqual(OFF);
    expect(captured?.gateChatPipeline.ok).toBe(false);
    expect(captured?.gateSystemEventPipeline.ok).toBe(false);
    if (captured!.gateSystemEventPipeline.ok === false) {
      expect(captured!.gateSystemEventPipeline.code).toBe('chat_capability_lease_invalid');
    }
  });

  it('token AUSENTE em turno system-event: efetivas OFF (nenhum bypass por origin sozinho, 0.5)', async () => {
    submitMessage(
      'turno system-event sem lease',
      {
        sessionId: 'sess-sem-lease',
        origin: 'system-event',
        driveProjectId: 'proj_y',
        driveTurnId: 'proj_y:1',
      } as QueryOptions,
      noopGetWindow,
    );

    await waitTurnDone();

    expect(captured?.ctx?.origin).toBe('system-event');
    expect(captured?.ctx?.internalLeaseToken).toBeUndefined();
    expect(captured?.effective).toEqual(OFF);
    expect(promptCapabilities()).toEqual(OFF);
    expect(captured?.gateChatPipeline.ok).toBe(false);
  });
});


describe('AC-A22 (d): turno de usuario comum com toggles OFF continua OFF', () => {
  it('origin user + featureToggles OFF: efetivas = OFF; gate em enforce nega pipeline_*', async () => {
    submitMessage(
      'oi',
      { sessionId: 'sess-user', featureToggles: { ...OFF } } as QueryOptions,
      noopGetWindow,
    );

    await waitTurnDone();

    expect(captured?.ctx?.origin).toBe('user');
    expect(captured?.effective).toEqual(OFF);
    expect(promptCapabilities()).toEqual(OFF);
    expect(mcpCapabilities()).toEqual(OFF);
    expect(captured?.gateChatPipeline.ok).toBe(false);
    expect(captured?.gateChatWorkflow.ok).toBe(false);
  });
});


describe('S6a bonus: fail-safe do getSetting(TTL) no hook do orchestrator', () => {
  it('getSetting lancando para o TTL: o turno RODA e o turn-context e registrado com TTL default', async () => {
    seedProject();
    const coord = makeCoordinator();
    h.getSettingMock.mockImplementation((key: string) => {
      if (key === CHAT_TURN_CONTEXT_TTL_SETTING_KEY) throw new Error('db quebrado');
      if (key === CHAT_CAPABILITY_GATE_MODE_SETTING_KEY) return 'enforce';
      return undefined;
    });

    const res = coord.startDrive('proj_a', 'sess-drive', 'semi');
    expect(res.ok).toBe(true);

    await waitTurnDone();

    expect(captured?.ctx).toBeDefined();
    expect(captured?.effective).toEqual({ pipelineControl: true, dynamicWorkflows: false });
    expect(captured?.gateChatPipeline).toEqual({ ok: true });
  });
});
