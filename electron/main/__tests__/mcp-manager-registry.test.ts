
import { describe, it, expect, vi, beforeEach } from 'vitest';


interface RecordedCall {
  sql: string;
  args: unknown[];
}

interface StubDb {
  db: {
    prepare: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };
  runs: RecordedCall[];
  alls: RecordedCall[];
}

function makeStubDb(allImpl?: (sql: string, args: unknown[]) => unknown[]): StubDb {
  const runs: RecordedCall[] = [];
  const alls: RecordedCall[] = [];
  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      run: (...args: unknown[]) => {
        runs.push({ sql, args });
      },
      all: (...args: unknown[]) => {
        alls.push({ sql, args });
        return allImpl ? allImpl(sql, args) : [];
      },
      get: () => undefined,
    })),
    transaction: vi.fn().mockImplementation(
      (fn: (...fnArgs: unknown[]) => unknown) =>
        (...callArgs: unknown[]) =>
          fn(...callArgs),
    ),
  };
  return { db, runs, alls };
}

const state = vi.hoisted(() => ({
  stub: undefined as unknown as { db: unknown },
}));

vi.mock('../db', () => ({
  getDb: () => state.stub.db,
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../app-version', () => ({
  getAppVersion: () => '0.0.0-test',
}));

import {
  saveMCPToolsToRegistry,
  getMCPToolsFromRegistry,
  getMcpToolRegistryEntries,
  deleteMCPServer,
} from '../mcp-manager';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let stub: StubDb;

beforeEach(() => {
  vi.clearAllMocks();
  stub = makeStubDb();
  state.stub = stub;
});


describe('saveMCPToolsToRegistry - UPSERT', () => {
  it('persiste as 5 colunas via INSERT ... ON CONFLICT DO UPDATE (description/schema/timestamp)', () => {
    const schema = { type: 'object', required: ['to'], properties: { to: { type: 'string' } } };
    saveMCPToolsToRegistry('gmail', [
      { name: 'send_email', description: 'Envia um email', inputSchema: schema },
    ]);

    const upserts = stub.runs.filter((r) => r.sql.includes('INSERT INTO mcp_tool_registry'));
    expect(upserts).toHaveLength(1);
    expect(upserts[0].sql).toMatch(
      /INSERT INTO mcp_tool_registry \(mcp_id, tool_name, description, input_schema, last_discovered_at\)/,
    );
    expect(upserts[0].sql).toMatch(/ON CONFLICT\(mcp_id, tool_name\) DO UPDATE SET/);
    expect(upserts[0].sql).toMatch(/description = excluded\.description/);
    expect(upserts[0].sql).toMatch(/input_schema = excluded\.input_schema/);
    expect(upserts[0].sql).toMatch(/last_discovered_at = excluded\.last_discovered_at/);

    const [mcpId, toolName, description, inputSchema, lastDiscoveredAt] = upserts[0].args;
    expect(mcpId).toBe('gmail');
    expect(toolName).toBe('send_email');
    expect(description).toBe('Envia um email');
    expect(inputSchema).toBe(JSON.stringify(schema));
    expect(lastDiscoveredAt).toMatch(ISO_RE);
  });

  it('re-discovery re-emite o UPSERT com a description/schema novos (DO UPDATE atualiza in place)', () => {
    saveMCPToolsToRegistry('gmail', [
      { name: 'send_email', description: 'v1', inputSchema: { type: 'object' } },
    ]);
    saveMCPToolsToRegistry('gmail', [
      { name: 'send_email', description: 'v2', inputSchema: { type: 'object', required: ['to'] } },
    ]);

    const upserts = stub.runs.filter((r) => r.sql.includes('INSERT INTO mcp_tool_registry'));
    expect(upserts).toHaveLength(2);
    expect(upserts[1].args[1]).toBe('send_email');
    expect(upserts[1].args[2]).toBe('v2');
    expect(upserts[1].args[3]).toBe(JSON.stringify({ type: 'object', required: ['to'] }));
  });

  it('poda tools que sumiram do server (DELETE ... NOT IN) sem apagar as que ficaram', () => {
    saveMCPToolsToRegistry('gmail', [
      { name: 'send_email', description: 'd' },
      { name: 'list_labels' },
    ]);

    const prunes = stub.runs.filter((r) => r.sql.includes('NOT IN'));
    expect(prunes).toHaveLength(1);
    expect(prunes[0].sql).toMatch(
      /DELETE FROM mcp_tool_registry WHERE mcp_id = \? AND tool_name NOT IN \(\?, \?\)/,
    );
    expect(prunes[0].args).toEqual(['gmail', 'send_email', 'list_labels']);
    const blindWipes = stub.runs.filter(
      (r) => r.sql === 'DELETE FROM mcp_tool_registry WHERE mcp_id = ?',
    );
    expect(blindWipes).toHaveLength(0);
  });

  it('shape antigo (string[]) segue aceito: colunas novas ficam NULL', () => {
    saveMCPToolsToRegistry('legacy', ['tool_a', 'tool_b']);

    const upserts = stub.runs.filter((r) => r.sql.includes('INSERT INTO mcp_tool_registry'));
    expect(upserts).toHaveLength(2);
    for (const call of upserts) {
      expect(call.args[0]).toBe('legacy');
      expect(call.args[2]).toBeNull(); // description
      expect(call.args[3]).toBeNull(); // input_schema
      expect(call.args[4]).toMatch(ISO_RE); // last_discovered_at sempre gravado
    }
  });

  it('lista vazia preserva a semantica antiga: apaga todas as linhas do server', () => {
    saveMCPToolsToRegistry('dead-server', []);

    expect(stub.runs).toHaveLength(1);
    expect(stub.runs[0].sql).toBe('DELETE FROM mcp_tool_registry WHERE mcp_id = ?');
    expect(stub.runs[0].args).toEqual(['dead-server']);
  });

  it('roda dentro de transaction (delete stale + upserts atomicos)', () => {
    saveMCPToolsToRegistry('gmail', [{ name: 'send_email' }]);
    expect(stub.db.transaction).toHaveBeenCalledTimes(1);
  });
});


