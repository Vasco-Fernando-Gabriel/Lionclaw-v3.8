import { useState, useEffect } from 'react';
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
} from 'lucide-react';
import { useAppStore, type Page } from '@/stores/app-store';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import { BootInstallIndicator } from './BootInstallIndicator';

function useSchedulerBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const load = () => {
      window.lionclaw.scheduler.getPendingReviewCount().then(setCount).catch(() => setCount(0));
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
      window.lionclaw.tasks.getPendingDueCount().then(setCount).catch(() => setCount(0));
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

export function Sidebar() {
  const { currentPage, setPage, sidebarCollapsed, toggleSidebar } = useAppStore();
  const { sessions, telegramSessions, currentSessionId, selectSession, deleteSession, compactSession, isCompacting, streamingSessionId } = useChatStore();
  const { onboardingCompleted } = useAuthStore();
  const schedulerBadge = useSchedulerBadge();
  const tasksBadge = useTasksBadge();
  const [appVersionLabel, setAppVersionLabel] = useState('');
  const computedNavItems = navItems;

  const showSessions = currentPage === 'chat' && !sidebarCollapsed;

  useEffect(() => {
    let mounted = true;
    window.lionclaw.app.getVersion()
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

  return (
    <aside
      className={`flex flex-col bg-zinc-900 border-r border-zinc-800 transition-all duration-200 ${
        sidebarCollapsed ? 'w-16' : 'w-56'
      }`}
    >
      {/* Header with drag region - pl-[78px] reserves space for macOS traffic lights */}
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

      {/* New Chat button — dispara compactacao (dreaming + nova sessao) */}
      <div className="px-2 mb-1">
        <button
          onClick={() => {
            if (isCompacting) return;
            setPage('chat');
            void compactSession();
          }}
          disabled={isCompacting}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium
            bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed
            ${sidebarCollapsed ? 'justify-center px-0' : ''}`}
          title="Encerrar conversa atual (salva em memoria e inicia nova)"
        >
          {isCompacting ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
          {!sidebarCollapsed && 'Novo Chat'}
        </button>
      </div>

      {/* Navigation */}
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
                ${isActive
                  ? 'bg-zinc-800 text-amber-500'
                  : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                }
                ${sidebarCollapsed ? 'justify-center px-0' : ''}
                ${isDisabled ? 'opacity-30 cursor-not-allowed hover:bg-transparent hover:text-zinc-400' : ''}`}
              title={sidebarCollapsed ? item.label : undefined}
            >
              {item.icon}
              {!sidebarCollapsed && item.label}
              {!sidebarCollapsed && item.id === 'scheduler' && (schedulerBadge + tasksBadge) > 0 && (
                <span className="ml-auto px-1.5 py-0.5 text-[10px] font-semibold bg-amber-500/20 text-amber-400 rounded-full leading-none">
                  {schedulerBadge + tasksBadge}
                </span>
              )}
              {sidebarCollapsed && item.id === 'scheduler' && (schedulerBadge + tasksBadge) > 0 && (
                <span className="absolute top-0 right-0 w-2 h-2 bg-amber-500 rounded-full" />
              )}
            </button>
          );
        })}
      </nav>

      {/* Pipelines ativos: movido para o painel de Atividade do chat
          (ActivityPanel), a pedido do dono — a sidebar nao mostra mais o bloco. */}

      {/* Session list when on chat page */}
      {showSessions && sessions.length > 0 && (
        <div className="flex-1 overflow-y-auto px-2 py-1 border-t border-zinc-800">
          <p className="text-[10px] uppercase text-zinc-600 font-medium px-3 py-1.5 tracking-wider">
            Conversas recentes
          </p>
          <div className="space-y-0.5">
            {sessions
              .filter((s) => s.type !== 'scheduled')
              .slice()
              .sort((a, b) => {
                if (a.status === 'active' && b.status !== 'active') return -1;
                if (a.status !== 'active' && b.status === 'active') return 1;
                return 0;
              })
              .slice(0, 20)
              .map((session) => {
              const isSelected = currentSessionId === session.id;
              const isSessionActive = session.status === 'active';
              const totalTokens = (session.inputTokens || 0) + (session.outputTokens || 0);
              return (
                <div
                  key={session.id}
                  className={`group flex items-center gap-1 rounded-lg transition-colors ${
                    isSelected
                      ? isSessionActive
                        ? 'bg-zinc-800 border border-amber-500/30'
                        : 'bg-zinc-800'
                      : 'hover:bg-zinc-800/50'
                  }`}
                >
                  <button
                    onClick={() => selectSession(session.id)}
                    className="flex-1 min-w-0 px-3 py-1.5 text-left"
                  >
                    <span className={`text-xs truncate block ${isSelected ? 'text-zinc-200' : 'text-zinc-400'}`}>
                      {streamingSessionId === session.id && streamingSessionId !== currentSessionId && (
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse mr-1.5 align-middle" />
                      )}
                      {session.title || 'Nova conversa'}
                    </span>
                    {totalTokens > 0 && (
                      <span className="text-[9px] text-zinc-600 font-mono">
                        {`${totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : totalTokens} tokens`}
                      </span>
                    )}
                  </button>
                  {isSelected && isSessionActive ? (
                    <div className="flex items-center gap-1 pr-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!isCompacting) void compactSession();
                        }}
                        disabled={isCompacting}
                        className="p-1.5 rounded hover:bg-zinc-700 text-amber-400 hover:text-amber-300 transition-all disabled:opacity-50"
                        title="Encerrar conversa (salva em memoria e inicia nova)"
                      >
                        {isCompacting ? <Loader2 size={14} className="animate-spin" /> : <Archive size={14} />}
                      </button>
                    </div>
                  ) : (
                    session.status !== 'active' && (
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
                    )
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Telegram sessions — lista SEPARADA, read-only (so acompanhamento; nao mistura com o chat do desktop) */}
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
                  <span className="text-[9px] px-1 py-0.5 rounded bg-sky-500/15 text-sky-400 font-semibold shrink-0">TG</span>
                  <span className={`text-xs truncate ${isSelected ? 'text-zinc-200' : 'text-zinc-400'}`}>
                    {session.title || 'Conversa Telegram'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Spacer when no sessions shown */}
      {!showSessions && <div className="flex-1" />}

      {/* SDK compaction indicator */}
      {isCompacting && (
        <div className={`px-2 py-2 border-t border-zinc-800 ${sidebarCollapsed ? 'flex justify-center' : ''}`}>
          {sidebarCollapsed ? (
            <div className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" title="Compactando conversa..." />
          ) : (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-zinc-800/50">
              <Loader2 size={13} className="animate-spin text-amber-500 shrink-0" />
              <span className="text-[11px] text-zinc-400">Compactando conversa...</span>
            </div>
          )}
        </div>
      )}

      {/* Open Design boot-install indicator (Sprint 1, SPEC L520-531) */}
      <BootInstallIndicator collapsed={sidebarCollapsed} />

      {/* Footer */}
      {!sidebarCollapsed && appVersionLabel && (
        <div className="px-4 py-3 border-t border-zinc-800 flex items-center gap-2 text-xs">
          <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-mono whitespace-nowrap shrink-0">
            {appVersionLabel}
          </span>
          <span className="italic text-zinc-500">Comunidade LionLabs</span>
        </div>
      )}
    </aside>
  );
}
