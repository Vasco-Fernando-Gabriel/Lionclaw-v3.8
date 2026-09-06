
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';


let SANDBOX = '';

const hoisted = vi.hoisted(() => {
  const logEntries: Array<{ level: string; data: unknown; msg: string }> = [];
  const makeLevel =
    (level: string) =>
    (...args: unknown[]) => {
      const [first, second] = args;
      if (typeof first === 'string') {
        logEntries.push({ level, data: undefined, msg: first });
      } else {
        logEntries.push({ level, data: first, msg: typeof second === 'string' ? second : '' });
      }
    };
  const state: { activeChatSession: { id: string } | null } = { activeChatSession: null };
  const auditEntries: Array<Record<string, unknown>> = [];
  return { logEntries, makeLevel, state, auditEntries };
});

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: hoisted.makeLevel('info'),
    warn: hoisted.makeLevel('warn'),
    error: hoisted.makeLevel('error'),
    debug: hoisted.makeLevel('debug'),
  }),
}));

vi.mock('../paths', () => ({
  getLionClawHome: () => SANDBOX,
  getAgentCwd: () => SANDBOX,
  getBackgroundCwd: () => path.join(SANDBOX, 'background'),
}));

vi.mock('../db', () => ({
  getAllAgents: () => [],
  getAgent: () => undefined,
  getActiveChatSession: () => hoisted.state.activeChatSession,
  getPermissionBypass: () => true,
  getCompletedDocsCount: () => 0,
  insertAuditEntry: (entry: Record<string, unknown>) => {
    hoisted.auditEntries.push({ ...entry });
  },
}));

vi.mock('../mcp-manager', () => ({
  getAllMCPServers: () => [],
  getMCPConfigForAgent: vi.fn(async () => ({})),
}));

vi.mock('../secrets-vault', () => ({ getSecret: async () => null }));

vi.mock('../ask-question', () => ({
  sendAskQuestion: async () => ({ id: 'unused', answers: [] }),
}));

vi.mock('../skills', () => ({
  listSkills: () => [],
  getSkill: () => null,
}));

vi.mock('../pipeline-control-core', () => ({
  isPipelineWriteAction: () => false,
  pipelineListCore: () => ({ ok: true, value: [{ id: 'p1', name: 'Pipe 1' }] }),
  pipelineInspectCore: vi.fn(),
  pipelineCreateCore: vi.fn(),
  pipelineDriveCore: vi.fn(),
  pipelineReplyCore: vi.fn(),
  pipelineApproveCore: vi.fn(),
  pipelineEscalateCore: vi.fn(),
  pipelineAbortCore: vi.fn(),
  pipelinePauseCore: vi.fn(),
  designSessionConfigCore: vi.fn(),
  normalizeApproveMetadata: (m: unknown) => m,
}));


import {
  startLocalIpcServer,
  stopLocalIpcServer,
  getCurrentEndpoint,
} from '../local-ipc';
import {
  dispatch,
  resolveGatedCallTurnContext,
  type JsonRpcContext,
} from '../local-ipc/jsonrpc-methods';
import {
  mintHelperToken,
  isValidHelperToken,
  LIONCLAW_HELPER_TOKEN_ENV,
  __resetHelperIdentityForTests,
} from '../helper-identity';
import {
  registerChatCapabilityTurn,
  setActiveChatTurn,
  __resetChatCapabilityContextForTests,
} from '../chat-capability-context';
import { LocalIpcClient } from '../../../mcp-servers/_shared/local-ipc-client';
import { generateWrapper, CHAT_GATED_HELPER_IDS } from '../codex-sdk/mcp-wrapper-generator';

const IS_POSIX = process.platform !== 'win32';


interface LineReader {
  next: () => Promise<string>;
}

function attachLineReader(socket: net.Socket): LineReader {
  let buffer = '';
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) {
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else lines.push(line);
      }
      nl = buffer.indexOf('\n');
    }
  });
  return {
    next: () =>
      new Promise<string>((resolve, reject) => {
        const queued = lines.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(() => reject(new Error('line-reader timeout')), 5000);
        waiters.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
      }),
  };
}

