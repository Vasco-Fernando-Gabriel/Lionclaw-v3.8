import { useEffect, useRef, useCallback, useState, memo } from 'react';
import { Send, User, ChevronDown, ChevronRight, Paperclip, X, Volume2, History } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { usePipelineStore } from '@/stores/pipeline-store';
import type { PipelineMessage, ChatAttachment, StreamTimelineBlock } from '@/types';
import { AgentThinking } from '@/components/chat/AgentThinking';
import { VoiceRecorder } from '@/components/chat/VoiceRecorder';
import { AudioPlayer } from '@/components/chat/AudioPlayer';
import { PhaseDocumentButton } from './PhaseDocumentButton';
import { StreamingMarkdown } from './StreamingMarkdown';
import { lionClawLogoUrl } from '@/assets/lionclaw-logo';
import { StreamTimeline } from '@/components/common/StreamTimeline';
import { timelineFromPersisted } from '@/lib/stream-timeline';

interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: PipelineMessage['toolCalls'];
  isStreaming?: boolean;
  timeline?: StreamTimelineBlock[];
  attachments?: ChatAttachment[];
}

function MessageBubble({ role, content, toolCalls, isStreaming = false, timeline, attachments }: MessageBubbleProps) {
  const isUser = role === 'user';
  const timelineBlocks = timeline ?? timelineFromPersisted(content, toolCalls, 'pipeline-message');

  return (
    <div className={`flex gap-3 items-start min-w-0 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
          isUser ? 'bg-zinc-700' : 'bg-amber-500/10'
        }`}
      >
        {isUser ? (
          <User size={14} className="text-zinc-300" />
        ) : (
          <img src={lionClawLogoUrl} alt="agent" className="w-4 h-4" />
        )}
      </div>

      <div
        className={`rounded-xl px-4 py-3 text-sm max-w-[85%] min-w-0 overflow-hidden ${
          isUser ? 'bg-amber-600 text-white' : 'bg-zinc-900 text-zinc-300 border border-zinc-800'
        }`}
      >
        {isUser ? (
          <div>
            {attachments && attachments.length > 0 && (
              <div className="space-y-1.5 mb-2">
                {attachments.filter((a) => a.type === 'image').length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {attachments
                      .filter((a) => a.type === 'image')
                      .map((att) => (
                        <img
                          key={att.id}
                          src={att.preview ?? `data:${att.mimeType};base64,${att.data}`}
                          alt={att.filename}
                          className="w-20 h-20 object-cover rounded-lg border border-amber-500/30"
                        />
                      ))}
                  </div>
                )}
                {attachments
                  .filter((a) => a.type === 'audio')
                  .map((att) => (
                    <AudioPlayer
                      key={att.id}
                      audioBase64={att.data}
                      mimeType={att.mimeType}
                      label={att.preview || 'Audio enviado'}
                    />
                  ))}
              </div>
            )}
            {content && <p className="whitespace-pre-wrap">{content}</p>}
          </div>
        ) : (
          <div className="chat-markdown">
            {timelineBlocks.length > 0 ? (
              <StreamTimeline
                blocks={timelineBlocks}
                className="space-y-2"
                renderText={(block) => (
                  <>
                    <StreamingMarkdown content={block.content} isStreaming={block.status === 'streaming'} />
                    {block.status === 'streaming' && <span className="pipeline-streaming-cursor" />}
                  </>
                )}
              />
            ) : isStreaming ? (
              <AgentThinking />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

const MemoizedMessageBubble = memo(MessageBubble);

function EmptyState({ isStreaming }: { isStreaming: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mb-3">
        <img src={lionClawLogoUrl} alt="agent" className="w-5 h-5" />
      </div>
      <p className="text-xs text-zinc-600 max-w-xs">
        {isStreaming ? 'Agente iniciando resposta...' : 'Aguardando mensagens...'}
      </p>
    </div>
  );
}

const REPORT_PHASES = new Set([3, 9]);

function CollapsibleReport({ messages }: { messages: PipelineMessage[] }) {
  const [expanded, setExpanded] = useState(false);

  const reportMessage = messages.find((m) => m.role === 'assistant' && m.content.trim().length > 80);

  if (!reportMessage) return null;

  return (
    <div className="px-4 py-2 shrink-0 border-b border-zinc-800/60">
      <div className="max-w-2xl mx-auto">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 hover:border-zinc-600 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronDown size={13} className="text-amber-400 shrink-0" />
            ) : (
              <ChevronRight size={13} className="text-amber-400 shrink-0" />
            )}
            <span className="font-medium text-zinc-300">Relatorio do Validador</span>
          </div>
          <span className="text-[10px] text-zinc-600">{expanded ? 'Recolher' : 'Expandir'}</span>
        </button>

        {expanded && (
          <div className="mt-1.5 px-3 py-3 rounded-lg bg-zinc-900/60 border border-zinc-800 text-xs text-zinc-400 max-h-64 overflow-y-auto">
            <div className="chat-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{reportMessage.content}</ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface PipelineChatViewProps {
  showInput: boolean;
  isPaused?: boolean;
  readOnly?: boolean;
}

export function PipelineChatView({ showInput, isPaused = false, readOnly = false }: PipelineChatViewProps) {
  const {
    getCurrentMessages,
    streamContent,
    streamTimeline,
    isStreaming,
    currentPhase,
    viewingPhase,
    phaseDocuments,
    sendMessage,
    setViewingPhase,
    isConversationPhase,
    activeProjectId,
    projects,
  } = usePipelineStore();

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const pipelineType = activeProject?.pipelineType ?? 'dev';
  const isAutoPhase = !isConversationPhase(currentPhase, pipelineType);

  const messages = getCurrentMessages();
  const isViewingHistory = viewingPhase !== null && viewingPhase !== currentPhase;
  const displayPhase = viewingPhase ?? currentPhase;

  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);
  const scrollRafRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!followTailRef.current || scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    });
  }, [messages, streamTimeline]);

  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isStreaming, currentPhase]);

  const processImageFile = useCallback((file: File) => {
    if (file.size > 20 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      const att: ChatAttachment = {
        id: crypto.randomUUID(),
        type: 'image',
        data: base64,
        mimeType: file.type as ChatAttachment['mimeType'],
        filename: file.name,
        size: file.size,
      };
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxSize = 200;
        let w = img.width;
        let h = img.height;
        if (w > h) {
          h = (h / w) * maxSize;
          w = maxSize;
        } else {
          w = (w / h) * maxSize;
          h = maxSize;
        }
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
        att.preview = canvas.toDataURL('image/jpeg', 0.7);
        setAttachments((prev) => [...prev, att]);
      };
      img.src = result;
    };
    reader.readAsDataURL(file);
  }, []);

  const processAudioFile = useCallback((file: File) => {
    if (file.size > 20 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      const att: ChatAttachment = {
        id: crypto.randomUUID(),
        type: 'audio',
        data: base64,
        mimeType: file.type as ChatAttachment['mimeType'],
        filename: file.name,
        size: file.size,
      };
      setAttachments((prev) => [...prev, att]);
    };
    reader.readAsDataURL(file);
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if ((!trimmed && attachments.length === 0) || isStreaming) return;
    const toSend = attachments.length > 0 ? [...attachments] : undefined;
    setInput('');
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    await sendMessage(trimmed, toSend);
  }, [input, attachments, isStreaming, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) processImageFile(file);
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    const files = Array.from(e.dataTransfer.files);
    files.forEach((file) => {
      if (file.type.startsWith('image/')) {
        processImageFile(file);
      } else if (file.type.startsWith('audio/')) {
        processAudioFile(file);
      }
    });
  };

  const handleAudioReady = useCallback(
    (audioBase64: string, transcription: string) => {
      const att: ChatAttachment = {
        id: crypto.randomUUID(),
        type: 'audio',
        data: audioBase64,
        mimeType: 'audio/webm',
        filename: 'audio.webm',
        size: Math.ceil(audioBase64.length * 0.75),
        preview: transcription || undefined,
      };
      const text = transcription || '[Audio]';
      void sendMessage(text, [att]);
    },
    [sendMessage],
  );

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const showStreamBubble = !isViewingHistory && (streamTimeline.length > 0 || isStreaming);

  const isEmpty = messages.length === 0 && !showStreamBubble;

  const showReport =
    !isViewingHistory &&
    currentPhase !== null &&
    (REPORT_PHASES.has(currentPhase) || (pipelineType === 'development-v2' && currentPhase === 12));

  const viewPhaseForDoc = displayPhase;
  const hasPhaseDoc = viewPhaseForDoc !== null && phaseDocuments[viewPhaseForDoc] != null;

  const canSend =
    (input.trim().length > 0 || attachments.length > 0) &&
    !isStreaming &&
    !isPaused &&
    !isViewingHistory &&
    !isAutoPhase;

  return (
    <div
      className={`flex flex-col flex-1 h-full min-h-0 ${isDraggingOver ? 'ring-2 ring-inset ring-amber-500/40' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* History mode banner (UI-17) */}
      {isViewingHistory && viewingPhase !== null && (
        <div className="flex items-center justify-between gap-2 px-4 py-2 shrink-0 bg-amber-500/10 border-b border-amber-500/30">
          <div className="flex items-center gap-2">
            <History size={13} className="text-amber-400 shrink-0" />
            <span className="text-xs font-medium text-amber-300">Visualizando historico - Fase {viewingPhase}</span>
          </div>
          <div className="flex items-center gap-2">
            {hasPhaseDoc && viewPhaseForDoc !== null && (
              <PhaseDocumentButton
                phase={viewPhaseForDoc}
                label={phaseDocuments[viewPhaseForDoc]?.label}
                onClick={() => void usePipelineStore.getState().openPhaseDocument(viewPhaseForDoc)}
              />
            )}
            <button
              onClick={() => setViewingPhase(null)}
              className="flex items-center gap-1 text-[11px] text-amber-400 hover:text-amber-200 transition-colors"
            >
              Voltar ao vivo
            </button>
          </div>
        </div>
      )}

      {/* Chat header with document button (live view) */}
      {!isViewingHistory && hasPhaseDoc && viewPhaseForDoc !== null && (
        <div className="flex items-center justify-end px-4 py-2 shrink-0 border-b border-zinc-800/60">
          <PhaseDocumentButton
            phase={viewPhaseForDoc}
            label={phaseDocuments[viewPhaseForDoc]?.label}
            onClick={() => void usePipelineStore.getState().openPhaseDocument(viewPhaseForDoc)}
          />
        </div>
      )}

      {/* Phases 3, 9 — Collapsible validator report */}
      {showReport && <CollapsibleReport messages={messages} />}

      {/* Drag-and-drop overlay hint */}
      {isDraggingOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/70 pointer-events-none rounded-xl">
          <p className="text-amber-400 text-sm font-medium">Solte a imagem ou audio aqui</p>
        </div>
      )}

      {/* Scrollable messages area */}
      <div
        ref={messagesScrollRef}
        className="flex-1 overflow-y-auto px-4 py-5"
        onScroll={() => {
          const element = messagesScrollRef.current;
          if (!element) return;
          followTailRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
        }}
      >
        <div className="max-w-2xl mx-auto space-y-4">
          {isEmpty && <EmptyState isStreaming={isStreaming && !isViewingHistory} />}

          {messages.map((msg: PipelineMessage, idx: number) => (
            <MemoizedMessageBubble
              key={idx}
              role={msg.role}
              content={msg.content}
              toolCalls={msg.toolCalls}
              attachments={msg.attachments}
            />
          ))}

          {showStreamBubble && (
            <MemoizedMessageBubble
              role="assistant"
              content={streamContent}
              timeline={streamTimeline}
              isStreaming={isStreaming}
            />
          )}

          <div ref={messagesEndRef} className="h-3" />
        </div>
      </div>

      {/* Text input — hidden when readOnly or viewing history */}
      {!readOnly && showInput && !isViewingHistory && (
        <div className="border-t border-zinc-800 px-4 py-3 shrink-0">
          <div className="max-w-2xl mx-auto">
            {/* Attachment thumbnails */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2 px-1">
                {attachments.map((att) => (
                  <div key={att.id} className="relative group">
                    {att.type === 'image' ? (
                      <img
                        src={att.preview ?? `data:${att.mimeType};base64,${att.data}`}
                        alt={att.filename}
                        className="w-16 h-16 object-cover rounded-lg border border-zinc-700"
                      />
                    ) : (
                      <div className="w-16 h-16 rounded-lg border border-zinc-700 bg-zinc-800 flex items-center justify-center">
                        <Volume2 size={18} className="text-amber-400" />
                      </div>
                    )}
                    <button
                      onClick={() => removeAttachment(att.id)}
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-600 rounded-full text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Remover"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-end gap-2 bg-zinc-900 rounded-xl border border-zinc-800 px-3 py-2 focus-within:border-amber-500/40 transition-colors">
              {/* File picker */}
              <label
                className={`cursor-pointer shrink-0 self-center transition-colors ${isStreaming || isPaused ? 'opacity-30 pointer-events-none' : 'text-zinc-500 hover:text-zinc-300'}`}
                title="Anexar imagem ou audio"
              >
                <Paperclip size={16} />
                <input
                  type="file"
                  accept="image/*,audio/*"
                  multiple
                  className="hidden"
                  disabled={isStreaming || isPaused}
                  onChange={(e) => {
                    Array.from(e.target.files ?? []).forEach((file) => {
                      if (file.type.startsWith('image/')) processImageFile(file);
                      else if (file.type.startsWith('audio/')) processAudioFile(file);
                    });
                    e.target.value = '';
                  }}
                />
              </label>

              {/* Voice recorder */}
              <VoiceRecorder onAudioReady={handleAudioReady} disabled={isStreaming || isPaused} />

              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={
                  isAutoPhase
                    ? 'Esta fase nao aceita mensagens (auto). Aguarde o agente.'
                    : isStreaming
                      ? 'Aguardando agente...'
                      : isPaused
                        ? 'Pipeline pausado...'
                        : 'Mensagem para o pipeline...'
                }
                rows={1}
                disabled={isStreaming || isPaused || isAutoPhase}
                className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 resize-none outline-none disabled:opacity-40"
                style={{ minHeight: '24px', maxHeight: '144px' }}
              />
              <button
                onClick={() => void handleSend()}
                disabled={!canSend}
                className="p-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                title="Enviar (Enter)"
              >
                <Send size={15} />
              </button>
            </div>
            <p className="text-[10px] text-zinc-700 text-center mt-1.5">
              Enter para enviar, Shift+Enter para nova linha
            </p>
          </div>
        </div>
      )}

      <style>{`
        .pipeline-streaming-cursor {
          display: inline-block;
          width: 2px;
          height: 0.85em;
          background: currentColor;
          margin-left: 1px;
          vertical-align: text-bottom;
          animation: pipeline-blink 1s step-end infinite;
        }
        @keyframes pipeline-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
