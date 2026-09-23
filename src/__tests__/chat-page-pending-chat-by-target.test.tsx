// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ChatPage } from '@/pages/ChatPage';
import { useChatStore, createThreadState } from '@/stores/chat-store';
import { useAppStore } from '@/stores/app-store';
import { useAuthStore } from '@/stores/auth-store';
import { useDriveStore } from '@/stores/drive-store';
import { usePipelineStore } from '@/stores/pipeline-store';
import { useErrorToastStore } from '@/stores/error-toast-store';
import type { ChatSessionUpdatedEvent, OpenChatSession } from '@/types';
import { lane, drive, project, mountedTest } from './lane-drive-fixtures';
const ui = mountedTest();
const sendMessage = vi.fn<ReturnType<typeof useChatStore.getState>['sendMessage']>(async () => {});
const originalSend = useChatStore.getState().sendMessage;
let lanes: OpenChatSession[];
beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  lanes = [lane('A', 1), lane('B', 2)];
  Object.defineProperty(window, 'lionclaw', {
    configurable: true,
    value: {
      settings: { get: async () => ({}) },
      tools: { getBypass: async () => true, getTelegramArmed: async () => false },
      chat: { listOpenSessions: async () => lanes, getFeatureToggles: async () => ({ ok: true, toggles: {} }) },
      swarm: { onStream: () => () => {}, listRuns: async () => ({ runs: [] }) },
      mcp: { list: async () => [] },
      provider: { listStatuses: async () => [] },
      repoGraph: {
        onStatus: () => () => {},
        list: async () => [],
        getSessionState: async (sessionId: string) => ({ sessionId, repository: null }),
      },
      dynamicWorkflow: { onEvent: () => () => {}, listRuns: async () => [] },
    },
  });
  sendMessage.mockClear();
  useChatStore.setState({
    currentSessionId: 'A',
    sessions: [],
    telegramSessions: [],
    openLanes: lanes,
    threads: { A: createThreadState(), B: createThreadState() },
    compactions: {},
    streamingSessionIds: new Set(),
    onboardingAutostartSessionId: null,
    sendMessage,
    drafts: {},
  });
  useAppStore.setState({ pendingChatByTarget: {} });
  useAuthStore.setState({ onboardingCompleted: true });
  useDriveStore.setState({ drives: new Map() });
  usePipelineStore.setState({ projects: [project('P1')] });
  useErrorToastStore.getState().clearToasts();
});
function handoffs() {
  useAppStore.getState().setPendingChat('para A', 'agent-A', { targetSessionId: 'A' });
  useAppStore.getState().setPendingChat('para B', 'agent-B', { targetSessionId: 'B' });
}
function mainState(state: OpenChatSession['state']) {
  const event: ChatSessionUpdatedEvent = { sessionId: 'A', laneBadge: 1, orchestrator: null, messageCount: 4, state };
  useChatStore.getState().applySessionUpdated(event);
}
it('main streaming bloqueia apesar de local false; main idle envia apesar de local true e preserva B', async () => {
  lanes = [lane('A', 1, { state: 'streaming' }), lanes[1]];
  useChatStore.setState({ openLanes: lanes });
  handoffs();
  await ui.render(<ChatPage />);
  expect(sendMessage).not.toHaveBeenCalled();
  await act(async () => {
    useChatStore.setState({ threads: { A: createThreadState({ isStreaming: true }), B: createThreadState() } });
    mainState('idle');
  });
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith('para A', 'agent-A', undefined, 'A');
  expect(Object.keys(useAppStore.getState().pendingChatByTarget)).toEqual(['B']);
  await act(async () => {
    useChatStore.setState({ currentSessionId: 'B' });
  });
  expect(sendMessage).toHaveBeenLastCalledWith('para B', 'agent-B', undefined, 'B');
  expect(useAppStore.getState().pendingChatByTarget).toEqual({});
});
it('awaiting-human bloqueia inclusive streaming, limpa apenas A e informa badge', async () => {
  useChatStore.setState({
    openLanes: [
      lane('A', 1, { state: 'streaming', drive: { projectId: 'P1', name: 'P1', status: 'awaiting-human' } }),
      lanes[1],
    ],
  });
  handoffs();
  await ui.render(<ChatPage />);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(Object.keys(useAppStore.getState().pendingChatByTarget)).toEqual(['B']);
  expect(useErrorToastStore.getState().toasts[0].title).toBe(
    'a Lane 1 aguarda resposta do pipeline; envie manualmente ou escolha outra lane',
  );
});
it('visible espera idle e entrada explicita tem precedencia sem perder a proxima', async () => {
  lanes = [lane('A', 1, { state: 'queued' }), lanes[1]];
  useChatStore.setState({ openLanes: lanes });
  useAppStore.getState().setPendingChat('visivel');
  useAppStore.getState().setPendingChat('explicita', undefined, { targetSessionId: 'A' });
  await ui.render(<ChatPage />);
  expect(sendMessage).not.toHaveBeenCalled();
  await act(async () => {
    mainState('idle');
  });
  expect(sendMessage.mock.calls.map((call) => [call[0], call[3]])).toEqual([
    ['explicita', 'A'],
    ['visivel', 'A'],
  ]);
});
it('sem chip nem placeholder de pipeline no chat (D7); Clear e compactacao acima do padrao', async () => {
  useDriveStore.setState({ drives: new Map([['P1', drive('A', 'awaiting-human')]]) });
  await ui.render(<ChatPage />);
  expect(ui.container.querySelector('[data-testid="lane-drive-chip"]')).toBeNull();
  const placeholder = () => ui.container.querySelector('textarea')?.placeholder;
  expect(placeholder()).toBe('Mensagem...');
  await act(async () => {
    mainState('interrupted');
  });
  expect(placeholder()).toBe('Clear interrompido: refaca o Clear');
  await act(async () => {
    mainState('clearing');
    useChatStore.setState({ compactions: { A: { phase: 'running', modelLabel: '', source: 'lionclaw' } } });
  });
  expect(placeholder()).toBe('Clear em andamento...');
  await act(async () => {
    mainState('idle');
    useChatStore.setState({ compactions: { A: { phase: 'running', modelLabel: '', source: 'sdk' } } });
  });
  expect(placeholder()).toBe('Compactando sessao...');
  await act(async () => {
    useChatStore.setState({ currentSessionId: 'B' });
  });
  expect(placeholder()).toBe('Mensagem...');
});
it('auto-envio usa sendMessage real mesmo com isStreaming local true', async () => {
  const send = vi.fn(async () => ({ ok: true }));
  Object.assign(window.lionclaw.chat, { send });
  useChatStore.setState({ sendMessage: originalSend, threads: { A: createThreadState({ isStreaming: true }) } });
  useAppStore.getState().setPendingChat('real', undefined, { targetSessionId: 'A' });
  await ui.render(<ChatPage />);
  expect(send).toHaveBeenCalled();
});
