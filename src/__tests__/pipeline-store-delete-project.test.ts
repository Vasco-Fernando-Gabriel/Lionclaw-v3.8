import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('zustand/middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zustand/middleware')>();
  return {
    ...actual,
    persist: (config: unknown) => config,
    createJSONStorage: () => undefined,
  };
});

let nextDeleteResult: unknown = { ok: true };

beforeAll(() => {
  const noop = () => () => {};
  (global as unknown as Record<string, unknown>).window = {
    lionclaw: {
      pipeline: {
        onStream: noop,
        onPhaseChanged: noop,
        onProjectUpdated: noop,
        onNotesUpdated: noop,
        onSprintComplete: noop,
        onSprintUpdated: noop,
        onAgentCompleted: noop,
        onDocumentUpdated: noop,
        onSprintsLoaded: noop,
        onSprintRound: noop,
        onResetComplete: noop,
        onSecurityAgentStatus: noop,
        onResolutionTrackerComplete: noop,
        onManifest: noop,
        listProjects: async () => [],
        getMetrics: async () => ({ phases: [] }),
        getProject: async () => ({ error: 'mock' }),
        start: async () => ({}),
        pause: async () => ({}),
        resume: async () => ({}),
        abort: async () => ({}),
        retry: async () => ({}),
        send: async () => ({}),
        approve: async () => ({}),
        confirmDevelopment: async () => ({}),
        createProject: async () => ({ id: 'mock' }),
        deleteProject: async () => nextDeleteResult,
        getPhaseMessages: async () => [],
        readManifest: async () => null,
        getSecurityAgentStatus: async () => [],
        resetPhase: async () => ({ ok: true }),
        resetSprint: async () => ({ ok: true }),
        getResetPreview: async () => null,
        readPhaseArtifact: async () => null,
        getSprintHistory: async () => [],
        readPhaseDocument: async () => ({ error: 'mock' }),
      },
      tasks: {
        getPendingDueCount: async () => 0,
      },
      scheduler: {
        getPendingReviewCount: async () => 0,
      },
    },
  };
});

import { usePipelineStore } from '@/stores/pipeline-store';
import type { PipelineProject } from '@/types';

function makeProject(id: string, overrides: Partial<PipelineProject> = {}): PipelineProject {
  return { id, ...overrides } as unknown as PipelineProject;
}

beforeEach(() => {
  nextDeleteResult = { ok: true };
  usePipelineStore.setState({
    projects: [],
    activeProjectId: null,
    projectStates: new Map(),
    _lastTouchedAt: new Map(),
    error: null,
  });
});

describe('deleteProject', () => {
  it('removes the project from the projects array', async () => {
    const projA = makeProject('proj-a');
    const projB = makeProject('proj-b');
    usePipelineStore.setState({ projects: [projA, projB] });

    await usePipelineStore.getState().deleteProject('proj-a');

    const remaining = usePipelineStore.getState().projects;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe('proj-b');
  });

  it('removes the entry from the projectStates Map', async () => {
    const store = usePipelineStore.getState();
    store._setProjectState('proj-a', { currentPhase: 3 });
    store._setProjectState('proj-b', { currentPhase: 5 });
    usePipelineStore.setState({
      projects: [makeProject('proj-a'), makeProject('proj-b')],
    });

    expect(usePipelineStore.getState().projectStates.has('proj-a')).toBe(true);

    await usePipelineStore.getState().deleteProject('proj-a');

    const states = usePipelineStore.getState().projectStates;
    expect(states.has('proj-a')).toBe(false);
    expect(states.has('proj-b')).toBe(true);
  });

  it('removes the entry from the _lastTouchedAt Map', async () => {
    const store = usePipelineStore.getState();
    store._setProjectState('proj-a', { currentPhase: 1 });
    store._setProjectState('proj-b', { currentPhase: 2 });
    usePipelineStore.setState({
      projects: [makeProject('proj-a'), makeProject('proj-b')],
    });

    expect(usePipelineStore.getState()._lastTouchedAt.has('proj-a')).toBe(true);

    await usePipelineStore.getState().deleteProject('proj-a');

    const touched = usePipelineStore.getState()._lastTouchedAt;
    expect(touched.has('proj-a')).toBe(false);
    expect(touched.has('proj-b')).toBe(true);
  });

  it('resets active runtime state when the deleted project was active', async () => {
    const projA = makeProject('proj-a');
    usePipelineStore.setState({
      projects: [projA],
      activeProjectId: 'proj-a',
      currentPhase: 4,
      streamContent: 'in-flight content',
      isStreaming: true,
    });

    await usePipelineStore.getState().deleteProject('proj-a');

    const after = usePipelineStore.getState();
    expect(after.activeProjectId).toBeNull();
    expect(after.currentPhase).toBeNull();
    expect(after.streamContent).toBe('');
    expect(after.isStreaming).toBe(false);
  });

  it('preserves active runtime state when the deleted project was NOT active', async () => {
    const projA = makeProject('proj-a');
    const projB = makeProject('proj-b');
    usePipelineStore.setState({
      projects: [projA, projB],
      activeProjectId: 'proj-b',
      currentPhase: 7,
      streamContent: 'still streaming b',
      isStreaming: true,
    });

    await usePipelineStore.getState().deleteProject('proj-a');

    const after = usePipelineStore.getState();
    expect(after.activeProjectId).toBe('proj-b');
    expect(after.currentPhase).toBe(7);
    expect(after.streamContent).toBe('still streaming b');
    expect(after.isStreaming).toBe(true);
  });

  it('sets error and skips state mutation when IPC returns an error', async () => {
    nextDeleteResult = { error: 'boom' };
    const projA = makeProject('proj-a');
    usePipelineStore.setState({ projects: [projA] });
    usePipelineStore.getState()._setProjectState('proj-a', { currentPhase: 9 });

    await usePipelineStore.getState().deleteProject('proj-a');

    const after = usePipelineStore.getState();
    expect(after.error).toBe('boom');
    expect(after.projects).toHaveLength(1);
    expect(after.projectStates.has('proj-a')).toBe(true);
  });
});
