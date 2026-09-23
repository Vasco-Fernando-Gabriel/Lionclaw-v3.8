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

function serverRow(id: string, visibleTo: 'all' | 'codex-lion-only' = 'all'): ServerRow {
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
    transaction:
      (fn: (...a: unknown[]) => unknown) =>
      (...a: unknown[]) =>
        fn(...a),
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

import { getMCPConfigForAgent } from '../mcp-manager';
import { isDirectMcpHelper } from '../mcp-risk-patterns';
import { MCP_GATEWAY_SERVER_ID } from '../mcp-display';
import { CHAT_CAPABILITIES_LEGACY_ON } from '../../../src/types';
import type { ChatFeatureToggles } from '../../../src/types';

type McpConfig = Record<string, { command: string; args: string[]; env?: Record<string, string> }>;

const PIPELINE_ID = 'lionclaw-pipeline-control';
const WORKFLOWS_ID = 'lionclaw-dynamic-workflows';

const BOTH_ON: ChatFeatureToggles = { pipelineControl: true, dynamicWorkflows: true };
const PIPELINE_OFF: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: true };
const WORKFLOWS_OFF: ChatFeatureToggles = { pipelineControl: true, dynamicWorkflows: false };
const BOTH_OFF: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: false };

function legacyExpected(): McpConfig {
  return {
    'google-gmail': { command: 'node', args: ['/path/google-gmail.js'] },
    shopify: { command: 'node', args: ['/path/shopify.js'] },
    [PIPELINE_ID]: { command: 'node', args: [`/path/${PIPELINE_ID}.js`] },
    [WORKFLOWS_ID]: { command: 'node', args: [`/path/${WORKFLOWS_ID}.js`] },
    'repo-graph': { command: 'node', args: ['/path/repo-graph.js'] },
  };
}

function stripTokens(config: McpConfig): McpConfig {
  const out: McpConfig = {};
  for (const [id, entry] of Object.entries(config)) {
    if (entry.env && 'LIONCLAW_HELPER_TOKEN' in entry.env) {
      const { LIONCLAW_HELPER_TOKEN: _token, ...rest } = entry.env;
      out[id] = Object.keys(rest).length > 0 ? { ...entry, env: rest } : { command: entry.command, args: entry.args };
    } else {
      out[id] = entry;
    }
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.settings = new Map([['mcp_prompt_mode', 'index']]);
  state.agents = new Map([
    ['agent-gated', JSON.stringify([PIPELINE_ID, WORKFLOWS_ID, 'google-gmail'])],
    ['agent-so-gated', JSON.stringify([PIPELINE_ID])],
  ]);
  state.servers = [
    serverRow('google-gmail'),
    serverRow('shopify'),
    serverRow(PIPELINE_ID),
    serverRow(WORKFLOWS_ID),
    serverRow('repo-graph'),
  ] as unknown as Array<Record<string, unknown>>;
});

describe('default sem capabilities — byte-identico ao comportamento atual', () => {
  it('caminho default (sem surface): formula legada intacta, gated presentes', async () => {
    const config = await getMCPConfigForAgent();
    expect(JSON.stringify(config)).toBe(JSON.stringify(legacyExpected()));
  });

  it('claude-sdk modo index: gateway + TODOS os helpers DIRECT (gated inclusos)', async () => {
    const config = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    expect(Object.keys(config!)).toEqual([MCP_GATEWAY_SERVER_ID, PIPELINE_ID, WORKFLOWS_ID, 'repo-graph']);
  });

  it('fullCatalog: true sem capabilities: composicao legada com os gated', async () => {
    const config = await getMCPConfigForAgent(undefined, {
      surface: 'claude-sdk',
      fullCatalog: true,
    });
    expect(JSON.stringify(stripTokens(config!))).toBe(JSON.stringify(legacyExpected()));
  });

  it('capabilities LEGACY_ON == omitir capabilities (apos strip do token aleatorio), em index/full/fullCatalog/kimi', async () => {
    const combos: Array<Parameters<typeof getMCPConfigForAgent>[1]> = [
      { surface: 'claude-sdk' },
      { surface: 'claude-sdk', fullCatalog: true },
      { surface: 'kimi-sdk' },
      undefined,
    ];
    for (const base of combos) {
      const without = await getMCPConfigForAgent(undefined, base);
      const withLegacy = await getMCPConfigForAgent(undefined, {
        ...(base ?? {}),
        capabilities: { ...CHAT_CAPABILITIES_LEGACY_ON },
      });
      expect(JSON.stringify(stripTokens(withLegacy ?? {}))).toBe(JSON.stringify(stripTokens(without ?? {})));
    }
    state.settings.set('mcp_prompt_mode', 'full');
    const without = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    const withLegacy = await getMCPConfigForAgent(undefined, {
      surface: 'claude-sdk',
      capabilities: { ...CHAT_CAPABILITIES_LEGACY_ON },
    });
    expect(JSON.stringify(stripTokens(withLegacy!))).toBe(JSON.stringify(stripTokens(without!)));
  });
});

