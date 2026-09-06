
import { isAbsolute } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';


interface ServerRow {
  id: string;
  name: string;
  description: string | null;
  command: string;
  args: string;
  env_keys: string;
  is_active: number;
  visible_to: 'all' | 'codex-lion-only';
  index_mode: 'tools' | 'server';
}

function serverRow(
  id: string,
  visibleTo: 'all' | 'codex-lion-only' = 'all',
): ServerRow {
  return {
    id,
    name: `Server ${id}`,
    description: null,
    command: 'node',
    args: JSON.stringify([`/path/${id}.js`]),
    env_keys: '[]',
    is_active: 1,
    visible_to: visibleTo,
    index_mode: 'tools',
  };
}

const state = vi.hoisted(() => ({
  servers: [] as Array<Record<string, unknown>>,
  agents: new Map<string, string>(), // agentId -> mcp_servers JSON
  settings: new Map<string, string>(),
}));

vi.mock('../db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: () => {
        if (sql.includes('FROM mcp_servers')) return state.servers;
        return [];
      },
      get: (...args: unknown[]) => {
        if (sql.includes('FROM agents')) {
          const id = args[0] as string;
          const mcp = state.agents.get(id);
          return mcp !== undefined ? { mcp_servers: mcp } : undefined;
        }
        if (sql.includes('FROM mcp_servers WHERE id')) {
          return state.servers.find((s) => s['id'] === args[0]);
        }
        return undefined;
      },
      run: () => undefined,
    }),
    transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
  }),
  getSetting: (key: string) => state.settings.get(key),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../app-version', () => ({
  getAppVersion: () => '0.0.0-test',
}));

import { getMCPConfigForAgent, getAllMCPServers } from '../mcp-manager';
import { DIRECT_MCP_HELPERS } from '../mcp-risk-patterns';
import { MCP_GATEWAY_SERVER_ID } from '../mcp-display';
import { isValidHelperToken } from '../helper-identity';

const GATEWAY_DIST_SUFFIX = 'gateway/dist/gateway/src/index.js';

