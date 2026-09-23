import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(() => undefined),
  insertAuditEntry: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getPermissionBypass: vi.fn(() => true),
  getCompletedDocsCount: vi.fn(() => 0),
}));

vi.mock('../mcp-manager', () => ({
  getAllMCPServers: vi.fn(() => []),
  getMCPConfigForAgent: vi.fn(),
}));
vi.mock('../secrets-vault', () => ({ getSecret: vi.fn(() => null) }));
vi.mock('../skills', () => ({
  listSkills: vi.fn(() => []),
  getSkill: vi.fn(() => null),
  buildSkillsPromptSection: vi.fn(() => ''),
  buildAgentSkillsPromptSection: vi.fn(() => ''),
}));
vi.mock('../ask-question', () => ({ sendAskQuestion: vi.fn() }));
vi.mock('../mcp-invoke', () => ({
  invokeMcpTool: vi.fn(),
  getMcpToolSchema: vi.fn(),
}));

const bridge = vi.hoisted(() => ({
  getCodexBinaryStatus: vi.fn().mockResolvedValue({
    installed: true,
    version: '0.140.0',
    authenticated: true,
    appServerSupported: true,
    binaryPath: '/usr/local/bin/codex',
  }),
  isCodexAvailable: vi.fn().mockResolvedValue({ installed: true, version: '0.140.0', authenticated: true }),
  CodexUnavailableError: class CodexUnavailableError extends Error {},
  CodexAuthError: class CodexAuthError extends Error {},
}));
vi.mock('../codex-runtime/binary', () => ({
  getCodexBinaryStatus: bridge.getCodexBinaryStatus,
  isCodexAvailable: bridge.isCodexAvailable,
}));
vi.mock('../codex-runtime/errors', () => ({
  CodexUnavailableError: bridge.CodexUnavailableError,
  CodexAuthError: bridge.CodexAuthError,
}));
vi.mock('../codex-runtime/windows-preflight', () => ({
  runOfficialPreFlight: vi.fn().mockReturnValue({ status: 'not-windows' }),
  resetOfficialPreparedRepos: vi.fn(),
}));
vi.mock('../app-version', () => ({ getAppVersion: () => '9.9.9' }));

import { getMCPConfigForAgent } from '../mcp-manager';
import { invokeMcpTool } from '../mcp-invoke';
import { dispatch, resolveGatedCallTurnContext, type JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import {
  setActiveChatTurn,
  clearActiveChatTurn,
  registerChatCapabilityTurn,
  __resetChatCapabilityContextForTests,
} from '../chat-capability-context';
import { OfficialAppServerDriver, type AppServerTransport } from '../codex-runtime/official-app-server-driver';
import type { AppServerEvent } from '../codex-runtime/official-event-translator';
import type { CodexRunOptions } from '../codex-runtime/types';
import {
  beginCodexTurnBarrier,
  isCodexSessionClosing,
  resetCodexTurnBarriersForTests,
} from '../codex-runtime/turn-barrier';

const mockGetConfig = getMCPConfigForAgent as ReturnType<typeof vi.fn>;
const mockInvoke = invokeMcpTool as ReturnType<typeof vi.fn>;

const SESSION = 'sess-desktop';

const ctx: JsonRpcContext = { getWindow: () => null };
const helperCtx: JsonRpcContext = {
  getWindow: () => null,
  connection: { authenticatedHelper: true, serverId: 'lionclaw-kanban' } as JsonRpcContext['connection'],
};

class FakeTransport implements AppServerTransport {
  public readonly requests: Array<{ method: string; params?: unknown }> = [];
  private handlers = new Set<(e: AppServerEvent) => void>();
  public turnScript: AppServerEvent[] | null = null;
  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === 'thread/start') return { threadId: 'thread-fake-1' };
    if (method === 'turn/start') {
      if (this.turnScript) {
        const script = this.turnScript;
        this.turnScript = null;
        queueMicrotask(() => {
          for (const e of script) this.emit(e);
        });
      }
      return { turnId: 'turn-fake-1' };
    }
    return {};
  }
  notify(): void {}
  onNotification(h: (e: AppServerEvent) => void): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  onError(): () => void {
    return () => undefined;
  }
  kill(): void {}
  async waitClosed(): Promise<boolean> {
    return true;
  }
  emit(e: AppServerEvent): void {
    for (const h of [...this.handlers]) h(e);
  }
  count(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }
}

function chatOpts(): CodexRunOptions {
  return {
    key: { surface: 'chat', ownerKind: 'chat', ownerId: SESSION, mcpProfile: 'chat', runId: 'run-1' },
    model: 'gpt-5-codex',
    cwd: '/tmp/project',
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
  };
}

function registerTurn(turnId: string): void {
  registerChatCapabilityTurn(
    {
      surface: 'chat',
      sessionId: SESSION,
      turnId,
      origin: 'user',
      capabilities: { pipelineControl: true, dynamicWorkflows: true },
      cwd: '/tmp/project',
      allowedTools: [],
      allowedServerIds: [],
      readRoots: [],
      writeRoots: [],
    },
    60_000,
  );
  setActiveChatTurn({ sessionId: SESSION, lane: 'desktop', turnId });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  resetCodexTurnBarriersForTests();
  mockGetConfig.mockResolvedValue({
    'google-gmail': { command: 'node', args: ['/x/gmail.js'] },
  });
  mockInvoke.mockResolvedValue({ content: 'ok', displayName: 'mcp__google-gmail__send_email' });
});

