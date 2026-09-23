import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ChatMessage,
  ChatSession,
  TimelineEvent,
  TimelineEventKind,
  TimelineTurnWithEvents,
} from '../../../src/types';

const h = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  capturedMessages: [] as Array<{ role: string; content: string }>,
  capturedText: '',
  compactionState: null as Record<string, unknown> | null,
  timelineReads: 0,
  timelineFences: [] as Array<number | null>,
}));

let memoryDb: DatabaseSync;
let runFixtures: Array<Omit<TimelineTurnWithEvents, 'events'>> = [];
let sessionBoundary: number | null = null;

const SCHEMA = `
  CREATE TABLE sessions (
    id    TEXT PRIMARY KEY,
    title TEXT
  );
  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE session_timeline_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    tool_use_id TEXT,
    tool_name   TEXT,
    content     TEXT NOT NULL,
    is_error    INTEGER NOT NULL DEFAULT 0
  );
`;

function eventsOfRun(runId: string): TimelineEvent[] {
  const rows = memoryDb
    .prepare('SELECT * FROM session_timeline_events WHERE run_id = ? ORDER BY seq')
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row['id'] as number,
    runId: row['run_id'] as string,
    sessionId: row['session_id'] as string,
    seq: row['seq'] as number,
    kind: row['kind'] as TimelineEventKind,
    toolUseId: (row['tool_use_id'] as string | null) ?? null,
    toolName: (row['tool_name'] as string | null) ?? null,
    content: row['content'] as string,
    toolCallsJson: null,
    reasoningContent: null,
    isError: row['is_error'] === 1,
    originalBytes: null,
    spillPath: null,
    createdAt: '2026-01-01 10:00:00',
  }));
}

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

vi.mock('../paths', () => ({ getLionClawHome: () => path.join(path.resolve('/'), 'tmp-lionclaw') }));

vi.mock('../db', () => ({
  getDb: () => ({
    prepare: (sql: string) => memoryDb.prepare(sql),
    transaction: (fn: () => void) => () => fn(),
  }),
  getSetting: (key: string) => h.settings.get(key),
  getSession: (sessionId: string) => sessionOf(sessionId),
  getSessionOrchestrator: vi.fn(() => null),
  getSessionMessages: (sessionId: string) => messagesOf(sessionId),
  setSessionCompactionState: (sessionId: string, state: Record<string, unknown>) => {
    h.compactionState = { sessionId, ...state };
  },
  setSessionActiveContextTokens: vi.fn(),
  getTimelineTurnsAfterFence: (sessionId: string, fence: number | null) => {
    h.timelineReads += 1;
    h.timelineFences.push(fence);
    return runFixtures
      .filter((run) => run.sessionId === sessionId)
      .filter((run) => run.anchorMessageId !== null)
      .filter((run) => fence === null || (run.anchorMessageId as number) > fence)
      .map((run) => ({ ...run, events: eventsOfRun(run.runId) }));
  },
  insertChunkWithEmbedding: vi.fn(),
  searchBM25: vi.fn(() => []),
  searchVector: vi.fn(() => []),
  setLastGateRunAt: vi.fn(),
  getDreamingState: vi.fn(),
  getDreamingTurnInterval: vi.fn(() => 20),
  incrementTurnCount: vi.fn(() => 1),
  resetTurnCount: vi.fn(),
  setLastTurnRunAt: vi.fn(),
  incrementTotalTurnRuns: vi.fn(),
  incrementTotalTurnFailsafes: vi.fn(),
}));

vi.mock('../memory-pipeline/budgeted-input', () => ({
  buildBudgetedMessageText: (messages: Array<{ role: string; content: string }>) => {
    h.capturedMessages = messages;
    h.capturedText = messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n');
    return Promise.resolve({
      messageText: h.capturedText,
      stats: { finalInputTokensEst: 0, durationMs: 0 },
    });
  },
  resolveCompactionInputBudget: () => 100_000,
  resolveLocalInputWarnTokens: () => 100_000,
  summarizePlainBlock: vi.fn(),
}));

vi.mock('../orchestrator-selection', () => ({
  resolveOrchestratorSelection: vi.fn(async () => ({
    runtime: 'claude-sdk',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    source: 'settings',
  })),
  resolveSubscriptionSelectionFor: vi.fn(),
  InvalidOrchestratorSelectionError: class extends Error {},
}));

