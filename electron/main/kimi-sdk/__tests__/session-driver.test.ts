import { beforeEach, describe, it, expect, vi } from 'vitest';
import type {
  CliRunHandle,
  CliRunOptions,
  CliAgenticResponse,
  CliStreamCallbacks,
} from '../../agent-runtime/cli-agentic/contract';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const acquireKimiSlotMock = vi.hoisted(() => vi.fn(async (_request: unknown) => vi.fn()));
vi.mock('../../agent-runtime/kimi-concurrency', () => ({
  acquireKimiSlot: (request: unknown) => acquireKimiSlotMock(request),
}));

vi.mock('../../paths', () => ({
  getAgentCwd: () => '/tmp/agent-cwd',
  getLionClawHome: () => '/tmp/lion-home',
}));

vi.mock('../../prompt-builder', () => ({
  buildSystemPrompt: () => 'SYSTEM PROMPT',
  loadGeneratedAgentContext: () => '',
}));

vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async () => ({})),
}));

vi.mock('../../db', () => ({
  getEnabledTools: vi.fn(() => []),
}));

const availabilityState = vi.hoisted(() => ({
  authMode: 'subscription' as 'subscription' | 'none',
}));
const toolState = vi.hoisted(() => ({ dispatchContext: undefined as unknown }));
vi.mock('../../agent-runtime/kimi-availability', () => ({
  isKimiAvailable: vi.fn(async () => ({
    installed: true,
    authenticated: true,
    authMode: availabilityState.authMode,
  })),
  resolveKimiBinary: vi.fn().mockResolvedValue('/usr/local/bin/kimi'),
  KimiUnavailableError: class KimiUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'KimiUnavailableError';
    }
  },
  KimiAuthError: class KimiAuthError extends Error {},
}));

vi.mock('../../agent-runtime/kimi-session-config', () => ({
  buildKimiSessionTools: vi.fn(async (args: { dispatchContext?: unknown }) => {
    toolState.dispatchContext = args.dispatchContext;
    return {
      externalTools: [],
      systemPrompt: 'RECONCILED PROMPT',
    };
  }),
}));

type SendImpl = (prompt: string, cb?: CliStreamCallbacks, abortSignal?: AbortSignal) => Promise<CliAgenticResponse>;

const driverState = vi.hoisted(() => ({
  sendImpl: undefined as unknown as SendImpl,
  lastRunOptions: undefined as unknown,
  createRun: undefined as unknown,
  close: undefined as unknown,
}));

vi.mock('../../kimi-acp/acp-driver', () => ({
  getKimiAcpDriver: () => ({
    createRun: (opts: CliRunOptions) => (driverState.createRun as (o: CliRunOptions) => Promise<CliRunHandle>)(opts),
  }),
}));

import { createChatKimiSession } from '../session';

const CHAT_PERMISSION = {
  mode: 'default' as const,
  dangerouslySkipPermissions: false,
  canUseTool: vi.fn(async () => ({ behavior: 'allow' as const })),
};

function installFakeDriver(): {
  createRun: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn().mockResolvedValue(undefined);
  const handle: CliRunHandle = {
    send: (prompt, cb, abortSignal) => driverState.sendImpl(prompt, cb, abortSignal),
    reply: (prompt, cb, abortSignal) => driverState.sendImpl(prompt, cb, abortSignal),
    interrupt: vi.fn().mockResolvedValue(undefined),
    close,
    forceKillFallback: vi.fn().mockResolvedValue(undefined),
  };
  const createRun = vi.fn(async (opts: CliRunOptions): Promise<CliRunHandle> => {
    driverState.lastRunOptions = opts;
    return handle;
  });
  driverState.createRun = createRun;
  driverState.close = close;
  return { createRun, close };
}

function finishedResponse(content: string): CliAgenticResponse {
  return {
    content,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    toolUses: 0,
    status: 'finished',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  availabilityState.authMode = 'subscription';
  driverState.sendImpl = async () => finishedResponse('ok');
  installFakeDriver();
});

