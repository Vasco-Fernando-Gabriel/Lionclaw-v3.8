import { describe, it, expect } from 'vitest';
import { resolveContextWindow, formatContextWindow } from '../agent-helpers';
import type { AgentConfig } from '../../types/index';

function makeExternalAgent(options: {
  provider: 'openrouter' | 'openai' | 'openai-compatible';
  model: string;
  contextWindow?: number;
}): AgentConfig {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    description: '',
    systemPrompt: '',
    model: 'sonnet',
    allowedTools: [],
    mcpServers: [],
    isActive: true,
    sortOrder: 0,
    effort: 'medium',
    thinking: 'adaptive',
    skills: [],
    runtime: 'external',
    externalConfig: {
      provider: options.provider,
      model: options.model,
      apiKeyRef: 'HARNESS_OPENROUTER_KEY',
      baseUrl: 'https://openrouter.ai/api/v1',
      contextWindow: options.contextWindow,
    },
  };
}

function makeCloudAgent(): AgentConfig {
  return {
    id: 'cloud-agent',
    name: 'Cloud Agent',
    description: '',
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
  };
}

function makeLocalAgent(): AgentConfig {
  return {
    id: 'local-agent',
    name: 'Local Agent',
    description: '',
    systemPrompt: '',
    model: 'llama3.1',
    allowedTools: [],
    mcpServers: [],
    isActive: true,
    sortOrder: 0,
    effort: 'medium',
    thinking: 'adaptive',
    skills: [],
    runtime: 'local',
    localConfig: {
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    },
  };
}

describe('resolveContextWindow', () => {
  it('retorna 1_000_000 para OpenRouter + deepseek/deepseek-v4-pro', () => {
    const agent = makeExternalAgent({ provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' });
    expect(resolveContextWindow(agent)).toBe(1_000_000);
  });

  it('retorna 1_000_000 para OpenRouter + deepseek/deepseek-v4-flash', () => {
    const agent = makeExternalAgent({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' });
    expect(resolveContextWindow(agent)).toBe(1_000_000);
  });

  it('retorna 256_000 para OpenRouter + moonshotai/kimi-k2.6', () => {
    const agent = makeExternalAgent({ provider: 'openrouter', model: 'moonshotai/kimi-k2.6' });
    expect(resolveContextWindow(agent)).toBe(256_000);
  });

  it('retorna 256_000 para OpenRouter + moonshotai/kimi-k2-thinking', () => {
    const agent = makeExternalAgent({ provider: 'openrouter', model: 'moonshotai/kimi-k2-thinking' });
    expect(resolveContextWindow(agent)).toBe(256_000);
  });

  it('retorna 262_000 para OpenRouter + qwen/qwen3.6-max-preview', () => {
    const agent = makeExternalAgent({ provider: 'openrouter', model: 'qwen/qwen3.6-max-preview' });
    expect(resolveContextWindow(agent)).toBe(262_000);
  });

  it('retorna 262_000 para OpenRouter + qwen/qwen3.6-plus', () => {
    const agent = makeExternalAgent({ provider: 'openrouter', model: 'qwen/qwen3.6-plus' });
    expect(resolveContextWindow(agent)).toBe(262_000);
  });

  it('retorna 196_608 para OpenRouter + minimax/minimax-m2.7', () => {
    const agent = makeExternalAgent({ provider: 'openrouter', model: 'minimax/minimax-m2.7' });
    expect(resolveContextWindow(agent)).toBe(196_608);
  });

  it('retorna 1_000_000 para OpenRouter + minimax/minimax-m1', () => {
    const agent = makeExternalAgent({ provider: 'openrouter', model: 'minimax/minimax-m1' });
    expect(resolveContextWindow(agent)).toBe(1_000_000);
  });

  it('retorna 1_000_000 para OpenAI + gpt-5.5', () => {
    const agent = makeExternalAgent({ provider: 'openai', model: 'gpt-5.5' });
    expect(resolveContextWindow(agent)).toBe(1_000_000);
  });

  it('retorna 1_000_000 para OpenAI + gpt-5.5-pro', () => {
    const agent = makeExternalAgent({ provider: 'openai', model: 'gpt-5.5-pro' });
    expect(resolveContextWindow(agent)).toBe(1_000_000);
  });

  it('retorna null para OpenRouter com slug nao catalogado', () => {
    const agent = makeExternalAgent({ provider: 'openrouter', model: 'unknown/future-model-v99' });
    expect(resolveContextWindow(agent)).toBeNull();
  });

  it('retorna contextWindow informado pelo usuario para provider openai-compatible', () => {
    const agent = makeExternalAgent({
      provider: 'openai-compatible',
      model: 'my-custom-model',
      contextWindow: 128_000,
    });
    expect(resolveContextWindow(agent)).toBe(128_000);
  });

  it('retorna null para Custom sem contextWindow informado', () => {
    const agent = makeExternalAgent({
      provider: 'openai-compatible',
      model: 'my-custom-model',
    });
    expect(resolveContextWindow(agent)).toBeNull();
  });

  it('retorna null para agente cloud', () => {
    expect(resolveContextWindow(makeCloudAgent())).toBeNull();
  });

  it('retorna null para agente local', () => {
    expect(resolveContextWindow(makeLocalAgent())).toBeNull();
  });

  it('retorna null para agente external sem externalConfig', () => {
    const agent: AgentConfig = {
      ...makeCloudAgent(),
      runtime: 'external',
      externalConfig: undefined,
    };
    expect(resolveContextWindow(agent)).toBeNull();
  });
});

describe('formatContextWindow', () => {
  it('1_000_000 => "1M tokens"', () => {
    expect(formatContextWindow(1_000_000)).toBe('1M tokens');
  });

  it('1_500_000 => "1.5M tokens"', () => {
    expect(formatContextWindow(1_500_000)).toBe('1.5M tokens');
  });

  it('2_000_000 => "2M tokens"', () => {
    expect(formatContextWindow(2_000_000)).toBe('2M tokens');
  });

  it('256_000 => "256k tokens"', () => {
    expect(formatContextWindow(256_000)).toBe('256k tokens');
  });

  it('196_608 => "197k tokens" (arredondamento para cima)', () => {
    expect(formatContextWindow(196_608)).toBe('197k tokens');
  });

  it('128_000 => "128k tokens"', () => {
    expect(formatContextWindow(128_000)).toBe('128k tokens');
  });

  it('262_000 => "262k tokens"', () => {
    expect(formatContextWindow(262_000)).toBe('262k tokens');
  });

  it('1_000 => "1k tokens"', () => {
    expect(formatContextWindow(1_000)).toBe('1k tokens');
  });

  it('512 => "512 tokens" (abaixo de 1k, retorna numero bruto)', () => {
    expect(formatContextWindow(512)).toBe('512 tokens');
  });

  it('0 => "0 tokens"', () => {
    expect(formatContextWindow(0)).toBe('0 tokens');
  });

  it('1 => "1 tokens"', () => {
    expect(formatContextWindow(1)).toBe('1 tokens');
  });

  it('999 => "999 tokens"', () => {
    expect(formatContextWindow(999)).toBe('999 tokens');
  });

  it('1_499 => "1k tokens" (arredondamento Math.round)', () => {
    expect(formatContextWindow(1_499)).toBe('1k tokens');
  });

  it('1_500 => "2k tokens" (arredondamento Math.round)', () => {
    expect(formatContextWindow(1_500)).toBe('2k tokens');
  });
});
