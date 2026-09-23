import { describe, it, expect, beforeEach, vi } from 'vitest';

const runToolScriptMock = vi.hoisted(() => vi.fn());
const createDispatcherMock = vi.hoisted(() => vi.fn());
const buildEnvMock = vi.hoisted(() => vi.fn(() => ({})));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../db', () => ({
  getSetting: () => undefined,
  getAllAgents: () => [],
  getAgent: () => undefined,
  getActiveChatSession: () => ({ id: 'sess-1' }),
  getPermissionBypass: () => false,
  getCompletedDocsCount: () => 0,
  insertAuditEntry: vi.fn(),
}));
vi.mock('../permission-guard', () => ({ createPermissionGuard: () => vi.fn() }));
vi.mock('../mcp-manager', () => ({
  getAllMCPServers: () => [],
  getMCPConfigForAgent: vi.fn(),
  getMcpToolRegistryEntries: () => [],
  discoverAndSaveMCPTools: vi.fn(),
}));
vi.mock('../mcp-tool-bridge', () => ({
  setupMCPsForSession: vi.fn(),
  callMCPTool: vi.fn(),
  teardownMCPsForSession: vi.fn(),
}));
vi.mock('../secrets-vault', () => ({ getSecret: async () => null }));
vi.mock('../skills', () => ({ listSkills: () => [], getSkill: () => null }));
vi.mock('../ask-question', () => ({
  sendAskQuestion: async () => ({ id: 'unused', answers: [] }),
}));
vi.mock('../pipeline-control-core', () => ({
  isPipelineWriteAction: () => false,
  pipelineListCore: vi.fn(),
  pipelineInspectCore: vi.fn(),
  pipelineCreateCore: vi.fn(),
  pipelineDriveCore: vi.fn(),
  pipelineReplyCore: vi.fn(),
  pipelineApproveCore: vi.fn(),
  pipelineEscalateCore: vi.fn(),
  pipelineAbortCore: vi.fn(),
  pipelinePauseCore: vi.fn(),
  designSessionConfigCore: vi.fn(),
  normalizeApproveMetadata: (m: unknown) => m,
}));
vi.mock('../dynamic-workflows/workflow-control-core', () => ({
  isDynamicWorkflowWriteAction: () => false,
  dynamicWorkflowStartCore: vi.fn(),
  dynamicWorkflowAuthorCore: vi.fn(),
  dynamicWorkflowInspectCore: vi.fn(),
  dynamicWorkflowReplyCore: vi.fn(),
  dynamicWorkflowApproveCore: vi.fn(),
  dynamicWorkflowInterveneCore: vi.fn(),
  dynamicWorkflowAbortCore: vi.fn(),
  dynamicWorkflowEditCoordinatorCore: vi.fn(),
}));

vi.mock('../tool-script/tool-script-engine', () => ({
  runToolScript: runToolScriptMock,
  isToolScriptAvailable: () => true,
}));
vi.mock('../tool-script/tool-script-dispatch', () => ({
  createToolScriptDispatcher: createDispatcherMock,
}));
vi.mock('../tool-script/tool-script-env', () => ({
  buildToolScriptEnv: buildEnvMock,
}));

import { dispatch, handleRunToolScript, type JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import {
  registerChatCapabilityTurn,
  setActiveChatTurn,
  __resetChatCapabilityContextForTests,
} from '../chat-capability-context';
import { getDesktopLane } from '../desktop-lanes';
import { ToolScriptError } from '../tool-script/tool-script-types';

const AUTHED_CTX: JsonRpcContext = {
  getWindow: () => null,
  connection: { authenticatedHelper: true, serverId: 'lionclaw-toolscript' },
};
const ANON_CTX: JsonRpcContext = { getWindow: () => null };

const SESSION_ID = 'sess-1';
const desktopLane = getDesktopLane(SESSION_ID);
const TURN_ID = 'turn-1';

const OK_RESULT = {
  stdout: 'ok\n',
  stderr: '',
  exitCode: 0,
  toolCallCount: 2,
  timedOut: false,
  aborted: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  toolCallLimitExceeded: false,
};

function seedActiveTurn(): void {
  registerChatCapabilityTurn({
    surface: 'chat',
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    capabilities: { pipelineControl: false, dynamicWorkflows: false },
    cwd: '/repo',
    permissionProfile: { mode: 'default', dangerouslySkipPermissions: false },
    allowedServerIds: ['google-gmail'],
  });
  setActiveChatTurn({ sessionId: SESSION_ID, lane: 'desktop', turnId: TURN_ID });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetChatCapabilityContextForTests();
  desktopLane.currentAbortController = null;
  createDispatcherMock.mockReturnValue(vi.fn());
  runToolScriptMock.mockResolvedValue(OK_RESULT);
});