vi.mock('../memory-pipeline/oneshot-subscription', () => ({
  runSubscriptionPromptWithFallback: vi.fn(async () => ({
    text: JSON.stringify({
      executive_summary: 'resumo',
      decisions: [],
      tasks_created: [],
      facts: [],
      semantic_chunks: [],
      user_profile_updates: [],
      working_memory_updates: { add: [], remove: [] },
    }),
    actualModelLabel: 'Claude Sonnet 4.6',
  })),
}));

vi.mock('../dreaming-gate', () => ({
  runDreamingGate: vi.fn(),
  saveDreamingReport: vi.fn(),
  resolveDreamingTimeoutMs: () => 60_000,
}));

vi.mock('../embedding-provider', () => ({ generateEmbedding: vi.fn(async () => null) }));

vi.mock('../mgraph-engine', () => ({
  executeVaultOperation: vi.fn(() => ({ success: true })),
  regenerateVaultIndex: vi.fn(),
  updateVaultHot: vi.fn(),
  appendVaultLog: vi.fn(),
  getExistingVaultFilesList: vi.fn(() => ''),
}));

vi.mock('../lion-sdk/adapters/lmstudio', () => ({ createLmStudioAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/ollama', () => ({ createOllamaAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/openai-compatible', () => ({ createOpenAiCompatibleAdapter: vi.fn() }));
vi.mock('../lion-sdk/adapters/google-genai', () => ({ createGoogleGenAiAdapter: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    messages = { create: vi.fn() };
    constructor(_opts: unknown) {}
  },
}));
vi.mock('../secrets-vault', () => ({
  getApiKey: vi.fn(async () => 'test-key'),
  getSecret: vi.fn(async () => null),
}));

import { CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY } from '../chat-compaction-defaults';
import { compactChatSessionInPlace } from '../chat-compaction-inplace';
import { __dreamingInternals } from '../dreaming-turn-engine';

const CWD = path.resolve('/proj');
const OUTSIDE_FILE = path.resolve('/fora/y.ts');

function posix(target: string): string {
  return target.split(path.sep).join('/');
}

function addSession(sessionId: string): void {
  memoryDb.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run(sessionId, 'Conversa');
}

function addMessage(
  sessionId: string,
  id: number,
  role: 'user' | 'assistant',
  content: string,
  createdAt = '2026-01-01 10:00:00',
): number {
  memoryDb
    .prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, sessionId, role, content, createdAt);
  return id;
}

function messagesOf(sessionId: string): ChatMessage[] {
  const rows = memoryDb
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, id')
    .all(sessionId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row['id'] as number,
    sessionId,
    role: row['role'] as ChatMessage['role'],
    content: row['content'] as string,
    createdAt: row['created_at'] as string,
  }));
}

function sessionOf(sessionId: string): ChatSession | undefined {
  const row = memoryDb.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId) as
    Record<string, unknown> | undefined;
  if (row === undefined) return undefined;
  return {
    id: sessionId,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    status: 'active',
    type: 'chat',
    createdAt: '2026-01-01 10:00:00',
    updatedAt: '2026-01-01 10:00:00',
    ...(sessionBoundary === null ? {} : { compactedUpToMessageId: sessionBoundary }),
  };
}

function addRun(
  sessionId: string,
  runId: string,
  anchorMessageId: number,
  opts?: { cwd?: string | null; seqId?: number },
): void {
  runFixtures.push({
    seqId: opts?.seqId ?? runFixtures.length + 1,
    runId,
    sessionId,
    turnIndex: 0,
    anchorMessageId,
    currentUserMessageId: anchorMessageId,
    assistantMessageId: null,
    origin: 'turn',
    runtime: 'lion-sdk',
    fidelity: 'exact',
    status: 'complete',
    cwd: opts?.cwd ?? null,
    textTokensEst: null,
    toolTokensEst: null,
    createdAt: '2026-01-01 10:00:00',
  });
}

let eventSeq = 0;

