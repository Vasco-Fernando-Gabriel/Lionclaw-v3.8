import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X, ExternalLink, Loader2, FileWarning } from 'lucide-react';
import type { KanbanAttachment } from '@/types/kanban';
import { useKanbanStore } from '@/stores/kanban-store';
import { attachmentFamily, formatBytes } from './kanban-ui';

interface AttachmentViewerProps {
  attachment: KanbanAttachment;
  onClose: () => void;
}

type TextState = { status: 'loading' } | { status: 'ready'; content: string } | { status: 'fallback'; reason: string };

export function AttachmentViewer({ attachment, onClose }: AttachmentViewerProps) {
  const pushToast = useKanbanStore((s) => s.pushToast);
  const family = attachmentFamily(attachment.filename);
  const [text, setText] = useState<TextState>({ status: 'loading' });

  useEffect(() => {
    if (family !== 'markdown' && family !== 'text') return;
    let mounted = true;
    void window.lionclaw.kanban.readAttachment(attachment.id).then((result) => {
      if (!mounted) return;
      if ('error' in result) {
        setText({ status: 'fallback', reason: result.error });
      } else if (!result.ok) {
        setText({
          status: 'fallback',
          reason: `arquivo com ${formatBytes(result.sizeBytes)} (acima do limite de 2MB do viewer)`,
        });
      } else {
        setText({ status: 'ready', content: result.content });
      }
    });
    return () => {
      mounted = false;
    };
  }, [attachment.id, family]);

  const openExternal = async () => {
    const result = await window.lionclaw.kanban.openAttachment(attachment.id);
    if ('error' in result) pushToast('error', result.error);
  };

  const src = `lionclaw-kanban://${attachment.id}`;

  const renderFallback = (reason?: string) => (
    <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
      <FileWarning size={28} className="text-zinc-600" />
      <div>
        <p className="text-sm text-zinc-300">{attachment.filename}</p>
        <p className="text-xs text-zinc-500 mt-1">
          {[attachment.mime, formatBytes(attachment.sizeBytes)].filter(Boolean).join(' · ') ||
            'sem preview para este tipo'}
        </p>
        {reason && <p className="text-xs text-zinc-600 mt-1">{reason}</p>}
      </div>
      <button
        onClick={() => void openExternal()}
        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors flex items-center gap-1.5"
      >
        <ExternalLink size={12} />
        Abrir no aplicativo do sistema
      </button>
    </div>
  );

  const renderBody = () => {
    switch (family) {
      case 'image':
        return (
          <div className="flex items-center justify-center p-4">
            <img src={src} alt={attachment.filename} className="max-w-full max-h-[70vh] rounded-lg" />
          </div>
        );
      case 'pdf':
        return (
          <iframe
            src={src}
            title={attachment.filename}
            className="w-full h-[72vh] rounded-lg border border-zinc-800 bg-zinc-950"
          />
        );
      case 'markdown':
      case 'text':
        if (text.status === 'loading') {
          return (
            <div className="flex items-center justify-center py-14">
              <Loader2 size={20} className="animate-spin text-zinc-500" />
            </div>
          );
        }
        if (text.status === 'fallback') return renderFallback(text.reason);
        if (family === 'markdown') {
          return (
            <div
              className="prose prose-invert prose-sm max-w-none px-1
              prose-headings:text-zinc-200
              prose-p:text-zinc-300 prose-p:leading-relaxed
              prose-a:text-amber-500 prose-a:no-underline hover:prose-a:underline
              prose-code:text-amber-400 prose-code:text-xs
              prose-li:text-zinc-300
              prose-strong:text-zinc-100"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text.content}</ReactMarkdown>
            </div>
          );
        }
        return (
          <pre className="text-xs font-mono text-zinc-300 bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-auto max-h-[70vh] whitespace-pre-wrap break-words">
            {text.content}
          </pre>
        );
      default:
        return renderFallback();
    }
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/70 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800 shrink-0">
          <p className="text-sm text-zinc-200 truncate flex-1">{attachment.filename}</p>
          <button
            onClick={() => void openExternal()}
            className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="Abrir no aplicativo do sistema"
          >
            <ExternalLink size={15} />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="Fechar"
          >
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto p-4">{renderBody()}</div>
      </div>
    </div>
  );
}