describe('pipelineControl=false — filtro em config, index, allowedServerIds e gateway-scope', () => {
  it('helpers independentes de Pipeline continuam compostos no Fable', async () => {
    state.servers.push(
      serverRow('lionclaw-telegram') as unknown as Record<string, unknown>,
      serverRow('lionclaw-preview') as unknown as Record<string, unknown>,
      serverRow('lionclaw-skills') as unknown as Record<string, unknown>,
    );
    const config = await getMCPConfigForAgent(undefined, {
      surface: 'claude-sdk',
      capabilities: PIPELINE_OFF,
    });
    expect(config![PIPELINE_ID]).toBeUndefined();
    expect(config!['lionclaw-telegram']).toBeDefined();
    expect(config!['lionclaw-preview']).toBeDefined();
    expect(config!['lionclaw-skills']).toBeDefined();
  });

  it('modo index (claude-sdk): pipeline-control FORA; gateway, workflows e repo-graph ficam', async () => {
    const config = await getMCPConfigForAgent(undefined, {
      surface: 'claude-sdk',
      capabilities: PIPELINE_OFF,
    });
    expect(Object.keys(config!)).toEqual([MCP_GATEWAY_SERVER_ID, WORKFLOWS_ID, 'repo-graph']);
    expect(config![PIPELINE_ID]).toBeUndefined();
    expect(config![WORKFLOWS_ID].env?.['LIONCLAW_HELPER_TOKEN']).toBeDefined();
  });

  it('modo full (claude-sdk): pipeline-control FORA; negocio e demais helpers intactos', async () => {
    state.settings.set('mcp_prompt_mode', 'full');
    const config = await getMCPConfigForAgent(undefined, {
      surface: 'claude-sdk',
      capabilities: PIPELINE_OFF,
    });
    expect(config![PIPELINE_ID]).toBeUndefined();
    expect(Object.keys(config!)).toEqual(['google-gmail', 'shopify', WORKFLOWS_ID, 'repo-graph']);
  });

  it('fullCatalog: true (a chamada do gateway resolveGatewayAllowedServerIds e do wrapper mcp-invoke): pipeline-control FORA do escopo e do spec de spawn/schema', async () => {
    const config = await getMCPConfigForAgent(undefined, {
      surface: 'claude-sdk',
      fullCatalog: true,
      capabilities: PIPELINE_OFF,
    });
    expect(config![PIPELINE_ID]).toBeUndefined();
    const scope = Object.keys(config!).filter((id) => !isDirectMcpHelper(id));
    expect(scope).toEqual(['google-gmail', 'shopify']);
  });

  it('allowedServerIds derivado (Object.keys) nunca contem o server filtrado — kimi e lion', async () => {
    for (const surface of ['kimi-sdk', 'lion-sdk'] as const) {
      const config = await getMCPConfigForAgent(undefined, {
        surface,
        capabilities: PIPELINE_OFF,
      });
      expect(Object.keys(config!)).not.toContain(PIPELINE_ID);
      expect(Object.keys(config!)).toContain(WORKFLOWS_ID);
    }
  });
});

