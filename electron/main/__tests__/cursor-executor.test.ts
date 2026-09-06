
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async (key: string) => (key === 'CURSOR_API_KEY' ? 'test-cursor-key' : null)),
}));

vi.mock('../agent-runtime/cursor-sidecar/sidecar-manager', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../agent-runtime/cursor-sidecar/sidecar-manager')
  >();
  return {
    ...actual,
    runCursorSidecarExecution: vi.fn(),
  };
});

import { getSecret } from '../secrets-vault';
import {
  CursorSidecarError,
  runCursorSidecarExecution,
  type CursorSidecarExecutionOptions,
  type CursorSidecarExecutionResult,
} from '../agent-runtime/cursor-sidecar/sidecar-manager';
import {
  cursorExecutor,
  CURSOR_FIRST_TOKEN_TIMEOUT_MS,
} from '../agent-runtime/cursor-executor';
import {
  buildCursorSessionKey,
  cursorSessionStoreDir,
  loadCursorSession,
  saveCursorSession,
} from '../agent-runtime/cursor-sidecar/session-registry';
import { calculateCost } from '../pricing';
import { TypedProviderError } from '../agent-runtime/llm-error';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { AgentExecutionRequest } from '../agent-runtime/types';

const mockedRun = vi.mocked(runCursorSidecarExecution);
const mockedGetSecret = vi.mocked(getSecret);

const WATCHDOG_STALL_ADVANCE_MS = 180_000 + 1_000;

let testHome = '';
const originalTestHome = process.env['LIONCLAW_TEST_HOME'];

function makeConfig(overrides: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
  return {
    model: 'composer-2.5',
    systemPrompt: 'Voce e o coder do LionClaw.',
    allowedTools: [],
    mcpServers: [],
    maxTurns: undefined,
    effort: 'medium',
    thinking: 'disabled',
    thinkingBudget: undefined,
    runtime: 'cursor',
    ...overrides,
  };
}

function makeRequest(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    agentId: 'harness-coder',
    prompt: 'Implemente a feature X.',
    cwd: path.join(testHome, 'workspace'),
    abortController: new AbortController(),
    permission: { mode: 'bypassPermissions', dangerouslySkipPermissions: true },
    ...overrides,
  };
}

function finishedResult(
  overrides: Partial<CursorSidecarExecutionResult> = {},
): CursorSidecarExecutionResult {
  return {
    status: 'finished',
    finalText: 'resposta final',
    usage: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      totalTokens: 1700,
    },
    agentId: 'cursor-agent-abc',
    runId: 'run-1',
    model: 'composer-2.5',
    durationMs: 4321,
    ...overrides,
  };
}

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-exec-'));
  process.env['LIONCLAW_TEST_HOME'] = testHome;
  fs.mkdirSync(path.join(testHome, 'workspace'), { recursive: true });
  mockedRun.mockReset();
  mockedGetSecret.mockClear();
  mockedGetSecret.mockImplementation(async (key: string) =>
    key === 'CURSOR_API_KEY' ? 'test-cursor-key' : null,
  );
});

afterEach(() => {
  vi.useRealTimers();
  if (originalTestHome === undefined) delete process.env['LIONCLAW_TEST_HOME'];
  else process.env['LIONCLAW_TEST_HOME'] = originalTestHome;
  try {
    fs.rmSync(testHome, { recursive: true, force: true });
  } catch {
  }
});

