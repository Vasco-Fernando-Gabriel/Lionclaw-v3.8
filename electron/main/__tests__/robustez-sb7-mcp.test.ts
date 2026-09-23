import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { dbRuns, fakeDb, spawnMock } = vi.hoisted(() => {
  const dbRuns: Array<{ sql: string; args: unknown[] }> = [];
  const serverRow = {
    id: 'srv1',
    name: 'Server 1',
    command: 'fake-mcp',
    args: '[]',
    env_keys: '[]',
    is_active: 1,
    visible_to: 'all',
    index_mode: 'tools',
  };
  const fakeDb = {
    prepare: (sql: string) => ({
      get: (..._args: unknown[]) => (sql.includes('FROM mcp_servers') ? serverRow : undefined),
      all: (..._args: unknown[]) => [],
      run: (...args: unknown[]) => {
        dbRuns.push({ sql, args });
        return { changes: 1 };
      },
    }),
    transaction:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  };
  return { dbRuns, fakeDb, spawnMock: vi.fn() };
});

vi.mock('../db', () => ({
  getDb: () => fakeDb,
  getSetting: vi.fn(() => undefined),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(async () => undefined),
}));

vi.mock('../kill-process-tree', () => ({
  DETACH_FOR_TREE_KILL: false,
  killProcessTree: vi.fn(),
}));

vi.mock('../app-version', () => ({
  getAppVersion: () => '0.0.0-test',
}));

vi.mock('../chat-capability-gate', () => ({
  getChatCapabilityForServer: vi.fn(() => null),
  assertChatCapability: vi.fn(() => ({ ok: true })),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import {
  discoverAndSaveMCPTools,
  getServerStatus,
  getServerErrorState,
  registerMcpStatusChangedEmitter,
  type McpStatusChangedPayload,
} from '../mcp-manager';
import { normalizeMcpToolCallResult, isMcpEmptyErrorResult, callMCPTool } from '../mcp-tool-bridge';
import { lionMcpCall } from '../lion-sdk/tools/mcp';
import type { McpServerConnection, McpSessionClient } from '../mcp-tool-bridge';

function makeFakeClient(responder: (id: number) => Record<string, unknown>): McpSessionClient {
  const conn: McpServerConnection = {
    serverId: 'srv1',
    proc: undefined,
    ownedBySession: true,
    stdoutBuf: '',
    pending: new Map(),
    nextId: 1,
    stdin: {
      write(data: unknown): boolean {
        const msg = JSON.parse(String(data)) as { id?: number };
        if (typeof msg.id === 'number') {
          const cb = conn.pending.get(msg.id);
          conn.pending.delete(msg.id);
          setImmediate(() => cb?.resolve(responder(msg.id as number)));
        }
        return true;
      },
    } as unknown as NodeJS.WritableStream,
  };
  return { connections: [conn] };
}

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    written: [] as string[],
    write(data: string): boolean {
      this.written.push(data);
      return true;
    },
  };
  pid = 4242;
  kill = vi.fn();
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('SB-7 AC-B18: crash no handshake de discovery', () => {
  let payloads: McpStatusChangedPayload[];

  beforeEach(() => {
    dbRuns.length = 0;
    payloads = [];
    registerMcpStatusChangedEmitter((p) => payloads.push(p));
    spawnMock.mockReset();
  });

  it('AC-B18: exit antes do handshake REJEITA, NAO apaga o registry e marca status error', async () => {
    const proc = new FakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = discoverAndSaveMCPTools('srv1');
    await nextTick();
    proc.emit('exit', 1);

    await expect(promise).rejects.toThrow(/exited before discovery/i);

    const registryWrites = dbRuns.filter((r) => r.sql.includes('mcp_tool_registry'));
    expect(registryWrites).toHaveLength(0);

    expect(getServerStatus('srv1')).toBe('error');
    expect(getServerErrorState('srv1')?.error).toContain('MCP-DISCOVERY-FAIL');

    const errorPayload = payloads.find((p) => p.id === 'srv1' && p.status === 'error');
    expect(errorPayload).toBeDefined();
    expect(errorPayload!.error).toContain('MCP-DISCOVERY-FAIL');
  });

  it('AC-B18: discovery bem-sucedida grava o registry e LIMPA o estado de erro', async () => {
    const proc = new FakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = discoverAndSaveMCPTools('srv1');
    await nextTick();

    proc.stdout.emit('data', Buffer.from(JSON.stringify({ id: 1, result: {} }) + '\n'));
    await nextTick();
    proc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ id: 2, result: { tools: [{ name: 'tool_a', description: 'd' }] } }) + '\n'),
    );

    await expect(promise).resolves.toEqual(['tool_a']);

    const registryWrites = dbRuns.filter((r) => r.sql.includes('mcp_tool_registry'));
    expect(registryWrites.length).toBeGreaterThan(0);

    expect(getServerErrorState('srv1')).toBeUndefined();
    expect(getServerStatus('srv1')).toBe('stopped');
    expect(payloads.some((p) => p.id === 'srv1' && p.status === 'stopped')).toBe(true);
  });
});

describe('SB-7 AC-B18b: tools/call vazio vira errorResult (paridade K5)', () => {
  it('AC-B18b (bridge): normalizeMcpToolCallResult(null) vira errorResult MCP-EMPTY', () => {
    const out = normalizeMcpToolCallResult(null, { serverId: 'srv1', toolName: 'tool_a' });
    expect(isMcpEmptyErrorResult(out)).toBe(true);
    const err = out as { isError: true; code: string; content: Array<{ text: string }> };
    expect(err.isError).toBe(true);
    expect(err.code).toBe('MCP-EMPTY');
    expect(err.content[0].text).toContain('MCP-EMPTY');
    expect(err.content[0].text).toContain('tool_a');
    expect(err.content[0].text).toContain('srv1');
  });

  it('AC-B18b (bridge): resultado NAO-vazio passa intacto (sem regressao)', () => {
    const result = { content: [{ type: 'text', text: 'ok' }] };
    expect(normalizeMcpToolCallResult(result, { serverId: 's', toolName: 't' })).toBe(result);
    expect(isMcpEmptyErrorResult(result)).toBe(false);
    expect(normalizeMcpToolCallResult(0, { serverId: 's', toolName: 't' })).toBe(0);
  });

  it('AC-B18b (bridge, integracao): callMCPTool com result ausente devolve errorResult', async () => {
    const client = makeFakeClient((id) => ({ jsonrpc: '2.0', id }));
    const out = await callMCPTool(client, 'mcp__srv1__tool_a', {});
    expect(isMcpEmptyErrorResult(out)).toBe(true);
  });

  it('AC-B18b (gemeo lion): lionMcpCall devolve ok:false MCP-EMPTY para resposta vazia', async () => {
    const client = makeFakeClient((id) => ({ jsonrpc: '2.0', id }));
    const result = await lionMcpCall(client, { server_id: 'srv1', tool: 'tool_a' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('MCP-EMPTY');
    expect(result.error).toContain('tool_a');
  });

  it('AC-B18b (gemeo lion): resposta NAO-vazia segue ok:true (sem regressao)', async () => {
    const client = makeFakeClient((id) => ({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: 'resposta valida' }] },
    }));
    const result = await lionMcpCall(client, { server_id: 'srv1', tool: 'tool_a' });
    expect(result.ok).toBe(true);
    expect(result.content).toBe('resposta valida');
  });
});