describe('dynamicWorkflows=false — filtro simetrico', () => {
  it('modo index (claude-sdk): dynamic-workflows FORA; pipeline-control fica (com token)', async () => {
    const config = await getMCPConfigForAgent(undefined, {
      surface: 'claude-sdk',
      capabilities: WORKFLOWS_OFF,
    });
    expect(Object.keys(config!)).toEqual([MCP_GATEWAY_SERVER_ID, PIPELINE_ID, 'repo-graph']);
    expect(config![WORKFLOWS_ID]).toBeUndefined();
    expect(config![PIPELINE_ID].env?.['LIONCLAW_HELPER_TOKEN']).toBeDefined();
  });

  it('fullCatalog: true: dynamic-workflows fora do spec/escopo; negocio intacto', async () => {
    const config = await getMCPConfigForAgent(undefined, {
      surface: 'claude-compat-sdk',
      fullCatalog: true,
      capabilities: WORKFLOWS_OFF,
    });
    expect(config![WORKFLOWS_ID]).toBeUndefined();
    expect(config![PIPELINE_ID]).toBeDefined();
    expect(config!['google-gmail']).toBeDefined();
  });

  it('ambos=false: os 2 gated FORA; nao-gated e negocio nunca sao filtrados', async () => {
    state.settings.set('mcp_prompt_mode', 'full');
    const config = await getMCPConfigForAgent(undefined, {
      surface: 'claude-sdk',
      capabilities: BOTH_OFF,
    });
    expect(Object.keys(config!)).toEqual(['google-gmail', 'shopify', 'repo-graph']);
  });

  it('ambos=true: nada e removido (identico ao default apos strip do token)', async () => {
    const withBothOn = await getMCPConfigForAgent(undefined, {
      surface: 'claude-sdk',
      capabilities: BOTH_ON,
    });
    const without = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    expect(JSON.stringify(stripTokens(withBothOn!))).toBe(JSON.stringify(stripTokens(without!)));
    expect(Object.keys(withBothOn!)).toContain(PIPELINE_ID);
    expect(Object.keys(withBothOn!)).toContain(WORKFLOWS_ID);
  });
});

describe('decisao 8 — config explicita de agente nao fura o filtro', () => {
  it('agente com gated explicito + capability off: so o resto sobrevive', async () => {
    const config = await getMCPConfigForAgent('agent-gated', {
      surface: 'claude-sdk',
      capabilities: BOTH_OFF,
    });
    expect(Object.keys(config!)).toEqual(['google-gmail']);
  });

  it('agente com gated explicito + capabilities AUSENTES: comportamento atual (tudo entra)', async () => {
    const config = await getMCPConfigForAgent('agent-gated', { surface: 'claude-sdk' });
    expect(Object.keys(config!)).toEqual([PIPELINE_ID, WORKFLOWS_ID, 'google-gmail']);
  });

  it('agente cujo UNICO MCP e o gated + capability off: retorno undefined (sem fallback ao catalogo)', async () => {
    const config = await getMCPConfigForAgent('agent-so-gated', {
      surface: 'claude-sdk',
      capabilities: PIPELINE_OFF,
    });
    expect(config).toBeUndefined();
  });

  it('AC-A17: alias "pipeline-control" no config explicito e filtrado igual ao id canonico', async () => {
    state.servers.push(serverRow('pipeline-control') as unknown as Record<string, unknown>);
    state.agents.set('agent-alias', JSON.stringify(['pipeline-control', 'google-gmail']));
    const filtered = await getMCPConfigForAgent('agent-alias', {
      surface: 'claude-sdk',
      capabilities: PIPELINE_OFF,
    });
    expect(Object.keys(filtered!)).toEqual(['google-gmail']);
    const unfiltered = await getMCPConfigForAgent('agent-alias', { surface: 'claude-sdk' });
    expect(Object.keys(unfiltered!)).toEqual(['pipeline-control', 'google-gmail']);
  });
});
