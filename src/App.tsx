import { useEffect, useRef } from 'react';
import { Sidebar } from '@/components/common/Sidebar';
import { useAppStore } from '@/stores/app-store';
import { useAuthStore } from '@/stores/auth-store';
import { selectNextPopup, useChatStore } from '@/stores/chat-store';
import { usePipelineStore } from '@/stores/pipeline-store';
import { useDriveStore } from '@/stores/drive-store';
import { useDynamicWorkflowStore } from '@/stores/dynamic-workflow-store';
import { ChatPage } from '@/pages/ChatPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { AuthPage } from '@/pages/AuthPage';
import { LogsPage } from '@/pages/LogsPage';
import { SubAgentsPage } from '@/pages/SubAgentsPage';
import { SkillsPage } from '@/pages/SkillsPage';
import { MCPServersPage } from '@/pages/MCPServersPage';
import { SchedulerPage } from '@/pages/SchedulerPage';
import { MemoryPage } from '@/pages/MemoryPage';
import { UsagePage } from '@/pages/UsagePage';
import VaultPage from '@/pages/VaultPage';
import { KanbanPage } from '@/pages/KanbanPage';
import { KnowledgePage } from '@/pages/KnowledgePage';
import HarnessPage from '@/pages/HarnessPage';
import PipelinePage from '@/pages/PipelinePage';
import { DynamicWorkflowPage } from '@/pages/DynamicWorkflowPage';
import RepositoriesPage from '@/pages/RepositoriesPage';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { AskQuestionDialog } from '@/components/chat/AskQuestionDialog';
import { useMcpDistStaleStore } from '@/stores/mcp-dist-stale-store';
import { LaneClearDialog } from '@/components/chat/LaneClearDialog';
import { ErrorToastHost } from '@/components/common/ErrorToastHost';
import { CodexAuthRequiredModal } from '@/components/pipeline/CodexAuthRequiredModal';
import { TerminalDock } from '@/components/chat/TerminalDock';

if (import.meta.env.DEV) {
  document.title = 'LionClaw · DEV';
}

function MissingPreloadScreen() {
  const reloadWindow = () => {
    window.location.reload();
  };

  return (
    <div className="flex h-screen items-center justify-center bg-zinc-950 px-6 text-zinc-100">
      <div className="max-w-md rounded-lg border border-red-900/60 bg-zinc-900 p-5 shadow-xl">
        <h1 className="text-base font-semibold text-red-300">Preload indisponivel</h1>
        <p className="mt-2 text-sm text-zinc-400">
          O renderer iniciou sem a API segura do LionClaw. Recarregue a janela. Se continuar, reinicie o app para
          restaurar a comunicacao IPC.
        </p>
        <p className="mt-3 font-mono text-xs text-zinc-500">window.lionclaw nao foi carregado</p>
        <button
          type="button"
          onClick={reloadWindow}
          className="mt-4 rounded-md bg-red-500/15 px-3 py-1.5 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/25"
        >
          Recarregar janela
        </button>
      </div>
    </div>
  );
}

export function App() {
  if (typeof window.lionclaw === 'undefined') {
    return <MissingPreloadScreen />;
  }

  return <LionClawApp />;
}

