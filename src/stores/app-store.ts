import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type Page =
  | 'chat'
  | 'agents'
  | 'skills'
  | 'mcp'
  | 'scheduler'
  | 'tasks'
  | 'kanban'
  | 'knowledge'
  | 'memory'
  | 'logs'
  | 'settings'
  | 'rules'
  | 'usage'
  | 'permissions'
  | 'vault'
  | 'harness'
  | 'pipeline'
  | 'dynamic-workflow'
  | 'repositories';

const VALID_PAGES: readonly Page[] = [
  'chat',
  'agents',
  'skills',
  'mcp',
  'scheduler',
  'tasks',
  'kanban',
  'knowledge',
  'memory',
  'logs',
  'settings',
  'rules',
  'usage',
  'permissions',
  'vault',
  'harness',
  'pipeline',
  'dynamic-workflow',
  'repositories',
];

export interface PendingChat {
  message: string;
  agentId: string | null;
  awaitRepoReady: string | null;
  targetSessionId: string | null;
}

interface AppState {
  currentPage: Page;
  sidebarCollapsed: boolean;
  setPage: (page: Page) => void;
  toggleSidebar: () => void;
  pendingChatByTarget: Record<string, PendingChat>;
  setPendingChat: (
    message: string,
    agentId?: string,
    handoff?: { awaitRepoReady?: string; targetSessionId?: string },
  ) => void;
  clearPendingChat: (target: string) => void;
  viewingTaskSession: string | null;
  viewingTaskRunId: number | null;
  viewingTaskName: string | null;
  openTaskSession: (sessionId: string, runId: number, taskName: string) => void;
  closeTaskSession: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      currentPage: 'chat',
      sidebarCollapsed: false,
      setPage: (page) => set({ currentPage: page }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      pendingChatByTarget: {},
      setPendingChat: (message, agentId, handoff) =>
        set((state) => ({
          pendingChatByTarget: {
            ...state.pendingChatByTarget,
            [handoff?.targetSessionId ?? 'visible']: {
              message,
              agentId: agentId || null,
              awaitRepoReady: handoff?.awaitRepoReady ?? null,
              targetSessionId: handoff?.targetSessionId ?? null,
            },
          },
        })),
      clearPendingChat: (target) =>
        set((state) => {
          const pendingChatByTarget = { ...state.pendingChatByTarget };
          delete pendingChatByTarget[target];
          return { pendingChatByTarget };
        }),
      viewingTaskSession: null,
      viewingTaskRunId: null,
      viewingTaskName: null,
      openTaskSession: (sessionId, runId, taskName) =>
        set({
          viewingTaskSession: sessionId,
          viewingTaskRunId: runId,
          viewingTaskName: taskName,
        }),
      closeTaskSession: () =>
        set({
          viewingTaskSession: null,
          viewingTaskRunId: null,
          viewingTaskName: null,
        }),
    }),
    {
      name: 'lionclaw-app',
      storage: createJSONStorage(() => localStorage),
      version: 2,
      migrate: (persistedState) => {
        const state = (persistedState ?? {}) as { currentPage?: string; sidebarCollapsed?: boolean };
        const page: Page =
          state.currentPage === 'channels'
            ? 'settings'
            : VALID_PAGES.includes(state.currentPage as Page)
              ? (state.currentPage as Page)
              : 'chat';
        return { currentPage: page, sidebarCollapsed: state.sidebarCollapsed ?? false };
      },
      partialize: (state) => ({
        currentPage: state.currentPage,
        sidebarCollapsed: state.sidebarCollapsed,
      }),
    },
  ),
);
