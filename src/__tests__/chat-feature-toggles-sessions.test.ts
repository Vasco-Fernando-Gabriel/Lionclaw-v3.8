import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { ChatFeatureTogglesResult } from '@/types';

let togglesBySession: Record<string, ChatFeatureTogglesResult> = {};

beforeAll(() => {
  (global as unknown as Record<string, unknown>).window = {
    lionclaw: {
      chat: {
        getFeatureToggles: async (sessionId: string) =>
          togglesBySession[sessionId] ?? { ok: false, code: 'session_not_found', error: 'x' },
        setFeatureToggles: async (sessionId: string, patch: Record<string, boolean>) => {
          const current = togglesBySession[sessionId];
          const toggles =
            current && current.ok
              ? { ...current.toggles, ...patch }
              : { pipelineControl: false, dynamicWorkflows: false, ...patch };
          togglesBySession[sessionId] = { ok: true, toggles };
          return togglesBySession[sessionId];
        },
        getSessions: async () => [],
        listOpenSessions: async () => [],
      },
      mcp: {
        list: async () => [
          { id: 'lionclaw-pipeline-control', name: 'p', command: 'node', args: [], envKeys: [], isActive: true },
        ],
      },
    },
  };
});

async function getStore() {
  return import('@/stores/chat-feature-toggles-store');
}

beforeEach(async () => {
  const { useChatFeatureTogglesStore } = await getStore();
  togglesBySession = {
    a: { ok: true, toggles: { pipelineControl: true, dynamicWorkflows: false } },
    b: { ok: true, toggles: { pipelineControl: false, dynamicWorkflows: true } },
  };
  useChatFeatureTogglesStore.setState({
    sessions: {},
    mcpAvailable: { pipelineControl: true, dynamicWorkflows: true, swarm: true },
  });
});

describe('chat-feature-toggles-store por sessao (10.1)', () => {
  it('hydrate guarda toggles por sessao e snapshotForSend responde por sessao', async () => {
    const { useChatFeatureTogglesStore, selectFeatureToggles } = await getStore();
    await useChatFeatureTogglesStore.getState().hydrate('a');
    await useChatFeatureTogglesStore.getState().hydrate('b');

    expect(selectFeatureToggles(useChatFeatureTogglesStore.getState(), 'a').toggles).toEqual({
      pipelineControl: true,
      dynamicWorkflows: false,
      swarm: false,
    });
    expect(selectFeatureToggles(useChatFeatureTogglesStore.getState(), 'b').toggles).toEqual({
      pipelineControl: false,
      dynamicWorkflows: true,
      swarm: false,
    });
    expect(useChatFeatureTogglesStore.getState().snapshotForSend('a')).toEqual({
      pipelineControl: true,
      dynamicWorkflows: false,
      swarm: false,
    });
    expect(useChatFeatureTogglesStore.getState().snapshotForSend('b')).toEqual({
      pipelineControl: false,
      dynamicWorkflows: false,
      swarm: false,
    });
    expect(useChatFeatureTogglesStore.getState().snapshotForSend('c')).toBeUndefined();
  });

  it('setFeatureToggle altera so a sessao pedida', async () => {
    const { useChatFeatureTogglesStore, selectFeatureToggles } = await getStore();
    await useChatFeatureTogglesStore.getState().hydrate('a');
    await useChatFeatureTogglesStore.getState().hydrate('b');
    const ok = await useChatFeatureTogglesStore.getState().setFeatureToggle('b', 'pipelineControl', true);
    expect(ok).toBe(true);
    expect(selectFeatureToggles(useChatFeatureTogglesStore.getState(), 'b').toggles?.pipelineControl).toBe(true);
    expect(selectFeatureToggles(useChatFeatureTogglesStore.getState(), 'a').toggles?.pipelineControl).toBe(true);
    expect(selectFeatureToggles(useChatFeatureTogglesStore.getState(), 'a').toggles?.dynamicWorkflows).toBe(false);
  });

  it('handleCapabilityError afeta so a thread do chunk; recordSend e clear sao por sessao', async () => {
    const { useChatFeatureTogglesStore, selectFeatureToggles } = await getStore();
    useChatFeatureTogglesStore.getState().recordSend({ sessionId: 'a', message: 'de A' });
    useChatFeatureTogglesStore.getState().recordSend({ sessionId: 'b', message: 'de B' });

    const handled = useChatFeatureTogglesStore
      .getState()
      .handleCapabilityError('b', 'chat_capability_workflows_disabled', undefined);
    expect(handled).toBe(true);
    expect(selectFeatureToggles(useChatFeatureTogglesStore.getState(), 'b').capabilityError?.capability).toBe(
      'dynamicWorkflows',
    );
    expect(selectFeatureToggles(useChatFeatureTogglesStore.getState(), 'a').capabilityError).toBeNull();
    expect(selectFeatureToggles(useChatFeatureTogglesStore.getState(), 'b').lastSent?.message).toBe('de B');

    useChatFeatureTogglesStore.getState().clearCapabilityError('b');
    expect(selectFeatureToggles(useChatFeatureTogglesStore.getState(), 'b').capabilityError).toBeNull();
    expect(
      useChatFeatureTogglesStore.getState().handleCapabilityError('a', 'orchestrator_unconfigured', undefined),
    ).toBe(false);
  });

  it('hydrationSeq por sessao: rehidratar A nao invalida a hidratacao de B', async () => {
    const { useChatFeatureTogglesStore, selectFeatureToggles } = await getStore();
    await useChatFeatureTogglesStore.getState().hydrate('a');
    const first = selectFeatureToggles(useChatFeatureTogglesStore.getState(), 'a').hydrationSeq;
    const pendingB = useChatFeatureTogglesStore.getState().hydrate('b');
    await useChatFeatureTogglesStore.getState().hydrate('a');
    await pendingB;
    expect(selectFeatureToggles(useChatFeatureTogglesStore.getState(), 'a').hydrationSeq).toBeGreaterThan(first);
    expect(selectFeatureToggles(useChatFeatureTogglesStore.getState(), 'b').loading).toBe(false);
    expect(selectFeatureToggles(useChatFeatureTogglesStore.getState(), 'b').toggles).toEqual({
      pipelineControl: false,
      dynamicWorkflows: true,
      swarm: false,
    });
  });
});