function connectRaw(address: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

interface RawResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Record<string, unknown> | unknown[];
  error?: { code: number; message: string };
}

async function rpcRaw(
  socket: net.Socket,
  reader: LineReader,
  frame: Record<string, unknown>,
): Promise<RawResponse> {
  socket.write(JSON.stringify(frame) + '\n');
  return JSON.parse(await reader.next()) as RawResponse;
}


function handshakeAuthLogs(): number {
  return hoisted.logEntries.filter((e) => e.msg.includes('autenticada via handshake')).length;
}

function anyHandshakeLogs(): number {
  return hoisted.logEntries.filter((e) => e.msg.toLowerCase().includes('handshake')).length;
}

function shadowLogs(): Array<{ data: Record<string, unknown>; msg: string }> {
  return hoisted.logEntries
    .filter((e) => e.msg.startsWith('S3b shadow'))
    .map((e) => ({ data: (e.data ?? {}) as Record<string, unknown>, msg: e.msg }));
}


beforeEach(async () => {
  const shortRoot = IS_POSIX ? '/tmp' : os.tmpdir();
  SANDBOX = await fs.promises.mkdtemp(path.join(shortRoot, 'lc-hs-'));
  hoisted.logEntries.length = 0;
  hoisted.auditEntries.length = 0;
  hoisted.state.activeChatSession = null;
  delete process.env[LIONCLAW_HELPER_TOKEN_ENV];
  __resetHelperIdentityForTests();
  __resetChatCapabilityContextForTests();
});

afterEach(async () => {
  delete process.env[LIONCLAW_HELPER_TOKEN_ENV];
  try {
    await stopLocalIpcServer();
  } catch {
  }
  try {
    await fs.promises.rm(SANDBOX, { recursive: true, force: true });
  } catch {
  }
});

async function startServer(): Promise<string> {
  await startLocalIpcServer();
  const endpoint = getCurrentEndpoint();
  expect(endpoint).not.toBeNull();
  return endpoint!.address;
}

function seedActiveDesktopTurn(sessionId = 'sess-1', turnId = 'turn-1'): void {
  registerChatCapabilityTurn({
    surface: 'chat',
    sessionId,
    turnId,
    capabilities: { pipelineControl: true, dynamicWorkflows: false },
  });
  setActiveChatTurn({ sessionId, lane: 'desktop', turnId });
}


