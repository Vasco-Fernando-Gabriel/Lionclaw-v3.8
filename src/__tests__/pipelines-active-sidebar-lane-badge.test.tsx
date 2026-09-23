// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { PipelinesActiveSidebar } from '@/components/common/PipelinesActiveSidebar';
import { useChatStore } from '@/stores/chat-store';
import { useDriveStore } from '@/stores/drive-store';
import { usePipelineStore } from '@/stores/pipeline-store';
import { laneLabel } from '@/lib/lanes';
import { lane, drive, project, mountedTest } from './lane-drive-fixtures';
const ui = mountedTest();
const load = vi.fn(async () => [lane('A', 1), lane('B', 2)]);
beforeEach(() => {
  load.mockClear();
  Object.defineProperty(window, 'lionclaw', {
    configurable: true,
    value: {
      chat: { listOpenSessions: load },
      drive: { getState: async (id: string) => drive(id === 'P1' ? 'A' : id === 'P2' ? 'B' : 'closed') },
    },
  });
  useChatStore.setState({ openLanes: [] });
  useDriveStore.setState({ drives: new Map(), pending: new Set() });
  usePipelineStore.setState({ projects: ['P1', 'P2', 'P3'].map(project), projectStates: new Map() });
  for (const id of ['P1', 'P2', 'P3']) usePipelineStore.getState()._setProjectState(id, { isStreaming: true });
});
it('AC-12: badges por sessionId, sem fallback para lane fechada; carrega uma vez', async () => {
  await ui.render(<PipelinesActiveSidebar />);
  const badges = [...ui.container.querySelectorAll<HTMLElement>('[data-testid="drive-lane-badge"]')];
  expect(badges.map((b) => [b.textContent, b.title])).toEqual([
    ['L1', laneLabel(lane('A', 1))],
    ['L2', laneLabel(lane('B', 2))],
  ]);
  expect(badges[0].parentElement?.textContent).toContain('P1');
  expect(badges[1].parentElement?.textContent).toContain('P2');
  await ui.render(<PipelinesActiveSidebar />);
  expect(load).toHaveBeenCalledTimes(1);
});
