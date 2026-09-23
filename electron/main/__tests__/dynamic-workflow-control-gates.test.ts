import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const getActiveChatSessionMock = vi.fn<() => { id: string } | null>(() => ({ id: 'chat-1' }));
const getDynamicWorkflowRunMock = vi.fn<(id: string) => unknown>(() => ({
  id: 'run-1',
  definitionId: 'def-1',
  status: 'created',
  currentPhaseId: null,
  currentNodeId: null,
  totalCostUsd: 0,
  createdBy: 'orchestrator',
}));

function manifestWithGates(): string {
  return JSON.stringify({
    version: 1,
    name: 'wf',
    phases: [],
    nodes: [],
    parallelism: { maxConcurrentAgents: 1, parallelWritersAllowed: false },
    gates: [
      { id: 'gate-final', mode: 'human', blocks: [] },
      { id: 'gate-orch', mode: 'orchestrator', blocks: [] },
    ],
    estimate: { minUsd: 0, maxUsd: 0, unknownCostNodes: [] },
  });
}
const getDynamicWorkflowDefinitionMock = vi.fn<(id: string) => unknown>(() => ({
  id: 'def-1',
  manifestJson: manifestWithGates(),
}));
const getPermissionBypassMock = vi.fn<() => boolean>(() => true);
const getAgentGatesMock = vi.fn<(id: string) => { access?: string; squad?: string } | undefined>(() => undefined);
vi.mock('../in-flight-desktop-session', () => ({
  getInFlightDesktopSession: () => getActiveChatSessionMock()?.id ?? null,
  setInFlightDesktopSession: () => {},
}));
vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  insertAuditEntry: vi.fn(),
  getAgent: (id: string) => getAgentGatesMock(id),
  getActiveChatSession: () => getActiveChatSessionMock(),
  getPermissionBypass: () => getPermissionBypassMock(),
  getDynamicWorkflowRun: (id: string) => getDynamicWorkflowRunMock(id),
  listDynamicWorkflowRuns: vi.fn(() => []),
  getDynamicWorkflowDefinition: (id: string) => getDynamicWorkflowDefinitionMock(id),
  createDynamicWorkflowDefinition: vi.fn(),
  createDynamicWorkflowRun: vi.fn(),
  listDynamicWorkflowRunsByStatus: vi.fn(() => []),
  setDynamicWorkflowRunStatus: vi.fn(),
  updateDynamicWorkflowRun: vi.fn(),
  upsertDynamicWorkflowNodeRun: vi.fn(),
  updateDynamicWorkflowNodeRun: vi.fn(),
  listDynamicWorkflowNodeRuns: vi.fn(() => []),
  insertDynamicWorkflowEvent: vi.fn(),
  listDynamicWorkflowRecentEvents: vi.fn(() => []),
  insertDynamicWorkflowGateDecision: vi.fn(),
  insertDynamicWorkflowArtifact: vi.fn(),
  insertDynamicWorkflowMessage: vi.fn(),
  listDynamicWorkflowMessages: vi.fn(() => []),
  getDynamicWorkflowRunCostAggregate: vi.fn(() => ({})),
  createDynamicWorkflowNode: vi.fn(() => ({})),
  getDynamicWorkflowNodeByKey: vi.fn(() => null),
  updateDynamicWorkflowNodeSprintMeta: vi.fn(),
  updateDynamicWorkflowDefinition: vi.fn(),
  upsertDynamicWorkflowSprint: vi.fn(() => ({})),
  updateDynamicWorkflowSprint: vi.fn(),
  listDynamicWorkflowSprints: vi.fn(() => []),
  materializeDynamicWorkflowSprintPlan: vi.fn(),
  getDynamicWorkflowPriorMaterialization: vi.fn(() => null),
  appendDynamicWorkflowJournalEntry: vi.fn(),
  listDynamicWorkflowJournalEntries: vi.fn(() => []),
  truncateDynamicWorkflowJournalFrom: vi.fn(),
  repointDynamicWorkflowRunDefinition: vi.fn(),
  claimAdjustmentsForNode: vi.fn(() => []),
  getSetting: vi.fn(() => undefined),
  getConsumedAdjustmentsForNode: vi.fn(() => []),
}));

vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: vi.fn() }));

const createWorkflowMock = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({
  ok: true,
  runId: 'run-1',
  definitionId: 'def-1',
  report: { ok: true, issues: [], checkedAt: 'now' },
  runDir: '/tmp/run-1',
}));
vi.mock('../dynamic-workflows/workflow-create', () => ({
  createWorkflow: (input: unknown) => createWorkflowMock(input),
}));

const startMock = vi.fn(async () => ({ ok: true }));
const abortMock = vi.fn(async () => ({ ok: true }));
const interveneMock = vi.fn(async () => ({ ok: true }));
const approveGateMock = vi.fn(async () => ({ ok: true }));
const resumeMock = vi.fn(async () => ({ ok: true }));
const editCoordinatorMock = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  ok: true,
  newDefinitionId: 'def-2',
  revisionId: 'rev-abc',
  manifestHash: 'mh-rev-abc',
}));
const getSnapshotMock = vi.fn<(id: string) => unknown>(() => ({
  runId: 'run-1',
  repoPath: '/tmp',
  status: 'running',
  currentNodeId: 'coder',
  recentEvents: [],
  cost: { actualUsd: 0 },
}));
vi.mock('../dynamic-workflows/workflow-runner', () => ({
  getWorkflowRunner: () => ({
    start: startMock,
    abort: abortMock,
    intervene: interveneMock,
    approveGate: approveGateMock,
    resume: resumeMock,
    editCoordinator: (...args: unknown[]) => editCoordinatorMock(...args),
    getSnapshot: (id: string) => getSnapshotMock(id),
  }),
  recoverInterruptedRuns: vi.fn(() => ({ recovered: 0 })),
}));