afterEach(() => {
  __resetChatCapabilityContextForTests();
  resetCodexTurnBarriersForTests();
});

describe('9.2 V8 - gateway recusa chamadas da sessao Codex em closing (turn_binding_required)', () => {
  it('mcp_invoke com o turno ativo da lane desktop em closing = turn_binding_required e a tool NAO executa', async () => {
    registerTurn('turn-1');
    const release = beginCodexTurnBarrier(SESSION);
    const res = await dispatch(ctx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'mcp_invoke',
      params: { server: 'google-gmail', tool: 'send_email', args: {}, surface: 'codex-sdk', sessionId: SESSION },
    });
    const result = res.result as { content: string; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content).toContain('turn_binding_required');
    expect(mockInvoke).not.toHaveBeenCalled();

    release();
    expect(isCodexSessionClosing(SESSION)).toBe(false);
    const ok = await dispatch(ctx, {
      jsonrpc: '2.0',
      id: 2,
      method: 'mcp_invoke',
      params: { server: 'google-gmail', tool: 'send_email', args: {}, surface: 'codex-sdk', sessionId: SESSION },
    });
    expect((ok.result as { isError?: boolean }).isError).toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION, turnId: 'turn-1' }));
  });

  it('resolveGatedCallTurnContext em closing = ok:false, reason session-closing, code turn_binding_required', () => {
    registerTurn('turn-1');
    const release = beginCodexTurnBarrier(SESSION);
    const closing = resolveGatedCallTurnContext(helperCtx, undefined, { lane: 'desktop', sessionId: SESSION });
    expect(closing).toMatchObject({
      ok: false,
      reason: 'session-closing',
      code: 'turn_binding_required',
      sessionId: SESSION,
      turnId: 'turn-1',
    });
    release();
    expect(resolveGatedCallTurnContext(helperCtx, undefined, { lane: 'desktop', sessionId: SESSION })).toMatchObject({
      ok: true,
      turnId: 'turn-1',
    });
  });

  it('chamada que ENTROU sob T1 mantem a identidade resolvida na entrada; closing so afeta chamadas novas', () => {
    registerTurn('turn-1');
    const entered = resolveGatedCallTurnContext(helperCtx, undefined, { lane: 'desktop', sessionId: SESSION });
    expect(entered.ok).toBe(true);
    const release = beginCodexTurnBarrier(SESSION);
    expect(entered).toMatchObject({ ok: true, sessionId: SESSION, turnId: 'turn-1' });
    expect(resolveGatedCallTurnContext(helperCtx, undefined, { lane: 'desktop', sessionId: SESSION }).ok).toBe(false);
    release();
  });

  it('AC-21a/b integrado: driver real com app-server fake; stop marca closing (gateway recusa), terminal libera, T2 resolve com a identidade de T2', async () => {
    const t = new FakeTransport();
    const driver = new OfficialAppServerDriver(async () => t);
    const handle = await driver.createRun(chatOpts());

    registerTurn('turn-1');
    t.turnScript = [{ method: 'turn/started', params: { turnId: 'turn-fake-1' } }];
    const ac = new AbortController();
    const p1 = handle.send('T1', {}, ac.signal);
    await tick();

    const before = await dispatch(ctx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'mcp_invoke',
      params: { server: 'google-gmail', tool: 'send_email', args: {}, surface: 'codex-sdk', sessionId: SESSION },
    });
    expect((before.result as { isError?: boolean }).isError).toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    ac.abort();
    await tick();
    expect(t.count('turn/interrupt')).toBe(1);
    expect(isCodexSessionClosing(SESSION)).toBe(true);

    const during = await dispatch(ctx, {
      jsonrpc: '2.0',
      id: 2,
      method: 'mcp_invoke',
      params: { server: 'google-gmail', tool: 'send_email', args: {}, surface: 'codex-sdk', sessionId: SESSION },
    });
    expect((during.result as { isError?: boolean; content: string }).isError).toBe(true);
    expect((during.result as { content: string }).content).toContain('turn_binding_required');
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(t.count('turn/start')).toBe(1);

    t.emit({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } });
    await expect(p1).resolves.toMatchObject({ status: 'failed' });
    expect(handle.status).toBe('interrupted');
    expect(isCodexSessionClosing(SESSION)).toBe(false);

    clearActiveChatTurn({ sessionId: SESSION, lane: 'desktop', turnId: 'turn-1' });
    registerTurn('turn-2');
    t.turnScript = [
      { method: 'turn/started', params: { turnId: 'turn-fake-1' } },
      { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    ];
    await expect(handle.reply('T2')).resolves.toMatchObject({ status: 'completed' });
    expect(t.count('turn/start')).toBe(2);

    const after = await dispatch(ctx, {
      jsonrpc: '2.0',
      id: 3,
      method: 'mcp_invoke',
      params: { server: 'google-gmail', tool: 'send_email', args: {}, surface: 'codex-sdk', sessionId: SESSION },
    });
    expect((after.result as { isError?: boolean }).isError).toBeUndefined();
    expect(mockInvoke).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: SESSION, turnId: 'turn-2' }));
  });
});