describe('handshake por conexao (server local-ipc)', () => {
  it('token valido marca a conexao como authenticated helper', async () => {
    const address = await startServer();
    const token = mintHelperToken();
    const socket = await connectRaw(address);
    const reader = attachLineReader(socket);
    try {
      const res = await rpcRaw(socket, reader, {
        jsonrpc: '2.0',
        id: 1,
        method: 'handshake',
        params: { token },
      });
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ ok: true, authenticated: true, serverId: 'unknown-helper' });
      expect(handshakeAuthLogs()).toBe(1);

      hoisted.state.activeChatSession = { id: 'sess-1' };
      seedActiveDesktopTurn('sess-1', 'turn-1');
      const gated = await rpcRaw(socket, reader, {
        jsonrpc: '2.0',
        id: 2,
        method: 'pipeline_list',
        params: {},
      });
      expect(gated.error).toBeUndefined();
      expect(gated.result).toEqual([{ id: 'p1', name: 'Pipe 1' }]);

      const shadow = shadowLogs();
      expect(shadow).toHaveLength(1);
      expect(shadow[0].data['resolved']).toBe(true);
      expect(shadow[0].data['sessionId']).toBe('sess-1');
      expect(shadow[0].data['turnId']).toBe('turn-1');
      expect(shadow[0].data['capabilities']).toEqual({
        pipelineControl: true,
        dynamicWorkflows: false,
      });
    } finally {
      socket.destroy();
    }
  });

  it('token invalido NAO marca auth (RPC error -32001) e a conexao segue funcional', async () => {
    const address = await startServer();
    const socket = await connectRaw(address);
    const reader = attachLineReader(socket);
    try {
      const res = await rpcRaw(socket, reader, {
        jsonrpc: '2.0',
        id: 1,
        method: 'handshake',
        params: { token: 'token-forjado-que-o-main-nunca-cunhou' },
      });
      expect(res.result).toBeUndefined();
      expect(res.error?.code).toBe(-32001);
      expect(handshakeAuthLogs()).toBe(0);

      const skills = await rpcRaw(socket, reader, {
        jsonrpc: '2.0',
        id: 2,
        method: 'list_skills',
        params: {},
      });
      expect(skills.error).toBeUndefined();
      expect(skills.result).toEqual([]);

      hoisted.state.activeChatSession = { id: 'sess-1' };
      const gated = await rpcRaw(socket, reader, {
        jsonrpc: '2.0',
        id: 3,
        method: 'pipeline_list',
        params: {},
      });
      expect(gated.error).toBeUndefined();
      expect(gated.result).toEqual([{ id: 'p1', name: 'Pipe 1' }]);
      const shadow = shadowLogs();
      expect(shadow).toHaveLength(1);
      expect(shadow[0].data['resolved']).toBe(false);
      expect(shadow[0].data['reason']).toBe('unauthenticated-connection');
    } finally {
      socket.destroy();
    }
  });

  it('handshake sem token / "none" e inocuo (authenticated: false, sem erro)', async () => {
    const address = await startServer();
    const socket = await connectRaw(address);
    const reader = attachLineReader(socket);
    try {
      const semToken = await rpcRaw(socket, reader, {
        jsonrpc: '2.0',
        id: 1,
        method: 'handshake',
        params: {},
      });
      expect(semToken.error).toBeUndefined();
      expect(semToken.result).toEqual({ ok: true, authenticated: false });

      const none = await rpcRaw(socket, reader, {
        jsonrpc: '2.0',
        id: 2,
        method: 'handshake',
        params: { token: 'none' },
      });
      expect(none.error).toBeUndefined();
      expect(none.result).toEqual({ ok: true, authenticated: false });
    } finally {
      socket.destroy();
    }
  });

  it('TOLERANCIA: client sem handshake nenhum segue 100% funcional (nao-gated E gated)', async () => {
    const address = await startServer();
    const socket = await connectRaw(address);
    const reader = attachLineReader(socket);
    try {
      const skills = await rpcRaw(socket, reader, {
        jsonrpc: '2.0',
        id: 1,
        method: 'list_skills',
        params: {},
      });
      expect(skills.error).toBeUndefined();
      expect(skills.result).toEqual([]);

      hoisted.state.activeChatSession = { id: 'sess-1' };
      const gated = await rpcRaw(socket, reader, {
        jsonrpc: '2.0',
        id: 2,
        method: 'pipeline_list',
        params: {},
      });
      expect(gated.error).toBeUndefined();
      expect(gated.result).toEqual([{ id: 'p1', name: 'Pipe 1' }]);
    } finally {
      socket.destroy();
    }
  });
});


describe('LocalIpcClient: handshake no connect e re-handshake no reconnect', () => {
  it('com token no env, envia handshake em TODA conexao nova (inclui reconexao)', async () => {
    await startServer();
    process.env[LIONCLAW_HELPER_TOKEN_ENV] = mintHelperToken();

    const client = new LocalIpcClient({
      lionclawHome: SANDBOX,
      maxRetries: 2,
      baseBackoffMs: 50,
      maxBackoffMs: 500,
      callTimeoutMs: 5000,
    });
    try {
      const first = await client.callMethod('list_skills', {});
      expect(first).toEqual([]);
      expect(handshakeAuthLogs()).toBe(1);

      const inner = (client as unknown as { socket: net.Socket | null }).socket;
      expect(inner).not.toBeNull();
      inner!.destroy();
      await new Promise((r) => setTimeout(r, 50));

      const second = await client.callMethod('list_skills', {});
      expect(second).toEqual([]);
      expect(handshakeAuthLogs()).toBe(2);
    } finally {
      client.close();
    }
  });

  it('sem token no env (helper nao-gated), NAO envia handshake e funciona 100%', async () => {
    await startServer();
    expect(process.env[LIONCLAW_HELPER_TOKEN_ENV]).toBeUndefined();

    const client = new LocalIpcClient({
      lionclawHome: SANDBOX,
      maxRetries: 2,
      baseBackoffMs: 50,
      maxBackoffMs: 500,
      callTimeoutMs: 5000,
    });
    try {
      const result = await client.callMethod('list_skills', {});
      expect(result).toEqual([]);
      expect(anyHandshakeLogs()).toBe(0);
    } finally {
      client.close();
    }
  });
});


