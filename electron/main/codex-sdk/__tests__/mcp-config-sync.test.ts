
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let SANDBOX = '';

beforeEach(() => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-codex-sync-'));
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

interface MockServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  isActive: boolean;
}

const mcpServers: MockServer[] = [];

vi.mock('../../db', () => ({
  getAllMCPServers: () => mcpServers.slice(),
}));

vi.mock('../../mcp-manager', () => ({
  resolveGatewayScriptPath: () => '/opt/lionclaw/mcp-servers/gateway/dist/gateway/src/index.js',
}));

describe('syncCodexMcpConfig', () => {
  beforeEach(() => {
    mcpServers.length = 0;
  });

  it('writes wrappers for MCPs with envKeys and direct entries for MCPs without', async () => {
    mcpServers.push(
      {
        id: 'knowledge-base',
        name: 'Knowledge Base',
        command: 'node',
        args: ['/opt/lionclaw/mcp/knowledge-base/server.js'],
        envKeys: [],
        isActive: true,
      },
      {
        id: 'google-gmail',
        name: 'Gmail',
        command: 'node',
        args: ['/opt/lionclaw/mcp/google-gmail/server.js'],
        envKeys: ['GOOGLE_OAUTH_TOKEN'],
        isActive: true,
      },
    );

    const { syncCodexMcpConfig } = await import('../mcp-config-sync');
    await syncCodexMcpConfig();

    const tomlPath = path.join(SANDBOX, '.codex', 'config.toml');
    const toml = fs.readFileSync(tomlPath, 'utf8');

    expect(toml).toContain('[mcp_servers.knowledge-base]');
    expect(toml).toContain('default_tools_approval_mode = "approve"');
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('"/opt/lionclaw/mcp/knowledge-base/server.js"');

    const expectedWrapper = path.join(SANDBOX, '.lionclaw', 'mcp-wrappers', 'google-gmail.js');
    expect(toml).toContain('[mcp_servers.google-gmail]');
    expect(toml).toContain(expectedWrapper);

    expect(fs.existsSync(expectedWrapper)).toBe(true);

    expect(toml).toContain('# >>> LIONCLAW_MANAGED');
    expect(toml).toContain('# <<< LIONCLAW_MANAGED');
  });

  it('preserves user-managed sections OUTSIDE the LIONCLAW_MANAGED markers', async () => {
    const codexDir = path.join(SANDBOX, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const initial = [
      '# user prologue - keep this comment',
      '[user_section]',
      'foo = "bar"',
      '',
      '# >>> LIONCLAW_MANAGED (do not edit manually)',
      '',
      '[mcp_servers.stale-entry]',
      'command = "/old/path"',
      'args    = []',
      '',
      '# <<< LIONCLAW_MANAGED',
      '',
      '[user_epilogue]',
      'baz = 42',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexDir, 'config.toml'), initial, 'utf8');

    mcpServers.push({
      id: 'fresh-entry',
      name: 'Fresh',
      command: 'node',
      args: ['/opt/fresh.js'],
      envKeys: [],
      isActive: true,
    });

    const { syncCodexMcpConfig } = await import('../mcp-config-sync');
    await syncCodexMcpConfig();

    const final = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');

    expect(final).toContain('# user prologue - keep this comment');
    expect(final).toContain('[user_section]');
    expect(final).toContain('foo = "bar"');
    expect(final).toContain('[user_epilogue]');
    expect(final).toContain('baz = 42');

    expect(final).not.toContain('stale-entry');
    expect(final).not.toContain('/old/path');

    expect(final).toContain('[mcp_servers.fresh-entry]');
    expect(final).toContain('/opt/fresh.js');
  });

  it('cleans up orphan wrapper files whose MCP is no longer active', async () => {
    const wrappersDir = path.join(SANDBOX, '.lionclaw', 'mcp-wrappers');
    fs.mkdirSync(wrappersDir, { recursive: true });
    const orphan = path.join(wrappersDir, 'old-mcp.js');
    fs.writeFileSync(orphan, '// orphan');
    expect(fs.existsSync(orphan)).toBe(true);

    mcpServers.push({
      id: 'new-mcp',
      name: 'New',
      command: 'node',
      args: ['/opt/new.js'],
      envKeys: ['SECRET_X'],
      isActive: true,
    });

    const { syncCodexMcpConfig } = await import('../mcp-config-sync');
    await syncCodexMcpConfig();

    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(path.join(wrappersDir, 'new-mcp.js'))).toBe(true);
  });
});


