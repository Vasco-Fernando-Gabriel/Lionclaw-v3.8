
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const getActiveChatSessionMock = vi.fn<() => { id: string } | null>(() => ({ id: 'chat-1' }));
const getPermissionBypassMock = vi.fn(() => false);
vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  insertAuditEntry: vi.fn(),
  getAgent: vi.fn(() => undefined),
  getActiveChatSession: () => getActiveChatSessionMock(),
  getPermissionBypass: () => getPermissionBypassMock(),
  getSetting: vi.fn(() => undefined),
}));

vi.mock('../mcp-manager', () => ({ getAllMCPServers: vi.fn(() => []) }));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(async () => null) }));
vi.mock('../skills', () => ({
  listSkills: vi.fn(() => []),
  getSkill: vi.fn(),
  buildAgentSkillsPromptSection: vi.fn(() => ''),
}));

const sendAskQuestionMock = vi.fn(async () => ({ answers: { '0': ['Recusar'] } }));
vi.mock('../ask-question', () => ({
  sendAskQuestion: (...args: unknown[]) => sendAskQuestionMock(...(args as [])),
}));

vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => vi.fn(async () => ({ behavior: 'allow' })),
}));

const approveCore = vi.fn(async () => ({ ok: true, value: { ack: 'approved' } }));
const interveneCore = vi.fn(async () => ({ ok: true, value: { ack: 'intervened' } }));
const abortCore = vi.fn(async () => ({ ok: true, value: { ack: 'aborted' } }));
const replyCore = vi.fn(async () => ({ ok: true, value: { ack: 'replied' } }));
const authorCore = vi.fn(async () => ({ ok: true, value: { ack: 'authored' } }));
const editCore = vi.fn(async () => ({ ok: true, value: { ack: 'edited' } }));
const inspectCore = vi.fn(async () => ({ ok: true, value: { status: 'paused' } }));
vi.mock('../dynamic-workflows/workflow-control-core', () => ({
  isDynamicWorkflowWriteAction: (a: string) =>
    new Set([
      'dynamic_workflow_approve',
      'dynamic_workflow_intervene',
      'dynamic_workflow_abort',
      'dynamic_workflow_reply',
      'dynamic_workflow_author',
      'dynamic_workflow_edit_coordinator',
    ]).has(a),
  dynamicWorkflowApproveCore: (...args: unknown[]) => approveCore(...(args as [])),
  dynamicWorkflowInterveneCore: (...args: unknown[]) => interveneCore(...(args as [])),
  dynamicWorkflowAbortCore: (...args: unknown[]) => abortCore(...(args as [])),
  dynamicWorkflowReplyCore: (...args: unknown[]) => replyCore(...(args as [])),
  dynamicWorkflowAuthorCore: (...args: unknown[]) => authorCore(...(args as [])),
  dynamicWorkflowEditCoordinatorCore: (...args: unknown[]) => editCore(...(args as [])),
  dynamicWorkflowInspectCore: (...args: unknown[]) => inspectCore(...(args as [])),
  dynamicWorkflowStartCore: vi.fn(),
}));

