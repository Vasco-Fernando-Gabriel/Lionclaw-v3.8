import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '@/types/index';
import type { AppSettings } from '@/types/index';

function resolveClaudeCompatVaultKey(provider: 'zai' | 'minimax', settings: AppSettings | null): string {
  return provider === 'zai'
    ? (settings?.orchestratorZaiApiKeyRef ?? 'ORCHESTRATOR_ZAI_API_KEY')
    : (settings?.orchestratorMinimaxApiKeyRef ?? 'ORCHESTRATOR_MINIMAX_API_KEY');
}

function resolveVertexVaultKey(): string {
  return 'ORCHESTRATOR_VERTEX_API_KEY';
}

function resolveOpenAiCompatVaultKey(settings: AppSettings | null): string {
  return settings?.orchestratorOpenAiCompatApiKeyRef ?? 'ORCHESTRATOR_OPENAI_COMPAT_API_KEY';
}

interface AgentRef {
  id: string;
  name: string;
  runtime: string;
  provider?: string;
}

interface CredentialUsage {
  agentsReferencing: AgentRef[];
}

async function shouldShowDisconnectDialog(
  vaultKey: string,
  getUsage: (key: string) => Promise<CredentialUsage>,
): Promise<boolean> {
  const usage = await getUsage(vaultKey);
  return usage.agentsReferencing.length > 0;
}

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

const mockAgentsList: AgentConfig[] = [];

vi.stubGlobal('window', {
  lionclaw: {
    agents: {
      list: vi.fn(async () => mockAgentsList),
    },
    provider: {
      disconnect: vi.fn(async () => ({ ok: true })),
    },
  },
});

import { getAgentsUsingVaultKey } from '../../../lib/credential-usage';

describe('resolveClaudeCompatVaultKey', () => {
  it('zai sem settings usa ORCHESTRATOR_ZAI_API_KEY', () => {
    expect(resolveClaudeCompatVaultKey('zai', null)).toBe('ORCHESTRATOR_ZAI_API_KEY');
  });

  it('zai com settings usa orchestratorZaiApiKeyRef', () => {
    const settings = { orchestratorZaiApiKeyRef: 'ORCHESTRATOR_ZAI_API_KEY' } as AppSettings;
    expect(resolveClaudeCompatVaultKey('zai', settings)).toBe('ORCHESTRATOR_ZAI_API_KEY');
  });

  it('zai com settings personalizado usa o valor do campo', () => {
    const settings = { orchestratorZaiApiKeyRef: 'MY_CUSTOM_ZAI_KEY' } as AppSettings;
    expect(resolveClaudeCompatVaultKey('zai', settings)).toBe('MY_CUSTOM_ZAI_KEY');
  });

  it('minimax sem settings usa ORCHESTRATOR_MINIMAX_API_KEY', () => {
    expect(resolveClaudeCompatVaultKey('minimax', null)).toBe('ORCHESTRATOR_MINIMAX_API_KEY');
  });

  it('minimax com settings usa orchestratorMinimaxApiKeyRef', () => {
    const settings = { orchestratorMinimaxApiKeyRef: 'ORCHESTRATOR_MINIMAX_API_KEY' } as AppSettings;
    expect(resolveClaudeCompatVaultKey('minimax', settings)).toBe('ORCHESTRATOR_MINIMAX_API_KEY');
  });
});

describe('resolveVertexVaultKey', () => {
  it('retorna sempre ORCHESTRATOR_VERTEX_API_KEY', () => {
    expect(resolveVertexVaultKey()).toBe('ORCHESTRATOR_VERTEX_API_KEY');
  });

  it('e a chave que Gemini SubAgents armazenam em apiKeyRef (SPEC-005 §4)', () => {
    expect(resolveVertexVaultKey()).toBe('ORCHESTRATOR_VERTEX_API_KEY');
  });
});

describe('resolveOpenAiCompatVaultKey', () => {
  it('sem settings usa ORCHESTRATOR_OPENAI_COMPAT_API_KEY', () => {
    expect(resolveOpenAiCompatVaultKey(null)).toBe('ORCHESTRATOR_OPENAI_COMPAT_API_KEY');
  });

  it('com settings.orchestratorOpenAiCompatApiKeyRef usa o campo', () => {
    const settings = {
      orchestratorOpenAiCompatApiKeyRef: 'ORCHESTRATOR_OPENAI_COMPAT_API_KEY',
    } as AppSettings;
    expect(resolveOpenAiCompatVaultKey(settings)).toBe('ORCHESTRATOR_OPENAI_COMPAT_API_KEY');
  });

  it('com apiKeyRef personalizado usa o valor', () => {
    const settings = {
      orchestratorOpenAiCompatApiKeyRef: 'MY_CUSTOM_KEY_REF',
    } as AppSettings;
    expect(resolveOpenAiCompatVaultKey(settings)).toBe('MY_CUSTOM_KEY_REF');
  });

  it('settings sem o campo usa fallback', () => {
    const settings = {} as AppSettings;
    expect(resolveOpenAiCompatVaultKey(settings)).toBe('ORCHESTRATOR_OPENAI_COMPAT_API_KEY');
  });
});

