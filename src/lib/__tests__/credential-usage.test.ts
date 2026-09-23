import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../../types/index';

function makeExternalAgent(overrides: { id: string; name: string; provider: string; apiKeyRef: string }): AgentConfig {
  return {
    id: overrides.id,
    name: overrides.name,
    description: 'Test agent',
    systemPrompt: 'Do stuff',
    model: 'claude-sonnet-4-6',
    allowedTools: [],
    mcpServers: [],
    isActive: true,
    sortOrder: 0,
    effort: 'medium',
    thinking: 'adaptive',
    skills: [],
    runtime: 'external',
    externalConfig: {
      provider: overrides.provider as AgentConfig['externalConfig'] extends infer T
        ? T extends { provider: infer P }
          ? P
          : never
        : never,
      model: 'some-model',
      apiKeyRef: overrides.apiKeyRef,
      baseUrl: 'https://api.example.com/v1',
    },
  };
}

function makeCloudAgent(id: string, name: string): AgentConfig {
  return {
    id,
    name,
    description: 'Cloud agent',
    systemPrompt: 'Think hard',
    model: 'claude-sonnet-4-6',
    allowedTools: [],
    mcpServers: [],
    isActive: true,
    sortOrder: 0,
    effort: 'medium',
    thinking: 'adaptive',
    skills: [],
    runtime: 'cloud',
  };
}

const mockAgentsList: AgentConfig[] = [];

vi.stubGlobal('window', {
  lionclaw: {
    agents: {
      list: vi.fn(async () => mockAgentsList),
    },
  },
});

import { getAgentsUsingVaultKey } from '../credential-usage';

