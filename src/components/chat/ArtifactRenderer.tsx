import { lazy, Suspense, useState } from 'react';
import { Check, Download, ExternalLink, FileText, Image, Paintbrush } from 'lucide-react';
import type { ArtifactData } from '../../types';

const ExcalidrawViewer = lazy(() => import('./ExcalidrawViewer'));
const McpAppViewer = lazy(() => import('./McpAppViewer'));
const AudioPlayer = lazy(() => import('./AudioPlayer'));

interface ArtifactRendererProps {
  artifact: ArtifactData;
}

export default function ArtifactRenderer({ artifact }: ArtifactRendererProps) {
  return (
    <div className="rounded-xl border border-zinc-700/50 overflow-hidden bg-zinc-900/80 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-700/50 bg-zinc-800/60">
        <div className="flex items-center gap-2">
          {artifact.type === 'image' ? (
            <Image size={14} className="text-emerald-500" />
          ) : artifact.type === 'document' ? (
            <FileText size={14} className="text-sky-500" />
          ) : (
            <Paintbrush size={14} className="text-amber-500" />
          )}
          <span className="text-sm text-zinc-200 font-medium">{artifact.title}</span>
        </div>
        <ArtifactActions artifact={artifact} />
      </div>

      {/* Content */}
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-48 text-zinc-500 text-sm">
            Carregando preview...
          </div>
        }
      >
        {artifact.type === 'mcp_app' && typeof artifact.data.viewId === 'string' && (
          <McpAppViewer viewId={artifact.data.viewId as string} />
        )}
        {artifact.type === 'excalidraw' && (
          <ExcalidrawViewer data={artifact.data} />
        )}
        {artifact.type === 'image' && typeof artifact.data.imageBase64 === 'string' && (
          <ImageViewer
            imageBase64={artifact.data.imageBase64 as string}
            mimeType={(artifact.data.mimeType as string) || 'image/png'}
            prompt={(artifact.data.prompt as string) || artifact.title}
          />
        )}
        {artifact.type === 'audio' && typeof artifact.data.audioBase64 === 'string' && (
          <AudioPlayer
            audioBase64={artifact.data.audioBase64 as string}
            mimeType={(artifact.data.mimeType as string) || 'audio/mpeg'}
            label={artifact.title}
          />
        )}
        {/* SPEC telegram-cron 8.3 (AC-30): branch EXPLICITO para documento,
            sem depender de fallback gracioso. */}
        {artifact.type === 'document' && (
          <DocumentViewer
            fileName={(artifact.data.fileName as string) || artifact.title}
            size={typeof artifact.data.size === 'number' ? (artifact.data.size as number) : undefined}
            mimeType={artifact.data.mimeType as string | undefined}
          />
        )}
      </Suspense>
    </div>
  );
}

function formatDocumentSize(bytes?: number): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${Math.round(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toFixed(1).replace(/\.0$/, '').replace('.', ',')} MB`;
}

function DocumentViewer({ fileName, size, mimeType }: { fileName: string; size?: number; mimeType?: string }) {
  const sizeLabel = formatDocumentSize(size);
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <FileText size={20} className="text-sky-500 shrink-0" />
      <div className="min-w-0">
        <div className="text-sm text-zinc-200 truncate">{fileName}</div>
        <div className="text-xs text-zinc-500">
          {[sizeLabel, mimeType].filter(Boolean).join(' - ') || 'Arquivo gerado'}
        </div>
      </div>
    </div>
  );
}

function ImageViewer({ imageBase64, mimeType, prompt }: { imageBase64: string; mimeType: string; prompt: string }) {
  return (
    <div className="relative">
      <img
        src={`data:${mimeType};base64,${imageBase64}`}
        alt={prompt}
        className="max-w-full h-auto"
      />
      <div className="px-3 py-2 bg-zinc-800/50 text-xs text-zinc-400">
        {prompt}
      </div>
    </div>
  );
}

function ArtifactActions({ artifact }: { artifact: ArtifactData }) {
  const [downloaded, setDownloaded] = useState(false);

  const getExcalidrawFile = (): string | null => {
    if (artifact.type === 'mcp_app' && typeof artifact.data.excalidrawFile === 'string') {
      return artifact.data.excalidrawFile;
    }
    if (artifact.type === 'excalidraw') {
      return JSON.stringify({
        type: 'excalidraw',
        version: 2,
        source: 'lionclaw',
        elements: artifact.data.elements || [],
        appState: {
          gridSize: null,
          viewBackgroundColor: '#ffffff',
          ...(artifact.data.appState as Record<string, unknown> || {}),
        },
        files: artifact.data.files || {},
      }, null, 2);
    }
    return null;
  };

  const excalidrawFile = getExcalidrawFile();

  if (artifact.type === 'image' && typeof artifact.data.imageBase64 === 'string') {
    const handleImageDownload = () => {
      const ext = (artifact.data.mimeType as string)?.includes('png') ? 'png' : 'jpg';
      const byteString = atob(artifact.data.imageBase64 as string);
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
      const blob = new Blob([ab], { type: (artifact.data.mimeType as string) || 'image/png' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = (artifact.title || 'image').replace(/[^a-zA-Z0-9_-]/g, '_');
      a.download = `${safeName}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 3000);
    };

    return (
      <div className="flex items-center gap-3">
        <button
          onClick={handleImageDownload}
          className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-emerald-400 transition-colors"
          title="Baixar imagem"
        >
          {downloaded ? <Check size={12} className="text-green-400" /> : <Download size={12} />}
          <span>{downloaded ? 'Salvo!' : 'Baixar imagem'}</span>
        </button>
      </div>
    );
  }

  if (!excalidrawFile) return null;

  const handleDownload = () => {
    const blob = new Blob([excalidrawFile], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = (artifact.title || 'drawing').replace(/[^a-zA-Z0-9_-]/g, '_');
    a.download = `${safeName}.excalidraw`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 3000);
  };

  const handleOpenExcalidraw = () => {
    handleDownload();
    setTimeout(() => {
      window.open('https://excalidraw.com/', '_blank');
    }, 300);
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleDownload}
        className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-amber-400 transition-colors"
        title="Baixar arquivo .excalidraw"
      >
        {downloaded ? <Check size={12} className="text-green-400" /> : <Download size={12} />}
        <span>{downloaded ? 'Salvo!' : 'Baixar .excalidraw'}</span>
      </button>
      <button
        onClick={handleOpenExcalidraw}
        className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-amber-400 transition-colors"
        title="Baixar e abrir excalidraw.com (File > Open para importar)"
      >
        <ExternalLink size={12} />
        <span>Abrir no Excalidraw</span>
      </button>
    </div>
  );
}
