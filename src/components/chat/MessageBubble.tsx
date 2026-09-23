import { useMemo, useState, useCallback } from 'react';
import { User, Copy, Check, ChevronDown, ChevronRight, Image as ImageIcon } from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AudioPlayer } from '@/components/chat/AudioPlayer';
import { splitVisionTranscription } from '@/constants/vision';
import type { ChatAttachment, ChatAttachmentMeta } from '@/types';
import { lionClawLogoUrl } from '@/assets/lionclaw-logo';

function CodeBlock({ className, children }: { className?: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const lang = className?.replace('language-', '') || '';
  const code = String(children).replace(/\n$/, '');

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div className="relative group my-3">
      {lang && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-800/80 border border-zinc-700/50 rounded-t-lg border-b-0">
          <span className="text-[10px] text-zinc-500 font-mono uppercase">{lang}</span>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {copied ? <Check size={10} /> : <Copy size={10} />}
            {copied ? 'Copiado' : 'Copiar'}
          </button>
        </div>
      )}
      <pre className={`!mt-0 ${lang ? '!rounded-t-none' : ''}`}>
        <code className={className}>{children}</code>
      </pre>
      {!lang && (
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1 rounded bg-zinc-800 text-zinc-500 hover:text-zinc-300 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      )}
    </div>
  );
}

function isLocalFilesystemImageSrc(src: unknown): boolean {
  if (typeof src !== 'string') return false;
  return /^(?:\/(?:Users|var|private|tmp|Volumes|home|opt|mnt)\/|[A-Za-z]:[\\/])/.test(src);
}

function resolveChatImageSrc(src: unknown): string | undefined {
  if (typeof src !== 'string' || !src.trim()) return undefined;
  if (/^file:\/\//i.test(src)) {
    try {
      let p = decodeURIComponent(new URL(src).pathname);
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
      return `lionclaw-asset://host/local-image/${encodeURIComponent(p)}`;
    } catch {
      return undefined;
    }
  }
  if (isLocalFilesystemImageSrc(src)) {
    return `lionclaw-asset://host/local-image/${encodeURIComponent(src)}`;
  }
  if (/^https?:\/\//i.test(src)) {
    return `lionclaw-asset://host/remote-image/${encodeURIComponent(src)}`;
  }
  return src;
}

const LOCAL_FILE_HREF = /^(?:file:|[a-zA-Z]:[\\/]|\/(?!\/))/;

function isLocalFileHref(href: string): boolean {
  return LOCAL_FILE_HREF.test(href.trim());
}

function chatUrlTransform(url: string): string {
  return isLocalFileHref(url) ? url : defaultUrlTransform(url);
}

async function openLocalFile(href: string): Promise<void> {
  const result = await window.lionclaw.shell.openFile(href.trim());
  if ('error' in result) {
    window.alert(`Nao foi possivel abrir o arquivo: ${result.error}`);
  }
}

