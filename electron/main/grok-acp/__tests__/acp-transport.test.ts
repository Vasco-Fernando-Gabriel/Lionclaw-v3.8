import { EventEmitter } from 'events';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { killProcessTree } = vi.hoisted(() => ({ killProcessTree: vi.fn() }));

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../kill-process-tree', () => ({
  DETACH_FOR_TREE_KILL: false,
  killProcessTree,
}));

import { StdioGrokAcpTransport } from '../acp-transport';
import { GrokJsonRpcError } from '../errors';

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly writes: string[] = [];
  readonly stdin = {
    write: (value: string): boolean => {
      this.writes.push(value);
      return true;
    },
  };

  feed(value: string): void {
    this.stdout.emit('data', Buffer.from(value));
  }
}

function transport(maxLineBytes = 128): { child: FakeChild; transport: StdioGrokAcpTransport } {
  const child = new FakeChild();
  return {
    child,
    transport: new StdioGrokAcpTransport(child as unknown as ChildProcessWithoutNullStreams, maxLineBytes),
  };
}

beforeEach(() => killProcessTree.mockReset());

describe('Grok ACP transport fail-closed', () => {
  it('encerra o child e rejeita requests na primeira linha NDJSON invalida', async () => {
    const state = transport();
    const pending = state.transport.request('initialize', {});
    state.child.feed('{ echoed-invalid-line\n');

    await expect(pending).rejects.toThrow(/Invalid Grok ACP NDJSON line/);
    expect(killProcessTree).toHaveBeenCalledWith(state.child, 'SIGKILL');
    await expect(state.transport.request('session/new', {})).rejects.toThrow(/closed/);
    const closed = state.transport.waitClosed(50);
    state.child.emit('exit', null, 'SIGKILL');
    await expect(closed).resolves.toBe(true);
  });

  it('pula linhas de log fora do protocolo sem derrubar a sessao', async () => {
    const state = transport(4096);
    const pending = state.transport.request('initialize', {});
    state.child.feed('\u001b[2m2026-07-18T22:56:41.245Z\u001b[0m ERROR log vazado no pty\n');
    state.child.feed('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');

    await expect(pending).resolves.toEqual({ ok: true });
    expect(killProcessTree).not.toHaveBeenCalled();
  });

  it('encerra fail-closed quando o ruido fora do protocolo vira enxurrada', async () => {
    const state = transport(4096);
    const pending = state.transport.request('initialize', {});
    for (let index = 0; index <= 32; index += 1) {
      state.child.feed(`ruido ${index}\n`);
    }

    await expect(pending).rejects.toThrow(/linhas fora do protocolo/);
    expect(killProcessTree).toHaveBeenCalledWith(state.child, 'SIGKILL');
  });

  it('encerra o child quando o buffer sem newline excede o limite', async () => {
    const state = transport(16);
    const pending = state.transport.request('initialize', {});
    state.child.feed('x'.repeat(17));

    await expect(pending).rejects.toThrow(/buffer exceeded 16 bytes/);
    expect(killProcessTree).toHaveBeenCalledWith(state.child, 'SIGKILL');
  });

  it('continua aceitando NDJSON valido dividido em chunks', async () => {
    const state = transport();
    const pending = state.transport.request('initialize', {});
    state.child.feed('{"jsonrpc":"2.0","id":1,"res');
    state.child.feed('ult":{"ok":true}}\n');
    await expect(pending).resolves.toEqual({ ok: true });
    expect(killProcessTree).not.toHaveBeenCalled();
  });

  it('preserva code/data do erro JSON-RPC', async () => {
    const state = transport();
    const pending = state.transport.request('session/new', {});
    state.child.feed(
      '{"jsonrpc":"2.0","id":1,"error":{"code":401,"message":"token expired","data":{"reason":"auth_required"}}}\n',
    );
    const error = await pending.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GrokJsonRpcError);
    expect(error).toMatchObject({
      method: 'session/new',
      code: 401,
      data: { reason: 'auth_required' },
    });
  });

  it('mata o child e rejeita request pendente em timeout ou abort', async () => {
    const timed = transport();
    await expect(timed.transport.request('initialize', {}, { timeoutMs: 5 })).rejects.toThrow(/timed out/);
    expect(killProcessTree).toHaveBeenCalledWith(timed.child, 'SIGKILL');

    killProcessTree.mockClear();
    const aborted = transport();
    const controller = new AbortController();
    const pending = aborted.transport.request('authenticate', {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(killProcessTree).toHaveBeenCalledWith(aborted.child, 'SIGKILL');
  });
});