function legacyClaudeExpected(): Record<string, { command: string; args: string[] }> {
  return {
    'google-gmail': { command: 'node', args: ['/path/google-gmail.js'] },
    shopify: { command: 'node', args: ['/path/shopify.js'] },
    'lionclaw-pipeline-control': {
      command: 'node',
      args: ['/path/lionclaw-pipeline-control.js'],
    },
    'repo-graph': { command: 'node', args: ['/path/repo-graph.js'] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.settings = new Map([['mcp_prompt_mode', 'index']]);
  state.agents = new Map([
    ['agent-p5', JSON.stringify(['google-gmail'])],
    ['agent-sem-mcp', '[]'],
  ]);
  state.servers = [
    serverRow('google-gmail'),
    serverRow('shopify'),
    serverRow('lionclaw-pipeline-control'),
    serverRow('repo-graph'),
    serverRow('lionclaw-user-question', 'codex-lion-only'),
  ] as unknown as Array<Record<string, unknown>>;
});


describe('modo index — claude-sdk / claude-compat-sdk', () => {
  it('claude-sdk: gateway + helpers DIRECT visiveis, ZERO server de negocio', async () => {
    const config = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    expect(config).toBeDefined();
    expect(Object.keys(config!)).toEqual([
      MCP_GATEWAY_SERVER_ID,
      'lionclaw-pipeline-control',
      'repo-graph',
    ]);
    expect(config!['google-gmail']).toBeUndefined();
    expect(config!['shopify']).toBeUndefined();
    expect(config!['lionclaw-user-question']).toBeUndefined();
  });

  it('entry do gateway: node + dist do gateway + env com o surface (claude-sdk)', async () => {
    const config = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    const gw = config![MCP_GATEWAY_SERVER_ID];
    expect(isAbsolute(gw.command)).toBe(true);
    expect(gw.args).toHaveLength(1);
    expect(gw.args[0].endsWith(GATEWAY_DIST_SUFFIX)).toBe(true);
    expect(gw.env).toEqual(expect.objectContaining({
      LIONCLAW_MCP_SURFACE: 'claude-sdk',
      LIONCLAW_HELPER_TOKEN: expect.any(String),
      PATH: expect.any(String),
    }));
    expect(isValidHelperToken(gw.env!['LIONCLAW_HELPER_TOKEN'])).toBe(true);
  });

  it('claude-compat-sdk: mesma composicao, env com o surface compat', async () => {
    const config = await getMCPConfigForAgent(undefined, { surface: 'claude-compat-sdk' });
    expect(Object.keys(config!)).toEqual([
      MCP_GATEWAY_SERVER_ID,
      'lionclaw-pipeline-control',
      'repo-graph',
    ]);
    expect(config![MCP_GATEWAY_SERVER_ID].env).toEqual(expect.objectContaining({
      LIONCLAW_MCP_SURFACE: 'claude-compat-sdk',
      LIONCLAW_HELPER_TOKEN: expect.any(String),
      PATH: expect.any(String),
    }));
  });


  it('S3a: helper GATED (pipeline-control) recebe LIONCLAW_HELPER_TOKEN valido no env', async () => {
    const config = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    const gated = config!['lionclaw-pipeline-control'];
    const token = gated.env?.['LIONCLAW_HELPER_TOKEN'];
    expect(typeof token).toBe('string');
    expect(isValidHelperToken(token!)).toBe(true);
  });

  it('S3a: helper NAO-gated (repo-graph) fica SEM token (fail-closed so vale p/ gated)', async () => {
    const config = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    expect(config!['repo-graph'].env?.['LIONCLAW_HELPER_TOKEN']).toBeUndefined();
  });

  it('S3a: um token POR SPAWN — composicoes distintas cunham tokens distintos', async () => {
    const first = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    const second = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    const t1 = first![MCP_GATEWAY_SERVER_ID].env!['LIONCLAW_HELPER_TOKEN'];
    const t2 = second![MCP_GATEWAY_SERVER_ID].env!['LIONCLAW_HELPER_TOKEN'];
    expect(t1).not.toBe(t2);
    expect(isValidHelperToken(t1)).toBe(true);
    expect(isValidHelperToken(t2)).toBe(true);
  });

  it('helpers que entram na composicao index pertencem todos a DIRECT_MCP_HELPERS', async () => {
    const config = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    for (const id of Object.keys(config!)) {
      if (id === MCP_GATEWAY_SERVER_ID) continue;
      expect(DIRECT_MCP_HELPERS).toContain(id);
    }
  });

  it('gateway NAO e linha do DB: getAllMCPServers (base do discovery) nao o contem', async () => {
    const ids = getAllMCPServers().map((s) => s.id);
    expect(ids).not.toContain(MCP_GATEWAY_SERVER_ID);
    const config = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    expect(config![MCP_GATEWAY_SERVER_ID]).toBeDefined();
  });
});


function stripGatedHelperTokens(
  config: Record<string, { command: string; args: string[]; env?: Record<string, string> }>,
): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
  const out: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  for (const [id, entry] of Object.entries(config)) {
    if (entry.env && 'LIONCLAW_HELPER_TOKEN' in entry.env) {
      const { LIONCLAW_HELPER_TOKEN: _token, ...rest } = entry.env;
      out[id] =
        Object.keys(rest).length > 0
          ? { ...entry, env: rest }
          : { command: entry.command, args: entry.args };
    } else {
      out[id] = entry;
    }
  }
  return out;
}

