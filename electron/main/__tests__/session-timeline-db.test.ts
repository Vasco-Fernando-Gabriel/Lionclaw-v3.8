import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const TEST_HOME = vi.hoisted(() => {
  const base = (process.env['RUNNER_TEMP'] ?? process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp').replace(
    /[\\/]+$/,
    '',
  );
  const home = `${base}/lionclaw-timeline-db-${process.pid}-${Date.now()}`;
  process.env['NODE_ENV'] = 'test';
  process.env['LIONCLAW_TEST_HOME'] = home;
  return home;
});

const loggerMock = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
}));

vi.mock('../logger', () => ({
  createLogger: () => loggerMock,
  getSystemLogFilePath: () => '',
  rotateLogFileIfNeededForBoot: () => false,
  rotateLogFileInSessionIfNeeded: async () => {},
  errorSerializers: {},
  rootLogger: loggerMock,
}));

let memoryDb: Database.Database;
let sqlFailure: Error | null = null;
const deleteCalls: string[][] = [];

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
    deleteSessionsByIds: (ids: string[]) => {
      deleteCalls.push([...ids]);
      if (sqlFailure !== null) throw sqlFailure;
      real.deleteSessionsByIds(ids, memoryDb);
    },
  };
});

import { applyMigrationV155 } from '../db-migrations/v155-session-timeline';
import {
  __timelineInternals,
  beginTimelineTurn,
  deleteSessionsWithTimeline,
  getTimelineRuns,
  selectExactCompleteRun,
  selectLatestRun,
  writeSpillFile,
} from '../session-timeline';

const SESSION_ID = 'sess-a';

