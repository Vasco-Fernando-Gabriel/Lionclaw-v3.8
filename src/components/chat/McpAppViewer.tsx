import { useState } from 'react';

interface McpAppViewerProps {
  viewId: string;
}

export default function McpAppViewer({ viewId }: McpAppViewerProps) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div
      className="w-full bg-zinc-950 relative"
      style={{ minHeight: '350px', height: '500px', maxHeight: '600px' }}
    >
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-sm z-10">
          Carregando Excalidraw...
        </div>
      )}
      <iframe
        src={`lionclaw-asset://host/excalidraw-view/${viewId}`}
        className="w-full h-full border-0"
        style={{ background: '#191919' }}
        title="Excalidraw Preview"
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}
