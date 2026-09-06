import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Send, Square, CheckCircle, Paperclip, AudioLines, Cpu, Clock, ShieldAlert, ShieldOff, FolderGit2, Megaphone, MegaphoneOff } from 'lucide-react';
import { formatModelLabel } from '@/utils/model-display';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import { useAppStore } from '@/stores/app-store';
import { useChatLayoutStore, CHAT_WIDTH_MAX_WIDTH } from '@/stores/chat-layout-store';
import { TokenCounter } from '@/components/chat/TokenCounter';
import { AskQuestionDialog } from '@/components/chat/AskQuestionDialog';
import { AskQuestionInline } from '@/components/chat/AskQuestionInline';
import { AgentThinking } from '@/components/chat/AgentThinking';
import { ActivityPanel } from '@/components/chat/ActivityPanel';
import { BackgroundPipeIndicator } from '@/components/chat/BackgroundPipeIndicator';
import { BackgroundWorkflowIndicator } from '@/components/dynamic-workflow/BackgroundWorkflowIndicator';
import { WorkflowChatStrip } from '@/components/dynamic-workflow/WorkflowChatStrip';
import { useDynamicWorkflowStore } from '@/stores/dynamic-workflow-store';
import { RepoGraphBadge } from '@/components/chat/RepoGraphBadge';
import { RepoSelectorControl } from '@/components/chat/RepoSelectorControl';
import {
  ChatCapabilityToggles,
  ChatCapabilityResendAffordance,
} from '@/components/chat/ChatCapabilityToggle';
import { RepoGraphConsentDialog } from '@/components/chat/RepoGraphConsentDialog';
import { useRepoGraphStore } from '@/stores/repo-graph-store';
import { useStreamTimer } from '@/components/chat/useStreamTimer';
import ArtifactRenderer from '@/components/chat/ArtifactRenderer';
import { VoiceRecorder, type VoiceRecorderHandle } from '@/components/chat/VoiceRecorder';
import { VoiceConversationPanel } from '@/components/chat/VoiceConversationPanel';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { StreamTimeline } from '@/components/common/StreamTimeline';
import { timelineFromPersisted } from '@/lib/stream-timeline';
import { ChatErrorBanner } from '@/components/chat/ChatErrorBanner';
import { SlashCommandPicker, type SlashCommand } from '@/components/chat/SlashCommandPicker';
import type { AskQuestionRequest, AskQuestionResponse, ChatAttachment } from '@/types';
import { lionClawLogoUrl } from '@/assets/lionclaw-logo';

const SLASH_COMMANDS: SlashCommand[] = [];
const ONBOARDING_AUTOSTART_MESSAGE = 'Ola! Vamos comecar.';
const ONBOARDING_AUTOSTART_CLAIM_MS = 30_000;
let onboardingAutostartClaimed = false;
let onboardingAutostartClaimedAt = 0;

