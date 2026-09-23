import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationV153 } from '../db-migrations/v153-swarm';
import { SWARM_SEED_AGENTS, ALL_SEED_AGENTS } from '../seed-agents';
import {
  upsertSwarmRunIndex,
  listSwarmRunIndex,
  enqueueSwarmDelivery,
  claimSwarmDelivery,
  releaseSwarmDelivery,
  completeSwarmDelivery,
  recoverSwarmDeliveryClaims,
  getPendingSwarmDeliveries,
  getSwarmDelivery,
  persistSwarmChatMessageOnce,
  getChatFeatureToggles,
  setChatFeatureToggles,
} from '../db';
import type { SwarmRunSummary } from '../../../src/types/swarm';

function fixture() {
  const sqlite = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  let seq = 0;
  const db = {
    prepare: sqlite.prepare.bind(sqlite),
    exec: sqlite.exec.bind(sqlite),
    transaction:
      <T>(fn: () => T) =>
      () => {
        const savepoint = `test_tx_${++seq}`;
        sqlite.exec(`SAVEPOINT ${savepoint}`);
        try {
          const result = fn();
          sqlite.exec(`RELEASE ${savepoint}`);
          return result;
        } catch (error) {
          sqlite.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
          throw error;
        }
      },
  } as unknown as Database.Database;
  db.exec(`
    CREATE TABLE sessions(id TEXT PRIMARY KEY, type TEXT DEFAULT 'chat',status TEXT DEFAULT 'active',updated_at TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,role TEXT CHECK(role IN ('user','assistant','system')),content TEXT,metadata TEXT);
    CREATE TABLE chat_session_features(session_id TEXT PRIMARY KEY REFERENCES sessions(id),pipeline_control_enabled INTEGER DEFAULT 0,dynamic_workflows_enabled INTEGER DEFAULT 0,updated_at TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,description TEXT,system_prompt TEXT,model TEXT,allowed_tools TEXT,mcp_servers TEXT,is_active INTEGER,sort_order INTEGER,effort TEXT,thinking TEXT,thinking_budget INTEGER,max_turns INTEGER,skills TEXT,runtime TEXT,max_tool_rounds INTEGER,squad TEXT,codex_config TEXT);
    INSERT INTO sessions(id) VALUES ('s1'),('s2');
    INSERT INTO chat_session_features(session_id) VALUES ('s1');
  `);
  applyMigrationV153(db);
  return { db, sqlite };
}
const summary = (runId: string, revision: number, chatSessionId = 's1'): SwarmRunSummary => ({
  runId,
  revision,
  chatSessionId,
  mode: 'comite',
  status: 'running',
  itemCount: 2,
  createdAt: '2026-09-13T00:00:00Z',
  finishedAt: null,
  costUsd: null,
});

