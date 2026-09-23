import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';

const sandboxState = vi.hoisted(() => ({
  path: '/tmp/lionclaw-ipc-cross-platform-uninitialized',
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../paths', () => ({
  getLionClawHome: () => sandboxState.path,
  getAgentCwd: () => sandboxState.path,
  getBackgroundCwd: () => path.join(sandboxState.path, 'background'),
}));

const auditEntries: Array<Record<string, unknown>> = [];
const agents: Array<Record<string, unknown>> = [];

vi.mock('../db', () => ({
  getAllAgents: () => agents,
  insertAuditEntry: (entry: Record<string, unknown>) => {
    auditEntries.push({ ...entry, createdAt: new Date().toISOString() });
  },
}));

const mcpServers: Array<Record<string, unknown>> = [];

vi.mock('../mcp-manager', () => ({
  getAllMCPServers: () => mcpServers,
}));

const secrets = new Map<string, string>();

vi.mock('../secrets-vault', () => ({
  getSecret: async (key: string) => secrets.get(key) ?? null,
}));

vi.mock('../ask-question', () => ({
  sendAskQuestion: async () => ({ id: 'unused', answers: [] }),
}));

const skillEntries: Array<{
  name: string;
  description: string;
  category?: string;
  content: string;
  allowedTools?: string[];
}> = [];

vi.mock('../skills', () => ({
  buildAgentSkillsPromptSection: () => '',
  listSkills: () =>
    skillEntries.map((s) => ({
      name: s.name,
      description: s.description,
      category: s.category,
      allowedTools: s.allowedTools,
      disableModelInvocation: false,
      userInvocable: true,
      content: s.content,
      rawContent: s.content,
      path: '/fake/' + s.name,
      hasAuxFiles: false,
    })),
  getSkill: (name: string) => {
    const s = skillEntries.find((x) => x.name === name);
    if (!s) return null;
    return {
      name: s.name,
      description: s.description,
      category: s.category,
      allowedTools: s.allowedTools,
      disableModelInvocation: false,
      userInvocable: true,
      content: s.content,
      rawContent: s.content,
      path: '/fake/' + s.name,
      hasAuxFiles: false,
    };
  },
}));

import { startLocalIpcServer, stopLocalIpcServer, getCurrentEndpoint } from '../local-ipc';
import { resolveSocketRuntimeDir } from '../local-ipc/platform-unix';

const IS_POSIX = process.platform !== 'win32';

describe('path físico do socket POSIX', () => {
  it('mantém path curto e encurta HOME que excede sun_path no macOS', () => {
    expect(resolveSocketRuntimeDir('/Users/lion/.lionclaw/runtime', 'darwin')).toBe('/Users/lion/.lionclaw/runtime');
    const long = `/var/folders/${'x'.repeat(120)}/home/.lionclaw/runtime`;
    const resolved = resolveSocketRuntimeDir(long, 'darwin');
    expect(resolved).toMatch(/^\/tmp\/lc-ipc-[a-f0-9]{16}$/);
    expect(Buffer.byteLength(path.join(resolved, 'main-0000000000000000.sock'))).toBeLessThanOrEqual(103);
  });
});

async function callRpc(
  address: string,
  method: string,
  params: unknown,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  return await new Promise((resolve, reject) => {
    const client = net.createConnection(address);
    let buf = '';
    client.setEncoding('utf8');
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error('rpc timeout'));
    }, 5000);

    client.on('connect', () => {
      const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n';
      client.write(payload);
    });
    client.on('data', (chunk: string) => {
      buf += chunk;
      const newlineIdx = buf.indexOf('\n');
      if (newlineIdx !== -1) {
        const line = buf.slice(0, newlineIdx).trim();
        clearTimeout(timeout);
        client.end();
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      }
    });
    client.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

beforeEach(async () => {
  const shortRoot = IS_POSIX ? '/tmp' : os.tmpdir();
  sandboxState.path = await fs.promises.mkdtemp(path.join(shortRoot, 'lc-ipc-'));
  auditEntries.length = 0;
  agents.length = 0;
  mcpServers.length = 0;
  skillEntries.length = 0;
  secrets.clear();
});