import { dispatch } from '../local-ipc/jsonrpc-methods';
import type { JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import {
  mintDriveCapability,
  consumeDriveCapability,
  registerReadOnlyDriveTurn,
  remainingWakeCapabilityUses,
  WAKE_CAPABILITY_ACTIONS,
  _resetDriveCapabilitiesForTesting,
} from '../dynamic-workflows/drive-capability';
import {
  registerChatCapabilityTurn,
  setActiveChatTurn,
  __resetChatCapabilityContextForTests,
} from '../chat-capability-context';

const RUN = 'run-1';
const GATE = 'gate-plan-review';
const FUTURE = 10 * 60 * 1000;
const SESSION = 'dw-drive-run-1-abc';
const TURN_ID = 'turn-1';
const DRIVE_TURN = 'run-1:1';

const ctx: JsonRpcContext = {
  getWindow: () => null,
  connection: { authenticatedHelper: true, serverId: 'lionclaw-dynamic-workflows', connectionId: 'c-1' },
};
const anonCtx: JsonRpcContext = { getWindow: () => null };

function activateTurn(driveTurnId: string | undefined, origin: 'system-event' | 'user' = 'system-event'): void {
  registerChatCapabilityTurn(
    {
      surface: 'chat',
      sessionId: SESSION,
      turnId: TURN_ID,
      origin,
      capabilities: { pipelineControl: false, dynamicWorkflows: true },
      ...(driveTurnId !== undefined ? { driveTurnId, driveProjectId: RUN } : {}),
    },
    60_000,
  );
  setActiveChatTurn({ sessionId: SESSION, lane: 'desktop', turnId: TURN_ID });
}

function mintGate(runId = RUN, gateId = GATE, driveTurnId = DRIVE_TURN): void {
  mintDriveCapability({ runId, scope: 'gate', gateId, driveTurnId, expiresAt: Date.now() + FUTURE });
}

function mintWake(runId = RUN, driveTurnId = DRIVE_TURN, expiresAt = Date.now() + FUTURE): void {
  mintDriveCapability({
    runId,
    scope: 'wake',
    driveTurnId,
    expiresAt,
    maxUses: 3,
    actions: WAKE_CAPABILITY_ACTIONS,
  });
}

const gateReq = { runId: RUN, driveTurnId: DRIVE_TURN, action: 'approve' as const, gateId: GATE };

beforeEach(() => {
  vi.clearAllMocks();
  getActiveChatSessionMock.mockReturnValue({ id: 'chat-1' });
  getPermissionBypassMock.mockReturnValue(false);
  sendAskQuestionMock.mockResolvedValue({ answers: { '0': ['Recusar'] } });
  _resetDriveCapabilitiesForTesting();
  __resetChatCapabilityContextForTests();
});

describe('T4 — bypass OFF + capability de GATE LIBERA o gate mode:orchestrator (mesmo driveTurnId)', () => {
  it('approve: capability valida + turno com o MESMO driveTurnId -> core chamado, SEM round-trip humano', async () => {
    activateTurn(DRIVE_TURN);
    mintGate();
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_approve',
      id: 1,
      params: { runId: RUN, gateId: GATE, decision: 'approve' },
    });
    expect(res.error).toBeUndefined();
    expect(approveCore).toHaveBeenCalledTimes(1);
    expect(sendAskQuestionMock).not.toHaveBeenCalled();
    expect(consumeDriveCapability(gateReq)).toBeNull(); // consumida (uso unico)
  });

  it('intervene approve-gate: capability valida -> core chamado, SEM round-trip humano', async () => {
    activateTurn(DRIVE_TURN);
    mintGate();
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_intervene',
      id: 2,
      params: { runId: RUN, intervention: { type: 'approve-gate', gateId: GATE, decision: 'approve' } },
    });
    expect(res.error).toBeUndefined();
    expect(interveneCore).toHaveBeenCalledTimes(1);
    expect(sendAskQuestionMock).not.toHaveBeenCalled();
    expect(consumeDriveCapability(gateReq)).toBeNull();
  });

  it('D7 ENDURECIMENTO: mesmo run, driveTurnId DIFERENTE no turno -> fail-closed (humano) e capability INTACTA', async () => {
    activateTurn('run-1:99');
    mintGate(RUN, GATE, DRIVE_TURN);
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_approve',
      id: 3,
      params: { runId: RUN, gateId: GATE, decision: 'approve' },
    });
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);
    expect(res.error).toBeDefined();
    expect(approveCore).not.toHaveBeenCalled();
    expect(consumeDriveCapability(gateReq)).not.toBeNull();
  });

  it('D7: turno SEM driveTurnId (turno humano) -> capability nao casa; fail-closed; intacta', async () => {
    activateTurn(undefined, 'user');
    mintGate();
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_approve',
      id: 4,
      params: { runId: RUN, gateId: GATE, decision: 'approve' },
    });
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);
    expect(res.error).toBeDefined();
    expect(approveCore).not.toHaveBeenCalled();
    expect(consumeDriveCapability(gateReq)).not.toBeNull();
  });

  it('D7: conexao ANONIMA (sem handshake) nunca resolve driveTurnId -> fail-closed; intacta', async () => {
    activateTurn(DRIVE_TURN);
    mintGate();
    const res = await dispatch(anonCtx, {
      method: 'dynamic_workflow_approve',
      id: 5,
      params: { runId: RUN, gateId: GATE, decision: 'approve' },
    });
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);
    expect(res.error).toBeDefined();
    expect(consumeDriveCapability(gateReq)).not.toBeNull();
  });
});

