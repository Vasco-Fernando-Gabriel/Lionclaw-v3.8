export interface TerminalTab {
  id: string;
  title: string;
}

export interface TerminalSessionsState {
  sessions: TerminalTab[];
  activeId: string;
  nextNum: number;
}

export type TerminalSessionsAction =
  { type: 'reset' } | { type: 'add' } | { type: 'remove'; id: string } | { type: 'setActive'; id: string };

function uuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

function makeTab(num: number): TerminalTab {
  return { id: uuid(), title: `Terminal ${num}` };
}

export function initTerminalSessionsState(): TerminalSessionsState {
  const first = makeTab(1);
  return { sessions: [first], activeId: first.id, nextNum: 2 };
}

export function terminalSessionsReducer(
  state: TerminalSessionsState,
  action: TerminalSessionsAction,
): TerminalSessionsState {
  switch (action.type) {
    case 'reset':
      return initTerminalSessionsState();
    case 'add': {
      const tab = makeTab(state.nextNum);
      return {
        sessions: [...state.sessions, tab],
        activeId: tab.id,
        nextNum: state.nextNum + 1,
      };
    }
    case 'remove': {
      const idx = state.sessions.findIndex((s) => s.id === action.id);
      if (idx === -1) return state;
      const remaining = state.sessions.filter((s) => s.id !== action.id);
      if (remaining.length === 0) return initTerminalSessionsState();
      let activeId = state.activeId;
      if (activeId === action.id) {
        activeId = remaining[Math.min(idx, remaining.length - 1)].id;
      }
      return { ...state, sessions: remaining, activeId };
    }
    case 'setActive':
      return state.sessions.some((s) => s.id === action.id) ? { ...state, activeId: action.id } : state;
    default:
      return state;
  }
}
