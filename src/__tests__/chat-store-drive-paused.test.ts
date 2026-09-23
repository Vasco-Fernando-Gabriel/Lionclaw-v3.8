// @vitest-environment jsdom
import { act, createElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createThreadState, useChatStore } from '@/stores/chat-store';
import { useDriveStore } from '@/stores/drive-store';
import { DriveLaneSelect } from '@/components/pipeline/DriveControls';
import type { DriveStateChangedEvent, OpenChatSession } from '@/types';
import { lane, drive, mountedTest } from './lane-drive-fixtures';
const ui = mountedTest();
let handler: (event: DriveStateChangedEvent) => void;
let lanes: OpenChatSession[];
const listOpenSessions = vi.fn<() => Promise<OpenChatSession[]>>();
function Consumer() {
  const openLanes = useChatStore((s) => s.openLanes);
  return createElement(DriveLaneSelect, { lanes: openLanes, value: 'B', onChange: () => {}, currentProjectId: 'P2' });
}
beforeEach(() => {
  lanes = [lane('A', 1), lane('B', 2)];
  listOpenSessions.mockReset().mockImplementation(async () => lanes);
  Object.defineProperty(window, 'lionclaw', {
    configurable: true,
    value: {
      settings: { get: async () => ({ voiceResponseEnabled: false }) },
      chat: { listOpenSessions, getSessions: async () => [], getMessages: async () => [] },
      drive: {
        onStateChanged: (cb: typeof handler) => {
          handler = cb;
          return () => {};
        },
      },
    },
  });
  useChatStore.setState({
    currentSessionId: 'A',
    threads: { A: createThreadState({ isStreaming: true, streamTurnStartedAt: 123 }) },
    openLanes: lanes,
  });
  useDriveStore.setState({ drives: new Map() });
});
it.each(['', 'resposta'])('drive_paused preserva turno humano; done limpa a pausa (%s)', async (streamingContent) => {
  useChatStore.setState({
    threads: { A: createThreadState({ isStreaming: true, streamTurnStartedAt: 123, streamingContent }) },
  });
  const store = useChatStore.getState();
  store.handleStreamChunk({ type: 'drive_paused', sessionId: 'A' });
  expect(useChatStore.getState().threads.A).toMatchObject({
    drivePaused: true,
    isStreaming: true,
    streamTurnStartedAt: 123,
  });
  store.handleStreamChunk({ type: 'done', sessionId: 'A' });
  await Promise.resolve();
  expect(useChatStore.getState().threads.A).toMatchObject({ drivePaused: false, isStreaming: false });
});
it('drive_paused para thread ausente nao cria thread', () => {
  useChatStore.getState().handleStreamChunk({ type: 'drive_paused', sessionId: 'missing' });
  expect(useChatStore.getState().threads.missing).toBeUndefined();
});
it('listener real limpa pausa na lane do payload ao voltar a driving sem done', async () => {
  const cleanup = useDriveStore.getState().init();
  useChatStore.getState().setDrivePausedForSession('A', true);
  handler({ projectId: 'P1', drive: drive('A', 'awaiting-human'), sessionId: 'A', laneBadge: 1 });
  handler({ projectId: 'P1', drive: drive('A'), sessionId: 'A', laneBadge: 1 });
  await Promise.resolve();
  expect(useChatStore.getState().threads.A).toMatchObject({
    drivePaused: false,
    isStreaming: true,
    streamTurnStartedAt: 123,
  });
  expect(listOpenSessions).toHaveBeenCalledTimes(2);
  cleanup();
});
it('consumidor montado recebe start/escalate/migracao/stop inclusive streaming, sem reload da UI', async () => {
  const cleanup = useDriveStore.getState().init();
  await ui.render(createElement(Consumer));
  for (const status of ['driving', 'awaiting-human'] as const) {
    lanes = [
      lane('A', 1, { state: 'streaming', drive: { projectId: 'P1', name: `P1 ${status}`, status } }),
      lane('B', 2),
    ];
    await act(async () => {
      handler({ projectId: 'P1', drive: drive('A', status), sessionId: 'A', laneBadge: 1 });
    });
    expect(ui.container.querySelectorAll('option')[0].textContent).toContain(`P1 ${status}`);
    expect(ui.container.querySelectorAll('option')[0].disabled).toBe(true);
    expect(useChatStore.getState().openLanes[0].drive?.status).toBe(status);
  }
  lanes = [lane('A', 1), lane('B', 2, { drive: { projectId: 'P1', name: 'P1 migrado', status: 'driving' } })];
  await act(async () => {
    handler({ projectId: 'P1', drive: drive('B'), sessionId: 'B', laneBadge: 2 });
  });
  expect([...ui.container.querySelectorAll('option')].map((o) => o.disabled)).toEqual([false, true]);
  expect(ui.container.textContent).toContain('P1 migrado');
  lanes = [lane('A', 1), lane('B', 2)];
  await act(async () => {
    handler({ projectId: 'P1', drive: null, sessionId: 'B', laneBadge: 2 });
  });
  expect([...ui.container.querySelectorAll('option')].map((o) => o.disabled)).toEqual([false, false]);
  expect(ui.container.textContent).not.toContain('P1');
  expect(listOpenSessions).toHaveBeenCalledTimes(4);
  cleanup();
});
it('eventos consecutivos: resposta antiga nao sobrescreve migracao mais recente', async () => {
  const cleanup = useDriveStore.getState().init();
  let resolveOld!: (lanes: OpenChatSession[]) => void;
  listOpenSessions.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  handler({ projectId: 'P1', drive: drive('A'), sessionId: 'A', laneBadge: 1 });
  lanes = [lane('A', 1), lane('B', 2, { drive: { projectId: 'P1', name: 'novo', status: 'driving' } })];
  handler({ projectId: 'P1', drive: drive('B'), sessionId: 'B', laneBadge: 2 });
  await Promise.resolve();
  resolveOld([lane('A', 1, { drive: { projectId: 'P1', name: 'antigo', status: 'driving' } }), lane('B', 2)]);
  await Promise.resolve();
  expect(useChatStore.getState().openLanes).toEqual(lanes);
  cleanup();
});
