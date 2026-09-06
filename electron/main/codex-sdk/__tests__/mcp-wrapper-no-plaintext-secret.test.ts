
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let SANDBOX = '';

beforeEach(() => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-codex-secret-'));
  vi.spyOn(os, 'homedir').mockReturnValue(SANDBOX);
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
  }
  vi.resetModules();
});

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const SECRET_KEY = 'GOOGLE_OAUTH_TOKEN';
const SECRET_VALUE = 'ya29.SECRET_VALUE_XYZ.abcdef.NEVER_TO_DISK';

interface MockServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  isActive: boolean;
}

const mcpServers: MockServer[] = [
  {
    id: 'google-gmail',
    name: 'Gmail',
    command: 'node',
    args: ['/opt/lionclaw/mcp/google-gmail/server.js'],
    envKeys: [SECRET_KEY],
    isActive: true,
  },
];

vi.mock('../../db', () => ({
  getAllMCPServers: () => mcpServers.slice(),
}));

vi.mock('../../secrets-vault', () => ({
  getSecret: async (key: string) => (key === SECRET_KEY ? SECRET_VALUE : null),
}));

vi.mock('../../mcp-manager', () => ({
  resolveGatewayScriptPath: () => '/opt/lionclaw/mcp-servers/gateway/dist/gateway/src/index.js',
}));

describe('mcp-wrapper secret safety', () => {
  it('never writes the plaintext secret value into ~/.codex/config.toml or any wrapper', async () => {
    const { syncCodexMcpConfig } = await import('../mcp-config-sync');
    await syncCodexMcpConfig();

    const tomlPath = path.join(SANDBOX, '.codex', 'config.toml');
    const wrapperPath = path.join(SANDBOX, '.lionclaw', 'mcp-wrappers', 'google-gmail.js');

    expect(fs.existsSync(tomlPath)).toBe(true);
    expect(fs.existsSync(wrapperPath)).toBe(true);

    const toml = fs.readFileSync(tomlPath, 'utf8');
    const wrapper = fs.readFileSync(wrapperPath, 'utf8');

    expect(toml).not.toContain('env = {');
    expect(toml).not.toContain('env=');
    expect(toml).not.toContain(SECRET_VALUE);
    expect(wrapper).not.toContain(SECRET_VALUE);

    expect(toml).toContain(wrapperPath);

    expect(wrapper).toContain(SECRET_KEY);
    expect(wrapper).toContain('ipc-endpoint.json');
    expect(wrapper).toContain('get_mcp_env');
  });

  it('SPEC-001 Sprint 13 (SP-13.6): full-tree scan finds no plaintext secret under sandbox after sync', async () => {
    const { syncCodexMcpConfig } = await import('../mcp-config-sync');
    await syncCodexMcpConfig();

    function walk(dir: string, acc: string[]): string[] {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return acc;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, acc);
        } else if (entry.isFile()) {
          acc.push(full);
        }
      }
      return acc;
    }

    const files = walk(SANDBOX, []);
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (content.includes(SECRET_VALUE)) {
        hits.push(file);
      }
    }
    expect(hits).toEqual([]);
  });
});