describe('handleRunToolScript — fail-closed em cada degrau', () => {
  it('conexao anonima -> { error, code: unauthenticated-connection }, runToolScript NAO chamado', async () => {
    seedActiveTurn();
    desktopLane.currentAbortController = new AbortController();
    const res = await handleRunToolScript(ANON_CTX, { code: 'print(1)', sessionId: SESSION_ID, turnId: TURN_ID });
    expect(res).toMatchObject({ code: 'unauthenticated-connection' });
    expect((res as { error?: string }).error).toContain('fail-closed');
    expect(runToolScriptMock).not.toHaveBeenCalled();
  });

  it('sem turno desktop ativo -> { code: turn_binding_required } (no-active-desktop-turn)', async () => {
    desktopLane.currentAbortController = new AbortController();
    const res = await handleRunToolScript(AUTHED_CTX, { code: 'print(1)', sessionId: SESSION_ID, turnId: TURN_ID });
    expect(res).toMatchObject({ code: 'turn_binding_required' });
    expect((res as { error?: string }).error).toContain('no-active-desktop-turn');
    expect(runToolScriptMock).not.toHaveBeenCalled();
  });

  it('turno ativo SEM turn-context vivo -> { code: turn-context-missing }', async () => {
    setActiveChatTurn({ sessionId: SESSION_ID, lane: 'desktop', turnId: TURN_ID });
    desktopLane.currentAbortController = new AbortController();
    const res = await handleRunToolScript(AUTHED_CTX, { code: 'print(1)', sessionId: SESSION_ID, turnId: TURN_ID });
    expect(res).toMatchObject({ code: 'turn-context-missing' });
    expect(runToolScriptMock).not.toHaveBeenCalled();
  });

  it('code vazio -> erro de argumento, runToolScript NAO chamado', async () => {
    seedActiveTurn();
    desktopLane.currentAbortController = new AbortController();
    const res = await handleRunToolScript(AUTHED_CTX, { code: '   ', sessionId: SESSION_ID, turnId: TURN_ID });
    expect((res as { error?: string }).error).toContain('"code"');
    expect(runToolScriptMock).not.toHaveBeenCalled();
  });

  it('sem controller de abort (turno sem execucao em voo) -> { code: turn-aborted }', async () => {
    seedActiveTurn();
    desktopLane.currentAbortController = null;
    const res = await handleRunToolScript(AUTHED_CTX, { code: 'print(1)', sessionId: SESSION_ID, turnId: TURN_ID });
    expect(res).toMatchObject({ code: 'turn-aborted' });
    expect(runToolScriptMock).not.toHaveBeenCalled();
  });

  it('controller JA abortado (corrida stop-vs-RPC) -> { code: turn-aborted }', async () => {
    seedActiveTurn();
    const controller = new AbortController();
    controller.abort();
    desktopLane.currentAbortController = controller;
    const res = await handleRunToolScript(AUTHED_CTX, { code: 'print(1)', sessionId: SESSION_ID, turnId: TURN_ID });
    expect(res).toMatchObject({ code: 'turn-aborted' });
    expect(runToolScriptMock).not.toHaveBeenCalled();
  });
});

describe('handleRunToolScript — composicao e fio do turno', () => {
  it('resolve sessionId/turnId pelo MAIN e passa o MESMO abortSignal do desktopLane ao motor E ao dispatcher', async () => {
    seedActiveTurn();
    const controller = new AbortController();
    desktopLane.currentAbortController = controller;

    const res = await handleRunToolScript(AUTHED_CTX, { code: 'print(1)', sessionId: SESSION_ID, turnId: TURN_ID });

    expect(runToolScriptMock).toHaveBeenCalledTimes(1);
    const [input, deps] = runToolScriptMock.mock.calls[0];
    expect(input).toMatchObject({ code: 'print(1)', sessionId: SESSION_ID, turnId: TURN_ID });
    expect(input.abortSignal).toBe(controller.signal);
    expect(typeof deps.dispatchRpc).toBe('function');
    expect(deps.buildEnv).toBe(buildEnvMock);

    expect(createDispatcherMock).toHaveBeenCalledTimes(1);
    const dispatcherInput = createDispatcherMock.mock.calls[0][0];
    expect(dispatcherInput.abortSignal).toBe(controller.signal);
    expect(dispatcherInput.code).toBe('print(1)');
    expect(typeof dispatcherInput.onToolCall).toBe('function');

    expect(res).toMatchObject({
      stdout: 'ok\n',
      exitCode: 0,
      toolCallCount: 2,
      aborted: false,
    });
  });

  it('ToolScriptError do motor -> { error, code } estruturado', async () => {
    seedActiveTurn();
    desktopLane.currentAbortController = new AbortController();
    runToolScriptMock.mockRejectedValueOnce(new ToolScriptError('python-unavailable', 'sem python3'));
    const res = await handleRunToolScript(AUTHED_CTX, { code: 'print(1)', sessionId: SESSION_ID, turnId: TURN_ID });
    expect(res).toEqual({ error: 'sem python3', code: 'python-unavailable' });
  });

  it('via dispatch(run_tool_script, params: { sessionId: SESSION_ID, turnId: TURN_ID } ): case wired no dispatcher, retorna { jsonrpc, id, result }', async () => {
    seedActiveTurn();
    desktopLane.currentAbortController = new AbortController();
    const res = await dispatch(AUTHED_CTX, {
      jsonrpc: '2.0',
      id: 42,
      method: 'run_tool_script',
      params: { ...{ sessionId: SESSION_ID, turnId: TURN_ID }, code: 'print(1)' },
    });
    expect(res.error).toBeUndefined();
    expect(res.id).toBe(42);
    expect(res.result).toMatchObject({ stdout: 'ok\n', exitCode: 0 });
    expect(runToolScriptMock).toHaveBeenCalledTimes(1);
  });
});