vi.mock('../mcp-manager', () => ({ getAllMCPServers: vi.fn(() => []) }));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(async () => null) }));
vi.mock('../skills', () => ({ listSkills: vi.fn(() => []), getSkill: vi.fn() }));
const sendAskQuestionMock = vi.fn<
  (
    getWindow: () => unknown,
    questions: Array<{ question: string; header: string; options: Array<{ label: string }> }>,
  ) => Promise<{ id: string; answers: Record<string, string | string[]> }>
>(async () => ({ id: 'q-1', answers: { '0': 'Aprovar' } }));
vi.mock('../ask-question', () => ({
  sendAskQuestion: (getWindow: () => unknown, questions: unknown) => sendAskQuestionMock(getWindow, questions as never),
}));

const permissionGuardMock = vi.fn<
  (tool: string, input: Record<string, unknown>) => Promise<{ behavior: 'allow' | 'deny'; message?: string }>
>(async () => ({ behavior: 'allow' }));
vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => permissionGuardMock,
}));

vi.mock('../pipeline-control-core', () => ({
  isPipelineWriteAction: () => false,
  pipelineListCore: vi.fn(() => ({ ok: true, value: [] })),
  pipelineInspectCore: vi.fn(() => ({ ok: true, value: {} })),
  pipelineCreateCore: vi.fn(async () => ({ ok: true, value: {} })),
  pipelineDriveCore: vi.fn(() => ({ ok: true, value: {} })),
  pipelineReplyCore: vi.fn(async () => ({ ok: true, value: {} })),
  pipelineApproveCore: vi.fn(async () => ({ ok: true, value: {} })),
  pipelineAbortCore: vi.fn(() => ({ ok: true, value: {} })),
  pipelinePauseCore: vi.fn(() => ({ ok: true, value: {} })),
  designSessionConfigCore: vi.fn(async () => ({ ok: true, value: {} })),
  normalizeApproveMetadata: (m: unknown) => m,
}));
vi.mock('../preview-open', () => ({ previewOpenCore: vi.fn(async () => ({ ok: true, value: {} })) }));
vi.mock('../repo-graph/turn-context', () => ({
  resolveRepoGraphSessionId: vi.fn(() => null),
  getRepoGraphTurnSession: vi.fn(() => null),
  getRepoGraphTurnRuntime: vi.fn(() => 'cloud'),
}));

const lionAgentDispatchMock = vi.fn<(params: unknown) => Promise<{ ok: boolean; summary: string }>>(async () => ({
  ok: true,
  summary: 'done',
}));
vi.mock('../lion-sdk/tools/agent', () => ({
  lionAgentDispatch: (params: unknown) => lionAgentDispatchMock(params),
}));

