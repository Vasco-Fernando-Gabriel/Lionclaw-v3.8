// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { LaneClearDialog } from '@/components/chat/LaneClearDialog';
import { Sidebar } from '@/components/common/Sidebar';
import { useChatStore } from '@/stores/chat-store';
import { useAppStore } from '@/stores/app-store';
import { useAuthStore } from '@/stores/auth-store';
import { lane, mountedTest } from './lane-drive-fixtures';
vi.mock('@/components/common/BootInstallIndicator', () => ({ BootInstallIndicator: () => null }));
const ui = mountedTest();
beforeEach(() => {
  Object.defineProperty(window, 'lionclaw', {
    configurable: true,
    value: {
      scheduler: { getPendingReviewCount: async () => 0 },
      tasks: { getPendingDueCount: async () => 0 },
      app: { getVersion: async () => ({ label: 'test' }) },
    },
  });
  useAppStore.setState({ currentPage: 'chat', sidebarCollapsed: false });
  useAuthStore.setState({ onboardingCompleted: true });
  useChatStore.setState({
    sessions: [],
    telegramSessions: [],
    threads: {},
    compactions: {},
    streamingSessionIds: new Set(),
  });
});
it.each(['driving', 'awaiting-human'] as const)(
  'popup e sidebar exibem nome com %s mesmo em streaming; remover drive remove nome',
  async (status) => {
    const lanes = [
      lane('A', 1, { state: 'streaming', drive: { projectId: 'P1', name: 'Meu pipeline', status } }),
      lane('B', 2, { state: 'drive', drive: { projectId: 'P2', name: 'Outro pipeline', status } }),
    ];
    useChatStore.setState({ openLanes: lanes });
    await ui.render(
      <>
        <Sidebar />
        <LaneClearDialog lanes={lanes} compactions={{}} onSelect={() => {}} onCancel={() => {}} />
      </>,
    );
    expect(ui.container.querySelector('[data-testid="lane-clear-option-1"]')?.textContent).toContain('Meu pipeline');
    expect(ui.container.querySelector('[data-testid="lane-clear-option-2"]')?.textContent).toContain('Outro pipeline');
    expect(ui.container.querySelector('[data-testid="lane-row-1"]')?.textContent).toContain(
      'ocupada: dirige "Meu pipeline"',
    );
    expect(ui.container.querySelector('[data-testid="lane-stale-1"]')?.textContent).toContain(
      'pare o drive do pipeline "Meu pipeline" antes de dar Clear',
    );
    const cleared = lanes.map((l) => ({ ...l, drive: null }));
    await act(async () => {
      useChatStore.setState({ openLanes: cleared });
    });
    await ui.render(
      <>
        <Sidebar />
        <LaneClearDialog lanes={cleared} compactions={{}} onSelect={() => {}} onCancel={() => {}} />
      </>,
    );
    expect(ui.container.textContent).not.toContain('Meu pipeline');
    expect(ui.container.textContent).not.toContain('Outro pipeline');
  },
);
