
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const getActiveChatSessionMock = vi.fn<() => { id: string } | null>(() => ({ id: 'chat-1' }));
const insertAuditEntryMock = vi.fn();

type FakeAgent = { id: string; access: 'read-only' | 'workspace-write'; squad: string };
const FAKE_AGENTS: Record<string, FakeAgent> = {
  'dynamic-workflow-scout': { id: 'dynamic-workflow-scout', access: 'read-only', squad: 'dynamic-workflow' },
  'dynamic-workflow-refuter': { id: 'dynamic-workflow-refuter', access: 'read-only', squad: 'dynamic-workflow' },
  'dynamic-workflow-coder': { id: 'dynamic-workflow-coder', access: 'workspace-write', squad: 'dynamic-workflow' },
  'dynamic-workflow-doc-writer': { id: 'dynamic-workflow-doc-writer', access: 'workspace-write', squad: 'dynamic-workflow' },
  'security-auditor': { id: 'security-auditor', access: 'read-only', squad: 'security' },
};
const getAgentMock = vi.fn<(id: string) => FakeAgent | undefined>((id) => FAKE_AGENTS[id]);

const getPermissionBypassMock = vi.fn<() => boolean>(() => true);

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  insertAuditEntry: (entry: unknown) => insertAuditEntryMock(entry),
  getAgent: (id: string) => getAgentMock(id),
  getActiveChatSession: () => getActiveChatSessionMock(),
  getPermissionBypass: () => getPermissionBypassMock(),
  getDynamicWorkflowRun: vi.fn(() => null),
  listDynamicWorkflowRuns: vi.fn(() => []),
  listDynamicWorkflowRunsByStatus: vi.fn(() => []),
  getDynamicWorkflowDefinition: vi.fn(() => null),
  createDynamicWorkflowDefinition: vi.fn(),
  createDynamicWorkflowRun: vi.fn(),
  createDynamicWorkflowNode: vi.fn(() => ({})),
  updateDynamicWorkflowDefinition: vi.fn(),
  repointDynamicWorkflowRunDefinition: vi.fn(),
  claimAdjustmentsForNode: vi.fn(() => []),
  getSetting: vi.fn(() => undefined),
  getConsumedAdjustmentsForNode: vi.fn(() => []),
}));

vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: vi.fn() }));

const createWorkflowMock = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({
  ok: true,
  runId: 'run-authored-1',
  definitionId: 'def-authored-1',
  report: { ok: true, issues: [], checkedAt: 'now' },
  runDir: '/tmp/run-authored-1',
}));
vi.mock('../dynamic-workflows/workflow-create', () => ({
  createWorkflow: (input: unknown) => createWorkflowMock(input),
}));

const startMock = vi.fn(async () => ({ ok: true }));
const getSnapshotMock = vi.fn<(id: string) => unknown>(() => ({
  runId: 'run-authored-1',
  status: 'running',
  currentNodeId: null,
  recentEvents: [],
  cost: { actualUsd: 0 },
}));
vi.mock('../dynamic-workflows/workflow-runner', () => ({
  getWorkflowRunner: () => ({
    start: startMock,
    getSnapshot: (id: string) => getSnapshotMock(id),
  }),
  recoverInterruptedRuns: vi.fn(() => ({ recovered: 0 })),
}));
vi.mock('../dynamic-workflows/workflow-runner-deps', () => ({
  createDefaultRunnerDeps: vi.fn(() => ({})),
}));

vi.mock('../mcp-manager', () => ({ getAllMCPServers: vi.fn(() => []) }));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(async () => null) }));
vi.mock('../skills', () => ({ listSkills: vi.fn(() => []), getSkill: vi.fn() }));
const sendAskQuestionMock = vi.fn<
  (getWindow: () => unknown, questions: unknown) => Promise<{ id: string; answers: Record<string, string | string[]> }>
