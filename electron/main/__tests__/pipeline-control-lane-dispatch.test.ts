import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  insertAuditEntry: vi.fn(),
  getAgent: vi.fn(() => undefined),
  getActiveChatSession: () => null,
  getPermissionBypass: vi.fn(() => true),
  getCompletedDocsCount: vi.fn(() => 0),
}));
vi.mock('../mcp-manager', () => ({ getAllMCPServers: vi.fn(() => []) }));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(async () => null) }));
vi.mock('../skills', () => ({ listSkills: vi.fn(() => []), getSkill: vi.fn() }));
vi.mock('../ask-question', () => ({ sendAskQuestion: vi.fn() }));
vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => vi.fn(async () => ({ behavior: 'allow' })),
}));

const pipeline = vi.hoisted(() => ({
  list: vi.fn(() => ({ ok: true, value: ['ok'] })),
  inspect: vi.fn(() => ({ ok: true, value: { id: 'p1' } })),
  create: vi.fn(async (_input: unknown) => ({ ok: true, value: { id: 'p1' } })),
  drive: vi.fn((..._args: unknown[]) => ({ ok: true, value: { id: 'p1' } })),
  reply: vi.fn(async () => ({ ok: true, value: { id: 'p1' } })),
}));
vi.mock('../pipeline-control-core', () => ({
  assertPipeVisibleToLane: vi.fn(() => null),
  isPipelineWriteAction: (a: string) =>
    new Set([
      'pipeline_create',
      'pipeline_drive',
      'pipeline_reply',
      'pipeline_approve',
      'pipeline_escalate',
      'pipeline_abort',
      'pipeline_pause',
    ]).has(a),
  pipelineListCore: () => pipeline.list(),
  pipelineInspectCore: () => pipeline.inspect(),
  pipelineCreateCore: (input: unknown) => pipeline.create(input),
  pipelineDriveCore: (...args: unknown[]) => pipeline.drive(...args),
  pipelineReplyCore: () => pipeline.reply(),
  pipelineApproveCore: vi.fn(async () => ({ ok: true, value: {} })),
  pipelineEscalateCore: vi.fn(() => ({ ok: true, value: {} })),
  pipelineAbortCore: vi.fn(() => ({ ok: true, value: {} })),
  pipelinePauseCore: vi.fn(() => ({ ok: true, value: {} })),
  designSessionConfigCore: vi.fn(async () => ({ ok: true, value: {} })),
  normalizeApproveMetadata: (m: unknown) => m,
}));

const workflow = vi.hoisted(() => ({
  inspect: vi.fn(async () => ({ ok: true, value: { runId: 'run-1' } })),
  author: vi.fn(async (_input: unknown) => ({ ok: true, value: { runId: 'run-1' } })),
}));
vi.mock('../dynamic-workflows/workflow-control-core', () => ({
  isDynamicWorkflowWriteAction: (a: string) => a !== 'dynamic_workflow_inspect',
  dynamicWorkflowStartCore: vi.fn(async () => ({ ok: true, value: {} })),
  dynamicWorkflowAuthorCore: (input: unknown) => workflow.author(input),
  dynamicWorkflowInspectCore: () => workflow.inspect(),
  dynamicWorkflowReplyCore: vi.fn(async () => ({ ok: true, value: {} })),
  dynamicWorkflowApproveCore: vi.fn(async () => ({ ok: true, value: {} })),
  dynamicWorkflowInterveneCore: vi.fn(async () => ({ ok: true, value: {} })),
  dynamicWorkflowAbortCore: vi.fn(async () => ({ ok: true, value: {} })),
  dynamicWorkflowEditCoordinatorCore: vi.fn(async () => ({ ok: true, value: {} })),
}));
vi.mock('../lion-sdk/tools/agent', () => ({ lionAgentDispatch: vi.fn(async () => ({ ok: true })) }));

