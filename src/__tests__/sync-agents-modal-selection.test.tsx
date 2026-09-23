// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderStatusEntry, SyncAgentsToOrchestratorRequest } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const syncCalls: SyncAgentsToOrchestratorRequest[] = [];

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
        reasoningOptions: ['low', 'high', 'xhigh'],
        defaultReasoning: 'high',
      },
    ],
  },
];

(window as unknown as Record<string, unknown>).lionclaw = {
  settings: {
    get: async () => ({
      orchestratorRuntime: 'claude-sdk',
      orchestratorProvider: 'anthropic',
      orchestratorModel: 'claude-opus-5',
      orchestratorEffort: 'max',
      orchestratorCodexEffort: 'high',
    }),
  },
  provider: {
    listStatuses: async () => ENTRIES,
  },
  agents: {
    syncToOrchestrator: async (req: SyncAgentsToOrchestratorRequest) => {
      syncCalls.push(req);
      return {
        blocked: false,
        orchestrator: { ...req.selection! },
        results: [],
        summary: { updated: 0, skipped: 0, failed: 0 },
      };
    },
  },
};

let container: HTMLDivElement;
let root: Root | null = null;

async function flush(): Promise<void> {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  syncCalls.length = 0;
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

describe('AC-15 lado UI: SyncAgentsModal envia selection no dryRun e no sync real', () => {
  it('pre-seleciona o Orquestrador padrao, recalcula o preview ao trocar de modelo e ecoa response.orchestrator', async () => {
    const { SyncAgentsModal } = await import('@/components/agents/SyncAgentsModal');
    act(() => {
      root = createRoot(container);
      root.render(
        <SyncAgentsModal open filteredAgentIds={[]} totalAgents={3} onClose={() => {}} onComplete={() => {}} />,
      );
    });
    await flush();
    await flush();

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0]).toMatchObject({
      dryRun: true,
      selection: { runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-5', effort: 'max' },
    });
    expect(container.querySelector('[data-testid="sync-response-orchestrator"]')?.textContent).toBe(
      'claude-sdk / anthropic / claude-opus-5 / effort max',
    );

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="chat-lane-orchestrator"]')!.click();
    });
    const nav = container.querySelector('nav[aria-label="Providers"]')!;
    const codexButton = Array.from(nav.querySelectorAll('button')).find((b) => b.textContent?.includes('Codex'))!;
    act(() => {
      codexButton.click();
    });
    act(() => {
      container.querySelector<HTMLElement>('[data-model-id="gpt-6-astra"]')!.click();
    });
    await flush();
    await flush();

    expect(syncCalls).toHaveLength(2);
    expect(syncCalls[1]).toMatchObject({
      dryRun: true,
      selection: { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-6-astra' },
    });
    expect(syncCalls[1].selection?.effort).toBeUndefined();
    expect(container.querySelector('[data-testid="sync-response-orchestrator"]')?.textContent).toBe(
      'codex-sdk / codex / gpt-6-astra',
    );

    const confirm = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Confirmar e Sincronizar'),
    )!;
    act(() => {
      confirm.click();
    });
    await flush();

    expect(syncCalls).toHaveLength(3);
    expect(syncCalls[2]).toMatchObject({
      dryRun: false,
      mode: 'manual-button',
      selection: { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-6-astra' },
    });
  });
});
