
import { describe, it, expect, beforeEach } from 'vitest';

import {
  checkRepoStaleness,
  clearStalenessForRepo,
  parsePorcelainLine,
  STALE_CHECK_MAX_DIRTY,
  STALE_CHECK_THROTTLE_MS,
  __clearStalenessThrottleForTests,
  type StalenessDeps,
} from '../repo-graph/staleness';
import type { RepoStalenessInput } from '../repo-graph/types';

const ROOT = '/repo/root';
const INDEXED_AT_ISO = '2026-06-10T10:00:00.000Z';
const INDEXED_AT_MS = Date.parse(INDEXED_AT_ISO);
const HEAD = 'aaaa111122223333aaaa111122223333aaaa1111';

let uniqueRepoCounter = 0;

function makeInput(overrides: Partial<RepoStalenessInput> = {}): RepoStalenessInput {
  uniqueRepoCounter += 1;
  return {
    repositoryId: `repo_${uniqueRepoCounter}`,
    canonicalRootPath: ROOT,
    indexedCommit: HEAD,
    lastIndexedAt: INDEXED_AT_ISO,
    ...overrides,
  };
}

interface DepsConfig {
  head?: string;
  porcelain?: string;
  mtimes?: Record<string, number>;
  now?: number;
  gitFails?: boolean;
}

function makeDeps(config: DepsConfig = {}): StalenessDeps & {
  gitCalls: string[][];
  statCalls: string[];
} {
  const gitCalls: string[][] = [];
  const statCalls: string[] = [];
  return {
    gitCalls,
    statCalls,
    execGit: (args: string[]) => {
      gitCalls.push(args);
      if (config.gitFails) throw new Error('not a git repository');
      if (args[0] === 'rev-parse') return `${config.head ?? HEAD}\n`;
      if (args[0] === 'status') return config.porcelain ?? '';
      throw new Error(`comando git inesperado: ${args.join(' ')}`);
    },
    statMtimeMs: (absolutePath: string) => {
      statCalls.push(absolutePath);
      const mtime = config.mtimes?.[absolutePath];
      if (mtime === undefined) {
        const err = new Error(`ENOENT: no such file or directory, stat '${absolutePath}'`);
        throw err;
      }
      return mtime;
    },
    now: () => config.now ?? 1_000_000,
  };
}

beforeEach(() => {
  __clearStalenessThrottleForTests();
});


describe('staleness - HEAD vs indexed_commit', () => {
  it('HEAD igual + worktree limpo -> nao stale', () => {
    const deps = makeDeps({ head: HEAD, porcelain: '' });
    const result = checkRepoStaleness(makeInput(), deps);
    expect(result.stale).toBe(false);
  });

  it('HEAD diferente -> stale SEM olhar porcelain (check barato primeiro)', () => {
    const deps = makeDeps({ head: 'bbbb222233334444bbbb222233334444bbbb2222' });
    const result = checkRepoStaleness(makeInput(), deps);
    expect(result.stale).toBe(true);
    expect(result.reason).toMatch(/HEAD/);
    expect(deps.gitCalls).toHaveLength(1);
    expect(deps.gitCalls[0][0]).toBe('rev-parse');
  });
});


