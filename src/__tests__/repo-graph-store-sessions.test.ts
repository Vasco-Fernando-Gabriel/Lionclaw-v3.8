import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { LocalRepositoryRecord, RepoGraphStatusEvent, SessionRepoGraphState } from '@/types/repo-graph';

let statusListener: ((event: RepoGraphStatusEvent) => void) | null = null;
let sessionStates: Record<string, SessionRepoGraphState> = {};
const getSessionStateCalls: string[] = [];

function repo(id: string, status: LocalRepositoryRecord['status']): LocalRepositoryRecord {
  return {
    id,
    name: id,
    canonicalRootPath: `/repos/${id}`,
    status,
  } as LocalRepositoryRecord;
}

function sessionState(sessionId: string, repository: LocalRepositoryRecord | null): SessionRepoGraphState {
  return { sessionId, repository, attach: null, staleness: null, activeRun: null };
}

beforeAll(() => {
  (global as unknown as Record<string, unknown>).window = {
    lionclaw: {
      repoGraph: {
        list: async () => [],
        getSessionState: async (sessionId: string) => {
          getSessionStateCalls.push(sessionId);
          return sessionStates[sessionId] ?? { error: 'nao encontrada' };
        },
        attachSession: async () => ({ ok: true }),
        detachSession: async () => ({ ok: true }),
        build: async () => ({ runId: 'run-1' }),
        update: async () => ({ runId: 'run-2' }),
        onStatus: (cb: (event: RepoGraphStatusEvent) => void) => {
          statusListener = cb;
          return () => {
            statusListener = null;
          };
        },
      },
    },
  };
});

async function getStore() {
  return import('@/stores/repo-graph-store');
}

beforeEach(async () => {
  const { useRepoGraphStore } = await getStore();
  statusListener = null;
  sessionStates = {};
  getSessionStateCalls.length = 0;
  useRepoGraphStore.setState({ repositories: [], sessions: {}, pending: false, consentOpen: false });
});

describe('repo-graph-store por sessao (10.1)', () => {
  it('loadSessionState guarda o estado na sessao certa; flags de turno sao por sessao', async () => {
    const { useRepoGraphStore, selectRepoGraphSession, repoGraphBadgeFor } = await getStore();
    sessionStates.a = sessionState('a', repo('r1', 'ready'));
    sessionStates.b = sessionState('b', repo('r2', 'absent'));

    await useRepoGraphStore.getState().loadSessionState('a');
    await useRepoGraphStore.getState().loadSessionState('b');

    const state = useRepoGraphStore.getState();
    expect(selectRepoGraphSession(state, 'a').sessionState?.repository?.id).toBe('r1');
    expect(selectRepoGraphSession(state, 'b').sessionState?.repository?.id).toBe('r2');
    expect(repoGraphBadgeFor(selectRepoGraphSession(state, 'a'))).toBe('ready');
    expect(repoGraphBadgeFor(selectRepoGraphSession(state, 'b'))).toBe('graph-absent');

    useRepoGraphStore.getState().markUsedInTurn('a');
    useRepoGraphStore.getState().markRuntimeLimited('b');
    expect(repoGraphBadgeFor(selectRepoGraphSession(useRepoGraphStore.getState(), 'a'))).toBe('used-in-turn');
    expect(selectRepoGraphSession(useRepoGraphStore.getState(), 'b').runtimeLimited).toBe(true);
    expect(selectRepoGraphSession(useRepoGraphStore.getState(), 'b').usedInTurn).toBe(false);

    useRepoGraphStore.getState().resetTurnFlags('a');
    expect(repoGraphBadgeFor(selectRepoGraphSession(useRepoGraphStore.getState(), 'a'))).toBe('ready');
    expect(selectRepoGraphSession(useRepoGraphStore.getState(), 'b').runtimeLimited).toBe(true);
  });

  it('consentOpen e pending por sessao; sem sessionId caem no global (pagina Pipeline)', async () => {
    const { useRepoGraphStore, selectRepoGraphSession } = await getStore();
    useRepoGraphStore.getState().setConsentOpen(true, 'a');
    expect(selectRepoGraphSession(useRepoGraphStore.getState(), 'a').consentOpen).toBe(true);
    expect(selectRepoGraphSession(useRepoGraphStore.getState(), 'b').consentOpen).toBe(false);
    expect(useRepoGraphStore.getState().consentOpen).toBe(false);

    useRepoGraphStore.getState().setConsentOpen(true);
    expect(useRepoGraphStore.getState().consentOpen).toBe(true);

    sessionStates.a = sessionState('a', repo('r1', 'ready'));
    const pendingDuring: boolean[] = [];
    const w = (global as unknown as { window: { lionclaw: { repoGraph: Record<string, unknown> } } }).window;
    w.lionclaw.repoGraph.attachSession = async () => {
      pendingDuring.push(selectRepoGraphSession(useRepoGraphStore.getState(), 'a').pending);
      pendingDuring.push(selectRepoGraphSession(useRepoGraphStore.getState(), 'b').pending);
      return { ok: true };
    };
    await useRepoGraphStore.getState().attachSession('a', 'r1');
    expect(pendingDuring).toEqual([true, false]);
    expect(selectRepoGraphSession(useRepoGraphStore.getState(), 'a').pending).toBe(false);
  });

  it('onStatus atualiza so as sessoes cujo repositorio casa com o evento; buildProgress por sessao', async () => {
    const { useRepoGraphStore, selectRepoGraphSession, repoGraphBuildPercentFor } = await getStore();
    sessionStates.a = sessionState('a', repo('r1', 'absent'));
    sessionStates.b = sessionState('b', repo('r2', 'ready'));
    await useRepoGraphStore.getState().loadSessionState('a');
    await useRepoGraphStore.getState().loadSessionState('b');
    const cleanup = useRepoGraphStore.getState().init();
    expect(statusListener).not.toBeNull();

    statusListener!({
      repositoryId: 'r1',
      sessionId: 'a',
      status: 'building',
      runStatus: 'running',
      buildProgress: '40%',
    });

    expect(selectRepoGraphSession(useRepoGraphStore.getState(), 'a').sessionState?.repository?.status).toBe('building');
    expect(repoGraphBuildPercentFor(selectRepoGraphSession(useRepoGraphStore.getState(), 'a'))).toBe(40);
    expect(selectRepoGraphSession(useRepoGraphStore.getState(), 'b').sessionState?.repository?.status).toBe('ready');
    expect(repoGraphBuildPercentFor(selectRepoGraphSession(useRepoGraphStore.getState(), 'b'))).toBeUndefined();

    sessionStates.a = sessionState('a', repo('r1', 'ready'));
    getSessionStateCalls.length = 0;
    statusListener!({ repositoryId: 'r1', sessionId: 'a', status: 'ready', runStatus: 'done' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getSessionStateCalls).toEqual(['a']);
    expect(selectRepoGraphSession(useRepoGraphStore.getState(), 'a').sessionState?.repository?.status).toBe('ready');
    cleanup();
    expect(statusListener).toBeNull();
  });
});
