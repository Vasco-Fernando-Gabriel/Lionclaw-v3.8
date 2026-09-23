import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

import { LocalIpcClient } from '../../../mcp-servers/_shared/local-ipc-client';

const IS_POSIX = process.platform !== 'win32';

const MULTIBYTE_TEXT = [
  'configuração da ação no armazém — coração, gênero, âmbito;',
  'CJK: こんにちは世界 你好世界; cirilico: Привет мир;',
  'emoji: 🚀🧭✅❤️🇧🇷👍🏽👨‍👩‍👧‍👦;',
  '/Users/maquina-de-teste/projetos/multichat-anonimizado/docs/Docs20260610_104808/registro-de-decisões-técnicas-e-padrões-de-implementação-do-módulo-de-conversação-com-nome-bem-longo-para-cruzar-fronteiras-de-chunk.md',
].join(' ');

interface SeenRequest {
  id: number;
  method: string;
  params: unknown;
}

let SANDBOX = '';
let server: net.Server | null = null;
let serverSockets: net.Socket[] = [];
let seen: SeenRequest[] = [];

async function startFakeServer(): Promise<void> {
  const address = IS_POSIX
    ? path.join(SANDBOX, 'ipc.sock')
    : `\\\\.\\pipe\\lc-f8-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  server = net.createServer((socket) => {
    serverSockets.push(socket);
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
          const payload = Buffer.from(
            JSON.stringify({ jsonrpc: '2.0', id: req.id, result: MULTIBYTE_TEXT }) + '\n',
            'utf8',
          );
          let offset = 0;
          const writeSlice = (): void => {
            if (offset >= payload.length) return;
            const end = Math.min(offset + 7, payload.length);
            socket.write(payload.subarray(offset, end));
            offset = end;
            setTimeout(writeSlice, 1);
          };
          writeSlice();
        }
        nl = buf.indexOf('\n');
      }
    });
    socket.on('error', () => undefined);
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

beforeEach(async () => {
  const shortRoot = IS_POSIX ? '/tmp' : os.tmpdir();
  SANDBOX = await fs.promises.mkdtemp(path.join(shortRoot, 'lc-f8-'));
  seen = [];
  serverSockets = [];
  await startFakeServer();
});

afterEach(async () => {
  for (const s of serverSockets) s.destroy();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  try {
    await fs.promises.rm(SANDBOX, { recursive: true, force: true });
  } catch {}
});

describe('F8-b3 — framing multibyte do LocalIpcClient (F8-AC3)', () => {
  it('socket real: resposta multibyte fatiada em chunks de 7 BYTES chega byte-identica', async () => {
    const client = new LocalIpcClient({
      lionclawHome: SANDBOX,
      maxRetries: 1,
      baseBackoffMs: 20,
      maxBackoffMs: 100,
      callTimeoutMs: 5000,
    });
    try {
      const result = await client.callMethod('pipeline_inspect', { id: 'p1' });
      expect(typeof result).toBe('string');
      const got = result as string;
      expect(got).toBe(MULTIBYTE_TEXT);
      expect(got.includes('�')).toBe(false);
      expect(Buffer.from(got, 'utf8').equals(Buffer.from(MULTIBYTE_TEXT, 'utf8'))).toBe(true);
    } finally {
      client.close();
    }
  });

  it('branch de Buffer (sem setEncoding): chunks partidos NO MEIO de caractere nao viram U+FFFD', async () => {
    interface PendingCallShape {
      id: number;
      method: string;
      params: unknown;
      idempotent: boolean;
      timeoutMs: number;
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
      retried: boolean;
    }
    interface ClientInternals {
      attachSocketHandlers(socket: net.Socket): void;
      pending: Map<number, PendingCallShape>;
    }

    const client = new LocalIpcClient({ lionclawHome: SANDBOX });
    const internals = client as unknown as ClientInternals;
    const fakeSocket = new EventEmitter() as unknown as net.Socket;
    internals.attachSocketHandlers(fakeSocket);

    const resultPromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout do teste')), 2000);
      internals.pending.set(42, {
        id: 42,
        method: 'pipeline_inspect',
        params: {},
        idempotent: true,
        timeoutMs: 2000,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
        retried: false,
      });
    });

    const line = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 42, result: MULTIBYTE_TEXT }) + '\n', 'utf8');
    for (let offset = 0; offset < line.length; offset += 5) {
      fakeSocket.emit('data', line.subarray(offset, Math.min(offset + 5, line.length)));
    }

    const result = await resultPromise;
    const got = result as string;
    expect(got.includes('�')).toBe(false);
    expect(got).toBe(MULTIBYTE_TEXT);
    expect(Buffer.from(got, 'utf8').equals(Buffer.from(MULTIBYTE_TEXT, 'utf8'))).toBe(true);

    client.close();
  });
});
