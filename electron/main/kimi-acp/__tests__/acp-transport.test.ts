import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const { warn, spawnMock, killProcessTree } = vi.hoisted(() => ({
  warn: vi.fn(),
  spawnMock: vi.fn(),
  killProcessTree: vi.fn(),
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('../../kill-process-tree', () => ({
  DETACH_FOR_TREE_KILL: false,
  killProcessTree,
}));

import { defaultAcpTransportFactory } from '../acp-transport';
import type { AcpTransport } from '../acp-transport';
import { KimiUnavailableError } from '../../agent-runtime/kimi-availability';
import type { AcpNotification } from '../types';

class FakeChild extends EventEmitter {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public readonly writes: string[] = [];
  public killed: string | null = null;
  public readonly stdin = {
    write: (chunk: string): boolean => {
      this.writes.push(chunk);
      return true;
    },
  };
  kill(signal: string): boolean {
    this.killed = signal;
    return true;
  }
  feed(text: string): void {
    this.stdout.emit('data', Buffer.from(text, 'utf8'));
  }
}

async function makeTransport(): Promise<{ transport: AcpTransport; child: FakeChild }> {
  const child = new FakeChild();
  spawnMock.mockReturnValue(child);
  const transport = await defaultAcpTransportFactory({ binary: '/bin/kimi', cwd: '/tmp', env: {} });
  return { transport, child };
}

beforeEach(() => {
  warn.mockClear();
  spawnMock.mockReset();
  killProcessTree.mockReset();
});

describe('StdioAcpTransport (via defaultAcpTransportFactory)', () => {
  it('spawns `<binary> acp` over stdio (subcommand acp)', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    await defaultAcpTransportFactory({ binary: '/bin/kimi', cwd: '/work', env: { PATH: '/bin' } });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnMock.mock.calls[0];
    expect(bin).toBe('/bin/kimi');
    expect(args).toEqual(['acp']);
    expect(opts.cwd).toBe('/work');
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(opts.detached).toBe(false);
    expect(opts.env).toEqual({ PATH: '/bin' });
    expect(opts.env).not.toBe(process.env);
  });

  it('AC-S2.2: a garbage line is logged via warn and does NOT throw; a following valid line dispatches', async () => {
    const { transport, child } = await makeTransport();
    const received: AcpNotification[] = [];
    transport.onNotification((n) => received.push(n));

    expect(() =>
      child.feed(
        '{ this is not json\n' + JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { a: 1 } }) + '\n',
      ),
    ).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    expect(received[0].method).toBe('session/update');
    expect(received[0].params).toEqual({ a: 1 });
  });

  it('AC-S2.3: a response line matching a pending request id RESOLVES', async () => {
    const { transport, child } = await makeTransport();
    const p = transport.request('initialize', { protocolVersion: 1 });
    expect(child.writes).toHaveLength(1);
    expect(JSON.parse(child.writes[0])).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    child.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\n');
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('AC-S2.3: an error line for a pending request id REJECTS', async () => {
    const { transport, child } = await makeTransport();
    const p = transport.request('session/new', {});
    child.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } }) + '\n');
    await expect(p).rejects.toThrow('nope');
  });

  it('AC-S2.3: a {method,id,params} with no result/error fires onServerRequest (NOT onNotification, NOT auto-replied)', async () => {
    const { transport, child } = await makeTransport();
    const serverReqs: Array<{ id: unknown; method: string; params: Record<string, unknown> }> = [];
    const notes: AcpNotification[] = [];
    transport.onServerRequest((id, method, params) => serverReqs.push({ id, method, params }));
    transport.onNotification((n) => notes.push(n));

    child.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-7',
        method: 'session/request_permission',
        params: { sessionId: 's1', options: [] },
      }) + '\n',
    );

    expect(serverReqs).toHaveLength(1);
    expect(serverReqs[0].id).toBe('req-7');
    expect(serverReqs[0].method).toBe('session/request_permission');
    expect(serverReqs[0].params).toEqual({ sessionId: 's1', options: [] });
    expect(notes).toHaveLength(0);
    expect(child.writes).toHaveLength(0);
  });

  it('AC-S2.3: a {method,params} with no id fires onNotification', async () => {
    const { transport, child } = await makeTransport();
    const notes: AcpNotification[] = [];
    transport.onNotification((n) => notes.push(n));
    child.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk' } },
      }) + '\n',
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].method).toBe('session/update');
  });

  it('respond writes a JSON-RPC response with the given id + result', async () => {
    const { transport, child } = await makeTransport();
    transport.respond('req-7', { outcome: { outcome: 'selected', optionId: 'approve_always' } });
    expect(child.writes).toHaveLength(1);
    expect(JSON.parse(child.writes[0])).toEqual({
      jsonrpc: '2.0',
      id: 'req-7',
      result: { outcome: { outcome: 'selected', optionId: 'approve_always' } },
    });
  });

  it('notify writes a JSON-RPC notification (no id)', async () => {
    const { transport, child } = await makeTransport();
    transport.notify('session/cancel', { sessionId: 's1' });
    expect(child.writes).toHaveLength(1);
    const parsed = JSON.parse(child.writes[0]);
    expect(parsed).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's1' } });
    expect(parsed.id).toBeUndefined();
  });

  it("child 'exit' rejects pending with KimiUnavailableError and fires onError", async () => {
    const { transport, child } = await makeTransport();
    const errors: Error[] = [];
    transport.onError((e) => errors.push(e));
    const p = transport.request('session/prompt', {});
    child.emit('exit', 1);
    await expect(p).rejects.toBeInstanceOf(KimiUnavailableError);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(KimiUnavailableError);
    expect(errors[0].message).toContain('kimi acp exited');
  });

  it("child 'error' rejects pending with KimiUnavailableError and fires onError", async () => {
    const { transport, child } = await makeTransport();
    const errors: Error[] = [];
    transport.onError((e) => errors.push(e));
    const p = transport.request('session/prompt', {});
    child.emit('error', new Error('ENOENT'));
    await expect(p).rejects.toBeInstanceOf(KimiUnavailableError);
    expect(errors[0].message).toContain('process error: ENOENT');
  });

  it('request after close rejects with KimiUnavailableError', async () => {
    const { transport, child } = await makeTransport();
    child.emit('exit', 0);
    await expect(transport.request('initialize')).rejects.toBeInstanceOf(KimiUnavailableError);
  });

  it('kill encerra a arvore do child e waitClosed resolves true after exit', async () => {
    const { transport, child } = await makeTransport();
    transport.kill('test-reason');
    expect(killProcessTree).toHaveBeenCalledWith(child, 'SIGKILL');
    const waited = transport.waitClosed(50);
    child.emit('exit', 0);
    await expect(waited).resolves.toBe(true);
  });

  it('split NDJSON across chunks buffers until newline', async () => {
    const { transport, child } = await makeTransport();
    const notes: AcpNotification[] = [];
    transport.onNotification((n) => notes.push(n));
    child.feed('{"jsonrpc":"2.0","method":"sess');
    expect(notes).toHaveLength(0);
    child.feed('ion/update","params":{"k":2}}\n');
    expect(notes).toHaveLength(1);
    expect(notes[0].params).toEqual({ k: 2 });
  });
});
