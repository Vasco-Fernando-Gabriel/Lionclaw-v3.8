
import Database from 'better-sqlite3';
import { describe, it, expect, vi, beforeEach } from 'vitest';


let testDb: Database.Database;

vi.mock('../db', () => ({
  getDb: () => testDb,
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


import { getMCPConfigForAgent } from '../mcp-manager';


function buildFixtureDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      command TEXT NOT NULL,
      args TEXT DEFAULT '[]',
      env_keys TEXT DEFAULT '[]',
      is_active INTEGER DEFAULT 1,
      visible_to TEXT NOT NULL DEFAULT 'all'
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      mcp_servers TEXT DEFAULT '[]'
    );
  `);

  const insertServer = db.prepare(
    'INSERT INTO mcp_servers (id, name, command, args, env_keys, is_active, visible_to) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insertServer.run('server-all-1', 'AllOne', 'node', '["/path/all-one.js"]', '[]', 1, 'all');
  insertServer.run('server-all-2', 'AllTwo', 'node', '["/path/all-two.js"]', '[]', 1, 'all');

  insertServer.run('helper-codex-1', 'HelperOne', 'node', '["/path/helper-one.js"]', '[]', 1, 'codex-lion-only');
  insertServer.run('helper-codex-2', 'HelperTwo', 'node', '["/path/helper-two.js"]', '[]', 1, 'codex-lion-only');

  return db;
}


describe('mcp-manager visibility (SPEC-001 SP-3.2 / SP-3.3)', () => {
  beforeEach(() => {
    testDb?.close();
    testDb = buildFixtureDb();
  });


  it('default path (sem opts) retorna apenas servers visible_to=all', async () => {
    const config = await getMCPConfigForAgent(/* no agentId */);
    expect(config).toBeDefined();
    const ids = Object.keys(config!).sort();
    expect(ids).toEqual(['server-all-1', 'server-all-2']);
    expect(ids).not.toContain('helper-codex-1');
    expect(ids).not.toContain('helper-codex-2');
  });

  it('default path (opts={} sem surface) retorna apenas visible_to=all', async () => {
    const config = await getMCPConfigForAgent(undefined, {});
    expect(config).toBeDefined();
    const ids = Object.keys(config!).sort();
    expect(ids).toEqual(['server-all-1', 'server-all-2']);
  });


  it('surface=claude-sdk retorna mesmo conjunto que default (apenas all)', async () => {
    const config = await getMCPConfigForAgent(undefined, { surface: 'claude-sdk' });
    expect(config).toBeDefined();
    const ids = Object.keys(config!).sort();
    expect(ids).toEqual(['server-all-1', 'server-all-2']);
  });

  it('surface=claude-compat-sdk retorna mesmo conjunto que default (apenas all)', async () => {
    const config = await getMCPConfigForAgent(undefined, { surface: 'claude-compat-sdk' });
    expect(config).toBeDefined();
    const ids = Object.keys(config!).sort();
    expect(ids).toEqual(['server-all-1', 'server-all-2']);
  });


  it('surface=codex-sdk inclui helpers visible_to=codex-lion-only', async () => {
    const config = await getMCPConfigForAgent(undefined, { surface: 'codex-sdk' });
    expect(config).toBeDefined();
    const ids = Object.keys(config!).sort();
    expect(ids).toEqual([
      'helper-codex-1',
      'helper-codex-2',
      'server-all-1',
      'server-all-2',
    ]);
  });

  it('surface=lion-sdk inclui helpers visible_to=codex-lion-only', async () => {
    const config = await getMCPConfigForAgent(undefined, { surface: 'lion-sdk' });
    expect(config).toBeDefined();
    const ids = Object.keys(config!).sort();
    expect(ids).toEqual([
      'helper-codex-1',
      'helper-codex-2',
      'server-all-1',
      'server-all-2',
    ]);
  });


  it('snapshot bit-identico: sem helpers no DB, default path retorna o mesmo conjunto', async () => {
    const withHelpers = await getMCPConfigForAgent();

    testDb.prepare("DELETE FROM mcp_servers WHERE visible_to = 'codex-lion-only'").run();
    const withoutHelpers = await getMCPConfigForAgent();

    expect(withoutHelpers).toEqual(withHelpers);
  });
});
