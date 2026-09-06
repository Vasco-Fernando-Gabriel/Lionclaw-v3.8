/**
 * @vitest-environment jsdom
 *
 * Fit guard do XtermView (SPEC terminal-chat, edge case "oculto via CSS"):
 * com o dock invisivel o container tem dimensao ZERO e NENHUM
 * terminal:resize pode ser enviado (mandaria 1x1 pro shell). Ao ficar
 * visivel, o refit dispara com as dimensoes reais do xterm.
 *
 * xterm/fit sao MOCKADOS (jsdom nao faz layout real); o alvo do teste e a
 * logica de guarda do componente, nao o xterm em si.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const fitMock = vi.fn();
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 120;
    rows = 32;
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    open = vi.fn();
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    hasSelection = () => false;
    getSelection = () => '';
    clearSelection = vi.fn();
    onData = () => ({ dispose: vi.fn() });
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = fitMock;
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { XtermView } from '@/components/chat/XtermView';

const terminalApi = {
  open: vi.fn(async () => ({ ok: true as const })),
  write: vi.fn(async () => undefined),
  resize: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  onData: vi.fn(() => () => undefined),
  onExit: vi.fn(() => () => undefined),
};

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    FakeResizeObserver.instances.push(this);
  }
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  trigger(): void {
    this.cb([], this as unknown as ResizeObserver);
  }
}

function flushRaf(): void {
  rafCallbacks.splice(0).forEach((cb) => cb(0));
}
const rafCallbacks: FrameRequestCallback[] = [];

describe('XtermView fit guard', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    FakeResizeObserver.instances.length = 0;
    rafCallbacks.length = 0;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    Object.defineProperty(window, 'lionclaw', {
      configurable: true,
      value: { terminal: terminalApi },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  it('invisivel: ResizeObserver dispara mas NENHUM fit/resize e enviado', async () => {
    await act(async () => {
      root.render(<XtermView sessionId="tab-a" visible={false} />);
    });
    flushRaf();
    for (const ro of FakeResizeObserver.instances) ro.trigger();

    expect(fitMock).not.toHaveBeenCalled();
    expect(terminalApi.resize).not.toHaveBeenCalled();
  });

  it('unmount com open em voo SEMPRE fecha a sessao (regressao StrictMode)', async () => {
    await act(async () => {
      root.render(<XtermView sessionId="tab-strict" visible={true} />);
    });
    await act(async () => {
      root.unmount();
    });
    expect(terminalApi.close).toHaveBeenCalledWith('tab-strict');
    root = createRoot(host);
  });

  it('visivel: refit dispara terminal:resize com as dimensoes reais', async () => {
    await act(async () => {
      root.render(<XtermView sessionId="tab-a" visible={false} />);
    });
    flushRaf();
    expect(terminalApi.resize).not.toHaveBeenCalled();

    await act(async () => {
      root.render(<XtermView sessionId="tab-a" visible={true} />);
    });
    flushRaf();

    expect(terminalApi.resize).toHaveBeenCalledWith('tab-a', 120, 32);
  });
});
