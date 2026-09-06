import net from 'net';
import path from 'path';
import fs from 'fs';
import { getLionClawHome } from './paths';
import { hybridKnowledgeSearch } from './knowledge-engine';
import { createLogger } from './logger';

const logger = createLogger('kb-ipc-bridge');

function getSocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\lionclaw-kb-search';
  }
  return path.join(getLionClawHome(), 'data', '.kb-search.sock');
}

const SOCKET_PATH = getSocketPath();

let server: net.Server | null = null;

export function startKnowledgeBridge(): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      const socketDir = path.dirname(SOCKET_PATH);
      fs.mkdirSync(socketDir, { recursive: true });
      try { fs.unlinkSync(SOCKET_PATH); } catch { /* ok */ }
    }

    server = net.createServer((conn) => {
      let buffer = '';

      conn.on('data', (data) => {
        buffer += data.toString();

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          handleRequest(conn, line.trim());
        }
      });

      conn.on('error', (err) => {
        logger.warn({ err }, 'KB bridge connection error');
      });
    });

    server.listen({ path: SOCKET_PATH, backlog: 50 }, () => {
      logger.info({ socketPath: SOCKET_PATH }, 'Knowledge bridge listening');
      resolve();
    });

    server.on('error', (err) => {
      logger.error({ err }, 'Knowledge bridge server error');
      resolve();
    });
  });
}

async function handleRequest(conn: net.Socket, raw: string): Promise<void> {
  try {
    const req = JSON.parse(raw) as { id: string; agentId: string; query: string };
    const result = await hybridKnowledgeSearch(req.agentId, req.query);
    const response = JSON.stringify({ id: req.id, result }) + '\n';
    conn.write(response);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'KB bridge request failed');
    try {
      conn.write(JSON.stringify({ id: 'unknown', error: errMsg }) + '\n');
    } catch { /* connection may be dead */ }
  }
}

export function stopKnowledgeBridge(): void {
  if (server) {
    server.close();
    server = null;
  }
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(SOCKET_PATH); } catch { /* ok */ }
  }
}
