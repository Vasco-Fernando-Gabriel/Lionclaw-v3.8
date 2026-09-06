import { create } from 'zustand';
import type {
  LocalRepositoryRecord,
  SessionRepoGraphState,
  RepoGraphStatusEvent,
  RepoGraphBadgeState,
} from '@/types/repo-graph';


interface RepoGraphStoreState {
  repositories: LocalRepositoryRecord[];
  sessionState: SessionRepoGraphState | null;
  activeSessionId: string | null;
  usedInTurn: boolean;
  runtimeLimited: boolean;
  buildProgress: string;
  pending: boolean;
  consentOpen: boolean;

  loadRepositories: () => Promise<void>;
  loadSessionState: (sessionId: string) => Promise<void>;
  addRepository: (rawPath: string) => Promise<LocalRepositoryRecord | { error: string }>;
  removeRepository: (repositoryId: string) => Promise<{ ok: true } | { error: string }>;
  attachSession: (
    sessionId: string,
    repositoryId: string,
  ) => Promise<{ ok: true } | { error: string }>;
  detachSession: (sessionId: string) => Promise<{ ok: true } | { error: string }>;
  setPromptSuppressed: (
    sessionId: string,
    suppressed: boolean,
  ) => Promise<{ ok: true } | { error: string }>;
  setGlobalPromptSuppressed: (
    repositoryId: string,
    suppressed: boolean,
  ) => Promise<{ ok: true } | { error: string }>;
  build: (
    repositoryId: string,
    sessionId?: string | null,
  ) => Promise<{ runId: string } | { error: string }>;
  update: (
    repositoryId: string,
    sessionId?: string | null,
  ) => Promise<{ runId: string } | { error: string }>;

  setConsentOpen: (open: boolean) => void;
  markUsedInTurn: () => void;
  markRuntimeLimited: () => void;
  resetTurnFlags: () => void;

  badgeState: () => RepoGraphBadgeState;

  buildPercent: () => number | undefined;

  init: () => () => void;
}

export const useRepoGraphStore = create<RepoGraphStoreState>((set, get) => ({
  repositories: [],
  sessionState: null,
  activeSessionId: null,
  usedInTurn: false,
  runtimeLimited: false,
  buildProgress: '',
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
      set({
        sessionState: result,
        activeSessionId: sessionId,
        usedInTurn: false,
        runtimeLimited: false,
        buildProgress: '',
      });
    } catch (err) {
      console.warn('[repo-graph-store] loadSessionState failed', { sessionId, err });
    }
  },

  addRepository: async (rawPath: string) => {
    set({ pending: true });
    try {
      const result = await window.lionclaw.repoGraph.addRepository(rawPath);
      if (!('error' in result)) await get().loadRepositories();
      return result;
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      set({ pending: false });
    }
  },

  removeRepository: async (repositoryId: string) => {
    set({ pending: true });
    try {
      const result = await window.lionclaw.repoGraph.removeRepository(repositoryId);
      if ('ok' in result) {
        await get().loadRepositories();
        const { sessionState, activeSessionId } = get();
        if (sessionState?.repository?.id === repositoryId && activeSessionId) {
          await get().loadSessionState(activeSessionId);
        }
      }
      return result;
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      set({ pending: false });
    }
  },

  attachSession: async (sessionId: string, repositoryId: string) => {
    set({ pending: true });
    try {
      const result = await window.lionclaw.repoGraph.attachSession(sessionId, repositoryId);
      if ('ok' in result) await get().loadSessionState(sessionId);
      return result;
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      set({ pending: false });
    }
  },

  detachSession: async (sessionId: string) => {
    set({ pending: true });
    try {
      const result = await window.lionclaw.repoGraph.detachSession(sessionId);
      if ('ok' in result) await get().loadSessionState(sessionId);
      return result;
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      set({ pending: false });
    }
  },

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
      const result = await window.lionclaw.repoGraph.setGlobalPromptSuppressed(
        repositoryId,
        suppressed,
      );
      if ('ok' in result) {
        await get().loadRepositories();
        const { activeSessionId } = get();
        if (activeSessionId) await get().loadSessionState(activeSessionId);
      }
      return result;
    } catch (err) {
      return { error: (err as Error).message };
    }
  },

  build: async (repositoryId: string, sessionId?: string | null) => {
    set({ pending: true, buildProgress: '' });
    try {
      return await window.lionclaw.repoGraph.build(repositoryId, sessionId ?? null);
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      set({ pending: false });
    }
  },

  update: async (repositoryId: string, sessionId?: string | null) => {
    set({ pending: true, buildProgress: '' });
    try {
      return await window.lionclaw.repoGraph.update(repositoryId, sessionId ?? null);
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      set({ pending: false });
    }
  },

  setConsentOpen: (open: boolean) => set({ consentOpen: open }),
  markUsedInTurn: () => set({ usedInTurn: true }),
  markRuntimeLimited: () => set({ runtimeLimited: true }),
  resetTurnFlags: () => set({ usedInTurn: false, runtimeLimited: false }),

  badgeState: (): RepoGraphBadgeState => {
    const { sessionState, usedInTurn, runtimeLimited } = get();
    const repo = sessionState?.repository ?? null;
    if (!repo) return 'no-repo';
    if (repo.status === 'building' || sessionState?.activeRun) return 'building';
    if (repo.status === 'error') return 'error';
    if (repo.status === 'absent') return 'graph-absent';
    if (usedInTurn) return 'used-in-turn';
    if (runtimeLimited) return 'runtime-limited';
    if (repo.status === 'stale' || sessionState?.staleness?.stale) return 'stale';
    return 'ready';
  },

  buildPercent: (): number | undefined => {
    const { buildProgress } = get();
    if (!buildProgress) return undefined;
    const matches = buildProgress.match(/(\d{1,3})\s*%/g);
    if (!matches || matches.length === 0) return undefined;
    const last = matches[matches.length - 1];
    const value = parseInt(last, 10);
    if (!Number.isFinite(value)) return undefined;
    return Math.min(100, Math.max(0, value));
  },

  init: () => {
    const unsub = window.lionclaw.repoGraph.onStatus((event: RepoGraphStatusEvent) => {
      const { sessionState, activeSessionId } = get();
      if (!sessionState?.repository || sessionState.repository.id !== event.repositoryId) {
        void get().loadRepositories();
        return;
      }
      if (event.buildProgress) {
        set({ buildProgress: get().buildProgress + event.buildProgress });
      }
      if (event.runStatus && event.runStatus !== 'running' && activeSessionId) {
        void get().loadSessionState(activeSessionId);
        void get().loadRepositories();
        return;
      }
      set({
        sessionState: {
          ...sessionState,
          repository: { ...sessionState.repository, status: event.status },
        },
      });
    });
    return unsub;
  },
}));