const markdownComponents: Components = {
  code({ className, children, ...props }) {
    const isInline = !className && typeof children === 'string' && !children.includes('\n');
    if (isInline) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return <CodeBlock className={className}>{children}</CodeBlock>;
  },
  pre({ children }) {
    return <>{children}</>;
  },
  a({ href, children }) {
    const local = href !== undefined && isLocalFileHref(href);
    return (
      <a
        href={href}
        target={local ? undefined : '_blank'}
        rel="noopener noreferrer"
        className="text-blue-400 underline underline-offset-2 hover:text-blue-300"
        onClick={
          local
            ? (event) => {
                event.preventDefault();
                void openLocalFile(href);
              }
            : undefined
        }
        title={local ? href : undefined}
      >
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    const resolved = resolveChatImageSrc(src);
    if (!resolved) return null;
    return <img src={resolved} alt={alt ?? ''} className="max-w-full rounded-lg border border-zinc-800" />;
  },
};

export function VisionTranscriptionBlock({ transcription }: { transcription: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mt-2 rounded-lg bg-white/10">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[11px] text-white/80 hover:text-white transition-colors"
      >
        <ImageIcon size={12} className="shrink-0" />
        <span className="font-medium">Imagem transcrita pelo vision</span>
        <span className="ml-auto flex items-center gap-0.5 text-white/60">
          {expanded ? 'recolher' : 'expandir'}
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      {expanded && (
        <p className="whitespace-pre-wrap selectable px-2 pb-2 text-xs leading-relaxed text-white/90">
          {transcription}
        </p>
      )}
    </div>
  );
}

interface ImageThumb {
  id: string;
  src: string;
  alt: string;
}

export function collectImageThumbs(
  attachments?: ChatAttachment[],
  attachmentsMeta?: ChatAttachmentMeta[],
): ImageThumb[] {
  const thumbs: ImageThumb[] = [];
  const seen = new Set<string>();
  for (const att of attachments ?? []) {
    if (att.type !== 'image') continue;
    thumbs.push({
      id: att.id,
      src: att.preview || `data:${att.mimeType};base64,${att.data}`,
      alt: att.filename,
    });
    seen.add(att.id);
  }
  for (const meta of attachmentsMeta ?? []) {
    if (meta.type !== 'image' || seen.has(meta.id) || !meta.preview) continue;
    thumbs.push({ id: meta.id, src: meta.preview, alt: meta.filename });
  }
  return thumbs;
}

export function MessageBubble({
  role,
  content,
  isStreaming = false,
  subagent,
  attachments,
  attachmentsMeta,
}: {
  role: string;
  content: string;
  isStreaming?: boolean;
  subagent?: string;
  attachments?: ChatAttachment[];
  attachmentsMeta?: ChatAttachmentMeta[];
}) {
  const isUser = role === 'user';

  const renderedContent = useMemo(() => {
    if (isUser) return null;
    if (isStreaming) {
      return <div className="whitespace-pre-wrap break-words">{content}</div>;
    }
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} urlTransform={chatUrlTransform}>
        {content}
      </ReactMarkdown>
    );
  }, [content, isStreaming, isUser]);

  const userParts = useMemo(() => (isUser ? splitVisionTranscription(content) : null), [content, isUser]);

  const imageThumbs = useMemo(() => collectImageThumbs(attachments, attachmentsMeta), [attachments, attachmentsMeta]);
  const audioAttachments = (attachments ?? []).filter((att) => att.type === 'audio');
  const hasAttachmentRow = imageThumbs.length > 0 || audioAttachments.length > 0;

  return (
    <div className={`flex gap-3 items-start ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
          isUser ? 'bg-zinc-700' : 'bg-amber-500/10'
        }`}
      >
        {isUser ? (
          <User size={14} className="text-zinc-300" />
        ) : (
          <img src={lionClawLogoUrl} alt="LionClaw" className="w-4 h-4" />
        )}
      </div>
      <div
        className={`rounded-xl px-4 py-3 text-sm max-w-[85%] ${
          isUser ? 'bg-amber-600 text-white' : 'bg-zinc-900 text-zinc-300 border border-zinc-800'
        }`}
      >
        {subagent && !isUser && (
          <span className="text-[10px] text-amber-500/70 font-medium uppercase block mb-1.5">{subagent}</span>
        )}
        {isUser && userParts ? (
          <>
            {userParts.text && <p className="whitespace-pre-wrap selectable">{userParts.text}</p>}
            {userParts.transcription !== null && <VisionTranscriptionBlock transcription={userParts.transcription} />}
          </>
        ) : (
          <div className="chat-markdown">
            {renderedContent}
            {isStreaming && <span className="streaming-cursor" />}
          </div>
        )}
        {hasAttachmentRow && (
          <div className="flex gap-2 mt-2 flex-wrap">
            {audioAttachments.map((att) => (
              <div key={att.id} className="w-full">
                <AudioPlayer audioBase64={att.data} mimeType={att.mimeType} label="Audio enviado" />
              </div>
            ))}
            {imageThumbs.map((thumb) => (
              <img key={thumb.id} src={thumb.src} alt={thumb.alt} className="max-w-xs max-h-48 rounded-lg" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
