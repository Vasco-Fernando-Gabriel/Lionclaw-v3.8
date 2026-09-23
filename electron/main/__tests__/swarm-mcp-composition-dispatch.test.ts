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

const domain = vi.hoisted(() => ({
  catalog: vi.fn(async () => ({ members: [], profiles: [] })),
  start: vi.fn(async () => ({ runId: 'accepted' })),
  list: vi.fn(async () => ({ runs: [] })),
}));
vi.mock('../swarm', () => ({
  getSwarmService: () => ({ getCatalog: domain.catalog, start: domain.start, listRuns: domain.list }),
}));
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
import { resolveHelperTokenOwner, __resetHelperIdentityForTests } from '../helper-identity';
import { dispatch, type JsonRpcContext } from '../local-ipc/jsonrpc-methods';
import {
  registerChatCapabilityTurn,
  setActiveChatTurn,
  __resetChatCapabilityContextForTests,
} from '../chat-capability-context';
import { resetDesktopLanesForTests } from '../desktop-lanes';

const ON = { pipelineControl: false, dynamicWorkflows: false, swarm: true };
const OFF = { ...ON, swarm: false };
const turn = { sessionId: 'swarm-chat', turnId: 'swarm-turn' };
beforeEach(() => {
  vi.clearAllMocks();
  __resetHelperIdentityForTests();
  __resetChatCapabilityContextForTests();
  resetDesktopLanesForTests();
  state.settings = new Map([['mcp_prompt_mode', 'index']]);
  state.agents.clear();
  state.servers = [serverRow('lionclaw-swarm')] as unknown as Array<Record<string, unknown>>;
});
function register(enabled: boolean) {
  registerChatCapabilityTurn(
    {
      surface: 'chat',
      ...turn,
      origin: 'user',
      capabilities: enabled ? ON : OFF,
      cwd: '/authorized',
      readRoots: ['/authorized'],
      writeRoots: [],
      allowedTools: [],
      allowedServerIds: ['lionclaw-swarm'],
    },
    60_000,
  );
  setActiveChatTurn({ ...turn, lane: 'desktop' });
}
function connectionFromSpawn(
  config: Awaited<ReturnType<typeof getMCPConfigForAgent>>,
  serverId = 'lionclaw-swarm',
): JsonRpcContext {
  const token = config?.[serverId]?.env?.LIONCLAW_HELPER_TOKEN;
  const owner = typeof token === 'string' ? resolveHelperTokenOwner(token) : null;
  expect(owner).toBe(serverId);
  return {
    getWindow: () => null,
    connection: {
      authenticatedHelper: owner !== null,
      ...(owner ? { serverId: owner } : {}),
      connectionId: 'spawn-from-composition',
    },
  };
}
function call(ctx: JsonRpcContext, method: string, binding: Record<string, unknown> = turn) {
  return dispatch(ctx, { jsonrpc: '2.0', id: 1, method, params: { ...binding, lane: 'desktop' } });
}
describe('Swarm composição real -> identidade do spawn -> gate do dispatch', () => {
  for (const surface of ['claude-sdk', 'claude-compat-sdk', 'lion-sdk', 'codex-sdk'] as const) {
    for (const fullCatalog of surface === 'claude-sdk' || surface === 'claude-compat-sdk' ? [false, true] : [true]) {
      it(`${surface} fullCatalog=${fullCatalog}: ON recebe identidade e binding, catálogo entra no domínio`, async () => {
        register(true);
        const config = await getMCPConfigForAgent(undefined, {
          surface,
          fullCatalog,
          capabilities: ON,
          lane: 'desktop',
          turn,
        });
        expect(config?.['lionclaw-swarm']).toBeDefined();
        const ctx = connectionFromSpawn(config);
        expect(config!['lionclaw-swarm'].env).toMatchObject({
          LIONCLAW_MCP_SESSION_ID: turn.sessionId,
          LIONCLAW_MCP_TURN_ID: turn.turnId,
        });
        expect((await call(ctx, 'swarm_catalog')).result).toEqual({ members: [], profiles: [] });
        expect(domain.catalog).toHaveBeenCalledWith(turn.sessionId, true);
        await call(ctx, 'swarm_list');
        expect(domain.list).toHaveBeenCalledWith(turn.sessionId, undefined, undefined);
        expect((await call(ctx, 'swarm_catalog', { ...turn, turnId: 'another-turn' })).result).toMatchObject({
          code: 'chat_capability_no_turn_context',
        });
        expect((await call(ctx, 'swarm_catalog', {})).result).toMatchObject({
          code: 'chat_capability_no_turn_context',
        });
        expect(domain.catalog).toHaveBeenCalledTimes(1);
      });
    }
  }
  it('OFF oculta helper na composição normal; token obtido no pool não concede capability', async () => {
    register(false);
    const normal = await getMCPConfigForAgent(undefined, {
      surface: 'claude-sdk',
      capabilities: OFF,
      lane: 'desktop',
      turn,
    });
    expect(normal?.['lionclaw-swarm']).toBeUndefined();
    const pool = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk', fullCatalog: true });
    const ctx = connectionFromSpawn(pool);
    for (const method of ['swarm_catalog', 'swarm_start']) {
      expect((await call(ctx, method)).result).toMatchObject({ code: 'chat_capability_swarm_disabled' });
    }
    expect(domain.catalog).not.toHaveBeenCalled();
    expect(domain.start).not.toHaveBeenCalled();
  });
});