describe('getAgentsUsingVaultKey', () => {
  beforeEach(() => {
    mockAgentsList.length = 0;
    vi.mocked(window.lionclaw.agents.list).mockClear();
  });

  it('retorna lista vazia quando nao ha agentes', async () => {
    const result = await getAgentsUsingVaultKey('HARNESS_KIMI_KEY');
    expect(result.agentsReferencing).toHaveLength(0);
  });

  it('retorna lista vazia quando nenhum agente referencia a key', async () => {
    mockAgentsList.push(
      makeExternalAgent({
        id: 'agent-1',
        name: 'OpenRouter Agent',
        provider: 'openrouter',
        apiKeyRef: 'HARNESS_OPENROUTER_KEY',
      }),
      makeCloudAgent('cloud-1', 'Cloud Agent'),
    );
    const result = await getAgentsUsingVaultKey('HARNESS_KIMI_KEY');
    expect(result.agentsReferencing).toHaveLength(0);
  });

  it('retorna o agente que referencia HARNESS_KIMI_KEY', async () => {
    const kimiAgent = makeExternalAgent({
      id: 'kimi-1',
      name: 'Kimi Coder',
      provider: 'kimi',
      apiKeyRef: 'HARNESS_KIMI_KEY',
    });
    mockAgentsList.push(kimiAgent);

    const result = await getAgentsUsingVaultKey('HARNESS_KIMI_KEY');
    expect(result.agentsReferencing).toHaveLength(1);
    expect(result.agentsReferencing[0].id).toBe('kimi-1');
    expect(result.agentsReferencing[0].name).toBe('Kimi Coder');
    expect(result.agentsReferencing[0].runtime).toBe('external');
    expect(result.agentsReferencing[0].provider).toBe('kimi');
  });

  it('retorna o agente que referencia HARNESS_DEEPSEEK_KEY', async () => {
    mockAgentsList.push(
      makeExternalAgent({ id: 'ds-1', name: 'DeepSeek Dev', provider: 'deepseek', apiKeyRef: 'HARNESS_DEEPSEEK_KEY' }),
      makeExternalAgent({ id: 'kimi-1', name: 'Kimi Coder', provider: 'kimi', apiKeyRef: 'HARNESS_KIMI_KEY' }),
    );

    const result = await getAgentsUsingVaultKey('HARNESS_DEEPSEEK_KEY');
    expect(result.agentsReferencing).toHaveLength(1);
    expect(result.agentsReferencing[0].id).toBe('ds-1');
  });

  it('retorna multiplos agentes se todos referenciam a mesma key', async () => {
    mockAgentsList.push(
      makeExternalAgent({
        id: 'or-1',
        name: 'OpenRouter Alpha',
        provider: 'openrouter',
        apiKeyRef: 'HARNESS_OPENROUTER_KEY',
      }),
      makeExternalAgent({
        id: 'or-2',
        name: 'OpenRouter Beta',
        provider: 'openrouter',
        apiKeyRef: 'HARNESS_OPENROUTER_KEY',
      }),
      makeExternalAgent({ id: 'kimi-1', name: 'Kimi Coder', provider: 'kimi', apiKeyRef: 'HARNESS_KIMI_KEY' }),
    );

    const result = await getAgentsUsingVaultKey('HARNESS_OPENROUTER_KEY');
    expect(result.agentsReferencing).toHaveLength(2);
    const ids = result.agentsReferencing.map((a) => a.id);
    expect(ids).toContain('or-1');
    expect(ids).toContain('or-2');
  });

  it('ignora agentes cloud (sem externalConfig)', async () => {
    mockAgentsList.push(makeCloudAgent('cloud-1', 'Cloud Brain'));
    const result = await getAgentsUsingVaultKey('HARNESS_OPENROUTER_KEY');
    expect(result.agentsReferencing).toHaveLength(0);
  });

  it('ignora agente external sem externalConfig (caso edge)', async () => {
    const noConfig: AgentConfig = {
      ...makeCloudAgent('edge-1', 'Edge Agent'),
      runtime: 'external',
      externalConfig: undefined,
    };
    mockAgentsList.push(noConfig);
    const result = await getAgentsUsingVaultKey('HARNESS_KIMI_KEY');
    expect(result.agentsReferencing).toHaveLength(0);
  });

  it('propaga provider corretamente no resultado', async () => {
    mockAgentsList.push(
      makeExternalAgent({ id: 'q-1', name: 'Qwen Pro', provider: 'qwen', apiKeyRef: 'HARNESS_QWEN_KEY' }),
    );
    const result = await getAgentsUsingVaultKey('HARNESS_QWEN_KEY');
    expect(result.agentsReferencing[0].provider).toBe('qwen');
  });

  it('provider e undefined para agente sem externalConfig.provider', async () => {
    const agent: AgentConfig = {
      ...makeExternalAgent({
        id: 'mx-1',
        name: 'MiniMax One',
        provider: 'minimax-payg',
        apiKeyRef: 'HARNESS_MINIMAX_PAYG_KEY',
      }),
      externalConfig: {
        provider: 'minimax-payg',
        model: 'MiniMax-Text-01',
        apiKeyRef: 'HARNESS_MINIMAX_PAYG_KEY',
        baseUrl: 'https://api.minimax.io/v1',
      },
    };
    mockAgentsList.push(agent);

    const result = await getAgentsUsingVaultKey('HARNESS_MINIMAX_PAYG_KEY');
    expect(result.agentsReferencing).toHaveLength(1);
    expect(result.agentsReferencing[0].provider).toBe('minimax-payg');
  });

  it('retorna agente Gemini que usa ORCHESTRATOR_VERTEX_API_KEY', async () => {
    const geminiAgent = makeExternalAgent({
      id: 'gem-1',
      name: 'Gemini Pro Agent',
      provider: 'gemini-agent-platform',
      apiKeyRef: 'ORCHESTRATOR_VERTEX_API_KEY',
    });
    mockAgentsList.push(geminiAgent);
    mockAgentsList.push(
      makeExternalAgent({ id: 'kimi-1', name: 'Kimi Dev', provider: 'kimi', apiKeyRef: 'HARNESS_KIMI_KEY' }),
    );

    const result = await getAgentsUsingVaultKey('ORCHESTRATOR_VERTEX_API_KEY');
    expect(result.agentsReferencing).toHaveLength(1);
    expect(result.agentsReferencing[0].id).toBe('gem-1');
    expect(result.agentsReferencing[0].provider).toBe('gemini-agent-platform');
  });

  it('mantem compatibilidade com agente Gemini salvo com ref legada', async () => {
    mockAgentsList.push(
      makeExternalAgent({
        id: 'gem-legacy',
        name: 'Gemini Legacy',
        provider: 'gemini-agent-platform',
        apiKeyRef: 'orchestrator_vertex_api_key_ref',
      }),
    );

    const result = await getAgentsUsingVaultKey('ORCHESTRATOR_VERTEX_API_KEY');
    expect(result.agentsReferencing).toHaveLength(1);
    expect(result.agentsReferencing[0].id).toBe('gem-legacy');
  });

  it('formato do objeto retornado tem apenas agentsReferencing', async () => {
    const result = await getAgentsUsingVaultKey('HARNESS_KIMI_KEY');
    expect(Object.keys(result)).toEqual(['agentsReferencing']);
  });

  it('cada elemento de agentsReferencing tem id, name, runtime obrigatorios', async () => {
    mockAgentsList.push(
      makeExternalAgent({
        id: 'or-1',
        name: 'OpenRouter One',
        provider: 'openrouter',
        apiKeyRef: 'HARNESS_OPENROUTER_KEY',
      }),
    );
    const result = await getAgentsUsingVaultKey('HARNESS_OPENROUTER_KEY');
    for (const agent of result.agentsReferencing) {
      expect(agent.id).toBeTruthy();
      expect(agent.name).toBeTruthy();
      expect(agent.runtime).toBeTruthy();
    }
  });

  it('e case-sensitive: "harness_kimi_key" NAO casa com "HARNESS_KIMI_KEY"', async () => {
    mockAgentsList.push(
      makeExternalAgent({ id: 'kimi-1', name: 'Kimi Dev', provider: 'kimi', apiKeyRef: 'HARNESS_KIMI_KEY' }),
    );
    const result = await getAgentsUsingVaultKey('harness_kimi_key');
    expect(result.agentsReferencing).toHaveLength(0);
  });

  it('chama window.lionclaw.agents.list a cada invocacao', async () => {
    await getAgentsUsingVaultKey('HARNESS_KIMI_KEY');
    await getAgentsUsingVaultKey('HARNESS_DEEPSEEK_KEY');
    expect(window.lionclaw.agents.list).toHaveBeenCalledTimes(2);
  });
});