describe('staleness - dirty files via porcelain + mtime', () => {
  it('arquivo dirty re-editado APOS o index (mtime > last_indexed_at) -> stale', () => {
    const deps = makeDeps({
      porcelain: ' M src/app.ts\n',
      mtimes: { '/repo/root/src/app.ts': INDEXED_AT_MS + 60_000 },
    });
    const result = checkRepoStaleness(makeInput(), deps);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain('src/app.ts');
  });

  it('.codegraph/ e .lionclaw/ untracked NAO marcam stale (artefatos, nao codigo)', () => {
    const deps = makeDeps({
      porcelain: '?? .codegraph/\n?? .lionclaw/manifest.json\n',
      mtimes: {
        '/repo/root/.codegraph/': INDEXED_AT_MS + 60_000,
        '/repo/root/.lionclaw/manifest.json': INDEXED_AT_MS + 60_000,
      },
    });
    const result = checkRepoStaleness(makeInput(), deps);
    expect(result.stale).toBe(false);
    expect(deps.statCalls).toEqual([]);
  });

  it('arquivo dirty SEM edicao nova (mtime < last_indexed_at) -> nao stale', () => {
    const deps = makeDeps({
      porcelain: ' M src/app.ts\n',
      mtimes: { '/repo/root/src/app.ts': INDEXED_AT_MS - 60_000 },
    });
    const result = checkRepoStaleness(makeInput(), deps);
    expect(result.stale).toBe(false);
  });

  it('conversao ISO vs epoch-ms: limiar exato (mtime == Date.parse(iso)) nao marca stale', () => {
    const deps = makeDeps({
      porcelain: ' M src/app.ts\n',
      mtimes: { '/repo/root/src/app.ts': INDEXED_AT_MS },
    });
    const result = checkRepoStaleness(makeInput(), deps);
    expect(result.stale).toBe(false);
  });

  it('arquivo deletado (stat ENOENT) -> stale (QUALQUER erro de stat = stale)', () => {
    const deps = makeDeps({
      porcelain: ' D src/gone.ts\n',
      mtimes: {}, // stat lanca ENOENT
    });
    const result = checkRepoStaleness(makeInput(), deps);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain('src/gone.ts');
  });

  it('untracked novo entra pela MESMA regra (?? + mtime novo) -> stale', () => {
    const deps = makeDeps({
      porcelain: '?? src/new-file.ts\n',
      mtimes: { '/repo/root/src/new-file.ts': INDEXED_AT_MS + 1 },
    });
    const result = checkRepoStaleness(makeInput(), deps);
    expect(result.stale).toBe(true);
  });

  it('rename (R old -> new) usa o path NOVO', () => {
    expect(parsePorcelainLine('R  src/old.ts -> src/new.ts')).toBe('src/new.ts');
    const deps = makeDeps({
      porcelain: 'R  src/old.ts -> src/new.ts\n',
      mtimes: { '/repo/root/src/new.ts': INDEXED_AT_MS + 1 },
    });
    const result = checkRepoStaleness(makeInput(), deps);
    expect(result.stale).toBe(true);
    expect(deps.statCalls).toEqual(['/repo/root/src/new.ts']);
  });
});


describe('staleness - cap de dirty files', () => {
  it('constante da spec: STALE_CHECK_MAX_DIRTY === 200', () => {
    expect(STALE_CHECK_MAX_DIRTY).toBe(200);
  });

  it('mais de 200 dirty -> stale SEM nenhum stat', () => {
    const lines = Array.from({ length: 201 }, (_, i) => ` M src/file${i}.ts`).join('\n');
    const deps = makeDeps({ porcelain: lines + '\n' });
    const result = checkRepoStaleness(makeInput(), deps);
    expect(result.stale).toBe(true);
    expect(result.reason).toMatch(/201 arquivos dirty/);
    expect(deps.statCalls).toHaveLength(0);
  });

  it('exatamente 200 dirty -> stat roda normalmente (cap e exclusivo)', () => {
    const lines = Array.from({ length: 200 }, (_, i) => ` M src/file${i}.ts`).join('\n');
    const mtimes: Record<string, number> = {};
    for (let i = 0; i < 200; i++) {
      mtimes[`/repo/root/src/file${i}.ts`] = INDEXED_AT_MS - 1000;
    }
    const deps = makeDeps({ porcelain: lines + '\n', mtimes });
    const result = checkRepoStaleness(makeInput(), deps);
    expect(result.stale).toBe(false);
    expect(deps.statCalls).toHaveLength(200);
  });
});


