import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tempState = vi.hoisted(() => ({
  home: '',
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../paths', () => ({
  getLionClawHome: () => tempState.home,
}));

vi.mock('../../db', () => ({
  getEnabledTools: vi.fn(() => []),
  getSetting: vi.fn(() => undefined),
  getSessionActiveRepository: vi.fn(() => null),
  getLocalRepository: vi.fn(() => null),
}));

vi.mock('../../prompt-builder', () => ({
  buildSystemPrompt: vi.fn(() => 'LION PROMPT'),
  loadGeneratedAgentContext: vi.fn(() => 'GENERATED CONTEXT'),
}));

const getSecretMock = vi.hoisted(() => vi.fn());
vi.mock('../../secrets-vault', () => ({
  getSecret: (key: string) => getSecretMock(key),
}));

const baseGuardMock = vi.hoisted(() => vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} })));
vi.mock('../../permission-guard', () => ({
  createPermissionGuard: vi.fn(() => baseGuardMock),
}));

const dispatchContextState = vi.hoisted(() => ({
  captured: undefined as Record<string, unknown> | undefined,
}));
vi.mock('../../agent-runtime/subagent-dispatch', () => ({
  createSubagentDispatchContext: vi.fn((args: Record<string, unknown>) => {
    dispatchContextState.captured = args;
    return { ...args, rootExecutionId: 'root-x', depth: 0 };
  }),
  pendingSubagentProviderAuthError: vi.fn(() => null),
  resolveSubagentHostAllowedTools: vi.fn(async () => []),
}));

vi.mock('../../agent-runtime/chat-effort-inheritance', () => ({
  resolveChatInheritedEffort: vi.fn(() => undefined),
}));

vi.mock('../../agent-runtime/cursor-session-config', () => ({
  buildCursorSessionTools: vi.fn(async (args: { systemPrompt: string }) => ({
    declarations: [
      { name: 'mcp_invoke', description: 'meta', inputSchema: { type: 'object' } },
      { name: 'lion_run_subagent', description: 'sub', inputSchema: { type: 'object' } },
    ],
    handlers: {},
    systemPrompt: `BRIDGE:${args.systemPrompt}`,
    allowedServerIds: [],
  })),
}));

vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn(async () => ({})),
}));

type SidecarConfig = Record<string, unknown>;
const sidecarState = vi.hoisted(() => ({
  configs: [] as SidecarConfig[],
  result: {
    status: 'finished',
    finalText: 'ok',
    agentId: 'agent-abc',
  } as Record<string, unknown>,
}));
vi.mock('../../agent-runtime/cursor-sidecar/sidecar-manager', () => ({
  runCursorSidecarExecution: vi.fn(async (opts: { config: SidecarConfig }) => {
    sidecarState.configs.push(opts.config);
    return { ...sidecarState.result };
  }),
}));

import { createChatCursorSession, buildCursorChatSessionKey } from '../session';
import { CURSOR_GUARDED_NATIVE_ALLOWLIST } from '../../agent-runtime/cursor-sidecar/guarded-tools';
import { cursorSessionStoreDir, loadCursorSession } from '../../agent-runtime/cursor-sidecar/session-registry';
import { CURSOR_CHAT_RULES_RELPATH } from '../workspace';
import { TypedProviderError } from '../../agent-runtime/llm-error';

function baseOptions(overrides?: Record<string, unknown>) {
  return {
    sessionId: 'sess-driver',
    model: 'composer-2.5',
    getWindow: () => null,
    abortController: new AbortController(),
    lane: 'desktop' as const,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sidecarState.configs.length = 0;
  sidecarState.result = { status: 'finished', finalText: 'ok', agentId: 'agent-abc' };
  getSecretMock.mockResolvedValue('cursor-key-123');
  tempState.home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-driver-'));
});

