import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sdkMessages: [] as Array<Record<string, unknown>>,
  codexResponse: {} as Record<string, unknown>,
  codexClosed: 0,
  kimiResponse: {} as Record<string, unknown>,
  kimiClosed: 0,
  kimiReleased: 0,
  kimiAcquire: vi.fn(),
  kimiCreateRun: vi.fn(),
  grokResponse: {} as Record<string, unknown>,
  grokClosed: 0,
  grokReleased: 0,
  grokCreateRun: vi.fn(),
  grokAvailability: vi.fn(),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../smoke-audit', () => ({ smokeAudit: vi.fn() }));

vi.mock('../paths', () => ({
  getBackgroundCwd: () => '/tmp/lion-bg',
}));

vi.mock('../db', () => ({
  getSetting: vi.fn(() => '3'),
}));

vi.mock('../pipeline-shared/sdk-bootstrap', () => ({
  ensureAuthForSDK: vi.fn(async () => {}),
  ensureNodeInPath: vi.fn(),
  getClaudeCodeExecutablePath: () => '/fake/cli.js',
  getClaudeSdkProcessOptions: vi.fn(() => ({
    pathToClaudeCodeExecutable: '/fake/cli.js',
    executable: 'node',
  })),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      for (const msg of state.sdkMessages) {
        yield msg;
      }
    },
  })),
}));

vi.mock('../agent-runtime/codex-session-factory', () => ({
  resolveCodexSessionForRun: vi.fn(async () => ({
    send: vi.fn(async () => state.codexResponse),
    close: vi.fn(() => {
      state.codexClosed += 1;
    }),
  })),
}));

vi.mock('../agent-runtime/kimi-availability', () => ({
  isKimiAvailable: vi.fn(async () => ({ installed: true, authenticated: true, authMode: 'subscription' })),
  resolveKimiBinary: vi.fn(async () => null),
  KimiUnavailableError: class KimiUnavailableError extends Error {},
}));

vi.mock('../kimi-acp/acp-driver', () => ({
  getKimiAcpDriver: vi.fn(() => ({
    createRun: state.kimiCreateRun,
  })),
}));

vi.mock('../agent-runtime/kimi-concurrency', () => ({
  acquireKimiSlot: state.kimiAcquire,
}));

vi.mock('../agent-runtime/grok-availability', () => ({
  buildGrokChildEnv: vi.fn(() => ({ GROK_HOME: '/tmp/grok-home', HOME: '/tmp/grok-home' })),
  ensureGrokHome: vi.fn(),
  prepareGrokWorkspace: vi.fn(async () => undefined),
  isGrokAvailable: state.grokAvailability,
  resolveGrokBinary: vi.fn(async () => '/fake/grok'),
  resolveGrokHome: vi.fn(() => '/tmp/grok-home'),
  GrokUnavailableError: class GrokUnavailableError extends Error {},
}));

vi.mock('../agent-runtime/grok-concurrency', () => ({
  configureGrokConcurrency: vi.fn(),
  acquireGrokSlot: vi.fn(async () => () => {
    state.grokReleased += 1;
  }),
}));

vi.mock('../grok-acp/acp-driver', () => ({
  getGrokAcpDriver: vi.fn(() => ({ createRun: state.grokCreateRun })),
}));

vi.mock('../agent-runtime/grok-session-config', () => ({
  buildGrokNativeToolPolicy: vi.fn(() => ({
    argv: ['--tools', '', '--disable-web-search'],
    effectiveTools: [],
  })),
}));

vi.mock('../grok-sdk/workspace', () => ({
  acquireGrokSandboxSpawnLock: vi.fn(async () => vi.fn()),
  assertGrokWorkspaceUnchanged: vi.fn(),
  attestGrokSession: vi.fn(),
  ensureGrokSandboxProfile: vi.fn(() => 'strict'),
  inspectGrokWorkspace: vi.fn(async () => undefined),
  resolveGrokWorkspaceGrant: vi.fn(() => ({
    processCwd: '/tmp/grok-neutral',
    sessionCwd: '/tmp/grok-neutral',
    readRoots: ['/tmp/grok-neutral'],
    writeRoots: [],
    source: 'neutral',
    projectSources: [],
  })),
  snapshotGrokSandboxAttestation: vi.fn(() => ({})),
  waitForGrokSandboxApplied: vi.fn(async () => undefined),
}));

