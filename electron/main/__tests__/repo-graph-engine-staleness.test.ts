import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { RepoGraphEngine, type RepoGraphEngineDb, type RepoGraphProvider } from '../repo-graph/engine';
import { checkRepoStaleness, __clearStalenessThrottleForTests } from '../repo-graph/staleness';
import type {
  LocalRepositoryRecord,
  RepoGraphRunRecord,
  SessionActiveRepositoryRecord,
  RepoGraphStatusEvent,
} from '../repo-graph/types';

const SESSION_ID = 'session-1';
const REPO_ID = 'repo-engine-staleness-1';
const OLD_ISO = '2026-06-01T10:00:00.000Z';

function makeRepoRecord(canonicalRootPath: string): LocalRepositoryRecord {
  return {
    id: REPO_ID,
    name: 'fixture-repo',
    rootPath: canonicalRootPath,
    canonicalRootPath,
    gitRoot: null,
    provider: 'mock',
    graphPath: `${canonicalRootPath}/.codegraph/codegraph.db`,
    status: 'ready',
    indexedCommit: 'old-commit',
    indexedWorktreeHash: null,
    lastIndexedAt: OLD_ISO,
    statsJson: null,
    graphPromptSuppressedGlobal: false,
    settingsJson: '{}',
    createdAt: OLD_ISO,
    updatedAt: OLD_ISO,
  };
}

function makeDb(repoRecord: LocalRepositoryRecord): RepoGraphEngineDb {
  const runs = new Map<string, RepoGraphRunRecord>();
  const attach: SessionActiveRepositoryRecord = {
    sessionId: SESSION_ID,
    repositoryId: repoRecord.id,
    graphPromptSuppressed: false,
    attachedAt: OLD_ISO,
    updatedAt: OLD_ISO,
  };
  return {
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
    insertRepoGraphRun: (input) => {
      const run: RepoGraphRunRecord = {
        id: input.id,
        repositoryId: input.repositoryId,
        sessionId: input.sessionId,
        provider: input.provider,
        kind: input.kind,
        status: 'running',
        startedAt: new Date().toISOString(),
        completedAt: null,
        durationMs: 0,
        output: null,
        error: null,
        statsJson: null,
      };
      runs.set(run.id, run);
      return run;
    },
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
    getSessionActiveRepository: (sessionId) => (sessionId === SESSION_ID ? { ...attach } : null),
    setSessionGraphPromptSuppressed: () => undefined,
  };
}

function makeProvider(): RepoGraphProvider {
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
  };
}

let tempDir: string;

beforeEach(() => {
  __clearStalenessThrottleForTests();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-repo-graph-engine-'));
});

afterEach(() => {
  __clearStalenessThrottleForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('engine - invalidacao do throttle de staleness no fim do run (AC-5)', () => {
  it('check stale -> run done -> getSessionState devolve ready SEM esperar 5min', async () => {
    const repoRecord = makeRepoRecord(tempDir);
    const engine = new RepoGraphEngine(makeDb(repoRecord), makeProvider());

    const seeded = checkRepoStaleness(
      {
        repositoryId: REPO_ID,
        canonicalRootPath: tempDir,
        indexedCommit: 'old-commit',
        lastIndexedAt: OLD_ISO,
      },
      {
        execGit: (args) => (args[0] === 'rev-parse' ? 'new-commit\n' : ''),
        statMtimeMs: () => 0,
        now: () => Date.now(),
      },
    );
    expect(seeded.stale).toBe(true);

    const before = engine.getSessionState(SESSION_ID);
    expect(before.staleness?.stale).toBe(true);
    expect(before.repository?.status).toBe('stale');

    const finalEvent = await new Promise<RepoGraphStatusEvent>((resolve, reject) => {
      engine.setStatusEmitter((event) => {
        if (event.runStatus && event.runStatus !== 'running') resolve(event);
      });
      void engine.startRun(REPO_ID, 'update', null).then((started) => {
        if ('error' in started) reject(new Error(started.error));
      });
    });
    expect(finalEvent.runStatus).toBe('done');
    expect(finalEvent.status).toBe('ready');

    const after = engine.getSessionState(SESSION_ID);
    expect(after.staleness?.stale).toBe(false);
    expect(after.repository?.status).toBe('ready');
    expect(after.activeRun).toBeNull();
  });
});
