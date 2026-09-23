import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { useArtifactPanelStore } from '@/stores/artifact-panel-store';
import {
  ARTIFACT_PANEL_MIN_WIDTH,
  effectiveArtifactMode,
  htmlArtifactUrl,
  parseArtifactMessage,
} from '@/lib/artifact-panel-messages';

const STATE_DEBOUNCE_MS = 500;

interface ArtifactPanelProps {
  containerWidth: number | null;
  onDecisions: (text: string) => void;
}

export function ArtifactPanel({ containerWidth, onDecisions }: ArtifactPanelProps) {
  const current = useArtifactPanelStore((s) => s.current);
  const mode = useArtifactPanelStore((s) => s.mode);
  const setMode = useArtifactPanelStore((s) => s.setMode);
  const close = useArtifactPanelStore((s) => s.close);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const storageKeyRef = useRef<string | null>(null);
  const pendingStateRef = useRef<{ storageKey: string; state: Record<string, unknown> } | null>(null);
  const debounceRef = useRef<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const filePath = typeof current?.data.filePath === 'string' ? (current.data.filePath as string) : null;
  const fileName = typeof current?.data.fileName === 'string' ? (current.data.fileName as string) : null;
  const visible = current !== null && mode !== 'minimized' && filePath !== null;
  const effectiveMode = effectiveArtifactMode(mode, containerWidth);

  const flushPendingState = useCallback(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const pending = pendingStateRef.current;
    pendingStateRef.current = null;
    if (!pending) return;
    void window.lionclaw.artifact.setState(pending.storageKey, pending.state);
  }, []);

  useEffect(() => {
    setLoaded(false);
    storageKeyRef.current = null;
    return () => {
      flushPendingState();
    };
  }, [filePath, flushPendingState]);

  useEffect(() => {
    if (!visible) return;
    const handler = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const message = parseArtifactMessage(event.data);
      if (!message) return;
      if (message.type === 'ready') {
        storageKeyRef.current = message.storageKey;
        void window.lionclaw.artifact.getState(message.storageKey).then((result) => {
          const target = iframeRef.current?.contentWindow;
          if (!target || storageKeyRef.current !== message.storageKey) return;
          const state = 'state' in result && result.state && typeof result.state === 'object' ? result.state : {};
          target.postMessage({ type: 'lionclaw:state', storageKey: message.storageKey, state }, '*');
        });
        return;
      }
      if (message.type === 'decisions') {
        onDecisions(message.text);
        setNotice('Decisões enviadas ao composer');
        window.setTimeout(() => setNotice(null), 4000);
        return;
      }
      pendingStateRef.current = { storageKey: message.storageKey, state: message.state };
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        flushPendingState();
      }, STATE_DEBOUNCE_MS);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [visible, onDecisions, flushPendingState]);

  useEffect(() => {
    if (!visible || mode !== 'full') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMode('side');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, mode, setMode]);

  if (!visible || !current || !filePath) return null;

  const openInBrowser = () => {
    void window.lionclaw.shell.openFile(filePath);
  };

  const toolbar = (
    <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-zinc-200" title={current.title}>
          {current.title}
        </div>
        <div className="truncate text-[10px] text-zinc-500" title={filePath}>
          {notice ?? fileName}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setMode(mode === 'full' ? 'side' : 'full')}
        title={mode === 'full' ? 'Voltar ao painel lateral (Esc)' : 'Tela cheia'}
        className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        data-testid="artifact-panel-toggle-full"
      >
        {mode === 'full' ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      </button>
      <button
        type="button"
        onClick={() => setMode('minimized')}
        title="Minimizar"
        className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        data-testid="artifact-panel-minimize"
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        onClick={openInBrowser}
        title="Abrir no navegador"
        className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
      >
        <ExternalLink size={14} />
      </button>
      <button
        type="button"
        onClick={close}
        title="Fechar"
        className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        data-testid="artifact-panel-close"
      >
        <X size={14} />
      </button>
    </div>
  );

  const body = (
    <div className="relative min-h-0 flex-1" style={{ background: '#070707' }}>
      {!loaded && (
        <div className="absolute inset-0 z-10 flex items-center justify-center text-xs text-zinc-500">
          Carregando artefato...
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={htmlArtifactUrl(filePath)}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={current.title}
        className="h-full w-full border-0"
        style={{ background: '#070707' }}
        onLoad={() => setLoaded(true)}
        data-testid="artifact-panel-iframe"
      />
    </div>
  );

  if (effectiveMode === 'full') {
    return (
      <div className="absolute inset-0 z-40 flex flex-col bg-zinc-950" data-testid="artifact-panel" data-mode="full">
        {toolbar}
        {body}
      </div>
    );
  }

  return (
    <aside
      className="flex shrink-0 flex-col border-l border-zinc-800 bg-zinc-950"
      style={{ width: '50%', minWidth: ARTIFACT_PANEL_MIN_WIDTH }}
      data-testid="artifact-panel"
      data-mode="side"
    >
      {toolbar}
      {body}
    </aside>
  );
}