describe('modo full — legado byte-identico EXCETO token nos gated (claude-sdk, S4b)', () => {
  it('full + claude-sdk == formula antiga apos strip do token; gated ganha token VALIDO', async () => {
    state.settings.set('mcp_prompt_mode', 'full');
    const config = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    const token = config!['lionclaw-pipeline-control'].env?.['LIONCLAW_HELPER_TOKEN'];
    expect(typeof token).toBe('string');
    expect(isValidHelperToken(token!)).toBe(true);
    expect(JSON.stringify(stripGatedHelperTokens(config!))).toBe(
      JSON.stringify(legacyClaudeExpected()),
    );
  });

  it('S4b: AMBOS os gated recebem token no full; nao-gated e negocio ficam SEM', async () => {
    state.settings.set('mcp_prompt_mode', 'full');
    state.servers.push(serverRow('lionclaw-dynamic-workflows') as unknown as Record<string, unknown>);
    const config = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    for (const id of ['lionclaw-pipeline-control', 'lionclaw-dynamic-workflows']) {
      const token = config![id].env?.['LIONCLAW_HELPER_TOKEN'];
      expect(isValidHelperToken(token ?? '')).toBe(true);
    }
    expect(config!['repo-graph'].env?.['LIONCLAW_HELPER_TOKEN']).toBeUndefined();
    expect(config!['google-gmail'].env?.['LIONCLAW_HELPER_TOKEN']).toBeUndefined();
    expect(config!['shopify'].env?.['LIONCLAW_HELPER_TOKEN']).toBeUndefined();
  });

  it('S4b: compat tambem recebe token no full (mesmo gap, mesma correcao)', async () => {
    state.settings.set('mcp_prompt_mode', 'full');
    const config = await getMCPConfigForAgent(undefined, { surface: 'claude-compat-sdk' });
    const token = config!['lionclaw-pipeline-control'].env?.['LIONCLAW_HELPER_TOKEN'];
    expect(isValidHelperToken(token ?? '')).toBe(true);
  });

  it('full + claude-sdk == caminho default sem surface (SP-3.2) apos strip do token', async () => {
    state.settings.set('mcp_prompt_mode', 'full');
    const withSurface = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    const noSurface = await getMCPConfigForAgent();
    expect(noSurface!['lionclaw-pipeline-control'].env).toBeUndefined();
    expect(JSON.stringify(stripGatedHelperTokens(withSurface!))).toBe(JSON.stringify(noSurface));
  });
});


describe('surfaces kimi-sdk / lion-sdk / codex-sdk / default — intocados', () => {
  const expectedCodexLion = [
    'google-gmail',
    'shopify',
    'lionclaw-pipeline-control',
    'repo-graph',
    'lionclaw-user-question',
  ];

  for (const surface of ['kimi-sdk', 'lion-sdk', 'codex-sdk'] as const) {
    it(`${surface}: mesmo retorno nos modos index e full (sem gateway)`, async () => {
      state.settings.set('mcp_prompt_mode', 'index');
      const indexMode = await getMCPConfigForAgent(undefined, { surface });
      state.settings.set('mcp_prompt_mode', 'full');
      const fullMode = await getMCPConfigForAgent(undefined, { surface });

      expect(JSON.stringify(indexMode)).toBe(JSON.stringify(fullMode));
      expect(Object.keys(indexMode!)).toEqual(expectedCodexLion);
      expect(indexMode![MCP_GATEWAY_SERVER_ID]).toBeUndefined();
    });
  }

  it('default (sem surface): intocado em modo index (sem gateway)', async () => {
    const config = await getMCPConfigForAgent();
    expect(JSON.stringify(config)).toBe(JSON.stringify(legacyClaudeExpected()));
    expect(config![MCP_GATEWAY_SERVER_ID]).toBeUndefined();
  });
});


