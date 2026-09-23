import { describe, it, expect, beforeEach, vi } from 'vitest';

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
        if (sql.includes('FROM agents')) return undefined;
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
import { TOOL_SCRIPT_HELPER_ID } from '../mcp-risk-patterns';
import type { ChatFeatureToggles, OrchestratorRuntime } from '../../../src/types';

type McpConfig = Record<string, { command: string; args: string[]; env?: Record<string, string> }>;

const TOKEN_ENV = 'LIONCLAW_HELPER_TOKEN';
const PIPELINE_ID = 'lionclaw-pipeline-control';
const TS_ID = TOOL_SCRIPT_HELPER_ID;

const DESKTOP_CAPS: ChatFeatureToggles = { pipelineControl: true, dynamicWorkflows: true };

const CHAT_SPAWN_SURFACES: OrchestratorRuntime[] = ['claude-sdk', 'claude-compat-sdk', 'kimi-sdk', 'lion-sdk'];

beforeEach(() => {
  vi.clearAllMocks();
  state.settings = new Map([['mcp_prompt_mode', 'index']]);
  state.servers = [
    serverRow('google-gmail'),
    serverRow('shopify'),
    serverRow(PIPELINE_ID),
    serverRow('lionclaw-dynamic-workflows'),
    serverRow('repo-graph'),
    serverRow(TS_ID),
  ] as unknown as Array<Record<string, unknown>>;
});

function tokenOf(config: McpConfig | undefined, id: string): string | undefined {
  return config?.[id]?.env?.[TOKEN_ENV];
}

describe('turno desktop (capabilities presente): toolscript always-on com token', () => {
  for (const surface of CHAT_SPAWN_SURFACES) {
    it(`${surface} (index): toolscript presente COM token de processo`, async () => {
      const config = await getMCPConfigForAgent(undefined, {
        surface,
        capabilities: DESKTOP_CAPS,
      });
      expect(Object.keys(config ?? {})).toContain(TS_ID);
      expect(tokenOf(config, TS_ID)).toBeDefined();
      expect(tokenOf(config, TS_ID)!.length).toBeGreaterThan(0);
    });

    it(`${surface} (full/rollback): toolscript AINDA presente COM token (decisao d superseded)`, async () => {
      state.settings.set('mcp_prompt_mode', 'full');
      const config = await getMCPConfigForAgent(undefined, {
        surface,
        capabilities: DESKTOP_CAPS,
      });
      expect(Object.keys(config ?? {})).toContain(TS_ID);
      expect(tokenOf(config, TS_ID)).toBeDefined();
    });
  }

  it('token e FRESCO por composicao (nao mapeia token->sessao)', async () => {
    const a = await getMCPConfigForAgent(undefined, {
      surface: 'kimi-sdk',
      capabilities: DESKTOP_CAPS,
    });
    const b = await getMCPConfigForAgent(undefined, {
      surface: 'kimi-sdk',
      capabilities: DESKTOP_CAPS,
    });
    expect(tokenOf(a, TS_ID)).toBeDefined();
    expect(tokenOf(b, TS_ID)).toBeDefined();
    expect(tokenOf(a, TS_ID)).not.toBe(tokenOf(b, TS_ID));
  });
});

describe('invariante Fase A (S4/S5): gated helpers SEM token em kimi/lion', () => {
  for (const surface of ['kimi-sdk', 'lion-sdk'] as const) {
    it(`${surface}: pipeline-control presente SEM token; toolscript presente COM token`, async () => {
      const config = await getMCPConfigForAgent(undefined, {
        surface,
        capabilities: DESKTOP_CAPS,
      });
      expect(Object.keys(config ?? {})).toContain(PIPELINE_ID);
      expect(tokenOf(config, PIPELINE_ID)).toBeUndefined();
      expect(tokenOf(config, TS_ID)).toBeDefined();
    });
  }
});

describe('lanes sem turn-context (capabilities undefined): toolscript AUSENTE (S3c)', () => {
  for (const surface of CHAT_SPAWN_SURFACES) {
    it(`${surface}: capabilities undefined -> toolscript NAO compoe`, async () => {
      const config = await getMCPConfigForAgent(undefined, { surface });
      expect(Object.keys(config ?? {})).not.toContain(TS_ID);
      expect(Object.keys(config ?? {})).toContain('repo-graph');
    });

    it(`${surface} (full): capabilities undefined -> toolscript NAO compoe`, async () => {
      state.settings.set('mcp_prompt_mode', 'full');
      const config = await getMCPConfigForAgent(undefined, { surface });
      expect(Object.keys(config ?? {})).not.toContain(TS_ID);
    });
  }

  it('polaridade INVERTIDA do filtro gated: gated compoe SEM caps; turn-scoped NAO', async () => {
    const config = await getMCPConfigForAgent(undefined, { surface: 'kimi-sdk' });
    expect(Object.keys(config ?? {})).toContain(PIPELINE_ID);
    expect(Object.keys(config ?? {})).not.toContain(TS_ID);
  });
});

describe('fullCatalog:true (wrapper central) — excecao deliberada do filtro S3c', () => {
  it('capabilities undefined + fullCatalog:true -> toolscript COMPOE (re-valida por turno no invoke)', async () => {
    const config = await getMCPConfigForAgent(undefined, {
      surface: 'kimi-sdk',
      fullCatalog: true,
    });
    expect(Object.keys(config ?? {})).toContain(TS_ID);
    expect(tokenOf(config, TS_ID)).toBeDefined();
  });

  it('capabilities presente + fullCatalog:true -> toolscript COMPOE com token (caminho do hook do orchestrator)', async () => {
    const config = await getMCPConfigForAgent(undefined, {
      surface: 'claude-sdk',
      fullCatalog: true,
      capabilities: DESKTOP_CAPS,
    });
    expect(Object.keys(config ?? {})).toContain(TS_ID);
    expect(tokenOf(config, TS_ID)).toBeDefined();
  });
});