const LEGACY_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE sessions (
    id   TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'chat'
  );
  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    PRIMARY KEY (session_id, covers_until_message_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
`;

function makeDb(): Database.Database {
  const database = new Database(':memory:');
  database.exec(LEGACY_SCHEMA);
  applyMigrationV155(database);
  database.pragma('foreign_keys = ON');
  return database;
}

function addSession(id: string): void {
  memoryDb.prepare('INSERT INTO sessions (id, type) VALUES (?, ?)').run(id, 'scheduled');
}

function addMessage(sessionId: string, role: 'user' | 'assistant', content: string, createdAt?: string): number {
  const result = memoryDb
    .prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, role, content, createdAt ?? '2026-01-01 10:00:00');
  return Number(result.lastInsertRowid);
}

function turnRow(runId: string): Record<string, unknown> {
  return memoryDb.prepare('SELECT * FROM session_timeline_turns WHERE run_id = ?').get(runId) as Record<
    string,
    unknown
  >;
}

function countRows(table: string, sessionId: string): number {
  const row = memoryDb.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId) as {
    n: number;
  };
  return row.n;
}

function sessionDir(sessionId: string): string {
  return path.join(path.resolve(TEST_HOME), 'data', 'sessions', sessionId);
}

function spillDir(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'tool-results');
}

function listSpillFiles(sessionId: string): string[] {
  const dir = spillDir(sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

function startRun(sessionId: string, anchorMessageId: number | null): ReturnType<typeof beginTimelineTurn> {
  return beginTimelineTurn({
    sessionId,
    turnIndex: 0,
    anchorMessageId,
    currentUserMessageId: anchorMessageId,
    origin: 'turn',
    runtime: 'lion-sdk',
    fidelity: 'exact',
    cwd: null,
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  memoryDb = makeDb();
  sqlFailure = null;
  deleteCalls.length = 0;
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
  __timelineInternals.closedSessions.clear();
  __timelineInternals.deletedSessions.clear();
  __timelineInternals.inFlightSpills.clear();
  fs.rmSync(path.resolve(TEST_HOME), { recursive: true, force: true });
  addSession(SESSION_ID);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  memoryDb.close();
  fs.rmSync(path.resolve(TEST_HOME), { recursive: true, force: true });
});

describe('migration V155 (T-25, T-36)', () => {
  it('T-25: preserva resumos legados como text/vazio, monta a PK quadrupla e mantem a FK para sessions', () => {
    const database = new Database(':memory:');
    database.exec(LEGACY_SCHEMA);
    database.exec(`
      INSERT INTO sessions (id, type) VALUES ('s1', 'chat');
      INSERT INTO lion_session_summaries
        (session_id, summary_text, covers_until_message_id, model_used, provider_used,
         input_tokens, output_tokens, created_at)
      VALUES ('s1', 'resumo legado', 7, 'qwen', 'ollama', 10, 5, 123);
    `);

    applyMigrationV155(database);

    const pk = (database.pragma('table_info(lion_session_summaries)') as Array<{ name: string; pk: number }>)
      .filter((column) => column.pk > 0)
      .map((column) => column.name)
      .sort();
    expect(pk).toEqual(['covers_until_message_id', 'mode', 'selection_hash', 'session_id']);

    expect(
      database
        .prepare(
          'SELECT session_id, covers_until_message_id, mode, selection_hash, summary_text, model_used FROM lion_session_summaries',
        )
        .all(),
    ).toEqual([
      {
        session_id: 's1',
        covers_until_message_id: 7,
        mode: 'text',
        selection_hash: '',
        summary_text: 'resumo legado',
        model_used: 'qwen',
      },
    ]);

    const fks = database.pragma('foreign_key_list(lion_session_summaries)') as Array<{
      table: string;
      from: string;
    }>;
    expect(fks).toEqual([expect.objectContaining({ table: 'sessions', from: 'session_id' })]);
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    database.close();
  });

  it('T-36: legado com mode text convive com dois resumos tools de hashes diferentes na mesma fronteira', () => {
    memoryDb.exec(`
      INSERT INTO lion_session_summaries
        (session_id, covers_until_message_id, mode, selection_hash, summary_text, model_used,
         provider_used, input_tokens, output_tokens, created_at)
      VALUES
        ('sess-a', 12, 'text',  '',      'legado',   'qwen', 'ollama', 1, 1, 1),
        ('sess-a', 12, 'tools', 'hash-a', 'com tools A', 'qwen', 'ollama', 1, 1, 2),
        ('sess-a', 12, 'tools', 'hash-b', 'com tools B', 'qwen', 'ollama', 1, 1, 3);
    `);

    const rows = memoryDb
      .prepare(
        'SELECT mode, selection_hash FROM lion_session_summaries WHERE covers_until_message_id = 12 ORDER BY created_at',
      )
      .all();
    expect(rows).toEqual([
      { mode: 'text', selection_hash: '' },
      { mode: 'tools', selection_hash: 'hash-a' },
      { mode: 'tools', selection_hash: 'hash-b' },
    ]);

    expect(() =>
      memoryDb
        .prepare(
          `INSERT INTO lion_session_summaries
             (session_id, covers_until_message_id, mode, selection_hash, summary_text, model_used,
              provider_used, input_tokens, output_tokens, created_at)
           VALUES ('sess-a', 12, 'tools', 'hash-a', 'duplicado', 'qwen', 'ollama', 1, 1, 4)`,
        )
        .run(),
    ).toThrow(/UNIQUE|PRIMARY/i);
  });
});

describe('handle degradado e falhas de persistencia (T-14, T-14b)', () => {
  it('T-14: falha de INSERT no tool_result do meio e no assistant_final marca persistFailed e complete() recusa', () => {
    const anchor = addMessage(SESSION_ID, 'user', 'pergunta');
    const handle = startRun(SESSION_ID, anchor);
    memoryDb.exec(`
      CREATE TRIGGER fail_events BEFORE INSERT ON session_timeline_events
      WHEN NEW.tool_use_id = 'boom' OR NEW.kind = 'assistant_final'
      BEGIN SELECT RAISE(ABORT, 'insert falhou'); END;
    `);

    handle.assistantStep({ content: '', toolCallsJson: '[]', reasoningContent: null });
    handle.toolResult({ toolUseId: 'ok-1', toolName: 'Read', content: 'a', isError: false });
    expect(handle.persistFailed).toBe(false);

    handle.toolResult({ toolUseId: 'boom', toolName: 'Bash', content: 'b', isError: false });
    expect(handle.persistFailed).toBe(true);
    handle.toolResult({ toolUseId: 'ok-2', toolName: 'Read', content: 'c', isError: false });
    handle.assistantFinal({ content: 'resposta', reasoningContent: null });

    handle.complete();
    expect(turnRow(handle.runId)['status']).toBe('interrupted');

    const kinds = (
      memoryDb
        .prepare('SELECT kind, tool_use_id FROM session_timeline_events WHERE run_id = ? ORDER BY seq')
        .all(handle.runId) as Array<{ kind: string; tool_use_id: string | null }>
    ).map((row) => `${row.kind}:${row.tool_use_id ?? '-'}`);
    expect(kinds).toEqual(['assistant_step:-', 'tool_result:ok-1', 'tool_result:ok-2']);

    const runs = getTimelineRuns(SESSION_ID, null);
    expect(selectExactCompleteRun(runs)).toBeNull();
    expect(selectLatestRun(runs)?.runId).toBe(handle.runId);
  });

  it('T-14: falha de UPDATE em metrics() e em complete() deixa o run interrupted', () => {
    const anchor = addMessage(SESSION_ID, 'user', 'pergunta');
    const handle = startRun(SESSION_ID, anchor);
    memoryDb.exec(`
      CREATE TRIGGER fail_turn_update BEFORE UPDATE ON session_timeline_turns
      BEGIN SELECT RAISE(ABORT, 'update falhou'); END;
    `);

    expect(() => handle.metrics({ textTokensEst: 10, toolTokensEst: 20 })).not.toThrow();
    expect(handle.persistFailed).toBe(true);

    expect(() => handle.complete()).not.toThrow();
    const row = turnRow(handle.runId);
    expect(row['status']).toBe('interrupted');
    expect(row['text_tokens_est']).toBeNull();
    expect(selectExactCompleteRun(getTimelineRuns(SESSION_ID, null))).toBeNull();
  });

  it('T-14b: falha de INSERT em beginTimelineTurn devolve handle degradado, um unico logger.error e nenhuma linha', () => {
    memoryDb.exec(`
      CREATE TRIGGER fail_turn_insert BEFORE INSERT ON session_timeline_turns
      BEGIN SELECT RAISE(ABORT, 'insert de turn falhou'); END;
    `);

    const handle = startRun(SESSION_ID, null);
    expect(handle.degraded).toBe(true);
    expect(handle.persistFailed).toBe(true);
    expect(loggerMock.error).toHaveBeenCalledTimes(1);

    expect(() => {
      handle.user('x');
      handle.assistantStep({ content: 'y', toolCallsJson: '[]', reasoningContent: null });
      handle.toolCall({ toolUseId: 't1', toolName: 'Read', content: '{}' });
      handle.toolResult({ toolUseId: 't1', toolName: 'Read', content: 'z', isError: false });
      handle.assistantFinal({ content: 'w', reasoningContent: null });
      handle.metrics({ textTokensEst: 1, toolTokensEst: 1 });
      handle.assistantMessage(1);
      handle.complete();
    }).not.toThrow();

    expect((memoryDb.prepare('SELECT COUNT(*) AS n FROM session_timeline_turns').get() as { n: number }).n).toBe(0);
    expect((memoryDb.prepare('SELECT COUNT(*) AS n FROM session_timeline_events').get() as { n: number }).n).toBe(0);
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
  });
});

describe('selecao por seq_id e purga do anchor (T-16, T-26, T-35)', () => {
  function insertTurnRow(runId: string, anchor: number, status: 'interrupted' | 'complete'): void {
    memoryDb
      .prepare(
        `INSERT INTO session_timeline_turns
           (run_id, session_id, turn_index, anchor_message_id, current_user_message_id,
            origin, runtime, fidelity, status, cwd, created_at)
         VALUES (?, ?, 0, ?, ?, 'turn', 'lion-sdk', 'exact', ?, NULL, '2026-01-01 10:00:00')`,
      )
      .run(runId, SESSION_ID, anchor, anchor, status);
  }

  it('T-16: com created_at igual e UUIDs em ordem lexica invertida, a selecao usa o maior seq_id', () => {
    const anchor = addMessage(SESSION_ID, 'user', 'pergunta');
    insertTurnRow('zzzzzzzz-0000-4000-8000-000000000000', anchor, 'complete');
    insertTurnRow('aaaaaaaa-0000-4000-8000-000000000000', anchor, 'complete');

    const runs = getTimelineRuns(SESSION_ID, null);
    expect(runs.map((run) => run.runId)).toEqual([
      'zzzzzzzz-0000-4000-8000-000000000000',
      'aaaaaaaa-0000-4000-8000-000000000000',
    ]);
    expect(runs[0].createdAt).toBe(runs[1].createdAt);
    expect(runs[0].seqId).toBeLessThan(runs[1].seqId);

    expect(selectExactCompleteRun(runs)?.runId).toBe('aaaaaaaa-0000-4000-8000-000000000000');
    expect(selectLatestRun(runs)?.runId).toBe('aaaaaaaa-0000-4000-8000-000000000000');
  });

  it('T-16: run com skipUserPersistence (anchor NULL) e gravado e ignorado pelo leitor', () => {
    const handle = startRun(SESSION_ID, null);
    handle.complete();

    expect(turnRow(handle.runId)['anchor_message_id']).toBeNull();
    expect(turnRow(handle.runId)['current_user_message_id']).toBeNull();
    expect(getTimelineRuns(SESSION_ID, null)).toEqual([]);
  });

  it('T-26: restart simulado deixa o run interrupted com os eventos gravados e ignora o .tmp orfao', async () => {
    const anchor = addMessage(SESSION_ID, 'user', 'pergunta');
    const handle = startRun(SESSION_ID, anchor);
    handle.user('pergunta');
    handle.assistantStep({ content: '', toolCallsJson: '[{"id":"t1"}]', reasoningContent: null });
    handle.toolCall({ toolUseId: 't1', toolName: 'Bash', content: '{"command":"npm test"}' });

    await fs.promises.mkdir(spillDir(SESSION_ID), { recursive: true });
    await fs.promises.writeFile(path.join(spillDir(SESSION_ID), 'orfao.txt.tmp'), 'parcial');

    const runs = getTimelineRuns(SESSION_ID, null);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('interrupted');
    expect(runs[0].events.map((event) => event.kind)).toEqual(['user', 'assistant_step', 'tool_call']);
    expect(runs[0].events.every((event) => event.spillPath === null)).toBe(true);
    expect(selectExactCompleteRun(runs)).toBeNull();
    expect(selectLatestRun(runs)?.runId).toBe(handle.runId);
    expect(listSpillFiles(SESSION_ID)).toEqual(['orfao.txt.tmp']);
  });

  it('T-35: purga do user remove o run do leitor mas preserva run, eventos e spill', async () => {
    const anchor = addMessage(SESSION_ID, 'user', 'sera purgada');
    const handle = startRun(SESSION_ID, anchor);
    handle.toolResult({ toolUseId: 't1', toolName: 'Bash', content: 'saida', isError: false });
    handle.complete();

    const spill = await writeSpillFile(SESSION_ID, 'conteudo do spill');
    expect(spill).not.toBeNull();

    memoryDb.prepare('DELETE FROM messages WHERE id = ?').run(anchor);

    expect(getTimelineRuns(SESSION_ID, null)).toEqual([]);
    expect(countRows('session_timeline_turns', SESSION_ID)).toBe(1);
    expect(countRows('session_timeline_events', SESSION_ID)).toBe(1);
    expect(fs.existsSync(spill as string)).toBe(true);
  });
});

describe('deleteSessionsWithTimeline (T-13)', () => {
  it('T-13: cascade nas tabelas, pasta apagada e ids liberados quando nao ha escritor', async () => {
    const anchor = addMessage(SESSION_ID, 'user', 'pergunta');
    const handle = startRun(SESSION_ID, anchor);
    handle.toolResult({ toolUseId: 't1', toolName: 'Bash', content: 'saida', isError: false });
    handle.complete();
    await writeSpillFile(SESSION_ID, 'conteudo');
    expect(fs.existsSync(sessionDir(SESSION_ID))).toBe(true);

    await deleteSessionsWithTimeline([SESSION_ID]);

    expect(deleteCalls).toEqual([[SESSION_ID]]);
    expect(countRows('session_timeline_turns', SESSION_ID)).toBe(0);
    expect(countRows('session_timeline_events', SESSION_ID)).toBe(0);
    expect(countRows('messages', SESSION_ID)).toBe(0);
    expect(memoryDb.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(SESSION_ID)).toEqual({ n: 0 });
    expect(fs.existsSync(sessionDir(SESSION_ID))).toBe(false);
    expect(__timelineInternals.closedSessions.has(SESSION_ID)).toBe(false);
    expect(__timelineInternals.deletedSessions.has(SESSION_ID)).toBe(false);
  });

  it('T-13: delete disparado entre a checagem inicial e o rename faz o spill devolver null com o .tmp removido', async () => {
    sqlFailure = new Error('SQL indisponivel');

    const realWriteFile = fs.promises.writeFile.bind(fs.promises);
    let tmpWritten: string | null = null;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      await realWriteFile(file as string, data as string, options as never);
      tmpWritten = file as string;
    });
    const renameSpy = vi.spyOn(fs.promises, 'rename');
    const realRm = fs.promises.rm.bind(fs.promises);
    const removed: string[] = [];
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      removed.push(target as string);
      return realRm(target as string, options as never);
    });

    const spill = writeSpillFile(SESSION_ID, 'conteudo grande');
    const operation = deleteSessionsWithTimeline([SESSION_ID]);

    await expect(operation).rejects.toThrow('SQL indisponivel');
    await expect(spill).resolves.toBeNull();

    expect(tmpWritten).toMatch(/\.txt\.tmp$/);
    expect(fs.existsSync(tmpWritten as unknown as string)).toBe(false);
    expect(removed).toEqual([tmpWritten]);
    expect(renameSpy).not.toHaveBeenCalled();
    expect(listSpillFiles(SESSION_ID)).toEqual([]);
    expect(fs.existsSync(spillDir(SESSION_ID))).toBe(true);
    expect(__timelineInternals.closedSessions.has(SESSION_ID)).toBe(true);
    expect(__timelineInternals.deletedSessions.has(SESSION_ID)).toBe(false);
    expect(loggerMock.error).toHaveBeenCalled();
  });

  it('T-13: falha de SQL mantem ids fechados, pasta intocada e propaga o erro ao caller', async () => {
    const anchor = addMessage(SESSION_ID, 'user', 'pergunta');
    startRun(SESSION_ID, anchor);
    const spill = await writeSpillFile(SESSION_ID, 'conteudo');
    sqlFailure = new Error('disco cheio');

    await expect(deleteSessionsWithTimeline([SESSION_ID])).rejects.toThrow('disco cheio');

    expect(fs.existsSync(spill as string)).toBe(true);
    expect(countRows('session_timeline_turns', SESSION_ID)).toBe(1);
    expect(__timelineInternals.closedSessions.has(SESSION_ID)).toBe(true);
    expect(__timelineInternals.deletedSessions.has(SESSION_ID)).toBe(false);
    await expect(writeSpillFile(SESSION_ID, 'novo')).resolves.toBeNull();
  });

  it('T-13: segura o SQL ate um escritor terminar; pasta intacta e sessao fechada antes do DELETE; sessao criada durante a espera sobrevive', async () => {
    const other = 'sess-nova';
    const anchor = addMessage(SESSION_ID, 'user', 'pergunta');
    startRun(SESSION_ID, anchor);
    const spill = await writeSpillFile(SESSION_ID, 'conteudo');

    const gate = createDeferred<void>();
    const writers = new Set<Promise<unknown>>([gate.promise]);
    __timelineInternals.inFlightSpills.set(SESSION_ID, writers);

    const operation = deleteSessionsWithTimeline([SESSION_ID]);
    await Promise.resolve();

    expect(deleteCalls).toEqual([]);
    expect(fs.existsSync(spill as string)).toBe(true);
    expect(__timelineInternals.closedSessions.has(SESSION_ID)).toBe(true);

    addSession(other);
    const otherAnchor = addMessage(other, 'user', 'nova pergunta');
    const otherHandle = startRun(other, otherAnchor);
    otherHandle.complete();
    const otherSpill = await writeSpillFile(other, 'spill da nova');
    expect(__timelineInternals.closedSessions.has(other)).toBe(false);

    writers.delete(gate.promise);
    __timelineInternals.inFlightSpills.delete(SESSION_ID);
    gate.resolve();
    await operation;

    expect(deleteCalls).toEqual([[SESSION_ID]]);
    expect(fs.existsSync(sessionDir(SESSION_ID))).toBe(false);
    expect(countRows('session_timeline_turns', SESSION_ID)).toBe(0);

    expect(countRows('session_timeline_turns', other)).toBe(1);
    expect(countRows('messages', other)).toBe(1);
    expect(fs.existsSync(otherSpill as string)).toBe(true);
    expect(__timelineInternals.closedSessions.has(other)).toBe(false);
  });

  it('T-13: escritor cujo mkdir conclui depois do timeout de 5 s tem o diretorio recriado apagado pela limpeza final', async () => {
    const anchor = addMessage(SESSION_ID, 'user', 'pergunta');
    startRun(SESSION_ID, anchor);

    const realMkdir = fs.promises.mkdir.bind(fs.promises);
    const gate = createDeferred<void>();
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockImplementation(async (target, options) => {
      await gate.promise;
      return realMkdir(target as string, options as { recursive: true });
    });
    const realWriteFile = fs.promises.writeFile.bind(fs.promises);
    let tmpWritten: string | null = null;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      await realWriteFile(file as string, data as string, options as never);
      tmpWritten = file as string;
    });

    const spill = writeSpillFile(SESSION_ID, 'conteudo atrasado');

    vi.useFakeTimers();
    const operation = deleteSessionsWithTimeline([SESSION_ID]);
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    await operation;

    expect(deleteCalls).toEqual([[SESSION_ID]]);
    expect(countRows('session_timeline_turns', SESSION_ID)).toBe(0);
    expect(fs.existsSync(sessionDir(SESSION_ID))).toBe(false);
    expect(__timelineInternals.closedSessions.has(SESSION_ID)).toBe(true);
    expect(__timelineInternals.deletedSessions.has(SESSION_ID)).toBe(true);

    mkdirSpy.mockRestore();
    gate.resolve();
    await expect(spill).resolves.toBeNull();
    expect(tmpWritten).toMatch(/\.txt\.tmp$/);

    await vi.waitFor(() => {
      expect(fs.existsSync(sessionDir(SESSION_ID))).toBe(false);
    });
    expect(__timelineInternals.closedSessions.has(SESSION_ID)).toBe(false);
    expect(__timelineInternals.deletedSessions.has(SESSION_ID)).toBe(false);
  });

  it('T-13: falha de remocao da pasta gera warn e resolve normalmente com o banco consistente', async () => {
    const anchor = addMessage(SESSION_ID, 'user', 'pergunta');
    startRun(SESSION_ID, anchor);
    await writeSpillFile(SESSION_ID, 'conteudo');

    vi.spyOn(fs.promises, 'rm').mockRejectedValue(new Error('EPERM'));

    await expect(deleteSessionsWithTimeline([SESSION_ID])).resolves.toBeUndefined();

    expect(countRows('session_timeline_turns', SESSION_ID)).toBe(0);
    expect(countRows('messages', SESSION_ID)).toBe(0);
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it('T-13: lista vazia nao chama o SQL e nao fecha nenhuma sessao', async () => {
    await deleteSessionsWithTimeline([]);
    expect(deleteCalls).toEqual([]);
    expect(__timelineInternals.closedSessions.size).toBe(0);
  });
});

describe('callers de exclusao (T-13: scheduler e factory reset)', () => {
  const read = (relative: string): string =>
    fs.readFileSync(path.join(process.cwd(), 'electron', 'main', relative), 'utf8');

  it('T-13: scheduler:delete-session e scheduler:cleanup-sessions usam deleteSessionsWithTimeline', () => {
    const source = read(path.join('ipc', 'scheduler.ts'));
    expect(source).not.toMatch(/deleteSessionById/);
    expect(source).not.toMatch(/deleteScheduledSessions/);
    expect(source).toMatch(
      /ipcMain\.handle\('scheduler:delete-session', async \(_event, sessionId: string\) => \{\s*await deleteSessionsWithTimeline\(\[sessionId\]\);/,
    );
    expect(source).toMatch(
      /ipcMain\.handle\('scheduler:cleanup-sessions', async \(\) => \{\s*const sessionIds = getScheduledSessions\(\)\.map\(\(session\) => session\.id\);\s*await deleteSessionsWithTimeline\(sessionIds\);/,
    );
  });

  it('T-13: factoryResetOnboarding e async, resolve os ids e nao varre data/sessions', () => {
    const source = read(path.join('ipc', 'system.ts'));
    expect(source).toMatch(/async function factoryResetOnboarding\(\): Promise<void>/);
    expect(source).not.toMatch(/clearAllSessions/);
    expect(source).not.toMatch(/readdirSync\(sessionsDir\)/);
    expect(source).toMatch(
      /const sessionIds = getAllSessionIds\(\);\s*await deleteSessionsWithTimeline\(sessionIds\);\s*clearNonSessionResetTables\(\);/,
    );
    expect(source).toMatch(/ipcMain\.handle\('onboarding:reset', async \(\) => \{\s*await factoryResetOnboarding\(\);/);
  });
});
