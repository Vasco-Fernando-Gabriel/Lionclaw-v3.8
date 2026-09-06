
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const getActiveChatSessionMock = vi.fn<() => { id: string } | null>(() => ({
  id: 'chat-1',
}));
vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  insertAuditEntry: vi.fn(),
  getAgent: vi.fn(() => undefined),
  getActiveChatSession: () => getActiveChatSessionMock(),
  getHarnessProject: vi.fn(),
  listHarnessProjects: vi.fn(() => []),
  getPipelinePhaseMessagesAsChatHistory: vi.fn(() => []),
  getDriveState: vi.fn(() => null),
}));

vi.mock('../mcp-manager', () => ({ getAllMCPServers: vi.fn(() => []) }));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(async () => null) }));
vi.mock('../skills', () => ({ listSkills: vi.fn(() => []), getSkill: vi.fn() }));
vi.mock('../ask-question', () => ({ sendAskQuestion: vi.fn() }));
vi.mock('../permission-guard', () => ({
  createPermissionGuard: () => vi.fn(async () => ({ behavior: 'allow' })),
}));
vi.mock('../lion-sdk/tools/agent', () => ({ lionAgentDispatch: vi.fn() }));
vi.mock('../pipeline-create', () => ({ createPipelineProject: vi.fn() }));
vi.mock('../pipeline-drive-coordinator', () => ({
  getPipelineDriveCoordinator: vi.fn(),
}));

const approveSpy = vi.fn(
  async (_id: string, _metadata?: Record<string, unknown>) =>
    ({ ok: true, value: { approved: true } }) as const,
);
vi.mock('../pipeline-control-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pipeline-control-core')>();
  return {
    ...actual,
    pipelineApproveCore: (id: string, metadata?: Record<string, unknown>) =>
      approveSpy(id, metadata),
  };
});

import { dispatch } from '../local-ipc/jsonrpc-methods';
import type { JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import { normalizeApproveMetadata } from '../pipeline-control-core';
import { normalizeApproveMetadata as normalizeSubprocess } from '../../../mcp-servers/_shared/approve-metadata';

const ctx: JsonRpcContext = { getWindow: () => null };

beforeEach(() => {
  vi.clearAllMocks();
  getActiveChatSessionMock.mockReturnValue({ id: 'chat-1' });
});


describe('F2 (subprocess): normalizeApproveMetadata do lionclaw-pipeline-control', () => {
  it('F2-AC1: objeto passa intacto; string JSON equivalente vira o MESMO objeto', () => {
    const obj = { action: 'lock-and-continue' };

    const fromObject = normalizeSubprocess(obj);
    expect(fromObject).toEqual({ ok: true, metadata: obj });

    const fromString = normalizeSubprocess('{"action":"lock-and-continue"}');
    expect(fromString.ok).toBe(true);
    if (fromString.ok) expect(fromString.metadata).toEqual(obj);
  });

  it('undefined e string vazia viram metadata undefined (sem erro)', () => {
    expect(normalizeSubprocess(undefined)).toEqual({ ok: true, metadata: undefined });
    expect(normalizeSubprocess('   ')).toEqual({ ok: true, metadata: undefined });
  });

  it('F2-AC2: string nao-JSON -> { error } instrutivo com exemplo do formato', () => {
    const res = normalizeSubprocess('lock-and-continue');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/nao e JSON valido/);
      expect(res.error).toContain('lock-and-continue');
      expect(res.error).toContain('selectedCandidateId');
    }
  });

  it('string JSON que NAO e objeto (array/numero/null) -> { error } instrutivo', () => {
    for (const bad of ['[1,2]', '42', 'null', '"texto"']) {
      const res = normalizeSubprocess(bad);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/nao representa um objeto/);
    }
  });
});


describe('F2 (main): normalizeApproveMetadata do pipeline-control-core', () => {
  it('F2-AC1: objeto passa intacto; string JSON equivalente vira o MESMO objeto', () => {
    const obj = { selectedCandidateId: 'C1' };
    expect(normalizeApproveMetadata(obj)).toBe(obj);
    expect(normalizeApproveMetadata('{"selectedCandidateId":"C1"}')).toEqual(obj);
    expect(normalizeApproveMetadata(undefined)).toBeUndefined();
    expect(normalizeApproveMetadata('')).toBeUndefined();
  });

  it('F2-AC2: string nao-JSON -> throw instrutivo com exemplo', () => {
    expect(() => normalizeApproveMetadata('nem json')).toThrow(/nao e JSON valido/);
    expect(() => normalizeApproveMetadata('nem json')).toThrow(/lock-and-continue/);
    expect(() => normalizeApproveMetadata('[1,2]')).toThrow(/nao representa um objeto/);
  });
});

describe('F2 (dispatch jsonrpc): pipeline_approve normaliza ANTES do core', () => {
  it('F2-AC1: metadata objeto e metadata string JSON equivalente chegam IGUAIS ao core', async () => {
    const res1 = await dispatch(ctx, {
      method: 'pipeline_approve',
      id: 1,
      params: { id: 'p1', metadata: { action: 'lock-and-continue' } },
    });
    expect(res1.error).toBeUndefined();

    const res2 = await dispatch(ctx, {
      method: 'pipeline_approve',
      id: 2,
      params: { id: 'p1', metadata: '{"action":"lock-and-continue"}' },
    });
    expect(res2.error).toBeUndefined();

    expect(approveSpy).toHaveBeenCalledTimes(2);
    expect(approveSpy.mock.calls[0]).toEqual(['p1', { action: 'lock-and-continue' }]);
    expect(approveSpy.mock.calls[1]).toEqual(['p1', { action: 'lock-and-continue' }]);
  });

  it('F2-AC2: string nao-JSON -> RPC error instrutivo SEM alcancar o core', async () => {
    const res = await dispatch(ctx, {
      method: 'pipeline_approve',
      id: 3,
      params: { id: 'p1', metadata: 'lock-and-continue' },
    });
    expect(res.result).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error?.message).toMatch(/nao e JSON valido/);
    expect(res.error?.message).toMatch(/lock-and-continue/);
    expect(approveSpy).not.toHaveBeenCalled();
  });

  it('sem metadata: core recebe undefined (comportamento anterior intacto)', async () => {
    const res = await dispatch(ctx, {
      method: 'pipeline_approve',
      id: 4,
      params: { id: 'p1' },
    });
    expect(res.error).toBeUndefined();
    expect(approveSpy).toHaveBeenCalledWith('p1', undefined);
  });
});
