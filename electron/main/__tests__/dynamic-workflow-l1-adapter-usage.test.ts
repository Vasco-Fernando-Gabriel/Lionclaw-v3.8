
import { describe, it, expect } from 'vitest';
import {
  runNodeAgent,
  readPartialUsageFromError,
  type ClaudeCompatBackend,
  type WorkflowAdapterDeps,
} from '../dynamic-workflows/workflow-agent-adapter';
import {
  createSdkUsageTap,
  runClaudeCompatNode,
} from '../dynamic-workflows/workflow-claude-compat-executor';
import type { AgentQueryConfig } from '../agent-config-resolver';

const ROOT = process.cwd();

function fakeResolved(over: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
  return {
    model: 'claude-sonnet-4-6',
    systemPrompt: 'x',
    allowedTools: ['Read', 'Grep'],
    mcpServers: [],
    maxTurns: 80,
    effort: 'medium',
    thinking: 'adaptive',
    thinkingBudget: undefined,
    runtime: 'cloud',
    ...over,
  };
}

function baseInput(abortSignal?: AbortSignal) {
  return {
    runId: 'r1',
    agentId: 'a1',
    grants: { nodeId: 'n1', agentId: 'a1', access: 'read-only' as const, allowedTools: ['Read', 'Grep'] },
    workspace: { runId: 'r1', workspaceRoot: ROOT, cwd: ROOT },
    prompt: 'p',
    ...(abortSignal ? { abortSignal } : {}),
  };
}

async function* stream(messages: Array<Record<string, unknown>>, thenThrow?: Error): AsyncGenerator<Record<string, unknown>> {
  for (const m of messages) yield m;
  if (thenThrow) throw thenThrow;
}

describe('createSdkUsageTap (L1.1)', () => {
  it('soma usage por message.id (max por campo) e aplica o piso do result; snapshot sobrevive ao throw', async () => {
    const tap = createSdkUsageTap();
    const wrapped = tap.wrap(
      stream(
        [
          { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50 } } },
          { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 50 } } },
          { type: 'assistant', message: { id: 'm2', usage: { input_tokens: 200, output_tokens: 20 } } },
          { type: 'result', subtype: 'error_max_turns', is_error: true, usage: { input_tokens: 300, output_tokens: 60, cache_read_input_tokens: 50 }, total_cost_usd: 0.9 },
        ],
        new Error('Claude Code returned an error result: Reached maximum number of turns (80)'),
      ),
    );
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const m of wrapped) seen.push(String(m.type));
      })(),
    ).rejects.toThrow(/maximum number of turns/);
    expect(seen).toEqual(['assistant', 'assistant', 'assistant', 'result']);
    expect(tap.snapshot()).toEqual({ inputTokens: 350, outputTokens: 60, cacheReadTokens: 50, cacheCreationTokens: 0, apiRequests: 2 });
  });

  it('sem usage visto => snapshot null', async () => {
    const tap = createSdkUsageTap();
    for await (const _m of tap.wrap(stream([{ type: 'system', subtype: 'init' }]))) void _m;
    expect(tap.snapshot()).toBeNull();
  });
});

describe('runClaudeCompatNode anexa partialUsage ao erro do iterador (L1.1)', () => {
  it('erro de max turns apos result com usage => err.partialUsage com tokens e costUsd calculado', async () => {
    const err = new Error('Claude Code returned an error result: Reached maximum number of turns (80)');
    const pending = runClaudeCompatNode(
      {
        runtime: 'cloud',
        config: fakeResolved(),
        prompt: 'p',
        cwd: ROOT,
        allowedTools: ['Read'],
        mcpServers: [],
        canUseTool: async () => ({ behavior: 'allow' }),
        abortSignal: new AbortController().signal,
      },
      {
        query: () =>
          stream(
            [
              { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 1000, output_tokens: 100 } } },
              { type: 'result', subtype: 'error_max_turns', is_error: true, usage: { input_tokens: 1000, output_tokens: 100 } },
            ],
            err,
          ),
        buildCloudOptions: () => ({}),
        processStream: async (q) => {
          for await (const _m of q) void _m;
          return { output: '', metrics: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolUses: 0, apiRequests: 0 } };
        },
        calculateCost: (_m, inT, outT) => inT * 0.001 + outT * 0.002,
        resolveCliPath: () => '/cli',
      },
    );
    await expect(pending).rejects.toBe(err);
    expect(readPartialUsageFromError(err)).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 1.2,
      apiRequests: 1,
    });
  });
});

