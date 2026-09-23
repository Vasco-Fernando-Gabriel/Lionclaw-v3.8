// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderModelPicker, type ProviderModelPickerProps } from '../composer/ProviderModelPicker';
import { LOCKED_PICKER_FOOTER, type PickerProviderRef } from '../composer/model-picker.logic';
import type { ProviderStatusEntry, SessionOrchestrator } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

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
        reasoningOptions: ['low', 'high', 'max'],
        defaultReasoning: 'high',
      },
      {
        id: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        label: 'Claude Sonnet 4.6',
        reasoningOptions: ['low', 'high', 'max'],
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
  {
    runtime: 'kimi-sdk',
    provider: 'kimi',
    connected: false,
    available: false,
    reason: 'Kimi CLI ausente',
    models: [
      { id: 'kimi-code/k3', displayName: 'Kimi K3', label: 'Kimi K3', reasoningOptions: [], defaultReasoning: null },
    ],
  },
];

const SELECTION: SessionOrchestrator = {
  runtime: 'claude-sdk',
  provider: 'anthropic',
  model: 'claude-opus-5',
  effort: 'high',
};

function render(props: Partial<ProviderModelPickerProps>): void {
  const merged: ProviderModelPickerProps = {
    selection: SELECTION,
    entries: ENTRIES,
    phase: 'ready',
    onRefresh: () => {},
    onSelect: () => {},
    ...props,
  };
  act(() => {
    if (!root) root = createRoot(container);
    root.render(<ProviderModelPicker {...merged} />);
  });
}

function trigger(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="chat-lane-orchestrator"]')!;
}

function popover(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-model-picker-content]');
}

function open(): void {
  act(() => {
    trigger().click();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  localStorage.clear();
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

describe('ProviderModelPicker (7.3/7.4 lado UI)', () => {
  it('lane vazia: abre com a coluna de providers, lista os modelos e marca o provider off com o motivo', () => {
    render({});
    expect(trigger().textContent).toContain('Claude Opus 5');
    open();
    const pop = popover();
    expect(pop).not.toBeNull();
    const nav = pop!.querySelector('nav[aria-label="Providers"]')!;
    expect(nav.textContent).toContain('Claude');
    expect(nav.textContent).toContain('Codex');
    expect(nav.textContent).toContain('Kimi');
    expect(nav.textContent).toContain('off');
    const kimiButton = Array.from(nav.querySelectorAll('button')).find((b) => b.textContent?.includes('Kimi'))!;
    expect(kimiButton.getAttribute('title')).toBe('Kimi CLI ausente');
    expect(pop!.querySelector('[data-testid="model-picker-footer"]')).toBeNull();
  });

  it('selecionar um modelo de outro provider em lane vazia chama onSelect com o modelo e fecha', () => {
    const onSelect = vi.fn();
    render({ onSelect });
    open();
    const nav = popover()!.querySelector('nav[aria-label="Providers"]')!;
    const codexButton = Array.from(nav.querySelectorAll('button')).find((b) => b.textContent?.includes('Codex'))!;
    act(() => {
      codexButton.click();
    });
    const row = popover()!.querySelector<HTMLElement>('[data-model-id="gpt-6-astra"]')!;
    act(() => {
      row.click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({
      runtime: 'codex-sdk',
      provider: 'codex',
      modelId: 'gpt-6-astra',
    });
    expect(popover()).toBeNull();
  });

  it('lockProvider: coluna de providers some, so os modelos do provider da lane e o rodape de Clear', () => {
    const lock: PickerProviderRef = { runtime: 'claude-sdk', provider: 'anthropic' };
    render({ lockProvider: lock, lockedFooter: LOCKED_PICKER_FOOTER });
    open();
    const pop = popover()!;
    expect(pop.querySelector('nav[aria-label="Providers"]')).toBeNull();
    const ids = Array.from(pop.querySelectorAll<HTMLElement>('[data-model-id]')).map((el) => el.dataset.modelId);
    expect(ids).toEqual(['claude-opus-5', 'claude-sonnet-4-6']);
    expect(pop.querySelector('[data-testid="model-picker-footer"]')?.textContent).toBe(LOCKED_PICKER_FOOTER);
  });

  it('7.4 DisabledCloser: o picker aberto fecha quando a lane recebe a primeira mensagem (provider trava) e reabre travado', () => {
    render({});
    open();
    expect(popover()).not.toBeNull();
    render({ lockProvider: { runtime: 'claude-sdk', provider: 'anthropic' }, lockedFooter: LOCKED_PICKER_FOOTER });
    expect(popover()).toBeNull();
    open();
    const pop = popover()!;
    expect(pop.querySelector('nav[aria-label="Providers"]')).toBeNull();
    expect(pop.querySelector('[data-testid="model-picker-footer"]')?.textContent).toBe(LOCKED_PICKER_FOOTER);
  });

  it('DisabledCloser: fecha ao ficar desabilitado; Escape fecha; Ctrl+N seleciona a posicao visivel', () => {
    const onSelect = vi.fn();
    render({ onSelect });
    open();
    expect(popover()).not.toBeNull();
    render({ onSelect, disabled: true });
    expect(popover()).toBeNull();

    render({ onSelect, disabled: false });
    open();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(popover()).toBeNull();

    open();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ modelId: 'claude-sonnet-4-6' });
    expect(popover()).toBeNull();
  });
});
