import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../../src/types';
import { pruneStaleRuntimeConfigs, swarmEffectiveModel } from '../agent-runtime/swarm-member-config';

const base: AgentConfig = {
  id: 'swarm-auth-auditor',
  name: 'Auth',
  description: '',
  systemPrompt: '',
  model: 'claude-sonnet-5',
  allowedTools: ['Read'],
  mcpServers: [],
  skills: [],
  squad: 'swarm',
  isActive: true,
  sortOrder: 0,
  effort: 'high',
  thinking: 'adaptive',
  runtime: 'cloud',
  codexConfig: { model: 'gpt-6-astra', sandbox: 'read-only', reasoningEffort: 'high' },
  localConfig: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama-local' },
  externalConfig: {
    provider: 'openrouter',
    protocol: 'openai-compatible',
    baseUrl: 'https://x',
    model: 'ext-model',
    apiKeyRef: 'ref',
  },
};

describe('swarmEffectiveModel', () => {
  it('ignora configs orfas quando o runtime e cloud/zai/minimax/kimi', () => {
    expect(swarmEffectiveModel(base)).toBe('claude-sonnet-5');
    expect(swarmEffectiveModel({ ...base, runtime: 'kimi', model: 'kimi-code/kimi-for-coding' })).toBe(
      'kimi-code/kimi-for-coding',
    );
  });
  it('usa a config aninhada do runtime selecionado', () => {
    expect(swarmEffectiveModel({ ...base, runtime: 'codex' })).toBe('gpt-6-astra');
    expect(swarmEffectiveModel({ ...base, runtime: 'local' })).toBe('llama-local');
    expect(swarmEffectiveModel({ ...base, runtime: 'external' })).toBe('ext-model');
  });
  it('cai no model do agente quando a config do runtime falta', () => {
    expect(swarmEffectiveModel({ ...base, runtime: 'codex', codexConfig: undefined })).toBe('claude-sonnet-5');
  });
});

describe('pruneStaleRuntimeConfigs', () => {
  it('mantem apenas a config do runtime atual', () => {
    const cloud = pruneStaleRuntimeConfigs(base);
    expect(cloud.codexConfig).toBeUndefined();
    expect(cloud.localConfig).toBeUndefined();
    expect(cloud.externalConfig).toBeUndefined();
    const codex = pruneStaleRuntimeConfigs({ ...base, runtime: 'codex' });
    expect(codex.codexConfig?.model).toBe('gpt-6-astra');
    expect(codex.localConfig).toBeUndefined();
  });
});