import {
  dynamicWorkflowStartCore,
  dynamicWorkflowReplyCore,
  dynamicWorkflowApproveCore,
  dynamicWorkflowInterveneCore,
  dynamicWorkflowAbortCore,
  dynamicWorkflowEditCoordinatorCore,
  isDynamicWorkflowWriteAction,
  MAX_CONDUCT_CALLS_PER_RUN,
  _resetWorkflowControlStateForTesting,
} from '../dynamic-workflows/workflow-control-core';
import { DYNAMIC_WORKFLOW_MAESTRO_ID } from '../seed-agents/dynamic-workflow-builder';
import { dispatch, handleCallAgent } from '../local-ipc/jsonrpc-methods';
import type { JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import { bindActiveDesktopTurn, type ActiveChatTurnFixture } from './helpers/active-chat-turn-fixture';

const ctx: JsonRpcContext = { getWindow: () => null };
const agentCtx: JsonRpcContext = {
  getWindow: () => null,
  connection: { authenticatedHelper: true, serverId: 'lionclaw-agents', connectionId: 'workflow-control-agent-test' },
};
let activeTurn: ActiveChatTurnFixture;
const activeBinding = () => ({ sessionId: activeTurn.sessionId, turnId: activeTurn.turnId });

beforeEach(() => {
  activeTurn = bindActiveDesktopTurn();
  vi.clearAllMocks();
  _resetWorkflowControlStateForTesting();
  getActiveChatSessionMock.mockReturnValue({ id: 'chat-1' });
  getDynamicWorkflowRunMock.mockReturnValue({
    id: 'run-1',
    definitionId: 'def-1',
    status: 'created',
    currentPhaseId: null,
    currentNodeId: null,
    totalCostUsd: 0,
    createdBy: 'orchestrator',
  });
  getDynamicWorkflowDefinitionMock.mockReturnValue({
    id: 'def-1',
    manifestJson: manifestWithGates(),
  });
  getAgentGatesMock.mockImplementation(() => undefined);
  getSnapshotMock.mockReturnValue({
    runId: 'run-1',
    repoPath: '/tmp',
    status: 'running',
    currentNodeId: 'coder',
    recentEvents: [],
    cost: { actualUsd: 0 },
  });
  startMock.mockResolvedValue({ ok: true });
  abortMock.mockResolvedValue({ ok: true });
  interveneMock.mockResolvedValue({ ok: true });
  approveGateMock.mockResolvedValue({ ok: true });
  lionAgentDispatchMock.mockResolvedValue({ ok: true, summary: 'done' });
  getPermissionBypassMock.mockReturnValue(true);
  sendAskQuestionMock.mockResolvedValue({ id: 'q-1', answers: { '0': 'Aprovar' } });
});

afterEach(() => activeTurn.dispose());

describe('caller gate (orquestrador-only)', () => {
  it('atende dynamic_workflow_inspect (READ) quando ha chat ativo e nenhum subagente', async () => {
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_inspect',
      id: 1,
      params: { ...activeBinding(), runId: 'run-1' },
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toBeDefined();
  });

  it('recusa dynamic_workflow_inspect (READ) quando NAO ha sessao de chat ativa', async () => {
    activeTurn.dispose();
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_inspect',
      id: 2,
      params: { ...activeBinding(), runId: 'run-1' },
    });
    expect(res.result).toBeUndefined();
    expect(res.error?.message).toMatch(/orquestrador/i);
  });

  it('recusa dynamic_workflow_start (WRITE) quando NAO ha sessao de chat ativa', async () => {
    activeTurn.dispose();
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_start',
      id: 3,
      params: { ...activeBinding(), runId: 'run-1' },
    });
    expect(res.error).toBeDefined();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('recusa dynamic_workflow_* (read E write) enquanto ha um subagente em curso', async () => {
    const inner: Array<{ method: string; refused: boolean }> = [];
    lionAgentDispatchMock.mockImplementation(async () => {
      const ins = await dispatch(ctx, {
        method: 'dynamic_workflow_inspect',
        id: 10,
        params: { ...activeBinding(), runId: 'run-1' },
      });
      inner.push({ method: 'dynamic_workflow_inspect', refused: !!ins.error });
      const st = await dispatch(ctx, {
        method: 'dynamic_workflow_start',
        id: 11,
        params: { ...activeBinding(), runId: 'run-1' },
      });
      inner.push({ method: 'dynamic_workflow_start', refused: !!st.error });
      return { ok: true, summary: 'done' };
    });
    await handleCallAgent(agentCtx, {
      agent_id: 'sub-1',
      task: 'algo',
      binding: { lane: 'desktop', ...activeBinding() },
    });
    expect(inner).toEqual([
      { method: 'dynamic_workflow_inspect', refused: true },
      { method: 'dynamic_workflow_start', refused: true },
    ]);
    expect(startMock).not.toHaveBeenCalled();
  });
});

describe('gate de permissao das WRITE actions', () => {
  it('isDynamicWorkflowWriteAction separa write de read', () => {
    expect(isDynamicWorkflowWriteAction('dynamic_workflow_start')).toBe(true);
    expect(isDynamicWorkflowWriteAction('dynamic_workflow_abort')).toBe(true);
    expect(isDynamicWorkflowWriteAction('dynamic_workflow_inspect')).toBe(false);
  });

  it('chama o permission guard em dynamic_workflow_start (WRITE)', async () => {
    await dispatch(ctx, {
      method: 'dynamic_workflow_start',
      id: 20,
      params: { ...activeBinding(), runId: 'run-1' },
    });
    expect(permissionGuardMock).toHaveBeenCalledTimes(1);
    expect(permissionGuardMock.mock.calls[0]?.[0]).toBe('mcp__dynamic-workflows__dynamic_workflow_start');
  });

  it('NAO chama o permission guard em dynamic_workflow_inspect (READ)', async () => {
    await dispatch(ctx, {
      method: 'dynamic_workflow_inspect',
      id: 21,
      params: { ...activeBinding(), runId: 'run-1' },
    });
    expect(permissionGuardMock).not.toHaveBeenCalled();
  });

  it('recusa o start quando o humano nega no guard (modo semi)', async () => {
    permissionGuardMock.mockResolvedValueOnce({ behavior: 'deny' as const });
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_start',
      id: 22,
      params: { ...activeBinding(), runId: 'run-1' },
    });
    expect(res.error).toBeDefined();
    expect(startMock).not.toHaveBeenCalled();
  });
});

