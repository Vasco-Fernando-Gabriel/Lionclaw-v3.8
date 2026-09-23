// @vitest-environment jsdom
import { act, createElement } from 'react';
import { ErrorToastHost } from '@/components/common/ErrorToastHost';
import { mountedTest } from './lane-drive-fixtures';
import { beforeEach, expect, it, vi } from 'vitest';
import { usePipelineStore } from '@/stores/pipeline-store';
import { useChatStore } from '@/stores/chat-store';
import { useErrorToastStore } from '@/stores/error-toast-store';
const send = vi.fn();
const ui = mountedTest();
beforeEach(() => {
  Object.defineProperty(window, 'lionclaw', { configurable: true, value: { pipeline: { send } } });
  usePipelineStore.setState({ activeProjectId: 'P1', projectStates: new Map() });
  useChatStore.setState({ currentSessionId: 'B' });
  useErrorToastStore.getState().clearToasts();
});
it('retomada em A com B visivel emite notice informativo', async () => {
  send.mockResolvedValue({ ok: true, laneBadge: 1, resumedInSessionId: 'A' });
  await usePipelineStore.getState().sendMessage('resposta');
  expect(useErrorToastStore.getState().toasts[0]).toMatchObject({
    title: 'drive retomado na Lane 1',
    tone: 'info',
    source: 'pipeline',
  });
});
it.each([{ ok: true }, { ok: true, laneBadge: 2, resumedInSessionId: 'B' }])(
  'retorno sem retomada fora da lane visivel nao emite toast: %j',
  async (result) => {
    send.mockResolvedValue(result);
    await usePipelineStore.getState().sendMessage('resposta');
    expect(useErrorToastStore.getState().toasts).toEqual([]);
  },
);
it('session_not_active mantem erro do projeto e mostra toast', async () => {
  send.mockResolvedValue({ error: 'lane encerrada', code: 'session_not_active' });
  await usePipelineStore.getState().sendMessage('resposta');
  expect(usePipelineStore.getState().projectStates.get('P1')?.error).toBe('lane encerrada');
  expect(useErrorToastStore.getState().toasts[0]).toMatchObject({ title: 'Conversa encerrada', tone: 'error' });
});

it('host montado renderiza a retomada como informacao', async () => {
  send.mockResolvedValue({ ok: true, laneBadge: 1, resumedInSessionId: 'A' });
  await ui.render(createElement(ErrorToastHost));
  await act(async () => {
    await usePipelineStore.getState().sendMessage('resposta');
  });
  const toast = ui.container.querySelector('[data-testid="error-toast"]');
  expect(toast?.getAttribute('data-tone')).toBe('info');
  expect(toast?.textContent).toContain('drive retomado na Lane 1');
});
