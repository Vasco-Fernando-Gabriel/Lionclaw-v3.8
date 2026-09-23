// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { useAppStore } from '@/stores/app-store';
beforeEach(() => useAppStore.setState({ pendingChatByTarget: {} }));
it('AC-12: dois alvos coexistem, limpar A preserva B e visible', () => {
  const store = useAppStore.getState();
  store.setPendingChat('a', 'agent', { targetSessionId: 'A', awaitRepoReady: 'repo' });
  store.setPendingChat('b', undefined, { targetSessionId: 'B' });
  store.setPendingChat('visivel');
  expect(useAppStore.getState().pendingChatByTarget.A).toEqual({
    message: 'a',
    agentId: 'agent',
    awaitRepoReady: 'repo',
    targetSessionId: 'A',
  });
  store.clearPendingChat('A');
  expect(Object.keys(useAppStore.getState().pendingChatByTarget)).toEqual(['B', 'visible']);
  expect(useAppStore.getState().pendingChatByTarget.B.message).toBe('b');
});

it('migracao descarta shape legado e preserva preferencias de navegacao', async () => {
  const legacyMessageKey = 'pendingChat' + 'Message';
  localStorage.setItem(
    'lionclaw-app',
    JSON.stringify({
      version: 1,
      state: {
        currentPage: 'pipeline',
        sidebarCollapsed: true,
        [legacyMessageKey]: 'legado',
        pendingChatTargetSessionId: 'A',
      },
    }),
  );
  await useAppStore.persist.rehydrate();
  expect(useAppStore.getState()).toMatchObject({
    currentPage: 'pipeline',
    sidebarCollapsed: true,
    pendingChatByTarget: {},
  });
  expect(legacyMessageKey in useAppStore.getState()).toBe(false);
  expect('pendingChatTargetSessionId' in useAppStore.getState()).toBe(false);
});
