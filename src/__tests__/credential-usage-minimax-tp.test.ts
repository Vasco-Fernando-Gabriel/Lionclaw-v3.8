import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAgentsUsingVaultKey } from '../lib/credential-usage';
import type { AgentConfig } from '../types';

const mockAgents: AgentConfig[] = [
  {
    id: 'agent-minimax-1',
    name: 'MiniMax Agent',
    description: 'test',
    systemPrompt: '',
    model: 'MiniMax-M2.7',
    allowedTools: [],
    mcpServers: [],
    isActive: true,
    sortOrder: 0,
    effort: 'medium',
    thinking: 'adaptive',
    skills: [],
    runtime: 'minimax-tp',
  },
  {
    id: 'agent-zai-1',
    name: 'Z.ai Agent',
    description: 'test',
    systemPrompt: '',
    model: 'glm-4.7',
    allowedTools: [],
    mcpServers: [],
    isActive: true,
    sortOrder: 0,
    effort: 'medium',
    thinking: 'adaptive',
    skills: [],
    runtime: 'zai',
  },
  {
    id: 'agent-cloud-1',
    name: 'Cloud Agent',
    description: 'test',
    systemPrompt: '',
    model: 'claude-sonnet-4-6',
    allowedTools: [],
    mcpServers: [],
    isActive: true,
    sortOrder: 0,
    effort: 'medium',
    thinking: 'adaptive',
    skills: [],
    runtime: 'cloud',
  },
  {
    id: 'agent-ext-minimax-1',
    name: 'External MiniMax Agent',
    description: 'test',
    systemPrompt: '',
    model: 'MiniMax-M2.7',
    allowedTools: [],
    mcpServers: [],
    isActive: true,
    sortOrder: 0,
    effort: 'medium',
    thinking: 'adaptive',
    skills: [],
    runtime: 'external',
    externalConfig: {
      provider: 'minimax-payg',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.minimax.chat/v1',
      model: 'MiniMax-M2.7',
      apiKeyRef: 'ORCHESTRATOR_MINIMAX_API_KEY',
    },
  },
];

beforeEach(() => {
  globalThis.window = {
    lionclaw: {
      agents: {
        list: vi.fn().mockResolvedValue(mockAgents),
      },
    },
  } as unknown as Window & typeof globalThis;
});

describe('getAgentsUsingVaultKey - SPEC-006 Sprint 3 claude-compat runtimes', () => {
  it('ORCHESTRATOR_MINIMAX_API_KEY: retorna agente runtime minimax-tp', async () => {
    const result = await getAgentsUsingVaultKey('ORCHESTRATOR_MINIMAX_API_KEY');
    const ids = result.agentsReferencing.map((a) => a.id);
    expect(ids).toContain('agent-minimax-1');
  });

  it('ORCHESTRATOR_MINIMAX_API_KEY: retorna agente external com apiKeyRef correto', async () => {
    const result = await getAgentsUsingVaultKey('ORCHESTRATOR_MINIMAX_API_KEY');
    const ids = result.agentsReferencing.map((a) => a.id);
    expect(ids).toContain('agent-ext-minimax-1');
  });

  it('ORCHESTRATOR_MINIMAX_API_KEY: nao retorna agentes cloud nem zai', async () => {
    const result = await getAgentsUsingVaultKey('ORCHESTRATOR_MINIMAX_API_KEY');
    const ids = result.agentsReferencing.map((a) => a.id);
    expect(ids).not.toContain('agent-cloud-1');
    expect(ids).not.toContain('agent-zai-1');
  });

  it('ORCHESTRATOR_ZAI_API_KEY: retorna agente runtime zai', async () => {
    const result = await getAgentsUsingVaultKey('ORCHESTRATOR_ZAI_API_KEY');
    const ids = result.agentsReferencing.map((a) => a.id);
    expect(ids).toContain('agent-zai-1');
  });

  it('ORCHESTRATOR_ZAI_API_KEY: nao retorna agentes minimax-tp nem cloud', async () => {
    const result = await getAgentsUsingVaultKey('ORCHESTRATOR_ZAI_API_KEY');
    const ids = result.agentsReferencing.map((a) => a.id);
    expect(ids).not.toContain('agent-minimax-1');
    expect(ids).not.toContain('agent-cloud-1');
  });

  it('chave desconhecida: nao retorna agentes claude-compat', async () => {
    const result = await getAgentsUsingVaultKey('SOME_OTHER_KEY');
    const ids = result.agentsReferencing.map((a) => a.id);
    expect(ids).not.toContain('agent-minimax-1');
    expect(ids).not.toContain('agent-zai-1');
  });
});