describe('resolveGatedCallTurnContext (0.7 item 3)', () => {
  const authedCtx: JsonRpcContext = {
    getWindow: () => null,
    connection: { authenticatedHelper: true },
  };

  it('conexao nao autenticada -> unauthenticated-connection (sem lancar)', () => {
    expect(resolveGatedCallTurnContext({ getWindow: () => null })).toEqual({
      ok: false,
      reason: 'unauthenticated-connection',
    });
    expect(
      resolveGatedCallTurnContext({
        getWindow: () => null,
        connection: { authenticatedHelper: false },
      }),
    ).toEqual({ ok: false, reason: 'unauthenticated-connection' });
  });

  it('autenticada sem turno desktop ativo -> no-active-desktop-turn', () => {
    expect(resolveGatedCallTurnContext(authedCtx)).toEqual({
      ok: false,
      reason: 'no-active-desktop-turn',
    });
  });

  it('turno ativo sem turn-context vivo -> turn-context-missing (com a chave resolvida)', () => {
    setActiveChatTurn({ sessionId: 'sess-9', lane: 'desktop', turnId: 'turn-9' });
    expect(resolveGatedCallTurnContext(authedCtx)).toEqual({
      ok: false,
      reason: 'turn-context-missing',
      sessionId: 'sess-9',
      turnId: 'turn-9',
    });
  });

  it('degraus completos -> ok com turn-context do turno ativo da lane desktop', () => {
    seedActiveDesktopTurn('sess-2', 'turn-7');
    const resolution = resolveGatedCallTurnContext(authedCtx);
    expect(resolution.ok).toBe(true);
    expect(resolution.reason).toBe('ok');
    expect(resolution.sessionId).toBe('sess-2');
    expect(resolution.turnId).toBe('turn-7');
    expect(resolution.turnContext?.capabilities).toEqual({
      pipelineControl: true,
      dynamicWorkflows: false,
    });
    expect(resolution.turnContext?.origin).toBe('user');
  });

  it('SHADOW no dispatch: loga o fail-closed e NAO nega a chamada gated', async () => {
    hoisted.state.activeChatSession = { id: 'sess-1' };
    const res = await dispatch(
      { getWindow: () => null },
      { jsonrpc: '2.0', id: 5, method: 'pipeline_list', params: {} },
    );
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual([{ id: 'p1', name: 'Pipe 1' }]);
    const shadow = shadowLogs();
    expect(shadow).toHaveLength(1);
    expect(shadow[0].msg).toContain('FAIL-CLOSED');
    expect(shadow[0].data['resolved']).toBe(false);
    expect(shadow[0].data['action']).toBe('pipeline_list');
  });

  it('SHADOW nunca loga o internalLeaseToken', async () => {
    hoisted.state.activeChatSession = { id: 'sess-1' };
    registerChatCapabilityTurn({
      surface: 'chat',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      origin: 'system-event',
      capabilities: { pipelineControl: true, dynamicWorkflows: false },
      internalLeaseToken: 'LEASE-SECRETA-NUNCA-LOGAR',
    });
    setActiveChatTurn({ sessionId: 'sess-1', lane: 'desktop', turnId: 'turn-1' });
    await dispatch(
      { getWindow: () => null, connection: { authenticatedHelper: true } },
      { jsonrpc: '2.0', id: 6, method: 'pipeline_list', params: {} },
    );
    const serialized = JSON.stringify(hoisted.logEntries);
    expect(serialized).not.toContain('LEASE-SECRETA-NUNCA-LOGAR');
  });
});


