// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { AskQuestionDialog } from '@/components/chat/AskQuestionDialog';
import { createThreadState, selectNextPopup, useChatStore } from '@/stores/chat-store';
import type { OpenChatSession } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const confirmCalls: Array<{ id: string; approved: boolean }> = [];
const askCalls: string[] = [];

function lane(id: string, laneBadge: number, title: string): OpenChatSession {
  return {
    id,
    laneBadge,
    title,
    orchestrator: null,
    messageCount: 1,
    lastUserMessageAt: null,
    createdAt: '2026-09-08T09:00:00.000Z',
    updatedAt: '2026-09-08T09:00:00.000Z',
    state: 'idle',
    drive: null,
  };
}

function PopupHost() {
  const popup = useChatStore(selectNextPopup);
  if (!popup) return null;
  if (popup.kind === 'confirm') {
    return (
      <ConfirmDialog
        key={popup.action.id}
        action={popup.action}
        laneLabel={popup.label}
        onApprove={() => void useChatStore.getState().resolveConfirmation(popup.action.id, true)}
        onDeny={() => void useChatStore.getState().resolveConfirmation(popup.action.id, false)}
      />
    );
  }
  return (
    <AskQuestionDialog
      key={popup.request.id}
      request={popup.request}
      laneLabel={popup.label}
      onSubmit={(response) => void useChatStore.getState().resolveAskQuestion(response)}
    />
  );
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  confirmCalls.length = 0;
  askCalls.length = 0;
  (window as unknown as Record<string, unknown>).lionclaw = {
    chat: {
      confirmResponse: async (id: string, approved: boolean) => {
        confirmCalls.push({ id, approved });
      },
      askResponse: async (response: { id: string }) => {
        askCalls.push(response.id);
      },
    },
  };
  useChatStore.setState({
    openLanes: [lane('a', 1, 'Primeira'), lane('b', 2, 'Bug do login')],
    currentSessionId: 'a',
    threads: { a: createThreadState({ hydrated: true }), b: createThreadState({ hydrated: true }) },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(<PopupHost />);
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
});

describe('AC-19 / 10.4: um modal global por vez, rotulado com a lane, FIFO entre lanes', () => {
  it('popup de B aparece rotulado "Lane 2: Bug do login" com A visivel; aprovar libera B e mostra o proximo (de A)', async () => {
    act(() => {
      useChatStore.getState().enqueueConfirmation({
        id: 'c-b',
        tool: 'Bash',
        description: 'rm -rf',
        input: {},
        risk: 'high',
        sessionId: 'b',
      });
      useChatStore.getState().enqueueConfirmation({
        id: 'c-a',
        tool: 'Write',
        description: 'grava',
        input: {},
        risk: 'medium',
        sessionId: 'a',
      });
    });

    expect(container.querySelector('[data-testid="confirm-lane-label"]')?.textContent).toBe('Lane 2: Bug do login');
    expect(container.textContent).toContain('rm -rf');
    expect(container.textContent).not.toContain('grava');
    expect(useChatStore.getState().currentSessionId).toBe('a');

    const approve = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Aprovar'))!;
    await act(async () => {
      approve.click();
      await Promise.resolve();
    });

    expect(confirmCalls).toEqual([{ id: 'c-b', approved: true }]);
    expect(useChatStore.getState().threads.b.pendingConfirmations).toEqual([]);
    expect(container.querySelector('[data-testid="confirm-lane-label"]')?.textContent).toBe('Lane 1: Primeira');
    expect(container.textContent).toContain('grava');
  });

  it('ask_question de B na fila atras de um confirm de A: responder o confirm revela a pergunta rotulada', async () => {
    act(() => {
      useChatStore.getState().enqueueConfirmation({
        id: 'c-a',
        tool: 'Write',
        description: 'grava',
        input: {},
        risk: 'medium',
        sessionId: 'a',
      });
      useChatStore.getState().enqueueAskQuestion({
        id: 'q-b',
        sessionId: 'b',
        questions: [{ question: 'Qual?', header: 'H', options: [{ label: 'x', description: 'd' }] }],
      });
    });
    expect(container.querySelector('[data-testid="ask-lane-label"]')).toBeNull();

    const deny = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Negar'))!;
    await act(async () => {
      deny.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="ask-lane-label"]')?.textContent).toBe('Lane 2: Bug do login');
    const option = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('x'))!;
    act(() => {
      option.click();
    });
    const submit = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Responder'))!;
    await act(async () => {
      submit.click();
      await Promise.resolve();
    });
    expect(askCalls).toEqual(['q-b']);
    expect(container.innerHTML).toBe('');
  });
});