describe('confirmacao do modo semi com bypass desligado (AC-21)', () => {
  it('bypass LIGADO (default): WRITE nao pede confirmacao humana e despacha', async () => {
    getPermissionBypassMock.mockReturnValue(true);
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_start',
      id: 30,
      params: { ...activeBinding(), runId: 'run-1' },
    });
    expect(res.error).toBeUndefined();
    expect(sendAskQuestionMock).not.toHaveBeenCalled();
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('bypass DESLIGADO + humano APROVA: pede confirmacao e despacha', async () => {
    getPermissionBypassMock.mockReturnValue(false);
    sendAskQuestionMock.mockResolvedValueOnce({ id: 'q', answers: { '0': 'Aprovar' } });
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_start',
      id: 31,
      params: { ...activeBinding(), runId: 'run-1' },
    });
    expect(res.error).toBeUndefined();
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('bypass DESLIGADO + humano RECUSA: recusa a acao e NAO despacha ao runner', async () => {
    getPermissionBypassMock.mockReturnValue(false);
    sendAskQuestionMock.mockResolvedValueOnce({ id: 'q', answers: { '0': 'Recusar' } });
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_start',
      id: 32,
      params: { ...activeBinding(), runId: 'run-1' },
    });
    expect(res.error).toBeDefined();
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('bypass DESLIGADO + round-trip falha (sem janela/timeout): fail-closed, NAO despacha', async () => {
    getPermissionBypassMock.mockReturnValue(false);
    sendAskQuestionMock.mockRejectedValueOnce(new Error('Janela nao disponivel para pergunta'));
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_start',
      id: 33,
      params: { ...activeBinding(), runId: 'run-1' },
    });
    expect(res.error).toBeDefined();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('bypass DESLIGADO: READ (inspect) NAO pede confirmacao humana', async () => {
    getPermissionBypassMock.mockReturnValue(false);
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_inspect',
      id: 34,
      params: { ...activeBinding(), runId: 'run-1' },
    });
    expect(res.error).toBeUndefined();
    expect(sendAskQuestionMock).not.toHaveBeenCalled();
  });

  it('bypass DESLIGADO: a confirmacao cobre toda WRITE (abort tambem pede)', async () => {
    getPermissionBypassMock.mockReturnValue(false);
    sendAskQuestionMock.mockResolvedValueOnce({ id: 'q', answers: { '0': 'Recusar' } });
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_abort',
      id: 35,
      params: { ...activeBinding(), runId: 'run-1' },
    });
    expect(res.error).toBeDefined();
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);
    expect(abortMock).not.toHaveBeenCalled();
  });
});

describe('idempotencia do start', () => {
  it('start de run ja running = no-op com aviso (nao chama runner.start)', async () => {
    getDynamicWorkflowRunMock.mockReturnValue({
      id: 'run-1',
      status: 'running',
      currentPhaseId: null,
      currentNodeId: null,
      totalCostUsd: 0,
      createdBy: 'orchestrator',
    });
    const res = await dynamicWorkflowStartCore('run-1');
    expect(res.ok).toBe(true);
    expect(startMock).not.toHaveBeenCalled();
    if (res.ok) {
      expect((res.value as { alreadyRunning?: boolean }).alreadyRunning).toBe(true);
    }
  });

  it('start de run terminal = recusa', async () => {
    getDynamicWorkflowRunMock.mockReturnValue({
      id: 'run-1',
      status: 'completed',
      currentPhaseId: null,
      currentNodeId: null,
      totalCostUsd: 0,
      createdBy: 'orchestrator',
    });
    const res = await dynamicWorkflowStartCore('run-1');
    expect(res.ok).toBe(false);
  });
});

describe('one-in-flight', () => {
  it('segunda acao concorrente no mesmo run e rejeitada', async () => {
    const releaseHolder: { fn?: () => void } = {};
    const reached = new Promise<void>((resolveReached) => {
      startMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseHolder.fn = () => resolve({ ok: true });
            resolveReached();
          }),
      );
    });
    const first = dynamicWorkflowStartCore('run-1');
    await reached;
    const second = await dynamicWorkflowStartCore('run-1');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/one-in-flight/i);
    expect(releaseHolder.fn).toBeTypeOf('function');
    releaseHolder.fn?.();
    const firstRes = await first;
    expect(firstRes.ok).toBe(true);
  });
});

describe('anti-runaway', () => {
  it('estourado o teto de conducao por run, recusa e escala', async () => {
    for (let i = 0; i < MAX_CONDUCT_CALLS_PER_RUN; i++) {
      const r = await dynamicWorkflowAbortCore('run-1');
      expect(r.ok).toBe(true);
    }
    const over = await dynamicWorkflowAbortCore('run-1');
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toMatch(/anti-runaway/i);
  });
});

