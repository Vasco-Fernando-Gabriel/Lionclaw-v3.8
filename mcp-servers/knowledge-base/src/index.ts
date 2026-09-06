#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';


const LIONCLAW_HOME = process.env['LIONCLAW_HOME'] ?? path.join(os.homedir(), '.lionclaw');
const STATE_FILE = path.join(LIONCLAW_HOME, 'data', '.kb-active-agent');

const SOCKET_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\lionclaw-kb-search'
  : path.join(LIONCLAW_HOME, 'data', '.kb-search.sock');


function getActiveAgentId(): string {
  const envAgentId = process.env['KB_AGENT_ID'];
  if (envAgentId) return envAgentId;

  try {
    return fs.readFileSync(STATE_FILE, 'utf-8').trim();
  } catch {
    return '';
  }
}


async function waitForSocket(maxWaitMs = 5000): Promise<boolean> {
  if (process.platform !== 'win32') {
    if (fs.existsSync(SOCKET_PATH)) return true;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 250));
      if (fs.existsSync(SOCKET_PATH)) return true;
    }
    return false;
  }
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(SOCKET_PATH);
      probe.on('connect', () => { probe.destroy(); resolve(true); });
      probe.on('error', () => { resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function searchViaBridge(agentId: string, query: string): Promise<unknown> {
  return new Promise(async (resolve, reject) => {
    const socketReady = await waitForSocket();
    if (!socketReady) {
      reject(new Error('Knowledge bridge not available after 5s wait. Is the LionClaw app running?'));
      return;
    }

    const requestId = crypto.randomUUID();
    const conn = net.createConnection(SOCKET_PATH);
    let buffer = '';
    const timeout = setTimeout(() => {
      conn.destroy();
      reject(new Error('Knowledge bridge timeout (30s)'));
    }, 30000);

    conn.on('connect', () => {
      const req = JSON.stringify({ id: requestId, agentId, query }) + '\n';
      conn.write(req);
    });

    conn.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line) as { id: string; result?: unknown; error?: string };
          if (resp.id === requestId) {
            clearTimeout(timeout);
            conn.destroy();
            if (resp.error) {
              reject(new Error(resp.error));
            } else {
              resolve(resp.result);
            }
            return;
          }
        } catch { /* ignore parse errors */ }
      }
    });

    conn.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}


const server = new McpServer({
  name: 'knowledge-base',
  version: '1.0.0',
});

server.tool(
  'knowledge_base_search',
  'Busca informacoes na sua base de conhecimento. Use quando precisar de informacoes especificas sobre documentos indexados para voce. Retorna os trechos mais relevantes rankeados por relevancia semantica. IMPORTANTE: sempre passe agent_id com o seu identificador (ex: "researcher").',
  {
    query: z.string().describe('O que voce quer encontrar na base de conhecimento'),
    agent_id: z.string().describe('Seu identificador como agente. Voce DEVE passar seu proprio id aqui (ex: "researcher").'),
  },
  async ({ query, agent_id }) => {
    const agentId = agent_id || getActiveAgentId();

    if (!agentId) {
      const empty = {
        found: false,
        strategy: 'not_found',
        results: [],
        query_used: query,
        latency_ms: 0,
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(empty) }],
      };
    }

    try {
      const result = await searchViaBridge(agentId, query);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `ERRO DE CONEXÃO: Não foi possível acessar a base de conhecimento. ${errMsg}` }],
      };
    }
  },
);


async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`knowledge-base MCP server fatal error: ${String(err)}\n`);
  process.exit(1);
});
