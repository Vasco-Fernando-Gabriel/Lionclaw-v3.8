import { useCallback, useEffect, useRef, useState } from 'react';
import { Flame } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type FilterKey = '1' | '2' | '3' | '4' | '5' | 'p' | 'o' | 'c';

const PERIOD_BUTTONS: Array<{ key: FilterKey; label: string }> = [
  { key: '1', label: 'Today' },
  { key: '2', label: '7 Days' },
  { key: '3', label: '30 Days' },
  { key: '4', label: 'This Month' },
  { key: '5', label: 'All Time' },
];

const ACTION_BUTTONS: Array<{ key: FilterKey; label: string }> = [
  { key: 'p', label: 'Provider' },
  { key: 'o', label: 'Optimize' },
  { key: 'c', label: 'Compare' },
];

export function UsagePage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activePeriod, setActivePeriod] = useState<FilterKey>('2');

  const focusTerm = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const sendKey = useCallback((key: FilterKey) => {
    void window.lionclaw.codeburn.write(key);
    termRef.current?.focus();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.0,
      letterSpacing: 0,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: { background: '#000000' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    let onInput: { dispose: () => void } | null = null;
    let offData: (() => void) | null = null;
    let offExit: (() => void) | null = null;
    let ro: ResizeObserver | null = null;

    const safeFit = () => {
      if (disposed) return;
      try {
        const rect = container.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        fit.fit();
      } catch {}
    };

    const raf = requestAnimationFrame(() => {
      if (disposed) return;
      term.open(container);
      safeFit();
      term.focus();

      offData = window.lionclaw.codeburn.onData((chunk) => {
        if (!disposed) term.write(chunk);
      });

      offExit = window.lionclaw.codeburn.onExit(({ exitCode, signal }) => {
        if (disposed) return;
        term.writeln('');
        term.writeln(`\x1b[90m[codeburn encerrou — exit ${exitCode}${signal ? `, signal ${signal}` : ''}]\x1b[0m`);
      });

      onInput = term.onData((data) => {
        window.lionclaw.codeburn.write(data);
      });

      void window.lionclaw.codeburn.spawn(term.cols, term.rows).then((res) => {
        if (disposed) return;
        if (!res.ok) setError(res.error);
        term.focus();
      });

      ro = new ResizeObserver(() => {
        safeFit();
        try {
          void window.lionclaw.codeburn.resize(term.cols, term.rows);
        } catch {}
      });
      ro.observe(container);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      onInput?.dispose();
      offData?.();
      offExit?.();
      void window.lionclaw.codeburn.kill();
      try {
        term.dispose();
      } catch {}
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  return (
    <div className="flex flex-col h-full bg-black">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/60 bg-zinc-950">
        <div className="flex items-center gap-2">
          <Flame size={18} className="text-amber-500" />
          <span className="text-sm font-semibold text-zinc-100">Codeburn</span>
        </div>
        <div className="flex items-center gap-1">
          {PERIOD_BUTTONS.map((b) => (
            <button
              key={b.key}
              onClick={() => {
                setActivePeriod(b.key);
                sendKey(b.key);
              }}
              className={`px-3 py-1.5 text-xs rounded transition-colors ${
                activePeriod === b.key
                  ? 'bg-amber-500/20 text-amber-400'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
              title={`Tecla: ${b.key}`}
            >
              {b.label}
            </button>
          ))}
          <div className="w-px h-5 bg-zinc-800 mx-2" />
          {ACTION_BUTTONS.map((b) => (
            <button
              key={b.key}
              onClick={() => sendKey(b.key)}
              className="px-3 py-1.5 text-xs rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              title={`Tecla: ${b.key}`}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <div className="px-4 py-2 text-xs font-mono text-red-400 bg-red-950/40 border-b border-red-900/60">{error}</div>
      )}
      <div ref={containerRef} onClick={focusTerm} className="flex-1 min-h-0" />
    </div>
  );
}