function LionClawApp() {
  const {
    isAuthenticated,
    isFirstRun,
    isLoading,
    checkAuth,
    onboardingCompleted,
    checkOnboarding,
    orchestratorSetupCompleted,
  } = useAuthStore();
  const { currentPage, setPage } = useAppStore();
  const { handleStreamChunk, loadSessions } = useChatStore();
  const openLanes = useChatStore((s) => s.openLanes);
  const compactions = useChatStore((s) => s.compactions);
  const newChatDialogOpen = useChatStore((s) => s.newChatDialogOpen);
  const nextPopup = useChatStore(selectNextPopup);
  const { init: pipelineInit } = usePipelineStore();
  const { init: driveInit } = useDriveStore();
  const dynamicWorkflowInit = useDynamicWorkflowStore((s) => s.init);
  const pipelineCleanupRef = useRef<(() => void) | null>(null);
  const driveCleanupRef = useRef<(() => void) | null>(null);
  const dynamicWorkflowCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    const unsubLock = window.lionclaw.auth.onLocked(() => {
      checkAuth();
    });
    return unsubLock;
  }, [checkAuth]);

  useEffect(() => {
    if (!isAuthenticated) return;
    checkOnboarding();
  }, [isAuthenticated, checkOnboarding]);

  useEffect(() => {
    if (isAuthenticated && !onboardingCompleted) {
      setPage('chat');
    }
  }, [isAuthenticated, onboardingCompleted, setPage]);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (pipelineCleanupRef.current) return;
    const cleanup = pipelineInit();
    pipelineCleanupRef.current = cleanup;
    // No return cleanup: listeners persist for the app lifetime.
  }, [isAuthenticated, pipelineInit]);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (driveCleanupRef.current) return;
    const cleanup = driveInit();
    driveCleanupRef.current = cleanup;
    // No return cleanup: listener persists for the app lifetime.
  }, [isAuthenticated, driveInit]);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (dynamicWorkflowCleanupRef.current) return;
    const cleanup = dynamicWorkflowInit();
    dynamicWorkflowCleanupRef.current = cleanup;
    // No return cleanup: listener persists for the app lifetime.
  }, [isAuthenticated, dynamicWorkflowInit]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const unsubStream = window.lionclaw.chat.onStream(handleStreamChunk);
    const unsubConfirm = window.lionclaw.chat.onConfirmRequest((action) => {
      useChatStore.getState().enqueueConfirmation(action);
    });
    const unsubAsk = window.lionclaw.chat.onAskQuestion((request) => {
      useChatStore.getState().enqueueAskQuestion(request);
    });
    const unsubCompaction = window.lionclaw.chat.onCompactionActive((payload) =>
      useChatStore.getState().setCompactionActive(payload),
    );
    const unsubSessionUpdated = window.lionclaw.chat.onSessionUpdated((event) =>
      useChatStore.getState().applySessionUpdated(event),
    );
    loadSessions();
    window.lionclaw.settings
      .get()
      .then((settings) => useChatStore.getState().setStaleLaneDays(settings.chatStaleLaneDays))
      .catch(() => {});
    return () => {
      unsubStream();
      unsubConfirm();
      unsubAsk();
      unsubCompaction();
      unsubSessionUpdated();
    };
  }, [isAuthenticated, handleStreamChunk, loadSessions]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const unsub = window.lionclaw.chat.onSessionsUpdated(() => {
      useChatStore.getState().loadSessions();
    });
    return unsub;
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;
    return useMcpDistStaleStore.getState().init();
  }, [isAuthenticated]);

  const confirmPopup = nextPopup?.kind === 'confirm' ? nextPopup : null;
  const askPopup = nextPopup?.kind === 'ask' ? nextPopup : null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-950">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-zinc-500">Carregando...</span>
        </div>
      </div>
    );
  }

  if (isFirstRun) {
    return <AuthPage mode="setup" />;
  }
  if (!isAuthenticated) {
    return <AuthPage mode="login" />;
  }
  if (!orchestratorSetupCompleted) {
    return <AuthPage mode="continue-sdk" />;
  }

  const pageContent = () => {
    switch (currentPage) {
      case 'chat':
        return <ChatPage />;
      case 'agents':
        return <SubAgentsPage />;
      case 'logs':
        return <LogsPage />;
      case 'settings':
        return <SettingsPage />;
      case 'skills':
        return <SkillsPage />;
      case 'mcp':
        return <MCPServersPage />;
      case 'scheduler':
        return <SchedulerPage />;
      case 'kanban':
        return <KanbanPage />;
      case 'knowledge':
        return <KnowledgePage />;
      case 'rules':
        return <MemoryPage />;
      case 'memory':
        return <MemoryPage />;
      case 'usage':
        return <UsagePage />;
      case 'vault':
        return <VaultPage />;
      case 'harness':
        return <HarnessPage />;
      case 'pipeline':
        return <PipelinePage />;
      case 'dynamic-workflow':
        return <DynamicWorkflowPage />;
      case 'repositories':
        return <RepositoriesPage />;
      default:
        return <ChatPage />;
    }
  };

  const handleConfirmResponse = (approved: boolean) => {
    if (confirmPopup) {
      void useChatStore.getState().resolveConfirmation(confirmPopup.action.id, approved);
    }
  };

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">{pageContent()}</div>
        <TerminalDock visible={currentPage === 'chat'} />
      </main>
      {confirmPopup && (
        <ConfirmDialog
          key={confirmPopup.action.id}
          action={confirmPopup.action}
          laneLabel={confirmPopup.label}
          onApprove={() => handleConfirmResponse(true)}
          onDeny={() => handleConfirmResponse(false)}
        />
      )}
      {askPopup && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 px-4">
          <div className="w-full">
            <AskQuestionDialog
              key={askPopup.request.id}
              request={askPopup.request}
              laneLabel={askPopup.label}
              onSubmit={(response) => void useChatStore.getState().resolveAskQuestion(response)}
            />
          </div>
        </div>
      )}
      {newChatDialogOpen && (
        <LaneClearDialog
          lanes={openLanes.slice().sort((a, b) => a.laneBadge - b.laneBadge)}
          compactions={compactions}
          onSelect={(sessionId) => {
            void useChatStore.getState().clearLane(sessionId);
          }}
          onCancel={() => useChatStore.getState().closeNewChatDialog()}
        />
      )}
      {/* SB-3: sink universal de erros (alimentado por qualquer store). */}
      <ErrorToastHost />
      <CodexAuthRequiredModal />
    </div>
  );
}
