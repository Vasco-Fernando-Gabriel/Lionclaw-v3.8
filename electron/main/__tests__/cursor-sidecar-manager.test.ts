import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CursorSidecarError,
  _resetCursorSidecarsForTesting,
  getActiveCursorSidecarCount,
  runCursorSidecarExecution,
  shutdownCursorSidecars,
  type CursorSidecarExecutionOptions,
  type CursorToolDispatcher,
} from '../agent-runtime/cursor-sidecar/sidecar-manager';
import type { CursorSidecarExecuteConfig } from '../agent-runtime/cursor-sidecar/protocol';

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-cursor-sidecar.cjs');

const tmpDirs: string[] = [];

function makeConfig(executionId: string): CursorSidecarExecuteConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-mgr-'));
  tmpDirs.push(dir);
  return {
    executionId,
    model: 'composer-2.5',
    apiKey: 'test-key',
    cwd: dir,
    storeDir: path.join(dir, 'store'),
    prompt: 'prompt de teste',
    settingSources: [],
    guarded: false,
    customTools: [],
  };
}

function baseOptions(
  executionId: string,
  dispatchTool: CursorToolDispatcher,
  mode: string,
): CursorSidecarExecutionOptions {
  return {
    config: makeConfig(executionId),
    abortController: new AbortController(),
    dispatchTool,
    nodePathOverride: process.execPath,
    entryPathOverride: FIXTURE,
    readyTimeoutMs: 5_000,
    killGraceMs: 800,
    extraEnv: { FAKE_SIDECAR_MODE: mode, ELECTRON_RUN_AS_NODE: '1' },
  };
}

afterEach(async () => {
  _resetCursorSidecarsForTesting();
  await new Promise((r) => setTimeout(r, 300));
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe('runCursorSidecarExecution', () => {
  it('executa ponta a ponta: ready -> execute -> tool round-trip -> resultado', async () => {
    const events: unknown[] = [];
    let started: { runId: string; agentId: string } | null = null;
    const invocations: Array<{ toolName: string; args: Record<string, unknown> }> = [];

    const opts = baseOptions(
      'exec-echo',
      async (invocation) => {
        invocations.push({ toolName: invocation.toolName, args: invocation.args });
        return `HOST:PONG:${String(invocation.args['value'])}`;
      },
      'echo',
    );
    opts.onEvent = (e) => events.push(e.event);
    opts.onStarted = (info) => {
      started = info;
    };

    const result = await runCursorSidecarExecution(opts);
    expect(result.status).toBe('finished');
    expect(result.finalText).toBe('HOST:PONG:PING-42');
    expect(result.usage?.totalTokens).toBe(15);
    expect(started).toEqual({ runId: 'run-1', agentId: 'agent-1' });
    expect(invocations).toEqual([{ toolName: 'lion_echo', args: { value: 'PING-42' } }]);
    expect(events).toEqual([{ type: 'status', status: 'RUNNING' }]);
    expect(getActiveCursorSidecarCount()).toBe(0);
  });

  it('abort: signal cancela o dispatch no main, RPC pos-abort e rejeitado e o run fecha cancelled', async () => {
    const controller = new AbortController();
    let toolSignalAborted = false;

    const opts = baseOptions(
      'exec-abort',
      async (invocation, ctx) => {
        if (invocation.toolName === 'long_op') {
          return new Promise<string>((_resolve, reject) => {
            ctx.signal.addEventListener(
              'abort',
              () => {
                toolSignalAborted = true;
                reject(new Error('operacao cancelada pelo abort'));
              },
              { once: true },
            );
          });
        }
        throw new Error(`dispatch inesperado: ${invocation.toolName}`);
      },
      'long-tool',
    );
    opts.abortController = controller;

    const resultPromise = runCursorSidecarExecution(opts);
    await new Promise((r) => setTimeout(r, 700));
    controller.abort();

    const result = await resultPromise;
    expect(result.status).toBe('cancelled');
    expect(result.finalText).toBe('probe=session-aborted');
    expect(toolSignalAborted).toBe(true);
    expect(getActiveCursorSidecarCount()).toBe(0);
  });

  it('sidecar que ignora o abort e morto pelo grace (kill = ultima linha)', async () => {
    const controller = new AbortController();
    const opts = baseOptions('exec-ignore', async () => 'nunca', 'ignore-abort');
    opts.abortController = controller;

    const resultPromise = runCursorSidecarExecution(opts);
    await new Promise((r) => setTimeout(r, 500));
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({ kind: 'aborted' });
    expect(getActiveCursorSidecarCount()).toBe(0);
  });

  it('abort e isolado por execucao: abortar uma nao afeta a outra', async () => {
    const victimController = new AbortController();
    const victimOpts = baseOptions(
      'exec-victim',
      async (_invocation, ctx) =>
        new Promise<string>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('cancelada')), {
            once: true,
          });
        }),
      'long-tool',
    );
    victimOpts.abortController = victimController;

    const controlOpts = baseOptions(
      'exec-control',
      async (invocation) => `HOST:PONG:${String(invocation.args['value'])}`,
      'echo',
    );

    const victimPromise = runCursorSidecarExecution(victimOpts);
    const controlPromise = runCursorSidecarExecution(controlOpts);
    await new Promise((r) => setTimeout(r, 700));
    victimController.abort();

    const [victimResult, controlResult] = await Promise.all([victimPromise, controlPromise]);
    expect(victimResult.status).toBe('cancelled');
    expect(controlResult.status).toBe('finished');
    expect(controlResult.finalText).toBe('HOST:PONG:PING-42');
  });

  it('abort antes do spawn falha fechado sem spawnar sidecar', async () => {
    const controller = new AbortController();
    controller.abort();
    const opts = baseOptions('exec-preabort', async () => 'x', 'echo');
    opts.abortController = controller;
    await expect(runCursorSidecarExecution(opts)).rejects.toMatchObject({ kind: 'aborted' });
    expect(getActiveCursorSidecarCount()).toBe(0);
  });

  it('crash do sidecar rejeita classificado como sidecar-crash', async () => {
    const opts = baseOptions('exec-crash', async () => 'x', 'crash');
    const err = await runCursorSidecarExecution(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CursorSidecarError);
    expect((err as CursorSidecarError).kind).toBe('sidecar-crash');
    expect((err as CursorSidecarError).message).toContain('code=7');
  });

  it('health check: sidecar sem pong e derrubado com health-timeout', async () => {
    const opts = baseOptions('exec-nopong', async () => 'nunca-responde', 'no-pong');
    opts.dispatchTool = () => new Promise<string>(() => undefined);
    opts.healthPingIntervalMs = 300;
    opts.healthPongTimeoutMs = 400;
    const err = await runCursorSidecarExecution(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CursorSidecarError);
    expect((err as CursorSidecarError).kind).toBe('health-timeout');
    expect(getActiveCursorSidecarCount()).toBe(0);
  });

  it('shutdownCursorSidecars mata todos os sidecars vivos', async () => {
    const opts = baseOptions('exec-shutdown', async () => 'nunca', 'ignore-abort');
    const outcome = runCursorSidecarExecution(opts).then(
      () => null,
      (err: unknown) => err,
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(getActiveCursorSidecarCount()).toBe(1);
    await shutdownCursorSidecars('test-shutdown');
    expect(getActiveCursorSidecarCount()).toBe(0);
    expect(await outcome).toMatchObject({ kind: 'sidecar-crash' });
  });
});