describe('kimi-sdk chat lane driver wiring (S6 §6.2)', () => {
  it('creates an ACP run with the chat scope + empty mcpServers when the tool set is empty', async () => {
    await createChatKimiSession({
      sessionId: 'sess-chat',
      model: 'kimi-code/kimi-for-coding',
      permission: CHAT_PERMISSION,
    });

    expect(driverState.createRun as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    const opts = driverState.lastRunOptions as {
      profile: string;
      surface: string;
      ownerKind: string;
      runId: string;
      model: string;
      systemPrompt: string;
      mcpServers?: unknown[];
    };
    expect(opts.profile).toBe('chat');
    expect(opts.surface).toBe('chat');
    expect(opts.ownerKind).toBe('chat');
    expect(opts.runId).toMatch(/^kimi-chat-[0-9a-f-]{36}$/);
    expect((driverState.lastRunOptions as { ownerId?: string }).ownerId).toBe('sess-chat');
    expect(opts.model).toBe('kimi-code/kimi-for-coding');
    expect(opts.systemPrompt).toBe('');
    expect(opts.mcpServers).toEqual([]);
  });

  it('mints a distinct execution UUID for consecutive turns in the same chat session', async () => {
    const first = await createChatKimiSession({
      sessionId: 'sess-repeat',
      model: 'kimi-code/kimi-for-coding',
      permission: CHAT_PERMISSION,
    });
    const second = await createChatKimiSession({
      sessionId: 'sess-repeat',
      model: 'kimi-code/kimi-for-coding',
      permission: CHAT_PERMISSION,
    });

    const calls = (driverState.createRun as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ runId: string; ownerId?: string }]
    >;
    expect(calls[0][0].runId).toMatch(/^kimi-chat-[0-9a-f-]{36}$/);
    expect(calls[1][0].runId).toMatch(/^kimi-chat-[0-9a-f-]{36}$/);
    expect(calls[1][0].runId).not.toBe(calls[0][0].runId);
    expect(calls.map(([opts]) => opts.ownerId)).toEqual(['sess-repeat', 'sess-repeat']);

    await Promise.all([first.close(), second.close()]);
  });

  it('repassa effort K3 e permission do chat como eixos independentes', async () => {
    const permission = { mode: 'default' as const, dangerouslySkipPermissions: false };
    await createChatKimiSession({
      sessionId: 'sess-k3',
      model: 'kimi-code/k3',
      effort: 'low',
      permission,
    });
    const opts = driverState.lastRunOptions as { effort?: string; permission?: unknown; thinking: boolean };
    expect(opts.effort).toBe('low');
    expect(opts.permission).toBe(permission);
    expect(opts.thinking).toBe(true);
  });

  it('send streams through the handle and injects the reconciled block on the FIRST send only', async () => {
    const prompts: string[] = [];
    driverState.sendImpl = async (prompt, cb) => {
      prompts.push(prompt);
      cb?.onText?.('Ola ');
      cb?.onText?.('mundo');
      return finishedResponse('Ola mundo');
    };

    const session = await createChatKimiSession({
      sessionId: 'sess-chat',
      model: 'kimi-code/kimi-for-coding',
      permission: CHAT_PERMISSION,
    });
    const onText = vi.fn();
    const ac = new AbortController();

    const res1 = await session.send('oi', { onText }, ac.signal);
    expect(res1.content).toBe('Ola mundo');
    expect(res1.status).toBe('finished');
    expect(onText).toHaveBeenCalledWith('Ola ');
    expect(onText).toHaveBeenCalledWith('mundo');
    expect(prompts[0]).toContain('## Instrucoes do agente');
    expect(prompts[0]).toContain('RECONCILED PROMPT');
    expect(prompts[0]).toContain('oi');

    await session.send('de novo', { onText }, ac.signal);
    expect(prompts[1]).toBe('de novo');
  });

  it("abort path resolves status:'cancelled' (index.ts L323 short-circuit dependency)", async () => {
    driverState.sendImpl = (_prompt, cb, abortSignal) =>
      new Promise<CliAgenticResponse>((resolve) => {
        cb?.onText?.('parcial...');
        abortSignal?.addEventListener(
          'abort',
          () =>
            resolve({
              content: 'parcial...',
              usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
              toolUses: 0,
              status: 'cancelled',
            }),
          { once: true },
        );
      });

    const session = await createChatKimiSession({
      sessionId: 'sess-chat',
      model: 'kimi-code/kimi-for-coding',
      permission: CHAT_PERMISSION,
    });
    const ac = new AbortController();
    const sendPromise = session.send('longa', { onText: vi.fn() }, ac.signal);
    ac.abort();
    const res = await sendPromise;
    expect(res.status).toBe('cancelled');
  });

  it('repropaga auth pendente de subagente depois que o driver encerra o turno', async () => {
    const authError = new Error('login Kimi necessario');
    driverState.sendImpl = async () => {
      const context = toolState.dispatchContext as { controlState?: { providerAuthError?: Error } };
      context.controlState ??= {};
      context.controlState.providerAuthError = authError;
      return finishedResponse('tool error convertido pelo driver');
    };

    const session = await createChatKimiSession({
      sessionId: 'sess-auth',
      model: 'kimi-code/kimi-for-coding',
      permission: CHAT_PERMISSION,
    });
    await expect(session.send('oi', {}, new AbortController().signal)).rejects.toBe(authError);
  });

  it('propaga imediatamente o abort do turno aos handlers e remove o listener no close', async () => {
    const parent = new AbortController();
    const removeListener = vi.spyOn(parent.signal, 'removeEventListener');
    const session = await createChatKimiSession({
      sessionId: 'sess-abort-tools',
      model: 'kimi-code/kimi-for-coding',
      permission: CHAT_PERMISSION,
      abortSignal: parent.signal,
    });
    const context = toolState.dispatchContext as { parentAbortSignal: AbortSignal };
    const reason = new Error('turno cancelado');

    expect(context.parentAbortSignal.aborted).toBe(false);
    parent.abort(reason);
    expect(context.parentAbortSignal.aborted).toBe(true);
    expect(context.parentAbortSignal.reason).toBe(reason);

    await session.close();
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('close() aborts the tool controller then awaits handle.close()', async () => {
    const session = await createChatKimiSession({
      sessionId: 'sess-chat',
      model: 'kimi-code/kimi-for-coding',
      permission: CHAT_PERMISSION,
    });
    await session.close();
    expect(driverState.close as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });
});
