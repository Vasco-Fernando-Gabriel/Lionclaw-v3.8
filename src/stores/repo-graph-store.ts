import { create } from 'zustand';
import type {
  LocalRepositoryRecord,
  SessionRepoGraphState,
  RepoGraphStatusEvent,
  RepoGraphBadgeState,
} from '@/types/repo-graph';

export interface RepoGraphSessionSlot {
  sessionState: SessionRepoGraphState | null;
  usedInTurn: boolean;
  runtimeLimited: boolean;
  buildProgress: string;
  pending: boolean;
  consentOpen: boolean;
}

interface RepoGraphStoreState {
  repositories: LocalRepositoryRecord[];
  sessions: Record<string, RepoGraphSessionSlot>;
  pending: boolean;
  consentOpen: boolean;

  loadRepositories: () => Promise<void>;
  loadSessionState: (sessionId: string) => Promise<void>;
  addRepository: (rawPath: string) => Promise<LocalRepositoryRecord | { error: string }>;
  removeRepository: (repositoryId: string) => Promise<{ ok: true } | { error: string }>;
  attachSession: (sessionId: string, repositoryId: string) => Promise<{ ok: true } | { error: string }>;
  detachSession: (sessionId: string) => Promise<{ ok: true } | { error: string }>;
  setPromptSuppressed: (sessionId: string, suppressed: boolean) => Promise<{ ok: true } | { error: string }>;
  setGlobalPromptSuppressed: (repositoryId: string, suppressed: boolean) => Promise<{ ok: true } | { error: string }>;
  build: (repositoryId: string, sessionId?: string | null) => Promise<{ runId: string } | { error: string }>;
  update: (repositoryId: string, sessionId?: string | null) => Promise<{ runId: string } | { error: string }>;

  setConsentOpen: (open: boolean, sessionId?: string) => void;
  markUsedInTurn: (sessionId: string) => void;
  markRuntimeLimited: (sessionId: string) => void;
  resetTurnFlags: (sessionId: string) => void;

  init: () => () => void;
}

export function createRepoGraphSlot(over: Partial<RepoGraphSessionSlot> = {}): RepoGraphSessionSlot {
  return {
    sessionState: null,
    usedInTurn: false,
    runtimeLimited: false,
    buildProgress: '',
    pending: false,
    consentOpen: false,
    ...over,
  };
}

export const EMPTY_REPO_GRAPH_SLOT: RepoGraphSessionSlot = createRepoGraphSlot();

export function selectRepoGraphSession(
  state: Pick<RepoGraphStoreState, 'sessions'>,
  sessionId: string | null | undefined,
): RepoGraphSessionSlot {
  if (!sessionId) return EMPTY_REPO_GRAPH_SLOT;
  return state.sessions[sessionId] ?? EMPTY_REPO_GRAPH_SLOT;
}

export function useRepoGraphSession(sessionId: string | null | undefined): RepoGraphSessionSlot {
  return useRepoGraphStore((state) => selectRepoGraphSession(state, sessionId));
}

export function repoGraphBadgeFor(slot: RepoGraphSessionSlot): RepoGraphBadgeState {
  const { sessionState, usedInTurn, runtimeLimited } = slot;
  const repo = sessionState?.repository ?? null;
  if (!repo) return 'no-repo';
  if (repo.status === 'building' || sessionState?.activeRun) return 'building';
  if (repo.status === 'error') return 'error';
  if (repo.status === 'absent') return 'graph-absent';
  if (usedInTurn) return 'used-in-turn';
  if (runtimeLimited) return 'runtime-limited';
  if (repo.status === 'stale' || sessionState?.staleness?.stale) return 'stale';
  return 'ready';
}