export function ChatPage() {
  const {
    messages,
    streamingContent,
    streamTimeline,
    isStreaming,
    toolCalls,
    artifacts,
    sendMessage,
    stopStreaming,
    currentUsage,
    currentContext,
    sessions,
    telegramSessions,
    currentSessionId,
    pendingAskQuestion,
    setPendingAskQuestion,
    isCompacting,
    compactionSource,
    compactionModelLabel,
    isDreaming,
    streamTurnStartedAt,
  } = useChatStore();

  const chatWidth = useChatLayoutStore((s) => s.width);
  const hydrateChatLayout = useChatLayoutStore((s) => s.hydrate);
  useEffect(() => {
    void hydrateChatLayout();
  }, [hydrateChatLayout]);
  const chatMaxWidthStyle = { maxWidth: CHAT_WIDTH_MAX_WIDTH[chatWidth] };
  const chatHorizontalPaddingClass = chatWidth === 'full-width' ? 'px-6' : 'px-4';

  const { onboardingCompleted } = useAuthStore();
  const {
    pendingChatMessage, pendingChatAgent, clearPendingChat,
    pendingChatAwaitRepoReady, pendingChatTargetSessionId,
  } = useAppStore();

  const currentSession = sessions.find((s) => s.id === currentSessionId)
    ?? telegramSessions.find((s) => s.id === currentSessionId);
  const isReadOnly =
    (currentSession != null && (currentSession.status !== 'active' || currentSession.type === 'telegram'))
    || isCompacting;

  const { drafts, setDraft, clearDraft } = useChatStore();
  const sessionKey = currentSessionId || '__new__';
  const input = drafts[sessionKey] || '';
  const setInput = useCallback((text: string) => {
    setDraft(sessionKey, text);
  }, [sessionKey, setDraft]);
  const wasOnboardingCompletedRef = useRef(onboardingCompleted);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const expectedTopRef = useRef<number | null>(null);
  const lastSeenMessageCountRef = useRef(0);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [voicePanelOpen, setVoicePanelOpen] = useState(false);

  const [repoControlsOpen, setRepoControlsOpen] = useState(false);
  const repoGraphSessionState = useRepoGraphStore((s) => s.sessionState);
  const repoGraphBadge = useRepoGraphStore((s) => s.badgeState());
  const repoGraphBuildPercent = useRepoGraphStore((s) => s.buildPercent());
  const repoGraphConsentOpen = useRepoGraphStore((s) => s.consentOpen);
  const setRepoGraphConsentOpen = useRepoGraphStore((s) => s.setConsentOpen);
  const repoGraphRepo = repoGraphSessionState?.repository ?? null;

  useEffect(() => {
    const cleanup = useRepoGraphStore.getState().init();
    void useRepoGraphStore.getState().loadRepositories();
    return cleanup;
  }, []);

  useEffect(() => {
    const cleanup = useDynamicWorkflowStore.getState().init();
    void useDynamicWorkflowStore.getState().loadRuns();
    return cleanup;
  }, []);

  useEffect(() => {
    if (currentSessionId) {
      void useRepoGraphStore.getState().loadSessionState(currentSessionId);
    }
  }, [currentSessionId]);

  useEffect(() => {
    if (
      repoGraphSessionState?.sessionId === currentSessionId &&
      repoGraphRepo &&
      repoGraphRepo.status === 'absent' &&
      !repoGraphRepo.graphPromptSuppressedGlobal &&
      !(repoGraphSessionState?.attach?.graphPromptSuppressed ?? false) &&
      !repoGraphConsentOpen
    ) {
      setRepoGraphConsentOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoGraphRepo?.id, repoGraphRepo?.status]);

  const handleRepoGraphBadgeClick = useCallback(() => {
    if (!repoGraphRepo || !currentSessionId) return;
    if (repoGraphBadge === 'graph-absent') {
      setRepoGraphConsentOpen(true);
    } else if (repoGraphBadge === 'stale') {
      void useRepoGraphStore.getState().update(repoGraphRepo.id, currentSessionId);
    }
  }, [repoGraphRepo, currentSessionId, repoGraphBadge, setRepoGraphConsentOpen]);

  const handleRepoGraphConsentCreate = useCallback(() => {
    setRepoGraphConsentOpen(false);
    if (repoGraphRepo && currentSessionId) {
      void useRepoGraphStore.getState().build(repoGraphRepo.id, currentSessionId);
    }
  }, [repoGraphRepo, currentSessionId, setRepoGraphConsentOpen]);

  const handleRepoGraphConsentNotNow = useCallback(() => {
    setRepoGraphConsentOpen(false);
    if (currentSessionId) {
      void useRepoGraphStore.getState().setPromptSuppressed(currentSessionId, true);
    }
  }, [currentSessionId, setRepoGraphConsentOpen]);

  const handleRepoGraphConsentNeverAsk = useCallback(() => {
    setRepoGraphConsentOpen(false);
    if (repoGraphRepo) {
      void useRepoGraphStore.getState().setGlobalPromptSuppressed(repoGraphRepo.id, true);
    }
  }, [repoGraphRepo, setRepoGraphConsentOpen]);

  const repoGraphFileCount = useMemo(() => {
    if (!repoGraphRepo?.statsJson) return undefined;
    try {
      const stats = JSON.parse(repoGraphRepo.statsJson) as { files?: number };
      return typeof stats.files === 'number' ? stats.files : undefined;
    } catch {
      return undefined;
    }
  }, [repoGraphRepo?.statsJson]);

  const [orchestratorModel, setOrchestratorModel] = useState<string>('');
  const [orchestratorRuntime, setOrchestratorRuntime] = useState<string>('');
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const settings = await window.lionclaw.settings.get();
        if (alive) {
          setOrchestratorModel((settings?.orchestratorModel as string) || '');
          setOrchestratorRuntime((settings?.orchestratorRuntime as string) || '');
        }
      } catch {
      }
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      alive = false;
      window.removeEventListener('focus', refresh);
    };
  }, []);
  const orchestratorModelLabel = useMemo(() => formatModelLabel(orchestratorModel), [orchestratorModel]);

  const [bypass, setBypass] = useState(true);
  useEffect(() => {
    let alive = true;
    window.lionclaw.tools.getBypass().then((v) => { if (alive) setBypass(v); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const handleToggleBypass = useCallback(async (next: boolean) => {
    try {
      const updated = await window.lionclaw.tools.setBypass(next);
      setBypass(updated);
    } catch { /* noop: mantem estado atual se IPC falhar */ }
  }, []);

  const [telegramArmed, setTelegramArmed] = useState(false);
  useEffect(() => {
    let alive = true;
    window.lionclaw.tools.getTelegramArmed().then((v) => { if (alive) setTelegramArmed(v); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const handleToggleTelegram = useCallback(async (next: boolean) => {
    try {
      const updated = await window.lionclaw.tools.setTelegramArmed(next);
      setTelegramArmed(updated);
    } catch { /* noop: mantem estado atual se IPC falhar */ }
  }, []);

  const streamElapsed = useStreamTimer(isStreaming, streamTurnStartedAt);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const legacyVoiceRecorderRef = useRef<VoiceRecorderHandle | null>(null);

  const slashPickerRef = useRef<{ onKeyDown: (e: React.KeyboardEvent) => boolean }>({ onKeyDown: () => false });
  const slashFilter = useMemo(() => {
    const match = input.match(/^\/(\S*)$/);
    return match ? match[1] : null;
  }, [input]);
  const showSlashPicker = slashFilter !== null;

  const handleSlashSelect = useCallback((command: string) => {
    clearDraft(sessionKey);
    sendMessage(command);
  }, [clearDraft, sessionKey, sendMessage]);

  const handleSlashNavigate = useCallback((handler: { onKeyDown: (e: React.KeyboardEvent) => boolean }) => {
    slashPickerRef.current = handler;
  }, []);

  const handleMessagesScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const previousTop = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      return;
    }
    const movedUp = el.scrollTop < previousTop;
    if (movedUp) {
      isAtBottomRef.current = false;
      setPinnedToBottom(false);
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 120;
    isAtBottomRef.current = atBottom;
    setPinnedToBottom(atBottom);
  }, []);

  const handleMessagesWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      isAtBottomRef.current = false;
      setPinnedToBottom(false);
    }
  }, []);

  const jumpToLatest = useCallback(() => {
    isAtBottomRef.current = true;
    setPinnedToBottom(true);
    programmaticScrollRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, []);

  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    const justSentByUser = lastMsg?.role === 'user'
      && messages.length !== lastSeenMessageCountRef.current;
    lastSeenMessageCountRef.current = messages.length;
    if (justSentByUser) {
      isAtBottomRef.current = true;
      setPinnedToBottom(true);
      expectedTopRef.current = null;
    }
    if (!isAtBottomRef.current && !justSentByUser) return;
    const frame = window.requestAnimationFrame(() => {
      if (!isAtBottomRef.current && !justSentByUser) return;
      const el = scrollContainerRef.current;
      if (!el) return;
      const expected = expectedTopRef.current;
      if (!justSentByUser && expected !== null && el.scrollTop < expected - 4) {
        isAtBottomRef.current = false;
        setPinnedToBottom(false);
        expectedTopRef.current = null;
        return;
      }
      const target = el.scrollHeight - el.clientHeight;
      if (target - el.scrollTop <= 4) {
        expectedTopRef.current = el.scrollTop;
        return;
      }
      programmaticScrollRef.current = true;
      el.scrollTop = target;
      expectedTopRef.current = target;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, streamingContent, toolCalls]);

  useEffect(() => {
    const claimIsFresh = onboardingAutostartClaimed
      && Date.now() - onboardingAutostartClaimedAt < ONBOARDING_AUTOSTART_CLAIM_MS;
    if (!onboardingCompleted && messages.length === 0 && !claimIsFresh && !isStreaming && !pendingChatMessage) {
      onboardingAutostartClaimed = true;
      onboardingAutostartClaimedAt = Date.now();
      void sendMessage(ONBOARDING_AUTOSTART_MESSAGE).catch(() => {
        onboardingAutostartClaimed = false;
        onboardingAutostartClaimedAt = 0;
      });
    }
  }, [onboardingCompleted, messages.length, isStreaming, sendMessage, pendingChatMessage]);

  useEffect(() => {
    if (wasOnboardingCompletedRef.current && !onboardingCompleted) {
      onboardingAutostartClaimed = false;
      onboardingAutostartClaimedAt = 0;
    }
    wasOnboardingCompletedRef.current = onboardingCompleted;
  }, [onboardingCompleted]);

  useEffect(() => {
    if (isReadOnly && voicePanelOpen) {
      setVoicePanelOpen(false);
    }
  }, [isReadOnly, voicePanelOpen]);

  const handoffSentRef = useRef(false);
  useEffect(() => {
    if (!pendingChatMessage) {
      handoffSentRef.current = false; // reset: pronto para o proximo pending
      return;
    }
    if (isStreaming || handoffSentRef.current) return;
    if (pendingChatTargetSessionId != null && currentSessionId !== pendingChatTargetSessionId) return;
    if (pendingChatAwaitRepoReady) {
      if (repoGraphSessionState?.sessionId !== pendingChatTargetSessionId) return;
      const repo = repoGraphRepo; // repoGraphSessionState?.repository ?? null
      const terminal = repo?.id === pendingChatAwaitRepoReady
        && (repo.status === 'ready' || repo.status === 'stale' || repo.status === 'error');
      if (!terminal) return; // segura (cobre null/repo-errado/absent/building)
    }
    handoffSentRef.current = true; // marca ANTES de enviar -> bloqueia re-disparo duplicado
    const msg = pendingChatMessage;
    const agent = pendingChatAgent || undefined;
    clearPendingChat();
    sendMessage(msg, agent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pendingChatMessage, isStreaming, pendingChatAwaitRepoReady, pendingChatTargetSessionId,
    currentSessionId, repoGraphSessionState?.sessionId, repoGraphRepo?.id, repoGraphRepo?.status,
  ]);

  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            processImageFile(file)
              .then(att => setAttachments(prev => [...prev, att]))
              .catch(err => console.error('Failed to process pasted image:', err));
          }
        }
      }
    };

    window.addEventListener('paste', handleGlobalPaste);
    return () => window.removeEventListener('paste', handleGlobalPaste);
  }, []);



  useEffect(() => {
    const unsub = window.lionclaw.chat.onAskQuestion((request: AskQuestionRequest) => {
      setPendingAskQuestion(request);
    });
    return unsub;
  }, [setPendingAskQuestion]);

  const handleAskResponse = async (response: AskQuestionResponse) => {
    await window.lionclaw.chat.askResponse(response);
    setPendingAskQuestion(null);
  };

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed && attachments.length === 0) return;
    clearDraft(sessionKey);
    const atts = [...attachments];
    setAttachments([]);
    sendMessage(trimmed, undefined, atts);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSlashPicker && slashPickerRef.current.onKeyDown(e)) {
      return;
    }
    if (e.key === 'Escape' && showSlashPicker) {
      e.preventDefault();
      setInput('');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 128) + 'px';
  };

  const processImageFile = async (file: File): Promise<ChatAttachment> => {
    if (!file.type.startsWith('image/')) return Promise.reject('Not an image');
    if (file.size > 20 * 1024 * 1024) return Promise.reject('Image too large (max 20MB)');

    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64Data = result.split(',')[1];
        resolve(base64Data);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

    const preview = await generateThumbnail(file, 200);

    return {
      id: crypto.randomUUID(),
      type: 'image',
      filename: file.name,
      mimeType: file.type as ChatAttachment['mimeType'],
      data: base64,
      size: file.size,
      preview,
    };
  };

  const generateThumbnail = (file: File, maxSize: number): Promise<string> => {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const cleanup = () => URL.revokeObjectURL(url);
      const timer = setTimeout(() => { cleanup(); reject(new Error('Thumbnail generation timed out')); }, 5000);
      const img = new window.Image();
      img.onload = () => {
        clearTimeout(timer);
        const canvas = document.createElement('canvas');
        const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        cleanup();
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => { clearTimeout(timer); cleanup(); reject(new Error('Failed to load image for thumbnail')); };
      img.src = url;
    });
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of files) {
      if (file.type.startsWith('image/') && file.size < 20 * 1024 * 1024) {
        processImageFile(file)
          .then(att => setAttachments(prev => [...prev, att]))
          .catch(err => console.error('Failed to process selected image:', err));
      }
    }
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        processImageFile(file)
          .then(att => setAttachments(prev => [...prev, att]))
          .catch(err => console.error('Failed to process dropped image:', err));
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const isEmpty = messages.length === 0 && !streamingContent;

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
      {/* SPEC-010 (S16): workflow strip no TOPO da conversa quando ela tem um run
          chat-bound ativo (4.3/13.3.1). Some sozinho sem run ativo. Passa o repo
          ativo da conversa (repoGraphRepo) como rotulo. */}
      <WorkflowChatStrip repoLabel={repoGraphRepo?.name ?? null} />
      {/* Onboarding banner */}
      {!onboardingCompleted && (
        <div className="mx-4 mt-2 px-4 py-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-center gap-2">
          <img src={lionClawLogoUrl} alt="LionClaw" className="w-3.5 h-3.5 shrink-0" />
          <span className="text-xs text-amber-300 flex-1">Configuracao inicial - conhecendo voce</span>
          {messages.length >= 10 && !isStreaming && (
            <button
              onClick={async () => {
                await window.lionclaw.onboarding.markCompleted();
                useAuthStore.getState().checkOnboarding();
              }}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-medium transition-colors shrink-0"
            >
              <CheckCircle size={12} />
              Concluir
            </button>
          )}
        </div>
      )}

      {/* Error banner (SB-3): traduzido + persist-aware (AC-B7/B9b) */}
      <ChatErrorBanner />

      {/* Messages area */}
      {/* overflowAnchor none: o scroll anchoring do Chromium ajusta scrollTop
          sozinho quando conteudo ACIMA muda de altura (tool cards colapsando,
          markdown refluindo) e briga com o pin do auto-scroll — dois pilotos no
          mesmo volante = tela sacudindo durante o streaming. */}
      <div ref={scrollContainerRef} onScroll={handleMessagesScroll} onWheel={handleMessagesWheel} className={`relative flex-1 overflow-y-auto ${chatHorizontalPaddingClass} py-6`} style={{ overflowAnchor: 'none' }}>
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/10 flex items-center justify-center mb-4">
              <img src={lionClawLogoUrl} alt="LionClaw" className="w-10 h-10" />
            </div>
            <h2 className="text-xl font-semibold text-zinc-200 mb-2">LionClaw</h2>
            <p className="text-sm text-zinc-500 max-w-md mb-6">
              Seu assistente pessoal de IA. Pergunte qualquer coisa, delegue tarefas ou
              deixe-me executar acoes no seu computador.
            </p>
            <div className="flex gap-2 flex-wrap justify-center">
              {['O que voce pode fazer?', 'Qual o status do sistema?', 'Me ajude a organizar meu dia'].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => {
                    setInput(suggestion);
                    inputRef.current?.focus();
                  }}
                  className="px-3 py-1.5 text-xs text-zinc-400 border border-zinc-800 rounded-lg hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto space-y-5" style={chatMaxWidthStyle}>
            {messages.map((msg) => {
              if (msg.messageType === 'ask_question') {
                const meta = msg.metadata;
                return (
                  <div key={msg.id} className="flex gap-3 items-start">
                    <div className="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0 mt-0.5">
                      <img src={lionClawLogoUrl} alt="LionClaw" className="w-4 h-4" />
                    </div>
                    <div className="flex-1 max-w-[85%]">
                      <AskQuestionInline
                        questions={meta?.askQuestions || []}
                        answers={meta?.askAnswers}
                      />
                    </div>
                  </div>
                );
              }
              const hasArtifacts = msg.metadata?.artifacts && msg.metadata.artifacts.length > 0;
              const messageTimeline = msg.role === 'assistant' && msg.metadata?.toolCalls?.length
                ? timelineFromPersisted(msg.content, msg.metadata.toolCalls, `chat-message-${msg.id}`)
                : null;
              return (
                <div key={msg.id}>
                  {messageTimeline ? (
                    <StreamTimeline
                      blocks={messageTimeline}
                      className="space-y-2"
                      renderText={(block) => (
                        <MessageBubble role="assistant" content={block.content} subagent={msg.subagent} />
                      )}
                    />
                  ) : (
                    <MessageBubble role={msg.role} content={msg.content} subagent={msg.subagent} attachments={msg.attachments} attachmentsMeta={msg.metadata?.attachmentsMeta} />
                  )}
                  {hasArtifacts && msg.metadata!.artifacts!.map((artifact) => (
                    <div key={artifact.id} className="mt-3">
                      <ArtifactRenderer artifact={artifact} />
                    </div>
                  ))}
                </div>
              );
            })}

            {/* Thinking indicator (no text yet, no tools yet) */}
            {isStreaming && streamTimeline.length === 0 && (
              <div className="py-1 pl-10">
                <AgentThinking elapsed={streamElapsed} />
              </div>
            )}

            {/* Streaming artifacts */}
            {artifacts.length > 0 && artifacts.map((artifact) => (
              <div key={artifact.id}>
                <ArtifactRenderer artifact={artifact} />
              </div>
            ))}

            {streamTimeline.length > 0 && (
              <StreamTimeline
                blocks={streamTimeline}
                className="space-y-2"
                renderText={(block) => (
                  <MessageBubble
                    role="assistant"
                    content={block.content}
                    isStreaming={block.status === 'streaming'}
                  />
                )}
              />
            )}


            <div ref={messagesEndRef} />
          </div>
        )}
        {/* Pin de retorno: aparece quando o usuario subiu para ler durante o
            streaming; um clique re-ancora no fim e religa o auto-scroll. */}
        {!pinnedToBottom && isStreaming && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="sticky bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-zinc-900/95 px-3 py-1.5 text-xs text-amber-400 shadow-lg hover:bg-zinc-800 transition-colors"
          >
            <span aria-hidden>↓</span> Voltar ao fim
          </button>
        )}
      </div>

      {/* Confirm Dialog renderizado globalmente em App.tsx (owner unico). */}

      {/* Ask Question Dialog (inline, above input) */}
      {pendingAskQuestion && (
        <div className="px-4">
          <AskQuestionDialog
            request={pendingAskQuestion}
            onSubmit={handleAskResponse}
          />
        </div>
      )}

      {/* Read-only banner */}
      {isReadOnly && (
        <div className="text-center py-2 text-xs text-zinc-500 bg-zinc-900/50 border-t border-zinc-800">
          {isCompacting ? 'Compactando sessao... aguarde' : 'Sessao arquivada - somente leitura'}
        </div>
      )}

      {voicePanelOpen && (
        <VoiceConversationPanel
          disabled={isReadOnly}
          onClose={() => setVoicePanelOpen(false)}
          onSendMessage={sendMessage}
          streamingContent={streamingContent}
          isStreaming={isStreaming}
          toolCalls={toolCalls}
          currentUsage={currentUsage}
        />
      )}

      {/* Input area */}
      <div className={`relative border-t border-zinc-800 ${chatHorizontalPaddingClass} py-3`} onDrop={handleDrop} onDragOver={handleDragOver}>
        {/* Modelo movido para a linha de rodape (abaixo do input) */}
        <div className="mx-auto" style={chatMaxWidthStyle}>
          {/* Token counter */}
          {(currentUsage || currentContext || isCompacting || isDreaming) && (
            <div className="flex justify-center mb-2">
              <TokenCounter
                inputTokens={currentUsage?.inputTokens ?? 0}
                outputTokens={currentUsage?.outputTokens ?? 0}
                cacheReadTokens={currentUsage?.cacheReadTokens}
                cacheCreationTokens={currentUsage?.cacheCreationTokens}
                isStreaming={isStreaming}
                costUsd={currentUsage?.costUsd}
                estimated={currentUsage?.estimated}
                costStatus={currentUsage?.costStatus}
                costUnknownReason={currentUsage?.costUnknownReason}
                costEstimationKind={currentUsage?.costEstimationKind}
                contextTokens={currentContext?.contextTokens}
                contextWindowTokens={currentContext?.contextWindowTokens}
                compactionThresholdPercent={currentContext?.compactionThresholdPercent}
                contextSource={currentContext?.source}
                isCompacting={isCompacting}
                compactionSource={compactionSource}
                compactionModelLabel={compactionModelLabel}
                isDreaming={isDreaming}
              />
            </div>
          )}
          {/* Attachment previews */}
          {attachments.length > 0 && (
            <div className="flex gap-2 px-3 py-2 mb-2 overflow-x-auto">
              {attachments.map(att => (
                <div key={att.id} className="relative group shrink-0">
                  <img
                    src={att.preview || `data:${att.mimeType};base64,${att.data}`}
                    alt={att.filename}
                    className="w-16 h-16 object-cover rounded-lg border border-zinc-700"
                  />
                  <button
                    onClick={() => setAttachments(prev => prev.filter(a => a.id !== att.id))}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-600 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* (A2) Controles do repo mode (12.2), colapsaveis pelo chip do rodape */}
          {repoControlsOpen && currentSessionId && (
            <div className="mb-2">
              <RepoSelectorControl sessionId={currentSessionId} />
            </div>
          )}
          {/* S7 (A.8): affordance "Ligar e reenviar" quando o backend nega o
              turno com chat_capability_*_disabled. Nunca liga sem clique. */}
          <ChatCapabilityResendAffordance />
          <div className="relative flex gap-2 items-end bg-zinc-900 rounded-xl border border-zinc-800 px-3 py-2 focus-within:border-amber-500/50 transition-colors">
            <SlashCommandPicker
              commands={SLASH_COMMANDS}
              filter={slashFilter ?? ''}
              onSelect={handleSlashSelect}
              visible={showSlashPicker}
              onNavigate={handleSlashNavigate}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isReadOnly}
              className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-amber-400 transition-colors disabled:opacity-30"
              title="Anexar imagem"
            >
              <Paperclip size={16} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
            <button
              onClick={() => {
                if (isReadOnly) return;
                setVoicePanelOpen((open) => {
                  const nextOpen = !open;
                  if (nextOpen) {
                    legacyVoiceRecorderRef.current?.cancel();
                  }
                  return nextOpen;
                });
              }}
              disabled={isReadOnly}
              className={`p-1.5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                voicePanelOpen
                  ? 'bg-amber-600 text-white hover:bg-amber-500'
                  : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-amber-400'
              }`}
              title={voicePanelOpen ? 'Fechar conversa por voz' : 'Conversa por voz'}
            >
              <AudioLines size={16} />
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={isCompacting ? 'Compactando sessao...' : isReadOnly ? 'Sessao somente leitura' : isStreaming ? 'Digite enquanto o agente trabalha...' : 'Mensagem...'}
              rows={1}
              className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 resize-none outline-none max-h-32 selectable"
              style={{ minHeight: '24px' }}
              disabled={isReadOnly}
            />
            {isStreaming && (
              <button
                onClick={stopStreaming}
                className="p-1.5 rounded-lg bg-red-600/80 hover:bg-red-500 text-white transition-colors shrink-0"
                title="Parar"
              >
                <Square size={14} />
              </button>
            )}
            <button
              onClick={handleSend}
              disabled={(!input.trim() && attachments.length === 0) || isReadOnly}
              className="p-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title={isStreaming ? 'Enviar para fila (Enter)' : 'Enviar (Enter)'}
            >
              <Send size={16} />
            </button>
            <div className="opacity-55 transition-opacity hover:opacity-100" title="Gravacao manual legada">
              <VoiceRecorder
                ref={legacyVoiceRecorderRef}
                onAudioReady={(audioBase64, transcription) => {
                  const audioAttachment: ChatAttachment = {
                    id: crypto.randomUUID(),
                    type: 'audio',
                    filename: 'audio.webm',
                    mimeType: 'audio/webm',
                    data: audioBase64,
                    size: Math.ceil(audioBase64.length * 3 / 4),
                    preview: transcription,
                  };
                  const text = transcription || '[Audio]';
                  sendMessage(text, undefined, [
                    ...attachments,
                    audioAttachment,
                  ]);
                  setAttachments([]);
                  clearDraft(sessionKey);
                }}
                disabled={isReadOnly || voicePanelOpen}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 mt-1.5 px-0.5">
            {/* Esquerda: "Ignorar permissoes" linkado ao Bypass total (PermissionsPage)
                + chip do drive em background (B3): some sozinho sem drive ativo.
                Responsivo (A.8): >=1280 uma linha; 768-1279 o grupo pode quebrar;
                <520 scroll horizontal discreto (nunca empurra o seletor de modelo,
                que vive no lado direito do justify-between). */}
            <div className="flex items-center gap-2 min-w-0 md:max-xl:flex-wrap max-[519px]:overflow-x-auto max-[519px]:[scrollbar-width:none]">
              <button
                type="button"
                onClick={() => handleToggleBypass(!bypass)}
                title={bypass
                  ? 'Bypass total LIGADO: acoes destrutivas rodam sem confirmacao. Clique para exigir confirmacao.'
                  : 'Bypass total DESLIGADO: cada acao destrutiva pede confirmacao. Clique para ignorar permissoes.'}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors shrink-0 ${
                  bypass
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {bypass ? <ShieldOff size={10} /> : <ShieldAlert size={10} />}
                Ignorar permissões
              </button>
              <BackgroundPipeIndicator />
              {/* SPEC-010 (S16): chip de background do workflow chat-bound, ao lado
                  do indicador de pipe. Some sozinho sem run ativo na conversa. */}
              <BackgroundWorkflowIndicator />
              {/* Chip de ARM do Telegram: gate do tool telegram_notify. Setting
                  global, entao fica FORA do gate de currentSessionId (sempre
                  alcancavel). Aceso = armado (sky); apagado = desarmado (muted). */}
              <button
                type="button"
                onClick={() => handleToggleTelegram(!telegramArmed)}
                title={telegramArmed
                  ? 'Telegram ARMADO: o agente pode te enviar mensagens. Clique para desarmar.'
                  : 'Telegram DESARMADO: o agente nao envia mensagens. Clique para armar (use ao se afastar do PC).'}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors shrink-0 ${
                  telegramArmed
                    ? 'border-sky-500/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {telegramArmed ? <Megaphone size={10} /> : <MegaphoneOff size={10} />}
                Telegram
              </button>
              {/* (A2) Badge CodeGraph (12.1) + chip que abre os controles do repo */}
              {currentSessionId && (
                <>
                  <RepoGraphBadge
                    state={repoGraphBadge}
                    buildPercent={repoGraphBuildPercent}
                    onClick={handleRepoGraphBadgeClick}
                  />
                  <button
                    type="button"
                    onClick={() => setRepoControlsOpen((open) => !open)}
                    title={
                      repoGraphRepo
                        ? `Repositorio ativo: ${repoGraphRepo.canonicalRootPath}`
                        : 'Vincular um repositorio a esta conversa'
                    }
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors shrink-0 ${
                      repoGraphRepo
                        ? 'border-blue-500/40 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20'
                        : 'border-zinc-700 bg-zinc-900 text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    <FolderGit2 size={10} />
                    {repoGraphRepo ? repoGraphRepo.name : 'Repo'}
                  </button>
                </>
              )}
              {/* S7 (A.8): chips Pipeline/Workflows depois do Repo (ordem da
                  spec). SO o toggle "vale para o próximo envio" — execucao
                  ativa continua nos indicadores acima. Lane telegram (nao-
                  desktop, A.9) NAO renderiza; read-only/onboarding renderizam
                  DESABILITADOS (nao ocultos). */}
              {currentSessionId && currentSession?.type !== 'telegram' && (
                <ChatCapabilityToggles
                  sessionId={currentSessionId}
                  disabled={isReadOnly || !onboardingCompleted}
                  isCodexRuntime={orchestratorRuntime === 'codex-sdk'}
                />
              )}
            </div>

            {/* Centro: relogio decorrido enquanto trabalha (sem dica de teclado) */}
            {isStreaming && (
              <span className="inline-flex items-center gap-1 text-[10px] font-mono tabular-nums text-amber-400/80">
                <Clock size={10} className="animate-pulse" />
                {streamElapsed || '0:00'}
              </span>
            )}

            {/* Direita: modelo do orquestrador */}
            {orchestratorModelLabel ? (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-medium text-zinc-400"
                title={`Orquestrador: ${orchestratorModel}`}
              >
                <Cpu size={10} className="text-amber-500" />
                {orchestratorModelLabel}
              </span>
            ) : (
              <span />
            )}
          </div>
        </div>
      </div>
      </div>
      {/* (A2) Consentimento do build do graph (12.3): so a UI alcanca o writer */}
      {repoGraphConsentOpen && repoGraphRepo && (
        <RepoGraphConsentDialog
          repository={repoGraphRepo}
          fileCount={repoGraphFileCount}
          onCreate={handleRepoGraphConsentCreate}
          onNotNow={handleRepoGraphConsentNotNow}
          onNeverAsk={handleRepoGraphConsentNeverAsk}
        />
      )}
      <ActivityPanel />
    </div>
  );
}