describe('T4 — fail-closed sem os dois predicados (gate)', () => {
  it('sem capability: approve cai no confirm humano; DENY -> core NAO chamado', async () => {
    activateTurn(DRIVE_TURN);
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_approve',
      id: 6,
      params: { runId: RUN, gateId: GATE, decision: 'approve' },
    });
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);
    expect(res.error).toBeDefined();
    expect(approveCore).not.toHaveBeenCalled();
  });

  it('caller subagente (sem chat ativo): recusado antes do carve-out; capability INTACTA', async () => {
    activateTurn(DRIVE_TURN);
    mintGate();
    getActiveChatSessionMock.mockReturnValue(null);
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_approve',
      id: 7,
      params: { runId: RUN, gateId: GATE, decision: 'approve' },
    });
    expect(res.error).toBeDefined();
    expect(res.error?.message).toMatch(/orquestrador/i);
    expect(approveCore).not.toHaveBeenCalled();
    expect(sendAskQuestionMock).not.toHaveBeenCalled();
    expect(consumeDriveCapability(gateReq)).not.toBeNull();
  });

  it('capability de GATE nao libera intervene pause (so approve daquele gate); fail-closed; intacta', async () => {
    activateTurn(DRIVE_TURN);
    mintGate();
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_intervene',
      id: 8,
      params: { runId: RUN, intervention: { type: 'pause', reason: 'parar' } },
    });
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);
    expect(res.error).toBeDefined();
    expect(interveneCore).not.toHaveBeenCalled();
    expect(consumeDriveCapability(gateReq)).not.toBeNull();
  });

  it('intervene request-replan: nunca casa capability (gate ou wake); fail-closed', async () => {
    activateTurn(DRIVE_TURN);
    mintGate();
    mintWake();
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_intervene',
      id: 9,
      params: { runId: RUN, intervention: { type: 'request-replan', scope: 'remaining', reason: 'replanejar' } },
    });
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);
    expect(res.error).toBeDefined();
    expect(interveneCore).not.toHaveBeenCalled();
    expect(consumeDriveCapability(gateReq)).not.toBeNull();
    expect(remainingWakeCapabilityUses(RUN, DRIVE_TURN)).toBe(3);
  });

  it('capability de OUTRO gate: approve do gate-X nao casa a do gate-A (e sem wake, fail-closed)', async () => {
    activateTurn(DRIVE_TURN);
    mintGate(RUN, 'gate-A');
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_approve',
      id: 10,
      params: { runId: RUN, gateId: 'gate-X', decision: 'approve' },
    });
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);
    expect(res.error).toBeDefined();
    expect(approveCore).not.toHaveBeenCalled();
    expect(consumeDriveCapability({ ...gateReq, gateId: 'gate-A' })).not.toBeNull();
  });

  it('gate e USO UNICO: a 2a aprovacao do mesmo par cai fail-closed', async () => {
    activateTurn(DRIVE_TURN);
    mintGate();
    const first = await dispatch(ctx, {
      method: 'dynamic_workflow_approve',
      id: 11,
      params: { runId: RUN, gateId: GATE, decision: 'approve' },
    });
    expect(first.error).toBeUndefined();
    expect(approveCore).toHaveBeenCalledTimes(1);
    const second = await dispatch(ctx, {
      method: 'dynamic_workflow_approve',
      id: 12,
      params: { runId: RUN, gateId: GATE, decision: 'approve' },
    });
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);
    expect(second.error).toBeDefined();
    expect(approveCore).toHaveBeenCalledTimes(1);
  });

  it('approve sem gateId nos params: sem wake nao casa; fail-closed sem throw do carve-out; gate intacta', async () => {
    activateTurn(DRIVE_TURN);
    mintGate();
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_approve',
      id: 13,
      params: { runId: RUN, decision: 'approve' },
    });
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);
    expect(res.error).toBeDefined();
    expect(approveCore).not.toHaveBeenCalled();
    expect(consumeDriveCapability(gateReq)).not.toBeNull();
  });
});