describe('deleteMCPServer - prune do registry', () => {
  it('encadeia o DELETE do registry ANTES do DELETE do server', () => {
    deleteMCPServer('gmail');

    const sqls = stub.runs.map((r) => r.sql);
    const registryIdx = sqls.indexOf('DELETE FROM mcp_tool_registry WHERE mcp_id = ?');
    const serverIdx = sqls.indexOf('DELETE FROM mcp_servers WHERE id = ?');
    expect(registryIdx).toBeGreaterThan(-1);
    expect(serverIdx).toBeGreaterThan(-1);
    expect(registryIdx).toBeLessThan(serverIdx);
    expect(stub.runs[registryIdx].args).toEqual(['gmail']);
    expect(stub.runs[serverIdx].args).toEqual(['gmail']);
  });
});


const REGISTRY_ROWS = [
  {
    mcp_id: 'gmail',
    tool_name: 'send_email',
    description: 'Envia um email',
    input_schema: '{"type":"object"}',
    last_discovered_at: '2026-07-02T10:00:00.000Z',
  },
  {
    mcp_id: 'shopify',
    tool_name: 'list_orders',
    description: null,
    input_schema: null,
    last_discovered_at: null,
  },
];

describe('getMcpToolRegistryEntries - getter novo', () => {
  beforeEach(() => {
    stub = makeStubDb(() => REGISTRY_ROWS);
    state.stub = stub;
  });

  it('retorna as colunas completas mapeadas em camelCase', () => {
    const entries = getMcpToolRegistryEntries();

    expect(entries).toEqual([
      {
        mcpId: 'gmail',
        toolName: 'send_email',
        description: 'Envia um email',
        inputSchema: '{"type":"object"}',
        lastDiscoveredAt: '2026-07-02T10:00:00.000Z',
      },
      {
        mcpId: 'shopify',
        toolName: 'list_orders',
        description: null,
        inputSchema: null,
        lastDiscoveredAt: null,
      },
    ]);

    expect(stub.alls).toHaveLength(1);
    expect(stub.alls[0].sql).toContain(
      'SELECT mcp_id, tool_name, description, input_schema, last_discovered_at FROM mcp_tool_registry',
    );
    expect(stub.alls[0].sql).toContain('ORDER BY mcp_id, tool_name');
  });

  it('filtra por mcpId quando informado', () => {
    getMcpToolRegistryEntries('gmail');

    expect(stub.alls).toHaveLength(1);
    expect(stub.alls[0].sql).toContain('WHERE mcp_id = ?');
    expect(stub.alls[0].args).toEqual(['gmail']);
  });

  it('sem mcpId: sem WHERE (retorna o registry inteiro)', () => {
    getMcpToolRegistryEntries();

    expect(stub.alls[0].sql).not.toContain('WHERE');
    expect(stub.alls[0].args).toEqual([]);
  });
});


describe('getMCPToolsFromRegistry - formato preservado', () => {
  beforeEach(() => {
    stub = makeStubDb(() => REGISTRY_ROWS.map((r) => ({ mcp_id: r.mcp_id, tool_name: r.tool_name })));
    state.stub = stub;
  });

  it('segue retornando string[] no formato mcp__id__tool', () => {
    const tools = getMCPToolsFromRegistry(['gmail', 'shopify']);
    expect(tools).toEqual(['mcp__gmail__send_email', 'mcp__shopify__list_orders']);
  });

  it('lista vazia de servers => [] sem tocar o DB', () => {
    expect(getMCPToolsFromRegistry([])).toEqual([]);
    expect(stub.alls).toHaveLength(0);
  });
});