describe('descarte de comando defasado', () => {
  it('reply com targetNodeId que nao bate com o node corrente e recusado com snapshot', async () => {
    getSnapshotMock.mockReturnValue({
      runId: 'run-1',
      repoPath: '/tmp',
      status: 'running',
      currentNodeId: 'coder', // node corrente
      recentEvents: [],
      cost: { actualUsd: 0 },
    });
    const res = await dynamicWorkflowReplyCore('run-1', 'oi', 'scout');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/defasad/i);
    expect(interveneMock).not.toHaveBeenCalled();
  });

  it('reply com targetNodeId correto despacha ao runner', async () => {
    getSnapshotMock.mockReturnValue({
      runId: 'run-1',
      repoPath: '/tmp',
      status: 'running',
      currentNodeId: 'coder',
      recentEvents: [],
      cost: { actualUsd: 0 },
    });
    const res = await dynamicWorkflowReplyCore('run-1', 'segue', 'coder');
    expect(res.ok).toBe(true);
    expect(interveneMock).toHaveBeenCalledTimes(1);
  });

  it("D8: adjust-next-node com nodeId '*' NAO passa pelo gate 6 (proximo node que iniciar) e devolve a nota do fan-out", async () => {
    getSnapshotMock.mockReturnValue({
      runId: 'run-1',
      repoPath: '/tmp',
      status: 'running',
      currentNodeId: 'coder',
      recentEvents: [],
      cost: { actualUsd: 0 },
    });
    const res = await dynamicWorkflowInterveneCore('run-1', {
      type: 'adjust-next-node',
      nodeId: '*',
      instruction: 'rode mais validadores',
    });
    expect(res.ok).toBe(true);
    expect(interveneMock).toHaveBeenCalledTimes(1);
    if (res.ok) expect((res.value as { note?: string }).note).toMatch(/PROXIMO node que iniciar/);
  });

  it('L1.9: adjust-next-node com nodeId EXATO de node FUTURO (sem node_run) e ACEITO mesmo nao sendo o corrente', async () => {
    getSnapshotMock.mockReturnValue({
      runId: 'run-1',
      repoPath: '/tmp',
      status: 'running',
      currentNodeId: 'coder',
      recentEvents: [],
      cost: { actualUsd: 0 },
    });
    const res = await dynamicWorkflowInterveneCore('run-1', {
      type: 'adjust-next-node',
      nodeId: 'validator-r1',
      instruction: 'x',
    });
    expect(res.ok).toBe(true);
    expect(interveneMock).toHaveBeenCalledTimes(1);
  });

  it('L1.9: adjust-next-node com nodeId EXATO de node JA INICIADO/CONCLUIDO (tem node_run) e recusado', async () => {
    const db = await import('../db');
    (db.listDynamicWorkflowNodeRuns as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      { nodeId: 'scout', status: 'completed' },
    ]);
    getSnapshotMock.mockReturnValue({
      runId: 'run-1',
      repoPath: '/tmp',
      status: 'running',
      currentNodeId: 'coder',
      recentEvents: [],
      cost: { actualUsd: 0 },
    });
    const res = await dynamicWorkflowInterveneCore('run-1', {
      type: 'adjust-next-node',
      nodeId: 'scout',
      instruction: 'x',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/ja tem attempt|AINDA NAO iniciou/);
    expect(interveneMock).not.toHaveBeenCalled();
  });

  it('D9: rerun-node NAO passa pelo gate 6 (alvo e node CONCLUIDO, nao o corrente) e devolve a nota de limitacao', async () => {
    getSnapshotMock.mockReturnValue({
      runId: 'run-1',
      repoPath: '/tmp',
      status: 'blocked',
      currentNodeId: 'coder',
      recentEvents: [],
      cost: { actualUsd: 0 },
    });
    const res = await dynamicWorkflowInterveneCore('run-1', {
      type: 'rerun-node',
      nodeId: 'scout',
      instruction: 'refaca o scout com foco em X',
    });
    expect(res.ok).toBe(true);
    expect(interveneMock).toHaveBeenCalledWith(
      'run-1',
      { type: 'rerun-node', nodeId: 'scout', instruction: 'refaca o scout com foco em X' },
      'orchestrator',
    );
    if (res.ok)
      expect((res.value as { note?: string }).note).toMatch(/Commits posteriores na worktree NAO sao desfeitos/);
  });

  it('D9: rerun-node e ISENTO do guard terminal (junto com resume); pause em run failed continua barrado', async () => {
    getDynamicWorkflowRunMock.mockReturnValue({
      id: 'run-1',
      definitionId: 'def-1',
      status: 'failed',
      currentPhaseId: null,
      currentNodeId: null,
      totalCostUsd: 0,
      createdBy: 'orchestrator',
    });
    const rerun = await dynamicWorkflowInterveneCore('run-1', {
      type: 'rerun-node',
      nodeId: 'scout',
      instruction: 'x',
    });
    expect(rerun.ok).toBe(true);
    const resume = await dynamicWorkflowInterveneCore('run-1', { type: 'resume' });
    expect(resume.ok).toBe(true);
    const pause = await dynamicWorkflowInterveneCore('run-1', { type: 'pause' });
    expect(pause.ok).toBe(false);
    if (!pause.ok) expect(pause.error).toMatch(/encerrado/);
    expect(interveneMock).toHaveBeenCalledTimes(2);
  });

  it('D9: rerun-node sem nodeId ou sem instruction e recusado antes do runner', async () => {
    const semNode = await dynamicWorkflowInterveneCore('run-1', { type: 'rerun-node', nodeId: '', instruction: 'x' });
    expect(semNode.ok).toBe(false);
    const semInstr = await dynamicWorkflowInterveneCore('run-1', {
      type: 'rerun-node',
      nodeId: 'scout',
      instruction: '   ',
    });
    expect(semInstr.ok).toBe(false);
    expect(interveneMock).not.toHaveBeenCalled();
  });

  it('8.4: intervene resume com acceptBoundary repassa o campo ao runner', async () => {
    const res = await dynamicWorkflowInterveneCore('run-1', { type: 'resume', acceptBoundary: true });
    expect(res.ok).toBe(true);
    expect(interveneMock).toHaveBeenCalledWith('run-1', { type: 'resume', acceptBoundary: true }, 'orchestrator');
  });
});

