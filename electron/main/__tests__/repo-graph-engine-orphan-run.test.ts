
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  RepoGraphEngine,
  type RepoGraphEngineDb,
  type RepoGraphProvider,
} from '../repo-graph/engine';
import { __clearStalenessThrottleForTests } from '../repo-graph/staleness';
import type {
  LocalRepositoryRecord,
  RepoGraphRunRecord,
  RepoGraphRunResult,
  RepoGraphStatusEvent,
  SessionActiveRepositoryRecord,
} from '../repo-graph/types';

const SESSION_ID = 'session-orphan-1';
const REPO_ID = 'repo-orphan-run-1';
const ORPHAN_RUN_ID = 'run-orphan-1';
const OLD_ISO = '2026-06-01T10:00:00.000Z';

function makeRepoRecord(
  canonicalRootPath: string,
  status: LocalRepositoryRecord['status'],
): LocalRepositoryRecord {
  return {
    id: REPO_ID,
    name: 'fixture-repo',
    rootPath: canonicalRootPath,
    canonicalRootPath,
    gitRoot: null,
    provider: 'mock',
    graphPath: `${canonicalRootPath}/.codegraph/codegraph.db`,
    status,
    indexedCommit: null,
    indexedWorktreeHash: null,
    lastIndexedAt: OLD_ISO,
    statsJson: null,
    graphPromptSuppressedGlobal: false,
    settingsJson: '{}',
    createdAt: OLD_ISO,
    updatedAt: OLD_ISO,
  };
}

interface MockDbHandle {
  db: RepoGraphEngineDb;
  runs: Map<string, RepoGraphRunRecord>;
  seedRun: (run: Partial<RepoGraphRunRecord> & { id: string }) => RepoGraphRunRecord;
}

function makeDb(repoRecord: LocalRepositoryRecord): MockDbHandle {
  const runs = new Map<string, RepoGraphRunRecord>();
  const attach: SessionActiveRepositoryRecord = {
    sessionId: SESSION_ID,
    repositoryId: repoRecord.id,
    graphPromptSuppressed: false,
    attachedAt: OLD_ISO,
    updatedAt: OLD_ISO,
  };
  const seedRun: MockDbHandle['seedRun'] = (partial) => {
    const run: RepoGraphRunRecord = {
      id: partial.id,
      repositoryId: partial.repositoryId ?? repoRecord.id,
      sessionId: partial.sessionId ?? null,
      provider: partial.provider ?? 'mock',
      kind: partial.kind ?? 'build',
      status: partial.status ?? 'running',
      startedAt: partial.startedAt ?? OLD_ISO,
      completedAt: partial.completedAt ?? null,
      durationMs: partial.durationMs ?? 0,
      output: partial.output ?? null,
      error: partial.error ?? null,
      statsJson: partial.statsJson ?? null,
    };
    runs.set(run.id, run);
    return run;
  };
  const db: RepoGraphEngineDb = {
    upsertLocalRepository: () => ({ ...repoRecord }),
    getLocalRepository: (id) => (id === repoRecord.id ? { ...repoRecord } : null),
    listLocalRepositories: () => [{ ...repoRecord }],
    removeLocalRepository: () => undefined,
    updateLocalRepositoryGraphState: (id, patch) => {
      if (id !== repoRecord.id) return;
      if (patch.status !== undefined) repoRecord.status = patch.status;
      if (patch.indexedCommit !== undefined) repoRecord.indexedCommit = patch.indexedCommit;
      if (patch.indexedWorktreeHash !== undefined) {
        repoRecord.indexedWorktreeHash = patch.indexedWorktreeHash;
      }
      if (patch.lastIndexedAt !== undefined) repoRecord.lastIndexedAt = patch.lastIndexedAt;
      if (patch.statsJson !== undefined) repoRecord.statsJson = patch.statsJson;
      if (patch.graphPath !== undefined) repoRecord.graphPath = patch.graphPath;
    },
    setRepoGraphPromptSuppressedGlobal: () => undefined,
    insertRepoGraphRun: (input) =>
      seedRun({ id: input.id, repositoryId: input.repositoryId, sessionId: input.sessionId, provider: input.provider, kind: input.kind, startedAt: new Date().toISOString() }),
    updateRepoGraphRun: (id, patch) => {
      const run = runs.get(id);
      if (!run) return;
      if (patch.status !== undefined) run.status = patch.status;
      if (patch.completedAt !== undefined) run.completedAt = patch.completedAt;
      if (patch.durationMs !== undefined) run.durationMs = patch.durationMs;
      if (patch.output !== undefined) run.output = patch.output;
      if (patch.error !== undefined) run.error = patch.error;
      if (patch.statsJson !== undefined) run.statsJson = patch.statsJson;
    },
    getLatestRepoGraphRun: () => {
      const all = [...runs.values()];
      return all.length > 0 ? { ...all[all.length - 1] } : null;
    },
    attachSessionRepository: () => undefined,
    detachSessionRepository: () => undefined,
    getSessionActiveRepository: (sessionId) =>
      sessionId === SESSION_ID ? { ...attach } : null,
    setSessionGraphPromptSuppressed: () => undefined,
  };
  return { db, runs, seedRun };
}

