import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OrchestratorSelection } from '../orchestrator-selection';

const h = vi.hoisted(() => ({
  queryCalls: [] as Array<Record<string, unknown>>,
  queryText: 'RESULT_TEXT',
  ensureAuthForSDK: vi.fn(async () => {}),
  ensureNodeInPath: vi.fn(() => {}),
  getClaudeCodeExecutablePath: vi.fn(() => '/path/to/cli.js'),
  getBackgroundCwd: vi.fn(() => '/bg/cwd'),
  buildCompatEnv: vi.fn((_sel: OrchestratorSelection) => ({
    PATH: '/usr/bin',
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'subscription-token',
  })),
  createCodexSession: vi.fn(),
  codexSend: vi.fn(async () => ({ status: 'completed', content: 'CODEX_OUT' })),
  codexClose: vi.fn(),
  runClaudePrompt: vi.fn(async () => 'SONNET_FALLBACK_TEXT'),
  cursorRunCalls: [] as Array<Record<string, unknown>>,
  cursorRunResult: { status: 'completed', finalText: 'CURSOR_OUT' } as Record<string, unknown>,
  cursorGetSecret: vi.fn(async () => 'cursor-key' as string | null),
}));

function makeQueryIterable(text: string): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
      yield { type: 'result' };
    },
  };
}

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((opts: Record<string, unknown>) => {
    h.queryCalls.push(opts);
    return makeQueryIterable(h.queryText);
  }),
}));

vi.mock('../pipeline-shared/sdk-bootstrap', () => ({
  ensureAuthForSDK: h.ensureAuthForSDK,
  ensureNodeInPath: h.ensureNodeInPath,
  getClaudeCodeExecutablePath: h.getClaudeCodeExecutablePath,
  getClaudeSdkProcessOptions: vi.fn(() => ({
    pathToClaudeCodeExecutable: '/path/to/cli.js',
    executable: 'node',
  })),
}));

vi.mock('../paths', () => ({
  getBackgroundCwd: h.getBackgroundCwd,
}));

vi.mock('../claude-compat-sdk', () => ({
  buildCompatEnv: h.buildCompatEnv,
}));

vi.mock('../agent-runtime/codex-session-factory', () => ({
  resolveCodexSessionForRun: h.createCodexSession,
}));

vi.mock('../agent-runtime/cursor-sidecar/sidecar-manager', () => ({
  runCursorSidecarExecution: vi.fn(async (opts: Record<string, unknown>) => {
    h.cursorRunCalls.push(opts);
    return h.cursorRunResult;
  }),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: h.cursorGetSecret,
}));

vi.mock('../memory-pipeline', () => ({
  runClaudePrompt: h.runClaudePrompt,
}));

import {
  runSubscriptionPrompt,
  runSubscriptionPromptWithFallback,
  humanizeModelLabel,
} from '../memory-pipeline/oneshot-subscription';

beforeEach(() => {
  vi.clearAllMocks();
  h.queryCalls = [];
  h.queryText = 'RESULT_TEXT';
  h.createCodexSession.mockResolvedValue({ send: h.codexSend, close: h.codexClose });
  h.codexSend.mockResolvedValue({ status: 'completed', content: 'CODEX_OUT' });
  h.cursorRunCalls = [];
  h.cursorRunResult = { status: 'completed', finalText: 'CURSOR_OUT' };
  h.cursorGetSecret.mockResolvedValue('cursor-key');
});