describe('syncCodexMcpConfig — helpers gated por capability toggle (S4b)', () => {
  beforeEach(() => {
    mcpServers.length = 0;
  });

  it('helper GATED sem envKeys e roteado pelo wrapper com fetchHelperToken', async () => {
    mcpServers.push({
      id: 'lionclaw-pipeline-control',
      name: 'Pipeline Control',
      command: 'node',
      args: ['/opt/lionclaw/mcp/lionclaw-pipeline-control/server.js'],
      envKeys: [],
      isActive: true,
    });

    const { syncCodexMcpConfig } = await import('../mcp-config-sync');
    await syncCodexMcpConfig();

    const toml = fs.readFileSync(path.join(SANDBOX, '.codex', 'config.toml'), 'utf8');
    const wrapperPath = path.join(
      SANDBOX,
      '.lionclaw',
      'mcp-wrappers',
      'lionclaw-pipeline-control.js',
    );

    expect(toml).toContain('[mcp_servers.lionclaw-pipeline-control]');
    expect(toml).toContain(wrapperPath);
    expect(toml).not.toContain('/opt/lionclaw/mcp/lionclaw-pipeline-control/server.js');

    expect(fs.existsSync(wrapperPath)).toBe(true);
    const wrapper = fs.readFileSync(wrapperPath, 'utf8');
    expect(wrapper).toContain('const FETCH_HELPER_TOKEN = true;');
    expect(wrapper).toContain('mint_helper_token');
    expect(wrapper).toContain('LIONCLAW_HELPER_TOKEN');
    expect(wrapper).toContain('ipc-endpoint.json');
  });

  it('helper NAO-gated sem envKeys segue DIRETO, sem wrapper (comportamento antigo)', async () => {
    mcpServers.push({
      id: 'knowledge-base',
      name: 'Knowledge Base',
      command: 'node',
      args: ['/opt/lionclaw/mcp/knowledge-base/server.js'],
      envKeys: [],
      isActive: true,
    });

    const { syncCodexMcpConfig } = await import('../mcp-config-sync');
    await syncCodexMcpConfig();

    const toml = fs.readFileSync(path.join(SANDBOX, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.knowledge-base]');
    expect(toml).toContain('"/opt/lionclaw/mcp/knowledge-base/server.js"');
    expect(
      fs.existsSync(path.join(SANDBOX, '.lionclaw', 'mcp-wrappers', 'knowledge-base.js')),
    ).toBe(false);
  });

  it('invariante no-plaintext: nenhum token aparece no config.toml nem no wrapper', async () => {
    const { mintHelperToken } = await import('../../helper-identity');
    const liveToken = mintHelperToken();

    mcpServers.push({
      id: 'lionclaw-dynamic-workflows',
      name: 'Dynamic Workflows',
      command: 'node',
      args: ['/opt/lionclaw/mcp/lionclaw-dynamic-workflows/server.js'],
      envKeys: [],
      isActive: true,
    });

    const { syncCodexMcpConfig } = await import('../mcp-config-sync');
    await syncCodexMcpConfig();

    const tomlPath = path.join(SANDBOX, '.codex', 'config.toml');
    const wrapperPath = path.join(
      SANDBOX,
      '.lionclaw',
      'mcp-wrappers',
      'lionclaw-dynamic-workflows.js',
    );
    const toml = fs.readFileSync(tomlPath, 'utf8');
    const wrapper = fs.readFileSync(wrapperPath, 'utf8');

    expect(toml).not.toContain(liveToken);
    expect(wrapper).not.toContain(liveToken);
    expect(toml).not.toContain('LIONCLAW_HELPER_TOKEN');
    expect(toml).not.toContain('mint_helper_token');
    expect(toml).not.toContain('env = {');

    function walk(dir: string, acc: string[]): string[] {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return acc;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else if (entry.isFile()) acc.push(full);
      }
      return acc;
    }
    const files = walk(SANDBOX, []);
    expect(files.length).toBeGreaterThan(0);
    const hits = files.filter((file) => {
      try {
        return fs.readFileSync(file, 'utf8').includes(liveToken);
      } catch {
        return false;
      }
    });
    expect(hits).toEqual([]);
  });
});