export function repoGraphBuildPercentFor(slot: RepoGraphSessionSlot): number | undefined {
  const { buildProgress } = slot;
  if (!buildProgress) return undefined;
  const matches = buildProgress.match(/(\d{1,3})\s*%/g);
  if (!matches || matches.length === 0) return undefined;
  const last = matches[matches.length - 1];
  const value = parseInt(last, 10);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

export const useRepoGraphStore = create<RepoGraphStoreState>((set, get) => {
  const patchSlot = (
    sessionId: string,
    patch: Partial<RepoGraphSessionSlot> | ((slot: RepoGraphSessionSlot) => Partial<RepoGraphSessionSlot>),
  ): void => {
    set((state) => {
      const current = state.sessions[sessionId] ?? createRepoGraphSlot();
      const delta = typeof patch === 'function' ? patch(current) : patch;
      return { sessions: { ...state.sessions, [sessionId]: { ...current, ...delta } } };
    });
  };

  const withSessionPending = async <T>(sessionId: string | null | undefined, work: () => Promise<T>): Promise<T> => {
    if (sessionId) patchSlot(sessionId, { pending: true });
    else set({ pending: true });
    try {
      return await work();
    } finally {
      if (sessionId) patchSlot(sessionId, { pending: false });
      else set({ pending: false });
    }
  };

  return {
    repositories: [],
    sessions: {},
    pending: false,
    consentOpen: false,

    loadRepositories: async () => {
      try {
        const result = await window.lionclaw.repoGraph.list();
        if (Array.isArray(result)) set({ repositories: result });
      } catch (err) {
        console.warn('[repo-graph-store] loadRepositories failed', err);
      }
    },

    loadSessionState: async (sessionId: string) => {
      try {
        const result = await window.lionclaw.repoGraph.getSessionState(sessionId);
        if ('error' in result) {
          console.warn('[repo-graph-store] get-session-state error', result.error);
          return;
        }
        patchSlot(sessionId, {
          sessionState: result,
          usedInTurn: false,
          runtimeLimited: false,
          buildProgress: '',
        });
      } catch (err) {
        console.warn('[repo-graph-store] loadSessionState failed', { sessionId, err });
      }
    },

    addRepository: async (rawPath: string) =>
      withSessionPending(null, async () => {
        try {
          const result = await window.lionclaw.repoGraph.addRepository(rawPath);
          if (!('error' in result)) await get().loadRepositories();
          return result;
        } catch (err) {
          return { error: (err as Error).message };
        }
      }),

    removeRepository: async (repositoryId: string) =>
      withSessionPending(null, async () => {
        try {
          const result = await window.lionclaw.repoGraph.removeRepository(repositoryId);
          if ('ok' in result) {
            await get().loadRepositories();
            const affected = Object.entries(get().sessions)
              .filter(([, slot]) => slot.sessionState?.repository?.id === repositoryId)
              .map(([id]) => id);
            await Promise.all(affected.map((id) => get().loadSessionState(id)));
          }
          return result;
        } catch (err) {
          return { error: (err as Error).message };
        }
      }),

    attachSession: async (sessionId: string, repositoryId: string) =>
      withSessionPending(sessionId, async () => {
        try {
          const result = await window.lionclaw.repoGraph.attachSession(sessionId, repositoryId);
          if ('ok' in result) await get().loadSessionState(sessionId);
          return result;
        } catch (err) {
          return { error: (err as Error).message };
        }
      }),

    detachSession: async (sessionId: string) =>
      withSessionPending(sessionId, async () => {
        try {
          const result = await window.lionclaw.repoGraph.detachSession(sessionId);
          if ('ok' in result) await get().loadSessionState(sessionId);
          return result;
        } catch (err) {
          return { error: (err as Error).message };
        }
      }),

    setPromptSuppressed: async (sessionId: string, suppressed: boolean) => {
      try {
        const result = await window.lionclaw.repoGraph.setPromptSuppressed(sessionId, suppressed);
        if ('ok' in result) await get().loadSessionState(sessionId);
        return result;
      } catch (err) {
        return { error: (err as Error).message };
      }
    },

    setGlobalPromptSuppressed: async (repositoryId: string, suppressed: boolean) => {
      try {
        const result = await window.lionclaw.repoGraph.setGlobalPromptSuppressed(repositoryId, suppressed);
        if ('ok' in result) {
          await get().loadRepositories();
          const affected = Object.entries(get().sessions)
            .filter(([, slot]) => slot.sessionState?.repository?.id === repositoryId)
            .map(([id]) => id);
          await Promise.all(affected.map((id) => get().loadSessionState(id)));
        }
        return result;
      } catch (err) {
        return { error: (err as Error).message };
      }
    },

    build: async (repositoryId: string, sessionId?: string | null) =>
      withSessionPending(sessionId, async () => {
        if (sessionId) patchSlot(sessionId, { buildProgress: '' });
        try {
          return await window.lionclaw.repoGraph.build(repositoryId, sessionId ?? null);
        } catch (err) {
          return { error: (err as Error).message };
        }
      }),

    update: async (repositoryId: string, sessionId?: string | null) =>
      withSessionPending(sessionId, async () => {
        if (sessionId) patchSlot(sessionId, { buildProgress: '' });
        try {
          return await window.lionclaw.repoGraph.update(repositoryId, sessionId ?? null);
        } catch (err) {
          return { error: (err as Error).message };
        }
      }),

    setConsentOpen: (open: boolean, sessionId?: string) => {
      if (sessionId) patchSlot(sessionId, { consentOpen: open });
      else set({ consentOpen: open });
    },
    markUsedInTurn: (sessionId) => patchSlot(sessionId, { usedInTurn: true }),
    markRuntimeLimited: (sessionId) => patchSlot(sessionId, { runtimeLimited: true }),
    resetTurnFlags: (sessionId) => patchSlot(sessionId, { usedInTurn: false, runtimeLimited: false }),

    init: () => {
      const unsub = window.lionclaw.repoGraph.onStatus((event: RepoGraphStatusEvent) => {
        const affected = Object.entries(get().sessions).filter(
          ([, slot]) => slot.sessionState?.repository?.id === event.repositoryId,
        );
        if (affected.length === 0) {
          void get().loadRepositories();
          return;
        }
        for (const [sessionId, slot] of affected) {
          if (event.buildProgress) {
            patchSlot(sessionId, { buildProgress: slot.buildProgress + event.buildProgress });
          }
          if (event.runStatus && event.runStatus !== 'running') {
            void get().loadSessionState(sessionId);
            continue;
          }
          patchSlot(sessionId, (current) =>
            current.sessionState?.repository
              ? {
                  sessionState: {
                    ...current.sessionState,
                    repository: { ...current.sessionState.repository, status: event.status },
                  },
                }
              : {},
          );
        }
        if (
          affected.some(([, slot]) => Boolean(slot.sessionState)) &&
          event.runStatus &&
          event.runStatus !== 'running'
        ) {
          void get().loadRepositories();
        }
      });
      return unsub;
    },
  };
});