describe('D7 — capability de WAKE (scope:wake, 3 usos / 10 min, lista fechada)', () => {
  it('autoriza intervene pause, rerun-node e abort do MESMO run e MESMO driveTurnId sem humano (bypass OFF)', async () => {
    activateTurn(DRIVE_TURN);
    mintWake();
    const pause = await dispatch(ctx, {
      method: 'dynamic_workflow_intervene',
      id: 20,
      params: { runId: RUN, intervention: { type: 'pause' } },
    });
    expect(pause.error).toBeUndefined();
    const rerun = await dispatch(ctx, {
      method: 'dynamic_workflow_intervene',
      id: 21,
      params: { runId: RUN, intervention: { type: 'rerun-node', nodeId: 'cc:S1:coder:1', instruction: 'refaca' } },
    });
    expect(rerun.error).toBeUndefined();
    const abort = await dispatch(ctx, {
      method: 'dynamic_workflow_abort',
      id: 22,
      params: { runId: RUN },
    });
    expect(abort.error).toBeUndefined();
    expect(interveneCore).toHaveBeenCalledTimes(2);
    expect(abortCore).toHaveBeenCalledTimes(1);
    expect(sendAskQuestionMock).not.toHaveBeenCalled();
    expect(remainingWakeCapabilityUses(RUN, DRIVE_TURN)).toBe(0);
  });

  it('approve do gate pendente via wake (sem capability de gate) e liberado', async () => {
    activateTurn(DRIVE_TURN);
    mintWake();
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_approve',
      id: 23,
      params: { runId: RUN, gateId: 'boundary:S1', decision: 'approve' },
    });
    expect(res.error).toBeUndefined();
    expect(approveCore).toHaveBeenCalledTimes(1);
    expect(sendAskQuestionMock).not.toHaveBeenCalled();
    expect(remainingWakeCapabilityUses(RUN, DRIVE_TURN)).toBe(2);
  });

  it('OBRIGATORIO: mesmo run, driveTurnId DIFERENTE = negado (humano), nada consumido', async () => {
    activateTurn('run-1:2');
    mintWake(RUN, 'run-1:1');
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_intervene',
      id: 24,
      params: { runId: RUN, intervention: { type: 'pause' } },
    });
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);
    expect(res.error).toBeDefined();
    expect(interveneCore).not.toHaveBeenCalled();
    expect(remainingWakeCapabilityUses(RUN, 'run-1:1')).toBe(3);
  });

  it('sem driveTurnId no turno = negado; outro run = negado', async () => {
    activateTurn(undefined, 'user');
    mintWake();
    const noTurn = await dispatch(ctx, {
      method: 'dynamic_workflow_intervene',
      id: 25,
      params: { runId: RUN, intervention: { type: 'pause' } },
    });
    expect(noTurn.error).toBeDefined();
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);

    __resetChatCapabilityContextForTests();
    activateTurn(DRIVE_TURN);
    const otherRun = await dispatch(ctx, {
      method: 'dynamic_workflow_abort',
      id: 26,
      params: { runId: 'run-OTHER' },
    });
    expect(otherRun.error).toBeDefined();
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(2);
    expect(abortCore).not.toHaveBeenCalled();
    expect(remainingWakeCapabilityUses(RUN, DRIVE_TURN)).toBe(3);
  });

  it('NUNCA autoriza author / edit_coordinator / reply (fail-closed, nada consumido)', async () => {
    activateTurn(DRIVE_TURN);
    mintWake();
    const author = await dispatch(ctx, {
      method: 'dynamic_workflow_author',
      id: 27,
      params: { projectPath: 'C:/p', workflowJsSource: 'export const meta = {}' },
    });
    expect(author.error).toBeDefined();
    const edit = await dispatch(ctx, {
      method: 'dynamic_workflow_edit_coordinator',
      id: 28,
      params: { runId: RUN, workflowJsSource: 'x', reason: 'y' },
    });
    expect(edit.error).toBeDefined();
    const reply = await dispatch(ctx, {
      method: 'dynamic_workflow_reply',
      id: 29,
      params: { runId: RUN, message: 'oi' },
    });
    expect(reply.error).toBeDefined();
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(3);
    expect(authorCore).not.toHaveBeenCalled();
    expect(editCore).not.toHaveBeenCalled();
    expect(replyCore).not.toHaveBeenCalled();
    expect(remainingWakeCapabilityUses(RUN, DRIVE_TURN)).toBe(3);
  });

  it('maxUses 3: a 4a acao cai fail-closed', async () => {
    activateTurn(DRIVE_TURN);
    mintWake();
    for (let i = 0; i < 3; i += 1) {
      const res = await dispatch(ctx, {
        method: 'dynamic_workflow_intervene',
        id: 30 + i,
        params: { runId: RUN, intervention: { type: 'pause' } },
      });
      expect(res.error).toBeUndefined();
    }
    const fourth = await dispatch(ctx, {
      method: 'dynamic_workflow_intervene',
      id: 34,
      params: { runId: RUN, intervention: { type: 'pause' } },
    });
    expect(fourth.error).toBeDefined();
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);
    expect(interveneCore).toHaveBeenCalledTimes(3);
  });

  it('TTL expirado = negado (humano)', async () => {
    activateTurn(DRIVE_TURN);
    mintWake(RUN, DRIVE_TURN, Date.now() - 1);
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_intervene',
      id: 35,
      params: { runId: RUN, intervention: { type: 'pause' } },
    });
    expect(res.error).toBeDefined();
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);
    expect(interveneCore).not.toHaveBeenCalled();
  });
});

