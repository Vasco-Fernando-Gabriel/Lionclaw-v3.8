// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { DriveControls } from '@/components/pipeline/DriveControls';
import { useChatStore } from '@/stores/chat-store';
import { useDriveStore } from '@/stores/drive-store';
import { useErrorToastStore } from '@/stores/error-toast-store';
import { laneErrorTitle } from '@/lib/lanes';
import { lane, drive, mountedTest } from './lane-drive-fixtures';
const ui = mountedTest();
const resume = vi.fn();
let lanes = [lane('A', 1), lane('B', 2)];
let persisted = drive('B', 'stopped');
beforeEach(() => {
  persisted = drive('B', 'stopped');
  lanes = [
    lane('A', 1, { state: 'streaming', drive: { projectId: 'P1', name: 'P1', status: 'driving' } }),
    lane('B', 2),
  ];
  resume.mockReset().mockResolvedValue({ ok: true, sessionId: 'B' });
  Object.defineProperty(window, 'lionclaw', {
    configurable: true,
    value: {
      chat: { listOpenSessions: async () => lanes },
      drive: { getState: async () => persisted, resume },
    },
  });
  useChatStore.setState({ openLanes: lanes, currentSessionId: 'A' });
  useDriveStore.setState({ drives: new Map([['P2', persisted]]), pending: new Set() });
  useErrorToastStore.getState().clearToasts();
});
it('AC-3(c)/12: A ocupada por P1, B livre pre-selecionada; seletor tambem em driving', async () => {
  await ui.render(<DriveControls projectId="P2" />);
  const select = ui.container.querySelector('select')!;
  expect(select.options[0].disabled).toBe(true);
  expect(select.options[0].textContent).toContain(' - ocupada: dirige "P1"');
  expect(select.options[1].disabled).toBe(false);
  expect(select.value).toBe('B');
  await act(async () => {
    useDriveStore.getState()._apply('P2', drive('B'));
  });
  expect(ui.container.querySelector('select')).not.toBeNull();
});
it.each(['lane_busy', 'drive_owned_by_other_lane', 'session_clearing'] as const)(
  'recusa %s usa mensagem do main e titulo do codigo',
  async (code) => {
    resume.mockResolvedValue({ error: 'mensagem do main', code });
    await ui.render(<DriveControls projectId="P2" />);
    await act(async () => {
      ui.container.querySelector<HTMLButtonElement>('[data-testid="drive-resume-button"]')!.click();
    });
    expect(useErrorToastStore.getState().toasts[0]).toMatchObject({
      title: laneErrorTitle(code, ''),
      body: expect.stringContaining('mensagem do main'),
    });
  },
);
it.each(['clearing', 'interrupted'] as const)(
  'marca %s como em Clear e desabilita Retomar sem lane livre',
  async (state) => {
    lanes[1] = lane('B', 2, { state });
    await ui.render(<DriveControls projectId="P2" />);
    const option = ui.container.querySelectorAll('option')[1];
    expect(option.disabled).toBe(true);
    expect(option.textContent).toContain(' - em Clear');
    const button = ui.container.querySelector<HTMLButtonElement>('[data-testid="drive-resume-button"]')!;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('as 2 lanes ja dirigem pipelines');
  },
);
it('lane do proprio projeto permanece selecionavel; sessao fechada cai na visivel', async () => {
  lanes[1] = lane('B', 2, { drive: { projectId: 'P2', name: 'P2', status: 'awaiting-human' } });
  await ui.render(<DriveControls projectId="P2" />);
  expect(ui.container.querySelectorAll('option')[1].disabled).toBe(false);
  await act(async () => {
    useDriveStore.getState()._apply('P2', drive('closed', 'stopped'));
  });
  expect(ui.container.querySelector('select')!.value).toBe('A');
});
