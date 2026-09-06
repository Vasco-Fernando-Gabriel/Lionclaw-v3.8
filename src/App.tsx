import { useEffect, useState, useRef } from 'react';
import { Sidebar } from '@/components/common/Sidebar';
import { useAppStore } from '@/stores/app-store';
import { useAuthStore } from '@/stores/auth-store';
import { useChatStore } from '@/stores/chat-store';
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
// SPEC robustez-chat SB-3: sink universal de erros (toast global, AC-B7/B8).
import { ErrorToastHost } from '@/components/common/ErrorToastHost';
import { CodexAuthRequiredModal } from '@/components/pipeline/CodexAuthRequiredModal';
// SPEC terminal-chat DN-8: dock montado ACIMA do switch de paginas (shells
// sobrevivem a navegacao); visivel so no chat.
import { TerminalDock } from '@/components/chat/TerminalDock';
import type { ConfirmAction } from '@/types';

// Diferenciacao visual do ambiente de DESENVOLVIMENTO (npm run dev) vs o app
// instalado: titulo da janela/barra de tarefas ganha sufixo DEV. Em build de
// producao import.meta.env.DEV e false e nada muda.
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
          O renderer iniciou sem a API segura do LionClaw. Recarregue a janela.
          Se continuar, reinicie o app para restaurar a comunicacao IPC.
        </p>
        <p className="mt-3 font-mono text-xs text-zinc-500">
          window.lionclaw nao foi carregado
        </p>
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
  const { isAuthenticated, isFirstRun, isLoading, checkAuth, onboardingCompleted, checkOnboarding, orchestratorSetupCompleted } = useAuthStore();
  const { currentPage, setPage } = useAppStore();
  const { handleStreamChunk, loadSessions } = useChatStore();
  const { init: pipelineInit } = usePipelineStore();
  const { init: driveInit } = useDriveStore();
  const dynamicWorkflowInit = useDynamicWorkflowStore((s) => s.init);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const pipelineCleanupRef = useRef<(() => void) | null>(null);
  const driveCleanupRef = useRef<(() => void) | null>(null);
  const dynamicWorkflowCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Subscribe to auto-lock events (sleep, lid close)
  useEffect(() => {
    const unsubLock = window.lionclaw.auth.onLocked(() => {
      checkAuth();
    });
    return unsubLock;
  }, [checkAuth]);

  // Check onboarding status after authentication
  useEffect(() => {
    if (!isAuthenticated) return;
    checkOnboarding();
  }, [isAuthenticated, checkOnboarding]);

  // Force chat page during onboarding
  useEffect(() => {
    if (isAuthenticated && !onboardingCompleted) {
      setPage('chat');
    }
  }, [isAuthenticated, onboardingCompleted, setPage]);

  // Register pipeline IPC listeners once at app-level so stream chunks are
  // never lost when the user navigates away from PipelinePage.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (pipelineCleanupRef.current) return; // already registered
    const cleanup = pipelineInit();
    pipelineCleanupRef.current = cleanup;
    // No return cleanup: listeners persist for the app lifetime.
  }, [isAuthenticated, pipelineInit]);

  // Register drive `drive:state-changed` listener once at app-level (SPEC S8) so
  // the driver badge/state stays live regardless of which page is mounted.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (driveCleanupRef.current) return; // already registered
    const cleanup = driveInit();
    driveCleanupRef.current = cleanup;
    // No return cleanup: listener persists for the app lifetime.
  }, [isAuthenticated, driveInit]);

  // Register the dynamic-workflow `dynamic-workflow:stream` listener once at
  // app-level so the run view / pipezinho / stream stay live no matter which
  // page is mounted. Antes so o ChatPage montava (cockpit); na pagina de
  // Workflows o run congelava apesar dos eventos chegarem. init() e idempotente
  // (refcount no store), entao coexiste com o mount do ChatPage sem duplicar.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (dynamicWorkflowCleanupRef.current) return; // already registered
    const cleanup = dynamicWorkflowInit();
    dynamicWorkflowCleanupRef.current = cleanup;
    // No return cleanup: listener persists for the app lifetime.
  }, [isAuthenticated, dynamicWorkflowInit]);

  // Subscribe to chat stream events
  useEffect(() => {
    if (!isAuthenticated) return;
    const unsubStream = window.lionclaw.chat.onStream(handleStreamChunk);
    const unsubConfirm = window.lionclaw.chat.onConfirmRequest((action) => {
      setConfirmAction(action);
    });
    const unsubCompaction = window.lionclaw.chat.onCompactionActive((payload) => useChatStore.getState().setCompactionActive(payload));
    loadSessions();
    return () => {
      unsubStream();
      unsubConfirm();
      unsubCompaction();
    };
  }, [isAuthenticated, handleStreamChunk, loadSessions]);

  // Subscribe to sessions-updated events (title generation, etc.)
  useEffect(() => {
    if (!isAuthenticated) return;
    const unsub = window.lionclaw.chat.onSessionsUpdated(() => {
      useChatStore.getState().loadSessions();
    });
    return unsub;
  }, [isAuthenticated]);

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

  // Three-way gate (SPEC-onboarding §11 mudanca 6).
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
      case 'chat': return <ChatPage />;
      case 'agents': return <SubAgentsPage />;
      case 'logs': return <LogsPage />;
      case 'settings': return <SettingsPage />;
      case 'skills': return <SkillsPage />;
      case 'mcp': return <MCPServersPage />;
      case 'scheduler': return <SchedulerPage />;
      case 'kanban': return <KanbanPage />;
      case 'knowledge': return <KnowledgePage />;
      case 'rules': return <MemoryPage />;
      case 'memory': return <MemoryPage />;
      case 'usage': return <UsagePage />;
      case 'vault': return <VaultPage />;
      case 'harness': return <HarnessPage />;
      case 'pipeline': return <PipelinePage />;
      case 'dynamic-workflow': return <DynamicWorkflowPage />;
      case 'repositories': return <RepositoriesPage />;
      default: return <ChatPage />;
    }
  };

  const handleConfirmResponse = (approved: boolean) => {
    if (confirmAction) {
      window.lionclaw.chat.confirmResponse(confirmAction.id, approved);
      setConfirmAction(null);
    }
  };

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {pageContent()}
        </div>
        <TerminalDock visible={currentPage === 'chat'} />
      </main>
      {confirmAction && (
        <ConfirmDialog
          action={confirmAction}
          onApprove={() => handleConfirmResponse(true)}
          onDeny={() => handleConfirmResponse(false)}
        />
      )}
      {/* SB-3: sink universal de erros (alimentado por qualquer store). */}
      <ErrorToastHost />
      <CodexAuthRequiredModal />
    </div>
  );
}
