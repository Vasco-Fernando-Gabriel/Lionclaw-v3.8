// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { SwarmRun } from '@/types/swarm';
vi.mock('@/stores/chat-store', () => ({
  useChatStore: (selector: (state: { currentSessionId: string }) => unknown) => selector({ currentSessionId: 's1' }),
}));
import { SwarmPanel } from '@/components/swarm/SwarmPanel';
function run(revision: number, objective: string): SwarmRun {
  return { runId: 'r1', chatSessionId: 's1', revision, objective, status: 'running', items: [] } as unknown as SwarmRun;
}
describe('Swarm sidebar', () => {
  it('ignora resposta antiga e eventos de outra sessão; remove listener', async () => {
    let listener: (event: { runId: string; chatSessionId: string; revision: number }) => void = () => {};
    let resolveOld: (run: SwarmRun) => void = () => {};
    const old = new Promise<SwarmRun>((resolve) => {
      resolveOld = resolve;
    });
    const dispose = vi.fn();
    const getRunState = vi.fn().mockReturnValueOnce(old).mockResolvedValue(run(3, 'Atual'));
    Object.assign(window, {
      lionclaw: {
        swarm: {
          getRunState,
          listRuns: async () => ({ runs: [{ runId: 'r1' }], nextCursor: null }),
          onStream: (cb: typeof listener) => {
            listener = cb;
            return dispose;
          },
        },
      },
    });
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    await act(async () => {
      root.render(<SwarmPanel />);
    });
    await act(async () => {
      listener({ runId: 'r1', chatSessionId: 's2', revision: 9 });
    });
    expect(getRunState).toHaveBeenCalledTimes(1);
    await act(async () => {
      listener({ runId: 'r1', chatSessionId: 's1', revision: 3 });
    });
    expect(element.textContent).toContain('Atual');
    await act(async () => {
      resolveOld(run(1, 'Obsoleto'));
    });
    expect(element.textContent).not.toContain('Obsoleto');
    await act(async () => {
      root.unmount();
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    element.remove();
  });
});
