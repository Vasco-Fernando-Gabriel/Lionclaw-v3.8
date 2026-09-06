import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DriveState } from '@/types';


vi.mock('zustand/middleware', async () => {
  const actual = await vi.importActual<typeof import('zustand/middleware')>('zustand/middleware');
  return {
    ...actual,
    persist: (initializer: unknown) => initializer,
    createJSONStorage: () => undefined,
  };
});

let driveStateHandler:
  | ((payload: { projectId: string; drive: DriveState | null }) => void)
  | null = null;

function noopListener() {
  return () => {};
}

beforeEach(() => {
  driveStateHandler = null;
  const pipelineListeners = new Proxy(
    {
      onStream: noopListener,
      onPhaseChanged: noopListener,
      onProjectUpdated: noopListener,
      onNotesUpdated: noopListener,
      onMessagesUpdated: noopListener,
      onSprintComplete: noopListener,
      onSprintUpdated: noopListener,
      onAgentCompleted: noopListener,
      onDocumentUpdated: noopListener,
      onSprintsLoaded: noopListener,
      onSprintRound: noopListener,
      onResetComplete: noopListener,
      onSecurityAgentStatus: noopListener,
      onResolutionTrackerComplete: noopListener,
      onManifest: noopListener,
      onAuditAgentProgress: noopListener,
      onStalled: noopListener,
      listProjects: async () => [],
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        return prop in target ? target[prop] : noopListener;
      },
    },
  );

  (global as unknown as Record<string, unknown>).window = {
    lionclaw: {
      pipeline: pipelineListeners,
      drive: {
        onStateChanged: (
          cb: (payload: { projectId: string; drive: DriveState | null }) => void,
        ) => {
          driveStateHandler = cb;
          return () => {};
        },
      },
    },
  };
});

async function getStore() {
  return import('@/stores/pipeline-store');
}

function makeDrive(status: DriveState['status']): DriveState {
  return {
    driver: 'orchestrator',
    status,
    handoff: 'none',
    mode: 'semi',
    sessionId: 'sess_1',
    requiresHumanPhases: [],
  };
}

describe('drive:state-changed -> relogio por-projeto (C-08)', () => {
  it('awaiting-human zera isStreaming/streamTurnStartedAt e marca drivePaused', async () => {
    const { usePipelineStore } = await getStore();
    const store = usePipelineStore.getState();
    const cleanup = store.init();
    expect(driveStateHandler).not.toBeNull();

    store._setProjectState('proj-a', { isStreaming: true, streamTurnStartedAt: 1234 });

    driveStateHandler!({ projectId: 'proj-a', drive: makeDrive('awaiting-human') });

    const ps = usePipelineStore.getState().projectStates.get('proj-a');
    expect(ps?.isStreaming).toBe(false);
    expect(ps?.streamTurnStartedAt).toBeNull();
    expect(ps?.drivePaused).toBe(true);

    cleanup();
  });

  it('stopped zera o relogio e NAO marca drivePaused (drive encerrou)', async () => {
    const { usePipelineStore } = await getStore();
    const store = usePipelineStore.getState();
    const cleanup = store.init();

    store._setProjectState('proj-b', { isStreaming: true, streamTurnStartedAt: 1234, drivePaused: true });

    driveStateHandler!({ projectId: 'proj-b', drive: makeDrive('stopped') });

    const ps = usePipelineStore.getState().projectStates.get('proj-b');
    expect(ps?.isStreaming).toBe(false);
    expect(ps?.streamTurnStartedAt).toBeNull();
    expect(ps?.drivePaused).toBe(false);

    cleanup();
  });

  it('driving (retomou) limpa drivePaused', async () => {
    const { usePipelineStore } = await getStore();
    const store = usePipelineStore.getState();
    const cleanup = store.init();

    store._setProjectState('proj-c', { drivePaused: true });

    driveStateHandler!({ projectId: 'proj-c', drive: makeDrive('driving') });

    const ps = usePipelineStore.getState().projectStates.get('proj-c');
    expect(ps?.drivePaused).toBe(false);

    cleanup();
  });
});