describe('Swarm migration, projection and delivery', () => {
  it('seeds all eleven independent profiles with full contracts, preserving customizations and defaults on replay', () => {
    const { db, sqlite } = fixture();
    try {
      expect(SWARM_SEED_AGENTS).toHaveLength(11);
      for (const seed of SWARM_SEED_AGENTS) {
        expect(ALL_SEED_AGENTS.filter((agent) => agent.id === seed.id)).toHaveLength(1);
        const row = db.prepare('SELECT * FROM agents WHERE id=?').get(seed.id) as Record<string, unknown>;
        expect(row.system_prompt).toBe(seed.systemPrompt);
        expect(row.squad).toBe('swarm');
        expect(row.model).toBe(seed.model);
        expect(seed.systemPrompt).toContain('{{FINDINGS_PATH}}');
      }
      db.prepare('UPDATE agents SET system_prompt=?,model=?,squad=? WHERE id=?').run(
        'custom',
        'custom-model',
        'quality',
        SWARM_SEED_AGENTS[0].id,
      );
      db.prepare("UPDATE settings SET value='3' WHERE key='swarm_concurrency_cap'").run();
      applyMigrationV153(db);
      expect(
        db.prepare('SELECT system_prompt,model,squad FROM agents WHERE id=?').get(SWARM_SEED_AGENTS[0].id),
      ).toEqual({ system_prompt: 'custom', model: 'custom-model', squad: 'quality' });
      expect(db.prepare("SELECT value FROM settings WHERE key='swarm_concurrency_cap'").get()).toEqual({ value: '3' });
      expect(getChatFeatureToggles('s1', db)?.swarm).toBe(false);
      expect(setChatFeatureToggles('s1', { swarm: true }, db)).toEqual({
        ok: true,
        toggles: { pipelineControl: false, dynamicWorkflows: false, swarm: true },
      });
      expect(setChatFeatureToggles('s1', { pipelineControl: true }, db)).toEqual({
        ok: true,
        toggles: { pipelineControl: true, dynamicWorkflows: false, swarm: true },
      });
    } finally {
      sqlite.close();
    }
  });
  it('rejects stale revisions and paginates equal timestamps without crossing sessions', () => {
    const { db, sqlite } = fixture();
    try {
      upsertSwarmRunIndex(summary('a', 2), db);
      upsertSwarmRunIndex(summary('a', 1), db);
      upsertSwarmRunIndex(summary('b', 1), db);
      upsertSwarmRunIndex(summary('c', 1, 's2'), db);
      expect(listSwarmRunIndex('s1', undefined, 1, db)).toEqual({ runs: [summary('b', 1)], nextCursor: 'b' });
      expect(listSwarmRunIndex('s1', 'b', 1, db)).toEqual({ runs: [summary('a', 2)], nextCursor: null });
      expect(() => listSwarmRunIndex('s1', 'c', 20, db)).toThrow('Cursor');
    } finally {
      sqlite.close();
    }
  });
  it('claims once, fences stale workers and commits final response with delivery atomically', () => {
    const { db, sqlite } = fixture();
    try {
      enqueueSwarmDelivery('run', 5, 's1', 'envelope', 'done', db);
      enqueueSwarmDelivery('run', 5, 's1', 'envelope', 'done', db);
      expect(() => enqueueSwarmDelivery('run', 5, 's2', 'envelope', 'done', db)).toThrow('Conflito');
      expect(getPendingSwarmDeliveries(db)).toHaveLength(1);
      expect(claimSwarmDelivery('run', 5, 'owner1', db)?.state).toBe('claimed');
      expect(claimSwarmDelivery('run', 5, 'owner2', db)).toBeUndefined();
      expect(() => completeSwarmDelivery('run', 5, 'owner1', 'delivered', undefined, db)).toThrow('sem mensagem');
      const event = {
        sessionId: 's1',
        runId: 'run',
        terminalRevision: 5,
        kind: 'event' as const,
        content: 'envelope',
        claimId: 'owner1',
      };
      const first = persistSwarmChatMessageOnce(event, db);
      expect(persistSwarmChatMessageOnce(event, db)).toEqual({ ...first, inserted: false });
      expect(getSwarmDelivery('run', 5, db)?.state).toBe('claimed');
      expect(recoverSwarmDeliveryClaims(db)).toBe(1);
      claimSwarmDelivery('run', 5, 'owner2', db);
      expect(() => persistSwarmChatMessageOnce({ ...event, kind: 'response', content: 'late' }, db)).toThrow('Claim');
      expect(releaseSwarmDelivery('run', 5, 'owner1', undefined, db)).toBe(false);
      persistSwarmChatMessageOnce({ ...event, kind: 'response', content: 'final', claimId: 'owner2' }, db);
      expect(getSwarmDelivery('run', 5, db)?.state).toBe('delivered');
      expect(
        persistSwarmChatMessageOnce({ ...event, kind: 'response', content: 'repeat', claimId: 'owner2' }, db).inserted,
      ).toBe(false);
      expect(db.prepare('SELECT role,content FROM messages ORDER BY id').all()).toEqual([
        { role: 'system', content: 'envelope' },
        { role: 'assistant', content: 'final' },
      ]);
    } finally {
      sqlite.close();
    }
  });
  it('aborted event is final without an LLM, and removed session keeps undeliverable evidence', () => {
    const { db, sqlite } = fixture();
    try {
      enqueueSwarmDelivery('abort', 2, 's1', 'cancelado', 'aborted', db);
      claimSwarmDelivery('abort', 2, 'owner', db);
      persistSwarmChatMessageOnce(
        { sessionId: 's1', runId: 'abort', terminalRevision: 2, kind: 'event', content: 'cancelado', claimId: 'owner' },
        db,
      );
      expect(getSwarmDelivery('abort', 2, db)?.state).toBe('delivered');
      enqueueSwarmDelivery('removed', 2, 's2', 'resultado', 'done', db);
      claimSwarmDelivery('removed', 2, 'owner', db);
      db.prepare("DELETE FROM sessions WHERE id='s2'").run();
      expect(() =>
        persistSwarmChatMessageOnce(
          {
            sessionId: 's2',
            runId: 'removed',
            terminalRevision: 2,
            kind: 'event',
            content: 'resultado',
            claimId: 'owner',
          },
          db,
        ),
      ).toThrow('removida');
      expect(completeSwarmDelivery('removed', 2, 'owner', 'undeliverable', 'Sessão removida', db)).toBe(true);
      expect(getSwarmDelivery('removed', 2, db)?.envelope).toBe('resultado');
    } finally {
      sqlite.close();
    }
  });
});