describe('cursorExecutor.run — caminho feliz', () => {
  it('executa via sidecar, calcula custo com a tabela e persiste a sessao', async () => {
    mockedRun.mockResolvedValue(finishedResult());
    const req = makeRequest();
    const config = makeConfig();

    const result = await cursorExecutor.run(req, config);

    expect(result.output).toBe('resposta final');
    expect(result.runtime).toBe('cursor');
    expect(result.provider).toBe('cursor');
    expect(result.model).toBe('composer-2.5');
    expect(result.metrics.inputTokens).toBe(1200);
    expect(result.metrics.outputTokens).toBe(500);
    expect(result.metrics.cacheReadTokens).toBe(200);
    expect(result.metrics.costUsd).toBeCloseTo(
      calculateCost('composer-2.5', 1200, 500, 200, 0),
      12,
    );
    expect(result.metrics.costStatus).toBe('known');
    expect(result.metrics.tokenStatus).toBe('reported');
    expect(result.metrics.durationMs).toBe(4321);
    expect(result.metadata?.costEstimationKind).toBe('subscription-equivalent-payg');
    expect(result.metadata?.costSource).toBe('calculated');
    expect(result.metadata?.sessionIds).toEqual(['cursor-agent-abc']);
    expect(result.metadata?.modelUsage?.['composer-2.5']?.inputTokens).toBe(1200);
    expect(result.metadata?.modelUsage?.['composer-2.5']?.cacheReadInputTokens).toBe(200);

    const opts = mockedRun.mock.calls[0]![0] as CursorSidecarExecutionOptions;
    expect(opts.config.model).toBe('composer-2.5');
    expect(opts.config.apiKey).toBe('test-cursor-key');
    expect(opts.config.cwd).toBe(req.cwd);
    expect(opts.config.settingSources).toEqual([]);
    expect(opts.config.customTools).toEqual([]);
    expect(opts.config.resumeAgentId).toBeUndefined();
    expect(opts.config.prompt).toContain('## Instrucoes do agente');
    expect(opts.config.prompt).toContain('Voce e o coder do LionClaw.');
    expect(opts.config.prompt).toContain('## Runtime Atual');
    expect(opts.config.prompt).toContain('- Runtime: cursor');
    expect(opts.config.prompt).toContain('## Tarefa\n\nImplemente a feature X.');

    const sessionKey = buildCursorSessionKey({ agentId: req.agentId, cwd: req.cwd });
    expect(opts.config.storeDir).toBe(cursorSessionStoreDir(sessionKey));
    expect(loadCursorSession(sessionKey)?.cursorAgentId).toBe('cursor-agent-abc');
  });

  it('marca estimated-partial (cache-write-not-reported) quando ha cache write em tarifa sem preco separado', async () => {
    mockedRun.mockResolvedValue(
      finishedResult({
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 40,
          totalTokens: 190,
        },
      }),
    );
    const result = await cursorExecutor.run(makeRequest(), makeConfig());
    expect(result.metrics.costStatus).toBe('estimated-partial');
    expect(result.metrics.costStatusReasons).toEqual(['cache-write-not-reported']);
    expect(result.metrics.costUsd).toBeCloseTo(calculateCost('composer-2.5', 140, 50, 0, 40), 12);
  });

  it('cache read maior que o input novo (resume tipico) nunca produz pureInput negativo', async () => {
    mockedRun.mockResolvedValue(
      finishedResult({
        usage: {
          inputTokens: 50,
          outputTokens: 20,
          cacheReadTokens: 5000,
          cacheWriteTokens: 0,
          totalTokens: 5070,
        },
      }),
    );
    const result = await cursorExecutor.run(makeRequest(), makeConfig());
    expect(result.metrics.inputTokens).toBe(5050);
    expect(result.metrics.costUsd).toBeCloseTo(
      calculateCost('composer-2.5', 5050, 20, 5000, 0),
      12,
    );
    expect(result.metrics.costUsd).toBeGreaterThan(0);
  });

  it('usage ausente vira custo nao-reportado honesto (nunca $0 silencioso)', async () => {
    const base = finishedResult();
    delete (base as { usage?: unknown }).usage;
    mockedRun.mockResolvedValue(base);
    const result = await cursorExecutor.run(makeRequest(), makeConfig());
    expect(result.metrics.costStatus).toBe('unknown');
    expect(result.metrics.tokenStatus).toBe('not_reported');
    expect(result.metrics.costUnknownReason).toBe('no-usage-reported');
    expect(result.metrics.costUsd).toBe(0);
  });
});