>(async () => ({ id: 'q-1', answers: { '0': 'Aprovar' } }));
vi.mock('../ask-question', () => ({
  sendAskQuestion: (getWindow: () => unknown, questions: unknown) =>
    sendAskQuestionMock(getWindow, questions),
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
  pipelineEscalateCore: vi.fn(() => ({ ok: true, value: {} })),
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
const lionAgentDispatchMock = vi.fn<(params: unknown) => Promise<{ ok: boolean; summary: string }>>(
  async () => ({ ok: true, summary: 'done' }),
);
vi.mock('../lion-sdk/tools/agent', () => ({
  lionAgentDispatch: (params: unknown) => lionAgentDispatchMock(params),
}));

import {
  dynamicWorkflowAuthorCore,
  MAX_AUTHOR_CALLS_PER_WINDOW,
  isDynamicWorkflowWriteAction,
  _resetWorkflowControlStateForTesting,
} from '../dynamic-workflows/workflow-control-core';
import {
  extractAgentTypeLiterals,
  validateAuthoredAgentTypes,
  AUTHORED_WORKFLOW_SQUAD_ALLOWLIST,
} from '../dynamic-workflows/authored-agent-validation';
import { dispatch, handleCallAgent } from '../local-ipc/jsonrpc-methods';
import type { JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import { bindActiveDesktopTurn, type ActiveChatTurnFixture } from './helpers/active-chat-turn-fixture';

const ctx: JsonRpcContext = { getWindow: () => null };
const agentCtx: JsonRpcContext = {
  getWindow: () => null,
  connection: { authenticatedHelper: true, serverId: 'lionclaw-agents', connectionId: 'workflow-author-agent-test' },
};
let activeTurn: ActiveChatTurnFixture;

const VALID_AUTHORED_JS = [
  "export const meta = { name: 'auditoria', phases: ['analise'] };",
  'export default async function run(ctx) {',
  "  const a = await ctx.agent('mapeie o repo', { agentType: 'dynamic-workflow-scout' });",
  '  const b = await ctx.agent(',
  "    'critique o achado',",
  "    { agentType: 'dynamic-workflow-refuter' },",
  '  );',
  '  return { a, b };',
  '}',
].join('\n');

beforeEach(() => {
  activeTurn = bindActiveDesktopTurn();
  vi.clearAllMocks();
  _resetWorkflowControlStateForTesting();
  getActiveChatSessionMock.mockReturnValue({ id: 'chat-1' });
  getAgentMock.mockImplementation((id) => FAKE_AGENTS[id]);
  getPermissionBypassMock.mockReturnValue(true);
  startMock.mockResolvedValue({ ok: true });
  createWorkflowMock.mockResolvedValue({
    ok: true,
    runId: 'run-authored-1',
    definitionId: 'def-authored-1',
    report: { ok: true, issues: [], checkedAt: 'now' },
    runDir: '/tmp/run-authored-1',
  });
  lionAgentDispatchMock.mockResolvedValue({ ok: true, summary: 'done' });
});

afterEach(() => activeTurn.dispose());


describe('AC-F4-1: author claude-code valido cria a definition + dispara o start', () => {
  it('dynamic_workflow_author e WRITE (passa pela allowlist)', () => {
    expect(isDynamicWorkflowWriteAction('dynamic_workflow_author')).toBe(true);
  });

  it('chama createWorkflow com workflowSource + origin orchestrator (criacao claude-code unica)', async () => {
    const res = await dynamicWorkflowAuthorCore({
      projectPath: '/abs/proj',
      name: 'auditoria',
      workflowJsSource: VALID_AUTHORED_JS,
    });
    expect(res.ok).toBe(true);
    expect(createWorkflowMock).toHaveBeenCalledTimes(1);
    const input = createWorkflowMock.mock.calls[0]?.[0] as {
      workflowSource?: string;
      origin?: string;
      chatSessionId?: string;
      pendingStart?: boolean;
    };
    expect(input.workflowSource).toBe(VALID_AUTHORED_JS);
    expect(input.origin).toBe('orchestrator');
    expect(input.chatSessionId).toBe('chat-1');
    expect(input.pendingStart).toBe(true);
  });

  it('start (default true) dispara runner.start em background (run sai de created)', async () => {
    const res = await dynamicWorkflowAuthorCore({
      projectPath: '/abs/proj',
      workflowJsSource: VALID_AUTHORED_JS,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const value = res.value as { runId: string; authored: boolean; started: boolean };
      expect(value.authored).toBe(true);
      expect(value.started).toBe(true);
      expect(value.runId).toBe('run-authored-1');
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledWith('run-authored-1');
  });

  it('start=false cria mas NAO inicia (createWorkflow nao inicia o run)', async () => {
    const res = await dynamicWorkflowAuthorCore({
      projectPath: '/abs/proj',
      workflowJsSource: VALID_AUTHORED_JS,
      start: false,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.value as { started: boolean }).started).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(startMock).not.toHaveBeenCalled();
  });

  it('exige projectPath e workflowJsSource', async () => {
    const noPath = await dynamicWorkflowAuthorCore({ projectPath: '', workflowJsSource: VALID_AUTHORED_JS });
    expect(noPath.ok).toBe(false);
    const noJs = await dynamicWorkflowAuthorCore({ projectPath: '/abs/proj', workflowJsSource: '   ' });
    expect(noJs.ok).toBe(false);
    expect(createWorkflowMock).not.toHaveBeenCalled();
  });
});


describe('T12: autonomia da autoria e SEMPRE `auto` no createWorkflow', () => {
  it('repassa autonomy `auto` ao createWorkflow mesmo sem input (modo unico)', async () => {
    const res = await dynamicWorkflowAuthorCore({
      projectPath: '/abs/proj',
      workflowJsSource: VALID_AUTHORED_JS,
    });
    expect(res.ok).toBe(true);
    const input = createWorkflowMock.mock.calls[0]?.[0] as { autonomy?: string };
    expect(input.autonomy).toBe('auto');
  });

  it('autonomy legado vindo da fronteira RPC (campo extra) nao propaga: create recebe `auto`', async () => {
    const legacyInput = {
      projectPath: '/abs/proj',
      workflowJsSource: VALID_AUTHORED_JS,
      autonomy: 'full',
    } as unknown as Parameters<typeof dynamicWorkflowAuthorCore>[0];
    const res = await dynamicWorkflowAuthorCore(legacyInput);
    expect(res.ok).toBe(true);
    const input = createWorkflowMock.mock.calls[0]?.[0] as { autonomy?: string };
    expect(input.autonomy).toBe('auto');
  });
});


describe('AC-F4-2: caller gate (orquestrador-only)', () => {
  it('atende dynamic_workflow_author via dispatch quando ha chat ativo e nenhum subagente', async () => {
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_author',
      id: 1,
      params: { projectPath: '/abs/proj', workflowJsSource: VALID_AUTHORED_JS },
    });
    expect(res.error).toBeUndefined();
    expect(createWorkflowMock).toHaveBeenCalledTimes(1);
  });

  it('recusa dynamic_workflow_author quando NAO ha sessao de chat ativa', async () => {
    getActiveChatSessionMock.mockReturnValue(null);
    const res = await dispatch(ctx, {
      method: 'dynamic_workflow_author',
      id: 2,
      params: { projectPath: '/abs/proj', workflowJsSource: VALID_AUTHORED_JS },
    });
    expect(res.error).toBeDefined();
    expect(res.error?.message).toMatch(/orquestrador/i);
    expect(createWorkflowMock).not.toHaveBeenCalled();
  });

  it('recusa dynamic_workflow_author enquanto ha um subagente em curso (call_agent)', async () => {
    let refused = false;
    lionAgentDispatchMock.mockImplementation(async () => {
      const r = await dispatch(ctx, {
        method: 'dynamic_workflow_author',
        id: 10,
        params: { projectPath: '/abs/proj', workflowJsSource: VALID_AUTHORED_JS },
      });
      refused = !!r.error;
      return { ok: true, summary: 'done' };
    });
    await handleCallAgent(agentCtx, { agent_id: 'sub-1', task: 'algo' });
    expect(refused).toBe(true);
    expect(createWorkflowMock).not.toHaveBeenCalled();
  });

  it('dispatch JSON-RPC: passa pelo permission guard da WRITE', async () => {
    await dispatch(ctx, {
      method: 'dynamic_workflow_author',
      id: 3,
      params: { projectPath: '/abs/proj', workflowJsSource: VALID_AUTHORED_JS },
    });
    expect(permissionGuardMock).toHaveBeenCalledTimes(1);
    expect(permissionGuardMock.mock.calls[0]?.[0]).toBe('mcp__dynamic-workflows__dynamic_workflow_author');
  });
});


describe('AC-F4-3: compile-fail volta o motivo REAL', () => {
  it('createWorkflow { ok:false } sobe o motivo real (sem mascarar)', async () => {
    createWorkflowMock.mockResolvedValueOnce({
      ok: false,
      error: 'workflow.js (claude-code) nao compila: Unexpected token (3:10)',
    });
    const res = await dynamicWorkflowAuthorCore({
      projectPath: '/abs/proj',
      workflowJsSource: 'export const meta = { name: ; }', // sintaxe quebrada
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/nao compila|Unexpected token/i);
    await new Promise((r) => setTimeout(r, 0));
    expect(startMock).not.toHaveBeenCalled();
  });
});


describe('AC-F4-4: enforcement de seguranca (writer PERMITIDO / D-F4a squad / nao-literal)', () => {
  it('PERMITE agentType writer (workspace-write) da squad dynamic-workflow', async () => {
    const js = [
      "export const meta = { name: 'x', phases: [] };",
      'export default async function run(ctx) {',
      "  return ctx.agent('escreva codigo', { agentType: 'dynamic-workflow-coder' });",
      '}',
    ].join('\n');
    const res = await dynamicWorkflowAuthorCore({ projectPath: '/abs/proj', workflowJsSource: js });
    expect(res.ok).toBe(true);
    expect(createWorkflowMock).toHaveBeenCalledTimes(1);
  });

  it('PERMITE o writer de DOCUMENTOS (dynamic-workflow-doc-writer) da squad', async () => {
    const js = [
      "export const meta = { name: 'doc', phases: [] };",
      'export default async function run(ctx) {',
      "  return ctx.agent('escreva a spec do modulo', { agentType: 'dynamic-workflow-doc-writer' });",
      '}',
    ].join('\n');
    const res = await dynamicWorkflowAuthorCore({ projectPath: '/abs/proj', workflowJsSource: js });
    expect(res.ok).toBe(true);
    expect(createWorkflowMock).toHaveBeenCalledTimes(1);
  });

  it('REJEITA agentType de outra squad [D-F4a]', async () => {
    const js = [
      "export const meta = { name: 'x', phases: [] };",
      'export default async function run(ctx) {',
      "  return ctx.agent('audite', { agentType: 'security-auditor' });",
      '}',
    ].join('\n');
    const res = await dynamicWorkflowAuthorCore({ projectPath: '/abs/proj', workflowJsSource: js });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/squad/i);
    expect(createWorkflowMock).not.toHaveBeenCalled();
  });

  it('REJEITA agentType inexistente no catalogo', async () => {
    const js = [
      "export const meta = { name: 'x', phases: [] };",
      'export default async function run(ctx) {',
      "  return ctx.agent('faca', { agentType: 'agente-fantasma' });",
      '}',
    ].join('\n');
    const res = await dynamicWorkflowAuthorCore({ projectPath: '/abs/proj', workflowJsSource: js });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/nao existe|catalogo/i);
    expect(createWorkflowMock).not.toHaveBeenCalled();
  });

  it('REJEITA agentType nao-literal/dinamico (exige literais no 1o corte)', async () => {
    const js = [
      "export const meta = { name: 'x', phases: [] };",
      "const which = 'dynamic-workflow-scout';",
      'export default async function run(ctx) {',
      '  return ctx.agent("faca", { agentType: which });', // valor = variavel, nao literal
      '}',
    ].join('\n');
    const res = await dynamicWorkflowAuthorCore({ projectPath: '/abs/proj', workflowJsSource: js });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/nao-literal|dinamico|literal/i);
    expect(createWorkflowMock).not.toHaveBeenCalled();
  });

  it('evento de auditoria (F4.8) emitido SO no caso de sucesso (source hash + chatSession + runId)', async () => {
    const res = await dynamicWorkflowAuthorCore({
      projectPath: '/abs/proj',
      workflowJsSource: VALID_AUTHORED_JS,
    });
    expect(res.ok).toBe(true);
    expect(insertAuditEntryMock).toHaveBeenCalledTimes(1);
    const entry = insertAuditEntryMock.mock.calls[0]?.[0] as {
      eventType: string;
      toolName: string;
      sessionId?: string;
      input: string;
    };
    expect(entry.eventType).toBe('tool_call');
    expect(entry.toolName).toBe('dynamic_workflow_author');
    expect(entry.sessionId).toBe('chat-1');
    const parsed = JSON.parse(entry.input) as { runId: string; workflowJsSourceSha256: string; timestamp: string };
    expect(parsed.runId).toBe('run-authored-1');
    expect(parsed.workflowJsSourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof parsed.timestamp).toBe('string');
  });

  it('NAO emite auditoria quando o enforcement rejeita (outra squad)', async () => {
    const js = "export const meta={name:'x',phases:[]}; export default async function run(ctx){ return ctx.agent('w',{agentType:'security-auditor'}); }";
    const res = await dynamicWorkflowAuthorCore({ projectPath: '/abs/proj', workflowJsSource: js });
    expect(res.ok).toBe(false);
    expect(insertAuditEntryMock).not.toHaveBeenCalled();
  });
});


describe('AC-F4-5: rate-limit de autoria (F4.7)', () => {
  it('estourado o teto por chat-session, recusa com erro claro', async () => {
    for (let i = 0; i < MAX_AUTHOR_CALLS_PER_WINDOW; i++) {
      const r = await dynamicWorkflowAuthorCore({
        projectPath: '/abs/proj',
        workflowJsSource: VALID_AUTHORED_JS,
      });
      expect(r.ok).toBe(true);
    }
    const over = await dynamicWorkflowAuthorCore({
      projectPath: '/abs/proj',
      workflowJsSource: VALID_AUTHORED_JS,
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toMatch(/anti-runaway de autoria|rate/i);
  });

  it('o teto e POR chat-session: sessao diferente nao herda o contador', async () => {
    getActiveChatSessionMock.mockReturnValue({ id: 'chat-A' });
    for (let i = 0; i < MAX_AUTHOR_CALLS_PER_WINDOW; i++) {
      await dynamicWorkflowAuthorCore({ projectPath: '/abs/proj', workflowJsSource: VALID_AUTHORED_JS });
    }
    const overA = await dynamicWorkflowAuthorCore({ projectPath: '/abs/proj', workflowJsSource: VALID_AUTHORED_JS });
    expect(overA.ok).toBe(false);
    getActiveChatSessionMock.mockReturnValue({ id: 'chat-B' });
    const freshB = await dynamicWorkflowAuthorCore({ projectPath: '/abs/proj', workflowJsSource: VALID_AUTHORED_JS });
    expect(freshB.ok).toBe(true);
  });

  it('o rate-limit corre ANTES do enforcement/createWorkflow (nao consome quota em rejeicao? - quota conta a tentativa)', async () => {
    for (let i = 0; i < MAX_AUTHOR_CALLS_PER_WINDOW; i++) {
      await dynamicWorkflowAuthorCore({ projectPath: '/abs/proj', workflowJsSource: VALID_AUTHORED_JS });
    }
    createWorkflowMock.mockClear();
    const over = await dynamicWorkflowAuthorCore({ projectPath: '/abs/proj', workflowJsSource: VALID_AUTHORED_JS });
    expect(over.ok).toBe(false);
    expect(createWorkflowMock).not.toHaveBeenCalled();
  });
});


describe('extractAgentTypeLiterals / validateAuthoredAgentTypes (robustez D-F4a/b)', () => {
  it('extrai literais com aspas simples e duplas', () => {
    const out = extractAgentTypeLiterals(
      "agent({ agentType: 'a' }); agent({ agentType: \"b\" });",
    );
    expect(out.dynamic).toBe(false);
    if (!out.dynamic) expect(out.agentTypes.sort()).toEqual(['a', 'b']);
  });

  it('detecta agentType com chave entre aspas', () => {
    const out = extractAgentTypeLiterals("agent({ 'agentType': 'a' })");
    expect(out.dynamic).toBe(false);
    if (!out.dynamic) expect(out.agentTypes).toEqual(['a']);
  });

  it('marca dinamico quando o valor nao e literal (fail-closed)', () => {
    const out = extractAgentTypeLiterals('agent({ agentType: someVar })');
    expect(out.dynamic).toBe(true);
  });

  it('sem agentType -> lista vazia (workflow sem agentes nominais e valido p/ a extracao)', () => {
    const out = extractAgentTypeLiterals('export default async function run(ctx){ return {}; }');
    expect(out.dynamic).toBe(false);
    if (!out.dynamic) expect(out.agentTypes).toEqual([]);
  });

  it('allowlist de squads default = dynamic-workflow', () => {
    expect(AUTHORED_WORKFLOW_SQUAD_ALLOWLIST.has('dynamic-workflow')).toBe(true);
    expect(AUTHORED_WORKFLOW_SQUAD_ALLOWLIST.has('security')).toBe(false);
  });

  it('validateAuthoredAgentTypes aceita read-only da squad permitida', () => {
    const v = validateAuthoredAgentTypes(VALID_AUTHORED_JS, { getAgent: getAgentMock });
    expect(v.ok).toBe(true);
  });

  it('validateAuthoredAgentTypes respeita uma allowlist customizada', () => {
    const v = validateAuthoredAgentTypes(
      "agent({ agentType: 'security-auditor' })",
      { getAgent: getAgentMock, squadAllowlist: new Set(['security']) },
    );
    expect(v.ok).toBe(true);
  });
});
