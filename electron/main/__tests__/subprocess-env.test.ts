
import { describe, it, expect } from 'vitest';
import {
  SUBPROCESS_ENV_STRIPPED_KEYS,
  SUBPROCESS_ENV_STRIPPED_PREFIXES,
  isStrippedSubprocessEnvKey,
  sanitizeSubprocessEnv,
} from '../agent-runtime/subprocess-env';
import { buildClaudeQueryOptions } from '../agent-runtime/cloud-executor';
import { buildZaiEnv } from '../agent-runtime/zai-executor';
import { buildMinimaxTpEnv } from '../agent-runtime/minimax-tokenplan-executor';
import { gateCommandEnv } from '../dynamic-workflows/workflow-gates';
import type { AgentExecutionRequest } from '../agent-runtime/types';
import type { AgentQueryConfig } from '../agent-config-resolver';

const DEV_ENV: NodeJS.ProcessEnv = {
  PATH: '/bin',
  HOME: '/home/x',
  NODE_ENV: 'development',
  ELECTRON_RENDERER_URL: 'http://localhost:5173',
  ELECTRON_RUN_AS_NODE: '1',
  DEBUG: 'electron*',
  VITE_DEV_SERVER_URL: 'http://localhost:5173',
  VITE_SOMETHING: '1',
  ANTHROPIC_API_KEY: 'sk',
  CUSTOM_VAR: 'keep',
};

describe('subprocess-env (L1.7): lista fechada', () => {
  it('a lista fechada e exatamente NODE_ENV, ELECTRON_RENDERER_URL, ELECTRON_RUN_AS_NODE, DEBUG + prefixo VITE_', () => {
    expect([...SUBPROCESS_ENV_STRIPPED_KEYS]).toEqual(['NODE_ENV', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'DEBUG']);
    expect([...SUBPROCESS_ENV_STRIPPED_PREFIXES]).toEqual(['VITE_']);
    expect(isStrippedSubprocessEnvKey('VITE_X')).toBe(true);
    expect(isStrippedSubprocessEnvKey('NODE_ENV')).toBe(true);
    expect(isStrippedSubprocessEnvKey('NODE_OPTIONS')).toBe(false);
    expect(isStrippedSubprocessEnvKey('PATH')).toBe(false);
  });

  it('sanitizeSubprocessEnv remove as chaves, preserva o resto e NUNCA forca NODE_ENV=production', () => {
    const out = sanitizeSubprocessEnv(DEV_ENV);
    expect(out).toEqual({ PATH: '/bin', HOME: '/home/x', ANTHROPIC_API_KEY: 'sk', CUSTOM_VAR: 'keep' });
    expect('NODE_ENV' in out).toBe(false);
    expect(DEV_ENV.NODE_ENV).toBe('development');
  });
});

describe('subprocess-env (L1.7): aplicado nos spawns', () => {
  it('buildClaudeQueryOptions (cloud: pipelines/harness/enrich e nodes de workflow) passa `env` sanitizado ao SDK', () => {
    const saved = { ...process.env };
    Object.assign(process.env, { NODE_ENV: 'development', VITE_PROBE: '1', DEBUG: 'x' });
    try {
      const req = {
        agentId: 'a',
        prompt: 'p',
        cwd: '/w',
        abortController: new AbortController(),
        permission: { mode: 'default', dangerouslySkipPermissions: false },
      } as unknown as AgentExecutionRequest;
      const config: AgentQueryConfig = {
        model: 'claude-sonnet-4-6',
        systemPrompt: '',
        allowedTools: ['Read'],
        mcpServers: [],
        maxTurns: undefined,
        effort: 'medium',
        thinking: 'adaptive',
        thinkingBudget: undefined,
        runtime: 'cloud',
      };
      const opts = buildClaudeQueryOptions(req, config, '/cli', new AbortController());
      const env = opts.env as NodeJS.ProcessEnv;
      expect(env).toBeDefined();
      expect('NODE_ENV' in env).toBe(false);
      expect('VITE_PROBE' in env).toBe(false);
      expect('DEBUG' in env).toBe(false);
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('buildZaiEnv / buildMinimaxTpEnv filtram as chaves da copia do env', () => {
    const zai = buildZaiEnv('k', 'glm-5.2', 'https://zai', DEV_ENV);
    const mm = buildMinimaxTpEnv('k', 'MiniMax-M2.7', 'https://mm', DEV_ENV);
    for (const env of [zai, mm]) {
      expect('NODE_ENV' in env).toBe(false);
      expect('ELECTRON_RENDERER_URL' in env).toBe(false);
      expect('ELECTRON_RUN_AS_NODE' in env).toBe(false);
      expect('DEBUG' in env).toBe(false);
      expect(Object.keys(env).some((k) => k.startsWith('VITE_'))).toBe(false);
      expect(env.CUSTOM_VAR).toBe('keep');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('k');
    }
  });

  it('gateCommandEnv (checks de gate/green-check) = git nao-interativo SEM as vars de dev', () => {
    const env = gateCommandEnv(DEV_ENV);
    expect('NODE_ENV' in env).toBe(false);
    expect('VITE_SOMETHING' in env).toBe(false);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.CUSTOM_VAR).toBe('keep');
  });
});