describe('D6 — turno needs-human SOMENTE-LEITURA nega WRITE mesmo com bypass ON', () => {
  it('intervene / abort / approve negados ANTES do bypass, com erro claro; inspect passa', async () => {
    getPermissionBypassMock.mockReturnValue(true);
    activateTurn(DRIVE_TURN);
    registerReadOnlyDriveTurn(DRIVE_TURN);
    mintWake();

    const intervene = await dispatch(ctx, {
      method: 'dynamic_workflow_intervene',
      id: 40,
      params: { runId: RUN, intervention: { type: 'pause' } },
    });
    expect(intervene.error).toBeDefined();
    expect(intervene.error?.message).toMatch(/SOMENTE-LEITURA/i);
    const abort = await dispatch(ctx, { method: 'dynamic_workflow_abort', id: 41, params: { runId: RUN } });
    expect(abort.error?.message).toMatch(/SOMENTE-LEITURA/i);
    const approve = await dispatch(ctx, {
      method: 'dynamic_workflow_approve',
      id: 42,
      params: { runId: RUN, gateId: GATE, decision: 'approve' },
    });
    expect(approve.error?.message).toMatch(/SOMENTE-LEITURA/i);

    expect(interveneCore).not.toHaveBeenCalled();
    expect(abortCore).not.toHaveBeenCalled();
    expect(approveCore).not.toHaveBeenCalled();
    expect(sendAskQuestionMock).not.toHaveBeenCalled();
    expect(remainingWakeCapabilityUses(RUN, DRIVE_TURN)).toBe(3);

    const inspect = await dispatch(ctx, { method: 'dynamic_workflow_inspect', id: 43, params: { runId: RUN } });
    expect(inspect.error).toBeUndefined();
    expect(inspectCore).toHaveBeenCalledTimes(1);
  });

  it('conexao ANONIMA (sem handshake) + turno read-only + bypass ON = NEGADO (o lado DENY nao exige identidade de helper)', async () => {
    getPermissionBypassMock.mockReturnValue(true);
    activateTurn(DRIVE_TURN);
    registerReadOnlyDriveTurn(DRIVE_TURN);

    const intervene = await dispatch(anonCtx, {
      method: 'dynamic_workflow_intervene',
      id: 45,
      params: { runId: RUN, intervention: { type: 'pause' } },
    });
    expect(intervene.error?.message).toMatch(/SOMENTE-LEITURA/i);
    const abort = await dispatch(anonCtx, { method: 'dynamic_workflow_abort', id: 46, params: { runId: RUN } });
    expect(abort.error?.message).toMatch(/SOMENTE-LEITURA/i);
    const approve = await dispatch(anonCtx, {
      method: 'dynamic_workflow_approve',
      id: 47,
      params: { runId: RUN, gateId: GATE, decision: 'approve' },
    });
    expect(approve.error?.message).toMatch(/SOMENTE-LEITURA/i);

    expect(interveneCore).not.toHaveBeenCalled();
    expect(abortCore).not.toHaveBeenCalled();
    expect(approveCore).not.toHaveBeenCalled();
    expect(sendAskQuestionMock).not.toHaveBeenCalled();

    const inspect = await dispatch(anonCtx, { method: 'dynamic_workflow_inspect', id: 48, params: { runId: RUN } });
    expect(inspect.error).toBeUndefined();
    expect(inspectCore).toHaveBeenCalledTimes(1);
  });

  it('outro turno (nao read-only) do mesmo processo segue normal com bypass ON', async () => {
    getPermissionBypassMock.mockReturnValue(true);
    registerReadOnlyDriveTurn('run-1:READONLY');
    activateTurn(DRIVE_TURN);
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_intervene',
      id: 44,
      params: { runId: RUN, intervention: { type: 'pause' } },
    });
    expect(res.error).toBeUndefined();
    expect(interveneCore).toHaveBeenCalledTimes(1);
  });
});

describe('turno humano sem capability = comportamento atual', () => {
  it('bypass LIGADO (default) auto-aprova sem capability nem humano', async () => {
    getPermissionBypassMock.mockReturnValue(true);
    activateTurn(undefined, 'user');
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_approve',
      id: 50,
      params: { runId: RUN, gateId: GATE, decision: 'approve' },
    });
    expect(res.error).toBeUndefined();
    expect(approveCore).toHaveBeenCalledTimes(1);
    expect(sendAskQuestionMock).not.toHaveBeenCalled();
  });

  it('bypass DESLIGADO pergunta ao humano; Aprovar libera', async () => {
    activateTurn(undefined, 'user');
    sendAskQuestionMock.mockResolvedValue({ answers: { '0': ['Aprovar'] } });
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_intervene',
      id: 51,
      params: { runId: RUN, intervention: { type: 'pause' } },
    });
    expect(res.error).toBeUndefined();
    expect(sendAskQuestionMock).toHaveBeenCalledTimes(1);
    expect(interveneCore).toHaveBeenCalledTimes(1);
  });
});
