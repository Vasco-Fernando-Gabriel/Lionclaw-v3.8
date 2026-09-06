import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useErrorToastStore,
  ERROR_TOAST_AUTO_DISMISS_MS,
} from '@/stores/error-toast-store';

beforeEach(() => {
  vi.useFakeTimers();
  useErrorToastStore.getState().clearToasts();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('error-toast-store (sink universal, SB-3)', () => {
  it('AC-B7: toast LLM-QUOTA e persistente — continua visivel bem depois dos 8s', () => {
    useErrorToastStore.getState().pushError({ code: 'LLM-QUOTA' });

    let toasts = useErrorToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('Limite do provedor');
    expect(toasts[0].action).toBeTruthy();
    expect(toasts[0].persist).toBe(true);

    vi.advanceTimersByTime(ERROR_TOAST_AUTO_DISMISS_MS * 3);

    toasts = useErrorToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].code).toBe('LLM-QUOTA');
  });

  it('AC-B7 (contraste): toast NAO-persistente auto-dispensa apos 8s', () => {
    useErrorToastStore.getState().pushError({ code: 'LLM-EMPTY' });
    expect(useErrorToastStore.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(ERROR_TOAST_AUTO_DISMISS_MS - 1);
    expect(useErrorToastStore.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(useErrorToastStore.getState().toasts).toHaveLength(0);
  });

  it('AC-B7: toast persistente e dispensavel MANUALMENTE (dismissToast)', () => {
    const id = useErrorToastStore.getState().pushError({ code: 'LLM-AUTH-401' });
    expect(useErrorToastStore.getState().toasts).toHaveLength(1);

    useErrorToastStore.getState().dismissToast(id);
    expect(useErrorToastStore.getState().toasts).toHaveLength(0);
  });

  it('titulo pode ser sobrescrito com o contexto da operacao (opts.title)', () => {
    useErrorToastStore
      .getState()
      .pushError({ error: 'db is locked' }, { title: 'Falha ao apagar a conversa', source: 'chat' });

    const [toast] = useErrorToastStore.getState().toasts;
    expect(toast.title).toBe('Falha ao apagar a conversa');
    expect(toast.body).toBe('db is locked');
    expect(toast.source).toBe('chat');
  });

  it('fila e limitada: o toast mais antigo cai quando estoura o cap', () => {
    for (let i = 0; i < 7; i += 1) {
      useErrorToastStore.getState().pushError({ code: 'LLM-QUOTA', error: `erro ${i}` });
    }
    const toasts = useErrorToastStore.getState().toasts;
    expect(toasts).toHaveLength(5);
    expect(toasts[0].detail).toBe('erro 2');
    expect(toasts[4].detail).toBe('erro 6');
  });
});