describe('orquestrador aprova gate human por comando do humano (SM-31)', () => {
  it('approve de gate de modo orchestrator (baixo risco) despacha ao runner com source orchestrator', async () => {
    const res = await dynamicWorkflowApproveCore('run-1', 'gate-orch', { decision: 'approve' });
    expect(res.ok).toBe(true);
    expect(approveGateMock).toHaveBeenCalledWith(
      'run-1',
      'gate-orch',
      { decision: 'approve', reason: undefined },
      'orchestrator',
    );
  });

  it('SM-31: approve de gate de modo human (ex: gate-final) DESPACHA ao runner (humano deu o aval por chat)', async () => {
    const res = await dynamicWorkflowApproveCore('run-1', 'gate-final', { decision: 'approve' });
    expect(res.ok).toBe(true);
    expect(approveGateMock).toHaveBeenCalledWith(
      'run-1',
      'gate-final',
      { decision: 'approve', reason: undefined },
      'orchestrator',
    );
  });

  it('SM-31: intervene approve-gate de gate human tambem DESPACHA (delega ao approve core)', async () => {
    const res = await dynamicWorkflowInterveneCore('run-1', {
      type: 'approve-gate',
      gateId: 'gate-final',
      decision: 'approve',
    });
    expect(res.ok).toBe(true);
    expect(approveGateMock).toHaveBeenCalledWith('run-1', 'gate-final', { decision: 'approve' }, 'orchestrator');
  });
});

describe('gates de entrega por autonomia (template plan-driven, sec 6)', () => {
  function manifestWithDeliveryGates(): string {
    return JSON.stringify({
      version: 1,
      name: 'adversarial-feature-delivery',
      phases: [],
      nodes: [],
      parallelism: { maxConcurrentAgents: 3, parallelWritersAllowed: false },
      gates: [
        { id: 'gate-plan-review-human', mode: 'human', kind: 'plan-review', blocks: [] },
        { id: 'gate-plan-review-orchestrator', mode: 'orchestrator', kind: 'plan-review', blocks: [] },
        { id: 'gate-delivery-human', mode: 'human', kind: 'delivery', blocks: [] },
        { id: 'gate-delivery-orchestrator', mode: 'orchestrator', kind: 'delivery', blocks: [] },
      ],
      estimate: { minUsd: 0, maxUsd: 0, unknownCostNodes: [] },
    });
  }

  beforeEach(() => {
    getDynamicWorkflowDefinitionMock.mockReturnValue({
      id: 'def-1',
      manifestJson: manifestWithDeliveryGates(),
    });
  });

  it('gate-delivery-orchestrator (mode orchestrator) E aprovavel pelo drive (autonomia full)', async () => {
    const res = await dynamicWorkflowApproveCore('run-1', 'gate-delivery-orchestrator', {
      decision: 'approve',
    });
    expect(res.ok).toBe(true);
    expect(approveGateMock).toHaveBeenCalledWith(
      'run-1',
      'gate-delivery-orchestrator',
      { decision: 'approve', reason: undefined },
      'orchestrator',
    );
  });

  it('SM-31: gate-delivery-human (mode human) E aprovado por comando do humano (despacha ao runner)', async () => {
    const res = await dynamicWorkflowApproveCore('run-1', 'gate-delivery-human', {
      decision: 'approve',
    });
    expect(res.ok).toBe(true);
    expect(approveGateMock).toHaveBeenCalledWith(
      'run-1',
      'gate-delivery-human',
      { decision: 'approve', reason: undefined },
      'orchestrator',
    );
  });

  it('SM-31: gate-plan-review (mode human) "aprova" AS-IS segue pro dev (despacha ao runner)', async () => {
    const res = await dynamicWorkflowApproveCore('run-1', 'gate-plan-review-human', {
      decision: 'approve',
    });
    expect(res.ok).toBe(true);
    expect(approveGateMock).toHaveBeenCalledWith(
      'run-1',
      'gate-plan-review-human',
      { decision: 'approve', reason: undefined },
      'orchestrator',
    );
  });

  it('SM-31: intervene approve-gate de gate-delivery-human tambem despacha (delega ao approve core)', async () => {
    const res = await dynamicWorkflowInterveneCore('run-1', {
      type: 'approve-gate',
      gateId: 'gate-delivery-human',
      decision: 'approve',
    });
    expect(res.ok).toBe(true);
    expect(approveGateMock).toHaveBeenCalledWith(
      'run-1',
      'gate-delivery-human',
      { decision: 'approve' },
      'orchestrator',
    );
    expect(interveneMock).not.toHaveBeenCalled();
  });

  it('SM-2: orquestrador PODE pedir re-plan no gate-plan-review (payload action replan) - despacha ao runner', async () => {
    const res = await dynamicWorkflowApproveCore('run-1', 'gate-plan-review-human', {
      decision: 'approve',
      payload: { action: 'replan' },
    });
    expect(res.ok).toBe(true);
    expect(approveGateMock).toHaveBeenCalledWith(
      'run-1',
      'gate-plan-review-human',
      { decision: 'approve', payload: { action: 'replan' } },
      'orchestrator',
    );
  });

  it('SM-20: REJEITAR um gate-plan-review e reject-com-replan: despacha ao runner (volta ao planner, NAO trava)', async () => {
    const res = await dynamicWorkflowApproveCore('run-1', 'gate-plan-review-human', {
      decision: 'reject',
      payload: { action: 'replan' },
    });
    expect(res.ok).toBe(true);
    expect(approveGateMock).toHaveBeenCalledWith(
      'run-1',
      'gate-plan-review-human',
      { decision: 'reject', payload: { action: 'replan' } },
      'orchestrator',
    );
  });

  it('SM-20: REJEITAR um gate-plan-review SEM payload tambem volta ao planner (reject = replan no plano)', async () => {
    const res = await dynamicWorkflowApproveCore('run-1', 'gate-plan-review-human', {
      decision: 'reject',
    });
    expect(res.ok).toBe(true);
    expect(approveGateMock).toHaveBeenCalledWith(
      'run-1',
      'gate-plan-review-human',
      { decision: 'reject' },
      'orchestrator',
    );
  });

  it('SM-31: REJEITAR um gate de ENTREGA humano por comando do humano despacha ao runner (recuperavel, REGRA MAXIMA)', async () => {
    const res = await dynamicWorkflowApproveCore('run-1', 'gate-delivery-human', {
      decision: 'reject',
    });
    expect(res.ok).toBe(true);
    expect(approveGateMock).toHaveBeenCalledWith(
      'run-1',
      'gate-delivery-human',
      { decision: 'reject' },
      'orchestrator',
    );
  });

  it('SM-2: re-plan via intervene approve-gate (payload) tambem destrava o gate-plan-review', async () => {
    const res = await dynamicWorkflowInterveneCore('run-1', {
      type: 'approve-gate',
      gateId: 'gate-plan-review-human',
      decision: 'approve',
      payload: { action: 'replan' },
    });
    expect(res.ok).toBe(true);
    expect(approveGateMock).toHaveBeenCalledWith(
      'run-1',
      'gate-plan-review-human',
      { decision: 'approve', payload: { action: 'replan' } },
      'orchestrator',
    );
  });
});