function addToolEvent(
  sessionId: string,
  runId: string,
  kind: TimelineEventKind,
  toolUseId: string | null,
  toolName: string | null,
  content: string,
  isError = false,
): void {
  eventSeq += 1;
  memoryDb
    .prepare(
      `INSERT INTO session_timeline_events
         (run_id, session_id, seq, kind, tool_use_id, tool_name, content, is_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(runId, sessionId, eventSeq, kind, toolUseId, toolName, content, isError ? 1 : 0);
}

function addToolPair(
  sessionId: string,
  runId: string,
  toolUseId: string,
  toolName: string,
  args: string,
  result: string,
  isError = false,
): void {
  addToolEvent(sessionId, runId, 'tool_call', toolUseId, toolName, args);
  addToolEvent(sessionId, runId, 'tool_result', toolUseId, toolName, result, isError);
}

function countTimelineEvents(sessionId: string): number {
  const row = memoryDb
    .prepare('SELECT COUNT(*) AS n FROM session_timeline_events WHERE session_id = ?')
    .get(sessionId) as { n: number };
  return Number(row.n);
}

function enableReinject(): void {
  h.settings.set(CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY, 'true');
}

beforeEach(() => {
  memoryDb = new DatabaseSync(':memory:');
  memoryDb.exec(SCHEMA);
  runFixtures = [];
  sessionBoundary = null;
  eventSeq = 0;
  h.settings.clear();
  h.settings.set('orchestrator_runtime', 'claude-sdk');
  h.settings.set('orchestrator_provider', 'anthropic');
  h.settings.set('orchestrator_model', 'claude-sonnet-4-6');
  h.capturedMessages = [];
  h.capturedText = '';
  h.compactionState = null;
  h.timelineReads = 0;
  h.timelineFences = [];
});

function seedInPlaceSession(): void {
  addSession('sess-inplace');
  addMessage('sess-inplace', 1, 'user', 'antiga');
  addMessage('sess-inplace', 2, 'assistant', 'resposta antiga');
  addMessage('sess-inplace', 3, 'user', 'u1');
  addMessage('sess-inplace', 4, 'assistant', 'a1');
  addMessage('sess-inplace', 5, 'assistant', 'a2');
  addMessage('sess-inplace', 6, 'user', 'u2');
  sessionBoundary = 2;

  addRun('sess-inplace', 'run-0', 1);
  addToolPair('sess-inplace', 'run-0', 't0', 'Read', '{"file_path":"antigo.ts"}', 'antigo');

  addRun('sess-inplace', 'run-1', 3);
  addToolPair('sess-inplace', 'run-1', 't1', 'Read', '{"file_path":"a.ts"}', 'conteudo a');

  addRun('sess-inplace', 'run-2', 6);
  addToolPair('sess-inplace', 'run-2', 't2', 'Bash', '{"command":"ls"}', 'ok');
}

describe('compactacao in-place com bloco Tools: (feat-045)', () => {
  it('T-10: bloco Tools: uma unica vez por intervalo e eventos preservados apos o fence avancar', async () => {
    seedInPlaceSession();
    enableReinject();
    const eventsBefore = countTimelineEvents('sess-inplace');

    const outcome = await compactChatSessionInPlace('sess-inplace');

    expect(outcome).toMatchObject({ ok: true });
    expect(h.capturedMessages).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'assistant', content: 'a2\n\nTools:\n- Read({"file_path":"a.ts"}) -> conteudo a' },
      { role: 'user', content: 'u2\n\nTools:\n- Bash({"command":"ls"}) -> ok' },
    ]);
    expect(h.capturedText.split('Tools:').length - 1).toBe(2);
    expect(h.capturedText.split('- Read({"file_path":"a.ts"}) -> conteudo a').length - 1).toBe(1);
    expect(h.capturedText.split('- Bash({"command":"ls"}) -> ok').length - 1).toBe(1);
    expect(h.capturedText).not.toContain('antigo.ts');
    expect(h.timelineFences).toEqual([2]);

    expect(h.compactionState).toMatchObject({ sessionId: 'sess-inplace', compactedUpToMessageId: 6 });
    expect(countTimelineEvents('sess-inplace')).toBe(eventsBefore);
    expect(countTimelineEvents('sess-inplace')).toBe(6);
  });

  it('T-33: com o setting desligado a entrada do sumarizador e identica a atual', async () => {
    seedInPlaceSession();

    const outcome = await compactChatSessionInPlace('sess-inplace');

    expect(outcome).toMatchObject({ ok: true });
    expect(h.capturedMessages).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u2' },
    ]);
    expect(h.capturedText).not.toContain('Tools:');
    expect(h.timelineReads).toBe(0);
  });
});

describe('dreaming com arquivos tocados (feat-046)', () => {
  it('T-11: uma linha com os arquivos elegiveis; Codex sem args nao rende linha', () => {
    addSession('sess-dream');
    addMessage('sess-dream', 10, 'user', 'pergunta 1');
    addMessage('sess-dream', 11, 'assistant', 'resposta 1');
    addMessage('sess-dream', 12, 'user', 'pergunta codex');
    addMessage('sess-dream', 13, 'assistant', 'resposta codex');

    addRun('sess-dream', 'run-dream-1', 10, { cwd: CWD });
    addToolPair(
      'sess-dream',
      'run-dream-1',
      'e1',
      'Edit',
      JSON.stringify({ file_path: path.join(CWD, 'src', 'a.ts') }),
      'editado',
    );
    addToolPair(
      'sess-dream',
      'run-dream-1',
      'e2',
      'Read',
      JSON.stringify({ file_path: path.join(CWD, 'src', 'b.ts') }),
      'lido',
    );
    addToolPair('sess-dream', 'run-dream-1', 'e3', 'Grep', JSON.stringify({ path: 'src' }), 'match');
    addToolPair(
      'sess-dream',
      'run-dream-1',
      'e4',
      'Read',
      JSON.stringify({ file_path: path.join(CWD, 'x.ts') }),
      'ENOENT',
      true,
    );
    addToolPair('sess-dream', 'run-dream-1', 'e5', 'Write', JSON.stringify({ file_path: OUTSIDE_FILE }), 'escrito');

    addRun('sess-dream', 'run-dream-2', 12, { cwd: CWD });
    addToolPair('sess-dream', 'run-dream-2', 'c1', 'shell', '', 'saida do codex');

    enableReinject();
    const turns = __dreamingInternals.collectRecentTurns('sess-dream', 10);

    expect(turns).toEqual([
      { role: 'user', content: 'pergunta 1' },
      {
        role: 'assistant',
        content: `resposta 1\n[arquivos tocados: src/a.ts, src/b.ts, ${posix(OUTSIDE_FILE)}]`,
      },
      { role: 'user', content: 'pergunta codex' },
      { role: 'assistant', content: 'resposta codex' },
    ]);
  });

  it('T-11: com o setting desligado a saida e a atual e o leitor de timeline nao roda', () => {
    addSession('sess-dream');
    addMessage('sess-dream', 10, 'user', 'pergunta 1');
    addMessage('sess-dream', 11, 'assistant', 'resposta 1');
    addRun('sess-dream', 'run-dream-1', 10, { cwd: CWD });
    addToolPair(
      'sess-dream',
      'run-dream-1',
      'e1',
      'Edit',
      JSON.stringify({ file_path: path.join(CWD, 'src', 'a.ts') }),
      'editado',
    );

    const turns = __dreamingInternals.collectRecentTurns('sess-dream', 10);

    expect(turns).toEqual([
      { role: 'user', content: 'pergunta 1' },
      { role: 'assistant', content: 'resposta 1' },
    ]);
    expect(h.timelineReads).toBe(0);
  });

  it('T-34: intervalo sem assistant recebe a linha no proprio user', () => {
    addSession('sess-t34a');
    addMessage('sess-t34a', 30, 'user', 'so user');
    addRun('sess-t34a', 'run-t34a', 30, { cwd: CWD });
    addToolPair(
      'sess-t34a',
      'run-t34a',
      'u1',
      'Write',
      JSON.stringify({ file_path: path.join(CWD, 'src', 'only-user.ts') }),
      'escrito',
    );

    enableReinject();
    const turns = __dreamingInternals.collectRecentTurns('sess-t34a', 5);

    expect(turns).toEqual([{ role: 'user', content: 'so user\n[arquivos tocados: src/only-user.ts]' }]);
  });

  it('T-34: LIMIT corta o user, anchor vem do predecessor, desempate por id e linha fora do corte de 2.000', () => {
    addSession('sess-t34b');
    addMessage('sess-t34b', 20, 'user', 'pergunta cortada', '2026-01-01 10:00:00');
    addMessage('sess-t34b', 21, 'assistant', 'resposta 21', '2026-01-01 10:00:05');
    addMessage('sess-t34b', 22, 'assistant', 'B'.repeat(5000), '2026-01-01 10:00:05');

    addRun('sess-t34b', 'run-t34b', 20, { cwd: CWD });
    addToolPair(
      'sess-t34b',
      'run-t34b',
      'p1',
      'Edit',
      JSON.stringify({ file_path: path.join(CWD, 'src', 'cortado.ts') }),
      'editado',
    );

    enableReinject();
    const turns = __dreamingInternals.collectRecentTurns('sess-t34b', 1);

    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.role)).toEqual(['assistant', 'assistant']);
    expect(turns[0].content).toBe('resposta 21');

    const line = '[arquivos tocados: src/cortado.ts]';
    expect(turns[1].content.endsWith(`\n${line}`)).toBe(true);
    const withoutLine = turns[1].content.slice(0, turns[1].content.length - line.length - 1);
    expect(withoutLine.length).toBe(2000);
    expect(withoutLine).toContain('[trecho central omitido:');
    expect(turns.some((t) => t.content.includes('pergunta cortada'))).toBe(false);
  });
});