describe('cursorExecutor.run — stream relay', () => {
  it('mapeia os eventos do SDK para os callbacks canonicos', async () => {
    mockedRun.mockImplementation(async (opts) => {
      const emit = (event: unknown): void =>
        opts.onEvent?.({ executionId: opts.config.executionId, event });
      emit({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Oi' }] },
      });
      emit({ type: 'thinking', text: 'pensando...' });
      emit({ type: 'tool_call', name: 'shell', status: 'running' });
      emit({ type: 'tool_call', name: 'shell', status: 'completed', args: { command: 'ls' } });
      emit({ type: 'status', status: 'RUNNING' });
      return finishedResult({ finalText: 'Oi' });
    });

    const texts: string[] = [];
    const thinking: string[] = [];
    const toolStarts: string[] = [];
    const toolDone: Array<[string, unknown]> = [];
    let activity = 0;
    const req = makeRequest({
      onText: (t) => texts.push(t),
      onThinking: (t) => thinking.push(t),
      onToolUse: (t) => toolStarts.push(t),
      onToolUseComplete: (t, input) => toolDone.push([t, input]),
      onActivity: () => {
        activity += 1;
      },
    });

    const result = await cursorExecutor.run(req, makeConfig());
    expect(texts).toEqual(['Oi']);
    expect(thinking).toEqual(['pensando...']);
    expect(toolStarts).toEqual(['shell']);
    expect(toolDone).toEqual([['shell', { command: 'ls' }]]);
    expect(activity).toBeGreaterThanOrEqual(1); // evento 'status' = prova de vida
    expect(result.metrics.toolUses).toBe(1);
  });
});

describe('cursorExecutor.run — continuidade (Agent.resume)', () => {
  it('continueSession retoma o agentId persistido e NAO reenvia as instrucoes', async () => {
    const req = makeRequest({ continueSession: true, prompt: 'Segundo turno.' });
    const sessionKey = buildCursorSessionKey({ agentId: req.agentId, cwd: req.cwd });
    saveCursorSession(sessionKey, {
      cursorAgentId: 'cursor-agent-prev',
      model: 'composer-2.5',
      updatedAt: new Date().toISOString(),
    });
    mockedRun.mockResolvedValue(finishedResult({ agentId: 'cursor-agent-prev' }));

    await cursorExecutor.run(req, makeConfig());

    const opts = mockedRun.mock.calls[0]![0] as CursorSidecarExecutionOptions;
    expect(opts.config.resumeAgentId).toBe('cursor-agent-prev');
    expect(opts.config.storeDir).toBe(cursorSessionStoreDir(sessionKey));
    expect(opts.config.prompt).toBe('Segundo turno.');
    expect(opts.config.model).toBe('composer-2.5');
  });

  it('continueSession sem sessao persistida vira sessao nova com instrucoes completas', async () => {
    mockedRun.mockResolvedValue(finishedResult());
    const req = makeRequest({ continueSession: true });
    await cursorExecutor.run(req, makeConfig());
    const opts = mockedRun.mock.calls[0]![0] as CursorSidecarExecutionOptions;
    expect(opts.config.resumeAgentId).toBeUndefined();
    expect(opts.config.prompt).toContain('## Instrucoes do agente');
  });

  it('segrega a sessao por projectId (pipeline) na chave/storeDir', async () => {
    mockedRun.mockResolvedValue(finishedResult());
    const req = makeRequest({ projectId: 'proj-42' });
    await cursorExecutor.run(req, makeConfig());
    const opts = mockedRun.mock.calls[0]![0] as CursorSidecarExecutionOptions;
    const keyed = buildCursorSessionKey({
      agentId: req.agentId,
      cwd: req.cwd,
      projectId: 'proj-42',
    });
    expect(opts.config.storeDir).toBe(cursorSessionStoreDir(keyed));
    expect(opts.config.storeDir).not.toBe(
      cursorSessionStoreDir(buildCursorSessionKey({ agentId: req.agentId, cwd: req.cwd })),
    );
  });
});

