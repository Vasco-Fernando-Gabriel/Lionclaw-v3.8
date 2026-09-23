import { create } from 'zustand';
import { initTerminalSessionsState, terminalSessionsReducer, type TerminalTab } from '@/lib/terminal-sessions-reducer';

export const TERMINAL_MIN_HEIGHT = 72;
export const TERMINAL_DEFAULT_HEIGHT = 220;
export const TERMINAL_MAX_TABS = 8;

export function terminalMaxHeight(viewportHeight: number): number {
  return Math.max(TERMINAL_MIN_HEIGHT, Math.min(680, viewportHeight - 240));
}

interface TerminalStoreState {
  open: boolean;
  everOpened: boolean;
  height: number;
  sessions: TerminalTab[];
  activeId: string;
  nextNum: number;
  toggle: () => void;
  setHeight: (height: number) => void;
  clampHeightToViewport: (viewportHeight: number) => void;
  addSession: () => void;
  removeSession: (id: string) => void;
  setActive: (id: string) => void;
}

const initial = initTerminalSessionsState();

export const useTerminalStore = create<TerminalStoreState>((set, get) => ({
  open: false,
  everOpened: false,
  height: TERMINAL_DEFAULT_HEIGHT,
  sessions: initial.sessions,
  activeId: initial.activeId,
  nextNum: initial.nextNum,

  toggle: () => set((s) => ({ open: !s.open, everOpened: s.everOpened || !s.open })),

  setHeight: (height) => set({ height }),

  clampHeightToViewport: (viewportHeight) => {
    const max = terminalMaxHeight(viewportHeight);
    if (get().height > max) set({ height: max });
  },

  addSession: () => {
    const { sessions, activeId, nextNum } = get();
    if (sessions.length >= TERMINAL_MAX_TABS) return;
    set(terminalSessionsReducer({ sessions, activeId, nextNum }, { type: 'add' }));
  },

  removeSession: (id) => {
    const { sessions, activeId, nextNum } = get();
    set(terminalSessionsReducer({ sessions, activeId, nextNum }, { type: 'remove', id }));
  },

  setActive: (id) => {
    const { sessions, activeId, nextNum } = get();
    set(terminalSessionsReducer({ sessions, activeId, nextNum }, { type: 'setActive', id }));
  },
}));
