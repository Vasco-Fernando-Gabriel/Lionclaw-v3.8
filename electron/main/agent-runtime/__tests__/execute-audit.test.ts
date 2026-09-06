
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../cloud-executor', () => ({ cloudExecutor: { run: (...a: unknown[]) => cloudRun(...a) } }));
vi.mock('../local-executor', () => ({ localExecutor: { run: vi.fn() } }));
vi.mock('../external-executor', () => ({ externalExecutor: { run: vi.fn() } }));
vi.mock('../codex-executor', () => ({ codexExecutor: { run: vi.fn() } }));
vi.mock('../zai-executor', () => ({ zaiExecutor: { run: vi.fn() } }));
vi.mock('../minimax-tokenplan-executor', () => ({ minimaxTokenplanExecutor: { run: vi.fn() } }));
vi.mock('../kimi-executor', () => ({ kimiExecutor: { run: vi.fn() } }));
vi.mock('../grok-executor', () => ({ grokExecutor: { run: vi.fn() } }));

const insertAuditEntry = vi.fn();
vi.mock('../../db', () => ({ insertAuditEntry: (...a: unknown[]) => insertAuditEntry(...a) }));

const emitIPC = vi.fn();
vi.mock('../../pipeline-shared/ipc-emitter', () => ({ emitIPC: (...a: unknown[]) => emitIPC(...a) }));

vi.mock('../../agent-config-resolver', () => ({
  resolveAgentQueryConfig: vi.fn(async () => ({
    runtime: 'cloud',
    model: 'claude-sonnet-4-5',
    systemPrompt: '',
    allowedTools: [],
    mcpServers: [],
  })),
}));

const cloudRun = vi.fn();

import { executeAgent } from '../execute';
import { PipelinePausedError } from '../types';
import type { AgentExecutionRequest, AgentExecutionResult, SubagentDispatchContext } from '../types';

function makeContext(ownerKind: SubagentDispatchContext['ownerKind']): SubagentDispatchContext {
  return {
    ownerKind,
    ownerId: 'proj-1',
    lane: 'pipeline',
    surface: 'pipeline:phase:2',
    workspace: { cwd: '/tmp', readRoots: ['/tmp'], writeRoots: ['/tmp'] },
    permission: { mode: 'bypassPermissions', dangerouslySkipPermissions: true },
    parentAbortSignal: new AbortController().signal,
    rootExecutionId: 'root-1',
    parentExecutionId: 'root-1',
    depth: 0,
    remainingBudget: 16,
    budgetState: { remaining: 16 },
    capabilityCeiling: { allowedTools: [], allowedMcpServerIds: [] },
  } as unknown as SubagentDispatchContext;
}

function makeReq(extra?: Partial<AgentExecutionRequest>): AgentExecutionRequest {
  return {
    agentId: 'harness-coder',
    prompt: 'implementa a feature',
    cwd: '/tmp',
    abortController: new AbortController(),
    permission: { mode: 'bypassPermissions', dangerouslySkipPermissions: true },
    ...extra,
  };
}

function makeResult(): AgentExecutionResult {
  return {
    output: 'feito',
    metrics: {
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0,
      toolUses: 1, apiRequests: 1, costUsd: 0, durationMs: 5,
    },
    model: 'claude-sonnet-4-5',
    runtime: 'cloud',
    provider: 'anthropic',
  };
}

async function flushAsyncAudits(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  cloudRun.mockReset();
  insertAuditEntry.mockReset();
  emitIPC.mockReset();
});

describe('auditoria V144 no executeAgent', () => {
  it('tool call concluido audita com source = ownerKind e subagent = agentId', async () => {
    cloudRun.mockImplementationOnce(async (req: AgentExecutionRequest) => {
      req.onToolUseComplete?.('Read', { file_path: '/tmp/a.ts' });
      return makeResult();
    });

    await executeAgent(makeReq({ executionContext: makeContext('pipeline') }));
    await flushAsyncAudits();

    expect(insertAuditEntry).toHaveBeenCalledTimes(1);
    expect(insertAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'tool_call',
      toolName: 'Read',
      subagent: 'harness-coder',
      source: 'pipeline',
      input: JSON.stringify({ file_path: '/tmp/a.ts' }),
    }));
    expect(emitIPC).toHaveBeenCalledWith('logs:entry', expect.objectContaining({
      id: -1,
      eventType: 'tool_call',
      source: 'pipeline',
    }));
  });

  it('sem executionContext nao audita nada (caminho reserva)', async () => {
    cloudRun.mockImplementationOnce(async (req: AgentExecutionRequest) => {
      req.onToolUseComplete?.('Read', { file_path: '/tmp/a.ts' });
      return makeResult();
    });

    await executeAgent(makeReq());
    await flushAsyncAudits();

    expect(insertAuditEntry).not.toHaveBeenCalled();
    expect(emitIPC).not.toHaveBeenCalled();
  });

  it('erro terminal audita eventType error com a mensagem', async () => {
    cloudRun.mockRejectedValueOnce(new Error('boom do provider'));

    await expect(
      executeAgent(makeReq({ executionContext: makeContext('harness') })),
    ).rejects.toThrow();
    await flushAsyncAudits();

    expect(insertAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'error',
      source: 'harness',
      subagent: 'harness-coder',
      output: 'boom do provider',
    }));
  });

  it('PipelinePausedError (controle de fluxo) NAO vira entrada de erro', async () => {
    cloudRun.mockRejectedValueOnce(new PipelinePausedError('aguardando usuario', 'other'));

    await expect(
      executeAgent(makeReq({ executionContext: makeContext('pipeline') })),
    ).rejects.toBeInstanceOf(PipelinePausedError);
    await flushAsyncAudits();

    expect(insertAuditEntry).not.toHaveBeenCalled();
  });

  it('input gigante e truncado no audit (nao explode a tabela)', async () => {
    const bigInput = { content: 'x'.repeat(20000) };
    cloudRun.mockImplementationOnce(async (req: AgentExecutionRequest) => {
      req.onToolUseComplete?.('Write', bigInput);
      return makeResult();
    });

    await executeAgent(makeReq({ executionContext: makeContext('enrich') }));
    await flushAsyncAudits();

    const entry = insertAuditEntry.mock.calls[0][0] as { input: string; source: string };
    expect(entry.source).toBe('enrich');
    expect(entry.input.length).toBeLessThanOrEqual(8000 + 20);
    expect(entry.input.endsWith('... [truncado]')).toBe(true);
  });

  it('callback do caller continua recebendo onToolUseComplete depois da auditoria', async () => {
    const callerCallback = vi.fn();
    cloudRun.mockImplementationOnce(async (req: AgentExecutionRequest) => {
      req.onToolUseComplete?.('Bash', { command: 'ls' });
      return makeResult();
    });

    await executeAgent(makeReq({
      executionContext: makeContext('pipeline'),
      onToolUseComplete: callerCallback,
    }));

    expect(callerCallback).toHaveBeenCalledWith('Bash', { command: 'ls' });
  });
});