describe('runSubscriptionPrompt — claude-sdk', () => {
  const sel: OrchestratorSelection = {
    runtime: 'claude-sdk',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    source: 'settings',
  };

  it('passes tools:[], allowedTools:[], settingSources:[], cwd, pathToClaudeCodeExecutable + model', async () => {
    const out = await runSubscriptionPrompt(sel, 'hello');

    expect(out).toBe('RESULT_TEXT');
    expect(h.ensureAuthForSDK).toHaveBeenCalledTimes(1);
    expect(h.ensureNodeInPath).toHaveBeenCalledTimes(1);
    expect(h.queryCalls).toHaveLength(1);

    const opts = h.queryCalls[0].options as Record<string, unknown>;
    expect(opts.tools).toEqual([]);
    expect(opts.allowedTools).toEqual([]);
    expect(opts.settingSources).toEqual([]);
    expect(opts.mcpServers).toEqual({});
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.maxTurns).toBe(1);
    expect(opts.model).toBe('claude-opus-4-7');
    expect(opts.cwd).toBe('/bg/cwd');
    expect(opts.pathToClaudeCodeExecutable).toBe('/path/to/cli.js');
    expect(opts.env).toBeUndefined();
  });

  it('does NOT use the raw @anthropic-ai/sdk fallback (no runClaudePrompt)', async () => {
    await runSubscriptionPrompt(sel, 'hello');
    expect(h.runClaudePrompt).not.toHaveBeenCalled();
  });

  it('strips a leading/trailing markdown fence from the drained text', async () => {
    h.queryText = '```json\n{"a":1}\n```';
    const out = await runSubscriptionPrompt(sel, 'hello');
    expect(out).toBe('{"a":1}');
  });
});

describe('runSubscriptionPrompt — claude-compat-sdk (Z.ai / MiniMax)', () => {
  const sel: OrchestratorSelection = {
    runtime: 'claude-compat-sdk',
    provider: 'zai',
    model: 'glm-4.7',
    baseUrl: 'https://api.z.ai/api/anthropic',
    apiKey: 'subscription-token',
    source: 'settings',
  };

  it('passes tools:[], cwd, pathToClaudeCodeExecutable, ensureNodeInPath called, env from buildCompatEnv, model verbatim', async () => {
    const out = await runSubscriptionPrompt(sel, 'hi');

    expect(out).toBe('RESULT_TEXT');
    expect(h.ensureNodeInPath).toHaveBeenCalledTimes(1);
    expect(h.ensureAuthForSDK).not.toHaveBeenCalled();
    expect(h.buildCompatEnv).toHaveBeenCalledWith(sel);

    const opts = h.queryCalls[0].options as Record<string, unknown>;
    expect(opts.tools).toEqual([]);
    expect(opts.allowedTools).toEqual([]);
    expect(opts.settingSources).toEqual([]);
    expect(opts.mcpServers).toEqual({});
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.cwd).toBe('/bg/cwd');
    expect(opts.pathToClaudeCodeExecutable).toBe('/path/to/cli.js');
    expect(opts.model).toBe('glm-4.7');
    const env = opts.env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('subscription-token');
  });
});

describe('runSubscriptionPrompt — codex-sdk', () => {
  const sel: OrchestratorSelection = {
    runtime: 'codex-sdk',
    provider: 'codex',
    model: 'gpt-5.5',
    source: 'settings',
  };

  it('creates a read-only one-shot session, sends the prompt, returns content, closes in finally', async () => {
    const out = await runSubscriptionPrompt(sel, 'summarize');

    expect(out).toBe('CODEX_OUT');
    expect(h.createCodexSession).toHaveBeenCalledTimes(1);
    const call = h.createCodexSession.mock.calls[0][0] as {
      sessionOptions: Record<string, unknown>;
    };
    const opts = call.sessionOptions;
    expect(opts.sandbox).toBe('read-only');
    expect(opts.approvalPolicy).toBe('never');
    expect(opts.reasoningEffort).toBe('low');
    expect(opts.cwd).toBe('/bg/cwd');
    expect(opts.model).toBe('gpt-5.5');
    expect(opts.ownerKind).toBe('chat');
    expect(opts.ownerId).toBe('lionclaw-compaction');
    expect(h.codexSend).toHaveBeenCalledWith('summarize');
    expect(h.codexClose).toHaveBeenCalledTimes(1);
  });

  it('still closes the session when send throws (E8)', async () => {
    h.codexSend.mockRejectedValueOnce(new Error('boom'));
    await expect(runSubscriptionPrompt(sel, 'summarize')).rejects.toThrow('boom');
    expect(h.codexClose).toHaveBeenCalledTimes(1);
  });
});