import { runSubscriptionPrompt } from '../memory-pipeline/oneshot-subscription';
import type { OrchestratorSelection } from '../orchestrator-selection';

const CLAUDE_SEL: OrchestratorSelection = {
  runtime: 'claude-sdk',
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  source: 'settings',
};

const CODEX_SEL: OrchestratorSelection = {
  runtime: 'codex-sdk',
  provider: 'codex',
  model: 'gpt-5.5',
  source: 'settings',
};

const KIMI_SEL: OrchestratorSelection = {
  runtime: 'kimi-sdk',
  provider: 'kimi',
  model: 'kimi-code',
  source: 'settings',
};

const GROK_SEL: OrchestratorSelection = {
  runtime: 'grok-sdk',
  provider: 'grok',
  model: 'grok-4.5',
  source: 'settings',
};

beforeEach(() => {
  vi.clearAllMocks();
  state.sdkMessages = [];
  state.codexResponse = {};
  state.codexClosed = 0;
  state.kimiResponse = {};
  state.kimiClosed = 0;
  state.kimiReleased = 0;
  state.kimiAcquire.mockResolvedValue(() => {
    state.kimiReleased += 1;
  });
  state.kimiCreateRun.mockResolvedValue({
    send: vi.fn(async () => state.kimiResponse),
    close: vi.fn(async () => {
      state.kimiClosed += 1;
    }),
  });
  state.grokResponse = {};
  state.grokClosed = 0;
  state.grokReleased = 0;
  state.grokAvailability.mockResolvedValue({
    installed: true,
    version: '0.2.103',
    authenticated: true,
    authMode: 'subscription',
    subscriptionRouteVerified: true,
    backendVerified: true,
    isolationVerified: true,
    modelAvailable: true,
    usable: true,
  });
  state.grokCreateRun.mockResolvedValue({
    send: vi.fn(async () => state.grokResponse),
    close: vi.fn(async () => {
      state.grokClosed += 1;
    }),
  });
});