describe('Maestro id canonico (F4a, sec 4.1/D-4/D-5)', () => {
  it('o id do seed do Maestro e estavel', () => {
    expect(DYNAMIC_WORKFLOW_MAESTRO_ID).toBe('dynamic-workflow-maestro');
  });
});

describe('dynamic_workflow_edit_coordinator (F4b core)', () => {
  it('edit_coordinator e WRITE (passa pela allowlist)', () => {
    expect(isDynamicWorkflowWriteAction('dynamic_workflow_edit_coordinator')).toBe(true);
  });

  it('edicao valida -> delega ao runner, devolve a nova revisao auditavel', async () => {
    getDynamicWorkflowRunMock.mockReturnValue({
      id: 'run-1',
      definitionId: 'def-1',
      status: 'paused',
      currentPhaseId: 'Implementar',
      currentNodeId: 'coder',
      totalCostUsd: 0,
      createdBy: 'orchestrator',
    });
    const res = await dynamicWorkflowEditCoordinatorCore({
      runId: 'run-1',
      workflowJsSource:
        "export const meta={name:'x',phases:['P']}; export default async function run(ctx){ return {}; }",
      reason: 'reescreve a fase de fix',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const value = res.value as { edited: boolean; newDefinitionId: string; revisionId: string; resumed: boolean };
    expect(value.edited).toBe(true);
    expect(value.newDefinitionId).toBe('def-2');
    expect(value.revisionId).toBe('rev-abc');
    expect(value.resumed).toBe(false);
    expect(editCoordinatorMock).toHaveBeenCalledTimes(1);
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('resume:true -> dispara o resume APOS a edicao valida', async () => {
    getDynamicWorkflowRunMock.mockReturnValue({
      id: 'run-1',
      definitionId: 'def-1',
      status: 'paused',
      currentNodeId: 'coder',
      totalCostUsd: 0,
      createdBy: 'orchestrator',
    });
    const res = await dynamicWorkflowEditCoordinatorCore({
      runId: 'run-1',
      workflowJsSource: 'export const meta={name:"x",phases:[]}; export default async function run(ctx){ return {}; }',
      reason: 'edita e retoma',
      resume: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.value as { resumed: boolean }).resumed).toBe(true);
    expect(resumeMock).toHaveBeenCalledWith('run-1');
  });

  it('recusa de quiescence do runner sobe como erro REAL (run nao mutado)', async () => {
    getDynamicWorkflowRunMock.mockReturnValue({
      id: 'run-1',
      definitionId: 'def-1',
      status: 'running',
      currentNodeId: 'coder',
      totalCostUsd: 0,
      createdBy: 'orchestrator',
    });
    editCoordinatorMock.mockResolvedValueOnce({
      ok: false,
      error: 'quiescence: o run "run-1" ainda esta em execucao. Pause-o antes.',
    });
    const res = await dynamicWorkflowEditCoordinatorCore({
      runId: 'run-1',
      workflowJsSource: 'export const meta={name:"x",phases:[]}; export default async function run(ctx){ return {}; }',
      reason: 'editar rodando',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/quiescence|execucao/i);
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('falha de validacao (schemaRef no writer) sobe o motivo REAL da secao 15', async () => {
    getDynamicWorkflowRunMock.mockReturnValue({
      id: 'run-1',
      definitionId: 'def-1',
      status: 'paused',
      currentNodeId: 'coder',
      totalCostUsd: 0,
      createdBy: 'orchestrator',
    });
    editCoordinatorMock.mockResolvedValueOnce({
      ok: false,
      error: "pacote editado invalido (secao 15): node writer 'coder' (workspace-write) NUNCA pode declarar schemaRef",
    });
    const res = await dynamicWorkflowEditCoordinatorCore({
      runId: 'run-1',
      workflowJsSource: 'export const meta={name:"x",phases:[]}; export default async function run(ctx){ return {}; }',
      reason: 'reintroduz schema no coder',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/secao 15|schemaRef|writer/i);
  });

  it('D-F4a: run claude-code REJEITA .js editado com agentType de squad fora da allowlist (runner intocado)', async () => {
    getDynamicWorkflowRunMock.mockReturnValue({
      id: 'run-1',
      definitionId: 'def-cc',
      status: 'paused',
      currentNodeId: 'coder',
      totalCostUsd: 0,
      createdBy: 'orchestrator',
    });
    getDynamicWorkflowDefinitionMock.mockReturnValue({
      id: 'def-cc',
      authoringModel: 'claude-code',
      manifestJson: manifestWithGates(),
    });
    getAgentGatesMock.mockImplementation((id) =>
      id === 'security-auditor' ? { access: 'read-only', squad: 'security' } : undefined,
    );
    const res = await dynamicWorkflowEditCoordinatorCore({
      runId: 'run-1',
      workflowJsSource:
        "export const meta={name:'x',phases:[]};\nawait agent({ agentType: 'security-auditor', prompt: 'audite' });\nreturn {};",
      reason: 'tenta injetar agente de outra squad',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/squad "security"/);
    expect(editCoordinatorMock).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('D-F4a: run claude-code ACEITA .js editado com writer da squad dynamic-workflow (delega ao runner)', async () => {
    getDynamicWorkflowRunMock.mockReturnValue({
      id: 'run-1',
      definitionId: 'def-cc',
      status: 'paused',
      currentNodeId: 'coder',
      totalCostUsd: 0,
      createdBy: 'orchestrator',
    });
    getDynamicWorkflowDefinitionMock.mockReturnValue({
      id: 'def-cc',
      authoringModel: 'claude-code',
      manifestJson: manifestWithGates(),
    });
    getAgentGatesMock.mockImplementation((id) =>
      id === 'dynamic-workflow-doc-writer' ? { access: 'workspace-write', squad: 'dynamic-workflow' } : undefined,
    );
    const res = await dynamicWorkflowEditCoordinatorCore({
      runId: 'run-1',
      workflowJsSource:
        "export const meta={name:'x',phases:[]};\nawait agent({ agentType: 'dynamic-workflow-doc-writer', prompt: 'escreva a spec' });\nreturn {};",
      reason: 'adiciona node de documento',
    });
    expect(res.ok).toBe(true);
    expect(editCoordinatorMock).toHaveBeenCalledTimes(1);
  });

  it('D-F4a: o enforcement de autoria e INCONDICIONAL na edicao (agentType fora do catalogo rejeita)', async () => {
    getDynamicWorkflowRunMock.mockReturnValue({
      id: 'run-1',
      definitionId: 'def-1',
      status: 'paused',
      currentNodeId: 'coder',
      totalCostUsd: 0,
      createdBy: 'orchestrator',
    });
    const res = await dynamicWorkflowEditCoordinatorCore({
      runId: 'run-1',
      workflowJsSource:
        "export const meta={name:'x',phases:[]};\nawait agent({ agentType: 'security-auditor', prompt: 'x' });\nreturn {};",
      reason: 'enforcement incondicional',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/nao existe no catalogo/);
    expect(editCoordinatorMock).not.toHaveBeenCalled();
  });

  it('exige runId / workflowJsSource / reason', async () => {
    const noRun = await dynamicWorkflowEditCoordinatorCore({
      runId: '',
      workflowJsSource: 'x',
      reason: 'r',
    });
    expect(noRun.ok).toBe(false);
    const noJs = await dynamicWorkflowEditCoordinatorCore({
      runId: 'run-1',
      workflowJsSource: '',
      reason: 'r',
    });
    expect(noJs.ok).toBe(false);
    const noReason = await dynamicWorkflowEditCoordinatorCore({
      runId: 'run-1',
      workflowJsSource: 'x',
      reason: '   ',
    });
    expect(noReason.ok).toBe(false);
  });

  it('dispatch JSON-RPC: caller gate + permission guard na WRITE', async () => {
    getDynamicWorkflowRunMock.mockReturnValue({
      id: 'run-1',
      definitionId: 'def-1',
      status: 'paused',
      currentNodeId: 'coder',
      totalCostUsd: 0,
      createdBy: 'orchestrator',
    });
    await dispatch(ctx, {
      method: 'dynamic_workflow_edit_coordinator',
      id: 99,
      params: {
        ...activeBinding(),
        runId: 'run-1',
        workflowJsSource:
          'export const meta={name:"x",phases:[]}; export default async function run(ctx){ return {}; }',
        reason: 'edita via rpc',
      },
    });
    expect(permissionGuardMock).toHaveBeenCalledTimes(1);
    expect(permissionGuardMock.mock.calls[0]?.[0]).toBe('mcp__dynamic-workflows__dynamic_workflow_edit_coordinator');
  });
});