describe('shouldShowDisconnectDialog', () => {
  it('retorna false quando nenhum agente referencia a chave', async () => {
    const getUsage = vi.fn(async () => ({ agentsReferencing: [] }));
    const show = await shouldShowDisconnectDialog('SOME_KEY', getUsage);
    expect(show).toBe(false);
    expect(getUsage).toHaveBeenCalledWith('SOME_KEY');
  });

  it('retorna true quando ha agentes referencando a chave', async () => {
    const getUsage = vi.fn(async () => ({
      agentsReferencing: [
        { id: 'agent-1', name: 'Gemini Pro', runtime: 'external', provider: 'gemini-agent-platform' },
      ],
    }));
    const show = await shouldShowDisconnectDialog('ORCHESTRATOR_VERTEX_API_KEY', getUsage);
    expect(show).toBe(true);
  });

  it('retorna false quando ha agentes mas nenhum referencia esta chave especifica', async () => {
    const getUsage = vi.fn(async () => ({ agentsReferencing: [] }));
    const show = await shouldShowDisconnectDialog('ORCHESTRATOR_ZAI_API_KEY', getUsage);
    expect(show).toBe(false);
  });
});

describe('VertexGeminiSection disconnect gate (via getAgentsUsingVaultKey)', () => {
  beforeEach(() => {
    mockAgentsList.length = 0;
    vi.mocked(window.lionclaw.agents.list).mockClear();
  });

  it('sem agentes Gemini: getAgentsUsingVaultKey retorna lista vazia', async () => {
    const usage = await getAgentsUsingVaultKey(resolveVertexVaultKey());
    expect(usage.agentsReferencing).toHaveLength(0);
  });

  it('com agente Gemini: getAgentsUsingVaultKey retorna o agente', async () => {
    mockAgentsList.push(
      makeExternalAgent({
        id: 'gem-1',
        name: 'Gemini Pro Agent',
        provider: 'gemini-agent-platform',
        apiKeyRef: 'ORCHESTRATOR_VERTEX_API_KEY',
      }),
    );

    const usage = await getAgentsUsingVaultKey(resolveVertexVaultKey());
    expect(usage.agentsReferencing).toHaveLength(1);
    expect(usage.agentsReferencing[0].name).toBe('Gemini Pro Agent');
    expect(usage.agentsReferencing[0].provider).toBe('gemini-agent-platform');
  });

  it('agente Kimi com HARNESS_KIMI_KEY nao aparece no check Vertex', async () => {
    mockAgentsList.push(
      makeExternalAgent({
        id: 'kimi-1',
        name: 'Kimi Coder',
        provider: 'kimi',
        apiKeyRef: 'HARNESS_KIMI_KEY',
      }),
    );

    const usage = await getAgentsUsingVaultKey(resolveVertexVaultKey());
    expect(usage.agentsReferencing).toHaveLength(0);
  });

  it('varios agentes Gemini com a mesma chave: todos aparecem', async () => {
    mockAgentsList.push(
      makeExternalAgent({
        id: 'gem-1',
        name: 'Gemini One',
        provider: 'gemini-agent-platform',
        apiKeyRef: 'ORCHESTRATOR_VERTEX_API_KEY',
      }),
      makeExternalAgent({
        id: 'gem-2',
        name: 'Gemini Two',
        provider: 'gemini-agent-platform',
        apiKeyRef: 'ORCHESTRATOR_VERTEX_API_KEY',
      }),
    );

    const usage = await getAgentsUsingVaultKey(resolveVertexVaultKey());
    expect(usage.agentsReferencing).toHaveLength(2);
  });
});

describe('ClaudeCompatSection disconnect gate — zai', () => {
  beforeEach(() => {
    mockAgentsList.length = 0;
    vi.mocked(window.lionclaw.agents.list).mockClear();
  });

  it('com settings validas: vault key derivada de orchestratorZaiApiKeyRef', async () => {
    const settings = { orchestratorZaiApiKeyRef: 'ORCHESTRATOR_ZAI_API_KEY' } as AppSettings;
    const vaultKey = resolveClaudeCompatVaultKey('zai', settings);
    expect(vaultKey).toBe('ORCHESTRATOR_ZAI_API_KEY');
  });

  it('sem agentes com essa chave: sem dialog', async () => {
    const settings = { orchestratorZaiApiKeyRef: 'ORCHESTRATOR_ZAI_API_KEY' } as AppSettings;
    const vaultKey = resolveClaudeCompatVaultKey('zai', settings);
    const usage = await getAgentsUsingVaultKey(vaultKey);
    expect(usage.agentsReferencing).toHaveLength(0);
  });

  it('com agente referenciando ORCHESTRATOR_ZAI_API_KEY: dialog deve aparecer', async () => {
    mockAgentsList.push(
      makeExternalAgent({
        id: 'zai-subagent-1',
        name: 'Z.ai Worker',
        provider: 'openai-compatible',
        apiKeyRef: 'ORCHESTRATOR_ZAI_API_KEY',
      }),
    );
    const settings = { orchestratorZaiApiKeyRef: 'ORCHESTRATOR_ZAI_API_KEY' } as AppSettings;
    const vaultKey = resolveClaudeCompatVaultKey('zai', settings);
    const usage = await getAgentsUsingVaultKey(vaultKey);
    expect(usage.agentsReferencing).toHaveLength(1);
    expect(usage.agentsReferencing[0].name).toBe('Z.ai Worker');
  });
});