describe('staleness - throttle in-memory', () => {
  it('janela da spec: 5 minutos', () => {
    expect(STALE_CHECK_THROTTLE_MS).toBe(5 * 60_000);
  });

  it('< 5min: reusa o resultado SEM rodar git de novo', () => {
    const input = makeInput();
    let nowValue = 1_000_000;
    const deps = makeDeps({ porcelain: '' });
    const timedDeps = { ...deps, now: () => nowValue };

    const first = checkRepoStaleness(input, timedDeps);
    expect(first.stale).toBe(false);
    const gitCallsAfterFirst = deps.gitCalls.length;

    nowValue += STALE_CHECK_THROTTLE_MS - 1; // ainda dentro da janela
    const second = checkRepoStaleness(input, timedDeps);
    expect(second).toEqual(first);
    expect(deps.gitCalls.length).toBe(gitCallsAfterFirst); // nenhum git novo
  });

  it('>= 5min: re-checa (git roda de novo) e pode mudar de resultado', () => {
    const input = makeInput();
    let nowValue = 1_000_000;
    let head = HEAD;
    const deps = makeDeps({});
    const timedDeps: StalenessDeps = {
      execGit: (args: string[], cwd: string) => {
        if (args[0] === 'rev-parse') {
          deps.gitCalls.push(args);
          void cwd;
          return `${head}\n`;
        }
        deps.gitCalls.push(args);
        return '';
      },
      statMtimeMs: deps.statMtimeMs,
      now: () => nowValue,
    };

    expect(checkRepoStaleness(input, timedDeps).stale).toBe(false);

    head = 'cccc333344445555cccc333344445555cccc3333'; // commit novo
    nowValue += STALE_CHECK_THROTTLE_MS + 1;
    const second = checkRepoStaleness(input, timedDeps);
    expect(second.stale).toBe(true);
  });

  it('throttle e POR repo (repos diferentes nao compartilham cache)', () => {
    const depsA = makeDeps({ porcelain: '' });
    const depsB = makeDeps({ head: 'dddd444455556666dddd444455556666dddd4444' });
    const a = checkRepoStaleness(makeInput(), depsA);
    const b = checkRepoStaleness(makeInput(), depsB);
    expect(a.stale).toBe(false);
    expect(b.stale).toBe(true);
  });
});


describe('staleness - invalidacao por repo (clearStalenessForRepo)', () => {
  it('apos clear, o proximo check RECOMPUTA dentro da janela de 5min', () => {
    const input = makeInput();
    const depsStale = makeDeps({ head: 'eeee555566667777eeee555566667777eeee5555' });

    expect(checkRepoStaleness(input, depsStale).stale).toBe(true);

    const depsClean = makeDeps({ head: HEAD, porcelain: '' });
    expect(checkRepoStaleness(input, depsClean).stale).toBe(true);
    expect(depsClean.gitCalls).toHaveLength(0);

    clearStalenessForRepo(input.repositoryId);
    expect(checkRepoStaleness(input, depsClean).stale).toBe(false);
    expect(depsClean.gitCalls.length).toBeGreaterThan(0);
  });

  it('clear e POR repo: nao derruba a entrada cacheada de outro repo', () => {
    const inputA = makeInput();
    const inputB = makeInput();
    const depsB = makeDeps({ porcelain: '' });

    checkRepoStaleness(inputB, depsB);
    const gitCallsAfterFirst = depsB.gitCalls.length;

    clearStalenessForRepo(inputA.repositoryId);

    expect(checkRepoStaleness(inputB, depsB).stale).toBe(false);
    expect(depsB.gitCalls.length).toBe(gitCallsAfterFirst);
  });
});


describe('staleness - bordas', () => {
  it('git indisponivel -> nao-determinavel (stale false; NUNCA bloqueia)', () => {
    const deps = makeDeps({ gitFails: true });
    const result = checkRepoStaleness(makeInput(), deps);
    expect(result.stale).toBe(false);
    expect(result.reason).toBe('git-indisponivel');
  });

  it('sem last_indexed_at -> nada a comparar (stale false)', () => {
    const deps = makeDeps({});
    const result = checkRepoStaleness(makeInput({ lastIndexedAt: null }), deps);
    expect(result.stale).toBe(false);
  });

  it('last_indexed_at corrompido (Date.parse NaN) -> stale (CTA de update conserta)', () => {
    const deps = makeDeps({
      porcelain: ' M src/app.ts\n',
      mtimes: { '/repo/root/src/app.ts': 123 },
    });
    const result = checkRepoStaleness(makeInput({ lastIndexedAt: 'nao-e-data' }), deps);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain('last_indexed_at invalido');
  });

  it('indexed_commit null (repo sem git no momento do index) -> cai no detector de dirty', () => {
    const deps = makeDeps({
      porcelain: ' M src/app.ts\n',
      mtimes: { '/repo/root/src/app.ts': INDEXED_AT_MS + 1 },
    });
    const result = checkRepoStaleness(makeInput({ indexedCommit: null }), deps);
    expect(result.stale).toBe(true);
  });
});
