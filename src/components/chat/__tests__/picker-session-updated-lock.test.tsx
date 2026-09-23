// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderModelPicker } from '../composer/ProviderModelPicker';
import { LOCKED_PICKER_FOOTER, lockedProviderFor } from '../composer/model-picker.logic';
import { useChatStore, selectLaneOrchestrator } from '@/stores/chat-store';
import type { OpenChatSession, ProviderStatusEntry } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRIES: ProviderStatusEntry[] = [
  {
    runtime: 'claude-sdk',
    provider: 'anthropic',
    connected: true,
    available: true,
    models: [
      {
        id: 'claude-opus-5',
        displayName: 'Claude Opus 5',
        label: 'Claude Opus 5',
        reasoningOptions: ['low', 'high'],
        defaultReasoning: 'high',
      },
    ],
  },
  {
    runtime: 'codex-sdk',
    provider: 'codex',
    connected: true,
    available: true,
    models: [
      {
        id: 'gpt-6-astra',
        displayName: 'GPT-6-Astra',
        label: 'GPT-6-Astra',
        reasoningOptions: ['low', 'high'],
        defaultReasoning: 'high',
      },
    ],
  },
];

function lane(over: Partial<OpenChatSession> = {}): OpenChatSession {
  return {
    id: 'a',
    laneBadge: 1,
    title: 'Lane 1',
    orchestrator: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-5', effort: 'high' },
    messageCount: 0,
    lastUserMessageAt: null,
    createdAt: '2026-09-08T09:00:00.000Z',
    updatedAt: '2026-09-08T09:00:00.000Z',
    state: 'idle',
    drive: null,
    ...over,
  };
}

function LanePicker() {
  const currentLane = useChatStore((s) => s.openLanes.find((l) => l.id === s.currentSessionId) ?? null);
  const selection = useChatStore((s) => selectLaneOrchestrator(s, s.currentSessionId));
  const lockProvider = lockedProviderFor(currentLane);
  return (
    <ProviderModelPicker
      selection={selection}
      entries={ENTRIES}
      phase="ready"
      lockProvider={lockProvider}
      lockedFooter={LOCKED_PICKER_FOOTER}
      onRefresh={() => {}}
      onSelect={() => {}}
    />
  );
}

let container: HTMLDivElement;
let root: Root | null = null;

function popover(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-model-picker-content]');
}

function openPicker(): void {
  act(() => {
    container.querySelector<HTMLButtonElement>('[data-testid="chat-lane-orchestrator"]')!.click();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  useChatStore.setState({ openLanes: [lane()], sessions: [], currentSessionId: 'a' });
  act(() => {
    root = createRoot(container);
    root.render(<LanePicker />);
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
});

describe('7.4 (renderer): chat:session-updated com a primeira mensagem fecha o picker aberto e trava o provider', () => {
  it('lane vazia aberta com a coluna de providers; session-updated messageCount 1 fecha (DisabledCloser) e reabre travado', () => {
    openPicker();
    expect(popover()).not.toBeNull();
    expect(popover()!.querySelector('nav[aria-label="Providers"]')).not.toBeNull();

    act(() => {
      useChatStore.getState().applySessionUpdated({
        sessionId: 'a',
        laneBadge: 1,
        orchestrator: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-5', effort: 'high' },
        messageCount: 1,
        state: 'streaming',
      });
    });

    expect(popover()).toBeNull();
    expect(lockedProviderFor(useChatStore.getState().openLanes[0])).toEqual({
      runtime: 'claude-sdk',
      provider: 'anthropic',
    });

    openPicker();
    const pop = popover()!;
    expect(pop.querySelector('nav[aria-label="Providers"]')).toBeNull();
    expect(pop.querySelector('[data-testid="model-picker-footer"]')?.textContent).toBe(LOCKED_PICKER_FOOTER);
  });

  it('session-updated com messageCount 0 mas state streaming (turno em voo) tambem trava', () => {
    openPicker();
    act(() => {
      useChatStore.getState().applySessionUpdated({
        sessionId: 'a',
        laneBadge: 1,
        orchestrator: lane().orchestrator,
        messageCount: 0,
        state: 'streaming',
      });
    });
    expect(popover()).toBeNull();
    expect(lockedProviderFor(useChatStore.getState().openLanes[0])).not.toBeNull();
  });
});
