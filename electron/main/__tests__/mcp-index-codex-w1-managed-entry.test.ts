import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let SANDBOX = '';
let SAVED_CODEX_HOME: string | undefined;

beforeEach(() => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-codex-w1-'));
  vi.spyOn(os, 'homedir').mockReturnValue(SANDBOX);
  SAVED_CODEX_HOME = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (SAVED_CODEX_HOME !== undefined) process.env.CODEX_HOME = SAVED_CODEX_HOME;
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {}
  vi.resetModules();
  loggerSpies.error.mockClear();
  loggerSpies.warn.mockClear();
});

const loggerSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../logger', () => ({
  createLogger: () => loggerSpies,
}));

const GATEWAY_SCRIPT = '/opt/lionclaw/mcp-servers/gateway/dist/gateway/src/index.js';

vi.mock('../mcp-manager', () => ({
  resolveGatewayScriptPath: () => GATEWAY_SCRIPT,
}));

interface MockServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  isActive: boolean;
}

const mcpServers: MockServer[] = [];

vi.mock('../db', () => ({
  getAllMCPServers: () => mcpServers.slice(),
}));

function server(id: string, isActive = true): MockServer {
  return {
    id,
    name: `Server ${id}`,
    command: 'node',
    args: [`/opt/mcp/${id}/server.js`],
    envKeys: [],
    isActive,
  };
}

function tomlPath(): string {
  return path.join(SANDBOX, '.codex', 'config.toml');
}

