import { create } from 'zustand';
import type { ChatMessage, ChatSession, StreamChunk, AskQuestionRequest, ArtifactData, ChatAttachment, LiveActivity, LiveActivityEvent, LiveActivityStatus, ActivityTurnBlock } from '@/types';
import { useRepoGraphStore } from './repo-graph-store';
import { useChatFeatureTogglesStore } from './chat-feature-toggles-store';
import { useErrorToastStore } from './error-toast-store';
import type { StreamTimelineBlock } from '@/types';
import {
  appendTimelineText,
  appendTimelineTool,
  applyTimelineToolResult,
  failTimeline,
  finishTimeline,
  replaceTimelineText,
  timelineToolsForPersistence,
} from '@/lib/stream-timeline';

type AssistantTurnEvent = {
  sequence: number;
  sessionId: string | null;
  status: 'completed' | 'empty' | 'error' | 'stopped';
  content: string;
  error?: string;
};

interface ChatState {
  sessions: ChatSession[];
  telegramSessions: ChatSession[];
  currentSessionId: string | null;
  messages: ChatMessage[];
  streamingContent: string;
  streamTimeline: StreamTimelineBlock[];
  isStreaming: boolean;
  isCompacting: boolean;
  compactionSource: 'lionclaw' | 'sdk' | null;
  compactionModelLabel: string;
  isDreaming: boolean;
  voiceModeActive: boolean;
  submittedUserTurnCount: number;
  assistantTurnCount: number;
  assistantTurnEvents: AssistantTurnEvent[];
  lastAssistantTurnEvent: AssistantTurnEvent | null;
  assistantCompletionCount: number;
  lastCompletedAssistantMessage: { id: number; sessionId: string; content: string; sequence: number } | null;
  completedAssistantMessages: Array<{ id: number; sessionId: string; content: string; sequence: number }>;
  toolCalls: Array<{
    id?: string;
    tool: string;
    input: unknown;
    status: 'running' | 'done' | 'error' | 'stopped';
    result?: string;
  }>;
  artifacts: ArtifactData[];
  currentUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number | null;
    estimated?: boolean;
    costStatus?: 'known' | 'unknown' | 'estimated-partial';
    tokenStatus?: 'reported' | 'not_reported';
    costUnknownReason?: string;
    costEstimationKind?: 'subscription-equivalent-payg';
  } | null;
  currentContext: NonNullable<StreamChunk['contextUsage']> | null;
  streamingSessionId: string | null;
  drafts: Record<string, string>;
  pendingAskQuestion: AskQuestionRequest | null;
  activities: LiveActivity[];
  activitiesPanelOpen: boolean;
  streamTurnStartedAt: number | null;

  loadSessions: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  sendMessage: (message: string, agentId?: string, attachments?: ChatAttachment[]) => Promise<void>;
  stopStreaming: () => Promise<void>;
  handleStreamChunk: (chunk: StreamChunk) => void;
  startNewSession: () => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  compactSession: () => Promise<{ success: boolean; newSessionId?: string; reason?: string; error?: string }>;
  setCompactionActive: (payload: { isActive: boolean; modelLabel?: string; source?: 'lionclaw' }) => void;
  clearSession: () => Promise<{ success: boolean; newSessionId?: string; reason?: string }>;
  setPendingAskQuestion: (request: AskQuestionRequest | null) => void;
  setVoiceModeActive: (active: boolean) => void;
  setDraft: (sessionId: string, text: string) => void;
  getDraft: (sessionId: string) => string;
  clearDraft: (sessionId: string) => void;
  reconcileDanglingActivities: (status: LiveActivityStatus) => void;
  toggleActivitiesPanel: (open?: boolean) => void;
}

function isDesktopSession(session: ChatSession): boolean {
  return (session.type === 'chat' || session.type === 'manual')
    && !session.taskId
    && !session.title?.startsWith('[Scheduler]');
}

function isActiveDesktopSession(session: ChatSession): boolean {
  return session.status === 'active' && isDesktopSession(session);
}

let clientMessageSequence = 0;

function nextClientMessageId(): number {
  clientMessageSequence = (clientMessageSequence + 1) % 1000;
  return Date.now() * 1000 + clientMessageSequence;
}

