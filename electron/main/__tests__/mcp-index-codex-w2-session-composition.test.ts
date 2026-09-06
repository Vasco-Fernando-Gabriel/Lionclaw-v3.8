
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../db', () => ({
  getAllMCPServers: () => [],
  getPermissionBypass: () => false,
  getSetting: vi.fn(() => undefined),
}));

vi.mock('../paths', () => ({ getAgentCwd: () => '/tmp/w2-session' }));

vi.mock('../prompt-builder', () => ({
  buildSystemPrompt: () => 'LION-PROMPT',
  loadGeneratedAgentContext: () => 'PERSONA',
}));

vi.mock('../prompt-builder-repo-graph', () => ({
  appendRepoGraphSection: (p: string) => p,
}));

const captured = vi.hoisted(() => ({
  runs: [] as Array<{ extraArgs?: string[] }>,
}));
vi.mock('../agent-runtime/codex-session-factory', () => ({
  resolveCodexSessionForRun: vi.fn(
    async (args: { extraArgs?: string[] }) => {
      captured.runs.push(args);
      return { threadId: null, close: () => undefined };
    },
  ),
}));

const composition = vi.hoisted(() => ({
  resolve: vi.fn(
    (
      _opts?: { agentId?: string; isOnboarding?: boolean },
    ): { mode: 'index' | 'full'; extraArgs: string[]; fingerprint: string | null } => ({
      mode: 'full',
      extraArgs: [],
      fingerprint: null,
    }),
  ),
}));
vi.mock('../codex-chat-spawn-extras', () => ({
  resolveChatCodexMcpComposition: (
    opts?: { agentId?: string; isOnboarding?: boolean },
  ) => composition.resolve(opts as never),
}));

import { createChatCodexSession } from '../codex-sdk/session';

const INDEX_COMPOSITION = {
  mode: 'index' as const,
  extraArgs: ['-c', 'mcp_servers.drive.enabled=false', '-c', 'mcp_servers.lionclaw-gateway.enabled=true'],
  fingerprint: JSON.stringify({ servers: ['drive'], gatewayEntry: true }),
};

beforeEach(() => {
  vi.clearAllMocks();
  captured.runs.length = 0;
});

describe('createChatCodexSession - composicao do spawn (W2)', () => {
  it('composicao INDEX do caller => extraArgs no factory', async () => {
    await createChatCodexSession({
      sessionId: 's1',
      model: 'gpt-5.5',
      mcpComposition: INDEX_COMPOSITION,
    });
    expect(captured.runs).toHaveLength(1);
    expect(captured.runs[0].extraArgs).toEqual(INDEX_COMPOSITION.extraArgs);
    expect(composition.resolve).not.toHaveBeenCalled();
  });

  it('composicao FULL do caller => extraArgs undefined', async () => {
    await createChatCodexSession({
      sessionId: 's1',
      model: 'gpt-5.5',
      mcpComposition: { mode: 'full', extraArgs: [], fingerprint: null },
    });
    expect(captured.runs[0].extraArgs).toBeUndefined();
  });

  it('sem composicao do caller: resolve internamente com os mesmos gates (agentId/onboarding threadados)', async () => {
    composition.resolve.mockReturnValueOnce({
      mode: 'index',
      extraArgs: INDEX_COMPOSITION.extraArgs,
      fingerprint: INDEX_COMPOSITION.fingerprint,
    });
    await createChatCodexSession({ sessionId: 's1', model: 'gpt-5.5', agentId: 'persona-x' });
    expect(composition.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'persona-x' }),
    );
    expect(captured.runs[0].extraArgs).toEqual(INDEX_COMPOSITION.extraArgs);
  });
});