describe('cursorExecutor.run — enforcement de tools (E5)', () => {
  it('bypass: allowedTools ausente (toolset default confinado ao cwd), guarded=false e sandbox so fora do Windows', async () => {
    mockedRun.mockResolvedValue(finishedResult());
    await cursorExecutor.run(makeRequest(), makeConfig());
    const opts = mockedRun.mock.calls[0]![0] as CursorSidecarExecutionOptions;
    expect(opts.config.guarded).toBe(false);
    expect(opts.config.allowedTools).toBeUndefined();
    expect(opts.config.sandbox ?? false).toBe(process.platform !== 'win32');
  });

  it('guardado sem canUseTool (PERM_DEFAULT_NO_BYPASS) falha FECHADO sem tocar o sidecar', async () => {
    const req = makeRequest({
      permission: { mode: 'default', dangerouslySkipPermissions: false },
    });
    await expect(cursorExecutor.run(req, makeConfig())).rejects.toThrow(/[Ff]ail-closed/);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('guardado com canUseTool: allowlist positiva so mcp + customTools host-controladas', async () => {
    mockedRun.mockResolvedValue(finishedResult());
    const guardCalls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const req = makeRequest({
      permission: {
        mode: 'default',
        dangerouslySkipPermissions: false,
        canUseTool: async (toolName, input) => {
          guardCalls.push({ toolName, input });
          return { behavior: 'deny', message: 'fora do writeSet' };
        },
      },
    });

    await cursorExecutor.run(req, makeConfig());

    const opts = mockedRun.mock.calls[0]![0] as CursorSidecarExecutionOptions;
    expect(opts.config.guarded).toBe(true);
    expect(opts.config.allowedTools).toEqual(['mcp']);
    expect(opts.config.allowedTools).not.toContain('read');
    expect(opts.config.allowedTools).not.toContain('task');
    const toolNames = opts.config.customTools.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      'lion_edit',
      'lion_glob',
      'lion_grep',
      'lion_list',
      'lion_read',
      'lion_shell',
      'lion_write',
    ]);
    expect(opts.config.sandbox).toBeUndefined();

    await expect(
      opts.dispatchTool(
        {
          executionId: opts.config.executionId,
          toolName: 'lion_write',
          args: { file_path: 'hack.txt', content: 'x' },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/Permissao negada \(Write\): fora do writeSet/);
    expect(guardCalls).toEqual([
      { toolName: 'Write', input: { file_path: 'hack.txt', content: 'x' } },
    ]);
    expect(fs.existsSync(path.join(req.cwd, 'hack.txt'))).toBe(false);
  });

  it('guardado em resume REAPLICA a allowlist e as customTools (policy nao persiste no SDK)', async () => {
    const req = makeRequest({
      continueSession: true,
      prompt: 'Turno 2 guardado.',
      permission: {
        mode: 'default',
        dangerouslySkipPermissions: false,
        canUseTool: async () => ({ behavior: 'allow' }),
      },
    });
    const sessionKey = buildCursorSessionKey({ agentId: req.agentId, cwd: req.cwd });
    saveCursorSession(sessionKey, {
      cursorAgentId: 'cursor-agent-guarded',
      model: 'composer-2.5',
      updatedAt: new Date().toISOString(),
    });
    mockedRun.mockResolvedValue(finishedResult({ agentId: 'cursor-agent-guarded' }));

    await cursorExecutor.run(req, makeConfig());

    const opts = mockedRun.mock.calls[0]![0] as CursorSidecarExecutionOptions;
    expect(opts.config.resumeAgentId).toBe('cursor-agent-guarded');
    expect(opts.config.guarded).toBe(true);
    expect(opts.config.allowedTools).toEqual(['mcp']);
    expect(opts.config.customTools.length).toBe(7);
    expect(opts.config.model).toBe('composer-2.5');
  });


  it('API key ausente do Vault vira LLM-AUTH-401', async () => {
    mockedGetSecret.mockResolvedValue(null);
    const err = await cursorExecutor.run(makeRequest(), makeConfig()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypedProviderError);
    expect((err as TypedProviderError).code).toBe('LLM-AUTH-401');
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('modelo fora do catalogo do runtime vira LLM-MODEL-404 (pertencimento, nao prefixo)', async () => {
    const err = await cursorExecutor
      .run(makeRequest(), makeConfig({ model: 'claude-3-haiku-fora-do-catalogo' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypedProviderError);
    expect((err as TypedProviderError).code).toBe('LLM-MODEL-404');
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('status failed do run vira erro com a mensagem real do sidecar', async () => {
    mockedRun.mockResolvedValue(
      finishedResult({ status: 'failed', errorCode: 'rate_limited', errorMessage: 'HTTP 429' }),
    );
    await expect(cursorExecutor.run(makeRequest(), makeConfig())).rejects.toThrow(
      /failed.*rate_limited.*HTTP 429/s,
    );
  });

  it('abort do usuario (status cancelled) propaga como aborted, nao como timeout', async () => {
    mockedRun.mockResolvedValue(finishedResult({ status: 'cancelled', finalText: '' }));
    const err = await cursorExecutor.run(makeRequest(), makeConfig()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CursorSidecarError);
    expect((err as CursorSidecarError).kind).toBe('aborted');
  });

  it('abortado antes do start falha fechado sem tocar o sidecar', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await cursorExecutor
      .run(makeRequest({ abortController: controller }), makeConfig())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CursorSidecarError);
    expect((err as CursorSidecarError).kind).toBe('aborted');
    expect(mockedRun).not.toHaveBeenCalled();
  });
});

describe('cursorExecutor.run — watchdog com ABORT EFETIVO', () => {
  it('primeiro token: sem NENHUM evento, aborta de verdade e classifica LLM-TIMEOUT', async () => {
    vi.useFakeTimers();
    mockedRun.mockImplementation(async (opts) => {
      return new Promise<CursorSidecarExecutionResult>((_resolve, reject) => {
        opts.abortController.signal.addEventListener(
          'abort',
          () =>
            reject(
              new CursorSidecarError('Execucao abortada (sidecar encerrado)', 'aborted'),
            ),
          { once: true },
        );
      });
    });

    const req = makeRequest();
    const pending = cursorExecutor.run(req, makeConfig());
    const outcome = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(CURSOR_FIRST_TOKEN_TIMEOUT_MS + 10);

    const err = await outcome;
    const opts = mockedRun.mock.calls[0]![0] as CursorSidecarExecutionOptions;
    expect(opts.abortController).not.toBe(req.abortController);
    expect(opts.abortController.signal.aborted).toBe(true);
    expect(req.abortController.signal.aborted).toBe(false);
    expect(err).toBeInstanceOf(TypedProviderError);
    expect((err as TypedProviderError).code).toBe('LLM-TIMEOUT');
    expect((err as TypedProviderError).message).toContain('primeiro token');
  });

  it('stall: eventos pararam depois do primeiro — aborta e classifica LLM-TIMEOUT', async () => {
    vi.useFakeTimers();
    mockedRun.mockImplementation(async (opts) => {
      opts.onEvent?.({
        executionId: opts.config.executionId,
        event: { type: 'status', status: 'RUNNING' },
      });
      return new Promise<CursorSidecarExecutionResult>((_resolve, reject) => {
        opts.abortController.signal.addEventListener(
          'abort',
          () =>
            reject(
              new CursorSidecarError('Execucao abortada (sidecar encerrado)', 'aborted'),
            ),
          { once: true },
        );
      });
    });

    const req = makeRequest();
    const outcome = cursorExecutor.run(req, makeConfig()).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(WATCHDOG_STALL_ADVANCE_MS);

    const err = await outcome;
    const opts = mockedRun.mock.calls[0]![0] as CursorSidecarExecutionOptions;
    expect(opts.abortController.signal.aborted).toBe(true);
    expect(req.abortController.signal.aborted).toBe(false);
    expect(err).toBeInstanceOf(TypedProviderError);
    expect((err as TypedProviderError).code).toBe('LLM-TIMEOUT');
    expect((err as TypedProviderError).message).toContain('stall');
  });

  it('abort do usuario no controller do caller PROPAGA para o child do sidecar', async () => {
    mockedRun.mockImplementation(async (opts) => {
      const cancelled: CursorSidecarExecutionResult = { status: 'cancelled', finalText: '' };
      if (opts.abortController.signal.aborted) return cancelled;
      return new Promise<CursorSidecarExecutionResult>((resolve) => {
        opts.abortController.signal.addEventListener('abort', () => resolve(cancelled), {
          once: true,
        });
      });
    });

    const req = makeRequest();
    const outcome = cursorExecutor.run(req, makeConfig()).catch((e: unknown) => e);
    req.abortController.abort();

    const err = await outcome;
    expect(err).toBeInstanceOf(CursorSidecarError);
    expect((err as CursorSidecarError).kind).toBe('aborted');
  });
});
