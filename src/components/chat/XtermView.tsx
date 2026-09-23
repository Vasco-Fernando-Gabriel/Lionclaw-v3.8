import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface XtermViewProps {
  sessionId: string;
  visible: boolean;
}

export function XtermView({ sessionId, visible }: XtermViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [exited, setExited] = useState<number | null>(null);
  const refitRef = useRef<(() => void) | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;

    const term = new XTerm({
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#09090b',
        foreground: '#e4e4e7',
        cursor: '#f59e0b',
        cursorAccent: '#09090b',
        selectionBackground: '#3f3f46',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    term.attachCustomKeyEventHandler((event) => {
      if (
        event.type === 'keydown' &&
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        (event.key === 'c' || event.key === 'C') &&
        term.hasSelection()
      ) {
        void navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      return true;
    });

    term.open(el);

    const doFit = (): void => {
      if (disposed || !visibleRef.current) return;
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {}
    };
    const fitRaf = requestAnimationFrame(doFit);

    void window.lionclaw.terminal.open(sessionId, term.cols || 80, term.rows || 24).then((result) => {
      if (disposed) return;
      if (result && 'ok' in result && result.ok) return;
      const message = result && 'error' in result ? result.error : 'erro desconhecido';
      term.write(`\r\n\x1b[31m[terminal indisponivel] ${message}\x1b[0m\r\n`);
    });

    const unsubData = window.lionclaw.terminal.onData(({ sessionId: sid, chunk }) => {
      if (!disposed && sid === sessionId) term.write(chunk);
    });
    const unsubExit = window.lionclaw.terminal.onExit(({ sessionId: sid, exitCode }) => {
      if (disposed || sid !== sessionId) return;
      term.write(`\r\n\x1b[2m[processo encerrado - exit ${exitCode}]\x1b[0m\r\n`);
      setExited(exitCode);
    });

    const inputDisposable = term.onData((data) => {
      void window.lionclaw.terminal.write(sessionId, data);
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      doFit();
      if (term.cols > 0 && term.rows > 0) {
        void window.lionclaw.terminal.resize(sessionId, term.cols, term.rows);
      }
    });
    resizeObserver.observe(el);

    refitRef.current = () => {
      doFit();
      if (term.cols > 0 && term.rows > 0) {
        void window.lionclaw.terminal.resize(sessionId, term.cols, term.rows);
      }
    };

    if (visibleRef.current) term.focus();

    return () => {
      disposed = true;
      refitRef.current = null;
      cancelAnimationFrame(fitRaf);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      unsubData();
      unsubExit();
      void window.lionclaw.terminal.close(sessionId);
      term.dispose();
    };
  }, [sessionId, generation]);

  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => refitRef.current?.());
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
      {exited !== null && (
        <div className="absolute inset-0 grid place-items-center bg-zinc-950/70">
          <button
            type="button"
            onClick={() => {
              setExited(null);
              setGeneration((g) => g + 1);
            }}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:border-amber-500 hover:text-amber-400"
          >
            Shell encerrado (exit {exited}). Reabrir
          </button>
        </div>
      )}
    </div>
  );
}
