// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LaneClearDialog } from '@/components/chat/LaneClearDialog';
import type { OpenChatSession } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

function lane(id: string, laneBadge: number, over: Partial<OpenChatSession> = {}): OpenChatSession {
  return {
    id,
    laneBadge,
    title: `Conversa ${laneBadge}`,
    orchestrator: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-sonnet-4-6' },
    messageCount: 4,
    lastUserMessageAt: '2026-09-08T10:00:00.000Z',
    createdAt: '2026-09-08T09:00:00.000Z',
    updatedAt: '2026-09-08T10:00:00.000Z',
    state: 'idle',
    drive: null,
    ...over,
  };
}

beforeEach(() => {
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

describe('LaneClearDialog (5.5a popup, AC-4 lado UI)', () => {
  it('lista badge, titulo, runtime/modelo e estado; so disponivel e selecionavel', () => {
    const onSelect = vi.fn();
    const lanes = [
      lane('a', 1),
      lane('b', 2, { state: 'streaming', title: 'Ocupada' }),
      lane('c', 3, { messageCount: 0, title: 'Vazia' }),
      lane('d', 4, { state: 'drive', title: 'Drive' }),
      lane('e', 5, { title: 'Em clear' }),
    ];
    const compactions = { e: { phase: 'running' as const, modelLabel: 'haiku', source: 'lionclaw' as const } };

    act(() => {
      root = createRoot(container);
      root.render(<LaneClearDialog lanes={lanes} compactions={compactions} onSelect={onSelect} onCancel={() => {}} />);
    });

    const option = (badge: number) =>
      container.querySelector<HTMLButtonElement>(`[data-testid="lane-clear-option-${badge}"]`)!;
    expect(option(1).disabled).toBe(false);
    expect(option(1).dataset.state).toBe('disponivel');
    expect(option(2).disabled).toBe(true);
    expect(option(2).dataset.state).toBe('ocupada');
    expect(option(3).dataset.state).toBe('vazia');
    expect(option(4).dataset.state).toBe('drive ativo');
    expect(option(5).dataset.state).toBe('em Clear');
    expect(option(1).textContent).toContain('Lane 1');
    expect(option(1).textContent).toContain('claude-sdk / Sonnet 4.6');
    expect(option(2).title).toMatch(/ocupada/i);

    act(() => {
      option(2).click();
      option(1).click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('cancelar fecha sem selecionar', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      root = createRoot(container);
      root.render(<LaneClearDialog lanes={[lane('a', 1)]} compactions={{}} onSelect={onSelect} onCancel={onCancel} />);
    });
    const cancel = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Cancelar'))!;
    act(() => {
      cancel.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
