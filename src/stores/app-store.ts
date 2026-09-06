import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type Page = 'chat' | 'agents' | 'skills' | 'mcp' | 'scheduler' | 'tasks' | 'kanban' | 'knowledge' | 'memory' | 'logs' | 'settings' | 'rules' | 'usage' | 'permissions' | 'vault' | 'harness' | 'pipeline' | 'dynamic-workflow' | 'repositories';

const VALID_PAGES: readonly Page[] = ['chat', 'agents', 'skills', 'mcp', 'scheduler', 'tasks', 'kanban', 'knowledge', 'memory', 'logs', 'settings', 'rules', 'usage', 'permissions', 'vault', 'harness', 'pipeline', 'dynamic-workflow', 'repositories'];

interface AppState {
  currentPage: Page;
  sidebarCollapsed: boolean;
  setPage: (page: Page) => void;
  toggleSidebar: () => void;
  pendingChatMessage: string | null;
  pendingChatAgent: string | null;
  pendingChatAwaitRepoReady: string | null;
  pendingChatTargetSessionId: string | null;
  setPendingChat: (
    message: string,
    agentId?: string,
    handoff?: { awaitRepoReady?: string; targetSessionId?: string },
  ) => void;
  clearPendingChat: () => void;
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
      pendingChatMessage: null,
      pendingChatAgent: null,
      pendingChatAwaitRepoReady: null,
      pendingChatTargetSessionId: null,
      setPendingChat: (message, agentId, handoff) => set({
        pendingChatMessage: message,
        pendingChatAgent: agentId || null,
        pendingChatAwaitRepoReady: handoff?.awaitRepoReady ?? null,
        pendingChatTargetSessionId: handoff?.targetSessionId ?? null,
      }),
      clearPendingChat: () => set({
        pendingChatMessage: null,
        pendingChatAgent: null,
        pendingChatAwaitRepoReady: null,
        pendingChatTargetSessionId: null,
      }),
      viewingTaskSession: null,
      viewingTaskRunId: null,
      viewingTaskName: null,
      openTaskSession: (sessionId, runId, taskName) => set({
        viewingTaskSession: sessionId,
        viewingTaskRunId: runId,
        viewingTaskName: taskName,
      }),
      closeTaskSession: () => set({
        viewingTaskSession: null,
        viewingTaskRunId: null,
        viewingTaskName: null,
      }),
    }),
    {
      name: 'lionclaw-app',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      migrate: (persistedState) => {
        const state = (persistedState ?? {}) as { currentPage?: string; sidebarCollapsed?: boolean };
        const page: Page = state.currentPage === 'channels'
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