describe('runSubscriptionPrompt — cursor-sdk', () => {
  const sel: OrchestratorSelection = {
    runtime: 'cursor-sdk',
    provider: 'cursor',
    model: 'composer-2.5',
    source: 'settings',
  };

  it('roda no sidecar guardado sem tools: allowlist [mcp], zero customTools, settingSources []', async () => {
    const out = await runSubscriptionPrompt(sel, 'hello');

    expect(out).toBe('CURSOR_OUT');
    expect(h.cursorRunCalls).toHaveLength(1);
    const config = h.cursorRunCalls[0].config as Record<string, unknown>;
    expect(config.model).toBe('composer-2.5');
    expect(config.apiKey).toBe('cursor-key');
    expect(config.guarded).toBe(true);
    expect(config.allowedTools).toEqual(['mcp']);
    expect(config.customTools).toEqual([]);
    expect(config.settingSources).toEqual([]);
    expect(config.cwd).toBe('/bg/cwd');
    expect(typeof config.storeDir).toBe('string');
    expect(config.prompt as string).toContain('hello');
  });

  it('falha claro sem CURSOR_API_KEY no Vault', async () => {
    h.cursorGetSecret.mockResolvedValue(null);
    await expect(runSubscriptionPrompt(sel, 'hello')).rejects.toThrow(/CURSOR_API_KEY/);
    expect(h.cursorRunCalls).toHaveLength(0);
  });

  it('status cancelled vira erro de timeout (nunca texto vazio silencioso)', async () => {
    h.cursorRunResult = { status: 'cancelled', finalText: '' };
    await expect(runSubscriptionPrompt(sel, 'hello')).rejects.toThrow(/timeout/);
  });

  it('prefere resultText e remove fence de markdown', async () => {
    h.cursorRunResult = {
      status: 'completed',
      finalText: 'ignorado',
      resultText: '```json\n{"a":1}\n```',
    };
    const out = await runSubscriptionPrompt(sel, 'hello');
    expect(out).toBe('{"a":1}');
  });
});

describe('runSubscriptionPrompt — lion-sdk invariant', () => {
  it('throws (Lion is handled by the existing kind:lion-sdk path, never here)', async () => {
    const sel: OrchestratorSelection = {
      runtime: 'lion-sdk',
      provider: 'ollama',
      model: 'qwen3:8b',
      source: 'settings',
    };
    await expect(runSubscriptionPrompt(sel, 'x')).rejects.toThrow(/lion-sdk must not reach/);
  });
});

describe('runSubscriptionPromptWithFallback — sem fallback (SPEC 4.1)', () => {
  it('subscription success -> { text, actualModelLabel } (sem fallbackUsed)', async () => {
    const sel: OrchestratorSelection = {
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      source: 'settings',
    };
    const r = await runSubscriptionPromptWithFallback(sel, 'p');
    expect(r.text).toBe('RESULT_TEXT');
    expect(r.actualModelLabel).toBe('Claude Sonnet 4.6');
    expect('fallbackUsed' in r).toBe(false);
    expect(h.runClaudePrompt).not.toHaveBeenCalled();
  });

  it('subscription throws -> PROPAGA o erro; runClaudePrompt NUNCA e chamado', async () => {
    h.createCodexSession.mockRejectedValueOnce(new Error('codex down'));
    const sel: OrchestratorSelection = {
      runtime: 'codex-sdk',
      provider: 'codex',
      model: 'gpt-5.5',
      source: 'settings',
    };

    await expect(runSubscriptionPromptWithFallback(sel, 'p', { maxTokens: 1234 })).rejects.toThrow(/codex down/);

    expect(h.runClaudePrompt).not.toHaveBeenCalled();
  });
});

describe('humanizeModelLabel', () => {
  it('resolves Claude, GLM compat, and Codex slugs; falls back to the raw slug', () => {
    expect(
      humanizeModelLabel({
        runtime: 'claude-sdk',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        source: 'settings',
      }),
    ).toBe('Claude Sonnet 4.6');
    expect(
      humanizeModelLabel({ runtime: 'claude-compat-sdk', provider: 'zai', model: 'glm-4.7', source: 'settings' }),
    ).toBe('GLM-4.7');
    expect(humanizeModelLabel({ runtime: 'codex-sdk', provider: 'codex', model: 'gpt-5.5', source: 'settings' })).toBe(
      'Codex GPT-5.5',
    );
    expect(humanizeModelLabel({ runtime: 'lion-sdk', provider: 'ollama', model: 'qwen3:8b', source: 'settings' })).toBe(
      'qwen3:8b',
    );
  });
});