describe('SB-5 — one-shots checam status/is_error ANTES de stripFence', () => {
  it('AC-B13 (claude-sdk): result is_error:true vira throw com o subtype/detalhe real, nao texto vazio', async () => {
    state.sdkMessages = [
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'API quota exhausted',
      },
    ];

    await expect(runSubscriptionPrompt(CLAUDE_SEL, 'resuma')).rejects.toThrow(
      /error_during_execution.*API quota exhausted/,
    );
  });

  it('AC-B13 (claude-sdk): caminho feliz inalterado — assistant text + result success retorna o texto', async () => {
    state.sdkMessages = [
      { type: 'assistant', message: { content: [{ type: 'text', text: '```json\n{"ok":1}\n```' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: '{"ok":1}' },
    ];

    await expect(runSubscriptionPrompt(CLAUDE_SEL, 'resuma')).resolves.toBe('{"ok":1}');
  });

  it('AC-B13 (codex): status failed vira throw com o status + errorCode (SB-4), e a sessao e fechada', async () => {
    state.codexResponse = {
      threadId: 't1',
      content: '',
      status: 'failed',
      errorCode: 'usageLimitExceeded',
    };

    await expect(runSubscriptionPrompt(CODEX_SEL, 'resuma')).rejects.toThrow(
      /status failed \(errorCode=usageLimitExceeded\)/,
    );
    expect(state.codexClosed).toBe(1);
  });

  it('AC-B13 (codex): status timeout sem errorCode tambem vira throw explicito', async () => {
    state.codexResponse = { threadId: 't1', content: 'parcial', status: 'timeout' };

    await expect(runSubscriptionPrompt(CODEX_SEL, 'resuma')).rejects.toThrow(/status timeout/);
  });

  it('AC-B13 (codex): caminho feliz inalterado — status completed retorna o content fence-stripped', async () => {
    state.codexResponse = { threadId: 't1', content: '```json\n{"a":2}\n```', status: 'completed' };

    await expect(runSubscriptionPrompt(CODEX_SEL, 'resuma')).resolves.toBe('{"a":2}');
    expect(state.codexClosed).toBe(1);
  });

  it('AC-B13 (kimi): status max_steps_reached vira throw explicito (nao texto parcial), e o handle e fechado', async () => {
    state.kimiResponse = { content: 'parcial truncado', status: 'max_steps_reached' };

    await expect(runSubscriptionPrompt(KIMI_SEL, 'resuma')).rejects.toThrow(/status max_steps_reached/);
    expect(state.kimiClosed).toBe(1);
  });

  it('AC-B13 (kimi): caminho feliz inalterado — status finished retorna o content fence-stripped', async () => {
    state.kimiResponse = { content: '```json\n{"k":3}\n```', status: 'finished' };

    await expect(runSubscriptionPrompt(KIMI_SEL, 'resuma')).resolves.toBe('{"k":3}');
    expect(state.kimiClosed).toBe(1);
    expect(state.kimiAcquire).toHaveBeenCalledWith({ role: 'standalone', toolBearing: false });
    expect(state.kimiReleased).toBe(1);
  });

  it('Kimi one-shots simultaneos recebem UUIDs de execucao distintos', async () => {
    state.kimiResponse = { content: '{"ok":true}', status: 'finished' };
    let releaseSends!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSends = resolve;
    });
    state.kimiCreateRun.mockImplementation(async () => ({
      send: vi.fn(async () => {
        await sendGate;
        return state.kimiResponse;
      }),
      close: vi.fn(async () => {
        state.kimiClosed += 1;
      }),
    }));

    const first = runSubscriptionPrompt(KIMI_SEL, 'resuma A');
    await vi.waitFor(() => expect(state.kimiCreateRun).toHaveBeenCalledTimes(1));
    const second = runSubscriptionPrompt(KIMI_SEL, 'resuma B');
    await vi.waitFor(() => expect(state.kimiCreateRun).toHaveBeenCalledTimes(2));
    releaseSends();
    await Promise.all([first, second]);

    const runIds = state.kimiCreateRun.mock.calls.map(([opts]) => (opts as { runId: string }).runId);
    expect(runIds).toHaveLength(2);
    expect(runIds[0]).toMatch(/^kimi-oneshot-[0-9a-f-]{36}$/);
    expect(runIds[1]).toMatch(/^kimi-oneshot-[0-9a-f-]{36}$/);
    expect(runIds[1]).not.toBe(runIds[0]);
    expect(state.kimiClosed).toBe(2);
    expect(state.kimiReleased).toBe(2);
  });

  it('AC-B13 (kimi): falha em createRun ainda libera o slot global', async () => {
    state.kimiCreateRun.mockRejectedValueOnce(new Error('kimi handshake failed'));

    await expect(runSubscriptionPrompt(KIMI_SEL, 'resuma')).rejects.toThrow('kimi handshake failed');
    expect(state.kimiClosed).toBe(0);
    expect(state.kimiReleased).toBe(1);
  });

  it('AC-B13 (grok): status max_steps_reached vira erro e sempre libera handle e slot', async () => {
    state.grokResponse = { content: 'parcial truncado', status: 'max_steps_reached' };

    await expect(runSubscriptionPrompt(GROK_SEL, 'resuma')).rejects.toThrow(
      /grok one-shot terminou com status max_steps_reached/,
    );
    expect(state.grokClosed).toBe(1);
    expect(state.grokReleased).toBe(1);
  });

  it('AC-B13 (grok): fake ACP finished retorna content sem fence e usa perfil one-shot isolado', async () => {
    state.grokResponse = { content: '```json\n{"g":4}\n```', status: 'finished' };

    await expect(runSubscriptionPrompt(GROK_SEL, 'resuma')).resolves.toBe('{"g":4}');
    expect(state.grokCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: 'one-shot',
        surface: 'oneshot',
        ownerKind: 'oneshot',
        sandbox: 'strict',
        nativeToolArgs: ['--tools', '', '--disable-web-search'],
        mcpServers: [],
      }),
    );
    expect(state.grokClosed).toBe(1);
    expect(state.grokReleased).toBe(1);
  });

  it('AC-B13 (grok): auth indisponivel falha antes de criar ACP ou adquirir recurso', async () => {
    state.grokAvailability.mockResolvedValueOnce({
      installed: true,
      version: '0.2.103',
      authenticated: false,
      authMode: 'none',
      subscriptionRouteVerified: false,
      backendVerified: false,
      isolationVerified: true,
      modelAvailable: false,
      usable: false,
      reason: 'cached_token authentication failed',
    });

    await expect(runSubscriptionPrompt(GROK_SEL, 'resuma')).rejects.toThrow(/cached_token authentication failed/);
    expect(state.grokCreateRun).not.toHaveBeenCalled();
    expect(state.grokClosed).toBe(0);
    expect(state.grokReleased).toBe(0);
  });
});