describe('mint_helper_token (wrapper codex)', () => {
  const ctx: JsonRpcContext = { getWindow: () => null };

  it('cunha token valido para helper gated e audita SEM o valor do token', async () => {
    const res = await dispatch(ctx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'mint_helper_token',
      params: { server_id: 'lionclaw-pipeline-control', caller_pid: 4242 },
    });
    expect(res.error).toBeUndefined();
    const token = (res.result as { token: string }).token;
    expect(typeof token).toBe('string');
    expect(isValidHelperToken(token)).toBe(true);

    const audit = hoisted.auditEntries.find((e) => e['toolName'] === 'mint_helper_token');
    expect(audit).toBeDefined();
    expect(String(audit!['input'])).toContain('lionclaw-pipeline-control');
    expect(String(audit!['input'])).toContain('4242');
    expect(JSON.stringify(hoisted.auditEntries)).not.toContain(token);
  });

  it('server_id fora dos helpers gated -> RPC error (fail-closed no mint)', async () => {
    const res = await dispatch(ctx, {
      jsonrpc: '2.0',
      id: 2,
      method: 'mint_helper_token',
      params: { server_id: 'google-gmail', caller_pid: 1 },
    });
    expect(res.result).toBeUndefined();
    expect(res.error?.code).toBe(-32000);
    expect(res.error?.message).toContain('nao e um helper gated');
  });

  it('token cunhado via mint vincula o serverId no handshake do Codex', async () => {
    const address = await startServer();
    const minted = await dispatch(ctx, {
      jsonrpc: '2.0',
      id: 3,
      method: 'mint_helper_token',
      params: { server_id: 'lionclaw-dynamic-workflows', caller_pid: 7 },
    });
    const token = (minted.result as { token: string }).token;

    const socket = await connectRaw(address);
    const reader = attachLineReader(socket);
    try {
      const res = await rpcRaw(socket, reader, {
        jsonrpc: '2.0',
        id: 4,
        method: 'handshake',
        params: { token },
      });
      expect(res.result).toEqual({
        ok: true,
        authenticated: true,
        serverId: 'lionclaw-dynamic-workflows',
      });
    } finally {
      socket.destroy();
    }
  });
});


describe('generateWrapper com fetchHelperToken (S3b item 4)', () => {
  it('helpers gated: o wrapper busca mint_helper_token e injeta LIONCLAW_HELPER_TOKEN', () => {
    const source = generateWrapper(
      'lionclaw-pipeline-control',
      'node',
      ['/x/pc.js'],
      [],
      '/home/x/.lionclaw',
      { fetchHelperToken: true },
    );
    expect(source).toContain('const FETCH_HELPER_TOKEN = true;');
    expect(source).toContain('mint_helper_token');
    expect(source).toContain(`"${LIONCLAW_HELPER_TOKEN_ENV}"`);
    expect(source).toContain('child runs anonymous');
  });

  it('default (sem opcao): comportamento atual preservado, sem token fetch', () => {
    const source = generateWrapper(
      'google-gmail',
      'node',
      ['/x/gmail.js'],
      ['GOOGLE_OAUTH_TOKEN'],
      '/home/x/.lionclaw',
    );
    expect(source).toContain('const FETCH_HELPER_TOKEN = false;');
    expect(source).toContain('get_mcp_env');
  });

  it('CHAT_GATED_HELPER_IDS espelha os helpers gated da S3a', () => {
    expect([...CHAT_GATED_HELPER_IDS].sort()).toEqual([
      'lionclaw-dynamic-workflows',
      'lionclaw-pipeline-control',
    ]);
  });
});
