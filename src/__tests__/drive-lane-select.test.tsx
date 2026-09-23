// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatLaneErrorCode, DriveState, OpenChatSession } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const resumeCalls: Array<{ projectId: string; sessionId: string }> = [];
let resumeResult: { ok: true; drive: DriveState; sessionId: string } | { error: string; code?: ChatLaneErrorCode };
let openLanes: OpenChatSession[] = [];
let persistedDrive: DriveState;
let container: HTMLDivElement;
let root: Root | null = null;

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

const stoppedDrive: DriveState = {
  driver: 'orchestrator',
  status: 'stopped',
  handoff: 'none',
  mode: 'semi',
  requiresHumanPhases: [],
};

beforeAll(() => {
  (window as unknown as Record<string, unknown>).lionclaw = {
    drive: {
      getState: async () => persistedDrive,
      resume: async (projectId: string, sessionId: string) => {
        resumeCalls.push({ projectId, sessionId });
        return resumeResult;
      },
      onStateChanged: () => () => {},
    },
    chat: {
      listOpenSessions: async () => openLanes,
      getSessions: async () => [],
    },
  };
});

async function getStores() {
  const chat = await import('@/stores/chat-store');
  const drive = await import('@/stores/drive-store');
  const toast = await import('@/stores/error-toast-store');
  return {
    useChatStore: chat.useChatStore,
    useDriveStore: drive.useDriveStore,
    useErrorToastStore: toast.useErrorToastStore,
  };
}

async function renderControls(projectId: string) {
  const { DriveControls } = await import('@/components/pipeline/DriveControls');
  await act(async () => {
    root = createRoot(container);
    root.render(<DriveControls projectId={projectId} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(async () => {
  const { useChatStore, useDriveStore, useErrorToastStore } = await getStores();
  resumeCalls.length = 0;
  resumeResult = { ok: true, drive: { ...stoppedDrive, status: 'driving' }, sessionId: 'a' };
  openLanes = [];
  persistedDrive = stoppedDrive;
  useErrorToastStore.getState().clearToasts();
  useChatStore.setState({ openLanes: [], currentSessionId: null });
  useDriveStore.setState({ drives: new Map([['p1', stoppedDrive]]), pending: new Set() });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  const r = root;
  if (r) {
    act(() => {
      r.unmount();
    });
    root = null;
  }
  container.remove();
});

describe('AC-23 (UI): seletor de lane do drive na pagina Pipeline', () => {
  it('lista as lanes abertas com badge e titulo, pre-selecionada a lane visivel do chat', async () => {
    const { useChatStore } = await getStores();
    openLanes = [lane('a', 1, 'Primeira'), lane('b', 2, 'Segunda')];
    useChatStore.setState({ openLanes, currentSessionId: 'b' });

    await renderControls('p1');

    const select = container.querySelector<HTMLSelectElement>('[data-testid="drive-lane-select"]')!;
    expect(select).not.toBeNull();
    expect(select.disabled).toBe(false);
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Lane 1: Primeira', 'Lane 2: Segunda']);
    expect(select.value).toBe('b');

    const resume = container.querySelector<HTMLButtonElement>('[data-testid="drive-resume-button"]')!;
    expect(resume.disabled).toBe(false);
    await act(async () => {
      resume.click();
    });
    expect(resumeCalls).toEqual([{ projectId: 'p1', sessionId: 'b' }]);
  });

  it('sem lane aberta o botao fica desabilitado com "abra um chat"', async () => {
    await renderControls('p1');
    const select = container.querySelector<HTMLSelectElement>('[data-testid="drive-lane-select"]')!;
    expect(select).toBeNull();
    const resume = container.querySelector<HTMLButtonElement>('[data-testid="drive-resume-button"]')!;
    expect(resume.disabled).toBe(true);
    expect(resume.title).toMatch(/Abra um chat/);
  });

  it('resume que volta com sessionId diferente do escolhido avisa qual lane ficou', async () => {
    const { useChatStore, useErrorToastStore } = await getStores();
    openLanes = [lane('a', 1, 'Primeira'), lane('b', 2, 'Segunda')];
    useChatStore.setState({ openLanes, currentSessionId: 'b' });
    resumeResult = { ok: true, drive: { ...stoppedDrive, status: 'driving', sessionId: 'a' }, sessionId: 'a' };

    await renderControls('p1');
    const resume = container.querySelector<HTMLButtonElement>('[data-testid="drive-resume-button"]')!;
    await act(async () => {
      resume.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const toasts = useErrorToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('Drive retomado na lane persistida');
    expect(toasts[0].body).toContain('Lane 1: Primeira');
  });

  it('resume com persisted.sessionId de lane encerrada mostra o seletor e retoma na lane escolhida', async () => {
    const { useChatStore, useDriveStore } = await getStores();
    openLanes = [lane('a', 1, 'Primeira'), lane('b', 2, 'Segunda')];
    useChatStore.setState({ openLanes, currentSessionId: 'a' });
    persistedDrive = { ...stoppedDrive, sessionId: 'encerrada' };
    useDriveStore.setState({ drives: new Map([['p1', persistedDrive]]) });

    await renderControls('p1');
    const select = container.querySelector<HTMLSelectElement>('[data-testid="drive-lane-select"]')!;
    expect(select).not.toBeNull();
    expect(select.value).toBe('a');
    const resume = container.querySelector<HTMLButtonElement>('[data-testid="drive-resume-button"]')!;
    expect(resume.disabled).toBe(false);
    await act(async () => {
      resume.click();
    });
    expect(resumeCalls).toEqual([{ projectId: 'p1', sessionId: 'a' }]);
  });

  it('erro tipado do main vira toast com o titulo do codigo', async () => {
    const { useChatStore, useErrorToastStore } = await getStores();
    openLanes = [lane('a', 1, 'Primeira')];
    useChatStore.setState({ openLanes, currentSessionId: 'a' });
    resumeResult = {
      error: 'session_not_active: a conversa escolhida nao e uma lane aberta.',
      code: 'session_not_active',
    };

    await renderControls('p1');
    const resume = container.querySelector<HTMLButtonElement>('[data-testid="drive-resume-button"]')!;
    await act(async () => {
      resume.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const toasts = useErrorToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('Conversa encerrada');
  });

  it('drive com lane persistida ainda aberta mantem seletor com a lane que o abriu', async () => {
    const { useChatStore, useDriveStore } = await getStores();
    openLanes = [lane('a', 1, 'Primeira'), lane('b', 2, 'Segunda')];
    useChatStore.setState({ openLanes, currentSessionId: 'b' });
    persistedDrive = { ...stoppedDrive, sessionId: 'a' };
    useDriveStore.setState({ drives: new Map([['p1', persistedDrive]]) });

    await renderControls('p1');
    expect(container.querySelector<HTMLSelectElement>('[data-testid="drive-lane-select"]')?.value).toBe('a');
    const resume = container.querySelector<HTMLButtonElement>('[data-testid="drive-resume-button"]')!;
    expect(resume.disabled).toBe(false);
  });
});