function makeProvider(overrides: Partial<RepoGraphProvider> = {}): RepoGraphProvider {
  return {
    providerName: 'mock',
    detect: async () => ({ exists: true, stats: { files: 1 } }),
    search: async () => ({ symbols: [] }),
    minimalContext: async (input) => ({
      repositoryId: input.repositoryId,
      rootPath: input.rootPath,
      files: [],
      symbols: [],
      renderedMarkdown: '',
    }),
    impact: async (input) => ({
      symbol: input.symbol,
      depth: input.depth ?? 1,
      nodeCount: 0,
      edgeCount: 0,
      affected: [],
    }),
    node: async () => ({ node: null }),
    callers: async (input) => ({ symbol: input.symbol, related: [] }),
    callees: async (input) => ({ symbol: input.symbol, related: [] }),
    build: async () => ({ status: 'done', output: 'indexed', durationMs: 5 }),
    update: async () => ({ status: 'done', output: 'synced', durationMs: 5 }),
    ...overrides,
  };
}

let tempDir: string;

beforeEach(() => {
  __clearStalenessThrottleForTests();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-repo-graph-orphan-'));
});

afterEach(() => {
  __clearStalenessThrottleForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('engine - reconciliacao de run orfao pos-restart (sprint A1)', () => {
  it('run running sem handle vira error e repo volta a ready quando o graph existe', async () => {
    const repoRecord = makeRepoRecord(tempDir, 'building');
    const { db, runs, seedRun } = makeDb(repoRecord);
    seedRun({ id: ORPHAN_RUN_ID, sessionId: SESSION_ID, kind: 'build' });

    const events: RepoGraphStatusEvent[] = [];
    const engine = new RepoGraphEngine(db, makeProvider());
    engine.setStatusEmitter((event) => events.push(event));

    await engine.reconcileOrphanRuns();

    const run = runs.get(ORPHAN_RUN_ID) as RepoGraphRunRecord;
    expect(run.status).toBe('error');
    expect(run.error).toContain('interrompido por restart');
    expect(run.completedAt).not.toBeNull();
    expect(repoRecord.status).toBe('ready');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      repositoryId: REPO_ID,
      runId: ORPHAN_RUN_ID,
      runStatus: 'error',
      status: 'ready',
    });

    const state = engine.getSessionState(SESSION_ID);
    expect(state.repository?.status).toBe('ready');
    expect(state.activeRun).toBeNull();
  });

  it('run orfao com graph AUSENTE no disco recomputa o repo para absent', async () => {
    const repoRecord = makeRepoRecord(tempDir, 'building');
    const { db, runs, seedRun } = makeDb(repoRecord);
    seedRun({ id: ORPHAN_RUN_ID, kind: 'update' });

    const engine = new RepoGraphEngine(
      db,
      makeProvider({ detect: async () => ({ exists: false }) }),
    );
    await engine.reconcileOrphanRuns();

    expect((runs.get(ORPHAN_RUN_ID) as RepoGraphRunRecord).status).toBe('error');
    expect(repoRecord.status).toBe('absent');
  });

  it('reconciliacao e idempotente e nao toca runs ja concluidos', async () => {
    const repoRecord = makeRepoRecord(tempDir, 'ready');
    const { db, runs, seedRun } = makeDb(repoRecord);
    seedRun({ id: 'run-done-1', status: 'done', completedAt: OLD_ISO });

    const engine = new RepoGraphEngine(db, makeProvider());
    await engine.reconcileOrphanRuns();
    await engine.reconcileOrphanRuns();

    expect((runs.get('run-done-1') as RepoGraphRunRecord).status).toBe('done');
    expect(repoRecord.status).toBe('ready');
  });

  it('guard do getSessionState: run orfao do DB nao rehidrata activeRun', () => {
    const repoRecord = makeRepoRecord(tempDir, 'building');
    const { db, seedRun } = makeDb(repoRecord);
    seedRun({ id: ORPHAN_RUN_ID, sessionId: SESSION_ID });

    const engine = new RepoGraphEngine(db, makeProvider());
    const state = engine.getSessionState(SESSION_ID);
    expect(state.activeRun).toBeNull();
  });

  it('nao-regressao: run legitimo em andamento continua como activeRun', async () => {
    const repoRecord = makeRepoRecord(tempDir, 'absent');
    const { db } = makeDb(repoRecord);

    let resolveBuild: ((result: RepoGraphRunResult) => void) | null = null;
    const engine = new RepoGraphEngine(
      db,
      makeProvider({
        build: () =>
          new Promise<RepoGraphRunResult>((resolve) => {
            resolveBuild = resolve;
          }),
      }),
    );

    const finalEvent = new Promise<RepoGraphStatusEvent>((resolve) => {
      engine.setStatusEmitter((event) => {
        if (event.runStatus && event.runStatus !== 'running') resolve(event);
      });
    });

    const started = await engine.startRun(REPO_ID, 'build', SESSION_ID);
    expect('runId' in started).toBe(true);

    const during = engine.getSessionState(SESSION_ID);
    expect(during.activeRun?.status).toBe('running');
    expect(during.repository?.status).toBe('building');

    await engine.reconcileOrphanRuns();
    expect(engine.getSessionState(SESSION_ID).activeRun?.status).toBe('running');

    (resolveBuild as unknown as (result: RepoGraphRunResult) => void)({
      status: 'done',
      output: 'indexed',
      durationMs: 5,
    });
    expect((await finalEvent).runStatus).toBe('done');
    expect(engine.getSessionState(SESSION_ID).activeRun).toBeNull();
  });
});