describe('P5 — config MCP explicita do agente', () => {
  it('agente com subset explicito: servers DIRETOS, sem gateway, em modo index', async () => {
    const config = await getMCPConfigForAgent('agent-p5', { surface: 'claude-sdk' });
    expect(Object.keys(config!)).toEqual(['google-gmail']);
    expect(config![MCP_GATEWAY_SERVER_ID]).toBeUndefined();
  });

  it('agente com subset explicito: identico nos 2 modos', async () => {
    state.settings.set('mcp_prompt_mode', 'index');
    const indexMode = await getMCPConfigForAgent('agent-p5', { surface: 'claude-sdk' });
    state.settings.set('mcp_prompt_mode', 'full');
    const fullMode = await getMCPConfigForAgent('agent-p5', { surface: 'claude-sdk' });
    expect(JSON.stringify(indexMode)).toBe(JSON.stringify(fullMode));
  });

  it('agente sem MCPs selecionados: undefined nos 2 modos (nao ganha gateway)', async () => {
    expect(await getMCPConfigForAgent('agent-sem-mcp', { surface: 'claude-sdk' })).toBeUndefined();
    state.settings.set('mcp_prompt_mode', 'full');
    expect(await getMCPConfigForAgent('agent-sem-mcp', { surface: 'claude-sdk' })).toBeUndefined();
  });

  it('S4b: agente com helper GATED explicito -> entry direta COM token nos 2 modos', async () => {
    state.agents.set('agent-gated', JSON.stringify(['lionclaw-pipeline-control', 'google-gmail']));
    for (const mode of ['index', 'full'] as const) {
      state.settings.set('mcp_prompt_mode', mode);
      const config = await getMCPConfigForAgent('agent-gated', { surface: 'claude-sdk' });
      const token = config!['lionclaw-pipeline-control'].env?.['LIONCLAW_HELPER_TOKEN'];
      expect(isValidHelperToken(token ?? '')).toBe(true);
      expect(config!['google-gmail'].env?.['LIONCLAW_HELPER_TOKEN']).toBeUndefined();
      expect(config![MCP_GATEWAY_SERVER_ID]).toBeUndefined();
    }
  });
});


describe('anti-bug do sprint — wrapper central ve a composicao LEGADA em modo index', () => {
  it('fullCatalog: true + claude-sdk + modo index -> servers de NEGOCIO presentes, sem gateway', async () => {
    const config = await getMCPConfigForAgent(undefined, {
      surface: 'claude-sdk',
      fullCatalog: true,
    });
    expect(JSON.stringify(config)).toBe(JSON.stringify(legacyClaudeExpected()));
    expect(config!['google-gmail']).toBeDefined();
    expect(config![MCP_GATEWAY_SERVER_ID]).toBeUndefined();
  });

  it('fullCatalog: true + claude-compat-sdk idem', async () => {
    const config = await getMCPConfigForAgent(undefined, {
      surface: 'claude-compat-sdk',
      fullCatalog: true,
    });
    expect(config!['shopify']).toBeDefined();
    expect(config![MCP_GATEWAY_SERVER_ID]).toBeUndefined();
  });

  it('fullCatalog: true nao muda o retorno dos surfaces kimi/lion', async () => {
    const kimi = await getMCPConfigForAgent(undefined, { surface: 'kimi-sdk', fullCatalog: true });
    const kimiPlain = await getMCPConfigForAgent(undefined, { surface: 'kimi-sdk' });
    expect(JSON.stringify(kimi)).toBe(JSON.stringify(kimiPlain));
  });
});


describe('AC-7 — troca de mcp_prompt_mode entre 2 montagens', () => {
  it('segunda montagem reflete o modo novo; objeto da primeira permanece intacto', async () => {
    state.settings.set('mcp_prompt_mode', 'index');
    const first = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    const firstSnapshot = JSON.stringify(first);
    expect(first![MCP_GATEWAY_SERVER_ID]).toBeDefined();

    state.settings.set('mcp_prompt_mode', 'full');
    const second = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });

    expect(second![MCP_GATEWAY_SERVER_ID]).toBeUndefined();
    expect(second!['google-gmail']).toBeDefined();
    expect(JSON.stringify(first)).toBe(firstSnapshot);

    state.settings.set('mcp_prompt_mode', 'index');
    const third = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    expect(third![MCP_GATEWAY_SERVER_ID]).toBeDefined();
  });

  it('setting ausente (fresh, pre-V126 seed) -> default index para claude/compat', async () => {
    state.settings.delete('mcp_prompt_mode');
    const config = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    expect(config![MCP_GATEWAY_SERVER_ID]).toBeDefined();
  });
});