function gatewayWrapperPath(): string {
  return path.join(SANDBOX, '.lionclaw', 'mcp-wrappers', 'lionclaw-gateway.js');
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function sync(): Promise<string> {
  const { syncCodexMcpConfig } = await import('../codex-sdk/mcp-config-sync');
  await syncCodexMcpConfig();
  return fs.readFileSync(tomlPath(), 'utf8');
}

describe('entry inerte do gateway no managed block (AC-C4)', () => {
  beforeEach(() => {
    mcpServers.length = 0;
  });

  it('escreve [mcp_servers.lionclaw-gateway] com enabled=false + timeout 360 + wrapper', async () => {
    mcpServers.push(server('google-gmail'));
    const toml = await sync();

    const begin = toml.indexOf('# >>> LIONCLAW_MANAGED');
    const end = toml.indexOf('# <<< LIONCLAW_MANAGED');
    const managed = toml.slice(begin, end);
    expect(managed).toContain('[mcp_servers.lionclaw-gateway]');
    expect(managed).toContain('enabled = false');
    expect(managed).toContain('tool_timeout_sec = 360');
    expect(managed).toContain(gatewayWrapperPath());

    const gwStart = managed.indexOf('[mcp_servers.lionclaw-gateway]');
    const nextHeader = managed.indexOf('[mcp_servers.', gwStart + 1);
    const gwSection = managed.slice(gwStart, nextHeader === -1 ? undefined : nextHeader);
    expect(gwSection).toContain('enabled = false');
    expect(gwSection).toContain('default_tools_approval_mode = "approve"');
    expect(gwSection).toContain('tool_timeout_sec = 360');
    expect(gwSection).toContain('command = "node"');
    expect(gwSection).toContain(gatewayWrapperPath());

    const gmStart = managed.indexOf('[mcp_servers.google-gmail]');
    expect(gmStart).toBeGreaterThan(-1);
    const gmSection = managed.slice(gmStart);
    expect(gmSection).not.toContain('enabled = false');
    expect(gmSection).not.toContain('tool_timeout_sec = 360');
  });

  it('wrapper do gateway: staticEnv com surface codex-sdk, SEM token e SEM envKeys', async () => {
    await sync();
    const wrapper = fs.readFileSync(gatewayWrapperPath(), 'utf8');
    expect(wrapper).toContain('"LIONCLAW_MCP_SURFACE":"codex-sdk"');
    expect(wrapper).toContain('const FETCH_HELPER_TOKEN = false;');
    expect(wrapper).toContain('const ENV_KEYS = [];');
    expect(wrapper).toContain(JSON.stringify([GATEWAY_SCRIPT]));
    expect(wrapper).not.toContain('LIONCLAW_MCP_LANE');
  });

  it('re-sync e idempotente e nao deleta o wrapper do gateway como orfao', async () => {
    mcpServers.push(server('google-gmail'));
    const first = await sync();
    vi.resetModules();
    const second = await sync();
    vi.resetModules();
    const third = await sync();
    expect(second.trimEnd()).toBe(first.trimEnd());
    expect(third).toBe(second);
    expect(fs.existsSync(gatewayWrapperPath())).toBe(true);
  });
});

describe('colisao do id lionclaw-gateway (P4, skip ruidoso)', () => {
  beforeEach(() => {
    mcpServers.length = 0;
    loggerSpies.error.mockClear();
  });

  it('entry pre-existente do USUARIO fora do managed => sem entry managed, config valido, log ERROR', async () => {
    const codexDir = path.join(SANDBOX, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const userEntry = [
      '[mcp_servers.lionclaw-gateway]',
      'command = "/home/user/my-own-gateway"',
      'args    = []',
      '',
    ].join('\n');
    fs.writeFileSync(tomlPath(), userEntry, 'utf8');

    const wrappersDir = path.join(SANDBOX, '.lionclaw', 'mcp-wrappers');
    fs.mkdirSync(wrappersDir, { recursive: true });
    fs.writeFileSync(gatewayWrapperPath(), '// stale');

    mcpServers.push(server('google-gmail'));
    const toml = await sync();

    expect(countOccurrences(toml, '[mcp_servers.lionclaw-gateway]')).toBe(1);
    expect(toml).toContain('/home/user/my-own-gateway');
    expect(toml).not.toContain('tool_timeout_sec = 360');
    expect(toml).toContain('[mcp_servers.google-gmail]');
    expect(loggerSpies.error).toHaveBeenCalled();
    expect(fs.existsSync(gatewayWrapperPath())).toBe(false);
  });

  it('server do DB com id lionclaw-gateway => entry managed do gateway ausente, DB entry unica, log ERROR', async () => {
    mcpServers.push(server('lionclaw-gateway'), server('google-gmail'));
    const toml = await sync();

    expect(countOccurrences(toml, '[mcp_servers.lionclaw-gateway]')).toBe(1);
    expect(toml).toContain('/opt/mcp/lionclaw-gateway/server.js');
    expect(toml).not.toContain('enabled = false');
    expect(toml).not.toContain('tool_timeout_sec = 360');
    expect(loggerSpies.error).toHaveBeenCalled();
  });

  it('colisao dupla (usuario + DB ativo) nao duplica a tabela em lugar nenhum', async () => {
    const codexDir = path.join(SANDBOX, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(tomlPath(), '[mcp_servers.lionclaw-gateway]\ncommand = "/home/user/gw"\nargs = []\n', 'utf8');
    mcpServers.push(server('lionclaw-gateway'), server('google-gmail'));
    const toml = await sync();

    expect(countOccurrences(toml, '[mcp_servers.lionclaw-gateway]')).toBe(1);
    expect(toml).toContain('/home/user/gw');
    expect(toml).not.toContain('/opt/mcp/lionclaw-gateway/server.js');
    expect(toml).toContain('[mcp_servers.google-gmail]');
    expect(loggerSpies.error).toHaveBeenCalled();
  });
});

describe('contrato de quoting do managed block (secao 1)', () => {
  beforeEach(() => {
    mcpServers.length = 0;
    loggerSpies.warn.mockClear();
  });

  it('id nao-bare e quotado no header IDENTICO ao key do -c (tomlKeyForConfigPath)', async () => {
    mcpServers.push(server('my server.v2'));
    const toml = await sync();

    const { tomlKeyForConfigPath } = await import('../codex-pipeline-config');
    const key = tomlKeyForConfigPath('my server.v2');
    expect(key).toBe('"my server.v2"');
    expect(toml).toContain(`[mcp_servers.${key}]`);
    expect(toml).not.toContain('[mcp_servers.my server.v2]');
  });

  it('round-trip: nomes escritos no header sao re-parseados identicos pelo leitor dos extras', async () => {
    mcpServers.push(server('my server.v2'), server('plain-id'));
    await sync();

    const { listConfiguredCodexMcpServerNames } = await import('../codex-pipeline-config');
    const names = listConfiguredCodexMcpServerNames();
    expect(names).toContain('plain-id');
    expect(names).toContain('lionclaw-gateway');
    expect(names).toContain('my server.v2');
  });

  it('id patologico (contem aspas) e pulado com warn em vez de gerar TOML invalido', async () => {
    mcpServers.push(server('bad"id'), server('plain-id'));
    const toml = await sync();

    expect(toml).not.toContain('bad"id');
    expect(toml).toContain('[mcp_servers.plain-id]');
    expect(loggerSpies.warn).toHaveBeenCalled();
  });
});