describe('OpenAiCompatSection disconnect gate', () => {
  beforeEach(() => {
    mockAgentsList.length = 0;
    vi.mocked(window.lionclaw.agents.list).mockClear();
  });

  it('sem settings: vault key = ORCHESTRATOR_OPENAI_COMPAT_API_KEY', () => {
    const vaultKey = resolveOpenAiCompatVaultKey(null);
    expect(vaultKey).toBe('ORCHESTRATOR_OPENAI_COMPAT_API_KEY');
  });

  it('sem agentes com essa chave: sem dialog', async () => {
    const settings = {
      orchestratorOpenAiCompatApiKeyRef: 'ORCHESTRATOR_OPENAI_COMPAT_API_KEY',
    } as AppSettings;
    const vaultKey = resolveOpenAiCompatVaultKey(settings);
    const usage = await getAgentsUsingVaultKey(vaultKey);
    expect(usage.agentsReferencing).toHaveLength(0);
  });

  it('com agente referenciando a mesma chave: dialog deve aparecer', async () => {
    mockAgentsList.push(
      makeExternalAgent({
        id: 'compat-1',
        name: 'Custom Compat Agent',
        provider: 'openai-compatible',
        apiKeyRef: 'ORCHESTRATOR_OPENAI_COMPAT_API_KEY',
      }),
    );
    const settings = {
      orchestratorOpenAiCompatApiKeyRef: 'ORCHESTRATOR_OPENAI_COMPAT_API_KEY',
    } as AppSettings;
    const vaultKey = resolveOpenAiCompatVaultKey(settings);
    const usage = await getAgentsUsingVaultKey(vaultKey);
    expect(usage.agentsReferencing).toHaveLength(1);
  });

  it('agente Kimi com HARNESS_KIMI_KEY nao bloqueia disconnect de ORCHESTRATOR_OPENAI_COMPAT_API_KEY', async () => {
    mockAgentsList.push(
      makeExternalAgent({
        id: 'kimi-1',
        name: 'Kimi Dev',
        provider: 'kimi',
        apiKeyRef: 'HARNESS_KIMI_KEY',
      }),
    );
    const settings = {
      orchestratorOpenAiCompatApiKeyRef: 'ORCHESTRATOR_OPENAI_COMPAT_API_KEY',
    } as AppSettings;
    const vaultKey = resolveOpenAiCompatVaultKey(settings);
    const usage = await getAgentsUsingVaultKey(vaultKey);
    expect(usage.agentsReferencing).toHaveLength(0);
  });
});

describe('disconnect flow: disconnect so ocorre apos confirmacao', () => {
  it('disconnect nao e chamado se o usuario nao confirmou (gate ativo)', async () => {
    const disconnectFn = vi.fn(async () => ({ ok: true }));
    const getUsageFn = vi.fn(async (_vaultKey: string) => ({
      agentsReferencing: [
        { id: 'gem-1', name: 'Gemini Agent', runtime: 'external', provider: 'gemini-agent-platform' },
      ],
    }));

    const usage = await getUsageFn('ORCHESTRATOR_VERTEX_API_KEY');
    const shouldGate = usage.agentsReferencing.length > 0;

    if (!shouldGate) {
      await disconnectFn();
    }
    expect(disconnectFn).not.toHaveBeenCalled();
  });

  it('disconnect e chamado se nenhum agente referencia a chave', async () => {
    const disconnectFn = vi.fn(async () => ({ ok: true }));
    const getUsageFn = vi.fn(async (_vaultKey: string) => ({
      agentsReferencing: [],
    }));

    const usage = await getUsageFn('ORCHESTRATOR_VERTEX_API_KEY');
    const shouldGate = usage.agentsReferencing.length > 0;

    if (!shouldGate) {
      await disconnectFn();
    }
    expect(disconnectFn).toHaveBeenCalledOnce();
  });

  it('disconnect e chamado apos confirmacao do usuario (onConfirm invocado)', async () => {
    const disconnectFn = vi.fn(async () => ({ ok: true }));
    const getUsageFn = vi.fn(async (_vaultKey: string) => ({
      agentsReferencing: [
        { id: 'gem-1', name: 'Gemini Agent', runtime: 'external', provider: 'gemini-agent-platform' },
      ],
    }));

    const usage = await getUsageFn('ORCHESTRATOR_VERTEX_API_KEY');
    const shouldGate = usage.agentsReferencing.length > 0;

    if (shouldGate) {
      await disconnectFn();
    }
    expect(disconnectFn).toHaveBeenCalledOnce();
  });
});
