import { useEffect, useRef } from 'react';
import { ChevronRight, Plus, TerminalSquare, X } from 'lucide-react';
import { TERMINAL_MAX_TABS, TERMINAL_MIN_HEIGHT, terminalMaxHeight, useTerminalStore } from '@/stores/terminal-store';
import { XtermView } from './XtermView';

interface TerminalDockProps {
  visible: boolean;
}

export function TerminalDock({ visible }: TerminalDockProps) {
  const {
    open,
    everOpened,
    height,
    sessions,
    activeId,
    toggle,
    setHeight,
    clampHeightToViewport,
    addSession,
    removeSession,
    setActive,
  } = useTerminalStore();

  useEffect(() => {
    const onResize = () => clampHeightToViewport(window.innerHeight);
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, [clampHeightToViewport]);

  const resizeTeardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeTeardownRef.current?.(), []);

  const onResizeStart = (event: React.PointerEvent): void => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const onMove = (ev: PointerEvent): void => {
      const max = terminalMaxHeight(window.innerHeight);
      const next = Math.min(max, Math.max(TERMINAL_MIN_HEIGHT, startHeight + (startY - ev.clientY)));
      setHeight(next);
    };
    const teardown = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', teardown);
      window.removeEventListener('pointercancel', teardown);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      resizeTeardownRef.current = null;
    };
    resizeTeardownRef.current = teardown;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', teardown);
    window.addEventListener('pointercancel', teardown);
  };

  const atCap = sessions.length >= TERMINAL_MAX_TABS;

  return (
    <div className={`shrink-0 flex flex-col border-t border-zinc-800 bg-zinc-900/60 ${visible ? '' : 'hidden'}`}>
      {open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Redimensionar terminal"
          onPointerDown={onResizeStart}
          className="group/resize -mt-px h-2 cursor-row-resize touch-none"
        >
          <div className="mx-auto mt-0.5 h-[3px] w-10 rounded-full bg-zinc-700 transition-colors group-hover/resize:bg-zinc-500" />
        </div>
      )}

      <div className="flex items-center gap-2 px-3 py-1">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls="terminal-dock-panel"
          className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-zinc-500 transition-colors hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          <ChevronRight size={13} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
          <TerminalSquare size={14} />
          Terminal
        </button>

        {open && (
          <div className="ml-1 flex min-w-0 items-center gap-0.5 overflow-x-auto">
            {sessions.map((session) => {
              const isActive = session.id === activeId;
              return (
                <span
                  key={session.id}
                  className={`inline-flex flex-none items-center rounded transition-colors ${
                    isActive ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-200'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActive(session.id)}
                    aria-current={isActive || undefined}
                    className="max-w-[120px] truncate px-2 py-[3px] text-[11px] focus-visible:outline-none"
                  >
                    {session.title}
                  </button>
                  {sessions.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeSession(session.id)}
                      title="Fechar terminal"
                      aria-label={`Fechar ${session.title}`}
                      className="mr-0.5 grid h-4 w-4 place-items-center rounded text-zinc-500 transition-colors hover:bg-red-500/15 hover:text-red-400 focus-visible:outline-none"
                    >
                      <X size={11} />
                    </button>
                  )}
                </span>
              );
            })}
            <button
              type="button"
              onClick={addSession}
              disabled={atCap}
              title={atCap ? `Limite de ${TERMINAL_MAX_TABS} terminais atingido` : 'Novo terminal'}
              aria-label="Novo terminal"
              className="ml-0.5 grid h-5 w-5 flex-none place-items-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-amber-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <Plus size={13} />
            </button>
          </div>
        )}

        <div className="flex-1" />
      </div>

      {everOpened && (
        <div id="terminal-dock-panel" className={`px-3 pb-3 ${open ? '' : 'hidden'}`}>
          <div className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-950" style={{ height }}>
            {sessions.map((session) => {
              const isActive = session.id === activeId;
              return (
                <div key={session.id} className={`h-full ${isActive ? '' : 'hidden'}`}>
                  <XtermView sessionId={session.id} visible={visible && open && isActive} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
