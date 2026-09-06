// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatErrorBanner } from '../ChatErrorBanner';
import type { StreamChunk } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type StreamCallback = (chunk: StreamChunk) => void;

let streamCallback: StreamCallback | null = null;
let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  streamCallback = null;
  (window as unknown as Record<string, unknown>).lionclaw = {
    chat: {
      onStream: (cb: StreamCallback) => {
        streamCallback = cb;
        return () => {
          streamCallback = null;
        };
      },
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  const r = root;
  if (r) {
    act(() => {
      r.unmount();
    });
    root = null;
  }
  container.remove();
  vi.useRealTimers();
});

function mount() {
  root = createRoot(container);
  act(() => {
    root?.render(<ChatErrorBanner />);
  });
}

function emit(chunk: StreamChunk) {
  act(() => {
    streamCallback?.(chunk);
  });
}

function banner(): HTMLElement | null {
  return container.querySelector('[data-testid="chat-error-banner"]');
}

describe('ChatErrorBanner (SB-3)', () => {
  it('AC-B7: chunk error LLM-QUOTA mostra titulo/acao traduzidos e PERSISTE (nao some em 8s)', () => {
    mount();
    expect(banner()).toBeNull();

    emit({ type: 'error', code: 'LLM-QUOTA', error: 'Cota ou creditos do provider esgotados.' });

    const el = banner();
    expect(el).not.toBeNull();
    expect(el!.dataset.code).toBe('LLM-QUOTA');
    expect(el!.dataset.persist).toBe('true');
    expect(el!.textContent).toContain('Limite do provedor');
    expect(el!.textContent).toContain('billing');

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(banner()).not.toBeNull();
  });

  it('AC-B7: banner persistente e dispensavel manualmente (botao X)', () => {
    mount();
    emit({ type: 'error', code: 'LLM-QUOTA' });
    expect(banner()).not.toBeNull();

    const dismiss = container.querySelector<HTMLButtonElement>('button[aria-label="Dispensar erro"]');
    expect(dismiss).not.toBeNull();
    act(() => {
      dismiss!.click();
    });
    expect(banner()).toBeNull();
  });

  it('AC-B7 (contraste): erro NAO-persistente auto-dispensa em 8s (paridade com o antigo)', () => {
    mount();
    emit({ type: 'error', error: 'erro qualquer nao classificavel' });
    expect(banner()).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(banner()).toBeNull();
  });

  it('AC-B9b: chunk LLM-EMPTY mostra o fallback "O agente terminou sem resposta"', () => {
    mount();
    emit({ type: 'error', code: 'LLM-EMPTY', error: 'O agente terminou sem resposta.' });

    const el = banner();
    expect(el).not.toBeNull();
    expect(el!.dataset.code).toBe('LLM-EMPTY');
    expect(el!.textContent).toContain('O agente terminou sem resposta');
  });

  it('AC-B9c: turno vazio LEGITIMO (so text/done, sem chunk de erro) NAO gera alarme falso', () => {
    mount();
    emit({ type: 'text', content: '' });
    emit({ type: 'done', sessionId: 's1' });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(banner()).toBeNull();
  });

  it('done de turno bem-sucedido limpa banner NAO-persistente antigo (persistente fica)', () => {
    mount();
    emit({ type: 'error', code: 'LLM-NET' });
    expect(banner()).not.toBeNull();
    emit({ type: 'done', sessionId: 's1' });
    expect(banner()).toBeNull();

    emit({ type: 'error', code: 'LLM-QUOTA' });
    emit({ type: 'done', sessionId: 's1' });
    expect(banner()).not.toBeNull();
  });
});
