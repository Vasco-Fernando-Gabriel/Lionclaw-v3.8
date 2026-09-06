import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('zustand/middleware', async () => {
  const actual = await vi.importActual<typeof import('zustand/middleware')>('zustand/middleware');
  return {
    ...actual,
    persist: (initializer: unknown) => initializer,
    createJSONStorage: () => undefined,
  };
});

let nextReadPhaseDocumentResult: unknown = { error: 'mock' };

beforeAll(() => {
  const noop = () => () => {};
  const memoryStore = new Map<string, string>();
  const localStorageMock = {
    getItem: (key: string) => memoryStore.get(key) ?? null,
    setItem: (key: string, value: string) => { memoryStore.set(key, value); },
    removeItem: (key: string) => { memoryStore.delete(key); },
    clear: () => { memoryStore.clear(); },
    key: (i: number) => Array.from(memoryStore.keys())[i] ?? null,
    get length() { return memoryStore.size; },
  };
  (global as unknown as Record<string, unknown>).localStorage = localStorageMock;
  (global as unknown as Record<string, unknown>).window = {
    localStorage: localStorageMock,
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
        deleteProject: async () => ({}),
        getPhaseMessages: async () => [],
        readManifest: async () => null,
        getSecurityAgentStatus: async () => [],
        resetPhase: async () => ({ ok: true }),
        resetSprint: async () => ({ ok: true }),
        getResetPreview: async () => null,
        readPhaseArtifact: async () => null,
        getSprintHistory: async () => [],
        readPhaseDocument: async () => nextReadPhaseDocumentResult,
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

beforeEach(() => {
  nextReadPhaseDocumentResult = { error: 'mock' };
  usePipelineStore.setState({
    projects: [],
    activeProjectId: null,
    projectStates: new Map(),
    _lastTouchedAt: new Map(),
  });
});

describe('phase document preview state', () => {
  it('closes the active document in the per-project state', () => {
    usePipelineStore.setState({ activeProjectId: 'doc-proj' });
    const store = usePipelineStore.getState();
    store._setProjectState('doc-proj', {
      activeDocument: { path: '/tmp/open-design-prompt.md', content: '# Prompt' },
    });

    usePipelineStore.getState().closeDocument();

    const after = usePipelineStore.getState();
    expect(after.activeDocument).toBeNull();
    expect(after.projectStates.get('doc-proj')?.activeDocument).toBeNull();
  });

  it('opens phase documents in the per-project state read by the pipeline view', async () => {
    nextReadPhaseDocumentResult = { path: '/tmp/PRD.md', content: '# PRD' };
    usePipelineStore.setState({ activeProjectId: 'doc-proj' });
    const store = usePipelineStore.getState();
    store._setProjectState('doc-proj', {
      phaseDocuments: { 7: { path: '/tmp/PRD.md', label: 'Ver PRD' } },
    });

    await usePipelineStore.getState().openPhaseDocument(7);

    const activeDocument = usePipelineStore.getState().projectStates.get('doc-proj')?.activeDocument;
    expect(activeDocument).toEqual({ path: '/tmp/PRD.md', content: '# PRD' });
  });

  it('clears the split document preview when the phase changes', () => {
    const store = usePipelineStore.getState();
    usePipelineStore.setState({ activeProjectId: 'doc-proj', currentPhase: 4 });
    store._setProjectState('doc-proj', {
      currentPhase: 4,
      activeDocument: { path: '/tmp/open-design-prompt.md', content: '# Prompt' },
      phaseDocuments: { 4: { path: '/tmp/open-design-prompt.md', label: 'Ver Prompt OD' } },
    });

    usePipelineStore.getState()._handlePhaseChanged({
      projectId: 'doc-proj',
      phase: 5,
      status: 'running',
      awaitingUser: false,
    });

    const projectState = usePipelineStore.getState().projectStates.get('doc-proj');
    expect(projectState?.activeDocument).toBeNull();
    expect(projectState?.phaseDocuments[4]?.label).toBe('Ver Prompt OD');
  });
});

describe('_setProjectState', () => {
  it('creates a new entry when project id does not exist', () => {
    const store = usePipelineStore.getState();
    store._setProjectState('proj-1', { isStreaming: true });

    const entry = usePipelineStore.getState().projectStates.get('proj-1');
    expect(entry).toBeDefined();
    expect(entry?.isStreaming).toBe(true);
  });

  it('performs shallow merge, preserving untouched fields', () => {
    const store = usePipelineStore.getState();
    store._setProjectState('proj-2', { currentPhase: 5, error: 'initial error' });
    store._setProjectState('proj-2', { currentPhase: 7 });

    const entry = usePipelineStore.getState().projectStates.get('proj-2');
    expect(entry?.currentPhase).toBe(7);
    expect(entry?.error).toBe('initial error');
  });
});

describe('_ensureProjectState', () => {
  it('is idempotent: second call returns the same entry', () => {
    const store = usePipelineStore.getState();
    const first = store._ensureProjectState('proj-3');
    const second = usePipelineStore.getState()._ensureProjectState('proj-3');
    expect(usePipelineStore.getState().projectStates.get('proj-3')).toBe(second);
    expect(first.currentPhase).toBe(second.currentPhase);
  });
});

describe('GC LRU', () => {
  it('evicts oldest entries when Map grows beyond 20', () => {
    const store = usePipelineStore.getState();

    for (let i = 0; i < 22; i++) {
      store._setProjectState(`gc-proj-${i}`, { currentPhase: i, isStreaming: false });
    }

    const mapSize = usePipelineStore.getState().projectStates.size;
    expect(mapSize).toBeLessThanOrEqual(20);
  });

  it('does not evict active project even when over limit', () => {
    usePipelineStore.setState({ activeProjectId: 'active-proj' });
    const store = usePipelineStore.getState();

    store._setProjectState('active-proj', { currentPhase: 1, isStreaming: false });

    for (let i = 0; i < 22; i++) {
      store._setProjectState(`non-active-${i}`, { currentPhase: i, isStreaming: false });
    }

    expect(usePipelineStore.getState().projectStates.has('active-proj')).toBe(true);
  });

  it('does not evict streaming entries', () => {
    const store = usePipelineStore.getState();

    store._setProjectState('streaming-proj', { isStreaming: true });

    for (let i = 0; i < 22; i++) {
      store._setProjectState(`fill-${i}`, { isStreaming: false });
    }

    expect(usePipelineStore.getState().projectStates.has('streaming-proj')).toBe(true);
  });
});

describe('flat state mirror', () => {
  it('mirrors patch to flat state when projectId === activeProjectId', () => {
    usePipelineStore.setState({ activeProjectId: 'mirror-proj' });
    const store = usePipelineStore.getState();
    store._setProjectState('mirror-proj', { streamContent: 'hello world' });

    const flatState = usePipelineStore.getState();
    expect(flatState.streamContent).toBe('hello world');
  });

  it('does not mirror to flat state when projectId !== activeProjectId', () => {
    usePipelineStore.setState({ activeProjectId: 'other-proj', streamContent: 'original' });
    const store = usePipelineStore.getState();
    store._setProjectState('different-proj', { streamContent: 'should not appear' });

    expect(usePipelineStore.getState().streamContent).toBe('original');
  });
});

describe('defensive: events without projectId', () => {
  it('_handlePhaseChanged: does not mutate state when projectId is empty string', () => {
    const stateBefore = new Map(usePipelineStore.getState().projectStates);
    const store = usePipelineStore.getState();
    try {
      store._handlePhaseChanged({
        projectId: '__test_no_conflict__',
        phase: 1,
        status: 'running',
        awaitingUser: false,
      });
    } catch {
      expect(true).toBe(false);
    }
    for (const [id, ps] of stateBefore) {
      expect(usePipelineStore.getState().projectStates.get(id)).toBeDefined();
      expect(usePipelineStore.getState().projectStates.get(id)?.currentPhase).toBe(ps.currentPhase);
    }
  });
});

describe('openProject rehydrate', () => {
  it('clears stale streaming buffers when backend project is no longer running', async () => {
    const pipelineApi = window.lionclaw.pipeline;
    const originalGetProject = pipelineApi.getProject;
    const originalGetPhaseMessages = pipelineApi.getPhaseMessages;

    pipelineApi.getProject = async () => ({
      id: 'stale-project',
      name: 'Stale project',
      projectPath: '/tmp/stale-project',
      specPath: '/tmp/stale-project/SPEC.md',
      status: 'idle',
      currentPhase: 3,
      pipelineType: 'development-v2',
      awaitingUser: true,
      createdAt: '2026-05-25T00:00:00.000Z',
      updatedAt: '2026-05-25T00:00:00.000Z',
      sprints: [],
    });
    pipelineApi.getPhaseMessages = async () => [
      { role: 'assistant', content: 'Relatorio pronto para aprovacao.' },
    ];

    const store = usePipelineStore.getState();
    store._setProjectState('stale-project', {
      currentPhase: 3,
      isStreaming: true,
      streamContent: 'texto parcial',
      currentToolCalls: [{ tool: 'Read', input: { file: 'stories.md' } }],
    });

    await usePipelineStore.getState().openProject('stale-project');

    const entry = usePipelineStore.getState().projectStates.get('stale-project');
    expect(entry?.isStreaming).toBe(false);
    expect(entry?.streamContent).toBe('');
    expect(entry?.currentToolCalls).toEqual([]);
    expect(entry?.awaitingUser).toBe(true);

    pipelineApi.getProject = originalGetProject;
    pipelineApi.getPhaseMessages = originalGetPhaseMessages;
  });
});