function reconcileRunning(activities: LiveActivity[], status: LiveActivityStatus): LiveActivity[] {
  let changed = false;
  const next = activities.map((a) => {
    if (a.status !== 'running') return a;
    changed = true;
    return { ...a, status, endedAt: a.endedAt ?? new Date().toISOString() };
  });
  return changed ? next : activities;
}

export function upsertActivity(activities: LiveActivity[], ev: LiveActivityEvent): LiveActivity[] {
  const status: LiveActivityStatus = ev.status ?? (ev.phase === 'end' ? 'done' : 'running');
  const idx = activities.findIndex((a) => a.id === ev.id);
  if (idx === -1) {
    return [
      ...activities,
      {
        id: ev.id,
        parentId: ev.parentId,
        kind: ev.kind,
        label: ev.label,
        status,
        agentId: ev.agentId,
        toolName: ev.toolName,
        tokens: ev.tokens,
        costUsd: ev.costUsd,
        durationMs: ev.durationMs,
        summary: ev.summary,
        startedAt: ev.startedAt,
        endedAt: ev.endedAt,
        turnIndex: ev.turnIndex,
        description: ev.description,
        file: ev.file,
        command: ev.command,
        filesChanged: ev.filesChanged,
        changed: ev.changed,
        exitCode: ev.exitCode,
        toolUses: ev.toolUses,
        projectId: ev.projectId,
      },
    ];
  }
  const existing = activities[idx];
  const merged: LiveActivity = {
    ...existing,
    parentId: ev.parentId ?? existing.parentId,
    label: ev.label || existing.label,
    status,
    agentId: ev.agentId ?? existing.agentId,
    toolName: ev.toolName ?? existing.toolName,
    tokens: ev.tokens ?? existing.tokens,
    costUsd: ev.costUsd ?? existing.costUsd,
    durationMs: ev.durationMs ?? existing.durationMs,
    summary: ev.summary ?? existing.summary,
    startedAt: existing.startedAt ?? ev.startedAt,
    endedAt: ev.endedAt ?? existing.endedAt,
    turnIndex: ev.turnIndex ?? existing.turnIndex,
    description: ev.description ?? existing.description,
    file: ev.file ?? existing.file,
    command: ev.command ?? existing.command,
    filesChanged: ev.filesChanged ?? existing.filesChanged,
    changed: ev.changed ?? existing.changed,
    exitCode: ev.exitCode ?? existing.exitCode,
    toolUses: ev.toolUses ?? existing.toolUses,
    projectId: ev.projectId ?? existing.projectId,
  };
  const next = activities.slice();
  next[idx] = merged;
  return next;
}

export function flattenBlocksToActivities(blocks: ActivityTurnBlock[]): LiveActivity[] {
  const out: LiveActivity[] = [];
  for (const block of blocks) {
    for (const item of block.items) {
      const status: LiveActivityStatus = item.status === 'running' ? 'stopped' : item.status;
      const withTurn = item.turnIndex === undefined ? { ...item, turnIndex: block.turnIndex } : { ...item };
      out.push({ ...withTurn, status });
    }
  }
  return out;
}

export function deriveTurnStartedAt(activities: LiveActivity[]): number | null {
  let min: number | null = null;
  for (const a of activities) {
    if (a.status !== 'running' || !a.startedAt) continue;
    const t = Date.parse(a.startedAt);
    if (Number.isNaN(t)) continue;
    if (min === null || t < min) min = t;
  }
  return min;
}

