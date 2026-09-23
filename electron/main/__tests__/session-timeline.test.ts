import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';

let memoryDb: Database.Database;

vi.mock('../db', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db')>();
  return {
    insertTimelineTurn: (input: Parameters<typeof real.insertTimelineTurn>[0]) =>
      real.insertTimelineTurn(input, memoryDb),
    insertTimelineEvent: (input: Parameters<typeof real.insertTimelineEvent>[0]) =>
      real.insertTimelineEvent(input, memoryDb),
    setTimelineTurnStatus: (runId: string, status: 'complete') => real.setTimelineTurnStatus(runId, status, memoryDb),
    setTimelineTurnMetrics: (runId: string, textTokensEst: number | null, toolTokensEst: number | null) =>
      real.setTimelineTurnMetrics(runId, textTokensEst, toolTokensEst, memoryDb),
    setTimelineTurnAssistantMessageId: (runId: string, messageId: number) =>
      real.setTimelineTurnAssistantMessageId(runId, messageId, memoryDb),
    getTimelineTurnsAfterFence: (sessionId: string, fence: number | null) =>
      real.getTimelineTurnsAfterFence(sessionId, fence, memoryDb),
  };
});

import { applyMigrationV155 } from '../db-migrations/v155-session-timeline';
import { beginTimelineTurn, computeTimelineMetrics, getTimelineRuns } from '../session-timeline';

const SESSION_ID = 'sess-timeline';

function asBetterSqlite(sqlite: DatabaseSync): Database.Database {
  return {
    exec: (sql: string) => sqlite.exec(sql),
    prepare: (sql: string) => sqlite.prepare(sql),
    pragma: (statement: string) => sqlite.prepare(`PRAGMA ${statement}`).all(),
    transaction: (fn: () => void) => () => {
      sqlite.exec('BEGIN');
      try {
        fn();
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as Database.Database;
}

function makeDb(): Database.Database {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE lion_session_summaries (
      session_id              TEXT    NOT NULL,
      summary_text            TEXT    NOT NULL,
      covers_until_message_id INTEGER NOT NULL,
      model_used              TEXT    NOT NULL,
      provider_used           TEXT    NOT NULL,
      input_tokens            INTEGER,
      output_tokens           INTEGER,
      created_at              INTEGER NOT NULL,
      PRIMARY KEY (session_id, covers_until_message_id)
    );
  `);
  sqlite.prepare('INSERT INTO sessions (id) VALUES (?)').run(SESSION_ID);
  const db = asBetterSqlite(sqlite);
  applyMigrationV155(db);
  return db;
}

function addMessage(db: Database.Database, role: 'user' | 'assistant', content: string): number {
  const result = db
    .prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)')
    .run(SESSION_ID, role, content);
  return Number(result.lastInsertRowid);
}

function turnRow(db: Database.Database, runId: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM session_timeline_turns WHERE run_id = ?').get(runId) as Record<string, unknown>;
}

beforeEach(() => {
  memoryDb = makeDb();
});

describe('migration V155', () => {
  it('cria as duas tabelas e recria lion_session_summaries com mode e selection_hash na PK', () => {
    const tables = (
      memoryDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toContain('session_timeline_turns');
    expect(tables).toContain('session_timeline_events');
    expect(tables).not.toContain('lion_session_summaries_v155');

    const columns = (
      memoryDb.pragma('table_info(lion_session_summaries)') as Array<{ name: string; pk: number }>
    ).filter((column) => column.pk > 0);
    expect(columns.map((column) => column.name).sort()).toEqual([
      'covers_until_message_id',
      'mode',
      'selection_hash',
      'session_id',
    ]);
  });

  it('copia os resumos legados como text/vazio e e idempotente', () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE lion_session_summaries (
        session_id              TEXT    NOT NULL,
        summary_text            TEXT    NOT NULL,
        covers_until_message_id INTEGER NOT NULL,
        model_used              TEXT    NOT NULL,
        provider_used           TEXT    NOT NULL,
        input_tokens            INTEGER,
        output_tokens           INTEGER,
        created_at              INTEGER NOT NULL,
        PRIMARY KEY (session_id, covers_until_message_id)
      );
      INSERT INTO sessions (id) VALUES ('s1');
      INSERT INTO lion_session_summaries
        (session_id, summary_text, covers_until_message_id, model_used, provider_used,
         input_tokens, output_tokens, created_at)
      VALUES ('s1', 'resumo legado', 7, 'qwen', 'ollama', 10, 5, 123);
    `);
    const db = asBetterSqlite(sqlite);

    applyMigrationV155(db);
    applyMigrationV155(db);

    const rows = sqlite
      .prepare(
        'SELECT session_id, covers_until_message_id, mode, selection_hash, summary_text FROM lion_session_summaries',
      )
      .all();
    expect(rows).toEqual([
      {
        session_id: 's1',
        covers_until_message_id: 7,
        mode: 'text',
        selection_hash: '',
        summary_text: 'resumo legado',
      },
    ]);
  });
});

