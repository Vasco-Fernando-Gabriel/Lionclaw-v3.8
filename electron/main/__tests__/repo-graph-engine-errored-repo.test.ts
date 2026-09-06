
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
  SessionActiveRepositoryRecord,
} from '../repo-graph/types';

const BINARY_MISSING = 'codegraph: binario da CLI ausente';
const SESSION_ID = 'session-errored-1';
const REPO_ID = 'repo-errored-1';
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
        startedAt: OLD_ISO,
        completedAt: null,
        durationMs: 0,
        output: null,
        error: null,
        statsJson: null,
      };
      runs.set(run.id, run);
      return run;
    },
    updateRepoGraphRun: () => undefined,
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-repo-graph-errored-'));
});

afterEach(() => {
  __clearStalenessThrottleForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('engine - repo preso em error por binario ausente (recuperavel)', () => {
  it('addRepository: binario ausente no detect inicial NAO persiste error (fica absent)', async () => {
    const repoRecord = makeRepoRecord(tempDir, 'absent');
    const db = makeDb(repoRecord);
    const engine = new RepoGraphEngine(
      db,
      makeProvider({ detect: async () => ({ exists: false, error: BINARY_MISSING }) }),
    );

    const result = await engine.addRepository(tempDir);

    expect('error' in result).toBe(false);
    expect((result as LocalRepositoryRecord).status).toBe('absent');
    expect(repoRecord.status).toBe('absent');
  });

  it('addRepository: re-add de repo preso em error com binario ainda ausente volta a absent', async () => {
    const repoRecord = makeRepoRecord(tempDir, 'error');
    const db = makeDb(repoRecord);
    const engine = new RepoGraphEngine(
      db,
      makeProvider({ detect: async () => ({ exists: false, error: BINARY_MISSING }) }),
    );

    const result = await engine.addRepository(tempDir);

    expect((result as LocalRepositoryRecord).status).toBe('absent');
    expect(repoRecord.status).toBe('absent');
  });

  it('addRepository: graph presente em repo absent vira ready (happy path intacto)', async () => {
    const repoRecord = makeRepoRecord(tempDir, 'absent');
    const db = makeDb(repoRecord);
    const engine = new RepoGraphEngine(
      db,
      makeProvider({ detect: async () => ({ exists: true, stats: { files: 7 } }) }),
    );

    const result = await engine.addRepository(tempDir);

    expect((result as LocalRepositoryRecord).status).toBe('ready');
  });

  it('reconcileErroredRepos: error + binario presente + sem graph -> absent (destrava o modal)', async () => {
    const repoRecord = makeRepoRecord(tempDir, 'error');
    const db = makeDb(repoRecord);
    const engine = new RepoGraphEngine(
      db,
      makeProvider({ detect: async () => ({ exists: false }) }),
    );

    await engine.reconcileErroredRepos();

    expect(repoRecord.status).toBe('absent');
    expect(engine.getSessionState(SESSION_ID).repository?.status).toBe('absent');
  });

  it('reconcileErroredRepos: error + binario AINDA ausente continua error (nao cura cedo demais)', async () => {
    const repoRecord = makeRepoRecord(tempDir, 'error');
    const db = makeDb(repoRecord);
    const engine = new RepoGraphEngine(
      db,
      makeProvider({ detect: async () => ({ exists: false, error: BINARY_MISSING }) }),
    );

    await engine.reconcileErroredRepos();

    expect(repoRecord.status).toBe('error');
  });

  it('reconcileErroredRepos: repo nao-error fica intocado (disjunto de reconcileOrphanRuns)', async () => {
    const repoRecord = makeRepoRecord(tempDir, 'ready');
    const db = makeDb(repoRecord);
    const engine = new RepoGraphEngine(
      db,
      makeProvider({ detect: async () => ({ exists: false }) }),
    );

    await engine.reconcileErroredRepos();

    expect(repoRecord.status).toBe('ready');
  });
});
