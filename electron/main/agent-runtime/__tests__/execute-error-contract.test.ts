
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';


vi.mock('../../codex-runtime/errors', () => {
  class CodexAuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'CodexAuthError';
    }
  }
  class CodexUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'CodexUnavailableError';
    }
  }
  class CodexCapabilityUnsupportedError extends Error {}
  return { CodexAuthError, CodexUnavailableError, CodexCapabilityUnsupportedError };
});

const cloudRun = vi.fn();
vi.mock('../cloud-executor', () => ({ cloudExecutor: { run: (...a: unknown[]) => cloudRun(...a) } }));
vi.mock('../local-executor', () => ({ localExecutor: { run: vi.fn() } }));
vi.mock('../external-executor', () => ({ externalExecutor: { run: vi.fn() } }));
vi.mock('../codex-executor', () => ({ codexExecutor: { run: vi.fn() } }));
vi.mock('../zai-executor', () => ({ zaiExecutor: { run: vi.fn() } }));
vi.mock('../minimax-tokenplan-executor', () => ({ minimaxTokenplanExecutor: { run: vi.fn() } }));
vi.mock('../kimi-executor', () => ({ kimiExecutor: { run: vi.fn() } }));

vi.mock('../../agent-config-resolver', () => ({
  resolveAgentQueryConfig: vi.fn(async () => ({
    runtime: 'cloud',
    model: 'claude-sonnet-4-5',
    systemPrompt: '',
    allowedTools: [],
    mcpServers: [],
  })),
}));

import { executeAgent } from '../execute';
import { CodexAuthError, CodexUnavailableError } from '../../codex-runtime/errors';
import { KimiAuthError } from '../kimi-availability';
import { PipelinePausedError } from '../types';
import { TypedProviderError } from '../llm-error';
import type { AgentExecutionRequest, AgentExecutionResult } from '../types';

function makeReq(): AgentExecutionRequest {
  return {
    agentId: 'agent-x',
    prompt: 'oi',
    cwd: '/tmp',
    abortController: new AbortController(),
    permission: { mode: 'default', dangerouslySkipPermissions: false },
  };
}

function makeResult(extra?: Partial<AgentExecutionResult>): AgentExecutionResult {
  return {
    output: 'resposta',
    metrics: {
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0,
      toolUses: 0, apiRequests: 1, costUsd: 0, durationMs: 5,
    },
    model: 'claude-sonnet-4-5',
    runtime: 'cloud',
    provider: 'anthropic',
    ...extra,
  };
}

beforeEach(() => {
  cloudRun.mockReset();
});

describe('AC-B5 [INV] — allowlist de re-throw CRU no catch do execute.ts', () => {
  it('AC-B5: CodexUnavailableError re-lanca a MESMA instancia (instanceof verdadeiro no boundary)', async () => {
    const raw = new CodexUnavailableError('codex app-server exited (code=null)');
    cloudRun.mockRejectedValueOnce(raw);
    let caught: unknown;
    try { await executeAgent(makeReq()); } catch (e) { caught = e; }
    expect(caught).toBe(raw);
    expect(caught instanceof CodexUnavailableError).toBe(true);
    expect(caught instanceof TypedProviderError).toBe(false);
  });

  it('AC-B5: CodexAuthError re-lanca CRU', async () => {
    const raw = new CodexAuthError('Codex auth required');
    cloudRun.mockRejectedValueOnce(raw);
    await expect(executeAgent(makeReq())).rejects.toBe(raw);
  });

  it('AC-B5: KimiAuthError re-lanca CRU', async () => {
    const raw = new KimiAuthError('Kimi auth required');
    cloudRun.mockRejectedValueOnce(raw);
    await expect(executeAgent(makeReq())).rejects.toBe(raw);
  });

  it('AC-B5: PipelinePausedError re-lanca CRU', async () => {
    const raw = new PipelinePausedError('paused', 'codex-auth');
    cloudRun.mockRejectedValueOnce(raw);
    await expect(executeAgent(makeReq())).rejects.toBe(raw);
  });

  it('AC-B5: TypedProviderError re-lanca CRU (sem re-embrulhar)', async () => {
    const raw = new TypedProviderError('LLM-QUOTA');
    cloudRun.mockRejectedValueOnce(raw);
    await expect(executeAgent(makeReq())).rejects.toBe(raw);
  });

  it('AC-B5: erro CRU de provider vira TypedProviderError com message/stack em cause', async () => {
    const raw = new Error('HTTP 429: rate limit exceeded');
    cloudRun.mockRejectedValueOnce(raw);
    let caught: unknown;
    try { await executeAgent(makeReq()); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(TypedProviderError);
    const typed = caught as TypedProviderError;
    expect(typed.code).toBe('LLM-RATE-429');
    expect(typed.cause).toBe(raw);
    expect((typed.cause as Error).message).toBe(raw.message);
    expect((typed.cause as Error).stack).toBe(raw.stack);
  });

  it('AC-B5 [INV]: o despacho (switch) do execute.ts e byte-identico ao baseline (so o catch e novo)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'execute.ts'), 'utf-8');
    const baselineSwitch = `    switch (config.runtime) {
      case 'cloud':
        return await cloudExecutor.run(wrappedReq, config);

      case 'local':
        return await localExecutor.run(wrappedReq, config);

      case 'external':
        return await externalExecutor.run(wrappedReq, config);

      case 'codex':
        return await codexExecutor.run(wrappedReq, config);

      case 'zai':
        return await zaiExecutor.run(wrappedReq, config);

      case 'minimax-tp':
        return await minimaxTokenplanExecutor.run(wrappedReq, config);

      case 'kimi':
        return await kimiExecutor.run(wrappedReq, config);

      case 'grok':
        return await grokExecutor.run(wrappedReq, config);

      default: {
        // Exhaustiveness guard: if a new runtime is added to AgentConfig['runtime']
        // but not handled here, TypeScript will produce a compile error.
        const _exhaustive: never = config.runtime;
        throw new Error(\`Runtime nao suportado: \${String(_exhaustive)}\`);
      }
    }`;
    expect(source).toContain(baselineSwitch);
    expect(source).toContain('} finally {\n    watchdog.stop();\n  }');
    expect(source).toContain('err instanceof CodexUnavailableError ||');
    expect(source).toContain('err instanceof CodexAuthError ||');
    expect(source).toContain('err instanceof PipelinePausedError ||');
    expect(source).toContain('err instanceof TypedProviderError');
  });
});

describe('AC-B6 — campos novos do contrato sao opcionais', () => {
  it('AC-B6: resultado SEM `error` passa intocado pelo executeAgent (caller que ignora nao muda)', async () => {
    const result = makeResult();
    cloudRun.mockResolvedValueOnce(result);
    const out = await executeAgent(makeReq());
    expect(out).toBe(result);
    expect(out.error).toBeUndefined();
  });

  it('AC-B6: resultado COM `error` (LLM-EMPTY) passa intocado', async () => {
    const result = makeResult({
      output: '',
      error: {
        code: 'LLM-EMPTY',
        category: 'empty-response',
        userMessage: 'O agente terminou sem resposta.',
        suggestedAction: 'Tente de novo; se persistir, troque de modelo ou verifique o provider.',
      },
    });
    cloudRun.mockResolvedValueOnce(result);
    const out = await executeAgent(makeReq());
    expect(out).toBe(result);
    expect(out.error?.code).toBe('LLM-EMPTY');
  });
});