export const useChatStore = create<ChatState>((set, get) => {
  let pendingText = '';
  let pendingTextSessionId: string | null = null;
  let pendingTextTimer: ReturnType<typeof setTimeout> | null = null;

  const flushPendingText = (): void => {
    if (pendingTextTimer !== null) {
      clearTimeout(pendingTextTimer);
      pendingTextTimer = null;
    }
    if (!pendingText) return;
    const content = pendingText;
    const sessionId = pendingTextSessionId;
    pendingText = '';
    pendingTextSessionId = null;
    set((state) => {
      if (sessionId && state.currentSessionId && sessionId !== state.currentSessionId) {
        return state;
      }
      return {
        streamingContent: state.streamingContent + content,
        streamTimeline: appendTimelineText(state.streamTimeline, content),
        streamTurnStartedAt: state.isStreaming
          ? (state.streamTurnStartedAt ?? Date.now())
          : state.streamTurnStartedAt,
      };
    });
  };

  const enqueueText = (chunk: StreamChunk): void => {
    const sessionId = chunk.sessionId ?? get().currentSessionId;
    if (pendingText && pendingTextSessionId && sessionId && pendingTextSessionId !== sessionId) {
      flushPendingText();
    }
    pendingTextSessionId = sessionId ?? null;
    pendingText += chunk.content ?? '';
    if (pendingTextTimer === null) {
      pendingTextTimer = setTimeout(flushPendingText, 32);
    }
  };

  return ({
  sessions: [],
  telegramSessions: [],
  currentSessionId: null,
  messages: [],
  streamingContent: '',
  streamTimeline: [],
  isStreaming: false,
  isCompacting: false,
  compactionSource: null,
  compactionModelLabel: '',
  isDreaming: false,
  voiceModeActive: false,
  submittedUserTurnCount: 0,
  assistantTurnCount: 0,
  assistantTurnEvents: [],
  lastAssistantTurnEvent: null,
  assistantCompletionCount: 0,
  lastCompletedAssistantMessage: null,
  completedAssistantMessages: [],
  toolCalls: [],
  artifacts: [],
  currentUsage: null,
  currentContext: null,
  streamingSessionId: null,
  drafts: {},
  pendingAskQuestion: null,
  activities: [],
  activitiesPanelOpen: true,
  streamTurnStartedAt: null,

  loadSessions: async () => {
    const allSessions = await window.lionclaw.chat.getSessions();
    const desktopSessions = allSessions.filter(isDesktopSession);
    const telegramSessions = allSessions
      .filter((s) => s.type === 'telegram' && s.status === 'active')
      .slice(0, 1);
    const base = desktopSessions.slice(0, 4);
    const { currentSessionId } = get();
    const activeDesktopSession = desktopSessions.find(isActiveDesktopSession);

    const current =
      currentSessionId && !base.find((s) => s.id === currentSessionId)
        ? desktopSessions.find((s) => s.id === currentSessionId)
        : undefined;
    const preferred =
      !currentSessionId && activeDesktopSession && !base.find((s) => s.id === activeDesktopSession.id)
        ? activeDesktopSession
        : undefined;
    const visibleSessions = current
      ? [current, ...base.filter((s) => s.id !== current.id).slice(0, 3)]
      : preferred
        ? [preferred, ...base.filter((s) => s.id !== preferred.id).slice(0, 3)]
        : base;

    if (!currentSessionId && activeDesktopSession) {
      const messages = await window.lionclaw.chat.getMessages(activeDesktopSession.id);
      const contextUsage = await window.lionclaw.chat
        .getContextUsage(activeDesktopSession.id)
        .catch(() => null);
      let activities: LiveActivity[] = [];
      try {
        activities = flattenBlocksToActivities(await window.lionclaw.activity.getBlocks(activeDesktopSession.id));
      } catch {
        activities = [];
      }
      set((state) => ({
        sessions: visibleSessions,
        telegramSessions,
        currentSessionId: activeDesktopSession.id,
        messages,
        activities,
        currentContext: contextUsage,
        streamTurnStartedAt: state.streamTurnStartedAt ?? deriveTurnStartedAt(activities),
      }));
      return;
    }

    set({ sessions: visibleSessions, telegramSessions });
  },

  selectSession: async (id: string) => {
    const { currentSessionId } = get();
    if (id === currentSessionId) return;

    set({
      currentSessionId: id,
      messages: [],
      streamingContent: '',
      streamTimeline: [],
      toolCalls: [],
      artifacts: [],
      currentUsage: null,
      currentContext: null,
      activities: [],
      streamTurnStartedAt: null,
    });

    const [messages, contextUsage] = await Promise.all([
      window.lionclaw.chat.getMessages(id),
      window.lionclaw.chat.getContextUsage(id).catch(() => null),
    ]);
    let hydrated: LiveActivity[] = [];
    try {
      hydrated = flattenBlocksToActivities(await window.lionclaw.activity.getBlocks(id));
    } catch {
      hydrated = [];
    }
    set((state) => {
      if (state.currentSessionId !== id) return { messages: state.messages };
      const activities =
        hydrated.length > 0 || state.activities.length === 0 ? hydrated : state.activities;
      return {
        messages,
        activities,
        currentContext: contextUsage,
        streamTurnStartedAt: state.streamTurnStartedAt ?? deriveTurnStartedAt(activities),
      };
    });
  },

  sendMessage: async (message: string, agentId?: string, attachments?: ChatAttachment[]) => {
    const { currentSessionId, isStreaming, sessions } = get();

    if (currentSessionId) {
      const session = sessions.find((s) => s.id === currentSessionId)
        ?? get().telegramSessions.find((s) => s.id === currentSessionId);
      if (session && (session.status !== 'active' || session.type === 'telegram')) return;
    }

    const userMsg: ChatMessage = {
      id: nextClientMessageId(),
      sessionId: currentSessionId || 'pending',
      role: 'user',
      content: message,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      createdAt: new Date().toISOString(),
    };

    if (isStreaming) {
      set((state) => ({
        messages: [...state.messages, userMsg],
        submittedUserTurnCount: state.submittedUserTurnCount + 1,
      }));
    } else {
      set((state) => ({
        messages: [...state.messages, userMsg],
        streamingContent: '',
        streamTimeline: [],
        isStreaming: true,
        toolCalls: [],
        currentUsage: null,
        submittedUserTurnCount: state.submittedUserTurnCount + 1,
        streamTurnStartedAt: Date.now(),
      }));
      useRepoGraphStore.getState().resetTurnFlags();
    }

    const togglesStore = useChatFeatureTogglesStore.getState();
    togglesStore.recordSend({ sessionId: currentSessionId, message, agentId, attachments });
    const featureToggles = togglesStore.snapshotForSend(currentSessionId);

    const ack = await window.lionclaw.chat.send(message, {
      sessionId: currentSessionId ?? undefined,
      agentId,
      attachments,
      featureToggles,
    });
    if (ack && ack.accepted === false) {
      set({ isStreaming: false, streamTurnStartedAt: null });
    }
  },

  stopStreaming: async () => {
    flushPendingText();
    await window.lionclaw.chat.stop();
    set((state) => {
      if (state.assistantTurnCount >= state.submittedUserTurnCount) {
        return { isStreaming: false, streamTurnStartedAt: null, activities: reconcileRunning(state.activities, 'stopped') };
      }

      const stoppedEvents: AssistantTurnEvent[] = [];
      for (let sequence = state.assistantTurnCount + 1; sequence <= state.submittedUserTurnCount; sequence += 1) {
        stoppedEvents.push({
          sequence,
          sessionId: state.currentSessionId,
          status: 'stopped',
          content: '',
        });
      }
      const lastEvent = stoppedEvents[stoppedEvents.length - 1] || state.lastAssistantTurnEvent;

      return {
        isStreaming: false,
        streamTurnStartedAt: null,
        assistantTurnCount: state.submittedUserTurnCount,
        lastAssistantTurnEvent: lastEvent,
        assistantTurnEvents: [...state.assistantTurnEvents, ...stoppedEvents].slice(-20),
        activities: reconcileRunning(state.activities, 'stopped'),
      };
    });
  },

  handleStreamChunk: (chunk: StreamChunk) => {
    const { currentSessionId } = get();

    const passthrough = ['session', 'error', 'onboarding_completed', 'compacting'];
    if (!passthrough.includes(chunk.type) && chunk.sessionId && currentSessionId && chunk.sessionId !== currentSessionId) {
      return;
    }

    if (chunk.type !== 'text') flushPendingText();

    switch (chunk.type) {
      case 'text':
        if (get().isStreaming && get().streamTurnStartedAt === null) {
          set({ streamTurnStartedAt: Date.now() });
        }
        enqueueText(chunk);
        break;

      case 'tool_call':
        set((state) => ({
          toolCalls: [
            ...state.toolCalls,
            {
              id: chunk.toolCallId,
              tool: chunk.tool!,
              input: chunk.input,
              status: 'running',
            },
          ],
          streamTimeline: appendTimelineTool(state.streamTimeline, {
            tool: chunk.tool!,
            input: chunk.input,
            toolCallId: chunk.toolCallId,
          }),
          streamTurnStartedAt: state.isStreaming
            ? (state.streamTurnStartedAt ?? Date.now())
            : state.streamTurnStartedAt,
        }));
        break;

      case 'tool_result':
        set((state) => {
          let index = chunk.toolCallId
            ? state.toolCalls.findIndex((call) => call.id === chunk.toolCallId)
            : -1;
          if (index < 0) {
            for (let candidate = state.toolCalls.length - 1; candidate >= 0; candidate -= 1) {
              const call = state.toolCalls[candidate];
              if (call.status === 'running' && call.tool === chunk.tool) {
                index = candidate;
                break;
              }
            }
          }
          if (index < 0) return state;
          const toolCalls = [...state.toolCalls];
          toolCalls[index] = {
            ...toolCalls[index],
            status: chunk.isError ? 'error' : 'done',
            result: chunk.result,
            ...(chunk.input !== undefined ? { input: chunk.input } : {}),
          };
          return {
            toolCalls,
            streamTimeline: applyTimelineToolResult(state.streamTimeline, {
              tool: chunk.tool,
              toolCallId: chunk.toolCallId,
              result: chunk.result,
              isError: chunk.isError,
            }),
          };
        });
        break;

      case 'artifact':
        if (chunk.artifact) {
          set((state) => ({
            artifacts: [...state.artifacts, chunk.artifact!],
          }));
        }
        break;

      case 'context_usage':
        if (chunk.contextUsage) {
          set({ currentContext: chunk.contextUsage });
        }
        break;

      case 'usage':
        if (chunk.usage) {
          set({ currentUsage: chunk.usage });
          const authoritative = Boolean(
            chunk.usage.runtime
            && chunk.usage.provider
            && chunk.usage.model
            && chunk.usage.costStatus
            && chunk.usage.tokenStatus,
          );
          if (authoritative) break;
          void window.lionclaw.settings.get().then((settings) => {
            return window.lionclaw.pricing.calculate({
              runtime: settings.orchestratorRuntime,
              provider: settings.orchestratorProvider,
              model: settings.orchestratorModel,
              presetId: settings.orchestratorOpenAiCompatPreset,
              inputTokens: chunk.usage!.inputTokens,
              outputTokens: chunk.usage!.outputTokens,
              cacheReadTokens: chunk.usage!.cacheReadTokens,
              cacheCreationTokens: chunk.usage!.cacheCreationTokens,
            });
          }).then((result) => {
            set((s) => ({
              currentUsage: s.currentUsage
                ? { ...s.currentUsage, costUsd: result.costUsd }
                : null,
            }));
          }).catch(() => {
          });
        }
        break;

      case 'session': {
        const nextSessionId = chunk.content || null;
        const prevSessionId = get().currentSessionId;
        set({ currentSessionId: nextSessionId, streamingSessionId: nextSessionId });
        if (nextSessionId && nextSessionId !== prevSessionId) {
          window.lionclaw.activity
            .getBlocks(nextSessionId)
            .then((blocks) => {
              if (get().currentSessionId !== nextSessionId) return;
              const hydrated = flattenBlocksToActivities(blocks);
              set((s) => {
                const nextActivities =
                  hydrated.length > 0 || s.activities.length === 0 ? hydrated : s.activities;
                return {
                  activities: nextActivities,
                  streamTurnStartedAt: s.streamTurnStartedAt ?? deriveTurnStartedAt(nextActivities),
                };
              });
            })
            .catch(() => {
              if (get().currentSessionId === nextSessionId && get().activities.length === 0) {
                set({ activities: [] });
              }
            });
        }
        get().loadSessions();
        break;
      }

      case 'done': {
        const doneSessionId = chunk.sessionId || chunk.content;
        const queueRemaining = chunk.queueRemaining || 0;
        Promise.resolve().then(() => {
          const { streamingContent, currentSessionId: currentSid, artifacts, streamTimeline, voiceModeActive } = get();
          const terminalTimeline = finishTimeline(streamTimeline, { toolWithoutResult: 'done' });

          if (doneSessionId && currentSid && doneSessionId !== currentSid) {
            get().loadSessions();
            set({ streamingSessionId: null });
            return;
          }

          const keepStreaming = queueRemaining > 0;

          if (streamingContent || artifacts.length > 0) {
            const assistantMsg: ChatMessage = {
              id: nextClientMessageId(),
              sessionId: doneSessionId || currentSid || '',
              role: 'assistant',
              content: streamingContent,
              metadata: {
                toolCalls: terminalTimeline.length > 0
                  ? timelineToolsForPersistence(terminalTimeline).map((tc) => ({
                      ...tc,
                      input: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
                      durationMs: tc.durationMs ?? 0,
                    }))
                  : undefined,
                artifacts: artifacts.length > 0 ? [...artifacts] : undefined,
              },
              createdAt: new Date().toISOString(),
            };
            set((state) => {
              const hasPendingTurn = state.assistantTurnCount < state.submittedUserTurnCount;
              const turnSequence = hasPendingTurn ? state.assistantTurnCount + 1 : state.assistantTurnCount;
              const turnEvent: AssistantTurnEvent | null = hasPendingTurn
                ? {
                    sequence: turnSequence,
                    sessionId: assistantMsg.sessionId,
                    status: streamingContent ? 'completed' : 'empty',
                    content: assistantMsg.content,
                  }
                : null;
              const nextState = {
                messages: [...state.messages, assistantMsg],
                streamingContent: '',
                streamTimeline: [],
                isStreaming: keepStreaming,
                toolCalls: [],
                artifacts: [],
                streamTurnStartedAt: null,
                streamingSessionId: keepStreaming ? state.streamingSessionId : null,
                currentSessionId: currentSid || doneSessionId || null,
                assistantTurnCount: turnSequence,
                assistantTurnEvents: turnEvent ? [...state.assistantTurnEvents, turnEvent].slice(-20) : state.assistantTurnEvents,
                lastAssistantTurnEvent: turnEvent || state.lastAssistantTurnEvent,
              };

              if (!streamingContent) {
                return nextState;
              }

              const textSequence = state.assistantCompletionCount + 1;
              const completedAssistantMessage = {
                id: assistantMsg.id,
                sessionId: assistantMsg.sessionId,
                content: assistantMsg.content,
                sequence: textSequence,
              };

              return {
                ...nextState,
                assistantCompletionCount: textSequence,
                lastCompletedAssistantMessage: completedAssistantMessage,
                completedAssistantMessages: [...state.completedAssistantMessages, completedAssistantMessage].slice(-20),
              };
            });

            if (streamingContent && streamingContent.length > 0) {
              window.lionclaw.settings.get().then(settings => {
                if (!voiceModeActive && settings.voiceResponseEnabled && streamingContent.length < 5000) {
                  const cleanText = streamingContent
                    .replace(/```[\s\S]*?```/g, '')
                    .replace(/`[^`]+`/g, '')
                    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                    .replace(/[#*_~>]/g, '')
                    .replace(/\n{2,}/g, '. ')
                    .replace(/\n/g, ' ')
                    .trim();

                  if (cleanText.length > 10) {
                    window.lionclaw.voice.speak(cleanText, settings.voiceId)
                      .then(result => {
                        const mimeType = result.format === 'opus' ? 'audio/ogg' : 'audio/mpeg';
                        const audio = new Audio(`data:${mimeType};base64,${result.base64}`);
                        audio.play().catch(() => {});
                      })
                      .catch(err => console.error('Auto-TTS failed:', err));
                  }
                }
              });
            }
          } else {
            set((state) => {
              if (state.assistantTurnCount >= state.submittedUserTurnCount) {
                return {
                  isStreaming: keepStreaming,
                  artifacts: [],
                  toolCalls: [],
                  streamTimeline: [],
                  streamTurnStartedAt: null,
                  streamingSessionId: keepStreaming ? state.streamingSessionId : null,
                };
              }

              const sequence = state.assistantTurnCount + 1;
              const event: AssistantTurnEvent = {
                sequence,
                sessionId: doneSessionId || currentSid || null,
                status: 'empty',
                content: '',
              };

              return {
                isStreaming: keepStreaming,
                artifacts: [],
                toolCalls: [],
                streamTimeline: [],
                streamTurnStartedAt: null,
                streamingSessionId: keepStreaming ? state.streamingSessionId : null,
                assistantTurnCount: sequence,
                assistantTurnEvents: [...state.assistantTurnEvents, event].slice(-20),
                lastAssistantTurnEvent: event,
              };
            });
          }
          if (!keepStreaming) get().reconcileDanglingActivities('stopped');
          get().loadSessions();
        });
        break;
      }

      case 'replace_content':
        set((state) => ({
          streamingContent: chunk.content || '',
          streamTimeline: replaceTimelineText(state.streamTimeline, chunk.content || ''),
        }));
        break;

      case 'onboarding_completed': {
        import('./auth-store').then(({ useAuthStore }) => {
          useAuthStore.getState().checkOnboarding();
        });
        break;
      }

      case 'ask_question': {
        if (chunk.askRequest) {
          const questionMsg: ChatMessage = {
            id: nextClientMessageId(),
            sessionId: get().currentSessionId || '',
            role: 'assistant',
            content: '',
            messageType: 'ask_question',
            metadata: { askQuestions: chunk.askRequest.questions },
            createdAt: new Date().toISOString(),
          };
          set((state) => ({
            messages: [...state.messages, questionMsg],
          }));
        }
        break;
      }

      case 'error':
        useChatFeatureTogglesStore.getState().handleCapabilityError(chunk.code, chunk.error);
        set((state) => {
          if (state.assistantTurnCount >= state.submittedUserTurnCount) {
            return {
              isStreaming: false,
              streamingContent: '',
              streamingSessionId: null,
              toolCalls: state.toolCalls.map((call) =>
                call.status === 'running' ? { ...call, status: 'error' as const } : call,
              ),
              streamTimeline: failTimeline(state.streamTimeline),
              artifacts: [],
              streamTurnStartedAt: null,
              activities: reconcileRunning(state.activities, 'error'),
            };
          }

          const sequence = state.assistantTurnCount + 1;
          const event: AssistantTurnEvent = {
            sequence,
            sessionId: state.currentSessionId,
            status: 'error',
            content: '',
            error: chunk.error || 'Erro desconhecido',
          };

          return {
            isStreaming: false,
            streamingContent: '',
            streamingSessionId: null,
            toolCalls: state.toolCalls.map((call) =>
              call.status === 'running' ? { ...call, status: 'error' as const } : call,
            ),
            streamTimeline: failTimeline(state.streamTimeline),
            artifacts: [],
            streamTurnStartedAt: null,
            assistantTurnCount: sequence,
            assistantTurnEvents: [...state.assistantTurnEvents, event].slice(-20),
            lastAssistantTurnEvent: event,
            activities: reconcileRunning(state.activities, 'error'),
          };
        });
        break;

      case 'compacting':
        set({
          isCompacting: chunk.isCompacting ?? false,
          compactionSource: chunk.isCompacting ? 'sdk' : null,
          compactionModelLabel: '',
        });
        break;

      case 'dreaming_status':
        set({ isDreaming: chunk.isDreaming ?? false });
        break;

      case 'activity': {
        const ev = chunk.activity;
        if (!ev) break;
        set((state) => ({
          activities: upsertActivity(state.activities, ev),
          activitiesPanelOpen: ev.phase === 'start' ? true : state.activitiesPanelOpen,
          streamTurnStartedAt: state.isStreaming
            ? (state.streamTurnStartedAt ?? Date.now())
            : state.streamTurnStartedAt,
        }));
        break;
      }

      case 'assistant_pushed': {
        const pushed = chunk.message;
        if (!pushed) break;
        if (chunk.sessionId && currentSessionId && chunk.sessionId !== currentSessionId) break;
        set((state) => ({
          messages: [...state.messages, pushed],
        }));
        break;
      }

      case 'drive_paused': {
        set({ isStreaming: false, streamTurnStartedAt: null });
        break;
      }

      case 'repo_graph': {
        const rg = chunk.repoGraph;
        if (!rg) break;
        const repoGraphStore = useRepoGraphStore.getState();
        if (rg.source === 'runtime-limited') {
          repoGraphStore.markRuntimeLimited();
        } else if (rg.used) {
          repoGraphStore.markUsedInTurn();
        }
        break;
      }
    }
  },

  startNewSession: async () => {
    const sessions = await window.lionclaw.chat.getSessions();
    const active = sessions.find(isActiveDesktopSession);

    if (active) {
      const messages = await window.lionclaw.chat.getMessages(active.id);
      const contextUsage = await window.lionclaw.chat.getContextUsage(active.id).catch(() => null);
      set({
        currentSessionId: active.id,
        messages,
        streamingContent: '',
        streamTimeline: [],
        toolCalls: [],
        artifacts: [],
        currentUsage: null,
        currentContext: contextUsage,
        activities: [],
        streamTurnStartedAt: null,
      });
    } else {
      set({
        currentSessionId: null,
        messages: [],
        streamingContent: '',
        streamTimeline: [],
        toolCalls: [],
        artifacts: [],
        currentUsage: null,
        currentContext: null,
        activities: [],
        streamTurnStartedAt: null,
      });
    }

    await get().loadSessions();
  },

  deleteSession: async (id: string) => {
    const result = await window.lionclaw.chat.deleteSession(id);
    if (result.success) {
      const { currentSessionId } = get();
      if (currentSessionId === id) {
        set({ currentSessionId: null, messages: [], activities: [], streamTurnStartedAt: null });
      }
      get().loadSessions();
    } else {
      console.error('deleteSession failed:', result.error);
      useErrorToastStore
        .getState()
        .pushError({ error: result.error }, { title: 'Falha ao apagar a conversa', source: 'chat' });
    }
  },

  compactSession: async () => {
    set({ isCompacting: true });
    try {
      const result = await window.lionclaw.chat.compactSession();

      if (result.success && result.newSessionId) {
        set({
          currentSessionId: result.newSessionId,
          messages: [],
          streamingContent: '',
          streamTimeline: [],
          toolCalls: [],
          artifacts: [],
          currentUsage: null,
          currentContext: null,
          activities: [],
          streamTurnStartedAt: null,
        });
        await get().loadSessions();
      } else if (!result.success) {
        useErrorToastStore
          .getState()
          .pushError(
            { error: result.error ?? result.reason },
            { title: 'Compactacao falhou', source: 'chat' },
          );
      }

      return result;
    } catch (err) {
      console.error('compactSession failed:', err);
      useErrorToastStore
        .getState()
        .pushError({ error: String(err) }, { title: 'Compactacao falhou', source: 'chat' });
      await get().loadSessions();
      return { success: false, reason: 'ipc_error', error: String(err) };
    } finally {
      set({ isCompacting: false });
    }
  },

  setCompactionActive: (payload) => {
    if (payload.isActive) {
      set({
        isCompacting: true,
        compactionSource: 'lionclaw',
        compactionModelLabel: payload.modelLabel ?? '',
      });
    } else {
      set({ isCompacting: false, compactionSource: null, compactionModelLabel: '' });
    }
  },

  clearSession: async () => {
    const result = await window.lionclaw.chat.clearSession();

    if (result.success && result.newSessionId) {
      set({
        currentSessionId: result.newSessionId,
        messages: [],
        streamingContent: '',
        streamTimeline: [],
        toolCalls: [],
        artifacts: [],
        currentUsage: null,
        currentContext: null,
        activities: [],
        streamTurnStartedAt: null,
      });
      await get().loadSessions();
    }

    return result;
  },

  setPendingAskQuestion: (request) => set({ pendingAskQuestion: request }),
  setVoiceModeActive: (active) => set({ voiceModeActive: active }),

  setDraft: (sessionId: string, text: string) => {
    set((state) => ({
      drafts: { ...state.drafts, [sessionId]: text },
    }));
  },

  getDraft: (sessionId: string) => {
    return get().drafts[sessionId] || '';
  },

  clearDraft: (sessionId: string) => {
    set((state) => {
      const { [sessionId]: _, ...rest } = state.drafts;
      return { drafts: rest };
    });
  },

  reconcileDanglingActivities: (status) =>
    set((state) => ({ activities: reconcileRunning(state.activities, status) })),

  toggleActivitiesPanel: (open) =>
    set((state) => ({ activitiesPanelOpen: open ?? !state.activitiesPanelOpen })),
  });
});