describe('runNodeAgent: custo do node falho e `aborted` (L1.1/L1.3)', () => {
  it('backend lanca COM partialUsage => cost real (known) no NodeRunResult de falha', async () => {
    const backend: ClaudeCompatBackend = async () => {
      const e = new Error('Claude Code returned an error result: Reached maximum number of turns (80)') as Error & { partialUsage?: unknown };
      e.partialUsage = { inputTokens: 5000, outputTokens: 300, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.42, apiRequests: 7 };
      throw e;
    };
    const deps: WorkflowAdapterDeps = { resolveConfig: async () => fakeResolved(), claudeCompat: backend };
    const r = await runNodeAgent(baseInput(), deps);
    expect(r.ok).toBe(false);
    expect(r.cost).toMatchObject({ inputTokens: 5000, outputTokens: 300, costUsd: 0.42, apiRequests: 7 });
    expect(r.cost?.costStatus).not.toBe('unknown');
    expect(r.aborted).toBe(false);
  });

  it('backend lanca SEM usage => costStatus unknown (error-without-usage), nunca $0 conhecido', async () => {
    const backend: ClaudeCompatBackend = async () => {
      throw new Error('boom');
    };
    const deps: WorkflowAdapterDeps = { resolveConfig: async () => fakeResolved(), claudeCompat: backend };
    const r = await runNodeAgent(baseInput(), deps);
    expect(r.ok).toBe(false);
    expect(r.cost?.costStatus).toBe('unknown');
    expect(r.cost?.costUnknownReason).toBe('error-without-usage');
  });

  it('abortSignal acionado durante o backend => aborted:true no resultado (sucesso e falha)', async () => {
    const abort = new AbortController();
    const okBackend: ClaudeCompatBackend = async () => {
      abort.abort();
      return { output: 'parcial', model: 'claude-sonnet-4-6', inputTokens: 1, outputTokens: 1 };
    };
    const deps: WorkflowAdapterDeps = { resolveConfig: async () => fakeResolved(), claudeCompat: okBackend };
    const r = await runNodeAgent(baseInput(abort.signal), deps);
    expect(r.ok).toBe(true);
    expect(r.aborted).toBe(true);

    const abort2 = new AbortController();
    const failBackend: ClaudeCompatBackend = async () => {
      abort2.abort();
      throw new Error('The operation was aborted');
    };
    const r2 = await runNodeAgent(baseInput(abort2.signal), { resolveConfig: async () => fakeResolved(), claudeCompat: failBackend });
    expect(r2.ok).toBe(false);
    expect(r2.aborted).toBe(true);
    expect(r2.failureClass).toBe('cancelled');
  });

  it('effectiveMaxTurns chega ao backend claude-compat como maxTurns; ausente => chave ausente', async () => {
    const seen: Array<number | undefined> = [];
    const backend: ClaudeCompatBackend = async (input) => {
      seen.push(input.maxTurns);
      return { output: 'ok', model: input.model };
    };
    const deps: WorkflowAdapterDeps = { resolveConfig: async () => fakeResolved(), claudeCompat: backend };
    await runNodeAgent({ ...baseInput(), effectiveMaxTurns: 150 }, deps);
    await runNodeAgent(baseInput(), deps);
    expect(seen).toEqual([150, undefined]);
  });
});