describe('beginTimelineTurn', () => {
  it('grava o run como interrupted e um evento por chamada com seq crescente', () => {
    const anchor = addMessage(memoryDb, 'user', 'pergunta');
    const handle = beginTimelineTurn({
      sessionId: SESSION_ID,
      turnIndex: 3,
      anchorMessageId: anchor,
      currentUserMessageId: anchor,
      origin: 'turn',
      runtime: 'lion-sdk',
      fidelity: 'exact',
      cwd: 'C:/repo',
    });

    expect(handle.degraded).toBe(false);
    expect(handle.persistFailed).toBe(false);
    expect(turnRow(memoryDb, handle.runId)['status']).toBe('interrupted');

    handle.user('pergunta efetiva');
    handle.assistantStep({ content: '', toolCallsJson: '[{"id":"t1"}]', reasoningContent: 'pensando' });
    handle.toolCall({ toolUseId: 't1', toolName: 'Read', content: '{"file":"a.ts"}' });
    handle.toolCallArgs({ toolUseId: 't1', toolName: 'Read', content: '{"file":"a.ts","limit":10}' });
    handle.toolResult({ toolUseId: 't1', toolName: 'Read', content: 'erro', isError: true });
    handle.assistantFinal({ content: 'resposta', reasoningContent: null });

    const events = memoryDb
      .prepare(
        'SELECT seq, kind, is_error, original_bytes, spill_path FROM session_timeline_events WHERE run_id = ? ORDER BY seq',
      )
      .all(handle.runId) as Array<{
      seq: number;
      kind: string;
      is_error: number;
      original_bytes: number | null;
      spill_path: string | null;
    }>;
    expect(events.map((e) => [e.seq, e.kind])).toEqual([
      [0, 'user'],
      [1, 'assistant_step'],
      [2, 'tool_call'],
      [3, 'tool_call_args'],
      [4, 'tool_result'],
      [5, 'assistant_final'],
    ]);
    expect(events[4].is_error).toBe(1);
    expect(events[4].original_bytes).toBeNull();
    expect(events[4].spill_path).toBeNull();

    handle.metrics({ textTokensEst: 40, toolTokensEst: 90 });
    handle.assistantMessage(addMessage(memoryDb, 'assistant', 'resposta'));
    handle.complete();

    const row = turnRow(memoryDb, handle.runId);
    expect(row['status']).toBe('complete');
    expect(row['text_tokens_est']).toBe(40);
    expect(row['tool_tokens_est']).toBe(90);
    expect(row['assistant_message_id']).toBe(2);
    expect(row['origin']).toBe('turn');
    expect(row['cwd']).toBe('C:/repo');
  });

  it('runId novo a cada chamada', () => {
    const args = {
      sessionId: SESSION_ID,
      turnIndex: 0,
      anchorMessageId: null,
      currentUserMessageId: null,
      origin: 'system-event' as const,
      runtime: 'codex' as const,
      fidelity: 'observed' as const,
      cwd: null,
    };
    expect(beginTimelineTurn(args).runId).not.toBe(beginTimelineTurn(args).runId);
  });

  it('falha no begin devolve handle degradado e nenhum metodo grava', () => {
    memoryDb.exec('DROP TABLE session_timeline_turns');
    const handle = beginTimelineTurn({
      sessionId: SESSION_ID,
      turnIndex: 0,
      anchorMessageId: null,
      currentUserMessageId: null,
      origin: 'turn',
      runtime: 'lion-sdk',
      fidelity: 'exact',
      cwd: null,
    });

    expect(handle.degraded).toBe(true);
    expect(handle.persistFailed).toBe(true);
    expect(() => {
      handle.user('x');
      handle.toolResult({ toolUseId: null, toolName: 'Read', content: 'y', isError: false });
      handle.metrics({ textTokensEst: 1, toolTokensEst: 1 });
      handle.complete();
    }).not.toThrow();
    const events = memoryDb.prepare('SELECT COUNT(*) AS n FROM session_timeline_events').get() as { n: number };
    expect(events.n).toBe(0);
  });

  it('falha de INSERT posterior marca persistFailed e o run nunca vira complete', () => {
    const handle = beginTimelineTurn({
      sessionId: SESSION_ID,
      turnIndex: 1,
      anchorMessageId: null,
      currentUserMessageId: null,
      origin: 'retry',
      runtime: 'lion-sdk',
      fidelity: 'exact',
      cwd: null,
    });
    memoryDb.exec('DROP TABLE session_timeline_events');

    expect(() => handle.user('x')).not.toThrow();
    expect(handle.persistFailed).toBe(true);

    handle.complete();
    expect(turnRow(memoryDb, handle.runId)['status']).toBe('interrupted');
  });
});

