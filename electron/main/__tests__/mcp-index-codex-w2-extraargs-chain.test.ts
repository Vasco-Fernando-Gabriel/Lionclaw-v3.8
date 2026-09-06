
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const state = vi.hoisted(() => ({ settings: new Map<string, string>() }));
vi.mock('../db', () => ({
  getSetting: (key: string) => state.settings.get(key),
}));

const official = vi.hoisted(() => {
  const createRun = vi.fn(async (opts: unknown) => ({ opts }));
  return {
    createRun,
    failNextCreate: { value: false },
    createCodexDriver: vi.fn(() => ({
      implementation: 'official-app-server',
      createRun: async (opts: unknown) => {
        if (official.failNextCreate.value) {
          throw new Error('spawn falhou (teste)');
        }
        return createRun(opts);
      },
      toSyncCodexSession: (handle: unknown) => ({
        threadId: null,
        handle,
        send: async () => ({}),
        reply: async () => ({}),
        close: () => undefined,
      }),
    })),
  };
});
vi.mock('../codex-runtime/factory', () => ({
  createCodexDriver: official.createCodexDriver,
}));

import { resolveCodexSessionForRun, type ResolveCodexSessionArgs } from '../agent-runtime/codex-session-factory';

const EXTRAS = ['-c', 'mcp_servers.google-drive.enabled=false', '-c', 'mcp_servers.lionclaw-gateway.enabled=true'];

function args(over: Partial<ResolveCodexSessionArgs> = {}): ResolveCodexSessionArgs {
  return {
    surface: 'chat',
    mcpProfile: 'chat',
    sessionOptions: {
      cwd: '/tmp/x',
      model: 'gpt-5.5',
      systemPrompt: 'sys',
      ownerKind: 'chat',
      ownerId: 's1',
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.settings.clear();
  official.failNextCreate.value = false;
});

describe('cadeia extraArgs no factory (buildRunOptions -> CodexRunOptions)', () => {
  it('oficial ON: extraArgs chegam VERBATIM nas run options do driver', async () => {
    await resolveCodexSessionForRun(args({ extraArgs: EXTRAS }));
    expect(official.createRun).toHaveBeenCalledTimes(1);
    const runOpts = official.createRun.mock.calls[0][0] as { extraArgs?: string[] };
    expect(runOpts.extraArgs).toEqual(EXTRAS);
  });

  it('oficial ON sem extras: run options seguem com extraArgs undefined (parity)', async () => {
    await resolveCodexSessionForRun(args());
    const runOpts = official.createRun.mock.calls[0][0] as { extraArgs?: string[] };
    expect(runOpts.extraArgs).toBeUndefined();
  });
});

describe('falha fechada do driver oficial', () => {
  it('falha do driver com extras propaga sem fallback', async () => {
    official.failNextCreate.value = true;
    await expect(resolveCodexSessionForRun(args({ extraArgs: EXTRAS }))).rejects.toThrow(
      'spawn falhou (teste)',
    );
  });
});
