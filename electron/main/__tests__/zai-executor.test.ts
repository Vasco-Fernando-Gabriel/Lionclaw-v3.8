import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../db', () => ({
  getSetting: vi.fn(),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(),
}));

import { buildZaiEnv, buildZaiQueryOptions } from '../agent-runtime/zai-executor';
import { PERM_BYPASS_NO_GUARD } from '../agent-runtime/permission-profiles';
import type { AgentExecutionRequest } from '../agent-runtime/types';
import type { AgentQueryConfig } from '../agent-config-resolver';

function makeReq(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    agentId: 'zai-agent',
    prompt: 'Do the thing',
    cwd: '/tmp/project',
    abortController: new AbortController(),
    permission: PERM_BYPASS_NO_GUARD,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
  return {
    model: 'glm-5-turbo',
    systemPrompt: 'You are a GLM harness agent.',
    allowedTools: ['Read', 'Edit'],
    mcpServers: [],
    maxTurns: undefined,
    effort: 'medium',
    thinking: 'adaptive',
    thinkingBudget: undefined,
    runtime: 'zai',
    ...overrides,
  };
}

describe('zai-executor', () => {
  it('buildZaiEnv strips Anthropic env and injects Z.ai compat variables', () => {
    const env = buildZaiEnv('sk-zai', 'glm-5-turbo', 'https://api.z.ai/api/anthropic', {
      PATH: '/bin',
      HOME: '/home/me',
      ANTHROPIC_API_KEY: 'sk-anthropic',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_AUTH_TOKEN: 'old-token',
      API_TIMEOUT_MS: '1000',
    });

    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/home/me');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-zai');
    expect(env.API_TIMEOUT_MS).toBe('3000000');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5-turbo');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5-turbo');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5-turbo');
  });

  it('buildZaiQueryOptions wires SDK options without touching cloud-executor', () => {
    const childAbort = new AbortController();
    const opts = buildZaiQueryOptions(
      makeReq(),
      makeConfig({
        mcpServers: [
          {
            'knowledge-base': {
              command: 'node',
              args: ['/tmp/kb.js'],
              env: { KB_AGENT_ID: 'zai-agent' },
            },
          },
        ],
      }),
      '/tmp/claude-cli.js',
      childAbort,
      'sk-zai',
    );

    expect(opts.pathToClaudeCodeExecutable).toBe('/tmp/claude-cli.js');
    expect(opts.cwd).toBe('/tmp/project');
    expect(opts.model).toBe('glm-5-turbo');
    expect(opts.allowedTools).toEqual(['Read', 'Edit']);
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
    expect(opts.abortController).toBe(childAbort);
    expect(opts.mcpServers).toEqual({
      'knowledge-base': {
        command: 'node',
        args: ['/tmp/kb.js'],
        env: { KB_AGENT_ID: 'zai-agent' },
      },
    });
    expect(String(opts.systemPrompt)).toContain('Runtime: zai');
    expect(String(opts.systemPrompt)).toContain('Modelo selecionado: glm-5-turbo');
    expect((opts.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toBe('sk-zai');
  });
});

describe('zai-executor: CLAUDE_CODE_MAX_CONTEXT_TOKENS (D9)', () => {
  const ZAI_URL = 'https://api.z.ai/api/anthropic';

  it('injeta 1000000 para modelo de janela 1M conhecida (glm-5.2)', () => {
    const env = buildZaiEnv('sk-zai', 'glm-5.2', ZAI_URL, { PATH: '/bin' });
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
  });

  it('injeta a janela real para modelo conhecido < 1M (glm-5.1 -> 200000)', () => {
    const env = buildZaiEnv('sk-zai', 'glm-5.1', ZAI_URL, { PATH: '/bin' });
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('200000');
  });

  it('modelo desconhecido: chave AUSENTE mesmo com override no baseEnv (saneamento)', () => {
    const env = buildZaiEnv('sk-zai', 'totally-unknown-model-x', ZAI_URL, {
      PATH: '/bin',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '999999',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50',
      DISABLE_AUTO_COMPACT: '1',
      DISABLE_COMPACT: '1',
    });
    expect(env.PATH).toBe('/bin');
    expect(env).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
    expect(env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    expect(env).not.toHaveProperty('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE');
    expect(env).not.toHaveProperty('DISABLE_AUTO_COMPACT');
    expect(env).not.toHaveProperty('DISABLE_COMPACT');
  });

  it('modelo conhecido: o valor do LionClaw vence o override herdado', () => {
    const env = buildZaiEnv('sk-zai', 'glm-5.2', ZAI_URL, {
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '123',
    });
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
  });

  it('buildZaiQueryOptions passa options.model IGUAL ao slug (sem sufixo [1m]) e a env da janela', () => {
    const opts = buildZaiQueryOptions(
      makeReq(),
      makeConfig({ model: 'glm-5.2' }),
      '/tmp/claude-cli.js',
      new AbortController(),
      'sk-zai',
    );
    expect(opts.model).toBe('glm-5.2');
    expect((opts.env as Record<string, string>).CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
  });
});
