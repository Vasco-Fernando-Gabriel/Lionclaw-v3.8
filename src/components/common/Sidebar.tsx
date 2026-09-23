import { useState, useEffect, useMemo } from 'react';
import {
  MessageSquare,
  Bot,
  Zap,
  Server,
  ScrollText,
  Settings,
  Brain,
  PanelLeftClose,
  PanelLeft,
  Plus,
  Trash2,
  Archive,
  Loader2,
  Flame,
  KeyRound,
  Radio,
  Kanban,
  BookOpen,
  Clock,
  GitBranch,
  Workflow,
  FolderGit2,
  X,
  RotateCcw,
  AlertTriangle,
} from 'lucide-react';
import { useAppStore, type Page } from '@/stores/app-store';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import { BootInstallIndicator } from './BootInstallIndicator';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { laneRuntimeLabel } from '@/components/chat/LaneClearDialog';
import { LANE_UI_STATE_REASON, laneUiState, resolveNewChatAction, staleLaneDays } from '@/lib/lanes';
import type { ConfirmAction, OpenChatSession } from '@/types';

function useSchedulerBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const load = () => {
      window.lionclaw.scheduler
        .getPendingReviewCount()
        .then(setCount)
        .catch(() => setCount(0));
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);
  return count;
}

function useTasksBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const load = () => {
      window.lionclaw.tasks
        .getPendingDueCount()
        .then(setCount)
        .catch(() => setCount(0));
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);
  return count;
}

interface NavItem {
  id: Page;
  label: string;
  icon: React.ReactNode;
}

const navItems: NavItem[] = [
  { id: 'chat', label: 'Chat', icon: <MessageSquare size={20} /> },
  { id: 'agents', label: 'SubAgents', icon: <Bot size={20} /> },
  { id: 'skills', label: 'Skills', icon: <Zap size={20} /> },
  { id: 'mcp', label: 'MCP Servers', icon: <Server size={20} /> },
  { id: 'scheduler', label: 'Scheduler', icon: <Clock size={20} /> },
  { id: 'kanban', label: 'Kanban', icon: <Kanban size={20} /> },
  { id: 'knowledge', label: 'Conhecimento', icon: <BookOpen size={20} /> },
  { id: 'pipeline', label: 'Pipeline', icon: <GitBranch size={20} /> },
  { id: 'dynamic-workflow', label: 'Workflows Dinamicos', icon: <Workflow size={20} /> },
  { id: 'repositories', label: 'Repositorios', icon: <FolderGit2 size={20} /> },
  { id: 'memory', label: 'Cerebro', icon: <Brain size={20} /> },
  { id: 'logs', label: 'Logs', icon: <ScrollText size={20} /> },
  { id: 'usage', label: 'Codeburn', icon: <Flame size={20} /> },
  { id: 'vault', label: 'Vault', icon: <KeyRound size={20} /> },
  { id: 'settings', label: 'Settings', icon: <Settings size={20} /> },
];

function formatSessionTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(3).replace('.', ',')}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace('.', ',')}K`;
  return String(tokens);
}

function forceClearAction(lane: OpenChatSession): ConfirmAction {
  return {
    id: `lane-clear-force-${lane.id}`,
    tool: 'chat:clear',
    description: `Parar o drive e dar Clear na Lane ${lane.laneBadge}? O drive do pipeline${lane.drive ? ` "${lane.drive.name}"` : ''} sera pausado e a conversa salva em memoria.`,
    input: { sessionId: lane.id, force: true },
    risk: 'high',
    sessionId: lane.id,
    title: lane.title,
  };
}

export function Sidebar() {
  const { currentPage, setPage, sidebarCollapsed, toggleSidebar } = useAppStore();
  const {
    sessions,
    telegramSessions,
    openLanes,
    compactions,
    staleLaneDays: staleThreshold,
    currentSessionId,
    selectSession,
    deleteSession,
    clearLane,
    cancelClear,
    startNewChat,
    streamingSessionIds,
  } = useChatStore();
  const { onboardingCompleted } = useAuthStore();
  const schedulerBadge = useSchedulerBadge();
  const tasksBadge = useTasksBadge();
  const [appVersionLabel, setAppVersionLabel] = useState('');
  const [forceClearLane, setForceClearLane] = useState<OpenChatSession | null>(null);
  const computedNavItems = navItems;

  const showSessions = currentPage === 'chat' && !sidebarCollapsed;
  const lanes = useMemo(() => openLanes.slice().sort((a, b) => a.laneBadge - b.laneBadge), [openLanes]);
  const laneIds = useMemo(() => new Set(lanes.map((l) => l.id)), [lanes]);
  const threadIds = useChatStore((s) => s.threads);
  const laneBusyWithoutThread = (lane: OpenChatSession): boolean =>
    !threadIds[lane.id] && (lane.state === 'streaming' || lane.state === 'queued');
  const newChatAction = useMemo(() => resolveNewChatAction(lanes, compactions), [lanes, compactions]);
  const runningClearLane = lanes.find(
    (l) => compactions[l.id]?.source === 'lionclaw' && compactions[l.id]?.phase === 'running',
  );

  useEffect(() => {
    let mounted = true;
    window.lionclaw.app
      .getVersion()
      .then((info) => {
        if (mounted) setAppVersionLabel(info.label);
      })
      .catch(() => {
        if (mounted) setAppVersionLabel('');
      });
    return () => {
      mounted = false;
    };
  }, []);

  const requestClear = (lane: OpenChatSession) => {
    const state = laneUiState(lane, compactions[lane.id]);
    if (state === 'drive ativo') {
      setForceClearLane(lane);
      return;
    }
    if (state !== 'disponivel' && state !== 'Clear interrompido') return;
    void clearLane(lane.id);
  };

  return (
    <aside
      className={`flex flex-col bg-zinc-900 border-r border-zinc-800 transition-all duration-200 ${
        sidebarCollapsed ? 'w-16' : 'w-56'
      }`}
    >
      <div
        className={`h-12 flex items-center gap-2 app-drag-region ${
          sidebarCollapsed ? 'justify-center' : 'pl-[78px] pr-3'
        }`}
      >
        {sidebarCollapsed ? (
          <button
            onClick={toggleSidebar}
            className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors no-drag mt-5"
            title="Expandir sidebar"
          >
            <PanelLeft size={18} />
          </button>
        ) : (
          <>
            <span className="text-sm font-semibold text-amber-500 tracking-tight">LionClaw</span>
            <div className="flex-1" />
            <button
              onClick={toggleSidebar}
              className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors no-drag"
              title="Recolher sidebar"
            >
              <PanelLeftClose size={18} />
            </button>
          </>
        )}
      </div>

      <div className="px-2 mb-1">
        <button
          onClick={() => {
            if (newChatAction.kind === 'disabled') return;
            setPage('chat');
            void startNewChat();
          }}
          disabled={newChatAction.kind === 'disabled'}
          data-testid="new-chat-button"
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium
            bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed
            ${sidebarCollapsed ? 'justify-center px-0' : ''}`}
          title={
            newChatAction.kind === 'disabled'
              ? newChatAction.reason
              : newChatAction.kind === 'choose'
                ? 'Todas as lanes abertas: escolha qual recebe o Clear'
                : 'Abrir uma conversa nova (ou selecionar a lane vazia)'
          }
        >
          <Plus size={16} />
          {!sidebarCollapsed && 'Novo Chat'}
        </button>
      </div>

      <nav className="px-2 py-2 space-y-0.5">
        {computedNavItems.map((item) => {
          const isActive = currentPage === item.id;
          const isDisabled = !onboardingCompleted && item.id !== 'chat' && item.id !== 'settings';
          return (
            <button
              key={item.id}
              onClick={() => !isDisabled && setPage(item.id)}
              disabled={isDisabled}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors relative
                ${isActive ? 'bg-zinc-800 text-amber-500' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'}
                ${sidebarCollapsed ? 'justify-center px-0' : ''}
                ${isDisabled ? 'opacity-30 cursor-not-allowed hover:bg-transparent hover:text-zinc-400' : ''}`}
              title={sidebarCollapsed ? item.label : undefined}
            >
              {item.icon}
              {!sidebarCollapsed && item.label}
              {!sidebarCollapsed && item.id === 'scheduler' && schedulerBadge + tasksBadge > 0 && (
                <span className="ml-auto px-1.5 py-0.5 text-[10px] font-semibold bg-amber-500/20 text-amber-400 rounded-full leading-none">
                  {schedulerBadge + tasksBadge}
                </span>
              )}
              {sidebarCollapsed && item.id === 'scheduler' && schedulerBadge + tasksBadge > 0 && (
                <span className="absolute top-0 right-0 w-2 h-2 bg-amber-500 rounded-full" />
              )}
            </button>
          );
        })}
      </nav>

      {showSessions && (
        <div className="flex-1 overflow-y-auto px-2 py-1 border-t border-zinc-800">
          {lanes.length > 0 && (
            <>
              <p className="text-[10px] uppercase text-zinc-600 font-medium px-3 py-1.5 tracking-wider">Lanes</p>
              <div className="space-y-0.5 mb-2">
                {lanes.map((lane) => {
                  const isSelected = currentSessionId === lane.id;
                  const compaction = compactions[lane.id];
                  const state = laneUiState(lane, compaction);
                  const clearPhase =
                    compaction?.source === 'lionclaw' ? compaction.phase : lane.state === 'clearing' ? 'running' : null;
                  const staleDays = staleLaneDays(lane, staleThreshold);
                  const clearDisabledReason =
                    state === 'disponivel' || state === 'drive ativo' || state === 'Clear interrompido'
                      ? undefined
                      : LANE_UI_STATE_REASON[state];
                  return (
                    <div
                      key={lane.id}
                      data-testid={`lane-row-${lane.laneBadge}`}
                      className={`group rounded-lg transition-colors ${
                        isSelected ? 'bg-zinc-800 border border-amber-500/30' : 'hover:bg-zinc-800/50'
                      }`}
                    >
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => selectSession(lane.id)}
                          className="flex-1 min-w-0 px-2.5 py-1.5 text-left"
                        >
                          <span className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 font-semibold shrink-0">
                              Lane {lane.laneBadge}
                            </span>
                            {(streamingSessionIds.has(lane.id) || laneBusyWithoutThread(lane)) && (
                              <span
                                className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0"
                                data-testid={`lane-streaming-${lane.laneBadge}`}
                              />
                            )}
                            <span className={`text-xs truncate ${isSelected ? 'text-zinc-200' : 'text-zinc-400'}`}>
                              {lane.title || 'Nova conversa'}
                            </span>
                          </span>
                          <span
                            className="block text-[9px] text-zinc-600 font-mono truncate mt-0.5"
                            title={laneRuntimeLabel(lane)}
                          >
                            {laneRuntimeLabel(lane)}
                          </span>
                        </button>
                        <div className="flex items-center gap-0.5 pr-1">
                          {clearPhase !== null ? (
                            <Loader2 size={14} className="animate-spin text-amber-400" />
                          ) : (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                requestClear(lane);
                              }}
                              disabled={clearDisabledReason !== undefined}
                              data-testid={`lane-clear-${lane.laneBadge}`}
                              className="p-1.5 rounded hover:bg-zinc-700 text-amber-400 hover:text-amber-300 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                              title={
                                clearDisabledReason ??
                                (state === 'drive ativo'
                                  ? `Drive ativo${lane.drive ? `: ${lane.drive.name}` : ''}: parar o drive e dar Clear`
                                  : state === 'Clear interrompido'
                                    ? 'Refazer Clear'
                                    : 'Clear: salva em memoria e abre conversa nova nesta lane')
                              }
                            >
                              {state === 'Clear interrompido' ? <RotateCcw size={14} /> : <Archive size={14} />}
                            </button>
                          )}
                        </div>
                      </div>
                      {lane.drive && (
                        <p className="px-2.5 pb-1 text-[10px] text-sky-400">
                          {state}: dirige &quot;{lane.drive.name}&quot;
                        </p>
                      )}
                      {clearPhase === 'queued' && (
                        <div className="flex items-center gap-1.5 px-2.5 pb-1.5 text-[10px] text-amber-400">
                          <span className="flex-1 truncate">
                            {runningClearLane && runningClearLane.id !== lane.id
                              ? `aguardando o Clear da Lane ${runningClearLane.laneBadge}`
                              : 'aguardando o Clear'}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void cancelClear(lane.id);
                            }}
                            className="p-0.5 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-200"
                            title="Cancelar o Clear na fila"
                            data-testid={`lane-clear-cancel-${lane.laneBadge}`}
                          >
                            <X size={11} />
                          </button>
                        </div>
                      )}
                      {clearPhase === 'running' && (
                        <div className="px-2.5 pb-1.5 text-[10px] text-amber-400 truncate">
                          Clear em andamento{compaction?.modelLabel ? ` (${compaction.modelLabel})` : ''}
                        </div>
                      )}
                      {state === 'Clear interrompido' && (
                        <div className="flex items-center gap-1.5 px-2.5 pb-1.5 text-[10px] text-red-400">
                          <span className="flex-1">Clear interrompido</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void clearLane(lane.id);
                            }}
                            className="px-1.5 py-0.5 rounded border border-red-500/40 hover:bg-red-500/10"
                            data-testid={`lane-clear-redo-${lane.laneBadge}`}
                          >
                            Refazer Clear
                          </button>
                        </div>
                      )}
                      {staleDays !== null && clearPhase === null && state !== 'Clear interrompido' && (
                        <div
                          className="flex items-start gap-1 px-2.5 pb-1.5 text-[10px] text-zinc-500"
                          data-testid={`lane-stale-${lane.laneBadge}`}
                        >
                          <AlertTriangle size={10} className="mt-0.5 shrink-0 text-amber-500/70" />
                          <span>
                            {lane.drive || state === 'drive ativo'
                              ? `sem atividade ha ${staleDays} dias; pare o drive${lane.drive ? ` do pipeline "${lane.drive.name}"` : ''} antes de dar Clear`
                              : `sem atividade ha ${staleDays} dias; de Clear para salvar a memoria`}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {sessions.some((s) => !laneIds.has(s.id) && s.type !== 'scheduled') && (
            <>
              <p className="text-[10px] uppercase text-zinc-600 font-medium px-3 py-1.5 tracking-wider">
                Conversas recentes
              </p>
              <div className="space-y-0.5">
                {sessions
                  .filter((s) => s.type !== 'scheduled' && !laneIds.has(s.id))
                  .slice()
                  .sort((a, b) => {
                    if (a.status === 'active' && b.status !== 'active') return -1;
                    if (a.status !== 'active' && b.status === 'active') return 1;
                    return 0;
                  })
                  .slice(0, 20)
                  .map((session) => {
                    const isSelected = currentSessionId === session.id;
                    const isOpenWithoutLane = session.status === 'active';
                    const compaction = compactions[session.id];
                    const totalTokens = (session.inputTokens || 0) + (session.outputTokens || 0);
                    return (
                      <div
                        key={session.id}
                        className={`group flex items-center gap-1 rounded-lg transition-colors ${
                          isSelected ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
                        }`}
                      >
                        <button
                          onClick={() => selectSession(session.id)}
                          className="flex-1 min-w-0 px-3 py-1.5 text-left"
                        >
                          <span className={`text-xs truncate block ${isSelected ? 'text-zinc-200' : 'text-zinc-400'}`}>
                            {session.title || 'Nova conversa'}
                          </span>
                          {isOpenWithoutLane ? (
                            <span className="text-[9px] text-zinc-600">aberta sem lane</span>
                          ) : (
                            totalTokens > 0 && (
                              <span className="text-[9px] text-zinc-600 font-mono">
                                {`${formatSessionTokens(totalTokens)} tokens`}
                              </span>
                            )
                          )}
                        </button>
                        {isOpenWithoutLane ? (
                          <div className="flex items-center gap-1 pr-1">
                            {compaction ? (
                              <Loader2 size={14} className="animate-spin text-amber-400" />
                            ) : (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void clearLane(session.id);
                                }}
                                disabled={(session.messageCount ?? 1) === 0}
                                className="p-1.5 rounded hover:bg-zinc-700 text-amber-400 hover:text-amber-300 transition-all disabled:opacity-40"
                                title={
                                  (session.messageCount ?? 1) === 0
                                    ? LANE_UI_STATE_REASON.vazia
                                    : 'Clear: salva em memoria e arquiva (sem lane, nao abre conversa nova)'
                                }
                              >
                                <Archive size={14} />
                              </button>
                            )}
                          </div>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (window.confirm('Deseja inativar essa sessao? Ela nao sera mais acessivel.')) {
                                deleteSession(session.id);
                              }
                            }}
                            className="p-1 rounded opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition-all"
                            title="Deletar"
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    );
                  })}
              </div>
            </>
          )}
        </div>
      )}

      {showSessions && telegramSessions.length > 0 && (
        <div className="px-2 py-1 border-t border-zinc-800 max-h-48 overflow-y-auto shrink-0">
          <p className="text-[10px] uppercase text-zinc-600 font-medium px-3 py-1.5 tracking-wider flex items-center gap-1.5">
            <Radio size={11} className="text-sky-400" /> Telegram
          </p>
          <div className="space-y-0.5">
            {telegramSessions.slice(0, 10).map((session) => {
              const isSelected = currentSessionId === session.id;
              return (
                <button
                  key={session.id}
                  onClick={() => selectSession(session.id)}
                  className={`w-full flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-left transition-colors ${
                    isSelected ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
                  }`}
                  title="Conversa do Telegram (somente leitura)"
                >
                  <span className="text-[9px] px-1 py-0.5 rounded bg-sky-500/15 text-sky-400 font-semibold shrink-0">
                    TG
                  </span>
                  <span className={`text-xs truncate ${isSelected ? 'text-zinc-200' : 'text-zinc-400'}`}>
                    {session.title || 'Conversa Telegram'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!showSessions && <div className="flex-1" />}

      {sidebarCollapsed && Object.keys(compactions).length > 0 && (
        <div className="px-2 py-2 border-t border-zinc-800 flex justify-center">
          <div className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" title="Clear em andamento numa lane" />
        </div>
      )}

      <BootInstallIndicator collapsed={sidebarCollapsed} />

      {!sidebarCollapsed && appVersionLabel && (
        <div className="px-4 py-3 border-t border-zinc-800 flex items-center gap-2 text-xs">
          <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-mono whitespace-nowrap shrink-0">
            {appVersionLabel}
          </span>
          <span className="italic text-zinc-500">Comunidade LionLabs</span>
        </div>
      )}

      {forceClearLane && (
        <ConfirmDialog
          action={forceClearAction(forceClearLane)}
          onApprove={() => {
            const lane = forceClearLane;
            setForceClearLane(null);
            void clearLane(lane.id, { force: true });
          }}
          onDeny={() => setForceClearLane(null)}
        />
      )}
    </aside>
  );
}
