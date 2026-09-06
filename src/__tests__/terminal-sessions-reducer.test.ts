import { describe, it, expect } from 'vitest';
import {
  terminalSessionsReducer,
  initTerminalSessionsState,
  type TerminalSessionsAction,
} from '@/lib/terminal-sessions-reducer';

const add: TerminalSessionsAction = { type: 'add' };
const reset: TerminalSessionsAction = { type: 'reset' };
const setActive = (id: string): TerminalSessionsAction => ({ type: 'setActive', id });
const remove = (id: string): TerminalSessionsAction => ({ type: 'remove', id });

describe('terminalSessionsReducer', () => {
  it('init: 1 aba "Terminal 1" ativa', () => {
    const s = initTerminalSessionsState();
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0].title).toBe('Terminal 1');
    expect(s.activeId).toBe(s.sessions[0].id);
    expect(s.nextNum).toBe(2);
  });

  it('add: nova aba vira ativa e o titulo incrementa', () => {
    let s = initTerminalSessionsState();
    s = terminalSessionsReducer(s, add);
    expect(s.sessions).toHaveLength(2);
    expect(s.sessions[1].title).toBe('Terminal 2');
    expect(s.activeId).toBe(s.sessions[1].id);
    s = terminalSessionsReducer(s, add);
    expect(s.sessions[2].title).toBe('Terminal 3');
    expect(s.nextNum).toBe(4);
  });

  it('setActive: troca a ativa; id inexistente e no-op (mesma referencia)', () => {
    let s = initTerminalSessionsState();
    s = terminalSessionsReducer(s, add);
    const first = s.sessions[0].id;
    s = terminalSessionsReducer(s, setActive(first));
    expect(s.activeId).toBe(first);
    const before = s;
    s = terminalSessionsReducer(s, setActive('nao-existe'));
    expect(s).toBe(before);
  });

  it('remove aba NAO-ativa: ativa inalterada', () => {
    let s = initTerminalSessionsState();
    s = terminalSessionsReducer(s, add); // [T1, T2], ativa T2
    const t1 = s.sessions[0].id;
    const activeBefore = s.activeId;
    s = terminalSessionsReducer(s, remove(t1));
    expect(s.sessions).toHaveLength(1);
    expect(s.activeId).toBe(activeBefore);
  });

  it('remove aba ATIVA: reassina para o vizinho (min(idx, len-1))', () => {
    let s = initTerminalSessionsState();
    s = terminalSessionsReducer(s, add);
    s = terminalSessionsReducer(s, add); // [T1, T2, T3]
    const [t1, t2, t3] = s.sessions.map((x) => x.id);
    s = terminalSessionsReducer(s, setActive(t2));
    s = terminalSessionsReducer(s, remove(t2));
    expect(s.sessions.map((x) => x.id)).toEqual([t1, t3]);
    expect(s.activeId).toBe(t3);
  });

  it('remove a ULTIMA aba: volta a 1 aba NOVA (regra LionCode, sem estado vazio)', () => {
    let s = initTerminalSessionsState();
    const only = s.sessions[0].id;
    s = terminalSessionsReducer(s, remove(only));
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0].id).not.toBe(only);
    expect(s.activeId).toBe(s.sessions[0].id);
  });

  it('remove id inexistente: no-op (mesma referencia)', () => {
    const s = initTerminalSessionsState();
    expect(terminalSessionsReducer(s, remove('nao-existe'))).toBe(s);
  });

  it('reset: descarta tudo e volta ao estado inicial', () => {
    let s = initTerminalSessionsState();
    s = terminalSessionsReducer(s, add);
    s = terminalSessionsReducer(s, add);
    s = terminalSessionsReducer(s, reset);
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0].title).toBe('Terminal 1');
    expect(s.nextNum).toBe(2);
  });
});
