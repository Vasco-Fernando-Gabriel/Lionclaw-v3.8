
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const runToolScriptMock = vi.hoisted(() => vi.fn());
const createDispatcherMock = vi.hoisted(() => vi.fn());
const buildEnvMock = vi.hoisted(() => vi.fn(() => ({})));
const recordActivityMock = vi.hoisted(() => vi.fn());
const recordSystemActivityMock = vi.hoisted(() => vi.fn());
const dbState = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  latestTurnIndex: 7 as number,
  throwOnTurnIndex: false,
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../db', () => ({
  getSetting: (key: string) => dbState.settings.get(key),
  getAllAgents: () => [],
  getAgent: () => undefined,
  getActiveChatSession: () => ({ id: 'sess-1' }),
  getPermissionBypass: () => false,
  getCompletedDocsCount: () => 0,
  insertAuditEntry: vi.fn(),
  getLatestUserTurnIndex: (_sessionId: string) => {
    if (dbState.throwOnTurnIndex) throw new Error('db de turnos quebrado');
    return dbState.latestTurnIndex;
  },
}));
vi.mock('../activity-log', () => ({
  recordActivity: recordActivityMock,
  recordSystemActivity: recordSystemActivityMock,
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

import { handleRunToolScript, type JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import {
  registerChatCapabilityTurn,
  setActiveChatTurn,
  __resetChatCapabilityContextForTests,
} from '../chat-capability-context';
import { desktopLane } from '../sdk-lane';
import { ToolScriptError } from '../tool-script/tool-script-types';
import type { ToolScriptToolCallAudit } from '../tool-script/tool-script-dispatch';
import type { LiveActivityEvent, StreamChunk } from '../../../src/types';

const SESSION_ID = 'sess-1';
const TURN_ID = 'turn-1';

const OK_RESULT = {
  stdout: 'ok\n',
  stderr: '',
  exitCode: 0,
  toolCallCount: 3,
  timedOut: false,
  aborted: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  toolCallLimitExceeded: false,
};

function makeWindow(): { win: BrowserWindow; sendSpy: ReturnType<typeof vi.fn> } {
  const sendSpy = vi.fn();
  const win = {
    isDestroyed: () => false,
    webContents: { send: sendSpy },
  } as unknown as BrowserWindow;
  return { win, sendSpy };
}

function makeCtx(win: BrowserWindow | null): JsonRpcContext {
  return {
    getWindow: () => win,
    connection: { authenticatedHelper: true, serverId: 'lionclaw-toolscript' },
  };
}

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

const RPC_AUDITS: ToolScriptToolCallAudit[] = [
  {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    tool: 'read_file',
    displayName: 'read_file /repo/a.txt',
    ok: true,
    durationMs: 12,
  },
  {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    tool: 'run_command',
    displayName: 'run_command cat a.txt | head',
    ok: true,
    durationMs: 34,
  },
  {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    tool: 'mcp_invoke',
    displayName: 'mcp__gmail__send_email',
    ok: false,
    error: 'capability negada',
    durationMs: 5,
  },
];

interface RecordedActivity {
  sessionId: string;
  turnIndex: number;
  ev: LiveActivityEvent;
  send: (chunk: StreamChunk) => void;
}

function recordedActivities(): RecordedActivity[] {
  return recordActivityMock.mock.calls.map((call) => ({
    sessionId: call[0] as string,
    turnIndex: call[1] as number,
    ev: call[2] as LiveActivityEvent,
    send: call[3] as (chunk: StreamChunk) => void,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  recordActivityMock.mockImplementation(() => undefined);
  __resetChatCapabilityContextForTests();
  desktopLane.currentAbortController = new AbortController();
  dbState.settings = new Map();
  dbState.latestTurnIndex = 7;
  dbState.throwOnTurnIndex = false;
  seedActiveTurn();

  createDispatcherMock.mockReturnValue(vi.fn());
  runToolScriptMock.mockImplementation(async () => {
    const dispatcherInput = createDispatcherMock.mock.calls[0]?.[0] as
      | { onToolCall?: (entry: ToolScriptToolCallAudit) => void }
      | undefined;
    for (const entry of RPC_AUDITS) {
      dispatcherInput?.onToolCall?.(entry);
    }
    return OK_RESULT;
  });
});


describe('AC-B13 - Activity Log por RPC no turno REAL', () => {
  it('3 RPCs -> 3 entradas com displayName real, no turno getLatestUserTurnIndex (nunca 0)', async () => {
    const { win } = makeWindow();
    const res = await handleRunToolScript(makeCtx(win), { code: 'print(1)' });
    expect(res).toMatchObject({ stdout: 'ok\n' });

    const acts = recordedActivities();
    expect(acts).toHaveLength(5);
    for (const act of acts) {
      expect(act.sessionId).toBe(SESSION_ID);
      expect(act.turnIndex).toBe(7);
      expect(act.turnIndex).not.toBe(0);
    }

    const rpcActs = acts.slice(1, 4);
    expect(rpcActs.map((a) => a.ev.label)).toEqual([
      'read_file /repo/a.txt',
      'run_command cat a.txt | head',
      'mcp__gmail__send_email',
    ]);
    expect(rpcActs.map((a) => a.ev.toolName)).toEqual([
      'read_file',
      'run_command',
      'mcp_invoke',
    ]);
    expect(rpcActs.map((a) => a.ev.status)).toEqual(['done', 'done', 'error']);
    expect(rpcActs[2].ev.description).toBe('capability negada');
    for (const a of rpcActs) {
      expect(a.ev.parentId).toBe(acts[0].ev.id);
    }
  });

  it('a propria run_tool_script aparece no stream: bloco start/end com o MESMO id', async () => {
    const { win } = makeWindow();
    await handleRunToolScript(makeCtx(win), { code: 'print(1)' });

    const acts = recordedActivities();
    const start = acts[0];
    const end = acts[acts.length - 1];
    expect(start.ev).toMatchObject({
      label: 'run_tool_script',
      toolName: 'run_tool_script',
      phase: 'start',
      status: 'running',
    });
    expect(end.ev).toMatchObject({
      label: 'run_tool_script',
      toolName: 'run_tool_script',
      phase: 'end',
      status: 'done',
    });
    expect(end.ev.id).toBe(start.ev.id);
    expect(end.ev.summary).toContain('exit 0');
    expect(end.ev.summary).toContain('3 tool call(s)');
  });

  it('send encaminha chat:stream com o sessionId injetado (padrao emitPipelineActivity)', async () => {
    const { win, sendSpy } = makeWindow();
    await handleRunToolScript(makeCtx(win), { code: 'print(1)' });

    const { send } = recordedActivities()[0];
    const chunk = { type: 'activity' } as unknown as StreamChunk;
    send(chunk);
    expect(sendSpy).toHaveBeenCalledWith('chat:stream', {
      type: 'activity',
      sessionId: SESSION_ID,
    });
  });

  it('janela nula/destruida: send vira no-op sem quebrar a emissao', async () => {
    await handleRunToolScript(makeCtx(null), { code: 'print(1)' });
    const acts = recordedActivities();
    expect(acts).toHaveLength(5);
    expect(() => acts[0].send({ type: 'activity' } as unknown as StreamChunk)).not.toThrow();
  });

  it('erro do motor: bloco da run_tool_script fecha com status error', async () => {
    runToolScriptMock.mockRejectedValueOnce(
      new ToolScriptError('python-unavailable', 'sem python3'),
    );
    const { win } = makeWindow();
    const res = await handleRunToolScript(makeCtx(win), { code: 'print(1)' });
    expect(res).toEqual({ error: 'sem python3', code: 'python-unavailable' });

    const acts = recordedActivities();
    const end = acts[acts.length - 1];
    expect(end.ev).toMatchObject({
      label: 'run_tool_script',
      phase: 'end',
      status: 'error',
    });
    expect(end.ev.description).toBe('sem python3');
  });

  it('recordSystemActivity NUNCA e usado', async () => {
    const { win } = makeWindow();
    await handleRunToolScript(makeCtx(win), { code: 'print(1)' });
    expect(recordSystemActivityMock).not.toHaveBeenCalled();
  });
});


describe('AC-B13 - robustez', () => {
  it('recordActivity lancando em TODA emissao: o resultado do script volta intacto', async () => {
    recordActivityMock.mockImplementation(() => {
      throw new Error('activity_log corrompido');
    });
    const { win } = makeWindow();
    const res = await handleRunToolScript(makeCtx(win), { code: 'print(1)' });
    expect(res).toMatchObject({ stdout: 'ok\n', exitCode: 0, toolCallCount: 3 });
  });

  it('getLatestUserTurnIndex lancando: emissao pulada, script intacto', async () => {
    dbState.throwOnTurnIndex = true;
    const { win } = makeWindow();
    const res = await handleRunToolScript(makeCtx(win), { code: 'print(1)' });
    expect(res).toMatchObject({ stdout: 'ok\n' });
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});


describe('settings tool_script_* -> deps do motor e do dispatcher', () => {
  it('limites customizados entram nas deps; a MESMA lista de tools vai ao dispatcher', async () => {
    dbState.settings.set('tool_script_tools', JSON.stringify(['read_file', 'run_command']));
    dbState.settings.set('tool_script_timeout_ms', '120000');
    dbState.settings.set('tool_script_max_stdout_bytes', '20000');
    dbState.settings.set('tool_script_max_stderr_bytes', '5000');
    dbState.settings.set('tool_script_max_tool_calls', '10');

    const { win } = makeWindow();
    await handleRunToolScript(makeCtx(win), { code: 'print(1)' });

    expect(runToolScriptMock).toHaveBeenCalledTimes(1);
    const deps = runToolScriptMock.mock.calls[0][1];
    expect(deps).toMatchObject({
      timeoutMs: 120000,
      maxStdoutBytes: 20000,
      maxStderrBytes: 5000,
      maxToolCalls: 10,
    });
    expect(deps.enabledTools).toEqual(['read_file', 'run_command']);
    expect(deps.buildEnv).toBe(buildEnvMock);

    const dispatcherInput = createDispatcherMock.mock.calls[0][0];
    expect(dispatcherInput.enabledTools).toBe(deps.enabledTools);
  });

  it('settings ausentes: defaults completos nas deps (fallback fail-safe)', async () => {
    const { win } = makeWindow();
    await handleRunToolScript(makeCtx(win), { code: 'print(1)' });

    const deps = runToolScriptMock.mock.calls[0][1];
    expect(deps).toMatchObject({
      timeoutMs: 300000,
      maxStdoutBytes: 50000,
      maxStderrBytes: 10000,
      maxToolCalls: 50,
    });
    expect(deps.enabledTools).toEqual([
      'read_file',
      'write_file',
      'edit',
      'grep',
      'search_files',
      'run_command',
      'mcp_invoke',
    ]);
  });

  it('AC-B12 rollback vivo: tool_script_enabled=false nega ANTES do motor', async () => {
    dbState.settings.set('tool_script_enabled', 'false');
    const { win } = makeWindow();
    const res = await handleRunToolScript(makeCtx(win), { code: 'print(1)' });

    expect(res).toMatchObject({ code: 'tool-script-disabled' });
    expect((res as { error?: string }).error).toContain('tool_script_enabled=false');
    expect(runToolScriptMock).not.toHaveBeenCalled();
    expect(createDispatcherMock).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});
