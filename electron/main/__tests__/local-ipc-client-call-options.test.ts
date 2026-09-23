import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { LocalIpcClient } from '../../../mcp-servers/_shared/local-ipc-client';

const IS_POSIX = process.platform !== 'win32';

interface SeenRequest {
  id: number;
  method: string;
  params: unknown;
}

type ServerBehavior = (req: SeenRequest, socket: net.Socket) => void;

let SANDBOX = '';
let server: net.Server | null = null;
let seen: SeenRequest[] = [];
let behavior: ServerBehavior = () => undefined;

function replyOk(req: SeenRequest, socket: net.Socket, result: unknown = 'ok'): void {
  socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
}

async function startFakeServer(): Promise<void> {
  const address = IS_POSIX
    ? path.join(SANDBOX, 'ipc.sock')
    : `\\\\.\\pipe\\lc-estrada-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.length > 0) {
          const req = JSON.parse(line) as SeenRequest;
          seen.push(req);
          behavior(req, socket);
        }
        nl = buf.indexOf('\n');
      }
    });
    socket.on('error', () => {});
  });

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(address, () => resolve());
  });

  fs.mkdirSync(path.join(SANDBOX, 'runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(SANDBOX, 'runtime', 'ipc-endpoint.json'),
    JSON.stringify({ transport: IS_POSIX ? 'unix' : 'pipe', address }),
  );
}

function makeClient(callTimeoutMs: number): LocalIpcClient {
  return new LocalIpcClient({
    lionclawHome: SANDBOX,
    maxRetries: 2,
    baseBackoffMs: 20,
    maxBackoffMs: 100,
    callTimeoutMs,
  });
}

beforeEach(async () => {
  const shortRoot = IS_POSIX ? '/tmp' : os.tmpdir();
  SANDBOX = await fs.promises.mkdtemp(path.join(shortRoot, 'lc-opt-'));
  seen = [];
  behavior = () => undefined;
  await startFakeServer();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  try {
    await fs.promises.rm(SANDBOX, { recursive: true, force: true });
  } catch {}
});

describe('LocalIpcClient CallOptions (F1 - SPEC estrada-fixes)', () => {
  it('F1-AC4 (compat): chamada com 2 args e RETENTADA apos queda de socket e resolve', async () => {
    behavior = (req, socket) => {
      if (seen.length === 1) {
        socket.destroy();
        return;
      }
      replyOk(req, socket);
    };

    const client = makeClient(5000);
    try {
      const result = await client.callMethod('pipeline_list', {});
      expect(result).toBe('ok');
      expect(seen).toHaveLength(2);
      expect(seen.map((r) => r.method)).toEqual(['pipeline_list', 'pipeline_list']);
    } finally {
      client.close();
    }
  });

  it('F1-AC2: call { idempotent: false } NUNCA e retentada; erro instrutivo imediato', async () => {
    behavior = (_req, socket) => {
      socket.destroy();
    };

    const client = makeClient(5000);
    try {
      await expect(client.callMethod('pipeline_create', { name: 'x' }, { idempotent: false })).rejects.toThrow(
        /PODE ter completado no servidor.*pipeline_inspect/,
      );

      await new Promise((r) => setTimeout(r, 150));
      expect(seen).toHaveLength(1);
      expect(seen[0]!.method).toBe('pipeline_create');
    } finally {
      client.close();
    }
  });

  it('timeoutMs por chamada vence o callTimeoutMs global do client', async () => {
    behavior = () => {};

    const client = makeClient(5000);
    try {
      const t0 = Date.now();
      await expect(client.callMethod('pipeline_create', {}, { timeoutMs: 120 })).rejects.toThrow(
        /timed out after 120ms/,
      );
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      client.close();
    }
  });

  it('F1-AC4 (compat): chamada com 2 args usa o timeout do CLIENT', async () => {
    behavior = () => {};

    const client = makeClient(150);
    try {
      await expect(client.callMethod('slow_thing', {})).rejects.toThrow(/timed out after 150ms/);
    } finally {
      client.close();
    }
  });

  it('retry preserva as options originais (timeoutMs custom na 2a tentativa)', async () => {
    behavior = (_req, socket) => {
      if (seen.length === 1) {
        socket.destroy();
        return;
      }
    };

    const client = makeClient(5000);
    try {
      await expect(client.callMethod('pipeline_inspect', { id: 'p1' }, { timeoutMs: 200 })).rejects.toThrow(
        /timed out after 200ms/,
      );
      expect(seen).toHaveLength(2);
    } finally {
      client.close();
    }
  });

  it('idempotent:false que recebe RESPOSTA normal resolve igual (options nao mudam o caminho feliz)', async () => {
    behavior = (req, socket) => replyOk(req, socket, { id: 'p1', started: false });

    const client = makeClient(5000);
    try {
      const result = await client.callMethod(
        'pipeline_create',
        { name: 'x' },
        { idempotent: false, timeoutMs: 5 * 60_000 },
      );
      expect(result).toEqual({ id: 'p1', started: false });
      expect(seen).toHaveLength(1);
    } finally {
      client.close();
    }
  });
});
