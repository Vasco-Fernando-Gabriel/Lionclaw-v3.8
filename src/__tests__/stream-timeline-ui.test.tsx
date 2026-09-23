// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { StreamTimeline } from '@/components/common/StreamTimeline';
import type { StreamTimelineBlock } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('StreamTimeline UI', () => {
  it('agrupa concluídas antigas sem esconder as três últimas, ativa ou erro', () => {
    const blocks: StreamTimelineBlock[] = Array.from({ length: 12 }, (_, index) => ({
      id: `tool-${index}`,
      sequence: index,
      kind: 'tool' as const,
      tool: `Tool${index}`,
      input: {},
      status: index === 8 ? ('error' as const) : index === 9 ? ('running' as const) : ('done' as const),
    }));
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(<StreamTimeline blocks={blocks} />));

    expect(container.textContent).toContain('8 ferramentas anteriores concluídas');
    expect(container.textContent).toContain('Tool8');
    expect(container.textContent).toContain('Tool9');
    expect(container.textContent).toContain('Tool10');
    expect(container.textContent).toContain('Tool11');
    expect(container.querySelectorAll('[data-timeline-kind="tool"]')).toHaveLength(4);
    act(() => root.unmount());
  });
});