afterEach(() => {
  try {
    fs.rmSync(tempState.home, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('createChatCursorSession — driver da surface cursor-sdk', () => {
  it('modelo fora do catalogo -> LLM-MODEL-404 (pertencimento, nunca prefixo)', async () => {
    await expect(createChatCursorSession(baseOptions({ model: 'gpt-4o-mini' }))).rejects.toMatchObject({
      code: 'LLM-MODEL-404',
    });
    await expect(createChatCursorSession(baseOptions({ model: 'gpt-4o-mini' }))).rejects.toBeInstanceOf(
      TypedProviderError,
    );
  });

  it('sem CURSOR_API_KEY no Vault -> LLM-AUTH-401', async () => {
    getSecretMock.mockResolvedValue(null);
    await expect(createChatCursorSession(baseOptions())).rejects.toMatchObject({
      code: 'LLM-AUTH-401',
    });
    expect(getSecretMock).toHaveBeenCalledWith('CURSOR_API_KEY');
  });

  it('send: settingSources MINIMOS, enforcement guardado e policy em TODO send', async () => {
    const session = await createChatCursorSession(baseOptions());
    expect(session.resuming).toBe(false);

    const result = await session.send('oi', () => {});
    expect(result.status).toBe('finished');
    expect(sidecarState.configs).toHaveLength(1);
    const config = sidecarState.configs[0];
    expect(config['settingSources']).toEqual(['project']);
    expect(config['guarded']).toBe(true);
    expect(config['allowedTools']).toEqual([...CURSOR_GUARDED_NATIVE_ALLOWLIST]);
    expect(config['model']).toBe('composer-2.5');
    expect(config['apiKey']).toBe('cursor-key-123');
    expect(config['resumeAgentId']).toBeUndefined();
    const toolNames = (config['customTools'] as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toContain('mcp_invoke');
    expect(toolNames).toContain('lion_run_subagent');
    expect(toolNames).toContain('lion_write');
    expect(toolNames).toContain('lion_edit');
    expect(toolNames).not.toContain('lion_shell');
    expect(String(config['cwd'])).toContain(path.join(tempState.home, 'runtime', 'cursor-chat-workspaces', 'desktop'));
  });

  it('rules materializadas no workspace proprio, com alwaysApply e o prompt da ponte', async () => {
    const session = await createChatCursorSession(baseOptions());
    const rulesPath = path.join(session.workspace.workspaceDir, CURSOR_CHAT_RULES_RELPATH);
    expect(fs.existsSync(rulesPath)).toBe(true);
    const body = fs.readFileSync(rulesPath, 'utf8');
    expect(body).toContain('alwaysApply: true');
    expect(body).toContain('BRIDGE:');
    expect(body).toContain('LION PROMPT');
    expect(body).toContain('GENERATED CONTEXT');
  });

  it('guard composto NEGA escrita no subtree .cursor da sessao (fonte de instrucao protegida)', async () => {
    const session = await createChatCursorSession(baseOptions());
    const permission = (dispatchContextState.captured as { permission: { canUseTool: Function } }).permission;
    const denied = await permission.canUseTool(
      'Write',
      { file_path: path.join(session.workspace.workspaceDir, '.cursor', 'rules', 'x.mdc') },
      {},
    );
    expect(denied).toMatchObject({ behavior: 'deny' });
    expect(baseGuardMock).not.toHaveBeenCalled();

    const allowed = await permission.canUseTool('Write', { file_path: path.join(tempState.home, 'USER.md') }, {});
    expect(allowed).toMatchObject({ behavior: 'allow' });
    expect(baseGuardMock).toHaveBeenCalledTimes(1);
  });

  it('continuidade: agentId salvo no registry; resume REAPLICA a policy (F3/G11-e)', async () => {
    const first = await createChatCursorSession(baseOptions());
    await first.send('primeiro turno', () => {});

    const sessionKey = buildCursorChatSessionKey('desktop', 'sess-driver');
    const record = loadCursorSession(sessionKey);
    expect(record?.cursorAgentId).toBe('agent-abc');

    const second = await createChatCursorSession(baseOptions());
    expect(second.resuming).toBe(true);
    await second.send('segundo turno', () => {});
    const config = sidecarState.configs[1];
    expect(config['resumeAgentId']).toBe('agent-abc');
    expect(config['guarded']).toBe(true);
    expect(config['allowedTools']).toEqual([...CURSOR_GUARDED_NATIVE_ALLOWLIST]);
    expect((config['customTools'] as unknown[]).length).toBeGreaterThan(0);
    expect(config['storeDir']).toBe(cursorSessionStoreDir(sessionKey));
  });

  it('lanes remotas usam workspace proprio da lane e perfil remote-chat (sem MCP do desktop)', async () => {
    const { buildCursorSessionTools } = await import('../../agent-runtime/cursor-session-config');
    const { getMCPConfigForAgent } = await import('../../mcp-manager');
    const session = await createChatCursorSession(baseOptions({ lane: 'telegram' }));
    expect(session.workspace.workspaceDir).toContain(path.join('cursor-chat-workspaces', 'telegram'));
    expect(getMCPConfigForAgent).not.toHaveBeenCalled();
    const args = (buildCursorSessionTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      profile: string;
    };
    expect(args.profile).toBe('remote-chat');
  });
});