import { dispatch, type JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import { setActiveChatTurn, clearActiveChatTurn } from '../chat-capability-context';

const ctx: JsonRpcContext = { getWindow: () => null };

function rpc(method: string, params: Record<string, unknown> = {}) {
  return dispatch(ctx, { jsonrpc: '2.0', id: 1, method, params });
}

const DESK = { sessionId: 'desk-1', turnId: 'd1' };

function bindDesktop(): void {
  setActiveChatTurn({ sessionId: 'desk-1', lane: 'desktop', turnId: 'd1' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  clearActiveChatTurn({ sessionId: 'tg-1', lane: 'telegram' });
  clearActiveChatTurn({ sessionId: 'cron-1', lane: 'cron' });
  clearActiveChatTurn({ sessionId: 'desk-1', lane: 'desktop' });
});

describe('P2-3: tools de pipeline/workflow por lane do chamador', () => {
  it('lane telegram com turno ativo: READs liberadas mesmo sem turno desktop', async () => {
    setActiveChatTurn({ sessionId: 'tg-1', lane: 'telegram', turnId: 't1' });
    expect((await rpc('pipeline_list', { lane: 'telegram' })).error).toBeUndefined();
    expect((await rpc('pipeline_inspect', { id: 'p1', lane: 'telegram' })).error).toBeUndefined();
    expect((await rpc('dynamic_workflow_inspect', { runId: 'run-1', lane: 'telegram' })).error).toBeUndefined();
    expect(pipeline.list).toHaveBeenCalledTimes(1);
    expect(pipeline.inspect).toHaveBeenCalledTimes(1);
    expect(workflow.inspect).toHaveBeenCalledTimes(1);
  });

  it('lane telegram sem turno ativo: turn_binding_required da propria lane, nunca o in-flight desktop', async () => {
    bindDesktop();
    const res = await rpc('pipeline_list', { lane: 'telegram' });
    expect(res.error?.message).toMatch(/turn_binding_required/);
    expect(res.error?.message).toMatch(/lane telegram/);
    expect(pipeline.list).not.toHaveBeenCalled();
  });

  it('lane telegram/cron: WRITEs recusam com desktop_lane_required e nunca vinculam o pipeline a lane desktop', async () => {
    setActiveChatTurn({ sessionId: 'tg-1', lane: 'telegram', turnId: 't1' });
    setActiveChatTurn({ sessionId: 'cron-1', lane: 'cron', turnId: 'c1' });
    bindDesktop();

    const create = await rpc('pipeline_create', {
      lane: 'telegram',
      projectPath: '/p',
      pipelineType: 'feature',
      name: 'x',
      brief: 'y',
      drive: 'semi',
    });
    expect(create.error?.message).toMatch(/^desktop_lane_required/);
    expect(pipeline.create).not.toHaveBeenCalled();

    const drive = await rpc('pipeline_drive', { lane: 'cron', id: 'p1', mode: 'semi' });
    expect(drive.error?.message).toMatch(/^desktop_lane_required/);
    expect(pipeline.drive).not.toHaveBeenCalled();

    const reply = await rpc('pipeline_reply', { lane: 'telegram', id: 'p1', message: 'ok' });
    expect(reply.error?.message).toMatch(/^desktop_lane_required/);
    expect(pipeline.reply).not.toHaveBeenCalled();

    const author = await rpc('dynamic_workflow_author', {
      lane: 'telegram',
      projectPath: '/p',
      workflowJsSource: 'export default async function run() {}',
    });
    expect(author.error?.message).toMatch(/^desktop_lane_required/);
    expect(workflow.author).not.toHaveBeenCalled();
  });

  it('lane desktop: o sessionId do drive vem do binding do turno desktop', async () => {
    bindDesktop();
    expect((await rpc('pipeline_list', { ...DESK })).error).toBeUndefined();

    await rpc('pipeline_create', {
      ...DESK,
      projectPath: '/p',
      pipelineType: 'feature',
      name: 'x',
      brief: 'y',
      drive: 'semi',
    });
    expect(pipeline.create).toHaveBeenCalledWith(expect.objectContaining({ driveSessionId: 'desk-1', drive: 'semi' }));

    await rpc('pipeline_drive', { ...DESK, lane: 'desktop', id: 'p1', mode: 'full' });
    expect(pipeline.drive).toHaveBeenCalledWith('p1', 'full', 'desk-1');

    await rpc('dynamic_workflow_author', {
      ...DESK,
      projectPath: '/p',
      workflowJsSource: 'export default async function run() {}',
    });
    expect(workflow.author).toHaveBeenCalledWith(expect.objectContaining({ chatSessionId: 'desk-1' }));
  });

  it('lane desktop sem binding: turn_binding_required', async () => {
    setActiveChatTurn({ sessionId: 'tg-1', lane: 'telegram', turnId: 't1' });
    const res = await rpc('pipeline_list');
    expect(res.error?.message).toMatch(/turn_binding_required/);
    expect(pipeline.list).not.toHaveBeenCalled();
  });
});