describe('getTimelineRuns', () => {
  function startRun(
    anchorMessageId: number | null,
    runtime: 'lion-sdk' | 'codex' = 'lion-sdk',
  ): ReturnType<typeof beginTimelineTurn> {
    return beginTimelineTurn({
      sessionId: SESSION_ID,
      turnIndex: 0,
      anchorMessageId,
      currentUserMessageId: anchorMessageId,
      origin: 'turn',
      runtime,
      fidelity: runtime === 'lion-sdk' ? 'exact' : 'observed',
      cwd: null,
    });
  }

  it('aplica o fence, ignora anchor nulo e anchor purgado, e ordena por (anchor, seq_id)', () => {
    const m1 = addMessage(memoryDb, 'user', 'antes do fence');
    const m2 = addMessage(memoryDb, 'user', 'depois do fence');
    const purged = addMessage(memoryDb, 'user', 'sera purgada');

    startRun(m1);
    const first = startRun(m2);
    const second = startRun(m2);
    startRun(null);
    startRun(purged);
    memoryDb.prepare('DELETE FROM messages WHERE id = ?').run(purged);

    const runs = getTimelineRuns(SESSION_ID, m1);
    expect(runs.map((run) => run.runId)).toEqual([first.runId, second.runId]);
    expect(runs[0].anchorMessageId).toBe(m2);
    expect(runs[0].status).toBe('interrupted');
    expect(runs[0].fidelity).toBe('exact');

    const semFence = getTimelineRuns(SESSION_ID, null);
    expect(semFence).toHaveLength(3);
    expect(semFence[0].anchorMessageId).toBe(m1);
  });

  it('nao filtra status nem fidelidade e devolve eventos ordenados por seq com isError boolean', () => {
    const anchor = addMessage(memoryDb, 'user', 'pergunta');
    const cli = startRun(anchor, 'codex');
    cli.toolCall({ toolUseId: 'a', toolName: 'Bash', content: '{}' });
    cli.toolResult({ toolUseId: 'a', toolName: 'Bash', content: 'boom', isError: true, originalBytes: 4 });
    const completed = startRun(anchor);
    completed.user('oi');
    completed.complete();

    const runs = getTimelineRuns(SESSION_ID, null);
    expect(runs.map((run) => [run.status, run.fidelity])).toEqual([
      ['interrupted', 'observed'],
      ['complete', 'exact'],
    ]);
    expect(runs[0].events.map((event) => event.seq)).toEqual([0, 1]);
    expect(runs[0].events[1].isError).toBe(true);
    expect(runs[0].events[1].originalBytes).toBe(4);
    expect(runs[0].events[0].isError).toBe(false);
    expect(runs[1].events).toHaveLength(1);
  });
});

describe('computeTimelineMetrics', () => {
  const event = (
    partial: Partial<Parameters<typeof computeTimelineMetrics>[1][number]>,
  ): Parameters<typeof computeTimelineMetrics>[1][number] => ({
    kind: 'user',
    toolUseId: null,
    content: '',
    toolCallsJson: null,
    reasoningContent: null,
    ...partial,
  });

  it('lion-sdk soma texto (user, steps, final, reasoning) e tools (tool_calls_json, results)', () => {
    const metrics = computeTimelineMetrics('lion-sdk', [
      event({ kind: 'user', content: 'a'.repeat(8) }),
      event({
        kind: 'assistant_step',
        content: 'b'.repeat(4),
        toolCallsJson: 'c'.repeat(16),
        reasoningContent: 'd'.repeat(12),
      }),
      event({ kind: 'tool_result', toolUseId: 't1', content: 'e'.repeat(40) }),
      event({ kind: 'assistant_final', content: 'f'.repeat(4), reasoningContent: 'g'.repeat(4) }),
    ]);
    expect(metrics).toEqual({ textTokensEst: 2 + 1 + 3 + 1 + 1, toolTokensEst: 4 + 10 });
  });

  it('CLI: text null e args do mesmo tool_use_id contam uma vez (args tardio vence)', () => {
    const metrics = computeTimelineMetrics('codex', [
      event({ kind: 'tool_call', toolUseId: 't1', content: 'a'.repeat(8) }),
      event({ kind: 'tool_call_args', toolUseId: 't1', content: 'b'.repeat(40) }),
      event({ kind: 'tool_result', toolUseId: 't1', content: 'c'.repeat(4) }),
      event({ kind: 'tool_call', toolUseId: 't2', content: 'd'.repeat(20) }),
    ]);
    expect(metrics).toEqual({ textTokensEst: null, toolTokensEst: 10 + 1 + 5 });
  });

  it('CLI: tool_use_id null nunca casa com outro evento', () => {
    const metrics = computeTimelineMetrics('kimi', [
      event({ kind: 'tool_call', toolUseId: null, content: 'a'.repeat(12) }),
      event({ kind: 'tool_call', toolUseId: null, content: 'b'.repeat(8) }),
      event({ kind: 'tool_result', toolUseId: null, content: 'c'.repeat(4) }),
    ]);
    expect(metrics).toEqual({ textTokensEst: null, toolTokensEst: 3 + 2 + 1 });
  });
});
