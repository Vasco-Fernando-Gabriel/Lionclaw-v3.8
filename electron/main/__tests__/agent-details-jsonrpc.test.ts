
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(() => undefined),
  insertAuditEntry: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getPermissionBypass: vi.fn(() => true),
  getCompletedDocsCount: vi.fn(() => 0),
}));

vi.mock('../mcp-manager', () => ({ getAllMCPServers: vi.fn(() => []) }));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(() => null) }));
vi.mock('../skills', () => ({
  listSkills: vi.fn(() => []),
  getSkill: vi.fn(() => null),
  buildSkillsPromptSection: vi.fn(() => ''),
  buildAgentSkillsPromptSection: vi.fn(() => ''),
}));
vi.mock('../ask-question', () => ({ sendAskQuestion: vi.fn() }));

import { getAgent, getCompletedDocsCount } from '../db';
import {
  handleAgentDetails,
  dispatch,
  type JsonRpcContext,
} from '../local-ipc/jsonrpc-methods';

const mockGetAgent = getAgent as ReturnType<typeof vi.fn>;
const mockGetCompletedDocsCount = getCompletedDocsCount as ReturnType<typeof vi.fn>;

const ctx: JsonRpcContext = { getWindow: () => null };

const BASE_AGENT = {
  id: 'researcher',
  name: 'Researcher',
  description:
    'Especialista em pesquisa profunda. Cobre coleta de fontes, verificacao adversarial e sintese final com citacoes, incluindo todos os detalhes que o resumo de 80 chars corta.',
  model: 'claude-opus-4-7',
  allowedTools: ['Read', 'WebSearch'],
  skills: ['skill-research'],
  isActive: true,
  runtime: 'cloud',
  squad: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgent.mockReturnValue({ ...BASE_AGENT });
  mockGetCompletedDocsCount.mockReturnValue(0);
});

describe('handleAgentDetails — ficha completa (13.3)', () => {
  it('retorna a ficha com description INTEGRAL e todos os campos', () => {
    mockGetCompletedDocsCount.mockReturnValue(4);
    const result = handleAgentDetails({ agent_id: 'researcher' });
    expect(result).toEqual({
      id: 'researcher',
      name: 'Researcher',
      description: BASE_AGENT.description,
      runtime: 'cloud',
      model: 'claude-opus-4-7',
      allowedTools: ['Read', 'WebSearch'],
      skills: ['skill-research'],
      kbDocs: 4,
      squad: null,
      chatEligible: true,
    });
  });

  it('kbDocs = 0 quando kb_enabled === 0, mesmo com docs indexados (mesma regra do indice)', () => {
    mockGetAgent.mockReturnValue({ ...BASE_AGENT, kb_enabled: 0 });
    mockGetCompletedDocsCount.mockReturnValue(7);
    const result = handleAgentDetails({ agent_id: 'researcher' });
    expect((result as { kbDocs: number }).kbDocs).toBe(0);
  });

  it('SEM gate de squad no read: pipeline-interno retorna ficha com chatEligible=false', () => {
    mockGetAgent.mockReturnValue({ ...BASE_AGENT, id: 'harness-coder', squad: 'harness' });
    const result = handleAgentDetails({ agent_id: 'harness-coder' });
    expect('error' in result).toBe(false);
    expect((result as { squad: string | null }).squad).toBe('harness');
    expect((result as { chatEligible: boolean }).chatEligible).toBe(false);
  });

  it('id inexistente -> { error } (nunca throw)', () => {
    mockGetAgent.mockReturnValue(undefined);
    const result = handleAgentDetails({ agent_id: 'ghost' });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('ghost');
  });

  it('agente inativo -> { error }', () => {
    mockGetAgent.mockReturnValue({ ...BASE_AGENT, isActive: false });
    const result = handleAgentDetails({ agent_id: 'researcher' });
    expect(result).toHaveProperty('error');
  });

  it('agent_id ausente/vazio -> { error }', () => {
    expect(handleAgentDetails({} as { agent_id: string })).toHaveProperty('error');
    expect(handleAgentDetails({ agent_id: '   ' })).toHaveProperty('error');
  });

  it('runtime ausente cai em cloud; arrays nao-array viram []', () => {
    mockGetAgent.mockReturnValue({
      ...BASE_AGENT,
      runtime: undefined,
      allowedTools: undefined,
      skills: undefined,
    });
    const result = handleAgentDetails({ agent_id: 'researcher' });
    expect((result as { runtime: string }).runtime).toBe('cloud');
    expect((result as { allowedTools: string[] }).allowedTools).toEqual([]);
    expect((result as { skills: string[] }).skills).toEqual([]);
  });
});

describe('dispatcher — method agent_details', () => {
  it('roteia para o handler e devolve a ficha como RESULT', async () => {
    const response = await dispatch(ctx, {
      jsonrpc: '2.0',
      id: 7,
      method: 'agent_details',
      params: { agent_id: 'researcher' },
    });
    expect(response.error).toBeUndefined();
    expect((response.result as { id: string }).id).toBe('researcher');
  });

  it('id inexistente volta como RESULT { error } (padrao IPC), nao RPC error', async () => {
    mockGetAgent.mockReturnValue(undefined);
    const response = await dispatch(ctx, {
      jsonrpc: '2.0',
      id: 8,
      method: 'agent_details',
      params: { agent_id: 'ghost' },
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toHaveProperty('error');
  });
});