describe('syncCodexMcpConfig — dedupe do managed block (spec-codex-config-dedupe)', () => {
  beforeEach(() => {
    mcpServers.length = 0;
  });

  function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it('6.1: reescrita-do-Desktop simulada — entries gerenciadas orfas sao adotadas, nao duplicadas', async () => {
    const codexDir = path.join(SANDBOX, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const initial = [
      '[projects."/home/user/proj"]',
      'trust_level = "trusted"',
      '',
      '[mcp_servers.blotato]',
      'command = "node"',
      'args = ["/opt/lionclaw/mcp/blotato/server.js"]',
      'tool_timeout_sec = 360.0',
      '',
      '[mcp_servers.node_repl]',
      'command = "/opt/codex-desktop/resources/node_repl"',
      '',
      '[mcp_servers.node_repl.env]',
      'CODEX_HOME = "/home/user/.codex"',
      '',
      '[mcp_servers.openaiDeveloperDocs]',
      'url = "https://developers.openai.com/mcp"',
      '',
      '# <<< LIONCLAW_MANAGED',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexDir, 'config.toml'), initial, 'utf8');

    mcpServers.push({
      id: 'blotato',
      name: 'Blotato',
      command: 'node',
      args: ['/opt/lionclaw/mcp/blotato/server.js'],
      envKeys: [],
      isActive: true,
    });

    const { syncCodexMcpConfig } = await import('../mcp-config-sync');
    await syncCodexMcpConfig();

    const final = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');

    expect(countOccurrences(final, '[mcp_servers.blotato]')).toBe(1);
    expect(final).toContain('[mcp_servers.node_repl]');
    expect(final).toContain('[mcp_servers.node_repl.env]');
    expect(final).toContain('[mcp_servers.openaiDeveloperDocs]');
    expect(final).toContain('[projects."/home/user/proj"]');
    expect(countOccurrences(final, '# >>> LIONCLAW_MANAGED')).toBe(1);
    expect(countOccurrences(final, '# <<< LIONCLAW_MANAGED')).toBe(1);
    expect(final.indexOf('# >>> LIONCLAW_MANAGED')).toBeLessThan(
      final.indexOf('# <<< LIONCLAW_MANAGED'),
    );
    const begin = final.indexOf('# >>> LIONCLAW_MANAGED');
    expect(final.indexOf('[mcp_servers.blotato]')).toBeGreaterThan(begin);
  });

  it('6.1: sub-tabela de id gerenciado orfao e removida junto com a tabela-pai', async () => {
    const codexDir = path.join(SANDBOX, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const initial = [
      '[mcp_servers.graph-search]',
      'command = "node"',
      '',
      '[mcp_servers.graph-search.env]',
      'STALE = "yes"',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexDir, 'config.toml'), initial, 'utf8');

    mcpServers.push({
      id: 'graph-search',
      name: 'Graph',
      command: 'node',
      args: ['/opt/graph.js'],
      envKeys: [],
      isActive: true,
    });

    const { syncCodexMcpConfig } = await import('../mcp-config-sync');
    await syncCodexMcpConfig();

    const final = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
    expect(countOccurrences(final, '[mcp_servers.graph-search]')).toBe(1);
    expect(final).not.toContain('STALE = "yes"');
  });

  it('idempotencia: rodar o sync 2x sobre o resultado e byte-identico', async () => {
    const codexDir = path.join(SANDBOX, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'config.toml'),
      '[mcp_servers.blotato]\ncommand = "node"\n\n# <<< LIONCLAW_MANAGED\n',
      'utf8',
    );
    mcpServers.push({
      id: 'blotato',
      name: 'Blotato',
      command: 'node',
      args: ['/opt/blotato.js'],
      envKeys: [],
      isActive: true,
    });

    const { syncCodexMcpConfig } = await import('../mcp-config-sync');
    await syncCodexMcpConfig();
    const first = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
    await syncCodexMcpConfig();
    const second = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
    expect(second).toBe(first);
  });

  it('blocos LIONCLAW_MANAGED extras (corrupcao) sao todos removidos no split', async () => {
    const { __internal } = await import('../mcp-config-sync');
    const content = [
      'user = 1',
      __internal.BEGIN_MARKER,
      '[mcp_servers.a]',
      __internal.END_MARKER,
      'meio = 2',
      __internal.BEGIN_MARKER,
      '[mcp_servers.b]',
      __internal.END_MARKER,
      'fim = 3',
    ].join('\n');
    const { pre, post } = __internal.splitExisting(content);
    expect(pre).toContain('user = 1');
    expect(post).toContain('meio = 2');
    expect(post).toContain('fim = 3');
    expect(post).not.toContain('[mcp_servers.b]');
    expect(post).not.toContain(__internal.BEGIN_MARKER);
  });

  it('P4 regressao: entry GENUINA do usuario com o id do gateway segue em colisao (skip ruidoso)', async () => {
    const codexDir = path.join(SANDBOX, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const initial = [
      '[mcp_servers.lionclaw-gateway]',
      'command = "python3"',
      'args = ["/home/user/meu-gateway-proprio.py"]',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexDir, 'config.toml'), initial, 'utf8');

    const { syncCodexMcpConfig } = await import('../mcp-config-sync');
    await syncCodexMcpConfig();

    const final = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
    expect(final).toContain('/home/user/meu-gateway-proprio.py');
    const begin = final.indexOf('# >>> LIONCLAW_MANAGED');
    const managedSegment = final.slice(begin);
    expect(managedSegment).not.toContain('[mcp_servers.lionclaw-gateway]');
    expect(countOccurrences(final, '[mcp_servers.lionclaw-gateway]')).toBe(1);
  });

  it('gateway STRANDED (aponta pro nosso wrapper) e adotado: sai do corpo, volta pro bloco', async () => {
    const codexDir = path.join(SANDBOX, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const wrapperRef = path.join(SANDBOX, '.lionclaw', 'mcp-wrappers', 'lionclaw-gateway.js');
    const initial = [
      '[mcp_servers.lionclaw-gateway]',
      'command = "node"',
      `args = ["${wrapperRef}"]`,
      'enabled = false',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexDir, 'config.toml'), initial, 'utf8');

    const { syncCodexMcpConfig } = await import('../mcp-config-sync');
    await syncCodexMcpConfig();

    const final = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
    expect(countOccurrences(final, '[mcp_servers.lionclaw-gateway]')).toBe(1);
    const begin = final.indexOf('# >>> LIONCLAW_MANAGED');
    expect(final.indexOf('[mcp_servers.lionclaw-gateway]')).toBeGreaterThan(begin);
  });

  it('6.3 guarda: findDuplicateMcpTableHeaders acusa duplicata exata e ignora sub-tabelas', async () => {
    const { __internal } = await import('../mcp-config-sync');
    const dup = [
      '[mcp_servers.blotato]',
      'a = 1',
      '[mcp_servers.node_repl]',
      '[mcp_servers.node_repl.env]',
      '[mcp_servers.blotato]',
      'b = 2',
    ].join('\n');
    expect(__internal.findDuplicateMcpTableHeaders(dup)).toEqual(['mcp_servers.blotato']);
    const clean = ['[mcp_servers.node_repl]', '[mcp_servers.node_repl.env]'].join('\n');
    expect(__internal.findDuplicateMcpTableHeaders(clean)).toEqual([]);
  });
});