afterEach(async () => {
  try {
    await stopLocalIpcServer();
  } catch {}
  try {
    await fs.promises.rm(sandboxState.path, { recursive: true, force: true });
  } catch {}
});

describe('local-ipc server lifecycle (SP-6.5)', () => {
  it('starts, advertises endpoint, round-trips list_skills, and stops cleanly', async () => {
    skillEntries.push({
      name: 'demo-skill',
      description: 'A demo skill',
      category: 'test',
      content: '# Demo body',
    });

    await startLocalIpcServer();
    const endpoint = getCurrentEndpoint();
    expect(endpoint).not.toBeNull();
    if (!endpoint) return;

    const expectedFile = path.join(sandboxState.path, 'runtime', 'ipc-endpoint.json');
    expect(endpoint.endpointFile).toBe(expectedFile);
    expect(fs.existsSync(expectedFile)).toBe(true);

    const fileContent = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
    expect(fileContent.transport).toBe(IS_POSIX ? 'unix' : 'pipe');
    expect(typeof fileContent.address).toBe('string');

    if (IS_POSIX) {
      const sockStat = fs.statSync(endpoint.address);
      expect(sockStat.mode & 0o777).toBe(0o600);

      const cfgStat = fs.statSync(expectedFile);
      expect(cfgStat.mode & 0o777).toBe(0o600);

      const dirStat = fs.statSync(path.dirname(expectedFile));
      expect(dirStat.mode & 0o777).toBe(0o700);
    }

    const response = await callRpc(endpoint.address, 'list_skills', {});
    expect(response.error).toBeUndefined();
    expect(Array.isArray(response.result)).toBe(true);
    const list = response.result as Array<{ name: string }>;
    expect(list.length).toBe(1);
    expect(list[0]?.name).toBe('demo-skill');

    await stopLocalIpcServer();

    if (IS_POSIX) {
      expect(fs.existsSync(endpoint.address)).toBe(false);
    }
    expect(fs.existsSync(expectedFile)).toBe(false);
  });
});

describe('get_mcp_env narrow scope (SP-6.6)', () => {
  it('returns env values for an active server and writes an audit row WITHOUT values', async () => {
    mcpServers.push({
      id: 'my-server',
      name: 'My Server',
      command: '/usr/bin/node',
      args: [],
      envKeys: ['FOO'],
      isActive: true,
      visibleTo: 'codex-lion-only',
      status: 'stopped',
    });
    secrets.set('FOO', 'super-secret-value');

    await startLocalIpcServer();
    const endpoint = getCurrentEndpoint();
    if (!endpoint) throw new Error('endpoint not set');

    const response = await callRpc(endpoint.address, 'get_mcp_env', {
      server_id: 'my-server',
      caller_pid: 12345,
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ env: { FOO: 'super-secret-value' } });

    expect(auditEntries.length).toBe(1);
    const audit = auditEntries[0];
    expect(audit.eventType).toBe('tool_call');
    expect(audit.toolName).toBe('get_mcp_env');
    const auditInput = JSON.parse(audit.input as string);
    expect(auditInput.server_id).toBe('my-server');
    expect(auditInput.env_key_names).toEqual(['FOO']);
    expect(auditInput.caller_pid).toBe(12345);
    expect(JSON.stringify(audit)).not.toContain('super-secret-value');
  });

  it('returns an error for an unknown server_id', async () => {
    await startLocalIpcServer();
    const endpoint = getCurrentEndpoint();
    if (!endpoint) throw new Error('endpoint not set');

    const response = await callRpc(endpoint.address, 'get_mcp_env', {
      server_id: 'does-not-exist',
    });
    expect(response.result).toBeUndefined();
    expect(response.error).toBeDefined();
    expect(response.error?.message).toMatch(/Unknown MCP server_id/);
  });
});
